// The compiler: one pure, deterministic function from annotated HTML to a
// rewritten page plus its IR and function table.
import * as parse5 from 'parse5';
import type { DefaultTreeAdapterMap } from 'parse5';
import { type Code, type Diagnostic, didYouMean, severityOf } from './diagnostics.js';
import { analyze, type ExprOptions, type ExprResult, type LoopEntry, type PageInfo, type ResourceInfo, type Scope } from './expr.js';
import { ATTRIBUTES, ELEMENTS } from './vocabulary.js';
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
}

export interface CompileResult {
  html: string;
  module: string;
  diagnostics: Diagnostic[];
  files: string[];
}

export interface CompiledParts {
  html: string;
  ir: IR;
  fns: string[];
  features: string[];
  /** helper names imported from the helpers module or the core */
  helpers: { user: string[]; builtin: string[] };
  namespaces: Record<string, string[]>;
  diagnostics: Diagnostic[];
  files: string[];
}

const ATTRS = ATTRIBUTES.map((a) => a.name);
const METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const;
const ACTION_ONLY = ['body', 'trigger', 'debounce', 'concurrency', 'optimistic', 'then', 'catch'];
const UNSAFE_ELEMENTS = new Set(['script', 'style', 'iframe', 'object', 'embed', 'base', 'meta', 'link', 'animate', 'set', 'animatemotion', 'animatetransform']);
const FORM_CONTROLS = new Set(['input', 'select', 'textarea']);
const RESOURCE_ATTRS = ELEMENTS.find((e) => e.name === 'sn-resource')!.attrs;
const EVENT_ATTRS = ELEMENTS.find((e) => e.name === 'sn-event')!.attrs;
const IDENT = /^[A-Za-z_][\w]*$/;
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
  nextId = 0;
  nextSid = 0;

  constructor(readonly opts: CompileOptions) {
    const ns = new Map<string, Set<string>>();
    for (const [k, v] of Object.entries(opts.helpers.namespaces)) ns.set(k, new Set(v.members));
    this.page = {
      resources: new Map(), helpers: new Set(opts.helpers.names), namespaces: ns,
      usedHelpers: new Set(), usedNs: new Map(), usesNow: false,
    };
  }

  run(html: string): CompiledParts {
    const doc = parse5.parse(html, { sourceCodeLocationInfo: true });
    this.tag(doc, { file: this.opts.file, src: html, chain: [] });
    this.expandIncludes(doc, [this.opts.file]);
    this.declare(doc);
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

    const ir: IR = { v: 1, resources: this.resources, syncs: this.syncs, roots: this.roots, templates: this.templates, actions: this.actions };
    if (this.page.usesNow) ir.now = true;
    const builtin: string[] = [];
    const user: string[] = [];
    for (const h of [...this.page.usedHelpers].sort()) (this.page.helpers.has(h) ? user : builtin).push(h);
    const namespaces: Record<string, string[]> = {};
    for (const [k, v] of [...this.page.usedNs].sort(([a], [b]) => a.localeCompare(b))) namespaces[k] = [...v].sort();
    return {
      html: parse5.serialize(doc),
      ir, fns: this.fns,
      features: [...(this.opts.dev ? ['dev'] : []), ...['sse', 'optimistic', 'paginate', 'persist'].filter((f) => this.features.has(f))],
      helpers: { user, builtin }, namespaces,
      diagnostics: this.diagnostics, files: [...this.files].sort(),
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

  report(el: P5Element | null, attr: string | null, code: Code, message: string, offset: number, hint?: string) {
    const origin = (el && this.origins.get(el)) || { file: this.opts.file, src: '', chain: [] };
    const base = el ? this.valueOffset(el, attr) : 0;
    const { line, col } = el?.sourceCodeLocation ? this.lineCol(origin.src, base + offset) : { line: 1, col: 1 };
    let msg = message;
    if (origin.chain.length) msg += ` (included from ${origin.chain.join(' ← ')})`;
    const d: Diagnostic = { severity: severityOf(code), code, message: msg, file: origin.file, line, col };
    if (hint) d.hint = hint;
    this.diagnostics.push(d);
  }

  reporter(el: P5Element, attr: string, shift = 0): ExprOptions['report'] {
    return (code, message, offset, hint) => this.report(el, attr, code, message, offset + shift, hint);
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
        this.page.resources.set(name, info);
        this.resourceEls.set(name, child);
        continue;
      }
      this.declare(child, inTemplate);
      if (child.tagName === 'template') this.declare((child as P5Template).content, true);
    }
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
        scope = { loops: scope.loops, states: [...scope.states, { sid, names: new Set(r.entries!.map((e) => e.key)) }] };
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

    for (const a of sn) {
      if (!a.name.startsWith('data-sn-on-')) continue;
      const event = a.name.slice('data-sn-on-'.length);
      if (!/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/.test(event)) {
        this.report(el, a.name, 'SN101', `event names are lowercase kebab-case: \`${a.name}\``, 0);
        continue;
      }
      const r = this.expr(el, a.name, scope, { mode: 'handler', magic: ['$event'] });
      if (r.ok) node.b.push(binding({ k: 'on', n: event, f: this.fn(r.code), w: r.writes }));
    }

    const methods = METHODS.filter((m) => has(m));
    if (methods.length > 1) this.report(el, `data-sn-${methods[1]}`, 'SN102', 'an element can have only one method attribute', 0);
    if (methods.length) this.action(el, node, scope, methods[0]!, get);
    else for (const n of ACTION_ONLY) if (has(n)) this.report(el, `data-sn-${n}`, 'SN102', `\`data-sn-${n}\` needs a method attribute (\`data-sn-get\`, \`-post\`, …) on the same element`, 0);

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
    return analyze(src, scope, this.page, { ...o, report: this.reporter(el, attrName, shift) });
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

  action(el: P5Element, node: NodeDef, scope: Scope, method: typeof METHODS[number], get: (n: string) => string | undefined) {
    const url = this.urlTemplate(el, `data-sn-${method}`, scope);
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
    const fnOf = (n: string, o: Omit<ExprOptions, 'report'>) => {
      if (get(n) === undefined) return { f: null, w: [] as string[] };
      const r = this.expr(el, `data-sn-${n}`, scope, o);
      return { f: r.ok ? this.fn(r.code) : null, w: r.writes };
    };
    const body = fnOf('body', { mode: 'value' });
    const optimistic = fnOf('optimistic', { mode: 'optimistic' });
    if (optimistic.f !== null) this.features.add('optimistic');
    const then = fnOf('then', { mode: 'handler', magic: ['$event', '$result'] });
    const catch_ = fnOf('catch', { mode: 'handler', magic: ['$event', '$error'] });
    const def: ActionDef = {
      method: method.toUpperCase() as ActionDef['method'], url, body: body.f, trigger, debounce, concurrency,
      optimistic: optimistic.f, then: then.f, catch: catch_.f, w: [...new Set([...then.w, ...catch_.w])].sort(), form: isForm,
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
    node.b.push(binding({ k: 'for', f: this.fn(list.code), d: list.deps, x: tid, ...usesEl(list) }));
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
    if (attr(el, 'src') == null) this.report(el, null, 'SN401', `resource \`${name}\` needs a \`src\``, 0);
    const deps = new Set<string>();
    const src = this.urlTemplate(el, 'src', ctx.scope, {}, deps);
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
            if (r.ast && r.ast.type !== 'ObjectExpression') this.report(el, 'cursor', 'SN401', '`cursor` must be an object literal', 0);
            cursor = this.fn(r.code);
          }
        }
        paginate = {
          mode: mode as Paginate['mode'], size, sizeParam: attr(el, 'size-param') ?? 'limit', cursor,
          directionParam: attr(el, 'direction-param') ?? 'direction', pageParam: attr(el, 'page-param') ?? 'page',
        };
        this.features.add('paginate');
      }
    }
    for (const a of ['page-size', 'size-param', 'cursor', 'direction-param', 'page-param']) {
      if (attr(el, a) != null && !paginate && mode == null) this.report(el, a, 'SN102', `\`${a}\` needs \`paginate\``, 0);
    }
    const order = attr(el, 'order');
    this.resources.push({
      name, src, key: info.key, items: attr(el, 'items') ?? null, total: attr(el, 'total') ?? null,
      order: order ? order.trim() : null, when, paginate, deps: [...deps].sort(), scope: ctx.stateIdx, data: null,
    });
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
    this.syncs.push({ src, events });
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
    const fnOf = (n: string, object = false) => {
      if (attr(el, n) == null) return null;
      const r = this.expr(el, n, scope, { mode: 'value', payload: true, ...(object ? {} : {}) });
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

/** `{ e: 1 }` when the expression reads `$el`, so the runtime adds it to the scope. */
const usesEl = (r: ExprResult): Pick<Binding, 'e'> => (r.usesEl ? { e: 1 } : {});

function binding(b: Binding): Binding {
  const out: Binding = { k: b.k };
  for (const key of ['f', 'd', 'n', 'x', 'a', 'y', 'w', 'p', 'e'] as const) {
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
