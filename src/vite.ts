// Vite adapter: a thin wrapper around compile(). Every HTML entry is compiled
// in transformIndexHtml; its page module is served as a virtual module. With
// first paint on, each page also gets an early script: classic scripts first in the
// head (one shared by every page, one of the page's own) that render what needs no
// data as the parser inserts it, before the first paint, with nothing render-blocking.
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, join, posix, relative, resolve, sep } from 'node:path';
import { gzipSync } from 'node:zlib';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { loadEnv, type Plugin, type ResolvedConfig, type ViteDevServer } from 'vite';
import { collectionsIn, loadContent, writeSnapshot, type LoadedContent } from './content-node.js';
import { applyStrict, CODES, compile, formatDiagnostic, formatWarning, strictPromotes, suggest, type Code, type CheckUnit, type Diagnostic, type CompileResult, type SourceMap } from './compiler/index.js';
import { lazyOf, project, staticPages, strictOf, type ProjectOptions } from './project.js';
import { CHUNK_MARK, chainText, isComponentScript, LAZY, lazyHelpers, lazyPackage, lineCol, loaderModule, mentions, parseLazyId, reachLazy, rewriteLazy, scanLazy, stubModule } from './lazy-build.js';
import { I18N_PICKER, languageFile, moduleKeys, type MessagesProject } from './i18n-build.js';
import { HOLD_SCRIPT } from './paint-build.js';
import { loadImages, MIME, type Images } from './images.js';
import { pageStyles } from './styles.js';
import { detectEngines, type StyleEngine } from './engines.js';
import { IMAGE_CHECK } from './image-check.js';
import type { RuntimeWarning } from './dev.js';
import { rewriteCssImages, type CssImageHost } from './css-images.js';
import { resolveRemote, type RemoteImages } from './remote.js';
import { devRemote, remoteMiddleware } from './remote-dev.js';
import type { EmbedSlot, ImageHost, ImageVariant, PrefetchParts, RuntimeReason, StyleSheet } from './compiler/index.js';
import { hasCspMeta, movesToDirectory, pageFile, pagePaths, pageUrl, prefetchModule, speculationRules, withRulesHash } from './prefetch-build.js';
import { type SwapPage, swapModule } from './swap-build.js';
import { pageRoutes, rebaseHtml, redirectHtml, redirectsFile, relocateHtml, type PageEntry, type Route } from './page-urls.js';
import { chooserHtml, hreflangTags, readLocales, type Locales } from './locales-build.js';
import { canonicalOf, fillPattern, noindex, sitemapFiles, sitemapOf, type SitemapOptions, type SitemapUrl } from './sitemap-build.js';
import { familyLineHeights, familyZeroWidths } from './font-metrics.js';
import { faceName, faceOf, fontDownloader, fontFileDownloader, inlineFonts, preloadFonts, preloadLocalFonts, usesFamily, type FontFaceRef, type FontPreload } from './fonts-build.js';
import { componentBase } from './components-build.js';
import { COMPONENT_NAME, LIBRARY_LAYER } from './compiler/components.js';
import { componentsOf, libraryOf } from './libraries.js';
import { LAYERS_SHEET, type FoldArg } from './compiler/compile.js';
import { docsUrl } from './compiler/diagnostics.js';
import { crossCheck, crossMessage, hashOf, type FoldCall } from './fold-cross.js';
import { apiOrigins } from './compiler/apis.js';
import { loadHelpers, loadingHelpers, unloadedMessage, type NodeHelpers } from './helpers-node.js';
import { FoldCache } from './fold-check.js';

export interface SinterOptions extends ProjectOptions {
  /** run `sinter check` at the end of `vite build` and fail it on type errors (needs TypeScript) */
  typecheck?: boolean;
  /**
   * first paint (default true): each page gets an early script (the app's `src/sinter.early.ts`, then
   * the bindings that need no data): classic scripts first in the head, which render each element as
   * the parser inserts it (`observe` in early.ts), and paginated lists hold their rows' space. `false`:
   * those wait for the page module. Build-time constants (and the base language's messages) are written
   * into the HTML either way, and a page with nothing to run ships no JavaScript either way.
   */
  firstPaint?: boolean;
  /**
   * builds: minify each page's HTML (default true; never in dev): the author's comments out, and the
   * white space the page's stylesheets show to render nothing (docs/minify.md). Before the page is compiled, so
   * sinter's own comments and node paths are counted on the minified markup.
   */
  minifyHtml?: boolean;
  /** an early file above this many bytes gzip is a build warning (default 10000) */
  earlyBudget?: number;
  /**
   * static images (default on, needs sharp): every `<img src>` of a local JPEG, PNG, WebP or AVIF
   * becomes a `<picture>` with AVIF or lossless WebP, widths for each screen, dimensions and lazy
   * loading (docs/images.md). `false`: images stay as written; `widths`: the widths of fluid images
   */
  images?: false | {
    widths?: number[];
    /**
     * images from the API (docs/images.md, step 2): an `<img>` whose `src` is bound to data gets a
     * `srcset` of a resizing service's URLs. `url`: a template (`{url}`, `{url:raw}`, `{w}`, `{q}`)
     * or a preset (`cloudflare`, `vercel`, `netlify`, `imgproxy:<base URL>`); `cover`: a template
     * with `{h}` for boxes cropped by `object-fit: cover`; `origins`: the only image origins sent
     * through it (`'self'` and origins). In dev the dev server resizes instead.
     */
    remote?: RemoteImages;
  };
  /**
   * Speculation Rules for links to the app's pages (Chromium): `'prefetch'` (default) fetches the
   * next page's HTML while the pointer rests on a link; `'prerender'` loads and runs the whole page
   * (data included, streams connect once it is shown); `false`: none. The rules are an inline
   * script in every page, so they need no server setup; a CSP the page declares in a `<meta>` gets
   * their hash from the build, a CSP sent as a response header needs `'inline-speculation-rules'`
   * in `script-src` (dev builds warn when it blocks them). `{ mode, delivery: 'header' }` writes
   * `speculation-rules.json` at the site root for a `Speculation-Rules` response header instead,
   * which no CSP blocks: the server sends the header with every page and the file as
   * `application/speculationrules+json` (`vite dev` and `vite preview` do both). See docs/navigation.md.
   */
  speculation?: 'prefetch' | 'prerender' | false | { mode: 'prefetch' | 'prerender'; delivery?: 'inline' | 'header' };
  /**
   * `_redirects` in the build (Netlify, Cloudflare Pages): a 301 from each moved page's old file URL and a
   * rewrite from each path a page declares with `data-sn-path`, after the app's own `public/_redirects`.
   * Default `true`; `false` leaves the file out (docs/static-pages.md#page-urls)
   */
  redirects?: boolean;
  /**
   * The site's origin (`'https://example.com'`, no path: a site under a path sets Vite's `base`). With it,
   * `$site` and `$canonical` work in expressions and every page whose URL is known gets a canonical link
   * (docs/static-pages.md#canonical-urls)
   */
  site?: string;
  /**
   * `sitemap.xml` in the build, with `site` (docs/static-pages.md#sitemap): every page with a fixed URL that may be
   * indexed (not `noindex`, its canonical link its own URL), with its languages as alternates. `paths` gives the
   * values of pages whose path has parameters, by pattern (`{ '/article/:slug': () => slugs() }`); a page without
   * them is left out, and the build says so. `false` leaves the file out; an app's own `public/sitemap.xml` is kept.
   */
  sitemap?: false | SitemapOptions;
  /**
   * Languages in the URL (docs/static-pages.md#languages): each page is built once per language of the inlang
   * project, under its prefix (`about.html` as `/en/about/` and `/de/about/`), with that language's text in the
   * HTML; each unprefixed URL (`/about/`, `/`) is a language chooser. Needs the built-in messages, with
   * `baseLocale` among `locales`
   */
  localePrefix?: boolean;
  /**
   * next-page data (default true): when a link to another page of the app is about to be followed,
   * that page's data is requested, and the page shows it at once (then revalidates). `false`: off.
   */
  prefetch?: boolean;
  /**
   * Builds served by a server that writes each page's data into it (sinter-axum): every resource whose
   * request only the page's URL decides gets a placeholder in the head, and the browser neither preloads
   * nor requests it early, since the data comes with the page. Not `call`, `each`, or `early="off"` (a
   * request a middleware changes, such as one with the user's token). `sinter-embed.json` lists them.
   * `vite dev` is unaffected: there is no server there to fill them.
   */
  embed?: boolean;
  /**
   * Other origins the app's resources, actions and streams may use: every page adds them to the
   * runtime's allowlist (as `configure({ origins })` would; list them here only), and their resources
   * with a literal `src` are preloaded or requested before the page module, like same-origin ones
   * (without credentials, as the request layer sends them). A resource on an origin listed only in
   * `configure({ origins })` waits for the page module; the build names those origins.
   * `<sn-resource early="off">` keeps one resource out (one a request middleware answers or adds a
   * header to).
   */
  origins?: string[];
  /**
   * Google Fonts (default `{ inline: true }`, builds only): a page's `<link rel="stylesheet"
   * href="https://fonts.googleapis.com/…">` is downloaded at build time and bundled as one of the app's
   * own CSS assets (a file, not an inline style: no CSP change), and the page preconnects to the
   * origin of its font files. The fonts, their `font-display` and the look stay as they are: one
   * render-blocking request to another origin less, and the font files' connection is open when they
   * are requested (as the Angular CLI does). Downloads are cached in `node_modules/.cache/sinter/fonts`;
   * a build that cannot download one keeps the link and warns. `{ inline: false }`: off.
   *
   * `preload` (opt-in, default none): faces to preload, each a family name (its regular face, 400
   * normal) or `{ family, weight, style }`. A page whose Google Fonts stylesheets have the face gets
   * `<link rel="preload" as="font">` for its Latin file after `<meta charset>`, in builds and in dev;
   * in builds, a face they do not have is looked up in the `@font-face` rules of the page's own
   * bundled CSS (a self-hosted font, e.g. Fontsource: use the family it declares).
   * The build fails when a page preloads a face of a family none of its stylesheets uses (a
   * `font-family` or `font` declaration, outside `@font-face`, directly or through a custom property), or when no page has the face at all;
   * in dev, sinter warns when the page did not render with the face in its first frames (a preload
   * competes with what the first paint needs, and when the font is slow it can hold the first paint).
   */
  fonts?: { inline?: boolean; preload?: FontPreload[] };
}

type SinterPlugins = [Plugin & { api: { options: SinterOptions; source(file: string): string } }, Plugin, Plugin, Plugin, Plugin, Plugin];

/** dev: the pages under the root (not in node_modules, the output, `public/`, hidden folders, or the components' and layouts' folders) */
function htmlPages(root: string, config: ResolvedConfig | null): string[] {
  const skip = new Set(['node_modules', resolve(root, config?.build.outDir ?? 'dist'), config?.publicDir ?? resolve(root, 'public'), resolve(root, 'src/components'), resolve(root, 'src/layouts')].map((x) => resolve(root, x)));
  const out: string[] = [];
  const walk = (dir: string) => {
    let names: string[];
    try { names = readdirSync(dir); } catch { return; }
    for (const n of names) {
      const f = join(dir, n);
      if (n.startsWith('.') || n === 'node_modules' || skip.has(f)) continue;
      let st;
      try { st = statSync(f); } catch { continue; }
      if (st.isDirectory()) walk(f);
      else if (n.endsWith('.html')) out.push(f);
    }
  };
  walk(root);
  return out.sort();
}

/** `_redirects` lines: `from to [status]` (302 when left out), comments and blank lines skipped */
function parseRedirects(text: string): Array<{ from: string; to: string; status: number }> {
  return text.split('\n').map((l) => l.replace(/\s+#.*$/, '').trim()).filter((l) => l && !l.startsWith('#')).flatMap((l) => {
    const [from, to, status] = l.split(/\s+/);
    const n = Number((status ?? '302').replace(/!$/, ''));
    return from && to && n ? [{ from, to, status: n }] : [];
  });
}

/** a base Vite resolves per file (`./`, ''): its URLs are relative to the page or stylesheet */
const relativeBase = (base: string) => base === '' || base.startsWith('.');
/** the base for URLs in the page at `rel` (root-relative): a relative base becomes the way up to the root */
const pageBase = (base: string, rel: string) => (relativeBase(base) ? '../'.repeat(rel.split('/').length - 1) || './' : base);

const PREFIX = '/@sinter/';

/**
 * Dev, strict: sends the page's runtime warnings to the dev server, which prints them in the terminal
 * and shows them in Vite's overlay. It takes the ones kept before it loaded (`warningSink` in dev.ts).
 */
const WARN_RELAY = `const sink = (globalThis[Symbol.for('sinter.warnings')] ??= { list: [], on: null });
const send = (w) => { if (import.meta.hot) import.meta.hot.send('sinter:warn', { ...w, page: location.pathname }); };
for (const w of sink.list.splice(0)) send(w);
sink.on = send;
`;
const EARLY = `${PREFIX}early/`;

/**
 * The early runtime (`@tiaforge-ui/sinter/early`) is in the shared head script, once for every page:
 * it puts the exports the pages call on this global, and each page's head script takes them from it
 * (this module stands for the runtime in a page's build).
 */
const RT_KEY = 'sinter.early.rt';
const RT_ID = '\0sinter:early-rt';
const EARLY_PKG = '@tiaforge-ui/sinter/early';
/** the runtime's exports a page's early module imports (the compiler names each it calls) */
const runtimeNames = (code: string) => /import \{([^}]*)\} from '@tiaforge-ui\/sinter\/early'/.exec(code)?.[1]!.split(',').map((x) => x.trim()).filter(Boolean) ?? [];
/** the page's image rules (a CSS module the page module imports) */
const IMG_CSS = `${PREFIX}img-css/`;
/** builds: a page's reserved-space rules (docs/first-paint.md#reserved-space), imported by its module */
const PAINT_CSS = `${PREFIX}paint-css/`;
/** a component's scoped styles, imported by the page modules of the pages that use it */
const COMPONENT_CSS = `${PREFIX}component-css/`;
/** the base class a component's script imports from its HTML (`import { TaskRingComponent } from './task-ring.html'`) */
const COMPONENT_BASE = `${PREFIX}component-base/`;
/** dev: where the image variants are served */
const IMG = `${PREFIX}img/`;
const PREFETCH = `${PREFIX}prefetch.js`;
/** with swaps on: the pages that swap (swap-build.ts) */
const SWAP = `${PREFIX}swap.js`;
/** `speculation: { delivery: 'header' }`: the rules file, at the site root */
const RULES_FILE = 'speculation-rules.json';
/** build: the pages' embedded-data placeholders, for a server that fills them per request (sinter-axum) */
const EMBED_FILE = 'sinter-embed.json';
/** build: the placeholders as TypeScript types, next to the manifest, for the server layer (`@tiaforge-ui/sinter/server`) */
const EMBED_TYPES = 'sinter-embed.d.ts';

/** `sinter-embed.d.ts`: per page, each placeholder's resource and whether the build describes its request (`true`) */
function embedTypes(pages: Array<{ file: string; data: EmbedSlot[] }>): string {
  const page = (p: { file: string; data: EmbedSlot[] }) =>
    `    ${JSON.stringify(p.file)}: {${p.data.map((d) => ` ${JSON.stringify(d.resource)}: ${d.src != null && d.when !== true};`).join('')} };`;
  return `// The build's data placeholders, written by sinter's Vite plugin with sinter-embed.json: for embed<Build>() from
// '@tiaforge-ui/sinter/server' (true: the build describes the request; false: it needs an entry in \`data\`).
export interface Build {
  pages: {
${pages.map(page).join('\n')}
  };
}
`;
}

export default function sinter(options: SinterOptions = {}): SinterPlugins {
  // the Vite server sinter starts to load the helpers module in Node (helpers-node.ts): nothing of sinter runs in it
  if (loadingHelpers()) return [{ name: 'sinter', api: { options, source: (f: string) => f } }, { name: 'sinter:post' }, { name: 'sinter:css-images' }, { name: 'sinter:fonts' }, { name: 'sinter:font-check' }, { name: 'sinter:pages' }];
  let root = process.cwd();
  /**
   * The project (its helpers, components, libraries, specs) as a build sees it: read once per build, from its start, where
   * every page asked again (`project()` scans the components and libraries and reads the helpers' manifest). Before a build
   * starts and in dev, read afresh, as files change.
   */
  let buildProject: ReturnType<typeof project> | null = null;
  const proj = () => buildProject ?? project(root, options);
  let dev = false;
  let server: ViteDevServer | null = null;
  let resolved: ResolvedConfig | null = null;
  const modules = new Map<string, string>();
  /** each page and early module's source map: from the compiled expressions back to the markup */
  const maps = new Map<string, SourceMap>();
  const setModule = (id: string, code: string, map: SourceMap | undefined) => {
    modules.set(id, code);
    if (map) maps.set(id, map); else maps.delete(id);
  };
  /** whether two paths name one file (a link and its target too) */
  const sameFile = (a: string, b: string | null) => {
    if (!b) return false;
    if (resolve(a) === resolve(b)) return true;
    try { return realpathSync(a) === realpathSync(b); } catch { return false; }
  };
  /**
   * One classic script (IIFE) from an early module's `code`, with nothing imported: builds (the shared head script
   * and each page's) and the dev server (a page's whole early script). `rt`: the runtime's exports it takes from the
   * shared head script's global (`runtimeId`: the runtime's resolved id); null: the runtime is bundled in. `map`: the
   * module's own (dev), carried into the script's (the entry then has a plain id: Rolldown drops a `\0` module's map).
   */
  const earlyScript = async (code: string, keys: Set<string>, rt: string[] | null, what: string, runtimeId: string | null = null, map?: SourceMap) => {
        const r = resolved!, ENTRY = `${PREFIX}early-entry.js`, entryId = map ? ENTRY : '\0' + ENTRY;
        const vite = await appVite(), rolldown = 'rolldownVersion' in vite;
        const out = await vite.build({
          configFile: false, root, base: r.base, mode: dev ? 'development' : r.mode, logLevel: 'silent', publicDir: false, define: r.define,
          resolve: { alias: r.resolve.alias, conditions: r.resolve.conditions },
          plugins: [{
            name: 'sinter:early-entry', enforce: 'pre',
            async resolveId(id, importer, o) {
              if (id === ENTRY) return entryId;
              if (!rt || id === RT_ID) return null;
              // the runtime, however it is named (an alias may resolve the package to its source)
              if (id === EARLY_PKG) return RT_ID;
              const res = await this.resolve(id, importer, { ...o, skipSelf: true });
              return res && runtimeId && res.id === runtimeId ? RT_ID : null;
            },
            load: (id) => (id === entryId ? (map ? { code, map } : code) : id === RT_ID ? `const R = globalThis[Symbol.for(${JSON.stringify(RT_KEY)})];\nexport const { ${rt!.join(', ')} } = R;\n` : null),
            transform(src, id) {
              if (messages && !id.includes('/node_modules/') && /\.[cm]?[jt]sx?$/.test(id)) for (const k of moduleKeys(src, id).keys) keys.add(k);
              // the helpers module's re-exports of lazy packages: an early binding calls its own helpers, never
              // the barrel's copy of a namespace, which would put the package in the early file (as lazyTransform)
              if (lazyPkgs.length && sameFile(id.replace(/[?#].*$/, ''), proj().helpersFile) && mentions(src, lazyPkgs)) {
                const s = scanLazy(src, id, lazyPkgs, true);
                if (s.drop?.length) return { code: rewriteLazy(src, { ...s, lazy: [] }), map: null };
              }
              return null;
            },
          }],
          build: {
            write: false, minify: dev ? false : r.build.minify, target: r.build.target, sourcemap: !!map, modulePreload: false, copyPublicDir: false, reportCompressedSize: false,
            // one file: dynamic imports inlined. Vite 8 bundles with Rolldown (`codeSplitting: false`; it
            // deprecates `inlineDynamicImports`), Vite 6 and 7 with Rollup, which knows only the latter.
            [rolldown ? 'rolldownOptions' : 'rollupOptions']: {
              input: ENTRY,
              output: { format: 'iife', ...(rolldown ? { codeSplitting: false } : { inlineDynamicImports: true }) },
            },
          },
        });
        const output = (Array.isArray(out) ? out[0] : out) as { output: Array<{ type: string; fileName: string; code?: string; map?: SourceMap | null; modules?: Record<string, { renderedLength: number }> }> };
        const chunks = output.output.filter((c) => c.type === 'chunk');
        if (chunks.length !== 1) throw new Error(`sinter: the early script of ${what} came out as ${chunks.length} chunks; it must be one file with nothing imported`);
        // the map's sources are relative to where the script would have been written: absolute, as the page module's
        const c = chunks[0]!, at = resolve(root, r.build.outDir, posix.dirname(c.fileName));
        if (c.map) c.map.sources = c.map.sources.map((x) => (x && !x.startsWith('\0') ? resolve(at, x) : x));
        return { code: c.code!, map: c.map ?? null, modules: c.modules ?? {} };
  };
  /** dev: each page's early script, bundled when first requested (cleared when a watched file changes) */
  const devEarly = new Map<string, Promise<{ code: string; map: SourceMap | null }>>();
  /** dev: the early module `key` (`/@sinter/early/<page>.js`) as one classic script, the runtime bundled in, as in builds */
  const devScript = (key: string) => {
    const code = modules.get(key)!;
    let js = devEarly.get(code);
    if (!js) devEarly.set(code, (js = earlyScript(code, new Set(), null, key.slice(EARLY.length, -3), null, maps.get(key))));
    return js;
  };
  /**
   * The app's own Vite, the one running this build: resolved from the root, so a sinter linked into the
   * app (`npm link`, a symlinked checkout) does not use a second copy from its own node_modules, whose
   * `preprocessCSS` would start a Sass compiler the build never closes (the process would not exit)
   */
  let viteModule: Promise<typeof import('vite')> | null = null;
  const appVite = () => (viteModule ??= (async () => {
    try { return (await import(pathToFileURL(createRequire(resolve(root, 'package.json')).resolve('vite')).href)) as typeof import('vite'); } catch { return import('vite'); }
  })());
  const watched = new Set<string>();
  const units = new Map<string, CheckUnit>();
  const firstPaint = options.firstPaint !== false;
  /** `lazy`: the packages loaded on first call (checked before Vite starts), and each one's resolved id (its chunk's facade) */
  const lazyPkgs = lazyOf(options.lazy);
  const lazyIds = new Map<string, string>();
  /** each page's `data-sn-preload` packages, and its component scripts that load with lazy packages, by its path relative to the root */
  const preloadOf = new Map<string, string[]>();
  const lazyScriptsOf = new Map<string, Array<{ module: string; lazy: string[] }>>();
  /** builds: the component scripts that load with lazy packages, logged once each with the chain that made them lazy */
  const loggedScripts = new Set<string>();
  /** the lazy packages a component script reaches (`/src/components/x.ts`); a build logs why it loads with them */
  const lazyScript = (module: string): string[] => {
    const file = resolve(root, '.' + module);
    const r = reachLazy(file, lazyPkgs, root, undefined, undefined, false, proj().libraries);
    if (r.length && !dev && !loggedScripts.has(module)) {
      loggedScripts.add(module);
      resolved?.logger.info(`sinter: ${relOf(file)} loads with ${r.map((x) => x.spec).join(', ')}, when its component first renders: ${r.map((x) => chainText(root, x)).join('; ')}`);
    }
    return r.map((x) => x.spec);
  };
  /** `site`: the origin, checked (no path, no query) */
  const siteOrigin = (() => {
    if (options.site == null) return null;
    let u: URL;
    try { u = new URL(options.site); } catch { throw new Error(`sinter({ site }): \`${options.site}\` is not a URL; write the origin, e.g. 'https://example.com'`); }
    if (!/^https?:$/.test(u.protocol) || u.pathname !== '/' || u.search || u.hash) throw new Error(`sinter({ site }): \`${options.site}\` is not an origin; write it without a path (a site served under a path sets Vite's \`base\`), e.g. '${u.origin}'`);
    return u.origin;
  })();
  /** `sitemap`, checked */
  const sitemapOptions = sitemapOf(options.sitemap, siteOrigin);
  /** the page's `$site`, `$canonical` (null for a page whose paths all have parameters) and origin */
  const urlsOf = (rel: string, patterns: string[]) => {
    const b = resolved?.base?.startsWith('/') ? resolved.base : '/';
    const url = pageUrl(rel, b, patterns);
    return { site: siteOrigin! + b.replace(/\/$/, ''), canonical: url === null ? null : siteOrigin! + url, origin: siteOrigin! };
  };
  /** a page's `data-sn-path` patterns, from its description */
  const out0Path = (file: string) => describe(file).path;
  /** pages that use `data-sn-transition`: they get the hold script (paint-build.ts) */
  const holdPages = new Set<string>();
  /**
   * build: the classic head scripts, first in the head. One shared by every page (the language picker, the early
   * runtime and the app's early module; cached across pages) and each page's own (the hold script, the page's early
   * bindings and requests): two parallel requests, run in order, before the stylesheets
   */
  let sharedHead: { fileName: string; code: string; modules: Record<string, { renderedLength: number }> } | null = null;
  const headFiles = new Map<string, string>();
  /** build: the pages with an early module, and each one's bundled early script */
  const earlyPages = new Map<string, string>();
  /** build: each page's embedded-data placeholders and the paths it answers at, by file */
  const embedPages = new Map<string, { file: string; paths: string[]; arrays?: string[]; data: EmbedSlot[] }>();
  /** origins of resources that could have been requested early, not listed in `origins` (reported once per build) */
  const unlisted = new Set<string>();
  const earlyFiles = new Map<string, { code: string; modules: Record<string, { renderedLength: number }> }>();
  /** the app's early module (`src/sinter.early.ts`), which the shared head script runs */
  let appEarly: string | null = null;
  const budget = options.earlyBudget ?? 10_000;
  /** built-in messages: keys each module calls (`m.key`), keys each page's markup calls, and each page's language files */
  const moduleMessages = new Map<string, string[]>();
  const markupMessages = new Map<string, string[]>();
  const languageFiles = new Map<string, Record<string, { fileName: string; code: string }>>();
  /** `localePrefix`: a page's messages its app modules call (its own are compiled in), written into its head */
  const pageMessages = new Map<string, string>();
  const messagesTag = (dict: Record<string, string>) => `<script type="application/json" data-sn-messages>${JSON.stringify(dict).replace(/</g, '\\u003c')}</script>`;
  let messages: MessagesProject | null = null;
  let images: Images | null = null;
  // a template or origin that cannot work fails before Vite starts
  const remoteConfig = options.images && options.images.remote ? resolveRemote(options.images.remote) : null;
  /** build: the widths the pages ask the resizing service for (Vercel accepts only the ones it is told) */
  const remoteWidths = new Set<number>();
  /** image variants by file name, and each page's image rules */
  const variants = new Map<string, ImageVariant>();
  const imageCss = new Map<string, string>();
  const paintCss = new Map<string, string>();
  const componentCss = new Map<string, string>();
  let resolveId: ((id: string, importer?: string) => Promise<string | undefined>) | null = null;
  let engines: StyleEngine[] | null = null;
  const warned = new Set<string>();
  /** strict mode (docs/strict.md): the option with SINTER_STRICT applied, refused before Vite starts when invalid */
  const strict = strictOf(options.strict);
  const allowed = new Set(strict.allow.keys());
  /** build, strict: the build's warnings, which fail it once it has finished (all of them, not the first) */
  const strictFailures = new Set<string>();
  /** a build warning with its code; in a strict build it is also kept to fail the build */
  const coded = (code: Code, message: string) => {
    const text = formatWarning(code, message);
    if (strict.on && !dev && strictPromotes(code) && !allowed.has(code)) strictFailures.add(text);
    return text;
  };
  /**
   * The helpers module in Node, with what of it may fold (helpers-node.ts): loaded once before the pages compile, in dev by
   * the dev server's SSR environment, and again after one of the files it reaches changes. A failure warns once (SN533).
   */
  let nodeHelpers: Promise<NodeHelpers> | null = null, helpersNow: NodeHelpers | null = null, warnedHelpers = false;
  const foldCache = new FoldCache();
  const helpersReady = async () => {
    const p = proj();
    const h = await (nodeHelpers ??= loadHelpers({ root, helpersFile: p.helpersFile, manifest: p.helpers, server: dev ? server : null, ...(resolved ? { configFile: resolved.configFile ?? false, mode: resolved.mode, ...(resolved.configFile ? {} : { alias: resolved.resolve.alias }) } : {}), cache: foldCache }));
    if (h.error && p.helpersFile && !warnedHelpers) { warnedHelpers = true; resolved?.logger.warn(coded('SN533', unloadedMessage(root, p.helpersFile, h.error))); }
    return (helpersNow = h);
  };
  /** a page's or the options' diagnostics, with strict mode's promotions */
  const strictly = (ds: Diagnostic[]): Diagnostic[] => (strict.on ? applyStrict(ds, allowed) : ds);
  const warnOnce = (m: string) => { if (!warned.has(m)) { warned.add(m); resolved!.logger.warn(m); } };
  /** a stylesheet as Vite compiles it: Sass, Less, Stylus, the project's PostCSS, `@import` */
  const failedCss = new Set<string>();
  const compileCss = async (code: string, file: string) => {
    const { preprocessCSS } = await appVite();
    try {
      const out = await preprocessCSS(code, file, resolved!);
      return { code: out.code, deps: [...(out.deps ?? [])] };
    } catch (e) {
      // e.g. a .scss file without sass installed: the build reports it; here its sizes are unknown
      if (!failedCss.has(file)) { failedCss.add(file); resolved!.logger.warn(coded('SN527', `image sizes from ${relOf(file)} are not read: ${(e as Error).message.split('\n')[0]}`)); }
      return null;
    }
  };
  // Google Fonts' stylesheets and files, for the fonts' metrics (cached where the fonts plugin caches them)
  let fontCss: ((url: string) => Promise<string | null>) | null = null, fontFile: ((url: string) => Promise<Uint8Array | null>) | null = null;
  /** `line-height: normal` of the families the stylesheets declare, from their files: local ones, data: URIs, Google Fonts' */
  const fontBytes = new Map<string, Promise<Uint8Array | null>>();
  const lineHeightsOf = (styles: StyleSheet[]) => familyLineHeights(styles, (url, sheet) => {
    const key = `${sheet}\0${url}`;
    let p = fontBytes.get(key);
    if (!p) fontBytes.set(key, (p = readFont(url, sheet)));
    return p;
  });
  /** the width of `0` in the families the stylesheets declare, for images in a box sized in `ch` (dev and builds alike) */
  const zeroWidthsOf = (styles: StyleSheet[]) => familyZeroWidths(styles, (url, sheet) => {
    const key = `${sheet}\0${url}`;
    let p = fontBytes.get(key);
    if (!p) fontBytes.set(key, (p = readFont(url, sheet)));
    return p;
  });
  const readFont = async (url: string, sheet: string): Promise<Uint8Array | null> => {
    if (url.startsWith('data:')) { const m = /^data:[^,]*;base64,(.*)$/s.exec(url); return m ? new Uint8Array(Buffer.from(m[1]!, 'base64')) : null; }
    if (/^https?:\/\//i.test(url)) return (fontFile ??= fontFileDownloader(resolve(root, 'node_modules/.cache/sinter/fonts/files')))(url);
    const path = decodeURI(url.replace(/[?#].*$/, ''));
    const candidates = path.startsWith('/@fs/') ? [path.slice(4)] : path.startsWith('/') ? [resolve(root, '.' + path), ...(resolved!.publicDir ? [resolve(resolved!.publicDir, '.' + path)] : [])] : [resolve(dirname(sheet), path)];
    for (const c of candidates) { try { return new Uint8Array(readFileSync(c)); } catch { /* the next */ } }
    return null;
  };
  /** the stylesheets the page loads, for the boxes they give its images */
  const stylesOf = async (html: string, file: string, p: ReturnType<typeof project>): Promise<StyleSheet[]> => {
    resolveId ??= resolved!.createResolver({ tryIndex: true });
    const r = resolveId;
    const modules = [p.config, p.early, p.helpersFile, p.actionsFile].filter((m): m is string => !!m);
    engines ??= detectEngines(root, resolved!.plugins.map((x) => x.name));
    // Google Fonts' stylesheets only in builds, where their fonts' metrics are read
    const remote = options.fonts?.inline === false || dev ? undefined : (url: string) => (fontCss ??= fontDownloader(resolve(root, 'node_modules/.cache/sinter/fonts')))(url);
    return pageStyles(html, file, { root, publicDir: resolved!.publicDir || null, modules, resolve: (id, importer) => r(id, importer), compile: compileCss, engines, warn: (m) => warnOnce(coded('SN527', m)), ...(remote ? { remote } : {}) });
  };
  const imageHost = (rel: string, styles?: StyleSheet[]): ImageHost | undefined => {
    if (!images) return undefined;
    const img = images, base = resolved?.base ?? '/';
    // a relative base (`./`, ''): URLs relative to the page, as Vite writes its own (`../assets/…` from `blog/post.html`)
    const prefix = dev ? `${base}${IMG.slice(1)}` : `${pageBase(base, rel)}${resolved!.build.assetsDir}/`;
    const widths = options.images ? options.images.widths : undefined;
    return { info: (f) => img.info(f), url: (v) => prefix + img.fileName(v), ignore: true, stylesheet: `${IMG_CSS}${rel}.css`, ...(widths ? { widths } : {}), ...(styles?.length ? { styles } : {}) };
  };
  /** next-page data: each page's description, by file (null: nothing to prefetch), and the pages compiled so far */
  type Described = { parts: PrefetchParts | null; path: string[]; off: boolean; keep: string[]; swapOff: boolean; keptSource: Record<string, string>; keptBound: string[] };
  const described = new Map<string, Described>();
  /**
   * `data-sn-pages`: each template's description (by source and language), from the first of its entries described.
   * Another entry's is that one at its own path: what an entry can request ahead reads only the URL (`$url`), never
   * the entry, so it is the same for every entry, as what a swap keeps is. Cleared with `described`.
   */
  const entriesDescribed = new Map<string, { page: string; d: Described }>();
  /** an entry's description from its template's, or null to compile it */
  const entryDescription = (v: { source: string; locale?: string; page?: { path: string } } | undefined): Described | null => {
    if (!v?.page) return null;
    const k = entriesDescribed.get(`${v.source}\0${v.locale ?? ''}`);
    // (the one path a `data-sn-pages` page has: the entry's, under its language's prefix)
    if (!k || k.d.path.length !== 1 || !k.d.path[0]!.endsWith(k.page)) return null;
    const own = k.d.path[0]!.slice(0, k.d.path[0]!.length - k.page.length) + v.page.path;
    const at = (ps: string[]) => ps.map((x) => (x === k.d.path[0] ? own : x));
    return { ...k.d, parts: k.d.parts && { ...k.d.parts, path: at(k.d.parts.path) }, path: at(k.d.path) };
  };
  let speculationHash: string | null = null, rulesWritten = false;
  /** every inline rule set's hash (pages with same-page links have their own) */
  const speculationHashes = new Set<string>();
  /** build: the pages with inline rules and no CSP <meta>, whose CSP (if any) comes from a response header */
  let unhashedPages = 0;
  const seen = new Set<string>();
  /** option warnings already printed (`sinter({ openapi })` is deprecated) */
  const warnedOptions = new Set<string>();
  /** `localePrefix`: the languages, and each page in a language (`<root>/<locale>/<page>`) with its source and language */
  let locales: Locales | null = null;
  const virtual = new Map<string, { source: string; locale: string; page?: { value: unknown; path: string; key: string } }>();
  /** `data-sn-pages` with languages: each template's entries by key, each language's path (an entry's translations) */
  const entryLangs = new Map<string, Map<string, string>>();
  /** `data-sn-pages`: the build's inputs, each template page replaced by a page per entry (`pageInputs()`), or null */
  let pageInputs: string[] | null = null;
  /** the build's input as the app wrote it, before `localePrefix` turns it into one input per page and language */
  let sourceInput: unknown = undefined;
  const sourceDescribed = new Map<string, string[]>();
  /** build: why each page needs the runtime, by its path relative to the root (empty: it ships none) */
  const runtimeOf = new Map<string, RuntimeReason[]>();
  let pagesCache: Array<{ paths: string[]; parts: PrefetchParts | null; swaps: boolean }> | null = null;
  const attr = (v: string) => v.replace(/[&"<>]/g, (c) => `&#${c.charCodeAt(0)};`);
  /** the tag of the script that starts with the picker: it picks the locale and starts the page's language file */
  const pickerTag = (src: string, files: Record<string, string>, locale?: string) => `<script src="${attr(src)}" data-sn-i18n="${attr(JSON.stringify({ base: locale ?? messages!.base, locales: locale ? [locale] : messages!.locales, storage: 'locale', files: locale ? { [locale]: files[locale]! } : files }))}"></script>`;
  /** `m.key` in a module: collected for the page's language file; any other use of `m` is refused */
  const collect = (ctx: { error(m: string): never }, code: string, id: string) => {
    if (!messages || id.includes('/node_modules/') || !/\.[cm]?[jt]sx?(\?|$)/.test(id)) return;
    const r = moduleKeys(code, id);
    if (r.errors.length) ctx.error(`sinter: ${r.errors.join('\n')}`);
    const unknown = r.keys.filter((k) => !(k in messages!.keys));
    if (unknown.length) ctx.error(`sinter: ${id}: no message ${unknown.map((k) => `\`${k}\``).join(', ')} in ${relOf(messages.files[messages.base]!)}`);
    if (r.keys.length) moduleMessages.set(id.replace(/\?.*$/, ''), r.keys); else moduleMessages.delete(id.replace(/\?.*$/, ''));
  };

  /** dev: the folders `file:` globs list; a file added or removed there that the glob matches reloads the pages */
  const globs = new Map<string, { dir: string; match: RegExp }>();
  const watchGlob = (g: { dir: string; match: string }) => {
    const k = `${g.dir}\0${g.match}`;
    if (globs.has(k)) return;
    globs.set(k, { dir: g.dir.replace(/\/$/, ''), match: new RegExp(g.match) });
    server?.watcher.add(g.dir);
  };
  const inGlob = (file: string) => {
    const f = file.split(sep).join('/');
    for (const g of globs.values()) if (f.startsWith(g.dir + '/') && g.match.test(f.slice(g.dir.length + 1))) return true;
    return false;
  };
  const watch = (file: string) => {
    if (watched.has(file)) return;
    watched.add(file);
    server?.watcher.add(file);
    // a library's file through a workspace link: the watcher reports its real path
    let real = file;
    try { real = realpathSync(file); } catch { /* missing */ }
    if (real !== file) { watched.add(real); server?.watcher.add(real); }
  };
  const relOf = (file: string) => relative(root, file).split(sep).join('/');

  /** the app's HTML entries: the build input, else `index.html`, and every page compiled so far */
  /** the app's source pages: the build input, else `index.html`, and every page compiled so far */
  const sourceEntries = () => {
    const b = resolved?.build as { rollupOptions?: { input?: unknown }; rolldownOptions?: { input?: unknown } } | undefined;
    const input = sourceInput ?? b?.rolldownOptions?.input ?? b?.rollupOptions?.input;
    const list = typeof input === 'string' ? [input] : Array.isArray(input) ? input : input && typeof input === 'object' ? Object.values(input) : [];
    const files = (list as unknown[]).filter((f): f is string => typeof f === 'string' && f.endsWith('.html')).map((f) => resolve(root, f));
    // dev without a build input: every page under the root, as the dev server serves any of them
    if (!files.length && dev) files.push(...htmlPages(root, resolved));
    if (!files.length && existsSync(resolve(root, 'index.html'))) files.push(resolve(root, 'index.html'));
    return [...new Set([...files, ...[...seen].map((f) => virtual.get(f)?.source ?? f)])].sort();
  };
  /** `localePrefix`: a source page in a language, `<root>/<locale>/<page>`, which the build and the dev server serve as a page */
  const virtualOf = (source: string, locale: string) => {
    const v = resolve(root, locale, relOf(source));
    virtual.set(v, { source, locale });
    return v;
  };
  /** the app's HTML entries: its pages, or with `localePrefix` each page in each language */
  const entries = () => pageInputs ?? (locales ? sourceEntries().flatMap((s) => locales!.list.map((l) => virtualOf(s, l))) : sourceEntries());
  /**
   * `data-sn-pages` (docs/static-pages.md#a-page-per-entry): a page's entries, from a compile of it as its template, which
   * reads its `file:` list; null for a page without it. Its errors (SN340, SN341) fail the build: the template is no
   * input of its own, so nothing else would report them.
   */
  const templatesKept = new Map<string, NonNullable<CompileResult['pages']> | null>();
  const templatePages = (file: string, locale?: string): NonNullable<CompileResult['pages']> | null => {
    const k = `${file}\0${locale ?? ''}`;
    if (!dev && templatesKept.has(k)) return templatesKept.get(k)!;
    const html = readFileSync(file, 'utf8');
    if (!/data-sn-pages\b/.test(html)) { templatesKept.set(k, null); return null; }
    const p = proj();
    // in a language: its entries (a `{$locale}` path reads that language's files)
    const out = compile(html, { file, root, dev, helpers: p.helpers, actions: p.actions, readFile: readVia(p), listFiles: p.listFiles, ...(dev ? {} : { globCache }), ...contentOpts(locale), lazy: p.lazy, openapi: p.openapi, apis: p.apis, prerender: true, ...(locale ? { locale: { name: locale, urls: null, base: resolved?.base ?? '/' } } : {}) });
    const fatal = out.diagnostics.filter((d) => d.severity === 'error' && /^SN34[01]$/.test(d.code));
    if (fatal.length) throw new Error(`sinter: ${fatal.map(formatDiagnostic).join('\n')}`);
    if (!dev) templatesKept.set(k, out.pages ?? null);
    return out.pages ?? null;
  };
  /** an entry's URL in each language that has it (the entry with its key in that language's list) */
  const entryUrls = (v: { source: string; page?: { key: string } }): Record<string, string> | null => {
    const by = v.page ? entryLangs.get(`${v.source}\0${v.page.key}`) : undefined;
    if (!by) return null;
    return Object.fromEntries([...by].map(([l, path]) => [l, prefixed([path], l)[0]!]));
  };
  /** where an entry's language chooser is, at its unprefixed path: the base language's entry's, else the first's */
  const entryChooser = (source: string, key: string): string | null => {
    const by = entryLangs.get(`${source}\0${key}`);
    return by ? (by.get(locales!.base) ?? [...by.values()][0]!) : null;
  };
  /** dev: the entry a URL names on a `data-sn-pages` page (its path, under `base`), else its first */
  const devEntry = (file: string, url: string, locale?: string): { value: unknown; path: string; key: string } | undefined => {
    let pages: ReturnType<typeof templatePages>;
    try { pages = templatePages(file, locale); } catch { return undefined; }
    if (!pages) return undefined;
    let path = decodeURIComponent(url.split(/[?#]/)[0]!).replace(/\/$/, '');
    if (locale) { const b = base().replace(/\/?$/, '/'); if (path.startsWith(`${b}${locale}/`)) path = b.replace(/\/$/, '') + path.slice(b.length + locale.length); }
    return pages.entries.find((e) => decodeURIComponent(e.path) === path) ?? pages.entries[0];
  };
  /**
   * builds: each `data-sn-pages` page becomes one input per entry, a virtual page at the entry's path (`blog/hello.html`
   * for `/blog/hello`), compiled with its entry; the template itself is no input. A path another page or a file in
   * `public/` has fails the build.
   */
  const pagesInputs = (): string[] | null => {
    const sources = sourceEntries();
    const found = sources.map((f) => [f, templatePages(f)] as const);
    if (!found.some(([, pg]) => pg)) return null;
    const b = base().startsWith('/') ? base().replace(/\/?$/, '/') : '/';
    const relOfPath = (path: string) => decodeURIComponent(path.startsWith(b) ? path.slice(b.length) : path.replace(/^\//, ''));
    // the pages that are not templates, in every language: where an entry may not be written
    const plain = sources.filter((f) => !found.find(([g, pg]) => g === f && pg));
    const taken = new Map<string, string>();
    for (const f of plain) for (const l of locales ? locales.list : [null]) {
      const rel = (l ? `${l}/` : '') + relOf(f);
      taken.set(rel.replace(/(^|\/)index\.html$/, '$1').replace(/\.html$/, ''), rel);
    }
    const out: string[] = [];
    entryLangs.clear();
    for (const [f, pg] of found) {
      if (!pg) { if (locales) out.push(...locales.list.map((l) => virtualOf(f, l))); else out.push(f); continue; }
      // each language's entries (its own list with `{$locale}`), at its prefix; their keys pair the translations
      for (const l of locales ? locales.list : [null]) {
        const entries = l ? templatePages(f, l)!.entries : pg.entries;
        for (const e of entries) {
          const rel = (l ? `${l}/` : '') + relOfPath(e.path);
          const other = taken.get(rel) ?? taken.get(rel + '/');
          if (other) throw new Error(`sinter: ${relOf(f)}: the entry at \`${l ? `/${l}` : ''}${e.path}\` would be written where \`${other}\` is (data-sn-pages)`);
          if (resolved?.publicDir && existsSync(resolve(resolved.publicDir, rel + '.html'))) throw new Error(`sinter: ${relOf(f)}: the entry at \`${e.path}\` would be written where \`public/${rel}.html\` is (data-sn-pages)`);
          taken.set(rel, `${relOf(f)} (${e.path})`);
          const v = resolve(root, rel + '.html');
          virtual.set(v, { source: f, locale: (l ?? undefined) as unknown as string, page: e });
          out.push(v);
          if (l) { const k = `${f}\0${e.key}`; if (!entryLangs.has(k)) entryLangs.set(k, new Map()); entryLangs.get(k)!.set(l, e.path); }
        }
      }
    }
    return out;
  };
  /** a page's HTML: its file, or for a page in a language its source's */
  const readPage = (file: string) => readFileSync(virtual.get(file)?.source ?? file, 'utf8');
  /** a source page's `data-sn-path` under a language's prefix, after the base (`/de/article/:slug`) */
  const prefixed = (patterns: string[], locale: string) => {
    const b = resolved?.base?.startsWith('/') ? resolved.base.replace(/\/?$/, '/') : '/';
    return patterns.map((p) => (p.startsWith(b) ? b + locale + (p.length > b.length ? '/' + p.slice(b.length) : '/') : p));
  };
  /** a source page's URL in each language (for `localeUrl()` and `hreflang`), or null for a page whose paths all have parameters */
  const localeUrls = (source: string): Record<string, string> | null => {
    const b = resolved?.base?.startsWith('/') ? resolved.base : '/';
    const pats = describeSource(source).path, out: Record<string, string> = {};
    for (const l of locales!.list) {
      const u = pageUrl(`${l}/${relOf(source)}`, b, prefixed(pats, l));
      if (u === null) return null;
      out[l] = u;
    }
    return out;
  };
  /** every page with the paths it answers at, and what another page can request ahead for it */
  /** a page's description (its patterns, what can be requested ahead), compiled once; a page in a language, under its prefix */
  const describe = (file: string) => {
    if (!described.has(file)) {
      const p = proj(), v = virtual.get(file);
      const kept = entryDescription(v);
      if (kept) { described.set(file, kept); return kept; }
      try {
        // with the APIs and specs: what is requested ahead is the page's own request (its base, its configured shape)
        const r = compile(readPage(file), { file: v?.source ?? file, root, dev, helpers: p.helpers, actions: p.actions, readFile: readVia(p), listFiles: p.listFiles, ...(dev ? {} : { globCache }), ...contentOpts(v?.locale), lazy: p.lazy, openapi: p.openapi, apis: p.apis, ...(v?.page ? { page: v.page } : {}), describeOnly: true, ...(v?.locale ? { locale: { name: v.locale, urls: null, base: resolved?.base ?? '/' } } : {}) });
        described.set(file, { parts: r.prefetch, path: r.path, off: !!r.prefetchOff, keep: r.permanent ?? [], swapOff: !!r.swapOff, keptSource: r.keptSource ?? {}, keptBound: r.keptBound ?? [] });
        if (v?.page) entriesDescribed.set(`${v.source}\0${v.locale ?? ''}`, { page: v.page.path, d: described.get(file)! });
      } catch { described.set(file, { parts: null, path: [], off: false, keep: [], swapOff: true, keptSource: {}, keptBound: [] }); }
    }
    return described.get(file)!;
  };
  /** a source page's description, as written (no language's prefix) */
  const describeSource = (source: string) => {
    if (!sourceDescribed.has(source)) {
      const p = proj();
      try { sourceDescribed.set(source, compile(readFileSync(source, 'utf8'), { file: source, root, dev, helpers: p.helpers, actions: p.actions, readFile: readVia(p), listFiles: p.listFiles, ...(dev ? {} : { globCache }), ...contentOpts(), lazy: p.lazy, openapi: p.openapi, apis: p.apis }).path); }
      catch { sourceDescribed.set(source, []); }
    }
    return { path: sourceDescribed.get(source)! };
  };
  /** every page, with its `data-sn-path` patterns: where it is written and what its links name (page-urls.ts) */
  const pageEntries = (): PageEntry[] => entries().map((file) => ({ rel: relOf(file), patterns: describe(file).path }));
  const appPages = () => {
    if (pagesCache) return pagesCache;
    const out: Array<{ paths: string[]; parts: PrefetchParts | null; swaps: boolean }> = [];
    for (const file of entries()) {
      const d = describe(file);
      // `<html data-sn-prefetch="off">`: neither described nor in the rules
      if (d.off) continue;
      out.push({ paths: pagePaths(relOf(file), resolved?.base ?? '/', d.path), parts: d.parts, swaps: !!options.swap && !d.swapOff });
    }
    return (pagesCache = out);
  };
  /** with swaps on: the pages that swap and the names each keeps (swap-build.ts); a page with `data-sn-swap="off"` is not one */
  const swapPages = (): SwapPage[] => entries().flatMap((file) => {
    const d = describe(file);
    return d.swapOff ? [] : [{ m: pagePaths(relOf(file), resolved?.base ?? '/', d.path), k: d.keep }];
  });
  const prefetchPages = () => appPages().filter((x): x is { paths: string[]; parts: PrefetchParts; swaps: boolean } => !!x.parts);
  /** how the Speculation Rules are delivered, or null for none */
  const spec = () => {
    // inline by default: it works with no server setup (a CSP in the page gets the rules' hash, see withRulesHash)
    const o = options.speculation ?? 'prefetch';
    return o === false ? null : typeof o === 'string' ? { mode: o, delivery: 'inline' as const } : { mode: o.mode, delivery: o.delivery ?? 'inline' };
  };
  /** the rules' JSON for links to the app's pages, or null; `samePage`: a page with same-page links (query-links.ts), whose own URLs are left out */
  /**
   * The Speculation Rules' pages: every page's paths, but a `data-sn-pages` page's entries are its pattern, once
   * (listing each entry in every page's head would grow with the square of their number)
   */
  let rulesKept: { for: unknown; same: Map<boolean, string | null> } | null = null;
  const rulesJson = (samePage = false) => {
    const s = spec();
    if (!s) return null;
    const pages = appPages();
    if (rulesKept?.for !== pages) rulesKept = { for: pages, same: new Map() };
    if (rulesKept.same.has(samePage)) return rulesKept.same.get(samePage)!;
    const json = rulesOf(s.mode, samePage);
    rulesKept.same.set(samePage, json);
    return json;
  };
  // with swaps on, a link to a page that swaps is fetched by the swap, which the browser's prefetch cache does
  // not serve: only the pages that opt out are in the rules
  const rulesOf = (mode: 'prefetch' | 'prerender', samePage: boolean) => {
    const entry = new Set<string>(), patterns = new Set<string>(), pages = appPages().filter((x) => !x.swaps);
    for (const v of virtual.values()) if (v.page) { entry.add(v.page.path); if (pages.some((x) => x.paths.includes(v.page!.path))) patterns.add(templatePattern(v.source)); }
    return speculationRules(mode, [...pages.flatMap((x) => x.paths).filter((x) => !entry.has(x)), ...patterns], samePage);
  };
  /**
   * builds: a link in a finished page to a path a `data-sn-pages` pattern matches, but no entry was written at, fails
   * the build (SN343), with the entry it was likely meant for. The links are the built HTML's (`href`, root-relative):
   * those from constants and folded expressions, markdown's included; a link built at run time is not checked.
   */
  const brokenEntryLinks = (fail: (m: string) => never, built: Map<string, string>) => {
    const entries = new Set<string>(), patterns = new Map<string, string>();
    for (const v of virtual.values()) if (v.page) { entries.add(decodeURIComponent(v.page.path)); patterns.set(templatePattern(v.source), relOf(v.source)); }
    if (!patterns.size) return;
    const found: string[] = [];
    for (const [rel, html] of built) for (const m of html.matchAll(/\shref="(\/(?!\/)[^"]*)"/g)) {
      let path: string;
      try { path = decodeURIComponent(m[1]!.replace(/&amp;/g, '&').split(/[?#]/)[0]!).replace(/(.)\/$/, '$1'); } catch { continue; }
      if (entries.has(path)) continue;
      for (const [pattern, template] of patterns) {
        if (!matches(pattern, path)) continue;
        const near = suggest(path, [...entries].filter((e) => matches(pattern, e)));
        found.push(`${rel} links to \`${path}\`, which \`${pattern}\` (${template}) matches, but no entry is there${near ? `. Did you mean \`${near}\`?` : ''}`);
        break;
      }
    }
    if (found.length) fail(`sinter: error SN343 ${CODES.SN343}: ${found.slice(0, 20).join('\n  ')}${found.length > 20 ? `\n  … and ${found.length - 20} more` : ''}\n  docs: \`npx sinter docs SN343\`, https://github.com/tiaforge/sinter/blob/main/docs/diagnostics.md#sn343-broken-entry-link`);
  };
  /** a `data-sn-pages` page's pattern, as its template writes it (read once per build) */
  const templatePatterns = new Map<string, string>();
  const templatePattern = (source: string) => {
    let pt = templatePatterns.get(source);
    if (pt === undefined) { pt = [...virtual.values()].find((v) => v.source === source && v.page) ? (templatePages(source)?.pattern ?? '') : ''; templatePatterns.set(source, pt); }
    return pt;
  };
  /** pages that load query-links: a rules file for a response header leaves out each page's own URLs once one does */
  const sameLinkPages = new Set<string>();
  /** where `delivery: 'header'` serves the rules: a fixed name, as the server's header names it */
  const rulesUrl = () => `${resolved?.base ?? '/'}${RULES_FILE}`;
  /** the Speculation Rules tag for links to the app's pages, or '' (none, or delivered by a header) */
  const speculationTag = (samePage: boolean) => {
    if (spec()?.delivery !== 'inline') return '';
    const json = rulesJson(samePage);
    if (!json) return '';
    speculationHash = `sha256-${createHash('sha256').update(json).digest('base64')}`;
    // pages with and without same-page links have different rules: a CSP header must allow each
    speculationHashes.add(speculationHash);
    return `<script type="speculationrules">${json}</script>`;
  };
  /** dev and preview, `delivery: 'header'`: the header on pages and the rules file with its content type */
  const rulesMiddleware = (read: () => string | null) => (req: { url?: string; headers: Record<string, string | string[] | undefined> }, res: { setHeader(k: string, v: string): void; end(b: string): void; statusCode: number }, next: () => void) => {
    if (spec()?.delivery !== 'header') return next();
    if (req.url?.split('?')[0] === rulesUrl()) {
      const json = read();
      if (json == null) return next();
      res.setHeader('Content-Type', 'application/speculationrules+json');
      return res.end(json);
    }
    if (String(req.headers.accept ?? '').includes('text/html')) res.setHeader('Speculation-Rules', `"${rulesUrl()}"`);
    next();
  };

  /** whether a hook runs for the client environment (or a Vite without environments) */
  const isClient = (ctx: unknown) => { const env = (ctx as { environment?: { config?: { consumer?: string } } }).environment; return !env?.config?.consumer || env.config.consumer === 'client'; };
  /**
   * The project's files a build's compiles read (components, layouts, `file:` sources), read once per build: every page
   * reads the same components, each instance looked up again (and its script beside it, which is usually missing).
   * Cleared at each build's start, so a rebuild under `--watch` sees edits; dev reads afresh, as files change under it.
   */
  const buildReads = new Map<string, { text: string } | { error: unknown }>();
  /**
   * The content module's collections (docs/resources.md#collections), loaded before any page compiles: in
   * `configResolved`, and again in dev when the module or a file its loaders read changes. A build fails on a loader's
   * error; dev reports it on the pages that read a collection.
   */
  let content: LoadedContent | null = null;
  const loadCollections = async (): Promise<LoadedContent | null> => {
    const p = proj();
    if (!p.contentFile || !resolved) return null;
    const c = await loadContent({
      root, file: p.contentFile, command: dev ? 'serve' : 'build', readFile: p.readFile, listFiles: p.listFiles,
      env: loadEnv(resolved.mode, resolved.envDir === false ? root : resolved.envDir ?? root, ''),
      configFile: resolved.configFile ?? false, mode: resolved.mode, ...(resolved.configFile ? {} : { alias: resolved.resolve.alias }),
      ...(locales ? { locales: locales.list } : {}),
    });
    // what `sinter check` and the editor compile against (the last load that worked; with languages, the base one's)
    if (!c.error) writeSnapshot(root, p.contentFile, c, locales?.base);
    return c;
  };
  /** what every compile gets of the collections */
  const contentOpts = (locale?: string) => (content ? { collections: collectionsIn(content, locale), ...(content.error ? { collectionsError: content.error } : {}) } : {});
  /** builds: the `file:` lists already built (compile's `globCache`), cleared with the reads */
  const globCache: NonNullable<Parameters<typeof compile>[1]['globCache']> = new Map();
  /** builds: each `data-sn-pages` template's first pass, walked once for all its entries (compile's `templates`), cleared with the reads */
  const templates = new Map<string, unknown>();
  const readVia = (p: ReturnType<typeof project>) => (dev ? p.readFile : (path: string) => {
    let r = buildReads.get(path);
    if (!r) { try { r = { text: p.readFile(path) }; } catch (error) { r = { error }; } buildReads.set(path, r); }
    if ('error' in r) throw r.error;
    return r.text;
  });
  /** the build's helper calls that folded, by page and call, for the cross-check at its end */
  const foldCalls = new Map<string, FoldCall[]>();
  const logFold = (page: string, key: string, args: FoldArg[], result: string, id: number) => {
    // ids count from 0 when the page's calls start afresh: what an earlier run logged is replaced
    const calls = id === 0 || !foldCalls.has(page) ? foldCalls.set(page, []).get(page)! : foldCalls.get(page)!;
    calls.push({ key, args, hash: hashOf(result), id });
  };

  /** compiles one page; `earlySrc`: where the page loads its early chunk (dev), else the build injects the tag */
  const build = (html: string, file: string, earlySrc: string | null, styles?: StyleSheet[], lineHeights?: Map<string, number>, zeros?: Map<string, number | null>, minifyStyles?: StyleSheet[], url?: string): { out: CompileResult; p: ReturnType<typeof project> } => {
    const rel = relOf(file);
    const p = proj();
    // a page in a language: compiled from its source (diagnostics, components, layouts as written), in that language
    const v = virtual.get(file), src = v?.source ?? file;
    const lang = v?.locale && p.messages ? { ...p.messages.dicts[p.messages.base], ...p.messages.dicts[v.locale] } : null;
    // `data-sn-pages`: an entry's page (a build's input), or in dev the entry the URL names
    const page = v?.page ?? (dev && url ? devEntry(src, url, v?.locale) : undefined);
    const fatal = strictly(p.diagnostics).filter((d) => d.severity === 'error');
    if (fatal.length) throw new Error(`sinter: ${fatal.map(formatDiagnostic).join('\n')}`);
    // a warning about the options (a deprecated one): once per build
    for (const d of p.diagnostics) if (d.severity === 'warning' && !warnedOptions.has(d.message)) { warnedOptions.add(d.message); resolved?.logger.warn(formatDiagnostic(d)); }
    // a page not seen before may be a new one (dev); a build's pages per entry are all known from the start
    if (!seen.has(file)) { seen.add(file); if (dev || !pageInputs) pagesCache = null; }
    const prefetch = options.prefetch !== false && prefetchPages().length ? PREFETCH : null;
    const out = compile(html, {
      file: src, root, dev, sourcemap: dev || !!resolved?.build.sourcemap, helpers: p.helpers, actions: p.actions, moduleSrc: `${PREFIX}${rel}.js`, config: p.config, readFile: readVia(p), listFiles: p.listFiles, ...(dev ? {} : { globCache, templates }), ...contentOpts(v?.locale), prefetch,
      ...(page ? { page } : {}),
      check: !!options.typecheck && !dev, openapi: p.openapi, apis: p.apis, complexity: p.complexity, ...(p.expansionLimit ? { expansionLimit: p.expansionLimit } : {}), componentNames: p.componentNames, libraries: p.libraries, checkCycles: p.checkCycles, lazy: p.lazy,
      ...(lazyPkgs.length ? { lazyScript, lazyModule: (m: string) => lazyHelpers(root, lazyPkgs, undefined, p.libraries).reach(m) } : {}),
      ...(helpersNow ? { helperValues: helpersNow.module, helperFold: helpersNow.fold } : {}),
      // a build: each distinct call that folds is run again at its end in a fresh copy of the module (fold-cross.ts)
      ...(helpersNow?.module && !dev ? { foldLog: (key: string, args: FoldArg[], result: string, id: number) => logFold(v?.page ? rel : relOf(src), key, args, result, id) } : {}),
      ...(images ? { images: imageHost(rel, styles)! } : {}),
      ...(styles?.length ? { styles } : {}),
      ...(minifyStyles ? { minify: { styles: minifyStyles } } : {}),
      ...(lineHeights?.size ? { normalLineHeight: (f: string) => lineHeights.get(f) ?? null } : {}),
      ...(zeros?.size ? { zeroWidth: (f: string) => zeros.get(f) ?? null } : {}),
      ...(firstPaint && !dev ? { paintCss: `${PAINT_CSS}${rel}.css` } : {}),
      ...(remoteConfig ? { remoteImages: dev ? devRemote(remoteConfig, resolved?.base ?? '/') : remoteConfig } : {}),
      // build-time constants and pages with nothing to run do not depend on the early script: `firstPaint: false` turns off only that
      prerender: true,
      ...(p.changesRequests ? { changesRequests: true } : {}),
      ...(firstPaint ? { early: { module: p.early, src: earlySrc } } : {}),
      ...(p.messages ? { baseMessages: lang ?? p.messages.dicts[p.messages.base] ?? {} } : {}),
      ...(v?.locale ? { locale: { name: v.locale, urls: v.page ? entryUrls(v) : localeUrls(src), base: resolved?.base ?? '/' } } : {}),
      ...(options.origins?.length || apiOrigins(p.apis).length ? { origins: [...(options.origins ?? []), ...apiOrigins(p.apis)] } : {}),
      ...(firstPaint ? { observe: true } : {}),
      ...(options.embed && !dev ? { embed: true } : {}),
      componentCss: (name) => `${COMPONENT_CSS}${name}.css`,
      ...(p.isStatic(src) ? { static: true } : {}),
      ...(p.swap ? { swap: true, swapList: SWAP } : {}),
      ...(resolved?.base?.startsWith('/') ? { base: resolved.base } : {}),
      ...(siteOrigin ? { urls: urlsOf(rel, out0Path(file)) } : {}),
    });
    // with swaps on, a kept element that binds is one markup on every page that keeps it: the next page's code
    // takes over the element the swap keeps (docs/proposals/swap-navigation.md §3)
    if (p.swap) for (const [name, at] of Object.entries(out.keptSource ?? {})) {
      const binds = !!out.keptBound?.includes(name);
      const other = entries().find((f) => { const d = describe(f), k = d.keptSource[name]; return k && k !== at && (binds || d.keptBound.includes(name)); });
      if (other) out.diagnostics.push({ severity: 'error', code: 'SN346', message: `\`data-sn-permanent="${name}"\` binds, and ${relOf(other)} has another element of that name: a kept element that binds is one markup, from one place (a layout or a component), on every page that keeps it`, file: src, line: 1, col: 1 });
    }
    // a page in a language is written into its language's folder: its relative URLs follow
    if (v) out.html = rebaseHtml(out.html, '/' + posix.dirname(relOf(src)).replace(/^\.$/, ''), '/' + posix.dirname(rel));
    runtimeOf.set(rel, out.runtime);
    if (out.preload.length) preloadOf.set(rel, out.preload); else preloadOf.delete(rel);
    if (out.lazyScripts) lazyScriptsOf.set(rel, out.lazyScripts); else lazyScriptsOf.delete(rel);
    for (const x of out.styles) {
      if (componentCss.get(x.name) === x.css) continue;
      componentCss.set(x.name, x.css);
      invalidate(`${COMPONENT_CSS}${x.name}.css`);
    }
    if (out.early) setModule(`${EARLY}${rel}.js`, out.early, out.earlyMap);
    if (!dev && out.embed.length) embedPages.set(rel, { file: pageFile(rel, resolved?.base ?? '/', out.path), paths: pagePaths(rel, resolved?.base ?? '/', out.path), ...(out.urlArrays ? { arrays: out.urlArrays } : {}), data: out.embed });
    else embedPages.delete(rel);
    if (out.module.includes(`/transition';`)) holdPages.add(rel); else holdPages.delete(rel);
    messages = p.messages;
    if (out.messages) markupMessages.set(rel, out.messages);
    return { out, p };
  };
  const invalidate = (id: string) => {
    const m = server?.moduleGraph.getModuleById('\0' + id);
    if (m) server!.moduleGraph.invalidateModule(m);
  };

  /**
   * Lazy packages in an app module (docs/lazy.md): its imports of one point at stubs, after the uses
   * a stub cannot serve were refused (SN324). A component script keeps its imports (it loads with the
   * package), and so does a helper module that reaches one, with the modules between (they load whole with it).
   */
  const lazyTransform = (ctx: { error(e: string | { message: string; id?: string; loc?: { line: number; column: number } }): never }, code: string, id: string) => {
    if (!lazyPkgs.length || id.startsWith('\0') || !/\.[cm]?[jt]sx?(\?|$)/.test(id)) return null;
    const file = id.replace(/[?#].*$/, '');
    // packages are not the app's modules, except the component libraries
    const libs = options.components?.length ? proj().libraries : [];
    if (id.includes('/node_modules/') && !libraryOf(libs, file)) return null;
    // a module of a lazy package (a component library listed in `lazy`) is the package: it loads whole with it
    const lib = libraryOf(libs, file);
    if (lib && lazyPackage(lib.name, lazyPkgs)) return null;
    if (!mentions(code, lazyPkgs)) return null;
    const s = scanLazy(code, file, lazyPkgs, sameFile(file, proj().helpersFile));
    if (!s.lazy.length && !s.problems.length && !s.drop?.length) return null;
    if (isComponentScript(root, file, libs)) return null;
    // a helper module that reaches the package, and the modules between: they load whole with it, when a let first needs them
    if (lazyHelpers(root, lazyPkgs, undefined, libs).whole(proj().helpers).has(file)) return null;
    if (s.problems.length) {
      const at = lineCol(code, s.problems[0]!.offset);
      ctx.error({ message: `sinter: ${s.problems.map((p) => { const l = lineCol(code, p.offset); return `SN324 ${relOf(file)}:${l.line}:${l.col} ${p.message}`; }).join('\n')}`, id: file, loc: { line: at.line, column: at.col - 1 } });
    }
    return { code: rewriteLazy(code, s), map: null };
  };

  const main: SinterPlugins[0] = {
    name: 'sinter',
    enforce: 'pre',
    // `localePrefix`: a page in a language is its source (`sinter check` checks the pages as written)
    api: { options, source: (file: string) => virtual.get(file)?.source ?? file },

    /**
     * No modulepreload polyfill unless the app asks for one: every browser sinter's pages rely on
     * (`commandfor`, Speculation Rules, `blocking="render"`) preloads modules natively, and the
     * polyfill is ~400 B gzip in every page's bundle. Without it an older browser loads the same
     * modules, one import after the other.
     */
    config(user) {
      // dev: the lazy packages are pre-bundled at startup (no page imports them statically, so the scan would not find them)
      // component libraries ship source the plugin compiles: never pre-bundled
      const libs = componentsOf(options.components);
      const deps = lazyPkgs.length || libs.length ? { optimizeDeps: { ...(lazyPkgs.length ? { include: lazyPkgs } : {}), ...(libs.length ? { exclude: libs } : {}) } } : {};
      const mp = user.build?.modulePreload;
      if (mp === false || (typeof mp === 'object' && mp.polyfill !== undefined)) return deps;
      return { ...deps, build: { modulePreload: { polyfill: false } } };
    },

    async configResolved(config) {
      root = config.root;
      dev = config.command === 'serve';
      resolved = config;
      // dev: a component library's files are served wherever they really are (a workspace link outside the root)
      if (dev && options.components?.length) {
        const allow = (config.server.fs as { allow?: string[] }).allow;
        if (Array.isArray(allow)) for (const l of proj().libraries) if (!allow.includes(l.real)) allow.push(l.real);
      }
      if (options.localePrefix) {
        if (options.messages === false) throw new Error('sinter({ localePrefix }): the languages come from the built-in messages, which `messages: false` turns off');
        locales = readLocales(root, typeof options.messages === 'string' ? options.messages : 'project.inlang');
        // the build: each page once per language, as `<root>/<locale>/<page>` (resolved and loaded below)
        const b = config.build as { rollupOptions?: { input?: unknown }; rolldownOptions?: { input?: unknown } };
        sourceInput = b.rolldownOptions?.input ?? b.rollupOptions?.input;
        if (!dev) {
          const input = entries();
          if (b.rolldownOptions) b.rolldownOptions.input = input;
          if (b.rollupOptions) b.rollupOptions.input = input;
        }
      }
      // the content module's collections, before anything compiles (a build's errors stop it here)
      content = await loadCollections();
      if (content?.error) {
        if (!dev) throw new Error(`sinter: ${content.error}`);
        config.logger.error(`sinter: ${content.error}`);
      }
      // `data-sn-pages`: one input per entry, before the build starts (its inputs are fixed from here)
      if (!dev) {
        const b = config.build as { rollupOptions?: { input?: unknown }; rolldownOptions?: { input?: unknown } };
        sourceInput ??= b.rolldownOptions?.input ?? b.rollupOptions?.input;
        pageInputs = pagesInputs();
        if (pageInputs) {
          const input = Object.fromEntries(pageInputs.map((f) => [relOf(f).replace(/\.html$/, ''), f]));
          if (b.rolldownOptions) b.rolldownOptions.input = input;
          if (b.rollupOptions) b.rollupOptions.input = input;
        }
      }
      if (options.images !== false) {
        images = await loadImages(resolve(root, 'node_modules/.cache/sinter/images'), dev);
        if (!images) config.logger.warn(coded('SN525', 'images are not optimized, since sharp is not installed (npm install -D sharp), or sinter({ images: false }) to silence this'));
      }
    },

    configureServer(s) {
      server = s;
      // strict: a runtime warning in the browser is printed here and fails the page in the overlay, unless it depends on the environment
      if (strict.on) s.ws.on('sinter:warn', (w: Partial<RuntimeWarning> & { page?: unknown }, client) => {
        if (typeof w?.message !== 'string') return;
        const text = `sinter (browser${typeof w.page === 'string' ? `, ${w.page}` : ''}): ${w.message.replace(/^sinter: /, '')}`;
        if (w.environment) { s.config.logger.warn(`${text} (strict mode does not fail on this one: it depends on the environment)`); return; }
        s.config.logger.error(text, { timestamp: true });
        client.send({ type: 'error', err: { message: `${text}\n\nStrict mode (docs/strict.md): runtime warnings fail the page in the dev server.`, stack: '', plugin: 'sinter' } });
      });
      // dev: an image variant is encoded the first time it is requested (and cached)
      if (remoteConfig) s.middlewares.use(remoteMiddleware(remoteConfig, (m) => s.config.logger.warn(coded('SN528', m))));
      s.middlewares.use((req, res, next) => {
        const url = req.url?.split('?')[0] ?? '';
        const at = url.indexOf(IMG);
        const v = at >= 0 && images ? variants.get(decodeURIComponent(url.slice(at + IMG.length))) : undefined;
        if (!v) return next();
        images!.encode(v).then((buf) => {
          res.setHeader('Content-Type', MIME[url.slice(url.lastIndexOf('.') + 1)] ?? 'application/octet-stream');
          res.setHeader('Cache-Control', 'no-cache');
          res.end(buf);
        }, next);
      });
      s.middlewares.use(rulesMiddleware(rulesJson));
      // the early script is a classic script: served as bundled, not through the module pipeline (which would add
      // imports, e.g. Vite's query helper for a dynamic import), its map inline
      s.middlewares.use((req, res, next) => {
        const base = resolved?.base ?? '/', url = req.url?.split('?')[0] ?? '';
        const key = url.startsWith(base + EARLY.slice(1)) ? '/' + url.slice(base.length) : null;
        if (!key || !modules.has(key)) return next();
        devScript(key).then(({ code, map }) => {
          res.setHeader('Content-Type', 'text/javascript');
          res.setHeader('Cache-Control', 'no-cache');
          res.end(map ? `${code}\n//# sourceMappingURL=data:application/json;base64,${Buffer.from(JSON.stringify(map)).toString('base64')}\n` : code);
        }, next);
      });
      // an HTML, component or helpers change triggers a full reload in v0.1
      s.watcher.on('change', (file) => {
        // the helpers module, or a file it reaches: loaded again before the next page compiles
        if (helpersNow?.files.includes(file) || file === proj().helpersFile) nodeHelpers = null;
        // a page's resources may have changed: the next-page module is described again
        if (file.endsWith('.html') || watched.has(file)) { described.clear(); entriesDescribed.clear(); pagesCache = null; invalidate(PREFETCH); invalidate(SWAP); devEarly.clear(); }
        if (watched.has(file)) s.ws.send({ type: 'full-reload' });
      });
      // the content module, or a file its loaders read: the collections are loaded again, and the pages reload
      if (content || proj().contentFile) for (const f of [proj().contentFile!, ...(content?.files ?? [])]) if (f) s.watcher.add(f);
      s.watcher.on('change', (file) => {
        const p = proj();
        if (file !== p.contentFile && !content?.files.includes(file)) return;
        loadCollections().then((c) => {
          content = c;
          if (c?.error) s.config.logger.error(`sinter: ${c.error}`);
          for (const f of c?.files ?? []) s.watcher.add(f);
          described.clear(); entriesDescribed.clear(); pagesCache = null; invalidate(PREFETCH); devEarly.clear();
          s.ws.send({ type: 'full-reload' });
        }, (e) => s.config.logger.error(`sinter: ${(e as Error).message}`));
      });
      // a `file:` glob's list changes when a file it matches is added or removed
      for (const ev of ['add', 'unlink'] as const) s.watcher.on(ev, (file) => {
        if (!inGlob(file)) return;
        described.clear(); entriesDescribed.clear(); pagesCache = null; invalidate(PREFETCH); invalidate(SWAP); devEarly.clear();
        s.ws.send({ type: 'full-reload' });
      });
    },

    /** build: the pages that have something to run early (bundled into one file each in generateBundle) */
    async buildStart() {
      unhashedPages = 0;
      // the pages are the client environment's (an SSR environment building beside it compiles none): its calls only
      if (isClient(this)) foldCalls.clear();
      strictFailures.clear();
      speculationHashes.clear();
      sharedHead = null;
      earlyPages.clear();
      unlisted.clear();
      earlyFiles.clear();
      languageFiles.clear();
      pageMessages.clear();
      described.clear(); entriesDescribed.clear();
      pagesCache = null;
      buildReads.clear();
      globCache.clear();
      templates.clear();
      templatesKept.clear();
      buildProject = null;
      if (dev) return;
      // a fresh instance each build: under `--watch`, edits to the helpers count, and nothing a helper kept from the
      // last build (or the memo, by the instance) carries over into this one
      nodeHelpers = null;
      await helpersReady();
      const p = buildProject = project(root, options);
      messages = p.messages;
      appEarly = p.early;
      // a missing translation falls back to the base language: reported once per locale
      if (messages) {
        for (const l of messages.locales) {
          if (l === messages.base) continue;
          const missing = Object.keys(messages.keys).filter((k) => !(k in (messages!.dicts[l] ?? {})));
          if (missing.length) this.warn(coded('SN522', `${missing.length} message(s) not translated to \`${l}\` (the ${messages.base} text is used): ${missing.slice(0, 10).join(', ')}${missing.length > 10 ? ', …' : ''}`));
        }
      }
      // Each page is compiled once, by its `transformIndexHtml`: that compile writes the page, its early file and every
      // per-page fact the bundle reads (all read in `generateBundle` or by the page itself). A compile of every page here,
      // before them, was overwritten by it, and doubled the build's compile time.
    },

    /**
     * build: the early scripts, each one classic script (IIFE): the shared head script (the early
     * runtime's exports the pages call, and the app's early module) and each page's (its early
     * bindings and requests, over the runtime the shared script left on a global). What they share
     * with the page bundle are copies: state the app sets early (an i18n library's locale,
     * configure()) is set again by the page.
     */
    async generateBundle(_, bundle) {
      const r = resolved!;
      guardLazy(this);
      // the placeholders a server fills (data-sn-data), next to the pages: what a middleware reads to know each page's requests
      if (embedPages.size) {
        const pages = [...embedPages].sort(([a], [b]) => a.localeCompare(b)).map(([, p]) => ({ file: p.file, paths: p.paths, ...(p.arrays ? { arrays: p.arrays } : {}), data: p.data }));
        // the site's URLs, which sinter-axum follows as a host follows _redirects: 301s, and rewrites to a page's file
        const b = resolved?.base ?? '/';
        const routes: Array<Route & { choose?: true }> = b.startsWith('/') ? siteRoutes().map((x) => (x.file && !x.choose ? { ...x, file: pageFile(x.file, b, describe(resolve(root, x.file)).path) } : x.file ? { ...x, file: chooserFile(x.file) } : x)) : [];
        // a server picks the language at a fixed unprefixed URL too (`/about/`, `/`), where a host serves the chooser file
        if (locales && b.startsWith('/')) for (const s of sourceEntries()) { const u = pageUrl(relOf(s), b, describeSource(s).path); if (u) routes.push({ from: u, to: u, status: 200, file: chooserFile(relOf(s)), choose: true }); }
        this.emitFile({ type: 'asset', fileName: EMBED_FILE, source: JSON.stringify({ version: 2, pages, ...(routes.length ? { routes } : {}), ...(locales ? { locales: { ...locales, at: b.replace(/\/?$/, '/') } } : {}) }, null, 2) + '\n' });
        // the same placeholders as types, for `embed<Build>()` from `@tiaforge-ui/sinter/server`: a name no placeholder has, or a
        // placeholder whose request the build cannot describe left without an entry, is a type error in the server's code
        this.emitFile({ type: 'asset', fileName: EMBED_TYPES, source: embedTypes(pages) });
      }
      if (remoteConfig?.url.startsWith('/_vercel/image') && remoteWidths.size) {
        r.logger.info(`sinter: images from the API use these widths; Vercel resizes only the ones in vercel.json: "images": { "sizes": [${[...remoteWidths].sort((a, b) => a - b).join(', ')}], "remotePatterns": [...] }`);
      }
      if (images && variants.size) {
        const img = images;
        await Promise.all([...variants].map(async ([name, v]) => {
          this.emitFile({ type: 'asset', fileName: `${r.build.assetsDir}/${name}`, source: await img.encode(v) });
        }));
      }
      const earlyKeys = new Map<string, Set<string>>();
      const bundleEarly = (code: string, keys: Set<string>, rt: string[] | null, what: string) => earlyScript(code, keys, rt, what, runtimeId);
      const runtimeId = earlyPages.size ? (await this.resolve(EARLY_PKG, resolve(root, 'index.html')))?.id ?? null : null;
      if (earlyPages.size) {
        // the app's early module runs once, from the shared script, before any page's bindings
        const app = appEarly ? `import ${JSON.stringify(appEarly)};\n` : '';
        const pages = new Map([...earlyPages].map(([rel, code]) => [rel, app && code.startsWith(app) ? code.slice(app.length) : code]));
        const names = [...new Set([...pages.values()].flatMap(runtimeNames))].sort();
        const sharedKeys = new Set<string>();
        sharedHead = { fileName: '', ...await bundleEarly(`${app}import { ${names.join(', ')} } from '${EARLY_PKG}';\nglobalThis[Symbol.for(${JSON.stringify(RT_KEY)})] = { ${names.join(', ')} };\n`, sharedKeys, null, 'every page') };
        for (const [rel, code] of pages) {
          const keys = new Set(sharedKeys);
          earlyKeys.set(rel, keys);
          earlyFiles.set(rel, await bundleEarly(code, keys, runtimeNames(code), rel));
        }
      }
      if (unlisted.size) resolved?.logger.info(`sinter: resources on ${[...unlisted].join(', ')} are requested when the page module runs; list ${unlisted.size > 1 ? 'these origins' : 'the origin'} in sinter({ origins: [...] }) (instead of configure({ origins }): every page adds them) to request them before it`);
      // Speculation Rules for a response header: one file at the site root, under a fixed name
      const rules = spec()?.delivery === 'header' ? rulesJson(sameLinkPages.size > 0) : null;
      rulesWritten = !!rules;
      if (rules) this.emitFile({ type: 'asset', fileName: RULES_FILE, source: rules });
      // the head scripts, once the language files are known (emitted at the end): the shared one (the picker, the early
      // runtime, the app's early module) and each page's own (the hold script: a morph pending, the first paint waits for
      // the page module, on pages that use data-sn-transition; the page's early bindings and requests)
      const hash = (x: string) => createHash('sha256').update(x).digest('base64url').slice(0, 8);
      // an early file that bundled a lazy package (the early module, or a helper an early binding calls, reaches it)
      if (lazyPkgs.length) {
        const bad = [...earlyFiles].flatMap(([rel, f]) => Object.keys({ ...f.modules, ...sharedHead?.modules }).filter(isLazyModule).map((id) => `SN325 ${rel}: the early script contains ${lazyName(id)}, which \`sinter({ lazy })\` loads lazily: the early module or a helper an early binding calls imports it (${relOf(id.replace(/^\0/, ''))})`));
        if (bad.length) this.error(`sinter: ${[...new Set(bad)].join('\n')}`);
      }
      const heads = () => {
        headFiles.clear();
        const common = [languageFiles.size ? I18N_PICKER : '', sharedHead?.code ?? ''].filter(Boolean).join('\n');
        if (common) {
          sharedHead = { code: common, modules: sharedHead?.modules ?? {}, fileName: `${r.build.assetsDir}/sinter-head-${hash(common)}.js` };
          this.emitFile({ type: 'asset', fileName: sharedHead.fileName, source: common });
        }
        for (const rel of new Set([...holdPages, ...earlyFiles.keys()])) {
          const source = [holdPages.has(rel) ? HOLD_SCRIPT : '', earlyFiles.get(rel)?.code ?? ''].filter(Boolean).join('\n');
          const name = rel.replace(/(^|\/)index\.html$/, '').replace(/\.html$/, '').replace(/\//g, '-') || 'index';
          const fileName = `${r.build.assetsDir}/${name}-head-${hash(source)}.js`;
          this.emitFile({ type: 'asset', fileName, source });
          headFiles.set(rel, fileName);
        }
      };
      if (!messages) return heads();
      // per page and language, the keys the page calls: its markup, the modules of its bundle, its early file
      for (const [rel, own] of markupMessages) {
        // a page with nothing to run (its messages written into the HTML in its language): no picker, no language file
        if (runtimeOf.get(rel)?.length === 0) continue;
        const entry = Object.values(bundle).find((c) => c.type === 'chunk' && c.isEntry && c.facadeModuleId === resolve(root, rel));
        // a page in one language: its markup's messages are compiled into it, so only the app's modules' are needed
        const one = virtual.get(resolve(root, rel))?.locale;
        const keys = new Set([...(one ? [] : own), ...(earlyKeys.get(rel) ?? [])]);
        const seen = new Set<string>(), todo = entry ? [entry.fileName] : [];
        while (todo.length) {
          const c = bundle[todo.pop()!];
          if (!c || c.type !== 'chunk' || seen.has(c.fileName)) continue;
          seen.add(c.fileName);
          for (const id of c.moduleIds) for (const k of moduleMessages.get(id) ?? []) keys.add(k);
          todo.push(...c.imports, ...c.dynamicImports);
        }
        if (!keys.size) continue;
        if (one) {
          const dict: Record<string, string> = {};
          for (const k of [...keys].sort()) dict[k] = messages.dicts[one]?.[k] ?? messages.dicts[messages.base]![k]!;
          pageMessages.set(rel, messagesTag(dict));
          continue;
        }
        const name = rel.replace(/(^|\/)index\.html$/, '').replace(/\.html$/, '').replace(/\//g, '-') || 'index';
        const files: Record<string, { fileName: string; code: string }> = {};
        for (const l of virtual.get(resolve(root, rel))?.locale ? [virtual.get(resolve(root, rel))!.locale] : messages.locales) {
          const dict: Record<string, string> = {};
          for (const k of [...keys].sort()) dict[k] = messages.dicts[l]?.[k] ?? messages.dicts[messages.base]![k]!;
          const code = languageFile(l, dict);
          const fileName = `${r.build.assetsDir}/${name}-${l}-${createHash('sha256').update(code).digest('base64url').slice(0, 8)}.js`;
          this.emitFile({ type: 'asset', fileName, source: code });
          files[l] = { fileName, code };
        }
        languageFiles.set(rel, files);
      }
      heads();
    },

    transform(code, id) {
      collect(this, code, id);
      return lazyTransform(this, code, id);
    },

    resolveId(id, importer) {
      // a page in a language: no file of its own (load gives its source's HTML)
      if ((locales || pageInputs) && id.endsWith('.html')) { const abs = resolve(root, id.replace(/^\//, '')); if (virtual.has(id) || virtual.has(abs)) return virtual.has(id) ? id : abs; }
      // a component's script imports its generated base from its own HTML file
      if (importer && id.endsWith('.html') && !importer.endsWith('.html')) {
        const file = resolve(dirname(importer.replace(/[?#].*$/, '')), id);
        const name = file.slice(0, -5).split(sep).pop()!;
        if (COMPONENT_NAME.test(name) && (dirname(file) === resolve(root, 'src/components') || (options.components?.length && isComponentScript(root, file.slice(0, -5) + '.ts', proj().libraries)))) return `\0${COMPONENT_BASE}${name}.js`;
      }
      // a build with source maps: page modules keep a plain id, as Rolldown drops the map of a `\0` module
      if (id.startsWith(PREFIX) && !dev && maps.has(id)) return id;
      if (id.startsWith(PREFIX)) return '\0' + id;
      return null;
    },

    async load(id) {
      if (virtual.has(id)) return readPage(id);
      // a stylesheet a page links (one with nothing to run) comes with a query in dev (`?direct`)
      const css = id.replace(/\?.*$/, '');
      if (css.startsWith(`\0${IMG_CSS}`)) return imageCss.get(css.slice(IMG_CSS.length + 1, -4)) ?? '';
      if (css.startsWith(`\0${PAINT_CSS}`)) return paintCss.get(css.slice(PAINT_CSS.length + 1, -4)) ?? '';
      if (css === `\0${COMPONENT_CSS}${LAYERS_SHEET}.css`) return `@layer ${LIBRARY_LAYER};\n`;
      if (css.startsWith(`\0${COMPONENT_CSS}`)) return componentCss.get(css.slice(COMPONENT_CSS.length + 1, -4)) ?? '';
      if (id.startsWith(`\0${COMPONENT_BASE}`)) return componentBase(id.slice(COMPONENT_BASE.length + 1, -3));
      // lazy packages: the loader (one `import()` of the package) and each importer's stubs
      const lz = id.startsWith(`\0${LAZY}`) ? parseLazyId(id.slice(1)) : null;
      if (lz && lazyPackage(lz.spec, lazyPkgs)) {
        if (lz.names) return stubModule(lz.spec, lz.names);
        // a lazy package that only a component library depends on (its own node_modules, as a workspace has it):
        // resolved from the library, and imported by that path
        const own = await this.resolve(lz.spec, resolve(root, 'index.html'));
        let r = own, spec = lz.spec;
        if (!r) for (const l of options.components?.length ? proj().libraries : []) {
          r = await this.resolve(lz.spec, join(l.folder, 'index.js'));
          if (r) { spec = r.id; break; }
        }
        if (dev) return loaderModule(spec, null);
        if (r) lazyIds.set(lz.spec, r.id);
        return loaderModule(spec, r?.id ?? null);
      }
      // dev: the picker, and each language's whole dictionary
      if (id === `\0${PREFIX}i18n.js`) return I18N_PICKER;
      if (id === `\0${PREFIX}img-check.js`) return IMAGE_CHECK;
      if (id === `\0${PREFIX}warn-relay.js`) return WARN_RELAY;
      if (id === `\0${PREFETCH}`) return prefetchModule(prefetchPages(), proj().helpers);
      if (id === `\0${SWAP}`) return swapModule(swapPages());
      const lang = id.startsWith(`\0${PREFIX}messages/`) && messages ? id.slice(`\0${PREFIX}messages/`.length, -3) : null;
      if (lang && messages?.dicts[lang]) return languageFile(lang, { ...messages.dicts[messages.base], ...messages.dicts[lang] });
      const key = id.startsWith('\0' + PREFIX) ? id.slice(1) : !dev && maps.has(id) ? id : null;
      if (key === null) return null;
      const code = modules.get(key);
      if (code === undefined) throw new Error(`sinter: page module ${key} requested before its HTML was compiled`);
      // dev: the page's whole early script (also served by the middleware above, outside the module pipeline)
      if (dev && key.startsWith(EARLY)) { const { code: c, map: m } = await devScript(key); return m ? { code: c, map: m } : c; }
      const map = maps.get(key);
      return map ? { code, map } : code;
    },

    configurePreviewServer(s) {
      s.middlewares.use(rulesMiddleware(() => { try { return readFileSync(resolve(root, resolved!.build.outDir, RULES_FILE), 'utf8'); } catch { return null; } }));
    },

    closeBundle() {
      if (dev) return;
      // strict: the build's warnings fail it, now that every one has been reported
      if (strictFailures.size) {
        const list = [...strictFailures];
        strictFailures.clear();
        throw new Error(`sinter: ${list.length} warning(s) fail the build in strict mode (sinter({ strict: { allow: { SNxxx: 'reason' } } }) keeps a code a warning; docs/strict.md)\n${list.join('\n')}`);
      }
      // inline rules: name what a CSP must allow; header: what the server must send. Once per build
      // pages with a CSP <meta> got the hash: nothing to say. The rest may have a CSP header the build cannot see
      if (speculationHash && unhashedPages) resolved?.logger.info(`sinter: Speculation Rules are inline in the pages: nothing to do without a CSP; a CSP sent as a response header must allow them: add 'inline-speculation-rules' to its script-src (or ${[...speculationHashes].map((h) => `'${h}'`).join(' and ')}, which change${speculationHashes.size > 1 ? '' : 's'} with the pages). docs/navigation.md`);
      if (rulesWritten) resolved?.logger.info(`sinter: Speculation Rules in ${RULES_FILE}: send \`Speculation-Rules: "${rulesUrl()}"\` with every page and serve the file as application/speculationrules+json (docs/navigation.md)`);
    },

    async buildEnd(error) {
      // a `static` pattern that matches no page: a renamed page would drop out of the check unnoticed
      const missing = !error && !dev && Array.isArray(options.static) ? staticPages(root, options.static).unmatched([...seen].map((f) => virtual.get(f)?.source ?? f)) : [];
      if (missing.length) this.error(`sinter({ static }): no page matches ${missing.map((m) => `\`${m}\``).join(', ')} (paths relative to the root, such as \`about.html\` or \`docs/**\`)`);
      // the helper calls that folded, again in a fresh copy of the helpers module, the pages in reverse order
      if (!error && !dev && foldCalls.size && isClient(this)) {
        const pages = [...foldCalls];
        foldCalls.clear();
        const p = proj();
        const fresh = await loadHelpers({ root, helpersFile: p.helpersFile, manifest: p.helpers, fresh: true, ...(resolved ? { configFile: resolved.configFile ?? false, mode: resolved.mode, ...(resolved.configFile ? {} : { alias: resolved.resolve.alias }) } : {}), cache: foldCache });
        if (!fresh.module) resolved?.logger.warn(coded('SN534', `the helper calls that ran at build time could not be checked again in a fresh copy of the helpers module (${fresh.error?.split('\n')[0] ?? 'it did not load'}): a helper that keeps state between calls would go unnoticed`));
        else {
          const bad = crossCheck(fresh.module, pages);
          if (bad.length) this.error(`sinter: error SN534 helper-not-folded: ${crossMessage(bad)}\n  docs: \`npx sinter docs SN534\`, ${docsUrl('SN534')}`);
        }
      }
      if (error || !options.typecheck || dev || !units.size) return;
      const { check } = await import('./check/index.js');
      const p = proj();
      const r = check({ root, units: [...units.values()], helpers: p.helpers, actions: p.actions, types: p.types, openapi: p.openapi, messagesTypes: p.messagesTypes });
      units.clear();
      if (r.diagnostics.length) this.error(`sinter check: ${r.diagnostics.length} type error(s)\n${r.diagnostics.map(formatDiagnostic).join('\n')}`);
    },

    transformIndexHtml: {
      order: 'pre',
      async handler(html, ctx) {
        const file = ctx.filename;
        const rel = relOf(file);
        const moduleSrc = `${PREFIX}${rel}.js`;
        // dev: the tag goes in with the page; a build adds it after bundling (see the post plugin)
        const earlySrc = dev ? `${resolved?.base ?? '/'}${EARLY.slice(1)}${rel}.js` : null;
        // the cascade, for images and for the space of lists (in the page or in its components)
        const styles = (images && /<img\b|<[a-z][a-z0-9]*-/i.test(html)) || (firstPaint && /data-sn-for|<[a-z][a-z0-9]*-/i.test(html)) ? await stylesOf(html, virtual.get(file)?.source ?? file, proj()) : undefined;
        // the fonts' `line-height: normal`, for the space of lists (builds)
        const lineHeights = styles?.length && firstPaint && !dev && /data-sn-for|<[a-z][a-z0-9]*-/i.test(html) ? await lineHeightsOf(styles) : undefined;
        // the fonts' `0`, for images in a box sized in ch
        const zeros = images && styles?.some((s) => /\dch\b/i.test(s.css)) && styles.some((s) => /@font-face/i.test(s.css)) ? await zeroWidthsOf(styles) : undefined;
        await helpersReady();
        // the minifier reads every page's cascade (builds)
        const minifyStyles = options.minifyHtml !== false && !dev ? styles ?? await stylesOf(html, virtual.get(file)?.source ?? file, proj()) : undefined;
        let { out, p } = build(html, file, earlySrc, styles, lineHeights, zeros, minifyStyles, ctx.originalUrl);
        // images the compiler did not know yet: analysed, then the page is compiled again with them
        if (images && out.images?.pending.length) {
          await images.analyze(out.images.pending);
          ({ out, p } = build(html, file, earlySrc, styles, lineHeights, zeros, minifyStyles, ctx.originalUrl));
        }
        for (const w of out.remoteWidths ?? []) remoteWidths.add(w);
        // the page's early file from this compile (with the stylesheets), which wrote the page: its ids are the page's
        if (!dev && firstPaint) { if (out.early) earlyPages.set(rel, out.early); else earlyPages.delete(rel); }
        if (!dev) for (const o of out.unlistedOrigins ?? []) unlisted.add(o);
        // the build says which paginated lists hold no space before their data, and why
        if (!dev) for (const u of out.waits ?? []) resolved?.logger.info(`sinter: ${relOf(u.file)}:${u.line}: what follows <${u.what}> stays hidden while this list's first rows load: its width follows its content (${u.widths}), so they would move it; data-sn-wait="off" on it keeps it shown (docs/first-paint.md#a-box-whose-width-follows-the-list)`);
        if (!dev) for (const u of out.unheld ?? []) resolved?.logger.info(`sinter: ${relOf(u.file)}:${u.line}: no space held for this list's rows before its data: ${u.why} (docs/first-paint.md#reserved-space)`);
        if (out.paint !== undefined && paintCss.get(rel) !== out.paint) {
          paintCss.set(rel, out.paint);
          invalidate(`${PAINT_CSS}${rel}.css`);
        }
        if (out.images) {
          for (const v of out.images.variants) variants.set(images!.fileName(v), v);
          if (imageCss.get(rel) !== out.images.css) {
            imageCss.set(rel, out.images.css);
            invalidate(`${IMG_CSS}${rel}.css`);
          }
          for (const f of [...out.images.variants.map((v) => v.file), ...out.images.pending]) watch(f);
        }
        if (out.check) units.set(file, out.check);
        for (const f of out.files) watch(f);
        for (const g of out.globs ?? []) watchGlob(g);
        for (const f of [p.helpersFile, p.actionsFile]) if (f) watch(f);
        const diagnostics = strictly(out.diagnostics);
        const errors = diagnostics.filter((d) => d.severity === 'error');
        for (const d of diagnostics) if (d.severity === 'warning') console.warn(formatDiagnostic(d));
        if (errors.length) {
          const err = new Error(`sinter: ${errors.length} error(s)\n${errors.map(formatDiagnostic).join('\n')}`) as Error & { loc?: unknown; id?: string };
          err.id = errors[0]!.file;
          err.loc = { file: errors[0]!.file, line: errors[0]!.line, column: errors[0]!.col };
          throw err;
        }
        setModule(moduleSrc, out.module, out.map);
        invalidate(moduleSrc);
        invalidate(`${EARLY}${rel}.js`);
        // dev: the picker first in the head, with every language's whole dictionary; a build adds it after bundling
        const base = resolved?.base ?? '/', early = out.early != null;
        // dev: the console warns about images shown with too few pixels
        const imageChecked = dev && images ? out.html.replace('</body>', `<script type="module" src="${base}${PREFIX.slice(1)}img-check.js"></script></body>`) : out.html;
        // dev, strict: the runtime's warnings go to the terminal and the overlay
        const checked = dev && strict.on ? imageChecked.replace('</body>', `<script type="module" src="${base}${PREFIX.slice(1)}warn-relay.js"></script></body>`) : imageChecked;
        // Speculation Rules for links to the app's pages: the browser fetches (or prerenders) the next page
        const samePage = !!out.sameLinks;
        samePage ? sameLinkPages.add(rel) : sameLinkPages.delete(rel);
        const rules = speculationTag(samePage), page = rules ? withRulesHash(checked.replace('</head>', `  ${rules}\n</head>`), speculationHash!) : checked;
        if (rules && !dev && !hasCspMeta(checked)) unhashedPages++;
        // dev, a page in one language: its messages compiled in; the app's modules may call any of that language's
        const one = virtual.get(file)?.locale;
        if (dev && one && messages) {
          for (const f of Object.values(messages.files)) watch(f);
          const tag = messagesTag({ ...messages.dicts[messages.base], ...messages.dicts[one] });
          return page.replace(/<head[^>]*>/, (h) => h + tag);
        }
        if (dev && out.messages && messages) {
          for (const f of Object.values(messages.files)) watch(f);
          const tag = pickerTag(`${base}${PREFIX.slice(1)}i18n.js`, Object.fromEntries(messages.locales.map((l) => [l, `${base}${PREFIX.slice(1)}messages/${l}.js`])), virtual.get(file)?.locale);
          return page.replace(/<head[^>]*>/, (h) => h + tag);
        }
        return page;
      },
    },
  };

  // CSS backgrounds (docs/images.md, step 3). Dev: a normal-order plugin sees each stylesheet after
  // Vite's CSS compiler (Sass, PostCSS, url() rebased to root paths) and before its post-processing.
  const STYLE_ID = /\.(css|scss|sass|less|styl|stylus|pcss|postcss|sss)(\?|$)/;
  const cssImages: Plugin = {
    name: 'sinter:css-images',
    apply: 'serve',
    async transform(code, id) {
      if (!images || !STYLE_ID.test(id) || /[?&](inline|url|raw)\b/.test(id) || id.includes('/node_modules/')) return null;
      const base = resolved?.base ?? '/', img = images;
      const host: CssImageHost = {
        source: (url) => {
          if (/^[a-z][a-z\d+.-]*:|^\/\/|[?#]/i.test(url) || !/\.(jpe?g|png|webp|avif)$/i.test(url)) return null;
          const path = url.startsWith(base) ? '/' + url.slice(base.length) : url;
          if (!path.startsWith('/')) return null;
          const file = path.startsWith('/@fs/') ? path.slice(4) : resolve(root, '.' + decodeURI(path));
          return img.info(file) === null ? null : file;
        },
        info: (f) => img.info(f), analyze: (f) => img.analyze(f),
        url: (v) => `${base}${IMG.slice(1)}${img.fileName(v)}`,
      };
      const out = await rewriteCssImages(code, host);
      if (!out) return null;
      for (const v of out.variants) variants.set(images.fileName(v), v);
      return { code: out.css, map: null };
    },
  };

  const post: Plugin = {
    name: 'sinter:early',
    enforce: 'post',
    apply: 'build',
    /** builds: the finished stylesheets, whose url()s name the build's copies of the images (their `originalFileNames` the sources) */
    async generateBundle(_, bundle) {
      patchChunkUrls(bundle);
      if (!images) return;
      const img = images, r = resolved!;
      const byName = new Map<string, string>();
      for (const a of Object.values(bundle)) {
        if (a.type !== 'asset' || !/\.(jpe?g|png|webp|avif)$/i.test(a.fileName)) continue;
        const orig = (a as { originalFileNames?: string[] }).originalFileNames?.[0];
        if (orig) byName.set(a.fileName.slice(a.fileName.lastIndexOf('/') + 1), resolve(root, orig));
      }
      if (!byName.size) return;
      const emitted = new Set(variants.keys());
      for (const a of Object.values(bundle)) {
        if (a.type !== 'asset' || !a.fileName.endsWith('.css')) continue;
        // a relative base: URLs relative to the stylesheet, as Vite writes its own
        const from = posix.dirname(a.fileName);
        const host: CssImageHost = {
          source: (url) => {
            if (/^data:/i.test(url)) return null;
            const path = url.replace(/[?#].*$/, '');
            return byName.get(path.slice(path.lastIndexOf('/') + 1)) ?? null;
          },
          info: (f) => img.info(f), analyze: (f) => img.analyze(f),
          url: (v) => {
            const file = `${r.build.assetsDir}/${img.fileName(v)}`;
            if (!relativeBase(r.base)) return r.base + file;
            const relPath = posix.relative(from, file);
            return relPath.startsWith('.') ? relPath : `./${relPath}`;
          },
        };
        const out = await rewriteCssImages(String(a.source), host);
        if (!out) continue;
        a.source = out.css;
        await Promise.all(out.variants.map(async (v) => {
          const name = img.fileName(v);
          if (emitted.has(name)) return;
          emitted.add(name);
          this.emitFile({ type: 'asset', fileName: `${r.build.assetsDir}/${name}`, source: await img.encode(v) });
        }));
      }
    },
    transformIndexHtml: {
      order: 'post',
      handler(html, ctx) {
        const rel = relOf(ctx.filename), early = earlyFiles.get(rel), langs = languageFiles.get(rel), own = headFiles.get(rel);
        reportRuntime(rel, ctx.chunk, ctx.bundle);
        // a relative base: URLs relative to the page, as Vite writes its own (`../assets/…` from `blog/post.html`)
        const base = pageBase(resolved?.base ?? '/', rel);
        // the page bundle is `async`: it does not wait for the stylesheets as a deferred module does,
        // and mounts once the document is parsed and the early script has rendered (see the page module)
        // (on a page with nothing to run, the chunk is the page's own script: it stays a plain, deferred module script)
        if (ctx.chunk && runtimeOf.get(rel)?.length !== 0) html = html.replace(`<script type="module" crossorigin src="${base}${ctx.chunk.fileName}">`, (t) => t.slice(0, -1) + ' async>');
        // the embedded-data placeholders last in the head, after the tags Vite added (the page module, its
        // preloads, the stylesheets): a server that streams the page up to the first one sends all of those first
        const slots = embedPages.get(rel)?.data;
        if (slots?.length) {
          const tags: string[] = [];
          for (const d of slots) {
            const tag = `<script type="application/json" data-sn="${d.id}"></script>`;
            if (html.includes(tag)) { html = html.replace(tag, ''); tags.push(tag); }
          }
          html = html.replace('</head>', `${tags.map((t) => `  ${t}\n`).join('')}</head>`);
        }
        // the head templates (anchors' templates the early script renders) after all of that: nothing the browser
        // fetches waits behind their bytes
        html = headTemplatesLast(html);
        // `data-sn-preload`: the lazy packages' chunks, fetched with the page
        const pre = preloadOf.get(rel);
        if (pre && ctx.bundle) html = withPreloads(html, rel, pre, ctx.bundle, base);
        const inline = pageMessages.get(rel);
        if (!early && !langs && !own && !inline) return html;
        // a page in one language: the messages its app modules call, before any script that reads them
        const tags: string[] = inline ? [inline] : [];
        // the shared head script (with the picker, its data on the tag), then the page's: classic scripts, run in order
        if ((early || langs) && sharedHead) {
          tags.push(langs ? pickerTag(base + sharedHead.fileName, Object.fromEntries(Object.entries(langs).map(([l, f]) => [l, base + f.fileName])), virtual.get(resolve(root, rel))?.locale) : `<script src="${attr(base + sharedHead.fileName)}"></script>`);
        }
        if (own) tags.push(`<script src="${attr(base + own)}"></script>`);
        if (early || langs) report(rel, early ? { fileName: own!, ...early } : null, langs ?? null);
        // first in the head, before the stylesheets (a classic script waits for the stylesheets before it) and the page
        // module (which the hold script changes as the parser inserts it): the early requests leave at once
        const at = html.search(/<link\b[^>]*\brel=["']?(stylesheet|modulepreload)|<script\b/i);
        const block = tags.join('\n  ');
        return at >= 0 ? html.slice(0, at) + block + '\n  ' + html.slice(at) : html.replace('</head>', `  ${block}\n</head>`);
      },
    },
  };

  /** whether a module id is (in) a lazy package, as Rolldown resolved it */
  const isLazyModule = (id: string) => lazyPkgs.some((p) => id.includes(`/node_modules/${p}/`));
  const lazyName = (id: string) => lazyPkgs.find((p) => id.includes(`/node_modules/${p}/`)) ?? id;

  /**
   * SN325 (builds): a page's static graph (what its bundle loads with it) contains a lazy package after
   * all, through a package that imports it; or an app module that a module of the page loads with
   * `import()` is imported statically by the page too, so the split does nothing for it. With the chain.
   */
  function guardLazy(ctx: { getModuleIds(): IterableIterator<string>; getModuleInfo(id: string): { importedIds: readonly string[]; dynamicImporters: readonly string[] } | null; error(m: string): never }) {
    const name = (id: string) => {
      const x = id.replace(/^\0/, '');
      return x.startsWith(PREFIX) && x.endsWith('.html.js') ? x.slice(PREFIX.length, -3) : relOf(x);
    };
    const pages = [...ctx.getModuleIds()].filter((id) => { const x = id.replace(/^\0/, ''); return x.startsWith(PREFIX) && x.endsWith('.html.js') && !x.startsWith(EARLY); });
    const errors: string[] = [];
    for (const page of pages) {
      const prev = new Map<string, string | null>([[page, null]]), todo = [page];
      while (todo.length) {
        const id = todo.shift()!;
        for (const next of ctx.getModuleInfo(id)?.importedIds ?? []) if (!prev.has(next)) { prev.set(next, id); todo.push(next); }
      }
      const chain = (id: string) => { const c: string[] = []; for (let x: string | null = id; x; x = prev.get(x) ?? null) c.unshift(x); return c; };
      const shown = (ids: string[]) => ids.map((x) => (isLazyModule(x) ? lazyName(x) : name(x))).filter((x, i, a) => a.indexOf(x) === i).join(' → ');
      const hit = new Set<string>();
      for (const id of prev.keys()) {
        if (isLazyModule(id)) {
          const pkg = lazyName(id);
          if (hit.has(pkg)) continue;
          hit.add(pkg);
          errors.push(`SN325 ${name(page)}: the page bundle contains ${pkg}, which \`sinter({ lazy })\` loads lazily: ${shown(chain(id))}. A package imports it: add that package to \`lazy\` too, or load it with \`import()\``);
          continue;
        }
        if (id.startsWith('\0') || id.includes('/node_modules/')) continue;
        const by = ctx.getModuleInfo(id)?.dynamicImporters.find((d) => prev.has(d));
        if (by) errors.push(`SN325 ${name(page)}: ${name(id)} is loaded with \`import()\` by ${name(by)}, and imported statically by the page too (${shown(chain(id))}), so the split does nothing for it. Import it only with \`import()\`, or not lazily at all`);
      }
    }
    if (errors.length) ctx.error(`sinter: ${errors.join('\n')}`);
  }

  /**
   * Builds, `data-sn-preload`: a modulepreload link for each lazy package's chunk and the chunks it
   * imports, at the end of the head (the browser fetches and compiles them; the first call runs them).
   */
  function withPreloads(html: string, rel: string, specs: string[], bundle: Record<string, unknown>, base: string): string {
    type C = { type: string; fileName: string; facadeModuleId?: string | null; imports?: string[] };
    const chunks = Object.values(bundle) as C[];
    const files: string[] = [];
    // the packages, and the page's component scripts that load with them
    const ids = specs.map((spec) => ({ spec, id: lazyIds.get(spec) }));
    for (const x of lazyScriptsOf.get(rel) ?? []) if (x.lazy.some((s) => specs.includes(s))) ids.push({ spec: x.module, id: resolve(root, '.' + x.module) });
    for (const { spec, id } of ids) {
      const c = id ? chunks.find((x) => x.type === 'chunk' && x.facadeModuleId === id) : undefined;
      if (!c) { warnOnce(coded('SN520', `${rel} preloads ${spec} (data-sn-preload), but no module of the app imports it: there is nothing to preload`)); continue; }
      const todo = [c.fileName];
      while (todo.length) {
        const f = todo.shift()!;
        if (files.includes(f)) continue;
        files.push(f);
        const x = bundle[f] as C | undefined;
        if (x?.type === 'chunk') todo.push(...(x.imports ?? []));
      }
    }
    const tags = files.filter((f) => !html.includes(`"${base}${f}"`)).map((f) => `<link rel="modulepreload" crossorigin href="${attr(base + f)}">`);
    return tags.length ? html.replace('</head>', `  ${tags.join('\n  ')}\n</head>`) : html;
  }

  /**
   * Builds: each lazy loader learns its chunk's URL (relative to the loader's own chunk), so a failed
   * load can ask the server whether the chunk is still there (lazy.ts): the mark becomes the path.
   */
  function patchChunkUrls(bundle: Record<string, { type: string; fileName: string; code?: string; facadeModuleId?: string | null }>) {
    const byFacade = new Map<string, string>();
    for (const c of Object.values(bundle)) if (c.type === 'chunk' && c.facadeModuleId) byFacade.set(c.facadeModuleId, c.fileName);
    // inside one string literal only: a match can never run across code to the next mark
    const mark = new RegExp(`(["'\`])${CHUNK_MARK}([^"'\`\\n]+?)__\\1`, 'g');
    for (const c of Object.values(bundle)) {
      if (c.type !== 'chunk' || !c.code?.includes(CHUNK_MARK)) continue;
      c.code = c.code.replace(mark, (_, _q: string, raw: string) => {
        let id = raw;
        try { id = JSON.parse(`"${raw}"`) as string; } catch { /* as written */ }
        const target = byFacade.get(id);
        if (!target) return 'null';
        const rel = posix.relative(posix.dirname(c.fileName), target);
        return JSON.stringify(rel.startsWith('.') ? rel : `./${rel}`);
      });
    }
  }

  /**
   * One line per page: no JavaScript, or the page's module and the chunks it imports (gzip), and why it
   * needs them (the first few things that run in the browser, where they were written).
   */
  function reportRuntime(rel: string, chunk: { fileName: string; code: string; imports: string[] } | undefined, bundle: Record<string, unknown> | undefined) {
    const reasons = runtimeOf.get(rel);
    if (!reasons) return;
    const logger = resolved?.logger;
    if (!reasons.length) { logger?.info(`sinter: ${rel}: no JavaScript`); return; }
    const kb = (n: number) => `${(n / 1000).toFixed(1)} kB`;
    let shared = 0;
    const done = new Set<string>(), todo = [...(chunk?.imports ?? [])];
    while (todo.length) {
      const f = todo.pop()!;
      if (done.has(f)) continue;
      done.add(f);
      const c = bundle?.[f] as { type?: string; code?: string; imports?: string[] } | undefined;
      if (c?.type !== 'chunk' || c.code === undefined) continue;
      shared += gzipSync(c.code).length;
      todo.push(...(c.imports ?? []));
    }
    const size = chunk ? `${kb(gzipSync(chunk.code).length)} gzip${shared ? ` + ${kb(shared)} gzip shared` : ''}` : 'runtime';
    const where = (r: RuntimeReason) => `${r.what} (${relative(root, r.file).split(sep).join('/') || r.file}:${r.line})`;
    const list = reasons.slice(0, 3).map(where).join(', ') + (reasons.length > 3 ? `, and ${reasons.length - 3} more` : '');
    logger?.info(`sinter: ${rel}: JavaScript ${size}: ${list}${lazySizes(rel, chunk, done, bundle)}`);
  }

  /**
   * What a page defers (its log line): each lazy package and lazy component script its bundle can load,
   * with the chunks that load with it and not with the page (gzip)
   */
  function lazySizes(rel: string, chunk: { fileName: string; code: string; imports: string[] } | undefined, statics: Set<string>, bundle: Record<string, unknown> | undefined): string {
    if (!lazyPkgs.length || !chunk || !bundle) return '';
    type C = { type?: string; code?: string; imports?: string[]; dynamicImports?: string[]; facadeModuleId?: string | null };
    const own = new Set([chunk.fileName, ...statics]), scripts = new Set((lazyScriptsOf.get(rel) ?? []).map((x) => resolve(root, '.' + x.module)));
    const out: string[] = [], counted = new Set<string>();
    // the packages first: a chunk both a package and a script load counts as the package's
    const found = new Map<string, { label: string; pkg: boolean }>();
    for (const f of own) {
      for (const d of (bundle[f] as C | undefined)?.dynamicImports ?? []) {
        const facade = (bundle[d] as C | undefined)?.facadeModuleId ?? '';
        if (isLazyModule(facade)) found.set(d, { label: lazyName(facade), pkg: true });
        else if (scripts.has(facade)) found.set(d, { label: relOf(facade), pkg: false });
      }
    }
    for (const [d, { label }] of [...found].sort((a, b) => Number(b[1].pkg) - Number(a[1].pkg))) {
      if (out.some((x) => x.startsWith(label + ' '))) continue;
      let gz = 0;
      const todo = [d];
      while (todo.length) {
        const x = todo.pop()!;
        if (own.has(x) || counted.has(x)) continue;
        counted.add(x);
        const c = bundle[x] as C | undefined;
        if (c?.type !== 'chunk' || c.code === undefined) continue;
        gz += gzipSync(c.code).length;
        todo.push(...(c.imports ?? []));
      }
      out.push(`${label} ${(gz / 1000).toFixed(1)} kB gzip`);
    }
    return out.length ? `; lazy: ${out.join(', ')}` : '';
  }

  /** One line per page: the early file's size (gzip) and its language files'; over the budget a warning naming the largest modules. */
  function report(rel: string, early: { fileName: string; code: string; modules: Record<string, { renderedLength: number }> } | null, langs: Record<string, { code: string }> | null) {
    const kb = (n: number) => `${(n / 1000).toFixed(1)} kB`;
    // the shared head script is on the first paint's path too: it counts toward the budget
    const own = early ? gzipSync(early.code).length : 0, common = early && sharedHead ? gzipSync(sharedHead.code).length : 0, gz = own + common;
    const files = langs ? `, messages ${Object.entries(langs).map(([l, f]) => `${l} ${kb(gzipSync(f.code).length)}`).join(', ')} gzip` : '';
    const line = `sinter: early script of ${rel}: ${early ? `${early.fileName} ${kb(own)} gzip${common ? ` + ${sharedHead!.fileName} ${kb(common)} gzip (shared)` : ''}` : 'none'}${files}`;
    const logger = resolved?.logger;
    if (!early || gz <= budget) { logger?.info(line); return; }
    const top = Object.entries({ ...sharedHead?.modules, ...early.modules }).sort((a, b) => b[1].renderedLength - a[1].renderedLength).slice(0, 5)
      .map(([id, m]) => `${id.includes(PREFIX) ? `the early bindings of ${rel}` : relative(root, id.replace(/^\0/, '')).split(sep).join('/')} ${kb(m.renderedLength)}`);
    const msg = `${line}, over the early budget of ${kb(budget)}. It renders before the first paint: keep heavy imports out of src/sinter.early.ts and of the helpers early bindings call. Largest (before gzip): ${top.join(', ')}`;
    const warning = coded('SN523', msg.replace(/^sinter: /, ''));
    if (logger) logger.warn(warning); else console.warn(warning);
  }

  // Google Fonts as the app's own CSS (`fonts`, on by default; see fonts-build.ts), and the faces to preload
  const fontSheets = new Map<string, string>();
  let downloadFont: ((url: string) => Promise<string | null>) | null = null;
  const download = () => (downloadFont ??= fontDownloader(resolve(root, 'node_modules/.cache/sinter/fonts')));
  const preloads: FontFaceRef[] = (options.fonts?.preload ?? []).map(faceOf);
  /** build: the faces each page preloads, by its path relative to the root (the HTML file's name in the bundle) */
  const pagePreloads = new Map<string, FontFaceRef[]>();
  const fonts: Plugin = {
    name: 'sinter:fonts',
    enforce: 'pre',
    transformIndexHtml: {
      order: 'pre',
      async handler(html, ctx) {
        const dev = !!ctx.server;
        // first the preloads: they read the Google Fonts links, which the inlining below rewrites
        if (preloads.length) {
          const out = await preloadFonts(html, download(), preloads, dev);
          html = out.html;
          if (!dev) pagePreloads.set(relative(root, ctx.filename).split(sep).join('/'), out.preloaded);
        }
        if (dev || options.fonts?.inline === false) return html;
        const out = await inlineFonts(html, download());
        for (const [id, url] of out.ids) fontSheets.set(id, url);
        for (const url of out.failed) resolved?.logger.warn(coded('SN526', `could not download ${url}; the page keeps the link (sinter({ fonts: { inline: false } }) turns this off)`));
        return out.html;
      },
    },
    resolveId: (id) => (fontSheets.has(id) ? id : null),
    async load(id) {
      const url = fontSheets.get(id);
      return url ? ((await downloadFont!(url)) ?? '') : null;
    },
  };
  // build: the faces no Google Fonts stylesheet had are looked up in the page's own bundled CSS (a
  // local font, e.g. Fontsource); a preloaded face whose family the page's stylesheets do not use
  // fails the build, as does one no page has
  const fontCheck: Plugin = {
    name: 'sinter:font-check',
    enforce: 'post',
    apply: 'build',
    generateBundle(_, bundle) {
      if (!preloads.length) return;
      const base = resolved?.base ?? '/', pub = resolved?.publicDir || '';
      const text = (s: string | Uint8Array) => (typeof s == 'string' ? s : Buffer.from(s).toString('utf8'));
      /** a stylesheet the page links, from the bundle or the public directory; '' for another origin's or a missing one */
      const sheet = (href: string, page: string) => {
        if (/^[a-z][\w+.-]*:|^\/\//i.test(href)) return '';
        const path = href.split(/[?#]/)[0]!;
        const name = path.startsWith(base) ? path.slice(base.length) : posix.join(posix.dirname(page), path);
        const a = bundle[name.replace(/^\/+/, '')];
        if (a?.type == 'asset') return text(a.source);
        const file = pub && resolve(pub, name.replace(/^\/+/, ''));
        try { return file ? readFileSync(file, 'utf8') : ''; } catch { return ''; }
      };
      const found = new Set<string>();
      for (const [page, google] of pagePreloads) {
        const html = bundle[page];
        if (html?.type != 'asset') continue;
        let doc = text(html.source);
        const sheets = [
          ...[...doc.matchAll(/<link\b[^>]*>/gi)].filter((m) => /\brel=["']?stylesheet\b/i.test(m[0])).map((m) => /\bhref=["']([^"']+)["']/i.exec(m[0])?.[1] ?? '').map((href) => ({ href, css: sheet(href, page) })),
          ...[...doc.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)].map((m) => ({ href: '', css: m[1]! })),
        ];
        const rest = preloads.filter((f) => !google.some((g) => faceName(g) == faceName(f)));
        const local = rest.length ? preloadLocalFonts(doc, sheets, rest) : { html: doc, preloaded: [] };
        if (local.html != doc) html.source = doc = local.html;
        const faces = [...google, ...local.preloaded];
        for (const f of faces) found.add(faceName(f));
        if (!faces.length) continue;
        const css = [...sheets.map((x) => x.css), ...[...doc.matchAll(/\sstyle=(?:"([^"]*)"|'([^']*)')/gi)].map((m) => `x{${m[1] ?? m[2]}}`)].join('\n');
        for (const f of faces) if (!usesFamily(css, f.family)) this.error(`sinter({ fonts: { preload } }): ${page} preloads ${faceName(f)}, but no stylesheet of the page uses the family \`${f.family}\` (a font-family or font declaration): the preload is downloaded for nothing. Remove it, or use the font`);
      }
      const none = preloads.filter((f) => !found.has(faceName(f)));
      if (none.length) this.error(`sinter({ fonts: { preload } }): no page's stylesheets (Google Fonts or the app's own \`@font-face\`) have ${none.map(faceName).join(', ')}: nothing to preload. Check the family, weight and style against the stylesheet`);
    },
  };
  // Page URLs: every page with a fixed path is a directory's index (`about.html` at `/about/`); see page-urls.ts
  const base = () => resolved?.base ?? '/';
  /** a page's source file for a site path (`/about/`, `/about`, `/about.html`) when that page moves into a directory */
  const movedPage = (path: string): string | null => {
    const b = base().startsWith('/') ? base().replace(/\/?$/, '/') : '/';
    if (!path.startsWith(b)) return null;
    const name = path.slice(b.length).replace(/\/$/, '').replace(/\.html?$/, '');
    if (!name) return null;
    const file = resolve(root, `${name}.html`);
    if (!file.startsWith(root + sep) || !existsSync(file)) return null;
    return movesToDirectory(relOf(file), base(), describe(file).path) ? file : null;
  };
  /**
   * The site's rules: each page's (`pageRoutes`), and with `localePrefix` the language choosers' at the unprefixed
   * paths: a rewrite from a source page's paths and its old file URL to its chooser, so `/about.html` is one hop from
   * `/de/about/` (`choose`: a server picks the language itself, by the `locale` cookie, else `Accept-Language`)
   */
  const siteRoutes = (): Array<Route & { choose?: true }> => {
    const b = base();
    const pages = pageRoutes(pageEntries(), b);
    if (!locales) return pages;
    const choosers = pageRoutes(sourceEntries().map((f) => ({ rel: relOf(f), patterns: describeSource(f).path })), b).map((r) => ({ ...r, status: 200 as const, file: r.file ?? r.from.slice((b.startsWith('/') ? b.replace(/\/?$/, '/') : '/').length), choose: true as const }));
    const dynamic = (r: Route) => /[:*]/.test(r.from);
    const all = [...pages, ...choosers];
    return [...all.filter((r) => !dynamic(r)), ...all.filter(dynamic)];
  };
  /** `localePrefix`: where a source page's language chooser is written (its unprefixed URL's file), and that URL */
  const chooserFile = (rel: string) => pageFile(rel, base(), describeSource(resolve(root, rel)).path);
  const chooserUrl = (source: string) => pageUrl(relOf(source), base(), describeSource(source).path) ?? base();
  /** a source page's language chooser: its languages' URLs, the base language's when nothing else decides */
  const chooserFor = (source: string, script: boolean) => {
    const b = base().startsWith('/') ? base().replace(/\/?$/, '/') : '/', urls = localeUrls(source);
    return chooserHtml({
      base: b, locales: locales!, urls, script,
      fallback: urls ? urls[locales!.base]! : b + locales!.base + '/',
      hreflang: siteOrigin && urls ? hreflangTags(siteOrigin, urls, chooserUrl(source)) : '',
    });
  };
  /** a rule's path against a request's: literal segments, `:name` for any one, a trailing slash either way */
  const matches = (from: string, path: string) => {
    const a = from.split('/').filter(Boolean), b = path.split('/').filter(Boolean);
    return a.length === b.length && a.every((s, i) => s[0] === ':' || s === b[i]);
  };
  /** the page whose file a declared path rewrites to (`/article/hello` → article.html), as `_redirects` says */
  const rewrite = (path: string): Route | undefined => siteRoutes().find((r) => r.status === 200 && matches(r.from, path));
  /** dev: `/about/` is `about.html`; `/about` and `/about.html` redirect to `/about/`; a declared path is its page, as a host does with the built site */
  const devPages = (req: { url?: string; originalUrl?: string }, res: { statusCode: number; setHeader(k: string, v: string): void; end(s?: string): void }, next: (e?: unknown) => void) => {
    const [path, query = ''] = (req.url ?? '/').split(/\?(.*)/s, 2) as [string, string?];
    const q = query ? `?${query}` : '';
    if (locales) return devLocales(path, q, req, res, next);
    const file = movedPage(path);
    // `/login/` for login.html (a page that stays in its file): to `/login`, as hosts do
    if (!file && path.length > 1 && path.endsWith('/') && base().startsWith('/') && path.startsWith(base()) && !existsSync(join(root, path.slice(base().length), 'index.html')) && existsSync(join(root, `${path.slice(base().length, -1)}.html`))) {
      res.statusCode = 301;
      res.setHeader('Location', `${path.slice(0, -1)}${q}`);
      res.end();
      return;
    }
    if (!file) {
      const r = !/\.[a-z\d]+$/i.test(path) && base().startsWith('/') ? rewrite(path) : undefined;
      if (r) req.url = `${base().replace(/\/?$/, '/')}${r.file}${q}`;
      return next();
    }
    if (path.endsWith('/')) { req.url = `${path.replace(/\/$/, '')}.html${q}`; return next(); }
    res.statusCode = 301;
    res.setHeader('Location', `${path.replace(/\.html?$/, '')}/${q}`);
    res.end();
  };
  /** dev with `localePrefix`: a page in a language at its URLs (`/de/about/`), and a language chooser at an unprefixed one */
  const devLocales = (path: string, q: string, req: { url?: string; originalUrl?: string }, res: { statusCode: number; setHeader(k: string, v: string): void; end(s?: string): void }, next: (e?: unknown) => void) => {
    if (/\.(?!html?$)[a-z\d]+$/i.test(path) || path.startsWith('/@') || path.startsWith('/node_modules/')) return next();
    const b = base().startsWith('/') ? base() : '/';
    const send = (html: string) => { res.statusCode = 200; res.setHeader('Content-Type', 'text/html'); res.end(html); };
    const moved = (to: string) => { res.statusCode = 301; res.setHeader('Location', to + q); res.end(); };
    for (const f of entries()) {
      const rel = relOf(f), pats = describe(f).path, url = pageUrl(rel, b, pats);
      const hit = path === b + rel || pagePaths(rel, b, pats).some((x) => matches(x, path));
      if (!hit) continue;
      if (movesToDirectory(rel, b, pats) && path !== url) return moved(url!);
      server!.transformIndexHtml(b + rel, readPage(f), req.originalUrl).then(send, next);
      return;
    }
    for (const s of sourceEntries()) {
      const rel = relOf(s), pats = describeSource(s).path;
      if (path === b + rel || pagePaths(rel, b, pats).some((x) => matches(x, path))) return send(chooserFor(s, true));
    }
    next();
  };
  /**
   * builds with `site`: the sitemap's files (sitemap-build.ts), from each page's finished HTML (`built`, by its file):
   * a page's URL as its canonical link names it, each language's with the others and the chooser as alternates, and
   * a pattern's URLs from `sitemap.paths`. 404.html, 200.html, `noindex` pages, pages whose canonical link names
   * another URL and patterns without values are left out, and the build's line names them.
   */
  const sitemap = async (fail: (m: string) => never, all: PageEntry[], built: Map<string, string>): Promise<Array<{ fileName: string; source: string }>> => {
    if (!siteOrigin || sitemapOptions === false) return [];
    const info = (m: string) => resolved?.logger.info(`sinter: ${m}`);
    if (relativeBase(base())) { info('no sitemap.xml with a relative base: the build does not know the URLs the site is served at'); return []; }
    const own = resolved?.publicDir ? resolve(resolved.publicDir, 'sitemap.xml') : null;
    if (own && existsSync(own)) { info(`sitemap.xml: the app's own (${relOf(own)}) is kept`); return []; }
    const b = base().replace(/\/?$/, '/'), given = sitemapOptions.paths ?? {}, used = new Set<string>();
    const urls: SitemapUrl[] = [], seen = new Set<string>(), left: string[] = [], known = new Set<string>();
    const add = (u: SitemapUrl) => { if (!seen.has(u.loc)) { seen.add(u.loc); urls.push(u); } };
    // the pages of each source page: one, or one per language
    const groups = new Map<string, Array<{ page: PageEntry; locale: string | null; html: string }>>();
    for (const page of all) {
      const html = built.get(page.rel), v = virtual.get(resolve(root, page.rel));
      if (html === undefined) continue;
      const src = v ? relOf(v.source) : page.rel;
      if (!groups.has(src)) groups.set(src, []);
      groups.get(src)!.push({ page, locale: v?.locale ?? null, html });
    }
    const valuesOf = async (pattern: string) => {
      const v = given[pattern]!;
      let list: unknown;
      try { list = typeof v === 'function' ? await v() : v; } catch (e) { fail(`sinter({ sitemap: { paths } }): \`${pattern}\` threw: ${e instanceof Error ? e.message : String(e)}`); }
      if (!Array.isArray(list)) fail(`sinter({ sitemap: { paths } }): \`${pattern}\` returned ${JSON.stringify(list)}, not a list of values`);
      return list as unknown[];
    };
    const fill = (pattern: string, value: unknown, src: string) => {
      const r = fillPattern(pattern, value);
      if (typeof r !== 'string') fail(`sinter({ sitemap: { paths } }): ${src}: ${r.error}`);
      return r;
    };
    for (const [src, list] of [...groups].sort(([x], [y]) => x.localeCompare(y))) {
      if (/(^|\/)(404|200)\.html?$/.test(src)) continue;
      const source = resolve(root, src);
      // each language's page that may be indexed, with its URL when it has a fixed one
      const pages = list.filter((x) => {
        if (!noindex(x.html)) return true;
        left.push(`${x.page.rel} (noindex)`);
        return false;
      });
      const fixed: Array<{ locale: string | null; loc: string }> = [];
      for (const x of pages) {
        const url = pageUrl(x.page.rel, base(), x.page.patterns);
        if (url === null) continue;
        const loc = siteOrigin + url, canonical = canonicalOf(x.html);
        if (canonical !== null && canonical !== loc) { left.push(`${x.page.rel} (its canonical link names ${canonical})`); continue; }
        fixed.push({ locale: x.locale, loc });
      }
      const alternates = (locs: Array<{ locale: string | null; loc: string }>, unprefixed: string) =>
        locales && locs.length ? { ...Object.fromEntries(locs.map((l) => [l.locale!, l.loc])), 'x-default': siteOrigin + unprefixed } : undefined;
      const alt = alternates(fixed, locales ? chooserUrl(source) : '');
      for (const f of fixed) add({ loc: f.loc, ...(alt ? { alternates: alt } : {}) });
      // the patterns with parameters, as the page writes them (without a language's prefix)
      const patterns = (locales ? describeSource(source).path : list[0]!.page.patterns).filter((p) => p.includes(':'));
      for (const pattern of patterns) {
        const has = pattern in given;
        known.add(pattern);
        if (has) used.add(pattern);
        if (!pages.length) continue;
        // a page with a fixed URL too: its canonical link names that URL at every path it answers at
        const fixedUrl = pageUrl(pages[0]!.page.rel, base(), pages[0]!.page.patterns);
        if (fixedUrl !== null) { left.push(`${src} ${pattern} (its canonical link names ${siteOrigin + fixedUrl})`); continue; }
        const own = pages.map((x) => canonicalOf(x.html)).find((c) => c !== null);
        if (own) { left.push(`${src} ${pattern} (its canonical link names ${own})`); continue; }
        if (!has) { left.push(`${src} ${pattern} (no values in sitemap.paths)`); continue; }
        for (const value of await valuesOf(pattern)) {
          const locs = pages.map((x) => ({ locale: x.locale, loc: siteOrigin + fill(x.locale ? prefixed([pattern], x.locale)[0]! : pattern, value, src) }));
          const a = alternates(locs, locales ? fill(pattern, value, src) : '');
          for (const l of locs) add({ loc: l.loc, ...(a ? { alternates: a } : {}) });
        }
      }
    }
    const unknown = Object.keys(given).filter((k) => !used.has(k));
    if (unknown.length) fail(`sinter({ sitemap: { paths } }): no page has the pattern \`${unknown[0]}\`; ${known.size ? `the patterns with parameters are ${[...known].map((p) => `\`${p}\``).join(', ')}` : 'no page has a pattern with parameters'}`);
    const files = sitemapFiles(urls, siteOrigin + b);
    info(`sitemap.xml: ${urls.length} URL${urls.length === 1 ? '' : 's'}${files.length > 1 ? ` in ${files.length - 1} files` : ''}${left.length ? `; left out: ${left.slice(0, 10).join(', ')}${left.length > 10 ? `, and ${left.length - 10} more` : ''}` : ''}`);
    return files;
  };
  const pages: Plugin = {
    name: 'sinter:pages',
    enforce: 'post',
    configureServer(s) { s.middlewares.use(devPages); },
    configurePreviewServer(s) {
      // the built site as a host serves it: the build's _redirects (301s from old file URLs, a declared path
      // rewritten to its page), and `/about` to `/about/` when about/index.html is there
      s.middlewares.use((req, res, next) => {
        const [path, query] = (req.url ?? '/').split(/\?(.*)/s, 2) as [string, string?];
        const q = query ? `?${query}` : '', out = resolve(root, resolved!.build.outDir);
        let rules: Array<{ from: string; to: string; status: number }> = [];
        try { rules = parseRedirects(readFileSync(join(out, '_redirects'), 'utf8')); } catch { /* none */ }
        const rule = rules.find((r) => !/^[a-z][a-z\d+.-]*:/i.test(r.to) && matches(r.from, path) && (r.from.includes(':') || r.from.includes('*') || r.from === path || r.from.replace(/\/$/, '') === path.replace(/\/$/, '')));
        if (rule && rule.status !== 200) { res.statusCode = rule.status; res.setHeader('Location', rule.to + q); res.end(); return; }
        if (rule) { req.url = rule.to + q; return next(); }
        if (!/\.[a-z\d]+$/i.test(path) && !path.endsWith('/') && existsSync(join(out, path, 'index.html'))) { res.statusCode = 301; res.setHeader('Location', `${path}/${q}`); res.end(); return; }
        // `/login/` for login.html: to `/login`, as hosts do
        if (path.length > 1 && path.endsWith('/') && !existsSync(join(out, path, 'index.html')) && existsSync(join(out, `${path.slice(0, -1)}.html`))) { res.statusCode = 301; res.setHeader('Location', `${path.slice(0, -1)}${q}`); res.end(); return; }
        next();
      });
    },
    // dev: the page as served at its URL (the build does this in generateBundle, once Vite has written every URL)
    transformIndexHtml: {
      order: 'post',
      handler(html, ctx) {
        if (!dev) return html;
        const rel = relOf(ctx.filename), all = pageEntries();
        const page = all.find((x) => x.rel === rel) ?? { rel, patterns: describe(ctx.filename).path };
        return relocateHtml(html, page, all.some((x) => x.rel === rel) ? all : [...all, page], base(), locales?.list);
      },
    },
    /**
     * builds: each page's finished HTML gets its links and, for a page with a fixed path, its relative URLs
     * for its new place; it moves into its directory, and a redirect file takes its old place
     */
    async generateBundle(_, bundle) {
      if (dev) return;
      const all = pageEntries(), by = new Map<string, string>(), built = new Map<string, string>();
      for (const page of all) {
        const to = pageFile(page.rel, base(), page.patterns), a = bundle[page.rel];
        if (a?.type !== 'asset') continue;
        let html = typeof a.source === 'string' ? a.source : Buffer.from(a.source).toString('utf8');
        // a page in a language with a URL: its other languages' URLs, and its chooser's, for search engines
        const v = virtual.get(resolve(root, page.rel)), urls = v?.locale && siteOrigin ? (v.page ? entryUrls(v) : localeUrls(v.source)) : null;
        if (v && urls) html = html.replace('</head>', `  ${hreflangTags(siteOrigin!, urls, v.page ? entryChooser(v.source, v.page.key)! : chooserUrl(v.source))}\n</head>`);
        const source = relocateHtml(html, page, all, base(), locales?.list);
        built.set(page.rel, source);
        if (to === page.rel) { a.source = source; continue; }
        if (bundle[to]) this.error(`sinter: ${page.rel} is written as ${to}, its URL ${pageUrl(page.rel, base(), page.patterns)}, and ${by.get(to) ?? to} is there too: rename one of them`);
        by.set(to, page.rel);
        delete bundle[page.rel];
        this.emitFile({ type: 'asset', fileName: to, source });
        // a link the page module builds at run time still names the old file: it arrives through the redirect
        for (const other of all) {
          const code = modules.get(`${PREFIX}${other.rel}.js`) ?? '';
          const old = `/${page.rel}`.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          if (new RegExp(`['"\`]${(base().startsWith('/') ? base().replace(/\/$/, '') : '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}${old}(?![\\w/-])`).test(code)) {
            resolved?.logger.warn(coded('SN521', `${other.rel} builds a link to ${page.rel} at run time, which is served at ${pageUrl(page.rel, base(), page.patterns)} now: it arrives through a redirect. Write the URL in the expression (\`'${pageUrl(page.rel, base(), page.patterns)}?…'\`)`));
          }
        }
        // the old URL still arrives: a redirect to the page's URL (relative under a relative base)
        const url = relativeBase(base()) ? `./${posix.basename(to, '/index.html')}/` : pageUrl(page.rel, base(), page.patterns)!;
        this.emitFile({ type: 'asset', fileName: page.rel, source: redirectHtml(url) });
      }
      // languages: at each source page's unprefixed URL, a chooser (404.html and 200.html: the base language's page,
      // which hosts look for there); at a moved source page's old file URL, the chooser too (one hop to a language)
      if (locales) {
        const script = [...runtimeOf.values()].some((r) => r.length);
        // a page per entry: a chooser at each entry's unprefixed path, to the visitor's language's translation (else the base's)
        const templates = new Set<string>(), done = new Set<string>();
        for (const v of virtual.values()) {
          if (!v.page) continue;
          templates.add(v.source);
          const k = `${v.source}\0${v.page.key}`;
          if (done.has(k)) continue;
          done.add(k);
          const urls = entryUrls(v)!, at = entryChooser(v.source, v.page.key)!, b = base().startsWith('/') ? base().replace(/\/?$/, '/') : '/';
          const fallback = urls[locales.base] ?? Object.values(urls)[0]!;
          const full = Object.fromEntries(locales.list.map((l) => [l, urls[l] ?? fallback]));
          const fileName = decodeURIComponent(at.startsWith(b) ? at.slice(b.length) : at.replace(/^\//, '')) + '.html';
          if (!bundle[fileName]) this.emitFile({ type: 'asset', fileName, source: chooserHtml({ base: b, locales, urls: full, script, fallback, hreflang: siteOrigin ? hreflangTags(siteOrigin, urls, at) : '' }) });
        }
        for (const src of sourceEntries()) {
          if (templates.has(src)) continue;
          const rel = relOf(src), file = chooserFile(rel);
          if (/(^|\/)(404|200)\.html?$/.test(rel)) {
            const a = bundle[`${locales.base}/${rel}`];
            if (a?.type === 'asset') this.emitFile({ type: 'asset', fileName: rel, source: rebaseHtml(String(a.source), '/' + posix.dirname(`${locales.base}/${rel}`), '/' + posix.dirname(rel).replace(/^\.$/, '')) });
            continue;
          }
          this.emitFile({ type: 'asset', fileName: file, source: chooserFor(src, script) });
          if (file !== rel) this.emitFile({ type: 'asset', fileName: rel, source: chooserFor(src, script) });
        }
      }
      brokenEntryLinks((m) => this.error(m), built);
      for (const f of await sitemap((m) => this.error(m), all, built)) this.emitFile({ type: 'asset', ...f });
      // _redirects: the same rules for hosts that read them (Netlify, Cloudflare Pages), after the app's own
      if (options.redirects === false) return;
      if (relativeBase(base())) { resolved?.logger.info('sinter: no _redirects with a relative base: the build does not know the paths the site is served at'); return; }
      const routes = siteRoutes();
      if (!routes.length) return;
      const pub = resolved?.publicDir ? resolve(resolved.publicDir, '_redirects') : null;
      let own: string | null = null;
      try { own = pub ? readFileSync(pub, 'utf8') : null; } catch { /* the app has none */ }
      const fixed = routes.filter((r) => !/[:*]/.test(r.from)).length, patterns = routes.length - fixed;
      if (fixed > 2000 || patterns > 100) resolved?.logger.warn(coded('SN524', `_redirects has ${fixed} fixed rules and ${patterns} with patterns; Cloudflare Pages reads at most 2,000 and 100 (Netlify has no such limit). Move the rest to the host's bulk redirects, or turn the file off with sinter({ redirects: false })`));
      this.emitFile({ type: 'asset', fileName: '_redirects', source: redirectsFile(routes, own) });
    },
  };
  return [main, post, cssImages, fonts, fontCheck, pages];
}

/**
 * The page's head templates (`<template id="sn-t-<id>">`, docs/spec.md HTML rewrite) moved to the end of the
 * `<head>`, in their order: after the stylesheets, preloads, scripts and data slots Vite and the plugin wrote.
 */
export function headTemplatesLast(html: string): string {
  const end = html.search(/<\/head\s*>/i);
  if (end < 0) return html;
  const moved: string[] = [];
  let head = html.slice(0, end);
  for (let at = head.search(/<template id="sn-t-\d+"/); at >= 0; at = head.search(/<template id="sn-t-\d+"/)) {
    // to its own `</template>`: a template its content holds counts
    const re = /<template\b|<\/template\s*>/gi;
    re.lastIndex = at + 1;
    let depth = 1, stop = -1;
    for (let m = re.exec(head); m; m = re.exec(head)) {
      depth += m[0][1] === '/' ? -1 : 1;
      if (!depth) { stop = m.index + m[0].length; break; }
    }
    if (stop < 0) return html;
    moved.push(head.slice(at, stop));
    head = head.slice(0, at) + head.slice(stop);
  }
  return moved.length ? `${head}${moved.join('')}${html.slice(end)}` : html;
}
