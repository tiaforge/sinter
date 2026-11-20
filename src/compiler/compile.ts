// The compiler: one pure, deterministic function from annotated HTML to a
// rewritten page plus its IR and function table.
import type { SourceMap } from './sourcemap.js';
import { rewriteImages, sourceFile, type ImageHost, type ImageResult } from './images.js';
import { boxSizesCss, type ReserveTrace, Layout, PLACEHOLDER_BASE, type Affine, type Reserved, type StyleSheet } from './layout.js';
import { shows } from './status-eval.js';
import { recordChild, replay as replayUnit, LINK_FIELDS, UNIT_NUMBERING, type Plan, type Refused } from './link.js';
import { HEAD_ELEMENTS, kindOfComponent, parseDocument } from './head.js';
import { minifyMarkup } from './minify.js';
import type { RemoteConfig } from '../remote.js';
import { AUTO_FIT_HINT, AUTO_FIT_ROWS, FLUID_WIDTHS } from './images.js';
import * as parse5 from 'parse5';
import { parseExpression, parseProgram } from './parse.js';
import { fullAncestor } from 'acorn-walk';
import type { DefaultTreeAdapterMap } from 'parse5';
import { type Code, type Diagnostic, didYouMean, severityOf, suggest } from './diagnostics.js';
import { analyze, applyEdits, refNames, STORE_FNS, throughField, type SlotScope, type ComponentScope, type ExprOptions, type ExprResult, type LetEntry, type LoopEntry, type PageInfo, type Read, type ResourceInfo, type Scope } from './expr.js';
import { callerAttribute, COMPONENT_NAME, DOM_EVENTS, LIBRARY_LAYER, rootCss, scopeCss, SLOT_TYPE, typeMembers, withoutSlots, type Member } from './components.js';
import type { Node } from 'acorn';
import type * as acorn from 'acorn';
import { COMPLEXITY_DEFAULTS, COMPLEXITY_LIMITS, measure, type ComplexityOptions } from './complexity.js';
import { ATTRIBUTES, CHAR_KEYS, ELEMENTS, KEY_ALIASES, LOOSE_SHIFT, MODIFIERS, NAMED_KEYS } from './vocabulary.js';
import type { CheckExpr, CheckFrame, CheckLoc, CheckResource, CheckUnit, TypeRef } from './check-unit.js';
import { apiOf, shapeTemplate, type ApiDef, type ApisDef, type OperationShape } from './apis.js';
import { foldReason, type FoldVerdict } from '../fold-check.js';
import { FILE_ATTRS, FILE_ENTRY, fileAttrProblem, fileEntry, filePath, fileValue, isContentSource, isFileSource, isGlob, PAGE_ENTRY, scriptJson, setPath, sortList } from './files.js';
import { deref, matchOperation, matchResource, type Method, type OpenApiMatch, type Auth, namedAt, namedSchema, properties, propertyNames, queryNames, responseEntities, walk, wrapperKey, type OpenApiSpec } from './openapi.js';
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
  /**
   * The files below a folder, at any depth, as absolute `/`-separated paths, for a `file:` glob. The project's skips
   * `node_modules` and folders whose name starts with a dot, and lists nothing outside the root. Throws when the folder
   * does not exist.
   */
  listFiles?: (dir: string) => string[];
  /**
   * `<html data-sn-for>` (docs/static-pages.md#a-page-per-entry): the entry this compile writes, and the path it is written
   * at (the page's pattern filled from it). Without it, a page with `<html data-sn-for>` is compiled as its template, its
   * entry the list's first (`sinter check`, the editor, and the build's look at it, which lists its entries: `pages`).
   */
  page?: { value: unknown; path: string; key?: string };
  /**
   * Builds: where a `<html data-sn-for>` template's first pass is kept, so its other entries are not walked again
   * (`fromTemplate`). The compiles that share one must differ only in what each entry changes: `page`, `foldLog`,
   * `urls`, `moduleSrc`, `paintCss`, `images` and `locale.urls`. Cleared with the build's reads.
   */
  templates?: Map<string, unknown>;
  /** (docs/proposals/compile-once.md, (5)): a build's shared definitions, recorded on one page and linked into the next */
  definitions?: Map<string, unknown>;
  /**
   * The content module's collections (docs/resources.md#collections), loaded before the compile: each list and its key,
   * by name. Absent: none loaded (`sinter check` and the editor read them from the build's snapshot). `collectionsError`:
   * why loading failed (dev), reported where a page reads a collection.
   */
  collections?: ReadonlyMap<string, { key: string; value: readonly unknown[] }>;
  collectionsError?: string;
  /** the content module, absolute: `sinter check` types a `content:` resource without `type` from its loader */
  contentModule?: string;
  /** the result's HTML is not read (a page's description: its paths, what it requests ahead): embedded values are not serialized into it */
  describeOnly?: boolean;
  /**
   * builds: the `file:` lists already built, by their glob, key, order, drafts, mode and language, with what they reported
   * (their files do not change during a build); every page that reads one gets it and its diagnostics from here
   */
  globCache?: Map<string, { value: unknown[]; files: string[]; said: Array<{ attr: string; code: Code; message: string; at: number }> }>;
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
  /**
   * the lazy packages a module that declares helpers reaches through its imports (by the module's specifier as
   * the manifest has it), or none: its helpers wait for it, in a `data-sn-let` (docs/lazy.md#helpers-that-wait)
   */
  lazyModule?: (module: string) => string[];
  /**
   * the helpers module as loaded in Node (helpers-node.ts), for helper calls over build-time constants; null when it
   * could not be loaded (nothing folds). Absent: not loaded (the testing module, a compile without a project)
   */
  helperValues?: Record<string, unknown> | null;
  /** per helper (`fmt`, `ns$member`), whether its calls may run at build time, and why not (fold-check.ts): for SN322 */
  helperFold?: ReadonlyMap<string, FoldVerdict>;
  /**
   * a build: each distinct call that ran at build time and gave plain data (once per page), its arguments (another
   * call's result by its id) and its result (`resultKey`), which the build runs again in a fresh copy of the helpers
   * module at its end. `id` counts the page's calls from 0, again when the page starts afresh
   */
  foldLog?: (key: string, args: FoldArg[], result: string, id: number) => void;
  /** SN507: limits for expressions too complex for markup, and the level (default `warn`) */
  complexity?: ComplexityOptions;
  /** write bindings whose value is a build-time constant (literal state, no helpers) into the HTML */
  prerender?: boolean;
  /**
   * the app's config may change requests (middleware, `header()`): nothing is requested before the
   * page module (an early request lacks what the middleware adds: refused, then sent again), unless the spec says the
   * operation is public or answered with cookies
   */
  changesRequests?: boolean;
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
  /** the early module runs as a classic script in the head, started by `observe` (see `@tiaforge-ui/sinter/runtime/early`); with `early.src`, its tag is classic */
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
  /**
   * the component libraries (`sinter({ libraries })`, docs/libraries.md): a tag with a library's prefix
   * is its component, from `<folder>/components/` (public) or `<folder>/components/internal/`
   */
  libraries?: readonly CompileLibrary[];
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
   * unrolled into one row per item, the item (its value, as a literal) and index given to each as constants
   */
  unrolled?: Map<string, unknown[]>;
  /**
   * internal, set by `compileParts` for its second pass: the state fields (`file:offset#field`) the first
   * pass's decided `data-sn-if`s and unrolled loops read, for `fixedState`
   */
  frozen?: Set<string>;
  /**
   * internal, set by `compileParts` for its second pass: the bindings the first pass found constant for good, by
   * the attribute that wrote them (`file:offset|uses|attribute`, and `#k` for row k of an unrolled loop), with what
   * each writes. The second pass writes them into the markup before the layout and the images (`prefold`)
   */
  constants?: Map<string, ConstantWrite[]>;
  /** the most rows and component instances a page expands at build time, in all (default `EXPANSION_LIMIT`; `sinter({ expansionLimit })`) */
  expansionLimit?: number;
  /** internal, set by `compileParts` for its second pass: the trees the first found over the limit (`SN536` again, there) */
  overLimit?: Map<string, number>;
  /**
   * the page must ship no JavaScript (`sinter({ static })`): each thing that runs in the browser is
   * `SN322` where it was written. Needs `prerender`, which leaves out what can never change.
   */
  static?: boolean;
  /**
   * links swap the next page in around the elements both pages keep (`sinter({ swap: true })`,
   * docs/proposals/swap-navigation.md): a kept element (`data-sn-permanent`) is then a reason to ship JavaScript
   */
  swap?: boolean;
  /** with `swap`: the module of the swap's stub and the build's list of pages (swap-build.ts), which a page that swaps imports */
  swapList?: string | null;
  /** every component of the app: the candidates of `<sn-component use>` a helper chooses (default: the components the page names) */
  componentNames?: string[];
  /** the module the page module imports for a component's scoped styles (`CompiledParts.styles`), so the bundler puts them in the page's stylesheet */
  componentCss?: (name: string) => string;
  /**
   * the stylesheets the page loads, in order: the boxes they fix size images (as `images.styles`) and
   * the space a list's rows take before its data arrives (docs/first-paint.md#reserved-space)
   */
  styles?: StyleSheet[];
  /**
   * builds: remove the author's comments, and white space that shows nothing, from the page's markup before it is
   * compiled (minify.ts). White space only with the page's stylesheets (`minify.styles`, else `styles`); with
   * none given, comments only.
   */
  minify?: boolean | { styles?: StyleSheet[] };
  /** builds: the module the page module imports for the page's generated first-paint rules (`CompiledParts.paint`), which the adapter serves */
  paintCss?: string;
  /** a font family's `line-height: normal` as a multiple of its size, from the font files the build has (fonts-build.ts) */
  normalLineHeight?: (family: string) => number | null;
  /** the width of `0` (`1ch`) in a web font, as a multiple of its size, from its files (font-metrics.ts); null when they were not read */
  zeroWidth?: (family: string) => number | null;
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
  /** the parts of the core its page module uses (`coreParts`, src/core-parts.ts); absent for a static page */
  core?: string[];
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
  /**
   * `<html data-sn-for>`: the variable, the list, the pattern, and each entry with the path it fills (compiled as the
   * template: no `page` option). A build writes one page per entry.
   */
  pages?: { name: string; of: string; pattern: string; entries: Array<{ value: unknown; path: string; key: string }> };
  /** @internal the embedded values, by id, whose JSON `compileParts` writes into the page */
  json?: Map<number, unknown>;
  /** @internal a first pass's diagnostics about the page as it ends, for when no second pass follows */
  lateDiagnostics?: Diagnostic[];
  /** the folders `file:` globs list, and the pattern below each their files match (dev: an added or removed file reloads the page) */
  globs?: Array<{ dir: string; match: string }>;
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
  /** the paginated lists over late data that hold no space, and why (the Vite plugin prints them) */
  unheld?: Array<{ file: string; line: number; col: number; why: string }>;
  /** the boxes whose following siblings stay invisible while their list's first rows load (the Vite plugin prints them) */
  waits?: Array<{ file: string; line: number; col: number; what: string; widths: string }>;
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
  /** the names of the page's kept elements (`data-sn-permanent`), in document order */
  permanent?: string[];
  /** where each kept element was written (file, offset, a hash of its source): one markup across the pages, for those that bind */
  keptSource?: Record<string, string>;
  /** the kept elements that bind */
  keptBound?: string[];
  /** `<html data-sn-swap="off">`: links to this page load it */
  swapOff?: true;
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
  /** the built-in formatters the early bindings call (EARLY_FORMATTERS), imported from the package */
  formatters?: string[];
}

/**
 * The built-in formatters an early binding may call: each gives, before the first paint, the text the page module
 * writes at mount (the runtime's own functions, bundled into the page's early file beside the messages module that
 * sets their locale). Not `relative`: it reads the clock.
 */
export const EARLY_FORMATTERS = ['date', 'number', 'bytes'];

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
 * One embedded-data placeholder (`data-sn-resource`), for a server that fills it per request (a
 * middleware: `sinter-embed.json`). `id`: the `data-sn` id the build gives the `<script>`. `src`:
 * the resource's URL template when only literals and plain `$url.<name>` reads make it up (`{ url:
 * name }`), else null and the server must produce the data itself (`call`, `each` too). `when`:
 * the resource has a condition the server cannot evaluate. `query`: a paginated resource's first
 * page, the parameters the pager sends for it (`firstParams`), set on the template's URL as the
 * runtime sets them (`withParams`), in this order. `start`: its `model` (paginate) parameter; from page 2
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
  /**
   * `<html data-sn-for>`: the variable, the list, the pattern, and each entry with the path it fills (compiled as the
   * template: no `page` option). A build writes one page per entry.
   */
  pages?: { name: string; of: string; pattern: string; entries: Array<{ value: unknown; path: string; key: string }> };
  /** @internal the embedded values, by id, whose JSON `compileParts` writes into the page */
  json?: Map<number, unknown>;
  /** @internal a first pass's diagnostics about the page as it ends, for when no second pass follows */
  lateDiagnostics?: Diagnostic[];
  /** the folders `file:` globs list, and the pattern below each their files match (dev: an added or removed file reloads the page) */
  globs?: Array<{ dir: string; match: string }>;
  /** with `check: true` */
  check?: CheckUnit;
  /** with `early`: the early chunk's bindings, or null when none can run early */
  early?: EarlyParts | null;
  /** with `images` */
  images?: ImageResult;
  /** with `paintCss`: the rules of the page's reserved space, empty when none */
  paint?: string;
  /** the paginated lists over late data that hold no space, and why */
  unheld?: Array<{ file: string; line: number; col: number; why: string }>;
  /** the boxes whose following siblings wait for their list's first rows */
  waits?: Array<{ file: string; line: number; col: number; what: string; widths: string }>;
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
  /** the names of the page's kept elements (`data-sn-permanent`), in document order */
  permanent?: string[];
  /** where each kept element was written, and those that bind: one markup across the pages */
  keptSource?: Record<string, string>;
  keptBound?: string[];
  /** `<html data-sn-swap="off">`: links to this page load it */
  swapOff?: true;
  /** origins of resources that could be requested early but are not in `origins` */
  unlistedOrigins?: string[];
  /** the scoped styles of the components the page uses, by component */
  styles: Array<{ name: string; css: string }>;
  /** the scripts of the components the page uses: the module, its class `export` imported as `local`; `lazy`: the packages it loads with */
  scripts: Array<{ name: string; module: string; local: string; export: string; lazy?: string[] }>;
  /** lazy packages the page module loads itself (`data-sn-import`): the package, and its loader's local name */
  lazy: Array<{ spec: string; local: string }>;
  /**
   * helper modules that reach lazy packages and that a `data-sn-let` of the page calls: loaded whole when first
   * needed, with the packages (`lazy`), as `local`; `ir.lm` holds the functions that load them, by index
   */
  lazyHelpers: Array<{ module: string; local: string; lazy: string[] }>;
  /** lazy packages the page fetches with itself (`data-sn-preload`) */
  preload: string[];
}

const ATTRS = ATTRIBUTES.map((a) => a.name);
const METHODS = ['post', 'put', 'patch', 'delete'] as const;
/** attributes that are gone or renamed (docs/proposals/vocabulary.md): what to write instead. Removed at 1.0, as SN316 was */
const RETIRED: Record<string, string> = {
  'data-sn-data': 'is renamed to `data-sn-resource`, which names the resource the embedded JSON is for: `<script type="application/json" data-sn-resource="people">`',
  'data-sn-prop': 'is renamed to `data-sn-with`, so passing values and declaring them (`data-sn-props`) are different words: `<contact-card data-sn-with="{ contact: c }">`',
  'data-sn-component': 'is renamed to `data-sn-props`, the one declaration of a component\'s or a layout\'s props: `<template data-sn-props="{ article: Article }">`',
  'data-sn-head': 'is renamed to `data-sn-props`: a component whose markup is head elements is a head component, `<template data-sn-props="{ title?: string }"><title …></template>`',
  'data-sn-layout': 'is renamed to `data-sn-props` on the layout\'s `<html>`: `<html lang="en" data-sn-props="{ title?: string }">`',
  'data-sn-pages': 'is renamed to `data-sn-for`, on `<html>` (or a layout\'s tag): `<html data-sn-for="post in posts" data-sn-path="/blog/:slug">` builds the page once per entry',
  'data-sn-apply': 'is renamed to `data-sn-write-through`, the name of what it turns off: `data-sn-write-through="off"`',
  'data-sn-listbox': 'is renamed to `data-sn-options`, which also serves menus and lists: on a text field it works as before; on the element that holds the options, that element takes the focus',
  'data-sn-get': 'is gone: data a GET loads is a resource, `<sn-resource name="hits" src="/api/search?q={q}" when="q">`, which reloads when the values its URL reads change (latest wins); a load a click starts sets the state its `when` reads (docs/recipes/click-to-load.html), or is a `data-sn-call`',
};
/** an action's expressions evaluated when it triggers, so they see `$event` */
const TRIGGER_TIME = new Set(['data-sn-post', 'data-sn-put', 'data-sn-patch', 'data-sn-delete', 'data-sn-call', 'data-sn-body', 'data-sn-confirm']);
/** attributes sinter writes on the page for CSS to style (docs/attributes.md), never written in markup */
export const SET_BY_SINTER: Record<string, string> = {
  'data-sn-marked': 'on the option a `data-sn-options` list marks',
  'data-sn-error': 'on the message it inserts after a field with a server error',
  'data-sn-failed': 'on the `<body>` of a page whose server render failed',
};
/**
 * A duration in markup, one grammar for every attribute that takes one: a number and `ms`, `s`, `m`, `h` or `d`
 * (`300ms`, `2s`, `10m`, `1d`). `bare: 'ms'`: a number alone is milliseconds (the debounces). Null when malformed.
 */
export function duration(v: string, bare: 'ms' | null): number | null {
  const m = /^\s*(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)?\s*$/.exec(v);
  if (!m || (!m[2] && bare !== 'ms')) return null;
  return Number(m[1]) * { ms: 1, s: 1e3, m: 6e4, h: 36e5, d: 864e5 }[(m[2] ?? 'ms') as 'ms'];
}
const DURATION = 'a duration such as `300ms`, `2s`, `10m`, `2h` or `1d`';
/** an old cursor (`{uid}`, `{ before: id }`, its fields bare) as the cursor of `$item`: `{ uid: $item.uid }` */
function itemCursor(text: string): string {
  let ast: acorn.Expression;
  try { ast = parseExpression(text); } catch { return text; }
  const edits: Array<[number, number, string]> = [];
  fullAncestor(ast as Node, (n, _s, anc) => {
    if (n.type !== 'Identifier') return;
    const id = n as acorn.Identifier, p = anc[anc.length - 2] as acorn.Node | undefined;
    if (id.name.startsWith('$') || (p?.type === 'MemberExpression' && (p as acorn.MemberExpression).property === id && !(p as acorn.MemberExpression).computed)) return;
    if (p?.type === 'Property' && (p as acorn.Property).key === id && !(p as acorn.Property).shorthand) return;
    if (p?.type === 'Property' && (p as acorn.Property).shorthand) edits.push([p.start, p.end, `${id.name}: $item.${id.name}`]);
    else edits.push([id.start, id.end, `$item.${id.name}`]);
  });
  let out = text;
  for (const [a, b, t] of edits.sort((x, y) => y[0] - x[0])) out = out.slice(0, a) + t + out.slice(b);
  return out;
}
const ACTION_ONLY = ['body', 'trigger', 'debounce', 'concurrency', 'optimistic', 'then', 'catch', 'confirm', 'encoding', 'write-through', 'retry'];
const UNSAFE_ELEMENTS = new Set(['script', 'style', 'iframe', 'object', 'embed', 'base', 'meta', 'link', 'animate', 'set', 'animatemotion', 'animatetransform']);
const FORM_CONTROLS = new Set(['input', 'select', 'textarea']);
// `fields` is a build-time source's (`file:`, `content:`, FILE_ATTRS): listed in the vocabulary, still SN101 on a fetched resource
const RESOURCE_ATTRS = ELEMENTS.find((e) => e.name === 'sn-resource')!.attrs.filter((a) => a !== 'fields');
/** the attributes `paginate` replaced (docs/proposals/vocabulary.md): reported with the object they become */
const PAGINATE_OLD = ['page-size', 'size-param', 'cursor', 'direction-param', 'direction-values', 'page-param', 'offset-param', 'page-model'];
const EVENT_ATTRS = ELEMENTS.find((e) => e.name === 'sn-event')!.attrs;
const IDENT = /^[A-Za-z_][\w]*$/;
const BAD_PARAM = /^(constructor|__proto__|prototype)$/;
const SECRET_AUTOCOMPLETE = /^(cc-|one-time-code$|current-password$|new-password$)/;

/** `use`: the uses this markup is in, by their tags' places (`file:offset<…`): two uses on one line differ; `usedAt`: in a library's file, where the app uses it */
interface Origin { file: string; src: string; chain: string[]; use?: string; usedAt?: string }

/**
 * Build-time helper calls of the page being compiled, by the helpers module's values: a page's passes share them
 * (a let over `parse()` is evaluated in each pass and by the worklist), the next page starts again.
 */
const FOLD_MEMO = new WeakMap<object, FoldMemo>();
/** one page's build-time calls: by helper and arguments; the results it handed out, by object, with their call ids */
interface FoldMemo { file: string; calls: Map<string, { v: unknown } | { what: string }>; refs: WeakMap<object, number>; n: number }
/** a logged call's argument: a value, or the result of the page's call `r` (a parse passed on), replayed from that call */
export type FoldArg = { v: unknown } | { r: number };
/** a result as `foldLog` reports it: tagged, so `undefined` is a result like any other */
export const resultKey = (v: unknown): string => (v === undefined ? 'u' : 'j' + JSON.stringify(v));
/**
 * Plain data as a key, one to one: every value tagged by its kind and strings by their length, so `undefined`,
 * `NaN`, `-0` and the infinities stay apart and no string can pass for another value
 */
export function dataKey(v: unknown): string {
  if (v === undefined) return 'u';
  if (v === null) return 'z';
  if (typeof v === 'boolean') return v ? 't' : 'f';
  if (typeof v === 'number') return `n${Object.is(v, -0) ? '-0' : String(v)};`;
  if (typeof v === 'string') return `s${v.length}:${v}`;
  if (Array.isArray(v)) return `[${v.map(dataKey).join('')}]`;
  return `{${Object.entries(v as object).map(([k, x]) => `${k.length}:${k}${dataKey(x)}`).join('')}}`;
}

/** the stylesheet `componentCss` serves for the libraries' layer (`@layer sinter-lib;`): a name no component can have */
export const LAYERS_SHEET = 'sn-layers';

/** A component library, as the compiler needs it (see `Library` in `src/libraries.ts`). */
export interface CompileLibrary {
  name: string;
  /** the package's folder, as diagnostics name its files relative to it */
  dir: string;
  /** the app-shaped folder its package.json names */
  folder: string;
  prefix: string | null;
  public: string[];
  internal: string[];
  /** its types module: type names in its components' props and slots resolve against it */
  types: string | null;
}

/** A row of an unrolled loop (the second pass): its template, item and index, and `inst`, the instance path of what is in it; `up`: the row it is the top of, when the loop is itself a row's top element */
type RowInfo = { tpl: P5Element; item: string; index: string | null; list: string; offset: number; k: number; value: unknown; inst: string; up?: RowInfo };

/** One use of a component: its tag in the caller's markup (`host`), replaced by the component's root. */
interface Use {
  name: string;
  file: string;
  host: P5Element;
  root: P5Element;
  /** the component's `<template data-sn-props>`, where its contract is written */
  template: P5Element;
  /** declared props and events (null: written as a type the compiler cannot list, such as an alias); props without `Slot<T>` members */
  props: Member[] | null;
  /** the props type, without its `Slot<T>` members */
  propsText: string;
  /** a root's fills for slots it declares, kept for tree placements deep inside it (section 4), by name, with their fill ids (`fillDefs`) */
  treeFills?: Map<string, { nodes: P5Node[]; id: number }>;
  /** the slots that pass data: `Slot<T>` members of the props type, by name */
  slots?: Map<string, Member>;
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
  /** a head component (`data-sn-props`): its elements, inlined at the use with no wrapper */
  head?: { roots: P5Element[]; parent: Use | null };
  /** what its markup sees, computed once (a head component's elements share it, and the branches of a chain root) */
  markup?: Scope;
  /** a root that is not one plain element: what it is (`rootShape`) */
  shape?: RootShape;
  /** such a root's tag was slot content: the use whose caller wrote it */
  hostSlot?: Use;
  /** a layout (`<html data-sn-props>`): the page is its tag, its root the layout's `<html>` */
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
  /** `<template data-sn-props>`: a head component */
  head?: boolean;
  /** its markup is only what a head and a body both hold (slots, `<script>`, `<style>`, `<noscript>`): a head
   *  component where it is used in a head, else a body component (`asKind`) */
  either?: boolean;
  /** its `<style>` as written, for `rootCss` */
  rawCss?: string;
  /** the names of its slots that pass data (`Slot<T>` in its props type), read once */
  dataSlots?: Set<string>;
  /** a component of a library (`sinter({ libraries })`); `internal`: in its `components/internal/` */
  lib?: CompileLibrary;
  internal?: true;
}

/**
 * A `<slot>` that passes data (`data-sn-with` on it, `Slot<T>` in the props type): one place where a
 * fill renders. Its `data-sn-with` is compiled where the fill is walked, in the component's scope there.
 */
interface Placement {
  /** the `<slot>`, detached once filled: where its `data-sn-with` is written */
  el: P5Element;
  use: Use;
  name: string;
  member: Member;
}

/**
 * A component's root, which renders at most one element: one plain element (`el`), an if/else chain
 * of roots, a component tag, `<sn-component use>`. `empty`: it may render nothing.
 */
/** a placement's default as a fill's `<slot>` takes it (`defaultShape`): data, its children from `shapeChildren` */
type DefaultShape = { shape: RootShape; el: P5Element; what?: string };

type RootShape =
  | { kind: 'el'; el: P5Element; empty: false }
  | { kind: 'chain'; templates: P5Element[]; branches: RootShape[]; empty: boolean }
  | { kind: 'tag' | 'choice'; el: P5Element; empty: boolean }
  /** a text fill (`<template slot data-sn-text>`) of the root `<slot>`: one text node, no element */
  | { kind: 'text'; el: P5Element; empty: false };

/** The elements a root renders as: each branch's, down to the elements (a component tag is not one). */
function landingOf(s: RootShape): P5Element[] {
  return s.kind === 'el' ? [s.el] : s.kind === 'chain' ? s.branches.flatMap(landingOf) : [];
}

/** Whether a root may render nothing: a chain without an else, at any depth, or a choice. A component tag's is its root's, known when it expands. */
function mayBeEmpty(s: RootShape): boolean {
  return s.kind === 'chain' ? s.empty || s.branches.some(mayBeEmpty) : s.empty;
}

/** An element or text that is not whitespace. */
function realNode(c: P5Node): boolean {
  return isElement(c) || (c.nodeName === '#text' && (c as DefaultTreeAdapterMap['textNode']).value.trim() !== '');
}

/**
 * The components whose markup starts at a node: `outer` first, then its own, each once (an outer one may
 * reach it twice: through the tags that pass their attributes on, and from the node it took the place of).
 */
function outerFirst(outer: Use[], own: Use[] | undefined): Use[] {
  return [...outer, ...(own ?? []).filter((u) => !outer.includes(u))];
}

/** A plain element as a component root: not a template, a slot, sinter's own element or a component. */
function plainRoot(e: P5Node | undefined, c: { componentFile(tag: string): unknown }): boolean {
  return !!e && isElement(e) && e.tagName !== 'template' && e.tagName !== 'slot' && !e.tagName.startsWith('sn-') && !c.componentFile(e.tagName);
}

/**
 * The placements a fill renders in, from the one expanded first (a forwarding slot of an outer
 * component, whose fill this is) to the one where it renders (`$slot` is the last one's values,
 * passed on through the others). One array per copy of a fill: its top-level nodes share it.
 */
type FillChain = Placement[];

/**
 * an expression's place: the value of `attr` (null: the element's start tag), `shift` characters in.
 * `parts`: for a function the compiler wrote, the code it inlined (found in order) and where each was written.
 */
interface Site { el: P5Element; attr: string | null; shift: number; parts?: Array<{ code: string; site: Site | null }> }

/** `<sn-component use>`: its one choice node, and each candidate's case (its definition and props), in order */
interface ChoiceGroup {
  node: NodeDef | null;
  cases: Array<{ name: string; tid: number; props: string; deps: string[] }>;
  /** `use`, compiled once, and its dev warning for a value outside the candidates */
  pick: string | null;
  warn: string;
  site: Site | null;
}

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
const SINTER_EVENTS = ['sn-error', 'sn-dismiss', 'sn-navigate'];
/** sinter's own events before they took the `sn-` prefix, as every one of them has now */
const UNPREFIXED: Record<string, string> = { navigate: 'sn-navigate', dismiss: 'sn-dismiss' };

/** a prop's value that is a build-time constant, and those of them that are falsy */
const CONST_PROP = /^(true|false|null|undefined|-?\d+(\.\d+)?|'[^'\\]*'|"[^"\\]*")$/;
const FALSY_PROP = ['false', 'null', 'undefined', '0', "''", '""'];

/** The query parameters `paginate` adds to a request, by mode (`runtime/pages.ts`), and the cursor's fields. */
/** `paginate`, read (`pageSpec`): the cursor and the model with where they are written in the attribute */
interface PageSpec {
  mode: Paginate['mode'];
  size: number;
  cursor: { text: string; at: number } | null;
  model: { name: string | null; at: number } | null;
  jump: boolean;
  /** numbered: `numbered: 'offset'`, the items to skip are sent instead of the page number */
  skip: boolean;
  params: { size?: string; page?: string; offset?: string; direction?: string };
  directions: Paginate['directionValues'] | null;
}

function paginateParams(p: Paginate, cursor: string | undefined): string[] {
  const out = [p.sizeParam];
  if (p.mode === 'numbered') out.push(p.skipParam ?? p.pageParam);
  else {
    out.push(p.directionParam);
    if (p.skipParam) out.push(p.skipParam);
    if (cursor) {
      try {
        const ast = parseExpression(cursor) as acorn.Expression;
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
    try { ast = parseExpression(src) as acorn.Expression; } catch { ast = null; }
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
const TAG_ONLY_HINT = 'a component\'s tag takes `data-sn-with`, `data-sn-model`, handlers, actions, `data-sn-class`, `-attr`, `-style`, `-show` and `-transition`; the rest belongs inside the component';

export function compileParts(html: string, options: CompileOptions): CompiledParts {
  let out = compilePasses(html, options);
  // a page whose path is a pattern gets its canonical link from the early script: only when it runs something anyway
  if (out.canonicalOnly) out = compilePasses(html, { ...options, canonicalLink: false });
  // the embedded values' JSON, into the page that is kept
  if (out.json && !options.describeOnly) { const json = out.json; out = { ...out, html: out.html.replace(/\u0001sn-json:(\d+)\u0001/g, (_, id: string) => scriptJson(json.get(+id))) }; delete out.json; }
  return out;
}

/**
 * Component files' markup, parsed once per process and shared by every compile: by text (an edited file is another
 * key), and only read (each use takes a `freshCopy`). Cleared when it holds many texts: the editor and the dev
 * server see one per edit.
 */
const PARSED = new Map<string, DefaultTreeAdapterMap['documentFragment']>();
function parsedText(text: string): DefaultTreeAdapterMap['documentFragment'] {
  let f = PARSED.get(text);
  if (!f) {
    if (PARSED.size >= 2000) PARSED.clear();
    PARSED.set(text, (f = parse5.parseFragment(text, { sourceCodeLocationInfo: true })));
  }
  return f;
}

/** what a field of the compiler holds: a container's type, a class's name, or a value's type (`compilerFields`) */
export function fieldKind(v: unknown): string {
  if (v === null || v === undefined) return 'empty';
  if (typeof v !== 'object') return typeof v;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null ? 'object' : (v as object).constructor?.name ?? 'object';
}

/** the compiler's fields after compiling `html`, each with what it holds, for the linker's list of them (`LINK_FIELDS`) */
export function compilerFields(html: string, options: CompileOptions): Array<[string, string]> {
  const c = new Compiler(options);
  c.run(html);
  return Object.keys(c).map((k) => [k, fieldKind((c as unknown as Record<string, unknown>)[k])]);
}

/** what a unit shares of its page as it is (`unitChild`); its numbering (`UNIT_NUMBERING`) it copies */
const UNIT_SHARED = new Set(['page', 'componentFiles']);

/** a `<html data-sn-for>` template walked once (`fromTemplate`): its first pass, kept for each entry's evaluation */
type KeptTemplate = { c: Compiler; path: string; checked: boolean; hits: number; misses: number };

/** the template walked as one entry's first pass, up to its evaluation; null when its entries cannot share it */
function keepTemplate(html: string, options: CompileOptions): KeptTemplate | null {
  // (not linked: the walk is kept for every entry already, and the one that checks it would only record what none replays)
  const c = new Compiler({ ...options, definitions: undefined });
  c.walkPage(html);
  // an entry's own URL compiled into the program (`$canonical`, `localeUrl()`): each entry has a program of its own
  if (!c.entryProgram()) return null;
  return { c, path: options.page!.path, checked: false, hits: 0, misses: 0 };
}

/**
 * `<html data-sn-for>` in a build (`templates`): an entry's page from its template's first pass, kept for every entry.
 * Each entry's first pass is the same program: the entry is a constant resource only the evaluation reads
 * (`prerender`, through `fileConstants`), and what it decides is keyed by place (`instKey`). So the template is
 * walked once, each entry is only evaluated again (`decideFor`) and compiled with what it decided: one walk per
 * entry, not two. Null: the entry is compiled the usual way, when there is nothing to decide (the first pass is the
 * page), a constant the layout or the images read is one the first pass writes into its own markup, or the page has
 * errors.
 */
function fromTemplate(html: string, options: CompileOptions): CompiledParts | null {
  const cache = options.templates as Map<string, KeptTemplate | null> | undefined;
  if (!cache || !options.page || !options.prerender || options.check || options.describeOnly || options.canonicalLink === false
    || options.decided || options.unrolled || options.constants) return null;
  const key = [options.file, options.locale?.name ?? '', html].join('\0');
  let t = cache.get(key);
  if (t === undefined) cache.set(key, (t = keepTemplate(html, options)));
  if (!t) return null;
  // the first other entry: walked as well, once. Its program must be the kept one, or nothing is shared
  if (!t.checked && options.page.path !== t.path) {
    const other = keepTemplate(html, options);
    if (!other || !t.c.sameProgram(other.c)) { cache.set(key, null); return null; }
    t.checked = true;
  }
  const c = t.c;
  c.decideFor(options);
  const clean = !c.diagnostics.some((d) => d.severity === 'error' && d.code !== 'SN322');
  if (!clean || c.needsMarkup || !(c.decided.size || c.unrolls.size)) {
    // a template none of whose entries gains: no longer evaluated for the next ones
    if (++t.misses >= 2 && !t.hits) cache.set(key, null);
    return null;
  }
  // (as `compilePasses` hands the first pass's decisions to the second)
  const frozen = c.foldedState();
  if (c.constants.size) for (const x of c.constantSites) frozen.add(x);
  const out = new Compiler({
    ...options, decided: new Map(c.decided), ...(c.unrolls.size ? { unrolled: new Map(c.unrolls) } : {}),
    ...(c.constants.size ? { constants: new Map(c.constants) as Map<string, ConstantWrite[]> } : {}),
    ...(c.overLimit.size ? { overLimit: new Map(c.overLimit) } : {}), frozen,
  }).run(html);
  // a page with errors: the usual way, which reports them as it always does
  if (out.diagnostics.some((d) => d.severity === 'error')) return null;
  t.hits++;
  return out;
}

function compilePasses(html: string, options: CompileOptions): CompiledParts & { canonicalOnly?: boolean } {
  const kept = fromTemplate(html, options);
  if (kept) return kept;
  const first = new Compiler(options);
  const out = first.run(html);
  // `data-sn-if` templates over state nothing writes: decided now, the page compiled again with their branches in place
  const withLate = (o: typeof out) => (o.lateDiagnostics ? { ...o, diagnostics: [...o.diagnostics, ...o.lateDiagnostics] } : o);
  if (!options.prerender || options.decided || options.unrolled) return withLate(out);
  // loops over constants: unrolled only when the first pass is clean (the second one compiles the rows with their item)
  // (SN322 does not count: what the first pass found running may be a loop the second one unrolls)
  const clean = !out.diagnostics.some((d) => d.severity === 'error' && d.code !== 'SN322');
  const unrolled = first.unrolls.size && clean ? first.unrolls : null;
  // constant bindings the layout or the images read (an image's attributes, a class or a style): written before
  // them, in a second pass; it needs a clean first pass too. What the second pass applies at every depth comes
  // from the first pass's worklist (`worklist()`), so a page is compiled at most twice: what writes state, which
  // decides what is constant, is known only after a walk
  const constants = first.constants.size && clean ? first.constants as Map<string, ConstantWrite[]> : null;
  if (!first.decided.size && !unrolled && !constants) return withLate(out);
  const frozen = first.foldedState();
  if (constants) for (const s of first.constantSites) frozen.add(s);
  const second = new Compiler({ ...options, decided: first.decided, ...(unrolled ? { unrolled } : {}), ...(constants ? { constants } : {}), ...(first.overLimit.size ? { overLimit: first.overLimit } : {}), frozen }).run(html);
  // the type check reads the page as written: in the second pass an unrolled loop's rows have no loop variable, so a
  // component prop in one (`{ post: p }`) was SN208 "Cannot find name 'p'" in `sinter check` of a `static` page
  return out.check ? { ...second, check: out.check } : second;
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
  /** a text node in a template: the node its path points at (its marking element, or its empty comment), so `anchors()` counts the path again */
  private readonly textAt = new Map<NodeDef, P5Node>();
  /** text nodes (`<template data-sn-text>`): the node that marks each, for the dry run of constant rows (never painted: the text stays a binding) */
  private readonly textMarks = new Map<NodeDef, P5Element>();
  /** text nodes outside templates: their anchor pair and slot, so `prerender()` can write a constant as plain text */
  private readonly textRoots: Array<{ node: NodeDef; b: Binding; parent: P5Parent; nodes: P5Node[] }> = [];
  /** bindings in templates `prerender()` wrote into the template's markup: the page module leaves them out */
  private readonly tplPainted = new Set<Binding>();
  /** `data-sn-if` templates whose condition is constant, by `file:offset`, for a second pass (null: the uses disagree) */
  readonly decided = new Map<string, boolean>();
  private readonly undecided = new Set<string>();
  /** `data-sn-for` templates whose list is constant and whose rows need nothing at run time, by instance path (`instKey`, after the rows' paths around it), with the list's length */
  readonly unrolls = new Map<string, unknown[]>();
  /** the state fields (`file:offset#field`) each decided `data-sn-if` and unrolled loop reads, by its key */
  private readonly foldReads = new Map<string, Set<string>>();
  /** the state fields (`$s<sid>.<field>`) whose bindings `dropConstants` left out */
  private readonly frozen = new Set<string>();
  private readonly notUnrolled = new Set<string>();
  /** the second pass: the top-level elements of each unrolled row, with what their item and index are */
  private readonly rowOf = new WeakMap<P5Element, RowInfo>();
  /** the second pass: unrolled loops whose list has been compiled (once, for its diagnostics) */
  private readonly listCompiled = new WeakSet<P5Element>();
  /** each recursion point and `<sn-component use>`: the components it is in and its nearest root, for expanding it as a use (`inlineInstance`) */
  private readonly pointCtx = new WeakMap<P5Element, { ch: string[]; en: Use | null }>();
  /** the second pass: the top nodes of an expanded instance (a recursion point, a choice's case), with the instance path of what is in it */
  private readonly instAt = new WeakMap<P5Node, string>();
  /** the scope a use's markup starts, per row or instance it is copied into (`markupOf`) */
  private readonly markups = new WeakMap<Use, Map<string, Scope>>();
  /** a layout's `<body>`, which takes the handlers of the page's tag */
  private readonly layoutBody = new WeakMap<P5Element, Use>();
  /** text forwarded into a component's named slot by a slot with `slot="…"` (elements carry the attribute) */
  private readonly forwarded = new WeakMap<object, string>();
  /** layout files by tag, read once (null: no such layout) */
  private readonly layoutFiles = new Map<string, { file: string; text: string } | null>();
  /** component files by tag, read once (null: no such component, a plain custom element) */
  private readonly componentFiles = new Map<string, ComponentFile | null>();
  /** `paginate` read once per element (`pageSpec`) */
  private readonly pageSpecs = new WeakMap<P5Element, PageSpec | null>();
  /** the component files whose kind is being decided (`componentFile`), against cycles */
  private readonly kinding = new Set<string>();
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
  /** a fill's top-level nodes (content for a slot that passes data): the placements it renders in */
  private readonly fillOf = new WeakMap<object, FillChain>();
  /** an unfilled placement's default, at the top: its placement, compiled there for its diagnostics and types */
  private readonly defaultOf = new WeakMap<object, FillChain>();
  /** unfilled placements with an empty default, by the node they were in: compiled when the walk reaches its children */
  private readonly emptyDefaults = new WeakMap<object, FillChain[]>();
  /** a component tag: the use whose markup it is in (for slot content, its caller's), for tree placements' nearest root */
  private readonly enclosing = new WeakMap<P5Element, Use | null>();
  /** above 0 while a shared definition expands: a tree placement there with no root in it is filled at run time */
  private inDef = 0;
  /** tree placements inside shared definitions: `<slot>`s left for the walk, which makes each a choice anchor */
  private readonly runtimeSlots = new WeakSet<P5Element>();
  /** every root's fill for a slot it declares, by id: a case template of each tree placement in a definition it reaches */
  private readonly fillDefs: Array<{ id: number; use: Use; k: string; nodes: P5Node[] }> = [];
  /** the fill a tree placement's case template renders (`fillStays`, SN322) */
  private readonly caseFill = new Map<number, { id: number; use: Use; k: string; nodes: P5Node[] }>();
  /** component files read as a graph (`fileGraph`) */
  /** tree placements in shared definitions, made choice anchors by the walk; their fills' cases after it (`finishTreeFills`) */
  private readonly runtimePlacements: Array<{ el: P5Element; node: NodeDef; k: string; at: Scope; data: string; deps: string[]; members: Map<string, LetEntry>; shape: DefaultShape | null; cases: number[]; map: Record<number, number> }> = [];
  /** the top nodes of a fill's case template and the children it places: the scope each is walked in */
  private readonly caseScopes = new WeakMap<object, Scope>();
  private graphs?: Map<string, { uses: Set<string>; declares: Set<string>; places: Set<string>; data: Set<string>; helperChoice: boolean }>;
  /** a component tag (or `<sn-component>`) that is another component's root: the outer uses, outer first, whose tag's attributes pass on to it */
  private readonly passOn = new WeakMap<P5Element, Use[]>();
  /** where a component's markup starts when its root is not one plain element (a chain's templates, a fill), or the outer components whose root an element also is: the uses, outer first */
  private readonly scopeStart = new WeakMap<P5Node, Use[]>();
  /** an element that renders as a component's root besides its own `useOf` (a branch of a chain, a fill, the root of a component tag that is a root): the uses whose tag's attributes it takes */
  private readonly landing = new WeakMap<P5Element, Use[]>();
  /** the children a fill's `<slot>` places (the component's markup): the fill they are placed in */
  private readonly childrenOf = new WeakMap<object, FillChain>();
  /** per fill: the scope at its placement (what its children see) and what the fill sees, computed at its first node */
  // (per instance too: the copies of an unrolled row share a component tag's fill, found through its use's host)
  private readonly fillScopes = new WeakMap<FillChain, Map<string, { at: Scope; fill: Scope }>>();
  /** a fill that took the place of slot content it was written in (a row, a branch): the slot of that content */
  private readonly writtenIn = new WeakMap<P5Node, Use>();
  /** the elements of a tree placement's case template: an instance of their own for `instOf` (first pass) */
  private readonly caseInst = new WeakMap<P5Element, string>();
  /** a fill chain `cloneTree` copied, and the chain it was copied from */
  private readonly chainCopyOf = new WeakMap<FillChain, FillChain>();
  /** fills of a slot placed more than once: each copy renders, so a literal `id` in one repeats */
  private readonly repeatedFills = new WeakSet<object>();
  /** library errors found at every use of a component, reported once per place */
  private readonly reportedOnce = new Set<string>();
  /** every use, by component name */
  readonly uses = new Map<string, Use[]>();
  /** the scripts of the components the page uses: module and local name in the page module */
  readonly scripts = new Map<string, { module: string; local: string; name: string; lazy?: string[] }>();
  /** `data-sn-import`: each lazy package's loader, by package, with its local name in the page module */
  readonly lazyLoads = new Map<string, string>();
  /** `data-sn-preload`: the lazy packages the build preloads with the page */
  readonly preloads = new Set<string>();
  /** `merge()`/`remove()` sources: what handlers assign to state paths and components emit, by reference (`@$s3.sel`, `@ev:2:select`) */
  private readonly srcOf = new Map<string, Set<string>>();
  /** calls whose sources hold references, resolved after the walk */
  /** write-through targets whose row's source is a reference: added once it is resolved */
  private readonly pendingTargets: Array<{ ap: () => ApplyDef | null; rd: Read; ref: string }> = [];
  private readonly srcCalls: Array<{ el: P5Element; attr: string; shift: number; fn: string; offset: number; src: string[]; text: string }> = [];
  private useIds = 0;
  /** components used inside themselves: their tags (recursion points), and the definition each compiles to */
  private readonly points = new WeakMap<P5Element, string>();
  /** `<sn-component use>`: one point per candidate, rendered when `use` is its name; `key`: the value of the data that names it, for narrowing */
  private readonly choices = new WeakMap<P5Element, { name: string; key: string | null; keySrc: string | null; names: string[]; pool?: string[]; first: boolean; keys?: string[]; also?: string[]; hasElse?: boolean; group: ChoiceGroup; keyAt?: number }>();
  /** `<sn-component use>`: one choice anchor per use, its candidates gathered as the walk reaches them (`finishChoices`) */
  private readonly choiceGroups: ChoiceGroup[] = [];
  /** the `<template>` of each `if`, `for`, `else` and recursion point node, which `anchors()` turns into a pair of comments */
  private readonly anchorEls = new Map<NodeDef, P5Element>();
  /** each anchor node's start comment, once `anchors()` placed it */
  private readonly anchorStart = new Map<NodeDef, P5Node>();
  /** the head templates `anchors()` made, by template id, placed by `placeTemplates()` */
  private readonly headTemplates = new Map<number, P5Template>();
  private readonly defs = new Map<string, { tid: number; id: string; use: Use } | null>();
  /** the elements a shared definition renders as its root, by element: its row's item name; given a node even without bindings */
  private readonly defRoots = new Map<P5Element, { rt: string; node?: NodeDef }>();
  /** per definition item (`$p<tid>`): the tag attributes its uses pass (`$a` of the item), as root bindings to add after the walk */
  private readonly defAttrs = new Map<string, Map<string, Binding>>();
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
  /** a GET resource's authentication, from the operation the spec matches (\`security\`): preloads and early requests follow it */
  private readonly authOf = new Map<string, Auth>();
  /** by `<template data-sn-for>` outside templates: its reserved space and the content-sized box around it (`planSpace`) */
  private readonly spacePlan = new Map<P5Element, { sized: { el: P5Element; siblings: boolean; widths: string; ranges: Array<[number, number | undefined]> } | null; space: Reserved | null; resources: string[]; names: string[]; waitForm: 'static' | 'if'; waitOff: boolean; form: 'static' | 'if'; list: string; why: string | null; unsized: Array<{ el: P5Element; src: string | null; v: string | null }> }>();
  /** paginated lists over late data that hold no space, and why (the build prints them) */
  readonly unheld: Array<{ file: string; line: number; col: number; why: string }> = [];
  /** the placeholders' rules (`CompiledParts.paint`) */
  readonly paintRules: string[] = [];
  /** the rules that keep what follows a content-sized box invisible while its list's first rows load (`waitFor`) */
  readonly waitRules: string[] = [];
  /** each box whose following siblings wait for its list's first rows, for the build's output */
  readonly waits: Array<{ file: string; line: number; col: number; what: string; widths: string }> = [];
  private spaceN = 0;
  /** the static placeholders and their nodes, given ids after the walk (`placeholders`) */
  private readonly pendingSpace: Array<{ el: P5Element; node: NodeDef }> = [];
  /** the placeholders the walk inserted, settled after it (`settleSpace`) */
  private readonly spaces: Array<{ list: P5Element; names: string[]; k: string; space: Reserved; note: (why: string) => void; ph?: P5Element; node?: NodeDef; tpl?: P5Element }> = [];
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
  /** `sinter check`: the condition a branch is checked under, when it is not its own `data-sn-if` (the `data-sn-else` of a choice); and each `if` binding's, for its `data-sn-else` */
  private readonly branchGuard = new WeakMap<object, string>();
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
  /** `<html data-sn-swap="off">`: links to this page load it */
  swapOff = false;
  /** the kept elements (`data-sn-permanent`) and their names */
  readonly permanentEls: P5Element[] = [];
  readonly permanentNames: string[] = [];
  /** how many kept elements the walk is inside (a kept element in another is SN346) */
  private keptDepth = 0;
  /** with swaps on, whether `n` is a kept element or inside one */
  inKept(n: P5Node): boolean {
    if (!this.opts.swap) return false;
    for (let p: P5Node | null = n; p; p = (p as P5Element).parentNode as P5Node | null) if (this.permanentEls.includes(p as P5Element)) return true;
    return false;
  }
  /** the kept elements that bind (their ids from their range), and where each kept element was written */
  readonly keptBound = new Set<string>();
  readonly keptSource = new Map<string, string>();
  private readonly keptSlot = new Set<string>();
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
   * SN519: a pager link (a static query-only `href` that sets a `model` (paginate) parameter) that drops
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
  /** `model` (paginate) parameters: one is never a list */
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
    for (const p of this.pageModels) if (arrays.has(p.name)) p.report(`\`model\` (paginate) takes a URL parameter that is one value; \`$url.${p.name}\` is a list (a \`<select multiple>\` or a checkbox with a \`value\` binds it)`);
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
  /** what `prerender()` wrote for each binding it wrote into the HTML or a template's markup */
  private readonly paintValue = new Map<Binding, ConstantWrite>();
  /** what each binding in the rows of an unrolled loop writes, by the row's instance path (null: not a constant), for the second pass */
  private readonly rowPaint = new Map<Binding, Map<string, ConstantWrite | null>>();
  /** each recursion point and candidate of `<sn-component use>` (`pick`: its `use`, compiled), for `prerender()`'s decisions */
  private readonly pointOf = new Map<NodeDef, { el: P5Element; group: ChoiceGroup | null; top: boolean; pick: { code: string; deps: PathRef[] } | null }>();
  /** bindings `dropConstants` left out: constant for good */
  private readonly dropped = new Set<Binding>();
  /** the value attributes of each element, the bindings each made, and whether it was reported on (`collectConstants`) */
  private readonly attrSources: Array<{ src: P5Element; node: NodeDef; attr: string; bindings: Binding[]; noted: boolean }> = [];
  /** the first pass: what the second one writes before the layout (`CompileOptions.constants`), and the state fields they read */
  readonly constants = new Map<string, ConstantWrite[] | null>();
  readonly constantSites = new Set<string>();
  /** the first pass: the trees over the expansion limit, by key, with the limit, for the second pass to report too */
  readonly overLimit = new Map<string, number>();
  /**
   * The first pass: a copy of the markup the layout reads (before the layout), the layout's answers for its images
   * and lists then, and the styled roots in the copy, for the dry run of constant classes and styles (`dryRun`)
   */
  private dry: { doc: DefaultTreeAdapterMap['document']; styled: Set<P5Element>; imgs: string; space: string; twin: Map<P5Element, P5Element>; traces: Map<P5Element, ReserveTrace> } | null = null;
  /** the second pass: images whose `src` or `srcset` `prefold` wrote, which resolve against the page as in the browser */
  private readonly foldedUrl = new WeakSet<P5Element>();
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
      this.page.locale = { name: l.name, messages: Object.entries(opts.helpers.namespaces).find(([, v]) => v.module === '@tiaforge-ui/sinter/messages')?.[0] ?? null, localeUrl, ...(l.urls ? { ownUrls: true } : {}) };
    }
    // helpers whose declaring module reaches a lazy package: each module loads whole, when a let first needs it
    const reach = opts.lazyModule;
    if (reach) {
      const lazy = new Map<string, { i: number; name: string }>(), mods = new Map<string, number>();
      const add = (key: string, mod: string | null | undefined, name: string) => {
        if (!mod) return;
        let i = mods.get(mod);
        if (i === undefined) {
          const pkgs = reach(mod);
          if (!pkgs.length) return;
          mods.set(mod, (i = this.lazyMods.push({ module: mod, local: `$lh$${this.lazyMods.length}`, lazy: pkgs }) - 1));
        }
        if (i >= 0) lazy.set(key, { i, name });
      };
      for (const h of opts.helpers.names) { const o = opts.helpers.from?.[h]; add(h, o?.module ?? opts.helpers.module, o?.name ?? h); }
      for (const [k, v] of Object.entries(opts.helpers.namespaces)) {
        if (v.module === '@tiaforge-ui/sinter/messages') continue;
        for (const m of v.members) { const o = v.from?.[m]; add(`${k}$${m}`, o?.module ?? v.module, o?.name ?? m); }
      }
      if (lazy.size) this.page.lazy = lazy;
    }
  }

  /** the helper modules that reach lazy packages (`page.lazy` indexes them) */
  readonly lazyMods: Array<{ module: string; local: string; lazy: string[] }> = [];

  run(html: string): CompiledParts & { canonicalOnly?: boolean } {
    return this.finishPage(this.walkPage(html));
  }

  /** the diagnostics `walkPage` reported, before anything evaluated the page (`decideFor` keeps these) */
  private walked = 0;
  /** what `finishPage` takes over from the walk */
  private walk: { doc: DefaultTreeAdapterMap['document']; images: ReturnType<typeof rewriteImages> | undefined; paths: string[] } | null = null;

  /** The page parsed, expanded and walked: its program, up to evaluating it (`prerender`). */
  walkPage(html: string): NonNullable<Compiler['walk']> {
    let doc = parseDocument(html);
    this.tag(doc, { file: this.opts.file, src: html, chain: [] });
    if (this.isLayoutFile(this.opts.file)) this.diagnostics.push({ severity: 'error', code: 'SN318', message: 'a layout is not a page: a page uses it by its tag. Leave `src/layouts/` out of the build\'s inputs', file: this.opts.file, line: 1, col: 1 });
    else doc = this.mergeLayout(doc) ?? doc;
    this.pagesOf(doc);
    this.head = findHead(doc);
    this.expandComponents(doc, []);
    this.strayAndRepeated(doc);
    this.slotsPlaced();
    // the second pass: what the first decided, per instance, at any depth (decided templates and choices, unrolled loops)
    if (this.opts.decided?.size || this.opts.unrolled?.size) this.expandConstants(doc, '', false);
    if (this.opts.urls) this.canonical(doc);
    // a page in one language says which: `<html lang="de">`
    if (this.opts.locale) { const h = doc.childNodes.find((n): n is P5Element => isElement(n) && n.tagName === 'html'); if (h) setAttr(h, 'lang', this.opts.locale.name); }
    // the page's language, for what the build sorts (`order` on a `file:` list): its `<html lang>`, the layout's included
    { const h = doc.childNodes.find((n): n is P5Element => isElement(n) && n.tagName === 'html'); this.pageLang = (h && attr(h, 'lang')) || undefined; }
    this.checkHead();
    const twice = this.componentIds();
    for (const { el, why } of this.repeatedIds) {
      const site = this.siteKey(el);
      if (site && twice.has(site)) continue;
      if (site) twice.add(site);
      this.report(el, 'id', 'SN532', `\`id="${attr(el, 'id')}"\` is in markup that renders more than once (${why}): the page would have that id more than once`, 0,
        `compute it from the row: \`data-sn-attr="{ id: '${attr(el, 'id')}-' + item.id }"\`, or move the element out of the repeated markup`);
    }
    // the second pass: bindings the first found constant for good, written before the layout and the images read the markup
    if (this.opts.constants?.size) this.prefold(doc);
    const sheets = this.opts.styles ?? this.opts.images?.styles;
    // builds: comments and white space that show nothing out, before anything counts nodes (docs/minify.md)
    if (this.opts.minify) this.minify(doc);
    // the first pass: a copy of the markup the layout reads, for the dry run of constant classes and styles (`dryRun`)
    if (sheets?.length && this.collecting()) this.snapshot(doc);
    const layout = this.layout = sheets?.length ? new Layout(sheets, doc, this.layoutOptions()) : null;
    // the lists whose rows arrive after the first paint: their space, before anything else reads the markup's bindings
    if (layout) this.planSpace(doc, layout);
    if (layout && this.dry) { this.dry.imgs = this.layoutAnswers(doc, layout); this.dry.space = this.spaceAnswers(); }
    const images = this.opts.images ? rewriteImages(doc, {
      host: this.opts.images, root: this.opts.root,
      ...(layout ? { layout: (el: P5Element) => layout.box(el), maxWidth: (el: P5Element) => layout.maxWidth(el), fluidSizes: (el: P5Element, w?: number) => layout.fluidSizes(el, w), autoFitRows: () => layout.autoFitRows, scaled: (el: P5Element, what: 'box' | 'bound') => this.scaledWidth(layout, el, what) } : {}),
      // a folded `src` is the URL the browser would have loaded, relative to the page
      fileOf: (el) => (this.foldedUrl.has(el) ? this.opts.file : this.origins.get(el)?.file ?? this.opts.file),
      warn: (el, a, code, message, hint) => this.report(el, a, code, message, 0, hint),
    }) : undefined;
    this.declare(doc);
    const paths = this.pathPatterns(doc);
    this.pathList = paths;
    this.walkChildren(doc, { scope: { loops: [], states: [] }, list: this.roots, tid: -1, path: [], stateIdx: -1 });
    this.finishTreeFills();
    this.defRootBindings();
    this.finishChoices();
    this.resolveSources();
    this.fileUses();
    // the component's name on its root: in dev builds for devtools, and on pages with scoped styles,
    // which start at the roots and stop at other components' roots and at slot content (`data-sn-s`)
    const styled = [...this.uses.keys()].filter((n) => this.componentFiles.get(n)?.css);
    if (this.opts.dev || styled.length) for (const list of this.uses.values()) for (const u of list) {
      if (u.head) continue;
      // a chain root: each branch carries it; a fill that is the root is the caller's markup, and a component tag's root the inner component's
      for (const el of u.shape ? landingOf(u.shape).filter((e) => !this.slotOf.has(e)) : [u.root]) setAttr(el, 'data-sn-c', u.name);
    }
    // an element that is also the root of outer components (through their tag as root): their names, for their root rules
    if (styled.length) for (const list of this.uses.values()) for (const u of list) for (const el of this.rootMarked(u)) {
      const outer = [...new Set((this.landing.get(el) ?? []).filter((x) => x.name !== u.name && this.componentFiles.get(x.name)?.css).map((x) => x.name))];
      if (outer.length) { setAttr(el, 'data-sn-r', outer.join(' ')); for (const n of outer) this.rootStyled.add(n); }
    }
    if (styled.length) for (const x of this.slotEls) if (attr(x.el, 'data-sn-c') === undefined) setAttr(x.el, 'data-sn-s', x.caller);

    for (const [name, id] of this.embedded) {
      const r = this.resources.find((x) => x.name === name);
      if (r) r.data = id;
    }
    this.fileScripts(doc);
    this.declareLayers(doc);
    if (this.opts.embed) this.addPlaceholders(doc);
    this.placeholders();
    for (const info of this.page.resources.values()) {
      if (!info.used) {
        const el = this.resourceEls.get(info.name)!;
        this.report(el, 'name', 'SN501', `resource \`${info.name}\` is declared but never read`, 0);
      }
    }
    this.runTargets();
    if (this.opts.swap && !this.swapOff) this.swapScripts(doc);
    this.runCycles();
    for (const el of this.remove) detach(el);
    this.markLowPriority();
    this.walked = this.diagnostics.length;
    return (this.walk = { doc, images, paths });
  }

  /**
   * An element's `data-sn-style` entries as one binding (`Binding.g`): its function returns the values in the
   * order of its names, which are listed once per distinct list in the IR (`sg`), and the runtime writes those
   * that changed. What a page with many styled elements ships (a component library that renders a tree, one
   * element per node, each with the properties it may have) is then one function and one binding per element,
   * not one of each per property. Entries that all read one object under their own key
   * (`{ color: node.style.color, 'font-size': node.style['font-size'] }`) read it once. Only plain entries are
   * grouped: not one that reads `$el` or compares a row with an outer value (`s`). The names stay the literal
   * keys the compiler checked; the runtime sets only those.
   */
  groupStyles(): string[][] {
    const lists: string[][] = [], byKey = new Map<string, number>();
    const prefix = '($) => (';
    const group = (node: NodeDef) => {
      const st = node.b.filter((b) => b.k === 'style' && b.n !== undefined && b.f !== undefined && !b.e && !b.s);
      if (st.length < 2) return;
      const codes = st.map((b) => this.fns[b.f!]!);
      if (!codes.every((c) => c.startsWith(prefix) && c.endsWith(')'))) return;
      const exprs = codes.map((c) => c.slice(prefix.length, -1));
      const names = st.map((b) => b.n!);
      // one object read under each entry's own name: read it once
      let object: string | null = null;
      const reads = exprs.map((x) => {
        let n: acorn.Expression;
        try { n = parseExpression(x) as acorn.Expression; } catch { return null; }
        if (n.type !== 'MemberExpression') return null;
        const key = n.computed ? (n.property.type === 'Literal' && typeof n.property.value === 'string' ? n.property.value : null) : (n.property as acorn.Identifier).name;
        return key === null ? null : { object: x.slice(n.object.start, n.object.end), key };
      });
      if (reads.every((r, i) => r && r.key === names[i] && r.object === reads[0]!.object)) object = reads[0]!.object;
      const code = object !== null
        ? `($) => (((o) => [${names.map((n) => (/^[A-Za-z_$][\w$]*$/.test(n) ? `o.${n}` : `o[${JSON.stringify(n)}]`)).join(', ')}])(${object}))`
        : `($) => ([${exprs.map((x) => `(${x})`).join(', ')}])`;
      const key = JSON.stringify(names);
      let g = byKey.get(key);
      if (g === undefined) byKey.set(key, (g = lists.push(names) - 1));
      const d = new Map<string, PathRef>();
      for (const b of st) for (const x of b.d ?? []) d.set(JSON.stringify(x), x);
      const merged = this.binding({ k: 'style', f: this.fn(code, this.fnAt[st[0]!.f!] ?? null), g, ...(d.size ? { d: [...d.values()] } : {}), ...(st.some((b) => b.i) ? { i: 1 as const } : {}) });
      for (const b of st) if (--this.fnUses[b.f!]! === 0) this.fns[b.f!] = '0';
      const at = node.b.indexOf(st[0]!);
      node.b = node.b.flatMap((b, i) => (i === at ? [merged] : st.includes(b) ? [] : [b]));
    };
    for (const n of this.roots) group(n);
    for (const t of this.templates) for (const n of t.nodes) group(n);
    return lists;
  }

  /** The walked page evaluated, its constants written and dropped, and its HTML, IR and module parts. */
  finishPage({ doc, images, paths }: NonNullable<Compiler['walk']>): CompiledParts & { canonicalOnly?: boolean } {
    if (this.opts.prerender) { this.prerender(); this.embedFolded(); this.dropConstants(); this.dropFiles(); this.foldScriptsOut(); if (this.collecting()) this.collectConstants(); }
    this.anchors();
    let early = this.opts.early ? this.earlyParts() : undefined;
    this.placeTemplates(doc, early);
    if (early && this.opts.sourcemap) early.sources = this.sourcesOf(early.fns, this.earlySites);
    // (after the passes that read one binding per property: the constants written at build time, the early file)
    const styleGroups = this.groupStyles();
    // row templates (data-sn-for) get a compiled element lookup; if/else branches render once per
    // toggle and use the generic path walk, which costs no code per template
    const rowTemplates = new Set([...this.roots, ...this.templates.flatMap((t) => t.nodes)].flatMap((n) => n.b.filter((b) => b.k === 'for').map((b) => b.x!)));
    this.at = null;
    for (const t of this.templates) {
      // (a wrapper's rows are not cloned: nothing to look up)
      if (!t.nodes.length || !rowTemplates.has(t.id) || t.a) continue;
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
      for (const r of runtime) this.diagnostics.push({ severity: 'error', code: 'SN322', message: `${page} must ship no JavaScript (\`sinter({ static })\`), but ${r.what} runs in the browser`, file: r.file, line: r.line, col: r.col, hint: 'make it a constant (a literal, a prop given as one, state nothing writes: those are written into the HTML at build time), remove it, or take the page out of `static` in vite.config' });
    }
    if (isStatic && early !== undefined) early = null;
    if (isStatic) this.linkStyles(doc, images?.css ? this.opts.images?.stylesheet ?? null : null);
    else this.injectScript(doc, early !== undefined && (early !== null || !!this.opts.early!.module) ? this.opts.early!.src ?? null : null);
    // a template whose content is one element (foreign content: inside its <svg> or <math>) is marked, so the runtime
    // clones that element alone; a later minifier can only drop whitespace, which leaves an unmarked one correct
    for (const [tid, tpl] of this.headTemplates) {
      const t = this.templates[tid], top = tpl.content.childNodes, kids = t?.w ? (top[0] as P5Element | undefined)?.childNodes ?? [] : top;
      if (t && kids.length == 1 && 'tagName' in kids[0]!) t.o = 1;
    }
    const ir: IR = { v: 2, resources: this.resources, syncs: this.syncs, roots: this.roots, templates: this.templates, actions: this.actions };
    if (styleGroups.length) ir.sg = styleGroups;
    if (this.page.usesNow) ir.now = true;
    // lets that wait for a lazy helper module (lets.ts), each module loaded by a function of the table
    const lazyHelpers = this.lazyMods.filter((_, i) => this.fns.some((c) => c.includes(`$.$z(${i}, `)));
    if (lazyHelpers.length) {
      this.features.add('lets');
      ir.lm = this.lazyMods.map((m) => this.fn(lazyHelpers.includes(m) ? `() => ${m.local}()` : '() => null', null));
    }
    if (paths.length) ir.path = paths;
    const arrays = this.urlArrays();
    if (arrays.length) ir.urlArrays = arrays;
    this.checkUrlArrays(new Set(arrays));
    const builtin: string[] = [];
    const user: string[] = [];
    // a lazy module's helpers are not imported: the module loads when a let needs it
    // and a helper whose every call ran at build time (written into the HTML) is not imported either
    const live = this.fns.filter((c) => c !== '0').join('\n');
    const imported = (key: string) => !this.page.lazy?.has(key) && new RegExp(`(?<![\\w$.])${key.replace(/\$/g, '\\$')}(?![\\w$])`).test(live);
    for (const h of [...this.page.usedHelpers].sort()) if (imported(h)) (this.page.helpers.has(h) ? user : builtin).push(h);
    const namespaces: Record<string, string[]> = {};
    for (const [k, v] of [...this.page.usedNs].sort(([a], [b]) => a.localeCompare(b))) {
      const ms = [...v].filter((m) => imported(`${k}$${m}`)).sort();
      if (ms.length) namespaces[k] = ms;
    }
    // unchanged reloads skipped by version, where reloads are routine: refreshes, refresh events and reconnects
    if (this.features.has('refresh') || this.features.has('sse')) this.features.add('versions');
    // a handler or model that writes `$url`: the query string follows (location.ts)
    if (this.page.writesUrl) this.features.add('location');
    // same-page links: the module, and location.ts for the history, on pages with one the build can see.
    // Not with `<base href>`: links resolve against it, not the page's URL
    // a page per entry is written at a fixed path: what its pattern's parameters were is the entry's, not the URL's
    if (this.pagesDecl) {
      const params = new Set(this.pagesDecl.pattern.split('/').filter((x) => x[0] === ':').map((x) => x.slice(1)));
      const read = new Set<string>();
      eachPath(ir, (p) => { if (typeof p === 'string' && p.startsWith('$url.')) { const n = p.slice(5).split('.')[0]!; if (params.has(n)) read.add(n); } }, () => {});
      for (const n of [...read].sort()) this.report(this.pagesDecl.html, 'data-sn-for', 'SN345', `\`$url.${n}\` on a page per entry (\`data-sn-for\` on \`<html>\`): each entry's page is written at its own path, so \`:${n}\` is the entry's field, \`${this.pagesDecl.name}.${n}\``, 0);
    }
    const reads = this.urlReads(ir, paths), own = this.ownPaths(paths);
    if (reads) this.checkDroppedQuery(reads, paths);
    // `navigate()` may go to this page with another query too: the build cannot see where, so it loads the module
    const navigates = this.fns.some((c) => c.includes('$f.navigate('));
    if (reads && !hasBase(doc) && (navigates || this.seesSameLink(own))) { ir.urlReads = reads; this.features.add('query-links'); this.features.add('location'); }
    this.fileJson();
    return {
      ...(this.jsonOut.size ? { json: this.jsonOut } : {}),
      ...(this.lateDiags.length ? { lateDiagnostics: this.lateDiags } : {}),
      html: parse5.serialize(doc),
      runtime, ...(isStatic ? { static: true as const } : {}), ...(isStatic && this.canonicalLink ? { canonicalOnly: true } : {}),
      ir, fns: this.fns,
      ...(this.opts.prerender ? { fixedState: this.fixedState() } : {}),
      ...(this.opts.sourcemap ? { sources: this.sourcesOf(this.fns) } : {}),
      features: [...(this.opts.dev ? ['dev'] : []), ...['sse', 'optimistic', 'paginate', 'persist', 'cache', 'versions', 'refresh', 'for', 'options', 'keys', 'write-through', 'fields', 'form', 'select', 'location', 'typing', 'query-links', 'navigate', 'call', 'debounce', 'confirm', 'models', 'transition', 'components', 'nested', 'lets'].filter((f) => this.features.has(f))],
      helpers: { user, builtin }, namespaces, calls: [...this.calls].sort(),
      diagnostics: this.diagnostics, files: [...this.files].sort(), ...(this.fileGlobs.length ? { globs: this.fileGlobs } : {}), ...(this.pagesOut ? { pages: this.pagesOut } : {}),
      ...(this.check ? { check: this.check } : {}),
      ...(early !== undefined ? { early } : {}),
      ...(images ? { images } : {}),
      ...(this.opts.paintCss ? { paint: [...this.paintRules, ...this.waitRules].join('\n') + (this.paintRules.length + this.waitRules.length ? '\n' : '') } : {}),
      ...(this.unheld.length ? { unheld: this.unheld } : {}),
      ...(this.waits.length ? { waits: this.waits } : {}),
      ...(this.remoteUsed ? { remote: this.opts.remoteImages!, remoteWidths: [...this.remoteWidths].sort((a, b) => a - b) } : {}),
      prefetch: this.prefetchOff ? null : this.prefetchParts(),
      embed: this.embedSlots(),
      ...(this.prefetchOff ? { prefetchOff: true as const } : {}),
      ...(this.permanentNames.length ? { permanent: [...this.permanentNames], keptSource: Object.fromEntries(this.keptSource), ...(this.keptBound.size ? { keptBound: [...this.keptBound] } : {}) } : {}),
      ...(this.swapOff ? { swapOff: true as const } : {}),
      ...(this.unlisted.size ? { unlistedOrigins: [...this.unlisted].sort() } : {}),
      styles: [...this.uses.keys()].sort().flatMap((n) => {
        const f = this.componentFiles.get(n), css = f?.css;
        // the root rules of a component that is the root of another component's tag, outside its scope
        const plain = css && this.rootStyled.has(n) ? rootCss(f!.rawCss ?? '', n) : null;
        const root = plain && f!.lib ? `@layer ${LIBRARY_LAYER} {\n${plain}\n}\n` : plain;
        return css ? [{ name: n, css: root ? css + root : css }] : [];
      }),
      scripts: [...this.scripts].sort(([a], [b]) => a.localeCompare(b)).map(([name, x]) => ({ name, module: x.module, local: x.local, export: x.name, ...(x.lazy ? { lazy: x.lazy } : {}) })),
      lazy: [...this.lazyLoads].map(([spec, local]) => ({ spec, local })),
      lazyHelpers,
      preload: [...this.preloads].sort(),
    };
  }

  /** A kept template (`fromTemplate`): whether its program is the same for every entry (no entry's URL in it). */
  entryProgram(): boolean {
    return !!this.pagesDecl && this.fileData.has(this.pagesDecl.name) && !this.page.readsUrl;
  }

  /** Two walks of one template, for two entries: the same program (the functions they compiled, in order). */
  sameProgram(other: Compiler): boolean {
    return this.fns.length === other.fns.length && this.fns.every((f, i) => f === other.fns[i])
      && this.templates.length === other.templates.length && this.paints.length === other.paints.length;
  }

  /**
   * A kept template evaluated for one of its entries (`fromTemplate`): the entry's value in place of the one walked,
   * and what the evaluation decides, afresh. Nothing is written into the markup (`prerender(true)`), so each entry
   * starts from the same walk.
   */
  decideFor(options: CompileOptions) {
    (this as { opts: CompileOptions }).opts = { ...this.opts, page: options.page, foldLog: options.foldLog };
    this.fileData.get(this.pagesDecl!.name)!.value = options.page!.value;
    this.diagnostics.length = this.walked;
    for (const m of [this.decided, this.undecided, this.unrolls, this.foldReads, this.overLimit, this.constants, this.constantSites, this.rowPaint, this.foldWhy, this.painted, this.tplPainted, this.paintValue, this.textFolded]) m.clear();
    this.foldedFields.length = 0;
    this.prerender(true);
    // the constants the layout and the images read: those of rows come from the evaluation (`rowPaint`); one written into
    // the first pass's own markup and dropped from it (`dropConstants`) needs that pass, so this entry is compiled the usual way
    this.needsMarkup = this.collecting() && this.constantSources().some(({ s }) => !s.bindings.every((b) => this.rowPaint.has(b)) && s.bindings.every((b) => this.paintValue.has(b)));
    if (this.collecting() && !this.needsMarkup) this.collectConstants(true);
  }

  /** `decideFor`: a constant the layout or the images read is one the first pass writes into its own markup */
  needsMarkup = false;

  // ---- positions and diagnostics

  tag(node: P5Node | P5Parent, origin: Origin) {
    this.origins.set(node, origin);
    // a `<template data-sn-…>` inside `<svg>` or `<math>`: parse5 gives a foreign template its children and no
    // content; it gets a content fragment, as an HTML template has, and `anchors()` wraps its head template
    if ((node as P5Element).nodeName === 'template' && !(node as P5Template).content) {
      const el = node as P5Template, frag = parse5.defaultTreeAdapter.createDocumentFragment();
      if (el.attrs.some((a) => a.name === 'data-sn-for' || a.name === 'data-sn-if' || a.name === 'data-sn-else')) {
        for (const c of el.childNodes) { c.parentNode = frag as never; frag.childNodes.push(c as never); }
        el.childNodes = [];
      }
      el.content = frag;
    }
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
    let ast: acorn.Expression;
    try {
      ast = parseExpression(text);
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

  /**
   * `paginate="{ keyset: { before: $item.id }, size: 20 }"` (docs/pagination.md): how a list pages, as one object literal.
   * The mode is the key (`keyset` or `append` with the cursor, `numbered: true`); `size`; `model: $url.page` (numbered);
   * `jump: true` (keyset, by `params.offset`); `params` and `directions`, the server's names, over the API's
   * (`sinter({ apis: { main: { paginate } } })`). Parsed once per element; null after reporting what is wrong.
   */
  pageSpec(el: P5Element): PageSpec | null {
    if (this.pageSpecs.has(el)) return this.pageSpecs.get(el)!;
    const spec = this.readPageSpec(el);
    this.pageSpecs.set(el, spec);
    return spec;
  }

  private readPageSpec(el: P5Element): PageSpec | null {
    const text = attr(el, 'paginate');
    if (text == null) return null;
    const EXAMPLE = '`paginate="{ keyset: { before: $item.id }, size: 20 }"`, `{ numbered: true, size: 10 }` or `{ append: { before: $item.id }, size: 20 }`';
    const fail = (message: string, offset = 0) => { this.report(el, 'paginate', 'SN401', message, offset); return null; };
    if (/^\s*(keyset|offset|append)\s*$/.test(text)) return fail(`\`paginate\` is one object literal now: ${this.legacyPaginate(el) ?? EXAMPLE}`);
    let ast: acorn.Expression;
    try { ast = parseExpression(text); } catch (e) { return fail(`\`paginate\`: ${(e as Error).message.replace(/ \(\d+:\d+\)$/, '')}`, (e as { pos?: number }).pos ?? 0); }
    if (ast.type !== 'ObjectExpression' || ast.end !== text.trimEnd().length) return fail(`\`paginate\` is an object literal: ${EXAMPLE}`);
    const lead = text.length - text.trimStart().length;
    const spec: PageSpec = { mode: 'keyset', size: 0, cursor: null, model: null, jump: false, skip: false, params: {}, directions: null };
    let modes = 0;
    const seen = new Set<string>();
    const strings = (v: acorn.Node, keys: readonly string[], what: string): Record<string, string> | null => {
      const o = v as acorn.Expression;
      if (o.type !== 'ObjectExpression') return fail(`\`${what}\` is an object literal of strings`, o.start);
      const out: Record<string, string> = {};
      for (const q of o.properties) {
        if (q.type !== 'Property' || q.computed || q.kind !== 'init' || q.method || q.shorthand) return fail(`\`${what}\` is an object literal of strings`, q.start);
        const k = q.key.type === 'Identifier' ? q.key.name : q.key.type === 'Literal' ? String(q.key.value) : '';
        if (!keys.includes(k)) return fail(`\`${k}\` is not a key of \`${what}\`; it takes ${keys.map((x) => `\`${x}\``).join(', ')}.${didYouMean(k, keys)}`, q.key.start);
        if (q.value.type !== 'Literal' || typeof q.value.value !== 'string' || !q.value.value) return fail(`\`${what}.${k}\` is a non-empty string literal`, q.value.start);
        if (what === 'params' && !/^[\w.\-[\]]+$/.test(q.value.value)) return fail(`\`params.${k}\` is a query parameter name`, q.value.start);
        out[k] = q.value.value;
      }
      return out;
    };
    for (const p of ast.properties) {
      if (p.type !== 'Property' || p.computed || p.kind !== 'init' || p.method || p.shorthand) return fail(`\`paginate\` takes \`key: value\` entries: ${EXAMPLE}`, p.start);
      const key = p.key.type === 'Identifier' ? p.key.name : p.key.type === 'Literal' ? String(p.key.value) : '';
      if (seen.has(key)) return fail(`\`${key}\` is given twice in \`paginate\``, p.key.start);
      seen.add(key);
      const v = p.value as acorn.Expression;
      if (key === 'keyset' || key === 'append') {
        modes++;
        spec.mode = key;
        if (v.type !== 'ObjectExpression') return fail(`\`${key}\` is the cursor, an object literal read on the boundary item, \`$item\`: \`${key}: { before: $item.id }\``, v.start);
        spec.cursor = { text: text.slice(v.start, v.end), at: v.start };
      } else if (key === 'offset') {
        return fail('`offset: true` is renamed to `numbered: true` (pages by number; `numbered: \'offset\'` sends the items to skip): `{ numbered: true, size: 10 }`', p.key.start);
      } else if (key === 'numbered') {
        modes++;
        spec.mode = 'numbered';
        // `true`: the page number; `'offset'`: the items to skip (a server that skips by offset)
        if (v.type !== 'Literal' || (v.value !== true && v.value !== 'offset')) return fail('`numbered` takes `true` (sends the page number) or `\'offset\'` (sends the items to skip): `{ numbered: true, size: 10 }`', v.start);
        spec.skip = v.value === 'offset';
      } else if (key === 'size') {
        if (v.type !== 'Literal' || typeof v.value !== 'number' || !Number.isInteger(v.value) || v.value <= 0) return fail('`size` is the number of items per page, a positive whole number', v.start);
        spec.size = v.value;
      } else if (key === 'model') {
        const name = v.type === 'MemberExpression' && !v.computed && v.object.type === 'Identifier' && v.object.name === '$url' && v.property.type === 'Identifier' ? v.property.name : null;
        spec.model = { name, at: v.start };
      } else if (key === 'jump') {
        if (v.type !== 'Literal' || v.value !== true) return fail('`jump` takes `true`: page numbers on a keyset list, sent as `params.offset`', v.start);
        spec.jump = true;
      } else if (key === 'params') {
        const o = strings(v, ['size', 'page', 'offset', 'direction'], 'params');
        if (!o) return null;
        spec.params = o;
      } else if (key === 'directions') {
        const o = strings(v, ['first', 'prev', 'next', 'last'], 'directions');
        if (!o) return null;
        spec.directions = o;
      } else {
        const KEYS = ['keyset', 'append', 'numbered', 'size', 'model', 'jump', 'params', 'directions'];
        return fail(`\`${key}\` is not a key of \`paginate\`; it takes ${KEYS.map((x) => `\`${x}\``).join(', ')}.${didYouMean(key, KEYS)}`, p.key.start);
      }
    }
    if (modes !== 1) return fail(`\`paginate\` names one mode, \`keyset\`, \`append\` (each with its cursor) or \`numbered: true\`: ${EXAMPLE}`, lead);
    if (!spec.size) return fail('`paginate` needs `size`, the number of items per page', lead);
    if (spec.model && spec.mode !== 'numbered') return fail(`\`model\` is for numbered lists, where every move has a page number when it is made; ${spec.mode === 'append' ? 'append lists load more by cursor' : 'keyset lists move by cursor, and their page number is often unknown'}`, spec.model.at);
    if (spec.jump && spec.mode !== 'keyset') return fail(`\`jump\` is for \`keyset\` lists; ${spec.mode === 'numbered' ? 'a numbered list jumps already' : 'append lists only load more'}`, lead);
    if (spec.directions && spec.mode === 'numbered') return fail('`directions` is for `keyset` and `append` lists; a numbered list sends page numbers', lead);
    // names this list never sends (an API's `params` may name them for its other lists)
    if (spec.params.page && spec.mode !== 'numbered') return fail('`params.page` is for numbered lists; a keyset or append list moves by its cursor', lead);
    if (spec.params.offset && !spec.skip && !spec.jump) return fail(`\`params.offset\` names a parameter this list does not send: only \`numbered: 'offset'\` and \`jump: true\` send the items to skip${spec.mode === 'numbered' ? `; write \`numbered: 'offset'\` to send them instead of the page number` : spec.mode === 'keyset' ? '; add `jump: true` for page numbers' : ''}`, lead);
    if (spec.params.direction && spec.mode === 'numbered') return fail('`params.direction` is for `keyset` and `append` lists; a numbered list sends page numbers', lead);
    return spec;
  }

  /** the old attributes (`paginate="keyset" size="20" cursor="{…}" …`) as the object that replaces them, or null */
  legacyPaginate(el: P5Element): string | null {
    const mode = attr(el, 'paginate')?.trim();
    if (mode !== 'keyset' && mode !== 'offset' && mode !== 'append') return null;
    const parts: string[] = [];
    const cursor = attr(el, 'cursor')?.trim(), offset = attr(el, 'offset-param')?.trim();
    parts.push(mode === 'offset' ? (offset ? "numbered: 'offset'" : 'numbered: true') : `${mode}: ${cursor ? itemCursor(cursor) : '{ … }'}`);
    parts.push(`size: ${attr(el, 'page-size')?.trim() || '…'}`);
    const pm = attr(el, 'page-model')?.trim();
    if (pm) parts.push(`model: ${pm}`);
    if (mode === 'keyset' && offset) parts.push('jump: true');
    const params = [['size', 'size-param'], ['page', 'page-param'], ['offset', 'offset-param'], ['direction', 'direction-param']]
      .map(([k, a]) => [k, attr(el, a!)?.trim()] as const).filter(([k, v]) => v && !(k === 'offset' && v === 'offset')).map(([k, v]) => `${k}: '${v}'`);
    if (params.length) parts.push(`params: { ${params.join(', ')} }`);
    const dirs = attr(el, 'direction-values')?.trim();
    if (dirs) parts.push(`directions: ${dirs}`);
    return `\`paginate="{ ${parts.join(', ')} }"\``;
  }


  /**
   * SN540: with swaps on, a script in the body that a swap would not run (inline or classic: the module
   * of the next page is the only script a swap runs), on a page that does not opt out
   */
  private swapScripts(doc: P5Parent) {
    const DATA = /^(application\/(ld\+)?json|speculationrules|importmap)$/i;
    const visit = (n: P5Parent) => {
      for (const c of n.childNodes) {
        if (!isElement(c)) continue;
        if (c.tagName === 'script') {
          const type = (attr(c, 'type') ?? '').trim(), src = attr(c, 'src');
          if (DATA.test(type)) continue;
          if (src === undefined || !/^module$/i.test(type)) {
            this.report(c, null, 'SN540', `${src === undefined ? 'an inline' : 'a classic'} script${src === undefined ? '' : ` (\`${src}\`)`} in the body does not run when a link swaps this page in (\`sinter({ swap: true })\`), only on a page load`, 0,
              'move what it does into the page\'s code (a component script or the actions module), load it as `<script type="module" src>` in the head, or take the page out with `<html data-sn-swap="off">`');
          }
          continue;
        }
        visit(c);
        const t = (c as P5Element & { content?: P5Parent }).content;
        if (t) visit(t);
      }
    };
    const body = findBody(doc);
    if (body) visit(body);
  }

  report(el: P5Element | null, attr: string | null, code: Code, message: string, offset: number, hint?: string, inExpr = false) {
    const origin = (el && this.origins.get(el)) || { file: this.opts.file, src: '', chain: [] };
    const base = el ? this.valueOffset(el, attr) : 0;
    const { line, col } = el?.sourceCodeLocation ? this.lineCol(origin.src, base + offset) : { line: 1, col: 1 };
    let msg = message;
    if (origin.usedAt) msg += ` … used at ${origin.usedAt}`;
    else if (origin.chain.length) msg += ` (included from ${origin.chain.join(' ← ')})`;
    const d: Diagnostic = { severity: severityOf(code), code, message: msg, file: origin.file, line, col };
    if (hint) d.hint = hint;
    const loc = el?.sourceCodeLocation;
    if (loc && !inExpr && offset === 0) {
      const a = attr ? loc.attrs?.[attr] : null;
      // an element's tag name; a comment (SN105), the whole comment
      const [from, to] = a ? [a.startOffset, a.endOffset] : el!.tagName ? [loc.startOffset + 1, loc.startOffset + 1 + el!.tagName.length] : [loc.startOffset, loc.endOffset];
      const start = this.lineCol(origin.src, from);
      const end = this.lineCol(origin.src, to);
      d.span = { line: start.line, col: start.col, endLine: end.line, endCol: end.col };
    }
    this.diagnostics.push(d);
  }

  reporter(el: P5Element, attr: string, shift = 0): ExprOptions['report'] {
    return (code, message, offset, hint) => this.report(el, attr, code, message, offset + shift, hint, true);
  }

  // ---- components

  /**
   * A component's or a layout's `data-sn-props`, under the name the compiler reads for its kind (`data-sn-component`,
   * `data-sn-head`, `data-sn-layout`), with its place in the source, so diagnostics point at what was written. The
   * old names written in the file are SN101.
   */
  declaration(el: P5Element, as: string, retired: string[]) {
    for (const n of retired) if (attr(el, n) !== undefined) this.once(el, n, 'SN101', `\`${n}\` ${RETIRED[n]}`, 0);
    const a = el.attrs.find((x) => x.name === 'data-sn-props');
    if (!a) return;
    a.name = as;
    const loc = el.sourceCodeLocation?.attrs;
    if (loc?.['data-sn-props']) loc[as] = loc['data-sn-props'];
  }

  /** `either` components as a head or a body component, one copy of each per file (its fields are the file's) */
  private readonly kinds = new WeakMap<ComponentFile, { head?: ComponentFile; body?: ComponentFile }>();
  asKind(def: ComponentFile, head: boolean): ComponentFile {
    let k = this.kinds.get(def);
    if (!k) this.kinds.set(def, (k = {}));
    return (head ? k.head : k.body) ?? (k[head ? 'head' : 'body'] = Object.assign(Object.create(def) as ComponentFile, { head, either: false }));
  }

  /** The component file for a tag (null: a plain custom element, or not a valid component name). */
  componentFile(tag: string): ComponentFile | null {
    if (!COMPONENT_NAME.test(tag) || tag.startsWith('sn-')) return null;
    let c = this.componentFiles.get(tag);
    if (c !== undefined) return c;
    // a library's prefix: its component, public or internal, and never the app's
    const lib = this.libOfTag(tag);
    const internal = !!lib?.internal.includes(tag);
    const dir = lib ? `${normalize(lib.folder).replace(/\/$/, '')}/components${internal ? '/internal' : ''}` : this.opts.components ?? `${normalize(this.opts.root).replace(/\/$/, '')}/src/components`;
    const file = normalize(`${dir}/${tag}.html`);
    if (lib && !internal && !lib.public.includes(tag)) c = null;
    else try { c = { file, text: this.opts.readFile(file) }; } catch { c = null; }
    if (c && lib) { c.lib = lib; if (internal) c.internal = true; }
    // its kind from its markup; a component's tag in it counts by its own kind (a cycle is a body component)
    if (c) {
      this.kinding.add(tag);
      const kind = kindOfComponent(c.text, (t) => { if (this.kinding.has(t)) return null; const f = this.componentFile(t); return !f || f.either ? null : !!f.head; });
      this.kinding.delete(tag);
      if (kind === 'head') c.head = true;
      else if (kind === 'either') c.either = true;
    }
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

  /** the library whose prefix a tag has, or null */
  libOfTag(tag: string): CompileLibrary | null {
    if (!this.opts.libraries?.length) return null;
    const p = tag.split('-')[0];
    return this.opts.libraries.find((l) => l.prefix === p) ?? null;
  }

  /** the file whose markup an element is (its own origin, or the nearest ancestor's); undefined for markup sinter made */
  markupFile(el: P5Element): string | undefined {
    for (let n: P5Node | P5Parent | null = el; n; n = (n as { parentNode?: P5Parent | null }).parentNode ?? null) {
      const o = this.origins.get(n as P5Element);
      if (o) return o.file;
    }
    return undefined;
  }

  /** the package a use's component is in: its library, or null for the app's components (one package) */
  packageOf(u: Use): CompileLibrary | null {
    return this.componentFile(u.name)?.lib ?? null;
  }

  /** a use written in the markup of another package than its component's (rule 3): a new contract, outer fills do not reach into it */
  crossesPackage(u: Use): boolean {
    if (!this.opts.libraries?.length || this.defHosts.has(u.host)) return false;
    const file = this.markupFile(u.host);
    return file !== undefined && this.libOfFile(file) !== this.packageOf(u);
  }

  /** the library a file is in, or null: the app's */
  libOfFile(file: string | undefined): CompileLibrary | null {
    if (!file || !this.opts.libraries?.length) return null;
    const f = normalize(file);
    return this.opts.libraries.find((l) => f.startsWith(normalize(l.folder).replace(/\/$/, '') + '/')) ?? null;
  }

  /** a library file as messages name it: `@acme/ui/sinter/components/ui-card.html` */
  libPath(file: string): string {
    const l = this.libOfFile(file);
    const f = normalize(file), dir = l ? normalize(l.dir).replace(/\/$/, '') : '';
    return l && f.startsWith(dir + '/') ? `${l.name}/${f.slice(dir.length + 1)}` : this.rootRel(f);
  }

  /** a file relative to the root, as diagnostics name it */
  rootRel(file: string): string {
    const root = normalize(this.opts.root).replace(/\/$/, '');
    const f = normalize(file);
    return f.startsWith(root + '/') ? f.slice(root.length + 1) : f;
  }

  /** The components the markup of a file chooses among (`<sn-component use>`): a library's own (rule 7), or the app's and the libraries' public ones. */
  choicePool(file: string | undefined): string[] {
    const lib = this.libOfFile(file);
    if (lib) return [...lib.public, ...lib.internal].filter((n) => this.componentFile(n) && !this.componentFile(n)!.head).sort();
    return [...new Set([...(this.opts.componentNames ?? []), ...this.componentFiles.keys()])].filter((n) => this.componentFile(n) && !this.componentFile(n)!.head && !this.componentFile(n)!.internal).sort();
  }

  /** A library's internal component used outside its library (SN339): the error, naming the public ones. */
  internalUse(el: P5Element, def: ComponentFile, offset = 0, attrName: string | null = null): boolean {
    // a shared definition's host is sinter's: its uses were checked where they are written
    if (!def.internal || this.defHosts.has(el)) return false;
    const file = this.markupFile(el);
    if (file === undefined || this.libOfFile(file) === def.lib) return false;
    const pub = def.lib!.public;
    this.report(el, attrName, 'SN339', `\`<${el.tagName === 'sn-component' ? this.points.get(el) ?? '' : el.tagName}>\` is internal to \`${def.lib!.name}\` (\`components/internal/\`): only its own components use it`, offset,
      pub.length ? `its public components: ${pub.map((n) => `\`<${n}>\``).join(', ')}` : `\`${def.lib!.name}\` has no public components`);
    return true;
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
      this.report(el, null, 'SN318', `a page that uses the layout \`<${name}>\` is only its tag: ${isElement(c) ? `\`<${c.tagName}>\`` : 'this text'} belongs inside it`, 0,
        `put it in one of the layout's slots: \`<${name}>…</${name}>\` (a head element with \`slot="…"\` for a head slot)`);
    }
    if (html.sourceCodeLocation?.startTag && html.attrs.length) {
      this.report(html, html.attrs[0]!.name, 'SN318', `a page that uses the layout \`<${name}>\` writes the attributes of \`<html>\` on its tag: \`<${name} ${html.attrs[0]!.name}="…">\``, 0);
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
    this.declaration(lhtml, 'data-sn-layout', ['data-sn-layout']);
    // a whole document in src/layouts/ without `data-sn-props` takes no props (agents leave it out when there are
    // none: every benchmark run that did paid a failed build for it); one whose pages pass props must declare them
    const whole = !!lhtml.sourceCodeLocation?.startTag, passes = attr(host, 'data-sn-with') != null;
    const decl = attr(lhtml, 'data-sn-layout') ?? (whole && !passes ? '{}' : undefined);
    if (decl === undefined || !whole) {
      const hint = whole
        ? 'declare the props the pages pass, e.g. `<html lang="en" data-sn-props="{ title?: string }">`'
        : '`<!doctype html><html lang="en" data-sn-props="{ title?: string }"><head>…</head><body><slot></slot></body></html>` (or `<html lang="en">` for a layout without props)';
      const message = whole
        ? `\`src/layouts/${name}.html\` declares no props, but this page passes \`data-sn-with\`: a layout declares them on its \`<html>\`, \`<html data-sn-props="{ …props }">\``
        : `\`src/layouts/${name}.html\` is not a layout: a layout is a whole document whose \`<html>\` declares its props, \`<html data-sn-props="{ …props }">\``;
      this.diagnostics.push({ severity: 'error', code: 'SN318', message, file: lf.file, line: 1, col: 1, hint });
      detach(host);
      return null;
    }
    const props = typeMembers(decl.trim() === '' ? '{}' : decl)?.filter((m) => m.slot === undefined) ?? null;
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
    if (SLOT_TYPE.test(decl)) this.report(lhtml, 'data-sn-layout', 'SN331', `\`<${name}>\` is a layout: its slots pass nothing, so \`Slot<T>\` cannot be in \`data-sn-props\``, decl.search(SLOT_TYPE), 'a plain `<slot name="…">` takes content with no declaration');
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
      if (a.name === 'data-sn-with' || a.name === 'data-sn-state') continue;
      if (a.name === 'data-sn-path' || a.name === 'data-sn-prefetch' || a.name === 'data-sn-for' || a.name === 'data-sn-swap') { setAttr(lhtml, a.name, a.value); continue; }
      if (a.name === 'data-sn-pages') { this.report(host, a.name, 'SN101', `\`data-sn-pages\` ${RETIRED['data-sn-pages']}`, 0); continue; }
      if (a.name === 'data-sn-early') { this.report(host, a.name, 'SN318', '`data-sn-early` cannot be on a layout\'s tag: the layout is the whole page', 0, 'leave parts out of the early script on their own tags: `<tag-cloud data-sn-early="off">`'); continue; }
      if (a.name.startsWith('data-sn-')) {
        if (RETIRED[a.name]) this.report(host, a.name, 'SN101', `\`${a.name}\` ${RETIRED[a.name]}`, 0);
        else if (!callerAttribute(a.name) || a.name === 'data-sn-model' || a.name === 'data-sn-persist') this.report(host, a.name, 'SN102', `\`${a.name}\` cannot be on a layout's tag`, 0, 'a layout\'s tag takes `data-sn-with`, `data-sn-state`, handlers, `data-sn-class`, `-attr` and `-style`, `data-sn-path`, `data-sn-for` (a page per entry), `data-sn-prefetch` and `data-sn-swap`, and the attributes of `<html>`');
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
  expandComponents(parent: P5Parent, chain: string[], inHead = false, encl: Use | null = null) {
    for (const child of [...parent.childNodes]) {
      if (!isElement(child)) continue;
      // slot content is the caller's: it is inside the components its caller is in
      const ch = this.slotOf.get(child)?.chain ?? chain;
      const su = this.slotOf.get(child);
      // the children a fill's `<slot>` places are the markup of the placement's component, in the caller's fill
      const placedBy = this.childrenOf.get(child);
      const en = su ? this.enclosing.get(su.host) ?? null : placedBy?.length ? placedBy[placedBy.length - 1]!.use : encl;
      // (where a recursion point or a choice is: a second pass expands one the first found constant, as a use here)
      if (child.tagName === 'sn-component') { this.pointCtx.set(child, { ch, en }); this.choice(child, en); continue; }
      const def0 = this.componentFile(child.tagName);
      if (!def0 && COMPONENT_NAME.test(child.tagName) && this.libOfTag(child.tagName)) {
        const lib = this.libOfTag(child.tagName)!;
        const pool = this.libOfFile(this.origins.get(child)?.file) === lib ? [...lib.public, ...lib.internal] : lib.public;
        this.report(child, null, 'SN339', `\`<${child.tagName}>\` is not a component of \`${lib.name}\`, which owns the prefix \`${lib.prefix}-\``, 0,
          (didYouMean(child.tagName, pool).trim() || '') + (pool.length ? `${didYouMean(child.tagName, pool) ? ' ' : ''}its ${pool === lib.public ? 'public ' : ''}components: ${pool.map((n) => `\`<${n}>\``).join(', ')}` : ''));
        detach(child);
        continue;
      }
      if (def0 && this.internalUse(child, def0)) { detach(child); continue; }
      if (!def0 && this.layoutFile(child.tagName)) {
        this.report(child, null, 'SN318', `\`<${child.tagName}>\` is a layout: it is the only tag of a page, at its top level`, 0, 'a layout cannot be inside a component, another layout or other markup');
        detach(child);
        continue;
      }
      if (def0 && this.layoutFile(child.tagName)) {
        this.report(child, null, 'SN318', `\`<${child.tagName}>\` is both a layout (\`src/layouts/${child.tagName}.html\`) and a component (\`src/components/${child.tagName}.html\`); rename one`, 0);
        detach(child);
        continue;
      }
      if (def0) {
        // a component whose markup either may hold takes the kind of where it is used
        const def = def0.either ? this.asKind(def0, inHead) : def0;
        const name = child.tagName;
        // a head component goes in a head, a component in a body
        if (!!def.head !== inHead) {
          this.report(child, null, 'SN320', def.head
            ? `\`<${name}>\` is a head component (\`data-sn-props\`): it goes in a \`<head>\`, or in a layout's head slot`
            : `\`<${name}>\` is a component with one root element, which cannot be in the \`<head>\``, 0,
          def.head ? 'a component for the body has one root element in its `<template data-sn-props>`' : 'a head component is a `<template data-sn-props>` whose markup is head elements only');
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
            this.pointCtx.set(child, { ch, en });
            continue;
          }
          this.report(child, null, 'SN306', `${loop.map((n) => `\`<${n}>\``).join(' → ')} uses itself with no \`data-sn-for\` or \`data-sn-if\` template between, so it would never end`, 0,
            'only data ends a recursion: put the inner use in a `<template data-sn-for>` over the children, or a `<template data-sn-if>`');
          detach(child);
          continue;
        }
        if (def.bad) { detach(child); continue; }
        if (def.head) { this.expandUse(child, def, ch); continue; }
        this.enclosing.set(child, en);
        const root = this.expandUse(child, def, ch);
        const use = this.hostUse.get(child);
        if (root && use?.shape) {
          // a root that is not one plain element: its templates, its component tag or choice, expanded in place
          this.expandComponents({ childNodes: root.parentNode!.childNodes.filter((c) => this.scopeStart.get(c)?.includes(use)) } as unknown as P5Parent, [...ch, name], false, use);
        } else if (root) this.expandComponents(root, [...ch, name], false, use ?? null);
        continue;
      }
      const head = inHead || child.tagName === 'head';
      this.expandComponents(child, ch, head, en);
      if (child.tagName === 'template') {
        const t = attr(child, 'data-sn-for') !== undefined || attr(child, 'data-sn-if') !== undefined || attr(child, 'data-sn-else') !== undefined;
        this.expandComponents((child as P5Template).content, t ? [...ch, '#'] : ch, head, en);
      }
    }
  }

  /**
   * `<sn-component use="…" data-sn-with="…">`: a component chosen by data at runtime. `use` names it in
   * one of three forms, each of which gives the candidates:
   * - convention, ``use="`${b.type}-block`"``: the components whose names have that prefix and suffix
   *   (sinter check: the template-literal type of the data's union, which must fit `ComponentName`);
   * - map, `use="{ hero: 'hero-block', text: 'rich-text' }[b.type]"`: its values;
   * - helper, `use="blockComponent(b)"`: every component (sinter check: its return type).
   * It becomes one point per candidate (a shared definition each), of which only the one `use` names
   * renders; a `data-sn-else` template after it renders for a value outside the candidates.
   */
  choice(el: P5Element, encl: Use | null = null) {
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
      if (RETIRED[a.name]) this.report(el, a.name, 'SN101', `\`${a.name}\` ${RETIRED[a.name]}`, 0);
      else if (a.name !== 'use' && a.name !== 'data-sn-with' && a.name !== 'data-sn-early') this.report(el, a.name, 'SN101', `\`${a.name}\` is not an attribute of \`<sn-component>\`; it takes \`use\`, \`data-sn-with\` and \`data-sn-early\``, 0);
    }
    let ast: acorn.Expression | null = null;
    try { ast = use ? parseExpression(use) : null; } catch { ast = null; }
    if (!ast || ast.end !== use!.trimEnd().length) {
      return fail('`<sn-component>` takes `use`, an expression naming the component: ``use="`${b.type}-block`"``, `use="{ hero: \'hero-block\' }[b.type]"` or `use="blockComponent(b)"`');
    }
    // rule 7: in a library's markup, its own components; in the app's, the app's and the libraries' public ones
    const all = this.choicePool(this.origins.get(el)?.file);
    const lib = this.libOfFile(this.origins.get(el)?.file);
    // each candidate, and the value of the data that names it (convention, map), for narrowing
    // `also`: a map's other keys for the same component (one candidate per component, as the browser picks one)
    let cands: Array<{ name: string; key: string | null; at?: number; also?: string[] }>;
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
        if (!all.includes(v)) {
          const f = this.componentFile(v)!;
          if (lib) this.report(el, 'use', 'SN339', `\`'${v}'\` is not a component of \`${lib.name}\`: \`<sn-component use>\` in a library's markup chooses among its own components`, (p as import('acorn').Property).value.start);
          else if (f.internal) this.report(el, 'use', 'SN339', `\`'${v}'\` is internal to \`${f.lib!.name}\` (\`components/internal/\`): only its own components use it`, (p as import('acorn').Property).value.start, `its public components: ${f.lib!.public.map((n) => `\`'${n}'\``).join(', ')}`);
          else { cands.push({ name: v, key: k, at: (p as import('acorn').Property).key.start }); continue; }
          continue;
        }
        cands.push({ name: v, key: k, at: (p as import('acorn').Property).key.start });
      }
    } else if (ast.type === 'CallExpression') {
      // rule 7: in a component that declares slots, or has a tree placement, every component would be a candidate
      const g = encl ? this.fileGraph(encl.name) : null;
      if (encl && g && (encl.slots?.size || [...g.data].some((x) => !g.declares.has(x)))) {
        return fail(`\`<${encl.name}>\` ${encl.slots?.size ? 'declares slots' : 'has a tree placement'}, so \`<sn-component use>\` in it names its candidates: a template string or a map in \`use\`; a helper makes every component a candidate`);
      }
      cands = all.map((n) => ({ name: n, key: null }));
    } else if (ast.type === 'BinaryExpression' && ast.operator === '+') {
      return fail('`use` built with `+` is a `string` to TypeScript, so its candidates are unknown: write a template string, ``use="`${b.type}-block`"``');
    } else {
      return fail('`use` names the component by a template string (``use="`${b.type}-block`"``), a map (`use="{ hero: \'hero-block\' }[b.type]"`) or a helper (`use="blockComponent(b)"`)');
    }
    // every key of the map: what `use`'s key may be, and what the else is not
    const allKeys = cands.flatMap((c) => (c.key === null ? [] : [c.key]));
    if (map) {
      // a component named under two keys is one candidate with both: rendered once, as the browser's choice renders it
      const byName = new Map<string, { name: string; key: string | null; at?: number; also: string[] }>();
      for (const c of cands) { const f = byName.get(c.name); if (f) f.also.push(c.key!); else byName.set(c.name, { ...c, also: [] }); }
      cands = [...byName.values()];
    }
    const names = cands.map((c) => c.name);
    const parent = el.parentNode!;
    const at = parent.childNodes.indexOf(el as never);
    const clones: P5Element[] = [];
    const group: ChoiceGroup = { node: null, cases: [], pick: null, warn: '', site: null };
    for (const c of cands) {
      const x: P5Element = { ...el, attrs: el.attrs.map((a) => ({ ...a })), childNodes: [], parentNode: parent };
      if (this.passOn.has(el)) this.passOn.set(x, this.passOn.get(el)!);
      // a choice that is a component's root: that component's markup starts at each candidate
      if (this.scopeStart.has(el)) this.scopeStart.set(x, this.scopeStart.get(el)!);
      this.origins.set(x, this.origins.get(el)!);
      // slot content (or a fill, or children a fill places) stays that: its writer's scope
      for (const map of [this.slotOf, this.fillOf, this.defaultOf, this.childrenOf] as Array<WeakMap<object, unknown>>) if (map.has(el)) map.set(x, map.get(el));
      this.points.set(x, c.name);
      if (this.pointCtx.has(el)) this.pointCtx.set(x, this.pointCtx.get(el)!);
      this.choices.set(x, { name: c.name, key: c.key, keySrc, names, ...(lib ? { pool: [...lib.public, ...lib.internal] } : {}), first: !clones.length, group, ...(map ? { keys: allKeys } : {}), ...(c.also?.length ? { also: c.also } : {}), ...(c.at !== undefined ? { keyAt: c.at } : keySrc !== null ? { keyAt: use!.indexOf(keySrc) } : {}) });
      clones.push(x);
    }
    if (!clones.length) this.report(el, 'use', 'SN312', '`use` names no component of the app', 0);
    parent.childNodes.splice(at, 1, ...(clones as never[]));
    // a value outside the candidates: the `data-sn-else` template after it
    const next = parent.childNodes.slice(at + clones.length).find((c) => isElement(c) || (c.nodeName === '#text' && (c as DefaultTreeAdapterMap['textNode']).value.trim() !== ''));
    if (next && isElement(next) && next.tagName === 'template' && attr(next, 'data-sn-else') !== undefined) {
      next.attrs = next.attrs.filter((a) => a.name !== 'data-sn-else');
      next.attrs.push({ name: 'data-sn-if', value: `!${JSON.stringify(names)}.includes(${use})` });
      // checked where the key names no candidate, so the data narrows (`n.value` of the union's other members)
      if (keySrc !== null && cands.length && cands.every((c) => c.key !== null)) this.branchGuard.set(next, `!(${(map ? allKeys : cands.map((c) => c.key!)).map((k) => `(${keySrc}) === ${JSON.stringify(k)}`).join(' || ')})`);
      for (const c of clones) this.choices.get(c)!.hasElse = true;
    }
  }

  /** Replaces one component tag by the component's root; null when the component file is invalid. */
  expandUse(host: P5Element, def: ComponentFile, chain: string[]): P5Element | null {
    const name = host.tagName;
    const hostOrigin = this.origins.get(host) ?? { file: this.opts.file, src: '', chain: [] };
    // parsed once per file: each use takes a copy (a constant tree expands a component once per node)
    const frag = freshCopy(parsedText(def.text), null) as DefaultTreeAdapterMap['documentFragment'];
    const loc = host.sourceCodeLocation ? this.lineCol(hostOrigin.src, host.sourceCodeLocation.startOffset) : { line: 1, col: 1 };
    // a library's file: its diagnostics say where the app uses it, the first use from the app's markup
    const usedAt = hostOrigin.usedAt ?? (def.lib && !this.libOfFile(hostOrigin.file) ? `${this.rootRel(hostOrigin.file)}:${loc.line}` : undefined);
    this.tag(frag, { file: def.file, src: def.text, chain: [`${basename(hostOrigin.file)}:${loc.line}`, ...hostOrigin.chain], use: `${this.siteKey(host) ?? ''}<${hostOrigin.use ?? ''}`, ...(usedAt ? { usedAt } : {}) });
    this.files.add(def.file);
    const fail = (el: P5Element | null, a: string | null, message: string, hint?: string): null => {
      if (el) this.report(el, a, 'SN312', message, 0, hint);
      else this.diagnostics.push({ severity: 'error', code: 'SN312', message, file: def.file, line: 1, col: 1, ...(hint ? { hint } : {}) });
      def.bad = true;
      detach(host);
      return null;
    };
    const top = frag.childNodes.filter(isElement);
    for (const t of top) if (t.tagName === 'template') this.declaration(t, def.head ? 'data-sn-head' : 'data-sn-component', ['data-sn-component', 'data-sn-head']);
    const templates = top.filter((t) => t.tagName === 'template' && (attr(t, 'data-sn-component') !== undefined || attr(t, 'data-sn-head') !== undefined));
    if (templates.length !== 1) {
      return fail(templates[1] ?? null, null, `component \`<${name}>\` needs ${templates.length ? 'exactly ' : ''}one \`<template data-sn-props="{ …props }">\` (one root element, or head elements only) around its markup`,
        '`<template data-sn-props="{ article: Article }"><article>…</article></template>`');
    }
    const template = templates[0]!;
    if (attr(template, 'data-sn-component') !== undefined && attr(template, 'data-sn-head') !== undefined) {
      return fail(template, 'data-sn-head', `\`<${name}>\` declares both \`data-sn-component\` and \`data-sn-head\`, which are one \`data-sn-props\` now`, 'its markup says the kind: one root element for a body, head elements only for a head');
    }
    const decl = def.head ? 'data-sn-head' : 'data-sn-component';
    for (const t of top) {
      if (t !== template && t.tagName !== 'style') return fail(t, null, `a component file holds its \`<template data-sn-props>\` and \`<style>\`; \`<${t.tagName}>\` belongs inside the template`);
    }
    if (def.head && def.css === undefined && top.some((t) => t.tagName === 'style')) {
      def.css = null;
      this.report(top.find((t) => t.tagName === 'style')!, null, 'SN320', `the head component \`<${name}>\` has a \`<style>\` beside its template: head elements render nothing to style`, 0, 'put the CSS in a stylesheet');
    }
    if (def.head && def.script) return fail(template, null, `the head component \`<${name}>\` has a script (\`${def.script}\`); head components have none`);
    // its `<style>`, scoped to the component (read once per file)
    if (def.css === undefined) {
      const css = top.filter((t) => t.tagName === 'style').map((t) => t.childNodes.map((c) => (c as DefaultTreeAdapterMap['textNode']).value ?? '').join('')).join('\n');
      def.rawCss = css;
      try { def.css = css.trim() ? scopeCss(css, name, def.lib ? LIBRARY_LAYER : undefined) : null; } catch (e) {
        def.css = null;
        this.report(top.find((t) => t.tagName === 'style')!, null, 'SN401', `the component's \`<style>\` does not parse: ${(e as Error).message}`, 0);
      }
    }
    for (const a of template.attrs) {
      if (a.name === 'data-sn-early') this.report(template, a.name, 'SN102', '`data-sn-early` goes on a use of the component, its tag: `<' + name + ' data-sn-early="off">`', 0);
      else if (a.name !== decl && a.name !== 'data-sn-emits') this.report(template, a.name, 'SN101', `\`${a.name}\` is not an attribute of \`<template data-sn-props>\`; it takes \`data-sn-props\` and \`data-sn-emits\``, 0);
    }
    if (def.head) return this.expandHead(host, def, template, chain);
    const content = (template as P5Template).content;
    const declText = attr(template, 'data-sn-component')!;
    const members = typeMembers(declText.trim() === '' ? '{}' : declText);
    const slots = this.declaredSlots(template, members, declText);
    // `Slot<T>` members are filled with markup: they are not props
    const props = members?.filter((m) => m.slot === undefined) ?? null;
    const propsText = withoutSlots(declText);
    const emitsText = attr(template, 'data-sn-emits') ?? null;
    const emits = emitsText === null ? [] : typeMembers(emitsText);
    if (emitsText !== null && !emits) this.report(template, 'data-sn-emits', 'SN401', '`data-sn-emits` takes a type literal of the events and their detail types: `{ select: Article; close: null }`', 0);
    // sinter's events are `sn-…` (`sn-navigate`, the guard of every navigation): a component's are named otherwise
    const snEvent = emits?.find((m) => m.name.startsWith('sn-'));
    if (snEvent) this.report(template, 'data-sn-emits', 'SN209', `\`${snEvent.name}\`: names starting with \`sn-\` are sinter's events (\`sn-navigate\`, \`sn-dismiss\`, \`sn-error\`, \`sn-page\`); name the component's event otherwise`, 0);
    // a root is known once its slots are filled: a `<slot>` at the top is its fill, or its default
    const first = content.childNodes.find(isElement) ?? template;
    const use: Use = { name, file: def.file, host, root: first, template, props, propsText, emits, emitsText, chain, ...(slots.size ? { slots } : {}), ...(this.lateTag(host) ? { late: true } : {}) };

    // the table rule: a tag the parser moved out of its table
    const next = host.parentNode?.childNodes.slice(host.parentNode.childNodes.indexOf(host as never) + 1).find(isElement);
    if (next?.tagName === 'table' && next.sourceCodeLocation && host.sourceCodeLocation && next.sourceCodeLocation.startOffset < host.sourceCodeLocation.startOffset) {
      this.report(host, null, 'SN102', `\`<${name}>\` is written in a table, where the HTML parser moves it out before the table`, 0,
        `write it in the row's template, where it stays in place: \`<template data-sn-for="…"><${name} …></${name}></template>\``);
    }

    this.fillSlots(use, content);
    // a root that is not one plain element: decided now where a constant prop decides its condition
    const plainTop = () => { const r = content.childNodes.filter(realNode); return r.length === 1 && isElement(r[0]!) && plainRoot(r[0], this) ? r[0] : null; };
    const folds = !plainTop();
    if (folds) this.foldIn(content, constantProps(attr(host, 'data-sn-with'), props), use);
    // decided to render nothing for this use: the tag goes, with nothing in its place
    if (folds && !content.childNodes.some(realNode)) {
      for (const u of [use, ...(this.passOn.get(host) ?? [])]) this.emptyRootAttrs(u, name);
      detach(host);
      this.hostUse.set(host, use);
      return null;
    }
    const shape = this.rootShape(content.childNodes, name);
    if (typeof shape === 'string') {
      const els = content.childNodes.filter(isElement);
      const headEls = els.length > 1 && els.every((e) => HEAD_ELEMENTS.has(e.tagName) || e.tagName === 'slot');
      return fail(els[1] ?? els[0] ?? template, null, shape, headEls ? 'a head component holds head elements only, any number of them: move what is not one out of it'
        : 'a root renders at most one element: one element, a `data-sn-if`/`data-sn-else` chain of them, a component, `<sn-component use>` or a `<slot>` whose default and fills are roots; wrap the markup in one element');
    }
    const own = (e: P5Element) => !this.slotOf.has(e);
    const lands = landingOf(shape);
    // one plain element of the component's own: the root as before (a fill that is the root is the caller's markup)
    const root = shape.kind === 'el' && own(shape.el) ? shape.el : null;
    // a script runs on its root, and root state would reset with it: both keep one plain element
    if (!root) {
      const why = def.script ? `a script (\`${def.script}\`)` : lands.some((e) => own(e) && attr(e, 'data-sn-state') !== undefined) ? '`data-sn-state` on its root' : null;
      if (why) return fail(template, null, `\`<${name}>\` has ${why}, so its root is one plain element: a root that is replaced (an if/else chain, a component, \`<sn-component>\`, a slot) would restart it`, 'keep one element around the markup, or give defaults with `??` in the expressions');
    }
    // a script reads and writes the root's own state: there is one
    if (def.script && root && attr(root, 'data-sn-state') === undefined) root.attrs.push({ name: 'data-sn-state', value: '{}' });
    if (root) use.root = root;
    else if (lands[0]) use.root = lands[0];
    if (!root) use.shape = shape;

    // the outer components whose root this tag is: their tag's attributes land here too
    const outer = this.passOn.get(host) ?? [];
    const all = [use, ...outer];
    // a root that may render nothing takes no attribute that points at, or depends on, its element
    if (mayBeEmpty(shape)) for (const u of all) this.emptyRootAttrs(u, name);
    // a text root has no element: an attribute of the tag (or of an outer one passing on to it) has nowhere to land
    if (shape.kind === 'text') for (const u of all) for (const a of u.host.attrs) {
      if (a.name === 'slot' || a.name === 'data-sn-with' || a.name === 'data-sn-early') continue;
      this.report(u.host, a.name, 'SN334', `\`<${u.name}>\`'s root is a text here (a text fill of the \`<slot>\` at the root${u.name !== name ? ` of \`<${name}>\`` : ''}), so \`${a.name}\` on its tag has no element to land on`, 0,
        'wrap the tag in an element that carries it, or give a fill that is an element');
    }
    // the tag's attributes: plain ones move onto the root (onto each branch, onto a component tag that is
    // the root, onto a fill), sinter's are compiled on it in the caller's scope
    for (const a of host.attrs) {
      if (RETIRED[a.name]) this.report(host, a.name, 'SN101', `\`${a.name}\` ${RETIRED[a.name]}`, 0);
      else if (a.name.startsWith('data-sn-') && !callerAttribute(a.name)) this.report(host, a.name, 'SN102', `\`${a.name}\` cannot be on a component's tag`, 0, TAG_ONLY_HINT);
    }
    const plain = host.attrs.filter((a) => !a.name.startsWith('data-sn-') && a.name !== 'slot');
    for (const el of shape.kind === 'tag' ? [shape.el] : shape.kind === 'choice' ? [] : lands) {
      for (const a of plain) {
        if (a.name === 'class') {
          const cls = attr(el, 'class');
          if (cls === undefined) el.attrs.push({ name: 'class', value: a.value });
          else setAttr(el, 'class', `${cls} ${a.value}`.trim());
        } else if (attr(el, a.name) !== undefined) {
          const fill = this.slotOf.has(el) && !own(el);
          this.report(host, a.name, 'SN209', fill
            ? `\`${a.name}\` is set both here and on \`<${el.tagName}>\`, the fill of \`<${name}>\`'s \`<slot>\` that is its root; one of them would be lost`
            : `\`${a.name}\` is set both here and on the root of \`<${name}>\`; one of them would be lost`, 0);
        } else {
          el.attrs.push({ name: a.name, value: a.value });
          // the caller's, on this use only: not an id of the component's markup (`componentIds`)
          if (a.name === 'id') this.tagIds.add(el);
        }
      }
    }
    // a component tag (or a choice) as root: the outer uses pass on to it
    if (shape.kind === 'tag' || shape.kind === 'choice') this.passOn.set(shape.el, all);
    else for (const el of lands) {
      if (el === root && !outer.length) continue;
      const list = this.landing.get(el) ?? [];
      list.push(...(el === root ? outer : all));
      this.landing.set(el, list);
    }

    // the root takes the tag's place; whitespace around and between a chain's templates is dropped
    const tops = root ? [root] : content.childNodes.filter((c) => isElement(c));
    const parent = host.parentNode!;
    const i = parent.childNodes.indexOf(host as never);
    for (const t of tops) (t as { parentNode: P5Parent }).parentNode = parent;
    parent.childNodes.splice(i, 1, ...(tops as never[]));
    host.parentNode = null;
    const slotUse = this.slotOf.get(host);
    if (root) {
      if (slotUse && !this.slotOf.has(root)) this.slotOf.set(root, slotUse);
      this.useOf.set(root, use);
      // the outer components' markup starts here, before this one's (outer first: `passOn` lists the nearest first)
      if (outer.length) this.scopeStart.set(root, [...outer].reverse());
    } else {
      use.hostSlot = slotUse;
      for (const t of tops) this.scopeStart.set(t, [...[...outer].reverse(), use]);
    }
    this.hostUse.set(host, use);
    if (!this.uses.has(name)) this.uses.set(name, []);
    this.uses.get(name)!.push(use);
    return root ?? (tops[0] as P5Element | undefined) ?? null;
  }

  /**
   * What a component's root is, from the nodes at the top of its template (its slots filled): an
   * error message when it can render more than one element, or text.
   */
  rootShape(nodes: P5Node[], name: string): RootShape | string {
    const real = nodes.filter(realNode);
    const text = real.find((c) => !isElement(c));
    if (text) return `a component's root renders at most one element; \`<${name}>\` has text at the top of its template${this.slotOf.has(text) ? ' (from a fill of its root `<slot>`)' : ''}`;
    const els = real as P5Element[];
    if (!els.length) return `\`<${name}>\` renders nothing: its template has no root element`;
    const [a, b] = els;
    if (els.length === 2 && a!.tagName === 'template' && attr(a!, 'data-sn-if') !== undefined && b!.tagName === 'template' && attr(b!, 'data-sn-else') !== undefined) {
      const x = this.branchShape(a!, name), y = this.branchShape(b!, name);
      if (typeof x === 'string') return x;
      if (typeof y === 'string') return y;
      return { kind: 'chain', templates: [a!, b!], branches: [x, y], empty: false };
    }
    if (els.length !== 1) {
      return `a component's root renders at most one element; \`<${name}>\` has ${els.length} elements at the top of its template`;
    }
    if (a!.tagName === 'template') {
      if (attr(a!, 'data-sn-if') !== undefined) {
        const x = this.branchShape(a!, name);
        return typeof x === 'string' ? x : { kind: 'chain', templates: [a!], branches: [x], empty: true };
      }
      // a caller's text fill of the root `<slot>`: the root renders one text node
      if (attr(a!, 'data-sn-text') !== undefined && this.slotOf.has(a!)) return { kind: 'text', el: a!, empty: false };
      return `a component's root renders at most one element: a \`<template${attr(a!, 'data-sn-for') !== undefined ? ' data-sn-for' : attr(a!, 'data-sn-text') !== undefined ? ' data-sn-text' : ''}>\` cannot be the root of \`<${name}>\``;
    }
    if (a!.tagName === 'sn-component') return { kind: 'choice', el: a!, empty: true };
    if (this.componentFile(a!.tagName)) return { kind: 'tag', el: a!, empty: false };
    // a tree placement in a shared definition: a choice, at run time, between its default and the fills passed down
    if (a!.tagName === 'slot' && this.runtimeSlots.has(a!)) return { kind: 'choice', el: a!, empty: false };
    if (a!.tagName === 'slot') return `the \`<slot>\` at the root of \`<${name}>\` was not filled`;
    return { kind: 'el', el: a!, empty: false };
  }

  /** A branch of a root chain: its content is a root itself. */
  branchShape(t: P5Element, name: string): RootShape | string {
    return this.rootShape((t as P5Template).content.childNodes, name);
  }

  /** `id`, `data-sn-model`, an action or `data-sn-transition` on the tag of a component whose root may render nothing: SN334. */
  emptyRootAttrs(u: Use, name: string) {
    for (const a of u.host.attrs) {
      const bad = a.name === 'id' || a.name === 'data-sn-model' || a.name === 'data-sn-transition' || /^data-sn-(get|post|put|patch|delete|call)$/.test(a.name);
      if (bad) this.report(u.host, a.name, 'SN334', `\`<${u.name}>\`'s root may render nothing${u.name !== name ? ` (through \`<${name}>\`)` : ''}, so \`${a.name}\` on its tag would point at an element that may not exist`, 0,
        'put it inside the component, on an element that is always there, or wrap the tag in an element that carries it');
    }
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
   * A head component's use (`<template data-sn-props>`): its elements, any number of them, take the
   * tag's place with no wrapper. Its tag takes only `data-sn-with` and slot content.
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
      const ok = HEAD_ELEMENTS.has(c.tagName) || c.tagName === 'slot' || this.componentFile(c.tagName)?.head || this.componentFile(c.tagName)?.either;
      if (!ok) {
        this.report(c, null, 'SN320', `a head component holds head elements: \`<${c.tagName}>\` cannot be in \`<${name}>\``, 0,
          'head elements are `<title>`, `<meta>`, `<link>`, `<script>`, `<style>`, `<noscript>`, `<base>`, `<template>` and head components; a component for the body is a `<template data-sn-props>` with one root');
        def.bad = true; detach(host); return null;
      }
    }
    const propsText = attr(template, 'data-sn-head')!;
    const props = typeMembers(propsText.trim() === '' ? '{}' : propsText)?.filter((m) => m.slot === undefined) ?? null;
    if (SLOT_TYPE.test(propsText)) this.once(template, 'data-sn-head', 'SN331', `\`<${name}>\` is a head component: its slots pass nothing, so \`Slot<T>\` cannot be in \`data-sn-props\``, propsText.search(SLOT_TYPE), 'a plain `<slot name="…">` takes content with no declaration');
    const emitsText = attr(template, 'data-sn-emits') ?? null;
    const emits = emitsText === null ? [] : typeMembers(emitsText);
    if (emitsText !== null && !emits) this.report(template, 'data-sn-emits', 'SN401', '`data-sn-emits` takes a type literal of the events and their detail types: `{ select: Article; close: null }`', 0);
    // sinter's events are `sn-…` (`sn-navigate`, the guard of every navigation): a component's are named otherwise
    const snEvent = emits?.find((m) => m.name.startsWith('sn-'));
    if (snEvent) this.report(template, 'data-sn-emits', 'SN209', `\`${snEvent.name}\`: names starting with \`sn-\` are sinter's events (\`sn-navigate\`, \`sn-dismiss\`, \`sn-error\`, \`sn-page\`); name the component's event otherwise`, 0);
    const first = fragment.childNodes.find(isElement) ?? template;
    const use: Use = { name, file: def.file, host, root: first, template, props, propsText, emits, emitsText, chain, head: { roots: [], parent: null } };
    for (const a of host.attrs) {
      if (RETIRED[a.name]) this.report(host, a.name, 'SN101', `\`${a.name}\` ${RETIRED[a.name]}`, 0);
      else if (a.name !== 'data-sn-with' && a.name !== 'slot') this.report(host, a.name, 'SN102', `\`${a.name}\` cannot be on the tag of a head component; it takes \`data-sn-with\` and slot content`, 0, 'a head component has no root element for other attributes to land on');
    }
    this.fillSlots(use, fragment);
    // a prop the use gives as a constant decides a `data-sn-if` on it now, before its elements join the head
    this.foldIn(fragment, constantProps(attr(host, 'data-sn-with'), props), use);
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
    const real = (c: P5Node) => isElement(c) || (c.nodeName === '#text' && (c as DefaultTreeAdapterMap['textNode']).value.trim() !== '');
    const realIn = (nodes: P5Node[] | undefined) => !!nodes?.some(real);
    // the tag's content by slot name; the `data-sn-else` template after a `<template slot="…" data-sn-if>` is part of its fill
    const groups = new Map<string, P5Node[]>();
    let ifSlot: string | null = null;
    for (const c of [...host.childNodes]) {
      let slot = isElement(c) ? attr(c, 'slot') : this.forwarded.get(c);
      if (slot === undefined && ifSlot !== null && isElement(c) && c.tagName === 'template' && attr(c, 'data-sn-else') !== undefined) slot = ifSlot;
      if (real(c)) ifSlot = isElement(c) && c.tagName === 'template' && attr(c, 'data-sn-if') !== undefined && attr(c, 'slot') !== undefined ? attr(c, 'slot')! : null;
      const k = slot ?? '';
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k)!.push(c);
    }
    const slots = this.placements(container);
    const data = use.slots ?? new Map<string, Member>();
    const byName = new Map<string, Array<{ el: P5Element; path: string[] }>>();
    const tree: P5Element[] = [];
    // a root's fills for the slots it declares: kept (a copy) for tree placements inside it
    for (const k of data.keys()) {
      const given = groups.get(k);
      if (!realIn(given)) continue;
      const caller = chain.filter((x) => x !== '#').at(-1) ?? '';
      const holder = { nodeName: '#document-fragment', childNodes: [] as P5Node[] } as unknown as P5Parent;
      const kept = given!.map((c) => this.cloneTree(c, holder));
      holder.childNodes = kept as never[];
      for (const c of kept) {
        if (isElement(c)) c.attrs = c.attrs.filter((a) => a.name !== 'slot');
        if (!this.slotOf.has(c)) this.slotOf.set(c, use);
        if (isElement(c)) this.slotEls.push({ el: c, caller, host: name });
      }
      // the components in it expand as the caller's markup (the copy placed at a tree placement is used as is)
      this.expandComponents(holder, chain, false, this.enclosing.get(host) ?? null);
      kept.splice(0, kept.length, ...(holder.childNodes as P5Node[]));
      const id = this.fillDefs.length;
      this.fillDefs.push({ id, use, k, nodes: kept });
      (use.treeFills ??= new Map()).set(k, { nodes: kept, id });
    }
    for (const s of slots) {
      const k = attr(s.el, 'name') ?? '';
      for (const a of s.el.attrs) if (RETIRED[a.name]) this.once(s.el, a.name, 'SN101', `\`${a.name}\` ${RETIRED[a.name]}`, 0);
      // a named slot that passes data and that the component does not declare: a tree placement (section 4)
      if (attr(s.el, 'data-sn-with') !== undefined && k && !data.has(k)) { tree.push(s.el); continue; }
      // a placement that passes data: of a slot declared `Slot<T>`
      if (attr(s.el, 'data-sn-with') !== undefined && !data.has(k)) {
        this.once(s.el, 'data-sn-with', 'SN331', k ? `\`data-sn-with\` on \`<slot name="${k}">\` passes data, and \`<${name}>\` does not declare \`${k}\` as \`Slot<T>\`` : '`data-sn-with` on the default `<slot>`: a slot that passes data is named, and declared `Slot<T>`', 0,
          `declare it in the props type: \`data-sn-props="{ …; ${k || 'cell'}: Slot<{ row: Row }> }"\`${k ? '' : ', and name the slot'}`);
      } else if (data.has(k) && attr(s.el, 'data-sn-with') === undefined) {
        this.once(s.el, null, 'SN331', `\`${k}\` is declared \`Slot<${data.get(k)!.slot}>\`: its placement passes the values with \`data-sn-with\``, 0, `\`<slot name="${k}" data-sn-with="{ … }">\``);
      }
      if (!byName.has(k)) byName.set(k, []);
      byName.get(k)!.push(s);
    }
    const placedNames = new Set<string>();
    for (const [k, list] of byName) {
      // SN312 counts placements that can render together: one in each branch of one if/else chain is allowed, and a slot that passes data may be placed anywhere
      const accepted: Array<{ el: P5Element; path: string[] }> = [];
      for (const s of list) {
        if (!data.has(k) && accepted.some((a) => !exclusive(a.path, s.path))) {
          this.report(s.el, null, 'SN312', `\`<${name}>\` has two ${k ? `slots named \`${k}\`` : 'default slots'} that can render together; slot content is placed once`, 0,
            'one placement per branch of one `data-sn-if`/`data-sn-else` chain is allowed; elsewhere, place it once');
          detach(s.el);
          continue;
        }
        accepted.push(s);
      }
      placedNames.add(k);
      const given = groups.get(k);
      const filled = realIn(given);
      if (filled) {
        const caller = chain.filter((x) => x !== '#').at(-1) ?? '';
        for (const c of given!) {
          if (isElement(c)) c.attrs = c.attrs.filter((a) => a.name !== 'slot');
          // content forwarded from further out stays its first caller's: its scope and its styles
          if (this.slotOf.has(c)) continue;
          if (isElement(c)) this.slotEls.push({ el: c, caller, host: name });
          this.slotOf.set(c, use);
        }
        if (data.has(k)) this.checkFill(given!, k, name);
      }
      const member = data.get(k);
      // the first placement takes the content, every other one a copy (made before any is placed)
      const contents = accepted.map((s, i) => (!filled ? s.el.childNodes : i === 0 ? given! : given!.map((c) => this.cloneTree(c, s.el.parentNode!))));
      accepted.forEach((s, i) => {
        const nodes = contents[i]!;
        if (filled && i > 0) for (const c of nodes) {
          const from = given![nodes.indexOf(c)]!;
          const x = this.slotEls.find((y) => y.el === from);
          if (x && isElement(c)) this.slotEls.push({ ...x, el: c });
        }
        if (filled && member && accepted.length > 1) for (const c of nodes) this.repeatedFills.add(c);
        // a slot that is itself slot content (`<slot name="seo" slot="extra">` in a component's tag): what fills it goes on into that slot
        const onward = attr(s.el, 'slot');
        const into = s.el.parentNode && isElement(s.el.parentNode as P5Node) ? (s.el.parentNode as P5Element).tagName : '';
        const forwards = onward !== undefined && !!this.componentFile(into);
        if (member) this.place({ el: s.el, use, name: k, member }, nodes, filled, forwards && this.dataSlotsOf(into).has(onward!));
        if (forwards) {
          for (const c of nodes) {
            if (isElement(c)) setAttr(c, 'slot', onward!);
            else this.forwarded.set(c, onward!);
          }
        }
        const parent = s.el.parentNode!;
        const at = parent.childNodes.indexOf(s.el as never);
        for (const c of nodes) (c as { parentNode: P5Parent }).parentNode = parent;
        parent.childNodes.splice(at, 1, ...(nodes as never[]));
        mergeText(parent);
      });
    }
    for (const el of tree) this.treePlacement(use, el);
    const slotNames = [...new Set([...placedNames, ...data.keys()])].filter((x) => x);
    for (const [k, nodes] of groups) {
      // a declared slot placed deeper in the tree takes its fill from `treeFills`
      if (placedNames.has(k) || data.has(k) || !realIn(nodes)) continue;
      const el = nodes.find(isElement);
      if (k) this.report(el!, 'slot', 'SN314', `\`<${name}>\` has no slot \`${k}\`.${slotNames.length ? ` Its slots are ${slotNames.map((x) => `\`${x}\``).join(', ')}.` : ''}${didYouMean(k, slotNames)}`, 0);
      else this.report(el ?? host, null, 'SN314', `\`<${name}>\` has no default \`<slot>\`, so this content would be dropped`, 0,
        slotNames.length ? `put it in a named slot: ${slotNames.map((x) => `\`slot="${x}"\``).join(', ')}` : `add a \`<slot></slot>\` to \`<${name}>\` where the content goes`);
    }
  }

  /**
   * A tree placement (section 4, rule 1): a `<slot>` that passes data and whose name its component `x`
   * does not declare. It is filled by the nearest enclosing root that declares the name (rule 2):
   * here, at build time, when that root's markup expands it; in a shared definition, which is compiled
   * once for every root, at run time (`runtimePlacement`). A root in caller markup starts a new contract
   * (rule 3): `enclosing` skips from slot content and fills to the caller's side. With no root at all,
   * it is an error at the outermost use.
   */
  treePlacement(x: Use, el: P5Element) {
    const k = attr(el, 'name')!;
    const near = didYouMean(k, [...(x.slots?.keys() ?? [])]);
    if (near) this.once(el, 'name', 'SN535', `\`<slot name="${k}">\` in \`<${x.name}>\` is a tree placement, filled by the nearest root that declares \`${k}\`; \`<${x.name}>\` declares a slot of a close name.${near}`, 0);
    // within the placement's package (rule 2): a use written in another package's markup is where its package's roots end
    const pkg = this.packageOf(x);
    const up1 = (c: Use) => (this.crossesPackage(c) ? null : this.enclosing.get(c.host) ?? null);
    let u = up1(x), last: Use = x;
    while (u && !(u.slots?.has(k) && this.packageOf(u) === pkg)) { last = u; u = up1(u); }
    // the fill: the declaring root's own, or (rule 4) an outer root's, while the roots are in their package's markup
    let from: Use | null = u;
    while (from && !from.treeFills?.has(k) && !this.slotOf.has(from.host) && !this.crossesPackage(from)) {
      let up = this.enclosing.get(from.host) ?? null;
      while (up && !(up.slots?.has(k) && this.packageOf(up) === pkg)) up = up1(up);
      if (!up) break;
      from = up;
    }
    const parent = el.parentNode!;
    const put = (nodes: P5Node[]) => {
      const at = parent.childNodes.indexOf(el as never);
      for (const c of nodes) (c as { parentNode: P5Parent }).parentNode = parent;
      parent.childNodes.splice(at, 1, ...(nodes as never[]));
      mergeText(parent);
    };
    if (!u) {
      // in a shared definition: the root that uses it passes its fill at run time
      if (this.inDef > 0) { this.runtimeSlots.add(el); return; }
      this.report(last.host, null, 'SN331', `\`<${x.name}>\` places the slot \`${k}\` (\`<slot name="${k}" data-sn-with>\`), and no component around it declares \`${k}\`: nothing can fill it here`, 0,
        `use it inside a component that declares \`${k}: Slot<…>\`, or declare it in \`<${x.name}>\` to fill it from its tag`);
      put([...el.childNodes]);
      return;
    }
    const member = u.slots!.get(k)!;
    const fill = from?.treeFills?.get(k);
    const p: Placement = { el, use: fill ? from! : u, name: k, member: fill ? from!.slots!.get(k)! : member };
    const nodes = fill ? fill.nodes.map((c) => this.cloneTree(c, parent)) : [...el.childNodes];
    if (fill) for (const c of nodes) {
      const x0 = this.slotEls.find((y) => y.el === fill.nodes[nodes.indexOf(c)]);
      if (x0 && isElement(c)) this.slotEls.push({ ...x0, el: c });
    }
    this.place(p, nodes, !!fill, false);
    put(nodes);
  }

  /**
   * The `<slot>`s a component's markup places, each with the if/else branches it is in (`chain:branch`,
   * outer first), a slot inside another slot's default before it. An unnamed `<slot>` inside a fill of a
   * slot that passes data (content of an inner component's tag) is not the component's: it places the
   * children its placement gives the fill.
   */
  placements(container: P5Parent): Array<{ el: P5Element; path: string[] }> {
    const out: Array<{ el: P5Element; path: string[] }> = [];
    let chains = 0;
    const walk = (n: P5Parent, path: string[], inFill: boolean, data: Set<string> | null) => {
      let ifSlot: string | null = null, prevIf: string | null = null;
      for (const c of n.childNodes) {
        if (!isElement(c)) { if (real(c)) prevIf = null; continue; }
        let here = path;
        // the branches of a chain: an if template and the else template right after it
        if (c.tagName === 'template' && attr(c, 'data-sn-if') !== undefined) { prevIf = `${chains++}`; here = [...path, `${prevIf}:0`]; }
        else if (c.tagName === 'template' && attr(c, 'data-sn-else') !== undefined && prevIf !== null) { here = [...path, `${prevIf}:1`]; prevIf = null; }
        else prevIf = null;
        let fill = inFill;
        if (data) {
          let k = attr(c, 'slot');
          if (k === undefined && ifSlot !== null && c.tagName === 'template' && attr(c, 'data-sn-else') !== undefined) k = ifSlot;
          ifSlot = c.tagName === 'template' && attr(c, 'data-sn-if') !== undefined && attr(c, 'slot') !== undefined ? attr(c, 'slot')! : null;
          if (k !== undefined && data.has(k)) fill = true;
        }
        const inner = this.componentFile(c.tagName) ? this.dataSlotsOf(c.tagName) : null;
        const kids = inner?.size ? inner : null;
        if (c.tagName === 'slot') {
          walk(c, here, fill, null);
          if (!fill || attr(c, 'name')) out.push({ el: c, path: here });
          continue;
        }
        walk(c, here, fill, kids);
        if (c.tagName === 'template') walk((c as P5Template).content, here, fill, null);
      }
    };
    const real = (c: P5Node) => c.nodeName === '#text' && (c as DefaultTreeAdapterMap['textNode']).value.trim() !== '';
    walk(container, [], false, null);
    return out;
  }

  /** A fill of a slot that passes data: elements with `slot="…"`, a `<template slot>` only for an if/else chain or a text. */
  checkFill(nodes: P5Node[], k: string, _name: string) {
    for (const c of nodes) {
      if (!isElement(c) || c.tagName !== 'template' || ['data-sn-else', 'data-sn-if', 'data-sn-text'].some((a) => attr(c, a) !== undefined)) continue;
      this.report(c, null, 'SN331', `a fill of \`${k}\` is elements with \`slot="${k}"\`; a \`<template slot>\` is for an if/else chain (\`<template slot="${k}" data-sn-if="…">\`) or a text (\`<template slot="${k}" data-sn-text="…">\`)`, 0,
        `put the content in an element: \`<div slot="${k}">…</div>\``);
    }
  }

  /**
   * One placement of a slot that passes data, with what renders there: a fill (`filled`), or its
   * default. A fill's top-level nodes get the placement, so the walk compiles its `data-sn-with` and
   * gives the fill `$slot`; an unnamed `<slot>` in the fill places the children of the element the
   * default renders. A forwarding placement (`forwards`: itself a fill of an inner component's slot
   * that passes data) leaves those for the inner placement, which gives the children.
   */
  place(p: Placement, nodes: P5Node[], filled: boolean, forwards: boolean) {
    const def = this.defaultShape(p);
    if (!filled) {
      if (forwards) return;
      const chain: FillChain = [p];
      const els = nodes.filter(isElement);
      for (const c of els) this.defaultOf.set(c, chain);
      // nothing to hang it on: the node the placement is in, whose children the walk sees in the placement's scope
      if (!els.length && p.el.parentNode) {
        const list = this.emptyDefaults.get(p.el.parentNode) ?? [];
        list.push(chain);
        this.emptyDefaults.set(p.el.parentNode, list);
      }
      return;
    }
    // one chain per prior chain: the content of one forwarding fill shares it
    const next = new Map<FillChain | undefined, FillChain>();
    for (const c of nodes) {
      if (!isElement(c)) continue;
      const prior = this.fillOf.get(c);
      if (!next.has(prior)) next.set(prior, [...(prior ?? []), p]);
      this.fillOf.set(c, next.get(prior)!);
    }
    if (forwards) return;
    // the fill's own `<slot>`s: the children
    const chain = next.values().next().value ?? [p];
    const found = this.placements({ childNodes: nodes } as unknown as P5Parent).filter((x) => attr(x.el, 'name') === undefined);
    const accepted: typeof found = [];
    for (const s of found) {
      if (accepted.some((a) => !exclusive(a.path, s.path))) {
        this.report(s.el, null, 'SN312', `this fill of \`${p.name}\` places the children twice: two \`<slot>\`s in it can render together`, 0, 'one `<slot>` per branch of one `data-sn-if`/`data-sn-else` chain');
        detach(s.el);
        continue;
      }
      accepted.push(s);
    }
    accepted.forEach((s, i) => {
      if (!def) {
        this.report(s.el, null, 'SN331', `the placement of \`${p.name}\` in \`<${p.use.name}>\` renders no element, so it gives its fill no children for this \`<slot>\``, 0,
          'leave the `<slot>` out of the fill, or give the placement a default element whose children it places');
        detach(s.el);
        return;
      }
      const kids = this.shapeChildren(def, i > 0);
      if (!kids) {
        this.report(s.el, null, 'SN331', `the default of \`${p.name}\` in \`<${p.use.name}>\` renders a component (\`<${def.what}>\`), whose children are that component's markup: this \`<slot>\` has none to place`, 0,
          'leave the `<slot>` out of the fill, or give the placement a default element of its own');
        detach(s.el);
        return;
      }
      for (const k of kids) if (isElement(k)) this.childrenOf.set(k, chain);
      // the component's markup inside the caller's fill: a scope root of the component's own styles
      const styled = (k: P5Node): P5Node[] => (isElement(k) && k.tagName === 'template' ? (k as P5Template).content.childNodes : [k]);
      for (const k of kids.flatMap(styled)) if (isElement(k) && !this.slotOf.has(k)) this.slotEls.push({ el: k, caller: p.use.name, host: p.use.name });
      // the `<slot>` is a top-level node of the fill itself: the children take its place in the fill
      const j = nodes.indexOf(s.el);
      if (j >= 0) { nodes.splice(j, 1, ...kids); return; }
      const parent = s.el.parentNode!;
      const at = parent.childNodes.indexOf(s.el as never);
      for (const k of kids) (k as { parentNode: P5Parent }).parentNode = parent;
      parent.childNodes.splice(at, 1, ...(kids as never[]));
      mergeText(parent);
    });
  }

  /**
   * What a placement's default renders, for the `<slot>`s of its fills: one plain element, whose
   * children they place, or an if/else chain of plain elements (the children per branch, as a chain);
   * null when it renders no element (text, nothing). Anything broader follows the component root's
   * rules (rootShape).
   */
  defaultShape(p: Placement): DefaultShape | null {
    const top = p.el.childNodes.filter(realNode);
    // text or nothing: no element
    if (!top.some(isElement)) return null;
    const shape = this.rootShape(p.el.childNodes, p.use.name);
    if (typeof shape === 'string') {
      this.once(p.el, null, 'SN331', `the default of \`<slot name="${p.name}">\` is a root: it renders at most one element (one element, a \`data-sn-if\`/\`data-sn-else\` chain of them, a component or \`<sn-component use>\`), or text`, 0,
        `wrap the default in one element: \`<slot name="${p.name}" data-sn-with="…"><span>…</span></slot>\``);
      return null;
    }
    // the children move into the fill: names an element declares would be lost to them
    const leaves = landingOf(shape);
    for (const e of leaves) {
      const names = [...stateKeys(attr(e, 'data-sn-state')), ...stateKeys(attr(e, 'data-sn-let'))];
      const read = names.find((n) => reads(e.childNodes, n));
      if (read) this.once(e, attr(e, 'data-sn-state') !== undefined ? 'data-sn-state' : 'data-sn-let', 'SN331', `the default of \`<slot name="${p.name}">\` declares \`${read}\` on its element, and its children read it: a fill's \`<slot>\` takes the children without that element`, 0,
        `pass it with \`data-sn-with\` on the \`<slot>\`, or declare it inside the element`);
    }
    // a component (or a choice) somewhere in the default: its element's children are that component's markup, not given to a fill
    const opaque = (sh: RootShape): string | null => sh.kind === 'tag' || sh.kind === 'choice' ? sh.el.tagName : sh.kind === 'chain' ? sh.branches.map(opaque).find((x) => x) ?? null : null;
    const what = opaque(shape) ?? undefined;
    return { shape, el: p.el, ...(what ? { what } : {}) };
  }

  /** A placement's default's children, for a fill's `<slot>` (copies, with `copy`); null when the default is a component. */
  shapeChildren(d: DefaultShape, copy: boolean): P5Node[] | null {
    const kids = (sh: RootShape, copy: boolean): P5Node[] => {
      if (sh.kind === 'el') return copy ? sh.el.childNodes.map((c) => this.cloneTree(c, sh.el)) : [...sh.el.childNodes];
      if (sh.kind !== 'chain') return [];
      // a chain: the same conditions, each branch its root's children
      return sh.templates.map((t, i) => {
        const x = this.cloneTree(t, t.parentNode ?? d.el) as P5Template;
        const inner = kids(sh.branches[i]!, copy);
        for (const k of inner) (k as { parentNode: P5Parent }).parentNode = x.content;
        x.content.childNodes = inner as never[];
        return x;
      });
    };
    return d.what ? null : kids(d.shape, copy);
  }


  /** A library error: reported at the first use of a component only, not once per use. */
  once(el: P5Element, a: string | null, code: Code, message: string, offset: number, hint?: string) {
    const key = `${this.siteKey(el) ?? ''}#${code}#${message}`;
    if (this.reportedOnce.has(key)) return;
    this.reportedOnce.add(key);
    this.report(el, a, code, message, offset, hint);
  }

  /**
   * The slots a component's props type declares with `Slot<T>`, by name. Such a member is written in a
   * type literal, without `?` (every slot may be left unfilled); in a type the compiler cannot list, it
   * is an error.
   */
  declaredSlots(template: P5Element, members: Member[] | null, text: string): Map<string, Member> {
    const out = new Map<string, Member>();
    if (!members) {
      if (SLOT_TYPE.test(text)) this.once(template, 'data-sn-component', 'SN331', '`Slot<T>` is written in the props type literal, where the compiler sees the slot; here the props are a type it cannot list', text.search(SLOT_TYPE),
        'write the props as a type literal: `data-sn-props="{ rows: Row[]; cell: Slot<{ row: Row }> }"`');
      return out;
    }
    for (const m of members) {
      if (m.slot === undefined) {
        if (m.type && SLOT_TYPE.test(m.type)) this.once(template, 'data-sn-component', 'SN331', `\`${m.name}\`: a slot is a member of type \`Slot<T>\` itself, not a type that contains one`, m.offset);
        continue;
      }
      if (m.optional) this.once(template, 'data-sn-component', 'SN331', `the slot \`${m.name}\` is written with \`?\`; every slot may be left unfilled, and its placement shows its default`, m.offset, `\`${m.name}: Slot<…>\``);
      out.set(m.name, m);
    }
    return out;
  }

  /** The slots that pass data of the component a tag names (`Slot<T>` members), read from its file once; empty for anything else. */
  /**
   * Why a fill of a tree placement is not expanded at build time with a constant tree around it, or null: it
   * forwards to a slot of an inner component (`<slot name="…" slot="…">`), or holds a component that declares
   * slots of its own (a new tree root in the fill). Those render in the browser.
   */
  fillStays(F: { nodes: P5Node[]; use: Use; k: string }): string | null {
    // given to a component that passed it on to this root (a wrapper's `<slot name="k" slot="k">`): it was written
    // further out than the root's tag, and keeps its first caller's file
    const at = this.origins.get(F.use.host)?.file;
    const from = F.nodes.find(isElement);
    // (a component's root, as the fill: where its tag was written)
    const written = from && (this.useOf.get(from)?.host ?? from);
    if (at && written && this.origins.get(written)?.file !== at) return `it is passed on to \`<${F.use.name}>\` by a component's \`<slot name="${F.k}" slot="${F.k}">\``;
    const walk = (ns: readonly P5Node[]): string | null => {
      for (const n of ns) {
        if (!isElement(n)) continue;
        if (n.tagName === 'slot' && attr(n, 'name') !== undefined) return `it passes the slot \`${attr(n, 'name')}\` on to an inner component`;
        const u = this.useOf.get(n) ?? this.hostUse.get(n);
        if (u && this.dataSlotsOf(u.name).size) return `it holds \`<${u.name}>\`, a component with slots of its own`;
        const w = walk(n.childNodes) ?? (n.tagName === 'template' ? walk((n as P5Template).content.childNodes) : null);
        if (w) return w;
      }
      return null;
    };
    return walk(F.nodes);
  }

  dataSlotsOf(tag: string): Set<string> {
    const def = this.componentFile(tag);
    if (!def || def.head) return new Set();
    if (!def.dataSlots) {
      def.dataSlots = new Set();
      try {
        const frag = parsedText(def.text);
        const t = frag.childNodes.find((c): c is P5Element => isElement(c) && c.tagName === 'template' && propsDecl(c) !== undefined);
        const text = t ? propsDecl(t)! : '';
        for (const m of typeMembers(text.trim() === '' ? '{}' : text) ?? []) if (m.slot !== undefined) def.dataSlots.add(m.name);
      } catch { /* reported where the component is expanded */ }
    }
    return def.dataSlots;
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

  /**
   * After expansion: a `<slot>` left in the page is one that no component or fill encloses (SN331), and a
   * literal `id` in markup that renders more than once (a `data-sn-for` row, a fill of a slot placed more
   * than once) would be on the page more than once (SN532). A `<template>` that is not sinter's
   * (declarative shadow DOM, an island's own) is the browser's, and not looked into.
   */
  strayAndRepeated(doc: P5Parent) {
    const walk = (n: P5Parent, repeated: string | null) => {
      for (const c of [...n.childNodes]) {
        if (!isElement(c)) continue;
        const rep = repeated ?? (this.repeatedFills.has(c) ? 'a fill of a slot placed more than once' : null);
        if (c.tagName === 'slot') {
          this.report(c, null, 'SN331', `this \`<slot>\` is not in a component or a fill, so nothing fills it`, 0,
            'a `<slot>` belongs in a component (`src/components/<name>.html`), or in a fill of a slot that passes data, where it places the children; remove it from the page');
          continue;
        }
        if (rep && attr(c, 'id') !== undefined) this.repeatedIds.push({ el: c, why: rep });
        walk(c, rep);
        if (c.tagName === 'template') {
          if (!c.attrs.some((a) => a.name.startsWith('data-sn-'))) continue;
          walk((c as P5Template).content, rep ?? (attr(c, 'data-sn-for') !== undefined ? 'a `data-sn-for` row' : null));
        }
      }
    };
    walk(doc, null);
  }

  /** components whose root rules are needed outside their scope (`data-sn-r`) */
  private readonly rootStyled = new Set<string>();

  /** The elements of a use's own markup that render as its root: the root, each branch's element; not a fill. */
  rootMarked(u: Use): P5Element[] {
    if (u.head) return [];
    return (u.shape ? landingOf(u.shape) : [u.root]).filter((e) => !this.slotOf.has(e) || this.useOf.get(e) === u);
  }

  /** elements whose `id` a component's tag gave them (its use's own) */
  private readonly tagIds = new WeakSet<P5Element>();

  /** literal ids in repeated markup, reported after `componentIds` (which may report the same element as SN209) */
  private readonly repeatedIds: Array<{ el: P5Element; why: string }> = [];

  /** A literal `id` in the markup of a component used more than once would be on the page more than once. */
  componentIds(): Set<string> {
    const out = new Set<string>();
    for (const [name, list] of this.uses) {
      if (list.length < 2 || list[0]!.head) continue;
      const u = list[0]!;
      const find = (n: P5Parent): P5Element | null => {
        for (const c of n.childNodes) {
          if (!isElement(c) || this.slotOf.get(c)) continue;
          if (attr(c, 'id') !== undefined && this.origins.get(c)?.file === u.file && !this.tagIds.has(c)) return c;
          const x = find(c) ?? (c.tagName === 'template' ? find((c as P5Template).content) : null);
          if (x) return x;
        }
        return null;
      };
      const el = attr(u.root, 'id') !== undefined && this.origins.get(u.root)?.file === u.file && !this.tagIds.has(u.root) ? u.root : find(u.root);
      if (el) this.report(el, 'id', 'SN209', `\`<${name}>\` is used ${list.length} times on this page, and its markup has \`id="${attr(el, 'id')}"\`: the page would have that id ${list.length} times`, 0,
        'compute the id from a prop: `data-sn-attr="{ id: \'edit-\' + item.id }"`, or use the component once');
      if (el && this.siteKey(el)) out.add(this.siteKey(el)!);
    }
    return out;
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
    if (!def && !use.head && !use.shape) this.foldConstants(use, lets);
    const outer = new Set<string>([...(caller.lets ?? []).map((l) => l.name), ...caller.loops.map((l) => l.name), ...caller.states.flatMap((x) => [...x.names])]);
    // no `data-sn-emits`: no events; one the compiler cannot list (an alias): not checked here
    const around = caller.component?.runtime;
    const runtime: Set<string> | 'all' = def || around === 'all' ? 'all' : new Set([...(around ?? []), ...caller.loops.map((l) => l.rt ?? l.name)]);
    // tree slots: the fills its markup's tree placements take, nearer roots over outer ones (rule 4); a shared
    // definition takes them from its row's item, at run time
    // a root in caller markup (slot content, a fill, a page) starts a new contract (rule 3); in its own package's
    // markup, the fills of slots it also declares pass into it, and one written on its tag wins (rule 4)
    const inherit = def ? { expr: `$.${def.rt}.$f`, own: new Map<string, number | null>() } : this.slotOf.has(use.host) || this.crossesPackage(use) ? undefined : caller.component?.fills;
    let fills = inherit;
    if (use.slots?.size) {
      const own = new Map(inherit?.own ?? []);
      for (const k of use.slots.keys()) {
        const id = use.treeFills?.get(k)?.id;
        if (id !== undefined) own.set(k, id);
        else if (!inherit || (!own.has(k) && !inherit.expr)) own.set(k, null);
      }
      fills = { expr: inherit?.expr ?? null, own };
    }
    const cs: ComponentScope = { name, outer, runtime, id: this.useIds, ...(fills ? { fills } : {}), ...(use.late || caller.component?.late ? { late: true } : {}), ...(use.emitsText === null ? { emits: null } : use.emits ? { emits: use.emits.map((m) => m.name) } : {}) };
    use.scope = cs;
    this.useById.set(this.useIds++, use);
    if (this.check) {
      this.frameOf.set(cs, this.check.frames.length);
      this.check.frames.push({ kind: 'props', component: name, type: { kind: 'ts', text: use.propsText.trim() || '{}', loc: this.locOf(use.template, use.layout ? 'data-sn-layout' : use.head ? 'data-sn-head' : 'data-sn-component') }, names: declared ?? [...passed], ...(!use.props && !use.layout ? { alias: true } : {}) });
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

  /**
   * What a fill sees: the scope of the markup that wrote it, and `$slot`. `at`: the component's scope at
   * the placement, where its `data-sn-with` is compiled; through forwarding slots, each outer
   * placement's `data-sn-with` is compiled with the inner one's `$slot`. Computed once per fill.
   */
  /** The scope a fill was compiled in, for the children its `<slot>` places: at the fill's instance, which is the longest one recorded that `inst` (theirs, in a row deeper down) starts with. */
  fillAt(chain: FillChain, inst: string): { at: Scope; fill: Scope } | undefined {
    // (rows copied inside the children, whose fill was not copied: the chain they were copied from)
    let c: FillChain | undefined = chain;
    while (c && !this.fillScopes.has(c)) c = this.chainCopyOf.get(c);
    const byInst = c && this.fillScopes.get(c);
    if (!byInst) return undefined;
    let best: string | null = null;
    for (const k of byInst.keys()) if (inst.startsWith(k) && (best === null || k.length > best.length)) best = k;
    return best === null ? undefined : byInst.get(best);
  }

  fillScope(chain: FillChain, at: Scope, writer: Use | null, inst = ''): Scope {
    let byInst = this.fillScopes.get(chain);
    if (!byInst) this.fillScopes.set(chain, byInst = new Map());
    let rec = byInst.get(inst);
    if (!rec) {
      let scope = at;
      for (let i = chain.length - 1; i >= 0; i--) {
        const p = chain[i]!;
        scope = { ...(p.use.caller ?? scope), slot: this.placementData(p, scope) };
      }
      rec = { at, fill: scope };
      byInst.set(inst, rec);
    }
    return writer?.caller ? { ...writer.caller, slot: rec.fill.slot! } : rec.fill;
  }

  /** A placement's `data-sn-with`, in the component's scope at the placement: `$slot`, checked against the slot's `T`. */
  placementData(p: Placement, scope: Scope): SlotScope {
    const el = p.el, T = p.member.slot!;
    const members = new Map<string, LetEntry>();
    const src = attr(el, 'data-sn-with');
    const known = typeMembers(T);
    if (src !== undefined) {
      const r = this.expr(el, 'data-sn-with', scope, { mode: 'value', object: 'literal-keys' });
      if (this.check) this.typeLast({ returns: { kind: 'ts', text: T, loc: this.locOf(p.use.template, 'data-sn-component', p.member.offset) } });
      for (const e of r.entries ?? []) {
        if (known && !known.some((m) => m.name === e.key)) {
          const names = known.map((m) => m.name);
          this.report(el, 'data-sn-with', 'SN313', `\`${e.key}\` is not in \`Slot<${T}>\` of \`${p.name}\`; ${names.length ? `it passes ${names.map((x) => `\`${x}\``).join(', ')}` : 'it passes nothing'}.${didYouMean(e.key, names)}`, e.offset);
          continue;
        }
        if (members.has(e.key)) continue;
        const v = entryValue(r, e);
        const q = v ? analyze(src.slice(v.start, v.end), scope, this.page, { mode: 'value', report: () => {} }) : null;
        members.set(e.key, { name: `$slot.${e.key}`, code: q?.ok ? q.inner : 'undefined', deps: q?.deps ?? [], usesEl: q?.usesEl ?? false, usesIndex: q?.usesIndex ?? false, resource: q?.resource ?? null, src: q?.itemOf ?? null, list: q?.listOf ?? null });
      }
      for (const m of known ?? []) if (!m.optional && !members.has(m.name)) this.report(el, 'data-sn-with', 'SN313', `the placement of \`${p.name}\` passes no \`${m.name}\`, which \`Slot<${T}>\` needs`, 0);
    }
    const all = [...members.values()];
    const whole: LetEntry = {
      name: '$slot', code: `{ ${[...members].map(([k, l]) => `${JSON.stringify(k)}: (${l.code})`).join(', ')} }`,
      deps: [...new Set(all.flatMap((l) => l.deps))], usesEl: all.some((l) => l.usesEl), usesIndex: all.some((l) => l.usesIndex), resource: null,
    };
    const out: SlotScope = { name: p.name, component: p.use.name, whole, members };
    if (this.check) {
      this.frameOf.set(out, this.check.frames.length);
      this.check.frames.push({ kind: 'slot', type: { kind: 'ts', text: T, loc: this.locOf(p.use.template, 'data-sn-component', p.member.offset) }, name: p.name, component: p.use.name });
    }
    return out;
  }

  /** What a component's markup sees when its root is not one plain element: computed once, at the first of its top nodes. */
  /** The instance path `el` is in: its own, or that of the nearest row of an unrolled loop or instance expanded at build time around it. */
  instOf(el: P5Node): string {
    for (let x: P5Node | null = el; x; x = (x as { parentNode: P5Node | null }).parentNode) {
      const at = isElement(x) ? this.instAt.get(x) ?? this.rowOf.get(x)?.inst ?? this.caseInst.get(x) : undefined;
      if (at !== undefined) return at;
    }
    return '';
  }

  markupOf(u: Use, at: Scope, inst = '', here = false): Scope {
    // (per instance: the copies of an unrolled row, or of an expanded instance, share the use)
    // the caller's scope: the slot content's writer's, with `$slot` when the tag is a fill (`at`: where it is placed)
    const caller = () => (this.fillOf.has(u.host) ? this.tagFill(u, at, inst) : (here ? undefined : u.hostSlot?.caller) ?? at);
    if (!inst) return u.markup ??= this.componentScope(u, caller());
    let byInst = this.markups.get(u);
    if (!byInst) this.markups.set(u, byInst = new Map());
    let s = byInst.get(inst);
    if (!s) byInst.set(inst, s = this.componentScope(u, caller()));
    return s;
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
    const src = attr(host, 'data-sn-with');
    if (src !== undefined) {
      const r = this.expr(host, 'data-sn-with', caller, { mode: 'value', object: 'literal-keys', waits: true });
      // a missing prop the compiler reports itself; TypeScript checks the types of those given
      if (this.check) this.typeLast({ returns: { kind: 'ts', text: use.props ? `Partial<${use.propsText.trim() || '{}'}>` : use.propsText, loc: this.locOf(use.template, use.layout ? 'data-sn-layout' : use.head ? 'data-sn-head' : 'data-sn-component') } });
      for (const e of r.entries ?? []) {
        const slot = use.slots?.get(e.key);
        if (slot) {
          this.report(host, 'data-sn-with', 'SN313', `\`${e.key}\` is a slot of \`<${name}>\` (\`Slot<${slot.slot}>\`), not a prop: it is filled with markup`, e.offset,
            `put the content in the tag: \`<${name}><span slot="${e.key}" data-sn-text="$slot…"></span></${name}>\``);
          continue;
        }
        if (declared && !declared.includes(e.key)) {
          this.report(host, 'data-sn-with', 'SN313', `\`${e.key}\` is not a prop of \`<${name}>\`; ${declared.length ? `its props are ${declared.map((x) => `\`${x}\``).join(', ')}` : 'it declares none'}.${didYouMean(e.key, declared)}`, e.offset);
          continue;
        }
        if (passed.has(e.key)) continue;
        passed.add(e.key);
        const v = entryValue(r, e);
        const q = v ? analyze(src.slice(v.start, v.end), caller, this.page, { mode: 'value', waits: true, report: () => {} }) : null;
        // a prop is a let: inlined, or waiting for a lazy helper module
        const waiting = q?.ok ? this.lazyLet(q.inner, q.deps) : null;
        lets.push({ name: e.key, code: waiting?.code ?? (q?.ok ? q.inner : 'undefined'), deps: waiting?.deps ?? q?.deps ?? [], usesEl: q?.usesEl ?? false, usesIndex: q?.usesIndex ?? false, resource: q?.resource ?? null, prop: true, src: q?.itemOf ?? null, list: q?.listOf ?? null });
      }
    }
    // `data-sn-model`: the `value` prop (and the `change` handler, with the other bindings)
    if (attr(host, 'data-sn-model') !== undefined) {
      const ok = (!declared || declared.includes('value')) && (!use.emits || use.emits.some((m) => m.name === 'change'));
      if (!ok) {
        this.report(host, 'data-sn-model', 'SN313', `\`data-sn-model\` binds a component through its \`value\` prop and \`change\` event; \`<${name}>\` declares ${declared?.includes('value') ? 'no `change` event' : 'no `value` prop'}`, 0,
          `declare both: \`data-sn-props="{ value: … }" data-sn-emits="{ change: … }"\`, and \`emit('change', v)\` when the value changes`);
      } else if (passed.has('value')) {
        this.report(host, 'data-sn-model', 'SN209', '`data-sn-model` passes the `value` prop; `data-sn-with` cannot pass it too', 0);
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
      if (!m.optional) this.report(host, null, 'SN313', `\`<${name}>\` needs the prop \`${m.name}\``, 0, `pass it with \`data-sn-with="{ ${m.name}: … }"\``);
      if (!defaults.has(m.name)) lets.push({ name: m.name, code: 'undefined', deps: [], usesEl: false, usesIndex: false, resource: null, prop: true });
    }
    return { lets, passed };
  }

  /**
   * A component used inside itself (through a `data-sn-for` or `data-sn-if` template): one shared
   * definition, a `<template>` in the head, compiled once as a row template whose item is the props.
   * Each use is a list anchor over `[props]` (two comments in the page) whose row is that definition;
   * the runtime and the early script render it from the head, so a tree renders at any depth.
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
      // a map in the markup: TypeScript types its values as strings, so the key is what must fit (its keys); the values are checked above.
      // With a `data-sn-else` after it, any other key renders the else: the key is checked, of any value
      if (choice.first && this.check && choice.keys) {
        if (this.lastExpr !== null) this.check.exprs.pop();
        const src = attr(host, 'use')!;
        this.expr(host, 'use', ctx.scope, { mode: 'value' }, choice.keySrc!, src.lastIndexOf(choice.keySrc!));
        if (!choice.hasElse) this.typeLast({ returns: { kind: 'ts', text: choice.keys.map((k) => JSON.stringify(k)).join(' | ') || 'never', loc: this.locOf(host, 'use') } });
      } else if (choice.first && this.check) this.typeLast({ returns: { kind: 'ts', text: [...new Set([...(choice.pool ?? this.opts.componentNames ?? []), ...choice.names])].sort().map((n) => JSON.stringify(n)).join(' | ') || 'never', loc: this.locOf(host, 'use') } });
    }
    const { lets } = this.propLets(use, ctx.scope);
    // each candidate's props, checked with the data narrowed to its value (convention, map; a helper hides the link)
    if (choice?.key != null && this.check && this.lastExpr !== null && attr(host, 'data-sn-with') !== undefined) {
      const e = this.check.exprs[this.lastExpr]!;
      // (in parentheses when there are several keys: the guard is joined with others)
      e.guard = choice.also?.length ? `(${[choice.key, ...choice.also].map((k) => `(${choice.keySrc}) === ${JSON.stringify(k)}`).join(' || ')})` : `(${choice.keySrc}) === ${JSON.stringify(choice.key)}`;
      e.guardAt = { name: choice.name, key: choice.key, loc: this.locOf(host, 'use', choice.keyAt ?? 0) };
    }
    for (const l of lets) if (l.src?.length) this.addSources(`@def:${name}:${l.name}`, l.src);
    const tagAttrs = this.pointAttrs(host, ctx, `$p${def.tid}`);
    // tree slots: the fills chosen here travel down the definition in its item
    const fills = this.reachesTree(name) ? this.fillsCode(ctx.scope) : null;
    const props = `[{ ${[...lets.map((l) => `${JSON.stringify(l.name)}: (${l.code})`), ...(tagAttrs ? [`"$a": ${tagAttrs.code}`] : []), ...(fills ? [`"$f": ${fills}`] : [])].join(', ')} }]`;
    // dev builds: a value outside the candidates, with no `data-sn-else` to show, is reported (once per value and place)
    const warn = pick && choice!.first && !choice!.hasElse && this.opts.dev
      ? `if (!${JSON.stringify(choice!.names)}.includes(v) && !(($.$f.$snw ??= new Set()).has(${JSON.stringify(this.position(host))} + v))) { $.$f.$snw.add(${JSON.stringify(this.position(host))} + v); console.warn(${JSON.stringify(`sinter: <sn-component use> at ${this.position(host)} is `)} + JSON.stringify(v) + ${JSON.stringify(`, not one of its components (${choice!.names.join(', ')}): nothing is rendered. Add the component, or a <template data-sn-else> after the element`)}); } `
      : '';
    const deps = [...new Set([...lets.flatMap((l) => l.deps), ...(pick?.deps ?? []), ...(tagAttrs?.deps ?? [])])].sort();
    if (choice) {
      if (choice.first && pick?.usesEl) this.report(host, 'use', 'SN213', '`$el` in `use`: a component chosen by data is marked by comments in the page, so there is no element to read', 0, 'choose with the data alone');
      // one choice anchor for the whole `<sn-component use>`: each candidate adds its case; the first makes the node
      const g = choice.group;
      g.cases.push({ name: choice.name, tid: def.tid, props: props.slice(1, -1), deps });
      // (removed after the walk: detaching it now would make the walk skip the node after it)
      if (g.node) { this.remove.push(host); return null; }
      g.pick = pick!.ok ? pick!.inner : 'undefined';
      g.warn = warn;
      g.site = { el: host, attr: 'data-sn-with', shift: 0 };
      this.choiceGroups.push(g);
    }
    const code = `($) => ${props}`;
    const node: NodeDef = { tag: 'template', p: ctx.stateIdx, b: [choice
      ? this.binding({ k: 'ch', d: deps, c: [] })
      : this.binding({ k: 'for', f: this.fn(code, { el: host, attr: 'data-sn-with', shift: 0 }), d: deps, x: def.tid })] };
    if (choice) choice.group.node = node;
    // for the first pass's decisions: which case the choice renders, from `use` alone (a recursion point: no `pick`)
    this.pointOf.set(node, { el: host, group: choice?.group ?? null, top: ctx.tid < 0, pick: choice && pick?.ok ? { code: `($) => (${pick.inner})`, deps: pick.deps } : null });
    if (ctx.scope.component?.late || this.lateTag(host)) this.lateNodes.add(node);
    // the tag becomes an empty template in place, which `anchors()` turns into the anchor's comments:
    // the anchor instantiates the definition's head template
    const t = host as unknown as P5Template;
    host.tagName = host.nodeName = 'template';
    host.attrs = [];
    t.content = parse5.defaultTreeAdapter.createDocumentFragment();
    host.childNodes = [];
    this.anchorEls.set(node, host);
    if (ctx.tid < 0) {
      node.id = this.nextId++;
      setAttr(host, 'data-sn', String(node.id));
    } else node.path = [...ctx.path, index];
    if (this.opts.dev) (node as NodeDef & { src?: string }).src = this.position(host);
    ctx.list.push(node);
    return null;
  }

  /**
   * `<template data-sn-text>`: a text node, with no element of its own. It always occupies one node, a
   * `Text` or an empty comment while its value is empty, so the paths of its siblings do not move. A
   * write finds it from the node before it: outside rows, the start of an anchor pair around it
   * (`<!--sn 7--><!----><!--/sn-->`, a root node by id); in a row, the element right before it, or an
   * empty comment the compiler puts there, so a row never starts with a text node. A literal folds into
   * the HTML as text.
   */
  textNode(el: P5Element, ctx: Ctx, index: number): null {
    const parent = el.parentNode!;
    const ad = parse5.defaultTreeAdapter;
    const others = el.attrs.filter((a) => a.name !== 'data-sn-text');
    const bad = others.find((a) => /^data-sn-(if|for|else)$/.test(a.name)) ?? others[0];
    if (bad) {
      this.report(el, bad.name, 'SN333', /^data-sn-(if|for|else)$/.test(bad.name)
        ? `\`data-sn-text\` and \`${bad.name}\` on one \`<template>\`: a text node is one binding; the condition or the loop goes on a template around it`
        : `\`${bad.name}\` on a \`<template data-sn-text>\`: a text node has no element to carry it`, 0,
      /^data-sn-(if|for|else)$/.test(bad.name) ? `\`<template ${bad.name}="…"><template data-sn-text="…"></template></template>\`` : 'put it on an element around the text');
    }
    if (hasSnDeep((el as P5Template).content) || (el as P5Template).content.childNodes.some(realNode)) this.report(el, null, 'SN333', 'a `<template data-sn-text>` renders its text and nothing else: its content is dropped', 0);
    const r = this.expr(el, 'data-sn-text', ctx.scope, { mode: 'value' });
    if (r.usesEl) this.report(el, 'data-sn-text', 'SN213', '`$el` in a text without an element: there is no element to read', 0, 'put the text in an element to read it');
    const at = parent.childNodes.indexOf(el as never);
    const put = (nodes: P5Node[]) => {
      for (const n of nodes) (n as { parentNode: P5Parent }).parentNode = parent;
      parent.childNodes.splice(at, 1, ...(nodes as never[]));
    };
    // a literal: plain text
    const lit = /^\s*(?:'([^'\\]*)'|"([^"\\]*)"|(-?\d+(?:\.\d+)?))\s*$/.exec(attr(el, 'data-sn-text') ?? '');
    if (lit && r.ok) {
      const v = lit[1] ?? lit[2] ?? lit[3]!;
      put(v ? [{ nodeName: '#text', value: v, parentNode: parent } as unknown as P5Node] : []);
      mergeText(parent);
      return null;
    }
    const slot = ad.createCommentNode('');
    const b = r.ok ? this.binding({ k: 'text', n: '+', f: this.fn(r.code), d: r.deps, ...usesEl(r) }) : null;
    let node: NodeDef;
    if (ctx.tid < 0) {
      node = { tag: '#', id: this.nextId++, p: ctx.stateIdx, b: b ? [b] : [] };
      const pair = [ad.createCommentNode(`sn ${node.id}`), slot, ad.createCommentNode('/sn')];
      put(pair);
      if (b) this.textRoots.push({ node, b, parent, nodes: pair });
    } else {
      // the element right before it marks it; otherwise an empty comment does
      const prev = at > 0 ? parent.childNodes[at - 1] : undefined;
      const mark = prev && isElement(prev) && prev.tagName !== 'template' && !prev.tagName.startsWith('sn-') && !this.points.has(prev) ? prev : null;
      if (mark) {
        node = { tag: mark.tagName, path: [...ctx.path, at - 1], p: ctx.stateIdx, b: b ? [b] : [] };
        put([slot]);
        this.textAt.set(node, mark);
      } else {
        node = { tag: '#', path: [...ctx.path, index], p: ctx.stateIdx, b: b ? [b] : [] };
        const own = ad.createCommentNode('');
        put([own, slot]);
        this.textAt.set(node, own);
      }
    }
    if (ctx.scope.component?.late) this.lateNodes.add(node);
    if (this.opts.dev) (node as NodeDef & { src?: string }).src = this.position(el);
    if (b) ctx.list.push(node);
    this.textMarks.set(node, el);
    return null;
  }

  /**
   * A tree placement in a shared definition (section 4, how it compiles): a choice anchor between its default
   * (case 0) and the fills that roots pass down the definition (`$f` of its item), one case template per fill,
   * added after the walk. The case's item is the placement's data: the fill reads it as `$slot`.
   */
  runtimePlacement(el: P5Element, ctx: Ctx, index: number): null {
    const k = attr(el, 'name')!;
    const ad = parse5.defaultTreeAdapter;
    // (a copy of the default as written: the walk below strips what it compiles, and each fill's `<slot>` takes the children again)
    const pristine = { ...el, childNodes: el.childNodes.map((c) => this.cloneTree(c, el)) } as P5Element;
    const shape = this.defaultShape({ el: pristine, use: this.useById.get(ctx.scope.component?.id ?? -1) ?? ({ name: ctx.scope.component?.name ?? '' } as Use), name: k, member: { name: k, optional: false, offset: 0 } });
    // the data, in the definition's scope at the placement
    const r = this.expr(el, 'data-sn-with', ctx.scope, { mode: 'value', object: 'literal-keys' });
    const src = attr(el, 'data-sn-with') ?? '{}';
    const members = new Map<string, LetEntry>();
    for (const e of r.entries ?? []) {
      if (members.has(e.key)) continue;
      const v = entryValue(r, e);
      const q = v ? analyze(src.slice(v.start, v.end), ctx.scope, this.page, { mode: 'value', report: () => {} }) : null;
      members.set(e.key, { name: `$slot.${e.key}`, code: q?.ok ? q.inner : 'undefined', deps: q?.deps ?? [], usesEl: false, usesIndex: false, resource: q?.resource ?? null, src: q?.itemOf ?? null, list: q?.listOf ?? null });
    }
    const data = `{ ${[...members].map(([key, l]) => `${JSON.stringify(key)}: (${l.code})`).join(', ')} }`;
    // case 0: the default, the component's markup
    const tid = this.newTemplate(), t = this.templates[tid]!;
    t.item = `$sl${tid}`;
    const tpl = ad.createElement('template', parse5.html.NS.HTML, [{ name: 'id', value: `sn-t-${tid}` }]) as P5Template;
    tpl.content = ad.createDocumentFragment();
    for (const c of [...el.childNodes]) { (c as { parentNode: P5Parent }).parentNode = tpl.content; tpl.content.childNodes.push(c as never); }
    this.origins.set(tpl, this.origins.get(el)!);
    this.headTemplates.set(tid, tpl);
    this.walkChildren(tpl.content, { scope: ctx.scope, list: t.nodes, tid, path: [], stateIdx: -1 });
    const node: NodeDef = { tag: 'template', p: ctx.stateIdx, b: [this.binding({ k: 'ch', d: [...new Set([...members.values()].flatMap((l) => l.deps))].sort(), c: [tid] })] };
    if (ctx.scope.component?.late) this.lateNodes.add(node);
    // the `<slot>` becomes an empty template in place, which `anchors()` turns into the anchor's comments
    const host = el as unknown as P5Template;
    el.tagName = el.nodeName = 'template';
    el.attrs = [];
    host.content = ad.createDocumentFragment();
    el.childNodes = [];
    this.anchorEls.set(node, el);
    if (ctx.tid < 0) { node.id = this.nextId++; setAttr(el, 'data-sn', String(node.id)); } else node.path = [...ctx.path, index];
    ctx.list.push(node);
    this.runtimePlacements.push({ el, node, k, at: ctx.scope, data, deps: node.b[0]!.d as string[], members, shape, cases: [tid], map: {} });
    return null;
  }

  /**
   * After the walk: each tree placement in a definition gets a case template per fill of its name from the
   * roots that reach it, compiled in that root's caller's scope (`$slot` the case's item, read through the
   * run-time scope chain), with the placement's default's children for its `<slot>`s in the definition's
   * scope; then its choice. Walking a fill can reach more definitions and fills: repeated until none is new.
   */
  finishTreeFills() {
    const ad = parse5.defaultTreeAdapter;
    for (let round = 0, changed = true; changed && round < 50; round++) {
      changed = false;
      for (let i = 0; i < this.runtimePlacements.length; i++) {
        const P = this.runtimePlacements[i]!;
        const owner = P.at.component?.name ?? '';
        for (const F of this.fillDefs) {
          if (F.k !== P.k || F.id in P.map || !F.use.caller || !this.reach(F.use.name).has(owner)) continue;
          changed = true;
          const tid = this.newTemplate(), t = this.templates[tid]!, rt = `$sl${tid}`;
          t.item = rt;
          const tpl = ad.createElement('template', parse5.html.NS.HTML, [{ name: 'id', value: `sn-t-${tid}` }]) as P5Template;
          tpl.content = ad.createDocumentFragment();
          const nodes = F.nodes.map((c) => this.cloneTree(c, tpl.content));
          tpl.content.childNodes = nodes as never[];
          this.freshChoices(nodes);
          this.origins.set(tpl, this.origins.get(P.el) ?? { file: this.opts.file, src: '', chain: [] });
          // the fill's own `<slot>`s: the children of the element the placement's default renders
          const accepted: Array<{ path: unknown }> = [];
          for (const s of this.placements(tpl.content).filter((x) => attr(x.el, 'name') === undefined)) {
            // (the rule the build applies when it expands the fill: one place for the children)
            if (accepted.some((a) => !exclusive(a.path as never, s.path))) {
              this.once(s.el, null, 'SN312', `this fill of \`${P.k}\` places the children twice: two \`<slot>\`s in it can render together`, 0, 'one `<slot>` per branch of one `data-sn-if`/`data-sn-else` chain');
              detach(s.el);
              continue;
            }
            accepted.push(s);
            const kids = P.shape ? this.shapeChildren(P.shape, true) : null;
            if (!kids) { this.report(s.el, null, 'SN331', `the default of \`${P.k}\` renders ${P.shape?.what ? `a component (\`<${P.shape.what}>\`)` : 'no element'}, so this \`<slot>\` has no children to place`, 0); detach(s.el); continue; }
            for (const kid of kids) if (isElement(kid)) this.caseScopes.set(kid, P.at);
            this.freshChoices(kids);
            const parent = s.el.parentNode!, at = parent.childNodes.indexOf(s.el as never);
            for (const kid of kids) (kid as { parentNode: P5Parent }).parentNode = parent;
            parent.childNodes.splice(at, 1, ...(kids as never[]));
          }
          // its own instance for what the walk keeps per instance (a component's markup scope, a fill's): the
          // case is a copy of markup compiled already (the placement's default children, a fill's components)
          // (every element: a loop's rows are template content, which does not lead back to the case)
          const mark = (ns: readonly P5Node[]) => { for (const c of ns) if (isElement(c)) { this.caseInst.set(c, `#case${tid}/`); mark(c.childNodes); if (c.tagName === 'template') mark((c as P5Template).content.childNodes); } };
          mark(tpl.content.childNodes);
          const slot: SlotScope = { name: P.k, component: F.use.name, members: new Map([...P.members].map(([key, l]) => [key, { ...l, code: `$.${rt}.${key}`, deps: [] }])), whole: { name: '$slot', code: `$.${rt}`, deps: [], usesEl: false, usesIndex: false, resource: null } };
          if (this.check) {
            const m = F.use.slots!.get(F.k)!;
            this.frameOf.set(slot, this.check.frames.length);
            this.check.frames.push({ kind: 'slot', type: { kind: 'ts', text: m.slot!, loc: this.locOf(F.use.template, 'data-sn-component', m.offset) }, name: P.k, component: F.use.name });
          }
          const scope: Scope = { ...F.use.caller, slot };
          // (a fill forwarded from further out compiles its placements' data from here, as the walk does for any fill)
          for (const c of nodes) if (isElement(c) && !this.fillOf.has(c)) this.caseScopes.set(c, scope);
          this.headTemplates.set(tid, tpl);
          this.walkChildren(tpl.content, { scope, list: t.nodes, tid, path: [], stateIdx: -1 });
          // `data-sn-early="off"` on the root's tag covers its fills
          if (F.use.late) for (const n of t.nodes) this.lateNodes.add(n);
          P.cases.push(tid);
          P.map[F.id] = P.cases.length - 1;
          this.caseFill.set(tid, F);
        }
      }
    }
    for (const P of this.runtimePlacements) {
      const b = P.node.b[0]!;
      const f = P.at.component?.fills ? this.fillsCode(P.at) : null;
      b.c = P.cases;
      b.f = this.fn(`($) => { const f = (${f ?? 'undefined'})?.[${JSON.stringify(P.k)}]; return [f == null ? 0 : (${JSON.stringify(P.map)})[f] ?? 0, ${P.data}]; }`, { el: P.el, attr: null, shift: 0 });
    }
  }

  /** Copies that are walked again on their own (a fill's case template): each `<sn-component use>` in them is a choice of its own. */
  freshChoices(nodes: P5Node[]) {
    const groups = new Map<ChoiceGroup, ChoiceGroup>();
    const walk = (ns: P5Node[]) => {
      for (const n of ns) {
        if (!isElement(n)) continue;
        const c = this.choices.get(n);
        if (c) {
          if (!groups.has(c.group)) groups.set(c.group, { node: null, cases: [], pick: null, warn: '', site: null });
          this.choices.set(n, { ...c, group: groups.get(c.group)! });
        }
        walk(n.childNodes);
        if (n.tagName === 'template') walk((n as P5Template).content.childNodes);
      }
    };
    walk(nodes);
  }

  /** Rule 5: every slot a component declares is placed somewhere inside it, directly or by a component of its package it reaches. */
  slotsPlaced() {
    for (const [name, list] of this.uses) {
      const u = list[0]!;
      if (!u.slots?.size) continue;
      const g = this.fileGraph(name);
      for (const [k, m] of u.slots) {
        // within its package: a component of another package places its own package's slots
        const pkg = this.componentFile(name)?.lib ?? null;
        if (g.places.has(k) || [...this.reach(name)].some((n) => n !== name && (this.componentFile(n)?.lib ?? null) === pkg && this.fileGraph(n).data.has(k) && !this.fileGraph(n).declares.has(k))) continue;
        this.once(u.template, 'data-sn-component', 'SN331', `\`<${name}>\` declares the slot \`${k}\`, and nothing inside it places \`${k}\`: a fill for it would never render`, m.offset,
          `place it: \`<slot name="${k}" data-sn-with="{ … }">\` in \`<${name}>\` or in a component it uses, or remove it`);
      }
    }
  }

  /** The fill choice a scope passes into a shared definition (`$f` of its item): the definition's own, nearer roots' ids over it; null for none. */
  fillsCode(scope: Scope): string | null {
    const f = scope.component?.fills;
    if (!f) return null;
    if (!f.own.size) return f.expr;
    const own = [...f.own].map(([k, id]) => `${JSON.stringify(k)}: ${id}`).join(', ');
    return f.expr ? `{ ...${f.expr}, ${own} }` : `{ ${own} }`;
  }

  /** A component file's markup, read for the graph of what uses what: its tags, its choices' candidates, the slots it declares and places. */
  fileGraph(name: string): { uses: Set<string>; declares: Set<string>; places: Set<string>; data: Set<string>; helperChoice: boolean } {
    const cache = (this.graphs ??= new Map());
    const known = cache.get(name);
    if (known) return known;
    const out = { uses: new Set<string>(), declares: new Set<string>(), places: new Set<string>(), data: new Set<string>(), helperChoice: false };
    cache.set(name, out);
    const f = this.componentFile(name);
    if (!f || f.head) return out;
    let frag: P5Parent;
    try { frag = parsedText(f.text); } catch { return out; }
    const all = () => [...new Set([...(this.opts.componentNames ?? []), ...this.componentFiles.keys()])].filter((n) => this.componentFile(n) && !this.componentFile(n)!.head);
    const walk = (n: P5Parent) => {
      for (const c of n.childNodes) {
        if (!isElement(c)) continue;
        if (c.tagName === 'template' && propsDecl(c) !== undefined) {
          for (const m of typeMembers(propsDecl(c)!.trim() || '{}') ?? []) if (m.slot !== undefined) out.declares.add(m.name);
        }
        if (c.tagName === 'slot' && attr(c, 'name')) {
          out.places.add(attr(c, 'name')!);
          if (attr(c, 'data-sn-with') !== undefined) out.data.add(attr(c, 'name')!);
        }
        if (c.tagName === 'sn-component') {
          const u = attr(c, 'use') ?? '';
          let ast: acorn.Expression | null = null;
          try { ast = parseExpression(u) as acorn.Expression; } catch { ast = null; }
          if (ast?.type === 'TemplateLiteral' && ast.quasis.length === 2) {
            const pre = ast.quasis[0]!.value.cooked ?? '', post = ast.quasis[1]!.value.cooked ?? '';
            for (const n2 of all()) if (n2.startsWith(pre) && n2.endsWith(post)) out.uses.add(n2);
          } else if (ast?.type === 'MemberExpression' && ast.object.type === 'ObjectExpression') {
            for (const p of ast.object.properties) if (p.type === 'Property' && p.value.type === 'Literal' && typeof p.value.value === 'string') out.uses.add(p.value.value);
          } else { out.helperChoice = true; for (const n2 of all()) out.uses.add(n2); }
        } else if (this.componentFile(c.tagName)) out.uses.add(c.tagName);
        walk(c);
        if (c.tagName === 'template') walk((c as P5Template).content);
      }
    };
    walk(frag);
    return out;
  }

  /** The components a component reaches, itself included: what its markup uses, at any depth. */
  reach(name: string): Set<string> {
    const out = new Set<string>([name]);
    const todo = [name];
    while (todo.length) for (const u of this.fileGraph(todo.pop()!).uses) if (!out.has(u)) { out.add(u); todo.push(u); }
    return out;
  }

  /** Whether a component, or one it reaches, has a tree placement: a placement of a name its own component does not declare. */
  reachesTree(name: string): boolean {
    return [...this.reach(name)].some((n) => { const g = this.fileGraph(n); return [...g.data].some((k) => !g.declares.has(k)); });
  }

  /**
   * The tag's attributes on a shared definition's use (a recursion point; for `<sn-component use>`, the
   * attributes of the outer components whose root it is): compiled where the tag is written, in its
   * caller's scope, into the row's item as `$a` (values, and handlers as functions over the caller's
   * scope). The definition's root reads them (`$.$p<tid>.$a`): the bindings for every key its uses
   * pass are added after the walk (`defRootBindings`). Null when there are none.
   */
  pointAttrs(host: P5Element, ctx: Ctx, rt: string): { code: string; deps: string[] } | null {
    const sources: Array<{ el: P5Element; scope: Scope }> = [];
    if (!this.choices.has(host)) sources.push({ el: host, scope: ctx.scope });
    for (const u of this.passOn.get(host) ?? []) if (u.caller) sources.push({ el: u.host, scope: u.caller });
    const entries: string[] = [], deps: string[] = [];
    const keys = this.defAttrs.get(rt) ?? new Map<string, Binding>();
    this.defAttrs.set(rt, keys);
    const read = (key: string) => this.fn(`($) => $.${rt}.$a?.[${JSON.stringify(key)}]`);
    for (const { el, scope } of sources) {
      // plain attributes: each a literal; classes one by one, joined with the root's own
      for (const a of el.attrs) {
        if (a.name.startsWith('data-sn-') || a.name === 'use' || a.name === 'slot') continue;
        if (a.name === 'class') {
          for (const c of a.value.split(/\s+/).filter(Boolean)) {
            entries.push(`${JSON.stringify(`c:${c}`)}: true`);
            if (!keys.has(`c:${c}`)) keys.set(`c:${c}`, this.binding({ k: 'class', n: c, f: read(`c:${c}`) }));
          }
          continue;
        }
        entries.push(`${JSON.stringify(`a:${a.name}`)}: ${JSON.stringify(a.value)}`);
        if (!keys.has(`a:${a.name}`)) keys.set(`a:${a.name}`, this.binding({ k: 'attr', n: a.name, f: read(`a:${a.name}`) }));
      }
      // sinter's: compiled as on an element, then moved into the item
      const sn = el.attrs.filter((a) => a.name.startsWith('data-sn-') && !['data-sn-with', 'data-sn-early'].includes(a.name));
      if (!sn.length) continue;
      const bad = sn.find((a) => !/^data-sn-(class|attr|style|show|on-.+)$/.test(a.name));
      if (bad) {
        this.report(el, bad.name, 'SN102', `\`${bad.name}\` cannot be on the tag of a component used inside itself or chosen by \`<sn-component>\`: its root is a shared definition, which takes plain attributes, \`data-sn-class\`, \`-attr\`, \`-style\`, \`-show\` and handlers`, 0,
          'wrap the tag in an element that carries it, or move it inside the component');
        continue;
      }
      const tmp: NodeDef = { tag: el.tagName, b: [] };
      const copy: P5Element = { ...el, attrs: sn };
      this.origins.set(copy, this.origins.get(el)!);
      this.bindings(copy, tmp, scope, { ...ctx, scope });
      for (const b of tmp.b) {
        if (b.f === undefined) continue;
        if (b.e) { this.report(el, null, 'SN102', '`$el` on the tag of a component used inside itself: the element is the definition\'s root, which the tag\'s scope cannot see', 0); continue; }
        const kind = b.k === 'on' ? 'o' : b.k === 'class' ? 'c' : b.k === 'style' ? 's' : b.k === 'show' ? 'h' : 'a';
        if (b.k !== 'on') for (const d of b.d ?? []) if (typeof d === 'string') deps.push(d);
        const key = `${kind}:${b.n ?? ''}`;
        const code = this.fns[b.f]!;
        entries.push(b.k === 'on'
          ? `${JSON.stringify(key)}: (($c) => ($r) => (${code})(Object.assign(Object.create($c), { $el: $r.$el, $event: $r.$event, $f: $r.$f })))($)`
          : `${JSON.stringify(key)}: (${code})($)`);
        const known = keys.get(key);
        if (b.k === 'on') {
          if (!known) keys.set(key, this.binding({ k: 'on', n: b.n!, f: this.fn(`($) => $.${rt}.$a?.[${JSON.stringify(key)}]?.($)`), ...(b.w?.length ? { w: [...b.w] } : {}) }));
          else if (b.w?.length) known.w = [...new Set([...(known.w ?? []), ...b.w])];
        } else if (!known) keys.set(key, this.binding({ k: b.k, ...(b.n !== undefined ? { n: b.n } : {}), f: read(key) }));
      }
    }
    return entries.length ? { code: `{ ${entries.join(', ')} }`, deps } : null;
  }

  /** After the walk: each shared definition's root takes the bindings for the tag attributes its uses pass. */
  defRootBindings() {
    for (const [, r] of this.defRoots) {
      const keys = this.defAttrs.get(r.rt);
      if (!keys?.size || !r.node) continue;
      r.node.b.push(...keys.values());
      if ([...keys.values()].some((b) => b.k === 'class')) r.node.cl = 1;
    }
  }

  /**
   * `<sn-component use>`: each choice node's function, once the walk reached all its candidates. It
   * evaluates `use` once and returns the case it names with that candidate's props (`[i, props]`), or
   * null for a value outside the candidates; the anchor instantiates case `i`'s definition.
   */
  finishChoices() {
    for (const g of this.choiceGroups) {
      const b = g.node!.b[0]!;
      // Many candidates that take a few distinct props (a library's dispatch: one prop, `{ node }`, the
      // same for every candidate but those that also carry fills) are a lookup, not a chain: one entry per
      // name, the first candidate of a name winning as in the chain, and each distinct props object written
      // once. The table has no prototype and is read only for a string, so `use` matches exactly the names
      // the chain would. A component used in many places repeats this per place, so it must stay small.
      const variants = [...new Set(g.cases.map((c) => c.props))];
      if (g.cases.length >= CHOICE_TABLE && variants.length <= 3) {
        const entries = new Map<string, string>();
        g.cases.forEach((c, i) => {
          if (!entries.has(c.name)) entries.set(c.name, variants.length > 1 ? `[${i}, ${variants.indexOf(c.props)}]` : String(i));
        });
        const table = `{ __proto__: null, ${[...entries].map(([n, e]) => `${JSON.stringify(n)}: ${e}`).join(', ')} }`;
        const pick = variants.length > 1
          ? `const e = typeof v === 'string' ? ${table}[v] : undefined; return e === undefined ? null : [e[0], ${variants.map((p, k) => (k < variants.length - 1 ? `e[1] === ${k} ? ${p} : ` : p)).join('')}];`
          : `const i = typeof v === 'string' ? ${table}[v] : undefined; return i === undefined ? null : [i, ${variants[0]}];`;
        b.f = this.fn(`($) => { const v = (${g.pick}); ${g.warn}${pick} }`, g.site);
      } else {
        const cases = g.cases.map((c, i) => `v === ${JSON.stringify(c.name)} ? [${i}, ${c.props}]`).join(' : ');
        b.f = this.fn(`($) => { const v = (${g.pick}); ${g.warn}return ${cases} : null; }`, g.site);
      }
      b.c = g.cases.map((c) => c.tid);
      const d = [...new Set(g.cases.flatMap((c) => c.deps))].sort();
      if (d.length) b.d = d;
      if (this.opts.dev) this.devAt(b, [b.f]);
    }
  }

  /** this page's linking (`definitions`): the units linked or recorded so far, and how they renumber */
  private defLink = { depth: 0, chain: [] as string[], off: false, maps: { outs: new Map<number, unknown[]>() }, prior: new Map<object, { u: number; i: number }>() };

  /** The shared definition of a component used inside itself: linked from the build's definitions, else compiled. */
  definition(name: string): { tid: number; id: string; use: Use } | null {
    const known = this.defs.get(name);
    if (known !== undefined) return known;
    const L = this.defLink;
    const cache = this.opts.definitions as Map<string, (Plan | Refused) & { slot?: number } | { seen: number }> | undefined;
    // compiled in place unless the build links (a unit compiles only to be recorded); in a unit, its definitions are its own
    if (!cache || L.depth > 0 || L.off || this.check || this.opts.dev) return this.compileDefinition(name);
    const stats = (globalThis as { __snLink?: { hits: number; recorded: number; refused: string[]; missed?: number } }).__snLink;
    // (the chain: the ids of the units before it on this page, short whatever their keys; and how the page is numbered
    // before it, which a plan is not renumbered for: a page numbered otherwise has a plan of its own)
    const numbered = [this.templates.length, this.nextSid, this.useIds, this.nextId, this.fns.length, this.actions.length].join(',');
    const key = [this.opts.decided || this.opts.unrolled || this.opts.constants ? 2 : 1, L.chain.join(','), name, [...this.defs.keys()].join(','), numbered].join('\u0002');
    const u = cache.get(key);
    if (u && 'ops' in u) {
      if (replayUnit(this, u, L.maps)) { L.chain.push(`${u.slot}`); if (stats) stats.hits++; return this.defs.get(name) ?? null; }
      // (what it read differs here: compiled in place, and so is the rest of the page, whose objects the plans after it name)
      if (stats) stats.missed = (stats.missed ?? 0) + 1;
      L.off = true;
      return this.compileDefinition(name);
    }
    if (u && !('seen' in u)) { L.off = true; return this.compileDefinition(name); }
    // recorded the second time a build needs it (recording logs what the unit reads and writes): a definition only one
    // page needs, as a `<html data-sn-for>` template's first entry, is compiled in place once. The chain goes on from either
    if (u === undefined) {
      const id = cache.size;
      cache.set(key, { seen: id });
      L.chain.push(`${id}`);
      L.depth++;
      try { return this.compileDefinition(name); } finally { L.depth--; }
    }
    const r = recordChild(this, name, (child: Compiler) => child.compileDefinition(name), L.prior);
    cache.set(key, Object.assign(r.unit, { slot: u.seen }));
    if ('refused' in r.unit) { L.off = true; if (stats) stats.refused.push(`${name}: ${r.unit.refused}`); }
    else { L.chain.push(`${u.seen}`); if (stats) stats.recorded++; }
    return r.result;
  }

  /**
   * A compiler for one definition (a unit, `recordChild`): this page's numbering copied (`UNIT_NUMBERING`), its context and
   * caches shared (`shared`), the definitions before it importable; its other tables (`own`) the recorder gives it, over
   * this page's, as views that log what it reads and writes.
   */
  unitChild(): { child: Compiler; own: string[]; shared: string[] } {
    const me = this as unknown as Record<string, any>, child = new Compiler(this.opts) as unknown as Record<string, any>;
    const own: string[] = [], shared: string[] = [];
    for (const [k, f] of Object.entries(LINK_FIELDS)) {
      if (!(k in me)) continue;
      const v = me[k];
      if (UNIT_NUMBERING.has(k)) child[k] = v instanceof Map ? new Map(v) : Array.isArray(v) ? v.slice() : v;
      else if (k === 'defs') child[k] = new Map(v);
      else if (UNIT_SHARED.has(k) || f.how !== 'table' && f.how !== 'weak') { child[k] = v; shared.push(k); }
      else { child[k] = v; own.push(k); }
    }
    child.defLink = { ...this.defLink, depth: 1, off: true };
    return { child: child as unknown as Compiler, own, shared };
  }

  /** The shared definition of a component used inside itself, compiled on its first such use. */
  compileDefinition(name: string): { tid: number; id: string; use: Use } | null {
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
    const tpl = ad.createElement('template', parse5.html.NS.HTML, [{ name: 'id', value: `sn-t-${tid}` }]) as P5Template;
    tpl.content = ad.createDocumentFragment();
    const host = ad.createElement(name, parse5.html.NS.HTML, []);
    ad.appendChild(tpl.content, host);
    this.origins.set(host, { file: this.opts.file, src: '', chain: [] });
    this.defHosts.set(host, { rt });
    this.inDef++;
    try { this.expandComponents(tpl.content, []); } finally { this.inDef--; }
    const root = tpl.content.childNodes.find(isElement);
    const use = root ? this.useOf.get(root) ?? this.hostUse.get(host) : undefined;
    if (!root || !use) { this.defs.set(name, null); return null; }
    const entry = { tid, id: `sn-t-${tid}`, use };
    this.defs.set(name, entry);
    if (!use.props) this.report(use.template, 'data-sn-component', 'SN312', `\`<${name}>\` uses itself, so its props must be a type literal the compiler can list (\`{ comment: Comment }\`), not a named type`, 0);
    // the elements it renders as its root: the tag attributes of its uses land there, through the row's item
    for (const el of use.shape ? landingOf(use.shape).filter((e) => !this.slotOf.has(e)) : [use.root]) this.defRoots.set(el, { rt });
    // a head template like any other (`placeTemplates`): anchors instantiate it, the early script while the body arrives
    this.headTemplates.set(tid, tpl);
    if (this.opts.dev) setAttr(tpl, 'data-sn-name', name);
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
          this.report(child, 'name', 'SN209', `resource \`${name}\` is declared twice`, 0);
          continue;
        }
        if (STORE_FNS.includes(name)) {
          this.report(child, 'name', 'SN209', `\`${name}\` is a store function (\`${name}()\`); a resource cannot take its name`, 0);
          continue;
        }
        const key = attr(child, 'key') ?? (attr(child, 'call') == null ? this.apiTarget(child, 'src', attr(child, 'method')?.trim() === 'POST' ? 'post' : 'get')?.shape?.key : undefined);
        const paginate = attr(child, 'paginate') != null ? this.pageSpec(child) : null;
        const info: ResourceInfo = { name, key: key ? key.split(',').map((s) => s.trim()).filter(Boolean) : null, paginate: paginate?.mode ?? null, used: false };
        if (paginate?.jump) info.jumps = true;
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
   * SN509: `then`/`catch` handlers that start each other again. Nodes are
   * action elements (by id) and resources; an edge is a `run('id')` in an action's `then`/`catch`
   * or a resource's `then`, or a `refresh(name)` there (a load runs the resource's `then`).
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
                'each step starts the next, so the requests never stop; a step that should end needs a condition that becomes false, or one step goes. A deliberate cycle, a guarded retry, stays a warning with `strict: { allow: { SN509: \'why\' } }`', true);
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
    for (const chain of this.emptyDefaults.get(parent) ?? []) this.fillScope(chain, ctx.scope, null, this.instOf(parent as P5Node));
    let lastIf: { node: NodeDef; binding: Binding } | null = null;
    const kids = parent.childNodes;
    for (let i = 0; i < kids.length; i++) {
      const child = kids[i]!;
      if (!isElement(child)) {
        if (child.nodeName === '#text' && (child as DefaultTreeAdapterMap['textNode']).value.trim() === '') continue;
        if (child.nodeName === '#comment') {
          // the anchors of lists and branches are comments of exactly these forms: `<!--sn-->` (in a row), `<!--sn 4-->`,
          // `<!--/sn-->`, and an empty one (a text separator); any other comment is the author's (`<!--snippet-->` too)
          // (the compiler's own, a text node's, have no place in the source)
          if (ANCHOR_COMMENT.test((child as DefaultTreeAdapterMap['commentNode']).data) && (child as DefaultTreeAdapterMap['commentNode']).sourceCodeLocation) {
            this.report(child as unknown as P5Element, null, 'SN105', 'this comment is one of the forms sinter marks lists and branches with (`<!--sn-->`, `<!--sn 4-->`, `<!--/sn-->`, `<!---->`): the page would take it for one', 0, 'add a word to the comment, or remove it');
          }
          continue;
        }
        lastIf = null;
        continue;
      }
      const before = kids.length;
      // a kept element's nodes are numbered in a range of their own, from its name: the same ids on every page
      // that keeps it, so the next page's code finds them in the element the swap keeps
      const kept = ctx.tid < 0 ? attr(child, 'data-sn-permanent')?.trim() : undefined;
      const saved = this.nextId;
      if (kept && /^[A-Za-z][\w-]*$/.test(kept)) this.nextId = keptBase(kept);
      if (kept) this.keptDepth++;
      const res = this.element(child, ctx, i, lastIf);
      if (kept) this.keptDepth--;
      if (kept && this.nextId !== saved) {
        if (this.nextId - keptBase(kept) > KEPT_IDS) this.report(child, 'data-sn-permanent', 'SN346', `a kept element binds at most ${KEPT_IDS} nodes (\`${kept}\` binds ${this.nextId - keptBase(kept)})`, 0);
        if (this.nextId > keptBase(kept)) {
          this.keptBound.add(kept);
          if (this.keptSlot.has(kept)) this.report(child, 'data-sn-permanent', 'SN346', `a kept element that binds holds a \`<slot>\` (\`${kept}\`): each page fills it with its own content, so the next page's code would not find its nodes`, 0, 'move the slot out of the kept element, or keep only what has no bindings');
        }
        this.nextId = saved;
      }
      lastIf = res;
      // a literal text folded into the text before it (`mergeText`): the node that followed is at `i` now
      if (kids.length < before && kids[i] !== child) i -= before - kids.length;
    }
  }

  element(el: P5Element, ctx: Ctx, index: number, prevIf: { node: NodeDef; binding: Binding } | null): { node: NodeDef; binding: Binding } | null {
    this.at = { el, attr: null, shift: 0 };
    // a link the build can see: same-page links (query-links.ts) are decided once the page is read
    if ((el.tagName === 'a' || el.tagName === 'area') && attr(el, 'href') != null) this.hrefs.push({ el, prefixes: [{ s: attr(el, 'href')!.trim(), whole: true }], literal: true });
    // a row of an unrolled loop: its item and index, as derived names over the constant list, on the
    // scope of the loop's writer (before a component's root takes its props from this scope). The
    // component's own loop: before its slot content or fill switches to its caller's scope (which
    // does not see the row), so a fill's placement sees it; a loop that is itself slot content: after.
    const row = this.rowOf.get(el);
    const rowLets = (c: Ctx): Ctx => {
      // a loop that is the top of an outer row: the outer rows' items first, which its list reads
      const levels: RowInfo[] = [];
      for (let x: RowInfo | undefined = row; x; x = x.up) levels.unshift(x);
      for (const x of levels) {
        // the list once per loop, for its diagnostics and types; each row's item is its value, which the first
        // pass computed (inlining the list into every row would make the page module grow with rows × list)
        if (!this.listCompiled.has(x.tpl)) {
          this.listCompiled.add(x.tpl);
          if (!this.expr(x.tpl, 'data-sn-for', c.scope, { mode: 'value' }, x.list, x.offset).ok) return c;
        }
        const fixed = { usesEl: false, usesIndex: false, resource: null, src: null };
        const lets: LetEntry[] = [{ name: x.item, code: `(${jsLiteral(x.value)})`, deps: [], ...fixed }];
        if (x.index) lets.push({ name: x.index, code: String(x.k), deps: [], ...fixed });
        c = { ...c, scope: { ...c.scope, lets: [...(c.scope.lets ?? []), ...lets] } };
      }
      return c;
    };
    // (a loop among the children a fill's `<slot>` places: after their scope too, the component's at the placement)
    const ownLoop = !!row && !this.slotOf.has(row.tpl) && !this.childrenOf.has(row.tpl);
    if (row && ownLoop) ctx = rowLets(ctx);
    // the children a fill's `<slot>` places: the component's markup, in its scope at the placement (before the
    // components whose markup starts here take their props from it), and a row of their own loop in it
    const placed = this.childrenOf.get(el);
    if (placed) ctx = { ...ctx, scope: this.fillAt(placed, this.instOf(el))?.at ?? ctx.scope };
    const placedRow = !!row && this.childrenOf.has(row.tpl);
    if (placedRow) ctx = rowLets(ctx);
    // a component whose root is not one plain element: its markup starts here (a chain's template, a
    // fill), or an outer component's whose root this is: their scopes, outer first, each in its caller's
    // (its instance: the nearest row or expanded instance it is in, for a chain's branch below a row's top too)
    // slot content (a row or a branch of it) where another component's markup starts: its writer's scope and
    // rows first, which that component's tag was written in, as for a plain root (not a fill that is a root:
    // the slot's owner starts there, in the scope of its own tag)
    const slot = this.slotOf.get(el);
    const starts = this.scopeStart.get(el) ?? [];
    const inSlot = !!slot && starts.length > 0 && !starts.includes(slot) && !this.fillOf.has(el);
    if (inSlot && slot.caller) ctx = { ...ctx, scope: slot.caller };
    // the same for a fill that is the root of a component whose tag was itself written in slot content (a slot
    // root with a named fill, in a row or a branch of another component's slot content): that writer's scope and rows
    // (not a component tag that is itself a fill: its caller is its placement's, `tagFill`)
    const outerSlot = !inSlot && starts.length > 0 && !!slot && starts.includes(slot) && !this.fillOf.has(starts[0]!.host) ? starts[0]!.hostSlot ?? this.writtenIn.get(el) : undefined;
    if (outerSlot?.caller) ctx = { ...ctx, scope: outerSlot.caller };
    const early = inSlot || !!outerSlot?.caller;
    if (early && row && !ownLoop && !placedRow) ctx = rowLets(ctx);
    // (switched to the writer's scope here: each component's caller is the scope the walk has, not its tag's slot)
    for (const u of starts) ctx = { ...ctx, scope: this.markupOf(u, ctx.scope, this.instOf(el), early) };
    // slot content sees the scope of the caller that wrote it
    if (slot?.head && !slot.caller) this.headMarkup(slot, ctx.scope);
    // an unfilled placement: its `data-sn-with`, compiled for its diagnostics and types
    const dflt = this.defaultOf.get(el);
    // a default that is a component's root, placed in that component's own markup: in its scope, below
    const own = dflt && this.useOf.get(el) && this.origins.get(dflt[0]!.el)?.file === this.origins.get(this.useOf.get(el)!.template)?.file;
    if (dflt && !own) this.fillScope(dflt, ctx.scope, null, this.instOf(el));
    // a fill of a slot that passes data: its writer's scope and `$slot`, the values its placement passes here
    // (a component tag that is the fill: its root, whose props and the tag's attributes read `$slot`)
    const fill = this.fillOf.get(el) ?? (this.useOf.has(el) ? this.fillOf.get(this.useOf.get(el)!.host) : undefined);
    if (fill) ctx = { ...ctx, scope: this.fillScope(fill, ctx.scope, slot ?? null, this.instOf(el)) };
    else if (slot?.caller && !inSlot) ctx = { ...ctx, scope: slot.caller };
    if (row && !ownLoop && !placedRow && !early) ctx = rowLets(ctx);
    // a fill's case template, or the children it places (tree slots): the scope they are compiled in
    const caseScope = this.caseScopes.get(el);
    if (caseScope) ctx = { ...ctx, scope: caseScope };
    const base = ctx.scope;
    // a component used inside itself: an instance of its shared definition
    const point = this.points.get(el);
    if (point) return this.recursionPoint(el, point, ctx, index);
    // text without an element
    if (el.tagName === 'template' && attr(el, 'data-sn-text') !== undefined) return this.textNode(el, ctx, index);
    // a tree placement in a shared definition: a choice between its default and the fills passed down
    if (el.tagName === 'slot' && this.runtimeSlots.has(el)) return this.runtimePlacement(el, ctx, index);

    // a component's root: its markup sees the props only
    const use = this.useOf.get(el);
    const callerCtx = use ? ctx : null;
    if (use && !use.layout) ctx = { ...ctx, scope: use.head ? this.headMarkup(use, base) : this.componentScope(use, ctx.scope) };
    if (dflt && own) this.fillScope(dflt, ctx.scope, null, this.instOf(el));
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
    // with the names `declaration()` gives `data-sn-props` for the compiler (the old names are reported there)
    const known = new Set<string>([...ATTRS.map((a) => `data-sn-${a}`), 'data-sn-component', 'data-sn-head', 'data-sn-layout']);
    for (const a of sn) {
      if (known.has(a.name) || a.name.startsWith('data-sn-on-') || a.name.startsWith('data-sn-debounce-')) continue;
      const retired = RETIRED[a.name];
      if (retired) { this.report(el, a.name, 'SN101', `\`${a.name}\` ${retired}`, 0); continue; }
      const by = SET_BY_SINTER[a.name];
      if (by) { this.report(el, a.name, 'SN101', `\`${a.name}\` is set by sinter (${by}): style it with \`[${a.name}]\`, do not write it`, 0); continue; }
      this.report(el, a.name, 'SN101', `\`${a.name}\` is not a sinter attribute.${didYouMean(a.name, [...known, 'data-sn-on-click'])}`, 0);
    }

    if (has('layout') && !use?.layout) this.report(el, 'data-sn-layout', 'SN101', `\`data-sn-layout\` ${RETIRED['data-sn-layout']}`, 0);
    if (has('props') && el.tagName === 'html') this.report(el, 'data-sn-props', 'SN318', '`data-sn-props` on `<html>` belongs to a layout file (`src/layouts/<name>.html`); a page takes no props', 0);
    for (const n of ['props', 'component', 'head', 'emits']) {
      // the old names, written outside a component file: renamed, whatever the place
      if ((n === 'component' || n === 'head') && has(n)) { this.report(el, `data-sn-${n}`, 'SN101', `\`data-sn-${n}\` ${RETIRED[`data-sn-${n}`]}`, 0); continue; }
      if (has(n) && !(n === 'props' && el.tagName === 'html')) this.report(el, `data-sn-${n}`, 'SN102', `\`data-sn-${n === 'emits' ? n : 'props'}\` belongs on the \`<template>\` of a component file (\`src/components/<name>.html\`)${n === 'props' ? ', or on the `<html>` of a layout file' : ''}`, 0);
    }
    if (has('early') && !this.useOf.get(el)) this.report(el, 'data-sn-early', 'SN102', '`data-sn-early` goes on a component\'s tag, `<tag-cloud data-sn-early="off">`', 0);
    if (has('path') && el.tagName !== 'html') this.report(el, 'data-sn-path', 'SN102', '`data-sn-path` belongs on `<html>`', 0);
    if (has('prefetch')) {
      if (el.tagName !== 'html') this.report(el, 'data-sn-prefetch', 'SN102', '`data-sn-prefetch` belongs on `<html>`: it keeps other pages from prefetching or prerendering this one', 0);
      else if (get('prefetch')!.trim() !== 'off') this.report(el, 'data-sn-prefetch', 'SN401', '`data-sn-prefetch` takes `off`; prefetching is on without the attribute', 0);
      else this.prefetchOff = true;
    }
    // kept across a swap (docs/proposals/swap-navigation.md §3): one element of the page; its nodes are numbered
    // from its name (the children loop), and the next page's code takes them over; the marker stays in the HTML
    if (has('permanent')) {
      const name = get('permanent')!.trim(), clash = this.permanentNames.find((n) => n !== name && keptBase(n) === keptBase(name));
      if (!/^[A-Za-z][\w-]*$/.test(name)) this.report(el, 'data-sn-permanent', 'SN346', '`data-sn-permanent` takes a name (letters, digits, `-` and `_`), the same on each page that keeps the element', 0);
      else if (ctx.tid >= 0) this.report(el, 'data-sn-permanent', 'SN346', '`data-sn-permanent` cannot be inside a `<template>`: a kept element is one element of the page', 0);
      else if (['html', 'head', 'body'].includes(el.tagName) || (() => { for (let p: P5Node | null = el; p; p = (p as P5Element).parentNode as P5Node | null) if (isElement(p) && p.tagName === 'head') return true; return false; })()) this.report(el, 'data-sn-permanent', 'SN346', `\`data-sn-permanent\` belongs on an element of the body: \`<${el.tagName}>\` is the page's own`, 0);
      else if (this.keptDepth > 1) this.report(el, 'data-sn-permanent', 'SN346', '`data-sn-permanent` cannot be inside another kept element: the outer one is kept with everything in it', 0);
      else if (this.permanentNames.includes(name)) this.report(el, 'data-sn-permanent', 'SN346', `\`data-sn-permanent="${name}"\` is on two elements of this page`, 0);
      else if (clash) this.report(el, 'data-sn-permanent', 'SN346', `\`${name}\` and \`${clash}\` get the same range of ids: rename one`, 0);
      else {
        this.permanentNames.push(name);
        this.permanentEls.push(el);
        // SN541: media inside whose playback is bound: the next page's code writes it again (a jump, a pause)
        const media = (n: P5Element) => {
          for (const c of [...n.childNodes, ...((n as P5Element & { content?: P5Element }).content?.childNodes ?? [])]) {
            if (!isElement(c)) continue;
            if (c.tagName === 'audio' || c.tagName === 'video') {
              for (const a of c.attrs) {
                const m = a.name === 'data-sn-attr' && /\b(currentTime|paused|volume|muted|playbackRate)\s*:/.exec(a.value);
                if (m) this.report(c, a.name, 'SN541', `\`${m[1]}\` of a \`<${c.tagName}>\` in a kept element is bound: the next page's code sets it again when a link swaps it in, which interrupts playback`, 0, 'leave playback to the element (its controls, or a handler that calls play() and pause()); bind its src, which changes only for another track');
              }
            }
            media(c);
          }
        };
        media(el);
        // its source, where it was written: one markup on every page that keeps it (checked across the pages by the build)
        const o = this.origins.get(el), loc = el.sourceCodeLocation, text = (o?.src ?? '').slice(loc?.startOffset ?? 0, loc?.endOffset ?? 0);
        this.keptSource.set(name, `${o?.file ?? this.opts.file}:${loc?.startOffset ?? 0}:${hashText(text)}`);
        // a slot in it: each page fills it, so its numbering would follow the page (reported if it binds)
        if (/<slot\b/i.test(text)) this.keptSlot.add(name);
      }
    }
    if (has('wait') && get('wait')!.trim() !== 'off') this.report(el, 'data-sn-wait', 'SN401', '`data-sn-wait` takes `off`: what follows the box shows at once instead of waiting for the list\'s first rows', 0);
    // a page or a link the swap leaves to the browser: on `<html>` the build records it, on a link it stays
    if (has('swap')) {
      if (el.tagName !== 'html' && el.tagName !== 'a' && el.tagName !== 'area') this.report(el, 'data-sn-swap', 'SN102', '`data-sn-swap` belongs on `<html>` (links to the page load it) or on a link (it loads its page)', 0);
      else if (get('swap')!.trim() !== 'off') this.report(el, 'data-sn-swap', 'SN401', '`data-sn-swap` takes `off`; with `sinter({ swap: true })` links swap without the attribute', 0);
      else if (el.tagName === 'html') this.swapOff = true;
    }

    // embedded data
    if (has('resource')) {
      if (el.tagName !== 'script' || attr(el, 'type') !== 'application/json') {
        this.report(el, 'data-sn-resource', 'SN102', '`data-sn-resource` must be on a `<script type="application/json">`', 0);
      } else {
        const name = get('resource')!;
        if (!this.page.resources.has(name)) {
          this.report(el, 'data-sn-resource', 'SN301', `resource \`${name}\` is not declared on this page.${didYouMean(name, this.page.resources.keys())}`, 0);
        } else if (ctx.tid >= 0) {
          this.report(el, 'data-sn-resource', 'SN102', 'embedded data cannot be inside a `<template>`', 0);
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

    // keys move a mark through a list of options (see src/options.ts): the attribute stays, for the runtime
    if (has('options')) {
      const list = get('options')!.trim();
      const type = attr(el, 'type')?.trim().toLowerCase() ?? 'text';
      const text = el.tagName === 'textarea' || (el.tagName === 'input' && !/^(button|submit|reset|checkbox|radio|image|file|color|range|hidden)$/.test(type));
      if (el.tagName === 'select' || (el.tagName === 'input' && !text) || el.tagName === 'template') this.report(el, 'data-sn-options', 'SN102', '`data-sn-options` belongs on a text field with suggestions, or on the element that holds the options (a menu, a list)', 0);
      else if (list && !/^[A-Za-z][\w-]*$/.test(list)) this.report(el, 'data-sn-options', 'SN401', '`data-sn-options` takes the literal `id` of the list, or nothing: the options inside the element, else the nearest list around it', 0);
      else {
        if (text) {
          setAttr(el, 'role', 'combobox');
          setAttr(el, 'aria-autocomplete', 'list');
        } else if (attr(el, 'tabindex') == null) setAttr(el, 'tabindex', '0');
        if (list) setAttr(el, 'aria-controls', list);
        this.features.add('options');
      }
    }

    const isTemplate = el.tagName === 'template';
    // raw text: the parser reads no elements or comments in `<textarea>` and `<title>`, so no anchor can mark a list there
    if (el.tagName === 'textarea' || el.tagName === 'title') {
      const text = el.childNodes.map((c) => (c as DefaultTreeAdapterMap['textNode']).value ?? '').join('');
      const m = /<template\b[^>]*\bdata-sn-(for|if|else|text)\b|<sn-component\b/.exec(text);
      if (m) this.report(el, null, 'SN106', `${m[1] ? `a \`<template data-sn-${m[1]}>\`` : '`<sn-component>`'} inside \`<${el.tagName}>\` is text to the HTML parser: it renders nothing`, 0, el.tagName === 'title' ? 'bind the whole title: `data-sn-text` on the `<title>`' : 'bind the whole value: `data-sn-model` or `data-sn-attr="{ value: … }"` on the `<textarea>`');
    }

    for (const n of ['for', 'if', 'else'] as const) {
      if (has(n) && !isTemplate) this.report(el, `data-sn-${n}`, 'SN102', `\`data-sn-${n}\` must be on a \`<template>\`${n === 'for' ? ' (or on `<html>`: the page once per entry)' : ''}`, 0);
    }
    if (has('key') && !(isTemplate && has('for'))) this.report(el, 'data-sn-key', 'SN102', '`data-sn-key` belongs on a `<template data-sn-for>`', 0);

    // a layout's `<body>`: first the handlers of the page's tag, in the page's scope
    const page = this.layoutBody.get(el);
    if (page?.bodyHandlers && page.caller) this.bindings(page.bodyHandlers, node, page.caller, { ...ctx, scope: page.caller }, page);
    this.bindings(el, node, scope, ctx);
    // a component's root: the caller's attributes on its tag, in the caller's scope
    if (use && !use.head) this.bindings(use.host, node, use.caller!, { ...callerCtx!, scope: use.caller! }, use);
    // a branch of a chain root, a fill that is a root, the root of a component tag that is a root: the tags' attributes too
    for (const u of this.landing.get(el) ?? []) if (u.caller) this.bindings(u.host, node, u.caller, { ...ctx, scope: u.caller }, u);
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
      if (r.usesEl) this.report(el, 'data-sn-if', 'SN213', '`$el` in a `data-sn-if`: the condition is marked by comments in the page, so there is no element to read', 0, 'read the element in a binding inside the template, or move the condition onto an element with `data-sn-show`');
      node.b.push(b);
      result = { node, binding: b };
      const cond = this.branchGuard.get(el) ?? `(${get('if')})`;
      if (this.check) this.branchGuard.set(b, cond);
      content = { tid, scope: this.guarded(scope, cond) };
    } else if (isTemplate && has('else')) {
      if (get('else')) this.report(el, 'data-sn-else', 'SN401', '`data-sn-else` takes no value; an else-if is `<template data-sn-else data-sn-if="…">`', 0);
      if (!prevIf) this.report(el, 'data-sn-else', 'SN102', '`data-sn-else` must be on a `<template>` directly after a `data-sn-if` template', 0);
      const tid = this.newTemplate();
      node.b.push(this.binding({ k: 'else', x: tid }));
      if (prevIf) prevIf.binding.y = nodeIdx;
      const before = prevIf && this.branchGuard.get(prevIf.binding);
      content = { tid, scope: before ? this.guarded(scope, `!${before}`) : scope };
    }

    const defRoot = this.defRoots.get(el);
    if (defRoot) defRoot.node = node;
    const hasDirectives = node.b.length > 0 || node.state !== undefined || !!defRoot;
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
      if (content) this.anchorEls.set(node, el);
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
    // the first pass of a prerendered page: which bindings each value attribute made, for `collectConstants`
    const source = (name: string, f: () => void) => {
      if (!this.collecting()) { f(); return; }
      const b0 = node.b.length, d0 = this.diagnostics.length;
      f();
      this.attrSources.push({ src: el, node, attr: name, bindings: node.b.slice(b0), noted: this.diagnostics.slice(d0).some((d) => d.code !== 'SN513') });
    };
    if (has('text')) source('data-sn-text', () => valueB('text', 'data-sn-text'));
    if (has('show')) source('data-sn-show', () => valueB('show', 'data-sn-show'));
    // the morph across a navigation: the name is kept on the element, the transition feature uses it
    if (has('transition')) {
      const r = this.expr(el, 'data-sn-transition', scope, { mode: 'value' });
      if (r.ok) { node.b.push(this.binding({ k: 'attr', n: 'data-sn-vt', f: this.fn(r.code), d: r.deps, ...usesEl(r) })); this.features.add('transition'); }
    }
    if (has('attr')) source('data-sn-attr', () => this.attrBinding(el, node, scope));
    if (has('class')) source('data-sn-class', () => this.objectBinding(el, node, scope, 'class'));
    if (has('style')) source('data-sn-style', () => this.objectBinding(el, node, scope, 'style'));
    if (has('with') && !use) {
      if (!el.tagName.includes('-')) this.report(el, 'data-sn-with', 'SN102', '`data-sn-with` is for custom elements only; use `data-sn-attr`', 0);
      else this.objectBinding(el, node, scope, 'prop');
    }
    if (has('model') && use) this.componentModel(use, node, scope);
    // with `data-sn-debounce` and no action, the model writes once the field pauses (below)
    else if (has('model')) this.model(el, node, scope, get('persist'), (duration(get('model-debounce') ?? '', 'ms') ?? 0) > 0);
    else if (has('persist') && !has('state')) this.report(el, 'data-sn-persist', 'SN102', '`data-sn-persist` needs `data-sn-model` or `data-sn-state` on the same element', 0);

    const methods = METHODS.filter((m) => has(m));
    const isCall = has('call');
    // `data-sn-debounce` delays an action's trigger; `data-sn-model-debounce` a model's write (the pause in place of
    // the typing pause: the write is not typing, so a resource over it loads at once and a model on `$url` is one
    // history entry); a handler waits by `data-sn-debounce-<event>`
    if (has('model-debounce')) {
      const ms = duration(get('model-debounce')!, 'ms'), modelB = !use ? node.b.find((b) => b.k === 'model') : undefined;
      if (ms === null) this.report(el, 'data-sn-model-debounce', 'SN401', `\`data-sn-model-debounce\` takes ${DURATION}, or milliseconds (\`300\`)`, 0);
      else if (use) { /* a component's tag: reported with its other attributes, `cannot be on a component's tag` */ }
      else if (!modelB) this.report(el, 'data-sn-model-debounce', 'SN102', '`data-sn-model-debounce` needs `data-sn-model` on the same element', 0);
      else if (ms > 0) { modelB.ms = ms; this.features.add('debounce'); }
    }
    if (!methods.length && !isCall && has('debounce')) {
      const events = [...new Set(sn.filter((a) => a.name.startsWith('data-sn-on-')).map((a) => a.name.slice('data-sn-on-'.length)))];
      const ms = get('debounce')!.trim();
      // what each part of the element takes instead, the model's only where it has none yet
      const parts = [
        ...(has('model') && !has('model-debounce') ? [`the model with \`data-sn-model-debounce="${ms}"\``] : []),
        ...(events.length ? [`${events.length > 1 ? 'the handlers' : 'the handler'} with ${events.map((e) => `\`data-sn-debounce-${e}="${ms}"\``).join(', ')}`] : []),
      ];
      this.report(el, 'data-sn-debounce', 'SN102', parts.length
        ? `\`data-sn-debounce\` delays an action's trigger, and this element has none; delay ${parts.join(', and ')}`
        : '`data-sn-debounce` needs an action on the same element: a method attribute (`data-sn-post`, `-put`, …) or `data-sn-call`; a model waits with `data-sn-model-debounce`, a handler with `data-sn-debounce-<event>`', 0);
    }
    // `data-sn-debounce-<event>`: only that event's handler waits
    for (const a of sn) {
      if (!a.name.startsWith('data-sn-debounce-')) continue;
      const event = a.name.slice('data-sn-debounce-'.length);
      if (duration(a.value, 'ms') === null) this.report(el, a.name, 'SN401', `\`${a.name}\` takes ${DURATION}, or milliseconds (\`300\`)`, 0);
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
      // sinter's events before the `sn-` prefix: a component that emits one of these names keeps it
      if (UNPREFIXED[event] && !use?.emits?.some((m) => m.name === event)) {
        this.report(el, a.name, 'SN101', `\`${a.name}\` is renamed to \`data-sn-on-${UNPREFIXED[event]}\`, as sinter's events are all \`sn-…\``, 0);
        continue;
      }
      // `sn-navigate`: sinter's, for every navigation while the element is on the page (navigate.ts finds the
      // element by this mark, which stays in the HTML)
      if (event === 'sn-navigate') { this.features.add('navigate'); setAttr(el, 'data-sn-navigate', ''); }
      if (!kf && !/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/.test(event)) {
        this.report(el, a.name, 'SN101', `event names are lowercase kebab-case: \`${a.name}\``, 0);
        continue;
      }
      // a layout's tag: the page's `<body>` handlers, for DOM events and sinter's own
      if (use?.layout && !kf && !DOM_EVENTS.has(event) && !SINTER_EVENTS.includes(event)) {
        this.report(el, a.name, 'SN315', `\`${event}\` is not an event the page's \`<body>\` hears: a layout's tag takes handlers for DOM events and sinter's \`sn-error\` and \`sn-dismiss\`.${didYouMean(event, [...SINTER_EVENTS, ...DOM_EVENTS])}`, 0,
          'a component tells the page with an event it declares: `data-sn-emits="{ \'delete-start\': Item }"` on its template, `emit(\'delete-start\', item)` in it, and the page handles it on the component\'s tag (`<item-row data-sn-on-delete-start="…">`) or an element around it, in the page\'s content');
      } else if (use && !use.layout && !kf && use.emits && !DOM_EVENTS.has(event) && !use.emits.some((m) => m.name === event)) {
        const names = use.emits.map((m) => m.name);
        this.report(el, a.name, 'SN315', `\`<${use.name}>\` does not emit \`${event}\`; ${names.length ? `it declares ${names.map((x) => `\`${x}\``).join(', ')}` : 'it declares no events'}.${didYouMean(event, names)}`, 0);
      }
      // `$url` writes on `input` or `change`: a keystroke replaces (location.ts), but on a checkbox, radio or select it
      // is a choice, a new history entry (4), decided here, so it holds for untrusted events too (Playwright's
      // selectOption() dispatches them). A handler higher up hears both: there `input` replaces.
      const choice = (event === 'input' || event === 'change') && (el.tagName === 'select' || (el.tagName === 'input' && /^(checkbox|radio)$/i.test(attr(el, 'type') ?? '')));
      const r = this.expr(el, a.name, scope, { mode: 'handler', magic: ['$event'], ...(choice ? { urlKind: 4 } : {}) });
      const ms = duration(get(`debounce-${event}`) ?? '', 'ms') ?? 0;
      if (ms > 0) this.features.add('debounce');
      if (r.ok) node.b.push(this.binding({ k: 'on', n: kf ? kf[1]! : event, f: this.fn(r.code), w: r.writes, ...filter, ...(ms > 0 ? { ms } : {}) }));
    }

    if (methods.length > 1) this.report(el, `data-sn-${methods[1]}`, 'SN102', 'an element can have only one method attribute', 0);
    if (methods.length && isCall) this.report(el, 'data-sn-call', 'SN102', 'an element has one action: a method attribute or `data-sn-call`, not both', 0);
    if (methods.length) this.action(el, node, scope, methods[0]!, get, !!ctx.form || el.attrs.some((x) => x.name === 'form'));
    else if (isCall) this.action(el, node, scope, 'call', get);
    // a retired action (`data-sn-get`) has its own SN101: its options asking for an action would contradict it
    else if (!has('get')) for (const n of ACTION_ONLY) if (has(n) && n !== 'debounce') this.report(el, `data-sn-${n}`, 'SN102', `\`data-sn-${n}\` needs an action on the same element: a method attribute (\`data-sn-post\`, \`-put\`, …) or \`data-sn-call\``, 0);
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
    // a shared definition (a component used inside itself, a candidate of `<sn-component use>`): its props are each
    // instance's, given at run time; its tag gives none, which must not read as "left out"
    if (!value.size || this.defHosts.has(use.host)) return;
    // with swaps on, a kept element is numbered alike on every page that keeps it, whatever each passes it (§3): a
    // component used in one, or one whose root is one, is not shaped by its constant props
    if (this.opts.swap && [use.host, parent as P5Node].some((n) => { for (let p: P5Node | null = n; p; p = (p as P5Element).parentNode as P5Node | null) if (isElement(p) && attr(p, 'data-sn-permanent') !== undefined) return true; return false; })) return;
    const real = (c: P5Node) => isElement(c) || (c.nodeName === '#text' && (c as DefaultTreeAdapterMap['textNode']).value.trim() !== '');
    const contentOf = (t: P5Element) => (t as P5Template).content.childNodes;
    const place = (parent: P5Parent, at: number, count: number, nodes: P5Node[]) => {
      for (const n of nodes) (n as { parentNode: P5Parent }).parentNode = parent;
      parent.childNodes.splice(at, count, ...(nodes as never[]));
    };
    const fold = (parent: P5Parent) => {
      for (let i = 0; i < parent.childNodes.length; i++) {
        const c = parent.childNodes[i]!;
        // (another component's markup: its root, or where a root that is not one plain element starts)
        if (!isElement(c) || this.slotOf.has(c) || (this.useOf.has(c) && c !== use.root) || this.points.has(c) || this.scopeStart.get(c)?.some((u) => u !== use)) continue;
        // with swaps on, a kept element is numbered alike on every page that keeps it, whatever each passes it (§3)
        if (this.opts.swap && attr(c, 'data-sn-permanent') !== undefined) continue;
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
    this.at = { el, attr: attrName, shift };
    if (r.ok && !this.codeAt.has(r.code)) this.codeAt.set(r.code, this.at);
    if (r.ok && r.ast) this.complexity(el, attrName, o, r.ast);
    if (r.runs || r.refreshes) this.flows.push({ el, attr: attrName, shift, runs: r.runs ?? [], refreshes: r.refreshes ?? [] });
    this.lastExpr = null;
    if (this.check) {
      // resources named by value (`refresh(people)`) are checked as their names, which the store's types take
      const i = this.recordExpr(el, attrName, scope, o, r.nameEdits ? applyEdits(src, r.nameEdits) : src, shift, r);
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
   * The sources of `merge()`/`remove()` items that are state (`sel`) or a component's event detail:
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
        this.features.add('write-through');
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
      this.fileUses({ el: c.el, attr: c.attr, at: c.shift + c.offset, fn: c.fn, names });
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
      obj = parseExpression(src) as typeof obj;
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
      const r = this.expr(el, 'data-sn-let', scope, { mode: 'value', waits: true }, src.slice(v.start, v.end), v.start);
      const waiting = r.ok ? this.lazyLet(r.inner, r.deps) : null;
      const entry: LetEntry = { name, code: waiting?.code ?? r.inner, deps: waiting?.deps ?? r.deps, usesEl: r.usesEl, usesIndex: r.usesIndex, resource: r.resource, src: r.itemOf ?? null, list: r.listOf ?? null };
      // the resources it can be, for store calls and `$meta[…]` that take it as one: its value as their names
      // (also when the value has an undeclared name: the use reports it as a resource, with the suggestion)
      {
        const lets = scope.lets ?? [], from: LetEntry[] = [];
        const look = (n: string): 'resource' | LetEntry | null => lets.findLast((l) => l.name === n)
          ?? (scope.loops.some((x) => x.name === n) || scope.states.some((x) => x.names.has(n)) ? null : 'resource');
        const leaves = refNames(v, look, from);
        if (Array.isArray(leaves)) {
          const text = src.slice(v.start, v.end), seen = new Set<object>();
          const nameSrc = applyEdits(text, leaves.filter((l) => !seen.has(l.node) && seen.add(l.node)).map((l) => ({ start: l.node.start - v.start, end: l.node.end - v.start, text: l.let ? `(${l.let.nameSrc})` : `'${l.name}'` })));
          // compiled quietly: the value itself was checked above
          const n = analyze(nameSrc, scope, this.page, { mode: 'value', report: () => {} });
          if (n.ok) Object.assign(entry, { names: [...new Set(leaves.map((c) => c.name))], from, nameSrc, nameCode: n.inner, nameDeps: n.deps });
        }
      }
      if (this.check) {
        this.frameOf.set(entry, this.check.frames.length);
        this.check.frames.push({ kind: 'let', name, init: r.ok ? this.lastExpr : null, loc: this.locOf(el, 'data-sn-let', p.key.start), ...(waiting?.waits ? { waits: true as const } : {}) });
      }
      scope = { ...scope, lets: [...(scope.lets ?? []), entry] };
    }
    return scope;
  }

  /**
   * A let (or a prop) that calls a helper of a module reaching a lazy package (anywhere in it): its code wrapped
   * to wait for the module, or null for a let that stays as it is (inlined at every read, docs/spec.md, Derived
   * names). Each such helper reads `$.$z(i, name)`, which throws while the module loads; `$.$w` makes the value
   * `undefined` until then, and the module's arrival (`$lz.<i>`) is one more dependency. lets.ts.
   */
  lazyLet(code: string, deps: string[]): { code: string; deps: string[]; waits: boolean } | null {
    const lazy = this.page.lazy;
    if (!lazy?.size) return null;
    let ast: acorn.Node;
    try { ast = parseExpression(code); } catch { return null; }
    // references to a lazy helper only: not a member's name (`post.title`), an object key (`{ title: s }`; a
    // shorthand `{ title }` is a reference, written out), nor a name a function in the let binds (`(title) => …`)
    const waits: Array<{ n: any; key?: true }> = [];
    const names = (p: any, out: Set<string>): Set<string> => {
      if (!p) return out;
      if (p.type === 'Identifier') out.add(p.name);
      else if (p.type === 'ObjectPattern') for (const x of p.properties) names(x.type === 'RestElement' ? x.argument : x.value, out);
      else if (p.type === 'ArrayPattern') for (const x of p.elements) names(x, out);
      else if (p.type === 'RestElement') names(p.argument, out);
      else if (p.type === 'AssignmentPattern') names(p.left, out);
      return out;
    };
    const visit = (n: any, bound: Set<string>) => {
      if (!n || typeof n.type !== 'string') return;
      if (n.type === 'Identifier') { if (lazy.has(n.name) && !bound.has(n.name)) waits.push({ n }); return; }
      if (n.type === 'MemberExpression') { visit(n.object, bound); if (n.computed) visit(n.property, bound); return; }
      if (n.type === 'Property') {
        if (n.computed) visit(n.key, bound);
        if (n.shorthand && n.value.type === 'Identifier') { if (lazy.has(n.value.name) && !bound.has(n.value.name)) waits.push({ n: n.value, key: true }); return; }
        visit(n.value, bound);
        return;
      }
      if (n.type === 'ArrowFunctionExpression' || n.type === 'FunctionExpression') {
        const inner = new Set(bound);
        if (n.id) inner.add(n.id.name);
        for (const p of n.params) names(p, inner);
        // defaults are evaluated in the function's scope
        for (const p of n.params) visit(p, inner);
        visit(n.body, inner);
        return;
      }
      if (n.type === 'AssignmentPattern') { visit(n.right, bound); return; }
      if (n.type === 'ObjectPattern' || n.type === 'ArrayPattern' || n.type === 'RestElement') {
        for (const x of n.type === 'ObjectPattern' ? n.properties : n.type === 'ArrayPattern' ? n.elements : [n.argument]) {
          if (!x) continue;
          if (x.type === 'Property') { if (x.computed) visit(x.key, bound); visit(x.value, bound); } else visit(x, bound);
        }
        return;
      }
      for (const k of Object.keys(n)) {
        if (k === 'start' || k === 'end' || k === 'type') continue;
        const v = n[k];
        if (Array.isArray(v)) for (const c of v) visit(c, bound);
        else if (v && typeof v === 'object') visit(v, bound);
      }
    };
    visit(ast, new Set());
    if (!waits.length) return null;
    const mods = new Set<number>();
    let out = code;
    for (const { n: w, key } of waits.sort((x, y) => y.n.start - x.n.start)) {
      const z = lazy.get(w.name)!;
      mods.add(z.i);
      out = out.slice(0, w.start) + (key ? `${w.name}: ` : '') + `$.$z(${z.i}, ${JSON.stringify(z.name)})` + out.slice(w.end);
    }
    return { code: `$.$w(() => (${out}))`, deps: [...new Set([...deps, ...[...mods].map((i) => `$lz.${i}`)])].sort(), waits: true };
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

  /** The caller's scope of a component tag that is a fill of a slot that passes data: with its `$slot` (its props read it). */
  tagFill(u: Use, scope: Scope, inst = ''): Scope {
    const f = this.fillOf.get(u.host);
    return f ? this.fillScope(f, scope, this.slotOf.get(u.host) ?? null, inst) : scope;
  }

  /** `sinter check`: the scope of a branch, whose expressions are checked where `cond` holds */
  guarded(scope: Scope, cond: string): Scope {
    if (!this.check) return scope;
    const g = { cond };
    this.frameOf.set(g, this.check.frames.length);
    this.check.frames.push({ kind: 'guard', cond });
    return { ...scope, guards: [...(scope.guards ?? []), g] };
  }

  recordExpr(el: P5Element, attrName: string, scope: Scope, o: Omit<ExprOptions, 'report'>, src: string, shift: number, r: ExprResult): number {
    const frames: number[] = [];
    for (const f of [...(scope.component ? [scope.component] : []), ...scope.states, ...scope.loops, ...(scope.lets ?? []), ...(scope.slot ? [scope.slot] : []), ...(scope.guards ?? [])]) {
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
    if (o.payload) e.payload = { as: o.payloadAs ?? '$event', type: null };
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
      const scaled = this.scaledWidth(this.layout!, el, 'box');
      if (scaled && Math.abs(scaled.b) > 1e-6) {
        // a box in rem or em grows with the default font size: its 2x at a 24 px default too, and `sizes` in em
        const w24 = Math.round(2 * (scaled.a + 24 * scaled.b));
        if (!widths.includes(w24)) widths = [...widths, w24].sort((a, b) => a - b);
        sizes = boxSizesCss(scaled);
      } else sizes = `(max-width: ${w}px) 100vw, ${w}px`;
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
      const scaled = !fluid && bound !== null ? this.scaledWidth(this.layout!, el, 'bound') : null;
      sizes = `auto, ${fluid ? fluid.sizes : bound === null ? '100vw' : scaled && Math.abs(scaled.b) > 1e-6 ? boxSizesCss(scaled) : `(max-width: ${bound}px) 100vw, ${bound}px`}`;
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

  /**
   * The fix SN530 suggests for an image without a height in a list's rows, the most specific the build can give: its
   * size from the API (fields next to the URL its `src` is bound to, in the resource's OpenAPI schema), the
   * attribute it lacks, or an `aspect-ratio` rule for it. Nothing at runtime: attributes and CSS.
   */
  unsizedFix(u: { el: P5Element; src: string | null; v: string | null }, list: string): string {
    const el = u.el;
    const w = attr(el, 'width') !== undefined, h = attr(el, 'height') !== undefined;
    if (w !== h) return `give it \`${w ? 'height' : 'width'}\` too: with both, the browser keeps their ratio before the file loads (\`height: auto\` in its CSS keeps it fluid)`;
    // the API's own width and height, next to the URL
    const path = u.src?.split('.') ?? [];
    const info = u.v && path[0] === u.v && path.length >= 2 && /^[A-Za-z_$][\w$]*$/.test(list) ? this.itemSchema.get(list) : undefined;
    if (info) {
      const doc = this.opts.openapi![info.spec]!.doc;
      // a list's schema (an inline array response) stands for its items
      const items = (x: unknown) => { const d = deref(doc, x) as { type?: unknown; items?: unknown } | null; return d?.type === 'array' ? d.items : x; };
      let schema: unknown = items(info.schema);
      for (const seg of path.slice(1, -1)) schema = schema === undefined ? undefined : properties(doc, schema).get(seg);
      const props = schema === undefined ? new Map<string, unknown>() : properties(doc, schema);
      const num = (k: string) => { const t = (deref(doc, props.get(k)) as { type?: unknown } | null)?.type; return t === 'integer' || t === 'number' || (Array.isArray(t) && t.some((x) => x === 'integer' || x === 'number')); };
      const last = path[path.length - 1]!, cap = last.charAt(0).toUpperCase() + last.slice(1);
      const pair = [['width', 'height'], ['w', 'h'], [`${last}Width`, `${last}Height`], [`${last}_width`, `${last}_height`], ['imageWidth', 'imageHeight'], ['image_width', 'image_height'], [`width${cap}`, `height${cap}`]].find(([a, b]) => num(a!) && num(b!));
      if (pair) {
        const at = path.slice(0, -1).join('.');
        return `the API gives its size next to the URL: add \`width: ${at}.${pair[0]}, height: ${at}.${pair[1]}\` to its \`data-sn-attr\`, so the browser has its ratio before the file loads (\`height: auto\` in its CSS keeps it fluid)`;
      }
    }
    // an aspect-ratio rule, with a selector for it: its classes, or the closest class in its row
    const cls = (x: P5Element) => (attr(x, 'class') ?? '').trim().split(/\s+/).filter((c) => c && !/[{}$]/.test(c));
    let sel = cls(el).length ? `${el.tagName}.${cls(el)[0]}` : null;
    for (let up = el.parentNode as P5Element | null; !sel && up && 'attrs' in up && up.tagName !== 'template'; up = up.parentNode as P5Element | null) if (cls(up).length) sel = `.${cls(up)[0]} ${el.tagName}`;
    const video = el.tagName !== 'img';
    return `give it its images' ratio in the stylesheets: \`${sel ?? el.tagName} { width: 100%; aspect-ratio: ${video ? '16 / 9' : '4 / 3'};${video ? '' : ' object-fit: cover;'} }\` (with your ratio${video ? '' : '; `object-fit: cover` crops any image to it'}), or \`width\` and \`height\` attributes${u.src ? ', or bind both from the data in its `data-sn-attr`' : ''}`;
  }

  /** an image's box width (`box`) or fluid bound (`bound`) from the stylesheets at every default font size */
  scaledWidth(layout: Layout, el: P5Element, what: 'box' | 'bound'): Affine | null {
    return layout.scalable((l) => {
      if (what === 'bound') return l.maxWidth(el);
      const b = l.box(el);
      return b && b !== 'fluid' ? b.width : null;
    });
  }

  objectBinding(el: P5Element, node: NodeDef, scope: Scope, k: 'class' | 'style' | 'prop') {
    const name = k === 'prop' ? 'data-sn-with' : `data-sn-${k}`;
    const r = this.expr(el, name, scope, { mode: 'value', object: k === 'class' ? 'any-keys' : 'literal-keys' });
    // a custom element's properties, from the app's HTMLElementTagNameMap
    if (this.check && k === 'prop') this.typeLast({ returns: { kind: 'decl', name: `Props<${JSON.stringify(el.tagName)}>` } });
    if (!r.entries) return;
    for (const e of r.entries) {
      let key = e.key;
      if (k === 'prop' && ['innerhtml', 'outerhtml', 'srcdoc', 'innertext', 'outertext'].includes(key.toLowerCase())) {
        this.report(el, name, 'SN207', `\`${key}\` cannot be set with \`data-sn-with\``, e.offset);
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

  model(el: P5Element, node: NodeDef, scope: Scope, persist: string | undefined, debounced = false) {
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
      // any other control pushes a history entry (location.ts: 2 typing, 3 burst, 4 push); a debounced model writes
      // after its own pause, so its write pushes, with no second pause
      const urlKind = debounced ? 4 : kind == 'text' ? 2 : kind == 'number' ? 3 : 4;
      const h = this.expr(el, 'data-sn-model', scope, { mode: 'handler', magic: ['$event'], urlKind }, `${attr(el, 'data-sn-model')!} = $event`);
      // typing and a number field's steps wait for a pause: the typing module, only on pages with such a model
      if (urlKind == 2 || urlKind == 3) this.features.add('typing');
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
    const debounce = get('debounce') !== undefined ? duration(get('debounce')!, 'ms') ?? -1 : 0;
    if (debounce < 0) this.report(el, 'data-sn-debounce', 'SN401', `\`data-sn-debounce\` takes ${DURATION}, or milliseconds (\`300\`)`, 0);
    let concurrency = (get('concurrency') ?? (isForm ? 'block' : 'queue')) as ActionDef['concurrency'];
    if (!['block', 'queue', 'latest'].includes(concurrency)) {
      this.report(el, 'data-sn-concurrency', 'SN401', '`data-sn-concurrency` is `block`, `queue` or `latest`', 0);
      concurrency = 'queue';
    }
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
    if (body.r) this.encodedBody(el, 'data-sn-body', body.r.ast);
    const optimistic = fnOf('optimistic', { mode: 'optimistic' });
    if (optimistic.f !== null) this.features.add('optimistic');
    const then = fnOf('then', { mode: 'handler', magic: ['$event', '$result'] },
      typed?.body != null ? { resultType: { kind: 'openapi', spec: typed.spec, schema: typed.body } }
        : call ? { resultType: { kind: 'call', name: call.name } } : undefined);
    const catch_ = fnOf('catch', { mode: 'handler', magic: ['$event', '$error'] });
    const confirm = fnOf('confirm', { mode: 'value', magic: ['$event'] });
    const encoding = get('encoding');
    if (encoding !== undefined && encoding !== 'form') this.report(el, 'data-sn-encoding', 'SN401', '`data-sn-encoding` takes `form`; a body is sent as JSON without the attribute', 0);
    if (encoding !== undefined && method === 'call') this.report(el, 'data-sn-encoding', 'SN102', '`data-sn-encoding` belongs to a method attribute; a call sends its own requests', 0);
    const applyAttr = get('write-through');
    if (applyAttr !== undefined && applyAttr.trim() !== 'off') this.report(el, 'data-sn-write-through', 'SN401', '`data-sn-write-through` takes `off`; write-through is on without the attribute', 0);
    if (applyAttr !== undefined && method === 'call') this.report(el, 'data-sn-write-through', 'SN102', '`data-sn-write-through` belongs to a method attribute (`data-sn-post`, `-put`, `-patch`, `-delete`): a call has no write-through', 0);
    const retryAttr = get('retry')?.trim();
    if (retryAttr === '') this.report(el, 'data-sn-retry', 'SN401', '`data-sn-retry` takes the name of a retry policy from `configure({ retry })`, e.g. `data-sn-retry="drafts"`', 0);
    const ap = method !== 'call' && applyAttr === undefined ? this.applyDef(reads, typed) : null;
    if (ap) {
      this.features.add('write-through');
      if (then.r?.ast) this.redundantWrites(el, then.r, ap, url, method, typed?.path ?? null);
    }
    // server validation errors shown on the fields (fields.ts): forms that send a mutation and leave errors to sinter
    // (a form's own action, or a control's inside one, as the editor's Publish button in RealWorld)
    if ((isForm || (inForm && (tag === 'button' || FORM_CONTROLS.has(tag)))) && method !== 'call' && get('catch') === undefined) this.features.add('fields');
    // a form's own fields as the body, or form encoding: the form module (form.ts)
    if ((isForm && body.f === null && method !== 'call' && method !== 'delete') || (encoding === 'form' && method !== 'call')) this.features.add('form');
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
      ...(retryAttr ? { retry: retryAttr } : {}),
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
   * `SN510`: a `then` write that write-through makes: `merge(item, $result.p)` (an item of `x`)/`upsert(x, $result.p)`
   * where the response's `p` is an object of `x`'s schema (an upsert also needs the action's URL to be the
   * list's URL, judged by the literal parts), and `remove(row)` on a DELETE of that row's URL.
   */
  redundantWrites(el: P5Element, then: ExprResult, ap: ApplyDef, url: UrlTemplate, method: string, opPath: string | null) {
    const lits = (t: UrlTemplate) => t.filter((x): x is string => typeof x === 'string');
    const src = (name: string) => this.resources.find((r) => r.name === name)?.src ?? null;
    const sameUrl = (name: string) => { const s = src(name); return !!s && lits(s).join('\0') === lits(url).join('\0'); };
    const rowUrl = (name: string) => { const s = src(name); if (!s) return false; const a = lits(url), b = lits(s); return a.length === b.length && a.slice(0, -1).join('\0') === b.slice(0, -1).join('\0') && a[a.length - 1] === b[b.length - 1] + '/'; };
    const fix = 'remove this write, or add `data-sn-write-through="off"` to keep it';
    const op = opPath ? `the response of \`${method.toUpperCase()} ${opPath}\`` : 'the response';
    const visit = (n: acorn.AnyNode) => {
      const fn = n.type === 'CallExpression' && n.callee.type === 'Identifier' ? n.callee.name : null;
      // upsert names its resource; patch and remove take the item, whose one source is the resource
      const item = fn === 'merge' || fn === 'remove' ? then.itemCalls?.find((c) => c.start === n.start)?.src : null;
      const name = fn === 'upsert' && n.type === 'CallExpression' && n.arguments[0]?.type === 'Identifier' && this.page.resources.has(n.arguments[0].name) ? n.arguments[0].name
        : item?.length === 1 && !item[0]!.startsWith('@') ? item[0]! : null;
      if (n.type === 'CallExpression' && fn && name) {
        const r = this.resources.find((x) => x.name === name);
        const first = n.arguments[0]!, value = n.arguments[fn === 'remove' ? 0 : 1];
        const itemText = (then.ast && 'start' in first) ? (attr(el, 'data-sn-then') ?? '').slice((first as acorn.Node).start, (first as acorn.Node).end) : '…';
        const resultPath = value && value.type === 'MemberExpression' && !value.computed && value.object.type === 'Identifier' && value.object.name === '$result' && value.property.type === 'Identifier' ? value.property.name
          : value && value.type === 'Identifier' && value.name === '$result' ? '' : null;
        const entry = resultPath != null ? ap.rs?.find((e) => e.p === resultPath && !e.a) : undefined;
        if (r && entry && r.sch === entry.s && fn === 'merge' && (r.key || ap.tg.some((t) => t.r === name && t.s === entry.s))) {
          this.report(el, 'data-sn-then', 'SN510', `\`merge(${itemText}, $result${resultPath ? '.' + resultPath : ''})\` is what write-through does: ${op} is \`${entry.s}\`, which \`${name}\` holds; ${fix}`, n.start);
        } else if (r && entry && r.sch === entry.s && fn === 'upsert' && r.key && sameUrl(name)) {
          this.report(el, 'data-sn-then', 'SN510', `\`upsert(${name}, $result${resultPath ? '.' + resultPath : ''})\` is what write-through does: a POST to \`${name}\`'s URL inserts ${op}'s \`${entry.s}\`; ${fix}`, n.start);
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
    // a list computed from others (`xs.slice()`, `visible(tasks, q)`): its rows' reads of the item have no path, so a
    // change to an item in place reaches the list only, and the rows it keeps render again
    if (!list.path) t.dv = 1;
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
    } else {
      // a choice between resources (`f ? feed : articles`, through lets, `filter`/`toSorted` and a helper given
      // one): their key, when every candidate has the same. Primitives key by value at run time (`keysOf`)
      const names = list.listOf;
      const keys = names?.length && names.every((n) => /^[\w$]+$/.test(n)) ? names.map((n) => this.page.resources.get(n)?.key) : null;
      if (keys?.every((k) => k && k.join('\0') === keys[0]!.join('\0'))) t.keyFields = keys[0]!;
    }
    // a plain list path changes the rows only through its structure or replaced elements (`#`), not element fields
    const deps = alias && list.deps.length == 1 && list.deps[0] == list.path!.join('.') ? [list.deps[0] + '.#'] : list.deps;
    if (list.usesEl) this.report(el, 'data-sn-for', 'SN213', '`$el` in a `data-sn-for`: the list is marked by comments in the page, so there is no element to read', 0, 'read the element in a binding inside a row');
    node.b.push(this.binding({ k: 'for', f: this.fn(list.code), d: deps, x: tid, ...usesEl(list) }));
    return { tid, scope: inner };
  }

  urlTemplate(el: P5Element, attrName: string, scope: Scope, exprOpts: Partial<ExprOptions> = {}, deps?: Set<string>, reads?: Read[]): UrlTemplate {
    const value = attr(el, attrName) ?? '';
    const parts: UrlTemplate = [];
    // `file:` reads a file at build time: a resource's source, never a request
    if (isFileSource(value)) {
      this.report(el, attrName, 'SN332', `\`file:\` is a source for \`<sn-resource src>\`: a file of the project, read at build time. ${el.tagName === 'sn-sync' ? 'A stream' : 'An action'} sends a request; give it a URL`, value.indexOf('file:'));
      return [''];
    }
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

  /** a resource's API's credentials, static headers and token (where it is stored, how it is sent), as the early file sends them; null for the defaults */
  settingsOf(name: string): NonNullable<NonNullable<EarlyIR['res']>[number]['a']> | null {
    const a = this.apiOfResource.get(name), t = a?.token;
    return a && (a.credentials || a.headers || t) ? {
      ...(a.credentials ? { c: a.credentials } : {}), ...(a.headers ? { h: a.headers } : {}),
      ...(t ? { t: { s: t.storage === 'local' ? 'l' as const : 's' as const, k: t.key, h: t.header, p: t.scheme ? t.scheme + ' ' : '' }, ...(this.needsToken.has(name) ? { r: 1 as const } : {}) } : {}),
    } : null;
  }

  /**
   * SN531: a body that is already JSON text (\`JSON.stringify(…)\`). sinter encodes the body itself, so the server
   * gets a JSON string, which a JSON body parser reads as a string, not an object: its fields are missing.
   */
  private encodedBody(el: P5Element, attrName: string, ast: unknown) {
    const n = ast as { type?: string; callee?: { type?: string; object?: { name?: string }; property?: { name?: string } } } | null;
    if (n?.type !== 'CallExpression' || n.callee?.type !== 'MemberExpression' || n.callee.object?.name !== 'JSON' || n.callee.property?.name !== 'stringify') return;
    this.report(el, attrName, 'SN531', `\`${attrName}\` is already JSON text (\`JSON.stringify(…)\`): sinter encodes the body, so the server would get a JSON string, not the object`, 0,
      'pass the object itself: remove `JSON.stringify(…)`');
  }

  /**
   * A resource the HTML preloads: its URL is fixed at build time, it is requested early (\`late\`), and its
   * request needs nothing a link cannot say (no static headers, no \`credentials: 'omit'\`, no token: a link
   * cannot send one, and the browser gives its answer to the page's request, token or not).
   */
  preloaded(r: ResourceDef): boolean {
    const a = this.apiOfResource.get(r.name);
    return !this.late(r.name) && fixedRequest(r) && !!this.earlyOrigin(r.src) && !a?.headers && a?.credentials !== 'omit' && (!a?.token || this.anonymous(r.name));
  }

  /** The spec says the answer does not depend on a token: public, or answered with cookies. */
  private anonymous(name: string): boolean {
    const auth = this.authOf.get(name);
    return auth === 'public' || auth === 'browser';
  }

  /**
   * Not requested before the page module, by preload or the early file: \`early="off"\`; or, on an API without a
   * \`token\`, the spec says the request needs a token the app adds, or the config may change requests (middleware,
   * \`header()\`) and the spec does not say the operation is public or answered with cookies. A request sent before the
   * middleware runs would only be refused (a 401, a console error) and sent again with what the middleware adds. An API's
   * own \`token\` is sent by the early file too.
   */
  private late(name: string): boolean {
    if (this.apiOfResource.get(name)?.token) return this.noEarly.has(name);
    return this.unembedded(name) || (!!this.opts.changesRequests && !this.anonymous(name));
  }

  /**
   * Not embedded by the server layers (they have no visitor's token): \`early="off"\`; the spec says the request
   * needs a token; it may send one (\`optional\`) and a middleware may add it; or its API has a \`token\` and the spec
   * does not say the answer is the same without one.
   */
  private unembedded(name: string): boolean {
    const auth = this.authOf.get(name);
    return this.noEarly.has(name) || auth === 'token' || (auth === 'optional' && !!this.opts.changesRequests)
      || (!!this.apiOfResource.get(name)?.token && !this.anonymous(name));
  }

  /** the resources whose operation needs their API's token (\`token\`, docs/apis.md#a-token): signed out, they load empty without a request */
  readonly needsToken = new Set<string>();

  /**
   * `<link rel="preload" as="fetch">` for the resources whose URL is fixed at build time. A link cannot
   * carry headers, so a resource of an API with static headers (or `credentials: 'omit'`) has none, and
   * the early file's request is its first; `credentials: 'include'` is `crossorigin="use-credentials"`.
   */
  preloadLinks(): string[] {
    const ok = this.resources.filter((r) => this.preloaded(r));
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
    if (attr(el, PAGE_ENTRY) !== undefined && el === this.pagesDecl?.entry) return this.entryResource(el, name, ctx.stateIdx);
    if (isFileSource(attr(el, 'src'))) return this.fileResource(el, name, ctx.stateIdx);
    if (isContentSource(attr(el, 'src'))) return this.contentResource(el, name, ctx.stateIdx);
    for (const a of el.attrs) {
      if (a.name === 'each') this.report(el, a.name, 'SN101', '`each` is renamed to `for`, as in `data-sn-for`: `<sn-resource name="mailboxes" for="a in accounts" src="/api/mailboxes?account={a.id}">`', 0);
      else if (!RESOURCE_ATTRS.includes(a.name) && !PAGINATE_OLD.includes(a.name)) this.report(el, a.name, 'SN101', `\`${a.name}\` is not an attribute of \`<sn-resource>\`.${didYouMean(a.name, RESOURCE_ATTRS)}`, 0);
    }
    const earlyAttr = attr(el, 'early');
    if (earlyAttr != null && earlyAttr !== 'off') this.report(el, 'early', 'SN401', '`early` takes only `off`', 0);
    if (earlyAttr === 'off') this.noEarly.add(name);
    const info = this.page.resources.get(name)!;
    const hasCall = attr(el, 'call') != null;
    if (hasCall && attr(el, 'src') != null) this.report(el, 'call', 'SN102', 'a resource loads from `src` or from `call`, not both', 0);
    else if (!hasCall && attr(el, 'src') == null) this.report(el, null, 'SN401', `resource \`${name}\` needs a \`src\` (or a \`call\`)`, 0);
    if (hasCall) {
      for (const a of ['paginate', 'for', 'cache']) {
        if (attr(el, a) != null) this.report(el, a, 'SN401', `\`${a}\` does not combine with \`call\` in v0.2`, 0);
      }
    }
    const deps = new Set<string>();
    // `for="a in accounts"`: src is evaluated once per list item, with the item in scope
    let each: ResourceDef['each'];
    let srcScope = ctx.scope;
    const eachAttr = attr(el, 'for');
    if (eachAttr != null) {
      const m = /^\s*([A-Za-z_$][\w$]*)\s+in\s+/.exec(eachAttr);
      if (!m) this.report(el, 'for', 'SN401', '`for` takes `item in list`, e.g. `a in accounts`', 0);
      else {
        const list = this.expr(el, 'for', ctx.scope, { mode: 'value' }, eachAttr.slice(m[0].length), m[0].length);
        const listExpr = this.lastExpr;
        for (const d of list.deps) deps.add(d);
        const loop: LoopEntry = { name: m[1]!, kind: 'item', alias: null, resource: list.resource };
        if (this.check) {
          this.frameOf.set(loop, this.check.frames.length);
          this.check.frames.push({ kind: 'loop', item: m[1]!, index: null, init: listExpr, loc: this.locOf(el, 'for', eachAttr.indexOf(m[1]!)) });
        }
        srcScope = { ...ctx.scope, loops: [...ctx.scope.loops, loop] };
        if (list.ok) each = { item: m[1]!, list: this.fn(list.code), ...(list.resource ? { of: list.resource } : {}) };
        this.features.add('for');
        if (!info.key) this.report(el, 'for', 'SN401', 'a `for` resource is a collection: it needs `key`, with a field that tells the sources apart', 0);
        for (const a of ['paginate', 'total', 'cache']) {
          if (attr(el, a) != null) this.report(el, a, 'SN401', `\`${a}\` does not combine with \`for\`: the items come from several requests`, 0);
        }
      }
    }
    const src = hasCall ? [] : this.urlTemplate(el, 'src', srcScope, {}, deps);
    const srcPath = this.lastPath;
    // `method="POST"`: an endpoint that loads data with a request body (search, reports); its body is a value, reloaded when it changes
    const methodAttr = attr(el, 'method')?.trim();
    const post = methodAttr === 'POST';
    if (methodAttr != null && !post) this.report(el, 'method', 'SN401', '`method` takes `POST`; a resource is loaded with GET without the attribute', 0);
    if (attr(el, 'body') != null && !post) this.report(el, 'body', 'SN102', '`body` needs `method="POST"`: a GET request has no body', 0);
    if (post) {
      if (hasCall) this.report(el, 'method', 'SN102', '`method` is for a resource with `src`', 0);
      for (const a of ['cache', 'paginate', 'for']) {
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
    // the old attributes: the object they become, once (on the first one written)
    const old = PAGINATE_OLD.find((a) => attr(el, a) != null);
    if (old && !/^\s*(keyset|offset|append)\s*$/.test(mode ?? '')) {
      this.report(el, old, 'SN101', `\`${old}\` is a key of \`paginate\` now, one object literal: \`paginate="{ keyset: { before: $item.id }, size: 20 }"\` (docs/pagination.md)`, 0);
    }
    const spec = this.pageSpec(el);
    if (spec) {
      if (!info.key) this.report(el, 'paginate', 'SN401', 'a paginated resource needs `key`', 0);
      // the server's names: the resource's own, over its API's, over the defaults
      const src = attr(el, 'src')?.trim() ?? '';
      const via = this.opts.apis && src && !isFileSource(src) && !isContentSource(src) ? apiOf(this.opts.apis, src) : null;
      const wire = via && 'api' in via ? via.api.paginate : undefined;
      const params = { ...wire?.params, ...spec.params }, directions = spec.directions || wire?.directions ? { ...wire?.directions, ...spec.directions } : null;
      let cursor: number | null = null;
      if (spec.cursor) {
        const r = this.expr(el, 'paginate', ctx.scope, { mode: 'value', payload: true, payloadAs: '$item' }, spec.cursor.text, spec.cursor.at);
        this.typeLast({ payload: { kind: 'item', resource: name } });
        cursor = this.fn(r.code);
      }
      paginate = {
        mode: spec.mode, size: spec.size, sizeParam: params.size ?? 'limit', cursor,
        directionParam: params.direction ?? 'direction', pageParam: params.page ?? 'page',
      };
      // the items to skip, named by `params.offset`: a numbered list sends them instead of the page number with
      // `numbered: 'offset'`, a keyset list to jump (`jump`); naming the parameter alone switches nothing
      if (spec.skip) paginate.skipParam = params.offset ?? 'offset';
      if (spec.jump) paginate.skipParam = params.offset ?? 'offset';
      if (directions && spec.mode !== 'numbered') paginate.directionValues = directions;
      // `model: $url.page`: the list's page lives in the URL, read at load and written back on every move
      if (spec.model) {
        const pm = spec.model.name;
        const at = (m: string, code: Code = 'SN401') => this.report(el, 'paginate', code, m, spec.model!.at);
        if (!pm || this.page.pathParams.has(pm)) {
          at(pm ? `\`model\` takes a URL query parameter such as \`$url.page\`; \`$url.${pm}\` is a path parameter (\`data-sn-path\`)` : '`model` takes a URL parameter such as `$url.page`', 'SN203');
        } else if ([...deps].some((d) => d === '$url' || d === `$url.${pm}` || d.startsWith(`$url.${pm}.`))) {
          at(`\`$url.${pm}\` is this resource's page (\`model\`), and its \`src\` or \`when\` reads it too: each page would reset the list; read another parameter there`);
        } else {
          // the read is the compiled `$url.<name>`, where the early file, preloads and embedded data read the start page
          paginate.start = this.fn(`($) => ($.$url.${pm})`);
          paginate.model = pm;
          deps.add(`$url.${pm}`);
          this.pageModels.push({ name: pm, report: (m) => at(m, 'SN203') });
          this.page.writesUrl = true;
        }
      }
      this.features.add('paginate');
    }
    let cache: number | undefined;
    const cacheAttr = attr(el, 'cache');
    if (cacheAttr != null) {
      const age = cacheAttr.trim() === '' ? 0 : duration(cacheAttr, null);
      if (age === null) this.report(el, 'cache', 'SN401', `\`cache\` takes the maximum age, ${DURATION}, or no value for any age`, 0);
      else {
        cache = age;
        this.features.add('cache');
      }
    }
    // `refresh="30s"`: reloaded once this long has passed since its last load, of any cause
    let refresh: number | undefined;
    const refreshAttr = attr(el, 'refresh');
    if (refreshAttr != null) {
      const ms = duration(refreshAttr, null) ?? 0;
      if (duration(refreshAttr, null) === null) this.report(el, 'refresh', 'SN401', `\`refresh\` takes the longest time between loads, ${DURATION}`, 0);
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
    const target = this.opts.apis && !hasCall ? this.apiCheck(el, 'src', post ? 'post' : 'get', srcPath, paginate ? paginateParams(paginate, spec?.cursor?.text) : []) : null;
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
    if (!post && !hasCall) {
      const m = target?.match ?? (!this.opts.apis && this.opts.openapi?.length ? matchResource(this.opts.openapi, src) : null);
      if (m && 'path' in m && m.auth) this.authOf.set(name, m.auth);
    }
    // its API's token: needed when the config's list (from the spec, or the config's own; none: every operation) names it;
    // signed out, such a GET is not sent (a POST resource is sent all the same)
    const tk = target?.api.token;
    if (tk && !post && (!tk.required || tk.required.includes(`GET ${target!.match.path}`))) this.needsToken.add(name);
    let body: number | null = null;
    if (post && attr(el, 'body') != null) {
      const m = target?.match ?? (!this.opts.apis && this.opts.openapi?.length ? matchOperation(this.opts.openapi, src, 'post') : null);
      const r = this.expr(el, 'body', ctx.scope, { mode: 'value' });
      this.encodedBody(el, 'body', r.ast);
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
      if (paginate?.mode === 'keyset' && !paginate.skipParam) r.directions = true;
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

  /** `file:` resources by name: their value is in the head (`data-sn` id), written there by `run()` */
  readonly fileData = new Map<string, { id: number; value: unknown; el?: P5Element; at?: P5Element; fields?: string[] | null; content?: boolean }>();

  /** `fields="sku,name"`: the fields of each entry that browser code gets (`fileJson`), or null; a malformed list is SN332 */
  fieldsOf(el: P5Element, report = true): string[] | null {
    const v = attr(el, 'fields');
    if (v === undefined) return null;
    const list = v.split(',').map((x) => x.trim()).filter(Boolean);
    if (report && (!list.length || list.some((x) => !/^[A-Za-z_$][\w$]*$/.test(x)))) this.report(el, 'fields', 'SN332', '`fields` lists the fields of each entry the browser gets, separated by commas: `fields="slug,title"`', 0);
    return list;
  }
  /** the folders `file:` globs listed, and what their files match: the dev server reloads the page when one is added or removed */
  readonly fileGlobs: Array<{ dir: string; match: string }> = [];
  /** `<html data-sn-for>`: the variable, its list, the pattern as written, and the internal resource that holds the entry */
  private pagesDecl: { name: string; of: string; pattern: string; html: P5Element; entry: P5Element } | null = null;
  /** `<html data-sn-for>`, compiled as the template: the entries and their paths */
  private pagesOut: CompiledParts['pages'] | undefined;
  /** the page's `<html lang>`, once the layout is merged */
  private pageLang: string | undefined;

  /**
   * `<html data-sn-for="post in posts">` (on the page's `<html>`, or its layout's tag): the page once per entry of a
   * build-time list the page declares, at its `data-sn-path` pattern filled from the entry. The entry is an internal
   * resource beside the list, so it is page scope, folds and is typed as any resource. With `page` the compile writes
   * that entry at its path; without it, the template, with the list's first entry.
   */
  pagesOf(doc: DefaultTreeAdapterMap['document']) {
    const html = doc.childNodes.find((n): n is P5Element => isElement(n) && n.tagName === 'html');
    if (html && attr(html, 'data-sn-pages') !== undefined) {
      this.report(html, 'data-sn-pages', 'SN101', `\`data-sn-pages\` ${RETIRED['data-sn-pages']}`, 0);
      html.attrs = html.attrs.filter((a) => a.name !== 'data-sn-pages');
    }
    const v = html && attr(html, 'data-sn-for');
    if (!html || v === undefined) return;
    html.attrs = html.attrs.filter((a) => a.name !== 'data-sn-for');
    const m = /^\s*([A-Za-z_$][\w$]*)\s+in\s+([A-Za-z_$][\w$]*)\s*$/.exec(v);
    if (!m) { this.report(html, 'data-sn-for', 'SN340', '`data-sn-for` on `<html>` takes `<name> in <list>`, e.g. `post in posts`, where `posts` is a `file:` resource of this page', 0); return; }
    const [, name, of] = m as unknown as [string, string, string];
    if (STORE_FNS.includes(name) || name.startsWith('$')) { this.report(html, 'data-sn-for', 'SN340', `\`${name}\` cannot name the entry: it is ${name.startsWith('$') ? 'a magic name' : 'a store function'}`, v.indexOf(name)); return; }
    const pattern = (attr(html, 'data-sn-path') ?? '').trim();
    const pats = pattern.split(/\s+/).filter(Boolean);
    if (pats.length !== 1 || !/\/:/.test(pats[0]!)) { this.report(html, 'data-sn-for', 'SN340', `\`data-sn-for\` on \`<html>\` needs \`data-sn-path\` with exactly one pattern to fill from each entry, e.g. \`data-sn-path="/blog/:slug"\`${pattern ? ` (it is \`${pattern}\`)` : ''}`, 0); return; }
    // the list: a top-level `<sn-resource>` of the page with a `file:` glob (not inside a template or a component)
    let list: P5Element | null = null;
    const find = (p: P5Parent) => { for (const c of p.childNodes) { if (!isElement(c) || list) continue; if (c.tagName === 'template') continue; if (c.tagName === 'sn-resource' && attr(c, 'name') === of) { list = c; return; } find(c); } };
    find(doc);
    const el = list as P5Element | null;
    if (!el) { this.report(html, 'data-sn-for', 'SN340', `\`${of}\` is not a resource of this page: \`data-sn-for\` on \`<html>\` takes a list the page declares, outside any template (\`<sn-resource name="${of}" src="file:/content/posts/*.md">\`)`, v.indexOf(of)); return; }
    const src = attr(el, 'src') ?? '';
    if (!isContentSource(src) && (!isFileSource(src) || !isGlob(src.trim().slice('file:'.length)))) { this.report(html, 'data-sn-for', 'SN340', `\`${of}\` is not a build-time list: \`data-sn-for\` on \`<html>\` takes a \`file:\` glob (\`file:/content/posts/*.md\`) or a collection (\`content:posts\`), whose entries the build knows`, v.indexOf(of)); return; }
    // the entry: an internal resource right after the list, so the list is read first
    const entry = parse5.defaultTreeAdapter.createElement('sn-resource', parse5.html.NS.HTML, [{ name: 'name', value: name }, { name: PAGE_ENTRY, value: of }]);
    const parent = el.parentNode as P5Parent;
    parent.childNodes.splice(parent.childNodes.indexOf(el) + 1, 0, entry);
    (entry as { parentNode: P5Parent }).parentNode = parent;
    const o = this.origins.get(el);
    if (o) this.origins.set(entry, o);
    // a page per entry is written at its own path: a fixed one, as any page with an exact `data-sn-path`
    if (this.opts.page) setAttr(html, 'data-sn-path', this.opts.page.path);
    this.pagesDecl = { name, of, pattern: pats[0]!, html, entry };
  }

  /**
   * `<sn-resource src="content:posts">`: a collection of the content module, a constant list as a `file:` glob is (`fx`),
   * its key the collection's unless `key` is given, sorted by `order` here. `drafts` and `items` are the loader's
   * business. Without collections (`sinter check`, the editor), an empty list.
   */
  contentResource(el: P5Element, name: string, scope: number) {
    const info = this.page.resources.get(name)!;
    for (const a of el.attrs) if (!FILE_ATTRS.includes(a.name) || a.name === 'drafts' || a.name === 'items') {
      const why = a.name === 'drafts' ? '`drafts` is a `file:` glob\'s; a collection leaves its drafts out in its loader (`ctx.files(glob, { drafts })`, `ctx.command`)'
        : a.name === 'items' ? '`items` picks a list out of a value; a collection is a list already'
        : fileAttrProblem(a.name).replace(/a `file:` resource/g, 'a `content:` resource');
      this.report(el, a.name, RESOURCE_ATTRS.includes(a.name) || a.name === 'drafts' || a.name === 'items' ? 'SN332' : 'SN101', why, 0);
    }
    const src = attr(el, 'src')!.trim(), cname = src.slice('content:'.length), at = attr(el, 'src')!.indexOf(cname);
    const known = this.opts.collections;
    const c = known?.get(cname);
    if (known && !c) {
      if (this.opts.collectionsError) this.report(el, 'src', 'SN342', `\`${cname}\`: the content module did not load its collections: ${this.opts.collectionsError.split('\n')[0]}`, at);
      else {
        const near = suggest(cname, known.keys());
        this.report(el, 'src', 'SN342', `\`${cname}\` is not a collection of the content module${known.size ? ` (it has ${[...known.keys()].map((k) => `\`${k}\``).join(', ')})` : ' (it exports none)'}`, at, near ? `did you mean \`content:${near}\`?` : 'export it from `src/sinter.content.ts`: `export const ' + cname + ' = collection({ key, load })`');
      }
    }
    if (!info.key) info.key = [c?.key ?? (attr(el, 'key')?.trim() || 'id')];
    // the list as this page reads it (sorted in its language): built once per build, frozen, shared by every page
    const order = attr(el, 'order')?.trim() || null, lang = this.opts.locale?.name ?? this.pageLang;
    const cacheKey = ['content', cname, order, lang].join('\0');
    let kept = c ? this.opts.globCache?.get(cacheKey) : undefined;
    if (c && !kept) {
      kept = { value: deepFreeze(order ? sortList([...c.value], order, lang) : [...c.value]), files: [], said: [] };
      this.opts.globCache?.set(cacheKey, kept);
    }
    const value: unknown[] = kept?.value ?? (c ? (order ? sortList([...c.value], order, lang) : [...c.value]) : []);
    const id = this.nextId++;
    this.fileData.set(name, { id, value, at: el, fields: this.fieldsOf(el), content: true });
    this.embedded.set(name, id);
    if (this.check) {
      const type = attr(el, 'type')?.trim() || null;
      const typed = !type && this.opts.contentModule ? { content: { module: this.opts.contentModule, name: cname } } : {};
      this.check.resources.push({ name, type: type ? `(${type})[]` : null, loc: this.locOf(el, type ? 'type' : null), nameLoc: this.locOf(el, 'name'), ...typed });
      if (!type && !this.opts.contentModule) this.report(el, null, 'SN504', `resource \`${name}\` has no type: expressions using it are not checked`, 0, 'add `type="…"`, one entry\'s type from the types module, or `type="any"` to leave it unchecked');
    }
    this.resources.push({ name, src: [], key: info.key, items: null, total: null, order: null, when: null, paginate: null, deps: [], scope, data: null, fx: 1 });
    this.declAt.set(this.resources[this.resources.length - 1]!, el);
  }

  /** `<html data-sn-for>`: the entry, a constant (`fx`) beside its list; as the template, the list's entries and their paths */
  entryResource(el: P5Element, name: string, scope: number) {
    const d = this.pagesDecl!;
    const list = this.fileData.get(d.of)?.value;
    const entries = Array.isArray(list) ? list : [];
    if (!this.opts.page) {
      // each entry's path: every `:param` from the entry's field of that name, one path segment (as the sitemap encodes it)
      const out: Array<{ value: unknown; path: string; key: string }> = [];
      // its key: what pairs an entry with its translation in another language's list (`localePrefix`)
      const keyOf = this.page.resources.get(d.of)?.key ?? ['slug'];
      const seen = new Map<string, string>();
      for (const e of entries) {
        const rec = (e ?? {}) as Record<string, unknown>;
        const what = typeof rec.path === 'string' ? `\`${rec.path.slice(1)}\`` : 'an entry';
        let bad: string | null = null;
        const path = d.pattern.replace(/:([A-Za-z_$][\w$]*)/g, (_, k: string) => {
          const x = rec[k];
          if (typeof x !== 'string' && typeof x !== 'number') bad ??= `has no \`${k}\` to fill \`:${k}\` (a string or a number)`;
          const t = String(x ?? '');
          if (!bad && (t === '' || t === '.' || t === '..' || t.includes('/'))) bad = `has \`${k}\` \`${t}\`, which is not one path segment`;
          return encodeURIComponent(t);
        });
        if (bad) { this.report(d.html, 'data-sn-for', 'SN340', `${what} ${bad}: each entry fills \`${d.pattern}\``, 0); continue; }
        const prev = seen.get(path);
        if (prev) { this.report(d.html, 'data-sn-for', 'SN340', `${what} and ${prev} would both be \`${path}\``, 0); continue; }
        seen.set(path, what);
        out.push({ value: e, path, key: keyOf.map((k) => String(rec[k])).join('\u001f') });
      }
      this.pagesOut = { name: d.name, of: d.of, pattern: d.pattern, entries: out };
    }
    const value = this.opts.page ? this.opts.page.value : entries[0] ?? null;
    const id = this.nextId++;
    const listEl = this.resourceEls.get(d.of);
    this.fileData.set(name, { id, value, at: d.html, fields: listEl ? this.fieldsOf(listEl, false) : null, content: !!listEl && isContentSource(attr(listEl, 'src')) });
    this.embedded.set(name, id);
    this.page.resources.get(name)!.used = true;
    // the list is read: by the build, for its entries, whatever the page reads of it
    const listInfo = this.page.resources.get(d.of);
    if (listInfo) listInfo.used = true;
    if (this.check) this.check.resources.push({ name, type: null, loc: this.locOf(el, null), nameLoc: this.locOf(d.html, 'data-sn-for'), item: d.of });
    this.resources.push({ name, src: [], key: null, items: null, total: null, order: null, when: null, paginate: null, deps: [], scope, data: null, fx: 1 });
    this.declAt.set(this.resources[this.resources.length - 1]!, el);
  }

  /**
   * `<sn-resource src="file:./post.md">` (files.ts): the file read at build time, or with a glob every file it matches as
   * a list, sorted by `order` and without drafts in a build; its value embedded in the head, a resource that never loads
   * (`fx`). Only `name`, `src`, `type`, `items`, `key`, `order` and `drafts` apply (SN332).
   */
  fileResource(el: P5Element, name: string, scope: number) {
    const info = this.page.resources.get(name)!;
    for (const a of el.attrs) if (!FILE_ATTRS.includes(a.name)) this.report(el, a.name, RESOURCE_ATTRS.includes(a.name) ? 'SN332' : 'SN101', fileAttrProblem(a.name), 0);
    const written = attr(el, 'src')!, at = written.indexOf('file:');
    // `{$locale}`: each language's build reads its own folder (`localePrefix`); `sinter check` and the editor, the base one
    const lang = /\{\s*\$locale\s*\}/;
    if (lang.test(written) && !this.opts.locale) this.report(el, 'src', 'SN332', '`{$locale}` in a `file:` path needs `sinter({ localePrefix })`: each language\'s build reads its own folder there; without it, the language is the visitor\'s, picked in the browser', written.search(lang));
    const src = this.opts.locale ? written.replace(new RegExp(lang.source, 'g'), this.opts.locale.name) : written;
    const where = lang.test(src) ? { error: '' } : filePath(src, this.origins.get(el)?.file ?? this.opts.file, this.opts.root);
    const top = normalize(this.opts.root).replace(/\/$/, '');
    const relOf = (f: string) => f.slice(top.length + 1);
    /** one file's text, or the problem (SN332) */
    const read = (path: string): string | null => {
      let text: string | null = null, outside = false;
      // the project's readFile refuses a path whose real place (a symlink) is outside the root
      try { text = this.opts.readFile(path); } catch (e) { outside = /outside the project root/.test(String((e as Error)?.message)); }
      this.files.add(path);
      if (text == null) this.report(el, 'src', 'SN332', outside ? `\`${src.trim()}\` is a link to a file outside the project root (\`${relOf(path)}\`): a \`file:\` source reads the project's own files` : `\`${src.trim()}\`: no such file in the project (\`${relOf(path)}\`)`, at);
      return text;
    };
    let value: unknown = null, list = false;
    if ('error' in where) { if (where.error) this.report(el, 'src', 'SN332', where.error, at); }
    else if (!where.glob) {
      const text = read(where.path);
      if (text != null) {
        const v = fileValue(text, where.path);
        if ('error' in v) this.report(el, 'src', 'SN332', v.error, at);
        else value = v.value;
      }
    } else {
      list = true;
      const { dir, match } = where.glob;
      this.fileGlobs.push({ dir, match: match.source });
      // the finished list (entries, drafts left out, keys checked, sorted), and what it reported: kept for the build, since
      // every page of a `<html data-sn-for>` template reads the same list, and building it per page grew with their square
      const drafts = attr(el, 'drafts')?.trim() || null, order = attr(el, 'order')?.trim() || null, keyAttr = attr(el, 'key')?.trim() || null;
      const key = info.key ?? ['slug'];
      const lang = this.opts.locale?.name ?? this.pageLang;
      const cacheKey = [dir, match.source, drafts, order, key.join(','), keyAttr ? 1 : 0, this.opts.dev ? 1 : 0, lang, src.trim()].join('\0');
      let kept = this.opts.globCache?.get(cacheKey);
      if (!kept) {
        const said: Array<{ attr: string; code: Code; message: string; at: number }> = [];
        const say = (a: string, code: Code, message: string, o: number) => said.push({ attr: a, code, message, at: o });
        let found: string[] = [];
        try { found = this.opts.listFiles ? this.opts.listFiles(dir) : []; } catch { found = []; }
        const files = found.filter((f) => f.startsWith(dir.replace(/\/$/, '') + '/') && match.test(f.slice(dir.replace(/\/$/, '').length + 1))).sort();
        if (!this.opts.listFiles) say('src', 'SN332', 'a `file:` glob needs the project\'s files listed; this compile has none (`listFiles`)', at);
        else if (!files.length) say('src', 'SN539', `\`${src.trim()}\` matches no file (\`${relOf(dir) || '.'}\` has none that match): the list is empty`, at);
        let entries: Array<Record<string, unknown>> = [];
        for (const f of files) {
          let text: string | null = null, outside = false;
          try { text = this.opts.readFile(f); } catch (e) { outside = /outside the project root/.test(String((e as Error)?.message)); }
          if (text == null) { say('src', 'SN332', outside ? `\`${src.trim()}\` is a link to a file outside the project root (\`${relOf(f)}\`): a \`file:\` source reads the project's own files` : `\`${src.trim()}\`: no such file in the project (\`${relOf(f)}\`)`, at); continue; }
          const e = fileEntry(text, f, dir, this.opts.root);
          if ('error' in e) { say('src', 'SN332', e.error, at); continue; }
          entries.push(e.value);
        }
        // drafts: an entry whose named field is `true` is left out of a build, and kept in dev (as written, by command)
        if (drafts && !this.opts.dev) entries = entries.filter((e) => e?.[drafts] !== true);
        // the key: a glob's entries have a `slug` each, which is unique (two entries with one key are an error)
        const seen = new Map<string, string>();
        for (const e of entries) {
          const k = key.map((f) => String(e[f])).join(', ');
          const prev = seen.get(k);
          if (prev !== undefined) say(keyAttr ? 'key' : 'src', 'SN332', `two files have the ${keyAttr ? `key \`${k}\`` : `slug \`${k}\``}: \`${prev}\` and \`${String(e.path).slice(1)}\`${keyAttr ? '' : '; give one of them a `slug` of its own, or a `key` that tells them apart'}`, 0);
          else seen.set(k, String(e.path).slice(1));
        }
        // sorted once, here: the page's language decides how strings compare, as the visitor's does for a live resource
        kept = { value: deepFreeze(order ? sortList(entries, order, lang) : entries), files, said };
        this.opts.globCache?.set(cacheKey, kept);
      }
      for (const f of kept.files) this.files.add(f);
      for (const x of kept.said) this.report(el, x.attr, x.code, x.message, x.at);
      value = kept.value;
    }
    const isMd = !('error' in where) && !where.glob && /\.(md|markdown)$/i.test(where.path);
    // drafts: an entry whose named field is `true` is left out of a build, and kept in dev (as written, by command)
    const drafts = attr(el, 'drafts')?.trim() || null;
    if (drafts && !list) this.report(el, 'drafts', 'SN332', '`drafts` leaves entries out of a list; this `file:` source is one file (a glob gives a list: `file:./posts/*.md`)', 0);
    const order = attr(el, 'order')?.trim() || null;
    if (order && !Array.isArray(value) && value !== null && !(attr(el, 'items'))) this.report(el, 'order', 'SN332', '`order` sorts a list; this value is not one (a glob gives a list, and `items` picks one out of a JSON file)', 0);
    if (list && attr(el, 'items')) this.report(el, 'items', 'SN332', '`items` picks a list out of a JSON file; a glob is a list already', 0);
    if (isMd && attr(el, 'items')) this.report(el, 'items', 'SN332', '`items` picks a list out of a JSON file; a markdown file is one entry', 0);
    // the key: a glob's entries have a `slug` each, which is unique (two entries with one key are an error)
    const key = info.key ?? (list ? ['slug'] : null);
    if (!info.key && key) info.key = key;
    const items = attr(el, 'items')?.trim() || null;
    if (items && typeof value === 'string') this.report(el, 'items', 'SN332', '`items` picks a list out of a JSON file; this file is text', 0);
    // sorted once, here: the page's language decides how strings compare, as the visitor's does for a live resource
    if (order && !list && Array.isArray(value)) value = sortList(value, order, this.opts.locale?.name ?? this.pageLang);
    else if (order && items && value && typeof value === 'object') {
      const at = items.split('.').reduce<unknown>((o, k) => (o as Record<string, unknown> | null)?.[k], value);
      if (Array.isArray(at)) value = setPath(value, items.split('.'), sortList(at, order, this.opts.locale?.name ?? this.pageLang));
    }
    const id = this.nextId++;
    this.fileData.set(name, { id, value, at: el, fields: this.fieldsOf(el) });
    this.embedded.set(name, id);
    if (this.check) {
      const type = attr(el, 'type')?.trim() || null;
      // a markdown file: its frontmatter's type (`type`) and the `body` sinter writes; a glob: one entry's, and the fields
      // sinter writes beside it (`slug`, `dir`, `path`, and `body` of a markdown or text file); JSON entries need `type`
      const bodied = list ? !/\.json\b/i.test(src) : isMd;
      const adds = [list ? FILE_ENTRY : null, bodied ? '{ body: string }' : null].filter(Boolean).join(' & ') || null;
      // with `type`, each file's own value must fit it: written into the check at that file (a body as `""`: its text is no type)
      const values: Array<{ file: string; json: string }> = [];
      const blank = (v: unknown) => (bodied && v && typeof v === 'object' && !Array.isArray(v) && 'body' in v ? { ...v, body: '' } : v);
      if (type && list) for (const e of value as Array<Record<string, unknown>>) values.push({ file: `${top}${String(e.path)}`, json: JSON.stringify(blank(e)) });
      else if (type && !('error' in where) && !list && value !== null && typeof value === 'object') {
        const picked = items ? items.split('.').reduce<unknown>((o, k) => (o as Record<string, unknown> | null)?.[k], value) : value;
        if (picked !== undefined) values.push({ file: where.path, json: JSON.stringify(blank(picked)) });
      }
      const fileInfo = list || isMd || values.length ? { file: { list, adds, values } } : {};
      this.check.resources.push({ name, type: type ?? (!list && !isMd && typeof value === 'string' ? 'string' : null), loc: this.locOf(el, type ? 'type' : null), nameLoc: this.locOf(el, 'name'), ...fileInfo });
      const md = bodied;
      if (!type && typeof value !== 'string' && !md) this.report(el, null, 'SN504', `resource \`${name}\` has no type: expressions using it are not checked`, 0, 'add `type="…"` with a type from the types module, or `type="any"` to leave it unchecked');
    }
    this.resources.push({ name, src: [], key: info.key, items, total: null, order: null, when: null, paginate: null, deps: [], scope, data: null, fx: 1 });
    this.declAt.set(this.resources[this.resources.length - 1]!, el);
  }

  /**
   * What would load or write a `file:` resource (SN332), once the page is compiled: a store function that names it
   * (`refresh`, `upsert`, `page`), a change through one of its items (`patch`, `remove`: `names`), write-through, a
   * stream event.
   */
  fileUses(names?: { el: P5Element; attr: string; at: number; fn: string; names: string[] }) {
    const file = (n: string) => this.fileData.has(n.split('>')[0]!);
    if (names) {
      const f = names.names.find(file);
      if (f) this.report(names.el, names.attr, 'SN332', `\`${names.fn}()\` changes \`${f}\`, a \`file:\` resource: it is a constant, read at build time`, names.at);
      return;
    }
    for (const n of this.fileData.keys()) {
      const el = this.resourceEls.get(n)!;
      const q = n.replace(/[$]/g, '\\$');
      const store = new RegExp(`\\$\\.\\$f\\.(refresh|upsert|page|patch|remove)\\([^)]*["']${q}["']`);
      const m = this.fns.map((c) => store.exec(c)).find(Boolean);
      if (m) this.report(el, 'name', 'SN332', `\`${m[1]}()\` would load or change \`${n}\`, a \`file:\` resource: it is a constant, read at build time`, 0);
      if (this.actions.some((a) => a.ap?.tg.some((t) => t.r === n) || a.ap?.nt?.some((t) => t.r === n))) this.report(el, 'name', 'SN332', `an action's response would be written through to \`${n}\`, a \`file:\` resource, which is a constant: add \`data-sn-write-through="off"\` to the action`, 0);
      for (const s of this.syncs) if (s.events.some((e) => e.resource === n)) this.report(el, 'name', 'SN332', `an \`<sn-event>\` changes \`${n}\`, a \`file:\` resource, which is a constant`, 0);
    }
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

  /**
   * The payload type an untyped `<sn-event>` most likely has, for SN506's hint: \`value="incident"\` on a resource
   * typed \`Incident[]\` is \`{ incident: Incident }\`; anything else gets the shape with a placeholder.
   */
  private payloadTypeHint(el: P5Element, resource: string | null): string {
    const resEl = resource ? this.resourceEls.get(resource) : undefined;
    const written = (resEl && attr(resEl, 'type')?.trim()) || null;
    const itemType = written && written !== 'any' ? (/^(.+)\[\]$/.exec(written)?.[1] ?? /^(?:Readonly)?Array<(.+)>$/.exec(written)?.[1] ?? null) : null;
    const item = attr(el, 'op')?.trim() === 'upsert' ? attr(el, 'value')?.trim() : undefined;
    const field = item ? /^\$event\.([A-Za-z_$][\w$]*)$/.exec(item)?.[1] : undefined;
    if (field) return `{ ${field}: ${itemType ?? '…'} }`;
    return '{ id: number; … }';
  }

  event(el: P5Element, ctx: Ctx): EventDef | null {
    for (const a of el.attrs) {
      if (a.name === 'fallback') this.report(el, a.name, 'SN101', '`fallback` is gone: write the refresh as a second event of the same name, each with its `when`: `<sn-event name="person_updated" resource="people" op="upsert" value="person" when="person">` and `<sn-event name="person_updated" resource="people" op="refresh" when="!person">` (docs/recipes/partial-events.html)', 0);
      else if (a.name === 'item' || a.name === 'set') this.report(el, a.name, 'SN101', `\`${a.name}\` is renamed to \`value\`, the value the change writes: the item for \`op="upsert"\`, the fields for \`op="merge"\``, 0);
      else if (!EVENT_ATTRS.includes(a.name)) this.report(el, a.name, 'SN101', `\`${a.name}\` is not an attribute of \`<sn-event>\`.${didYouMean(a.name, EVENT_ATTRS)}`, 0);
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
    if (!only && (!op || !['upsert', 'merge', 'remove', 'refresh'].includes(op))) {
      const was = { patch: 'merge', refetch: 'refresh' }[op as string];
      this.report(el, 'op', 'SN401', was ? `\`op="${op}"\` is renamed to \`op="${was}"\`` : '`op` is `upsert`, `merge`, `remove` or `refresh`', 0);
      return null;
    }
    const scope = ctx.scope;
    const typeAttr = attr(el, 'type')?.trim() || null;
    const payloadType: TypeRef | null = typeAttr && typeAttr !== 'any' ? { kind: 'ts', text: typeAttr, loc: this.locOf(el, 'type') } : null;
    if (this.check && !typeAttr && ['value', 'when', 'then'].some((n) => attr(el, n) != null)) {
      this.report(el, null, 'SN506', `event \`${name}\` has no type: expressions reading its payload are not checked`, 0,
        `add \`type="${this.payloadTypeHint(el, resource)}"\`, the payload's fields (a type from the types module may be named), or \`type="any"\` to leave it unchecked`);
    }
    let writes: string[] = [];
    const fnOf = (n: string, object = false) => {
      if (attr(el, n) == null) return null;
      const r = this.expr(el, n, scope, n === 'then' ? { mode: 'handler', payload: true, payloadState: true, noElement: 'sn-event' } : { mode: 'value', payload: true, payloadState: true });
      writes = r.writes;
      this.typeLast({
        payload: payloadType,
        ...(!resource || n !== 'value' ? {} : { returns: { kind: 'item', resource, ...(op === 'merge' ? { partial: true } : {}) } }),
      });
      if (object && r.ast && r.ast.type !== 'ObjectExpression') this.report(el, n, 'SN401', `\`${n}\` must be an object literal`, 0);
      return this.fn(r.code);
    };
    // `value`: what the change writes, the item (`upsert`, default the whole payload) or the fields (`merge`)
    const value = fnOf('value', op === 'merge');
    if (value !== null && op !== 'upsert' && op !== 'merge') this.report(el, 'value', 'SN102', '`value` applies to `op="upsert"` (the item) and `op="merge"` (the fields)', 0);
    if (op === 'merge' && value === null) this.report(el, null, 'SN401', '`op="merge"` needs `value`, the fields it merges: `value="{ flags }"`', 0);
    const when = fnOf('when');
    const then = fnOf('then');
    return {
      name, resource, op, value: op === 'upsert' || op === 'merge' ? value : null, when,
      ...(then !== null ? { then, ...(writes.length ? { w: writes } : {}) } : {}),
    };
  }

  // ---- first paint

  /**
   * Writes page-level bindings whose value is a build-time constant into the HTML: they read only
   * literal state fields (not persisted) and constants, and evaluate without error to a value the
   * runtime would write as is. Helpers that may not fold (`helperCalls`), `$locale`, resources but `file:` ones, the
   * clock and the URL are not constant: those bindings render in the browser (early chunk or page module).
   */
  /** `decideOnly`: what it decides and would write, with nothing written into the markup (a kept template's entries, `decideFor`) */
  prerender(decideOnly = false) {
    /** `tpl`: in a template's content, written there only when it can never change; `if`: a condition decided for a second pass; `for`: a loop unrolled in it */
    type Cand = { el: P5Element; b: Binding; f: number; tpl?: true; if?: true; for?: true };
    const cands: Cand[] = [];
    const written = this.writtenState();
    const fixed = (ds: PathRef[] | undefined) => strs(ds).every((d) => {
      // a `file:` resource and its status: constants nothing writes
      if (this.fileConstant(d)) return true;
      // a namespace member's call depends on `$locale` (i18n libraries export namespaces): one that may fold reads no
      // locale, and anything else that reads it throws in the evaluator
      if (d === '$locale' && this.opts.helperFold) return true;
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
      if (this.opts.decided || b.k !== 'if' || b.f === undefined || !fixed(b.d) || !this.instKey(el)) return;
      cands.push({ el, b, f: b.f, if: true });
    };
    // a loop over a constant list whose rows need nothing at run time: each row's bindings read only the item, its
    // index, constants and state nothing writes (no handler, model, state, `$el`, component script); a template in a
    // row is decided or unrolled per row (`rowsOf`)
    const ROW = new Set(['text', 'attr', 'class', 'style', 'show']);
    const unroll = (el: P5Element, b: Binding) => {
      if (!this.collecting() || b.k !== 'for' || b.f === undefined || b.e || !fixed(b.d) || !this.instKey(el)) return;
      if (!this.templates[b.x!]) return;
      cands.push({ el, b, f: b.f, for: true });
    };
    // in a kept element nothing is decided or unrolled at build time: its nodes are numbered alike on every page that
    // keeps it, whatever each page passes it, and the next page's code takes them over (swaps, §3)
    for (const { el, node } of this.paints) for (const b of node.b) { value(el, b, false); if (!this.inKept(el)) { decide(el, b); unroll(el, b); } }
    for (const [node, el] of this.tplEls) for (const b of node.b) { value(el, b, true); decide(el, b); }
    const choosing = this.collecting() && [...this.pointOf.values()].some((p) => p.pick);
    if (!cands.length && !choosing && !this.textRoots.length) return;
    // everything the page could call is shadowed: what is not a constant throws
    const NOT = new Error('not a build-time constant');
    const stub = new Proxy(function () {}, { apply() { throw NOT; }, get() { throw NOT; } });
    const params = new Map<string, unknown>([['$k', $k]]);
    // (`location`: the browser's, as in a pattern page's `$canonical`; a test environment may have one)
    for (const h of ['Date', 'Intl', 'Math', 'location', 'date', 'relative', 'number', 'bytes', ...this.opts.helpers.names]) params.set(h, stub);
    // the app's helpers: a call over constants runs here when the static check lets it (`helperFold`), else its stub
    // records which helper kept the binding in the browser, for SN322
    const folding = (this.folding = this.helperCalls(NOT));
    for (const h of this.opts.helpers.names) params.set(h, folding.fn(h));
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
    for (const [ns, { members, module }] of Object.entries(this.opts.helpers.namespaces)) for (const m of members) params.set(`${ns}$${m}`, module === '@tiaforge-ui/sinter/messages' ? stub : folding.fn(`${ns}$${m}`));
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
    // the worklist evaluates the rows' templates and bindings too, and which component each choice renders
    const rowCodes = this.collecting() ? [
      ...this.templates.flatMap((tp) => tp.nodes.flatMap((n) => n.b.filter((b) => b.f !== undefined && (ROW.has(b.k) || b.k === 'if' || b.k === 'for')).map((b) => this.fns[b.f!]!))),
      ...[...this.pointOf.values()].flatMap((p) => (p.pick ? [p.pick.code] : [])),
      ...[...this.pointOf.values()].flatMap((p) => p.group?.cases.map((c) => `($) => (${c.props})`) ?? []),
      ...this.runtimePlacements.flatMap((P) => (P.node.b[0]?.f !== undefined ? [this.fns[P.node.b[0].f]!] : [])),
    ] : [];
    const texts = this.textRoots.filter((t) => !t.b.e && t.b.f !== undefined && fixed(t.b.d) && !this.inKept(t.parent as P5Node));
    const used = [...new Set([...this.stateInits.flatMap((st) => st.fields.map((x) => x.code)), ...cands.map((c) => this.fns[c.f]!), ...rowCodes, ...texts.map((t) => this.fns[t.b.f!]!)])];
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
      if (d === '$locale' && this.opts.helperFold) return true;
      if (this.fileConstant(d)) return true;
      // a waiting let's module: evaluated, so its call (`$z`) records why it does not fold
      if (d.startsWith('$lz.')) return true;
      const m = /^\$s(\d+)(?:\.([^.]+))?/.exec(d);
      if (!m || !states.has(Number(m[1]))) return false;
      return m[2] !== undefined ? !isPersisted(`$s${m[1]}.${m[2]}`) : ![...this.persisted].some((p) => p !== own && p.startsWith(`$s${m[1]}.`));
    });
    const files = this.fileConstants(NOT);
    const scope = new Proxy({}, {
      get: (_, k) => {
        const m = typeof k === 'string' ? /^\$s(\d+)$/.exec(k) : null;
        if (m && states.has(Number(m[1]))) return states.get(Number(m[1]));
        // `file:` resources: their values and constant status; a waiting let's wrapper lets its helper decide
        if (k === '$r') return files.r;
        if (k === '$meta') return files.meta;
        if (k === '$w') return (f: () => unknown) => f();
        // a waiting let's helper (its module reaches a lazy package): never at build time, and SN322 says so
        if (k === '$z') return (_i: number, name: string) => folding.lazy(name);
        throw NOT;
      },
    });
    const run = (code: string): unknown => { folding.start(code); try { return fnOf.get(code)!(scope); } catch { return FAIL; } finally { folding.end(); } };
    for (const st of this.stateInits) {
      if (st.persist) continue;
      const sid = st.sid, obj: Record<string, unknown> = {};
      // each field on its own: one that reads the clock leaves the others constant
      for (const x of st.fields) {
        const v = known(x.deps) ? run(x.code) : FAIL;
        if (v !== FAIL && plainData(v)) { obj[x.key] = v; if (folding.called) this.foldedFields.push({ sid, key: x.key, value: v }); }
        else delete obj[x.key];
      }
      states.set(sid, new Proxy(deepFreeze(obj), {
        get: (t, k) => { if (typeof k === 'string' && (!Object.hasOwn(t, k) || isPersisted(`$s${sid}.${k}`))) throw NOT; return Reflect.get(t, k); },
      }));
    }
    const schemes = schemesOf([]);
    const work = this.worklist(fnOf, known, fixed, schemes, () => usedMessage, () => { usedMessage = false; }, ROW);
    for (const c of cands) {
      own = c.b.k === 'model' && c.b.p !== undefined ? (c.b.w![0] as string).split('.').slice(0, 2).join('.') : null;
      usedMessage = false;
      const v = known(strs(c.b.d)) ? run(this.fns[c.f]!) : FAIL;
      if (c.for) {
        work.unroll(this.instKey(c.el)!, c.b, (usedMessage && !this.opts.locale) ? FAIL : v, scope, c.el);
        continue;
      }
      if (c.if) {
        // per instance (its uses too); one template in two instances nothing tells apart: decided only when they agree
        const key = this.instKey(c.el)!;
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
      // (deciding only: what would be written is recorded, for `collectConstants`, and the markup left as walked)
      if (!decideOnly) writeFirstPaint(c.el, w[0], c.b.n ?? null, w[1]);
      if (c.tpl) { this.tplPainted.add(c.b); this.paintValue.set(c.b, { k: w[0], n: c.b.n ?? null, v: w[1] }); continue; }
      if (msg) { if (!decideOnly) setAttr(c.el, 'data-sn-m', ''); continue; }
      // a persisted model's written value is the fallback: the early chunk still applies the stored one
      if (own === null) { this.painted.add(c.b); this.paintValue.set(c.b, { k: w[0], n: c.b.n ?? null, v: w[1] }); }
    }
    // a text node over constants: plain text in the HTML, its anchor pair gone, its binding and node dropped
    for (const t of texts) {
      usedMessage = false;
      const v = known(strs(t.b.d)) ? run(this.fns[t.b.f!]!) : FAIL;
      if (decideOnly || v === FAIL || usedMessage || (v !== null && v !== undefined && typeof v === 'object')) continue;
      const text = '' + (v ?? '');
      const at = t.parent.childNodes.indexOf(t.nodes[0] as never);
      if (at < 0) continue;
      const out = text ? [{ nodeName: '#text', value: text, parentNode: t.parent } as unknown as P5Node] : [];
      t.parent.childNodes.splice(at, t.nodes.length, ...(out as never[]));
      mergeText(t.parent);
      this.painted.add(t.b);
      this.textFolded.add(t.node);
    }
    if (this.collecting()) work.finish(scope);
  }

  /** prerender's helper calls, while it evaluates (`helperCalls`) */
  folding: ReturnType<Compiler['helperCalls']> | null = null;
  /** by compiled code: the app helper whose call kept it from being a build-time constant, and why (SN322) */
  readonly foldWhy = new Map<string, string>();

  /**
   * The app's helpers as the build-time evaluator calls them (docs/spec.md, Helpers at build time): a helper the
   * static check lets fold (`helperFold`), with its module loaded in Node (`helperValues`), runs over plain-data
   * arguments and must return plain data. One that throws, returns anything else, or (every build runs it twice)
   * returns another result the second time, stays in the browser, with warning SN534 once at the call in dev builds. Any other
   * helper throws `NOT`, and the call it was in is recorded with the reason, for SN322.
   */
  helperCalls(NOT: Error) {
    const values = this.opts.helperValues, verdicts = this.opts.helperFold;
    // a page's build-time calls, by helper and arguments: its passes and the worklist evaluate a let again and again
    let rec: FoldMemo | null = null;
    if (values) {
      const m = FOLD_MEMO.get(values);
      // (the editor compiles one file again at every edit: what it no longer calls is dropped now and then)
      if (m?.file === this.opts.file && m.calls.size < 512) rec = m;
      else FOLD_MEMO.set(values, (rec = { file: this.opts.file, calls: new Map(), refs: new WeakMap(), n: 0 }));
    }
    const memo = rec?.calls ?? null;
    /** an argument that is a result the page handed out: that call, not its (large) value */
    const refOf = (x: unknown) => (x && typeof x === 'object' ? rec?.refs.get(x) : undefined);
    let code: string | null = null;
    const warned = new Set<string>();
    const why = (key: string) => {
      const v = verdicts?.get(key);
      const name = key.replace('$', '.') + '()';
      if (this.page.lazy?.has(key)) return `\`${name}\` cannot run at build time: its module reaches a lazy package (\`sinter({ lazy })\`), which the dev server loads as stubs and the build does not, so dev and build would differ`;
      if (v && !v.fold) return `\`${name}\` cannot run at build time: ${foldReason(v, this.opts.root)}`;
      if (values === null) return `\`${name}\` cannot run at build time: the helpers module could not be loaded in Node (SN533)`;
      // a compile with no helpers loaded at all (a plain `compile()`): nothing to say
      return null;
    };
    const valueOf = (key: string): unknown => {
      if (!values) return undefined;
      const i = key.indexOf('$');
      return i < 0 ? values[key] : (values[key.slice(0, i)] as Record<string, unknown> | undefined)?.[key.slice(i + 1)];
    };
    const problem = (key: string, what: string) => {
      const at = code ? this.codeAt.get(code) : null;
      const k = `${code}\0${key}`;
      if (!this.opts.dev || !at || warned.has(k)) return;
      warned.add(k);
      this.report(at.el, at.attr, 'SN534', `\`${key.replace('$', '.')}()\` ${what}, so this call stays in the browser`, at.shift);
    };
    const api = {
      /** a helper ran at build time in the current evaluation */
      called: false,
      start: (c: string) => { code = c; api.called = false; },
      /** a call of a lazy module's helper (`$.$z`, a waiting let): recorded for SN322, never run */
      lazy: (name: string): never => {
        const key = [...(this.page.lazy ?? [])].find(([, v]) => v.name === name)?.[0] ?? name;
        const w = code && !this.foldWhy.has(code) ? why(key) : null;
        if (w) this.foldWhy.set(code!, w);
        throw NOT;
      },
      end: () => { code = null; },
      fn: (key: string) => {
        const f = valueOf(key);
        // a helper of a module that reaches a lazy package never runs here: dev stubs the package, the build does not
        const may = typeof f === 'function' && verdicts?.get(key)?.fold === true && !this.page.lazy?.has(key);
        return (...a: unknown[]) => {
          if (!may) { const w = code && !this.foldWhy.has(code) ? why(key) : null; if (w) this.foldWhy.set(code!, w); throw NOT; }
          if (!a.every((x) => plainData(x))) throw NOT;
          const mk = key + '\0' + a.map((x) => { const r = refOf(x); return r === undefined ? dataKey(x) : `r${r};`; }).join('');
          const hit = memo?.get(mk);
          if (hit) {
            if ('what' in hit) { problem(key, hit.what); throw NOT; }
            api.called = true;
            return hit.v;
          }
          const refuse = (what: string): never => { memo?.set(mk, { what }); problem(key, what); throw NOT; };
          let v: unknown;
          try { v = (f as (...x: unknown[]) => unknown)(...a); } catch (e) {
            if (e === NOT) throw NOT;
            refuse(`threw at build time (${(e as Error)?.message ?? String(e)})`);
          }
          if (!plainData(v)) refuse('returned something that is not plain data (JSON values)');
          // run twice here: a second result that differs (a counter, the clock through a path the static check missed)
          // keeps the call in the browser. A build also runs each call again at its end, in a fresh copy of the module
          // and another page order (`foldLog`), for what depends on the calls before, another page's included
          {
            let again: unknown;
            try { again = (f as (...x: unknown[]) => unknown)(...a); } catch { again = FAIL; }
            if (again === FAIL || JSON.stringify(again) !== JSON.stringify(v)) refuse('returned another result when called again with the same arguments: a helper must be pure');
          }
          api.called = true;
          const out = v && typeof v === 'object' ? deepFreeze(structuredClone(v) as object) : v;
          memo?.set(mk, { v: out });
          if (rec && this.opts.foldLog) {
            const id = rec.n++;
            this.opts.foldLog(key, a.map((x): FoldArg => { const r = refOf(x); return r === undefined ? { v: structuredClone(x) } : { r }; }), resultKey(v), id);
            if (out && typeof out === 'object') rec.refs.set(out, id);
          }
          return out;
        };
      },
    };
    return api;
  }

  /** state fields whose value a helper call computed at build time (`prerender`), and where each is written once */
  readonly foldedFields: Array<{ sid: number; key: string; value: unknown }> = [];
  readonly foldScripts = new Map<number, string>();
  headEl: P5Element | null = null;

  /**
   * A folded state field that something in the browser still reads (a binding that does not fold) is read from
   * embedded data in the head (`$.$d(id)`: the runtime and the early file parse it), not computed again by the
   * helper, nor written into the page module and the early file both. After `dropConstants`, only the values a
   * function still reads are written.
   */
  embedFolded() {
    for (const f of this.foldedFields) {
      const st = this.stateInits.find((x) => x.sid === f.sid), x = st?.fields.find((y) => y.key === f.key);
      const node = [...this.roots, ...this.templates.flatMap((t) => t.nodes)].find((n) => n.sid === f.sid && n.state !== undefined);
      if (!x || !node || !x.code.startsWith('($) => (')) continue;
      const body = x.code.slice('($) => ('.length, -1), init = this.fns[node.state!]!;
      // the field's expression, once in the state's initializer: replaced by the read of its value
      if (init.split(body).length !== 2) continue;
      const id = this.nextId++;
      this.foldScripts.set(id, scriptJson(f.value));
      x.code = `($) => ($.$d(${id}))`;
      this.fnUses[node.state!]!--;
      if (this.fnUses[node.state!] === 0) this.fns[node.state!] = '0';
      node.state = this.fn(init.replace(body, `$.$d(${id})`));
    }
  }

  /** the embedded values `embedFolded` made that a function left for the browser reads, in the head */
  foldScriptsOut() {
    if (!this.foldScripts.size || !this.headEl) return;
    const live = this.fns.filter((c) => c !== '0').join('\n');
    for (const [id, json] of this.foldScripts) {
      if (!live.includes(`$.$d(${id})`)) continue;
      const el = parse5.parseFragment(`<script type="application/json" data-sn="${id}">${json}</script>`).childNodes[0] as P5Element;
      el.parentNode = this.headEl;
      this.headEl.childNodes.push(el as never);
    }
  }

  /**
   * A `file:` resource that nothing left for the browser reads (every binding over it was written into the HTML):
   * out of the page, with its embedded data, so a page whose files all folded can ship no JavaScript.
   */
  dropFiles() {
    if (!this.fileData.size) return;
    const code = this.fns.filter((c) => c !== '0');
    // a resource chosen by a computed name (`$r[name]`, `$meta[name]`) may be any of them
    if (code.some((c) => /\$\.\$(r|meta)\[/.test(c))) return;
    for (const [name, d] of this.fileData) {
      const re = new RegExp(`\\$\\.\\$(r|meta)\\.${name}(?![\\w$])`);
      if (code.some((c) => re.test(c))) continue;
      const i = this.resources.findIndex((r) => r.name === name);
      if (i >= 0) this.resources.splice(i, 1);
      if (d.el) detach(d.el);
      this.embedded.delete(name);
      this.fileData.delete(name);
    }
  }

  /** whether a dependency path is a `file:` resource's value or status: a constant nothing writes */
  fileConstant(d: string): boolean {
    const m = /^\$(r|meta)\.([^.]+)/.exec(d);
    return !!m && this.fileData.has(m[2]!);
  }

  /** `$r` and `$meta` for the build-time evaluator: the `file:` resources' values (frozen) and constant status; any other resource throws */
  fileConstants(NOT: Error): { r: object; meta: object } {
    const values = new Map<string, unknown>(), status = new Map<string, unknown>();
    for (const [name, d] of this.fileData) {
      const def = this.resources.find((x) => x.name === name);
      let v = d.value;
      for (const k of def?.items ? def.items.split('.') : []) v = (v as Record<string, unknown> | null)?.[k];
      // a list a build keeps for every page that reads it is frozen once (`globCache`): shared, not copied per page
      values.set(name, v && typeof v === 'object' ? (DEEP_FROZEN.has(v) ? v : deepFreeze(structuredClone(v) as object)) : v);
      status.set(name, Object.freeze({ loading: false, error: null, loadedAt: null, total: null, live: null }));
    }
    const of = (m: Map<string, unknown>) => new Proxy({}, { get: (_, k) => { if (typeof k === 'string' && m.has(k)) return m.get(k); throw NOT; } });
    return { r: of(values), meta: of(status) };
  }
  /** text nodes `prerender()` wrote as plain text: `dropConstants` removes their nodes */
  private readonly textFolded = new Set<NodeDef>();

  /** `SN536` at a constant tree left to the browser, as it would take the page past the expansion limit. */
  expansionWarning(el: P5Element, limit: number, list: boolean) {
    const what = list ? 'this list\'s rows' : 'this component\'s tree';
    const n = this.diagnostics.length;
    this.report(el, null, 'SN536', `${what} would take the page past ${limit.toLocaleString('en')} rows and components expanded at build time, so it is rendered in the browser${this.pagesDecl ? ': on a page per entry, where every entry\'s page would ship its content and the runtime, that is an error' : ''}`, 0,
      'a page that long builds and lays out slowly: split the content over pages, keep a long list of it a list the browser renders, or raise `sinter({ expansionLimit })` if the page is measured fast enough');
    // a page per entry: one long entry would quietly ship its body and the runtime, on that page only
    if (this.pagesDecl) for (const d of this.diagnostics.slice(n)) d.severity = 'error';
  }

  /** The first pass of a prerendered page, which may compile it again: it records what folds (`collectConstants`). */
  collecting(): boolean {
    return !!this.opts.prerender && !this.opts.decided && !this.opts.unrolled && !this.opts.constants;
  }

  /**
   * The worklist of the first pass (`prerender()`): what becomes decidable once a loop is unrolled or a
   * `data-sn-if` decided, at any depth, found by evaluating the compiled templates with each level's item in
   * scope, so the page is compiled again once, whatever the depth. Rows are static markup, at every level: a row
   * is unrolled only when each of its nodes is (bindings of kind `text`, `attr`, `class`, `style` or `show` over
   * the rows and fixed state, no state of its own), each `data-sn-if` in it decided and its branch the same, each
   * loop in it unrolled the same, and each `<sn-component use>` in it rendering none of its candidates (one it
   * renders comes from its shared definition at run time). What a row decides is kept only when the whole loop
   * is unrolled. Keys are instance paths: `<loop>#<k>/` per level before the template's own key (`instKey`).
   * Two instances with one key (no way to tell them apart) leave it. At most `EXPANSION_LIMIT` rows and component
   * instances per page, any list's rows counted (`SN536` past it, at the loop or the tree that crosses it).
   */
  worklist(fnOf: Map<string, ($: unknown) => unknown>, known: (deps: string[]) => boolean, fixed: (ds: PathRef[] | undefined) => boolean, schemes: Set<string>, usedMessage: () => boolean, reset: () => void, ROW: Set<string>) {
    type Found = { unrolls: Array<[string, unknown[], PathRef[] | undefined]>; decided: Array<[string, boolean, PathRef[] | undefined]>; paints: Array<[Binding, string, ConstantWrite | null]>; rows: number; over?: true };
    /** `pick`: a choice's case expanded (decided true), else a loop unrolled */
    const pending = new Map<string, { items: unknown[]; d: PathRef[] | undefined; found: Found; pick?: true; el: P5Element } | null>();
    const placementOf = new Map(this.runtimePlacements.map((P) => [P.node, P] as const));
    const written = this.writtenState();
    /**
     * Item 6: a handler a static tree keeps, which the page module adopts: it writes nothing and reads only
     * constants and its own `$el` (no data, URL, clock or state something writes)
     */
    const handlerOnly = (b: Binding) => {
      if (b.k !== 'on' || b.w?.length || b.f === undefined) return false;
      const code = this.fns[b.f]!;
      if (/\$\.\$(r|meta|url|now|locale|slot|error)\b|\$\.\$p\d/.test(code)) return false;
      return [...code.matchAll(/\$\.\$s(\d+)(?:\.([A-Za-z_$][\w$]*))?/g)].every((m) => m[2] !== undefined && !written.has(`$s${m[1]}`) && !written.has(`$s${m[1]}.${m[2]}`));
    };
    const chosen = new Set<string>();
    const limit = this.opts.expansionLimit ?? EXPANSION_LIMIT;
    let left = limit;
    const run = (sc: object, code: string): unknown => {
      const f = fnOf.get(code);
      if (!f) return FAIL;
      reset();
      this.folding?.start(code);
      try { const v = f(sc); return usedMessage() && !this.opts.locale ? FAIL : v; } catch { return FAIL; } finally { this.folding?.end(); }
    };
    const listOf = (v: unknown): unknown[] | null => (Array.isArray(v) && v.every((x) => plainData(x)) ? v : null);
    // (a placement's element is its `<slot>`; an anchor's, its template)
    const elOf = (n: NodeDef) => this.tplEls.get(n) ?? this.pointOf.get(n)?.el ?? this.paints.find((x) => x.node === n)?.el ?? this.textMarks.get(n) ?? placementOf.get(n)?.el ?? this.anchorEls.get(n);
    const rowScope = (sc: object, t: TemplateDef, item: unknown, k: number) => new Proxy({}, {
      get: (_, p) => (p === t.item ? item : p === t.index || p === t.ii ? k : (sc as Record<string | symbol, unknown>)[p]),
    });
    /** which case a choice renders here: the candidates' keys, and the one it renders (null: none), or null when that is not known */
    const caseOf = (n: NodeDef, el: P5Element, sc: object): { keys: Map<string, string>; picked: string | null } | null => {
      const point = this.pointOf.get(n)!;
      if (!point.group || !point.pick || !fixed(point.pick.deps) || !known(strs(point.pick.deps))) return null;
      const keys = new Map<string, string>();
      for (const c of point.group.cases) {
        const ck = this.choiceKey(el, c.name);
        if (!ck) return null;
        keys.set(c.name, ck);
      }
      const u = run(sc, point.pick.code);
      return u === FAIL ? null : { keys, picked: typeof u === 'string' && keys.has(u) ? u : null };
    };
    /** a choice's case, at `key`: its definition over its props (one row), when that is static markup */
    const expandCase = (point: NonNullable<ReturnType<typeof this.pointOf.get>>, name: string, key: string, sc: object, prefix: string, out: Found): boolean => {
      const c = point.group!.cases.find((x) => x.name === name), t = c && this.templates[c.tid];
      const props = c ? run(sc, `($) => (${c.props})`) : FAIL;
      if (!t?.item || props === FAIL || !plainData(props)) return false;
      out.decided.push([prefix + key, true, point.pick!.deps]);
      return rowsOf(t, [props], prefix + key, sc, out);
    };
    const rowsOf = (t: TemplateDef, items: unknown[], key: string, sc: object, out: Found): boolean => {
      if ((out.rows += items.length) > left) { out.over = true; return false; }
      for (let k = 0; k < items.length; k++) {
        const item = deepFreeze({ v: structuredClone(items[k]) }).v;
        if (!nodesOf(t.nodes, rowScope(sc, t, item, k), `${key}#${k}/`, out)) return false;
      }
      return true;
    };
    /** the nodes of a row, or of a branch decided in it: static markup in every copy, what each decides in `out` */
    const nodesOf = (nodes: NodeDef[], sc: object, prefix: string, out: Found): boolean => {
      for (const n of nodes) {
        if (n.state !== undefined || n.sid !== undefined) return false;
        const el = elOf(n);
        if (!el) return false;
        const point = this.pointOf.get(n);
        if (point?.group) {
          // the candidates it does not render go; the case it renders is an instance of its definition, expanded
          // like a row of one item, its props (item 5)
          const ch = caseOf(n, el, sc);
          if (!ch) return false;
          for (const [name, ck] of ch.keys) if (name !== ch.picked) out.decided.push([prefix + ck, false, point.pick!.deps]);
          if (ch.picked === null) continue;
          if (!expandCase(point, ch.picked, ch.keys.get(ch.picked)!, sc, prefix, out)) return false;
          continue;
        }
        // a tree placement in a definition: the case its fill map chooses (a fill, or its default), as the instance's markup
        const P = placementOf.get(n);
        if (P) {
          const v = run(sc, this.fns[P.node.b[0]!.f!]!);
          const pick = Array.isArray(v) && typeof v[0] === 'number' ? v as [number, unknown] : null;
          const tc = pick ? this.templates[P.cases[pick[0]]!] : undefined;
          if (!pick || !tc?.item || !plainData(pick[1])) return false;
          // (a fill, or the default: any markup, with the rest of the row's conditions; the second pass expands it inline)
          // two shapes of fill stay the browser's (`fillStays`, for SN322): one that forwards to an inner component's
          // slot, and one that holds a tree root of its own
          const stays = pick[0] > 0 ? this.caseFill.get(P.cases[pick[0]]!) : undefined;
          if (stays && this.fillStays(stays)) return false;
          if (!nodesOf(tc.nodes, rowScope(sc, tc, deepFreeze({ v: structuredClone(pick[1]) }).v, 0), prefix, out)) return false;
          continue;
        }
        for (const b of n.b) {
          if (handlerOnly(b)) continue;
          if (ROW.has(b.k)) {
            if (b.e || b.w?.length || !fixed(b.d)) return false;
            if (paintable(el, b) && known(strs(b.d))) {
              const v = run(sc, this.fns[b.f!]!);
              const w = v === FAIL ? FAIL : firstPaintValue(el, b, v, schemes);
              out.paints.push([b, prefix, w === FAIL ? null : { k: w[0], n: b.n ?? null, v: w[1] }]);
            }
            continue;
          }
          if (b.k === 'else') continue;
          if ((b.k !== 'if' && b.k !== 'for') || b.e || b.f === undefined || !fixed(b.d) || !known(strs(b.d))) return false;
          const key = this.instKey(el);
          const v = key ? run(sc, this.fns[b.f]!) : FAIL;
          if (v === FAIL) return false;
          if (b.k === 'if') {
            out.decided.push([prefix + key, !!v, b.d]);
            const other = b.y !== undefined ? nodes[b.y]?.b.find((x) => x.k === 'else')?.x : undefined;
            const kept = v ? this.templates[b.x!] : other !== undefined ? this.templates[other] : undefined;
            if (kept && !nodesOf(kept.nodes, sc, prefix, out)) return false;
            continue;
          }
          const items = listOf(v), t = this.templates[b.x!];
          if (!items || !t?.item) return false;
          out.unrolls.push([prefix + key, items, b.d]);
          if (!rowsOf(t, items, prefix + key, sc, out)) return false;
        }
      }
      return true;
    };
    /** a loop outside any row: unrolled when every row is static markup (above) */
    const unroll = (key: string, b: Binding, v: unknown, sc: object, el: P5Element) => {
      const items = v === FAIL ? null : listOf(v), t = this.templates[b.x!];
      const found: Found = { unrolls: [], decided: [], paints: [], rows: 0 };
      const ok = !!items && !!t?.item && rowsOf(t, items, key, sc, found);
      // the same template in two instances that nothing tells apart: left alone; one over the limit: reported
      pending.set(key, pending.has(key) || (!ok && !found.over) ? null : { items: items!, d: b.d, found, el });
    };
    /** outside rows: each candidate of a choice that this instance does not render goes (one another instance with this key renders stays) */
    const choose = (n: NodeDef, el: P5Element, sc: object) => {
      const point = this.pointOf.get(n)!, ch = caseOf(n, el, sc);
      const keys = point.group?.cases.map((c) => this.choiceKey(el, c.name)) ?? [];
      for (const [i, ck] of keys.entries()) {
        if (!ck) continue;
        if (!ch || ch.picked === point.group!.cases[i]!.name || chosen.has(ck)) {
          chosen.add(ck);
          this.decided.delete(ck);
          // the case it renders: expanded when its definition over its props is static markup (one instance per key)
          if (ch?.picked === point.group!.cases[i]!.name) {
            const found: Found = { unrolls: [], decided: [], paints: [], rows: 0 };
            const ok = expandCase(point, ch.picked!, ck, sc, '', found);
            found.decided = found.decided.filter(([k]) => k !== ck);
            pending.set(ck, pending.has(ck) || (!ok && !found.over) ? null : { items: [], d: point.pick!.deps, found, pick: true, el });
          }
          continue;
        }
        this.decided.set(ck, false);
        this.foldReads.set(ck, this.stateSites(point.pick!.deps));
      }
    };
    /** outside rows, in a branch decided at build time: its loops, choices and the branches decided in it, as page markup */
    const pageOf = (nodes: NodeDef[], sc: object) => {
      for (const n of nodes) {
        const el = elOf(n);
        if (!el) continue;
        if (this.pointOf.has(n)) { choose(n, el, sc); continue; }
        for (const b of n.b) {
          const key = this.instKey(el);
          if (!key || b.f === undefined || b.e || !fixed(b.d) || !known(strs(b.d))) continue;
          if (b.k === 'for' && !pending.has(key)) unroll(key, b, run(sc, this.fns[b.f]!), sc, el);
          if (b.k !== 'if' || !this.decided.has(key)) continue;
          const other = b.y !== undefined ? nodes[b.y]?.b.find((x) => x.k === 'else')?.x : undefined;
          const kept = this.decided.get(key) ? this.templates[b.x!] : other !== undefined ? this.templates[other] : undefined;
          if (kept) pageOf(kept.nodes, sc);
        }
      }
    };
    return {
      unroll,
      /** after `prerender()`'s own candidates: the page's choices and decided branches, then every loop found, committed */
      finish: (sc: object) => {
        // (the page's loops are `prerender()`'s candidates; its decided branches hold more)
        for (const n of this.roots) {
          const el = elOf(n);
          if (!el) continue;
          if (this.pointOf.has(n)) { choose(n, el, sc); continue; }
          for (const b of n.b) {
            const key = b.k === 'if' ? this.instKey(el) : null;
            if (!key || !this.decided.has(key)) continue;
            const other = b.y !== undefined ? this.roots[b.y]?.b.find((x) => x.k === 'else')?.x : undefined;
            const kept = this.decided.get(key) ? this.templates[b.x!] : other !== undefined ? this.templates[other] : undefined;
            if (kept) pageOf(kept.nodes, sc);
          }
        }
        for (const [key, p] of pending) {
          if (!p) continue;
          // over the page's limit (this tree alone, or with those before it): left to the browser, with a warning
          if (p.found.over || p.found.rows > left) { this.overLimit.set(key, limit); this.expansionWarning(p.el, limit, !p.pick); continue; }
          left -= p.found.rows;
          if (p.pick) this.decided.set(key, true); else this.unrolls.set(key, p.items);
          this.foldReads.set(key, this.stateSites(p.d));
          for (const [k, items, d] of p.found.unrolls) { this.unrolls.set(k, items); this.foldReads.set(k, this.stateSites(d)); }
          for (const [k, v, d] of p.found.decided) { this.decided.set(k, v); this.foldReads.set(k, this.stateSites(d)); }
          for (const [b, prefix, w] of p.found.paints) {
            let m = this.rowPaint.get(b);
            if (!m) this.rowPaint.set(b, m = new Map());
            m.set(prefix, w);
          }
        }
      },
    };
  }

  /**
   * The first pass, after `dropConstants`: each value attribute whose every binding is a constant for good, by
   * where it was written, with what it writes, when the layout or the images read it: any of an `<img>`'s
   * (`data-sn-text`, `-show`, `-attr`, `-class`, `-style`), so it is a static image, and `data-sn-class` and
   * `-style` anywhere when the page has stylesheets. The rest is written after the walk, as before. Uses that
   * disagree (a component's markup on one line, used twice) leave it. An attribute reported on (`SN513` aside,
   * which a written image no longer has) stays, so the second pass reports it again.
   */
  /**
   * The attributes `collectConstants` may write for the second pass, before the layout and the images read them: an
   * image's own (with `images`), a class some selector names or a style (with a layout). Which they are is the walk's:
   * a page with none collects no constants, whatever its values.
   */
  constantSources(): Array<{ s: Compiler['attrSources'][number]; key: string; layoutFold: boolean }> {
    const els = new Map<NodeDef, P5Element>([...this.paints.map((x) => [x.node, x.el] as const), ...this.tplEls]);
    const sheets = (this.opts.styles ?? this.opts.images?.styles ?? []).map((x) => x.css).join('\n');
    // the selectors of the stylesheets' rules (at-rules' preludes too, which name no class)
    const selectors = [...sheets.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]*)\{/g)].flatMap((m) => m[1]!.split(',').map((x) => x.trim()));
    /** whether some selector names the class (as the stylesheet writes it: `.md\:w-1\/2` for `md:w-1/2`): one none names changes nothing */
    const named = (name: string) => {
      const token = new RegExp(`\\.${name.replace(/[^\w-]/g, (c) => `\\\\?\\${c}`)}(?![\\w-])`);
      return selectors.some((x) => token.test(x));
    };
    const out: ReturnType<Compiler['constantSources']> = [];
    for (const s of this.attrSources) {
      const key = s.bindings.length && !s.noted ? this.constKey(s.src, s.attr) : null;
      const target = els.get(s.node);
      // an image's own attributes: always; a class some selector names, or a style: when the dry run finds that the
      // layout's answers change (`collectConstants`)
      const img = target?.tagName === 'img' && !!this.opts.images;
      const layoutFold = !img && !!this.layout && !!target && (s.attr === 'data-sn-style' || (s.attr === 'data-sn-class' && s.bindings.some((b) => !!b.n && named(b.n))));
      if (key && (img || layoutFold)) out.push({ s, key, layoutFold });
    }
    return out;
  }

  /** `kept`: on a kept template's walk (`decideFor`), which the dry run must not change: the entry is compiled the usual way instead */
  collectConstants(kept = false) {
    /** the keys of constant classes and styles, which the dry run decides */
    const layoutKeys = new Set<string>();
    const put = (key: string, writes: ConstantWrite[], sites: PathRef[]) => {
      const was = this.constants.get(key);
      if (was === null) return;
      if (was !== undefined && JSON.stringify(was) !== JSON.stringify(writes)) { this.constants.set(key, null); return; }
      this.constants.set(key, writes);
      for (const s of this.stateSites(sites)) this.constantSites.add(s);
    };
    for (const { s, key, layoutFold } of this.constantSources()) {
      const before = new Set(this.constants.keys());
      const deps = s.bindings.flatMap((b) => b.d ?? []);
      const rows = s.bindings.map((b) => this.rowPaint.get(b));
      if (rows.every((r) => r !== undefined)) {
        for (const prefix of rows[0]!.keys()) {
          const writes = rows.map((r) => r!.get(prefix));
          if (writes.every((w) => w)) put(prefix + key, writes as ConstantWrite[], deps);
        }
      } else if (s.bindings.every((b) => this.dropped.has(b) && this.paintValue.has(b))) put(key, s.bindings.map((b) => this.paintValue.get(b)!), deps);
      if (layoutFold) for (const k of this.constants.keys()) if (!before.has(k)) layoutKeys.add(k);
    }
    for (const [k, v] of this.constants) if (v === null) this.constants.delete(k);
    const folds = [...layoutKeys].filter((k) => this.constants.has(k));
    if (!folds.length) return;
    // the page is compiled again anyway (an image's attributes, a decided template, an unrolled loop): they go with it
    const clean = !this.diagnostics.some((d) => d.severity === 'error' && d.code !== 'SN322');
    if (this.constants.size > folds.length || this.decided.size || (this.unrolls.size && clean)) return;
    // else only when the dry run finds a difference (no copy: the page has no image or list for them to change)
    if (kept) { this.needsMarkup = true; return; }
    if (this.dry && this.dryRun(new Map(folds.map((k) => [k, this.constants.get(k)!])))) return;
    for (const k of folds) this.constants.delete(k);
  }

  /**
   * The HTML minifier (minify.ts) over the page as expanded. White space only with the page's stylesheets
   * (`styles`, all of them: none from another origin but Google Fonts' `@font-face` rules); markup a
   * component's scoped styles reach is left as written, as the layout does not read them.
   */
  minify(doc: P5Parent) {
    const styles = (typeof this.opts.minify === 'object' ? this.opts.minify.styles : undefined) ?? this.opts.styles;
    let remote = false;
    const scan = (p: P5Parent) => {
      for (const c of p.childNodes) {
        if (!isElement(c)) continue;
        if (c.tagName === 'link' && /(^|\s)stylesheet(\s|$)/i.test(attr(c, 'rel') ?? '') && /^([a-z][a-z\d+.-]*:)?\/\//i.test(attr(c, 'href') ?? '') && !/^(https?:)?\/\/fonts\.googleapis\.com\//i.test(attr(c, 'href') ?? '')) remote = true;
        scan(c.tagName === 'template' ? (c as P5Template).content : c);
      }
    };
    scan(doc);
    const scoped = new Set([...this.componentFiles.values()].filter((f) => f?.css).map((f) => f!.file));
    const layout = styles && !remote ? new Layout(styles, doc, this.layoutOptions()) : null;
    minifyMarkup(doc, {
      layout,
      opaque: (el) => {
        const o = this.origins.get(el);
        if (o && scoped.has(o.file)) return true;
        // a component's root takes its tag's bindings in the walk: a class or style set there is not on it yet
        const host = this.useOf.get(el)?.host;
        return !!host && host.attrs.some((a) => a.name === 'data-sn-class' || a.name === 'data-sn-style' || a.name === 'data-sn-show' || a.name === 'data-sn-attr');
      },
      removed: (el) => el.tagName === 'sn-resource' || el.tagName === 'sn-sync',
    });
  }

  layoutOptions() {
    return { ...(this.opts.normalLineHeight ? { normalLineHeight: this.opts.normalLineHeight } : {}), ...(this.opts.zeroWidth ? { zeroWidth: this.opts.zeroWidth } : {}) };
  }

  /**
   * The first pass, before the layout: a copy of the markup, when a constant class or style could change what the
   * layout feeds (a `data-sn-class` or `-style` on the page, and an image or a list in it), with the styled roots
   * mapped into it (the two trees have one shape).
   */
  snapshot(doc: DefaultTreeAdapterMap['document']) {
    let bound = false, feeds = false;
    const scan = (p: P5Parent) => {
      for (const c of p.childNodes) {
        if (!isElement(c)) continue;
        const host = this.useOf.get(c)?.host;
        if ([c, ...(host ? [host] : [])].some((e) => e.attrs.some((a) => a.name === 'data-sn-class' || a.name === 'data-sn-style'))) bound = true;
        if (c.tagName === 'img' || (c.tagName === 'template' && attr(c, 'data-sn-for') !== undefined)) feeds = true;
        scan(c.tagName === 'template' ? (c as P5Template).content : c);
      }
    };
    scan(doc);
    if (!bound || !feeds) return;
    const copy = this.cloneTree(doc as unknown as P5Node, null as unknown as P5Parent) as unknown as DefaultTreeAdapterMap['document'];
    // each element's twin in the copy: the styled roots, and what a traced `reserve()` read (`planSpace`)
    const styled = this.styledRoots(), mapped = new Set<P5Element>(), twin = new Map<P5Element, P5Element>();
    const pair = (a: P5Parent, b: P5Parent) => a.childNodes.forEach((x, i) => {
      const y = b.childNodes[i]!;
      if (!isElement(x)) return;
      twin.set(x, y as P5Element);
      if (styled.has(x)) mapped.add(y as P5Element);
      pair(x, y as P5Parent);
      if (x.tagName === 'template') pair((x as P5Template).content, (y as P5Template).content);
    });
    pair(doc, copy);
    this.dry = { doc: copy, styled: mapped, imgs: '', space: '', twin, traces: new Map() };
  }

  /**
   * What the layout tells the images in `doc`, in document order (templates included): what `rewriteImages` and
   * `remoteImage` ask, the box and its scaled width, or the rendered width at every viewport width (with the file's
   * own width when it is a local image), whether an `auto-fit` grid was why that failed, and the bound.
   */
  layoutAnswers(doc: P5Parent, layout: Layout): string {
    const out: unknown[] = [];
    const host = this.opts.images, ctx = { root: this.opts.root, fileOf: (el: P5Element) => this.origins.get(el)?.file ?? this.opts.file };
    const visit = (p: P5Parent) => {
      for (const c of p.childNodes) {
        if (!isElement(c)) continue;
        if (c.tagName === 'img') {
          // what the image pipeline and `remoteImage` go on to ask, given the answers before: a fixed box needs only its
          // scaled width; else the width at every viewport width (with the file's own width for a local image), and
          // the bound when that fails
          const box = layout.box(c);
          if (box && box !== 'fluid') { out.push([box, this.scaledWidth(layout, c, 'box')]); continue; }
          const file = host ? sourceFile(c, ctx) : null;
          const fluid = layout.fluidSizes(c, (file && host!.info(file)?.width) || undefined), auto = !!layout.autoFitRows;
          const bound = fluid ? null : layout.maxWidth(c);
          out.push([box, fluid, auto, bound, bound !== null ? this.scaledWidth(layout, c, 'bound') : null]);
        }
        visit(c.tagName === 'template' ? (c as P5Template).content : c);
      }
    };
    visit(doc);
    return JSON.stringify(out);
  }

  /** The reserved space `planSpace` planned, list by list in document order: the placeholder, the content-sized box, the unsized images. */
  spaceAnswers(): string {
    return JSON.stringify([...this.spacePlan.values()].map((p) => [p.space, p.sized && [p.sized.widths, p.sized.siblings, p.sized.ranges], p.unsized.length, p.why, p.form, p.waitForm]));
  }

  /**
   * The dry run (the first pass): the constant classes and styles written into the copy of the markup, and the
   * layout computed again on it, without a walk: whether any image's or list's answer differs from the first
   * pass's. Only then is the page compiled again for them.
   */
  dryRun(consts: Map<string, ConstantWrite[]>): boolean {
    const dry = this.dry!, sheets = this.opts.styles ?? this.opts.images?.styles ?? [];
    this.prefold(dry.doc, consts);
    const layout = new Layout(sheets, dry.doc, this.layoutOptions());
    // `planSpace` writes the plan by template: the first pass's, kept aside
    const plan = new Map(this.spacePlan);
    this.spacePlan.clear();
    try {
      this.planSpace(dry.doc, layout, dry.styled);
      return this.spaceAnswers() !== dry.space || this.layoutAnswers(dry.doc, layout) !== dry.imgs;
    } finally {
      this.spacePlan.clear();
      for (const [k, v] of plan) this.spacePlan.set(k, v);
    }
  }

  /** An attribute where it was written, the same in both passes: its element's file, offset and component uses. */
  constKey(el: P5Element, name: string): string | null {
    const at = this.siteKey(el);
    return at && `${at}|${this.origins.get(el)?.use ?? ''}|${name}`;
  }

  /**
   * The second pass, before the layout and the images: each value attribute the first pass found constant for
   * good is written into the markup and removed, so the layout sees the class and the image pipeline a static
   * `<img>`. A component's tag passes its attributes to its root: written there, and removed from the tag only
   * when every root it gave them to (one per row of an unrolled loop) has them.
   */
  prefold(doc: P5Parent, consts: Map<string, ConstantWrite[]> = this.opts.constants!) {
    const found = new Map<P5Element, Map<string, Array<{ el: P5Element; writes: ConstantWrite[] | undefined }>>>();
    const look = (src: P5Element, el: P5Element, prefix: string) => {
      for (const name of FOLDED) {
        if (attr(src, name) === undefined) continue;
        const key = this.constKey(src, name);
        const writes = key ? (prefix ? consts.get(prefix + key) : undefined) ?? consts.get(key) : undefined;
        let bySrc = found.get(src);
        if (!bySrc) found.set(src, bySrc = new Map());
        let list = bySrc.get(name);
        if (!list) bySrc.set(name, list = []);
        list.push({ el, writes });
      }
    };
    const visit = (parent: P5Parent, prefix: string) => {
      for (const c of parent.childNodes) {
        if (!isElement(c)) continue;
        const row = this.instAt.get(c) ?? this.rowOf.get(c)?.inst ?? prefix;
        look(c, c, row);
        const use = this.useOf.get(c);
        if (use && !use.head && !use.layout) look(use.host, c, row);
        visit(c, row);
        if (c.tagName === 'template') visit((c as P5Template).content, row);
      }
    };
    visit(doc, '');
    for (const [src, names] of found) for (const [name, list] of names) {
      if (!list.every((x) => x.writes)) continue;
      for (const x of list) for (const w of x.writes!) {
        writeFirstPaint(x.el, w.k, w.n, w.v);
        if (w.k === 'attr' && (w.n === 'src' || w.n === 'srcset')) this.foldedUrl.add(x.el);
      }
      src.attrs = src.attrs.filter((a) => a.name !== name);
    }
  }

  /**
   * Where a template or an attribute was written, the same in both passes: its element's file and offset and the
   * uses of the components it is in (`Origin.use`: two uses on one line differ), or null for one the compiler made.
   * Inside an unrolled row, the row's instance path goes before it (`expandConstants`).
   */
  instKey(el: P5Element): string | null {
    const at = this.siteKey(el);
    return at && `${at}|${this.origins.get(el)?.use ?? ''}`;
  }

  /** The key of a candidate of `<sn-component use>`: the element's, and the component it renders. */
  choiceKey(el: P5Element, name: string): string | null {
    const at = this.instKey(el);
    return at && `${at}|use:${name}`;
  }

  /**
   * The second pass, top down: each decided `data-sn-if` template becomes its branch (or the `data-sn-else` after
   * it), or nothing; a candidate of `<sn-component use>` the first pass did not choose goes; each unrolled
   * `data-sn-for` becomes its rows, one copy of its content per item, whose top elements get the item and index
   * as derived names (`rowOf`), so their bindings are constants. Inside a row, keys start with the row's instance
   * path (`<loop>#<k>/`), at every level. Loops are unrolled outside templates only; in a template that stays (a
   * row that renders at run time) only `data-sn-if`s over fixed state are decided, as before.
   */
  expandConstants(parent: P5Parent, prefix: string, inTemplate: boolean) {
    const decided = this.opts.decided, unrolled = this.opts.unrolled;
    const real = (c: P5Node) => isElement(c) || (c.nodeName === '#text' && (c as DefaultTreeAdapterMap['textNode']).value.trim() !== '');
    let changed = false;
    for (let i = 0; i < parent.childNodes.length; i++) {
      const c = parent.childNodes[i]!;
      if (!isElement(c)) continue;
      const row = this.rowOf.get(c);
      const pre = this.instAt.get(c) ?? row?.inst ?? prefix;
      // a node that takes `c`'s place at the top of a row is the top of that row too, and at the top of an
      // instance expanded at build time (a root chain's branch), in that instance
      const at = this.instAt.get(c);
      const place = (nodes: P5Node[], count: number) => {
        for (const n of nodes) {
          (n as { parentNode: P5Parent }).parentNode = parent;
          if (row && isElement(n) && !this.rowOf.has(n)) this.rowOf.set(n, row);
          if (at !== undefined && isElement(n) && !this.instAt.has(n)) this.instAt.set(n, at);
          // a fill that was a chain (`<template slot data-sn-if>`): its kept branch is that fill, and reads its `$slot`
          for (const map of [this.fillOf, this.defaultOf, this.childrenOf]) if (isElement(n) && map.has(c) && !map.has(n)) map.set(n, map.get(c)!);
        }
        this.inheritSlot(c, nodes);
        // a component's root chain, decided: its markup starts at what is left
        const start = this.scopeStart.get(c);
        if (start) for (const n of nodes) if (isElement(n)) this.scopeStart.set(n, outerFirst(start, this.scopeStart.get(n)));
        parent.childNodes.splice(i, count, ...(nodes as never[]));
        changed = true;
        i--;
      };
      const key = c.tagName === 'template' && attr(c, 'data-sn-if') !== undefined ? this.instKey(c) : null;
      const v = key ? decided?.get(pre + key) : undefined;
      if (v !== undefined) {
        const j = parent.childNodes.findIndex((x, k) => k > i && real(x));
        const other = j >= 0 && isElement(parent.childNodes[j]!) && (parent.childNodes[j] as P5Element).tagName === 'template' && attr(parent.childNodes[j] as P5Element, 'data-sn-else') !== undefined ? parent.childNodes[j] as P5Element : null;
        place([...(v ? (c as P5Template).content.childNodes : other ? (other as P5Template).content.childNodes : [])], (other ? j : i) - i + 1);
        continue;
      }
      const choice = this.choices.get(c);
      const ck = choice ? this.choiceKey(c, choice.name) : null;
      // a tree over the expansion limit, which the first pass reported: reported here too, since this pass's warnings are the build's
      const over = this.opts.overLimit?.get(pre + (ck ?? (c.tagName === 'template' && attr(c, 'data-sn-for') !== undefined ? this.instKey(c) ?? '' : '')));
      if (over !== undefined) this.expansionWarning(c, over, !ck);
      if (ck && decided?.get(pre + ck) === false) { place([], 1); continue; }
      // a choice's case, or a recursion point, that the first pass expanded: the component's markup here, as a use,
      // whose own templates are decided and unrolled as the loop goes on over them (item 5)
      const point = this.points.get(c);
      const pk = point && !choice ? this.instKey(c) : null;
      if ((ck && decided?.get(pre + ck) === true) || (pk && unrolled?.has(pre + pk))) {
        const before = parent.childNodes.length, start = this.scopeStart.get(c);
        if (this.inlineInstance(c, point!)) {
          const inst = `${pre}${ck ?? pk}#0/`, nodes = parent.childNodes.slice(i, i + parent.childNodes.length - before + 1);
          this.inheritSlot(c, nodes);
          for (const x of nodes) {
            this.instAt.set(x, inst);
            if (row && isElement(x) && !this.rowOf.has(x)) this.rowOf.set(x, row);
            // the outer components whose markup started at the candidate (a choice as their root) start here
            if (start && isElement(x)) this.scopeStart.set(x, outerFirst(start, this.scopeStart.get(x)));
            // a candidate that was a fill, or among the children a fill's `<slot>` places: so is what it renders
            for (const map of [this.fillOf, this.defaultOf, this.childrenOf]) if (isElement(x) && map.has(c) && !map.has(x)) map.set(x, map.get(c)!);
          }
          changed = true;
          i--;
          continue;
        }
      }
      const value = !inTemplate && c.tagName === 'template' ? attr(c, 'data-sn-for') : undefined;
      const tkey = value !== undefined ? this.instKey(c) : null;
      const items = tkey ? unrolled?.get(pre + tkey) : undefined;
      const m = items !== undefined ? /^\s*(?:\(\s*([A-Za-z_][\w]*)\s*,\s*([A-Za-z_][\w]*)\s*\)|([A-Za-z_][\w]*))\s+in\s+/.exec(value!) : null;
      if (m) {
        const rows: P5Node[] = [];
        for (let k = 0; k < items!.length; k++) {
          const info: RowInfo = { tpl: c, item: (m[1] ?? m[3])!, index: m[2] ?? null, list: value!.slice(m[0].length), offset: m[0].length, k, value: items![k], inst: `${pre}${tkey}#${k}/`, ...(row ? { up: row } : {}) };
          for (const x of (c as P5Template).content.childNodes) {
            const copy = this.cloneTree(x, parent);
            if (isElement(copy)) this.rowOf.set(copy, info);
            rows.push(copy);
          }
        }
        // (the rows' own templates are decided and unrolled as the loop goes on over them)
        place(rows, 1);
        continue;
      }
      this.expandConstants(c, pre, inTemplate);
      if (c.tagName === 'template') this.expandConstants((c as P5Template).content, pre, true);
    }
    if (changed) mergeText(parent);
  }

  /**
   * The second pass: a recursion point or a choice's case that the first pass found constant, expanded as a use of
   * its component where it is (instead of an instance of its shared definition): its markup's uses keyed as the
   * definition's (`Origin.use`), so the first pass's decisions inside it apply.
   */
  inlineInstance(host: P5Element, name: string): boolean {
    const at = this.pointCtx.get(host), def = this.componentFile(name);
    if (!at || !def || def.bad || def.head) return false;
    if (this.choices.has(host)) {
      host.tagName = host.nodeName = name;
      host.attrs = host.attrs.filter((a) => a.name !== 'use');
      // the plain attributes of the tags whose root the choice is: onto the tag, which moves them to the root
      for (const u of this.passOn.get(host) ?? []) for (const a of u.host.attrs) {
        if (a.name.startsWith('data-sn-') || a.name === 'slot') continue;
        if (a.name === 'class') setAttr(host, 'class', `${attr(host, 'class') ?? ''} ${a.value}`.trim());
        else if (attr(host, a.name) === undefined) host.attrs.push({ ...a });
      }
    }
    this.points.delete(host);
    this.choices.delete(host);
    this.enclosing.set(host, at.en);
    const root = this.expandUse(host, def, at.ch);
    if (!root) return false;
    // the component's own markup, keyed as in its definition, whose host is synthetic: one origin for all of it
    // (a slot root's default and the children a fill places too), not a fill that took the root's place, which
    // is its caller's markup and keyed as written
    const use = this.hostUse.get(host);
    const o = this.origins.get(use?.template ?? root);
    if (o && o.file === def.file) o.use = '<';
    if (use?.shape) this.expandComponents({ childNodes: root.parentNode!.childNodes.filter((c) => this.scopeStart.get(c)?.includes(use)) } as unknown as P5Parent, [name], false, use);
    else this.expandComponents(root, [name], false, use ?? null);
    return true;
  }

  /**
   * Nodes that take the place of `from` (a decided `data-sn-if`'s branch, an unrolled loop's rows): when
   * `from` was slot content, so are they, in the scope of the caller that wrote them and outside the
   * component's scoped styles.
   */
  inheritSlot(from: P5Element, nodes: P5Node[]) {
    const use = this.slotOf.get(from);
    if (!use) return;
    const w = this.writtenIn.get(from);
    if (w) for (const n of nodes) if (!this.writtenIn.has(n)) this.writtenIn.set(n, w);
    const el = this.slotEls.find((x) => x.el === from);
    for (const n of nodes) {
      // a fill of a component written in this slot content: its own slot's, and written in this one (`writtenIn`)
      if (this.slotOf.has(n)) { if (this.slotOf.get(n) !== use && !this.writtenIn.has(n)) this.writtenIn.set(n, use); continue; }
      this.slotOf.set(n, use);
      if (el && isElement(n)) this.slotEls.push({ ...el, el: n });
    }
  }

  /** A copy of markup that compiles as the original: its source locations, origins, slot content and component uses. */
  cloneTree(node: P5Node, parent: P5Parent, chains = new Map<FillChain, FillChain>()): P5Node {
    const copy = { ...node, parentNode: parent } as P5Node;
    // (a candidate of `<sn-component use>` in an unrolled row: still one)
    for (const map of [this.origins, this.slotOf, this.useOf, this.forwarded, this.points, this.choices, this.scopeStart, this.landing, this.passOn, this.pointCtx] as Array<WeakMap<object, unknown>>) if (map.has(node)) map.set(copy, map.get(node));
    if (this.defRoots.has(node as P5Element)) this.defRoots.set(copy as P5Element, { rt: this.defRoots.get(node as P5Element)!.rt });
    if (this.repeatedFills.has(node)) this.repeatedFills.add(copy);
    const empty = this.emptyDefaults.get(node);
    if (empty) this.emptyDefaults.set(copy, empty.map((c) => { if (!chains.has(c)) chains.set(c, [...c]); return chains.get(c)!; }));
    // a fill copied with it renders in its own place: its own chain, so its `$slot` is compiled there
    for (const map of [this.fillOf, this.defaultOf, this.childrenOf]) {
      const c = map.get(node);
      if (!c) continue;
      if (!chains.has(c)) { const copy = [...c]; chains.set(c, copy); this.chainCopyOf.set(copy, c); }
      map.set(copy, chains.get(c)!);
    }
    if (!('childNodes' in node)) return copy;
    const el = copy as P5Element;
    if ('attrs' in node) el.attrs = (node as P5Element).attrs.map((a) => ({ ...a }));
    el.childNodes = (node as P5Element).childNodes.map((x) => this.cloneTree(x, el, chains)) as never[];
    if ((node as P5Element).nodeName === 'template') {
      const content = { ...(node as P5Template).content } as P5Template['content'];
      content.childNodes = (node as P5Template).content.childNodes.map((x) => this.cloneTree(x, content, chains)) as never[];
      const empty = this.emptyDefaults.get((node as P5Template).content);
      if (empty) this.emptyDefaults.set(content, empty.map((c) => { if (!chains.has(c)) chains.set(c, [...c]); return chains.get(c)!; }));
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
   * Anchors as comments (docs/proposals/component-libraries.md, section 1). Each `if`, `for`, choice and
   * recursion point's `<template>` becomes a pair of comments in place, `<!--sn 4-->` and `<!--/sn-->` (in
   * a row, `<!--sn-->`: it is found by its path), and its content a head template `<template id="sn-t-<id>">`
   * (a shared definition's is already one). An `if`'s `data-sn-else` becomes its `z`, and the else's node
   * goes. Then each template's markup is normalized as the browser will parse it, and the paths in rows
   * are counted again from it: an anchor is its start comment.
   */
  anchors() {
    const ad = parse5.defaultTreeAdapter;
    const listOf = new Map<NodeDef, NodeDef[]>();
    for (const l of [this.roots, ...this.templates.map((t) => t.nodes)]) for (const n of l) listOf.set(n, l);
    const gone = new Set<NodeDef>();
    const head = (tid: number, el: P5Template) => {
      if (this.headTemplates.has(tid)) return;
      const tpl = ad.createElement('template', parse5.html.NS.HTML, [{ name: 'id', value: `sn-t-${tid}` }]) as P5Template;
      const frag = el.content ?? ad.createDocumentFragment(), ns = el.namespaceURI;
      // foreign content: a template's content is parsed as HTML, so a row inside `<svg>` is written inside an `<svg>`
      // and made of that element's children (`w`)
      if (ns === parse5.html.NS.SVG || ns === parse5.html.NS.MATHML) {
        const wrap = ad.createElement(ns === parse5.html.NS.SVG ? 'svg' : 'math', ns, []);
        wrap.childNodes = frag.childNodes;
        for (const c of wrap.childNodes) c.parentNode = wrap;
        frag.childNodes = [wrap as never];
        wrap.parentNode = frag as never;
        this.templates[tid]!.w = 1;
      }
      tpl.content = frag;
      this.headTemplates.set(tid, tpl);
    };
    for (const [node, el] of this.anchorEls) {
      const b = node.b.find((x) => x.k === 'for' || x.k === 'if' || x.k === 'ch');
      // an else goes with its if; an element that is gone (an error) needs nothing
      if (!b || !el.parentNode) continue;
      if (b.k !== 'ch') head(b.x!, el as P5Template);
      if (b.k === 'if' && b.y !== undefined) {
        const en = listOf.get(node)![b.y]!, ee = this.anchorEls.get(en), eb = en.b.find((x) => x.k === 'else');
        if (ee && eb) { head(eb.x!, ee as P5Template); b.z = eb.x!; detach(ee); gone.add(en); }
        delete b.y;
      }
      const parent = el.parentNode as P5Parent, at = parent.childNodes.indexOf(el as never);
      const start = ad.createCommentNode(node.id !== undefined ? `sn ${node.id}` : 'sn'), end = ad.createCommentNode('/sn');
      start.parentNode = end.parentNode = parent as never;
      parent.childNodes.splice(at, 1, start as never, end as never);
      node.tag = '#';
      this.anchorStart.set(node, start);
    }
    if (gone.size) this.dropNodes(gone);
    // as the browser parses the markup: adjacent text is one node, empty text none
    const norm = (p: P5Parent) => {
      const out: P5Node[] = [];
      for (const c of p.childNodes as P5Node[]) {
        if (c.nodeName === '#text') {
          const t = c as DefaultTreeAdapterMap['textNode'];
          if (!t.value) continue;
          const last = out[out.length - 1];
          if (last?.nodeName === '#text') { (last as DefaultTreeAdapterMap['textNode']).value += t.value; continue; }
        }
        out.push(c);
        if (isElement(c)) norm(c.tagName === 'template' && (c as P5Template).content ? (c as P5Template).content : c);
      }
      p.childNodes = out as never;
    };
    for (const tpl of this.headTemplates.values()) norm(tpl.content);
    for (const t of this.templates) {
      const tpl = this.headTemplates.get(t.id);
      if (!tpl) continue;
      const root: P5Parent = t.w ? (tpl.content.childNodes[0] as P5Element) : tpl.content;
      for (const nd of t.nodes) {
        const target = (this.anchorStart.get(nd) ?? this.tplEls.get(nd) ?? this.textAt.get(nd)) as P5Node | undefined;
        if (!target) continue;
        const path: number[] = [];
        for (let n = target as { parentNode: P5Parent | null }; n.parentNode && n !== (root as unknown); n = n.parentNode as unknown as { parentNode: P5Parent | null }) path.unshift(n.parentNode.childNodes.indexOf(n as never));
        nd.path = path;
      }
      // a wrapper: its content is one `if` or choice anchor and nothing else (a row whose only content is a branch, a
      // branch whose only content is a choice). The runtime renders it without nodes of its own: no clone, no comments,
      // its anchor's branch stands for it (docs/proposals/flat-anchors.md)
      const [nd] = t.nodes, b = nd?.b[0];
      if (!t.w && t.nodes.length === 1 && nd!.b.length === 1 && (b!.k === 'if' || b!.k === 'ch') && nd!.state === undefined && !nd!.dl && !b!.e
        && root.childNodes.length === 2 && this.anchorStart.get(nd!) === root.childNodes[0]) t.a = 1;
      // a text run: its content is one `<template data-sn-text>` and nothing else (its mark and its place, two empty
      // comments). The runtime renders it as a text node, bound itself: no clone, no comments
      if (!t.w && t.nodes.length === 1 && nd!.tag === '#' && nd!.b.length === 1 && b!.k === 'text' && b!.n === '+' && nd!.state === undefined && !nd!.dl
        && root.childNodes.length === 2 && this.textAt.get(nd!) === root.childNodes[0] && root.childNodes[1]!.nodeName === '#comment') t.tx = 1;
    }
  }

  /** Nodes out of their lists (`roots`, a template's), the indexes after them renumbered: `p`, and the roots' resource and stream scopes. */
  dropNodes(gone: Set<NodeDef>) {
    const lists = [this.roots, ...this.templates.map((t) => t.nodes)];
    for (const list of lists) {
      if (!list.some((n) => gone.has(n))) continue;
      const at = new Map<number, number>();
      list.forEach((n, i) => { if (!gone.has(n)) at.set(i, at.size); });
      const re = (i: number | undefined) => (i === undefined || i < 0 ? i : at.get(i) ?? -1);
      const kept = list.filter((n) => !gone.has(n));
      for (const n of kept) if (n.p !== undefined) n.p = re(n.p);
      if (list === this.roots) {
        for (const r of this.resources) if (r.scope !== undefined) r.scope = re(r.scope);
        for (const x of this.syncs) if (x.scope !== undefined) x.scope = re(x.scope);
      }
      list.splice(0, list.length, ...kept);
    }
  }

  /**
   * Where each head template goes: those the early file renders last in the `<head>` (after what the browser
   * fetches and the embedded data: the Vite plugin moves them after the tags it adds, `headTemplatesLast`),
   * the rest at the end of the `<body>`, where nothing waits for them. In id order.
   */
  placeTemplates(doc: P5Parent, early: EarlyParts | null | undefined) {
    if (!this.headTemplates.size) return;
    const used = new Set<number>();
    early?.ir.templates.forEach((t, i) => { if (t) used.add(i); });
    const head = this.head ?? findHead(doc), body = findBody(doc);
    for (const [tid, tpl] of [...this.headTemplates].sort(([a], [b]) => a - b)) {
      // a wrapper or a text run is never cloned by the page module (docs/proposals/flat-anchors.md): its template is
      // in the page only for the early file, which renders it as written
      const t = this.templates[tid];
      if ((t?.a || t?.tx) && !used.has(tid)) continue;
      const into = used.has(tid) || !body ? head : body;
      if (!into) continue;
      tpl.parentNode = into as never;
      into.childNodes.push(tpl as never);
    }
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
      // a `file:` resource's value and status never change; a helper that folded read no `$locale`
      if (this.fileConstant(d) || (d === '$locale' && this.opts.helperFold)) return true;
      const m = /^\$s(\d+)\.([^.]+)/.exec(d);
      return !!m && m[2] !== '*' && m[2] !== '**' && !written.has(`$s${m[1]}`) && !written.has(`$s${m[1]}.${m[2]}`);
    };
    const drop = (b: Binding) => this.painted.has(b) && !b.w?.length && b.k !== 'model' && strs(b.d).every(fixed);
    const gone = new Set<NodeDef>();
    for (const node of this.textFolded) {
      if (!node.b.every(drop)) continue;
      for (const b of node.b) { if (b.f !== undefined) this.fnUses[b.f]!--; this.freeze(b.d); this.dropped.add(b); }
      node.b = [];
      gone.add(node);
    }
    for (const { el, node } of this.paints) {
      // a kept element's bindings stay, constants too: the next page passes it other values (swaps, §3)
      if (this.inKept(el)) continue;
      const keep = node.b.filter((b) => !drop(b));
      if (keep.length === node.b.length) continue;
      for (const b of node.b) if (drop(b)) { if (b.f !== undefined) this.fnUses[b.f]!--; this.freeze(b.d); this.dropped.add(b); }
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
        for (const b of node.b) if (this.tplPainted.has(b)) { if (b.f !== undefined) this.fnUses[b.f]!--; this.freeze(b.d); this.dropped.add(b); }
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
    // which functions read each state object whole (`$s0`, not followed by `.`) or a field of it (`$s0.k`):
    // one scan of the functions, instead of a regular expression per field over every function
    const readers = stateReaders(this.fns);
    const byOther = (key: string, own: string) => { const r = readers.get(key); return !!r && (r.size > 1 || !r.has(own)); };
    const inits = new Map(this.stateInits.map((x) => [x.sid, x] as const).reverse());
    const emptied = new Set<NodeDef>();
    for (const n of nodes) {
      if (n.sid === undefined || n.state === undefined) continue;
      const st = inits.get(n.sid);
      if (!st || st.persist) continue;
      const sid = n.sid, own = this.fns[n.state]!;
      // the whole object read (`$s0[k]`, passed on): every field stays
      if (byOther(`$s${sid}`, own)) continue;
      const unread = (k: string) => !written.has(`$s${sid}.${k}`) && !byOther(`$s${sid}.${k}`, own);
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
    const BUILTIN = /(?<![\w$.])(date|relative|number|bytes)\(/g;
    // for requests: no formatter (their URLs and `when`s stay as before)
    const builtin = (code: string) => [...code.matchAll(BUILTIN)].some((m) => !userHelpers.has(m[1]!));
    // for bindings and state fields: the formatters the early file carries (EARLY_FORMATTERS) give the text the page module
    // writes at mount (the same functions over the same locale); `relative` reads the clock, which the early file has not
    const late = (code: string) => [...code.matchAll(BUILTIN)].some((m) => !userHelpers.has(m[1]!) && !EARLY_FORMATTERS.includes(m[1]!));
    // state fields known before data, by scope
    const fields = new Map<number, Map<string, string>>();
    // a resource with embedded data: its data is in the page, so bindings over it render early (rows too)
    const embedded = new Map(this.resources.filter((r) => r.data != null).map((r) => [r.name, r]));
    const usedEmb = new Set<string>();
    let readsUrl = false;
    // resources whose state at mount the early file knows: no data yet, and loading if their `when` holds (`$meta.<name>.loading`,
    // `.error` and `.loadedAt`): not embedded, `each` or `call`, and a `when` the early file can evaluate. With `cache`, only in a tab
    // that has cached nothing (the early file checks): cached rows would be there at mount
    const pre = this.predictable();
    const known = (deps: string[], status = true) => deps.every((d) => {
      if (d === '$locale') return true;
      // the URL: the browser knows it as the head is parsed
      if (d === '$url' || d.startsWith('$url.')) return (readsUrl = true);
      // with embedded or predictable data, any resource: one the early file cannot tell throws when it is read, which leaves
      // that binding to the page module (`($url.feed ? feed : articles)`)
      const r = /^\$r\.([^.]+)/.exec(d);
      if (r) { if (!embedded.size && !(status && pre.size)) return false; if (embedded.has(r[1]!)) usedEmb.add(r[1]!); return true; }
      // a status field, or the whole status (a `data-sn-let` of it); another resource's throws early
      const mt = /^\$meta\.([^.]+)(?:\.([^.]+))?$/.exec(d);
      if (mt) {
        if (!status || !pre.size) return false;
        // a field the early file knows, or the whole status (its pager and stream fields throw early)
        return mt[2] === undefined || ['loading', 'error', 'loadedAt'].includes(mt[2]);
      }
      const m = /^\$s(\d+)(?:\.([^.]+))?/.exec(d);
      const f = m ? fields.get(Number(m[1])) : undefined;
      if (!m || !f) return false;
      const st = this.stateInits.find((x) => x.sid === Number(m[1]))!;
      return m[2] !== undefined ? f.has(m[2]) : f.size === st.fields.length;
    });
    for (const st of [...this.stateInits].sort((a, b) => a.sid - b.sid)) {
      const f = new Map<string, string>();
      for (const x of st.fields) {
        // (a field over a resource's status is not: one that throws early takes its state's other fields with it)
        if (known(x.deps, false) && !late(x.code) && x.code.startsWith('($) => (')) f.set(x.key, x.code.slice('($) => ('.length, -1));
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
    /**
     * A binding over the resources the early file knows, with their state at mount written in: `[]` (null for one object)
     * for the data, `{ loading, error: null, loadedAt: null }` for the status, loading when the `when` holds. A resource
     * with `cache` checks first that this tab has cached nothing (else it throws, and the page module renders the binding).
     */
    const status = (code: string): string => {
      let ast: acorn.Node;
      try { ast = parseExpression(code); } catch { return code; }
      const edits: Array<[number, number, string]> = [];
      const checks = new Set<number>();
      const name = (m: any): string | null => (m.computed ? (m.property.type === 'Literal' && typeof m.property.value === 'string' ? m.property.value : null) : m.property.name);
      // `$.$meta.<name>` or `$.$r.<name>`, with `$` the function's parameter
      const at = (m: any, kind: string) => m?.type === 'MemberExpression' && m.object.type === 'MemberExpression' && !m.object.computed && m.object.object.type === 'Identifier'
        && m.object.object.name === '$' && m.object.property.name === kind ? name(m) : null;
      const visit = (n: any, parent: any) => {
        if (!n || typeof n.type !== 'string') return;
        const r = at(n, '$r'), mt = at(n, '$meta'), def = pre.get((r ?? mt)!);
        if (def && (r !== null || mt !== null)) {
          // cached or prefetched rows would be there at mount: this resource's entries (its URL's literal start, its items
          // and total paths, as the cache and next-page data key them), checked once per binding (below). An entry without
          // data (no rows, a null object: a signed-out visitor's `{user: null}`) fills the resource with what is written in
          // here, and `loadedAt` stays null at mount, so it changes nothing: the binding stays early (otherwise a branch over
          // it renders at mount, after the first paint, in every tab that opened another page first)
          if (def.cache != null || (this.opts.prefetch && !def.paginate && def.body == null)) {
            const start = JSON.stringify(typeof def.src[0] === 'string' ? def.src[0] : '').slice(1, -1), end = `,${JSON.stringify(def.items ?? null)},${JSON.stringify(def.total ?? null)}]`;
            const none = JSON.stringify(def.key ? '[]' : 'null');
            checks.add(fn(`() => { for (const k of Object.keys(sessionStorage)) if (/^sn:[cp]:\\[/.test(k) && k.includes(${JSON.stringify(start)}) && k.endsWith(${JSON.stringify(end)})) { let e; try { e = JSON.parse(sessionStorage.getItem(k)); } catch { throw 0; } if (!e || JSON.stringify(e.items) !== ${none} || e.total != null) throw 0; } }`));
          }
          // its API's token, when the operation needs it: with none stored the resource is loaded, empty, at mount (signed
          // out, `$meta.user.loadedAt && !user`), and not loading; the early file reads the storage the request layer reads
          const t = this.needsToken.has(def.name) ? this.settingsOf(def.name)?.t : undefined;
          const out = t ? `$so(${JSON.stringify(t.s)}, ${JSON.stringify(t.k)})` : null;
          const when = (def.when != null ? `!!f[${fn(this.fns[def.when]!)}]($)` : 'true') + (out ? ` && !${out}` : '');
          if (r !== null) { edits.push([n.start, n.end, def.key ? '[]' : 'null']); return; }
          const field = parent?.type === 'MemberExpression' && parent.object === n && !parent.computed ? parent.property.name : null;
          if (field === 'loading') { edits.push([parent.start, parent.end, `(${when})`]); return; }
          if (field === 'loadedAt' && out) { edits.push([parent.start, parent.end, `(${out} ? new Date() : null)`]); return; }
          if (field === 'error' || field === 'loadedAt') { edits.push([parent.start, parent.end, 'null']); return; }
          // the whole status (a `data-sn-let`, a helper): every field as it is at mount; a pager's or a stream's fields are not known
          // before then, and throw (the page module renders what reads them)
          const open = def.paginate || this.page.fed.has(def.name);
          const at = out ? `${out} ? new Date() : null` : 'null';
          const make = fn(open
            ? `(l) => ({ loading: l, error: null, loadedAt: ${at}, get total() { throw 0; }, get live() { throw 0; }, get page() { throw 0; }, get pages() { throw 0; }, get from() { throw 0; }, get to() { throw 0; }, get hasPrev() { throw 0; }, get hasNext() { throw 0; } })`
            : `(l) => ({ loading: l, error: null, loadedAt: ${at}, total: null, live: null })`);
          edits.push([n.start, n.end, `f[${make}](${when})`]);
          return;
        }
        for (const k of Object.keys(n)) {
          if (k === 'start' || k === 'end' || k === 'type') continue;
          const v = n[k];
          if (Array.isArray(v)) for (const c of v) visit(c, n);
          else if (v && typeof v === 'object') visit(v, n);
        }
      };
      visit(ast, null);
      if (!edits.length) return code;
      let out = code;
      for (const [a, b, t] of edits.sort((x, y) => y[0] - x[0])) out = out.slice(0, a) + t + out.slice(b);
      // a tab that has cached or prefetched rows of these: the binding throws, and the page module renders it
      return checks.size ? `($) => (${[...checks].map((i) => `f[${i}](), `).join('')}(${out})($))` : out;
    };
    const templates: EarlyIR['templates'] = this.templates.map(() => null);
    // a binding over a resource without data is early only when it reads a status the early file knows (a loading branch):
    // anything else of it reads data that is not there yet
    // (with embedded data on the page, as before: a binding may name another resource, which throws only if it is read,
    // `$url.feed ? feed : articles`)
    const statusOnly = (deps: string[]) => embedded.size > 0 || !deps.some((d) => { const r = /^\$r\.([^.]+)/.exec(d); return r && !embedded.has(r[1]!); })
      || deps.some((d) => { const m = /^\$meta\.([^.]+)/.exec(d); return !!m && pre.has(m[1]!); });
    const eligible = (b: Binding) => ['text', 'attr', 'class', 'style', 'show', 'model', 'if', ...(embedded.size ? ['for', 'ch'] : [])].includes(b.k) && !b.e && b.f !== undefined && statusOnly(strs(b.d)) && known(strs(b.d)) && !late(this.fns[b.f]!) && !this.painted.has(b)
      // a let that waits for a lazy helper module is not early
      && !this.fns[b.f]!.includes('$.$z(');
    /**
     * A `data-sn-if` (without a `data-sn-else`) that the resources' state at mount closes, whether or not they load
     * (no data, not loading or loading): what the HTML shows already, so nothing to render early. One that reads
     * anything else (state, the URL) is evaluated as before.
     */
    const closedAtMount = (b: Binding) => {
      if (b.k !== 'if' || b.z !== undefined) return false;
      const names = [...new Set(strs(b.d).map((d) => /^\$(?:r|meta)\.([^.]+)/.exec(d)?.[1]).filter((n): n is string => !!n))];
      // any resource without embedded data: whether it loads at mount does not matter (both are tried), and one with cached
      // rows is the page module's either way
      const defs = names.map((n) => this.resources.find((r) => r.name === n));
      // (one that needs a token may be loaded at mount: signed out)
      if (!names.length || defs.some((d) => !d || embedded.has(d.name) || d.each || d.call || this.needsToken.has(d.name))) return false;
      const data = Object.fromEntries(defs.map((d) => [d!.name, d!.key ? [] : null]));
      const code = this.fns[b.f!]!;
      return shows(code, names, { loading: true }, [], data) === false && shows(code, names, { loading: false }, [], data) === false;
    };
    const list = (defs: NodeDef[]): NodeDef[] => {
      // a dialog's bindings wait until it opens (as in the runtime): nothing of a closed dialog is painted
      const bs = defs.map((nd) => (nd.dl || this.lateNodes.has(nd) ? [] : nd.b.filter(eligible).filter((b) => !closedAtMount(b))));
      const keep = new Map<number, number>();
      defs.forEach((nd, i) => { if (nd.state !== undefined || bs[i]!.length) keep.set(i, keep.size); });
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
          const nb: Binding = { k: b.k, f: fn(status(this.fns[b.f!]!)) };
          if (b.n !== undefined) nb.n = b.n;
          if (b.k === 'model') { nb.a = fn(this.fns[b.a!]!); if (b.p !== undefined) nb.p = b.p; }
          if (b.k === 'if') { nb.x = tpl(b.x!); if (b.z !== undefined) nb.z = tpl(b.z); }
          if (b.k === 'for') nb.x = tpl(b.x!);
          if (b.k === 'ch') nb.c = b.c!.map(tpl);
          o.b.push(nb);
        }
        out[j] = o;
      }
      return out;
    };
    const tpl = (x: number) => {
      if (!templates[x]) {
        const t = this.templates[x]!;
        templates[x] = { nodes: [], ...(t.item ? { item: t.item, index: t.index ?? null } : {}), ...(t.w ? { w: 1 as const } : {}) };
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
      // a URL the HTML preloads (see injectScript) leaves earlier than this file runs
      if (this.preloaded(def) || this.late(def.name)) continue;
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
    // the built-in formatters the early functions call, and only those: the page's early file bundles each
    const formatters = EARLY_FORMATTERS.filter((n) => !userHelpers.has(n) && calls(n));
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
    return { ir, fns, helpers, namespaces, ...(formatters.length ? { formatters } : {}) };
  }

  /**
   * The resources whose state when the page module mounts the early file can tell: no data, loading
   * if their `when` holds. Not embedded, `each` or `call`; a `when` only over what the early file
   * knows (`$url`, `$now`, `$locale`, helpers but the built-in formatters; not state),
   * in a scope the early file has.
   */
  predictable(): Map<string, ResourceDef> {
    const out = new Map<string, ResourceDef>();
    const userHelpers = new Set(this.opts.helpers.names);
    const builtin = (code: string) => [...code.matchAll(/(?<![\w$.])(date|relative|number|bytes)\(/g)].some((m) => !userHelpers.has(m[1]!));
    for (const def of this.resources) {
      if (def.call || def.each || def.data != null || this.embedded.has(def.name)) continue;
      // its URL and its `when` (and the page it starts at) over what the early file knows: then its load starts at mount
      // exactly when the `when` holds. Not state (its fields at mount may differ from their first values), nor another
      // resource (its data is not there at mount: the load waits for it)
      const codes = [...def.src.filter((x): x is number => typeof x === 'number'), ...(def.when != null ? [def.when] : []), ...(def.paginate?.start != null ? [def.paginate.start] : [])].map((i) => this.fns[i]!);
      if (codes.some((c) => builtin(c) || /\$(r|meta|el)\b/.test(c))) continue;
      if (!strs(def.deps).every((d) => d === '$now' || d === '$locale' || d === '$url' || d.startsWith('$url.'))) continue;
      out.set(def.name, def);
    }
    return out;
  }

  /**
   * The resources another page can request for this one before it is opened: a `src` and `when`
   * that read only `$url`, constants and the app's helpers (no state, resources, clock, formatters
   * or messages); not paginated, `each`, `call` or embedded data.
   */
  prefetchParts(): PrefetchParts | null {
    const userHelpers = new Set(this.opts.helpers.names);
    const BUILTIN = /(?<![\w$.])(date|relative|number|bytes)\(/g;
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
   * The lists outside templates (and dialogs): each one's placeholder for the rows its resource brings
   * after the first paint (`Layout.reserve`: a paginated resource's `size` rows, or
   * `data-sn-reserve="n"`), and the box around it whose width follows its content
   * (`Layout.contentSized`). Read before the walk, which removes the bindings the cascade looks at.
   */
  /** the roots a component's own `<style>` reaches from (its root, slot content it passes on), which the layout does not read */
  styledRoots(): Set<P5Element> {
    const styled = new Set(this.componentFiles.size ? [...this.uses].filter(([n]) => this.componentFiles.get(n)?.css).flatMap(([, us]) => us.map((u) => u.root)) : []);
    for (const x of this.slotEls) if (this.componentFiles.get(x.caller)?.css) styled.add(x.el);
    return styled;
  }

  planSpace(doc: DefaultTreeAdapterMap['document'], layout: Layout, styledIn?: Set<P5Element>) {
    const resources = new Map<string, P5Element>(), lists: P5Element[] = [];
    const walk = (p: P5Parent, dialog: boolean) => {
      for (const c of p.childNodes) {
        if (!isElement(c)) continue;
        if (c.tagName === 'sn-resource' && attr(c, 'name')) resources.set(attr(c, 'name')!, c);
        if (c.tagName === 'template') {
          if (attr(c, 'data-sn-for') !== undefined && !dialog) lists.push(c);
          continue;
        }
        walk(c, dialog || c.tagName === 'dialog');
      }
    };
    walk(doc, false);
    const words = (t: string) => new Set(t.match(/[A-Za-z_$][\w$]*/g) ?? []);
    // the roots a component's own `<style>` reaches from (its root, slot content it passes on): the layout reads the page's
    // stylesheets, not these
    const styled = styledIn ?? this.styledRoots();
    const inStyled = (tpl: P5Element) => {
      for (let up = tpl.parentNode as P5Element | null; up && 'attrs' in up; up = up.parentNode as P5Element | null) if (styled.has(up)) return true;
      const down = (p: P5Parent): boolean => p.childNodes.some((c) => isElement(c) && (styled.has(c) || down(c.tagName === 'template' ? (c as P5Template).content : c)));
      return down((tpl as P5Template).content);
    };
    for (const tpl of lists) {
      const sized = layout.contentSized(tpl);
      const m = /^\s*(?:\(\s*[A-Za-z_]\w*\s*,\s*[A-Za-z_]\w*\s*\)|[A-Za-z_]\w*)\s+in\s+([\s\S]+)$/.exec(attr(tpl, 'data-sn-for')!);
      let space: Reserved | null = null, names: string[] = [], form: 'static' | 'if' = 'static', why: string | null = null;
      // what follows a content-sized box waits for the list (`waitFor`): needs no row count, only which resources it can be
      let cands: string[] = [], waitForm: 'static' | 'if' = 'if';
      // read here: the walk removes the box's directives before it reaches the list
      const waitOff = sized ? attr(sized.el, 'data-sn-wait')?.trim() === 'off' : false;
      // planned in dev too (no placeholders there): what SN529 says follows the same plan as a build
      if (m) {
        const list = m[1]!.trim();
        // the resources the list can be: named in its expression, or in a `data-sn-let` around it that the expression reads
        // each `data-sn-let` entry around the list, innermost first, that the list's expression names
        // (and, for the resources, the entries those name in turn)
        const around: Array<{ k: string; v: string }> = [];
        for (let up = tpl.parentNode as P5Element | null; up && 'attrs' in up; up = up.parentNode as P5Element | null) {
          const l = attr(up, 'data-sn-let')?.trim().replace(/^\{|\}$/g, '');
          if (l) for (const [, k, v] of l.matchAll(/([A-Za-z_$][\w$]*)\s*:\s*([^,]*(?:\([^)]*\)[^,]*)*)/g)) around.push({ k: k!, v: v! });
        }
        const used = words(list);
        for (const { k, v } of around) if (used.has(k)) for (const w of words(v)) used.add(w);
        names = [...used].filter((n) => resources.has(n));
        cands = names.slice();
        // worth a note when it does not work out: a list over a paginated resource
        if (names.some((n) => attr(resources.get(n)!, 'paginate') !== undefined)) why = '';
        if (names.length && !names.every((n) => attr(resources.get(n)!, 'paginate') !== undefined)) { names = []; why &&= ''; if (why === '') why = 'it can be a resource without `paginate`, whose rows the build cannot count'; }
        // only a choice between resources (`$url.feed ? feed : articles`, `a ?? b`): no call, member or index (a filter, a
        // field), whose rows the build could not count
        const chooses = (t: string) => {
          const bare = t.replace(/'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|`[^`$]*`/g, '0').replace(/\$url\.[A-Za-z_$][\w$]*/g, '0');
          return !/[.[\]{}]|[\w$)\]]\s*\(|=>/.test(bare);
        };
        const lets = around.filter(({ k }) => words(list).has(k)).map(({ v }) => v);
        if (![list, ...lets].every(chooses)) cands = [];
        if (cands.some((c) => ['for', 'call'].some((x) => attr(resources.get(c)!, x) !== undefined))) cands = [];
        waitForm = cands.length === 1 && list === cands[0] && attr(resources.get(cands[0])!, 'when') === undefined ? 'static' : 'if';
        if (![list, ...lets].every(chooses)) { if (why === '') why = 'the list is not a resource or a choice between resources (a filter, a field), whose rows the build could count'; names = []; }
        const rs = names.map((n) => resources.get(n)!);
        // paginated (their size, the least), loading by URL or always: not `each` or `call`, nor data the page has (embedded)
        const ok = rs.length && rs.every((r) => attr(r, 'paginate') !== undefined && !['for', 'call'].some((x) => attr(r, x) !== undefined));
        if (rs.length && !ok && why === '') why = 'a resource with `for` or `call`';
        // the list is a resource that always loads: the placeholder is page markup; else it shows by its resources' status,
        // which the early file decides (`if`)
        form = names.length === 1 && list === names[0] && attr(rs[0]!, 'when') === undefined ? 'static' : 'if';
        const n = ok ? Math.min(...rs.map((r) => this.pageSpec(r)?.size ?? NaN)) : NaN;
        // in a box whose width follows its content, only rows of a width of their own (the placeholder takes it)
        if (Number.isInteger(n) && n > 0 && styled.size && inStyled(tpl)) { if (why === '') why = 'a component\'s own `<style>` styles the rows or their container, and the build reads only the page\'s stylesheets'; }
        else if (Number.isInteger(n) && n > 0) {
          // (the `if` form's anchor after the rows is comments: `:last-child` and the like see the rows as the last elements)
          // the dry run (`styledIn`: the copy): the first pass's result, when what it read is the same in the copy
          const dry = this.dry, count = Math.min(n, 1000);
          const trace = styledIn && dry ? dry.traces.get(tpl) : undefined;
          const reused = trace ? layout.reuse(trace, (el) => dry!.twin.get(el)) : undefined;
          if (reused !== undefined) space = reused;
          else if (dry && !styledIn && dry.twin.has(tpl)) {
            const tr = layout.reserveTraced(tpl, count, { sized: !!sized });
            dry.traces.set(dry.twin.get(tpl)!, tr);
            space = tr.result;
          } else space = layout.reserve(tpl, count, { sized: !!sized });
          if (!space && why === '') why = sized && layout.unreserved?.startsWith('the box') ? `the box around it is as wide as its content (${sized.widths}), and the rows have no width of their own (SN529)` : layout.unreserved ?? 'unknown';
        }
      }
      // images in the rows without a height before their file: each one grows its row when it loads
      // with what its `src` is bound to (read here: the walk removes the bindings), for the fix SN530 suggests
      const unsized: Array<{ el: P5Element; src: string | null; v: string | null }> = [];
      const v = /^\s*(?:\(\s*([A-Za-z_]\w*)\s*,\s*[A-Za-z_]\w*\s*\)|([A-Za-z_]\w*))\s+in\b/.exec(attr(tpl, 'data-sn-for')!);
      const srcOf = (c: P5Element) => /(?:^|[{,]\s*)src\s*:\s*([A-Za-z_$][\w$]*(?:\??\.[A-Za-z_$][\w$]*)+)\s*(?=[,}])/.exec(attr(c, 'data-sn-attr') ?? '')?.[1]?.replace(/\?\./g, '.') ?? null;
      const scan = (p: P5Parent) => { for (const c of p.childNodes) { if (!isElement(c)) continue; if (/^(img|video|iframe|embed|object)$/.test(c.tagName) && layout.sized(c) === false) unsized.push({ el: c, src: srcOf(c), v: v?.[1] ?? v?.[2] ?? null }); scan(c.tagName === 'template' ? (c as P5Template).content : c); } };
      scan((tpl as P5Template).content);
      this.spacePlan.set(tpl, { sized, space, resources: space ? names : [], names: cands, waitForm, waitOff, form, list: m?.[1]!.trim() ?? '', why: why || null, unsized });
    }
  }

  /**
   * After a list's template is compiled: SN529 for a list over late data in a box whose width its rows
   * decide, and the planned placeholder after the template. `static` (the list is a resource that always
   * loads): an element whose one binding removes it once the resource has rows or no load is running.
   * `if` (a `when`, a `data-sn-let` or an expression over resources): a `data-sn-if` over the same, so
   * the early file decides it from the resources' status at mount, and the page module removes it as any
   * branch. A "Loading…" branch over the same status right before the list takes the placeholder's place.
   */
  spaceFor(el: P5Element, node: NodeDef, ctx: Ctx) {
    const plan = this.spacePlan.get(el);
    const b = node.b.find((x) => x.k === 'for');
    if (!plan || !b || ctx.tid >= 0) return;
    const late = strs(b.d).map((d) => /^\$r\.([^.]+)/.exec(d)?.[1]).filter((n): n is string => !!n && !this.embedded.has(n));
    const names = plan.resources, deps = strs(b.d);
    const reads = (d: string) => names.some((n) => d === `$r.${n}` || d.startsWith(`$r.${n}.`));
    // the static form: the list's only dependency is its resource; the if form: the resources and what the early file knows
    // every resource's load starts at mount: else the space would go at mount and come back. The static form needs no more
    // (a `src` over state starts from its first values); the if form is the early file's, so its resources must be `predictable`
    const pre = this.predictable();
    const starts = (n: string) => { const def = this.resources.find((r) => r.name === n); return !!def && !def.src.some((x) => typeof x === 'number' && /\$(r|meta|el)\b/.test(this.fns[x]!)); };
    const held = !!plan.space && names.length > 0 && !names.some((n) => this.embedded.has(n)) && names.every((n) => /^[A-Za-z_$][\w$]*$/.test(n))
      && names.every((n) => (plan.form === 'static' ? starts(n) : pre.has(n)))
      && (plan.form === 'static' ? deps.every(reads) : deps.every((d) => reads(d) || d === '$url' || d.startsWith('$url.') || d === '$locale'));
    const waits = plan.sized?.siblings && late.length && !held ? this.waitFor(el, plan, deps, starts, pre, ctx) : false;
    if (plan.sized?.siblings && late.length && !held && !waits) {
      const what = plan.sized.el.tagName + (attr(plan.sized.el, 'class') ? `.${attr(plan.sized.el, 'class')!.trim().split(/\s+/).join('.')}` : '');
      this.report(el, 'data-sn-for', 'SN529', `this list's rows arrive after the first paint inside \`<${what}>\`, whose width follows its content (${plan.sized.widths}): the rows widen it and move what is beside it`, 0,
        'give that box a width or flex basis of its own (`flex: 1 1 0`, `width: 100%`), or give the rows a width');
    }
    if (late.length) for (const u of plan.unsized) this.report(u.el, null, 'SN530', `\`<${u.el.tagName}>\` in a list whose rows arrive after the first paint has no height before its file loads: when it does, its row grows and what follows moves`, 0,
      this.unsizedFix(u, plan.list));
    const note = (why: string) => {
      const o = this.origins.get(el), at = o && el.sourceCodeLocation ? this.lineCol(o.src, el.sourceCodeLocation.startOffset) : { line: 1, col: 1 };
      this.unheld.push({ file: o?.file ?? this.opts.file, line: at.line, col: at.col, why });
    };
    if (plan.why && !waits) note(plan.why);
    else if (plan.space && !held) note(!names.every((n) => (plan.form === 'static' ? starts(n) : pre.has(n))) ? 'a resource\'s `src` or `when` reads more than the URL (state, another resource): its load may not start when the page module mounts' : 'the list reads more than its resources and the URL');
    if (!held || !plan.space || !this.opts.paintCss) return;
    const parent = el.parentNode as P5Element;
    // unique across pages, should two pages' rules end up in one stylesheet
    let hash = 0x811c9dc5;
    const rel = this.opts.file.slice(this.opts.root.length).replace(/^[\\/]+/, '');
    for (const ch of rel) hash = Math.imul(hash ^ ch.charCodeAt(0), 0x01000193);
    const k = `snr${(hash >>> 0).toString(36).slice(0, 4)}${this.spaceN++}`;
    const tag = plan.space.tag, markup = `<${tag} class="sn-reserve ${k}" aria-hidden="true"></${tag}>`;
    const at = parent.childNodes.indexOf(el) + 1;
    if (plan.form === 'static') {
      const ph = parse5.parseFragment(markup).childNodes[0] as P5Element;
      ph.parentNode = parent;
      parent.childNodes.splice(at, 0, ph as never);
      const r = `.${names[0]!}`;
      // rows, or no load running: it ended (empty, failed) or never started (a `src` that cannot be built); the load starts at mount, before this runs
      const code = `($) => ($.$r${r}?.length || !$.$meta${r}.loading) && $.$el.remove()`;
      this.spaces.push({ list: el, names, k, space: plan.space, note, ph, node: { tag, p: ctx.stateIdx, b: [this.binding({ k: 'imp', f: this.fn(code, { el, attr: 'data-sn-for', shift: 0 }), d: [`$r.${names[0]!}`, `$meta.${names[0]!}`], e: 1 })] } });
    } else {
      // no rows yet, and one of the resources loading: the walk compiles it next, as page markup
      const cond = `!(${plan.list})?.length && (${names.map((n) => `$meta.${n}.loading`).join(' || ')})`;
      const t = parse5.parseFragment(`<template data-sn-if="${cond.replace(/&/g, '&amp;').replace(/"/g, '&quot;')}">${markup}</template>`).childNodes[0] as P5Element;
      t.parentNode = parent;
      parent.childNodes.splice(at, 0, t as never);
      const origin = this.origins.get(el);
      if (origin) this.tag(t, origin);
      this.spaces.push({ list: el, names, k, space: plan.space, note, tpl: t });
    }
  }

  /**
   * A list over late data in a box whose width follows its content, with boxes after it (SN529's case), and no
   * space held: what follows the box stays invisible (`visibility: hidden`, still laid out) while the list's first
   * rows load, so when they widen or lengthen the box nothing that is shown moves. A marker after the list's
   * template is there exactly then: the static form's element is removed for good once the resource has rows or no
   * load is running; the `if` form's branch shows with no rows while one of its resources the early file knows
   * makes its first load (`!loadedAt`): a resource it cannot tell (a `when` over another resource, as "Your Feed"
   * over the user) never shows it. The box's following siblings are hidden by a rule over the marker (`:has()`;
   * a browser without it shows them, as before), for at most 3 s (an animation), should the page script never run.
   * Builds only; dev plans the same and reports nothing. Returns whether it did (then no SN529).
   */
  waitFor(el: P5Element, plan: NonNullable<ReturnType<typeof this.spacePlan.get>>, deps: string[], starts: (n: string) => boolean, pre: Map<string, ResourceDef>, ctx: Ctx): boolean {
    const names = plan.names, box = plan.sized?.el;
    if (!box || !names.length || names.some((n) => this.embedded.has(n) || !/^[A-Za-z_$][\w$]*$/.test(n))) return false;
    if (plan.waitOff) return false;
    const reads = (d: string) => names.some((n) => d === `$r.${n}` || d.startsWith(`$r.${n}.`));
    const known = names.filter((n) => pre.has(n));
    if (plan.waitForm === 'static' ? !(names.every(starts) && deps.every(reads)) : !(known.length && deps.every((d) => reads(d) || d === '$url' || d.startsWith('$url.') || d === '$locale'))) return false;
    const o = this.origins.get(el), at = o && el.sourceCodeLocation ? this.lineCol(o.src, el.sourceCodeLocation.startOffset) : { line: 1, col: 1 };
    const what = box.tagName + (attr(box, 'class') ? `.${attr(box, 'class')!.trim().split(/\s+/).join('.')}` : '');
    this.waits.push({ file: o?.file ?? this.opts.file, line: at.line, col: at.col, what, widths: plan.sized!.widths });
    if (!this.opts.paintCss) return true;
    let hash = 0x811c9dc5;
    const rel = this.opts.file.slice(this.opts.root.length).replace(/^[\\/]+/, '');
    for (const ch of rel) hash = Math.imul(hash ^ ch.charCodeAt(0), 0x01000193);
    const k = `snw${(hash >>> 0).toString(36).slice(0, 4)}${this.spaceN++}`;
    setAttr(box, 'class', [attr(box, 'class'), k].filter(Boolean).join(' '));
    const parent = el.parentNode as P5Element, i = parent.childNodes.indexOf(el) + 1, markup = `<i class="${k}m" hidden></i>`;
    if (plan.waitForm === 'static') {
      const mk = parse5.parseFragment(markup).childNodes[0] as P5Element;
      mk.parentNode = parent;
      parent.childNodes.splice(i, 0, mk as never);
      const r = `.${names[0]!}`;
      this.pendingSpace.push({ el: mk, node: { tag: 'i', p: ctx.stateIdx, b: [this.binding({ k: 'imp', f: this.fn(`($) => ($.$r${r}?.length || !$.$meta${r}.loading) && $.$el.remove()`, { el, attr: 'data-sn-for', shift: 0 }), d: [`$r.${names[0]!}`, `$meta.${names[0]!}`], e: 1 })] } });
    } else {
      const cond = `!(${plan.list})?.length && (${known.map((n) => `$meta.${n}.loading && !$meta.${n}.loadedAt`).join(' || ')})`;
      const t = parse5.parseFragment(`<template data-sn-if="${cond.replace(/&/g, '&amp;').replace(/"/g, '&quot;')}">${markup}</template>`).childNodes[0] as P5Element;
      t.parentNode = parent;
      parent.childNodes.splice(i, 0, t as never);
      if (o) this.tag(t, o);
    }
    if (!this.waitRules.length) this.waitRules.push('@keyframes sn-wait { to { visibility: visible } }');
    // `:not(#_)`: an id's weight, over the author's rules for those boxes; the animation shows them after 3 s whatever happens
    // only at the widths where the box follows its content: elsewhere nothing moves, and nothing is hidden
    const rule = `.${k}:has(.${k}m) ~ :not(#_) { visibility: hidden; animation: sn-wait 0s 3s forwards }`;
    for (const [lo, hi] of plan.sized!.ranges) {
      // the breakpoints are the stylesheets' own: `max-width` one hundredth below the next so the two never overlap
      const q = [lo > 0 ? `(min-width: ${Math.round(lo * 100) / 100}px)` : '', hi !== undefined ? `(max-width: ${Math.round(hi * 100) / 100 - 0.02}px)` : ''].filter(Boolean).join(' and ');
      this.waitRules.push(q ? `@media ${q} { ${rule} }` : rule);
    }
    return true;
  }

  /**
   * After the walk, every binding compiled: each planned placeholder against the page's loading indicators,
   * the `data-sn-if` and `data-sn-show` bindings over one of its resources' status (tried with `shows`: while
   * loading with no rows, with rows, and loaded). One that does not show while loading with no rows never meets
   * it. A branch right before the list (only templates between) with one element, which shows exactly then,
   * takes the placeholder's place: the rows' box, and the placeholder hidden while it shows. Any other that may
   * show then leaves the list without space, as the two would be taller than the rows.
   */
  settleSpace() {
    const elOf = new Map<NodeDef, P5Element>([...this.paints.map((x) => [x.node, x.el] as const), ...this.tplEls]);
    const bindings = [...this.roots, ...this.templates.flatMap((t) => t.nodes)].flatMap((nd) => nd.b.filter((b) => (b.k === 'if' || b.k === 'show') && b.f !== undefined).map((b) => ({ b, el: elOf.get(nd) })));
    for (const sp of this.spaces) {
      const reads = (b: Binding) => strs(b.d).some((d) => sp.names.some((n) => d === `$meta.${n}` || d.startsWith(`$meta.${n}.`)));
      const kids = (sp.list.parentNode as P5Element).childNodes.filter(isElement), at = kids.indexOf(sp.list);
      let branch: P5Element | null = null, clash = false;
      for (const { b, el } of bindings) {
        if (!reads(b) || (sp.tpl && el === sp.tpl)) continue;
        const code = this.fns[b.f!]!, now = shows(code, sp.names, { loading: true }, []);
        if (now === false) continue;
        const i = el ? kids.indexOf(el) : -1;
        const roots = b.k === 'if' && el ? ((el as P5Template).content?.childNodes ?? []).filter((c) => isElement(c) || (c.nodeName === '#text' && /\S/.test((c as DefaultTreeAdapterMap['textNode']).value))) : [];
        if (now === true && !branch && b.k === 'if' && i >= 0 && i < at && kids.slice(i + 1, at).every((x) => x.tagName === 'template')
          && shows(code, sp.names, { loading: true }, [{}]) === false && shows(code, sp.names, { loading: false }, []) === false && roots.length === 1 && isElement(roots[0]!)) branch = roots[0] as P5Element;
        else clash = true;
      }
      // a resource the server embeds (a slot the walk added, `embed`): its rows are in the first frame
      const served = sp.names.some((n) => this.resources.find((r) => r.name === n)?.data != null);
      if (served || clash) {
        sp.note(served ? 'its data is embedded by the server, in the first frame' : 'a loading indicator over the same status may show with the space, and the two would be taller than the rows (one "Loading…" branch right before the list, as one element, takes its place)');
        if (sp.ph) detach(sp.ph);
        // the inserted branch never shows
        if (sp.tpl) { const nd = this.paints.find((x) => x.el === sp.tpl)?.node, ib = nd?.b.find((x) => x.k === 'if'); if (ib) ib.f = this.fn('($) => (false)'); }
        continue;
      }
      if (sp.ph && sp.node) this.pendingSpace.push({ el: sp.ph, node: sp.node });
      // `:not(#_)` counts as an id: the rules win over the author's, `!important` ones of an id and two classes or less included
      if (!this.paintRules.length) this.paintRules.push(`.sn-reserve:not(#_) { ${PLACEHOLDER_BASE} }`);
      const k = sp.k, sel = `.sn-reserve.${k}:not(#_)`, media = (from: number, rule: string) => (from ? `@media (min-width: ${Math.round(from * 100) / 100}px) { ${rule} }` : rule);
      for (const p of sp.space.pieces) this.paintRules.push(media(p.from, `${sel} { ${p.decls} }`));
      if (branch) {
        // the branch takes the rows' box (their height, their outer margins, which collapse with what is around as the rows'
        // will), and while it shows, the placeholder after it does not
        setAttr(branch, 'class', [attr(branch, 'class'), `${k}b`].filter(Boolean).join(' '));
        this.paintRules.push(`.${k}b ~ .sn-reserve.${k}:not(#_) { display:none !important }`);
        for (const p of sp.space.pieces) this.paintRules.push(media(p.from, `.${k}b:not(#_) { box-sizing:border-box !important;min-height:${p.height} !important;margin-top:${p.mt} !important;margin-bottom:${p.mb} !important }`));
      }
    }
  }

  /** the placeholders' root nodes, last, with the last ids */
  placeholders() {
    this.settleSpace();
    for (const { el, node } of this.pendingSpace) {
      node.id = this.nextId++;
      setAttr(el, 'data-sn', String(node.id));
      this.roots.push(node);
    }
  }

  /**
   * `embed`: a placeholder at the end of the head for each resource without one whose `src`,
   * `when` and `model` (paginate) read only `$url`, constants and helpers (what a server knows at the
   * page request; helpers make it a request only a resolver can make)
   */
  /** the values of the `file:` resources, as embedded data in the head (not placeholders: nothing for a server to fill) */
  fileScripts(doc: DefaultTreeAdapterMap['document']) {
    const html = doc.childNodes.find((n) => isElement(n) && n.tagName === 'html') as P5Element | undefined;
    const head = html?.childNodes.find((n) => isElement(n) && n.tagName === 'head') as P5Element | undefined;
    this.headEl = head ?? null;
    if (!head || !this.fileData.size) return;
    // the elements now, their JSON once the page is compiled and only for what is left (`fileJson`): a list that every
    // page of a `<html data-sn-for>` template declares would otherwise be written and parsed in each, and then dropped
    for (const d of this.fileData.values()) {
      const el = parse5.defaultTreeAdapter.createElement('script', parse5.html.NS.HTML, [{ name: 'type', value: 'application/json' }, { name: 'data-sn', value: String(d.id) }]);
      parse5.defaultTreeAdapter.appendChild(head, el);
      d.el = el;
    }
  }

  /**
   * the `file:` values still in the page: a placeholder in each element, which `compileParts` fills with the value's
   * JSON once the passes are done (a first pass whose page is compiled again would write it for nothing)
   */
  readonly jsonOut = new Map<number, unknown>();
  /**
   * diagnostics about the page as it ends (what still ships): in a first pass that may be followed by a second, they
   * wait (`late`), since the second pass may fold away what they are about, and a first pass with errors has none
   */
  readonly lateDiags: Diagnostic[] = [];
  reportLate(el: P5Element, a: string | null, code: Code, message: string, at: number, hint?: string) {
    const n = this.diagnostics.length;
    this.report(el, a, code, message, at, hint);
    if (this.collecting()) this.lateDiags.push(...this.diagnostics.splice(n));
  }
  fileJson() {
    for (const [name, d] of this.fileData) if (d.el && !d.el.childNodes.length && d.el.parentNode) {
      // what the browser still reads: only the fields `fields` names, of each entry; a collection's is named, always,
      // so that what a CMS returns and no page shows does not ship (SN344)
      if (d.content && !d.fields && d.at) this.reportLate(d.at, d.at.tagName === 'html' ? 'data-sn-for' : 'src', 'SN344', `browser code reads \`${name}\`, a collection, so it would ship to the page: name the fields it gets with \`fields="…"\`${d.at.tagName === 'html' ? ' on its list' : ''}`, 0, 'a collection holds what a loader returned, which can be more than a page shows (a CMS\'s internal fields); `fields="sku,name,price"` ships those of each entry, and nothing else');
      parse5.defaultTreeAdapter.insertText(d.el, `\u0001sn-json:${d.id}\u0001`);
      this.jsonOut.set(d.id, d.fields ? pickFields(d.value, d.fields) : d.value);
    }
  }

  addPlaceholders(doc: DefaultTreeAdapterMap['document']) {
    const html = doc.childNodes.find((n) => isElement(n) && n.tagName === 'html') as P5Element | undefined;
    const head = html?.childNodes.find((n) => isElement(n) && n.tagName === 'head') as P5Element | undefined;
    if (!head) return;
    for (const def of this.resources) {
      if (def.data != null || def.call || def.each || this.unembedded(def.name) || !def.src.length) continue;
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
      if (def.data == null || def.fx) continue;
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
        ...(pg && startUrl ? { start: { url: startUrl, key: pg.skipParam ?? pg.pageParam, size: pg.size, ...(pg.skipParam ? { skip: true as const } : {}), query: Object.entries(pageParams(pg, 2)) } } : {}),
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
    for (const y of this.syncs) { for (const x of y.src) if (typeof x === 'number') fn(x); for (const e of y.events) { fn(e.value); fn(e.when); fn(e.then); } }
    const read = new Set<string>();
    for (const c of codes) for (const m of c.matchAll(/\$\.\$(?:r|meta)\.([A-Za-z_$][\w$]*)/g)) read.add(m[1]!);
    for (const r of this.resources) if (!read.has(r.name) && r.data == null) r.lo = 1;
  }

  /**
   * Why the page needs the runtime, in document order: each element with something bound, a state or a
   * component script (by its first sinter attribute), each resource and stream. Empty: nothing runs.
   */
  /** why a node's bindings (or the rows of its templates) stayed in the browser, when an app helper's call kept them there */
  whyNotFolded(n: NodeDef, seen = new Set<number>()): string | null {
    for (const b of n.b) {
      const w = b.f !== undefined ? this.foldWhy.get(this.fns[b.f]!) : undefined;
      if (w) return w;
      if ((b.k === 'for' || b.k === 'if' || b.k === 'else') && b.x !== undefined && !seen.has(b.x)) {
        seen.add(b.x);
        for (const m of this.templates[b.x]?.nodes ?? []) { const r = this.whyNotFolded(m, seen); if (r) return r; }
      }
    }
    if (n.state !== undefined) {
      const st = this.stateInits.find((x) => x.sid === n.sid);
      for (const f of st?.fields ?? []) { const w = this.foldWhy.get(f.code); if (w) return w; }
    }
    return null;
  }

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
      return names.find((n) => n.startsWith('data-sn-') && !['data-sn-with', 'data-sn-component', 'data-sn-key', 'data-sn-early'].includes(n)) ?? null;
    };
    const elOf = new Map(this.paints.map((x) => [x.node, x.el]));
    for (const n of this.roots) {
      if (!n.b.length && n.state === undefined) continue;
      // an anchor (a loop, branch, choice or recursion point left to the browser) paints nothing: its element
      // is the template or tag it took the place of, so that it is never left out
      const el = elOf.get(n) ?? this.tplEls.get(n) ?? this.pointOf.get(n)?.el ?? this.anchorEls.get(n);
      if (el === self) continue;
      // (no element to point at: still a reason, at the page, so that a page never ships code without one)
      if (!el) { const k = n.b[0] && BY_KIND[n.b[0].k]; out.push({ what: `${k ? `\`${k}\`` : 'a binding'} (where it was written is not known)`, file: this.opts.file, line: 1, col: 1, at: 0 }); continue; }
      const b = n.b.find((x) => x.k === 'cmp') ?? n.b[0];
      if (b?.k === 'cmp') { out.push({ what: `the script of \`<${this.useOf.get(el)?.name ?? el.tagName}>\``, ...at(el, null) }); continue; }
      const name = nameOf(el, b);
      const why = this.whyNotFolded(n);
      out.push({ what: `${name ? `\`${name}\`` : `\`<${this.points.get(el) ?? el.tagName}>\``}${why ? ` (${why})` : ''}`, ...at(el, name) });
    }
    // a fill of a tree placement that renders in the browser whatever its data (`fillStays`): named, with why
    for (const F of new Set(this.caseFill.values())) {
      const why = this.fillStays(F);
      const el = F.nodes.find(isElement);
      if (!why || !el) continue;
      const tag = this.useOf.get(el)?.host ?? el;
      out.push({ what: `the fill \`<${tag.tagName} slot="${F.k}">\` (${why}, so it renders in the browser)`, ...at(tag, null) });
    }
    for (const r of this.resources) {
      const el = this.declAt.get(r);
      out.push({ what: `resource \`${r.name}\``, ...(el ? at(el, 'name') : { file: this.opts.file, line: 1, col: 1, at: 0 }) });
    }
    for (const x of this.syncs) {
      const el = this.declAt.get(x);
      out.push({ what: '`<sn-sync>`', ...(el ? at(el, null) : { file: this.opts.file, line: 1, col: 1, at: 0 }) });
    }
    // a kept element needs the swap's code to be kept (with swaps on)
    if (this.opts.swap) for (const el of this.permanentEls) out.push({ what: '`data-sn-permanent` (links swap the next page in around it)', ...at(el, 'data-sn-permanent') });
    const page = (r: RuntimeReason) => (r.file === this.opts.file ? 0 : 1);
    return out.sort((a, b) => page(a) - page(b) || (a.file === b.file ? a.at - b.at : 0)).map(({ at: _, ...r }) => r);
  }

  /**
   * A page that uses a library's scoped styles: `@layer sinter-lib;` in a stylesheet linked before
   * anything else in its head, so the libraries' layer comes first and the app's own layers and its
   * unlayered CSS win. An app that declares the layer itself (`@layer reset, sinter-lib, app;`) in a
   * stylesheet before it places it among its layers.
   */
  declareLayers(doc: DefaultTreeAdapterMap['document']) {
    if (!this.opts.componentCss || ![...this.uses.keys()].some((n) => this.componentFiles.get(n)?.lib && this.componentFiles.get(n)?.css)) return;
    const head = findHead(doc);
    if (!head) return;
    const link = parse5.parseFragment(`<link rel="stylesheet" href="${this.opts.componentCss(LAYERS_SHEET).replace(/[&"<>]/g, (c) => `&#${c.charCodeAt(0)};`)}">`).childNodes[0] as P5Element;
    link.parentNode = head;
    const first = head.childNodes.findIndex((c) => isElement(c) && (c.tagName === 'link' || c.tagName === 'style'));
    head.childNodes.splice(first < 0 ? head.childNodes.length : first, 0, link as never);
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
/**
 * For each state object (`$s3`) and field (`$s3.k`) the functions read, the distinct function sources
 * that read it; the object itself only where it is not followed by `.`, `$` or a word character, a
 * field only where it is not followed by `$` or a word character. Functions that are `'0'` are gone.
 */
export function stateReaders(fns: readonly string[]): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  const add = (key: string, c: string) => { let r = out.get(key); if (!r) out.set(key, (r = new Set())); r.add(c); };
  const word = /[\w$]/, re = /\$s(\d+)/g, field = /^\.([\w$]+)/;
  for (const c of new Set(fns)) {
    if (c === '0') continue;
    for (const m of c.matchAll(re)) {
      const end = m.index + m[0].length, next = c[end];
      if (next !== undefined && word.test(next)) continue;
      if (next !== '.') { add(`$s${m[1]}`, c); continue; }
      const f = field.exec(c.slice(end, end + 200));
      if (f) add(`$s${m[1]}.${f[1]}`, c);
    }
  }
  return out;
}

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
 * data then cannot name a global another script reads, so `id`/`name` from it is not reported. A choice
 * (`c.id ? 'contact-' + c.id : null`) is when each of its branches is, or sets no attribute (`null`,
 * `false`, `undefined`): every value it can give still starts with the literal.
 */
const literalPrefix = (n: Node | undefined): boolean => {
  if (n?.type === 'ConditionalExpression') {
    const c = n as import('acorn').ConditionalExpression;
    return [c.consequent, c.alternate].every((b) => noAttribute(b as Node) || literalPrefix(b as Node));
  }
  while (n?.type === 'BinaryExpression' && (n as import('acorn').BinaryExpression).operator === '+') n = (n as import('acorn').BinaryExpression).left as Node;
  if (n?.type === 'Literal') { const v = (n as import('acorn').Literal).value; return typeof v === 'string' && v !== ''; }
  if (n?.type === 'TemplateLiteral') return ((n as import('acorn').TemplateLiteral).quasis[0].value.cooked ?? '') !== '';
  return false;
};
/** `null`, `false` or `undefined`: a value that removes the attribute */
const noAttribute = (n: Node): boolean =>
  (n.type === 'Literal' && ((n as import('acorn').Literal).value === null || (n as import('acorn').Literal).value === false))
  || (n.type === 'Identifier' && (n as import('acorn').Identifier).name === 'undefined');
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
  for (const key of ['f', 'd', 'n', 'q', 'm', 'x', 'a', 'y', 'z', 'c', 'w', 'p', 'e', 'i', 'ms', 's', 'g'] as const) {
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

function findBody(doc: P5Parent): P5Element | null {
  for (const c of doc.childNodes) {
    if (!isElement(c)) continue;
    if (c.tagName === 'body') return c;
    const b = findBody(c);
    if (b) return b;
  }
  return null;
}

/** sinter's anchor comments, exactly: `sn` (in a row), `sn <id>`, `/sn`, and empty (a text separator) */
const ANCHOR_COMMENT = /^(?:sn(?: \d+)?|\/sn)?$/;

/** `task-ring` → `TaskRing`: the class a component's script exports */
const pascalName = (name: string) => name.split('-').map((p) => p[0]!.toUpperCase() + p.slice(1)).join('');

/** The literal keys of a `data-sn-state` object (none when it does not parse). */
function stateKeys(src: string | undefined): Set<string> {
  const out = new Set<string>();
  if (!src) return out;
  try {
    const o = parseExpression(src);
    if (o.type === 'ObjectExpression') for (const p of o.properties) if (p.type === 'Property' && !p.computed && p.key.type === 'Identifier') out.add(p.key.name);
  } catch { /* reported where the state is compiled */ }
  return out;
}

/** Whether two placements cannot render together: some if/else chain has them in different branches (paths of `chain:branch`). */
function exclusive(a: string[], b: string[]): boolean {
  const branch = new Map(a.map((x) => x.split(':') as [string, string]));
  return b.some((x) => { const [c, k] = x.split(':') as [string, string]; return branch.has(c) && branch.get(c) !== k; });
}

/**
 * Whether markup's expressions read `name` (in any `data-sn-*` value): an identifier, not an object
 * literal's key or a member's property name (`{ node: … }`, `x.node`). A value that does not parse
 * counts when the name appears in it.
 */
function reads(nodes: P5Node[], name: string): boolean {
  const re = new RegExp(`(?<![\\w$.])${name.replace(/\$/g, '\\$')}(?![\\w$])`);
  const inValue = (v: string): boolean => {
    if (!re.test(v)) return false;
    let ast: acorn.Node;
    try { ast = parseExpression(v); } catch {
      try { ast = parseProgram(v); } catch { return true; }
    }
    let found = false;
    fullAncestor(ast, (n, _state, ancestors) => {
      if (found || n.type !== 'Identifier' || (n as acorn.Identifier).name !== name) return;
      const parent = ancestors[ancestors.length - 2] as acorn.Node | undefined;
      if (parent?.type === 'Property' && (parent as acorn.Property).key === n && !(parent as acorn.Property).computed && !(parent as acorn.Property).shorthand) return;
      if (parent?.type === 'MemberExpression' && (parent as acorn.MemberExpression).property === n && !(parent as acorn.MemberExpression).computed) return;
      found = true;
    });
    return found;
  };
  const walk = (ns: P5Node[]): boolean => ns.some((c) => isElement(c) && (c.attrs.some((a) => a.name.startsWith('data-sn-') && inValue(a.value)) || walk(c.childNodes) || (c.tagName === 'template' && walk((c as P5Template).content.childNodes))));
  return walk(nodes);
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

const KEPT_ATTRS = new Set(['data-sn-navigate', 'data-sn-permanent', 'data-sn-swap', 'data-sn-options']);
/** the ids of a kept element's nodes: a range of its own, from its name, past any page's own numbering */
const KEPT_IDS = 1000;
export const keptBase = (name: string) => {
  let h = 2166136261;
  for (let i = 0; i < name.length; i++) h = Math.imul(h ^ name.charCodeAt(i), 16777619);
  return 1_000_000 + ((h >>> 0) % 1000) * KEPT_IDS;
};
const hashText = (t: string) => {
  let h = 2166136261;
  for (let i = 0; i < t.length; i++) h = Math.imul(h ^ t.charCodeAt(i), 16777619);
  return (h >>> 0).toString(36);
};
/** a component template's props type: `data-sn-props` as written, or the name the compiler gave it (`declaration()`) */
const propsDecl = (t: P5Element) => attr(t, 'data-sn-props') ?? attr(t, 'data-sn-component');

function stripSn(el: P5Element) {
  // what stays, for the runtime: `data-sn-navigate` marks an element with a `navigate` handler (navigate.ts),
  // `data-sn-permanent` a kept element, `data-sn-swap` a link the swap leaves to the browser and `data-sn-options`
  // the owner of a list of options (options.ts)
  el.attrs = el.attrs.filter((a) => !a.name.startsWith('data-sn-') || KEPT_ATTRS.has(a.name));
}

/** Whether a form's markup reads `$error` (outside `data-sn-catch`, where `$error` is the action's own). */
function readsFormError(el: P5Element, hostOf: (e: P5Element) => P5Element | undefined): boolean {
  const own = (e: P5Element) => e.attrs.some((a) => a.name.startsWith('data-sn-') && a.name !== 'data-sn-catch' && /\$error\b/.test(a.value));
  // a component's tag, which its root replaced: `data-sn-with="{ error: $error }"`
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
    return nd.tag === '#' ? `${x}?.nodeType == 8 ? ${x} : null` : `${x}?.localName == ${JSON.stringify(nd.tag)} ? ${x} : null`;
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
      // a style group: its values in the order of its names (`groupStyles`)
      if (b.g !== undefined) { writes.push(`${e} && w.g(${e}, ${b.g}, ${v})`); continue; }
      writes.push(`${e} && w.${b.k === 'text' && b.n ? 'x' : WRITER[b.k]}(${e}, ${JSON.stringify(b.n ?? '')}, ${v}${b.k === 'class' ? `, ${valued[k]!.cl ? 1 : 0}` : ''})`);
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
  try { fn = parseExpression(code) as acorn.Expression; } catch { return null; }
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

/** the early file's `model` (paginate) start: page n's parameters are `qn` with `k` set (the page, or with `params.offset` the items to skip) */
function startOf(cfg: Paginate, f: number): NonNullable<NonNullable<EarlyIR['res']>[number]['sp']> {
  const k = cfg.skipParam ?? cfg.pageParam;
  return { f, k, s: cfg.size, ...(cfg.skipParam ? { o: 1 as const } : {}), qn: pageParams(cfg, 2) };
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

/** From this many candidates, a `<sn-component use>` choice is a lookup table rather than a chain (`finishChoices`). */
const CHOICE_TABLE = 8;

/**
 * How deep plain data may nest. A constant tree a component library unrolls at build time is as deep as
 * its content: an email's HTML, a document's sections (each element is two levels: the node and its
 * children's array). The bound keeps a cycle, or a structure nothing renders, from being walked forever.
 */
const PLAIN_DEPTH = 1024;

/**
 * JSON-like data: what a literal state object holds. Walked with a stack, not recursion, so a deep
 * tree does not exhaust the call stack; an object reached twice (a shared subtree) is walked once
 * unless it is reached again less deep.
 */
function plainData(v: unknown): boolean {
  const scalar = (x: unknown) => x === null || ['string', 'number', 'boolean', 'undefined'].includes(typeof x);
  if (scalar(v)) return true;
  const seen = new Map<object, number>();
  const stack: [unknown, number][] = [[v, 0]];
  while (stack.length) {
    const [x, depth] = stack.pop()!;
    if (scalar(x)) continue;
    if (depth > PLAIN_DEPTH || typeof x !== 'object') return false;
    const at = seen.get(x as object);
    if (at !== undefined && at <= depth) continue;
    seen.set(x as object, depth);
    if (!Array.isArray(x)) {
      const proto = Object.getPrototypeOf(x);
      if (proto !== Object.prototype && proto !== null) return false;
    }
    for (const c of Array.isArray(x) ? x : Object.values(x as object)) stack.push([c, depth + 1]);
  }
  return true;
}

/** A copy of parsed markup as the parser made it (source locations shared), with nothing the compiler attached. */
function freshCopy(n: P5Node | DefaultTreeAdapterMap['documentFragment'], parent: P5Parent | null): P5Node {
  const copy = { ...n, parentNode: parent } as P5Node;
  if ('attrs' in n) (copy as P5Element).attrs = n.attrs.map((a) => ({ ...a }));
  if ('childNodes' in n) (copy as P5Element).childNodes = n.childNodes.map((c) => freshCopy(c, copy as P5Parent)) as never[];
  if ('content' in n && n.content) (copy as P5Template).content = freshCopy(n.content as never, null) as never;
  return copy;
}

/** Plain data (`plainData`) as a JavaScript expression that makes an equal value: `undefined`, `NaN`, `-0` and a `__proto__` key included; `<` escaped, for an inline script. */
function jsLiteral(v: unknown): string {
  if (v === undefined) return 'undefined';
  if (typeof v === 'number') return Object.is(v, -0) ? '-0' : String(v);
  if (typeof v === 'string') return JSON.stringify(v).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
  if (v === null || typeof v === 'boolean') return String(v);
  if (Array.isArray(v)) return `[${v.map(jsLiteral).join(', ')}]`;
  return `{ ${Object.entries(v as object).map(([k, x]) => `${k === '__proto__' ? '["__proto__"]' : jsLiteral(k)}: ${jsLiteral(x)}`).join(', ')} }`;
}

/** a value with only `fields` of each entry (a list's), or of the object itself */
function pickFields(v: unknown, fields: string[]): unknown {
  const pick = (e: unknown) => (e && typeof e === 'object' && !Array.isArray(e) ? Object.fromEntries(fields.filter((f) => f in (e as object)).map((f) => [f, (e as Record<string, unknown>)[f]])) : e);
  return Array.isArray(v) ? v.map(pick) : pick(v);
}

/** values `deepFreeze` froze at every depth: build-time constants may share them without a copy */
const DEEP_FROZEN = new WeakSet<object>();

function deepFreeze<T extends object>(v: T): T {
  DEEP_FROZEN.add(v);
  for (const x of Object.values(v)) if (x && typeof x === 'object') deepFreeze(x);
  return Object.freeze(v);
}

/** a binding that cannot be written ahead */
const FAIL: unique symbol = Symbol('first paint: runtime-only');
/**
 * the most rows and component instances a page expands at build time, at every depth: compiling the expanded page
 * takes about 0.2 ms each (measured on a generic tree of paragraphs, links and images, in the build and the LSP alike,
 * which compile it on every edit), so the limit keeps a page near 1 s. A tree that would cross it stays a template,
 * with `SN536` at its use
 */
const EXPANSION_LIMIT = 10_000;

const isPrimitive = (v: unknown) => v == null || ['string', 'number', 'boolean'].includes(typeof v);

/** what a binding the build found constant writes into the markup (`writeFirstPaint`) */
export type ConstantWrite = { k: Kind; n: string | null; v: unknown };
/** the attributes whose bindings the second pass writes before the layout (`prefold`) */
const FOLDED = ['data-sn-text', 'data-sn-show', 'data-sn-attr', 'data-sn-class', 'data-sn-style'];

/** A binding of a kind `prerender()` writes on `el`, outside templates or in them (no model, a class by name, a text without elements). */
function paintable(el: P5Element, b: Binding): boolean {
  // a text node: written by its binding, never into the HTML
  if (b.k === 'text' && b.n === '+') return false;
  if (b.f === undefined || b.e || b.w?.length || !['text', 'attr', 'class', 'style', 'show'].includes(b.k)) return false;
  if (b.k === 'class' && !b.n) return false;
  return !(b.k === 'text' && el.childNodes.some(isElement));
}

/**
 * What the runtime would write for value `v` of binding `b` on `el`, as `[kind, value]`, or FAIL
 * when it cannot be written ahead (an object, a refused URL or style, a select).
 */
export type Kind = 'text' | 'attr' | 'class' | 'style' | 'show' | 'checked' | 'value';

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
