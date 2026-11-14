// The compiler: one pure, deterministic function from annotated HTML to a
// rewritten page plus its IR and function table.
import type { SourceMap } from './sourcemap.js';
import { rewriteImages, type ImageHost, type ImageResult } from './images.js';
import { Layout, type Reserved, type StyleSheet } from './layout.js';
import { HEAD_ELEMENTS, parseDocument } from './head.js';
import type { RemoteConfig } from '../remote.js';
import { AUTO_FIT_HINT, AUTO_FIT_ROWS, FLUID_WIDTHS } from './images.js';
import * as parse5 from 'parse5';
import { parseExpressionAt } from 'acorn';
import type { DefaultTreeAdapterMap } from 'parse5';
import { type Code, type Diagnostic, didYouMean, severityOf } from './diagnostics.js';
import { analyze, literalNames, STORE_FNS, throughField, type ComponentScope, type ExprOptions, type ExprResult, type LetEntry, type LoopEntry, type PageInfo, type Read, type ResourceInfo, type Scope } from './expr.js';
import { callerAttribute, COMPONENT_NAME, DOM_EVENTS, scopeCss, typeMembers, type Member } from './components.js';
import type { Node } from 'acorn';
import type * as acorn from 'acorn';
import { COMPLEXITY_DEFAULTS, COMPLEXITY_LIMITS, measure, type ComplexityOptions } from './complexity.js';
import { ATTRIBUTES, CHAR_KEYS, ELEMENTS, KEY_ALIASES, LOOSE_SHIFT, MODIFIERS, NAMED_KEYS } from './vocabulary.js';
import type { CheckExpr, CheckFrame, CheckLoc, CheckResource, CheckUnit, TypeRef } from './check-unit.js';
import { apiOf, shapeTemplate, type ApiDef, type ApisDef, type OperationShape } from './apis.js';
import { deref, matchOperation, matchResource, type Method, type OpenApiMatch, namedAt, namedSchema, properties, propertyNames, queryNames, responseEntities, walk, wrapperKey, type OpenApiSpec } from './openapi.js';
import type { ActionDef, ApplyDef, Binding, EarlyIR, EventDef, IR, NodeDef, Paginate, PathRef, ResourceDef, SyncDef, TemplateDef, UrlTemplate } from '../ir.js';
import { $k, schemesOf, STYLE_BAD, urlAllowed } from '../runtime/security.js';
import { withParams } from '../runtime/url.js';
import { firstParams, pageParams } from '../runtime/pages.js';
import { eachPath } from '../paths.js';
import { pagePaths } from '../page-paths.js';
import { bytes, date, isCalendarDate, number } from '../runtime/helpers.js';
import { config } from '../runtime/config.js';

/** the compiler's IR holds paths as strings (the page module's holds node ids) */
const strs = (x: PathRef[] | undefined) => (x ?? []) as string[];

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
  /** `sinter({ apis })`, resolved: paths are relative to them and must be operations they declare (their specs are in `openapi`) */
  apis?: ApisDef | null;
  /** the actions module (`data-sn-call`, `<sn-resource call>`), same shape as helpers */
  actions?: HelperManifest;
  /** `sinter({ lazy })`: the packages `data-sn-import` and `data-sn-preload` may name (`true`: any, for testing) */
  lazy?: readonly string[] | true;
  /**
   * the lazy packages a component's script reaches through its imports (by its module, `/src/components/x.ts`),
   * or none: a script that reaches one loads with it, apart from the page bundle (docs/lazy.md)
   */
  lazyScript?: (module: string) => string[];
  /** SN507: limits for expressions too complex for markup, and the level (default `warn`) */
  complexity?: ComplexityOptions;
  /** SN509: report `then`/`catch` handlers that start each other again through `run()` (off by default) */
  checkCycles?: boolean;
  /** write bindings whose value is a build-time constant (literal state, no helpers) into the HTML */
  prerender?: boolean;
  /**
   * builds: the base language's messages. With `prerender`, a text binding
   * that calls `m` is written into the HTML in the base language and marked `data-sn-m`; it is still
   * rendered in the browser (early file, page module), which writes the visitor's language
   */
  baseMessages?: Record<string, string>;
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
  /** the early module runs as a classic script in the head, started by `observe` (see `@tiaforge-ui/sinter/early`); with `early.src`, its tag is classic */
  observe?: boolean;
  /**
   * builds served by a server that fills embedded data (sinter-axum): every resource whose request
   * only the page's URL decides gets a placeholder in the head, so it is neither preloaded nor
   * requested early; not `call`, `each`, or `early="off"` (a request a middleware changes)
   */
  embed?: boolean;
  /** internal: false when a page whose path is a pattern has nothing else to run, so it gets no canonical link (`compileParts`) */
  canonicalLink?: false;
  /** the module whose default export is the app's `prefetch` feature (every page's description), added to the page's features */
  prefetch?: string | null;
  /** also return where each function in `fns` was written (`CompiledParts.sources`), for the page module's source map */
  sourcemap?: boolean;
  /** where the app's components are (default `<root>/src/components`): `<name>.html` is the component `<name>` */
  components?: string;
  /** where the app's layouts are (default `<root>/src/layouts`): `<name>.html` is the layout `<name>`, a page's only tag */
  layouts?: string;
  /** Vite's `base`, which the pages' URLs start with (default `/`); for SN515 */
  base?: string;
  /**
   * `sinter({ site })`: `$site` (the site's root URL), the page's `$canonical` (null for a page whose path
   * is a pattern: computed in the browser from `origin`), and `link` to write the canonical link into a
   * page that has none (docs/static-pages.md#canonical-urls)
   */
  urls?: { site: string; canonical: string | null; origin: string };
  /**
   * `localePrefix`: the page in one language (`name`). `baseMessages` is that language's text; the page's
   * `data-sn-path` patterns get its prefix after `base`; `localeUrl(l)` is the page's URL in language `l`, from
   * `urls` (null for a page whose paths all have parameters: from the browser's path); the page module records
   * the language in the `locale` cookie (docs/static-pages.md#languages)
   */
  locale?: { name: string; urls: Record<string, string> | null; base: string };
  /**
   * internal, set by `compileParts` for its second pass: the `data-sn-if` templates (by `file:offset`)
   * whose condition the first pass found constant (state nothing writes), and its value
   */
  decided?: Map<string, boolean>;
  /**
   * internal, set by `compileParts` for its second pass: the `data-sn-for` templates (by `file:offset`
   * and the components they are in) whose list the first pass found constant, and its length: each is
   * unrolled into that many rows, the item and index given to each as constants
   */
  unrolled?: Map<string, number>;
  /**
   * internal, set by `compileParts` for its second pass: the state fields (`file:offset#field`) the first
   * pass's decided `data-sn-if`s and unrolled loops read, for `fixedState`
   */
  frozen?: Set<string>;
  /**
   * the page must ship no JavaScript (`sinter({ static })`): each thing that runs in the browser is
   * `SN322` where it was written. Needs `prerender`, which leaves out what can never change.
   */
  static?: boolean;
  /** every component of the app: the candidates of `<sn-component use>` a helper chooses (default: the components the page names) */
  componentNames?: string[];
  /** the module the page module imports for a component's scoped styles (`CompiledParts.styles`), so the bundler puts them in the page's stylesheet */
  componentCss?: (name: string) => string;
  /**
   * the stylesheets the page loads, in order: the boxes they fix size images (as `images.styles`) and
   * the space a list's rows take before its data arrives (docs/first-paint.md#reserved-space)
   */
  styles?: StyleSheet[];
  /** builds: the module the page module imports for the page's generated first-paint rules (`CompiledParts.paint`), which the adapter serves */
  paintCss?: string;
  /** a font family's `line-height: normal` as a multiple of its size, from the font files the build has (fonts-build.ts) */
  normalLineHeight?: (family: string) => number | null;
}

/** A place in the markup: `file`, 1-based line and column. */
export interface SourcePos { file: string; line: number; col: number }

/**
 * Where a compiled function was written: the start of the expression (or of its element). `parts`:
 * expressions the compiler inlined into a function it wrote, each at `at` for `len` characters of its code.
 */
export interface FnSource extends SourcePos { parts?: Array<SourcePos & { at: number; len: number }> }

/** With `sourcemap`: the source of each function in a table (null: generated, nothing in the markup), and the files' text. */
export interface FnSources { fns: Array<FnSource | null>; content: Record<string, string> }

export interface CompileResult {
  html: string;
  /** the page loads query-links: its Speculation Rules leave out its own URLs with another query */
  sameLinks?: true;
  /** the page module; with `static`, the HTML does not load it */
  module: string;
  /** why the page needs the runtime (empty: nothing runs in the browser) */
  runtime: RuntimeReason[];
  /** with `prerender`, nothing on the page runs in the browser: the HTML has no script of sinter's, and links the stylesheets the module imports */
  static?: true;
  /** the scoped styles of the components the page uses (the adapter serves them at `componentCss(name)`) */
  styles: Array<{ name: string; css: string }>;
  /** lazy packages the page fetches with itself (`data-sn-preload`): the build writes their modulepreload links */
  preload: string[];
  /** component scripts that load with lazy packages: the module and the packages */
  lazyScripts?: Array<{ module: string; lazy: string[] }>;
  /** with `sourcemap`: the page module's source map, from each function back to the markup (null-free; absent when nothing maps) */
  map?: SourceMap;
  /** with `sourcemap`: the early module's source map */
  earlyMap?: SourceMap;
  diagnostics: Diagnostic[];
  files: string[];
  /** with `check: true` */
  check?: CheckUnit;
  /** with `early`: the page's early module, or null when the page has nothing to run early */
  early?: string | null;
  /** the built-in message keys the page calls (markup only; modules are collected by the adapter); absent without built-in messages */
  messages?: string[];
  /** with `images` */
  images?: ImageResult;
  /** with `paintCss`: the rules of the page's reserved space (the placeholders of lists whose data comes later), empty when none */
  paint?: string;
  /** every width the page asks the resizing service for (`remoteImages`) */
  remoteWidths?: number[];
  /** what another page needs to request this page's data ahead (null: nothing) */
  prefetch: PrefetchParts | null;
  /** the page's embedded-data placeholders, for a server that fills them (`sinter-embed.json`) */
  embed: EmbedSlot[];
  /** the page's `data-sn-path` patterns */
  path: string[];
  /** the page's array parameters (`IR.urlArrays`): the server reads them as lists */
  urlArrays?: string[];
  /** `<html data-sn-prefetch="off">`: no other page prefetches or prerenders this one */
  /** origins of resources that could be requested early but are not in `origins` */
  unlistedOrigins?: string[];
  prefetchOff?: true;
}

/** What the early chunk runs: the bindings that can render before data, and what they import. */
export interface EarlyParts {
  ir: EarlyIR;
  fns: string[];
  /** with `sourcemap` */
  sources?: FnSources;
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
  /** the page's array parameters (`IR.urlArrays`) */
  a?: string[];
}

/**
 * One embedded-data placeholder (`data-sn-data`), for a server that fills it per request (a
 * middleware: `sinter-embed.json`). `id`: the `data-sn` id the build gives the `<script>`. `src`:
 * the resource's URL template when only literals and plain `$url.<name>` reads make it up (`{ url:
 * name }`), else null and the server must produce the data itself (`call`, `each` too). `when`:
 * the resource has a condition the server cannot evaluate. `query`: a paginated resource's first
 * page, the parameters the pager sends for it (`firstParams`), set on the template's URL as the
 * runtime sets them (`withParams`), in this order. `start`: its `page-model` parameter; from page 2
 * on, the parameters are `query` of `start` with `key` set to the page (with `skip`, to
 * `(page - 1) * size`), as the pager's `pageParams` writes them.
 */
/**
 * A `when` a server can evaluate: a `$url` value is present and not empty (`{ url }`), equal or not
 * to a string (`eq`, `ne`; an absent value equals nothing), and `not`, `and`, `or` over those.
 */
export type EmbedCond = { url: string; eq?: string; ne?: string } | { not: EmbedCond } | { and: EmbedCond[] } | { or: EmbedCond[] };

export interface EmbedSlot {
  id: number;
  resource: string;
  src: Array<string | { url: string }> | null;
  /** the resource's `when`, as a condition a server evaluates, or `true` when only the browser can */
  when?: true | EmbedCond;
  query?: Array<[string, string]>;
  start?: { url: string; key: string; size: number; skip?: true; query: Array<[string, string]> };
  /** the static headers of the resource's API (`sinter({ apis })`): the server sends them with its request */
  headers?: Record<string, string>;
}

/** Why a page needs the runtime: what runs in the browser, and where it was written. */
export interface RuntimeReason { what: string; file: string; line: number; col: number }

export interface CompiledParts {
  html: string;
  /**
   * why the page needs the runtime, in document order; empty when nothing on it runs in the browser (with
   * `prerender`: then the page gets no script, and its stylesheets are linked: see `static`)
   */
  runtime: RuntimeReason[];
  /** with `prerender`, nothing on the page runs in the browser: no page module, no early script */
  static?: true;
  ir: IR;
  fns: string[];
  /**
   * with `prerender`: the state fields (`$s<sid>.<field>`) the build used as constants (written into the
   * HTML, a branch decided, a loop unrolled), their bindings gone: writing one at run time changes nothing
   * on the page. Testing's `state(el).update()` refuses them.
   */
  fixedState?: string[];
  /** with `sourcemap` */
  sources?: FnSources;
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
  /** with `paintCss`: the rules of the page's reserved space, empty when none */
  paint?: string;
  /** the resizing service's config, when a bound image uses it (the page module creates `$ri` from it) */
  remote?: RemoteConfig;
  /** every width the page asks the service for */
  remoteWidths?: number[];
  /** what another page needs to request this page's data ahead; null when no request is decided by the URL alone */
  prefetch: PrefetchParts | null;
  /** the page's embedded-data placeholders, in document order */
  embed: EmbedSlot[];
  /** `<html data-sn-prefetch="off">` */
  prefetchOff?: true;
  /** origins of resources that could be requested early but are not in `origins` */
  unlistedOrigins?: string[];
  /** the scoped styles of the components the page uses, by component */
  styles: Array<{ name: string; css: string }>;
  /** the scripts of the components the page uses: the module, its class `export` imported as `local`; `lazy`: the packages it loads with */
  scripts: Array<{ name: string; module: string; local: string; export: string; lazy?: string[] }>;
  /** lazy packages the page module loads itself (`data-sn-import`): the package, and its loader's local name */
  lazy: Array<{ spec: string; local: string }>;
  /** lazy packages the page fetches with itself (`data-sn-preload`) */
  preload: string[];
}

const ATTRS = ATTRIBUTES.map((a) => a.name);
const METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const;
/** an action's expressions evaluated when it triggers, so they see `$event` */
const TRIGGER_TIME = new Set(['data-sn-get', 'data-sn-post', 'data-sn-put', 'data-sn-patch', 'data-sn-delete', 'data-sn-call', 'data-sn-body', 'data-sn-confirm']);
const ACTION_ONLY = ['body', 'trigger', 'debounce', 'concurrency', 'optimistic', 'then', 'catch', 'confirm', 'encoding', 'apply', 'retry'];
const UNSAFE_ELEMENTS = new Set(['script', 'style', 'iframe', 'object', 'embed', 'base', 'meta', 'link', 'animate', 'set', 'animatemotion', 'animatetransform']);
const FORM_CONTROLS = new Set(['input', 'select', 'textarea']);
const RESOURCE_ATTRS = ELEMENTS.find((e) => e.name === 'sn-resource')!.attrs;
const EVENT_ATTRS = ELEMENTS.find((e) => e.name === 'sn-event')!.attrs;
const IDENT = /^[A-Za-z_][\w]*$/;
const BAD_PARAM = /^(constructor|__proto__|prototype)$/;
const SECRET_AUTOCOMPLETE = /^(cc-|one-time-code$|current-password$|new-password$)/;

interface Origin { file: string; src: string; chain: string[] }

/** One use of a component: its tag in the caller's markup (`host`), replaced by the component's root. */
interface Use {
  name: string;
  file: string;
  host: P5Element;
  root: P5Element;
  /** the component's `<template data-sn-component>`, where its contract is written */
  template: P5Element;
  /** declared props and events (null: written as a type the compiler cannot list, such as an alias) */
  props: Member[] | null;
  propsText: string;
  emits: Member[] | null;
  emitsText: string | null;
  /** the components it is inside, outer first, `#` for a `data-sn-for` or `data-sn-if` template between */
  chain: string[];
  /** `data-sn-early="off"` on its tag: this use is left out of the early script */
  late?: boolean;
  /** the root's state id: a script's refs reach their instance through it */
  sid?: number;
  /** what the component's markup sees of it */
  scope?: ComponentScope;
  /** the caller's scope at the use: its attributes on the tag and its slot content see it */
  caller?: Scope;
  /** a head component (`data-sn-head`): its elements, inlined at the use with no wrapper */
  head?: { roots: P5Element[]; parent: Use | null };
  /** what its markup sees, computed once (a head component's elements share it) */
  markup?: Scope;
  /** a layout (`<html data-sn-layout>`): the page is its tag, its root the layout's `<html>` */
  layout?: true;
  /** a layout's tag's handlers, compiled on the layout's `<body>` (the page's `<body>` handlers, as before layouts) */
  bodyHandlers?: P5Element;
}

/** A component file, read once: its text, scoped styles and script. */
interface ComponentFile {
  file: string;
  text: string;
  bad?: true;
  css?: string | null;
  /** the script beside it (`/src/components/task-ring.ts`), imported by the page modules that use it */
  script?: string | null;
  /** the class it exports: `TaskRing` for `task-ring`, else `default`; null when it exports neither */
  exported?: string | null;
  /** `<template data-sn-head>`: a head component */
  head?: boolean;
}

/** An `<sn-include>`, kept only to name what the partial reads from the page in its migration error. */
interface IncludeRec { el: P5Element; src: string; names: Set<string>; site: Set<object> | null }
/**
 * an expression's place: the value of `attr` (null: the element's start tag), `shift` characters in.
 * `parts`: for a function the compiler wrote, the code it inlined (found in order) and where each was written.
 */
interface Site { el: P5Element; attr: string | null; shift: number; parts?: Array<{ code: string; site: Site | null }> }

interface Ctx {
  scope: Scope;
  list: NodeDef[];
  /** template id, or -1 outside templates */
  tid: number;
  path: number[];
  stateIdx: number;
  /** inside a `<dialog>` of the same block (page or template) */
  dialog?: boolean;
  /** inside a `<form>` (template content included): a control's action there reports field errors on it */
  form?: boolean;
}

const ONCE_NAMES = new Set(['viewport', 'description', 'robots']);
const ONCE_PROPERTIES = new Set(['og:title', 'og:description', 'og:url', 'og:type', 'twitter:card', 'twitter:title', 'twitter:description']);

/** An element a head has once (SN321): what identifies it, and how a message names it. */
function onceKey(el: P5Element): { id: string; label: string } | null {
  const a = (n: string) => el.attrs.find((x) => x.name === n)?.value;
  if (el.tagName === 'title' || el.tagName === 'base') return { id: el.tagName, label: `\`<${el.tagName}>\`` };
  if (el.tagName === 'link' && a('rel')?.trim().toLowerCase() === 'canonical') return { id: 'canonical', label: '`<link rel="canonical">`' };
  if (el.tagName !== 'meta' || a('media') !== undefined) return null;
  if (a('charset') !== undefined) return { id: 'charset', label: '`<meta charset>`' };
  const name = a('name')?.trim().toLowerCase();
  if (name && ONCE_NAMES.has(name)) return { id: `name:${name}`, label: `\`<meta name="${name}">\`` };
  const prop = a('property')?.trim().toLowerCase();
  if (prop && ONCE_PROPERTIES.has(prop)) return { id: `property:${prop}`, label: `\`<meta property="${prop}">\`` };
  return null;
}

/** the events the runtime itself sends, which bubble up the page */
const SINTER_EVENTS = ['sn-error', 'dismiss'];

/** a prop's value that is a build-time constant, and those of them that are falsy */
const CONST_PROP = /^(true|false|null|undefined|-?\d+(\.\d+)?|'[^'\\]*'|"[^"\\]*")$/;
const FALSY_PROP = ['false', 'null', 'undefined', '0', "''", '""'];

/** The query parameters `paginate` adds to a request, by mode (`runtime/pages.ts`), and the cursor's fields. */
function paginateParams(p: Paginate, cursor: string | undefined): string[] {
  const out = [p.sizeParam];
  if (p.mode === 'offset') out.push(p.offsetParam ?? p.pageParam);
  else {
    out.push(p.directionParam);
    if (p.offsetParam) out.push(p.offsetParam);
    if (cursor) {
      try {
        const ast = parseExpressionAt(cursor, 0, { ecmaVersion: 'latest' }) as acorn.Expression;
        if (ast.type === 'ObjectExpression') for (const x of ast.properties) {
          if (x.type === 'Property' && !x.computed) out.push(x.key.type === 'Identifier' ? x.key.name : String((x.key as acorn.Literal).value));
        }
      } catch { /* reported where the cursor is compiled */ }
    }
  }
  return out;
}

/** The props a use gives as constants (`{ label: true }`), and the optional ones it leaves out (undefined), each as truthy or not. */
function constantProps(src: string | undefined, props: Member[] | null): Map<string, boolean> {
  const out = new Map<string, boolean>();
  const given = new Set<string>();
  if (src !== undefined && src.trim()) {
    let ast: acorn.Expression | null = null;
    try { ast = parseExpressionAt(src, 0, { ecmaVersion: 'latest' }) as acorn.Expression; } catch { ast = null; }
    if (!ast || ast.type !== 'ObjectExpression') return out;
    for (const p of ast.properties) {
      if (p.type !== 'Property' || p.computed) return new Map();
      const key = p.key.type === 'Identifier' ? p.key.name : p.key.type === 'Literal' ? String(p.key.value) : null;
      if (key === null) continue;
      given.add(key);
      const code = src.slice(p.value.start, p.value.end).trim();
      if (CONST_PROP.test(code)) out.set(key, !FALSY_PROP.includes(code));
    }
  }
  for (const m of props ?? []) if (m.optional && !given.has(m.name)) out.set(m.name, false);
  return out;
}

/** what a component's tag may not carry: these change its content, which belongs to the component */
const TAG_ONLY_HINT = 'a component\'s tag takes `data-sn-prop`, `data-sn-model`, handlers, actions, `data-sn-class`, `-attr`, `-style`, `-show` and `-transition`; the rest belongs inside the component';

export function compileParts(html: string, options: CompileOptions): CompiledParts {
  const out = compilePasses(html, options);
  // a page whose path is a pattern gets its canonical link from the early script: only when it runs something anyway
  if (out.canonicalOnly) return compilePasses(html, { ...options, canonicalLink: false });
  return out;
}

function compilePasses(html: string, options: CompileOptions): CompiledParts & { canonicalOnly?: boolean } {
  const first = new Compiler(options);
  const out = first.run(html);
  // `data-sn-if` templates over state nothing writes: decided now, the page compiled again with their branches in place
  if (!options.prerender || options.decided || options.unrolled) return out;
  // loops over constants: unrolled only when the first pass is clean (the second one compiles the rows with their item)
  // (SN322 does not count: what the first pass found running may be a loop the second one unrolls)
  const unrolled = first.unrolls.size && !out.diagnostics.some((d) => d.severity === 'error' && d.code !== 'SN322') ? first.unrolls : null;
  if (!first.decided.size && !unrolled) return out;
  return new Compiler({ ...options, decided: first.decided, ...(unrolled ? { unrolled } : {}), frozen: first.foldedState() }).run(html);
}

class Compiler {
  readonly diagnostics: Diagnostic[] = [];
  readonly files = new Set<string>();
  /** the canonical link `canonical()` added to a page whose path is a pattern: bound to `$canonical`, not a reason to run */
  canonicalLink: P5Element | null = null;
  readonly fns: string[] = [];
  readonly fnIndex = new Map<string, number>();
  /** how many times each function's index was handed out: a function no longer used by anything is left out (`dropConstants`) */
  private readonly fnUses: number[] = [];
  /** where each function in `fns` was first written: the expression that compiled to it, else the element being compiled */
  readonly fnAt: Array<Site | null> = [];
  /** the element or expression being compiled: the site of functions the compiler writes itself */
  private at: Site | null = null;
  /** each compiled expression's site, by its code: a function made from it maps to where it was written */
  private readonly codeAt = new Map<string, Site>();
  /** dev builds: the site of each function's latest `fn()` call (identical code, one entry: this use's own place) */
  private readonly callAt = new Map<number, Site | null>();
  /** each `data-sn-for` template's site, by template id: its row lookups map there */
  private readonly templateAt = new Map<number, Site>();
  /** each state's `data-sn-state` and the site of each field, by state id: the early module's state functions */
  /** the early module's state functions, written for its table alone, by code */
  private readonly earlySites = new Map<string, Site>();
  private readonly stateAt = new Map<number, { site: Site; fields: Map<string, Site> }>();
  readonly origins = new WeakMap<object, Origin>();
  /** template nodes and their elements (in template content), for constants written into templates */
  private readonly tplEls = new Map<NodeDef, P5Element>();
  /** bindings in templates `prerender()` wrote into the template's markup: the page module leaves them out */
  private readonly tplPainted = new Set<Binding>();
  /** `data-sn-if` templates whose condition is constant, by `file:offset`, for a second pass (null: the uses disagree) */
  readonly decided = new Map<string, boolean>();
  private readonly undecided = new Set<string>();
  /** `data-sn-for` templates whose list is constant and whose rows need nothing at run time, by `unrollKey`, with the list's length */
  readonly unrolls = new Map<string, number>();
  /** the state fields (`file:offset#field`) each decided `data-sn-if` and unrolled loop reads, by its key */
  private readonly foldReads = new Map<string, Set<string>>();
  /** the state fields (`$s<sid>.<field>`) whose bindings `dropConstants` left out */
  private readonly frozen = new Set<string>();
  private readonly notUnrolled = new Set<string>();
  /** the second pass: the top-level elements of each unrolled row, with what their item and index are */
  private readonly rowOf = new WeakMap<P5Element, { tpl: P5Element; item: string; index: string | null; list: string; offset: number; k: number }>();
  /** a layout's `<body>`, which takes the handlers of the page's tag */
  private readonly layoutBody = new WeakMap<P5Element, Use>();
  /** text forwarded into a component's named slot by a slot with `slot="…"` (elements carry the attribute) */
  private readonly forwarded = new WeakMap<object, string>();
  /** layout files by tag, read once (null: no such layout) */
  private readonly layoutFiles = new Map<string, { file: string; text: string } | null>();
  /** component files by tag, read once (null: no such component, a plain custom element) */
  private readonly componentFiles = new Map<string, ComponentFile | null>();
  /** by component id (`ComponentScope.id`): the use, for the refs of its markup */
  private readonly useById = new Map<number, Use>();
  /** slot content's top-level elements and the component whose markup they are ('' for the page's) */
  private readonly slotEls: Array<{ el: P5Element; caller: string; host: string }> = [];
  /** a component's root, by the element that replaced its tag */
  readonly useOf = new WeakMap<P5Element, Use>();
  /** a component's tag: the use it belongs to */
  readonly hostUse = new WeakMap<P5Element, Use>();
  /** slot content's top-level nodes: the use whose caller wrote them */
  readonly slotOf = new WeakMap<object, Use>();
  /** every use, by component name */
  readonly uses = new Map<string, Use[]>();
  /** the scripts of the components the page uses: module and local name in the page module */
  readonly scripts = new Map<string, { module: string; local: string; name: string; lazy?: string[] }>();
  /** `data-sn-import`: each lazy package's loader, by package, with its local name in the page module */
  readonly lazyLoads = new Map<string, string>();
  /** `data-sn-preload`: the lazy packages the build preloads with the page */
  readonly preloads = new Set<string>();
  /** nodes that came from an `<sn-include>`, and the top-level ones */
  private readonly includeOf = new WeakMap<object, IncludeRec>();
  private readonly includeTop = new WeakMap<object, IncludeRec>();
  private readonly includes: IncludeRec[] = [];
  /** `patch()`/`remove()` sources: what handlers assign to state paths and components emit, by reference (`@$s3.sel`, `@ev:2:select`) */
  private readonly srcOf = new Map<string, Set<string>>();
  /** calls whose sources hold references, resolved after the walk */
  /** write-through targets whose row's source is a reference: added once it is resolved */
  private readonly pendingTargets: Array<{ ap: () => ApplyDef | null; rd: Read; ref: string }> = [];
  private readonly srcCalls: Array<{ el: P5Element; attr: string; shift: number; fn: string; offset: number; src: string[]; text: string }> = [];
  private useIds = 0;
  /** components used inside themselves: their tags (recursion points), and the definition each compiles to */
  private readonly points = new WeakMap<P5Element, string>();
  /** `<sn-component use>`: one point per candidate, rendered when `use` is its name; `key`: the value of the data that names it, for narrowing */
  private readonly choices = new WeakMap<P5Element, { name: string; key: string | null; keySrc: string | null; names: string[]; first: boolean; keys?: string[]; hasElse?: boolean }>();
  private readonly defs = new Map<string, { tid: number; id: string; use: Use } | null>();
  /** the synthetic tag of a shared definition, whose props are the row's item `rt` */
  private readonly defHosts = new WeakMap<P5Element, { rt: string }>();
  /** the page's `<head>`, where shared definitions go */
  private head: P5Element | null = null;
  /** nodes of components with `data-sn-early="off"`: the early script leaves their bindings out */
  private readonly lateNodes = new WeakSet<NodeDef>();
  /** attributes SN507 has measured, so an expression analysed twice is reported once */
  readonly measured = new WeakMap<P5Element, Set<string>>();
  readonly lineStarts = new Map<string, number[]>();
  readonly page: PageInfo;
  readonly resources: ResourceDef[] = [];
  /** resources with `early="off"`: no preload, no early request (one a request middleware answers or adds a header to) */
  private readonly noEarly = new Set<string>();
  /** by `<template data-sn-for>` outside templates: its reserved space and the content-sized box around it (`planSpace`) */
  private readonly spacePlan = new Map<P5Element, { off: boolean; sized: { el: P5Element; siblings: boolean } | null; space: Reserved | null; resource: string | null }>();
  /** the placeholders' rules (`CompiledParts.paint`) */
  readonly paintRules: string[] = [];
  private spaceN = 0;
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
  /** the element that declared each resource and stream, for `runtimeReasons` */
  private readonly declAt = new WeakMap<object, P5Element>();
  readonly stateInits: Array<{ sid: number; fields: Array<{ key: string; code: string; deps: string[] }>; persist: string | null }> = [];
  /** `<html data-sn-prefetch="off">`: other pages do not prefetch or prerender this one */
  prefetchOff = false;
  /** `data-sn-path` patterns (for `$url` in the early file's requests) */
  pathList: string[] = [];
  /** `$s<sid>.<name>` paths a persisted model writes at mount */
  readonly persisted = new Set<string>();
  /** models on `$url` parameters: whether each binds a list (`<select multiple>`, a checkbox with a `value`) */
  readonly urlBinds: Array<{ name: string; array: boolean; report: (msg: string) => void }> = [];
  /** links and what the build can see of where they go (static `href`s, the literal starts of bound ones); elements whose `href` is bound */
  readonly hrefs: Array<{ el: P5Element; prefixes: HrefPrefix[]; literal: boolean }> = [];
  readonly boundHrefs = new Set<P5Element>();
  /**
   * Same-page links (query-links.ts): the query parameters the page reads, from the IR's dependencies
   * (`$url.<name>`); null when it reads `$url` whole or by a computed name, or has none.
   */
  urlReads(ir: IR, patterns: string[]): string[] | null {
    const fromPath = new Set(patterns.flatMap((p) => p.split('/').filter((x) => x[0] === ':').map((x) => x.slice(1))));
    const names = new Set<string>();
    let whole = false;
    eachPath(ir, (p) => {
      if (typeof p !== 'string' || (p !== '$url' && !p.startsWith('$url.'))) return;
      const n = p.slice(5).split('.')[0] ?? '';
      // `$url`, `$url[k]` (`*`) and the like: every parameter may be read
      if (p === '$url' || /^[*#~{]/.test(n)) whole = true;
      else names.add(n);
    }, () => {});
    const query = [...names].filter((n) => !fromPath.has(n));
    return whole || !query.length ? null : [...names].sort();
  }
  /**
   * The URLs the page is served at, and the forms of them the source may link to: `pagePaths`
   * (`/about/`, `/about`, `/`, `/index.html`, `data-sn-path` patterns) and the page's file (`/about.html`).
   */
  ownPaths(patterns: string[]): string[] {
    const rel = this.opts.file.slice(this.opts.root.length).replace(/^\/+/, ''), base = this.opts.base ?? '/';
    return [...new Set([...pagePaths(rel, base, patterns), ...(patterns.length ? [] : [(base.replace(/\/*$/, '/')) + rel])])];
  }
  /** Whether a link the build can see goes to the page itself: a static `href` resolved against the page's file, or a bound one by its start. */
  seesSameLink(paths: string[]): boolean {
    const rel = this.opts.file.slice(this.opts.root.length).replace(/^\/+/, ''), here = 'http://x' + (this.opts.base ?? '/').replace(/\/*$/, '/') + rel;
    return this.hrefs.some((h) => h.prefixes.some((p) => {
      // a static relative `href` (`about.html?q=1`, `./?q=1`): resolved as the browser would, from the page's file
      if (h.literal && p.s && !/^([a-z][a-z0-9+.-]*:|\/|\?|#)/i.test(p.s)) {
        try { const u = new URL(p.s, here); return samePage({ s: u.pathname + (u.search || '?'), whole: true }, paths); } catch { return false; }
      }
      return samePage(p, paths);
    }));
  }
  /**
   * SN519: a pager link (a static query-only `href` that sets a `page-model` parameter) that drops
   * query parameters the page reads. A filter or tab link that drops the page is how a list starts
   * at page 1; a link whose `href` is also bound is its fallback.
   */
  checkDroppedQuery(reads: string[], patterns: string[]): void {
    const models = new Set(this.pageModels.map((m) => m.name));
    const fromPath = new Set(patterns.flatMap((p) => p.split('/').filter((x) => x[0] === ':').map((x) => x.slice(1))));
    const query = reads.filter((n) => !fromPath.has(n) && !models.has(n));
    for (const h of this.hrefs) {
      const v = h.prefixes[0]?.s;
      if (!h.literal || v?.[0] !== '?' || this.boundHrefs.has(h.el)) continue;
      const has = new Set(new URLSearchParams(v.slice(1).split('#')[0]).keys());
      if (![...has].some((n) => models.has(n))) continue;
      const dropped = query.filter((n) => !has.has(n));
      if (dropped.length) this.report(h.el, 'href', 'SN519', `\`${v}\` keeps only its own query: ${dropped.map((n) => `\`${n}\``).join(', ')}, which this page reads, ${dropped.length > 1 ? 'are' : 'is'} dropped when it is followed`, 0,
        'build the whole query in `data-sn-attr` (`href: \'?page=\' + n + \'&tag=\' + encodeURIComponent($url.tag)`), or leave the parameter out on purpose');
    }
  }
  /** `page-model` parameters: one is never a list */
  readonly pageModels: Array<{ name: string; report: (msg: string) => void }> = [];
  /**
   * The checks that need every array parameter: one bound as a list and as one value (SN210), a list
   * written to a parameter that is not one (SN210), a list tested as a condition (SN211).
   */
  checkUrlArrays(arrays: Set<string>) {
    // a write to an array parameter goes through `$l` (location.ts), decided here: the runtime keeps no
    // list of them for writes. Same length as `$u`, so source maps still line up.
    if (arrays.size) this.fns.forEach((f, i) => {
      if (f.includes('$.$u(')) for (const n of arrays) f = f.split(`$.$u(${JSON.stringify(n)}, `).join(`$.$l(${JSON.stringify(n)}, `);
      this.fns[i] = f;
    });
    for (const p of this.pageModels) if (arrays.has(p.name)) p.report(`\`page-model\` takes a URL parameter that is one value; \`$url.${p.name}\` is a list (a \`<select multiple>\` or a checkbox with a \`value\` binds it)`);
    for (const b of this.urlBinds) if (!b.array && arrays.has(b.name)) b.report(`\`$url.${b.name}\` is a list elsewhere on the page (a \`<select multiple>\` or a checkbox with a \`value\`), and one value here; bind it as a list everywhere`);
    for (const w of this.page.urlWrites ?? []) {
      if (w.list && !arrays.has(w.name)) w.report('SN210', `\`$url.${w.name}\` is one value (no \`<select multiple>\` or checkbox with a \`value\` binds it), and a list is written to it; write one value`);
      if (w.test && arrays.has(w.name)) w.report('SN211', `\`$url.${w.name}\` is a list and always truthy; use \`$url.${w.name}.length\``);
    }
  }
  /** the page's array parameters (`IR.urlArrays`), sorted */
  urlArrays(): string[] { return [...new Set(this.urlBinds.filter((b) => b.array).map((b) => b.name))].sort(); }
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
      usedHelpers: new Set(), usedNs: new Map(), usesNow: false, pathParams: new Set(), dialogs: new Set(), fed: new Set(), ids: new Map(),
    };
    const l = opts.locale;
    if (l) {
      const b = l.base.startsWith('/') ? l.base.replace(/\/?$/, '/') : '/';
      // a page whose paths have parameters: its path in another language is the browser's, with that language's prefix
      const localeUrl = l.urls ? `((l) => (${JSON.stringify(l.urls)})[l])` : `((l) => ${JSON.stringify(b)} + l + location.pathname.slice(${b.length + l.name.length}))`;
      this.page.locale = { name: l.name, messages: Object.entries(opts.helpers.namespaces).find(([, v]) => v.module === '@tiaforge-ui/sinter/messages')?.[0] ?? null, localeUrl };
    }
  }

  run(html: string): CompiledParts & { canonicalOnly?: boolean } {
    let doc = parseDocument(html);
    this.tag(doc, { file: this.opts.file, src: html, chain: [] });
    if (this.isLayoutFile(this.opts.file)) this.diagnostics.push({ severity: 'error', code: 'SN318', message: 'a layout is not a page: a page uses it by its tag. Leave `src/layouts/` out of the build\'s inputs', file: this.opts.file, line: 1, col: 1 });
    else doc = this.mergeLayout(doc) ?? doc;
    this.expandIncludes(doc, [this.opts.file]);
    this.head = findHead(doc);
    this.expandComponents(doc, []);
    if (this.opts.decided?.size) this.foldDecided(doc);
    if (this.opts.urls) this.canonical(doc);
    // a page in one language says which: `<html lang="de">`
    if (this.opts.locale) { const h = doc.childNodes.find((n): n is P5Element => isElement(n) && n.tagName === 'html'); if (h) setAttr(h, 'lang', this.opts.locale.name); }
    if (this.opts.unrolled?.size) this.unrollLoops(doc);
    this.checkHead();
    this.componentIds();
    const sheets = this.opts.styles ?? this.opts.images?.styles;
    const layout = this.layout = sheets?.length ? new Layout(sheets, doc, this.opts.normalLineHeight ? { normalLineHeight: this.opts.normalLineHeight } : {}) : null;
    // the lists whose rows arrive after the first paint: their space, before anything else reads the markup's bindings
    if (layout) this.planSpace(doc, layout);
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
    this.resolveSources();
    this.reportIncludes();
    // the component's name on its root: in dev builds for devtools, and on pages with scoped styles,
    // which start at the roots and stop at other components' roots and at slot content (`data-sn-s`)
    const styled = [...this.uses.keys()].filter((n) => this.componentFiles.get(n)?.css);
    if (this.opts.dev || styled.length) for (const list of this.uses.values()) for (const u of list) if (!u.head) setAttr(u.root, 'data-sn-c', u.name);
    if (styled.length) for (const x of this.slotEls) if (attr(x.el, 'data-sn-c') === undefined) setAttr(x.el, 'data-sn-s', x.caller);

    for (const [name, id] of this.embedded) {
      const r = this.resources.find((x) => x.name === name);
      if (r) r.data = id;
    }
    if (this.opts.embed) this.addPlaceholders(doc);
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
    if (this.opts.prerender) { this.prerender(); this.dropConstants(); }
    let early = this.opts.early ? this.earlyParts() : undefined;
    if (early && this.opts.sourcemap) early.sources = this.sourcesOf(early.fns, this.earlySites);
    // row templates (data-sn-for) get a compiled element lookup; if/else branches render once per
    // toggle and use the generic path walk, which costs no code per template
    const rowTemplates = new Set([...this.roots, ...this.templates.flatMap((t) => t.nodes)].flatMap((n) => n.b.filter((b) => b.k === 'for').map((b) => b.x!)));
    this.at = null;
    for (const t of this.templates) {
      if (!t.nodes.length || !rowTemplates.has(t.id)) continue;
      const at = this.templateAt.get(t.id) ?? null;
      t.find = this.fn(findCode(t.nodes), at);
      const make = makeCode(t.nodes, this.fns);
      // each binding's expression is inlined: it maps to its own attribute
      const parts = t.nodes.flatMap((nd) => nd.b.filter((b) => b.k !== 'on' && b.f !== undefined).map((b) => ({ code: bodyOf(this.fns[b.f!]!), site: this.fnAt[b.f!] ?? null })));
      if (make) t.make = this.fn(make, at && { ...at, parts });
    }

    if (this.opts.prerender) this.fixedDeps();
    // nothing left to run in the browser: no script at all, the stylesheets the page module imported are linked
    const runtime = this.runtimeReasons();
    const isStatic = !!this.opts.prerender && !runtime.length;
    if (this.opts.static) {
      const root = this.opts.root.replace(/[\\/]+$/, '') + '/', file = this.opts.file.replace(/\\/g, '/');
      const page = file.startsWith(root.replace(/\\/g, '/')) ? file.slice(root.length) : basename(file);
      for (const r of runtime) this.diagnostics.push({ severity: 'error', code: 'SN322', message: `${page} must ship no JavaScript (\`sinter({ static })\`), but ${r.what} runs in the browser`, file: r.file, line: r.line, col: r.col, hint: 'remove it, or take the page out of `static` in vite.config' });
    }
    if (isStatic && early !== undefined) early = null;
    if (isStatic) this.linkStyles(doc, images?.css ? this.opts.images?.stylesheet ?? null : null);
    else this.injectScript(doc, early !== undefined && (early !== null || !!this.opts.early!.module) ? this.opts.early!.src ?? null : null);
    const ir: IR = { v: 2, resources: this.resources, syncs: this.syncs, roots: this.roots, templates: this.templates, actions: this.actions };
    if (this.page.usesNow) ir.now = true;
    if (paths.length) ir.path = paths;
    const arrays = this.urlArrays();
    if (arrays.length) ir.urlArrays = arrays;
    this.checkUrlArrays(new Set(arrays));
    const builtin: string[] = [];
    const user: string[] = [];
    for (const h of [...this.page.usedHelpers].sort()) (this.page.helpers.has(h) ? user : builtin).push(h);
    const namespaces: Record<string, string[]> = {};
    for (const [k, v] of [...this.page.usedNs].sort(([a], [b]) => a.localeCompare(b))) namespaces[k] = [...v].sort();
    // unchanged reloads skipped by version, where reloads are routine: refreshes, refetch events and reconnects
    if (this.features.has('refresh') || this.features.has('sse')) this.features.add('versions');
    // a handler or model that writes `$url`: the query string follows (location.ts)
    if (this.page.writesUrl) this.features.add('location');
    // same-page links: the module, and location.ts for the history, on pages with one the build can see.
    // Not with `<base href>`: links resolve against it, not the page's URL
    const reads = this.urlReads(ir, paths), own = this.ownPaths(paths);
    if (reads) this.checkDroppedQuery(reads, paths);
    if (reads && !hasBase(doc) && this.seesSameLink(own)) { ir.urlReads = reads; this.features.add('query-links'); this.features.add('location'); }
    return {
      html: parse5.serialize(doc),
      runtime, ...(isStatic ? { static: true as const } : {}), ...(isStatic && this.canonicalLink ? { canonicalOnly: true } : {}),
      ir, fns: this.fns,
      ...(this.opts.prerender ? { fixedState: this.fixedState() } : {}),
      ...(this.opts.sourcemap ? { sources: this.sourcesOf(this.fns) } : {}),
      features: [...(this.opts.dev ? ['dev'] : []), ...['sse', 'optimistic', 'paginate', 'persist', 'cache', 'versions', 'refresh', 'each', 'listbox', 'keys', 'apply', 'fields', 'form', 'select', 'location', 'typing', 'query-links', 'call', 'debounce', 'confirm', 'models', 'transition', 'components', 'nested', 'defs'].filter((f) => this.features.has(f))],
      helpers: { user, builtin }, namespaces, calls: [...this.calls].sort(),
      diagnostics: this.diagnostics, files: [...this.files].sort(),
      ...(this.check ? { check: this.check } : {}),
      ...(early !== undefined ? { early } : {}),
      ...(images ? { images } : {}),
      ...(this.opts.paintCss ? { paint: this.paintRules.join('\n') + (this.paintRules.length ? '\n' : '') } : {}),
      ...(this.remoteUsed ? { remote: this.opts.remoteImages!, remoteWidths: [...this.remoteWidths].sort((a, b) => a - b) } : {}),
      prefetch: this.prefetchOff ? null : this.prefetchParts(),
      embed: this.embedSlots(),
      ...(this.prefetchOff ? { prefetchOff: true as const } : {}),
      ...(this.unlisted.size ? { unlistedOrigins: [...this.unlisted].sort() } : {}),
      styles: [...this.uses.keys()].sort().flatMap((n) => { const css = this.componentFiles.get(n)?.css; return css ? [{ name: n, css }] : []; }),
      scripts: [...this.scripts].sort(([a], [b]) => a.localeCompare(b)).map(([name, x]) => ({ name, module: x.module, local: x.local, export: x.name, ...(x.lazy ? { lazy: x.lazy } : {}) })),
      lazy: [...this.lazyLoads].map(([spec, local]) => ({ spec, local })),
      preload: [...this.preloads].sort(),
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
    // the runtime's part of action functions (call.ts)
    this.features.add('call');
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
    if (src == null || src === '' || src.includes('{')) return fail('SN316', 'partial `src` must be a literal path');
    for (const a of el.attrs) if (a.name !== 'src') this.report(el, a.name, 'SN101', `\`${a.name}\` is not an attribute of \`<sn-include>\``, 0);
    const resolved = resolvePath(dirname(origin.file), src);
    const root = normalize(this.opts.root).replace(/\/$/, '');
    if (!(resolved === root || resolved.startsWith(root + '/'))) {
      return fail('SN316', `partial \`${src}\` not found or outside the project root`);
    }
    if (chain.includes(resolved)) {
      return fail('SN306', `${[...chain, resolved].map(basename).join(' → ')} includes itself`);
    }
    let text: string;
    try {
      text = this.opts.readFile(resolved);
    } catch {
      return fail('SN316', `partial \`${src}\` not found or outside the project root`);
    }
    this.files.add(resolved);
    const frag = parse5.parseFragment(text, { sourceCodeLocationInfo: true });
    const loc = el.sourceCodeLocation ? this.lineCol(origin.src, el.sourceCodeLocation.startOffset) : { line: 1, col: 1 };
    const here = `${basename(origin.file)}:${loc.line}`;
    this.tag(frag, { file: resolved, src: text, chain: [here, ...origin.chain] });
    const rec: IncludeRec = { el, src, names: new Set(), site: null };
    this.includes.push(rec);
    const mark = (n: object) => {
      this.includeOf.set(n, rec);
      for (const c of (n as P5Parent).childNodes ?? []) mark(c);
      if ((n as P5Element).nodeName === 'template') mark((n as P5Template).content);
    };
    for (const c of frag.childNodes) { mark(c); this.includeTop.set(c, rec); }
    this.expandIncludes(frag, [...chain, resolved]);
    const parent = el.parentNode!;
    const i = parent.childNodes.indexOf(el as never);
    for (const c of frag.childNodes) (c as { parentNode: P5Parent }).parentNode = parent;
    parent.childNodes.splice(i, 1, ...(frag.childNodes as never[]));
    // the browser merges adjacent text when it parses the output; merge now so node paths agree
    mergeText(parent);
  }

  /**
   * `<sn-include>` is removed: a partial is a component. Each one fails the build with what it
   * reads from the page, the props it needs as a component.
   */
  reportIncludes() {
    for (const rec of this.includes) {
      const names = [...rec.names].sort();
      const name = basename(rec.src).replace(/\.html?$/, '');
      const tag = name.includes('-') ? name : `x-${name}`;
      this.report(rec.el, 'src', 'SN316', `\`<sn-include>\` is removed: a partial is a component. Move \`${rec.src}\` to \`src/components/${tag}.html\`, wrap its markup in \`<template data-sn-component="{ … }">\` around one root element, and write \`<${tag}></${tag}>\` here${
        names.length ? `. It reads ${names.map((n) => `\`${n}\``).join(', ')} from the page: add ${names.length > 1 ? 'them' : 'it'} to \`data-sn-component\` and pass ${names.length > 1 ? 'them' : 'it'} with \`data-sn-prop="{ ${names.map((n) => `${n}: ${n}`).join(', ')} }"\`` : ''}`, 0);
    }
  }

  /** The names a partial's expression reads from the scope its `<sn-include>` is in. */
  outerNames(src: string, scope: Scope, o: Omit<ExprOptions, 'report'>, rec: IncludeRec) {
    if (!rec.site) return;
    const free: string[] = [];
    analyze(src, { loops: [], states: [] }, this.page, { ...o, report: (code, message) => { const m = code === 'SN201' && /^`([^`]+)` is not defined/.exec(message); if (m) free.push(m[1]!); } });
    for (const n of free) {
      const entry = (scope.lets ?? []).findLast((l) => l.name === n) ?? scope.loops.findLast((l) => l.name === n) ?? scope.states.findLast((x) => x.names.has(n));
      if (entry && rec.site.has(entry)) rec.names.add(n);
    }
  }

  // ---- components

  /** The component file for a tag (null: a plain custom element, or not a valid component name). */
  componentFile(tag: string): ComponentFile | null {
    if (!COMPONENT_NAME.test(tag) || tag.startsWith('sn-')) return null;
    let c = this.componentFiles.get(tag);
    if (c !== undefined) return c;
    const dir = this.opts.components ?? `${normalize(this.opts.root).replace(/\/$/, '')}/src/components`;
    const file = normalize(`${dir}/${tag}.html`);
    try { c = { file, text: this.opts.readFile(file) }; } catch { c = null; }
    if (c && /<template\b[^>]*\sdata-sn-head\b/i.test(c.text)) c.head = true;
    if (c) {
      // a script beside it: the component runs it per instance
      const root = normalize(this.opts.root).replace(/\/$/, '');
      for (const ext of ['.ts', '.js', '.mts', '.mjs']) {
        const f = file.replace(/\.html$/, ext);
        let text: string;
        try { text = this.opts.readFile(f); } catch { continue; }
        c.script = f.startsWith(root + '/') ? f.slice(root.length) : f;
        // the class: imported by its name, so the runtime looks nothing up
        const pascal = pascalName(tag);
        c.exported = new RegExp(`export\\s+(?:abstract\\s+)?class\\s+${pascal}\\b|export\\s*\\{[^}]*\\b${pascal}\\b[^}]*\\}`).test(text) ? pascal
          : /export\s+default\b|export\s*\{[^}]*\bas\s+default\b/.test(text) ? 'default' : null;
        break;
      }
    }
    this.componentFiles.set(tag, c);
    return c;
  }

  // ---- layouts

  /** where the app's layouts are */
  layoutDir(): string {
    return normalize(this.opts.layouts ?? `${normalize(this.opts.root).replace(/\/$/, '')}/src/layouts`).replace(/\/$/, '');
  }

  isLayoutFile(file: string): boolean {
    return normalize(file).startsWith(this.layoutDir() + '/');
  }

  /** The layout file for a tag (null: no such layout). */
  layoutFile(tag: string): { file: string; text: string } | null {
    if (!COMPONENT_NAME.test(tag) || tag.startsWith('sn-')) return null;
    let l = this.layoutFiles.get(tag);
    if (l !== undefined) return l;
    const file = normalize(`${this.layoutDir()}/${tag}.html`);
    try { l = { file, text: this.opts.readFile(file) }; } catch { l = null; }
    this.layoutFiles.set(tag, l);
    return l;
  }

  /**
   * A page that is a layout's tag: the layout's document, its slots filled with the tag's content, the
   * tag's attributes on its `<html>`. From here on it is the page. Null when the page uses no layout.
   */
  mergeLayout(doc: DefaultTreeAdapterMap['document']): DefaultTreeAdapterMap['document'] | null {
    const html = doc.childNodes.find((c): c is P5Element => isElement(c) && c.tagName === 'html');
    const head = html?.childNodes.find((c): c is P5Element => isElement(c) && c.tagName === 'head');
    const body = html?.childNodes.find((c): c is P5Element => isElement(c) && c.tagName === 'body');
    if (!html || !head || !body) return null;
    const real = (c: P5Node) => isElement(c) || (c.nodeName === '#text' && (c as DefaultTreeAdapterMap['textNode']).value.trim() !== '');
    const top = body.childNodes.filter(real);
    const host = top.find((c): c is P5Element => isElement(c) && !this.componentFile(c.tagName) && !!this.layoutFile(c.tagName));
    if (!host) return null;
    const name = host.tagName;
    const lf = this.layoutFile(name)!;
    const pageOrigin = this.origins.get(host)!;
    // the page is the tag, and nothing else
    for (const c of [...head.childNodes.filter(real), ...top.filter((c) => c !== host)]) {
      const el = isElement(c) ? c : host;
      this.report(el, null, 'SN319', `a page that uses the layout \`<${name}>\` is only its tag: ${isElement(c) ? `\`<${c.tagName}>\`` : 'this text'} belongs inside it`, 0,
        `put it in one of the layout's slots: \`<${name}>…</${name}>\` (a head element with \`slot="…"\` for a head slot)`);
    }
    if (html.sourceCodeLocation?.startTag && html.attrs.length) {
      this.report(html, html.attrs[0]!.name, 'SN319', `a page that uses the layout \`<${name}>\` writes the attributes of \`<html>\` on its tag: \`<${name} ${html.attrs[0]!.name}="…">\``, 0);
    }
    const lroot = normalize(this.opts.root).replace(/\/$/, '');
    for (const ext of ['.ts', '.js', '.mts', '.mjs']) {
      const f = lf.file.replace(/\.html$/, ext);
      try { this.opts.readFile(f); } catch { continue; }
      this.diagnostics.push({ severity: 'error', code: 'SN318', message: `the layout \`<${name}>\` has a script (\`${f.startsWith(lroot + '/') ? f.slice(lroot.length + 1) : f}\`); layouts have none, its components may`, file: lf.file, line: 1, col: 1 });
    }
    const ldoc = parseDocument(lf.text);
    const at = host.sourceCodeLocation ? this.lineCol(pageOrigin.src, host.sourceCodeLocation.startOffset) : { line: 1, col: 1 };
    this.tag(ldoc, { file: lf.file, src: lf.text, chain: [`${basename(this.opts.file)}:${at.line}`] });
    this.files.add(lf.file);
    // comments around the layout's `<html>` document the layout file, not the page
    ldoc.childNodes = ldoc.childNodes.filter((c) => c.nodeName !== '#comment');
    const lhtml = ldoc.childNodes.find((c): c is P5Element => isElement(c) && c.tagName === 'html')!;
    const lhead = lhtml.childNodes.find((c): c is P5Element => isElement(c) && c.tagName === 'head')!;
    const decl = attr(lhtml, 'data-sn-layout');
    if (decl === undefined || !lhtml.sourceCodeLocation?.startTag) {
      this.diagnostics.push({ severity: 'error', code: 'SN318', message: `\`src/layouts/${name}.html\` is not a layout: a layout is a whole document whose \`<html>\` declares its props, \`<html data-sn-layout="{ …props }">\``, file: lf.file, line: 1, col: 1, hint: '`<!doctype html><html lang="en" data-sn-layout="{ title?: string }"><head>…</head><body><slot></slot></body></html>`' });
      detach(host);
      return null;
    }
    const props = typeMembers(decl.trim() === '' ? '{}' : decl);
    for (const a of lhtml.attrs) if (a.name === 'data-sn-emits') this.report(lhtml, a.name, 'SN318', 'a layout emits no events: nothing is above it to receive them', 0);
    // the layout's own relative URLs are relative to its file
    this.rebaseUrls(ldoc, lf.file);
    // its slots: a default slot is in the body
    const headSlots = new Set<string>();
    const inHead = (n: P5Parent) => {
      for (const c of [...n.childNodes]) {
        if (!isElement(c)) continue;
        if (c.tagName === 'slot') {
          const k = attr(c, 'name');
          if (!k) { this.report(c, null, 'SN318', 'the default slot of a layout is in its body: content without `slot="…"` is the page\'s body', 0, 'name the head slot: `<slot name="head"></slot>`'); detach(c); continue; }
          headSlots.add(k);
        }
        inHead(c);
        if (c.tagName === 'template') inHead((c as P5Template).content);
      }
    };
    inHead(lhead);
    const use: Use = { name, file: lf.file, host, root: lhtml, template: lhtml, props, propsText: decl, emits: [], emitsText: null, chain: [], layout: true };
    // a head element given to a body slot: the browser would keep it, but it belongs in a head slot
    for (const c of [...host.childNodes]) {
      if (!isElement(c) || !['title', 'meta', 'link', 'base'].includes(c.tagName) || headSlots.has(attr(c, 'slot') ?? '')) continue;
      const k = attr(c, 'slot');
      this.report(c, k === undefined ? null : 'slot', 'SN320', `\`<${c.tagName}>\` is a head element: ${k === undefined ? 'content without `slot` goes into the layout\'s body' : `\`${k}\` is not a head slot of \`<${name}>\``}`, 0,
        headSlots.size ? `give it a head slot: ${[...headSlots].map((x) => `\`slot="${x}"\``).join(', ')}` : `add a head slot to the layout: \`<slot name="head"></slot>\` in its \`<head>\``);
      detach(c);
    }
    this.fillSlots(use, ldoc);
    // the tag's attributes: plain ones replace the layout's on `<html>` (its defaults), `class` is joined
    for (const a of host.attrs) {
      if (a.name === 'data-sn-prop' || a.name === 'data-sn-state') continue;
      if (a.name === 'data-sn-path' || a.name === 'data-sn-prefetch') { setAttr(lhtml, a.name, a.value); continue; }
      if (a.name === 'data-sn-early') { this.report(host, a.name, 'SN319', '`data-sn-early` cannot be on a layout\'s tag: the layout is the whole page', 0, 'leave parts out of the early script on their own tags: `<tag-cloud data-sn-early="off">`'); continue; }
      if (a.name.startsWith('data-sn-')) {
        if (!callerAttribute(a.name) || a.name === 'data-sn-model' || a.name === 'data-sn-persist') this.report(host, a.name, 'SN102', `\`${a.name}\` cannot be on a layout's tag`, 0, 'a layout\'s tag takes `data-sn-prop`, `data-sn-state`, handlers, `data-sn-class`, `-attr` and `-style`, `data-sn-path` and `data-sn-prefetch`, and the attributes of `<html>`');
        continue;
      }
      if (a.name === 'class') { const own = attr(lhtml, 'class'); setAttr(lhtml, 'class', own ? `${own} ${a.value}` : a.value); }
      else setAttr(lhtml, a.name, a.value);
    }
    // the tag's handlers are the page's `<body>` handlers: on the layout's `<body>`, ahead of its own
    const lbody = lhtml.childNodes.find((c): c is P5Element => isElement(c) && c.tagName === 'body');
    const handler = (n: string) => n.startsWith('data-sn-on-') || n.startsWith('data-sn-debounce-');
    if (lbody && host.attrs.some((a) => handler(a.name))) {
      const h: P5Element = { ...host, attrs: host.attrs.filter((a) => handler(a.name)) };
      this.origins.set(h, pageOrigin);
      host.attrs = host.attrs.filter((a) => !handler(a.name));
      use.bodyHandlers = h;
      this.layoutBody.set(lbody, use);
    }
    if (attr(host, 'data-sn-state') !== undefined && attr(lhtml, 'data-sn-state') !== undefined) {
      this.report(host, 'data-sn-state', 'SN209', `\`data-sn-state\` is set both here and on the \`<html>\` of \`<${name}>\`; the page's state and the layout's would be one`, 0, 'keep the layout\'s state on an element inside it, such as its `<body>`');
    }
    this.useOf.set(lhtml, use);
    this.hostUse.set(host, use);
    this.head = lhead;
    return ldoc;
  }

  /** A layout's relative URLs (`./main.ts`, `styles/site.css`) are relative to its file: rewritten to root-relative ones. */
  rebaseUrls(doc: P5Parent, file: string) {
    const root = normalize(this.opts.root).replace(/\/$/, '');
    const dir = dirname(file);
    const ATTRS_OF: Record<string, string[]> = { link: ['href'], script: ['src'], img: ['src', 'srcset'], source: ['src', 'srcset'], video: ['src', 'poster'], audio: ['src'], track: ['src'], input: ['src'] };
    const relative = (u: string) => u.trim() !== '' && !/^([a-z][a-z0-9+.-]*:|\/|#|\?|\{)/i.test(u.trim());
    const rebase = (u: string) => {
      const abs = resolvePath(dir, u.trim());
      return abs.startsWith(root + '/') ? abs.slice(root.length) : u;
    };
    const walk = (n: P5Parent) => {
      for (const c of n.childNodes) {
        if (!isElement(c)) continue;
        for (const a of ATTRS_OF[c.tagName] ?? []) {
          const v = attr(c, a);
          if (v === undefined) continue;
          if (a === 'srcset') setAttr(c, a, v.split(',').map((part) => { const [u, ...d] = part.trim().split(/\s+/); return u && relative(u) ? [rebase(u), ...d].join(' ') : part.trim(); }).join(', '));
          else if (relative(v)) setAttr(c, a, rebase(v));
        }
        walk(c);
        if (c.tagName === 'template') walk((c as P5Template).content);
      }
    };
    walk(doc);
  }

  /**
   * Expands every component tag, at any depth, into the component's markup: the root element
   * takes the tag's place, the caller's content fills the slots. `chain`: the components this
   * markup is in, `#` marking a `data-sn-for` or `data-sn-if` template between.
   */
  expandComponents(parent: P5Parent, chain: string[], inHead = false) {
    for (const child of [...parent.childNodes]) {
      if (!isElement(child)) continue;
      // slot content is the caller's: it is inside the components its caller is in
      const ch = this.slotOf.get(child)?.chain ?? chain;
      if (child.tagName === 'sn-component') { this.choice(child); continue; }
      const def = this.componentFile(child.tagName);
      if (!def && this.layoutFile(child.tagName)) {
        this.report(child, null, 'SN319', `\`<${child.tagName}>\` is a layout: it is the only tag of a page, at its top level`, 0, 'a layout cannot be inside a component, another layout or other markup');
        detach(child);
        continue;
      }
      if (def && this.layoutFile(child.tagName)) {
        this.report(child, null, 'SN318', `\`<${child.tagName}>\` is both a layout (\`src/layouts/${child.tagName}.html\`) and a component (\`src/components/${child.tagName}.html\`); rename one`, 0);
        detach(child);
        continue;
      }
      if (def) {
        const name = child.tagName;
        // a head component goes in a head, a component in a body
        if (!!def.head !== inHead) {
          this.report(child, null, 'SN320', def.head
            ? `\`<${name}>\` is a head component (\`data-sn-head\`): it goes in a \`<head>\`, or in a layout's head slot`
            : `\`<${name}>\` is a component with one root element, which cannot be in the \`<head>\``, 0,
          def.head ? 'a component for the body is declared with `<template data-sn-component>` and has one root element' : 'for head elements, declare the component with `<template data-sn-head>`');
          detach(child);
          continue;
        }
        if (def.head && ch.includes(name)) {
          this.report(child, null, 'SN306', `the head component \`<${name}>\` uses itself`, 0);
          detach(child);
          continue;
        }
        const at = ch.lastIndexOf(name);
        if (at >= 0) {
          const loop = [...ch.slice(at).filter((x) => x !== '#'), name];
          if (ch.slice(at).includes('#')) {
            // data ends it: the use is an instance of the component's shared definition
            if (child.childNodes.some((c) => isElement(c) || (c.nodeName === '#text' && (c as DefaultTreeAdapterMap['textNode']).value.trim() !== ''))) {
              this.report(child, null, 'SN314', `\`<${name}>\` used inside itself takes no slot content`, 0);
            }
            this.points.set(child, name);
            continue;
          }
          this.report(child, null, 'SN306', `${loop.map((n) => `\`<${n}>\``).join(' → ')} uses itself with no \`data-sn-for\` or \`data-sn-if\` template between, so it would never end`, 0,
            'only data ends a recursion: put the inner use in a `<template data-sn-for>` over the children, or a `<template data-sn-if>`');
          detach(child);
          continue;
        }
        if (def.bad) { detach(child); continue; }
        if (def.head) { this.expandUse(child, def, ch); continue; }
        const root = this.expandUse(child, def, ch);
        if (root) this.expandComponents(root, [...ch, name]);
        continue;
      }
      const head = inHead || child.tagName === 'head';
      this.expandComponents(child, ch, head);
      if (child.tagName === 'template') {
        const t = attr(child, 'data-sn-for') !== undefined || attr(child, 'data-sn-if') !== undefined || attr(child, 'data-sn-else') !== undefined;
        this.expandComponents((child as P5Template).content, t ? [...ch, '#'] : ch, head);
      }
    }
  }

  /**
   * `<sn-component use="…" data-sn-prop="…">`: a component chosen by data at runtime. `use` names it in
   * one of three forms, each of which gives the candidates:
   * - convention, ``use="`${b.type}-block`"``: the components whose names have that prefix and suffix
   *   (sinter check: the template-literal type of the data's union, which must fit `ComponentName`);
   * - map, `use="{ hero: 'hero-block', text: 'rich-text' }[b.type]"`: its values;
   * - helper, `use="blockComponent(b)"`: every component (sinter check: its return type).
   * It becomes one point per candidate (a shared definition each), of which only the one `use` names
   * renders; a `data-sn-else` template after it renders for a value outside the candidates.
   */
  choice(el: P5Element) {
    const use = attr(el, 'use');
    const elseAfter = () => el.parentNode?.childNodes.slice(el.parentNode.childNodes.indexOf(el as never) + 1).find((c) => isElement(c) || (c.nodeName === '#text' && (c as DefaultTreeAdapterMap['textNode']).value.trim() !== ''));
    const fail = (message: string, hint?: string) => {
      this.report(el, use === undefined ? null : 'use', 'SN312', message, 0, hint);
      // its else template goes with it: nothing to pair it with
      const e = elseAfter();
      if (e && isElement(e) && e.tagName === 'template' && attr(e, 'data-sn-else') !== undefined) detach(e);
      detach(el);
    };
    for (const a of el.attrs) {
      if (a.name !== 'use' && a.name !== 'data-sn-prop' && a.name !== 'data-sn-early') this.report(el, a.name, 'SN101', `\`${a.name}\` is not an attribute of \`<sn-component>\`; it takes \`use\`, \`data-sn-prop\` and \`data-sn-early\``, 0);
    }
    let ast: ReturnType<typeof parseExpressionAt> | null = null;
    try { ast = use ? parseExpressionAt(use, 0, { ecmaVersion: 'latest' }) : null; } catch { ast = null; }
    if (!ast || ast.end !== use!.trimEnd().length) {
      return fail('`<sn-component>` takes `use`, an expression naming the component: ``use="`${b.type}-block`"``, `use="{ hero: \'hero-block\' }[b.type]"` or `use="blockComponent(b)"`');
    }
    const all = [...new Set([...(this.opts.componentNames ?? []), ...this.componentFiles.keys()])].filter((n) => this.componentFile(n) && !this.componentFile(n)!.head).sort();
    // each candidate, and the value of the data that names it (convention, map), for narrowing
    let cands: Array<{ name: string; key: string | null }>;
    let keySrc: string | null = null, map = false;
    if (ast.type === 'TemplateLiteral' && ast.expressions.length === 1) {
      const pre = ast.quasis[0]!.value.cooked ?? '', post = ast.quasis[1]!.value.cooked ?? '';
      const e = ast.expressions[0]!;
      keySrc = use!.slice(e.start, e.end);
      cands = all.filter((n) => n.startsWith(pre) && n.endsWith(post) && n.length > pre.length + post.length).map((n) => ({ name: n, key: n.slice(pre.length, n.length - post.length) }));
    } else if (ast.type === 'MemberExpression' && ast.computed && ast.object.type === 'ObjectExpression') {
      keySrc = use!.slice(ast.property.start, ast.property.end);
      map = true;
      cands = [];
      for (const p of ast.object.properties) {
        const k = p.type === 'Property' && !p.computed ? (p.key.type === 'Identifier' ? p.key.name : p.key.type === 'Literal' ? String(p.key.value) : null) : null;
        const v = p.type === 'Property' && p.value.type === 'Literal' && typeof p.value.value === 'string' ? p.value.value : null;
        if (k === null || v === null) return fail('the map in `use` has literal keys and component names as string values: `{ hero: \'hero-block\' }[b.type]`');
        if (!this.componentFile(v)) { this.report(el, 'use', 'SN312', `\`'${v}'\` is not a component; create \`src/components/${v}.html\``, (p as import('acorn').Property).value.start); continue; }
        if (this.componentFile(v)!.head) { this.report(el, 'use', 'SN312', `\`'${v}'\` is a head component; \`<sn-component>\` chooses components for the body`, (p as import('acorn').Property).value.start); continue; }
        cands.push({ name: v, key: k });
      }
    } else if (ast.type === 'CallExpression') {
      cands = all.map((n) => ({ name: n, key: null }));
    } else if (ast.type === 'BinaryExpression' && ast.operator === '+') {
      return fail('`use` built with `+` is a `string` to TypeScript, so its candidates are unknown: write a template string, ``use="`${b.type}-block`"``');
    } else {
      return fail('`use` names the component by a template string (``use="`${b.type}-block`"``), a map (`use="{ hero: \'hero-block\' }[b.type]"`) or a helper (`use="blockComponent(b)"`)');
    }
    const names = cands.map((c) => c.name);
    const parent = el.parentNode!;
    const at = parent.childNodes.indexOf(el as never);
    const clones: P5Element[] = [];
    for (const c of cands) {
      const x: P5Element = { ...el, attrs: el.attrs.map((a) => ({ ...a })), childNodes: [], parentNode: parent };
      this.origins.set(x, this.origins.get(el)!);
      this.points.set(x, c.name);
      this.choices.set(x, { name: c.name, key: c.key, keySrc, names, first: !clones.length, ...(map ? { keys: cands.map((y) => y.key!) } : {}) });
      clones.push(x);
    }
    if (!clones.length) this.report(el, 'use', 'SN312', '`use` names no component of the app', 0);
    parent.childNodes.splice(at, 1, ...(clones as never[]));
    // a value outside the candidates: the `data-sn-else` template after it
    const next = parent.childNodes.slice(at + clones.length).find((c) => isElement(c) || (c.nodeName === '#text' && (c as DefaultTreeAdapterMap['textNode']).value.trim() !== ''));
    if (next && isElement(next) && next.tagName === 'template' && attr(next, 'data-sn-else') !== undefined) {
      next.attrs = next.attrs.filter((a) => a.name !== 'data-sn-else');
      next.attrs.push({ name: 'data-sn-if', value: `!${JSON.stringify(names)}.includes(${use})` });
      for (const c of clones) this.choices.get(c)!.hasElse = true;
    }
  }

  /** Replaces one component tag by the component's root; null when the component file is invalid. */
  expandUse(host: P5Element, def: ComponentFile, chain: string[]): P5Element | null {
    const name = host.tagName;
    const hostOrigin = this.origins.get(host) ?? { file: this.opts.file, src: '', chain: [] };
    const frag = parse5.parseFragment(def.text, { sourceCodeLocationInfo: true });
    const loc = host.sourceCodeLocation ? this.lineCol(hostOrigin.src, host.sourceCodeLocation.startOffset) : { line: 1, col: 1 };
    this.tag(frag, { file: def.file, src: def.text, chain: [`${basename(hostOrigin.file)}:${loc.line}`, ...hostOrigin.chain] });
    this.files.add(def.file);
    const fail = (el: P5Element | null, a: string | null, message: string, hint?: string): null => {
      if (el) this.report(el, a, 'SN312', message, 0, hint);
      else this.diagnostics.push({ severity: 'error', code: 'SN312', message, file: def.file, line: 1, col: 1, ...(hint ? { hint } : {}) });
      def.bad = true;
      detach(host);
      return null;
    };
    const top = frag.childNodes.filter(isElement);
    const templates = top.filter((t) => t.tagName === 'template' && (attr(t, 'data-sn-component') !== undefined || attr(t, 'data-sn-head') !== undefined));
    if (templates.length !== 1) {
      return fail(templates[1] ?? null, null, `component \`<${name}>\` needs ${templates.length ? 'exactly ' : ''}one \`<template data-sn-component="{ …props }">\` (or \`<template data-sn-head>\` for head elements) around its markup`,
        '`<template data-sn-component="{ article: Article }"><article>…</article></template>`');
    }
    const template = templates[0]!;
    if (attr(template, 'data-sn-component') !== undefined && attr(template, 'data-sn-head') !== undefined) {
      return fail(template, 'data-sn-head', `\`<${name}>\` declares both \`data-sn-component\` and \`data-sn-head\`; a component is one kind`, '`data-sn-component` for one root element in a body, `data-sn-head` for head elements');
    }
    const decl = def.head ? 'data-sn-head' : 'data-sn-component';
    for (const t of top) {
      if (t !== template && t.tagName !== 'style') return fail(t, null, `a component file holds its \`<template ${decl}>\` and \`<style>\`; \`<${t.tagName}>\` belongs inside the template`);
    }
    if (def.head && def.css === undefined && top.some((t) => t.tagName === 'style')) {
      def.css = null;
      this.report(top.find((t) => t.tagName === 'style')!, null, 'SN320', `the head component \`<${name}>\` has a \`<style>\` beside its template: head elements render nothing to style`, 0, 'put the CSS in a stylesheet');
    }
    if (def.head && def.script) return fail(template, null, `the head component \`<${name}>\` has a script (\`${def.script}\`); head components have none`);
    // its `<style>`, scoped to the component (read once per file)
    if (def.css === undefined) {
      const css = top.filter((t) => t.tagName === 'style').map((t) => t.childNodes.map((c) => (c as DefaultTreeAdapterMap['textNode']).value ?? '').join('')).join('\n');
      try { def.css = css.trim() ? scopeCss(css, name) : null; } catch (e) {
        def.css = null;
        this.report(top.find((t) => t.tagName === 'style')!, null, 'SN401', `the component's \`<style>\` does not parse: ${(e as Error).message}`, 0);
      }
    }
    for (const a of template.attrs) {
      if (a.name === 'data-sn-early') this.report(template, a.name, 'SN102', '`data-sn-early` goes on a use of the component, its tag: `<' + name + ' data-sn-early="off">`', 0);
      else if (a.name !== decl && a.name !== 'data-sn-emits') this.report(template, a.name, 'SN101', `\`${a.name}\` is not an attribute of \`<template ${decl}>\`; it takes \`${decl}\` and \`data-sn-emits\``, 0);
    }
    if (def.head) return this.expandHead(host, def, template, chain);
    const content = (template as P5Template).content.childNodes;
    const text = content.find((c) => c.nodeName === '#text' && (c as DefaultTreeAdapterMap['textNode']).value.trim() !== '');
    const els = content.filter(isElement);
    if (els.length !== 1 || text) {
      const head = !text && els.length > 1 && els.every((e) => HEAD_ELEMENTS.has(e.tagName) || e.tagName === 'slot');
      return fail(els[1] ?? template, null, `a component has one root element; \`<${name}>\` has ${text ? 'text and ' : ''}${els.length} element${els.length === 1 ? '' : 's'} at the top of its template`,
        head ? 'head elements: declare it with `<template data-sn-head="{ …props }">`, which holds any number of them' : 'wrap the markup in one element: it is what the caller\'s classes, attributes and handlers land on');
    }
    const root = els[0]!;
    if (root.tagName === 'template' || root.tagName === 'slot' || this.componentFile(root.tagName)) {
      return fail(root, null, `a component's root is a plain element: \`<${root.tagName}>\` cannot be the root of \`<${name}>\``, 'wrap it in an element');
    }
    // a script reads and writes the root's own state: there is one
    if (def.script && attr(root, 'data-sn-state') === undefined) root.attrs.push({ name: 'data-sn-state', value: '{}' });
    const propsText = attr(template, 'data-sn-component')!;
    const props = typeMembers(propsText.trim() === '' ? '{}' : propsText);
    const emitsText = attr(template, 'data-sn-emits') ?? null;
    const emits = emitsText === null ? [] : typeMembers(emitsText);
    if (emitsText !== null && !emits) this.report(template, 'data-sn-emits', 'SN401', '`data-sn-emits` takes a type literal of the events and their detail types: `{ select: Article; close: null }`', 0);
    const use: Use = { name, file: def.file, host, root, template, props, propsText, emits, emitsText, chain, ...(this.lateTag(host) ? { late: true } : {}) };

    // the table rule: a tag the parser moved out of its table
    const next = host.parentNode?.childNodes.slice(host.parentNode.childNodes.indexOf(host as never) + 1).find(isElement);
    if (next?.tagName === 'table' && next.sourceCodeLocation && host.sourceCodeLocation && next.sourceCodeLocation.startOffset < host.sourceCodeLocation.startOffset) {
      this.report(host, null, 'SN102', `\`<${name}>\` is written in a table, where the HTML parser moves it out before the table`, 0,
        `write it in the row's template, where it stays in place: \`<template data-sn-for="…"><${name} …></${name}></template>\``);
    }

    this.fillSlots(use, root);

    // the tag's attributes: plain ones move onto the root, sinter's are compiled on it in the caller's scope
    for (const a of host.attrs) {
      if (a.name.startsWith('data-sn-')) {
        if (!callerAttribute(a.name)) this.report(host, a.name, 'SN102', `\`${a.name}\` cannot be on a component's tag`, 0, TAG_ONLY_HINT);
        continue;
      }
      if (a.name === 'class') {
        const own = attr(root, 'class');
        if (own === undefined) root.attrs.push({ name: 'class', value: a.value });
        else setAttr(root, 'class', `${own} ${a.value}`.trim());
      } else if (attr(root, a.name) !== undefined) {
        this.report(host, a.name, 'SN209', `\`${a.name}\` is set both here and on the root of \`<${name}>\`; one of them would be lost`, 0);
      } else root.attrs.push({ name: a.name, value: a.value });
    }

    const parent = host.parentNode!;
    const i = parent.childNodes.indexOf(host as never);
    parent.childNodes[i] = root as never;
    root.parentNode = parent;
    host.parentNode = null;
    const slotUse = this.slotOf.get(host);
    if (slotUse) this.slotOf.set(root, slotUse);
    this.useOf.set(root, use);
    this.hostUse.set(host, use);
    if (!this.uses.has(name)) this.uses.set(name, []);
    this.uses.get(name)!.push(use);
    return root;
  }

  /**
   * SN320: after expansion, the head holds head elements only (and sinter's own, which the build
   * removes). The browser would move anything else, and what follows it, into the body.
   */
  checkHead() {
    const head = this.head;
    if (!head) return;
    const walk = (n: P5Parent, owner: P5Element) => {
      for (const c of [...n.childNodes]) {
        if (c.nodeName === '#text') {
          const t = (c as DefaultTreeAdapterMap['textNode']).value.trim();
          if (t) this.report(owner, null, 'SN320', `text cannot be in the \`<head>\`: \`${t.slice(0, 40)}\``, 0, 'move it into the body');
          continue;
        }
        if (!isElement(c)) continue;
        // a resource or a stream: page-wide wherever it is written, so it goes in the body (it stays declared, for the rest of the page)
        if (c.tagName === 'sn-resource' || c.tagName === 'sn-sync') {
          this.report(c, null, 'SN320', `\`<${c.tagName}>\` goes in the body, not the \`<head>\``, 0,
            `${c.tagName === 'sn-resource' ? 'a resource is page-wide: the head reads it from the body too' : 'a stream is page-wide: put it in the body'}, and its requests still start in the head`);
          continue;
        }
        if (!HEAD_ELEMENTS.has(c.tagName)) {
          this.report(c, null, 'SN320', `\`<${c.tagName}>\` cannot be in the \`<head>\`: the browser would move it, and everything after it, into the body`, 0,
            'only head elements go in the head: `<title>`, `<meta>`, `<link>`, `<script>`, `<style>`, `<noscript>`, `<base>`, `<template>` and head components');
          detach(c);
          continue;
        }
        if (c.tagName === 'template') walk((c as P5Template).content, c);
      }
    };
    walk(head, head);
    // SN321: what a page has once, also inside templates; the branches of one if/else are one
    type Once = { id: string; label: string; el: P5Element };
    const real = (n: P5Node) => isElement(n) || (n.nodeName === '#text' && (n as DefaultTreeAdapterMap['textNode']).value.trim() !== '');
    const unique = (list: Once[]): Once[] => {
      const seen = new Set<string>(), out: Once[] = [];
      for (const x of list) {
        if (seen.has(x.id)) {
          this.report(x.el, null, 'SN321', `a second ${x.label} in the head: the page would have two`, 0,
            'keep one: pass the value to the one that is there (a prop of the layout or head component), or put this one in place of a slot\'s fallback');
          continue;
        }
        seen.add(x.id);
        out.push(x);
      }
      return out;
    };
    const collect = (nodes: P5Node[]): Once[] => {
      const out: Once[] = [];
      for (let i = 0; i < nodes.length; i++) {
        const c = nodes[i]!;
        if (!isElement(c)) continue;
        if (c.tagName === 'template') {
          const inner = (t: P5Element) => collect((t as P5Template).content.childNodes);
          if (attr(c, 'data-sn-for') !== undefined) {
            for (const x of inner(c)) this.report(x.el, null, 'SN321', `${x.label} in a \`data-sn-for\` template: the head would have one per row`, 0, 'move it out of the loop');
          } else if (attr(c, 'data-sn-if') !== undefined) {
            let j = i + 1;
            while (j < nodes.length && !real(nodes[j]!)) j++;
            const next = nodes[j];
            const other = next && isElement(next) && next.tagName === 'template' && attr(next, 'data-sn-else') !== undefined ? next : null;
            const a = unique(inner(c)), b = other ? unique(inner(other)) : [];
            if (other) i = j;
            // one of the two branches renders: an element in both is one
            out.push(...a, ...b.filter((x) => !a.some((y) => y.id === x.id)));
          }
          continue;
        }
        const key = onceKey(c);
        if (key) out.push({ ...key, el: c });
      }
      return out;
    };
    unique(collect(head.childNodes));
  }

  /**
   * A head component's use (`<template data-sn-head>`): its elements, any number of them, take the
   * tag's place with no wrapper. Its tag takes only `data-sn-prop` and slot content.
   */
  expandHead(host: P5Element, def: ComponentFile, template: P5Element, chain: string[]): null {
    const name = host.tagName;
    const fragment = (template as P5Template).content;
    for (const c of fragment.childNodes) {
      if (c.nodeName === '#text' && (c as DefaultTreeAdapterMap['textNode']).value.trim() !== '') {
        this.report(template, null, 'SN320', `a head component holds head elements; \`<${name}>\` has text at the top of its template`, 0);
        def.bad = true; detach(host); return null;
      }
      if (!isElement(c)) continue;
      const ok = HEAD_ELEMENTS.has(c.tagName) || c.tagName === 'slot' || this.componentFile(c.tagName)?.head;
      if (!ok) {
        this.report(c, null, 'SN320', `a head component holds head elements: \`<${c.tagName}>\` cannot be in \`<${name}>\``, 0,
          'head elements are `<title>`, `<meta>`, `<link>`, `<script>`, `<style>`, `<noscript>`, `<base>`, `<template>` and head components; a component for the body is a `<template data-sn-component>` with one root');
        def.bad = true; detach(host); return null;
      }
    }
    const propsText = attr(template, 'data-sn-head')!;
    const props = typeMembers(propsText.trim() === '' ? '{}' : propsText);
    const emitsText = attr(template, 'data-sn-emits') ?? null;
    const emits = emitsText === null ? [] : typeMembers(emitsText);
    if (emitsText !== null && !emits) this.report(template, 'data-sn-emits', 'SN401', '`data-sn-emits` takes a type literal of the events and their detail types: `{ select: Article; close: null }`', 0);
    const first = fragment.childNodes.find(isElement) ?? template;
    const use: Use = { name, file: def.file, host, root: first, template, props, propsText, emits, emitsText, chain, head: { roots: [], parent: null } };
    for (const a of host.attrs) {
      if (a.name !== 'data-sn-prop' && a.name !== 'slot') this.report(host, a.name, 'SN102', `\`${a.name}\` cannot be on the tag of a head component; it takes \`data-sn-prop\` and slot content`, 0, 'a head component has no root element for other attributes to land on');
    }
    this.fillSlots(use, fragment);
    // a prop the use gives as a constant decides a `data-sn-if` on it now, before its elements join the head
    this.foldIn(fragment, constantProps(attr(host, 'data-sn-prop'), props), use);
    this.expandComponents(fragment, [...chain, name], true);
    const nodes = [...fragment.childNodes];
    for (const n of nodes) {
      if (!isElement(n) || this.slotOf.has(n)) continue;
      const inner = this.useOf.get(n);
      if (inner) { if (inner.head && !inner.head.parent) inner.head.parent = use; continue; }
      use.head!.roots.push(n);
      this.useOf.set(n, use);
    }
    // slot content of an inner head component sits among these elements too: its caller is this one
    const parent = host.parentNode!;
    const i = parent.childNodes.indexOf(host as never);
    for (const n of nodes) (n as { parentNode: P5Parent }).parentNode = parent;
    parent.childNodes.splice(i, 1, ...(nodes as never[]));
    host.parentNode = null;
    mergeText(parent);
    const slotUse = this.slotOf.get(host);
    if (slotUse) for (const n of nodes) if (!this.slotOf.has(n)) this.slotOf.set(n, slotUse);
    this.hostUse.set(host, use);
    if (!this.uses.has(name)) this.uses.set(name, []);
    this.uses.get(name)!.push(use);
    return null;
  }

  /** Fills a use's slots, in `container` (its root, or a head component's elements), with the content of its tag, by `slot` name. */
  fillSlots(use: Use, container: P5Parent) {
    const { host, name, chain } = use;
    const groups = new Map<string, P5Node[]>();
    for (const c of [...host.childNodes]) {
      const slot = isElement(c) ? attr(c, 'slot') : this.forwarded.get(c);
      const k = slot ?? '';
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k)!.push(c);
    }
    const real = (nodes: P5Node[] | undefined) => !!nodes?.some((c) => isElement(c) || (c.nodeName === '#text' && (c as DefaultTreeAdapterMap['textNode']).value.trim() !== ''));
    const slots: P5Element[] = [];
    const findSlots = (n: P5Parent) => {
      for (const c of n.childNodes) {
        if (!isElement(c)) continue;
        if (c.tagName === 'slot') slots.push(c);
        else findSlots(c);
        if (c.tagName === 'template') findSlots((c as P5Template).content);
      }
    };
    findSlots(container);
    const filled = new Set<string>();
    for (const s of slots) {
      const k = attr(s, 'name') ?? '';
      if (filled.has(k)) { this.report(s, null, 'SN312', `\`<${name}>\` has two ${k ? `slots named \`${k}\`` : 'default slots'}; slot content is placed once`, 0); detach(s); continue; }
      filled.add(k);
      const given = groups.get(k);
      const nodes = real(given) ? given! : s.childNodes;
      if (nodes === given) {
        const caller = chain.filter((x) => x !== '#').at(-1) ?? '';
        for (const c of nodes) {
          if (isElement(c)) c.attrs = c.attrs.filter((a) => a.name !== 'slot');
          // content forwarded from further out stays its first caller's: its scope and its styles
          if (this.slotOf.has(c)) continue;
          if (isElement(c)) this.slotEls.push({ el: c, caller, host: name });
          this.slotOf.set(c, use);
        }
      }
      // a slot that is itself slot content (`<slot name="seo" slot="extra">` in a component's tag): what fills it goes on into that slot
      const onward = attr(s, 'slot');
      const into = s.parentNode && isElement(s.parentNode as P5Node) ? (s.parentNode as P5Element).tagName : '';
      if (onward !== undefined && this.componentFile(into)) {
        for (const c of nodes) {
          if (isElement(c)) setAttr(c, 'slot', onward);
          else this.forwarded.set(c, onward);
        }
      }
      const parent = s.parentNode!;
      const i = parent.childNodes.indexOf(s as never);
      for (const c of nodes) (c as { parentNode: P5Parent }).parentNode = parent;
      parent.childNodes.splice(i, 1, ...(nodes as never[]));
      mergeText(parent);
    }
    const slotNames = slots.map((x) => attr(x, 'name')).filter((x): x is string => !!x);
    for (const [k, nodes] of groups) {
      if (filled.has(k) || !real(nodes)) continue;
      const el = nodes.find(isElement);
      if (k) this.report(el!, 'slot', 'SN314', `\`<${name}>\` has no slot \`${k}\`.${slotNames.length ? ` Its slots are ${slotNames.map((x) => `\`${x}\``).join(', ')}.` : ''}${didYouMean(k, slotNames)}`, 0);
      else this.report(el ?? host, null, 'SN314', `\`<${name}>\` has no default \`<slot>\`, so this content would be dropped`, 0,
        slotNames.length ? `put it in a named slot: ${slotNames.map((x) => `\`slot="${x}"\``).join(', ')}` : `add a \`<slot></slot>\` to \`<${name}>\` where the content goes`);
    }

  }

  /** `data-sn-early="off"` on a component's tag: this use renders when the page module runs, not in the early script */
  lateTag(host: P5Element): boolean {
    const v = attr(host, 'data-sn-early');
    if (v === undefined) return false;
    if (v.trim() !== 'off') { this.report(host, 'data-sn-early', 'SN401', '`data-sn-early` takes `off`: this use renders when the page module runs, not in the early script', 0); return false; }
    return true;
  }

  /**
   * `sinter({ site })`: the page's canonical URL. A `<link rel="canonical">` the page writes (in the head
   * after its layout and head components) is `$canonical`, and must be absolute (SN323); without one, a page
   * whose URL is known gets one with `$canonical`, last in its head.
   */
  canonical(doc: DefaultTreeAdapterMap['document']) {
    const u = this.opts.urls!;
    const head = findHead(doc);
    const own = head?.childNodes.find((n): n is P5Element => isElement(n) && n.tagName === 'link' && (attr(n, 'rel') ?? '').toLowerCase().split(/\s+/).includes('canonical'));
    this.page.urls = { ...u };
    if (own) {
      const href = attr(own, 'href') ?? '';
      if (/^https?:\/\//i.test(href)) this.page.urls.canonical = href;
      else this.report(own, 'href', 'SN323', `a canonical link is an absolute URL, and \`${href}\` is not: \`$canonical\` is what it names`, 0, `write \`${u.canonical ?? u.site + '/…'}\`, or leave the link out and the build writes it`);
      return;
    }
    if (!head) return;
    const esc = (v: string) => v.replace(/[&"<>]/g, (c) => `&#${c.charCodeAt(0)};`);
    // a page whose path is a pattern: one file for every URL, so the early script writes it from the address
    if (u.canonical === null && this.opts.canonicalLink === false) return;
    const link = parse5.parseFragment(u.canonical === null ? '<link rel="canonical" data-sn-attr="{ href: $canonical }">' : `<link rel="canonical" href="${esc(u.canonical)}">`).childNodes[0] as P5Element;
    if (u.canonical === null) this.canonicalLink = link;
    link.parentNode = head;
    head.childNodes.push(link as never);
  }

  /** A literal `id` in the markup of a component used more than once would be on the page more than once. */
  componentIds() {
    for (const [name, list] of this.uses) {
      if (list.length < 2 || list[0]!.head) continue;
      const u = list[0]!;
      const find = (n: P5Parent): P5Element | null => {
        for (const c of n.childNodes) {
          if (!isElement(c) || this.slotOf.get(c)) continue;
          if (attr(c, 'id') !== undefined && this.origins.get(c)?.file === u.file) return c;
          const x = find(c) ?? (c.tagName === 'template' ? find((c as P5Template).content) : null);
          if (x) return x;
        }
        return null;
      };
      const el = attr(u.root, 'id') !== undefined && this.origins.get(u.root)?.file === u.file ? u.root : find(u.root);
      if (el) this.report(el, 'id', 'SN209', `\`<${name}>\` is used ${list.length} times on this page, and its markup has \`id="${attr(el, 'id')}"\`: the page would have that id ${list.length} times`, 0,
        'compute the id from a prop: `data-sn-attr="{ id: \'edit-\' + item.id }"`, or use the component once');
    }
  }

  /**
   * The scope of a component's markup: its props, each the caller's expression (inlined where it
   * is read, as `data-sn-let`), and nothing else of the caller's.
   */
  componentScope(use: Use, caller: Scope): Scope {
    use.caller = caller;
    const name = use.name;
    const declared = use.props?.map((m) => m.name) ?? null;
    // the shared definition of a component used inside itself: its props are the row's item, given at each use
    const def = this.defHosts.get(use.host);
    const { lets, passed } = def
      ? { lets: (use.props ?? []).map((m): LetEntry => ({ name: m.name, code: `$.${def.rt}.${m.name}`, deps: [], usesEl: false, usesIndex: false, resource: null, prop: true, src: [`@def:${name}:${m.name}`] })), passed: new Set(declared) }
      : this.propLets(use, caller);
    if (!def && !use.head) this.foldConstants(use, lets);
    const outer = new Set<string>([...(caller.lets ?? []).map((l) => l.name), ...caller.loops.map((l) => l.name), ...caller.states.flatMap((x) => [...x.names])]);
    // no `data-sn-emits`: no events; one the compiler cannot list (an alias): not checked here
    const around = caller.component?.runtime;
    const runtime: Set<string> | 'all' = def || around === 'all' ? 'all' : new Set([...(around ?? []), ...caller.loops.map((l) => l.rt ?? l.name)]);
    const cs: ComponentScope = { name, outer, runtime, id: this.useIds, ...(use.late || caller.component?.late ? { late: true } : {}), ...(use.emitsText === null ? { emits: null } : use.emits ? { emits: use.emits.map((m) => m.name) } : {}) };
    use.scope = cs;
    this.useById.set(this.useIds++, use);
    if (this.check) {
      this.frameOf.set(cs, this.check.frames.length);
      this.check.frames.push({ kind: 'props', component: name, type: { kind: 'ts', text: use.propsText.trim() || '{}', loc: this.locOf(use.template, use.layout ? 'data-sn-layout' : use.head ? 'data-sn-head' : 'data-sn-component') }, names: declared ?? [...passed] });
    }
    return { loops: [], states: [], lets, component: cs };
  }

  /**
   * What a head component's markup sees, computed once for all its elements. `base`: the scope where
   * its elements are. Its caller is the page there, or the head component whose markup has the tag,
   * or, for slot content, the caller of the component it was passed into.
   */
  headMarkup(use: Use, base: Scope): Scope {
    return use.markup ??= this.componentScope(use, this.headCaller(use, base));
  }

  headCaller(use: Use, base: Scope): Scope {
    const slot = this.slotOf.get(use.host);
    if (slot) return slot.caller ?? (slot.head ? (this.headMarkup(slot, base), slot.caller!) : base);
    if (use.head?.parent) return this.headMarkup(use.head.parent, base);
    return base;
  }

  /** `data-sn-state` on `el`, compiled onto `node`: the scope its subtree sees. */
  stateOf(el: P5Element, node: NodeDef, scope: Scope): Scope {
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
      if (attr(el, 'data-sn-persist') !== undefined && attr(el, 'data-sn-model') === undefined) {
        node.persist = attr(el, 'data-sn-persist')!;
        this.features.add('persist');
      }
      this.stateInits.push({ sid, fields: r.entries!.map((e) => ({ key: e.key, code: e.code, deps: e.deps })), persist: node.persist ?? null });
      const site: Site = { el, attr: 'data-sn-state', shift: 0 };
      this.stateAt.set(sid, { site, fields: new Map(r.entries!.map((e) => [e.key, { ...site, shift: e.offset }])) });
    }
    return scope;
  }

  /** A use's props: each the caller's expression (checked against the declaration), as `data-sn-let` names. */
  propLets(use: Use, caller: Scope): { lets: LetEntry[]; passed: Set<string> } {
    const host = use.host, name = use.name;
    const lets: LetEntry[] = [];
    const passed = new Set<string>();
    const declared = use.props?.map((m) => m.name) ?? null;
    const src = attr(host, 'data-sn-prop');
    if (src !== undefined) {
      const r = this.expr(host, 'data-sn-prop', caller, { mode: 'value', object: 'literal-keys' });
      // a missing prop the compiler reports itself; TypeScript checks the types of those given
      if (this.check) this.typeLast({ returns: { kind: 'ts', text: use.props ? `Partial<${use.propsText.trim() || '{}'}>` : use.propsText, loc: this.locOf(use.template, use.layout ? 'data-sn-layout' : use.head ? 'data-sn-head' : 'data-sn-component') } });
      for (const e of r.entries ?? []) {
        if (declared && !declared.includes(e.key)) {
          this.report(host, 'data-sn-prop', 'SN313', `\`${e.key}\` is not a prop of \`<${name}>\`; ${declared.length ? `its props are ${declared.map((x) => `\`${x}\``).join(', ')}` : 'it declares none'}.${didYouMean(e.key, declared)}`, e.offset);
          continue;
        }
        if (passed.has(e.key)) continue;
        passed.add(e.key);
        const v = entryValue(r, e);
        const q = v ? analyze(src.slice(v.start, v.end), caller, this.page, { mode: 'value', report: () => {} }) : null;
        lets.push({ name: e.key, code: q?.ok ? q.inner : 'undefined', deps: q?.deps ?? [], usesEl: q?.usesEl ?? false, usesIndex: q?.usesIndex ?? false, resource: q?.resource ?? null, prop: true, src: q?.itemOf ?? null, list: q?.listOf ?? null });
      }
    }
    // `data-sn-model`: the `value` prop (and the `change` handler, with the other bindings)
    if (attr(host, 'data-sn-model') !== undefined) {
      const ok = (!declared || declared.includes('value')) && (!use.emits || use.emits.some((m) => m.name === 'change'));
      if (!ok) {
        this.report(host, 'data-sn-model', 'SN313', `\`data-sn-model\` binds a component through its \`value\` prop and \`change\` event; \`<${name}>\` declares ${declared?.includes('value') ? 'no `change` event' : 'no `value` prop'}`, 0,
          `declare both: \`data-sn-component="{ value: … }" data-sn-emits="{ change: … }"\`, and \`emit('change', v)\` when the value changes`);
      } else if (passed.has('value')) {
        this.report(host, 'data-sn-model', 'SN209', '`data-sn-model` passes the `value` prop; `data-sn-prop` cannot pass it too', 0);
      } else {
        const q = analyze(attr(host, 'data-sn-model')!, caller, this.page, { mode: 'value', report: () => {} });
        passed.add('value');
        lets.push({ name: 'value', code: q.ok ? q.inner : 'undefined', deps: q.deps, usesEl: q.usesEl, usesIndex: q.usesIndex, resource: q.resource, prop: true });
      }
    }
    // a prop not given is undefined, unless the root's state gives it a default
    const defaults = stateKeys(attr(use.root, 'data-sn-state'));
    for (const m of use.props ?? []) {
      if (passed.has(m.name)) continue;
      if (!m.optional) this.report(host, null, 'SN313', `\`<${name}>\` needs the prop \`${m.name}\``, 0, `pass it with \`data-sn-prop="{ ${m.name}: … }"\``);
      if (!defaults.has(m.name)) lets.push({ name: m.name, code: 'undefined', deps: [], usesEl: false, usesIndex: false, resource: null, prop: true });
    }
    return { lets, passed };
  }

  /**
   * A component used inside itself (through a `data-sn-for` or `data-sn-if` template): one shared
   * definition, a `<template>` in the head, compiled once as a row template whose item is the props.
   * Each use is an empty `<template data-sn-def>` with a `data-sn-for` over `[props]`; the runtime and
   * the early script clone the definition into it, so a tree renders at any depth.
   */
  recursionPoint(host: P5Element, name: string, ctx: Ctx, index: number): null {
    const def = this.definition(name);
    if (!def) { detach(host); return null; }
    const use: Use = { ...def.use, host, chain: [] };
    const choice = this.choices.get(host);
    // `<sn-component use>`: the name, checked once against `ComponentName` (the app's components)
    let pick: ExprResult | null = null;
    if (choice) {
      pick = choice.first ? this.expr(host, 'use', ctx.scope, { mode: 'value' }) : analyze(attr(host, 'use')!, ctx.scope, this.page, { mode: 'value', report: () => {} });
      // a map in the markup: TypeScript types its values as strings, so the key is what must fit (its keys); the values are checked above
      if (choice.first && this.check && choice.keys) {
        if (this.lastExpr !== null) this.check.exprs.pop();
        const src = attr(host, 'use')!;
        this.expr(host, 'use', ctx.scope, { mode: 'value' }, choice.keySrc!, src.lastIndexOf(choice.keySrc!));
        this.typeLast({ returns: { kind: 'ts', text: choice.keys.map((k) => JSON.stringify(k)).join(' | ') || 'never', loc: this.locOf(host, 'use') } });
      } else if (choice.first && this.check) this.typeLast({ returns: { kind: 'ts', text: [...new Set([...(this.opts.componentNames ?? []), ...choice.names])].sort().map((n) => JSON.stringify(n)).join(' | ') || 'never', loc: this.locOf(host, 'use') } });
    }
    const { lets } = this.propLets(use, ctx.scope);
    // each candidate's props, checked with the data narrowed to its value (convention, map; a helper hides the link)
    if (choice?.key != null && this.check && this.lastExpr !== null && attr(host, 'data-sn-prop') !== undefined) this.check.exprs[this.lastExpr]!.guard = `(${choice.keySrc}) === ${JSON.stringify(choice.key)}`;
    for (const l of lets) if (l.src?.length) this.addSources(`@def:${name}:${l.name}`, l.src);
    const props = `[{ ${lets.map((l) => `${JSON.stringify(l.name)}: (${l.code})`).join(', ')} }]`;
    // dev builds: a value outside the candidates, with no `data-sn-else` to show, is reported (once per value and place)
    const warn = pick && choice!.first && !choice!.hasElse && this.opts.dev
      ? `if (!${JSON.stringify(choice!.names)}.includes(v) && !(($.$f.$snw ??= new Set()).has(${JSON.stringify(this.position(host))} + v))) { $.$f.$snw.add(${JSON.stringify(this.position(host))} + v); console.warn(${JSON.stringify(`sinter: <sn-component use> at ${this.position(host)} is `)} + JSON.stringify(v) + ${JSON.stringify(`, not one of its components (${choice!.names.join(', ')}): nothing is rendered. Add the component, or a <template data-sn-else> after the element`)}); } `
      : '';
    const code = pick
      ? (warn ? `($) => { const v = (${pick.ok ? pick.inner : 'undefined'}); ${warn}return v === ${JSON.stringify(choice!.name)} ? ${props} : []; }`
        : `($) => ((${pick.ok ? pick.inner : 'undefined'}) === ${JSON.stringify(choice!.name)} ? ${props} : [])`)
      : `($) => ${props}`;
    const deps = [...new Set([...lets.flatMap((l) => l.deps), ...(pick?.deps ?? [])])].sort();
    const node: NodeDef = { tag: 'template', p: ctx.stateIdx, b: [this.binding({ k: 'for', f: this.fn(code, { el: host, attr: 'data-sn-prop', shift: 0 }), d: deps, x: def.tid })] };
    if (ctx.scope.component?.late || this.lateTag(host)) this.lateNodes.add(node);
    // the tag becomes the empty template the definition is cloned into
    const t = host as unknown as P5Template;
    host.tagName = host.nodeName = 'template';
    host.attrs = [{ name: 'data-sn-def', value: def.id }];
    t.content = parse5.defaultTreeAdapter.createDocumentFragment();
    host.childNodes = [];
    if (ctx.tid < 0) {
      node.id = this.nextId++;
      setAttr(host, 'data-sn', String(node.id));
    } else node.path = [...ctx.path, index];
    if (this.opts.dev) (node as NodeDef & { src?: string }).src = this.position(host);
    ctx.list.push(node);
    return null;
  }

  /** The shared definition of a component used inside itself, compiled on its first such use. */
  definition(name: string): { tid: number; id: string; use: Use } | null {
    const known = this.defs.get(name);
    if (known !== undefined) return known;
    const file = this.componentFile(name);
    if (!file || file.bad) { this.defs.set(name, null); return null; }
    const tid = this.newTemplate(), t = this.templates[tid]!, rt = `$p${tid}`;
    t.item = rt;
    t.index = null;
    // one row: kept across renders, its item (the props) updated
    t.key = this.fn('() => 0');
    t.keyFields = null;
    const ad = parse5.defaultTreeAdapter;
    const tpl = ad.createElement('template', parse5.html.NS.HTML, [{ name: 'id', value: `sn-def-${name}` }]) as P5Template;
    tpl.content = ad.createDocumentFragment();
    const host = ad.createElement(name, parse5.html.NS.HTML, []);
    ad.appendChild(tpl.content, host);
    this.origins.set(host, { file: this.opts.file, src: '', chain: [] });
    this.defHosts.set(host, { rt });
    this.expandComponents(tpl.content, []);
    const root = tpl.content.childNodes.find(isElement);
    const use = root ? this.useOf.get(root) : undefined;
    if (!root || !use) { this.defs.set(name, null); return null; }
    const entry = { tid, id: `sn-def-${name}`, use };
    this.defs.set(name, entry);
    this.features.add('defs');
    if (!use.props) this.report(use.template, 'data-sn-component', 'SN312', `\`<${name}>\` uses itself, so its props must be a type literal the compiler can list (\`{ comment: Comment }\`), not a named type`, 0);
    // in the head, so the parser has it before the body: the early script clones it while the body arrives
    const head = this.head;
    if (head) ad.appendChild(head, tpl);
    this.templateAt.set(tid, { el: root, attr: null, shift: 0 });
    this.walkChildren(tpl.content, { scope: { loops: [], states: [] }, list: t.nodes, tid, path: [], stateIdx: -1 });
    return entry;
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
        const key = attr(child, 'key') ?? (attr(child, 'call') == null ? this.apiTarget(child, 'src', attr(child, 'method')?.trim() === 'POST' ? 'post' : 'get')?.shape?.key : undefined);
        const paginate = attr(child, 'paginate');
        const info: ResourceInfo = { name, key: key ? key.split(',').map((s) => s.trim()).filter(Boolean) : null, paginate: paginate ?? null, used: false };
        if (paginate === 'keyset' && attr(child, 'offset-param') != null) info.jumps = true;
        this.page.resources.set(name, info);
        this.resourceEls.set(name, child);
        continue;
      }
      if (child.tagName === 'sn-event') { const fed = attr(child, 'resource'); if (fed) this.page.fed.add(fed); }
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
    // a page in one language: its paths under that language's prefix, after the base (`/de/article/:slug`)
    const lp = this.opts.locale;
    const lb = lp && lp.base.startsWith('/') ? lp.base.replace(/\/?$/, '/') : '/';
    const prefixed = lp ? patterns.map((p) => (p.startsWith(lb) ? lb + lp.name + (p.length > lb.length ? '/' + p.slice(lb.length) : '/') : p)) : patterns;
    // only the URL the page has anyway: it is a directory's index without data-sn-path (docs/static-pages.md#page-urls)
    const root = this.opts.root.replace(/[\\/]+$/, '').replace(/\\/g, '/') + '/', file = this.opts.file.replace(/\\/g, '/');
    const rel = file.startsWith(root) ? file.slice(root.length) : null;
    const b = (this.opts.base ?? '/').startsWith('/') ? (this.opts.base ?? '/').replace(/\/?$/, '/') : '/';
    if (rel && /\.html?$/.test(rel) && !/(^|\/)(index|404|200)\.html?$/.test(rel) && patterns.length === 1 && patterns[0] === b + rel.replace(/\.html?$/, '/')) {
      this.report(html!, 'data-sn-path', 'SN515', `\`data-sn-path="${patterns[0]}"\` is the URL this page has anyway, as a directory's index`, 0, 'remove it: `data-sn-path` lists the paths a page answers at besides that, such as `/article/:slug` or `/login`');
    }
    return prefixed;
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
    this.at = { el, attr: null, shift: 0 };
    // a link the build can see: same-page links (query-links.ts) are decided once the page is read
    if ((el.tagName === 'a' || el.tagName === 'area') && attr(el, 'href') != null) this.hrefs.push({ el, prefixes: [{ s: attr(el, 'href')!.trim(), whole: true }], literal: true });
    // slot content sees the scope of the caller that wrote it
    const slot = this.slotOf.get(el);
    if (slot?.head && !slot.caller) this.headMarkup(slot, ctx.scope);
    if (slot?.caller) ctx = { ...ctx, scope: slot.caller };
    // a row of an unrolled loop: its item and index, as derived names over the constant list (on the
    // scope of the loop's writer, slot content's caller; before a component's root takes its props from this scope)
    const row = this.rowOf.get(el);
    if (row) {
      const r = this.expr(row.tpl, 'data-sn-for', ctx.scope, { mode: 'value' }, row.list, row.offset);
      if (r.ok) {
        const fixed = { usesEl: false, usesIndex: false, resource: null, src: null };
        const lets: LetEntry[] = [{ name: row.item, code: `(${r.inner})[${row.k}]`, deps: r.deps, ...fixed }];
        if (row.index) lets.push({ name: row.index, code: String(row.k), deps: [], ...fixed });
        ctx = { ...ctx, scope: { ...ctx.scope, lets: [...(ctx.scope.lets ?? []), ...lets] } };
      }
    }
    const base = ctx.scope;
    // the partial an `<sn-include>` inserted: what the page's scope has there
    const inc = this.includeTop.get(el);
    if (inc && !inc.site) inc.site = new Set<object>([...ctx.scope.loops, ...ctx.scope.states, ...(ctx.scope.lets ?? [])]);
    // a component used inside itself: an instance of its shared definition
    const point = this.points.get(el);
    if (point) return this.recursionPoint(el, point, ctx, index);
    // a component's root: its markup sees the props only
    const use = this.useOf.get(el);
    const callerCtx = use ? ctx : null;
    if (use && !use.layout) ctx = { ...ctx, scope: use.head ? this.headMarkup(use, base) : this.componentScope(use, ctx.scope) };
    switch (el.tagName) {
      case 'sn-resource': this.resource(el, ctx); return null;
      case 'sn-sync': this.sync(el, ctx); return null;
      case 'sn-event': this.report(el, null, 'SN102', '`<sn-event>` must be a child of `<sn-sync>`', 0); this.remove.push(el); return null;
    }
    if (el.tagName.startsWith('sn-')) {
      this.report(el, null, 'SN101', `\`<${el.tagName}>\` is not a sinter element.${didYouMean(el.tagName, ['sn-resource', 'sn-sync', 'sn-event', 'sn-component'])}`, 0);
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

    if (has('layout') && !use?.layout) this.report(el, 'data-sn-layout', 'SN318', '`data-sn-layout` belongs on the `<html>` of a layout file (`src/layouts/<name>.html`)', 0);
    for (const n of ['component', 'head', 'emits']) {
      if (has(n)) this.report(el, `data-sn-${n}`, 'SN102', `\`data-sn-${n}\` belongs on the \`<template>\` of a component file (\`src/components/<name>.html\`)`, 0);
    }
    if (has('early') && !this.useOf.get(el)) this.report(el, 'data-sn-early', 'SN102', '`data-sn-early` goes on a component\'s tag, `<tag-cloud data-sn-early="off">`', 0);
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

    // a `<meta name|property|itemprop>`: its `content` binds (a per-page description, `og:title`); nothing else of a meta does
    const meta = el.tagName === 'meta' && sn.length ? this.metaBindable(el, sn) : null;
    if (meta === false) { stripSn(el); return null; }
    // the canonical link of a page whose path is a pattern, which the compiler adds (`canonical()`): its `href` is `$canonical`
    if (sn.length && !meta && el !== this.canonicalLink && UNSAFE_ELEMENTS.has(el.tagName.toLowerCase())) {
      this.report(el, sn[0]!.name, 'SN207', `\`<${el.tagName}>\` cannot carry sinter bindings`, 0);
      stripSn(el);
      return null;
    }

    const node: NodeDef = { tag: el.tagName, p: ctx.stateIdx, b: [] };
    if (ctx.scope.component?.late) this.lateNodes.add(node);
    const inDialog = ctx.dialog || el.tagName === 'dialog';
    if (inDialog) node.dl = 1;
    const inForm = ctx.form || el.tagName === 'form';
    const nodeIdx = ctx.list.length;
    // a layout's `<html>`: the page's state (on the tag) is the caller's, which its props and slot content see
    if (use?.layout) {
      const caller = attr(use.host, 'data-sn-state') !== undefined ? this.stateOf(use.host, node, ctx.scope) : ctx.scope;
      ctx = { ...ctx, scope: this.componentScope(use, caller) };
    }
    let scope = ctx.scope;
    let result: { node: NodeDef; binding: Binding } | null = null;

    // state
    if (has('state')) scope = this.stateOf(el, node, scope);

    // a form whose markup reads `$error`: the form's last failed send, as a state field of the form
    // (merged into its own `data-sn-state`); the runtime sets it when the send fails, null when sent again
    if (el.tagName === 'form' && readsFormError(el, (e) => this.useOf.get(e)?.host)) {
      this.features.add('fields');
      let entry = node.state !== undefined ? scope.states.at(-1)! : null;
      if (entry) {
        const init = this.fns[node.state!]!;
        node.state = this.fn(`($) => Object.assign((${init})($), { $error: null })`, { el, attr: 'data-sn-state', shift: 0, parts: [{ code: init, site: this.fnAt[node.state!] ?? null }] });
        entry.names.add('$error');
        this.stateInits.find((x) => x.sid === entry!.sid)!.fields.push({ key: '$error', code: '($) => (null)', deps: [] });
      } else {
        const sid = this.nextSid++;
        node.state = this.fn('($) => ({ $error: null })', { el, attr: null, shift: 0 });
        node.sid = sid;
        this.stateAt.set(sid, { site: { el, attr: null, shift: 0 }, fields: new Map() });
        entry = { sid, names: new Set(['$error']) };
        scope = { ...scope, states: [...scope.states, entry] };
        this.stateInits.push({ sid, fields: [{ key: '$error', code: '($) => (null)', deps: [] }], persist: null });
      }
      if (this.check) {
        // its own frame, inside the state's: typed as the error or null
        const e2 = { sid: entry.sid, names: new Set(['$error']) };
        this.frameOf.set(e2, this.check.frames.length);
        this.check.frames.push({ kind: 'formError' });
        scope = { ...scope, states: [...scope.states, e2] };
      }
    }

    // a component's root: its state, where its script's refs find the instance
    if (use && node.sid !== undefined) use.sid = node.sid;
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

    for (const n of ['for', 'if', 'else'] as const) {
      if (has(n) && !isTemplate) this.report(el, `data-sn-${n}`, 'SN102', `\`data-sn-${n}\` must be on a \`<template>\``, 0);
    }
    if (has('key') && !(isTemplate && has('for'))) this.report(el, 'data-sn-key', 'SN102', '`data-sn-key` belongs on a `<template data-sn-for>`', 0);
    if (has('reserve')) {
      if (!(isTemplate && has('for')) || ctx.tid >= 0) this.report(el, 'data-sn-reserve', 'SN102', '`data-sn-reserve` belongs on a `<template data-sn-for>` outside templates', 0);
      else if (!/^\s*(off|[1-9]\d*)\s*$/.test(get('reserve')!)) this.report(el, 'data-sn-reserve', 'SN401', '`data-sn-reserve` takes `off` or the number of rows to hold space for', 0);
    }

    // a layout's `<body>`: first the handlers of the page's tag, in the page's scope
    const page = this.layoutBody.get(el);
    if (page?.bodyHandlers && page.caller) this.bindings(page.bodyHandlers, node, page.caller, { ...ctx, scope: page.caller }, page);
    this.bindings(el, node, scope, ctx);
    // a component's root: the caller's attributes on its tag, in the caller's scope
    if (use && !use.head) this.bindings(use.host, node, use.caller!, { ...callerCtx!, scope: use.caller! }, use);
    // a component with a script: its object, created per instance with the live props
    const script = use ? this.componentFiles.get(use.name)?.script : null;
    if (use && script) {
      const local = `$cm$${use.name.replace(/-/g, '_')}`;
      const exported = this.componentFiles.get(use.name)!.exported;
      if (exported === null) this.report(use.template, null, 'SN312', `the script of \`<${use.name}>\` (\`${script}\`) exports no class \`${pascalName(use.name)}\` and no default export`, 0, `\`export class ${pascalName(use.name)} extends ${pascalName(use.name)}Component { … }\``);
      const lazy = this.opts.lazyScript?.(script) ?? [];
      this.scripts.set(use.name, { module: script, local, name: exported ?? 'default', ...(lazy.length ? { lazy } : {}) });
      this.features.add('components');
      const props = (scope.lets ?? []).filter((l) => l.prop);

      // what the script can write: each field of the root's state (`this.state.n = …` marks that one), its names in the order of `w`
      const keys = node.sid !== undefined ? [...stateKeys(attr(use.root, 'data-sn-state') ?? '{}')] : [];
      const writes = keys.map((k) => `$s${node.sid}.${k}`);
      const code = `($) => [${local}, { ${props.map((l) => `${JSON.stringify(l.name)}: (${l.code})`).join(', ')} }, ${JSON.stringify(keys)}]`;
      node.b.push(this.binding({ k: 'cmp', f: this.fn(code, { el, attr: null, shift: 0 }), d: [...new Set(props.flatMap((l) => l.deps))].sort(), ...(writes.length ? { w: writes } : {}) }));
    }
    // `data-sn-ref="name"`: an element of a component's markup, for its script (`this.refs.name`)
    if (has('ref')) this.ref(el, scope, node);
    // lazy packages: loaded when the element is rendered, fetched with the page
    if (has('import')) this.lazyImport(el, node);
    if (has('preload')) for (const spec of this.lazyNames(el, 'data-sn-preload')) this.preloads.add(spec);

    // templates
    let content: { tid: number; scope: Scope } | null = null;
    if (isTemplate && has('for')) content = this.forTemplate(el, node, scope, get('for')!, get('key'));
    else if (isTemplate && has('if')) {
      const r = this.expr(el, 'data-sn-if', scope, { mode: 'value', cond: true });
      const tid = this.newTemplate();
      const b = this.binding({ k: 'if', f: this.fn(r.code), d: r.deps, x: tid, ...usesEl(r) });
      node.b.push(b);
      result = { node, binding: b };
      content = { tid, scope };
    } else if (isTemplate && has('else')) {
      if (get('else')) this.report(el, 'data-sn-else', 'SN401', '`data-sn-else` takes no value', 0);
      if (!prevIf) this.report(el, 'data-sn-else', 'SN102', '`data-sn-else` must be on a `<template>` directly after a `data-sn-if` template', 0);
      const tid = this.newTemplate();
      node.b.push(this.binding({ k: 'else', x: tid }));
      if (prevIf) prevIf.binding.y = nodeIdx;
      content = { tid, scope };
    }

    const hasDirectives = node.b.length > 0 || node.state !== undefined;
    if (hasDirectives) {
      if (ctx.tid < 0) {
        node.id = this.nextId++;
        setAttr(el, 'data-sn', String(node.id));
        this.paints.push({ el, node });
      } else {
        node.path = [...ctx.path, index];
        this.tplEls.set(node, el);
      }
      if (this.opts.dev) (node as NodeDef & { src?: string }).src = this.position(el);
      ctx.list.push(node);
      if (content && isTemplate && has('for')) this.spaceFor(el, node, ctx);
    }
    stripSn(el);

    if (content) {
      if (inDialog || this.dlTemplates.has(ctx.tid)) this.dlTemplates.add(content.tid);
      const t = this.templates[content.tid]!;
      this.walkChildren((el as P5Template).content, { scope: content.scope, list: t.nodes, tid: content.tid, path: [], stateIdx: -1, form: inForm });
    } else if (isTemplate) {
      if (hasSnDeep((el as P5Template).content)) {
        this.report(el, null, 'SN102', 'directives inside a `<template>` need `data-sn-for` or `data-sn-if` on it', 0);
      }
    } else {
      this.walkChildren(el, {
        ...ctx, scope, dialog: inDialog, form: inForm,
        stateIdx: node.state !== undefined && hasDirectives ? nodeIdx : ctx.stateIdx,
        path: ctx.tid >= 0 ? [...ctx.path, index] : ctx.path,
      });
    }
    return result;
  }

  /**
   * The bindings, handlers and action of an element's attributes. For a component's root, it runs
   * twice: for the root's own attributes in the component's scope, and for the tag's (`use`) in
   * the caller's, onto the same node.
   */
  bindings(el: P5Element, node: NodeDef, scope: Scope, ctx: Ctx, use?: Use) {
    const sn = el.attrs.filter((a) => a.name.startsWith('data-sn-'));
    const get = (n: string) => sn.find((a) => a.name === `data-sn-${n}`)?.value;
    const has = (n: string) => sn.some((a) => a.name === `data-sn-${n}`);
    const valueB = (k: 'text' | 'show', name: string) => {
      const r = this.expr(el, name, scope, { mode: 'value', ...(k == 'show' ? { cond: true } : {}) });
      if (r.ok) node.b.push(this.binding({ k, f: this.fn(r.code), d: r.deps, ...usesEl(r), s: this.selection(scope, attr(el, name) ?? '', r.ast, r) }));
    };
    if (has('text')) valueB('text', 'data-sn-text');
    if (has('show')) valueB('show', 'data-sn-show');
    // the morph across a navigation: the name is kept on the element, the transition feature uses it
    if (has('transition')) {
      const r = this.expr(el, 'data-sn-transition', scope, { mode: 'value' });
      if (r.ok) { node.b.push(this.binding({ k: 'attr', n: 'data-sn-vt', f: this.fn(r.code), d: r.deps, ...usesEl(r) })); this.features.add('transition'); }
    }
    if (has('attr')) this.attrBinding(el, node, scope);
    if (has('class')) this.objectBinding(el, node, scope, 'class');
    if (has('style')) this.objectBinding(el, node, scope, 'style');
    if (has('prop') && !use) {
      if (!el.tagName.includes('-')) this.report(el, 'data-sn-prop', 'SN102', '`data-sn-prop` is for custom elements only; use `data-sn-attr`', 0);
      else this.objectBinding(el, node, scope, 'prop');
    }
    if (has('model') && use) this.componentModel(use, node, scope);
    else if (has('model')) this.model(el, node, scope, get('persist'));
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
      // a layout's tag: the page's `<body>` handlers, for DOM events and sinter's own
      if (use?.layout && !kf && !DOM_EVENTS.has(event) && !SINTER_EVENTS.includes(event)) {
        this.report(el, a.name, 'SN315', `\`${event}\` is not an event the page's \`<body>\` hears: a layout's tag takes handlers for DOM events and sinter's \`sn-error\` and \`dismiss\`.${didYouMean(event, [...SINTER_EVENTS, ...DOM_EVENTS])}`, 0,
          'handle a component\'s event on an element around it, in the page\'s content');
      } else if (use && !use.layout && !kf && use.emits && !DOM_EVENTS.has(event) && !use.emits.some((m) => m.name === event)) {
        const names = use.emits.map((m) => m.name);
        this.report(el, a.name, 'SN315', `\`<${use.name}>\` does not emit \`${event}\`; ${names.length ? `it declares ${names.map((x) => `\`${x}\``).join(', ')}` : 'it declares no events'}.${didYouMean(event, names)}`, 0);
      }
      // `$url` writes on `input`: a keystroke replaces (location.ts), but on a checkbox, radio or select it is a
      // choice, a new history entry (4), decided here. A handler higher up hears both: there `input` replaces.
      const choice = event === 'input' && (el.tagName === 'select' || (el.tagName === 'input' && /^(checkbox|radio)$/i.test(attr(el, 'type') ?? '')));
      const r = this.expr(el, a.name, scope, { mode: 'handler', magic: ['$event'], ...(choice ? { urlKind: 4 } : {}) });
      const own = get(`debounce-${event}`), ms = own !== undefined ? Number(own) || 0 : handlerDebounce;
      if (ms > 0) this.features.add('debounce');
      if (r.ok) node.b.push(this.binding({ k: 'on', n: kf ? kf[1]! : event, f: this.fn(r.code), w: r.writes, ...filter, ...(ms > 0 ? { ms } : {}) }));
    }

    if (methods.length > 1) this.report(el, `data-sn-${methods[1]}`, 'SN102', 'an element can have only one method attribute', 0);
    if (methods.length && isCall) this.report(el, 'data-sn-call', 'SN102', 'an element has one action: a method attribute or `data-sn-call`, not both', 0);
    if (methods.length) this.action(el, node, scope, methods[0]!, get, !!ctx.form || el.attrs.some((x) => x.name === 'form'));
    else if (isCall) this.action(el, node, scope, 'call', get);
    else for (const n of ACTION_ONLY) if (has(n) && n !== 'debounce') this.report(el, `data-sn-${n}`, 'SN102', `\`data-sn-${n}\` needs a method attribute (\`data-sn-get\`, \`-post\`, …) on the same element`, 0);
  }

  /**
   * `data-sn-model` on a component: the `value` prop (see `componentScope`) and a handler for its
   * `change` event that writes the detail back. Only the component's own event writes: a native
   * `change` bubbling from a control inside it is not a `CustomEvent`.
   */
  componentModel(use: Use, node: NodeDef, scope: Scope) {
    const host = use.host;
    const src = attr(host, 'data-sn-model')!;
    const r = analyze(src, scope, this.page, { mode: 'value', report: this.reporter(host, 'data-sn-model') });
    if (!r.ok) return;
    if (r.resource) { this.report(host, 'data-sn-model', 'SN205', `\`data-sn-model\` cannot write to resource \`${r.resource}\`; copy the item into state with structuredClone()`, 0); return; }
    const url = r.path?.[0] === '$url';
    if (!r.path || !((r.path[0]!.startsWith('$s') || url) && r.path.length >= 2)) { this.report(host, 'data-sn-model', 'SN203', '`data-sn-model` takes a state path or a URL parameter such as `q` or `$url.q`', 0); return; }
    if (url && attr(host, 'data-sn-persist') !== undefined) this.report(host, 'data-sn-persist', 'SN102', '`data-sn-persist` on a `$url` model: the URL already keeps this value', 0);
    else if (attr(host, 'data-sn-persist') !== undefined) {
      this.report(host, 'data-sn-persist', 'SN102', '`data-sn-persist` on a component: persist the state the model writes instead (`data-sn-persist` on its `data-sn-state`)', 0);
    }
    // a component's change pushes a history entry, as a select's does
    const h = this.expr(host, 'data-sn-model', scope, { mode: 'handler', magic: ['$event'], urlKind: 4 }, `${src} = $event.detail`);
    if (!h.ok) return;
    const f = this.fn(`($) => { if ($.$event instanceof CustomEvent) (${h.code})($); }`, { el: host, attr: 'data-sn-model', shift: 0 });
    node.b.push(this.binding({ k: 'on', n: 'change', f, w: h.writes }));
  }

  /**
   * A use whose prop is a constant (`label: true`, or left out): a `data-sn-if` on that prop in the
   * component's markup is decided at build time. True: its content takes the template's place; false,
   * `undefined` and other falsy constants: it is dropped (a `data-sn-else` after it, the other way
   * round). Slot content and other components' markup are not the component's, and stay.
   */
  foldConstants(use: Use, lets: LetEntry[]) {
    const value = new Map(lets.filter((l) => l.prop && CONST_PROP.test(l.code)).map((l) => [l.name, !FALSY_PROP.includes(l.code)]));
    this.foldIn(use.root, value, use);
  }

  /** `foldConstants` in `parent`: each `data-sn-if` on a constant prop, decided. */
  foldIn(parent: P5Parent, value: Map<string, boolean>, use: Use) {
    if (!value.size) return;
    const real = (c: P5Node) => isElement(c) || (c.nodeName === '#text' && (c as DefaultTreeAdapterMap['textNode']).value.trim() !== '');
    const contentOf = (t: P5Element) => (t as P5Template).content.childNodes;
    const place = (parent: P5Parent, at: number, count: number, nodes: P5Node[]) => {
      for (const n of nodes) (n as { parentNode: P5Parent }).parentNode = parent;
      parent.childNodes.splice(at, count, ...(nodes as never[]));
    };
    const fold = (parent: P5Parent) => {
      for (let i = 0; i < parent.childNodes.length; i++) {
        const c = parent.childNodes[i]!;
        if (!isElement(c) || this.slotOf.has(c) || (this.useOf.has(c) && c !== use.root) || this.points.has(c)) continue;
        const cond = c.tagName === 'template' ? attr(c, 'data-sn-if')?.trim() : undefined;
        if (cond !== undefined && value.has(cond)) {
          const j = parent.childNodes.findIndex((x, k) => k > i && real(x));
          const other = j >= 0 && isElement(parent.childNodes[j]!) && (parent.childNodes[j] as P5Element).tagName === 'template' && attr(parent.childNodes[j] as P5Element, 'data-sn-else') !== undefined ? parent.childNodes[j] as P5Element : null;
          const keep = value.get(cond) ? contentOf(c) : other ? contentOf(other) : [];
          place(parent, i, (other ? j : i) - i + 1, [...keep]);
          mergeText(parent);
          i--;
          continue;
        }
        fold(c);
        if (c.tagName === 'template') fold((c as P5Template).content);
      }
    };
    fold(parent);
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
  fn(code: string, site?: Site | null): number {
    let i = this.fnIndex.get(code);
    if (i === undefined) {
      this.fnIndex.set(code, (i = this.fns.push(code) - 1));
      this.fnAt[i] = this.codeAt.get(code) ?? (site !== undefined ? site : this.at);
    }
    this.fnUses[i] = (this.fnUses[i] ?? 0) + 1;
    if (this.opts.dev) this.callAt.set(i, site !== undefined ? site : this.at);
    return i;
  }

  /** `binding()`; in dev builds with where its functions were written (`at`) */
  binding(b: Binding): Binding {
    const out = binding(b);
    if (this.opts.dev) this.devAt(out, [out.f, out.a]);
    return out;
  }

  /**
   * Dev builds: `o.at`, the place in the markup of each of the functions `fs` this object uses
   * (`"file:line:col"` by function index), so the dev runtime can say which attribute threw although
   * identical code shares one function. Read right after the functions are made: their latest use is this one.
   */
  devAtOf(fs: Array<number | null | undefined>): { at?: Record<number, string> } {
    const o: { at?: Record<number, string> } = {};
    this.devAt(o, fs);
    return o;
  }

  devAt(o: { at?: Record<number, string> }, fs: Array<number | null | undefined>) {
    if (!this.opts.dev) return;
    const at: Record<number, string> = {};
    for (const i of fs) {
      const site = i == null ? null : this.callAt.get(i), o2 = site && this.origins.get(site.el);
      if (!site || !o2 || !site.el.sourceCodeLocation || i! in at) continue;
      const { line, col } = this.lineCol(o2.src, this.valueOffset(site.el, site.attr) + site.shift);
      at[i!] = `${o2.file}:${line}:${col}`;
    }
    if (Object.keys(at).length) o.at = at;
  }

  /**
   * Where each function of a table (the page's, or one copied from it) was written, and the files' text.
   * `sites`: the sites of functions written for that table alone (the early module's state functions).
   */
  sourcesOf(fns: string[], sites?: Map<string, Site>): FnSources {
    const content: Record<string, string> = {};
    const pos = (site: Site | null | undefined): SourcePos | null => {
      const o = site && this.origins.get(site.el);
      if (!site || !o || !site.el.sourceCodeLocation) return null;
      content[o.file] ??= o.src;
      return { file: o.file, ...this.lineCol(o.src, this.valueOffset(site.el, site.attr) + site.shift) };
    };
    const at = (code: string): FnSource | null => {
      const i = this.fnIndex.get(code), site = sites?.get(code) ?? (i === undefined ? null : this.fnAt[i]);
      const p = pos(site);
      if (!p || !site?.parts) return p;
      // each inlined expression where it is in the code, in order
      const parts: NonNullable<FnSource['parts']> = [];
      let from = 0;
      for (const part of site.parts) {
        const k = code.indexOf(part.code, from), q = k < 0 ? null : pos(part.site);
        if (k < 0) continue;
        from = k + part.code.length;
        if (q) parts.push({ ...q, at: k, len: part.code.length });
      }
      return parts.length ? { ...p, parts } : p;
    };
    return { fns: fns.map(at), content };
  }

  expr(el: P5Element, attrName: string, scope: Scope, o: Omit<ExprOptions, 'report'>, value?: string, shift = 0): ExprResult {
    const src = value ?? attr(el, attrName) ?? '';
    // a handler on a component's tag: its event's detail has the source of what the component emits
    const host = this.hostUse.get(el)?.scope;
    if (host?.id !== undefined) {
      const ev = attrName.startsWith('data-sn-on-') ? attrName.slice('data-sn-on-'.length) : TRIGGER_TIME.has(attrName) || attrName === 'data-sn-optimistic' || attrName === 'data-sn-then' || attrName === 'data-sn-catch' ? attr(el, 'data-sn-trigger') ?? 'click' : null;
      if (ev) o = { ...o, detailSource: `@ev:${host.id}:${ev}` };
    }
    const r = analyze(src, scope, this.page, { ...o, report: this.reporter(el, attrName, shift) });
    for (const a of r.assigns ?? []) this.addSources(`@${a.path}`, a.src);
    if (scope.component?.id !== undefined) for (const e of r.emitted ?? []) this.addSources(`@ev:${scope.component.id}:${e.event}`, e.src);
    for (const c of r.srcRefs ?? []) this.srcCalls.push({ el, attr: attrName, shift, ...c });
    const inc = this.includeOf.get(el);
    if (inc) this.outerNames(src, scope, o, inc);
    this.at = { el, attr: attrName, shift };
    if (r.ok && !this.codeAt.has(r.code)) this.codeAt.set(r.code, this.at);
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

  /**
   * `data-sn-ref="name"` in a component's markup: a `cmp` binding on the element that gives it to its
   * instance's `this.refs`, found through the root's state (`[state, name]`); nothing for a component
   * without a script, which has no `this.refs`
   */
  ref(el: P5Element, scope: Scope, node: NodeDef) {
    const name = attr(el, 'data-sn-ref') ?? '';
    const use = scope.component?.id !== undefined ? this.useById.get(scope.component.id) : undefined;
    if (!use || this.useOf.get(el) === use) {
      this.report(el, 'data-sn-ref', 'SN102', use ? '`data-sn-ref` on a component\'s root: the script has it as `this.root`' : '`data-sn-ref` names an element of a component\'s markup for its script', 0);
      return;
    }
    if (!IDENT.test(name)) { this.report(el, 'data-sn-ref', 'SN401', '`data-sn-ref` takes a name, as the script reads it: `this.refs.canvas`', 0); return; }
    if (use.sid === undefined || !this.componentFiles.get(use.name)?.script) return;
    node.b.push(this.binding({ k: 'cmp', f: this.fn(`($) => [$.$s${use.sid}, ${JSON.stringify(name)}]`, { el, attr: 'data-sn-ref', shift: 0 }) }));
  }

  /** the lazy packages an attribute names (`openpgp, marked`), each one of `sinter({ lazy })` (SN324) */
  lazyNames(el: P5Element, name: 'data-sn-import' | 'data-sn-preload'): string[] {
    const text = attr(el, name) ?? '', list = this.opts.lazy ?? [];
    const out: string[] = [];
    let at = 0;
    for (const part of text.split(',')) {
      const spec = part.trim(), offset = at + part.indexOf(spec);
      at += part.length + 1;
      if (!spec) { this.report(el, name, 'SN401', `\`${name}\` takes the lazy packages to load, separated by commas: \`${name}="openpgp"\``, 0); continue; }
      if (list !== true && !list.some((p) => spec === p || spec.startsWith(p + '/'))) {
        this.report(el, name, 'SN324', `\`${spec}\` is not a lazy package: \`${name}\` names packages of \`sinter({ lazy })\`${list.length ? ` (${list.map((p) => `\`${p}\``).join(', ')})` : ', which lists none'}${didYouMean(spec, [...list]) ? '.' + didYouMean(spec, [...list]) : ''}`, offset);
        continue;
      }
      out.push(spec);
    }
    return out;
  }

  /**
   * `data-sn-import="openpgp"`: the page module loads the package when it renders the element (at
   * mount for an element outside templates, so never before the page has taken over). A binding whose
   * function starts the load; a failed load is reported by the call that needs the package.
   */
  lazyImport(el: P5Element, node: NodeDef) {
    const specs = this.lazyNames(el, 'data-sn-import');
    if (!specs.length) return;
    const locals = specs.map((spec) => {
      let local = this.lazyLoads.get(spec);
      if (!local) this.lazyLoads.set(spec, (local = `$l$${this.lazyLoads.size}`));
      return local;
    });
    node.b.push(this.binding({ k: 'imp', f: this.fn(`() => { ${locals.map((l) => `${l}().catch(() => {});`).join(' ')} }`, { el, attr: 'data-sn-import', shift: 0 }) }));
  }

  addSources(ref: string, src: string[]) {
    let set = this.srcOf.get(ref);
    if (!set) this.srcOf.set(ref, (set = new Set()));
    for (const x of src) set.add(x);
  }

  /**
   * The sources of `patch()`/`remove()` items that are state (`sel`) or a component's event detail:
   * the resources assigned to them anywhere on the page, followed through other references. A
   * reference no assignment gives a resource is SN317.
   */
  resolveSources() {
    const resolve = (ref: string, seen: Set<string>): string[] => {
      // `@def:x:comment>replies`: what the reference resolves to, through `replies`
      const at = ref.indexOf('>');
      if (at > 0) return resolve(ref.slice(0, at), seen).map((n) => ref.slice(at + 1).split('>').reduce(throughField, n));
      if (seen.has(ref)) return [];
      seen.add(ref);
      const out: string[] = [];
      for (const [k, set] of this.srcOf) {
        if (k !== ref) continue;
        for (const x of set) out.push(...(x.startsWith('@') ? resolve(x, new Set(seen)) : [x]));
      }
      return out;
    };
    // write-through targets about a prop of a shared definition, or state that holds a row
    for (const t of this.pendingTargets) {
      const ap = t.ap();
      if (!ap) continue;
      for (const name of resolve(t.ref, new Set())) {
        if (name.startsWith('!')) continue;
        const [base, fields] = name.split('>') as [string, string | undefined];
        const k = (x: ApplyDef['tg'][number]) => `${x.r}\0${x.v ?? ''}\0${(x.p ?? []).join('.')}\0${(x.n ?? []).join(',')}`;
        const add = (x: ApplyDef['tg'][number]) => { if (!ap.tg.some((y) => k(y) === k(x))) ap.tg.push(x); };
        const info0 = this.itemSchema.get(base), doc = info0 ? this.opts.openapi![info0.spec]!.doc : null;
        const n = fields ? fields.split(',') : null;
        const sch = info0 ? (n ? nestedSchema(doc, info0.schema, n) : info0.schema) : null;
        const root = sch ? namedSchema(doc, sch) : null;
        add({ r: base, ...(t.rd.row ? { v: t.rd.row } : {}), ...(n ? { n } : {}), ...(root ? { s: root.name } : {}) });
        for (let i = 1; sch && i < t.rd.path.length; i++) {
          const sn = namedAt(doc, sch, t.rd.path.slice(0, i));
          if (sn) add({ r: base, ...(t.rd.row ? { v: t.rd.row } : {}), ...(n ? { n } : {}), p: t.rd.path.slice(0, i), s: sn });
        }
        if (n) this.features.add('nested');
        this.features.add('apply');
      }
    }
    const resolved = new Map<string, string[]>();
    for (const c of this.srcCalls) {
      const names = [...new Set(c.src.flatMap((x) => (x.startsWith('@') ? resolve(x, new Set()) : [x])))];
      const bad = names.find((x) => x.startsWith('!'));
      if (!names.length || bad) {
        const item = c.text;
        this.report(c.el, c.attr, 'SN317', bad ? `\`${item}\` holds rows of \`${bad.slice(1)}()\`, which takes more than one resource, so they have no single source`
          : `\`${item}\` has no source: no handler on this page assigns it an item of a resource, so \`${c.fn}()\` cannot know which resource to change`, c.shift + c.offset,
          'assign it from a row (`sel = m` with `m in messages`), or keep the key in state and derive the row with `data-sn-let`', true);
        resolved.set(JSON.stringify(c.src), []);
        continue;
      }
      for (const n of names) { const info = this.page.resources.get(n); if (info) info.used = true; }
      resolved.set(JSON.stringify(c.src), names);
    }
    // write-through: nested targets in a list of their own (`nt`), which the nested module applies
    for (const a of this.actions) {
      const ap = a.ap;
      if (!ap?.tg.some((t) => t.n)) continue;
      const u = ap.u !== undefined ? ap.tg[ap.u] : undefined;
      ap.nt = ap.tg.filter((t) => t.n);
      ap.tg = ap.tg.filter((t) => !t.n);
      delete ap.u;
      if (u?.n) ap.nu = ap.nt.indexOf(u);
      else if (u) ap.u = ap.tg.indexOf(u);
    }
    // a change under a row (`comments>replies`): the nested module
    const nested = () => { if (this.fns.some((f) => /\$\.\$f\.(?:patch|remove|upsert)\(\[[^\]]*>/.test(f))) this.features.add('nested'); };
    if (!this.srcCalls.length) return nested();
    for (let i = 0; i < this.fns.length; i++) {
      if (!this.fns[i]!.includes('/*src*/')) continue;
      this.fns[i] = this.fns[i]!.replace(/\/\*src\*\/(\[.*?\])\/\*end\*\//g, (_, j: string) => JSON.stringify(resolved.get(j) ?? JSON.parse(j).filter((x: string) => !x.startsWith('@'))));
    }
    nested();
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
      const entry: LetEntry = { name, code: r.inner, deps: r.deps, usesEl: r.usesEl, usesIndex: r.usesIndex, resource: r.resource, src: r.itemOf ?? null, list: r.listOf ?? null };
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
      // a component's state gives an optional prop its default
      const isLet = (scope.lets ?? []).some((l) => l.name === n && !(l.prop && attrName === 'data-sn-state'));
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
    for (const f of [...(scope.component ? [scope.component] : []), ...scope.states, ...scope.loops, ...(scope.lets ?? [])]) {
      const i = this.frameOf.get(f);
      if (i !== undefined && !frames.includes(i)) frames.push(i);
    }
    let event: string | null = null;
    // a key filter's handler runs for its keydown or keyup
    if (attrName.startsWith('data-sn-on-')) event = attrName.slice('data-sn-on-'.length).replace(/^(key(?:down|up))-.*/s, '$1');
    // an element-less handler (<sn-event>, <sn-resource then>) runs for no DOM event
    else if ((o.mode !== 'value' || o.magic?.includes('$event')) && !o.noElement) {
      const tag = this.hostUse.get(el)?.root.tagName ?? el.tagName;
      event = attr(el, 'data-sn-trigger') ?? (tag === 'form' ? 'submit' : FORM_CONTROLS.has(tag) ? 'change' : 'click');
    }
    // a component's tag: the element is its root; its events have the detail `data-sn-emits` declares
    const use = this.hostUse.get(el);
    const e: CheckExpr = {
      src, mode: o.mode === 'value' ? 'value' : 'handler', loc: this.locOf(el, attrName, shift), frames, tag: use?.root.tagName ?? el.tagName, event,
      result: attrName === 'data-sn-then' || !!o.magic?.includes('$result'), error: attrName === 'data-sn-catch',
    };
    if (use && event && use.emitsText && use.emits?.some((m) => m.name === event)) {
      e.detail = { kind: 'ts', text: `(${use.emitsText})[${JSON.stringify(event)}]`, loc: this.locOf(use.template, 'data-sn-emits') };
    }
    if (o.payload) e.payload = { names: r.payloadNames ?? [], type: null, ...(r.payloadStates?.length ? { states: r.payloadStates } : {}), ...(r.payloadLets?.length ? { lets: r.payloadLets } : {}) };
    this.check!.exprs.push(e);
    const list = this.exprsOf.get(el) ?? [];
    list.push({ attr: attrName, i: this.check!.exprs.length - 1 });
    this.exprsOf.set(el, list);
    return this.check!.exprs.length - 1;
  }

  // ---- bindings

  /**
   * Whether a `<meta>`'s sinter attributes may stay: only `data-sn-attr`, on a meta with a literal
   * `name`, `property` or `itemprop` and no `http-equiv` or `charset` (its keys, `content` only, are
   * checked with the binding). False after reporting why not.
   */
  metaBindable(el: P5Element, sn: Array<{ name: string }>): boolean {
    const other = sn.find((a) => a.name !== 'data-sn-attr');
    if (other) { this.report(el, other.name, 'SN207', `\`<meta>\` takes only \`data-sn-attr="{ content: … }"\`; \`${other.name}\` cannot be on it`, 0); return false; }
    const risky = ['http-equiv', 'charset'].find((n) => attr(el, n) !== undefined);
    if (risky) { this.report(el, 'data-sn-attr', 'SN207', `a \`<meta ${risky}>\` cannot carry bindings: a value from data could redirect the page or change its policy`, 0); return false; }
    if (!['name', 'property', 'itemprop'].some((n) => attr(el, n) !== undefined)) {
      this.report(el, 'data-sn-attr', 'SN207', 'a bound `<meta>` names what it is with a literal `name`, `property` or `itemprop`: `<meta name="description" data-sn-attr="{ content: … }">`', 0);
      return false;
    }
    return true;
  }

  attrBinding(el: P5Element, node: NodeDef, scope: Scope) {
    const r = this.expr(el, 'data-sn-attr', scope, { mode: 'value', object: 'literal-keys' });
    if (this.check) this.typeLast({ returns: { kind: 'decl', name: 'Attrs' } });
    if (!r.entries) return;
    for (const e of r.entries) {
      const key = e.key.toLowerCase();
      if (el.tagName === 'meta' && key !== 'content') {
        this.report(el, 'data-sn-attr', 'SN207', `a \`<meta>\` binds only \`content\`; \`${e.key}\` stays as written`, e.offset);
        continue;
      }
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
      if ((key === 'id' || key === 'name') && !e.literal && !literalPrefix(entryValue(r, e))) {
        this.report(el, 'data-sn-attr', 'SN503', `\`${key}\` bound from data can shadow globals other scripts read (DOM clobbering)`, e.offset);
      }
      if (!r.ok) continue;
      if (key === 'src' && el.tagName === 'img') {
        const files = localImages(entryValue(r, e));
        if (files) this.report(el, 'data-sn-attr', 'SN513', `\`src\` is bound to ${files.length > 1 ? 'local images' : 'a local image'} (${files.map((f) => `\`${f}\``).join(', ')}), which ${files.length > 1 ? 'are' : 'is'} not optimized`, e.offset,
          `write each image as a static \`<img src>\` (optimized at build time) and choose with \`data-sn-if\` or \`data-sn-show\`: \`<img src="${files[0]}" data-sn-show="…">\``);
      }
      if (key === 'href' && (el.tagName === 'a' || el.tagName === 'area')) { this.hrefs.push({ el, prefixes: hrefPrefixes(entryValue(r, e)), literal: false }); this.boundHrefs.add(el); }
      const remote = key === 'src' ? this.remoteImage(el, e, r.entries.some((x) => x.key.toLowerCase() === 'srcset'), scope) : null;
      node.b.push(this.binding({ k: 'attr', n: e.key, f: this.fn(remote ? remote.src : e.code), d: e.deps, ...usesEl(r), s: this.selection(scope, attr(el, 'data-sn-attr') ?? '', entryValue(r, e), r) }));
      if (remote) node.b.push(this.binding({ k: 'attr', n: 'srcset', f: this.fn(remote.srcset), d: e.deps, ...usesEl(r) }));
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
    // a custom element's properties, from the app's HTMLElementTagNameMap
    if (this.check && k === 'prop') this.typeLast({ returns: { kind: 'decl', name: `Props<${JSON.stringify(el.tagName)}>` } });
    if (!r.entries) return;
    for (const e of r.entries) {
      let key = e.key;
      if (k === 'prop' && ['innerhtml', 'outerhtml', 'srcdoc', 'innertext', 'outertext'].includes(key.toLowerCase())) {
        this.report(el, name, 'SN207', `\`${key}\` cannot be set with \`data-sn-prop\``, e.offset);
        continue;
      }
      if (k === 'style' && !key.startsWith('--')) key = key.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase());
      if (k === 'class' && attr(el, 'class') != null) node.cl = 1;
      if (r.ok) node.b.push(this.binding({ k, n: key, f: this.fn(e.code), d: e.deps, ...usesEl(r), s: this.selection(scope, attr(el, name) ?? '', entryValue(r, e), r) }));
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
    // the runtime's selection index (select.ts)
    this.features.add('select');
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
    // controls other than text fields: the models module
    if (kind != 'text') this.features.add('models');
    const url = attr(el, 'data-sn-model')!.trim().startsWith('$url');
    if (persist !== undefined && url) {
      this.report(el, 'data-sn-persist', 'SN102', '`data-sn-persist` on a `$url` model: the URL already keeps this value', 0);
      persist = undefined;
    }
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
    if (!r.path || !((r.path[0]!.startsWith('$s') || r.path[0] === '$url') && r.path.length >= 2)) {
      this.report(el, 'data-sn-model', 'SN203', '`data-sn-model` takes a state path or a URL parameter such as `q` or `$url.q`', 0);
      return;
    }
    let setter: number;
    if (r.path[0] === '$url') {
      // a `<select multiple>` or a checkbox with a `value` binds a list: decided here, at build time
      this.urlBinds.push({ name: r.path[1]!, array: kind == 'multi' || (kind == 'checkbox' && attr(el, 'value') != null), report: (m) => this.report(el, 'data-sn-model', 'SN210', m, 0) });
      // through the handler analysis: a path parameter or `$url.a.b` is refused as in a handler; typing
      // in a text field commits at each pause, a number field's burst of steps pushes once at its pause,
      // any other control pushes a history entry (location.ts: 2 typing, 3 burst, 4 push)
      const h = this.expr(el, 'data-sn-model', scope, { mode: 'handler', magic: ['$event'], urlKind: kind == 'text' ? 2 : kind == 'number' ? 3 : 4 }, `${attr(el, 'data-sn-model')!} = $event`);
      // typing and a number field's steps wait for a pause: the typing module, only on pages with such a model
      if (kind == 'text' || kind == 'number') this.features.add('typing');
      if (!h.ok) return;
      setter = this.fn(`($, v) => (${h.code})(Object.assign(Object.create($), { $event: v }))`);
    } else setter = this.fn(`($, v) => { ${r.code.slice('($) => ('.length, -1)} = v; }`);
    const b = this.binding({ k: 'model', n: kind, f: this.fn(r.code), a: setter, d: r.deps, w: [r.path.join('.')], ...usesEl(r) });
    if (persist !== undefined) {
      b.p = persist;
      this.persisted.add(r.path.slice(0, 2).join('.'));
    }
    node.b.push(b);
  }

  action(el: P5Element, node: NodeDef, scope: Scope, method: typeof METHODS[number] | 'call', get: (n: string) => string | undefined, inForm = false) {
    // arguments and body are taken when the trigger fires, so they see its event
    const call = method === 'call' ? this.callExpr(el, 'data-sn-call', scope, undefined, ['$event']) : null;
    if (method === 'call' && get('body') !== undefined) this.report(el, 'data-sn-body', 'SN102', '`data-sn-body` belongs to a method attribute; a call takes its arguments in `data-sn-call`', 0);
    const reads: Read[] = [];
    const url = method === 'call' ? [] : this.urlTemplate(el, `data-sn-${method}`, scope, {}, undefined, reads);
    const urlPath = this.lastPath;
    const tag = this.hostUse.get(el)?.root.tagName ?? el.tagName;
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
    // `sinter({ apis })`: the operation of the API the path calls (SN326, SN327); else matched by URL against the specs
    const target = method !== 'call' && this.opts.apis ? this.apiCheck(el, `data-sn-${method}`, method as Method, urlPath) : null;
    const op = target ? target.match : method !== 'call' && !this.opts.apis && this.opts.openapi?.length ? matchOperation(this.opts.openapi, url, method) : null;
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
    const retryAttr = get('retry')?.trim();
    if (retryAttr === '') this.report(el, 'data-sn-retry', 'SN401', '`data-sn-retry` takes the name of a retry policy from `configure({ retry })`, e.g. `data-sn-retry="drafts"`', 0);
    else if (retryAttr !== undefined && (method === 'call' || method === 'get')) this.report(el, 'data-sn-retry', 'SN102', method === 'get'
      ? '`data-sn-retry` belongs to a mutation (`data-sn-post`, `-put`, `-patch`, `-delete`): GETs use the policy `retry.get` names'
      : '`data-sn-retry` belongs to a mutation (`data-sn-post`, `-put`, `-patch`, `-delete`): a call may send several requests, so sinter cannot send it again', 0);
    const ap = method !== 'call' && method !== 'get' && applyAttr === undefined ? this.applyDef(reads, typed) : null;
    if (ap) {
      this.features.add('apply');
      if (then.r?.ast) this.redundantWrites(el, then.r, ap, url, method, typed?.path ?? null);
    }
    // server validation errors shown on the fields (fields.ts): forms that send a mutation and leave errors to sinter
    // (a form's own action, or a control's inside one, as the editor's Publish button in RealWorld)
    if ((isForm || (inForm && (tag === 'button' || FORM_CONTROLS.has(tag)))) && method !== 'call' && method !== 'get' && get('catch') === undefined) this.features.add('fields');
    // a form's own fields as the body, or form encoding: the form module (form.ts)
    if ((isForm && body.f === null && method !== 'call' && method !== 'get' && method !== 'delete') || (encoding === 'form' && method !== 'call')) this.features.add('form');
    // only what differs from the defaults: an attribute the page does not write costs no bytes
    // (the event is the `on` binding's; the runtime reads absent fields as null, 0, false, [])
    const w = [...new Set([...then.w, ...catch_.w])].sort();
    const def: ActionDef = {
      method: method.toUpperCase() as ActionDef['method'], url, concurrency,
      ...(body.f !== null ? { body: body.f } : {}),
      ...(debounce ? (this.features.add('debounce'), { debounce }) : {}),
      ...(optimistic.f !== null ? { optimistic: optimistic.f } : {}),
      ...(then.f !== null ? { then: then.f } : {}),
      ...(catch_.f !== null ? { catch: catch_.f } : {}),
      ...(w.length ? { w } : {}),
      ...(isForm ? { form: true } : {}),
      ...(call ? { call: { args: call.args, run: call.run } } : {}),
      ...(confirm.f !== null ? (this.features.add('confirm'), { confirm: confirm.f }) : {}),
      ...(encoding === 'form' ? { enc: 'form' as const } : {}),
      ...(ap ? { ap } : {}),
      ...(retryAttr && method !== 'call' && method !== 'get' ? { retry: retryAttr } : {}),
    };
    this.devAt(def, [def.then, def.catch]);
    this.actions.push(def);
    node.b.push(this.binding({ k: 'on', n: trigger, x: this.actions.length - 1 }));
  }

  /**
   * Write-through: what a mutation is about (the resources, rows and nested entities its URL and body
   * read) and what its response holds (objects of named schemas). Null when there is nothing to apply.
   */
  applyDef(reads: Read[], typed: { spec: number; body: unknown; request: unknown } | null): ApplyDef | null {
    const tg: ApplyDef['tg'] = [];
    const apBox: { ap: ApplyDef | null } = { ap: null };
    const apRef = () => apBox.ap!;
    const ap0 = apRef;
    const seen = new Set<string>();
    const add = (t: ApplyDef['tg'][number]) => { const k = `${t.r}\0${t.v ?? ''}\0${(t.p ?? []).join('.')}`; if (!seen.has(k)) { seen.add(k); tg.push(t); } };
    // rows with a source of their own: nested (`comments>replies`) at once, references once the page is compiled
    const direct: Read[] = [];
    for (const rd of reads) {
      if (!rd.src) { direct.push(rd); continue; }
      for (const x of rd.src) {
        if (x.startsWith('@')) { this.pendingTargets.push({ ap: ap0, rd, ref: x }); continue; }
        direct.push({ ...rd, resource: x });
      }
    }
    for (const rd0 of direct) {
      const [base, fields] = rd0.resource.split('>') as [string, string | undefined];
      const rd = { ...rd0, resource: base };
      const n = fields ? fields.split(',') : null;
      const info0 = this.itemSchema.get(base), doc = info0 ? this.opts.openapi![info0.spec]!.doc : null;
      // a nested item's schema: the item schema of its list, under the row's
      const info = info0 && n ? (() => { const s = nestedSchema(doc, info0.schema, n); return s ? { ...info0, schema: s } : null; })() : info0;
      if (n) {
        const root = info ? namedSchema(doc, info.schema) : null;
        add({ r: base, ...(rd.row ? { v: rd.row } : {}), n, ...(root ? { s: root.name } : {}) });
        for (let i = 1; info && i < rd.path.length; i++) {
          const s = namedAt(doc, info.schema, rd.path.slice(0, i));
          if (s) add({ r: base, ...(rd.row ? { v: rd.row } : {}), n, p: rd.path.slice(0, i), s });
        }
        this.features.add('nested');
        continue;
      }
      const root = info ? namedSchema(doc, info.schema) : null;
      add({ r: rd.resource, ...(rd.row ? { v: rd.row } : {}), ...(root ? { s: root.name } : {}) });
      // the named entities along the path: `article.author.username` is also about `article.author`, a Profile
      for (let i = 1; info && i < rd.path.length; i++) {
        const s = namedAt(doc, info.schema, rd.path.slice(0, i));
        if (s) add({ r: rd.resource, ...(rd.row ? { v: rd.row } : {}), p: rd.path.slice(0, i), s });
      }
    }
    if (!tg.length && !typed && !this.pendingTargets.some((x) => x.ap === ap0)) return null;
    const ap: ApplyDef = { tg };
    apBox.ap = ap;
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
   * `SN510`: a `then` write that write-through makes: `patch(item, $result.p)` (an item of `x`)/`upsert('x', $result.p)`
   * where the response's `p` is an object of `x`'s schema (an upsert also needs the action's URL to be the
   * list's URL, judged by the literal parts), and `remove(row)` on a DELETE of that row's URL.
   */
  redundantWrites(el: P5Element, then: ExprResult, ap: ApplyDef, url: UrlTemplate, method: string, opPath: string | null) {
    const lits = (t: UrlTemplate) => t.filter((x): x is string => typeof x === 'string');
    const src = (name: string) => this.resources.find((r) => r.name === name)?.src ?? null;
    const sameUrl = (name: string) => { const s = src(name); return !!s && lits(s).join('\0') === lits(url).join('\0'); };
    const rowUrl = (name: string) => { const s = src(name); if (!s) return false; const a = lits(url), b = lits(s); return a.length === b.length && a.slice(0, -1).join('\0') === b.slice(0, -1).join('\0') && a[a.length - 1] === b[b.length - 1] + '/'; };
    const fix = 'remove this write, or add `data-sn-apply="off"` to keep it';
    const op = opPath ? `the response of \`${method.toUpperCase()} ${opPath}\`` : 'the response';
    const visit = (n: acorn.AnyNode) => {
      const fn = n.type === 'CallExpression' && n.callee.type === 'Identifier' ? n.callee.name : null;
      // upsert names its resource; patch and remove take the item, whose one source is the resource
      const item = fn === 'patch' || fn === 'remove' ? then.itemCalls?.find((c) => c.start === n.start)?.src : null;
      const name = fn === 'upsert' && n.type === 'CallExpression' && n.arguments[0]?.type === 'Literal' && typeof n.arguments[0].value === 'string' ? n.arguments[0].value
        : item?.length === 1 && !item[0]!.startsWith('@') ? item[0]! : null;
      if (n.type === 'CallExpression' && fn && name) {
        const r = this.resources.find((x) => x.name === name);
        const first = n.arguments[0]!, value = n.arguments[fn === 'remove' ? 0 : 1];
        const itemText = (then.ast && 'start' in first) ? (attr(el, 'data-sn-then') ?? '').slice((first as acorn.Node).start, (first as acorn.Node).end) : '…';
        const resultPath = value && value.type === 'MemberExpression' && !value.computed && value.object.type === 'Identifier' && value.object.name === '$result' && value.property.type === 'Identifier' ? value.property.name
          : value && value.type === 'Identifier' && value.name === '$result' ? '' : null;
        const entry = resultPath != null ? ap.rs?.find((e) => e.p === resultPath && !e.a) : undefined;
        if (r && entry && r.sch === entry.s && fn === 'patch' && (r.key || ap.tg.some((t) => t.r === name && t.s === entry.s))) {
          this.report(el, 'data-sn-then', 'SN510', `\`patch(${itemText}, $result${resultPath ? '.' + resultPath : ''})\` is what write-through does: ${op} is \`${entry.s}\`, which \`${name}\` holds; ${fix}`, n.start);
        } else if (r && entry && r.sch === entry.s && fn === 'upsert' && r.key && sameUrl(name)) {
          this.report(el, 'data-sn-then', 'SN510', `\`upsert('${name}', $result${resultPath ? '.' + resultPath : ''})\` is what write-through does: a POST to \`${name}\`'s URL inserts ${op}'s \`${entry.s}\`; ${fix}`, n.start);
        } else if (r && fn === 'remove' && method === 'delete' && value?.type === 'Identifier' && ap.tg.some((t) => t.r === name && t.v === (value as acorn.Identifier).name && !t.p) && rowUrl(name)) {
          this.report(el, 'data-sn-then', 'SN510', `\`remove(${(value as acorn.Identifier).name})\` is what write-through does: a DELETE of a row's URL removes the row; ${fix}`, n.start);
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
    this.templateAt.set(tid, { el, attr: 'data-sn-for', shift: 0 });
    const t = this.templates[tid]!;
    const ii = `$i${tid}`;
    t.item = item;
    t.index = index;
    t.ii = ii;
    const resInfo = list.resource ? this.page.resources.get(list.resource) : undefined;
    const alias = list.path && list.path[0]!.startsWith('$s') ? [...list.path, `{${ii}}`] : null;
    // in a component, the runtime names are the template's own, so a prop read in a row cannot resolve to a row of the component's
    // (only where a loop around it has the name: a row's functions stay the same across uses and pages)
    const taken = scope.component?.runtime, clash = (n: string) => taken === 'all' || !!taken?.has(n) || scope.loops.some((l) => (l.rt ?? l.name) === n);
    const rt = (n: string) => (scope.component && clash(n) ? { rt: `${n}$${tid}` } : {});
    const loops: LoopEntry[] = [...scope.loops, { name: item, kind: 'item', alias, resource: list.resource, ...(list.resources ? { resources: list.resources } : {}), ...rt(item), src: list.listOf ?? null }];
    if (index) loops.push({ name: index, kind: 'index', alias: null, resource: null, of: alias, ...rt(index) });
    if (scope.component && clash(item)) t.item = `${item}$${tid}`;
    if (scope.component && index && clash(index)) t.index = `${index}$${tid}`;
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
    node.b.push(this.binding({ k: 'for', f: this.fn(list.code), d: deps, x: tid, ...usesEl(list) }));
    return { tid, scope: inner };
  }

  urlTemplate(el: P5Element, attrName: string, scope: Scope, exprOpts: Partial<ExprOptions> = {}, deps?: Set<string>, reads?: Read[]): UrlTemplate {
    const value = attr(el, attrName) ?? '';
    const parts: UrlTemplate = [];
    // `sinter({ apis })`: `[api:]/path`, relative to the API's base
    const apis = this.opts.apis;
    let api: ApiDef | null = null, i = 0;
    if (apis) {
      if (/^https?:\/\//i.test(value)) {
        const own = apis.list.filter((a) => a.base && value.toLowerCase().startsWith(a.base.toLowerCase()) && /^([/?#]|$)/.test(value.slice(a.base.length)))
          .sort((a, b) => b.base.length - a.base.length)[0];
        const rel = own ? `${own.name === apis.defaultApi ? '' : own.name + ':'}${value.slice(own.base.length) || '/'}` : null;
        this.report(el, attrName, 'SN328', `\`${value.replace(/\{[\s\S]*$/, '…')}\` names ${own ? `the origin of the API \`${own.name}\`` : 'an origin'}: ${rel ? `write \`${rel}\`` : 'with `sinter({ apis })`, a page writes paths relative to an API'}`, 0,
          rel ? 'the origin and path prefix are the API\'s `base`' : 'add an API with this origin as its `base` to `sinter({ apis })`');
      } else {
        const r = apiOf(apis, value);
        if ('error' in r) this.report(el, attrName, 'SN326', r.error, 0);
        else api = r.api;
        i = r.prefix;
      }
    }
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
    if (typeof first !== 'string' || !(/^\/[^/\\]/.test(first) || first === '/' || (!api && origin.test(first)))) {
      this.report(el, attrName, 'SN207', api ? 'a path to an API must start with a literal `/` (`/contacts/{c.id}`)' : 'a URL template must start with a literal same-origin path (`/api/…`) or a literal `https://` origin (with a `/` after the host when a value follows)', 0,
        'a leading interpolation or `//` lets a value choose the host');
    }
    this.lastPath = parts.slice();
    if (api && api.base && typeof parts[0] === 'string') parts[0] = api.base + parts[0];
    return parts;
  }

  /** the path (without the API's base) of the last `urlTemplate` */
  lastPath: UrlTemplate = [];
  /** the API each resource's `src` goes to (`sinter({ apis })`): its request settings for preloads, the early file and embedding */
  readonly apiOfResource = new Map<string, ApiDef>();

  /** a resource's API's credentials and static headers, as the early file sends them; null for the defaults */
  settingsOf(name: string): { c?: RequestCredentials; h?: Record<string, string> } | null {
    const a = this.apiOfResource.get(name);
    return a && (a.credentials || a.headers) ? { ...(a.credentials ? { c: a.credentials } : {}), ...(a.headers ? { h: a.headers } : {}) } : null;
  }

  /**
   * `<link rel="preload" as="fetch">` for the resources whose URL is fixed at build time. A link cannot
   * carry headers, so a resource of an API with static headers (or `credentials: 'omit'`) has none, and
   * the early file's request is its first; `credentials: 'include'` is `crossorigin="use-credentials"`.
   */
  preloadLinks(): string[] {
    const ok = this.resources.filter((r) => {
      const a = this.apiOfResource.get(r.name);
      return !this.noEarly.has(r.name) && fixedRequest(r) && this.earlyOrigin(r.src) && !a?.headers && a?.credentials !== 'omit';
    });
    const include = (r: ResourceDef) => this.apiOfResource.get(r.name)?.credentials === 'include';
    const esc = (v: string) => v.replace(/[&"<>]/g, (c) => `&#${c.charCodeAt(0)};`);
    const link = (cross: string) => ({ url, lo }: { url: string; lo: boolean }) => `<link rel="preload" as="fetch" ${cross} href="${esc(url)}"${lo ? ' fetchpriority="low"' : ''}>`;
    return [...preloads(ok.filter((r) => !include(r))).map(link('crossorigin')), ...preloads(ok.filter(include)).map(link('crossorigin="use-credentials"'))];
  }

  /** The operation of an API a path calls with this method, and its configured shape; null without `apis`. */
  apiTarget(el: P5Element, attrName: string, method: Method): { api: ApiDef; match: OpenApiMatch | { closest: string | null }; shape: OperationShape | null } | null {
    const apis = this.opts.apis;
    const value = attr(el, attrName);
    if (!apis || value == null || /^https?:\/\//i.test(value)) return null;
    const r = apiOf(apis, value);
    if ('error' in r) return null;
    const match = matchOperation(this.opts.openapi ?? [], shapeTemplate(r.path), method, r.api.specs);
    const shape = 'path' in match ? r.api.shapes[`${method.toUpperCase()} ${match.path}`] ?? null : null;
    return { api: r.api, match, shape };
  }

  /**
   * A path to a configured API: the operation it calls (SN326), and its query parameters (SN327).
   * `extra`: the query parameters sinter adds itself (`paginate`'s), which count as given and must be declared too.
   */
  apiCheck(el: P5Element, attrName: string, method: Method, path: UrlTemplate, extra: string[] = []): { api: ApiDef; match: OpenApiMatch; shape: OperationShape | null } | null {
    const t = this.apiTarget(el, attrName, method);
    if (!t) return null;
    const raw = attr(el, attrName) ?? '';
    const label = (p: string) => `\`${method.toUpperCase()} ${p}\``;
    if (!('path' in t.match)) {
      const shown = shapeTemplate(raw.slice(raw.indexOf('/'))).map((p) => (typeof p === 'string' ? p : '{…}')).join('').split('?')[0]!;
      this.report(el, attrName, 'SN326', `${label(shown)} is no operation of the API \`${t.api.name}\`.${t.match.closest ? ` Did you mean \`${t.match.closest}\`?` : ''}`, 0,
        t.api.specs.length ? 'declare an endpoint the spec does not have in the API\'s `operations`' : `the API \`${t.api.name}\` declares its endpoints in \`operations\``);
      return null;
    }
    const m = t.match;
    const declared = [...m.query, ...(t.shape?.query ?? [])];
    const given = new Set<string>();
    const at = raw.indexOf('?');
    const fromPath = queryNames(path);
    for (const q of [...fromPath, ...extra.filter((x) => !fromPath.includes(x))]) {
      const deep = /^([^[]+)\[/.exec(q)?.[1];
      const name = deep && m.deep.includes(deep) ? deep : q;
      given.add(name);
      if (declared.includes(name)) continue;
      const mine = !fromPath.includes(q);
      this.report(el, mine ? 'paginate' : attrName, 'SN327', `${label(m.path)} of the API \`${t.api.name}\` declares no query parameter \`${q}\`${mine ? ' (sent by `paginate`)' : ''}.${didYouMean(q, declared)}`, mine ? 0 : Math.max(raw.indexOf(q + '=', at), 0),
        declared.length ? `it declares ${declared.map((d) => `\`${d}\``).join(', ')}` : 'it declares no query parameters');
    }
    const missing = m.required.filter((r) => !given.has(r));
    if (missing.length) this.report(el, attrName, 'SN327', `${label(m.path)} of the API \`${t.api.name}\` needs the query parameter${missing.length > 1 ? 's' : ''} ${missing.map((x) => `\`${x}\``).join(', ')}`, 0);
    return { api: t.api, match: m, shape: t.shape };
  }

  // ---- declaration elements

  resource(el: P5Element, ctx: Ctx) {
    this.remove.push(el);
    const name = attr(el, 'name');
    if (!name || !this.page.resources.has(name) || this.resourceEls.get(name) !== el) return;
    if (ctx.tid >= 0) return;
    for (const a of el.attrs) {
      if (a.name === 'start-page') this.report(el, a.name, 'SN401', '`start-page` is renamed to `page-model` (offset lists, a query parameter), which also writes the page back', 0);
      else if (!RESOURCE_ATTRS.includes(a.name)) this.report(el, a.name, 'SN101', `\`${a.name}\` is not an attribute of \`<sn-resource>\`.${didYouMean(a.name, RESOURCE_ATTRS)}`, 0);
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
    const srcPath = this.lastPath;
    // `method="POST"`: an endpoint that loads data with a request body (search, reports); its body is a value, reloaded when it changes
    const methodAttr = attr(el, 'method')?.trim();
    const post = methodAttr === 'POST';
    if (methodAttr != null && !post && methodAttr !== 'GET') this.report(el, 'method', 'SN401', '`method` is `POST` (or `GET`, the default)', 0);
    if (attr(el, 'body') != null && !post) this.report(el, 'body', 'SN102', '`body` needs `method="POST"`: a GET request has no body', 0);
    if (post) {
      if (hasCall) this.report(el, 'method', 'SN102', '`method` is for a resource with `src`', 0);
      for (const a of ['cache', 'paginate', 'each']) {
        if (attr(el, a) != null) this.report(el, a, 'SN401', a === 'cache' ? '`cache` does not combine with `method="POST"`: a cached search or report would outlive the request that asked for it' : `\`${a}\` does not combine with \`method="POST"\``, 0);
      }
      // started by the page module only: not preloaded, requested early, prefetched or embedded
      this.noEarly.add(name);
    }
    const call = hasCall ? this.callExpr(el, 'call', ctx.scope, deps) : null;
    let when: number | null = null;
    if (attr(el, 'when') != null) {
      const r = this.expr(el, 'when', ctx.scope, { mode: 'value', cond: true });
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
          if (mode === 'append') this.report(el, 'offset-param', 'SN401', '`offset-param` applies to `paginate="offset"` (the items to skip, sent instead of `page-param`) and `paginate="keyset"` (to jump); append mode only loads more', 0);
          else if (!/^[\w.\-\[\]]+$/.test(offsetParam)) this.report(el, 'offset-param', 'SN401', '`offset-param` is a query parameter name', 0);
          else paginate.offsetParam = offsetParam;
        }
        // `page-model="$url.page"`: the list's page lives in the URL, read at load and written back on every move
        const pm = attr(el, 'page-model');
        if (pm != null) {
          const name = /^\s*\$url\.([A-Za-z_$][\w$]*)\s*$/.exec(pm)?.[1];
          if (mode !== 'offset') {
            this.report(el, 'page-model', 'SN401', `\`page-model\` applies to \`paginate="offset"\`, where every move has a page number when it is made; ${mode === 'append' ? 'append lists load more by cursor' : 'keyset lists move by cursor, and their page number is often unknown'}`, 0);
          } else if (!name || this.page.pathParams.has(name)) {
            this.report(el, 'page-model', 'SN203', name ? `\`page-model\` takes a URL query parameter such as \`$url.page\`; \`$url.${name}\` is a path parameter (\`data-sn-path\`)` : '`page-model` takes a URL parameter such as `$url.page`', 0);
          } else if ([...deps].some((d) => d === '$url' || d === `$url.${name}` || d.startsWith(`$url.${name}.`))) {
            this.report(el, 'page-model', 'SN401', `\`$url.${name}\` is this resource's page (\`page-model\`), and its \`src\` or \`when\` reads it too: each page would reset the list; read another parameter there`, 0);
          } else {
            // the read is the compiled `$url.<name>`, where the early file, preloads and embedded data read the start page
            paginate.start = this.fn(`($) => ($.$url.${name})`);
            paginate.model = name;
            deps.add(`$url.${name}`);
            this.pageModels.push({ name, report: (m) => this.report(el, 'page-model', 'SN203', m, 0) });
            this.page.writesUrl = true;
          }
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
    for (const a of ['page-size', 'size-param', 'cursor', 'direction-param', 'direction-values', 'page-param', 'offset-param', 'page-model']) {
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
    // `refresh="30s"`: reloaded once this long has passed since its last load, of any cause
    let refresh: number | undefined;
    const refreshAttr = attr(el, 'refresh');
    if (refreshAttr != null) {
      const m = /^\s*(\d+)\s*(s|m|h)\s*$/.exec(refreshAttr);
      const ms = m ? Number(m[1]) * { s: 1e3, m: 6e4, h: 36e5 }[m[2] as 's' | 'm' | 'h'] : 0;
      if (!m) this.report(el, 'refresh', 'SN401', '`refresh` takes the longest time between loads, such as `30s`, `5m` or `1h`', 0);
      else if (ms < 1000) this.report(el, 'refresh', 'SN401', '`refresh` must be at least `1s`', 0);
      else {
        refresh = ms;
        this.features.add('refresh');
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
    // `sinter({ apis })`: the operation the path calls, and what the config says it returns (said once)
    const target = this.opts.apis && !hasCall ? this.apiCheck(el, 'src', post ? 'post' : 'get', srcPath, paginate ? paginateParams(paginate, attr(el, 'cursor')) : []) : null;
    if (target) this.apiOfResource.set(name, target.api);
    const shape = target?.shape ?? null;
    const shaped = (a: 'items' | 'total' | 'key' | 'type'): string | null => {
      const v = attr(el, a)?.trim(), c = shape?.[a];
      if (c != null && v != null) {
        const where = `\`${target!.api.name}.${target!.match.spec === target!.api.specs[target!.api.specs.length - 1] && this.opts.openapi![target!.match.spec]!.config ? 'operations' : 'defaults'}\``;
        if (v === c) this.report(el, a, 'SN518', `\`${a}\` of \`GET ${target!.match.path}\` is configured as \`${c}\` (${where}): remove it here`, 0);
        else this.report(el, a, 'SN330', `\`${a}\` of \`GET ${target!.match.path}\` is \`${c}\` (${where}), not \`${v}\`: every page reads one shape from an endpoint`, 0, 'remove the attribute, or change the configured value');
      }
      return c ?? v ?? null;
    };
    const items = shaped('items'), total = shaped('total');
    shaped('key');
    const type = shaped('type');
    // an operation the config declares has no schema: its type is the config's
    const generated = target ? !!this.opts.openapi![target.match.spec]!.config : false;
    const openapi = type || hasCall || generated ? null : this.openapi(el, src, items, total, target?.match, post ? 'post' : 'get');
    let body: number | null = null;
    if (post && attr(el, 'body') != null) {
      const m = target?.match ?? (!this.opts.apis && this.opts.openapi?.length ? matchOperation(this.opts.openapi, src, 'post') : null);
      const r = this.expr(el, 'body', ctx.scope, { mode: 'value' });
      if (m && 'request' in m && m.request != null) this.typeLast({ returns: { kind: 'openapi', spec: m.spec, schema: m.request } });
      for (const d of r.deps) deps.add(d);
      if (r.ok) body = this.fn(r.code);
    }
    const sch = openapi && 'schema' in openapi ? namedSchema(this.opts.openapi![openapi.spec]!.doc, openapi.schema) : null;
    if (openapi && 'schema' in openapi) this.itemSchema.set(name, { spec: openapi.spec, schema: sch?.array ? (openapi.schema as { items: unknown }).items : openapi.schema });
    // a list of objects without `key` is one object holding the array: nothing can change one of its items
    if (openapi && 'schema' in openapi && !info.key && !each) {
      const doc = this.opts.openapi![openapi.spec]!.doc;
      const list = deref(doc, openapi.schema);
      const item = list?.type === 'array' ? deref(doc, list.items) : null;
      const fields = item ? propertyNames(doc, item) : [];
      if (item && (item.type === 'object' || fields.length)) {
        const at = items;
        this.report(el, attr(el, 'items') != null ? 'items' : 'name', 'SN517', `\`${openapi.label}\` returns a list${at ? ` at \`${at}\`` : ''}: resource \`${name}\` has no \`key\`, so it is one object holding the list`, 0,
          `add \`key\` with the field that identifies an item${fields.length ? ` (its items have ${fields.map((f) => `\`${f}\``).join(', ')})` : ''}; a list that is only read can stay as it is`);
      }
    }
    if (this.check) {
      const r: CheckResource = { name, type, loc: this.locOf(el, type ? 'type' : null), nameLoc: this.locOf(el, 'name') };
      if (openapi && 'schema' in openapi) r.openapi = openapi;
      if (call) r.call = { name: call.name, items };
      if (paginate?.mode === 'keyset' && !paginate.offsetParam) r.directions = true;
      this.check.resources.push(r);
      // a resource fed by an action is typed by the action's result
      if (!type && !r.openapi && !r.call) {
        const hint = target
          ? `\`GET ${target.match.path}\` has no JSON response type: add \`type\` for it in \`${target.api.name}.${generated ? 'operations' : 'defaults'}\``
          : openapi && 'closest' in openapi
          ? `no OpenAPI GET operation matches \`src\`${openapi.closest ? ` (closest path: \`${openapi.closest}\`)` : ''}; add \`type="…"\`, or \`type="any"\` to leave it unchecked`
          : 'add `type="…"` with a type from the types module, or `type="any"` to leave it unchecked';
        this.report(el, null, 'SN504', `resource \`${name}\` has no type: expressions using it are not checked`, 0, hint);
      }
    }
    this.resources.push({
      ...(this.opts.dev && then ? this.devAtOf([then.f]) : {}),
      name, src, key: info.key, items, total,
      order: order ? order.trim() : null, when, paginate, deps: [...deps].sort(), scope: ctx.stateIdx, data: null,
      ...(cache !== undefined ? { cache } : {}),
      ...(refresh !== undefined ? { refresh } : {}),
      ...(each ? { each } : {}),
      ...(call ? { call: { args: call.args, run: call.run } } : {}),
      ...(then ? { then: then.f, ...(then.w.length ? { w: then.w } : {}) } : {}),
      ...(sch ? { sch: sch.name } : {}),
      ...(body != null ? { body } : {}),
    });
    this.declAt.set(this.resources[this.resources.length - 1]!, el);
  }

  /** Matches a resource against the OpenAPI specs; checks `items`, `total` and query parameter names. */
  openapi(el: P5Element, src: UrlTemplate, items: string | null, total: string | null, matched?: OpenApiMatch, method: Method = 'get'):
    { spec: number; label: string; schema: unknown } | { closest: string | null } | null {
    const specs = this.opts.openapi;
    if (!specs?.length) return null;
    const m = matched ?? (method === 'get' ? matchResource(specs, src) : matchOperation(specs, src, method));
    if ('closest' in m) return m;
    const doc = specs[m.spec]!.doc;
    const label = `${method.toUpperCase()} ${m.path}`;
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
    // a configured API checked the query (SN327)
    if (!matched) for (const q of queryNames(src)) {
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
    // a stream of a configured API is an operation it declares (`operations`, as specs rarely describe streams)
    if (this.opts.apis) this.apiCheck(el, 'src', 'get', this.lastPath);
    const events: EventDef[] = [];
    for (const c of el.childNodes) {
      if (!isElement(c)) {
        if (c.nodeName === '#text' && (c as DefaultTreeAdapterMap['textNode']).value.trim()) this.report(el, null, 'SN102', '`<sn-sync>` may only contain `<sn-event>` elements', 0);
        continue;
      }
      if (c.tagName !== 'sn-event') { this.report(c, null, 'SN102', '`<sn-sync>` may only contain `<sn-event>` elements', 0); continue; }
      const ev = this.event(c, ctx);
      if (ev) { this.devAt(ev, [ev.then]); events.push(ev); }
    }
    this.syncs.push({ src, events, ...(ctx.stateIdx >= 0 ? { scope: ctx.stateIdx } : {}) });
    this.declAt.set(this.syncs[this.syncs.length - 1]!, el);
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
    /** `tpl`: in a template's content, written there only when it can never change; `if`: a condition decided for a second pass; `for`: a loop unrolled in it */
    type Cand = { el: P5Element; b: Binding; f: number; tpl?: true; if?: true; for?: true };
    const cands: Cand[] = [];
    const written = this.writtenState();
    const fixed = (ds: PathRef[] | undefined) => strs(ds).every((d) => {
      const m = /^\$s(\d+)\.([^.]+)/.exec(d);
      return !!m && m[2] !== '*' && m[2] !== '**' && !written.has(`$s${m[1]}`) && !written.has(`$s${m[1]}.${m[2]}`);
    });
    const value = (el: P5Element, b: Binding, tpl: boolean) => {
      if (b.f === undefined || b.e || !['text', 'attr', 'class', 'style', 'show', 'model'].includes(b.k)) return;
      if (b.k === 'class' && !b.n) return;
      if (b.k === 'text' && el.childNodes.some(isElement)) return;
      if (b.k === 'model' && (tpl || !['checkbox', 'radio', 'text', 'number'].includes(b.n!))) return;
      if (tpl && (b.w?.length || !fixed(b.d))) return;
      cands.push({ el, b, f: b.f, ...(tpl ? { tpl: true as const } : {}) });
    };
    const decide = (el: P5Element, b: Binding) => {
      if (this.opts.decided || b.k !== 'if' || b.f === undefined || !fixed(b.d) || !this.siteKey(el)) return;
      cands.push({ el, b, f: b.f, if: true });
    };
    // a loop over a constant list whose rows need nothing at run time: each row's bindings read only the item, its
    // index, constants and state nothing writes (no handler, model, state, nested template, `$el`, component script)
    const ROW = new Set(['text', 'attr', 'class', 'style', 'show']);
    const unroll = (el: P5Element, b: Binding) => {
      if (this.opts.unrolled || b.k !== 'for' || b.f === undefined || b.e || !fixed(b.d) || !this.unrollKey(el)) return;
      const t = this.templates[b.x!];
      if (!t) return;
      if (!t.nodes.every((n) => n.state === undefined && n.sid === undefined && n.b.every((x) => ROW.has(x.k) && !x.e && !x.w?.length && fixed(x.d)))) return;
      cands.push({ el, b, f: b.f, for: true });
    };
    for (const { el, node } of this.paints) for (const b of node.b) { value(el, b, false); decide(el, b); unroll(el, b); }
    for (const [node, el] of this.tplEls) for (const b of node.b) { value(el, b, true); decide(el, b); }
    if (!cands.length) return;
    // everything the page could call is shadowed: what is not a constant throws
    const NOT = new Error('not a build-time constant');
    const stub = new Proxy(function () {}, { apply() { throw NOT; }, get() { throw NOT; } });
    const params = new Map<string, unknown>([['$k', $k]]);
    // (`location`: the browser's, as in a pattern page's `$canonical`; a test environment may have one)
    for (const h of ['Date', 'Intl', 'Math', 'location', 'date', 'time', 'datetime', 'relative', 'number', 'bytes', ...this.opts.helpers.names]) params.set(h, stub);
    // a page built in one language: what depends only on the language is written as the browser would. A calendar
    // date (`2026-11-11`) is the same day everywhere; a moment (`…T09:00Z`) is the visitor's time zone's
    const lang = this.opts.locale?.name;
    if (lang) {
      // the browser's own formatters, with the page's language as the locale for the call
      const inLang = <T>(f: () => T): T => { const was = config.locale; config.locale = { get: () => lang, set: () => {} }; try { return f(); } finally { config.locale = was; } };
      params.set('number', (v: unknown, o?: Intl.NumberFormatOptions) => inLang(() => number(v, o)));
      params.set('bytes', (v: unknown) => inLang(() => bytes(v)));
      params.set('date', (v: unknown, style?: 'full' | 'long' | 'medium' | 'short') => { if (!isCalendarDate(v)) throw NOT; return inLang(() => date(v, style)); });
    }
    for (const [ns, { members }] of Object.entries(this.opts.helpers.namespaces)) for (const m of members) params.set(`${ns}$${m}`, stub);
    // the base language's text, for a text binding: the binding is marked and stays the browser's
    const base = this.opts.baseMessages;
    let usedMessage = false;
    const msgNs = base ? Object.entries(this.opts.helpers.namespaces).find(([, v]) => v.module === '@tiaforge-ui/sinter/messages') : undefined;
    if (base && msgNs) for (const m of msgNs[1].members) {
      params.set(`${msgNs[0]}$${m}`, (p?: Record<string, unknown>) => {
        const t = base[m];
        if (typeof t !== 'string') throw NOT;
        usedMessage = true;
        return p ? t.replace(/\{(\w+)\}/g, (x, n) => (n in p ? String(p[n]) : x)) : t;
      });
    }
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
      // a message re-renders on `$locale`: its base text is what is written
      if (d === '$locale' && msgNs) return true;
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
      own = c.b.k === 'model' && c.b.p !== undefined ? (c.b.w![0] as string).split('.').slice(0, 2).join('.') : null;
      usedMessage = false;
      const v = known(strs(c.b.d)) ? run(this.fns[c.f]!) : FAIL;
      if (c.for) {
        // the same template in two uses (a component's markup on one line): unrolled only when they agree
        const key = this.unrollKey(c.el)!;
        const n = Array.isArray(v) && v.length <= MAX_UNROLL && v.every((x) => plainData(x)) ? v.length : -1;
        if (n < 0 || (usedMessage && !this.opts.locale) || this.notUnrolled.has(key) || (this.unrolls.has(key) && this.unrolls.get(key) !== n)) { this.unrolls.delete(key); this.notUnrolled.add(key); continue; }
        this.unrolls.set(key, n);
        this.foldReads.set(key, this.stateSites(c.b.d));
        continue;
      }
      if (c.if) {
        // the same template in every use (a component's markup): decided only when they agree
        const key = this.siteKey(c.el)!;
        if (v === FAIL || usedMessage) { this.decided.delete(key); this.undecided.add(key); continue; }
        if (this.undecided.has(key)) continue;
        if (this.decided.has(key) && this.decided.get(key) !== !!v) { this.decided.delete(key); this.undecided.add(key); continue; }
        this.decided.set(key, !!v);
        this.foldReads.set(key, this.stateSites(c.b.d));
        continue;
      }
      // in a page built in one language a message is that language's text, a constant like any other
      const msg = usedMessage && !this.opts.locale;
      if (c.tpl && (v === FAIL || msg)) continue;
      if (msg && c.b.k !== 'text') continue;
      const w = v === FAIL ? FAIL : firstPaintValue(c.el, c.b, v, schemes);
      if (w === FAIL) continue;
      writeFirstPaint(c.el, w[0], c.b.n ?? null, w[1]);
      if (c.tpl) { this.tplPainted.add(c.b); continue; }
      if (msg) { setAttr(c.el, 'data-sn-m', ''); continue; }
      // a persisted model's written value is the fallback: the early chunk still applies the stored one
      if (own === null) this.painted.add(c.b);
    }
  }

  /** The second pass: each decided `data-sn-if` template becomes its branch (or the `data-sn-else` after it), or nothing. */
  foldDecided(parent: P5Parent) {
    const real = (c: P5Node) => isElement(c) || (c.nodeName === '#text' && (c as DefaultTreeAdapterMap['textNode']).value.trim() !== '');
    for (let i = 0; i < parent.childNodes.length; i++) {
      const c = parent.childNodes[i]!;
      if (!isElement(c)) continue;
      const key = c.tagName === 'template' && attr(c, 'data-sn-if') !== undefined ? this.siteKey(c) : null;
      const v = key ? this.opts.decided!.get(key) : undefined;
      if (v !== undefined) {
        const j = parent.childNodes.findIndex((x, k) => k > i && real(x));
        const other = j >= 0 && isElement(parent.childNodes[j]!) && (parent.childNodes[j] as P5Element).tagName === 'template' && attr(parent.childNodes[j] as P5Element, 'data-sn-else') !== undefined ? parent.childNodes[j] as P5Element : null;
        const keep = [...(v ? (c as P5Template).content.childNodes : other ? (other as P5Template).content.childNodes : [])];
        for (const n of keep) (n as { parentNode: P5Parent }).parentNode = parent;
        this.inheritSlot(c, keep);
        parent.childNodes.splice(i, (other ? j : i) - i + 1, ...(keep as never[]));
        mergeText(parent);
        i--;
        continue;
      }
      this.foldDecided(c);
      if (c.tagName === 'template') this.foldDecided((c as P5Template).content);
    }
  }

  /**
   * A `data-sn-for` template, the same in both passes: where it was written and the uses of the components
   * it is in (a component used on two lines of a page has two), or null for one the compiler made.
   */
  unrollKey(el: P5Element): string | null {
    const at = this.siteKey(el);
    return at && `${at}|${(this.origins.get(el)?.chain ?? []).join('<')}`;
  }

  /**
   * The second pass: each unrolled `data-sn-for` template becomes its rows, one copy of its content per
   * item. The top-level elements of each copy get the item and index as derived names (`rowOf`), so
   * their bindings are constants, written into the HTML and left out of the page module.
   */
  unrollLoops(parent: P5Parent) {
    for (let i = 0; i < parent.childNodes.length; i++) {
      const c = parent.childNodes[i]!;
      if (!isElement(c)) continue;
      const value = c.tagName === 'template' ? attr(c, 'data-sn-for') : undefined;
      const key = value !== undefined ? this.unrollKey(c) : null;
      const n = key ? this.opts.unrolled!.get(key) : undefined;
      const m = n !== undefined ? /^\s*(?:\(\s*([A-Za-z_][\w]*)\s*,\s*([A-Za-z_][\w]*)\s*\)|([A-Za-z_][\w]*))\s+in\s+/.exec(value!) : null;
      if (m) {
        const rows: P5Node[] = [];
        for (let k = 0; k < n!; k++) {
          for (const x of (c as P5Template).content.childNodes) {
            const copy = this.cloneTree(x, parent);
            if (isElement(copy)) this.rowOf.set(copy, { tpl: c, item: (m[1] ?? m[3])!, index: m[2] ?? null, list: value!.slice(m[0].length), offset: m[0].length, k });
            rows.push(copy);
          }
        }
        this.inheritSlot(c, rows);
        parent.childNodes.splice(i, 1, ...(rows as never[]));
        mergeText(parent);
        i += rows.length - 1;
        continue;
      }
      this.unrollLoops(c);
      if (c.tagName === 'template') this.unrollLoops((c as P5Template).content);
    }
  }

  /**
   * Nodes that take the place of `from` (a decided `data-sn-if`'s branch, an unrolled loop's rows): when
   * `from` was slot content, so are they, in the scope of the caller that wrote them and outside the
   * component's scoped styles.
   */
  inheritSlot(from: P5Element, nodes: P5Node[]) {
    const use = this.slotOf.get(from);
    if (!use) return;
    const el = this.slotEls.find((x) => x.el === from);
    for (const n of nodes) {
      if (this.slotOf.has(n)) continue;
      this.slotOf.set(n, use);
      if (el && isElement(n)) this.slotEls.push({ ...el, el: n });
    }
  }

  /** A copy of markup that compiles as the original: its source locations, origins, slot content and component uses. */
  cloneTree(node: P5Node, parent: P5Parent): P5Node {
    const copy = { ...node, parentNode: parent } as P5Node;
    for (const map of [this.origins, this.slotOf, this.useOf] as Array<WeakMap<object, unknown>>) if (map.has(node)) map.set(copy, map.get(node));
    if (!('childNodes' in node)) return copy;
    const el = copy as P5Element;
    if ('attrs' in node) el.attrs = (node as P5Element).attrs.map((a) => ({ ...a }));
    el.childNodes = (node as P5Element).childNodes.map((x) => this.cloneTree(x, el)) as never[];
    if ((node as P5Element).nodeName === 'template') {
      const content = { ...(node as P5Template).content } as P5Template['content'];
      content.childNodes = (node as P5Template).content.childNodes.map((x) => this.cloneTree(x, content)) as never[];
      (el as P5Template).content = content;
    }
    return copy;
  }

  /** Where an element was written, the same in both passes: its file and offset, or null for one the compiler made. */
  siteKey(el: P5Element): string | null {
    const at = el.sourceCodeLocation?.startOffset;
    return at === undefined ? null : `${this.origins.get(el)?.file ?? this.opts.file}:${at}`;
  }

  /**
   * A binding `prerender()` wrote into the HTML that reads nothing (no data, URL or language) but
   * state nothing writes can never change: the page module leaves it out, with its function when
   * nothing else uses it, and its node when nothing else is bound there (`data-sn` too). The roots
   * after it are renumbered.
   */
  dropConstants() {
    const written = this.writtenState();
    // a state field no write reaches keeps its first value, which the HTML has
    const fixed = (d: string) => {
      const m = /^\$s(\d+)\.([^.]+)/.exec(d);
      return !!m && m[2] !== '*' && m[2] !== '**' && !written.has(`$s${m[1]}`) && !written.has(`$s${m[1]}.${m[2]}`);
    };
    const drop = (b: Binding) => this.painted.has(b) && !b.w?.length && b.k !== 'model' && strs(b.d).every(fixed);
    const gone = new Set<NodeDef>();
    for (const { el, node } of this.paints) {
      const keep = node.b.filter((b) => !drop(b));
      if (keep.length === node.b.length) continue;
      for (const b of node.b) if (drop(b)) { if (b.f !== undefined) this.fnUses[b.f]!--; this.freeze(b.d); }
      node.b = keep;
      if (!keep.length && node.state === undefined && node.sid === undefined) {
        gone.add(node);
        el.attrs = el.attrs.filter((a) => a.name !== 'data-sn');
      }
    }
    // in templates: what was written into the template's markup, and nodes left with nothing
    for (const t of this.templates) {
      const out = new Set<NodeDef>();
      for (const node of t.nodes) {
        if (!node.b.some((b) => this.tplPainted.has(b))) continue;
        for (const b of node.b) if (this.tplPainted.has(b)) { if (b.f !== undefined) this.fnUses[b.f]!--; this.freeze(b.d); }
        node.b = node.b.filter((b) => !this.tplPainted.has(b));
        if (!node.b.length && node.state === undefined && node.sid === undefined) out.add(node);
      }
      if (!out.size) continue;
      const at = new Map<number, number>();
      t.nodes.forEach((n, i) => { if (!out.has(n)) at.set(i, at.size); });
      const re = (i: number | undefined) => (i === undefined || i < 0 ? i : at.get(i)!);
      t.nodes = t.nodes.filter((n) => !out.has(n));
      for (const n of t.nodes) {
        if (n.p !== undefined) n.p = re(n.p);
        for (const b of n.b) if (b.y !== undefined) b.y = re(b.y);
      }
    }
    // a function nothing uses: a placeholder keeps the others' indexes
    for (let i = 0; i < this.fns.length; i++) if (this.fnUses[i] === 0) this.fns[i] = '0';
    if (!gone.size) return;
    const at = new Map<number, number>();
    this.roots.forEach((n, i) => { if (!gone.has(n)) at.set(i, at.size); });
    const re = (i: number | undefined) => (i === undefined || i < 0 ? i : at.get(i)!);
    const kept = this.roots.filter((n) => !gone.has(n));
    for (const n of kept) {
      if (n.p !== undefined) n.p = re(n.p);
      for (const b of n.b) if (b.y !== undefined) b.y = re(b.y);
    }
    for (const r of this.resources) if (r.scope !== undefined) r.scope = re(r.scope);
    for (const x of this.syncs) if (x.scope !== undefined) x.scope = re(x.scope);
    this.roots.splice(0, this.roots.length, ...kept);
  }

  /**
   * A dependency on a state field nothing writes never fires: it is left out of every binding's and
   * resource's `d`/`deps`, so the runtime subscribes to nothing for it (the page module only: the early
   * chunk, made before, decides what is known by the full list).
   */
  fixedDeps() {
    const written = this.writtenState();
    const fixed = (d: PathRef) => {
      const m = typeof d === 'string' ? /^\$s(\d+)\.([^.]+)/.exec(d) : null;
      return !!m && m[2] !== '*' && m[2] !== '**' && !written.has(`$s${m[1]}`) && !written.has(`$s${m[1]}.${m[2]}`);
    };
    // (what is left out is frozen: `fixedState`)
    const strip = (ds: PathRef[] | undefined) => { if (!ds?.some(fixed)) return ds; this.freeze(ds.filter(fixed)); return ds.filter((d) => !fixed(d)); };
    const nodes = [...this.roots, ...this.templates.flatMap((t) => t.nodes)];
    for (const n of nodes) for (const b of n.b) if (b.d) b.d = strip(b.d)!;
    for (const r of this.resources) if (r.deps) r.deps = strip(r.deps);
    // a state field nothing writes and no function reads anymore (its readers were written into the markup): out of the state
    const code = this.fns.filter((c) => c !== '0');
    const emptied = new Set<NodeDef>();
    for (const n of nodes) {
      if (n.sid === undefined || n.state === undefined) continue;
      const st = this.stateInits.find((x) => x.sid === n.sid);
      if (!st || st.persist) continue;
      const sid = n.sid, own = this.fns[n.state]!;
      // the whole object read (`$s0[k]`, passed on): every field stays
      if (code.some((c) => c !== own && new RegExp(`\\$s${sid}(?![\\w$.])`).test(c))) continue;
      const unread = (k: string) => !written.has(`$s${sid}.${k}`) && !code.some((c) => c !== own && new RegExp(`\\$s${sid}\\.${k.replace(/\$/g, '\\$')}(?![\\w$])`).test(c));
      const keep = st.fields.filter((x) => !unread(x.key));
      if (keep.length === st.fields.length || !keep.every((x) => x.code.startsWith('($) => ('))) continue;
      this.fnUses[n.state]!--;
      if (this.fnUses[n.state] === 0) this.fns[n.state] = '0';
      if (!keep.length) { emptied.add(n); continue; }
      n.state = this.fn(`($) => ({ ${keep.map((x) => `${JSON.stringify(x.key)}: (${x.code.slice('($) => ('.length, -1)})`).join(', ')} })`);
    }
    this.dropEmptyStates(emptied);
  }

  /**
   * A page-level `data-sn-state` none of whose fields are left (nothing writes or reads them) is no
   * scope at all: its node goes when nothing else is bound there, with its `data-sn` id, and the nodes
   * inside take the scope around it. A branch's or row's state stays, with no fields.
   */
  dropEmptyStates(emptied: Set<NodeDef>) {
    const gone = new Set<NodeDef>();
    for (const n of emptied) {
      const i = this.roots.indexOf(n);
      if (i < 0 || n.b.length) { n.state = this.fn('($) => ({})'); continue; }
      gone.add(n);
      for (const m of this.roots) if (m.p === i) m.p = n.p;
      const el = this.paints.find((x) => x.node === n)?.el;
      if (el) el.attrs = el.attrs.filter((a) => a.name !== 'data-sn');
    }
    if (!gone.size) return;
    // a resource or stream declared in it: in the scope around it
    for (const r of [...this.resources, ...this.syncs]) {
      const s = r.scope === undefined ? undefined : this.roots[r.scope];
      if (s && gone.has(s)) r.scope = s.p;
    }
    const at = new Map<number, number>();
    this.roots.forEach((n, i) => { if (!gone.has(n)) at.set(i, at.size); });
    const re = (i: number | undefined) => (i === undefined || i < 0 ? i : at.get(i)!);
    const kept = this.roots.filter((n) => !gone.has(n));
    for (const n of kept) {
      if (n.p !== undefined) n.p = re(n.p);
      for (const b of n.b) if (b.y !== undefined) b.y = re(b.y);
    }
    for (const r of this.resources) if (r.scope !== undefined) r.scope = re(r.scope);
    for (const x of this.syncs) if (x.scope !== undefined) x.scope = re(x.scope);
    this.roots.splice(0, this.roots.length, ...kept);
  }

  /**
   * Every state field something can write, as `$s<sid>.<field>`, or `$s<sid>` for a write that may
   * reach any of its fields (a computed key, `**`): handlers, models, actions' `then`/`catch`,
   * resources' and events' `then`, component scripts (their `cmp` bindings), and the runtime's own
   * (a form's `$error`, persisted values restored from storage).
   */
  /** The state fields `deps` reads, by where their `data-sn-state` was written (`file:offset#field`): the same in both passes. */
  stateSites(deps: PathRef[] | undefined): Set<string> {
    const out = new Set<string>();
    for (const d of strs(deps)) {
      const m = /^\$s(\d+)\.([^.]+)/.exec(d);
      const at = m && m[2] !== '*' && m[2] !== '**' ? this.stateAt.get(Number(m[1])) : undefined;
      const key = at && this.siteKey(at.site.el);
      if (key) out.add(`${key}#${m![2]}`);
    }
    return out;
  }

  /** For the second pass: the state fields the decided `data-sn-if`s and unrolled loops read. */
  foldedState(): Set<string> {
    return new Set([...this.decided.keys(), ...this.unrolls.keys()].flatMap((k) => [...this.foldReads.get(k) ?? []]));
  }

  /** State fields the build used as constants: read by a binding `dropConstants` left out, or left out of a binding's dependencies. */
  freeze(deps: PathRef[] | undefined) {
    for (const d of strs(deps)) {
      const m = /^\$s(\d+)\.([^.]+)/.exec(d);
      if (m && m[2] !== '*' && m[2] !== '**') this.frozen.add(`$s${m[1]}.${m[2]}`);
    }
  }

  /**
   * `fixedState`: the fields the build used as constants. Those the first pass's folds read are named by where
   * their state was written (each use of a component agreed on the fold), in this pass's state ids.
   */
  fixedState(): string[] {
    const out = new Set(this.frozen);
    const sites = this.opts.frozen;
    if (sites?.size) for (const [sid, at] of this.stateAt) {
      const key = this.siteKey(at.site.el);
      if (key) for (const f of at.fields.keys()) if (sites.has(`${key}#${f}`)) out.add(`$s${sid}.${f}`);
    }
    return [...out].sort();
  }

  writtenState(): Set<string> {
    const out = new Set<string>();
    const add = (ws: PathRef[] | undefined) => {
      for (const w of strs(ws)) {
        const m = /^\$s(\d+)(?:\.([^.]+))?/.exec(w);
        if (!m) continue;
        out.add(m[2] === undefined || m[2] === '*' || m[2] === '**' ? `$s${m[1]}` : `$s${m[1]}.${m[2]}`);
      }
    };
    for (const n of [...this.roots, ...this.templates.flatMap((t) => t.nodes)]) for (const b of n.b) add(b.w);
    for (const a of this.actions) add(a.w);
    for (const r of this.resources) add(r.w);
    for (const x of this.syncs) for (const e of x.events) add(e.w);
    for (const st of this.stateInits) {
      if (st.persist) out.add(`$s${st.sid}`);
      if (st.fields.some((f) => f.key === '$error')) out.add(`$s${st.sid}.$error`);
    }
    for (const p of this.persisted) add([p]);
    return out;
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
    // a resource with embedded data: its data is in the page, so bindings over it render early (rows too)
    const embedded = new Map(this.resources.filter((r) => r.data != null).map((r) => [r.name, r]));
    const usedEmb = new Set<string>();
    let readsUrl = false;
    const known = (deps: string[]) => deps.every((d) => {
      if (d === '$locale') return true;
      // the URL: the browser knows it as the head is parsed
      if (d === '$url' || d.startsWith('$url.')) return (readsUrl = true);
      // with embedded data, any resource: one without data throws when it is read, which leaves that
      // binding to the page module (`($url.feed ? feed : articles)`)
      const r = /^\$r\.([^.]+)/.exec(d);
      if (r) { if (!embedded.size) return false; if (embedded.has(r[1]!)) usedEmb.add(r[1]!); return true; }
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
    const eligible = (b: Binding) => ['text', 'attr', 'class', 'style', 'show', 'model', 'if', ...(embedded.size ? ['for'] : [])].includes(b.k) && !b.e && b.f !== undefined && known(strs(b.d)) && !builtin(this.fns[b.f]!) && !this.painted.has(b);
    const list = (defs: NodeDef[]): NodeDef[] => {
      // a dialog's bindings wait until it opens (as in the runtime): nothing of a closed dialog is painted
      const bs = defs.map((nd) => (nd.dl || this.lateNodes.has(nd) ? [] : nd.b.filter(eligible)));
      const elses = new Set(bs.flatMap((b) => b.filter((x) => x.k === 'if' && x.y !== undefined).map((x) => x.y!)));
      const keep = new Map<number, number>();
      defs.forEach((nd, i) => { if (nd.state !== undefined || bs[i]!.length || elses.has(i)) keep.set(i, keep.size); });
      if (defs === this.roots) rootKeep = keep;
      const out: NodeDef[] = [];
      for (const [i, j] of keep) {
        const nd = defs[i]!, o: NodeDef = { tag: nd.tag, p: (nd.p ?? -1) >= 0 ? keep.get(nd.p!) ?? -1 : -1, b: [] };
        if (nd.id !== undefined) o.id = nd.id; else o.path = nd.path!;
        if (nd.state !== undefined) {
          // the init function once the fields the early bindings read are known (below)
          states.push(o);
          o.sid = nd.sid!;
          if (nd.persist) o.persist = nd.persist;
        }
        for (const b of bs[i]!) {
          reads.push(...strs(b.d), ...strs(b.w));
          const nb: Binding = { k: b.k, f: fn(this.fns[b.f!]!) };
          if (b.n !== undefined) nb.n = b.n;
          if (b.k === 'model') { nb.a = fn(this.fns[b.a!]!); if (b.p !== undefined) nb.p = b.p; }
          if (b.k === 'if') { nb.x = tpl(b.x!); if (b.y !== undefined) nb.y = keep.get(b.y)!; }
          if (b.k === 'for') nb.x = tpl(b.x!);
          o.b.push(nb);
        }
        if (elses.has(i)) { const e = nd.b.find((x) => x.k === 'else')!; o.b.push({ k: 'else', x: tpl(e.x!) }); }
        out[j] = o;
      }
      return out;
    };
    const tpl = (x: number) => {
      if (!templates[x]) {
        const t = this.templates[x]!;
        templates[x] = { nodes: [], ...(t.item ? { item: t.item, index: t.index ?? null } : {}) };
        templates[x]!.nodes = list(t.nodes);
      }
      return x;
    };
    const states: NodeDef[] = [], reads: string[] = [];
    let rootKeep = new Map<number, number>();
    const roots = list(this.roots);
    while (templates.length && templates[templates.length - 1] === null) templates.pop();
    // the resources the early file requests: `src` and `when` read only what is known early
    // (state, persisted values, `$url`, `$now`, helpers); not `call`, `each` or embedded data; a
    // paginated one: its first page, with the query parameters the pager sends for it
    const res: NonNullable<EarlyIR['res']> = [];
    let url = false;
    for (const def of this.resources) {
      if (def.call || def.each || def.data != null || !def.src.length || !knownReq(strs(def.deps))) continue;
      // a URL fixed at build time is preloaded from the HTML (see injectScript), earlier than this file runs
      if (fixedRequest(def) || this.noEarly.has(def.name)) continue;
      // another origin only when listed in `origins` (the runtime's allowlist, known at build time)
      const where = this.earlyOrigin(def.src);
      if (!where) continue;
      const start = def.paginate?.start;
      const codes = [...def.src.filter((x): x is number => typeof x === 'number'), ...(def.when != null ? [def.when] : []), ...(start != null ? [start] : [])].map((i) => this.fns[i]!);
      const scope = (def.scope ?? -1) < 0 ? -1 : rootKeep.get(def.scope!);
      if (scope === undefined || codes.some(builtin) || codes.some((c) => /\$(r|meta|el)\b/.test(c))) continue;
      reads.push(...strs(def.deps));
      url ||= codes.some((c) => c.includes('$url'));
      res.push({ name: def.name, src: def.src.map((x) => (typeof x === 'number' ? fn(this.fns[x]!) : x)), when: def.when != null ? fn(this.fns[def.when]!) : null, scope, ...(def.paginate ? { q: firstParams(def.paginate) } : {}), ...(def.paginate && start != null ? { sp: startOf(def.paginate, fn(this.fns[start]!)) } : {}), ...(def.lo ? { lo: 1 as const } : {}), ...(where === 'listed' ? { xo: 1 as const } : {}), ...(this.settingsOf(def.name) ? { a: this.settingsOf(def.name)! } : {}) });
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
      const code = `($) => ({ ${keep.map(([k, code]) => `${JSON.stringify(k)}: (${code})`).join(', ')} })`;
      o.state = fn(code);
      // written here, from the state's fields: each maps to its field in `data-sn-state`
      const at = this.stateAt.get(o.sid!);
      if (at) this.earlySites.set(code, { ...at.site, parts: keep.map(([k, c]) => ({ code: `${JSON.stringify(k)}: (${c})`, site: at.fields.get(k) ?? null })) });
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
    if (usedEmb.size) ir.emb = Object.fromEntries([...usedEmb].map((n) => [n, { id: embedded.get(n)!.data!, items: embedded.get(n)!.items ?? null }]));
    if (res.length) ir.res = res;
    if ((url || readsUrl) && this.pathList.length) ir.path = this.pathList;
    const arrays = this.urlArrays();
    if ((url || readsUrl) && arrays.length) ir.urlArrays = arrays;
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
      if (def.call || def.each || def.data != null || def.paginate || def.body != null || !def.src.length) continue;
      if (!strs(def.deps).every((d) => d === '$url' || d.startsWith('$url.'))) continue;
      const codes = [...def.src.filter((x): x is number => typeof x === 'number'), ...(def.when != null ? [def.when] : [])].map((i) => this.fns[i]!);
      if (codes.some((c) => /\$\.\$(?!url\b)/.test(c) || builtin(c) || messages.some((m) => c.includes(`${m}$`)))) continue;
      res.push({
        s: def.src.map((x) => (typeof x === 'number' ? fn(this.fns[x]!) : x)),
        ...(def.when != null ? { w: fn(this.fns[def.when]!) } : {}),
        i: def.items ?? null, t: def.total ?? null, ...(def.key ? { k: 1 as const } : {}),
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
    const arrays = this.urlArrays();
    return { path: this.pathList, res, fns, helpers: this.opts.helpers.names.filter(calls), namespaces, ...(arrays.length ? { a: arrays } : {}) };
  }

  /**
   * `embed`: a placeholder at the end of the head for each resource without one whose `src`,
   * `when` and `page-model` read only `$url`, constants and helpers (what a server knows at the
   * page request; helpers make it a request only a resolver can make)
   */
  /**
   * The lists outside templates (and dialogs): each one's placeholder for the rows its resource brings
   * after the first paint (`Layout.reserve`: a paginated resource's `page-size` rows, or
   * `data-sn-reserve="n"`), and the box around it whose width follows its content
   * (`Layout.contentSized`). Read before the walk, which removes the bindings the cascade looks at.
   */
  planSpace(doc: DefaultTreeAdapterMap['document'], layout: Layout) {
    const resources = new Map<string, P5Element>(), lists: P5Element[] = [];
    const walk = (p: P5Parent, dialog: boolean) => {
      for (const c of p.childNodes) {
        if (!isElement(c)) continue;
        if (c.tagName === 'sn-resource' && attr(c, 'name')) resources.set(attr(c, 'name')!, c);
        if (c.tagName === 'template') { if (attr(c, 'data-sn-for') !== undefined && !dialog) lists.push(c); continue; }
        walk(c, dialog || c.tagName === 'dialog');
      }
    };
    walk(doc, false);
    for (const tpl of lists) {
      const own = attr(tpl, 'data-sn-reserve')?.trim();
      if (own === 'off') { this.spacePlan.set(tpl, { off: true, sized: null, space: null, resource: null }); continue; }
      const sized = layout.contentSized(tpl);
      const m = /^\s*(?:\(\s*[A-Za-z_]\w*\s*,\s*[A-Za-z_]\w*\s*\)|[A-Za-z_]\w*)\s+in\s+([A-Za-z_$][\w$]*)\s*$/.exec(attr(tpl, 'data-sn-for')!);
      const r = m ? resources.get(m[1]!) : undefined;
      let space: Reserved | null = null;
      // where the adapter serves the rules (builds: dev would serve them with the page module, after the first paint); not a
      // resource whose data the page has (embedded) or one that may not load at all (`when`), nor one the build cannot follow (`each`, `call`)
      if (r && !sized && this.opts.paintCss && !['when', 'each', 'call'].some((a) => attr(r, a) !== undefined)
        && !(this.opts.embed && attr(r, 'early') !== 'off')) {
        const n = own && /^[1-9]\d*$/.test(own) ? Number(own) : attr(r, 'paginate') !== undefined ? Number(attr(r, 'page-size')) : NaN;
        if (Number.isInteger(n) && n > 0) space = layout.reserve(tpl, Math.min(n, 1000));
      }
      this.spacePlan.set(tpl, { off: false, sized, space, resource: space ? m![1]! : null });
    }
  }

  /**
   * After a list's template is compiled: SN520 for a list over late data in a box whose width its rows
   * decide, and the planned placeholder after the template (a root node whose only binding removes it
   * once the resource has rows, has loaded or has failed: nothing of it stays to count as a child).
   */
  spaceFor(el: P5Element, node: NodeDef, ctx: Ctx) {
    const plan = this.spacePlan.get(el);
    const b = node.b.find((x) => x.k === 'for');
    if (!plan || plan.off || !b || ctx.tid >= 0) return;
    const late = strs(b.d).map((d) => /^\$r\.([^.]+)/.exec(d)?.[1]).filter((n): n is string => !!n && !this.embedded.has(n));
    if (plan.sized?.siblings && late.length) {
      const what = plan.sized.el.tagName + (attr(plan.sized.el, 'class') ? `.${attr(plan.sized.el, 'class')!.trim().split(/\s+/).join('.')}` : '');
      this.report(el, 'data-sn-for', 'SN520', `this list's rows arrive after the first paint inside \`<${what}>\`, whose width follows its content: the rows widen it and move what is beside it`, 0,
        'give that box a width or flex basis of its own (`flex: 1 1 0`, `width: 100%`), or add `data-sn-reserve="off"` to the template to leave it as it is');
    }
    const name = plan.resource;
    if (!plan.space || !name || this.embedded.has(name) || !strs(b.d).every((d) => d === `$r.${name}` || d.startsWith(`$r.${name}.`))) return;
    const parent = el.parentNode as P5Element;
    // unique across pages, should two pages' rules end up in one stylesheet
    let hash = 0x811c9dc5;
    const rel = this.opts.file.slice(this.opts.root.length).replace(/^[\\/]+/, '');
    for (const ch of rel) hash = Math.imul(hash ^ ch.charCodeAt(0), 0x01000193);
    const k = `${(hash >>> 0).toString(36).slice(0, 5)}-${this.spaceN++}`, id = this.nextId++;
    const ph = parse5.parseFragment(`<${plan.space.tag} class="sn-reserve sn-reserve-${k}" aria-hidden="true" data-sn="${id}"></${plan.space.tag}>`).childNodes[0] as P5Element;
    ph.parentNode = parent;
    parent.childNodes.splice(parent.childNodes.indexOf(el) + 1, 0, ph as never);
    const r = JSON.stringify(name);
    const code = `($) => { const l = $.$r[${r}], m = $.$meta[${r}]; if ((l && l.length) || m.loadedAt || m.error) $.$el.remove(); }`;
    const pnode: NodeDef = { tag: plan.space.tag, p: ctx.stateIdx, b: [this.binding({ k: 'imp', f: this.fn(code, { el, attr: 'data-sn-for', shift: 0 }), d: [`$r.${name}`, `$meta.${name}`], e: 1 })], id };
    ctx.list.push(pnode);
    const sel = `.sn-reserve.sn-reserve-${k}`;
    for (const p of plan.space.pieces) this.paintRules.push(p.from ? `@media (min-width: ${Math.round(p.from * 100) / 100}px) { ${sel} { ${p.decls} } }` : `${sel} { ${p.decls} }`);
  }

  addPlaceholders(doc: DefaultTreeAdapterMap['document']) {
    const html = doc.childNodes.find((n) => isElement(n) && n.tagName === 'html') as P5Element | undefined;
    const head = html?.childNodes.find((n) => isElement(n) && n.tagName === 'head') as P5Element | undefined;
    if (!head) return;
    for (const def of this.resources) {
      if (def.data != null || def.call || def.each || this.noEarly.has(def.name) || !def.src.length) continue;
      if (!strs(def.deps).every((d) => d === '$url' || d.startsWith('$url.'))) continue;
      const codes = [...def.src.filter((x): x is number => typeof x === 'number'), ...(def.when != null ? [def.when] : []), ...(def.paginate?.start != null ? [def.paginate.start] : [])].map((i) => this.fns[i]!);
      if (codes.some((c) => /\$\.\$(?!url\b)/.test(c))) continue;
      const id = this.nextId++;
      def.data = id;
      this.embedded.set(def.name, id);
      const el = parse5.parseFragment(`<script type="application/json" data-sn="${id}"></script>`).childNodes[0] as P5Element;
      el.parentNode = head;
      head.childNodes.push(el as never);
    }
  }

  /** The embedded-data placeholders a server can fill, with each resource's request where the URL alone decides it. */
  embedSlots(): EmbedSlot[] {
    const out: EmbedSlot[] = [], arrays = this.urlArrays();
    for (const def of this.resources) {
      if (def.data == null) continue;
      const parts = def.call || def.each ? null : def.src.map((x) => {
        if (typeof x === 'string') return x;
        const m = URL_READ.exec(this.fns[x]!);
        return m ? { url: m[1]! } : null;
      });
      const pg = def.paginate;
      const startUrl = pg?.start != null ? URL_READ.exec(this.fns[pg.start]!)?.[1] ?? null : undefined;
      const described = parts && parts.length && parts.every((x) => x != null) && startUrl !== null;
      out.push({
        id: def.data, resource: def.name, src: described ? parts as EmbedSlot['src'] : null,
        ...(this.apiOfResource.get(def.name)?.headers ? { headers: this.apiOfResource.get(def.name)!.headers } : {}),
        // a `when` that reads an array parameter is the browser's to evaluate
        ...(def.when != null ? { when: (!arrays.some((n) => readsParam(this.fns[def.when!]!, n)) && condOf(this.fns[def.when]!)) || true as const } : {}), ...(pg ? { query: Object.entries(firstParams(pg)) } : {}),
        ...(pg && startUrl ? { start: { url: startUrl, key: pg.offsetParam ?? pg.pageParam, size: pg.size, ...(pg.offsetParam ? { skip: true as const } : {}), query: Object.entries(pageParams(pg, 2)) } } : {}),
      });
    }
    return out.sort((a, b) => a.id - b.id);
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

  /**
   * Why the page needs the runtime, in document order: each element with something bound, a state or a
   * component script (by its first sinter attribute), each resource and stream. Empty: nothing runs.
   */
  runtimeReasons(): RuntimeReason[] {
    const out: Array<RuntimeReason & { at: number }> = [];
    const self = this.canonicalLink;
    const at = (el: P5Element, attrName: string | null) => ({ ...this.locOf(el, attrName), at: el.sourceCodeLocation?.startOffset ?? 0 });
    const BY_KIND: Record<string, string> = { text: 'data-sn-text', attr: 'data-sn-attr', class: 'data-sn-class', style: 'data-sn-style', show: 'data-sn-show', model: 'data-sn-model', if: 'data-sn-if', for: 'data-sn-for' };
    const written = (el: P5Element) => Object.keys(el.sourceCodeLocation?.attrs ?? {});
    const nameOf = (el: P5Element, b: Binding | undefined): string | null => {
      const names = written(el);
      const want = b ? (b.k === 'on' && b.n ? `data-sn-on-${b.n}` : b.k === 'attr' && b.n === 'data-sn-vt' ? 'data-sn-transition' : BY_KIND[b.k]) : 'data-sn-state';
      if (want && names.includes(want)) return want;
      return names.find((n) => n.startsWith('data-sn-') && !['data-sn-prop', 'data-sn-component', 'data-sn-key', 'data-sn-early'].includes(n)) ?? null;
    };
    const elOf = new Map(this.paints.map((x) => [x.node, x.el]));
    for (const n of this.roots) {
      if (!n.b.length && n.state === undefined) continue;
      const el = elOf.get(n);
      if (!el || el === self) continue;
      const b = n.b.find((x) => x.k === 'cmp') ?? n.b[0];
      if (b?.k === 'cmp') { out.push({ what: `the script of \`<${this.useOf.get(el)?.name ?? el.tagName}>\``, ...at(el, null) }); continue; }
      const name = nameOf(el, b);
      out.push({ what: name ? `\`${name}\`` : `\`<${el.tagName}>\``, ...at(el, name) });
    }
    for (const r of this.resources) {
      const el = this.declAt.get(r);
      out.push({ what: `resource \`${r.name}\``, ...(el ? at(el, 'name') : { file: this.opts.file, line: 1, col: 1, at: 0 }) });
    }
    for (const x of this.syncs) {
      const el = this.declAt.get(x);
      out.push({ what: '`<sn-sync>`', ...(el ? at(el, null) : { file: this.opts.file, line: 1, col: 1, at: 0 }) });
    }
    const page = (r: RuntimeReason) => (r.file === this.opts.file ? 0 : 1);
    return out.sort((a, b) => page(a) - page(b) || (a.file === b.file ? a.at - b.at : 0)).map(({ at: _, ...r }) => r);
  }

  /**
   * A page with nothing to run: the stylesheets its module would have imported (the components' scoped
   * styles, the images' rules) are linked in its head instead, for the bundler to build.
   */
  linkStyles(doc: DefaultTreeAdapterMap['document'], images: string | null) {
    const head = findHead(doc);
    if (!head) return;
    const hrefs = [
      ...(images ? [images] : []),
      ...(this.opts.componentCss ? [...this.uses.keys()].sort().filter((n) => this.componentFiles.get(n)?.css).map((n) => this.opts.componentCss!(n)) : []),
    ];
    const esc = (v: string) => v.replace(/[&"<>]/g, (c) => `&#${c.charCodeAt(0)};`);
    for (const href of hrefs) {
      const link = parse5.parseFragment(`<link rel="stylesheet" href="${esc(href)}">`).childNodes[0] as P5Element;
      link.parentNode = head;
      head.childNodes.push(link as never);
    }
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
      const links = [...preconnects(this.resources, this.syncs).map((o) => `<link rel="preconnect" href="${esc(o)}" crossorigin>`), ...this.preloadLinks()]
        .map((t) => parse5.parseFragment(t).childNodes[0] as P5Element);
      for (const l of links) l.parentNode = head;
      // after the leading <meta>s (charset first), before stylesheets and scripts
      let at = 0;
      for (let i = 0; i < head.childNodes.length; i++) { const n = head.childNodes[i]!; if (isElement(n) && n.tagName !== 'meta') break; if (isElement(n)) at = i + 1; }
      head.childNodes.splice(at, 0, ...(links as never[]));
    }
    if (early) {
      // with `observe`, a classic script (the dev server bundles it) after the leading <meta>s, before stylesheets
      // (a classic script waits for those before it) and scripts: it renders as the parser goes; else a
      // render-blocking module, before the page module
      const observe = !!this.opts.observe;
      const tag = parse5.parseFragment(observe ? `<script src="${esc(early)}"></script>` : `<script type="module" src="${esc(early)}" blocking="render"></script>`).childNodes[0] as P5Element;
      tag.parentNode = head;
      if (observe) {
        let at = 0;
        for (let i = 0; i < head.childNodes.length; i++) { const n = head.childNodes[i]!; if (isElement(n) && n.tagName !== 'meta') break; if (isElement(n)) at = i + 1; }
        head.childNodes.splice(at, 0, tag as never);
      } else head.childNodes.push(tag as never);
    }
    const src = this.opts.moduleSrc ?? `./${basename(this.opts.file).replace(/\.html?$/, '')}.sinter.js`;
    const frag = parse5.parseFragment(`<script type="module" src="${esc(src)}"></script>`);
    const script = frag.childNodes[0] as P5Element;
    script.parentNode = head;
    head.childNodes.push(script as never);
  }
}

// ---- helpers

/** Whether the document has a `<base href>` (links then resolve against it). */
function hasBase(n: P5Parent): boolean {
  return n.childNodes.some((c) => isElement(c) && ((c.tagName === 'base' && attr(c, 'href') != null) || hasBase(c.tagName === 'template' ? (c as any).content : c)));
}
/** What the build can see of where a link goes: a literal start, and whether it is the whole `href`. */
interface HrefPrefix { s: string; whole: boolean }
/**
 * The literal starts an `href` expression can have, followed through `+`, template literals, both
 * branches of `?:` and both sides of `||`/`??`; a branch the build cannot see adds nothing.
 */
function hrefPrefixes(n: Node | undefined): HrefPrefix[] {
  if (!n) return [];
  const v = n as any;
  if (v.type === 'Literal') return typeof v.value === 'string' ? [{ s: v.value, whole: true }] : [];
  if (v.type === 'TemplateLiteral') return [{ s: v.quasis[0].value.cooked ?? '', whole: v.quasis.length === 1 }];
  if (v.type === 'ConditionalExpression') return [...hrefPrefixes(v.consequent), ...hrefPrefixes(v.alternate)];
  if (v.type === 'LogicalExpression') return [...hrefPrefixes(v.left), ...hrefPrefixes(v.right)];
  if (v.type === 'BinaryExpression' && v.operator === '+') {
    const right = hrefPrefixes(v.right);
    return hrefPrefixes(v.left).flatMap((l) => (!l.whole ? [l] : right.length ? right.map((r) => ({ s: l.s + r.s, whole: r.whole })) : [{ s: l.s, whole: false }]));
  }
  return [];
}
/** Whether a link starting with `p` can go to a page served at one of `patterns` (`/tag/:tag`). */
function samePage(p: HrefPrefix, patterns: string[]): boolean {
  if (p.s[0] === '?') return true;
  if (p.s[0] !== '/' || p.s[1] === '/') return false;
  const cut = p.s.search(/[?#]/), path = cut < 0 ? p.s : p.s.slice(0, cut), known = cut >= 0 || p.whole;
  const parts = path.split('/').slice(1);
  return patterns.some((pattern) => {
    const want = pattern.split('/').filter(Boolean), fits = (w: string | undefined, x: string) => w !== undefined && (w[0] === ':' || w === x);
    if (known) { const segs = parts.filter(Boolean); return segs.length === want.length && segs.every((x, i) => fits(want[i], x)); }
    // a path the build sees only the start of: its whole segments fit, and the last one starts one
    const whole = parts.slice(0, -1), last = parts[parts.length - 1] ?? '';
    if (!whole.every((x, i) => fits(want[i], x))) return false;
    return last === '' || (want[whole.length] !== undefined && (want[whole.length]![0] === ':' || want[whole.length]!.startsWith(last)));
  });
}

/** Flags for the runtime: `e` when the expression reads `$el`, `i` when it reads a loop index. */
/** The AST of an object-literal entry's value (by its offset), for the selection pattern. */
const entryValue = (r: ExprResult, e: { offset: number }): Node | undefined => {
  const props = (r.ast as import('acorn').ObjectExpression | null)?.properties;
  const p = props?.find((x) => x.start === e.offset);
  return p && p.type === 'Property' ? (p.value as Node) : undefined;
};
/**
 * Whether a value starts with a literal, non-empty string (`'contact-' + c.id`, `` `contact-${c.id}` ``):
 * data then cannot name a global another script reads, so `id`/`name` from it is not reported.
 */
const literalPrefix = (n: Node | undefined): boolean => {
  while (n?.type === 'BinaryExpression' && (n as import('acorn').BinaryExpression).operator === '+') n = (n as import('acorn').BinaryExpression).left as Node;
  if (n?.type === 'Literal') { const v = (n as import('acorn').Literal).value; return typeof v === 'string' && v !== ''; }
  if (n?.type === 'TemplateLiteral') return ((n as import('acorn').TemplateLiteral).quasis[0].value.cooked ?? '') !== '';
  return false;
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

/** The item schema of a nested list: the list under `fields` of an item of `schema` (any of them), its items. */
function nestedSchema(doc: unknown, schema: unknown, fields: string[]): unknown {
  for (const f of fields) {
    const props = properties(doc, schema);
    if (!props.has(f)) continue;
    const list = deref(doc, props.get(f)) as { items?: unknown } | null;
    if (list?.items) return list.items;
  }
  return null;
}

function findHead(doc: P5Parent): P5Element | null {
  for (const c of doc.childNodes) {
    if (!isElement(c)) continue;
    if (c.tagName === 'head') return c;
    const h = findHead(c);
    if (h) return h;
  }
  return null;
}

/** `task-ring` → `TaskRing`: the class a component's script exports */
const pascalName = (name: string) => name.split('-').map((p) => p[0]!.toUpperCase() + p.slice(1)).join('');

/** The literal keys of a `data-sn-state` object (none when it does not parse). */
function stateKeys(src: string | undefined): Set<string> {
  const out = new Set<string>();
  if (!src) return out;
  try {
    const o = parseExpressionAt(src, 0, { ecmaVersion: 'latest' });
    if (o.type === 'ObjectExpression') for (const p of o.properties) if (p.type === 'Property' && !p.computed && p.key.type === 'Identifier') out.add(p.key.name);
  } catch { /* reported where the state is compiled */ }
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

/** Whether a form's markup reads `$error` (outside `data-sn-catch`, where `$error` is the action's own). */
function readsFormError(el: P5Element, hostOf: (e: P5Element) => P5Element | undefined): boolean {
  const own = (e: P5Element) => e.attrs.some((a) => a.name.startsWith('data-sn-') && a.name !== 'data-sn-catch' && /\$error\b/.test(a.value));
  // a component's tag, which its root replaced: `data-sn-prop="{ error: $error }"`
  const reads = (e: P5Element): boolean => own(e) || (!!hostOf(e) && own(hostOf(e)!))
    || (e.tagName === 'template' ? (e as P5Template).content.childNodes : e.childNodes).some((c) => isElement(c) && reads(c));
  return reads(el);
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
/** A value function's expression, as `makeCode` inlines it (`($) => (x)` → `x`). */
function bodyOf(code: string): string {
  return code.startsWith('($) => (') && code.endsWith(')') ? code.slice('($) => ('.length, -1) : code;
}

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

/** A resource whose request is fixed at build time: a literal `src`, no `when`, not `each`, `call` or embedded (a paginated one: its first page). */
const fixedRequest = (r: ResourceDef) => !r.call && !r.each && r.data == null && r.when == null && r.paginate?.start == null && r.src.length > 0 && r.src.every((p) => typeof p === 'string');

/** a compiled `when` as a condition a server can evaluate (see EmbedCond), or null */
function condOf(code: string): EmbedCond | null {
  let fn: acorn.Expression;
  try { fn = parseExpressionAt(code, 0, { ecmaVersion: 'latest' }) as acorn.Expression; } catch { return null; }
  if (fn.type !== 'ArrowFunctionExpression' || fn.body.type === 'BlockStatement') return null;
  const urlName = (n: acorn.Node): string | null => {
    const m = n as acorn.MemberExpression;
    if (m.type !== 'MemberExpression' || m.computed || m.property.type !== 'Identifier') return null;
    const o = m.object as acorn.MemberExpression;
    return o.type === 'MemberExpression' && !o.computed && o.object.type === 'Identifier' && o.object.name === '$' && o.property.type === 'Identifier' && o.property.name === '$url' ? m.property.name : null;
  };
  const str = (n: acorn.Node) => (n.type === 'Literal' && typeof (n as acorn.Literal).value === 'string' ? (n as acorn.Literal).value as string : null);
  const walk = (n: acorn.Node): EmbedCond | null => {
    const u = urlName(n);
    if (u) return { url: u };
    if (n.type === 'UnaryExpression' && (n as acorn.UnaryExpression).operator === '!') { const c = walk((n as acorn.UnaryExpression).argument); return c && { not: c }; }
    if (n.type === 'LogicalExpression') {
      const l = n as acorn.LogicalExpression;
      if (l.operator === '??') return null;
      const a = walk(l.left), b = walk(l.right);
      return a && b ? (l.operator === '&&' ? { and: [a, b] } : { or: [a, b] }) : null;
    }
    if (n.type === 'BinaryExpression') {
      const b = n as acorn.BinaryExpression;
      if (!['==', '===', '!=', '!=='].includes(b.operator)) return null;
      const [name, value] = urlName(b.left) ? [urlName(b.left), str(b.right)] : [urlName(b.right), str(b.left)];
      if (name == null || value == null) return null;
      return b.operator.startsWith('=') ? { url: name, eq: value } : { url: name, ne: value };
    }
    return null;
  };
  return walk(fn.body);
}

/** whether compiled code reads `$url.<name>` */
const readsParam = (code: string, name: string) => new RegExp(`\\$\\.\\$url\\.${name.replace(/\$/g, '\\$')}(?![\\w$])`).test(code);

/** a compiled function that is one `$url` read: `($) => ($.$url.page)` */
const URL_READ = /^\(\$\) => \(\$\.\$url\.([A-Za-z_$][\w$]*)\)$/;

/** the early file's `page-model` start: page n's parameters are `qn` with `k` set (the page, or with `offset-param` the items to skip) */
function startOf(cfg: Paginate, f: number): NonNullable<NonNullable<EarlyIR['res']>[number]['sp']> {
  const k = cfg.offsetParam ?? cfg.pageParam;
  return { f, k, s: cfg.size, ...(cfg.offsetParam ? { o: 1 as const } : {}), qn: pageParams(cfg, 2) };
}

/** URLs of the resources whose request is fixed at build time (callers pass only those it may request early: same-origin or a listed origin): the page preloads them from its HTML (low priority when every resource of that URL is `lo`). */
export function preloads(resources: ResourceDef[]): Array<{ url: string; lo: boolean }> {
  const urls = new Map<string, boolean>();
  for (const r of resources.filter(fixedRequest)) {
    const u = withParams((r.src as string[]).join('').replace(/[?&](?=#|$)/, ''), r.paginate ? firstParams(r.paginate) : null);
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
/** the most rows a constant loop is unrolled into at build time; a longer list stays a template */
const MAX_UNROLL = 1000;

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
      // a property the attribute does not set: no `indeterminate` attribute, a select's and a textarea's
      // value is not one either. The binding stays: the runtime sets the property
      if (b.n === 'indeterminate' || (b.n === 'value' && (el.tagName === 'select' || el.tagName === 'textarea'))) return FAIL;
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
