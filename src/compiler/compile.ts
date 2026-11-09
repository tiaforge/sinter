// The compiler: one pure, deterministic function from annotated HTML to a
// rewritten page plus its IR and function table.
import { rewriteImages, type ImageHost, type ImageResult } from './images.js';
import { Layout } from './layout.js';
import type { RemoteConfig } from '../remote.js';
import { AUTO_FIT_HINT, AUTO_FIT_ROWS, FLUID_WIDTHS } from './images.js';
import * as parse5 from 'parse5';
import { parseExpressionAt } from 'acorn';
import type { DefaultTreeAdapterMap } from 'parse5';
import { type Code, type Diagnostic, didYouMean, severityOf } from './diagnostics.js';
import { analyze, literalNames, STORE_FNS, type ExprOptions, type ExprResult, type LetEntry, type LoopEntry, type PageInfo, type Read, type ResourceInfo, type Scope } from './expr.js';
import type { Node } from 'acorn';
import type * as acorn from 'acorn';
import { COMPLEXITY_DEFAULTS, COMPLEXITY_LIMITS, measure, type ComplexityOptions } from './complexity.js';
import { ATTRIBUTES, CHAR_KEYS, ELEMENTS, KEY_ALIASES, LOOSE_SHIFT, MODIFIERS, NAMED_KEYS } from './vocabulary.js';
import type { CheckExpr, CheckFrame, CheckLoc, CheckResource, CheckUnit, TypeRef } from './check-unit.js';
import { matchOperation, matchResource, namedAt, namedSchema, properties, propertyNames, queryNames, responseEntities, walk, wrapperKey, type OpenApiSpec } from './openapi.js';
import type { ActionDef, ApplyDef, Binding, EarlyIR, EventDef, IR, NodeDef, Paginate, ResourceDef, SyncDef, TemplateDef, UrlTemplate } from '../ir.js';
import { $k, schemesOf, STYLE_BAD, urlAllowed } from '../runtime/security.js';

type P5Node = DefaultTreeAdapterMap['node'];
type P5Element = DefaultTreeAdapterMap['element'];
type P5Parent = DefaultTreeAdapterMap['parentNode'];
type P5Template = DefaultTreeAdapterMap['template'];

export interface HelperOrigin { module: string; name: string }

export interface HelperManifest {
  /** import specifier of the helpers module, or null */
  module: string | null;
  names: string[];
  /** where a re-exported helper is declared (`export { x } from './lib.js'`, `export * from`): the early chunk imports it from there */
  from?: Record<string, HelperOrigin>;
  namespaces: Record<string, { module: string; members: string[]; from?: Record<string, HelperOrigin> }>;
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
  /** SN507: limits for expressions too complex for markup, and the level (default `warn`) */
  complexity?: ComplexityOptions;
  /** SN509: report `then`/`catch` handlers that start each other again through `run()` (off by default) */
  checkCycles?: boolean;
  /** write bindings whose value is a build-time constant (literal state, no helpers) into the HTML */
  prerender?: boolean;
  /**
   * the early chunk: a second, render-blocking page entry that runs the app's early module and
   * the bindings outside templates whose inputs exist before any data has loaded. `module`: the
   * app's early module (`/src/sinter.early.ts`) or null; `src`: where the page loads the early
   * entry from, injected before the page module (the Vite plugin injects it itself in builds)
   */
  early?: { module: string | null; src?: string | null };
  /** static `<img>` become `<picture>` with optimized variants (docs/images.md); the adapter encodes them */
  images?: ImageHost;
  /** images from the API: an `<img>` whose `src` is bound to data gets a `srcset` of the resizing service's URLs (docs/images.md, step 2) */
  remoteImages?: RemoteConfig;
  /**
   * other origins whose resources (a literal `https://` origin in `src`) are preloaded or requested
   * early like same-origin ones, as `configure({ origins })` allows them at runtime; without
   * credentials, as the request layer sends cross-origin requests
   */
  origins?: string[];
  /** builds: a page with early requests gets a split early file (`earlySplit`): see `prime` in `@tiaforge-ui/sinter/early` */
  splitEarly?: boolean;
  /** the module whose default export is the app's `prefetch` feature (every page's description), added to the page's features */
  prefetch?: string | null;
}

export interface CompileResult {
  html: string;
  module: string;
  diagnostics: Diagnostic[];
  files: string[];
  /** with `check: true` */
  check?: CheckUnit;
  /** with `early`: the page's early module, or null when the page has nothing to run early */
  early?: string | null;
  /** with `splitEarly`: the early file exports `render`, and the page loads it `async` first and renders it from a stub */
  earlySplit?: true;
  /** the built-in message keys the page calls (markup only; modules are collected by the adapter); absent without built-in messages */
  messages?: string[];
  /** with `images` */
  images?: ImageResult;
  /** every width the page asks the resizing service for (`remoteImages`) */
  remoteWidths?: number[];
  /** what another page needs to request this page's data ahead (null: nothing) */
  prefetch: PrefetchParts | null;
  /** the page's `data-sn-path` patterns */
  path: string[];
  /** `<html data-sn-prefetch="off">`: no other page prefetches or prerenders this one */
  /** origins of resources that could be requested early but are not in `origins` */
  unlistedOrigins?: string[];
  prefetchOff?: true;
}

/** What the early chunk runs: the bindings that can render before data, and what they import. */
export interface EarlyParts {
  ir: EarlyIR;
  fns: string[];
  /** helper names and namespace members the early bindings call */
  helpers: string[];
  namespaces: Record<string, string[]>;
}

/**
 * What another page needs to request this page's data ahead (the `prefetch` feature): its
 * `data-sn-path` patterns and the resources whose request only `$url` decides. Function indexes
 * point into `fns`.
 */
export interface PrefetchParts {
  path: string[];
  res: Array<{ s: UrlTemplate; w?: number; i: string | null; t: string | null; k?: 1 }>;
  fns: string[];
  /** helper names and namespace members the functions call */
  helpers: string[];
  namespaces: Record<string, string[]>;
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
  /** with `early`: the early chunk's bindings, or null when none can run early */
  early?: EarlyParts | null;
  /** with `images` */
  images?: ImageResult;
  /** the resizing service's config, when a bound image uses it (the page module creates `$ri` from it) */
  remote?: RemoteConfig;
  /** every width the page asks the service for */
  remoteWidths?: number[];
  /** what another page needs to request this page's data ahead; null when no request is decided by the URL alone */
  prefetch: PrefetchParts | null;
  /** `<html data-sn-prefetch="off">` */
  prefetchOff?: true;
  /** origins of resources that could be requested early but are not in `origins` */
  unlistedOrigins?: string[];
}

const ATTRS = ATTRIBUTES.map((a) => a.name);
const METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const;
/** an action's expressions evaluated when it triggers, so they see `$event` */
const TRIGGER_TIME = new Set(['data-sn-get', 'data-sn-post', 'data-sn-put', 'data-sn-patch', 'data-sn-delete', 'data-sn-call', 'data-sn-body', 'data-sn-confirm']);
const ACTION_ONLY = ['body', 'trigger', 'debounce', 'concurrency', 'optimistic', 'then', 'catch', 'confirm', 'encoding', 'apply'];
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
  /** inside a `<dialog>` of the same block (page or template) */
  dialog?: boolean;
}

export function compileParts(html: string, options: CompileOptions): CompiledParts {
  return new Compiler(options).run(html);
}

class Compiler {
  readonly diagnostics: Diagnostic[] = [];
  readonly files = new Set<string>();
  readonly fns: string[] = [];
  readonly fnIndex = new Map<string, number>();
  readonly origins = new WeakMap<object, Origin>();
  /** attributes SN507 has measured, so an expression analysed twice is reported once */
  readonly measured = new WeakMap<P5Element, Set<string>>();
  readonly lineStarts = new Map<string, number[]>();
  readonly page: PageInfo;
  readonly resources: ResourceDef[] = [];
  /** resources with `early="off"`: no preload, no early request (one a request middleware answers or adds a header to) */
  private readonly noEarly = new Set<string>();
  /** origins of resources that could be requested early but are not listed in `origins` */
  readonly unlisted = new Set<string>();
  /** whether a resource's literal `src` may be requested before the page module: same-origin, or a listed origin */
  private earlyOrigin(src: ResourceDef['src']): 'same' | 'listed' | null {
    const head = typeof src[0] === 'string' ? src[0] : '';
    if (/^\/(?!\/)/.test(head)) return 'same';
    const m = /^https?:\/\/[^/?#]+/i.exec(head);
    if (!m) return null;
    const origin = new URL(m[0]).origin;
    if ((this.opts.origins ?? []).some((o) => { try { return new URL(o).origin === origin; } catch { return false; } })) return 'listed';
    this.unlisted.add(origin);
    return null;
  }
  readonly resourceEls = new Map<string, P5Element>();
  readonly syncs: SyncDef[] = [];
  /** templates inside a `<dialog>`, at any depth: nothing in them is painted before that dialog opens */
  readonly dlTemplates = new Set<number>();
  /** per resource matched to a spec: its item schema, for write-through (`sch`, provenance sub-paths) */
  readonly itemSchema = new Map<string, { spec: number; schema: unknown }>();
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
  /** action elements by literal `id` (`run()` targets) */
  readonly idEls = new Map<string, P5Element>();
  /** check unit: the expressions recorded per element, so `run()` targets can type their `$event` */
  readonly exprsOf = new Map<P5Element, Array<{ attr: string; i: number }>>();
  /** handlers that call `run()` or `refresh()`, for SN509 */
  readonly flows: Array<{ el: P5Element; attr: string; shift: number; runs: NonNullable<ExprResult['runs']>; refreshes: NonNullable<ExprResult['refreshes']> }> = [];
  /** first paint: page-level nodes with bindings, and every state scope's fields */
  readonly paints: Array<{ el: P5Element; node: NodeDef }> = [];
  readonly stateInits: Array<{ sid: number; fields: Array<{ key: string; code: string; deps: string[] }>; persist: string | null }> = [];
  /** `<html data-sn-prefetch="off">`: other pages do not prefetch or prerender this one */
  prefetchOff = false;
  /** `data-sn-path` patterns (for `$url` in the early file's requests) */
  pathList: string[] = [];
  /** `$s<sid>.<name>` paths a persisted model writes at mount */
  readonly persisted = new Set<string>();
  /** bindings `prerender()` wrote into the HTML as constants: the early chunk leaves them out */
  readonly painted = new Set<Binding>();
  /** the page's stylesheets as a cascade (images: boxes of static and bound images) */
  layout: Layout | null = null;
  /** a bound `<img src>` goes through the resizing service (`remoteImages`), with these widths */
  remoteUsed = false;
  readonly remoteWidths = new Set<number>();

  constructor(readonly opts: CompileOptions) {
    this.check = opts.check ? { file: opts.file, resources: [], frames: [], exprs: [] } : null;
    const ns = new Map<string, Set<string>>();
    for (const [k, v] of Object.entries(opts.helpers.namespaces)) ns.set(k, new Set(v.members));
    this.page = {
      resources: new Map(), helpers: new Set(opts.helpers.names), namespaces: ns,
      actions: new Set([...(opts.actions?.names ?? []), ...Object.keys(opts.actions?.namespaces ?? {})]),
      usedHelpers: new Set(), usedNs: new Map(), usesNow: false, pathParams: new Set(), dialogs: new Set(), ids: new Map(),
    };
  }

  run(html: string): CompiledParts {
    const doc = parse5.parse(html, { sourceCodeLocationInfo: true });
    this.tag(doc, { file: this.opts.file, src: html, chain: [] });
    this.expandIncludes(doc, [this.opts.file]);
    const layout = this.layout = this.opts.images?.styles?.length ? new Layout(this.opts.images.styles, doc) : null;
    const images = this.opts.images ? rewriteImages(doc, {
      host: this.opts.images, root: this.opts.root,
      ...(layout ? { layout: (el: P5Element) => layout.box(el), maxWidth: (el: P5Element) => layout.maxWidth(el), fluidSizes: (el: P5Element, w?: number) => layout.fluidSizes(el, w), autoFitRows: () => layout.autoFitRows } : {}),
      fileOf: (el) => this.origins.get(el)?.file ?? this.opts.file,
      warn: (el, a, code, message, hint) => this.report(el, a, code, message, 0, hint),
    }) : undefined;
    this.declare(doc);
    const paths = this.pathPatterns(doc);
    this.pathList = paths;
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
    this.runTargets();
    if (this.opts.checkCycles) this.runCycles();
    for (const el of this.remove) detach(el);
    this.markLowPriority();
    if (this.opts.prerender) this.prerender();
    const early = this.opts.early ? this.earlyParts() : undefined;
    this.injectScript(doc, early !== undefined && (early !== null || !!this.opts.early!.module) ? this.opts.early!.src ?? null : null);
    // row templates (data-sn-for) get a compiled element lookup; if/else branches render once per
    // toggle and use the generic path walk, which costs no code per template
    const rowTemplates = new Set([...this.roots, ...this.templates.flatMap((t) => t.nodes)].flatMap((n) => n.b.filter((b) => b.k === 'for').map((b) => b.x!)));
    for (const t of this.templates) {
      if (!t.nodes.length || !rowTemplates.has(t.id)) continue;
      t.find = this.fn(findCode(t.nodes));
      const make = makeCode(t.nodes, this.fns);
      if (make) t.make = this.fn(make);
    }

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
      features: [...(this.opts.dev ? ['dev'] : []), ...['sse', 'optimistic', 'paginate', 'persist', 'cache', 'each', 'listbox', 'keys', 'apply', 'transition'].filter((f) => this.features.has(f))],
      helpers: { user, builtin }, namespaces, calls: [...this.calls].sort(),
      diagnostics: this.diagnostics, files: [...this.files].sort(),
      ...(this.check ? { check: this.check } : {}),
      ...(early !== undefined ? { early } : {}),
      ...(images ? { images } : {}),
      ...(this.remoteUsed ? { remote: this.opts.remoteImages!, remoteWidths: [...this.remoteWidths].sort((a, b) => a - b) } : {}),
      prefetch: this.prefetchOff ? null : this.prefetchParts(),
      ...(this.prefetchOff ? { prefetchOff: true as const } : {}),
      ...(this.unlisted.size ? { unlistedOrigins: [...this.unlisted].sort() } : {}),
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

  // ---- declarations (first pass: names only, so expressions can see every resource and dialog)

  declare(parent: P5Parent, inTemplate = false, inRow = false) {
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
        if (STORE_FNS.includes(name)) {
          this.report(child, 'name', 'SN209', `\`${name}\` is a store function (\`${name}()\`); a resource cannot take its name`, 0);
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
      const id = attr(child, 'id');
      if (id && child.tagName === 'dialog') this.page.dialogs.add(id);
      if (id) {
        const t = this.page.ids!.get(id) ?? { action: false, row: false, n: 0 };
        const action = attr(child, 'data-sn-call') != null || METHODS.some((m) => attr(child, `data-sn-${m}`) != null);
        t.n++;
        if (action) { t.action = true; t.row ||= inRow; }
        this.page.ids!.set(id, t);
        if (action) this.idEls.set(id, child);
      }
      this.declare(child, inTemplate, inRow);
      if (child.tagName === 'template') this.declare((child as P5Template).content, true, inRow || attr(child, 'data-sn-for') != null);
    }
  }

  // ---- run(): targets and cycles

  /**
   * A non-form action `run()` starts gets no event: its trigger-time expressions (URL, body, call
   * arguments, confirm) type `$event` as `RunEvent<…>`, so `sinter check` reports unguarded reads.
   * A form is submitted (`requestSubmit()`), so its `$event` is a real `SubmitEvent`.
   */
  runTargets() {
    if (!this.check) return;
    const ids = new Set(this.flows.flatMap((f) => f.runs.map((r) => r.id)));
    for (const id of ids) {
      const el = this.idEls.get(id);
      if (!el || el.tagName === 'form') continue;
      for (const { attr: a, i } of this.exprsOf.get(el) ?? []) {
        if (TRIGGER_TIME.has(a) && this.check.exprs[i]!.event !== null) this.check.exprs[i]!.run = true;
      }
    }
  }

  /**
   * SN509 (opt-in, `checkCycles`): `then`/`catch` handlers that start each other again. Nodes are
   * action elements (by id) and resources; an edge is a `run('id')` in an action's `then`/`catch`
   * or a resource's `then`, or a `refresh('name')` there (a load runs the resource's `then`).
   * Each elementary cycle with at least one `run()` is reported once, at its first step.
   */
  runCycles() {
    type Edge = { to: string; run: boolean; flow: Compiler['flows'][number]; offset: number };
    const nodeOf = (el: P5Element, a: string): string | null => {
      if (el.tagName === 'sn-resource') return a === 'then' ? `r:${attr(el, 'name')}` : null;
      const id = attr(el, 'id');
      return id && (a === 'data-sn-then' || a === 'data-sn-catch') && this.idEls.get(id) === el ? `#${id}` : null;
    };
    const edges = new Map<string, Edge[]>();
    for (const f of this.flows) {
      const from = nodeOf(f.el, f.attr);
      if (!from) continue;
      const list = edges.get(from) ?? [];
      for (const r of f.runs) list.push({ to: `#${r.id}`, run: true, flow: f, offset: r.offset });
      for (const r of f.refreshes) list.push({ to: `r:${r.name}`, run: false, flow: f, offset: r.offset });
      edges.set(from, list);
    }
    const order = [...edges.keys()];
    const rank = new Map(order.map((k, i) => [k, i]));
    const where = (e: Edge) => {
      const o = this.origins.get(e.flow.el) ?? { file: this.opts.file, src: '', chain: [] };
      const { line } = e.flow.el.sourceCodeLocation ? this.lineCol(o.src, this.valueOffset(e.flow.el, e.flow.attr) + e.flow.shift + e.offset) : { line: 1 };
      const rel = o.file.startsWith(this.opts.root) ? o.file.slice(this.opts.root.length).replace(/^\//, '') : o.file;
      return `${rel}:${line}`;
    };
    const label = (n: string) => (n.startsWith('#') ? `\`${n}\`` : `\`<sn-resource name="${n.slice(2)}">\``);
    let reported = 0;
    for (const start of order) {
      const s = rank.get(start)!;
      const path: Edge[] = [];
      const onPath = new Set<string>([start]);
      const dfs = (n: string) => {
        for (const e of edges.get(n) ?? []) {
          if (reported >= 20) return;
          const r = rank.get(e.to);
          if (r === undefined || r < s) continue;
          path.push(e);
          if (e.to === start) {
            if (path.some((p) => p.run)) {
              let from = start;
              const steps = path.map((p) => {
                const step = `${label(from)} \`${p.flow.attr}\` (${where(p)}) ${p.run ? 'runs' : 'refreshes'} ${p.run ? label(p.to) : `\`${p.to.slice(2)}\``}`;
                from = p.to;
                return step;
              });
              const first = path[0]!;
              this.report(first.flow.el, first.flow.attr, 'SN509', `\`run()\` cycle: ${steps.join(', then ')}, which starts the first step again`, first.flow.shift + first.offset,
                'each step starts the next, so the requests never stop; a step that should end needs a condition that becomes false, or one step goes. Reported because the cycle check is on (`sinter check --check-cycles` or `sinter({ checkCycles: true })`)', true);
              reported++;
            }
          } else if (!onPath.has(e.to)) {
            onPath.add(e.to);
            dfs(e.to);
            onPath.delete(e.to);
          }
          path.pop();
        }
      };
      dfs(start);
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
      if (known.has(a.name) || a.name.startsWith('data-sn-on-') || a.name.startsWith('data-sn-debounce-')) continue;
      this.report(el, a.name, 'SN101', `\`${a.name}\` is not a sinter attribute.${didYouMean(a.name, [...known, 'data-sn-on-click'])}`, 0);
    }

    if (has('path') && el.tagName !== 'html') this.report(el, 'data-sn-path', 'SN102', '`data-sn-path` belongs on `<html>`', 0);
    if (has('prefetch')) {
      if (el.tagName !== 'html') this.report(el, 'data-sn-prefetch', 'SN102', '`data-sn-prefetch` belongs on `<html>`: it keeps other pages from prefetching or prerendering this one', 0);
      else if (get('prefetch')!.trim() !== 'off') this.report(el, 'data-sn-prefetch', 'SN401', '`data-sn-prefetch` takes `off`; prefetching is on without the attribute', 0);
      else this.prefetchOff = true;
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
    const inDialog = ctx.dialog || el.tagName === 'dialog';
    if (inDialog) node.dl = 1;
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
        this.checkNames(el, 'data-sn-state', scope, [...entry.names]);
        scope = { ...scope, states: [...scope.states, entry] };
        if (has('persist') && !has('model')) {
          node.persist = get('persist')!;
          this.features.add('persist');
        }
        this.stateInits.push({ sid, fields: r.entries!.map((e) => ({ key: e.key, code: e.code, deps: e.deps })), persist: node.persist ?? null });
      }
    }

    // derived names: the element and its subtree read them like state
    if (has('let')) scope = this.lets(el, scope);

    // a text field with suggestions: the listbox feature handles the keys (see src/listbox.ts)
    if (has('listbox')) {
      const list = get('listbox')!;
      if (!['input', 'textarea'].includes(el.tagName)) this.report(el, 'data-sn-listbox', 'SN102', '`data-sn-listbox` belongs on a text `<input>` or `<textarea>`', 0);
      else if (list && !/^[A-Za-z][\w-]*$/.test(list)) this.report(el, 'data-sn-listbox', 'SN401', '`data-sn-listbox` takes the literal `id` of the suggestion list, or nothing for the nearest `[role="listbox"]` around the input', 0);
      else {
        setAttr(el, 'role', 'combobox');
        if (list) setAttr(el, 'aria-controls', list);
        setAttr(el, 'aria-autocomplete', 'list');
        this.features.add('listbox');
      }
    }

    const isTemplate = el.tagName === 'template';
    const valueB = (k: 'text' | 'show', name: string) => {
      const r = this.expr(el, name, scope, { mode: 'value' });
      if (r.ok) node.b.push(binding({ k, f: this.fn(r.code), d: r.deps, ...usesEl(r), s: this.selection(scope, attr(el, name) ?? '', r.ast, r) }));
    };

    for (const n of ['for', 'if', 'else'] as const) {
      if (has(n) && !isTemplate) this.report(el, `data-sn-${n}`, 'SN102', `\`data-sn-${n}\` must be on a \`<template>\``, 0);
    }
    if (has('key') && !(isTemplate && has('for'))) this.report(el, 'data-sn-key', 'SN102', '`data-sn-key` belongs on a `<template data-sn-for>`', 0);

    if (has('text')) valueB('text', 'data-sn-text');
    if (has('show')) valueB('show', 'data-sn-show');
    // the morph across a navigation: the name is kept on the element, the transition feature uses it
    if (has('transition')) {
      const r = this.expr(el, 'data-sn-transition', scope, { mode: 'value' });
      if (r.ok) { node.b.push(binding({ k: 'attr', n: 'data-sn-vt', f: this.fn(r.code), d: r.deps, ...usesEl(r) })); this.features.add('transition'); }
    }
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
    // `data-sn-debounce-<event>`: only that event's handler waits
    for (const a of sn) {
      if (!a.name.startsWith('data-sn-debounce-')) continue;
      const event = a.name.slice('data-sn-debounce-'.length), ms = Number(a.value);
      if (!Number.isFinite(ms) || ms < 0 || a.value.trim() === '') this.report(el, a.name, 'SN401', `\`${a.name}\` takes milliseconds`, 0);
      if (!has(`on-${event}`)) this.report(el, a.name, 'SN102', `\`${a.name}\` needs a \`data-sn-on-${event}\` handler on the same element`, 0);
    }
    for (const a of sn) {
      if (!a.name.startsWith('data-sn-on-')) continue;
      const event = a.name.slice('data-sn-on-'.length);
      // `keydown-<modifiers->key`: a key filter on keydown or keyup
      const kf = /^(key(?:down|up))-(.*)$/s.exec(event);
      const filter = kf ? this.keyFilter(el, a.name, kf[2]!) : undefined;
      if (filter === null) continue;
      if (filter) this.features.add('keys');
      if (!kf && !/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/.test(event)) {
        this.report(el, a.name, 'SN101', `event names are lowercase kebab-case: \`${a.name}\``, 0);
        continue;
      }
      const r = this.expr(el, a.name, scope, { mode: 'handler', magic: ['$event'] });
      const own = get(`debounce-${event}`), ms = own !== undefined ? Number(own) || 0 : handlerDebounce;
      if (r.ok) node.b.push(binding({ k: 'on', n: kf ? kf[1]! : event, f: this.fn(r.code), w: r.writes, ...filter, ...(ms > 0 ? { ms } : {}) }));
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
        this.paints.push({ el, node });
      } else node.path = [...ctx.path, index];
      if (this.opts.dev) (node as NodeDef & { src?: string }).src = this.position(el);
      ctx.list.push(node);
    }
    stripSn(el);

    if (content) {
      if (inDialog || this.dlTemplates.has(ctx.tid)) this.dlTemplates.add(content.tid);
      const t = this.templates[content.tid]!;
      this.walkChildren((el as P5Template).content, { scope: content.scope, list: t.nodes, tid: content.tid, path: [], stateIdx: -1 });
    } else if (isTemplate) {
      if (hasSnDeep((el as P5Template).content)) {
        this.report(el, null, 'SN102', 'directives inside a `<template>` need `data-sn-for` or `data-sn-if` on it', 0);
      }
    } else {
      this.walkChildren(el, {
        ...ctx, scope, dialog: inDialog,
        stateIdx: node.state !== undefined && hasDirectives ? nodeIdx : ctx.stateIdx,
        path: ctx.tid >= 0 ? [...ctx.path, index] : ctx.path,
      });
    }
    return result;
  }

  /**
   * `data-sn-on-keydown-ctrl-shift-k`: the part after the event, modifiers first and the key last.
   * Returns the binding's `q` (the `KeyboardEvent.key` to match) and `m` (modifier bits), or null
   * after reporting what is wrong.
   */
  keyFilter(el: P5Element, attrName: string, spec: string): { q: string; m?: number } | null {
    const fail = (message: string) => { this.report(el, attrName, 'SN101', message, 0); return null; };
    const tokens = spec.split('-'), key = tokens.pop()!;
    const keyNames = [...Object.keys(NAMED_KEYS), ...Object.keys(CHAR_KEYS)];
    const hint = (t: string, names: string[]) => (KEY_ALIASES[t] ? ` Did you mean \`${KEY_ALIASES[t]}\`?` : didYouMean(t, names));
    const isKey = (t: string) => /^[a-z0-9]$/.test(t) || t in NAMED_KEYS || t in CHAR_KEYS;
    if (!key || tokens.includes('')) return fail(`\`${attrName}\` is a key filter: modifiers and one key, separated by single \`-\`, e.g. \`data-sn-on-keydown-shift-n\``);
    if (key in MODIFIERS) return fail(`\`${key}\` is a modifier: a key filter ends with the key, e.g. \`data-sn-on-keydown-${key}-k\``);
    // HTML lowercases attribute names: `-N` arrives as `-n`, so the source spelling is checked
    const loc = el.sourceCodeLocation?.attrs?.[attrName], src = this.origins.get(el)?.src;
    const raw = loc && src ? src.slice(loc.startOffset, loc.startOffset + attrName.length) : attrName;
    if (raw.toLowerCase() === attrName && raw !== attrName) {
      const rawKey = raw.slice(raw.lastIndexOf('-') + 1);
      return fail(/^[A-Z]$/.test(rawKey) && !tokens.includes('shift')
        ? `HTML lowercases attribute names, so \`${raw}\` would be \`${attrName}\`: write ${rawKey} as \`${[...tokens, 'shift', key].join('-')}\``
        : `HTML lowercases attribute names: write \`${raw}\` as \`${attrName}\``);
    }
    if (!isKey(key)) return fail(`\`${key}\` in \`${attrName}\` is not a key name.${hint(key, keyNames)}`);
    let m = 0;
    for (const t of tokens) {
      const bit = MODIFIERS[t];
      if (bit === undefined) {
        if (isKey(t)) return fail(`a key filter names one key, last: \`${t}\` in \`${attrName}\` is a key, not a modifier (modifiers are \`ctrl\`, \`alt\`, \`shift\`, \`meta\`, \`mod\`)`);
        return fail(`\`${t}\` in \`${attrName}\` is not a modifier.${hint(t, Object.keys(MODIFIERS))}`);
      }
      if (m & bit) return fail(`\`${t}\` appears twice in \`${attrName}\``);
      m |= bit;
    }
    if (m & MODIFIERS.mod! && m & (MODIFIERS.ctrl! | MODIFIERS.meta!)) return fail(`\`mod\` is Ctrl, or Cmd on Apple platforms: \`${attrName}\` cannot also name \`ctrl\` or \`meta\``);
    // letters: Shift is part of the filter (`n` vs `shift-n`); other characters: the character says it (`?`, `1`)
    const q = NAMED_KEYS[key] ?? CHAR_KEYS[key] ?? key;
    if (!(key in NAMED_KEYS) && !/^[a-z]$/.test(key)) m |= LOOSE_SHIFT;
    return m ? { q, m } : { q };
  }

  /** SN507: an expression too complex for markup; object attributes are measured per property value */
  complexity(el: P5Element, attrName: string, o: Omit<ExprOptions, 'report'>, ast: Node) {
    const c = this.opts.complexity ?? {};
    if (c.level === 'off') return;
    const seen = this.measured.get(el) ?? new Set<string>();
    this.measured.set(el, seen);
    if (seen.has(attrName)) return;
    seen.add(attrName);
    const limits = { ...COMPLEXITY_DEFAULTS };
    for (const k of COMPLEXITY_LIMITS) if (typeof c[k] === 'number') limits[k] = c[k]!;
    const a = ast as Node & { type: string; properties?: any[]; body?: any[] };
    const found: Array<[string, ReturnType<typeof measure>]> = [];
    if (o.object && a.type === 'ObjectExpression') {
      for (const p of a.properties!) if (p.type === 'Property') found.push([p.key.name ?? p.key.value ?? '', measure([p.value], false, limits)]);
    } else if (a.type === 'Program') found.push(['', measure(a.body!.filter((st) => st.type === 'ExpressionStatement').map((st) => st.expression), true, limits)]);
    else found.push(['', measure([a], false, limits)]);
    for (const [key, x] of found) {
      if (!x) continue;
      const where = key ? `\`${key}\` in \`${attrName}\`` : `\`${attrName}\``;
      this.report(el, attrName, 'SN507', `${where} is too complex for markup: ${x.message}. Move the logic into a helper (pure, \`x = fn(…)\`) or an action`, 0,
        'markup holds filters, conditions, single assignments and short calls; limits: sinter({ complexity: { … } })');
      if (c.level === 'error') this.diagnostics[this.diagnostics.length - 1]!.severity = 'error';
    }
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

  /** Index of a function in the page's table; identical code shares one entry (one compile in the engine). */
  fn(code: string): number {
    let i = this.fnIndex.get(code);
    if (i === undefined) this.fnIndex.set(code, (i = this.fns.push(code) - 1));
    return i;
  }

  expr(el: P5Element, attrName: string, scope: Scope, o: Omit<ExprOptions, 'report'>, value?: string, shift = 0): ExprResult {
    const src = value ?? attr(el, attrName) ?? '';
    const r = analyze(src, scope, this.page, { ...o, report: this.reporter(el, attrName, shift) });
    if (r.ok && r.ast) this.complexity(el, attrName, o, r.ast);
    if (r.runs || r.refreshes) this.flows.push({ el, attr: attrName, shift, runs: r.runs ?? [], refreshes: r.refreshes ?? [] });
    this.lastExpr = null;
    if (this.check) {
      // a let read as a resource name is typed as its names (TypeScript would widen `'messages'` to string)
      for (const l of r.nameLets ?? []) {
        const f = this.check.frames[this.frameOf.get(l) ?? -1];
        if (f?.kind === 'let' && f.init !== null && l.names) this.check.exprs[f.init]!.returns = { kind: 'names', names: l.names };
      }
      const i = this.recordExpr(el, attrName, scope, o, src, shift, r);
      // a broken expression is there for editor completion only; nothing refers to it
      if (r.ok) this.lastExpr = i;
      else this.check.exprs[i]!.broken = true;
    }
    return r;
  }

  // ---- derived names

  /**
   * `data-sn-let="{ s: suggestions(q), n: s.length }"`: each name is a value expression, inlined
   * where it is read; later names may use earlier ones.
   */
  lets(el: P5Element, scope: Scope): Scope {
    const src = attr(el, 'data-sn-let') ?? '';
    let obj: import('acorn').Node & { type: string; properties?: Array<import('acorn').Property | import('acorn').SpreadElement> };
    try {
      obj = parseExpressionAt(src, 0, { ecmaVersion: 'latest' }) as typeof obj;
    } catch (e) {
      this.report(el, 'data-sn-let', 'SN401', (e as Error).message.replace(/ \(\d+:\d+\)$/, ''), (e as { pos?: number }).pos ?? 0);
      return scope;
    }
    if (obj.type !== 'ObjectExpression') {
      this.report(el, 'data-sn-let', 'SN401', '`data-sn-let` takes an object literal: `{ name: expression, … }`', 0);
      return scope;
    }
    for (const p of obj.properties!) {
      if (p.type !== 'Property' || p.computed || p.shorthand || p.key.type !== 'Identifier' || p.kind !== 'init' || p.method) {
        this.report(el, 'data-sn-let', 'SN401', '`data-sn-let` entries are `name: expression`', p.start);
        continue;
      }
      const name = p.key.name;
      if (name.startsWith('$')) { this.report(el, 'data-sn-let', 'SN401', 'names starting with `$` are reserved', p.key.start); continue; }
      if (!this.checkNames(el, 'data-sn-let', scope, [name], p.key.start)) continue;
      const v = p.value as import('acorn').Expression & { start: number; end: number };
      const r = this.expr(el, 'data-sn-let', scope, { mode: 'value' }, src.slice(v.start, v.end), v.start);
      const entry: LetEntry = { name, code: r.inner, deps: r.deps, usesEl: r.usesEl, usesIndex: r.usesIndex, resource: r.resource };
      // the resource names it can be, for store calls and `$meta[…]` that read it as one
      if (r.ok) {
        const lets = scope.lets ?? [], from: LetEntry[] = [];
        const names = literalNames(v, (n) => lets.findLast((l) => l.name === n) ?? null, from);
        if (names) Object.assign(entry, { names: [...new Set(names.map((c) => c.name))], from });
      }
      if (this.check) {
        this.frameOf.set(entry, this.check.frames.length);
        this.check.frames.push({ kind: 'let', name, init: r.ok ? this.lastExpr : null, loc: this.locOf(el, 'data-sn-let', p.key.start) });
      }
      scope = { ...scope, lets: [...(scope.lets ?? []), entry] };
    }
    return scope;
  }

  /** A name declared here must not hide a let, or be hidden by one (SN209); false on a conflict. */
  checkNames(el: P5Element, attrName: string, scope: Scope, names: string[], offset = 0): boolean {
    let ok = true;
    for (const n of names) {
      const isLet = (scope.lets ?? []).some((l) => l.name === n);
      const other = attrName === 'data-sn-let' && (scope.loops.some((l) => l.name === n) || scope.states.some((s) => s.names.has(n)));
      if (isLet || other) {
        this.report(el, attrName, 'SN209', `\`${n}\` is already defined here${isLet ? ' by `data-sn-let`' : ''}; use another name`, offset);
        ok = false;
      }
    }
    return ok;
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
    for (const f of [...scope.states, ...scope.loops, ...(scope.lets ?? [])]) {
      const i = this.frameOf.get(f);
      if (i !== undefined && !frames.includes(i)) frames.push(i);
    }
    let event: string | null = null;
    // a key filter's handler runs for its keydown or keyup
    if (attrName.startsWith('data-sn-on-')) event = attrName.slice('data-sn-on-'.length).replace(/^(key(?:down|up))-.*/s, '$1');
    // an element-less handler (<sn-event>, <sn-resource then>) runs for no DOM event
    else if ((o.mode !== 'value' || o.magic?.includes('$event')) && !o.noElement) {
      event = attr(el, 'data-sn-trigger') ?? (el.tagName === 'form' ? 'submit' : FORM_CONTROLS.has(el.tagName) ? 'change' : 'click');
    }
    const e: CheckExpr = {
      src, mode: o.mode === 'value' ? 'value' : 'handler', loc: this.locOf(el, attrName, shift), frames, tag: el.tagName, event,
      result: attrName === 'data-sn-then' || !!o.magic?.includes('$result'), error: attrName === 'data-sn-catch',
    };
    if (o.payload) e.payload = { names: r.payloadNames ?? [], type: null, ...(r.payloadStates?.length ? { states: r.payloadStates } : {}), ...(r.payloadLets?.length ? { lets: r.payloadLets } : {}) };
    this.check!.exprs.push(e);
    const list = this.exprsOf.get(el) ?? [];
    list.push({ attr: attrName, i: this.check!.exprs.length - 1 });
    this.exprsOf.set(el, list);
    return this.check!.exprs.length - 1;
  }

  // ---- bindings

  attrBinding(el: P5Element, node: NodeDef, scope: Scope) {
    const r = this.expr(el, 'data-sn-attr', scope, { mode: 'value', object: 'literal-keys' });
    if (this.check) this.typeLast({ returns: { kind: 'decl', name: 'Attrs' } });
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
      // both would write the control's live state; the model's state is the one source
      if (attr(el, 'data-sn-model') != null && key === (/^(checkbox|radio)$/i.test(attr(el, 'type') ?? '') ? 'checked' : 'value')) {
        this.report(el, 'data-sn-attr', 'SN102', `\`${key}\` is the control state \`data-sn-model\` writes; set it through the model's state, not \`data-sn-attr\``, e.offset);
        continue;
      }
      if ((key === 'id' || key === 'name') && !e.literal) {
        this.report(el, 'data-sn-attr', 'SN503', `\`${key}\` bound from data can shadow globals other scripts read (DOM clobbering)`, e.offset);
      }
      if (!r.ok) continue;
      if (key === 'src' && el.tagName === 'img') {
        const files = localImages(entryValue(r, e));
        if (files) this.report(el, 'data-sn-attr', 'SN513', `\`src\` is bound to ${files.length > 1 ? 'local images' : 'a local image'} (${files.map((f) => `\`${f}\``).join(', ')}), which ${files.length > 1 ? 'are' : 'is'} not optimized`, e.offset,
          `write each image as a static \`<img src>\` (optimized at build time) and choose with \`data-sn-if\` or \`data-sn-show\`: \`<img src="${files[0]}" data-sn-show="…">\``);
      }
      const remote = key === 'src' ? this.remoteImage(el, e, r.entries.some((x) => x.key.toLowerCase() === 'srcset'), scope) : null;
      node.b.push(binding({ k: 'attr', n: e.key, f: this.fn(remote ? remote.src : e.code), d: e.deps, ...usesEl(r), s: this.selection(scope, attr(el, 'data-sn-attr') ?? '', entryValue(r, e), r) }));
      if (remote) node.b.push(binding({ k: 'attr', n: 'srcset', f: this.fn(remote.srcset), d: e.deps, ...usesEl(r) }));
    }
  }

  /**
   * An `<img>` whose `src` is bound to data (not to constants or state alone), with a resizing
   * service configured: `src` and a `srcset` through it, with widths from the box the stylesheets
   * give the image, and its `sizes`, dimensions and loading attributes (docs/images.md, step 2).
   */
  remoteImage(el: P5Element, e: { code: string; deps: string[] }, srcset: boolean, scope: Scope): { src: string; srcset: string } | null {
    if (!this.opts.remoteImages || el.tagName !== 'img' || srcset || attr(el, 'srcset') !== undefined || (el.parentNode as P5Element | null)?.tagName === 'picture') return null;
    // data: a resource (or what reads one), or a row of a list (rows never render early, so `$ri` is in scope)
    const data = scope.loops.length > 0 || e.deps.some((d) => !/^\$(s\d+|locale|now|url)(\.|$)/.test(d));
    if (!data || !e.code.startsWith('($) => (')) return null;
    const box = this.layout?.box(el) ?? null;
    let widths: number[], at: number, r = 0, sizes: string;
    if (box && box !== 'fluid') {
      const w = Math.round(box.width);
      const small = w * (box.height ?? w) <= 300 * 300;
      widths = [w, 2 * w, ...(small ? [3 * w] : [])];
      at = w;
      if (box.height !== null && box.fit === 'cover' && this.opts.remoteImages.cover) r = Math.round(box.height) / w;
      sizes = `(max-width: ${w}px) 100vw, ${w}px`;
      if (attr(el, 'width') === undefined) setAttr(el, 'width', String(w));
      if (box.height !== null && attr(el, 'height') === undefined) setAttr(el, 'height', String(Math.round(box.height)));
    } else {
      // its width at every viewport width (layout.ts), else no wider than its containers allow: at most 3x of that
      const fluid = this.layout?.fluidSizes(el) ?? null;
      if (!fluid && attr(el, 'sizes') === undefined && this.layout?.autoFitRows) this.report(el, 'data-sn-attr', 'SN514', AUTO_FIT_ROWS, 0, AUTO_FIT_HINT);
      const bound = fluid ? fluid.max : this.layout?.maxWidth(el) ?? null;
      const ladder = this.opts.images?.widths ?? FLUID_WIDTHS;
      widths = fluid?.constant ? [...new Set(fluid.constant.flatMap((w) => [w, 2 * w, 3 * w]))].sort((a, b) => a - b)
        : bound === null ? [...ladder] : [...ladder.filter((w) => w < 3 * bound * 0.9), 3 * bound];
      at = fluid?.constant ? Math.max(...fluid.constant) : bound === null ? 1280 : Math.min(1280, bound);
      sizes = `auto, ${fluid ? fluid.sizes : bound === null ? '100vw' : `(max-width: ${bound}px) 100vw, ${bound}px`}`;
    }
    if (attr(el, 'sizes') === undefined) setAttr(el, 'sizes', sizes);
    // rows load as they scroll in; an image outside a template may be the page's largest, so it is not deferred
    if (attr(el, 'loading') === undefined && (scope.loops.length || sizes.startsWith('auto'))) setAttr(el, 'loading', 'lazy');
    if (attr(el, 'decoding') === undefined) setAttr(el, 'decoding', 'async');
    this.remoteUsed = true;
    for (const w of widths) this.remoteWidths.add(w);
    const value = e.code.slice('($) => '.length);
    return { src: `($) => $ri.src(${value}, ${at}, ${r})`, srcset: `($) => $ri.set(${value}, ${JSON.stringify(widths)}, ${r})` };
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
      if (k === 'class' && attr(el, 'class') != null) node.cl = 1;
      if (r.ok) node.b.push(binding({ k, n: key, f: this.fn(e.code), d: e.deps, ...usesEl(r), s: this.selection(scope, attr(el, name) ?? '', entryValue(r, e), r) }));
    }
  }

  /**
   * A value binding in a row whose value is `row side === outer side` (or `!==`): one side reads the
   * row (the innermost loop's item or index), the other does not and depends on something. The row
   * side is where the row's data is read; such bindings are re-evaluated on the rows concerned when
   * only the outer side changes (the selection pattern: `{active: row.id === selectedId}`).
   */
  selection(scope: Scope, src: string, v: Node | null | undefined, whole: ExprResult): Binding['s'] {
    const n = scope.loops.length;
    if (!n || !v || whole.usesEl || v.type !== 'BinaryExpression') return undefined;
    const bin = v as import('acorn').BinaryExpression & Node;
    if (bin.operator !== '===' && bin.operator !== '!==') return undefined;
    // the innermost loop's names: its item and, after it, its index
    const names = new Set<string>();
    let k = n;
    while (k > 0 && scope.loops[k - 1]!.kind === 'index') names.add(scope.loops[--k]!.name);
    if (k > 0) names.add(scope.loops[k - 1]!.name);
    const [l, rt] = [bin.left as Node, bin.right as Node];
    const lm = mentions(l, names), rm = mentions(rt, names);
    if (lm === rm) return undefined;
    const [row, outer] = lm ? [l, rt] : [rt, l];
    const quiet: ExprOptions = { mode: 'value', report: () => {} };
    const ro = analyze(src.slice(row.start, row.end), scope, this.page, quiet), oo = analyze(src.slice(outer.start, outer.end), scope, this.page, quiet);
    if (!ro.ok || !oo.ok || oo.usesIndex || oo.usesEl || ro.usesEl) return undefined;
    const d = oo.deps.filter((x) => !ro.deps.includes(x));
    if (!d.length) return undefined;
    return { r: this.fn(ro.code), o: this.fn(oo.code), d, ...(bin.operator === '!==' ? { x: 1 as const } : {}) };
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
    if (persist !== undefined) {
      b.p = persist;
      this.persisted.add(r.path.slice(0, 2).join('.'));
    }
    node.b.push(b);
  }

  action(el: P5Element, node: NodeDef, scope: Scope, method: typeof METHODS[number] | 'call', get: (n: string) => string | undefined) {
    // arguments and body are taken when the trigger fires, so they see its event
    const call = method === 'call' ? this.callExpr(el, 'data-sn-call', scope, undefined, ['$event']) : null;
    if (method === 'call' && get('body') !== undefined) this.report(el, 'data-sn-body', 'SN102', '`data-sn-body` belongs to a method attribute; a call takes its arguments in `data-sn-call`', 0);
    const reads: Read[] = [];
    const url = method === 'call' ? [] : this.urlTemplate(el, `data-sn-${method}`, scope, {}, undefined, reads);
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
      if (get(n) === undefined) return { f: null, w: [] as string[], r: null };
      const r = this.expr(el, `data-sn-${n}`, scope, o);
      if (type) this.typeLast(type);
      return { f: r.ok ? this.fn(r.code) : null, w: r.writes, r };
    };
    // with OpenAPI specs: the body must fit the request schema, `$result` gets the response's type, and write-through knows the response's entities
    const op = method !== 'call' && this.opts.openapi?.length ? matchOperation(this.opts.openapi, url, method) : null;
    const typed = op && 'spec' in op ? op : null;
    const body = fnOf('body', { mode: 'value', magic: ['$event'] }, typed?.request != null ? { returns: { kind: 'openapi', spec: typed.spec, schema: typed.request } } : undefined);
    reads.push(...(body.r?.reads ?? []));
    const optimistic = fnOf('optimistic', { mode: 'optimistic' });
    if (optimistic.f !== null) this.features.add('optimistic');
    const then = fnOf('then', { mode: 'handler', magic: ['$event', '$result'] },
      typed?.body != null ? { resultType: { kind: 'openapi', spec: typed.spec, schema: typed.body } }
        : call ? { resultType: { kind: 'call', name: call.name } } : undefined);
    const catch_ = fnOf('catch', { mode: 'handler', magic: ['$event', '$error'] });
    const confirm = fnOf('confirm', { mode: 'value', magic: ['$event'] });
    const encoding = get('encoding');
    if (encoding !== undefined && encoding !== 'form' && encoding !== 'json') this.report(el, 'data-sn-encoding', 'SN401', '`data-sn-encoding` is `json` (the default) or `form`', 0);
    if (encoding !== undefined && method === 'call') this.report(el, 'data-sn-encoding', 'SN102', '`data-sn-encoding` belongs to a method attribute; a call sends its own requests', 0);
    const applyAttr = get('apply');
    if (applyAttr !== undefined && applyAttr.trim() !== 'off') this.report(el, 'data-sn-apply', 'SN401', '`data-sn-apply` takes `off`; write-through is on without the attribute', 0);
    if (applyAttr !== undefined && (method === 'call' || method === 'get')) this.report(el, 'data-sn-apply', 'SN102', '`data-sn-apply` belongs to a mutation (`data-sn-post`, `-put`, `-patch`, `-delete`): a GET or a call has no write-through', 0);
    const ap = method !== 'call' && method !== 'get' && applyAttr === undefined ? this.applyDef(reads, typed) : null;
    if (ap) {
      this.features.add('apply');
      if (then.r?.ast) this.redundantWrites(el, then.r, ap, url, method, typed?.path ?? null);
    }
    const def: ActionDef = {
      method: method.toUpperCase() as ActionDef['method'], url, body: body.f, trigger, debounce, concurrency,
      optimistic: optimistic.f, then: then.f, catch: catch_.f, w: [...new Set([...then.w, ...catch_.w])].sort(), form: isForm,
      ...(call ? { call: { args: call.args, run: call.run } } : {}),
      ...(confirm.f !== null ? { confirm: confirm.f } : {}),
      ...(encoding === 'form' ? { enc: 'form' as const } : {}),
      ...(ap ? { ap } : {}),
    };
    this.actions.push(def);
    node.b.push(binding({ k: 'on', n: trigger, x: this.actions.length - 1 }));
  }

  /**
   * Write-through: what a mutation is about (the resources, rows and nested entities its URL and body
   * read) and what its response holds (objects of named schemas). Null when there is nothing to apply.
   */
  applyDef(reads: Read[], typed: { spec: number; body: unknown; request: unknown } | null): ApplyDef | null {
    const tg: ApplyDef['tg'] = [];
    const seen = new Set<string>();
    const add = (t: ApplyDef['tg'][number]) => { const k = `${t.r}\0${t.v ?? ''}\0${(t.p ?? []).join('.')}`; if (!seen.has(k)) { seen.add(k); tg.push(t); } };
    for (const rd of reads) {
      const info = this.itemSchema.get(rd.resource), doc = info ? this.opts.openapi![info.spec]!.doc : null;
      const root = info ? namedSchema(doc, info.schema) : null;
      add({ r: rd.resource, ...(rd.row ? { v: rd.row } : {}), ...(root ? { s: root.name } : {}) });
      // the named entities along the path: `article.author.username` is also about `article.author`, a Profile
      for (let i = 1; info && i < rd.path.length; i++) {
        const s = namedAt(doc, info.schema, rd.path.slice(0, i));
        if (s) add({ r: rd.resource, ...(rd.row ? { v: rd.row } : {}), p: rd.path.slice(0, i), s });
      }
    }
    if (!tg.length && !typed) return null;
    const ap: ApplyDef = { tg };
    if (typed) {
      const doc = this.opts.openapi![typed.spec]!.doc;
      ap.t = 1;
      const rs = responseEntities(doc, typed.body);
      if (rs.length) ap.rs = rs;
      const rq = typed.request != null ? wrapperKey(doc, typed.request) : null;
      if (rq) ap.rq = rq;
      // the entity the body describes: the most specific target whose schema has every field the body may carry
      if (typed.request != null) {
        const fields = propertyNames(doc, rq ? properties(doc, typed.request).get(rq) : typed.request);
        const u = tg.map((t, i) => [t, i] as const).filter(([t]) => t.s && fields.length && fields.every((f) => propertyNames(doc, this.schemaNamed(doc, t.s!)).includes(f)))
          .sort((a, b) => (b[0].p?.length ?? 0) - (a[0].p?.length ?? 0))[0];
        if (u) ap.u = u[1];
      }
    }
    return ap;
  }

  /** The component schema with that name. */
  schemaNamed(doc: unknown, name: string): unknown {
    return { $ref: `#/components/schemas/${name.replace(/~/g, '~0').replace(/\//g, '~1')}` };
  }

  /**
   * `SN510`: a `then` write that write-through makes: `patch('x', item, $result.p)`/`upsert('x', $result.p)`
   * where the response's `p` is an object of `x`'s schema (an upsert also needs the action's URL to be the
   * list's URL, judged by the literal parts), and `remove('x', row)` on a DELETE of that row's URL.
   */
  redundantWrites(el: P5Element, then: ExprResult, ap: ApplyDef, url: UrlTemplate, method: string, opPath: string | null) {
    const lits = (t: UrlTemplate) => t.filter((x): x is string => typeof x === 'string');
    const src = (name: string) => this.resources.find((r) => r.name === name)?.src ?? null;
    const sameUrl = (name: string) => { const s = src(name); return !!s && lits(s).join('\0') === lits(url).join('\0'); };
    const rowUrl = (name: string) => { const s = src(name); if (!s) return false; const a = lits(url), b = lits(s); return a.length === b.length && a.slice(0, -1).join('\0') === b.slice(0, -1).join('\0') && a[a.length - 1] === b[b.length - 1] + '/'; };
    const fix = 'remove this write, or add `data-sn-apply="off"` to keep it';
    const op = opPath ? `the response of \`${method.toUpperCase()} ${opPath}\`` : 'the response';
    const visit = (n: acorn.AnyNode) => {
      if (n.type === 'CallExpression' && n.callee.type === 'Identifier' && ['patch', 'upsert', 'remove'].includes(n.callee.name) && n.arguments[0]?.type === 'Literal' && typeof n.arguments[0].value === 'string') {
        const fn = n.callee.name, name = n.arguments[0].value, r = this.resources.find((x) => x.name === name);
        const value = n.arguments[fn === 'patch' ? 2 : 1];
        const resultPath = value && value.type === 'MemberExpression' && !value.computed && value.object.type === 'Identifier' && value.object.name === '$result' && value.property.type === 'Identifier' ? value.property.name
          : value && value.type === 'Identifier' && value.name === '$result' ? '' : null;
        const entry = resultPath != null ? ap.rs?.find((e) => e.p === resultPath && !e.a) : undefined;
        if (r && entry && r.sch === entry.s && fn === 'patch' && (r.key || ap.tg.some((t) => t.r === name && t.s === entry.s))) {
          this.report(el, 'data-sn-then', 'SN510', `\`patch('${name}', …, $result${resultPath ? '.' + resultPath : ''})\` is what write-through does: ${op} is \`${entry.s}\`, which \`${name}\` holds; ${fix}`, n.start);
        } else if (r && entry && r.sch === entry.s && fn === 'upsert' && r.key && sameUrl(name)) {
          this.report(el, 'data-sn-then', 'SN510', `\`upsert('${name}', $result${resultPath ? '.' + resultPath : ''})\` is what write-through does: a POST to \`${name}\`'s URL inserts ${op}'s \`${entry.s}\`; ${fix}`, n.start);
        } else if (r && fn === 'remove' && method === 'delete' && value?.type === 'Identifier' && ap.tg.some((t) => t.r === name && t.v === (value as acorn.Identifier).name && !t.p) && rowUrl(name)) {
          this.report(el, 'data-sn-then', 'SN510', `\`remove('${name}', ${(value as acorn.Identifier).name})\` is what write-through does: a DELETE of a row's URL removes the row; ${fix}`, n.start);
        }
      }
      for (const k of Object.keys(n)) {
        const v = (n as unknown as Record<string, unknown>)[k];
        if (Array.isArray(v)) { for (const c of v) if (c && typeof c === 'object' && 'type' in c) visit(c as acorn.AnyNode); }
        else if (v && typeof v === 'object' && 'type' in v && k !== 'loc') visit(v as acorn.AnyNode);
      }
    };
    visit(then.ast as acorn.AnyNode);
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
    const loops: LoopEntry[] = [...scope.loops, { name: item, kind: 'item', alias, resource: list.resource, ...(list.resources ? { resources: list.resources } : {}) }];
    if (index) loops.push({ name: index, kind: 'index', alias: null, resource: null, of: alias });
    if (this.check) {
      for (const l of loops.slice(scope.loops.length)) this.frameOf.set(l, this.check.frames.length);
      const itemAt = value.indexOf(item, value.indexOf('(') >= 0 && value.indexOf('(') < m[0].length ? value.indexOf('(') : 0);
      const frame: CheckFrame = { kind: 'loop', item, index, init: listExpr, loc: this.locOf(el, 'data-sn-for', itemAt) };
      if (index) frame.indexLoc = this.locOf(el, 'data-sn-for', value.indexOf(index, itemAt + item.length));
      this.check.frames.push(frame);
    }
    this.checkNames(el, 'data-sn-for', scope, index ? [item, index] : [item]);
    const inner: Scope = { ...scope, loops };
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

  urlTemplate(el: P5Element, attrName: string, scope: Scope, exprOpts: Partial<ExprOptions> = {}, deps?: Set<string>, reads?: Read[]): UrlTemplate {
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
      // an array is a repeated key as a whole query value, and refused in the path
      if (!/[?#]/.test(value.slice(0, i))) this.typeLast({ returns: { kind: 'decl', name: 'PathValue' } });
      parts.push(this.fn(r.code));
      if (deps) for (const d of r.deps) deps.add(d);
      reads?.push(...(r.reads ?? []));
      i = j + 1;
    }
    if (lit) parts.push(lit);
    const first = parts[0];
    // a literal origin followed by a value needs its `/`: `https://api.example.com{x}` lets `x` extend the host
    const origin = parts.length > 1 ? /^https?:\/\/[^/{}]+\//i : /^https?:\/\/[^/{}]+(\/|$)/i;
    if (typeof first !== 'string' || !(/^\/[^/\\]/.test(first) || first === '/' || origin.test(first))) {
      this.report(el, attrName, 'SN207', 'a URL template must start with a literal same-origin path (`/api/…`) or a literal `https://` origin (with a `/` after the host when a value follows)', 0,
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
    const earlyAttr = attr(el, 'early');
    if (earlyAttr != null && earlyAttr !== 'off') this.report(el, 'early', 'SN401', '`early` takes only `off`', 0);
    if (earlyAttr === 'off') this.noEarly.add(name);
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
        srcScope = { ...ctx.scope, loops: [...ctx.scope.loops, loop] };
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
    // `then`: a handler run after each successful load, with what it loaded as `$result`
    let then: { f: number; w: string[] } | null = null;
    if (attr(el, 'then') != null) {
      // a resource loaded for its `then` is used, whether or not the handler reads `$result`
      this.page.resources.get(name)!.used = true;
      const r = this.expr(el, 'then', ctx.scope, { mode: 'handler', magic: ['$result'], noElement: 'sn-resource' });
      this.typeLast({ resultType: { kind: 'resource', resource: name } });
      if (r.ok) then = { f: this.fn(r.code), w: r.writes };
    }
    const order = attr(el, 'order');
    const type = attr(el, 'type')?.trim() || null;
    const openapi = type || hasCall ? null : this.openapi(el, src, attr(el, 'items') ?? null, attr(el, 'total') ?? null);
    const sch = openapi && 'schema' in openapi ? namedSchema(this.opts.openapi![openapi.spec]!.doc, openapi.schema) : null;
    if (openapi && 'schema' in openapi) this.itemSchema.set(name, { spec: openapi.spec, schema: sch?.array ? (openapi.schema as { items: unknown }).items : openapi.schema });
    if (this.check) {
      const r: CheckResource = { name, type, loc: this.locOf(el, type ? 'type' : null), nameLoc: this.locOf(el, 'name') };
      if (openapi && 'schema' in openapi) r.openapi = openapi;
      if (call) r.call = { name: call.name, items: attr(el, 'items') ?? null };
      if (paginate?.mode === 'keyset' && !paginate.offsetParam) r.directions = true;
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
      ...(then ? { then: then.f, ...(then.w.length ? { w: then.w } : {}) } : {}),
      ...(sch ? { sch: sch.name } : {}),
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
    const resource = attr(el, 'resource') ?? null;
    const op = (attr(el, 'op') ?? null) as EventDef['op'];
    if (!name) { this.report(el, null, 'SN401', '`<sn-event>` needs `name`', 0); return null; }
    // with `then`, an event may only run its handler
    const only = resource === null && op === null && attr(el, 'then') != null;
    if (!only && (!resource || !this.page.resources.has(resource))) {
      this.report(el, 'resource', 'SN301', `resource \`${resource ?? ''}\` is not declared on this page.${didYouMean(resource ?? '', this.page.resources.keys())}`, 0);
      return null;
    }
    if (!only && (!op || !['upsert', 'patch', 'remove', 'refetch'].includes(op))) {
      this.report(el, 'op', 'SN401', '`op` is `upsert`, `patch`, `remove` or `refetch`', 0);
      return null;
    }
    const scope = ctx.scope;
    const typeAttr = attr(el, 'type')?.trim() || null;
    const payloadType: TypeRef | null = typeAttr && typeAttr !== 'any' ? { kind: 'ts', text: typeAttr, loc: this.locOf(el, 'type') } : null;
    if (this.check && !typeAttr && ['item', 'set', 'when', 'then'].some((n) => attr(el, n) != null)) {
      this.report(el, null, 'SN506', `event \`${name}\` has no type: expressions reading its payload are not checked`, 0,
        'add `type="…"` with the payload type from the types module, or `type="any"` to leave it unchecked');
    }
    let writes: string[] = [];
    const fnOf = (n: string, object = false) => {
      if (attr(el, n) == null) return null;
      const r = this.expr(el, n, scope, n === 'then' ? { mode: 'handler', payload: true, payloadState: true, noElement: 'sn-event' } : { mode: 'value', payload: true, payloadState: true });
      writes = r.writes;
      this.typeLast({
        payload: payloadType,
        ...(!resource ? {} : n === 'item' ? { returns: { kind: 'item', resource } } : n === 'set' ? { returns: { kind: 'item', resource, partial: true } } : {}),
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
    const when = fnOf('when');
    const then = fnOf('then');
    return {
      name, resource, op, item, set, when, fallback: fallback === 'refetch' ? 'refetch' : null,
      ...(then !== null ? { then, ...(writes.length ? { w: writes } : {}) } : {}),
    };
  }

  // ---- first paint

  /**
   * Writes page-level bindings whose value is a build-time constant into the HTML: they read only
   * literal state fields (not persisted) and constants, and evaluate without error to a value the
   * runtime would write as is. Helpers, `$locale`, resources, the clock and the URL are not
   * constant: those bindings render in the browser (early chunk or page module).
   */
  prerender() {
    type Cand = { el: P5Element; b: Binding; f: number };
    const cands: Cand[] = [];
    for (const { el, node } of this.paints) {
      for (const b of node.b) {
        if (b.f === undefined || b.e || !['text', 'attr', 'class', 'style', 'show', 'model'].includes(b.k)) continue;
        if (b.k === 'class' && !b.n) continue;
        if (b.k === 'text' && el.childNodes.some(isElement)) continue;
        if (b.k === 'model' && !['checkbox', 'radio', 'text', 'number'].includes(b.n!)) continue;
        cands.push({ el, b, f: b.f });
      }
    }
    if (!cands.length) return;
    // everything the page could call is shadowed: what is not a constant throws
    const NOT = new Error('not a build-time constant');
    const stub = new Proxy(function () {}, { apply() { throw NOT; }, get() { throw NOT; } });
    const params = new Map<string, unknown>([['$k', $k]]);
    for (const h of ['Date', 'Intl', 'Math', 'date', 'time', 'datetime', 'relative', 'number', 'bytes', ...this.opts.helpers.names]) params.set(h, stub);
    for (const [ns, { members }] of Object.entries(this.opts.helpers.namespaces)) for (const m of members) params.set(`${ns}$${m}`, stub);
    const used = [...new Set([...this.stateInits.flatMap((st) => st.fields.map((x) => x.code)), ...cands.map((c) => this.fns[c.f]!)])];
    let table: Array<($: unknown) => unknown>;
    try {
      // eslint-disable-next-line no-new-func -- build time only: the page's own compiled expressions, with nothing in scope
      table = new Function(...params.keys(), `"use strict"; return [\n${used.join(',\n')}\n];`)(...params.values());
    } catch { return; }
    const fnOf = new Map(used.map((code, i) => [code, table[i]!]));
    // a persisted model's own state path: its initial value is the fallback when storage has none
    let own: string | null = null;
    const isPersisted = (p: string) => p !== own && this.persisted.has(p);
    const states = new Map<number, unknown>();
    const known = (deps: string[]) => deps.every((d) => {
      const m = /^\$s(\d+)(?:\.([^.]+))?/.exec(d);
      if (!m || !states.has(Number(m[1]))) return false;
      return m[2] !== undefined ? !isPersisted(`$s${m[1]}.${m[2]}`) : ![...this.persisted].some((p) => p !== own && p.startsWith(`$s${m[1]}.`));
    });
    const scope = new Proxy({}, {
      get: (_, k) => {
        const m = typeof k === 'string' ? /^\$s(\d+)$/.exec(k) : null;
        if (m && states.has(Number(m[1]))) return states.get(Number(m[1]));
        throw NOT;
      },
    });
    const run = (code: string): unknown => { try { return fnOf.get(code)!(scope); } catch { return FAIL; } };
    for (const st of this.stateInits) {
      if (st.persist) continue;
      const sid = st.sid, obj: Record<string, unknown> = {};
      // each field on its own: one that reads the clock leaves the others constant
      for (const x of st.fields) {
        const v = known(x.deps) ? run(x.code) : FAIL;
        if (v !== FAIL && plainData(v)) obj[x.key] = v;
        else delete obj[x.key];
      }
      states.set(sid, new Proxy(deepFreeze(obj), {
        get: (t, k) => { if (typeof k === 'string' && (!Object.hasOwn(t, k) || isPersisted(`$s${sid}.${k}`))) throw NOT; return Reflect.get(t, k); },
      }));
    }
    const schemes = schemesOf([]);
    for (const c of cands) {
      own = c.b.k === 'model' && c.b.p !== undefined ? c.b.w![0]!.split('.').slice(0, 2).join('.') : null;
      const v = known(c.b.d ?? []) ? run(this.fns[c.f]!) : FAIL;
      const w = v === FAIL ? FAIL : firstPaintValue(c.el, c.b, v, schemes);
      if (w === FAIL) continue;
      writeFirstPaint(c.el, w[0], c.b.n ?? null, w[1]);
      // a persisted model's written value is the fallback: the early chunk still applies the stored one
      if (own === null) this.painted.add(c.b);
    }
  }

  /**
   * The early chunk's bindings: outside `data-sn-for` templates and `<dialog>`s, reading only state fields whose
   * initial value needs no data (literal, helpers, `$locale`, persisted values), and no built-in
   * formatter or `$el`. A `data-sn-if` of that kind renders its branch, whose bindings follow the
   * same rule. Everything else waits for the page module, which takes the rendered DOM over.
   */
  earlyParts(): EarlyParts | null {
    const userHelpers = new Set(this.opts.helpers.names);
    const BUILTIN = /(?<![\w$.])(date|time|datetime|relative|number|bytes)\(/g;
    const builtin = (code: string) => [...code.matchAll(BUILTIN)].some((m) => !userHelpers.has(m[1]!));
    // state fields known before data, by scope
    const fields = new Map<number, Map<string, string>>();
    const known = (deps: string[]) => deps.every((d) => {
      if (d === '$locale') return true;
      const m = /^\$s(\d+)(?:\.([^.]+))?/.exec(d);
      const f = m ? fields.get(Number(m[1])) : undefined;
      if (!m || !f) return false;
      const st = this.stateInits.find((x) => x.sid === Number(m[1]))!;
      return m[2] !== undefined ? f.has(m[2]) : f.size === st.fields.length;
    });
    for (const st of [...this.stateInits].sort((a, b) => a.sid - b.sid)) {
      const f = new Map<string, string>();
      for (const x of st.fields) {
        if (known(x.deps) && !builtin(x.code) && x.code.startsWith('($) => (')) f.set(x.key, x.code.slice('($) => ('.length, -1));
        else f.delete(x.key);
      }
      fields.set(st.sid, f);
    }
    // for requests also the clock and the URL: a URL computed from them early is the one the page
    // module computes (or the page module sends its own request), and no binding shows these fields
    const reqFields = new Map<number, Map<string, string>>();
    const knownReq = (deps: string[]) => deps.every((d) => {
      if (d === '$locale' || d === '$now' || d === '$url' || d.startsWith('$url.')) return true;
      const m = /^\$s(\d+)(?:\.([^.]+))?/.exec(d);
      const f = m ? reqFields.get(Number(m[1])) : undefined;
      if (!m || !f) return false;
      const st = this.stateInits.find((x) => x.sid === Number(m[1]))!;
      return m[2] !== undefined ? f.has(m[2]) : f.size === st.fields.length;
    });
    for (const st of [...this.stateInits].sort((a, b) => a.sid - b.sid)) {
      const f = new Map<string, string>();
      for (const x of st.fields) {
        if (knownReq(x.deps) && !builtin(x.code) && x.code.startsWith('($) => (')) f.set(x.key, x.code.slice('($) => ('.length, -1));
      }
      reqFields.set(st.sid, f);
    }
    const fns: string[] = [], index = new Map<string, number>();
    const fn = (code: string) => { let i = index.get(code); if (i === undefined) index.set(code, (i = fns.push(code) - 1)); return i; };
    const templates: EarlyIR['templates'] = this.templates.map(() => null);
    const eligible = (b: Binding) => ['text', 'attr', 'class', 'style', 'show', 'model', 'if'].includes(b.k) && !b.e && b.f !== undefined && known(b.d ?? []) && !builtin(this.fns[b.f]!) && !this.painted.has(b);
    const list = (defs: NodeDef[]): NodeDef[] => {
      // a dialog's bindings wait until it opens (as in the runtime): nothing of a closed dialog is painted
      const bs = defs.map((nd) => (nd.dl ? [] : nd.b.filter(eligible)));
      const elses = new Set(bs.flatMap((b) => b.filter((x) => x.k === 'if' && x.y !== undefined).map((x) => x.y!)));
      const keep = new Map<number, number>();
      defs.forEach((nd, i) => { if (nd.state !== undefined || bs[i]!.length || elses.has(i)) keep.set(i, keep.size); });
      if (defs === this.roots) rootKeep = keep;
      const out: NodeDef[] = [];
      for (const [i, j] of keep) {
        const nd = defs[i]!, o: NodeDef = { tag: nd.tag, p: nd.p >= 0 ? keep.get(nd.p) ?? -1 : -1, b: [] };
        if (nd.id !== undefined) o.id = nd.id; else o.path = nd.path!;
        if (nd.state !== undefined) {
          // the init function once the fields the early bindings read are known (below)
          states.push(o);
          o.sid = nd.sid!;
          if (nd.persist) o.persist = nd.persist;
        }
        for (const b of bs[i]!) {
          reads.push(...(b.d ?? []), ...(b.w ?? []));
          const nb: Binding = { k: b.k, f: fn(this.fns[b.f!]!) };
          if (b.n !== undefined) nb.n = b.n;
          if (b.k === 'model') { nb.a = fn(this.fns[b.a!]!); if (b.p !== undefined) nb.p = b.p; }
          if (b.k === 'if') { nb.x = tpl(b.x!); if (b.y !== undefined) nb.y = keep.get(b.y)!; }
          o.b.push(nb);
        }
        if (elses.has(i)) { const e = nd.b.find((x) => x.k === 'else')!; o.b.push({ k: 'else', x: tpl(e.x!) }); }
        out[j] = o;
      }
      return out;
    };
    const tpl = (x: number) => {
      if (!templates[x]) { templates[x] = { nodes: [] }; templates[x]!.nodes = list(this.templates[x]!.nodes); }
      return x;
    };
    const states: NodeDef[] = [], reads: string[] = [];
    let rootKeep = new Map<number, number>();
    const roots = list(this.roots);
    while (templates.length && templates[templates.length - 1] === null) templates.pop();
    // the resources the early file requests: `src` and `when` read only what is known early
    // (state, persisted values, `$url`, `$now`, helpers); not `call`, `each`, embedded data or pages
    const res: NonNullable<EarlyIR['res']> = [];
    let url = false;
    for (const def of this.resources) {
      if (def.call || def.each || def.data != null || def.paginate || !def.src.length || !knownReq(def.deps)) continue;
      // a URL fixed at build time is preloaded from the HTML (see injectScript), earlier than this file runs
      if (fixedRequest(def) || this.noEarly.has(def.name)) continue;
      // another origin only when listed in `origins` (the runtime's allowlist, known at build time)
      const where = this.earlyOrigin(def.src);
      if (!where) continue;
      const codes = [...def.src.filter((x): x is number => typeof x === 'number'), ...(def.when != null ? [def.when] : [])].map((i) => this.fns[i]!);
      const scope = def.scope < 0 ? -1 : rootKeep.get(def.scope);
      if (scope === undefined || codes.some(builtin) || codes.some((c) => /\$(r|meta|el)\b/.test(c))) continue;
      reads.push(...def.deps);
      url ||= codes.some((c) => c.includes('$url'));
      res.push({ name: def.name, src: def.src.map((x) => (typeof x === 'number' ? fn(this.fns[x]!) : x)), when: def.when != null ? fn(this.fns[def.when]!) : null, scope, ...(def.lo ? { lo: 1 as const } : {}), ...(where === 'listed' ? { xo: 1 as const } : {}) });
    }
    if (!roots.some((n) => n.b.length) && !res.length) return null;
    // only the state fields the early bindings read (and the fields those read): a field whose
    // initializer calls a heavy helper stays out of the early chunk unless something shown needs it
    const need = new Map<number, Set<string> | 'all'>();
    const add = (d: string) => {
      const m = /^\$s(\d+)(?:\.([^.]+))?/.exec(d);
      if (!m) return;
      const sid = Number(m[1]), cur = need.get(sid);
      if (cur === 'all') return;
      const st = this.stateInits.find((x) => x.sid === sid)!;
      const keys = m[2] === undefined ? st.fields.map((x) => x.key) : [m[2]];
      const set = cur ?? new Set<string>();
      need.set(sid, m[2] === undefined ? 'all' : set);
      for (const k of keys) {
        if (set.has(k)) continue;
        set.add(k);
        for (const x of st.fields) if (x.key === k) x.deps.forEach(add);
      }
    };
    reads.forEach(add);
    for (const o of states) {
      const f = reqFields.get(o.sid!)!, n = need.get(o.sid!);
      const keep = [...f].filter(([k]) => n === 'all' || n?.has(k));
      o.state = fn(`($) => ({ ${keep.map(([k, code]) => `${JSON.stringify(k)}: (${code})`).join(', ')} })`);
    }
    // the helpers and namespace members the early functions call
    const all = fns.join('\n');
    const calls = (name: string) => new RegExp(`(?<![\\w$.])${name.replace(/\$/g, '\\$')}(?![\\w$])`).test(all);
    const helpers = this.opts.helpers.names.filter(calls);
    const namespaces: Record<string, string[]> = {};
    for (const [ns, { members }] of Object.entries(this.opts.helpers.namespaces)) {
      const used = members.filter((m) => calls(`${ns}$${m}`));
      if (used.length) namespaces[ns] = used;
    }
    const ir: EarlyIR = { roots, templates };
    if (res.length) ir.res = res;
    if (url && this.pathList.length) ir.path = this.pathList;
    return { ir, fns, helpers, namespaces };
  }

  /**
   * The resources another page can request for this one before it is opened: a `src` and `when`
   * that read only `$url`, constants and the app's helpers (no state, resources, clock, formatters
   * or messages); not paginated, `each`, `call` or embedded data.
   */
  prefetchParts(): PrefetchParts | null {
    const userHelpers = new Set(this.opts.helpers.names);
    const BUILTIN = /(?<![\w$.])(date|time|datetime|relative|number|bytes)\(/g;
    const builtin = (code: string) => [...code.matchAll(BUILTIN)].some((m) => !userHelpers.has(m[1]!));
    const messages = Object.entries(this.opts.helpers.namespaces).filter(([, v]) => v.module === '@tiaforge-ui/sinter/messages').map(([k]) => k);
    const fns: string[] = [], index = new Map<string, number>();
    const fn = (code: string) => { let i = index.get(code); if (i === undefined) index.set(code, (i = fns.push(code) - 1)); return i; };
    const res: PrefetchParts['res'] = [];
    for (const def of this.resources) {
      if (def.call || def.each || def.data != null || def.paginate || !def.src.length) continue;
      if (!def.deps.every((d) => d === '$url' || d.startsWith('$url.'))) continue;
      const codes = [...def.src.filter((x): x is number => typeof x === 'number'), ...(def.when != null ? [def.when] : [])].map((i) => this.fns[i]!);
      if (codes.some((c) => /\$\.\$(?!url\b)/.test(c) || builtin(c) || messages.some((m) => c.includes(`${m}$`)))) continue;
      res.push({
        s: def.src.map((x) => (typeof x === 'number' ? fn(this.fns[x]!) : x)),
        ...(def.when != null ? { w: fn(this.fns[def.when]!) } : {}),
        i: def.items, t: def.total, ...(def.key ? { k: 1 as const } : {}),
      });
    }
    if (!res.length) return null;
    const all = fns.join('\n');
    const calls = (name: string) => new RegExp(`(?<![\\w$.])${name.replace(/\$/g, '\\$')}(?![\\w$])`).test(all);
    const namespaces: Record<string, string[]> = {};
    for (const [ns, { members }] of Object.entries(this.opts.helpers.namespaces)) {
      const used = members.filter((m) => calls(`${ns}$${m}`));
      if (used.length) namespaces[ns] = used;
    }
    return { path: this.pathList, res, fns, helpers: this.opts.helpers.names.filter(calls), namespaces };
  }

  /**
   * A resource that only elements inside `<dialog>`s read (bindings, state, actions, their handlers)
   * is not needed for the first paint: its requests go out with low priority (`lo`), so the
   * visible content's requests get the bandwidth first. A read anywhere else, in another
   * resource's `src`/`when`/`then`, or in a stream's events keeps the default priority.
   */
  markLowPriority() {
    const codes: string[] = [];
    const fn = (i: number | null | undefined) => { if (i != null) codes.push(this.fns[i]!); };
    const action = (a: ActionDef) => { for (const x of a.url) if (typeof x === 'number') fn(x); fn(a.body); fn(a.optimistic); fn(a.then); fn(a.catch); fn(a.confirm); if (a.call) { fn(a.call.args); fn(a.call.run); } };
    const node = (n: NodeDef) => { fn(n.state); for (const b of n.b) { fn(b.f); fn(b.a); if (b.k === 'on' && b.x != null) action(this.actions[b.x]!); } };
    for (const n of this.roots) if (!n.dl) node(n);
    for (const t of this.templates) if (!this.dlTemplates.has(t.id)) for (const n of t.nodes) if (!n.dl) node(n);
    for (const r of this.resources) { for (const x of r.src) if (typeof x === 'number') fn(x); fn(r.when); fn(r.then); if (r.each) fn(r.each.list); if (r.call) { fn(r.call.args); fn(r.call.run); } fn(r.paginate?.cursor); }
    for (const y of this.syncs) { for (const x of y.src) if (typeof x === 'number') fn(x); for (const e of y.events) { fn(e.item); fn(e.set); fn(e.when); fn(e.then); } }
    const read = new Set<string>();
    for (const c of codes) for (const m of c.matchAll(/\$\.\$(?:r|meta)\.([A-Za-z_$][\w$]*)/g)) read.add(m[1]!);
    for (const r of this.resources) if (!read.has(r.name) && r.data == null) r.lo = 1;
  }

  injectScript(doc: DefaultTreeAdapterMap['document'], early: string | null) {
    const html = doc.childNodes.find((n) => isElement(n) && n.tagName === 'html') as P5Element | undefined;
    const head = html?.childNodes.find((n) => isElement(n) && n.tagName === 'head') as P5Element | undefined;
    if (!head) return;
    const esc = (v: string) => v.replace(/[&"<>]/g, (c) => `&#${c.charCodeAt(0)};`);
    // first paint: the requests fixed at build time start while the head is parsed, before any script;
    // the runtime's fetch() takes the preloaded response (same URL and credentials mode)
    if (this.opts.early) {
      // another origin named in a `src`: its connection (DNS, TCP, TLS) is made while the page bundle downloads,
      // instead of when the first request leaves the runtime; anonymous, as the request layer and EventSource connect
      const links = [...preconnects(this.resources, this.syncs).map((o) => `<link rel="preconnect" href="${esc(o)}" crossorigin>`), ...preloads(this.resources.filter((r) => !this.noEarly.has(r.name) && fixedRequest(r) && this.earlyOrigin(r.src))).map(({ url, lo }) => `<link rel="preload" as="fetch" crossorigin href="${esc(url)}"${lo ? ' fetchpriority="low"' : ''}>`)]
        .map((t) => parse5.parseFragment(t).childNodes[0] as P5Element);
      for (const l of links) l.parentNode = head;
      // after the leading <meta>s (charset first), before stylesheets and scripts
      let at = 0;
      for (let i = 0; i < head.childNodes.length; i++) { const n = head.childNodes[i]!; if (isElement(n) && n.tagName !== 'meta') break; if (isElement(n)) at = i + 1; }
      head.childNodes.splice(at, 0, ...(links as never[]));
    }
    if (early) {
      const tag = parse5.parseFragment(`<script type="module" src="${esc(early)}" blocking="render"></script>`).childNodes[0] as P5Element;
      tag.parentNode = head;
      head.childNodes.push(tag as never);
    }
    const src = this.opts.moduleSrc ?? `./${basename(this.opts.file).replace(/\.html?$/, '')}.sinter.js`;
    const frag = parse5.parseFragment(`<script type="module" src="${esc(src)}"></script>`);
    const script = frag.childNodes[0] as P5Element;
    script.parentNode = head;
    head.childNodes.push(script as never);
  }
}

// ---- helpers

/** Flags for the runtime: `e` when the expression reads `$el`, `i` when it reads a loop index. */
/** The AST of an object-literal entry's value (by its offset), for the selection pattern. */
const entryValue = (r: ExprResult, e: { offset: number }): Node | undefined => {
  const props = (r.ast as import('acorn').ObjectExpression | null)?.properties;
  const p = props?.find((x) => x.start === e.offset);
  return p && p.type === 'Property' ? (p.value as Node) : undefined;
};
/**
 * The local image files an expression can only evaluate to (a literal path, or a choice between
 * literals: `dark ? './logo-dark.png' : './logo.png'`), or null when it can be anything else.
 */
function localImages(n: Node | undefined): string[] | null {
  const out: string[] = [];
  const visit = (x: unknown): boolean => {
    const v = x as { type: string; value?: unknown; consequent?: unknown; alternate?: unknown; quasis?: Array<{ value: { cooked: string } }>; expressions?: unknown[] };
    if (v.type === 'Literal') {
      if (v.value === null || v.value === false) return true;
      if (typeof v.value !== 'string' || /^[a-z][a-z\d+.-]*:|^\/\/|[?#]/i.test(v.value) || !/\.(jpe?g|png|webp|avif)$/i.test(v.value)) return false;
      out.push(v.value);
      return true;
    }
    if (v.type === 'TemplateLiteral' && !v.expressions?.length) return visit({ type: 'Literal', value: v.quasis![0]!.value.cooked });
    if (v.type === 'ConditionalExpression') return visit(v.consequent) && visit(v.alternate);
    return false;
  };
  return n && visit(n) && out.length ? [...new Set(out)] : null;
}

/** Whether an expression names one of `names` (object keys of literals count, conservatively). */
function mentions(n: unknown, names: Set<string>): boolean {
  if (!n || typeof n !== 'object') return false;
  if (Array.isArray(n)) return n.some((x) => mentions(x, names));
  const node = n as Node & Record<string, unknown>;
  if (node.type === 'Identifier') return names.has((node as unknown as import('acorn').Identifier).name);
  if (node.type === 'MemberExpression' && !(node as unknown as import('acorn').MemberExpression).computed) return mentions(node.object, names);
  for (const key in node) if (key !== 'type' && key !== 'start' && key !== 'end' && key !== 'loc' && typeof node[key] === 'object' && mentions(node[key], names)) return true;
  return false;
}
const usesEl = (r: ExprResult): Pick<Binding, 'e' | 'i'> => ({ ...(r.usesEl ? { e: 1 as const } : {}), ...(r.usesIndex ? { i: 1 as const } : {}) });

function binding(b: Binding): Binding {
  const out: Binding = { k: b.k };
  for (const key of ['f', 'd', 'n', 'q', 'm', 'x', 'a', 'y', 'w', 'p', 'e', 'i', 'ms', 's'] as const) {
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
  const { decls, els } = lookup(nodes);
  return `(c) => { const ${decls.join(', ')}; return [${els.join(', ')}]; }`;
}

/** Declarations walking from `c` to each bound node, and per node the expression giving its element (null if the tag differs). */
function lookup(nodes: NodeDef[]): { decls: string[]; els: string[] } {
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
  const els = nodes.map((nd) => {
    const x = node(nd.path!);
    return `${x}?.localName == ${JSON.stringify(nd.tag)} ? ${x} : null`;
  });
  return { decls, els };
}

const SIMPLE_KINDS = new Set(['text', 'attr', 'class', 'style', 'show', 'prop', 'on']);
const WRITER: Record<string, string> = { text: 't', attr: 'a', class: 'c', style: 's', show: 'h', prop: 'p' };

/**
 * The creation function of a simple row template (see `TemplateDef.make`): the lookup of the elements
 * with value bindings (handlers bind on an element's first event), then every
 * value binding evaluated inline (`$` is the row scope) and written with the runtime's writer of its
 * kind (`w.t(el, name, value)`, …; a class binding tells whether the source element has a `class`
 * attribute, so a false first value has nothing to remove otherwise). Null when the template is not
 * simple, a binding reads `$el`, or an expression is not of the value form.
 */
export function makeCode(nodes: NodeDef[], fns: string[]): string | null {
  if (!nodes.every((nd) => !nd.dl && nd.state == null && nd.b.every((b) => SIMPLE_KINDS.has(b.k) && !b.e))) return null;
  // only elements with value bindings: a handler binds on its element's first event
  const valued = nodes.filter((nd) => nd.b.some((b) => b.k !== 'on'));
  const { decls, els } = lookup(valued);
  const vals: string[] = [], writes: string[] = [], names: string[] = [];
  for (let k = 0; k < valued.length; k++) {
    const e = 'e' + k;
    decls.push(`${e} = ${els[k]}`);
    for (const b of valued[k]!.b) {
      if (b.k === 'on') continue;
      const code = fns[b.f!]!;
      if (!code.startsWith('($) => (') || !code.endsWith(')')) return null;
      const v = 'v' + names.length;
      names.push(v);
      vals.push(`${v} = ${e} ? (${code.slice('($) => ('.length, -1)}) : w.U`);
      writes.push(`${e} && w.${WRITER[b.k]}(${e}, ${JSON.stringify(b.n ?? '')}, ${v}${b.k === 'class' ? `, ${valued[k]!.cl ? 1 : 0}` : ''})`);
    }
  }
  if (!names.length) return null;
  return `(c, $, w) => { const ${decls.join(', ')}; const ${vals.join(', ')}; ${writes.join('; ')}; return [${names.join(', ')}]; }`;
}

// ---- first paint

/** A resource whose request is fixed at build time: a literal `src`, no `when`, not paginated, `each`, `call` or embedded. */
const fixedRequest = (r: ResourceDef) => !r.call && !r.each && r.data == null && !r.paginate && r.when == null && r.src.length > 0 && r.src.every((p) => typeof p === 'string');

/** URLs of the resources whose request is fixed at build time (callers pass only those it may request early: same-origin or a listed origin): the page preloads them from its HTML (low priority when every resource of that URL is `lo`). */
export function preloads(resources: ResourceDef[]): Array<{ url: string; lo: boolean }> {
  const urls = new Map<string, boolean>();
  for (const r of resources.filter(fixedRequest)) {
    const u = (r.src as string[]).join('').replace(/[?&](?=#|$)/, '');
    if (/^\/(?!\/)/.test(u) || /^https?:\/\/[^/?#]+\//i.test(u)) urls.set(u, (urls.get(u) ?? true) && !!r.lo);
  }
  return [...urls].map(([url, lo]) => ({ url, lo }));
}

/** The origins literal `src`s name (`https://api.example.com/…`), of resources and streams: the page preconnects to them. */
export function preconnects(resources: ResourceDef[], syncs: SyncDef[]): string[] {
  const out = new Set<string>();
  for (const { src } of [...resources, ...syncs]) {
    const m = typeof src[0] === 'string' && /^https?:\/\/[^/?#]+/i.exec(src[0]);
    if (m) out.add(m[0]);
  }
  return [...out];
}

/** JSON-like data: what a literal state object holds. */
function plainData(v: unknown, depth = 0): boolean {
  if (v === null || ['string', 'number', 'boolean', 'undefined'].includes(typeof v)) return true;
  if (depth > 20 || typeof v !== 'object') return false;
  if (Array.isArray(v)) return v.every((x) => plainData(x, depth + 1));
  const proto = Object.getPrototypeOf(v);
  return (proto === Object.prototype || proto === null) && Object.values(v as object).every((x) => plainData(x, depth + 1));
}

function deepFreeze<T extends object>(v: T): T {
  for (const x of Object.values(v)) if (x && typeof x === 'object') deepFreeze(x);
  return Object.freeze(v);
}

/** a binding that cannot be written ahead */
const FAIL: unique symbol = Symbol('first paint: runtime-only');

const isPrimitive = (v: unknown) => v == null || ['string', 'number', 'boolean'].includes(typeof v);

/**
 * What the runtime would write for value `v` of binding `b` on `el`, as `[kind, value]`, or FAIL
 * when it cannot be written ahead (an object, a refused URL or style, a select).
 */
type Kind = 'text' | 'attr' | 'class' | 'style' | 'show' | 'checked' | 'value';

function firstPaintValue(el: P5Element, b: Binding, v: unknown, schemes: Set<string>): [Kind, unknown] | typeof FAIL {
  switch (b.k) {
    case 'text': return isPrimitive(v) ? ['text', '' + (v ?? '')] : FAIL;
    case 'show': return ['show', !!v];
    case 'class': return ['class', !!v];
    case 'attr': {
      if (!isPrimitive(v)) return FAIL;
      if (v == null || v === false) return ['attr', null];
      const s = v === true ? '' : '' + v;
      return urlAllowed({ localName: el.tagName } as Element, b.n!, s, 'https://sinter.invalid/', schemes) ? ['attr', s] : FAIL;
    }
    case 'style': {
      if (!isPrimitive(v)) return FAIL;
      if (v == null || v === false) return ['style', null];
      return STYLE_BAD.test('' + v) ? FAIL : ['style', '' + v];
    }
    case 'model': {
      const value = attr(el, 'value') ?? 'on';
      if (b.n === 'checkbox') return ['checked', Array.isArray(v) ? v.map(String).includes(value) : !!v];
      if (b.n === 'radio') return ['checked', v != null && '' + v == value];
      return isPrimitive(v) ? ['value', '' + (v ?? '')] : FAIL;
    }
  }
  return FAIL;
}

/** Writes one first-paint value into the static HTML, as the runtime's write would into the DOM. */
function writeFirstPaint(el: P5Element, kind: Kind, name: string | null, v: unknown) {
  const text = (s: string) => {
    for (const c of el.childNodes) (c as { parentNode: unknown }).parentNode = null;
    el.childNodes = s ? [{ nodeName: '#text', value: s, parentNode: el } as unknown as P5Node] as never : [];
  };
  const set = (n: string, value: string | null) => {
    if (value === null) el.attrs = el.attrs.filter((a) => a.name !== n);
    else setAttr(el, n, value);
  };
  switch (kind) {
    case 'text': text(v as string); break;
    case 'show': set('hidden', v ? null : ''); break;
    case 'attr': set(name!.toLowerCase(), v as string | null); break;
    case 'class': {
      const list = (attr(el, 'class') ?? '').split(/\s+/).filter((c) => c && c !== name);
      if (v) list.push(name!);
      set('class', list.length ? list.join(' ') : attr(el, 'class') != null ? '' : null);
      break;
    }
    case 'style': {
      const cur = attr(el, 'style') ?? '';
      const rest = cur.split(';').map((d) => d.trim()).filter((d) => d && d.slice(0, d.indexOf(':')).trim().toLowerCase() !== name);
      if (v !== null) rest.push(`${name}: ${v as string}`);
      set('style', rest.length ? rest.join('; ') : cur ? '' : null);
      break;
    }
    case 'checked': set('checked', v ? '' : null); break;
    case 'value': if (el.tagName === 'textarea') text(v as string); else set('value', v as string); break;
  }
}
