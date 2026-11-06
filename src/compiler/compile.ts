// The compiler: one pure, deterministic function from annotated HTML to a
// rewritten page plus its IR and function table.
import * as parse5 from 'parse5';
import { parseExpressionAt } from 'acorn';
import type { DefaultTreeAdapterMap } from 'parse5';
import { type Code, type Diagnostic, didYouMean, severityOf } from './diagnostics.js';
import { analyze, type ExprOptions, type ExprResult, type LoopEntry, type PageInfo, type ResourceInfo, type Scope } from './expr.js';
import { ATTRIBUTES, ELEMENTS } from './vocabulary.js';
import type { CheckExpr, CheckFrame, CheckLoc, CheckResource, CheckUnit, TypeRef } from './check-unit.js';
import { matchOperation, matchResource, queryNames, walk, type OpenApiSpec } from './openapi.js';
import type { ActionDef, Binding, EventDef, IR, NodeDef, Paginate, ResourceDef, SyncDef, TemplateDef, UrlTemplate } from '../ir.js';

type P5Node = DefaultTreeAdapterMap['node'];
type P5Element = DefaultTreeAdapterMap['element'];
type P5Parent = DefaultTreeAdapterMap['parentNode'];
type P5Template = DefaultTreeAdapterMap['template'];

export interface HelperManifest {
  /** import specifier of the helpers module, or null */
  module: string | null;
  names: string[];
  namespaces: Record<string, { module: string; members: string[] }>;
}

export interface CompileOptions {
  file: string;
  root: string;
  readFile: (path: string) => string;
  helpers: HelperManifest;
  dev: boolean;
  /** URL the injected `<script type="module">` loads the page module from */
  moduleSrc?: string;
  /** app configuration module imported before mount (e.g. `/src/sinter.config.js`) */
  config?: string | null;
  /** also return a check unit for `sinter check`, and warn about resources without `type` */
  check?: boolean;
  /** parsed OpenAPI specs: resources without `type` are matched against them */
  openapi?: OpenApiSpec[];
  /** the actions module (`data-sn-call`, `<sn-resource call>`), same shape as helpers */
  actions?: HelperManifest;
}

export interface CompileResult {
  html: string;
  module: string;
  diagnostics: Diagnostic[];
  files: string[];
  /** with `check: true` */
  check?: CheckUnit;
}

export interface CompiledParts {
  html: string;
  ir: IR;
  fns: string[];
  features: string[];
  /** helper names imported from the helpers module or the core */
  helpers: { user: string[]; builtin: string[] };
  namespaces: Record<string, string[]>;
  /** action functions called, as written: `archive`, `pgp.decrypt` */
  calls: string[];
  diagnostics: Diagnostic[];
  files: string[];
  /** with `check: true` */
  check?: CheckUnit;
}

const ATTRS = ATTRIBUTES.map((a) => a.name);
const METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const;
const ACTION_ONLY = ['body', 'trigger', 'debounce', 'concurrency', 'optimistic', 'then', 'catch'];
const UNSAFE_ELEMENTS = new Set(['script', 'style', 'iframe', 'object', 'embed', 'base', 'meta', 'link', 'animate', 'set', 'animatemotion', 'animatetransform']);
const FORM_CONTROLS = new Set(['input', 'select', 'textarea']);
const RESOURCE_ATTRS = ELEMENTS.find((e) => e.name === 'sn-resource')!.attrs;
const EVENT_ATTRS = ELEMENTS.find((e) => e.name === 'sn-event')!.attrs;
const IDENT = /^[A-Za-z_][\w]*$/;
const BAD_PARAM = /^(constructor|__proto__|prototype)$/;
const SECRET_AUTOCOMPLETE = /^(cc-|one-time-code$|current-password$|new-password$)/;

interface Origin { file: string; src: string; chain: string[] }

interface Ctx {
  scope: Scope;
  list: NodeDef[];
  /** template id, or -1 outside templates */
  tid: number;
  path: number[];
  stateIdx: number;
}

export function compileParts(html: string, options: CompileOptions): CompiledParts {
  return new Compiler(options).run(html);
}

class Compiler {
  readonly diagnostics: Diagnostic[] = [];
  readonly files = new Set<string>();
  readonly fns: string[] = [];
  readonly origins = new WeakMap<object, Origin>();
  readonly lineStarts = new Map<string, number[]>();
  readonly page: PageInfo;
  readonly resources: ResourceDef[] = [];
  readonly resourceEls = new Map<string, P5Element>();
  readonly syncs: SyncDef[] = [];
  readonly roots: NodeDef[] = [];
  readonly templates: TemplateDef[] = [];
  readonly actions: ActionDef[] = [];
  readonly remove: P5Element[] = [];
  readonly embedded = new Map<string, number>();
  readonly features = new Set<string>();
  /** action functions called by the page (`archive`, `pgp.decrypt`) */
  readonly calls = new Set<string>();
  nextId = 0;
  nextSid = 0;
  readonly check: CheckUnit | null;
  /** StateEntry / LoopEntry → frame index in `check.frames` */
  readonly frameOf = new Map<object, number>();
  /** index in `check.exprs` of the expression `expr()` recorded last, or null */
  lastExpr: number | null = null;

  constructor(readonly opts: CompileOptions) {
    this.check = opts.check ? { file: opts.file, resources: [], frames: [], exprs: [] } : null;
    const ns = new Map<string, Set<string>>();
    for (const [k, v] of Object.entries(opts.helpers.namespaces)) ns.set(k, new Set(v.members));
    this.page = {
      resources: new Map(), helpers: new Set(opts.helpers.names), namespaces: ns,
      actions: new Set([...(opts.actions?.names ?? []), ...Object.keys(opts.actions?.namespaces ?? {})]),
      usedHelpers: new Set(), usedNs: new Map(), usesNow: false, pathParams: new Set(),
    };
  }

  run(html: string): CompiledParts {
    const doc = parse5.parse(html, { sourceCodeLocationInfo: true });
    this.tag(doc, { file: this.opts.file, src: html, chain: [] });
    this.expandIncludes(doc, [this.opts.file]);
    this.declare(doc);
    const paths = this.pathPatterns(doc);
    this.walkChildren(doc, { scope: { loops: [], states: [] }, list: this.roots, tid: -1, path: [], stateIdx: -1 });

    for (const [name, id] of this.embedded) {
      const r = this.resources.find((x) => x.name === name);
      if (r) r.data = id;
    }
    for (const info of this.page.resources.values()) {
      if (!info.used) {
        const el = this.resourceEls.get(info.name)!;
        this.report(el, 'name', 'SN501', `resource \`${info.name}\` is declared but never read`, 0);
      }
    }
    for (const el of this.remove) detach(el);
    this.injectScript(doc);
    // row templates (data-sn-for) get a compiled element lookup; if/else branches render once per
    // toggle and use the generic path walk, which costs no code per template
    const rowTemplates = new Set([...this.roots, ...this.templates.flatMap((t) => t.nodes)].flatMap((n) => n.b.filter((b) => b.k === 'for').map((b) => b.x!)));
    for (const t of this.templates) if (t.nodes.length && rowTemplates.has(t.id)) t.find = this.fn(findCode(t.nodes));

    const ir: IR = { v: 1, resources: this.resources, syncs: this.syncs, roots: this.roots, templates: this.templates, actions: this.actions };
    if (this.page.usesNow) ir.now = true;
    if (paths.length) ir.path = paths;
    const builtin: string[] = [];
    const user: string[] = [];
    for (const h of [...this.page.usedHelpers].sort()) (this.page.helpers.has(h) ? user : builtin).push(h);
    const namespaces: Record<string, string[]> = {};
    for (const [k, v] of [...this.page.usedNs].sort(([a], [b]) => a.localeCompare(b))) namespaces[k] = [...v].sort();
    return {
      html: parse5.serialize(doc),
      ir, fns: this.fns,
      features: [...(this.opts.dev ? ['dev'] : []), ...['sse', 'optimistic', 'paginate', 'persist', 'cache', 'each'].filter((f) => this.features.has(f))],
      helpers: { user, builtin }, namespaces, calls: [...this.calls].sort(),
      diagnostics: this.diagnostics, files: [...this.files].sort(),
      ...(this.check ? { check: this.check } : {}),
    };
  }

  // ---- positions and diagnostics

  tag(node: P5Node | P5Parent, origin: Origin) {
    this.origins.set(node, origin);
    if ('childNodes' in node) for (const c of node.childNodes) this.tag(c, origin);
    if ((node as P5Element).nodeName === 'template') this.tag((node as P5Template).content, origin);
  }

  lineCol(src: string, offset: number): { line: number; col: number } {
    let starts = this.lineStarts.get(src);
    if (!starts) {
      starts = [0];
      for (let i = 0; i < src.length; i++) if (src[i] === '\n') starts.push(i + 1);
      this.lineStarts.set(src, starts);
    }
    let lo = 0, hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid]! <= offset) lo = mid; else hi = mid - 1;
    }
    return { line: lo + 1, col: offset - starts[lo]! + 1 };
  }

  /** Offset in the element's source file where the value of `attr` starts. */
  valueOffset(el: P5Element, attr: string | null): number {
    const loc = el.sourceCodeLocation;
    if (!loc) return 0;
    if (!attr) return loc.startOffset;
    const a = loc.attrs?.[attr];
    if (!a) return loc.startOffset;
    const src = this.origins.get(el)?.src ?? '';
    let i = a.startOffset + attr.length;
    while (i < a.endOffset && src[i] !== '=') i++;
    if (i >= a.endOffset) return a.startOffset;
    i++;
    while (i < a.endOffset && /\s/.test(src[i]!)) i++;
    if (src[i] === '"' || src[i] === "'") i++;
    return i;
  }

  /** `inExpr`: the offset points into an expression; otherwise offset 0 is about the whole attribute (or element) */
  /**
   * `data-sn-call` / `call`: exactly one call of an actions module function, `name(args)` or
   * `ns.name(args)`. Compiles to two table entries: the arguments as one array expression, and a
   * runner that calls the imported function with them and the context.
   */
  callExpr(el: P5Element, attrName: string, scope: Scope, deps?: Set<string>, magic?: string[]): { args: number; run: number; name: string } | null {
    const text = attr(el, attrName) ?? '';
    const shape = `\`${attrName}\` is one call of an action, e.g. \`pgp.decrypt(msg)\``;
    let ast: ReturnType<typeof parseExpressionAt>;
    try {
      ast = parseExpressionAt(text, 0, { ecmaVersion: 'latest' });
    } catch (e) {
      this.report(el, attrName, 'SN401', `\`${attrName}\`: ${(e as Error).message.replace(/ \(\d+:\d+\)$/, '')}`, (e as { pos?: number }).pos ?? 0);
      return null;
    }
    if (ast.type !== 'CallExpression' || ast.optional || ast.end !== text.trimEnd().length) {
      this.report(el, attrName, 'SN401', shape, 0);
      return null;
    }
    const acts = this.opts.actions ?? { module: null, names: [], namespaces: {} };
    const callee = ast.callee;
    const all = [...acts.names, ...Object.entries(acts.namespaces).flatMap(([ns, m]) => m.members.map((x) => `${ns}.${x}`))];
    let name: string, local: string;
    if (callee.type === 'Identifier') {
      name = callee.name;
      local = `$a$${name}`;
      if (!acts.names.includes(name)) {
        this.report(el, attrName, 'SN310', `\`${name}\` is not exported by the actions module.${didYouMean(name, all)}`, callee.start);
        return null;
      }
    } else if (callee.type === 'MemberExpression' && !callee.computed && callee.object.type === 'Identifier' && callee.property.type === 'Identifier') {
      name = `${callee.object.name}.${callee.property.name}`;
      local = `$a$${callee.object.name}$${callee.property.name}`;
      if (!acts.namespaces[callee.object.name]?.members.includes(callee.property.name)) {
        this.report(el, attrName, 'SN310', `\`${name}\` is not exported by the actions module.${didYouMean(name, all)}`, callee.start);
        return null;
      }
    } else {
      this.report(el, attrName, 'SN401', shape, callee.start);
      return null;
    }
    const open = text.indexOf('(', callee.end);
    const r = this.expr(el, attrName, scope, { mode: 'value', ...(magic ? { magic } : {}) }, `[${text.slice(open + 1, ast.end - 1)}]`, open);
    if (this.check) this.typeLast({ returns: { kind: 'call', name, args: true } });
    if (deps) for (const d of r.deps) deps.add(d);
    if (!r.ok) return null;
    this.calls.add(name);
    return { args: this.fn(r.code), run: this.fn(`($a, $c) => ${local}(...$a, $c)`), name };
  }

  /** `direction-values="{prev: 'backward', next: 'forward'}"`: static data, string values for known directions only */
  directionValues(el: P5Element): Paginate['directionValues'] | null {
    const text = attr(el, 'direction-values')!;
    const DIRS = ['first', 'prev', 'next', 'last'] as const;
    const fail = (message: string, offset = 0) => { this.report(el, 'direction-values', 'SN401', message, offset); return null; };
    let ast: ReturnType<typeof parseExpressionAt>;
    try {
      ast = parseExpressionAt(text, 0, { ecmaVersion: 'latest' });
    } catch (e) {
      return fail(`\`direction-values\`: ${(e as Error).message.replace(/ \(\d+:\d+\)$/, '')}`, (e as { pos?: number }).pos ?? 0);
    }
    if (ast.type !== 'ObjectExpression' || ast.end !== text.trimEnd().length) {
      return fail("`direction-values` is an object literal of strings, e.g. `{prev: 'backward', next: 'forward'}`");
    }
    const out: NonNullable<Paginate['directionValues']> = {};
    for (const p of ast.properties) {
      if (p.type !== 'Property' || p.computed || p.kind !== 'init' || p.method || p.shorthand) {
        return fail("`direction-values` is an object literal of strings, e.g. `{prev: 'backward', next: 'forward'}`", p.start);
      }
      const key = p.key.type === 'Identifier' ? p.key.name : p.key.type === 'Literal' ? String(p.key.value) : '';
      if (!(DIRS as readonly string[]).includes(key)) {
        return fail(`\`${key}\` is not a direction; directions are \`first\`, \`prev\`, \`next\` and \`last\`.${didYouMean(key, DIRS)}`, p.key.start);
      }
      if (p.value.type !== 'Literal' || typeof p.value.value !== 'string') {
        return fail(`the value for \`${key}\` must be a string literal`, p.value.start);
      }
      out[key as typeof DIRS[number]] = p.value.value;
    }
    return out;
  }

  report(el: P5Element | null, attr: string | null, code: Code, message: string, offset: number, hint?: string, inExpr = false) {
    const origin = (el && this.origins.get(el)) || { file: this.opts.file, src: '', chain: [] };
    const base = el ? this.valueOffset(el, attr) : 0;
    const { line, col } = el?.sourceCodeLocation ? this.lineCol(origin.src, base + offset) : { line: 1, col: 1 };
    let msg = message;
    if (origin.chain.length) msg += ` (included from ${origin.chain.join(' ← ')})`;
    const d: Diagnostic = { severity: severityOf(code), code, message: msg, file: origin.file, line, col };
    if (hint) d.hint = hint;
    const loc = el?.sourceCodeLocation;
    if (loc && !inExpr && offset === 0) {
      const a = attr ? loc.attrs?.[attr] : null;
      const [from, to] = a ? [a.startOffset, a.endOffset] : [loc.startOffset + 1, loc.startOffset + 1 + el!.tagName.length];
      const start = this.lineCol(origin.src, from);
      const end = this.lineCol(origin.src, to);
      d.span = { line: start.line, col: start.col, endLine: end.line, endCol: end.col };
    }
    this.diagnostics.push(d);
  }

  reporter(el: P5Element, attr: string, shift = 0): ExprOptions['report'] {
    return (code, message, offset, hint) => this.report(el, attr, code, message, offset + shift, hint, true);
  }

  // ---- includes

  expandIncludes(parent: P5Parent, chain: string[]) {
    const children = [...parent.childNodes];
    for (const child of children) {
      if (!isElement(child)) continue;
      if (child.tagName === 'sn-include') {
        this.include(child, chain);
        continue;
      }
      this.expandIncludes(child, chain);
      if (child.tagName === 'template') this.expandIncludes((child as P5Template).content, chain);
    }
  }

  include(el: P5Element, chain: string[]) {
    const src = attr(el, 'src');
    const origin = this.origins.get(el)!;
    const fail = (code: Code, msg: string) => { this.report(el, 'src', code, msg, 0); detach(el); };
    if (src == null || src === '' || src.includes('{')) return fail('SN305', 'partial `src` must be a literal path');
    for (const a of el.attrs) if (a.name !== 'src') this.report(el, a.name, 'SN101', `\`${a.name}\` is not an attribute of \`<sn-include>\``, 0);
    const resolved = resolvePath(dirname(origin.file), src);
    const root = normalize(this.opts.root).replace(/\/$/, '');
    if (!(resolved === root || resolved.startsWith(root + '/'))) {
      return fail('SN305', `partial \`${src}\` not found or outside the project root`);
    }
    if (chain.includes(resolved)) {
      return fail('SN306', `${[...chain, resolved].map(basename).join(' → ')} includes itself`);
    }
    let text: string;
    try {
      text = this.opts.readFile(resolved);
    } catch {
      return fail('SN305', `partial \`${src}\` not found or outside the project root`);
    }
    this.files.add(resolved);
    const frag = parse5.parseFragment(text, { sourceCodeLocationInfo: true });
    const loc = el.sourceCodeLocation ? this.lineCol(origin.src, el.sourceCodeLocation.startOffset) : { line: 1, col: 1 };
    const here = `${basename(origin.file)}:${loc.line}`;
    this.tag(frag, { file: resolved, src: text, chain: [here, ...origin.chain] });
    this.expandIncludes(frag, [...chain, resolved]);
    const parent = el.parentNode!;
    const i = parent.childNodes.indexOf(el as never);
    for (const c of frag.childNodes) (c as { parentNode: P5Parent }).parentNode = parent;
    parent.childNodes.splice(i, 1, ...(frag.childNodes as never[]));
    // the browser merges adjacent text when it parses the output; merge now so node paths agree
    mergeText(parent);
  }

  // ---- declarations (first pass: names only, so expressions can see every resource)

  declare(parent: P5Parent, inTemplate = false) {
    for (const child of parent.childNodes) {
      if (!isElement(child)) continue;
      if (child.tagName === 'sn-resource') {
        if (inTemplate) { this.report(child, null, 'SN102', '`<sn-resource>` cannot be inside a `<template>`', 0); continue; }
        const name = attr(child, 'name');
        if (!name || !IDENT.test(name) || name.startsWith('$')) {
          this.report(child, 'name', 'SN401', 'resource `name` must be a valid JavaScript identifier', 0);
          continue;
        }
        if (this.page.resources.has(name)) {
          this.report(child, 'name', 'SN302', `resource \`${name}\` is declared twice`, 0);
          continue;
        }
        const key = attr(child, 'key');
        const paginate = attr(child, 'paginate');
        const info: ResourceInfo = { name, key: key ? key.split(',').map((s) => s.trim()).filter(Boolean) : null, paginate: paginate ?? null, used: false };
        if (paginate === 'keyset' && attr(child, 'offset-param') != null) info.jumps = true;
        this.page.resources.set(name, info);
        this.resourceEls.set(name, child);
        continue;
      }
      this.declare(child, inTemplate);
      if (child.tagName === 'template') this.declare((child as P5Template).content, true);
    }
  }

  /** `<html data-sn-path="/a /b/:id">`: the URL shapes this page is served for. */
  pathPatterns(doc: DefaultTreeAdapterMap['document']): string[] {
    const html = doc.childNodes.find((n) => isElement(n) && n.tagName === 'html') as P5Element | undefined;
    const value = html && attr(html, 'data-sn-path');
    if (value == null) return [];
    const patterns = value.trim().split(/\s+/).filter(Boolean);
    for (const p of patterns) {
      const segs = p.split('/').slice(1);
      const bad = !p.startsWith('/') || p.startsWith('//') || segs.some((s, i) =>
        s[0] === ':' ? !IDENT.test(s.slice(1)) || BAD_PARAM.test(s.slice(1)) : (s === '' && i < segs.length - 1) || /[?#:]/.test(s));
      if (bad) this.report(html!, 'data-sn-path', 'SN401', `\`${p}\` is not a path pattern; use literal segments and \`:name\`, e.g. \`/article/:slug\``, value.indexOf(p));
      for (const s of segs) if (s[0] === ':') this.page.pathParams.add(s.slice(1));
    }
    return patterns;
  }

  // ---- main walk

  walkChildren(parent: P5Parent, ctx: Ctx) {
    let lastIf: { node: NodeDef; binding: Binding } | null = null;
    const kids = parent.childNodes;
    for (let i = 0; i < kids.length; i++) {
      const child = kids[i]!;
      if (!isElement(child)) {
        if (child.nodeName === '#text' && (child as DefaultTreeAdapterMap['textNode']).value.trim() === '') continue;
        if (child.nodeName === '#comment') continue;
        lastIf = null;
        continue;
      }
      const res = this.element(child, ctx, i, lastIf);
      lastIf = res;
    }
  }

  element(el: P5Element, ctx: Ctx, index: number, prevIf: { node: NodeDef; binding: Binding } | null): { node: NodeDef; binding: Binding } | null {
    switch (el.tagName) {
      case 'sn-resource': this.resource(el, ctx); return null;
      case 'sn-sync': this.sync(el, ctx); return null;
      case 'sn-event': this.report(el, null, 'SN102', '`<sn-event>` must be a child of `<sn-sync>`', 0); this.remove.push(el); return null;
    }
    if (el.tagName.startsWith('sn-')) {
      this.report(el, null, 'SN101', `\`<${el.tagName}>\` is not a sinter element.${didYouMean(el.tagName, ['sn-resource', 'sn-sync', 'sn-event', 'sn-include'])}`, 0);
    }

    const sn = el.attrs.filter((a) => a.name.startsWith('data-sn-'));
    const get = (n: string) => sn.find((a) => a.name === `data-sn-${n}`)?.value;
    const has = (n: string) => sn.some((a) => a.name === `data-sn-${n}`);

    // unknown attributes
    const known = new Set<string>(ATTRS.map((a) => `data-sn-${a}`));
    for (const a of sn) {
      if (known.has(a.name) || a.name.startsWith('data-sn-on-')) continue;
      this.report(el, a.name, 'SN101', `\`${a.name}\` is not a sinter attribute.${didYouMean(a.name, [...known, 'data-sn-on-click'])}`, 0);
    }

    if (has('path') && el.tagName !== 'html') this.report(el, 'data-sn-path', 'SN102', '`data-sn-path` belongs on `<html>`', 0);

    // embedded data
    if (has('data')) {
      if (el.tagName !== 'script' || attr(el, 'type') !== 'application/json') {
        this.report(el, 'data-sn-data', 'SN102', '`data-sn-data` must be on a `<script type="application/json">`', 0);
      } else {
        const name = get('data')!;
        if (!this.page.resources.has(name)) {
          this.report(el, 'data-sn-data', 'SN301', `resource \`${name}\` is not declared on this page.${didYouMean(name, this.page.resources.keys())}`, 0);
        } else if (ctx.tid >= 0) {
          this.report(el, 'data-sn-data', 'SN102', 'embedded data cannot be inside a `<template>`', 0);
        } else {
          const id = this.nextId++;
          this.embedded.set(name, id);
          setAttr(el, 'data-sn', String(id));
        }
      }
      stripSn(el);
      return null;
    }

    if (sn.length && UNSAFE_ELEMENTS.has(el.tagName.toLowerCase())) {
      this.report(el, sn[0]!.name, 'SN207', `\`<${el.tagName}>\` cannot carry sinter bindings`, 0);
      stripSn(el);
      return null;
    }

    const node: NodeDef = { tag: el.tagName, p: ctx.stateIdx, b: [] };
    const nodeIdx = ctx.list.length;
    let scope = ctx.scope;
    let result: { node: NodeDef; binding: Binding } | null = null;

    // state
    if (has('state')) {
      const r = this.expr(el, 'data-sn-state', scope, { mode: 'value', object: 'state' });
      if (r.ok) {
        const sid = this.nextSid++;
        node.state = this.fn(r.code);
        node.sid = sid;
        const entry = { sid, names: new Set(r.entries!.map((e) => e.key)) };
        if (this.check) {
          this.frameOf.set(entry, this.check.frames.length);
          const first = [...entry.names].map((n) => r.entries!.find((e) => e.key === n)!);
          const locs = first.map((e) => this.locOf(el, 'data-sn-state', e.offset));
          this.check.frames.push({ kind: 'state', names: [...entry.names], init: this.lastExpr, locs });
        }
        scope = { loops: scope.loops, states: [...scope.states, entry] };
        if (has('persist') && !has('model')) {
          node.persist = get('persist')!;
          this.features.add('persist');
        }
      }
    }

    const isTemplate = el.tagName === 'template';
    const valueB = (k: 'text' | 'show', name: string) => {
      const r = this.expr(el, name, scope, { mode: 'value' });
      if (r.ok) node.b.push(binding({ k, f: this.fn(r.code), d: r.deps, ...usesEl(r) }));
    };

    for (const n of ['for', 'if', 'else'] as const) {
      if (has(n) && !isTemplate) this.report(el, `data-sn-${n}`, 'SN102', `\`data-sn-${n}\` must be on a \`<template>\``, 0);
    }
    if (has('key') && !(isTemplate && has('for'))) this.report(el, 'data-sn-key', 'SN102', '`data-sn-key` belongs on a `<template data-sn-for>`', 0);

    if (has('text')) valueB('text', 'data-sn-text');
    if (has('show')) valueB('show', 'data-sn-show');
    if (has('attr')) this.attrBinding(el, node, scope);
    if (has('class')) this.objectBinding(el, node, scope, 'class');
    if (has('style')) this.objectBinding(el, node, scope, 'style');
    if (has('prop')) {
      if (!el.tagName.includes('-')) this.report(el, 'data-sn-prop', 'SN102', '`data-sn-prop` is for custom elements only; use `data-sn-attr`', 0);
      else this.objectBinding(el, node, scope, 'prop');
    }
    if (has('model')) this.model(el, node, scope, get('persist'));
    else if (has('persist') && !has('state')) this.report(el, 'data-sn-persist', 'SN102', '`data-sn-persist` needs `data-sn-model` or `data-sn-state` on the same element', 0);

    const methods = METHODS.filter((m) => has(m));
    const isCall = has('call');
    // without a method, `data-sn-debounce` delays the element's own handlers
    let handlerDebounce = 0;
    if (!methods.length && !isCall && has('debounce')) {
      handlerDebounce = Number(get('debounce'));
      if (!Number.isFinite(handlerDebounce) || handlerDebounce < 0) this.report(el, 'data-sn-debounce', 'SN401', '`data-sn-debounce` takes milliseconds', 0);
      if (!sn.some((a) => a.name.startsWith('data-sn-on-'))) this.report(el, 'data-sn-debounce', 'SN102', '`data-sn-debounce` needs a method attribute (`data-sn-get`, `-post`, …) or a `data-sn-on-*` handler on the same element', 0);
    }
    for (const a of sn) {
      if (!a.name.startsWith('data-sn-on-')) continue;
      const event = a.name.slice('data-sn-on-'.length);
      if (!/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/.test(event)) {
        this.report(el, a.name, 'SN101', `event names are lowercase kebab-case: \`${a.name}\``, 0);
        continue;
      }
      const r = this.expr(el, a.name, scope, { mode: 'handler', magic: ['$event'] });
      if (r.ok) node.b.push(binding({ k: 'on', n: event, f: this.fn(r.code), w: r.writes, ...(handlerDebounce > 0 ? { ms: handlerDebounce } : {}) }));
    }

    if (methods.length > 1) this.report(el, `data-sn-${methods[1]}`, 'SN102', 'an element can have only one method attribute', 0);
    if (methods.length && isCall) this.report(el, 'data-sn-call', 'SN102', 'an element has one action: a method attribute or `data-sn-call`, not both', 0);
    if (methods.length) this.action(el, node, scope, methods[0]!, get);
    else if (isCall) this.action(el, node, scope, 'call', get);
    else for (const n of ACTION_ONLY) if (has(n) && n !== 'debounce') this.report(el, `data-sn-${n}`, 'SN102', `\`data-sn-${n}\` needs a method attribute (\`data-sn-get\`, \`-post\`, …) on the same element`, 0);

    // templates
    let content: { tid: number; scope: Scope } | null = null;
    if (isTemplate && has('for')) content = this.forTemplate(el, node, scope, get('for')!, get('key'));
    else if (isTemplate && has('if')) {
      const r = this.expr(el, 'data-sn-if', scope, { mode: 'value' });
      const tid = this.newTemplate();
      const b = binding({ k: 'if', f: this.fn(r.code), d: r.deps, x: tid, ...usesEl(r) });
      node.b.push(b);
      result = { node, binding: b };
      content = { tid, scope };
    } else if (isTemplate && has('else')) {
      if (get('else')) this.report(el, 'data-sn-else', 'SN401', '`data-sn-else` takes no value', 0);
      if (!prevIf) this.report(el, 'data-sn-else', 'SN102', '`data-sn-else` must be on a `<template>` directly after a `data-sn-if` template', 0);
      const tid = this.newTemplate();
      node.b.push(binding({ k: 'else', x: tid }));
      if (prevIf) prevIf.binding.y = nodeIdx;
      content = { tid, scope };
    }

    const hasDirectives = node.b.length > 0 || node.state !== undefined;
    if (hasDirectives) {
      if (ctx.tid < 0) {
        node.id = this.nextId++;
        setAttr(el, 'data-sn', String(node.id));
      } else node.path = [...ctx.path, index];
      if (this.opts.dev) (node as NodeDef & { src?: string }).src = this.position(el);
      ctx.list.push(node);
    }
    stripSn(el);

    if (content) {
      const t = this.templates[content.tid]!;
      this.walkChildren((el as P5Template).content, { scope: content.scope, list: t.nodes, tid: content.tid, path: [], stateIdx: -1 });
    } else if (isTemplate) {
      if (hasSnDeep((el as P5Template).content)) {
        this.report(el, null, 'SN102', 'directives inside a `<template>` need `data-sn-for` or `data-sn-if` on it', 0);
      }
    } else {
      this.walkChildren(el, {
        ...ctx, scope,
        stateIdx: node.state !== undefined && hasDirectives ? nodeIdx : ctx.stateIdx,
        path: ctx.tid >= 0 ? [...ctx.path, index] : ctx.path,
      });
    }
    return result;
  }

  position(el: P5Element): string {
    const o = this.origins.get(el);
    if (!o || !el.sourceCodeLocation) return this.opts.file;
    const { line, col } = this.lineCol(o.src, el.sourceCodeLocation.startOffset);
    return `${o.file}:${line}:${col}`;
  }

  newTemplate(): number {
    const tid = this.templates.length;
    this.templates.push({ id: tid, nodes: [] });
    return tid;
  }

  fn(code: string): number {
    this.fns.push(code);
    return this.fns.length - 1;
  }

  expr(el: P5Element, attrName: string, scope: Scope, o: Omit<ExprOptions, 'report'>, value?: string, shift = 0): ExprResult {
    const src = value ?? attr(el, attrName) ?? '';
    const r = analyze(src, scope, this.page, { ...o, report: this.reporter(el, attrName, shift) });
    this.lastExpr = null;
    if (this.check) {
      const i = this.recordExpr(el, attrName, scope, o, src, shift, r);
      // a broken expression is there for editor completion only; nothing refers to it
      if (r.ok) this.lastExpr = i;
      else this.check.exprs[i]!.broken = true;
    }
    return r;
  }

  // ---- check unit

  /** Adds type information to the expression `expr()` recorded last. */
  typeLast(info: Partial<Pick<CheckExpr, 'resultType' | 'returns'>> & { payload?: TypeRef | null }) {
    if (!this.check || this.lastExpr === null) return;
    const e = this.check.exprs[this.lastExpr]!;
    if (info.resultType) e.resultType = info.resultType;
    if (info.returns) e.returns = info.returns;
    if (info.payload && e.payload) e.payload.type = info.payload;
  }

  locOf(el: P5Element, attrName: string | null, shift = 0): CheckLoc {
    const origin = this.origins.get(el) ?? { file: this.opts.file, src: '', chain: [] };
    const { line, col } = el.sourceCodeLocation ? this.lineCol(origin.src, this.valueOffset(el, attrName) + shift) : { line: 1, col: 1 };
    return { file: origin.file, line, col, chain: origin.chain };
  }

  recordExpr(el: P5Element, attrName: string, scope: Scope, o: Omit<ExprOptions, 'report'>, src: string, shift: number, r: ExprResult): number {
    const frames: number[] = [];
    for (const f of [...scope.states, ...scope.loops]) {
      const i = this.frameOf.get(f);
      if (i !== undefined && !frames.includes(i)) frames.push(i);
    }
    let event: string | null = null;
    if (attrName.startsWith('data-sn-on-')) event = attrName.slice('data-sn-on-'.length);
    else if (o.mode !== 'value' || o.magic?.includes('$event')) {
      event = attr(el, 'data-sn-trigger') ?? (el.tagName === 'form' ? 'submit' : FORM_CONTROLS.has(el.tagName) ? 'change' : 'click');
    }
    const e: CheckExpr = {
      src, mode: o.mode === 'value' ? 'value' : 'handler', loc: this.locOf(el, attrName, shift), frames, tag: el.tagName, event,
      result: attrName === 'data-sn-then', error: attrName === 'data-sn-catch',
    };
    if (o.payload) e.payload = { names: r.payloadNames ?? [], type: null, ...(r.payloadStates?.length ? { states: r.payloadStates } : {}) };
    this.check!.exprs.push(e);
    return this.check!.exprs.length - 1;
  }

  // ---- bindings

  attrBinding(el: P5Element, node: NodeDef, scope: Scope) {
    const r = this.expr(el, 'data-sn-attr', scope, { mode: 'value', object: 'literal-keys' });
    if (!r.entries) return;
    for (const e of r.entries) {
      const key = e.key.toLowerCase();
      if (key.startsWith('on')) {
        this.report(el, 'data-sn-attr', 'SN207', `\`${e.key}\` cannot be bound with \`data-sn-attr\`; use \`data-sn-on-${key.slice(2)}\``, e.offset);
        continue;
      }
      if (key === 'style') { this.report(el, 'data-sn-attr', 'SN207', '`style` cannot be bound with `data-sn-attr`; use `data-sn-style`', e.offset); continue; }
      if (key === 'srcdoc') { this.report(el, 'data-sn-attr', 'SN207', '`srcdoc` cannot be bound', e.offset); continue; }
      if (key.startsWith('data-sn')) { this.report(el, 'data-sn-attr', 'SN207', `\`${e.key}\` cannot be bound`, e.offset); continue; }
      if ((key === 'id' || key === 'name') && !e.literal) {
        this.report(el, 'data-sn-attr', 'SN503', `\`${key}\` bound from data can shadow globals other scripts read (DOM clobbering)`, e.offset);
      }
      if (r.ok) node.b.push(binding({ k: 'attr', n: e.key, f: this.fn(e.code), d: e.deps, ...usesEl(r) }));
    }
  }

  objectBinding(el: P5Element, node: NodeDef, scope: Scope, k: 'class' | 'style' | 'prop') {
    const name = `data-sn-${k}`;
    const r = this.expr(el, name, scope, { mode: 'value', object: k === 'class' ? 'any-keys' : 'literal-keys' });
    if (!r.entries) return;
    for (const e of r.entries) {
      let key = e.key;
      if (k === 'prop' && ['innerhtml', 'outerhtml', 'srcdoc', 'innertext', 'outertext'].includes(key.toLowerCase())) {
        this.report(el, name, 'SN207', `\`${key}\` cannot be set with \`data-sn-prop\``, e.offset);
        continue;
      }
      if (k === 'style' && !key.startsWith('--')) key = key.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase());
      if (r.ok) node.b.push(binding({ k, n: key, f: this.fn(e.code), d: e.deps, ...usesEl(r) }));
    }
  }

  model(el: P5Element, node: NodeDef, scope: Scope, persist: string | undefined) {
    const tag = el.tagName;
    const type = (attr(el, 'type') ?? 'text').toLowerCase();
    let kind: string;
    if (tag === 'select') kind = attr(el, 'multiple') != null ? 'multi' : 'select';
    else if (tag === 'textarea') kind = 'text';
    else if (tag === 'input') {
      if (type === 'file') { this.report(el, 'data-sn-model', 'SN104', '`data-sn-model` does not support `type="file"`; submit the form instead', 0); return; }
      kind = type === 'number' || type === 'range' ? 'number' : type === 'checkbox' ? 'checkbox' : type === 'radio' ? 'radio' : 'text';
    } else if (tag.includes('-')) kind = 'text';
    else { this.report(el, 'data-sn-model', 'SN102', '`data-sn-model` must be on `<input>`, `<select>` or `<textarea>`', 0); return; }
    if (persist !== undefined) {
      const ac = (attr(el, 'autocomplete') ?? '').toLowerCase().trim();
      if (type === 'password' || SECRET_AUTOCOMPLETE.test(ac)) {
        this.report(el, 'data-sn-persist', 'SN207', '`data-sn-persist` is refused on password, one-time-code and payment fields', 0);
        persist = undefined;
      } else this.features.add('persist');
    }
    const r = this.expr(el, 'data-sn-model', scope, { mode: 'value' });
    if (!r.ok) return;
    if (r.resource) {
      this.report(el, 'data-sn-model', 'SN205', `\`data-sn-model\` cannot write to resource \`${r.resource}\`; copy the item into state with structuredClone()`, 0);
      return;
    }
    if (!r.path || !(r.path[0]!.startsWith('$s') && r.path.length >= 2)) {
      this.report(el, 'data-sn-model', 'SN203', '`data-sn-model` takes a state path such as `q` or `draft.fn_name`', 0);
      return;
    }
    const inner = r.code.slice('($) => ('.length, -1);
    const setter = this.fn(`($, v) => { ${inner} = v; }`);
    const b = binding({ k: 'model', n: kind, f: this.fn(r.code), a: setter, d: r.deps, w: [r.path.join('.')], ...usesEl(r) });
    if (persist !== undefined) b.p = persist;
    node.b.push(b);
  }

  action(el: P5Element, node: NodeDef, scope: Scope, method: typeof METHODS[number] | 'call', get: (n: string) => string | undefined) {
    // arguments and body are taken when the trigger fires, so they see its event
    const call = method === 'call' ? this.callExpr(el, 'data-sn-call', scope, undefined, ['$event']) : null;
    if (method === 'call' && get('body') !== undefined) this.report(el, 'data-sn-body', 'SN102', '`data-sn-body` belongs to a method attribute; a call takes its arguments in `data-sn-call`', 0);
    const url = method === 'call' ? [] : this.urlTemplate(el, `data-sn-${method}`, scope);
    const tag = el.tagName;
    const isForm = tag === 'form';
    const trigger = get('trigger') ?? (isForm ? 'submit' : FORM_CONTROLS.has(tag) ? 'change' : 'click');
    if (!/^[a-z][a-z0-9-]*$/.test(trigger)) this.report(el, 'data-sn-trigger', 'SN401', '`data-sn-trigger` takes a DOM event name', 0);
    const debounce = get('debounce') !== undefined ? Number(get('debounce')) : 0;
    if (!Number.isFinite(debounce) || debounce < 0) this.report(el, 'data-sn-debounce', 'SN401', '`data-sn-debounce` takes milliseconds', 0);
    let concurrency = (get('concurrency') ?? (isForm ? 'block' : 'queue')) as ActionDef['concurrency'];
    if (!['block', 'queue', 'latest'].includes(concurrency)) {
      this.report(el, 'data-sn-concurrency', 'SN401', '`data-sn-concurrency` is `block`, `queue` or `latest`', 0);
      concurrency = 'queue';
    }
    if (get('concurrency') && method === 'get') this.report(el, 'data-sn-concurrency', 'SN102', '`data-sn-concurrency` applies to mutations only; `GET` actions are always latest-wins', 0);
    const fnOf = (n: string, o: Omit<ExprOptions, 'report'>, type?: Parameters<Compiler['typeLast']>[0]) => {
      if (get(n) === undefined) return { f: null, w: [] as string[] };
      const r = this.expr(el, `data-sn-${n}`, scope, o);
      if (type) this.typeLast(type);
      return { f: r.ok ? this.fn(r.code) : null, w: r.writes };
    };
    // with OpenAPI specs: the body must fit the request schema, `$result` gets the response's type
    const op = method !== 'call' && this.check && this.opts.openapi?.length ? matchOperation(this.opts.openapi, url, method) : null;
    const typed = op && 'spec' in op ? op : null;
    const body = fnOf('body', { mode: 'value', magic: ['$event'] }, typed?.request != null ? { returns: { kind: 'openapi', spec: typed.spec, schema: typed.request } } : undefined);
    const optimistic = fnOf('optimistic', { mode: 'optimistic' });
    if (optimistic.f !== null) this.features.add('optimistic');
    const then = fnOf('then', { mode: 'handler', magic: ['$event', '$result'] },
      typed?.body != null ? { resultType: { kind: 'openapi', spec: typed.spec, schema: typed.body } }
        : call ? { resultType: { kind: 'call', name: call.name } } : undefined);
    const catch_ = fnOf('catch', { mode: 'handler', magic: ['$event', '$error'] });
    const def: ActionDef = {
      method: method.toUpperCase() as ActionDef['method'], url, body: body.f, trigger, debounce, concurrency,
      optimistic: optimistic.f, then: then.f, catch: catch_.f, w: [...new Set([...then.w, ...catch_.w])].sort(), form: isForm,
      ...(call ? { call: { args: call.args, run: call.run } } : {}),
    };
    this.actions.push(def);
    node.b.push(binding({ k: 'on', n: trigger, x: this.actions.length - 1 }));
  }

  forTemplate(el: P5Element, node: NodeDef, scope: Scope, value: string, keySrc: string | undefined): { tid: number; scope: Scope } | null {
    const m = /^\s*(?:\(\s*([A-Za-z_][\w]*)\s*,\s*([A-Za-z_][\w]*)\s*\)|([A-Za-z_][\w]*))\s+in\s+/.exec(value);
    if (!m) {
      this.report(el, 'data-sn-for', 'SN401', '`data-sn-for` takes `item in list` or `(item, i) in list`', 0);
      return null;
    }
    const item = (m[1] ?? m[3])!;
    const index = m[2] ?? null;
    const list = this.expr(el, 'data-sn-for', scope, { mode: 'value' }, value.slice(m[0].length), m[0].length);
    const listExpr = this.lastExpr;
    const tid = this.newTemplate();
    const t = this.templates[tid]!;
    const ii = `$i${tid}`;
    t.item = item;
    t.index = index;
    t.ii = ii;
    const resInfo = list.resource ? this.page.resources.get(list.resource) : undefined;
    const alias = list.path && list.path[0]!.startsWith('$s') ? [...list.path, `{${ii}}`] : null;
    const loops: LoopEntry[] = [...scope.loops, { name: item, kind: 'item', alias, resource: list.resource }];
    if (index) loops.push({ name: index, kind: 'index', alias: null, resource: null, of: alias });
    if (this.check) {
      for (const l of loops.slice(scope.loops.length)) this.frameOf.set(l, this.check.frames.length);
      const itemAt = value.indexOf(item, value.indexOf('(') >= 0 && value.indexOf('(') < m[0].length ? value.indexOf('(') : 0);
      const frame: CheckFrame = { kind: 'loop', item, index, init: listExpr, loc: this.locOf(el, 'data-sn-for', itemAt) };
      if (index) frame.indexLoc = this.locOf(el, 'data-sn-for', value.indexOf(index, itemAt + item.length));
      this.check.frames.push(frame);
    }
    const inner: Scope = { loops, states: scope.states };
    t.key = null;
    t.keyFields = null;
    if (keySrc !== undefined) {
      const k = this.expr(el, 'data-sn-key', inner, { mode: 'value' });
      if (k.ok) t.key = this.fn(k.code);
    } else if (resInfo?.key) {
      t.keyFields = resInfo.key;
    } else if (list.ast && primitiveList(list.ast)) {
      this.report(el, 'data-sn-for', 'SN103', 'a `data-sn-for` over primitive values needs `data-sn-key`', m[0].length);
    }
    // a plain list path changes the rows only through its structure or replaced elements (`#`), not element fields
    const deps = alias && list.deps.length == 1 && list.deps[0] == list.path!.join('.') ? [list.deps[0] + '.#'] : list.deps;
    node.b.push(binding({ k: 'for', f: this.fn(list.code), d: deps, x: tid, ...usesEl(list) }));
    return { tid, scope: inner };
  }

  urlTemplate(el: P5Element, attrName: string, scope: Scope, exprOpts: Partial<ExprOptions> = {}, deps?: Set<string>): UrlTemplate {
    const value = attr(el, attrName) ?? '';
    const parts: UrlTemplate = [];
    let i = 0;
    let lit = '';
    while (i < value.length) {
      const c = value[i]!;
      if (c !== '{') { lit += c; i++; continue; }
      // find the matching brace, skipping strings
      let depth = 0, j = i, q: string | null = null;
      for (; j < value.length; j++) {
        const d = value[j]!;
        if (q) { if (d === '\\') j++; else if (d === q) q = null; continue; }
        if (d === '"' || d === "'" || d === '`') q = d;
        else if (d === '{') depth++;
        else if (d === '}' && --depth === 0) break;
      }
      if (j >= value.length) {
        this.report(el, attrName, 'SN401', 'unclosed `{` in URL template', i);
        return parts;
      }
      if (lit) parts.push(lit);
      lit = '';
      const r = this.expr(el, attrName, scope, { mode: 'value', ...exprOpts }, value.slice(i + 1, j), i + 1);
      parts.push(this.fn(r.code));
      if (deps) for (const d of r.deps) deps.add(d);
      i = j + 1;
    }
    if (lit) parts.push(lit);
    const first = parts[0];
    if (typeof first !== 'string' || !(/^\/[^/\\]/.test(first) || first === '/' || /^https?:\/\/[^/{}]+(\/|$)/i.test(first))) {
      this.report(el, attrName, 'SN207', 'a URL template must start with a literal same-origin path (`/api/…`) or a literal `https://` origin', 0,
        'a leading interpolation or `//` lets a value choose the host');
    }
    return parts;
  }

  // ---- declaration elements

  resource(el: P5Element, ctx: Ctx) {
    this.remove.push(el);
    const name = attr(el, 'name');
    if (!name || !this.page.resources.has(name) || this.resourceEls.get(name) !== el) return;
    if (ctx.tid >= 0) return;
    for (const a of el.attrs) {
      if (!RESOURCE_ATTRS.includes(a.name)) this.report(el, a.name, 'SN101', `\`${a.name}\` is not an attribute of \`<sn-resource>\`.${didYouMean(a.name, RESOURCE_ATTRS)}`, 0);
    }
    const info = this.page.resources.get(name)!;
    const hasCall = attr(el, 'call') != null;
    if (hasCall && attr(el, 'src') != null) this.report(el, 'call', 'SN102', 'a resource loads from `src` or from `call`, not both', 0);
    else if (!hasCall && attr(el, 'src') == null) this.report(el, null, 'SN401', `resource \`${name}\` needs a \`src\` (or a \`call\`)`, 0);
    if (hasCall) {
      for (const a of ['paginate', 'each', 'cache']) {
        if (attr(el, a) != null) this.report(el, a, 'SN401', `\`${a}\` does not combine with \`call\` in v0.2`, 0);
      }
    }
    const deps = new Set<string>();
    // `each="a in accounts"`: src is evaluated once per list item, with the item in scope
    let each: ResourceDef['each'];
    let srcScope = ctx.scope;
    const eachAttr = attr(el, 'each');
    if (eachAttr != null) {
      const m = /^\s*([A-Za-z_$][\w$]*)\s+in\s+/.exec(eachAttr);
      if (!m) this.report(el, 'each', 'SN401', '`each` takes `item in list`, e.g. `a in accounts`', 0);
      else {
        const list = this.expr(el, 'each', ctx.scope, { mode: 'value' }, eachAttr.slice(m[0].length), m[0].length);
        const listExpr = this.lastExpr;
        for (const d of list.deps) deps.add(d);
        const loop: LoopEntry = { name: m[1]!, kind: 'item', alias: null, resource: list.resource };
        if (this.check) {
          this.frameOf.set(loop, this.check.frames.length);
          this.check.frames.push({ kind: 'loop', item: m[1]!, index: null, init: listExpr, loc: this.locOf(el, 'each', eachAttr.indexOf(m[1]!)) });
        }
        srcScope = { loops: [...ctx.scope.loops, loop], states: ctx.scope.states };
        if (list.ok) each = { item: m[1]!, list: this.fn(list.code), ...(list.resource ? { of: list.resource } : {}) };
        this.features.add('each');
        if (!info.key) this.report(el, 'each', 'SN401', 'an `each` resource is a collection: it needs `key`, with a field that tells the sources apart', 0);
        for (const a of ['paginate', 'total', 'cache']) {
          if (attr(el, a) != null) this.report(el, a, 'SN401', `\`${a}\` does not combine with \`each\`: the items come from several requests`, 0);
        }
      }
    }
    const src = hasCall ? [] : this.urlTemplate(el, 'src', srcScope, {}, deps);
    const call = hasCall ? this.callExpr(el, 'call', ctx.scope, deps) : null;
    let when: number | null = null;
    if (attr(el, 'when') != null) {
      const r = this.expr(el, 'when', ctx.scope, { mode: 'value' });
      when = this.fn(r.code);
      for (const d of r.deps) deps.add(d);
    }
    let paginate: Paginate | null = null;
    const mode = attr(el, 'paginate');
    if (mode != null) {
      if (!['keyset', 'offset', 'append'].includes(mode)) {
        this.report(el, 'paginate', 'SN401', '`paginate` is `keyset`, `offset` or `append`', 0);
      } else {
        if (!info.key) this.report(el, 'paginate', 'SN401', 'a paginated resource needs `key`', 0);
        const size = Number(attr(el, 'page-size') ?? '');
        if (!Number.isInteger(size) || size <= 0) this.report(el, 'page-size', 'SN401', 'a paginated resource needs a positive `page-size`', 0);
        let cursor: number | null = null;
        if (mode !== 'offset') {
          if (attr(el, 'cursor') == null) this.report(el, null, 'SN401', `\`paginate="${mode}"\` needs \`cursor\``, 0);
          else {
            const r = this.expr(el, 'cursor', ctx.scope, { mode: 'value', payload: true });
            this.typeLast({ payload: { kind: 'item', resource: name } });
            if (r.ast && r.ast.type !== 'ObjectExpression') this.report(el, 'cursor', 'SN401', '`cursor` must be an object literal', 0);
            cursor = this.fn(r.code);
          }
        }
        paginate = {
          mode: mode as Paginate['mode'], size, sizeParam: attr(el, 'size-param') ?? 'limit', cursor,
          directionParam: attr(el, 'direction-param') ?? 'direction', pageParam: attr(el, 'page-param') ?? 'page',
        };
        const offsetParam = attr(el, 'offset-param');
        if (offsetParam != null) {
          if (mode !== 'keyset') this.report(el, 'offset-param', 'SN401', `\`offset-param\` applies to \`paginate="keyset"\`; ${mode === 'offset' ? 'offset pages jump with `page-param`' : 'append mode only loads more'}`, 0);
          else if (!/^[\w.\-\[\]]+$/.test(offsetParam)) this.report(el, 'offset-param', 'SN401', '`offset-param` is a query parameter name', 0);
          else paginate.offsetParam = offsetParam;
        }
        if (attr(el, 'direction-values') != null) {
          if (mode === 'offset') this.report(el, 'direction-values', 'SN401', '`direction-values` applies to `paginate="keyset"` and `paginate="append"`; offset pages send `page-param`', 0);
          else {
            const values = this.directionValues(el);
            if (values) paginate.directionValues = values;
          }
        }
        this.features.add('paginate');
      }
    }
    for (const a of ['page-size', 'size-param', 'cursor', 'direction-param', 'direction-values', 'page-param', 'offset-param']) {
      if (attr(el, a) != null && !paginate && mode == null) this.report(el, a, 'SN102', `\`${a}\` needs \`paginate\``, 0);
    }
    let cache: number | undefined;
    const cacheAttr = attr(el, 'cache');
    if (cacheAttr != null) {
      const m = /^\s*(?:(\d+)\s*(s|m|h|d))?\s*$/.exec(cacheAttr);
      if (!m) this.report(el, 'cache', 'SN401', '`cache` takes a maximum age such as `30s`, `10m`, `2h` or `1d`, or no value for any age', 0);
      else {
        cache = m[1] ? Number(m[1]) * { s: 1e3, m: 6e4, h: 36e5, d: 864e5 }[m[2] as 's' | 'm' | 'h' | 'd'] : 0;
        this.features.add('cache');
      }
    }
    const order = attr(el, 'order');
    const type = attr(el, 'type')?.trim() || null;
    const openapi = type || hasCall ? null : this.openapi(el, src, attr(el, 'items') ?? null, attr(el, 'total') ?? null);
    if (this.check) {
      const r: CheckResource = { name, type, loc: this.locOf(el, type ? 'type' : null), nameLoc: this.locOf(el, 'name') };
      if (openapi && 'schema' in openapi) r.openapi = openapi;
      if (call) r.call = { name: call.name, items: attr(el, 'items') ?? null };
      this.check.resources.push(r);
      // a resource fed by an action is typed by the action's result
      if (!type && !r.openapi && !r.call) {
        const hint = openapi && 'closest' in openapi
          ? `no OpenAPI GET operation matches \`src\`${openapi.closest ? ` (closest path: \`${openapi.closest}\`)` : ''}; add \`type="…"\`, or \`type="any"\` to leave it unchecked`
          : 'add `type="…"` with a type from the types module, or `type="any"` to leave it unchecked';
        this.report(el, null, 'SN504', `resource \`${name}\` has no type: expressions using it are not checked`, 0, hint);
      }
    }
    this.resources.push({
      name, src, key: info.key, items: attr(el, 'items') ?? null, total: attr(el, 'total') ?? null,
      order: order ? order.trim() : null, when, paginate, deps: [...deps].sort(), scope: ctx.stateIdx, data: null,
      ...(cache !== undefined ? { cache } : {}),
      ...(each ? { each } : {}),
      ...(call ? { call: { args: call.args, run: call.run } } : {}),
    });
  }

  /** Matches a resource against the OpenAPI specs; checks `items`, `total` and query parameter names. */
  openapi(el: P5Element, src: UrlTemplate, items: string | null, total: string | null):
    { spec: number; label: string; schema: unknown } | { closest: string | null } | null {
    const specs = this.opts.openapi;
    if (!specs?.length) return null;
    const m = matchResource(specs, src);
    if ('closest' in m) return m;
    const doc = specs[m.spec]!.doc;
    const label = `GET ${m.path}`;
    let schema = m.body;
    if (schema == null) return { closest: m.path };
    for (const [field, path] of [['items', items], ['total', total]] as const) {
      if (!path) continue;
      const w = walk(doc, m.body, path);
      if ('missing' in w) {
        this.report(el, field, 'SN308', `the response of \`${label}\` has no \`${w.missing}\`.${didYouMean(w.missing, w.have)}`, 0,
          w.have.length ? `it has ${w.have.map((h) => `\`${h}\``).join(', ')}` : undefined);
        if (field === 'items') return { closest: m.path };
      } else if (field === 'items') schema = w.schema;
    }
    const raw = attr(el, 'src') ?? '';
    for (const q of queryNames(src)) {
      if (m.query.includes(q)) continue;
      const at = raw.indexOf(q + '=', raw.indexOf('?'));
      this.report(el, 'src', 'SN505', `\`${label}\` declares no query parameter \`${q}\`.${didYouMean(q, m.query)}`, Math.max(at, 0));
    }
    return { spec: m.spec, label, schema };
  }

  sync(el: P5Element, ctx: Ctx) {
    this.remove.push(el);
    if (ctx.tid >= 0) { this.report(el, null, 'SN102', '`<sn-sync>` cannot be inside a `<template>`', 0); return; }
    for (const a of el.attrs) if (a.name !== 'src') this.report(el, a.name, 'SN101', `\`${a.name}\` is not an attribute of \`<sn-sync>\``, 0);
    const src = this.urlTemplate(el, 'src', ctx.scope);
    const events: EventDef[] = [];
    for (const c of el.childNodes) {
      if (!isElement(c)) {
        if (c.nodeName === '#text' && (c as DefaultTreeAdapterMap['textNode']).value.trim()) this.report(el, null, 'SN102', '`<sn-sync>` may only contain `<sn-event>` elements', 0);
        continue;
      }
      if (c.tagName !== 'sn-event') { this.report(c, null, 'SN102', '`<sn-sync>` may only contain `<sn-event>` elements', 0); continue; }
      const ev = this.event(c, ctx);
      if (ev) events.push(ev);
    }
    this.syncs.push({ src, events, ...(ctx.stateIdx >= 0 ? { scope: ctx.stateIdx } : {}) });
    this.features.add('sse');
  }

  event(el: P5Element, ctx: Ctx): EventDef | null {
    for (const a of el.attrs) {
      if (!EVENT_ATTRS.includes(a.name)) this.report(el, a.name, 'SN101', `\`${a.name}\` is not an attribute of \`<sn-event>\`.${didYouMean(a.name, EVENT_ATTRS)}`, 0);
    }
    const name = attr(el, 'name');
    const resource = attr(el, 'resource');
    const op = attr(el, 'op') as EventDef['op'] | undefined;
    if (!name) { this.report(el, null, 'SN401', '`<sn-event>` needs `name`', 0); return null; }
    if (!resource || !this.page.resources.has(resource)) {
      this.report(el, 'resource', 'SN301', `resource \`${resource ?? ''}\` is not declared on this page.${didYouMean(resource ?? '', this.page.resources.keys())}`, 0);
      return null;
    }
    if (!op || !['upsert', 'patch', 'remove', 'refetch'].includes(op)) {
      this.report(el, 'op', 'SN401', '`op` is `upsert`, `patch`, `remove` or `refetch`', 0);
      return null;
    }
    const scope = ctx.scope;
    const typeAttr = attr(el, 'type')?.trim() || null;
    const payloadType: TypeRef | null = typeAttr && typeAttr !== 'any' ? { kind: 'ts', text: typeAttr, loc: this.locOf(el, 'type') } : null;
    if (this.check && !typeAttr && ['item', 'set', 'when'].some((n) => attr(el, n) != null)) {
      this.report(el, null, 'SN506', `event \`${name}\` has no type: expressions reading its payload are not checked`, 0,
        'add `type="…"` with the payload type from the types module, or `type="any"` to leave it unchecked');
    }
    const fnOf = (n: string, object = false) => {
      if (attr(el, n) == null) return null;
      const r = this.expr(el, n, scope, { mode: 'value', payload: true, payloadState: true });
      this.typeLast({
        payload: payloadType,
        ...(n === 'item' ? { returns: { kind: 'item', resource } } : n === 'set' ? { returns: { kind: 'item', resource, partial: true } } : {}),
      });
      if (object && r.ast && r.ast.type !== 'ObjectExpression') this.report(el, n, 'SN401', `\`${n}\` must be an object literal`, 0);
      return this.fn(r.code);
    };
    const item = fnOf('item');
    const set = fnOf('set', true);
    if (item !== null && op !== 'upsert') this.report(el, 'item', 'SN102', '`item` applies to `op="upsert"`', 0);
    if (set !== null && op !== 'patch') this.report(el, 'set', 'SN102', '`set` applies to `op="patch"`', 0);
    if (op === 'patch' && set === null) this.report(el, null, 'SN401', '`op="patch"` needs `set`', 0);
    const fallback = attr(el, 'fallback');
    if (fallback != null && fallback !== 'refetch') this.report(el, 'fallback', 'SN401', '`fallback` takes `refetch`', 0);
    return { name, resource, op, item, set, when: fnOf('when'), fallback: fallback === 'refetch' ? 'refetch' : null };
  }

  injectScript(doc: DefaultTreeAdapterMap['document']) {
    const html = doc.childNodes.find((n) => isElement(n) && n.tagName === 'html') as P5Element | undefined;
    const head = html?.childNodes.find((n) => isElement(n) && n.tagName === 'head') as P5Element | undefined;
    if (!head) return;
    const src = this.opts.moduleSrc ?? `./${basename(this.opts.file).replace(/\.html?$/, '')}.sinter.js`;
    const frag = parse5.parseFragment(`<script type="module" src="${src.replace(/[&"<>]/g, (c) => `&#${c.charCodeAt(0)};`)}"></script>`);
    const script = frag.childNodes[0] as P5Element;
    script.parentNode = head;
    head.childNodes.push(script as never);
  }
}

// ---- helpers

/** Flags for the runtime: `e` when the expression reads `$el`, `i` when it reads a loop index. */
const usesEl = (r: ExprResult): Pick<Binding, 'e' | 'i'> => ({ ...(r.usesEl ? { e: 1 as const } : {}), ...(r.usesIndex ? { i: 1 as const } : {}) });

function binding(b: Binding): Binding {
  const out: Binding = { k: b.k };
  for (const key of ['f', 'd', 'n', 'x', 'a', 'y', 'w', 'p', 'e', 'i', 'ms'] as const) {
    const v = b[key];
    if (v === undefined || (Array.isArray(v) && v.length === 0 && key !== 'd')) continue;
    (out as unknown as Record<string, unknown>)[key] = v;
  }
  if (out.d && out.d.length === 0) delete out.d;
  return out;
}

function isElement(n: P5Node): n is P5Element {
  return 'tagName' in n;
}

function attr(el: P5Element, name: string): string | undefined {
  return el.attrs.find((a) => a.name === name)?.value;
}

function setAttr(el: P5Element, name: string, value: string) {
  const a = el.attrs.find((x) => x.name === name);
  if (a) a.value = value; else el.attrs.push({ name, value });
}

function stripSn(el: P5Element) {
  el.attrs = el.attrs.filter((a) => !a.name.startsWith('data-sn-'));
}

function hasSnDeep(parent: P5Parent): boolean {
  for (const c of parent.childNodes) {
    if (!isElement(c)) continue;
    if (c.attrs.some((a) => a.name.startsWith('data-sn-'))) return true;
    if (hasSnDeep(c)) return true;
    if (c.tagName === 'template' && hasSnDeep((c as P5Template).content)) return true;
  }
  return false;
}

/** Merges adjacent text nodes, as parsing the serialized HTML would. */
function mergeText(parent: P5Parent) {
  const kids = parent.childNodes as Array<P5Node & { value?: string }>;
  for (let i = kids.length - 1; i > 0; i--) {
    if (kids[i]!.nodeName === '#text' && kids[i - 1]!.nodeName === '#text') {
      kids[i - 1]!.value += kids[i]!.value!;
      kids.splice(i, 1);
    }
  }
}

function detach(el: P5Element) {
  const p = el.parentNode;
  if (!p) return;
  const i = p.childNodes.indexOf(el as never);
  if (i >= 0) p.childNodes.splice(i, 1);
  el.parentNode = null;
}

function primitiveList(ast: { type: string }): boolean {
  const a = ast as { type: string; elements?: Array<{ type: string } | null>; callee?: { type: string; object?: { type: string; name?: string }; property?: { name?: string } } };
  if (a.type === 'ArrayExpression') return (a.elements ?? []).every((e) => e && (e.type === 'Literal' || e.type === 'TemplateLiteral'));
  if (a.type === 'CallExpression' && a.callee?.type === 'MemberExpression') {
    const obj = a.callee.object, prop = a.callee.property?.name;
    if (obj?.type === 'Identifier' && obj.name === 'Object' && prop === 'keys') return true;
    if (prop === 'split') return true;
  }
  return false;
}

export function normalize(p: string): string {
  const abs = p.startsWith('/');
  const out: string[] = [];
  for (const seg of p.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') out.pop(); else out.push(seg);
  }
  return (abs ? '/' : '') + out.join('/');
}

export function dirname(p: string): string {
  const i = p.lastIndexOf('/');
  return i <= 0 ? (p.startsWith('/') ? '/' : '.') : p.slice(0, i);
}

export function basename(p: string): string {
  return p.slice(p.lastIndexOf('/') + 1);
}

function resolvePath(dir: string, rel: string): string {
  return normalize(rel.startsWith('/') ? rel : `${dir}/${rel}`);
}

/**
 * A row template's element lookup as straight-line code: each path prefix is walked once
 * (`firstChild` / `nextSibling`), and an element whose tag does not match comes out null.
 * The argument is the clone's first content node (the row element itself for a one-element row).
 */
export function findCode(nodes: NodeDef[]): string {
  const names = new Map<string, string>(), decls: string[] = [];
  const node = (p: number[]): string => {
    const key = p.join('.');
    let name = names.get(key);
    if (name) return name;
    const last = p[p.length - 1]!;
    const expr = last > 0 ? `${node([...p.slice(0, -1), last - 1])}?.nextSibling`
      : p.length > 1 ? `${node(p.slice(0, -1))}?.firstChild` : 'c';
    name = 'n' + names.size;
    names.set(key, name);
    decls.push(`${name} = ${expr}`);
    return name;
  };
  const out = nodes.map((nd) => {
    const x = node(nd.path!);
    return `${x}?.localName == ${JSON.stringify(nd.tag)} ? ${x} : null`;
  });
  return `(c) => { const ${decls.join(', ')}; return [${out.join(', ')}]; }`;
}
