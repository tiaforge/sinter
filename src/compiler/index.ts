import * as acorn from 'acorn';
import { tsPlugin } from '@sveltejs/acorn-typescript';
import { compileParts, type CompileOptions, type CompileResult, type CompiledParts, type EarlyParts, type FnSource, type FnSources, type HelperManifest, type HelperOrigin, type PrefetchParts, type EmbedSlot, type EmbedCond, type RuntimeReason } from './compile.js';
import { compactIR } from '../ir.js';
import { MappedLines, type SourceMap } from './sourcemap.js';
import { earlyRender } from './early-render.js';

export type { SourceMap };
export type { CompileOptions, CompileResult, CompiledParts, EarlyParts, FnSource, FnSources, HelperManifest, HelperOrigin, PrefetchParts, EmbedSlot, EmbedCond, RuntimeReason };
export type { Diagnostic } from './diagnostics.js';
export type { CheckUnit } from './check-unit.js';
export type { ImageFormat, ImageHost, ImageInfo, ImageKind, ImageResult, ImageVariant } from './images.js';
export { FLUID_WIDTHS, TINY_BYTES } from './images.js';
export { Layout, evaluate, type FixedBox, type FluidPiece, type FluidSizes, type StyleSheet } from './layout.js';
export { formatDiagnostic, docsUrl, CODES } from './diagnostics.js';
export { DIAGNOSTIC_DOCS, type DiagnosticDoc } from './diagnostic-docs.js';
export { compileParts };
export { COMPLEXITY_DEFAULTS, type ComplexityLimits, type ComplexityOptions } from './complexity.js';

export const PACKAGE = '@tiaforge-ui/sinter';
/** lazy packages' generated modules (lazy-build.ts): `<pkg>.js` is the loader */
const LAZY_PREFIX = '/@sinter/lazy/';
/** the built-in messages: a helper namespace with this module is sinter's `m` */
export const MESSAGES = `${PACKAGE}/messages`;

/** Compiles annotated HTML into a rewritten page and its page module. Pure and deterministic. */
export function compile(html: string, options: CompileOptions): CompileResult {
  const parts = compileParts(html, options);
  // the images' rules: imported, so the bundler puts them in the page's stylesheet (no request, no inline style)
  // and the components' scoped styles, the same way
  const css = (parts.images?.css && options.images?.stylesheet ? `import ${JSON.stringify(options.images.stylesheet)};\n` : '')
    + (options.componentCss ? parts.styles.map((x) => `import ${JSON.stringify(options.componentCss!(x.name))};\n`).join('') : '')
    // components with a script: their modules, which the `cmp` bindings hand to the components feature
    + parts.scripts.filter((x) => !x.lazy).map((x) => `import { ${x.export} as ${x.local} } from ${JSON.stringify(x.module)};\n`).join('')
    + lazyScripts(parts, options);
  const page = pageLines(parts, options);
  const out: CompileResult = {
    html: parts.html, module: css + page.text(), runtime: parts.runtime, preload: parts.preload, ...(parts.static ? { static: true as const } : {}),
    diagnostics: parts.diagnostics, files: parts.files, styles: parts.styles, prefetch: parts.prefetch, embed: parts.embed, path: parts.ir.path ?? [], ...(parts.prefetchOff ? { prefetchOff: true as const } : {}),
  };
  if (parts.check) out.check = parts.check;
  const lazy = parts.scripts.filter((x) => x.lazy);
  if (lazy.length) out.lazyScripts = lazy.map((x) => ({ module: x.module, lazy: x.lazy! }));
  const map = options.sourcemap ? page.map(parts.sources, css.split('\n').length - 1) : null;
  if (map) out.map = map;
  if (parts.images) out.images = parts.images;
  if (parts.remoteWidths) out.remoteWidths = parts.remoteWidths;
  // a page with nothing to run gets no early script either, not even for the app's early module
  if (parts.static && parts.early !== undefined) out.early = null;
  else if (parts.early !== undefined) setEarly(out, parts.early, options);
  if (parts.unlistedOrigins) out.unlistedOrigins = parts.unlistedOrigins;
  const ns = Object.entries(options.helpers.namespaces).find(([, v]) => v.module === MESSAGES)?.[0];
  if (ns) out.messages = parts.namespaces[ns] ?? [];
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
  return `import { later as $later } from '${PACKAGE}/lazy';\n`
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
 * The early page object's source, over the early table `f`: the early requests (`ir`), the table,
 * and the compiled renderer (early-render.ts); `uses`: the early module's exports it calls.
 */
export function earlyPage(early: EarlyParts): { code: string; uses: string[] } {
  const r = earlyRender(early.ir, early.fns);
  // a request's scope by the root whose state it is (the renderer keeps a scope only for nodes that open one)
  const res = early.ir.res?.map((x) => ({ ...x, scope: x.scope < 0 ? -1 : r.owner[x.scope]! }));
  const ir = { ...(res ? { res } : {}), ...(early.ir.path ? { path: early.ir.path } : {}), ...(early.ir.emb ? { emb: early.ir.emb } : {}) };
  // `$locale` read early: the page passes the configured locale source (else the early file carries no config)
  const lc = early.fns.some((x) => /\$\.\$locale\b/.test(x));
  return { code: `{ ir: ${JSON.stringify(ir)}, fns: f, scopes: ${r.scopes}, render: ${r.render}${lc ? ', locale' : ''} }`, uses: lc ? [...r.uses, 'locale'].sort() : r.uses };
}

function earlyLines(early: EarlyParts | null, options: Pick<CompileOptions, 'helpers' | 'early' | 'observe' | 'locale' | 'baseMessages'>): MappedLines | null {
  const observe = !!options.observe, fixed = isFixed(options);
  const app = options.early?.module ?? null;
  if (!early && !app) return null;
  const lines = new MappedLines();
  if (app) lines.push(`import ${JSON.stringify(app)};`);
  const req = !!early?.ir.res?.length, pages = !!early?.ir.res?.some((r) => r.q);
  const page = early ? earlyPage(early) : null;
  // a page with nothing to wait for (no requests, no messages, no app early module's dictionary): `run`, one step
  const simple = !!early && !observe && !req && (fixed || !Object.values(options.helpers.namespaces).some((n) => n.module === MESSAGES));
  lines.push(`import { ${[observe ? 'observe' : simple ? 'run' : 'start', ...(early ? ['$k', ...page!.uses] : []), ...(req ? ['requests', ...(app ? ['configured'] : [])] : []), ...(pages ? ['withParams'] : [])].join(', ')} } from '${PACKAGE}/early';`);
  let messages: string | null = null;
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
      if (info.module === MESSAGES) { messages = fixed ? fixedMessages(ns, members, options) : messagesImport(ns, members); continue; }
      for (const m of members) {
        const o = info.from?.[m];
        add(o?.module ?? info.module, `${o?.name ?? m} as ${ns}$${m}`);
      }
    }
  }
  // an app with built-in messages: the first paint waits for the dictionary (helpers may call `m` too)
  if (!messages && Object.values(options.helpers.namespaces).some((n) => n.module === MESSAGES)) messages = fixed ? fixedMessages('m', [], options) : messagesImport('m', []);
  for (const [mod, specs] of byModule) lines.push(`import { ${specs.join(', ')} } from ${JSON.stringify(mod)};`);
  // observe: the early script reads the dictionary's state (has it arrived?) from the messages module
  if (messages) lines.push(observe && !fixed ? messages.replace('ready as $ready }', 'ready as $ready, state as $state }') : messages);
  // a page in one language: its text is compiled in, nothing to wait for
  if (fixed) messages = null;
  lines.push('');
  if (early) {
    lines.push('const page = () => {', '  const f = [');
    early.fns.forEach((f, i) => lines.fn('    ', f, ',', early.sources?.fns[i]));
    lines.push('  ];', `  return ${page!.code};`, '};');
  }
  const args = `${early ? 'page' : 'null'}, ${messages ? `{ use: $use, ready: $ready${observe ? ', state: $state' : ''} }` : 'null'}${req ? `, requests(${pages ? 'withParams' : app ? 'undefined' : ''}${app ? ', configured' : ''})` : ''}`;
  // observe (builds): a classic head script, which starts the requests at once and renders as the parser goes
  lines.push(observe ? `observe(${args});` : simple ? 'run(page);' : `start(${args});`);
  return lines;
}

export function pageModule(parts: CompiledParts, options: Pick<CompileOptions, 'helpers' | 'dev' | 'config' | 'actions' | 'prefetch' | 'origins' | 'locale'>): string {
  return pageLines(parts, options).text();
}

function pageLines(parts: CompiledParts, options: Pick<CompileOptions, 'helpers' | 'dev' | 'config' | 'actions' | 'prefetch' | 'origins' | 'locale'>): MappedLines {
  const lines = new MappedLines();
  // the page module is `async`: it waits for the parse, and for the early file if the page has one
  const core = ['mount', '$k', parts.early ? 'rendered' : 'parsed', ...parts.helpers.builtin];
  lines.push(`import { ${core.join(', ')} } from '${PACKAGE}';`);
  // prefixed: a helper may be named as a feature (`keys`, `form`, …)
  for (const f of parts.features) lines.push(`import sn$${f} from '${PACKAGE}/${f}';`);
  // next-page data: the app's pages, described in one module every page shares
  const features = [...parts.features.map((f) => `sn$${f}`), ...(options.prefetch ? ['$prefetch'] : [])];
  if (options.prefetch) lines.push(`import $prefetch from ${JSON.stringify(options.prefetch)};`);
  if (parts.helpers.user.length && options.helpers.module) {
    lines.push(`import { ${parts.helpers.user.join(', ')} } from ${JSON.stringify(options.helpers.module)};`);
  }
  let messages = false;
  for (const [ns, members] of Object.entries(parts.namespaces)) {
    const mod = options.helpers.namespaces[ns]!.module;
    if (mod === MESSAGES) { lines.push(isFixed(options) ? fixedMessages(ns, members, options) : messagesImport(ns, members)); messages = true; continue; }
    lines.push(`import { ${members.map((m) => `${m} as ${ns}$${m}`).join(', ')} } from ${JSON.stringify(mod)};`);
  }
  // an app with built-in messages: the page's modules (helpers, actions, islands) may call `m` although
  // its markup does not, so every page waits for the dictionary (and sinter is the locale source)
  if (!messages && Object.values(options.helpers.namespaces).some((n) => n.module === MESSAGES)) {
    lines.push(isFixed(options) ? fixedMessages('m', [], options) : messagesImport('m', []));
    messages = true;
  }
  // a page in one language: the locale is fixed and its messages compiled in, so nothing waits for a dictionary
  if (isFixed(options)) messages = false;
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
  if (options.origins?.length) lines.push(`import { $origins } from '${PACKAGE}';`, `$origins(${JSON.stringify(options.origins)});`);
  // images from the API: the resizing service's URLs (docs/images.md, step 2)
  if (parts.remote) lines.push(`import { remote } from '${PACKAGE}/remote';`);
  lines.push('');
  if (parts.remote) lines.push(`const $ri = remote(${JSON.stringify(parts.remote)});`);
  lines.push(`const ir = ${JSON.stringify(compactIR(parts.ir))};`);
  lines.push('const fns = [');
  parts.fns.forEach((f, i) => lines.fn('  ', f, ',', parts.sources?.fns[i]));
  lines.push('];');
  lines.push('');
  // the early file renders part of this page: mount once it has (they meet through a global)
  // a page in one language records it: a language chooser at an unprefixed URL, or a server, sends the visitor back to it
  if (options.locale) lines.push(`document.cookie = ${JSON.stringify(`locale=${encodeURIComponent(options.locale.name)}; Path=/; Max-Age=31536000; SameSite=Lax`)};`);
  lines.push(parts.early ? 'await rendered();' : 'await parsed();');
  if (messages) {
    // sinter's messages are the locale source; the dictionary the early step loaded, once it is there
    lines.push('$use();', 'await $ready();', `$use(mount(document, { ir, fns, features: [${features.join(', ')}] }));`);
  } else lines.push(`mount(document, { ir, fns, features: [${features.join(', ')}] });`);
  return lines;
}

/** a page built in one language, with that language's text (`localePrefix`) */
const isFixed = (o: Pick<CompileOptions, 'locale' | 'baseMessages'>) => !!o.locale && !!o.baseMessages;

/**
 * A page in one language: each message it calls is a function of that language's text (`m$title = () => "Über uns"`,
 * `m$hi = (p = {}) => "Hallo " + …`), so no dictionary is loaded; `fixed` sets the locale (for `date()`, `number()`,
 * and the app's modules, whose messages the build writes into the page).
 */
function fixedMessages(ns: string, members: string[], options: Pick<CompileOptions, 'locale' | 'baseMessages'>): string {
  const d = options.baseMessages!;
  const fn = (s: string) => {
    const parts = s.split(/\{(\w+)\}/);
    if (parts.length === 1) return `() => ${JSON.stringify(s)}`;
    // a parameter missing at run time stays as written, as `t()` does
    return `(p = {}) => ${parts.map((x, i) => (i % 2 ? `(${JSON.stringify(x)} in p ? p[${JSON.stringify(x)}] : ${JSON.stringify(`{${x}}`)})` : JSON.stringify(x))).join(' + ')}`;
  };
  const imp = `import { fixed as $fixed } from '${MESSAGES}';\n$fixed(${JSON.stringify(options.locale!.name)});`;
  return members.length ? `${imp}\nconst ${members.map((m) => `${ns}$${m} = ${fn(d[m] ?? m)}`).join(', ')};` : imp;
}

/** The built-in messages a module calls: `m.key` bound to the names compiled code uses (`m$key`). */
function messagesImport(ns: string, members: string[]): string {
  const imp = `import { ${members.length ? 'm as $m, ' : ''}use as $use, ready as $ready } from '${MESSAGES}';`;
  return members.length ? `${imp}\nconst ${members.map((m) => `${ns}$${m} = $m.${m}`).join(', ')};` : imp;
}

/**
 * Reads a helpers module's export names statically. `export * as m from './x.js'`
 * becomes a namespace whose members are read from `x.js` the same way. `export * from './y.js'`
 * re-exports (e.g. paraglide's message index) are followed, relative paths only.
 */
export function readHelperManifest(
  source: string,
  options: { module: string; file: string; readFile: (path: string) => string; resolve?: (spec: string, from: string) => string | null },
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
    const from = path && spec.startsWith('.') ? fromOf(origin, path, modSpec) : null;
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

/** Value exports only: type-only exports (`export type`, `export interface`, `export { type X }`) are skipped. */
function exportsOf(source: string, file: string): ModuleExports {
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
