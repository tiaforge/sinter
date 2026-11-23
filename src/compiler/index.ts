import * as acorn from 'acorn';
import { canonical } from './canon.js';
import { tsPlugin } from '@sveltejs/acorn-typescript';
import { compileParts, pageHead, localSignIn, withoutFromWalk, requestUrl, type CompileOptions, type CompileResult, type CompiledParts, type EarlyParts, type FnSource, type FnSources, type HelperManifest, type HelperOrigin, type PrefetchParts, type EmbedSlot, type EmbedCond, type RuntimeReason } from './compile.js';
import { compactIR, type EarlyIR } from '../ir.js';
import { coreParts } from '../core-parts.js';
import { MappedLines, type SourceMap } from './sourcemap.js';
import { earlyRender } from './early-render.js';
import { runtimeApi } from './apis.js';

export type { SourceMap };
export type { CompileOptions, CompileResult, CompiledParts, EarlyParts, FnSource, FnSources, HelperManifest, HelperOrigin, PrefetchParts, EmbedSlot, EmbedCond, RuntimeReason };
export type { Code, Diagnostic } from './diagnostics.js';
export type { CheckUnit } from './check-unit.js';
export type { ImageFormat, ImageHost, ImageInfo, ImageKind, ImageResult, ImageVariant } from './images.js';
export { FLUID_WIDTHS, TINY_BYTES } from './images.js';
export { Layout, evaluate, type FixedBox, type FluidPiece, type FluidSizes, type StyleSheet } from './layout.js';
export { formatDiagnostic, formatWarning, applyStrict, strictPromotes, docsUrl, suggest, CODES, ENVIRONMENT_CODES, HEURISTIC_CODES } from './diagnostics.js';
export { DIAGNOSTIC_DOCS, type DiagnosticDoc } from './diagnostic-docs.js';
export { compileParts, pageHead };
export type { PageHead } from './compile.js';
export { COMPLEXITY_DEFAULTS, type ComplexityLimits, type ComplexityOptions } from './complexity.js';

export const PACKAGE = '@tiaforge-ui/sinter';
/** what compiled modules import: the core and each feature, `@tiaforge-ui/sinter/runtime/<feature>` */
export const RUNTIME = `${PACKAGE}/runtime`;
/** lazy packages' generated modules (lazy-build.ts): `<pkg>.js` is the loader */
const LAZY_PREFIX = '/@sinter/lazy/';
/** the built-in messages: a helper namespace with this module is sinter's `m` */
import { nsLocal } from './expr.js';
export const MESSAGES = `${PACKAGE}/messages`;
/**
 * The module a content namespace (`namespace()` in the content module, docs/proposals/messages.md §1) is registered
 * under in the helpers manifest: no module of its own, its members are its entries, which the page compiles in
 */
export const CONTENT_NS = 'sinter:content/';
/** whether a helpers manifest namespace's module is a content namespace's (the built-in messages included) */
export const isContentModule = (module: string) => module.startsWith(CONTENT_NS);


/** Compiles annotated HTML into a rewritten page and its page module. Pure and deterministic. */
export function compile(html: string, options: CompileOptions): CompileResult {
  // (docs/proposals/compile-once.md, (5)): every compile checked against itself linked, to find what linking misses
  // (with B1 off: each compares two routes of its own byte for byte, `withoutFromWalk`)
  if (env('SN_LINK_AUDIT') && !options.dev) return withoutFromWalk(() => (options.definitions ? auditedLink(html, options) : audited(html, options)));
  if (env('SN_UNITS_AUDIT') && !options.dev && !options.describeOnly) return withoutFromWalk(() => auditedUnits(html, options));
  return compileOne(html, options);
}

/**
 * `SN_UNITS_AUDIT=1` (docs/proposals/redesign-notes/stage4-units.md): the page compiled without units, and through a
 * build's units: where it makes them, where it places them, and placed into the same page under another name and in
 * another folder; each must be the page compiled without them, every field. The first difference throws.
 */
function auditedUnits(html: string, options: CompileOptions): CompileResult {
  const plain = compileOne(html, { ...options, units: undefined });
  const units = options.units ?? new Map<string, unknown>();
  const made = compileOne(html, { ...options, units });
  const placed = compileOne(html, { ...options, units });
  differs('through units, where made', options.file, plain, made);
  differs('through units, where placed', options.file, plain, placed);
  // (not where helpers fold, whose calls are kept per file; not a kept template's, which the caller counts)
  if (!options.helperValues) for (const file of [options.file.replace(/([^/]*)$/, 'sn-audit-$1'), options.file.replace(/([^/]*)$/, 'sn-audit/$1')]) {
    differs(`through units, placed into ${file}`, file, compileOne(html, { ...options, file, templates: undefined, units: undefined }), compileOne(html, { ...options, file, templates: undefined, units }));
  }
  return plain;
}

/** a compile that links (a build's, `definitions`): the same page compiled on its own beside it, which it must be */
function auditedLink(html: string, options: CompileOptions): CompileResult {
  const alone = compileOne(html, { ...options, definitions: undefined }), linked = compileOne(html, options);
  // (a kept template's type check goes with its first entry's compile only, here the one before: the same unit,
  // the kept template's, which the build is handed as without the audit)
  if (options.templates && options.check) {
    differs('linked in its build', options.file, { ...alone, check: undefined }, { ...linked, check: undefined });
    if (!(alone.check && !linked.check)) return linked;
    const out = { ...linked, check: alone.check }, later = LATER.get(linked);
    if (later) LATER.set(out, later);
    return out;
  }
  differs('linked in its build', options.file, alone, linked);
  return linked;
}

/** the first place two results differ, thrown */
function differs(what: string, file: string, x: CompileResult, y: CompileResult) {
  const text = (r: CompileResult) => JSON.stringify(r, (_, v) => (typeof v === 'function' ? '[fn]' : v instanceof Map ? [...v] : v instanceof Set ? [...v] : v));
  const a = text(x), b = text(y);
  if (a === b) return;
  let i = 0;
  while (a[i] === b[i]) i++;
  throw new Error(`sinter link audit: ${file}: ${what} differs at ${i}:\n  compiled ${a.slice(Math.max(0, i - 120), i + 120)}\n  linked   ${b.slice(Math.max(0, i - 120), i + 120)}`);
}

/** an environment variable, where there is one (the compiler has no Node imports of its own) */
const node = (globalThis as { process?: { env: Record<string, string | undefined>; getBuiltinModule?: (m: string) => unknown } }).process;
const env = (k: string) => node?.env[k];

/**
 * `SN_LINK_AUDIT=1`: the page compiled as always, and again through a cache of shared definitions (seen, then recorded,
 * then linked). The two must be the same, every field; the first difference throws. The page compiled as always is returned.
 */
function audited(html: string, options: CompileOptions): CompileResult {
  const plain = compileOne(html, options);
  // linked into the page as it is (three rounds: a definition seen, recorded, linked), and into the same page under another
  // name and in another folder (the plans the first recorded: numbered alike, the file not), each against that page compiled
  const definitions = new Map<string, unknown>();
  const named = options.file.replace(/([^/]*)$/, 'sn-audit-$1'), moved = options.file.replace(/([^/]*)$/, 'sn-audit/$1');
  const linked: CompileResult[] = [], others: Array<[string, CompileResult, CompileResult]> = [];
  // what linking did, for the log (`SN_LINK_AUDIT_LOG=<file>`: one line per page)
  type Stats = { hits: number; recorded: number; refused: string[]; missed?: number };
  const g = globalThis as { __snLink?: Stats };
  const was = g.__snLink, st: Stats = { hits: 0, recorded: 0, refused: [], missed: 0 };
  let last: Stats = { hits: 0, recorded: 0, refused: [] };
  // (not the caller's kept templates: what the caller counts of them is its own compile's; a kept walk gives the same page)
  try {
    for (let i = 0; i < 3; i++) {
      g.__snLink = { hits: 0, recorded: 0, refused: [], missed: 0 };
      linked.push(compileOne(html, { ...options, templates: undefined, definitions }));
      last = g.__snLink;
      st.hits += last.hits; st.recorded += last.recorded; st.refused.push(...last.refused); st.missed! += last.missed ?? 0;
    }
    // (not where helpers fold: their calls are kept per file, and a caller counts them)
    if (!options.helperValues) for (const [what, file] of [['under another name', named], ['in another folder', moved]] as const) {
      g.__snLink = { hits: 0, recorded: 0, refused: [] };
      others.push([`linked into the page ${what}`, compileOne(html, { ...options, file, templates: undefined }), compileOne(html, { ...options, file, templates: undefined, definitions })]);
    }
  } finally {
    g.__snLink = was;
    const log = env('SN_LINK_AUDIT_LOG');
    if (log) (node?.getBuiltinModule?.('node:fs') as { appendFileSync(f: string, s: string): void } | undefined)?.appendFileSync(log, JSON.stringify({ file: options.file, linked: last.hits, recorded: st.recorded, refused: st.refused }) + '\n');
  }
  // the same page again links what it recorded: a plan that does not hold on its own page is a recording that missed
  // something (and a check that links nothing checks nothing)
  if (st.missed) throw new Error(`sinter link audit: ${options.file}: a plan recorded on this page does not link into it again`);
  if (st.recorded && !last.hits) throw new Error(`sinter link audit: ${options.file}: ${st.recorded} definitions recorded, none linked in the third round`);
  for (const [what, x, y] of [['compiled where first seen', plain, linked[0]!], ['recorded', plain, linked[1]!], ['linked', plain, linked[2]!], ...others] as const) differs(what, options.file, x, y);
  return plain;
}

/** (`prefetchLater`) each result's page module written with another `prefetch`, and its description's `prefetch` */
const LATER = new WeakMap<CompileResult, { module: (prefetch: string | null) => { module: string; map?: SourceMap }; described: NonNullable<CompiledParts['firstPrefetch']> }>();

/**
 * A build's page compiled with `prefetchLater`: its page module (and source map) as `compile` writes it with this
 * `prefetch` instead of the one it was given (everything else of the page is the same), or null for a result that
 * was not (`moduleWith(out, options.prefetch)` is `out`'s own module).
 */
export function moduleWith(out: CompileResult, prefetch: string | null): { module: string; map?: SourceMap } | null {
  return LATER.get(out)?.module(prefetch) ?? null;
}

/**
 * A build's page compiled with `prefetchLater`: what another page can request ahead for it as its description
 * (`describeOnly`) gives it, read off its first pass; `{ why }` where that is not known there; null for a result that
 * was not compiled with `prefetchLater`.
 */
export function describedPrefetch(out: CompileResult): NonNullable<CompiledParts['firstPrefetch']> | null {
  return LATER.get(out)?.described ?? null;
}

function compileOne(html: string, options0: CompileOptions): CompileResult {
  const raw = compileParts(html, options0);
  // `SN_CANON=1` (redesign-notes/stage5-assembly.md, step 0): the output in its canonical numbering, to count what a
  // step that renumbers would change, and to compare two builds up to numbering (the app audits' `--canon`)
  const parts = env('SN_CANON') === '1' && !options0.dev ? { ...canonical(raw), ...(raw.check ? { check: raw.check } : {}) } : raw;
  // a content namespace loaded per axis: its entries at the page's point, as the compile resolved them
  const options = parts.contentNs ? { ...options0, contentNs: parts.contentNs } : options0;
  // the images' rules: imported, so the bundler puts them in the page's stylesheet (no request, no inline style)
  // and the components' scoped styles, the same way
  const css = (parts.images?.css && options.images?.stylesheet ? `import ${JSON.stringify(options.images.stylesheet)};\n` : '')
    + (parts.paint && options.paintCss ? `import ${JSON.stringify(options.paintCss)};\n` : '')
    + (options.componentCss ? parts.styles.map((x) => `import ${JSON.stringify(options.componentCss!(x.name))};\n`).join('') : '')
    // components with a script: their modules, which the `cmp` bindings hand to the components feature
    + parts.scripts.filter((x) => !x.lazy).map((x) => `import { ${x.export} as ${x.local} } from ${JSON.stringify(x.module)};\n`).join('')
    + lazyScripts(parts, options);
  const page = pageLines(parts, options);
  const out: CompileResult = {
    html: parts.html, module: css + page.text(), runtime: parts.runtime, preload: parts.preload, ...(parts.static ? { static: true as const } : {}),
    diagnostics: parts.diagnostics, files: parts.files, ...(parts.globs ? { globs: parts.globs } : {}), ...(parts.pages ? { pages: parts.pages } : {}), ...(parts.axes ? { axes: parts.axes } : {}), ...(options.contentNs ? { contentNs: options.contentNs } : {}), styles: parts.styles, prefetch: parts.prefetch, embed: parts.embed, path: parts.ir.path ?? [], ...(parts.ir.urlArrays ? { urlArrays: parts.ir.urlArrays } : {}), ...(parts.prefetchOff ? { prefetchOff: true as const } : {}), ...(parts.loadEffect ? { loadEffect: parts.loadEffect } : {}), ...(parts.permanent ? { permanent: parts.permanent, ...(parts.keptSource ? { keptSource: parts.keptSource } : {}), ...(parts.keptBound ? { keptBound: parts.keptBound } : {}) } : {}), ...(parts.swapOff ? { swapOff: true as const } : {}),
    ...(parts.ir.urlReads ? { sameLinks: true as const } : {}),
    // the parts of the core the page module uses (a site's core keeps their union: src/core-parts.ts)
    ...(parts.static ? {} : { core: coreParts(parts.ir) }),
  };
  if (parts.check) out.check = parts.check;
  const lazy = parts.scripts.filter((x) => x.lazy);
  if (lazy.length) out.lazyScripts = lazy.map((x) => ({ module: x.module, lazy: x.lazy! }));
  const map = options.sourcemap ? page.map(parts.sources, css.split('\n').length - 1) : null;
  if (map) out.map = map;
  if (options.prefetchLater) LATER.set(out, {
    module: (prefetch) => {
      const again = pageLines(parts, { ...options, prefetch });
      const m = options.sourcemap ? again.map(parts.sources, css.split('\n').length - 1) : null;
      return { module: css + again.text(), ...(m ? { map: m } : {}) };
    },
    described: parts.firstPrefetch ?? { why: 'no first pass' },
  });
  if (parts.images) out.images = parts.images;
  if (parts.paint !== undefined) out.paint = parts.paint;
  if (parts.unheld) out.unheld = parts.unheld;
  if (parts.waits) out.waits = parts.waits;
  if (parts.remoteWidths) out.remoteWidths = parts.remoteWidths;
  // a page with nothing to run gets no early script either, not even for the app's early module
  if (parts.static && parts.early !== undefined) out.early = null;
  else if (parts.early !== undefined) setEarly(out, parts.early, options);
  if (parts.unlistedOrigins) out.unlistedOrigins = parts.unlistedOrigins;
  return out;
}

/**
 * Component scripts that reach lazy packages: imported when an instance is first rendered, with the
 * packages, apart from the page bundle (`later`: the module and the packages' loaders at once, and the
 * script chunk's URL for the stale check, which the build writes in place of the mark).
 */
function lazyScripts(parts: CompiledParts, options: CompileOptions): string {
  const list = parts.scripts.filter((x) => x.lazy);
  if (!list.length) return '';
  const specs = [...new Set(list.flatMap((x) => x.lazy!))].sort();
  const loader = (s: string) => `$ls$${specs.indexOf(s)}`;
  const file = (m: string) => `${options.root.replace(/\/$/, '')}${m}`;
  return `import { later as $later } from '${RUNTIME}/lazy';\n`
    + specs.map((s) => `import { load as ${loader(s)} } from ${JSON.stringify(`${LAZY_PREFIX}${s}.js`)};\n`).join('')
    + list.map((x) => `const ${x.local} = $later(() => import(${JSON.stringify(x.module)}).then((m) => m[${JSON.stringify(x.export)}]), [${x.lazy!.map(loader).join(', ')}], ${options.dev ? 'null' : JSON.stringify(`__SN_CHUNK__${file(x.module)}__`)}, import.meta.url);\n`).join('');
}

function setEarly(out: CompileResult, early: EarlyParts | null, options: CompileOptions) {
  const lines = earlyLines(early, options);
  out.early = lines && lines.text();
  const map = lines && options.sourcemap ? lines.map(early?.sources) : null;
  if (map) out.earlyMap = map; else delete out.earlyMap;
}

/**
 * The page's early module: the app's early module first (it runs before any binding, e.g. to pick
 * the language), then the early bindings with only the helpers they call, started by `start()`
 * (with the built-in messages' locale source and wait, if the app has them). Null when there is
 * neither.
 */
export function earlyModule(early: EarlyParts | null, options: Pick<CompileOptions, 'helpers' | 'early' | 'observe'>): string | null {
  return earlyLines(early, options)?.text() ?? null;
}

/**
 * The early requests as code (early.ts `Requests`): per request, its URL as the page module's request layer will have
 * it, written out (`urlCode`: the literals, each value encoded; `$href` for a template of another shape), its `when`
 * before it, a paginated list's first-page parameters after it (literal text, a numbered list's page from the URL as an
 * expression; `withParams` when the template has a query of its own, which the pager's parameters are merged into),
 * and its API's settings. `uses`: the early module's exports it calls.
 */
export function earlyRequests(res: NonNullable<EarlyIR['res']>, as: EarlyIR['as']): { code: string; uses: string[] } {
  const uses = new Set<string>();
  const lines = res.map((r) => {
    const s = r.scope < 0 ? 'b' : `n[${r.scope}]`;
    const vals: string[] = [];
    for (const p of r.src) if (typeof p === 'number') vals[p] = `f[${p}](${s})`;
    let u = requestUrl(r.src, vals, r.q, r.sp ? { ...r.sp, code: `f[${r.sp.f}](${s})` } : undefined, uses);
    if (r.when != null) u = `f[${r.when}](${s}) && ${u}`;
    const args = [`() => ${u}`, r.a != null ? `a[${r.a}]` : '', r.r ? '1' : '', r.lo ? '1' : ''];
    while (args.at(-1) === '') args.pop();
    return `q(${args.map((x) => x || '0').join(', ')})`;
  });
  return { code: `(q, n, b${as?.length ? `, a = ${JSON.stringify(as)}` : ''}) => { ${lines.join('; ')}; }`, uses: [...uses] };
}

/**
 * The early page object's source, over the early table `f`: the early requests (`ir`), the table,
 * and the compiled renderer (early-render.ts); `uses`: the early module's exports it calls.
 */
export function earlyPage(early: EarlyParts): { code: string; uses: string[] } {
  const r = earlyRender(early.ir, early.fns);
  // a request's scope by the root whose state it is (the renderer keeps a scope only for nodes that open one)
  const res = early.ir.res?.map((x) => ({ ...x, scope: x.scope < 0 ? -1 : r.owner[x.scope]! }));
  const req = res ? earlyRequests(res, early.ir.as) : null;
  const ir = { ...(early.ir.path ? { path: early.ir.path } : {}), ...(early.ir.urlArrays ? { urlArrays: early.ir.urlArrays } : {}), ...(early.ir.emb ? { emb: early.ir.emb } : {}), ...(early.ir.si ? { si: early.ir.si } : {}) };
  // `$locale` read early: the page passes the configured locale source (else the early file carries no config)
  const lc = early.fns.some((x) => /\$\.\$locale\b/.test(x)), ls = !!early.ir.urlArrays;
  // a link's URL template (`data-sn-href`) rendered early: the early module fills it as the page module does
  const hr = ['$href', '$hq', '$hv'].filter((h) => early.fns.some((x) => x.includes(`${h}(`)));
  // array parameters: the page passes `lists` (else the early file carries none of it)
  // `data-sn-signed-in`: the page passes the guard (else the early file carries none of it); `signIn` a path, the one
  // without loginRedirect's options
  const away = early.ir.si ? (typeof early.ir.si.i == 'string' ? 'away' : 'awayVia') : null;
  const extra = [...(lc ? ['locale'] : []), ...(ls ? ['lists'] : []), ...(away ? [away] : [])];
  // a resource that needs its API's token: its early status reads whether one is stored
  // (and the guard, which the page passes it)
  const so = away || early.fns.some((x) => x.includes('$so(')) ? ['$so'] : [];
  const more = [...extra, ...hr, ...so, ...(req?.uses ?? [])];
  const uses = more.length ? [...new Set([...r.uses, ...more])].sort() : r.uses;
  return { code: `{ ir: ${JSON.stringify(ir)}, fns: f, scopes: ${r.scopes}, render: ${r.render}${req ? `, req: ${req.code}` : ''}${extra.map((x) => (x == away ? `, away: (o, b) => ${x}(o, b, $so)` : ', ' + x)).join('')} }`, uses };
}

function earlyLines(early: EarlyParts | null, options: Pick<CompileOptions, 'helpers' | 'early' | 'observe' | 'locale' | 'contentNs'>): MappedLines | null {
  const observe = !!options.observe;
  const app = options.early?.module ?? null;
  if (!early && !app) return null;
  const lines = new MappedLines();
  if (app) lines.push(`import ${JSON.stringify(app)};`);
  const req = !!early?.ir.res?.length;
  const page = early ? earlyPage(early) : null;
  // a page with nothing to wait for (no requests): `run`, one step
  const simple = !!early && !observe && !req;
  lines.push(`import { ${[observe ? 'observe' : simple ? 'run' : 'start', ...(early ? ['$k', ...page!.uses] : []), ...(req ? ['requests', ...(app ? ['configured'] : [])] : [])].join(', ')} } from '${RUNTIME}/early';`);
  const byModule = new Map<string, string[]>();
  if (early) {
    // each from the module that declares it: past the helpers module and barrels, whose other
    // exports (a namespace object of every message) would otherwise load before the first paint
    const add = (mod: string, spec: string) => byModule.set(mod, [...(byModule.get(mod) ?? []), spec]);
    const as = (o: HelperOrigin, local: string) => (o.name === local ? local : `${o.name} as ${local}`);
    if (options.helpers.module) for (const h of early.helpers) {
      const o = options.helpers.from?.[h];
      add(o?.module ?? options.helpers.module, o ? as(o, h) : h);
    }
    for (const [ns, members] of Object.entries(early.namespaces)) {
      const info = options.helpers.namespaces[ns]!;
      if (isContentModule(info.module)) { lines.push(contentLines(ns, members, options)); continue; }
      for (const m of members) {
        const o = info.from?.[m];
        add(o?.module ?? info.module, `${o?.name ?? m} as ${ns}$${m}`);
      }
    }
  }
  for (const [mod, specs] of byModule) lines.push(`import { ${specs.join(', ')} } from ${JSON.stringify(mod)};`);
  // the early renderers of the components whose uses render early (docs/components.md#early-renderers): only this page's
  for (const [local, mod] of Object.entries(early?.renderers ?? {})) lines.push(`import ${local} from ${JSON.stringify(mod)};`);
  // the built-in formatters the early bindings call, from the package (not the early runtime, which the build shares
  // between pages): each early file bundles only those it calls, beside the messages module that sets its locale
  // (in the page's language, when it has one: `$lang`)
  if (early?.formatters?.length) {
    lines.push(`import { ${[...early.formatters, ...(options.locale ? ['$lang'] : [])].join(', ')} } from '${RUNTIME}';`);
    if (options.locale) lines.push(`$lang(${JSON.stringify(options.locale.name)});`);
  }
  lines.push('');
  if (early) {
    lines.push('const page = () => {', '  const f = [');
    early.fns.forEach((f, i) => lines.fn('    ', f, ',', early.sources?.fns[i]));
    lines.push('  ];', `  return ${page!.code};`, '};');
  }
  const args = `${early ? 'page' : 'null'}${req ? `, requests(${app ? 'configured' : ''})` : ''}`;
  // observe (builds): a classic head script, which starts the requests at once and renders as the parser goes
  lines.push(observe ? `observe(${args});` : simple ? 'run(page);' : `start(${args});`);
  return lines;
}

export function pageModule(parts: CompiledParts, options: Pick<CompileOptions, 'helpers' | 'dev' | 'config' | 'actions' | 'prefetch' | 'origins' | 'locale' | 'apis' | 'swap' | 'swapList'> & Partial<Pick<CompileOptions, 'root'>>): string {
  return pageLines(parts, options).text();
}

function pageLines(parts: CompiledParts, options: Pick<CompileOptions, 'helpers' | 'dev' | 'config' | 'actions' | 'prefetch' | 'origins' | 'locale' | 'apis' | 'swap' | 'swapList'> & Partial<Pick<CompileOptions, 'root'>>): MappedLines {
  const lines = new MappedLines();
  // the page module is `async`: it waits for the parse, and for the early file if the page has one
  const core = ['mount', '$k', parts.early ? 'rendered' : 'parsed', ...parts.helpers.builtin, ...(options.locale ? ['$lang'] : [])];
  lines.push(`import { ${core.join(', ')} } from '${RUNTIME}';`);
  // a page in one language: the locale the formatters use, the app's and the page's
  if (options.locale) lines.push(`$lang(${JSON.stringify(options.locale.name)});`);
  // prefixed (a helper may be named as a feature: `keys`, `form`, …), and an identifier (`query-links` is `sn$query_links`)
  const local = (f: string) => `sn$${f.replace(/-/g, '_')}`;
  for (const f of parts.features) lines.push(`import ${local(f)} from '${RUNTIME}/${f}';`);
  // next-page data: the app's pages, described in one module every page shares
  // swaps: the stub with the build's list, on every page that swaps (not one that opts out)
  const swaps = !!options.swap && !parts.swapOff;
  const features = [...parts.features.map(local), ...(options.prefetch ? ['$prefetch'] : []), ...(swaps && options.swapList ? ['$swap'] : [])];
  if (options.prefetch) lines.push(`import $prefetch from ${JSON.stringify(options.prefetch)};`);
  if (swaps && options.swapList) lines.push(`import $swap from ${JSON.stringify(options.swapList)};`);
  // each helper from the module that declares it, as the early file imports them: past the helpers module and
  // barrels, so a module that reaches a lazy package loads only when a let needs it (docs/lazy.md)
  for (const [ns, members] of Object.entries(parts.namespaces)) if (isContentModule(options.helpers.namespaces[ns]!.module)) lines.push(contentLines(ns, members, options));
  lines.push(...helperImports(parts.helpers.user, parts.namespaces, options.helpers));
  // helper modules that reach lazy packages: each loads whole, with its packages, when a let first needs it
  if (parts.lazyHelpers.length) {
    const specs = [...new Set(parts.lazyHelpers.flatMap((x) => x.lazy))].sort();
    const loader = (s: string) => `$lp$${specs.indexOf(s)}`;
    const file = (m: string) => `${(options.root ?? '').replace(/\/$/, '')}${m}`;
    lines.push(`import { later as $laterH } from '${RUNTIME}/lazy';`);
    for (const s of specs) lines.push(`import { load as ${loader(s)} } from ${JSON.stringify(`${LAZY_PREFIX}${s}.js`)};`);
    for (const x of parts.lazyHelpers) lines.push(`const ${x.local} = $laterH(() => import(${JSON.stringify(x.module)}), [${x.lazy.map(loader).join(', ')}], ${options.dev || !x.module.startsWith('/') ? 'null' : JSON.stringify(`__SN_CHUNK__${file(x.module)}__`)}, import.meta.url);`);
  }
  // actions (`data-sn-call`): imported as `$a$name` / `$a$ns$member`, only those the page calls
  const acts = options.actions;
  if (acts?.module) {
    const direct = parts.calls.filter((c) => !c.includes('.'));
    if (direct.length) lines.push(`import { ${direct.map((c) => `${c} as $a$${c}`).join(', ')} } from ${JSON.stringify(acts.module)};`);
    const byNs = new Map<string, string[]>();
    for (const c of parts.calls.filter((x) => x.includes('.'))) {
      const [ns, member] = c.split('.') as [string, string];
      byNs.set(ns, [...(byNs.get(ns) ?? []), member]);
    }
    for (const [ns, members] of byNs) {
      lines.push(`import { ${members.map((x) => `${x} as $a$${ns}$${x}`).join(', ')} } from ${JSON.stringify(acts.namespaces[ns]!.module)};`);
    }
  }
  // lazy packages the markup loads when an element is rendered (`data-sn-import`): their loaders
  for (const x of parts.lazy) lines.push(`import { load as ${x.local} } from ${JSON.stringify(`${LAZY_PREFIX}${x.spec}.js`)};`);
  if (options.config) lines.push(`import ${JSON.stringify(options.config)};`);
  // the build's origins join the runtime's allowlist, after the app's config module (imports run first): listed once
  if (options.origins?.length) lines.push(`import { $origins } from '${RUNTIME}';`, `$origins(${JSON.stringify(options.origins)});`);
  // `sinter({ apis })`: the runtime sends each API's credentials and headers, and `apiOf(url)` names a request's API
  if (options.apis?.list.length) {
    const table = options.apis.list.map((a) => runtimeApi(a.token?.signIn && options.locale ? { ...a, token: { ...a.token, signIn: localSignIn(a.token.signIn, options.locale) } } : a));
    lines.push(`import { $apis } from '${RUNTIME}';`, `$apis(${JSON.stringify(table)});`);
    // an API with a token: the request layer sends it (src/token.ts); other apps carry none of it
    // (a `signIn` of loginRedirect's options: its target function; a path needs none of it)
    if (table.some((a) => a.t)) lines.push(...(table.some((a) => typeof a.t?.i == 'object')
      ? [`import { $tokens, signInTarget } from '${RUNTIME}/token';`, '$tokens(signInTarget);'] : [`import { $tokens } from '${RUNTIME}/token';`, '$tokens();']));
  }
  // images from the API: the resizing service's URLs (docs/images.md, step 2)
  if (parts.remote) lines.push(`import { remote } from '${RUNTIME}/remote';`);
  lines.push('');
  if (parts.remote) lines.push(`const $ri = remote(${JSON.stringify(parts.remote)});`);
  lines.push(`const ir = ${JSON.stringify(compactIR(parts.ir))};`);
  lines.push('const fns = [');
  parts.fns.forEach((f, i) => lines.fn('  ', f, ',', parts.sources?.fns[i]));
  lines.push('];');
  lines.push('');
  // a page in one language records it: a language chooser at an unprefixed URL, or a server, sends the visitor back to it
  const cookie = options.locale && options.locale.prefix !== false ? `document.cookie = ${JSON.stringify(`locale=${encodeURIComponent(options.locale.name)}; Path=/; Max-Age=31536000; SameSite=Lax`)};` : null;
  const opts = `{ ir, fns, features: [${features.join(', ')}] }`;
  // the early file renders part of this page: mount once it has (they meet through a global)
  const wait = parts.early ? 'await rendered();' : 'await parsed();';
  if (swaps) {
    // swaps on (docs/proposals/swap-navigation.md §6): the mount is registered under the module's URL (an app
    // build keeps no exports of a page's entry), for the swap to call when it swaps this page in (the module
    // imported once, the mount run per visit), with the names the page keeps; the module mounts itself only
    // on a load, not when the swap imports it
    const body = `${cookie ? `${cookie} ` : ''}return mount(document, $page);`;
    lines.push(`const $page = ${opts};`, `const $boot = () => { ${body} };`);
    lines.push(`(globalThis[Symbol.for('sinter.pages')] ??= {})[import.meta.url] = { boot: $boot, kept: ${JSON.stringify(parts.permanent ?? [])} };`);
    lines.push(`if (!globalThis[Symbol.for('sinter.swapping')]) { ${wait} await $boot(); }`);
    return lines;
  }
  if (cookie) lines.push(cookie);
  lines.push(wait);
  lines.push(`mount(document, ${opts});`);
  return lines;
}

/**
 * The imports of the helpers and namespace members compiled code calls (`h`, `ns$m`), each from the module that
 * declares it, as the early file imports them: past the helpers module and barrels, so a module that reaches a
 * lazy package is not loaded with the page (docs/lazy.md). The built-in messages are imported apart.
 */
export function helperImports(user: Iterable<string>, namespaces: Record<string, Iterable<string>>, helpers: HelperManifest): string[] {
  const byModule = new Map<string, string[]>();
  const add = (mod: string, spec: string) => byModule.set(mod, [...(byModule.get(mod) ?? []), spec]);
  if (helpers.module) for (const h of user) {
    const o = helpers.from?.[h];
    add(o?.module ?? helpers.module, o && o.name !== h ? `${o.name} as ${h}` : h);
  }
  for (const [ns, members] of Object.entries(namespaces)) {
    const info = helpers.namespaces[ns]!;
    if (isContentModule(info.module)) continue;
    for (const m of members) { const o = info.from?.[m]; add(o?.module ?? info.module, `${o?.name ?? m} as ${ns}$${m}`); }
  }
  return [...byModule].map(([mod, specs]) => `import { ${specs.join(', ')} } from ${JSON.stringify(mod)};`);
}


/**
 * A content namespace's entries the page calls (docs/proposals/messages.md §1), compiled in: each `ns$id` a function of
 * its entry in the page's language, through the namespace's formatter module (`format(entry, args, locale)`), or for
 * the built-in `{param}` form a function of its text, as the messages are.
 */

function contentLines(ns: string, members: string[], options: Pick<CompileOptions, 'contentNs' | 'locale'>): string {
  const spec = options.contentNs?.[ns];
  if (!spec || !members.length) return '';
  if (spec.format === null) return `const ${members.map((m) => `${nsLocal(ns, m)} = ${fillFn(typeof spec.entries[m] === 'string' ? spec.entries[m] as string : m)}`).join(', ')};`;
  const f = `$fmt$${ns}`, l = JSON.stringify(options.locale?.name ?? null);
  // what the formatter compiles in place (`inline`), else a call of it with the entry
  const code = members.map((m) => [m, spec.inlineFn?.(spec.entries[m]) ?? null] as const);
  const call = (m: string) => `(p) => ${f}(${JSON.stringify(spec.entries[m] ?? null).replace(/</g, '\\u003c')}, p, ${l})`;
  return `${code.some(([, c]) => c === null) ? `import { format as ${f} } from ${JSON.stringify(spec.format)};\n` : ''}const ${code.map(([m, c]) => `${nsLocal(ns, m)} = ${c ?? call(m)}`).join(', ')};`;
}

/** a `{param}` text as a function of its parameters (a parameter missing at run time stays as written, as `t()` does) */
function fillFn(s: string): string {
  const parts = s.split(/\{(\w+)\}/);
  if (parts.length === 1) return `() => ${JSON.stringify(s)}`;
  return `(p = {}) => ${parts.map((x, i) => (i % 2 ? `(${JSON.stringify(x)} in p ? p[${JSON.stringify(x)}] : ${JSON.stringify(`{${x}}`)})` : JSON.stringify(x))).join(' + ')}`;
}

/**
 * Reads a helpers module's export names statically. `export * as m from './x.js'`
 * becomes a namespace whose members are read from `x.js` the same way. `export * from './y.js'`
 * re-exports (e.g. paraglide's message index) are followed, relative paths only.
 */
export function readHelperManifest(
  source: string,
  options: {
    module: string; file: string; readFile: (path: string) => string; resolve?: (spec: string, from: string) => string | null;
    /**
     * the specifier of a module inside a package the helpers re-export (a component library): members declared
     * past the package's entry are imported, checked for folding and for lazy packages, from their own module
     */
    moduleOf?: (file: string) => string | null;
  },
): HelperManifest {
  const manifest: HelperManifest = { module: options.module, names: [], namespaces: {} };
  const resolve = options.resolve ?? ((spec: string, from: string) => (spec.startsWith('.') ? joinPath(from, spec) : null));
  const read = (file: string): ModuleExports | null => {
    try { return exportsOf(options.readFile(file), file); } catch { return null; }
  };
  /** the module's own value exports plus those of its `export *` re-exports, transitively; `origin`: name → declaring file and name */
  const valueNames = (file: string, exports: ModuleExports, seen: Set<string>, origin?: Map<string, { file: string; name: string }>): string[] => {
    const names = new Set(exports.names);
    for (const n of exports.names) {
      if (origin?.has(n)) continue;
      const re = exports.named.get(n), at = re && re.spec.startsWith('.') ? resolve(re.spec, file) : null;
      origin?.set(n, at ? { file: at, name: re!.name } : { file, name: n });
    }
    for (const spec of exports.reexports) {
      const path = spec.startsWith('.') ? resolve(spec, file) : null;
      if (!path || seen.has(path)) continue;
      seen.add(path);
      const sub = read(path);
      if (sub) for (const n of valueNames(path, sub, seen, origin)) names.add(n);
    }
    return [...names].sort();
  };
  const top = exportsOf(source, options.file);
  const own = new Map<string, { file: string; name: string }>();
  manifest.names = valueNames(options.file, top, new Set([options.file]), own);
  const fromOf = (origin: Map<string, { file: string; name: string }>, file: string, spec: string) => {
    const from: Record<string, HelperOrigin> = {};
    for (const [n, o] of origin) if (o.file !== file) from[n] = { module: joinPath(spec, relPath(file, o.file)), name: o.name };
    return Object.keys(from).length ? from : null;
  };
  /** a package's members by their declaring modules, as `moduleOf` names them */
  const packageFrom = (origin: Map<string, { file: string; name: string }>, file: string, moduleOf: (f: string) => string | null) => {
    const from: Record<string, HelperOrigin> = {};
    for (const [n, o] of origin) { const m = o.file !== file ? moduleOf(o.file) : null; if (m) from[n] = { module: m, name: o.name }; }
    return Object.keys(from).length ? from : null;
  };
  const topFrom = fromOf(own, options.file, options.module);
  if (topFrom) manifest.from = topFrom;
  for (const [ns, spec] of top.namespaces) {
    const path = resolve(spec, options.file);
    const exports = path ? read(path) : null;
    const origin = new Map<string, { file: string; name: string }>();
    const members = path && exports ? valueNames(path, exports, new Set([path]), origin) : [];
    const modSpec = spec.startsWith('.') ? joinPath(options.module, spec) : spec;
    manifest.namespaces[ns] = { module: modSpec, members };
    // members declared in a re-exported module (a barrel such as paraglide's message index makes a
    // namespace object; importing past it keeps the early chunk to what it calls)
    const from = !path ? null : spec.startsWith('.') ? fromOf(origin, path, modSpec) : options.moduleOf ? packageFrom(origin, path, options.moduleOf) : null;
    if (from) manifest.namespaces[ns]!.from = from;
  }
  return manifest;
}

interface ModuleExports {
  /** value exports declared or listed in the module itself */
  names: string[];
  /** `export * as ns from 'spec'` */
  namespaces: Array<[string, string]>;
  /** `export * from 'spec'` */
  reexports: string[];
  /** `export { name as exported } from 'spec'`, by exported name */
  named: Map<string, { spec: string; name: string }>;
}

/** acorn extended with TypeScript syntax, for `.ts` helper and namespace modules (and the LSP's extract refactoring) */
let tsParser: typeof acorn.Parser | null = null;

export function parseModule(source: string, file: string): acorn.Program {
  const options: acorn.Options = { ecmaVersion: 'latest', sourceType: 'module' };
  if (!/\.[cm]?tsx?$/.test(file)) return acorn.parse(source, options);
  tsParser ??= acorn.Parser.extend(tsPlugin() as never);
  return tsParser.parse(source, options) as acorn.Program;
}

// the helpers and actions manifests are read for every page and hook: a module is parsed once per file and text
const exportsCache = new Map<string, { source: string; exports: ModuleExports }>();

/** Value exports only: type-only exports (`export type`, `export interface`, `export { type X }`) are skipped. */
function exportsOf(source: string, file: string): ModuleExports {
  const hit = exportsCache.get(file);
  if (hit?.source === source) return hit.exports;
  const exports = parseExports(source, file);
  exportsCache.set(file, { source, exports });
  return exports;
}

function parseExports(source: string, file: string): ModuleExports {
  const ast = parseModule(source, file);
  const names: string[] = [];
  const namespaces: Array<[string, string]> = [];
  const reexports: string[] = [];
  const named = new Map<string, { spec: string; name: string }>();
  const typeOnly = (n: unknown) => (n as { exportKind?: string }).exportKind === 'type';
  for (const st of ast.body) {
    if (typeOnly(st)) continue;
    if (st.type === 'ExportNamedDeclaration') {
      const d = st.declaration;
      if (d?.type === 'FunctionDeclaration' && d.id) names.push(d.id.name);
      else if (d?.type === 'ClassDeclaration' && d.id) names.push(d.id.name);
      else if ((d?.type as string) === 'TSEnumDeclaration') names.push((d as unknown as { id: { name: string } }).id.name);
      else if (d?.type === 'VariableDeclaration') {
        for (const v of d.declarations) if (v.id.type === 'Identifier') names.push(v.id.name);
      }
      for (const s of st.specifiers) {
        if (typeOnly(s)) continue;
        const exported = s.exported.type === 'Identifier' ? s.exported.name : String(s.exported.value);
        if (exported !== 'default') names.push(exported);
        const local = s.local.type === 'Identifier' ? s.local.name : String(s.local.value);
        if (st.source && exported !== 'default' && local !== 'default') named.set(exported, { spec: String(st.source.value), name: local });
      }
    } else if (st.type === 'ExportAllDeclaration' && st.exported) {
      const ns = st.exported.type === 'Identifier' ? st.exported.name : String(st.exported.value);
      namespaces.push([ns, String(st.source.value)]);
    } else if (st.type === 'ExportAllDeclaration') {
      reexports.push(String(st.source.value));
    }
  }
  return { names: [...new Set(names)].sort(), namespaces, reexports, named };
}

/** `to` relative to the directory of `from` (both absolute, `/`-separated), as `./x.js` or `../y/x.js` */
function relPath(from: string, to: string): string {
  const a = from.split('/').slice(0, -1), b = to.split('/');
  let i = 0;
  while (i < a.length && i < b.length - 1 && a[i] === b[i]) i++;
  const up = a.length - i;
  return (up ? '../'.repeat(up) : './') + b.slice(i).join('/');
}

function joinPath(from: string, spec: string): string {
  const dir = from.slice(0, from.lastIndexOf('/') + 1);
  const out: string[] = [];
  for (const seg of (dir + spec).split('/')) {
    if (seg === '.') continue;
    if (seg === '..') out.pop(); else out.push(seg);
  }
  return out.join('/');
}
