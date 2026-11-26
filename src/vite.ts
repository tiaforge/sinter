// Vite adapter: a thin wrapper around compile(). Every HTML entry is compiled
// in transformIndexHtml; its page module is served as a virtual module. With
// first paint on, each page also gets an early script: classic scripts first in the
// head (one shared by every page, one of the page's own) that render what needs no
// data as the parser inserts it, before the first paint, with nothing render-blocking.
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, posix, relative, resolve, sep } from 'node:path';
import { gzipSync } from 'node:zlib';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { flagsModule } from './core-parts.js';
import { loadEnv, type InlineConfig, type Plugin, type ResolvedConfig, type ViteDevServer } from 'vite';
import { collectionsIn, loadContent, writeNamespaceTypes, writeSnapshot, type LoadedContent } from './content-node.js';
import { applyStrict, CODES, compile, describedPrefetch, moduleWith, pageHead, CONTENT_NS, formatDiagnostic, formatWarning, strictPromotes, suggest, type Code, type CheckUnit, type Diagnostic, type CompileResult, type SourceMap } from './compiler/index.js';
import { sinterFile } from './own-files.js';
import { buildInput, checkOptionsOf, compileOptionsOf, htmlInputs, lazyOf, lazyReachOf, project, retiredExport, retiredOptions, staticPages, strictOf, type PluginApi, type ProjectOptions } from './project.js';
import { CHUNK_MARK, chainText, componentOfHtml, isComponentScript, LAZY, lazyPackage, type LazyScan, lineCol, loaderModule, mentions, parseLazyId, reachLazy, rewriteLazy, scanLazy, stubModule } from './lazy-build.js';
import { moduleKeys } from './i18n-build.js';
import { HOLD_SCRIPT } from './paint-build.js';
import { shareOpaque, shapesOn } from './early-opaque.js';
import { earlyImports, OWN, registration, SHARED_MARKS, sharedKey, sharedMark, stubModule as sharedStub, topLevelAwait } from './shared-build.js';
import { loadImages, MIME, type Images } from './images.js';
import { pageStyles } from './styles.js';
import { detectEngines, type StyleEngine } from './engines.js';
import { IMAGE_CHECK } from './image-check.js';
import type { RuntimeWarning } from './dev.js';
import { rewriteCssImages, type CssImageHost } from './css-images.js';
import { resolveRemote, type RemoteImages } from './remote.js';
import { devRemote, remoteMiddleware } from './remote-dev.js';
import type { EmbedSlot, ImageHost, ImageVariant, PrefetchParts, RuntimeReason, StyleSheet } from './compiler/index.js';
import { moduleEffect } from './prerender-build.js';
import { hasCspMeta, movesToDirectory, pageFile, pagePaths, pageUrl, prefetchModule, speculationRules, withRulesHash } from './prefetch-build.js';
import { type SwapPage, swapModule } from './swap-build.js';
import { filesNamed, pageRoutes, rebaseHtml, redirectHtml, redirectsFile, relocateHtml, type OtherPoint, type PageEntry, type Route } from './page-urls.js';
import { chain, chooserHtml, hreflangTags, manifestLocales, prefixPaths, segmentOf, type Locales } from './locales.js';
import { entryChooserPath, listPoints, pointFolder, pointOrigin, pointPrefix, translationKey, type AxisValue, type LanguageUrls, type Point, type Points, type Variant } from './points.js';
import { canonicalOf, fillPattern, noindex, sitemapFiles, sitemapOf, type SitemapOptions, type SitemapUrl } from './sitemap-build.js';
import { familyLineHeights, familyZeroWidths, fitMetrics, isTextFont } from './font-metrics.js';
import { faceName, faceOf, fontDownloader, fontFileDownloader, bundleFonts, deferredFaces, fallbackFaces, textFamilies, withFallbackFamilies, preloadFonts, preloadLocalFonts, rebaseFace, usesFamily, type FontFaceRef, type FontPreload } from './fonts-build.js';
import { componentBase } from './components-build.js';
import { inlineScriptSource } from './component-files.js';
import { inlineScriptHtml } from './compiler/components.js';
import { COMPONENT_NAME, LIBRARY_LAYER } from './compiler/components.js';
import { librariesOf, libraryOf, ownLibrary } from './libraries.js';
import { LAYERS_SHEET, type FoldArg } from './compiler/compile.js';
import { didYouMean, docsUrl } from './compiler/diagnostics.js';
import { crossCheck, crossMessage, hashOf, type FoldCall } from './fold-cross.js';
import { crossWorker, type CrossWorker } from './fold-late.js';
import { STEP_STAND_IN, viteStepNeeded } from './html-step.js';
import type { CrossAnswer } from './fold-worker.js';
import { apiOrigins } from './compiler/apis.js';
import { importModule, loadHelpers, loadingHelpers, unloadedMessage, type NodeHelpers } from './helpers-node.js';
import { FoldCache, setAppAliases } from './fold-check.js';

export interface SinterOptions extends ProjectOptions {
  /** run `sinter check` at the end of `vite build` and fail it on type errors: on when the project has TypeScript; `false` turns it off */
  typecheck?: boolean;
  /**
   * V8's explicit compile hints (default false): each page module starts with `//# allFunctionsCalledOnLoad`, so
   * Chromium compiles all of it as the page loads instead of each function on its first call. Worth it where a
   * page runs much of its code at once on its first render (a large parse in the browser: sinter-mail's mail.parse);
   * a large page module compiles longer up front. Browsers that do not know the comment ignore it.
   */
  compileHints?: boolean;
  /**
   * first paint (default true): each page gets an early script (the app's `src/sinter.early.ts`, then
   * the bindings that need no data): classic scripts first in the head, which render each element as
   * the parser inserts it (`observe` in early.ts), and paginated lists hold their rows' space. `false`:
   * those wait for the page module. Build-time constants (and the base language's messages) are written
   * into the HTML either way, and a page with nothing to run ships no JavaScript either way.
   */
  firstPaint?: boolean | { budget?: number };
  /**
   * builds: minify each page's HTML (default true; never in dev): the author's comments out, and the
   * white space the page's stylesheets show to render nothing (docs/minify.md). Before the page is compiled, so
   * sinter's own comments and node paths are counted on the minified markup.
   */
  minifyHtml?: boolean;
  /**
   * static images (default on, needs sharp): every `<img src>` of a local JPEG, PNG, WebP or AVIF
   * becomes a `<picture>` with AVIF or lossless WebP, widths for each screen, dimensions and lazy
   * loading (docs/images.md). `false`: images stay as written; `widths`: the widths of fluid images, the
   * largest also the widest file of any fluid image or sized CSS background (default: up to the source's width)
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
   * Getting the next page ready (default on), as `<html data-sn-prefetch="off">` turns off for one page:
   * - `data` (default true): when a link to another page of the app is about to be followed, that page's data is
   *   requested, and the page shows it at once (then revalidates).
   * - `html`: Speculation Rules for links to the app's pages (Chromium): `true` (default) fetches the next
   *   page's HTML while the pointer rests on a link; `{ prerender: true }` loads and runs the whole page (data included,
   *   streams connect once it is shown); `false`: none. The rules are an inline script in every page, so they need
   *   no server setup; a CSP the page declares in a `<meta>` gets their hash from the build, a CSP sent as a
   *   response header needs `'inline-speculation-rules'` in `script-src` (dev builds warn when it blocks them).
   *   `{ prerender: 'auto' }`: the build decides per page, prerendering those it can show do nothing on load but read
   *   (only GET resources, no `then`, `call` or POST loads, no component scripts, custom elements, lazy packages, scripts,
   *   handlers of events no visitor caused, and app modules without load-time effects) and prefetching the rest.
   *   `{ delivery: 'header' }` (with `prerender: true` to prerender) writes `speculation-rules.json` at the site root for a `Speculation-Rules`
   *   response header instead, which no CSP blocks: the server sends the header with every page and the file as
   *   `application/speculationrules+json` (`vite dev` and `vite preview` do both). See docs/navigation.md.
   * `false`: neither.
   */
  prefetch?: boolean | { data?: boolean; html?: boolean | { prerender?: boolean | 'auto'; delivery?: 'inline' | 'header' } };
  /**
   * Builds served by a server that writes each page's data into it (sinter-axum): every resource whose
   * request only the page's URL decides gets a placeholder in the head, and the browser neither preloads
   * nor requests it early, since the data comes with the page. Not `call`, `each`, `early="off"`, or an
   * operation of an API with a `token` (the server has no visitor's token). `sinter-embed.json` lists them.
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
   * Google Fonts (default on, builds only): `bundle` (default true): a page's `<link rel="stylesheet"
   * href="https://fonts.googleapis.com/…">` is downloaded at build time and bundled as one of the app's
   * own CSS assets (a file, not an inline style: no CSP change), and the page preconnects to the
   * origin of its font files. The fonts, their `font-display` and the look stay as they are: one
   * render-blocking request to another origin less, and the font files' connection is open when they
   * are requested (as the Angular CLI does). Downloads are cached in `node_modules/.cache/sinter/fonts`;
   * a build that cannot download one keeps the link and warns. `{ bundle: false }` keeps the links.
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
   *
   * `false`: neither.
   *
   * Whatever this option says, a build loads these faces of a page's bundled CSS (Google Fonts', self-hosted, the
   * app's own), other than the preloaded ones, after the window's `load` on a page with an early script: the
   * `font-display: swap` faces, and the faces of text fonts without a `font-display` (told from icon fonts by their
   * files), which become `swap`. They move to a stylesheet in `<noscript data-sn-fonts>` that the early file links
   * then, and the text painted before them is in a fitted fallback family (`deferFonts`;
   * docs/first-paint.md#fonts-after-the-load).
   */
  fonts?: false | { bundle?: boolean; preload?: FontPreload[] };
}

/**
 * The main plugin's `api`, read by `sinter check`, the editor and `sinter render` (`viteProject`): the options, a page's
 * source, and with `pageOptions` the options the build compiles a source page with (once the config is resolved).
 */
type SinterApi = { options: SinterOptions; source(file: string): string; pageOptions?: PluginApi['pageOptions'] };
/** the plugins' names (an HTML hook of any other plugin keeps every page in Vite's HTML step) */
const SINTER_PLUGINS = new Set(['sinter', 'sinter:early', 'sinter:css-images', 'sinter:fonts', 'sinter:font-check', 'sinter:pages', 'sinter:compile-hints', 'sinter:html-in', 'sinter:html-out']);
type SinterPlugins = [Plugin & { api: SinterApi }, Plugin, Plugin, Plugin, Plugin, Plugin, Plugin, Plugin, Plugin, Plugin];

/** dev: the pages under the root (not in node_modules, the output, `public/`, hidden folders, or the components' and layouts' folders) */
function htmlPages(root: string, config: ResolvedConfig | null): string[] {
  const skip = new Set(['node_modules', resolve(root, config?.build.outDir ?? 'dist'), resolve(root, 'dist'), config?.publicDir ?? resolve(root, 'public'), resolve(root, 'src/components'), resolve(root, 'src/layouts')].map((x) => resolve(root, x)));
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
/** the pages a build describes from which their descriptions link their shared definitions (`describedDefinitions`) */
const LINK_DESCRIPTIONS = 8;
/** `SN_DESCRIBE_AUDIT=1`: pages whose build compile gave their description, and those where it differed (`own`: a page of its own) */
const DESCRIBE_AUDIT = { same: { own: 0, entry: 0 }, differ: { own: 0, entry: 0 }, effect: { own: 0, entry: 0 } };
if (process.env.SN_DESCRIBE_AUDIT === '1') process.on('exit', () => console.error(`sinter describe audit: ${JSON.stringify(DESCRIBE_AUDIT)}`));
/**
 * The descriptions of this process's builds (`SN_PASS_LOG=1`, with the second passes' routes): read off a page's head
 * (`head`), or compiled and why; and the page modules written again once every page had compiled (`rewritten`)
 */
export const LATE_STATS = { head: 0, compiled: {} as Record<string, number>, late: {} as Record<string, number>, rewritten: 0, sources: 0 };
if (process.env.SN_PASS_LOG === '1') process.on('exit', () => console.error(`sinter descriptions: ${LATE_STATS.head} read off the page's head (their parts compiled after all: ${JSON.stringify(LATE_STATS.late)}); compiled: ${JSON.stringify(LATE_STATS.compiled)}; page modules written again: ${LATE_STATS.rewritten}; source pages' paths read off their heads: ${LATE_STATS.sources}`));

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
 * The early runtime (`@tiaforge-ui/sinter/runtime/early`) is in the shared head script, once for every page:
 * it puts the exports the pages call on this global, and each page's head script takes them from it
 * (this module stands for the runtime in a page's build).
 */
const RT_KEY = 'sinter.early.rt';
const RT_ID = '\0sinter:early-rt';
/** this package, as apps and libraries import it */
const SELF = '@tiaforge-ui/sinter';
const EARLY_PKG = '@tiaforge-ui/sinter/runtime/early';
/** the runtime's exports a page's early module imports (the compiler names each it calls) */
const runtimeNames = (code: string) => /import \{([^}]*)\} from '@tiaforge-ui\/sinter\/runtime\/early'/.exec(code)?.[1]!.split(',').map((x) => x.trim()).filter(Boolean) ?? [];
/**
 * The runtime's exports that keep no state of the early runtime's own and share little code with the rest (the first-page
 * parameters and page, the array parameters, the token's and the guard's storage reads, a query with whole values, a
 * URL template of another shape, a component's early renderer): when not every page imports one, it is
 * bundled into the early files of the pages that do, and the shared head script, which every page loads, holds none of it.
 */
const PAGE_OWN = new Set(['$so', 'away', 'awayVia', 'lists', 'withParams', 'toPage', '$hq', '$href', 'cr', 'fonts']);
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
/** `prefetch: { html: { delivery: 'header' } }`: the rules file, at the site root */
/** the `prefetch.html` value an old one (`speculation`, `'prefetch'`, `'prerender'`, `{ mode, delivery }`) is now, as written in the config */
function htmlOf(v: unknown): string {
  if (v === 'prefetch') return 'true';
  if (v === 'prerender') return '{ prerender: true }';
  if (v === false) return 'false';
  if (typeof v === 'object' && v !== null) {
    const o = v as { mode?: unknown; delivery?: unknown };
    const parts = [...(o.mode === 'prerender' ? ['prerender: true'] : []), ...(o.delivery !== undefined ? [`delivery: '${String(o.delivery)}'`] : [])];
    return parts.length ? `{ ${parts.join(', ')} }` : 'true';
  }
  return JSON.stringify(v);
}
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
  if (loadingHelpers()) return [{ name: 'sinter', api: { options, source: (f: string) => f } }, { name: 'sinter:post' }, { name: 'sinter:css-images' }, { name: 'sinter:fonts' }, { name: 'sinter:font-check' }, { name: 'sinter:pages' }, { name: 'sinter:compile-hints' }, { name: 'sinter' }, { name: 'sinter:html-in' }, { name: 'sinter:html-out' }];
  // options renamed (docs/proposals/vocabulary.md): what to write instead
  const was = options as { speculation?: unknown; earlyBudget?: unknown; fonts?: { inline?: unknown; preload?: unknown } };
  if (was.speculation !== undefined) throw new Error(`sinter({ speculation }) is renamed to \`prefetch: { html: ${htmlOf(was.speculation)} }\`, beside the next page's data (\`prefetch: { data }\`)`);
  if (was.earlyBudget !== undefined) throw new Error(`sinter({ earlyBudget }) is renamed to \`firstPaint: { budget: ${JSON.stringify(was.earlyBudget)} }\``);
  // `fonts: { inline }` bundled a file, it inlined nothing; and it was the one off-switch not written `false`
  if (typeof was.fonts === 'object' && was.fonts !== null && 'inline' in was.fonts) {
    const off = was.fonts.inline === false, preload = was.fonts.preload !== undefined;
    throw new Error(`sinter({ fonts: { inline } }) is renamed to \`${off ? (preload ? 'fonts: { bundle: false, preload }' : 'fonts: false') : 'fonts: { bundle }'}\`: the build bundles Google Fonts' stylesheets as CSS files, it inlines nothing${off || preload ? '' : ' (`bundle: true` is the default: leave it out)'}`);
  }
  // nested options take known keys only, as markup does: a typo fails the build instead of doing nothing
  const keysOf = (name: string, v: unknown, keys: string[]) => {
    if (typeof v !== 'object' || v === null) return;
    const extra = Object.keys(v).filter((k) => !keys.includes(k));
    if (extra.length) throw new Error(`sinter({ ${name} }): no option \`${extra[0]}\`; it takes ${keys.map((k) => `\`${k}\``).join(' and ')}`);
  };
  // the options themselves, as nested ones: a typo (`typechek`) fails instead of doing nothing
  retiredOptions(options);
  const OPTIONS = ['typecheck', 'compileHints', 'firstPaint', 'minifyHtml', 'images', 'redirects', 'site', 'sitemap', 'localePrefix', 'prefetch', 'embed', 'origins', 'fonts',
    'content', 'messages', 'openapi', 'apis', 'complexity', 'expansionLimit', 'static', 'swap', 'lazy', 'libraries', 'strict'];
  const unknown = Object.keys(options).find((k) => !OPTIONS.includes(k));
  if (unknown) throw new Error(`sinter({ ${unknown} }) is not an option.${didYouMean(unknown, OPTIONS)}`);
  if (options.fonts !== undefined && options.fonts !== false && (typeof options.fonts !== 'object' || options.fonts === null)) {
    throw new Error(`sinter({ fonts }): takes \`false\` or \`{ bundle, preload }\`, not ${JSON.stringify(options.fonts)}`);
  }
  keysOf('fonts', options.fonts, ['bundle', 'preload']);
  /** Google Fonts' stylesheets bundled as the app's CSS (builds) */
  const fontsBundled = options.fonts !== false && options.fonts?.bundle !== false;
  keysOf('images', options.images, ['widths', 'remote']);
  keysOf('prefetch', options.prefetch, ['data', 'html']);
  keysOf('firstPaint', options.firstPaint, ['budget']);
  // `prefetch.html` was `'prefetch'` or `{ mode, delivery }`, a value that repeated the option's name, and `'prerender'`,
  // a second spelling of `{ prerender: true }`
  const html0 = typeof options.prefetch === 'object' ? (options.prefetch.html as unknown) : undefined;
  if (html0 === 'prefetch' || html0 === 'prerender' || (typeof html0 === 'object' && html0 !== null && 'mode' in html0)) {
    throw new Error(`sinter({ prefetch: { html: ${JSON.stringify(html0).replace(/"(\w+)":/g, '$1: ').replace(/"/g, "'")} } }) is renamed to \`html: ${htmlOf(html0)}\``);
  }
  if (html0 !== undefined && typeof html0 !== 'boolean' && (typeof html0 !== 'object' || html0 === null)) {
    throw new Error(`sinter({ prefetch: { html } }): takes \`true\`, \`false\` or \`{ prerender, delivery }\`, not ${JSON.stringify(html0)}`);
  }
  keysOf('prefetch: { html }', html0, ['prerender', 'delivery']);
  const pr0 = typeof html0 === 'object' && html0 !== null ? (html0 as { prerender?: unknown }).prerender : undefined;
  if (pr0 !== undefined && typeof pr0 !== 'boolean' && pr0 !== 'auto') throw new Error(`sinter({ prefetch: { html: { prerender } } }): takes \`true\`, \`false\` or \`'auto'\` (the build decides per page), not ${JSON.stringify(pr0)}`);
  const prefetchData = options.prefetch !== false && (typeof options.prefetch !== 'object' || options.prefetch.data !== false);
  const speculation = options.prefetch === false ? false : typeof options.prefetch === 'object' && options.prefetch.html !== undefined ? options.prefetch.html : true;
  let root = process.cwd();
  /** type-check the build: on when the project has TypeScript installed, unless `typecheck: false` */
  let tsFound: boolean | null = null;
  const typecheckOn = () => options.typecheck ?? (tsFound ??= (() => {
    // the project's own install: a node_modules from the root up (not a global folder on NODE_PATH)
    for (let d = resolve(root); ; d = dirname(d)) {
      if (existsSync(join(d, 'node_modules/typescript/package.json'))) return true;
      if (dirname(d) === d) return false;
    }
  })());
  /**
   * The project (its helpers, components, libraries, specs) as a build sees it: read once per build, from its start, where
   * every page asked again (`project()` scans the components and libraries and reads the helpers' manifest). A build's
   * config phase (`configResolved`: the content module, the template probe) reads it once too, and its start afresh
   * (`vite build --watch`); in dev, afresh as files change.
   */
  let buildProject: ReturnType<typeof project> | null = null;
  /** dev: the project as last read, until the watcher reports a file changed, added or removed (configureServer) */
  let devProject: ReturnType<typeof project> | null = null;
  /** a build's `configResolved` until its `buildStart`: the project read there is kept for that phase */
  let configPhase = false;
  const proj = () => buildProject ?? (server ? (devProject ??= project(root, options)) : configPhase ? (buildProject = project(root, options)) : project(root, options));
  let dev = false;
  let server: ViteDevServer | null = null;
  let resolved: ResolvedConfig | null = null;
  const modules = new Map<string, string>();
  /** builds: each bundle's entry chunks by facade (`entryChunk`) */
  const entryIndex = new WeakMap<object, Map<string, unknown>>();
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
  type EarlyJob = { code: string; keys: Set<string>; rt: string[] | null; runtimeId: string | null; map?: SourceMap; own: string[] };
  /** the nested build's config for an early script; its entry plugin reads what it builds from `job` (a session swaps it) */
  const earlyConfig = (job: EarlyJob, rolldown: boolean): InlineConfig => {
        /** the runtime as a page's early file sees it: the shared head script's exports from its global, `own` bundled in (PAGE_OWN) */
        const runtimeStub = (names: string[], mine: string[]) => `const R = globalThis[Symbol.for(${JSON.stringify(RT_KEY)})];\nexport const { ${names.join(', ')} } = R;\n${mine.length ? `export { ${mine.join(', ')} } from ${JSON.stringify(job.runtimeId)};\n` : ''}`;
        const r = resolved!, ENTRY = `${PREFIX}early-entry.js`, entryId = job.map ? ENTRY : '\0' + ENTRY;
        return {
          configFile: false, root, base: r.base, mode: dev ? 'development' : r.mode, logLevel: 'silent', publicDir: false, define: r.define,
          // the app's resolution: a library linked from outside the root (`file:`, `npm link`) finds the app's sinter through `dedupe`
          resolve: { alias: r.resolve.alias, conditions: r.resolve.conditions, dedupe: r.resolve.dedupe, preserveSymlinks: r.resolve.preserveSymlinks },
          plugins: [{
            name: 'sinter:early-entry', enforce: 'pre',
            async resolveId(id, importer, o) {
              if (id === ENTRY) return entryId;
              // the page's own exports, from the runtime itself (PAGE_OWN)
              if (!job.rt || id === RT_ID || importer === RT_ID) return null;
              // the runtime, however it is named (an alias may resolve the package to its source)
              if (id === EARLY_PKG) return RT_ID;
              const res = await this.resolve(id, importer, { ...o, skipSelf: true });
              return res && job.runtimeId && res.id === job.runtimeId ? RT_ID : null;
            },
            load: (id) => (id === entryId ? (job.map ? { code: job.code, map: job.map } : job.code) : id === RT_ID ? runtimeStub(job.rt!, job.own) : null),
            transform(src, id) {
              // a content namespace the early modules call through its module: its ids (`ns \0 id`), written into the page,
              // and the formatter for one that is not plain text (`withFormatter`)
              let fmt: { code: string; map: null } | undefined;
              if (content?.namespaces.size && !id.includes('/node_modules/') && !sinterFile(id) && /\.[cm]?[jt]sx?$/.test(id)) {
                const by = new Map<string, string[]>();
                for (const d of content.namespaces.values()) if (d.module) {
                  const ks = moduleKeys(src, id, d.module, d.name, true).keys;
                  for (const k of ks) job.keys.add(`${d.name}\0${k}`);
                  if (ks.length) by.set(d.name, ks);
                }
                fmt = withFormatter(src, by);
              }
              // the helpers module's re-exports of lazy packages: an early binding calls its own helpers, never
              // the barrel's copy of a namespace, which would put the package in the early file (as lazyTransform)
              if (lazyPkgs.length && sameFile(id.replace(/[?#].*$/, ''), proj().helpersFile) && mentions(src, lazyPkgs)) {
                const s = scanLazy(src, id, lazyPkgs, true);
                if (s.drop?.length) return { code: rewriteLazy(fmt?.code ?? src, { ...s, lazy: [] }), map: null };
              }
              return fmt ?? null;
            },
          }],
          build: {
            write: false, minify: dev ? false : r.build.minify, target: r.build.target, sourcemap: !!job.map, modulePreload: false, copyPublicDir: false, reportCompressedSize: false,
            // one file: dynamic imports inlined. Vite 8 bundles with Rolldown (`codeSplitting: false`; it
            // deprecates `inlineDynamicImports`), Vite 6 and 7 with Rollup, which knows only the latter.
            [rolldown ? 'rolldownOptions' : 'rollupOptions']: {
              input: ENTRY,
              output: { format: 'iife', ...(rolldown ? { codeSplitting: false } : { inlineDynamicImports: true }) },
            },
          },
        };
  };
  /**
   * A build's early scripts through one Vite builder: the config resolved and the environment set up once, then one
   * bundle per script, one after another, the entry plugin reading each one's job. That is what `vite build` does for
   * one (`createBuilder(config, true)`, then `build(environment)`), so the plugins and the bytes are the same; a
   * `vite build` per script resolved the config again each time. Null where this Vite has no `createBuilder`.
   */
  const earlySession = async (runtimeId: string | null): Promise<((j: EarlyJob) => Promise<unknown>) | null> => {
    const vite = await appVite();
    if (typeof vite.createBuilder !== 'function') return null;
    const job: EarlyJob = { code: '', keys: new Set(), rt: null, runtimeId, own: [] };
    const builder = await vite.createBuilder(earlyConfig(job, 'rolldownVersion' in vite), true);
    const env = Object.values(builder.environments)[0]!;
    let last: Promise<unknown> = Promise.resolve();
    return (j) => {
      const run = last.then(() => { Object.assign(job, j); return builder.build(env); });
      last = run.catch(() => {});
      return run;
    };
  };
  /**
   * One classic script (IIFE) from an early module's `code`, with nothing imported: builds (the shared head script
   * and each page's) and the dev server (a page's whole early script). `rt`: the runtime's exports it takes from the
   * shared head script's global (`runtimeId`: the runtime's resolved id); null: the runtime is bundled in. `map`: the
   * module's own (dev), carried into the script's (the entry then has a plain id: Rolldown drops a `\0` module's map).
   * `session`: a build's builder (`earlySession`), else a `vite build` of its own.
   */
  const earlyScript = async (code: string, keys: Set<string>, rt: string[] | null, what: string, runtimeId: string | null = null, map?: SourceMap, own: string[] = [], session?: ((j: EarlyJob) => Promise<unknown>) | null) => {
        const r = resolved!, job: EarlyJob = { code, keys, rt, runtimeId, ...(map ? { map } : {}), own };
        const vite = await appVite();
        const out = session ? await session(job) : await vite.build(earlyConfig(job, 'rolldownVersion' in vite));
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
  const earlyBudget = typeof options.firstPaint === 'object' ? options.firstPaint.budget ?? 10_000 : 10_000;
  /** `lazy`: the packages loaded on first call (checked before Vite starts), and each one's resolved id (its chunk's facade) */
  const lazyPkgs = lazyOf(options.lazy);
  const lazyIds = new Map<string, string>();
  /** each page's `data-sn-preload` packages, and its component scripts that load with lazy packages, by its path relative to the root */
  const preloadOf = new Map<string, string[]>();
  const lazyScriptsOf = new Map<string, Array<{ module: string; lazy: string[] }>>();
  /** builds: the component scripts that load with lazy packages, logged once each with the chain that made them lazy */
  const loggedScripts = new Set<string>();
  /** the lazy packages a component script reaches (`/src/components/x.ts`); a build logs why it loads with them */
  const lazyScans = new WeakMap<ReturnType<typeof project>, Map<string, LazyScan | null>>();
  const lazyScript = (module: string): string[] => {
    const file = resolve(root, '.' + module);
    // (the modules' scans kept with the project: a build reads each once for all its component scripts, dev again after a change)
    const p = proj();
    let scans = lazyScans.get(p);
    if (!scans) lazyScans.set(p, (scans = new Map()));
    // a script of a component library in `lazy` is that package: it loads with it, whatever it imports
    const lib = libraryOf(p.libraries, file);
    const own = lib && lazyPackage(lib.name, lazyPkgs) ? [{ spec: lib.name, chain: [file] }] : [];
    const r = own.length ? own : reachLazy(file, lazyPkgs, root, scans, undefined, false, p.libraries);
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
  const siteOriginOf = () => siteOrigin;
  /** `sitemap`, checked */
  const sitemapOptions = sitemapOf(options.sitemap, siteOrigin);
  /** the page's `$site`, `$canonical` (null for a page whose paths all have parameters) and origin */
  const urlsOf = (rel: string, patterns: string[]) => {
    const b = resolved?.base?.startsWith('/') ? resolved.base : '/';
    // a page on its own domain: that origin's URLs, without its folder
    const g = groupOf(rel), site = g?.origin ?? siteOrigin!;
    const url = pageUrl(g ? urlRel(rel) : rel, b, patterns);
    return { site: site + b.replace(/\/$/, ''), canonical: url === null ? null : site + url, origin: site };
  };
  /** a page's `data-sn-path` patterns, from its description */
  const out0Path = (file: string) => describe(file).path;
  /** the same of a file that is no page of the build (one the editor has open): none when it does not compile */
  const describedPaths = (file: string) => { try { return describe(file).path; } catch { return []; } };
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
  /**
   * build: the pages with an early file whose bundled stylesheets have faces to load after `load` (`deferredFaces`):
   * their early files call the runtime's `fonts`, and only their stylesheets lose the faces (`deferFonts`)
   */
  const fontPages = new Set<string>();
  /** build: the text families of each bundled stylesheet's faces without `font-display` (`textFamilies`), by its file */
  const textOf = new Map<string, Promise<Set<string>>>();
  /** build: each page's embedded-data placeholders and the paths it answers at, by file */
  const embedPages = new Map<string, { file: string; paths: string[]; arrays?: string[]; data: EmbedSlot[] }>();
  /** origins of resources that could have been requested early, not listed in `origins` (reported once per build) */
  const unlisted = new Set<string>();
  const earlyFiles = new Map<string, { code: string; modules: Record<string, { renderedLength: number }> }>();
  /**
   * build: shared helper modules (shared-build.ts). `helperFiles`: the modules that declare helpers (real paths), the
   * only ones a load waits for; `compiled`: the pages compiled so far, and `pagesDone` once all are (the early modules
   * are then known); `shared`: each module the page bundle takes from the early files, with its exports; `unshared`:
   * why a module an early file imports stays a copy of its own; `registered`: by page, the modules its early file shares
   */
  let helperFiles = new Set<string>();
  const compiled = new Set<string>();
  let pagesDone: Promise<void> = Promise.resolve();
  let pagesReady: () => void = () => {};
  const decisions = new Map<string, Promise<boolean>>();
  const shared = new Map<string, string[]>();
  const unshared = new Map<string, string>();
  const registered = new Map<string, Set<string>>();
  /** a file's real path (a library linked into node_modules is its target), or the path as given */
  const realOf = (f: string) => { try { return realpathSync(f); } catch { return f; } };
  /** the helper modules' import specifiers (as the compiler writes them in early modules) and the files they resolve to */
  const specFiles = new Map<string, string>();
  /** an early module's import specifier as a file, when it names a helper module */
  const specFile = (spec: string) => specFiles.get(spec) ?? null;
  /**
   * Whether the page bundle takes helper module `f` from the early files: once every page is compiled, when an early
   * file imports it, every early file that does imports all of its exports (so its namespace adds nothing to the early
   * file), and the build target has top-level `await` (the stub waits for its own copy). Else why not, in `unshared`.
   */
  const decideShared = (ctx: { load(o: { id: string }): Promise<{ exports?: string[] | null }> }, f: string) => {
    let d = decisions.get(f);
    if (!d) decisions.set(f, (d = (async () => {
      await everyPage(pagesDone, compiled, 'sharing helper modules with the early files');
      const pages = [...earlyPages].map(([rel, code]) => ({ rel, names: [...earlyImports(code)].filter(([spec]) => specFile(spec) === f).flatMap(([, n]) => n) })).filter((x) => x.names.length);
      if (!pages.length) return false;
      if (!topLevelAwait(resolved?.build.target)) { unshared.set(f, `the build target (${[resolved?.build.target].flat().join(', ')}) has no top-level await`); return false; }
      const exports = (await ctx.load({ id: f + OWN })).exports ?? [];
      for (const p of pages) {
        const left = exports.filter((e) => !p.names.includes(e));
        if (left.length) { unshared.set(f, `the early file of ${p.rel} uses ${p.names.length} of its ${exports.length} exports`); return false; }
      }
      shared.set(f, exports);
      return true;
    })()));
    return d;
  };
  /** a page compiled (or failed): once every entry is, the shared modules can be decided */
  const pageDone = (file: string) => {
    compiled.add(file);
    if (entries().every((e) => compiled.has(e))) pagesReady();
  };
  /** the app's early module (`src/sinter.early.ts`), which the shared head script runs */
  let appEarly: string | null = null;
  const budget = earlyBudget;
  /**
   * build: each script's gzip size, by its text, for the per-page log lines: the chunks pages share (and on a blog every
   * post's early file) are gzipped once, not once per page
   */
  const gzipped = new Map<string, number>();
  const gzipSize = (code: string) => { let n = gzipped.get(code); if (n === undefined) gzipped.set(code, (n = gzipSync(code).length)); return n; };
  /** whether the build's info lines are printed: its own logger below `info` (`logLevel: 'warn'`) prints none; a custom one gets them all */
  const infoShown = () => !!resolved && (!!resolved.customLogger || (resolved.logLevel ?? 'info') === 'info');
  /** the entries of the content namespaces a page's app modules call (its own are compiled in), written into its head */
  const pageMessages = new Map<string, string>();
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
      // an `@import` Vite's pipeline cannot open as a file (ENOENT): named, as the cause to look for
      const msg = (e as Error).message.split('\n')[0]!, missing = /ENOENT\b.*?'([^']+)'/.exec(msg)?.[1];
      const why = missing ? `\`@import '${missing}'\` cannot be read as a file (${msg})` : msg;
      if (!failedCss.has(file)) { failedCss.add(file); resolved!.logger.warn(coded('SN527', `image sizes from ${relOf(file)} are not read: ${why}`)); }
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
    const remote = !fontsBundled || dev ? undefined : (url: string) => (fontCss ??= fontDownloader(resolve(root, 'node_modules/.cache/sinter/fonts')))(url);
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
  /** `effect`: what the page does as it loads besides reading (`CompileResult.loadEffect`), null for nothing */
  type Described = { parts: PrefetchParts | null; path: string[]; off: boolean; keep: string[]; swapOff: boolean; keptSource: Record<string, string>; keptBound: string[]; effect: string | null; late?: true };
  const described = new Map<string, Described>();
  /**
   * builds of many pages: the shared definitions of their descriptions, linked from one page's description into the next
   * (as `definitions` links their compiles; a description's options are not a compile's, so each has its own). Recording
   * one costs about two compiles of it in place and each page after saves most of one, so it is worth it from a few pages
   * on: below `LINK_DESCRIPTIONS`, every description compiles its definitions in place
   */
  const describedDefinitions = new Map<string, unknown>();
  /**
   * `<html data-sn-for>`: each template's description (by source and language), from the first of its entries described.
   * Another entry's is that one at its own path: what an entry can request ahead reads only the URL (`$url`), never
   * the entry, so it is the same for every entry, as what a swap keeps is. Cleared with `described`.
   */
  const entriesDescribed = new Map<string, { page: string; d: Described }>();
  /** an entry's description from its template's, or null to compile it */
  const entryDescription = (v: { source: string; locale?: string; page?: { path: string } } | undefined): Described | null => {
    if (!v?.page) return null;
    const k = entriesDescribed.get(`${v.source}\0${v.locale ?? ''}`);
    // (the one path a `<html data-sn-for>` page has: the entry's, under its language's prefix)
    if (!k || k.d.path.length !== 1 || !k.d.path[0]!.endsWith(k.page)) return null;
    const own = k.d.path[0]!.slice(0, k.d.path[0]!.length - k.page.length) + v.page.path;
    const at = (ps: string[]) => ps.map((x) => (x === k.d.path[0] ? own : x));
    return { ...k.d, parts: k.d.parts && { ...k.d.parts, path: at(k.d.parts.path) }, path: at(k.d.path) };
  };
  let speculationHash: string | null = null, rulesWritten = false;
  /** every inline rule set's hash (pages with same-page links have their own) */
  const speculationHashes = new Set<string>();
  let hashedRules: { json: string; hash: string } | null = null;
  /** build: the pages with inline rules and no CSP <meta>, whose CSP (if any) comes from a response header */
  let unhashedPages = 0;
  const seen = new Set<string>();
  /** option warnings already printed (`sinter({ openapi })` is deprecated) */
  const warnedOptions = new Set<string>();
  /** `localePrefix`: the languages, and each page in a language (`<root>/<locale>/<page>`) with its source and language */
  let locales: Locales | null = null;
  /** how the languages are in URLs (points.ts): their segments, and in a build their domains (dev serves a language on its own domain under its segment) */
  let lurls: LanguageUrls | null = null;
  /** the compiler's `locale.paths`: each language's URL segment where it is not its tag, '' for one on its own domain */
  const cpaths = () => (lurls?.paths || lurls?.domains ? { ...lurls.paths, ...Object.fromEntries(Object.keys(lurls.domains ?? {}).map((k) => [k, ''])) } : null);
  const virtual = new Map<string, { source: string; locale: string; page?: { value: unknown; path: string; key: string }; axes?: AxisValue[] }>();
  /**
   * a page's one language: its point's (`localePrefix`), else the content module's `languages()` base, the build's one
   * language (a page is in one language, chosen at build: docs/proposals/axes.md §7)
   */
  const pageLang = (file: string): string | undefined => virtual.get(file)?.locale ?? (!locales ? content?.languages?.base : undefined);
  /** `<html data-sn-for>` with languages: each template's entries by key, each language's path (an entry's translations) */
  let translations: Points['translations'] = new Map();
  /** `<html data-sn-for>`: the build's inputs, each template page replaced by a page per entry (`pageInputs()`), or null */
  let pageInputs: string[] | null = null;
  /** the build's input as the app wrote it, before `localePrefix` turns it into one input per page and language */
  let sourceInput: unknown = undefined;
  const sourceDescribed = new Map<string, string[]>();
  /** build: why each page needs the runtime, by its path relative to the root (empty: it ships none) */
  const runtimeOf = new Map<string, RuntimeReason[]>();
  let pagesCache: Array<{ paths: string[]; parts: PrefetchParts | null; swaps: boolean; file: string; effect: string | null }> | null = null;
  const attr = (v: string) => v.replace(/[&"<>]/g, (c) => `&#${c.charCodeAt(0)};`);
  /** each page's content namespaces as its compile resolved them (its point's), for the entries its modules call */
  const pageNs = new Map<string, NonNullable<Parameters<typeof compile>[1]['contentNs']>>();
  /** a content namespace's ids each app module calls through the namespace's `module` (`m.inbox.title()`), by module */
  const moduleNs = new Map<string, Map<string, string[]>>();
  const collectNs = (ctx: { error(m: string): never }, code: string, id: string) => {
    if (!content?.namespaces.size || id.includes('/node_modules/') || sinterFile(id) || !/\.[cm]?[jt]sx?(\?|$)/.test(id)) return;
    const file = id.replace(/\?.*$/, ''), by = new Map<string, string[]>();
    for (const d of content.namespaces.values()) {
      if (!d.module) continue;
      const r = moduleKeys(code, id, d.module, d.name, true);
      if (r.errors.length) ctx.error(`sinter: ${r.errors.join('\n')}`);
      const known = new Set(helpersOf(proj().helpers).namespaces[d.name]?.members ?? []);
      const unknown = r.keys.filter((k) => !known.has(k));
      if (unknown.length) ctx.error(`sinter: ${id}: no entry ${unknown.map((k) => `\`${d.name}.${k}\``).join(', ')} in the namespace \`${d.name}\``);
      if (r.keys.length) by.set(d.name, r.keys);
    }
    if (by.size) moduleNs.set(file, by); else moduleNs.delete(file);
    return withFormatter(code, by);
  };
  /**
   * An app module that calls an entry its formatter cannot inline (a plural, a formatted placeholder) in any language:
   * it registers the formatter with the namespace's module (`install(null, format, name)`), so a page whose modules call
   * only plain texts ships no formatter
   */
  const withFormatter = (code: string, by: Map<string, string[]>): { code: string; map: null } | undefined => {
    const lines: string[] = [];
    for (const [ns, keys] of by) {
      const d = [...(content?.namespaces.values() ?? [])].find((x) => x.name === ns);
      const inl = d ? inliners.get(d.format) : undefined;
      if (!d?.module) continue;
      const complex = keys.some((k) => (locales?.list ?? [undefined]).some((l) => { const e = contentNsAt(l)[ns]?.entries[k]; return e != null && (!inl || inl(e) === null); }));
      if (complex) lines.push(`import { format as $snf$${ns} } from ${JSON.stringify(formatSpec(d.format))};`, `import { install as $sni$${ns} } from ${JSON.stringify(d.module)};`, `$sni$${ns}(null, $snf$${ns}, ${JSON.stringify(ns)});`);
    }
    return lines.length ? { code: `${code}\n${lines.join('\n')}\n`, map: null } : undefined;
  };
  const collect = collectNs;

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
  /** a component's top-level `<script>` module (`/src/components/x.html.script.ts`, an absolute path, `/@fs/…`), resolved, or null */
  const inlineScriptId = (id: string, importer?: string): string | null => {
    const clean = id.replace(/[?#].*$/, '');
    if (!inlineScriptHtml(clean)) return null;
    const abs = clean.startsWith('/@fs/') ? clean.slice(4)
      : clean.startsWith('.') && importer ? resolve(dirname(importer.replace(/[?#].*$/, '')), clean)
      : isAbsolute(clean) && existsSync(inlineScriptHtml(clean)!) ? clean : resolve(root, '.' + (clean.startsWith('/') ? clean : '/' + clean));
    return inlineScriptSource(abs) ? abs : null;
  };

  /** the app's HTML entries: the build input, else `index.html`, and every page compiled so far */
  /** the app's source pages: the build input, else `index.html`, and every page compiled so far */
  /**
   * a build's, once its input is known: kept while no page is added to `seen` (every page asks for the list, often
   * several times: computed afresh it made the build's cost grow with the square of its pages). Callers only read it.
   */
  let sourceKept: { input: unknown; seen: number; files: string[]; set: Set<string>; axes?: boolean } | null = null;
  const sourceEntries = (): string[] => {
    if (!dev && sourceInput !== undefined && sourceKept?.input === sourceInput && sourceKept.seen === seen.size) return sourceKept.files;
    const files = htmlInputs(sourceInput ?? buildInput(resolved?.build)).map((f) => resolve(root, f));
    // dev without a build input: every page under the root, as the dev server serves any of them
    if (!files.length && dev) files.push(...htmlPages(root, resolved));
    if (!files.length && existsSync(resolve(root, 'index.html'))) files.push(resolve(root, 'index.html'));
    const out = [...new Set([...files, ...[...seen].map((f) => virtual.get(f)?.source ?? f)])].sort();
    if (!dev && sourceInput !== undefined) sourceKept = { input: sourceInput, seen: seen.size, files: out, set: new Set(out) };
    return out;
  };
  /**
   * a point's file (points.ts): the source page itself, or a virtual page (`<root>/<locale>/<page>`, an entry's
   * `<root>/blog/hello.html`) that the build and the dev server serve from its source
   */
  const fileOf = (pt: Point) => {
    if (!pt.locale && !pt.entry && !pt.axes.length) return pt.source;
    const v = resolve(root, pt.rel);
    virtual.set(v, { source: pt.source, locale: (pt.locale ?? undefined) as unknown as string, ...(pt.entry ? { page: pt.entry } : {}), ...(pt.axes.length ? { axes: pt.axes } : {}) });
    return v;
  };
  /** the origin a page (by its output path) is served from, when one of its axes' values has one (`pointOrigin`) */
  const groupOf = (rel: string): { folder: string; origin: string } | null => {
    const v = virtual.get(resolve(root, rel));
    return v ? pointOrigin(v.axes ?? [], v.locale, lurls) : null;
  };
  /** a page's path as its origin serves it: without its origin's folder */
  const urlRel = (rel: string) => { const g = groupOf(rel); return g ? rel.slice(g.folder.length + 1) : rel; };
  /** every origin's folder, from the points */
  const groups = () => new Set([...virtual.values()].flatMap((v) => [pointOrigin(v.axes ?? [], v.locale, lurls)?.folder].filter((x): x is string => !!x)));
  /** the pages that link and are listed together: one origin's, or those of the site's own */
  const sameGroup = (a: string, b: string) => groupOf(a)?.folder === groupOf(b)?.folder;
  /**
   * a source's variants (points.ts): every combination of its axes' values, outer first (an inner list may read an outer
   * item: `file:/content/{tenant.key}/…`), each with its own entries (`withEntries`, a build's) or none; null for a
   * page without axes
   */
  const variantsOf = (f: string, l: string | null, withEntries: boolean): Variant[] | null => {
    const t = templateOf(f, l ?? undefined);
    if (!t?.axes?.length) return null;
    const out: Variant[] = [];
    const walk = (vals: AxisValue[]) => {
      const here = vals.length ? templateOf(f, l ?? undefined, vals) : t;
      if (vals.length === t.axes!.length) { out.push({ axes: vals, entries: withEntries && here?.pages ? here.pages.entries : null }); return; }
      const ax = here?.axes?.[vals.length];
      for (const e of ax?.entries ?? []) {
        // an entry with an `origin` (`https://acme-shop.com`): its pages on that domain, written under its key's folder
        // (a build's; dev serves it under its key, as a segment)
        const o = (e.value as { origin?: unknown } | null)?.origin;
        const origin = !dev && typeof o === 'string' && /^https?:\/\/[^/]+\/?$/.test(o) ? o.replace(/\/$/, '') : null;
        walk([...vals, { value: e.value, key: e.key, segment: origin ? null : e.key, ...(origin ? { folder: e.key, origin } : {}), ...(ax?.src ? { list: ax.src } : {}) }]);
      }
    };
    walk([]);
    return out;
  };
  /**
   * the points of the source pages: each in each language, and a page per entry's entries (a build's; dev compiles a
   * template per URL, `devEntry`). `withEntries` lists them only when a source is a template (the build's inputs).
   */
  const points = (withEntries: boolean): Points => listPoints({
    sources: sourceEntries().map((f) => {
      const pg = withEntries ? templatePages(f) : null;
      const axes = templateOf(f)?.axes?.length;
      if (axes) return { source: f, rel: relOf(f), variants: (l: string | null) => variantsOf(f, l, withEntries)! };
      return { source: f, rel: relOf(f), entries: pg ? (l: string | null) => (l ? templatePages(f, l)!.entries : pg.entries) : null };
    }),
    locales: locales?.list ?? null, ...(lurls ? { languages: lurls } : {}), base: base(),
    inPublic: (rel) => !!resolved?.publicDir && existsSync(resolve(resolved.publicDir, rel + '.html')),
  });
  /** the app's HTML entries: its pages, or with `localePrefix` each page in each language */
  const entries = () => pageInputs ?? (locales || hasAxes() ? points(false).points.map(fileOf) : sourceEntries());
  /** whether a source page is built over axes (kept with the build's list of them) */
  const hasAxes = () => {
    const files = sourceEntries(), kept = sourceKept?.files === files ? sourceKept : null;
    if (kept?.axes !== undefined) return kept.axes;
    const v = files.some((f) => templateOf(f)?.axes?.length);
    if (kept) kept.axes = v;
    return v;
  };
  /**
   * `<html data-sn-for>` (docs/static-pages.md#a-page-per-entry): a page's entries, from a compile of it as its template, which
   * reads its `file:` list; null for a page without it. Its errors (SN340, SN340) fail the build: the template is no
   * input of its own, so nothing else would report them.
   */
  const templatesKept = new Map<string, { pages: CompileResult['pages'] | null; axes: CompileResult['axes'] | null } | null>();
  /** `data-sn-for` on `<html>`, on a layout's tag (a custom element: no other takes it), or on the layout's own `<html>` */
  const FOR_ATTR = /<(?:html|[a-z][\w.]*-[\w.-]*)(?=[\s/>])(?:[^>"']|"[^"]*"|'[^']*')*\sdata-sn-(?:for|pages)\s*=/i;
  const declaresFor = (html: string) => {
    if (FOR_ATTR.test(html)) return true;
    const tag = /^\s*(?:<!--[\s\S]*?-->\s*|<!doctype[^>]*>\s*)*<([a-z][\w.]*-[\w.-]*)(?=[\s/>])/i.exec(html)?.[1];
    const lf = tag ? resolve(root, 'src/layouts', `${tag.toLowerCase()}.html`) : null;
    try { return !!lf && FOR_ATTR.test(readFileSync(lf, 'utf8')); } catch { return false; }
  };
  /**
   * A page's axes and entries (`data-sn-for` on `<html>`), from a compile of it as its template: in a language (a
   * `{$locale}` path reads that language's files) and with its outer axes' values (`vals`: an inner list may read them)
   */
  const templateOf = (file: string, locale?: string, vals: AxisValue[] = []): { pages: CompileResult['pages'] | null; axes: CompileResult['axes'] | null } | null => {
    const k = [file, locale ?? '', ...vals.map((v) => v.key)].join('\0');
    if (!dev && templatesKept.has(k)) return templatesKept.get(k)!;
    const html = readFileSync(file, 'utf8');
    if (!declaresFor(html)) { templatesKept.set(k, null); return null; }
    const p = proj();
    // the list's entries, its axes' entries and the SN340/SN341 errors are the walk's: a description's single pass
    // (`describeOnly`, nothing evaluated), not the page's two
    // (test/compiler/template-probe.test.ts)
    const out = compile(html, { ...compileOptionsOf(p), file, dev, helpers: helpersOf(p.helpers), readFile: readVia(p), ...(dev ? {} : { globCache, componentCache }), ...contentOpts(locale), describeOnly: true, ...(locale ? { locale: { name: locale, urls: null, base: resolved?.base ?? '/', ...(cpaths() ? { paths: cpaths()! } : {}) } } : {}), ...(vals.length ? { axes: vals } : {}) });
    const fatal = out.diagnostics.filter((d) => d.severity === 'error' && /^SN34[01]$/.test(d.code));
    if (fatal.length) throw new Error(`sinter: ${fatal.map(formatDiagnostic).join('\n')}`);
    const t = { pages: out.pages ?? null, axes: out.axes ?? null };
    const r = t.pages || t.axes ? t : null;
    if (!dev) templatesKept.set(k, r);
    return r;
  };
  /** the lists some page is built over (their `src`), for links in loops over them (`axisLists`) */
  let axisListsKept: string[] | null = null;
  const axisLists = () => (axisListsKept ??= [...new Set(sourceEntries().flatMap((f) => templateOf(f)?.axes?.map((a) => a.src) ?? []))].sort());
  /**
   * `axisUrl(list, key)` (docs/proposals/axes.md §5): each point's URL at the other values of each of its axes, by the
   * list's `src` and the value's key; on another origin, absolute. Indexed once: every point by its source, language,
   * entry and axes' values with one of them left out.
   */
  let axisIndexKept: Map<string, Array<{ file: string; list: string; key: string }>> | null = null;
  const pointKey = (v: { source: string; locale?: string; page?: { key: string }; axes?: AxisValue[] }, skip: number) =>
    [v.source, v.locale ?? '', v.page?.key ?? '', ...(v.axes ?? []).map((a, i) => (i === skip ? '*' : `${a.list}\0${a.key}`))].join('\u0001');
  const axisUrlsOf = (file: string): Record<string, Record<string, string>> | null => {
    const v = virtual.get(file);
    if (!v?.axes?.some((a) => a.list)) return null;
    if (!axisIndexKept) {
      axisIndexKept = new Map();
      for (const [f, x] of virtual) (x.axes ?? []).forEach((a, i) => {
        if (!a.list) return;
        const k = pointKey(x, i);
        if (!axisIndexKept!.has(k)) axisIndexKept!.set(k, []);
        axisIndexKept!.get(k)!.push({ file: f, list: a.list, key: a.key });
      });
    }
    const from = groupOf(relOf(file))?.folder, out: Record<string, Record<string, string>> = {};
    v.axes.forEach((a, i) => {
      if (!a.list) return;
      for (const o of axisIndexKept!.get(pointKey(v, i)) ?? []) {
        const rel = relOf(o.file), g = groupOf(rel);
        const u = pageUrl(urlRel(rel), base(), describe(o.file).path);
        if (u === null) continue;
        const origin = g?.folder === from ? '' : g?.origin ?? siteOrigin;
        if (origin === null) continue;
        (out[o.list] ??= {})[o.key] = origin + u;
      }
    });
    return Object.keys(out).length ? out : null;
  };
  /**
   * Links to other points (docs/proposals/axes.md §5): for a page, a link its own point's pages do not answer goes to
   * the page at that path at the point the page is at, with the axes' values its row names (`data-sn-pt`) over its
   * own; on another origin, absolute. A link to a page only an axis's values have, from a page that has none of that
   * axis and no row to name one, cannot be derived: `fail` is called with why.
   */
  const pointLinks = (all: PageEntry[]) => {
    const by = new Map<string, Array<{ rel: string; patterns: string[]; locale: string | null; axes: AxisValue[] }>>();
    for (const x of all) {
      const v = virtual.get(resolve(root, x.rel)), locale = v?.locale ?? null, axes = v?.axes ?? [];
      const folder = pointFolder(locale, axes, lurls);
      const bare = folder && x.rel.startsWith(`${folder}/`) ? x.rel.slice(folder.length + 1) : x.rel;
      const noExt = '/' + bare.replace(/\.html?$/, '');
      const keys = new Set(['/' + bare, noExt, `${noExt}/`]);
      if (/(^|\/)index$/.test(noExt)) { const d = noExt.replace(/index$/, ''); keys.add(d); keys.add(d.replace(/(.)\/$/, '$1')); }
      for (const k of keys) { if (!by.has(k)) by.set(k, []); by.get(k)!.push({ rel: x.rel, patterns: x.patterns, locale, axes }); }
    }
    return (rel: string, fail: (why: string) => void): OtherPoint => {
      const here = virtual.get(resolve(root, rel)), from = groupOf(rel);
      return (site, at) => {
        const cands = by.get(site);
        if (!cands) return null;
        const want = new Map((here?.axes ?? []).flatMap((a) => (a.list ? [[a.list, a.key] as const] : [])));
        for (const [k, x] of at ?? []) want.set(k, x);
        const ok = cands.filter((c) => c.locale === (here?.locale ?? null) && c.axes.every((a) => !a.list || want.get(a.list) === a.key));
        if (!ok.length) {
          const need = cands.flatMap((c) => c.axes.filter((a) => a.list && !want.has(a.list)).map((a) => a.list!));
          if (need.length) fail(`the link to \`${site}\` goes to a page built per entry of \`${need[0]}\`, and this page is not, nor is the link in a loop over that list: put it in one (\`<template data-sn-for="t in …">\`), or link to one entry's page`);
          return null;
        }
        const best = ok.reduce((a, b) => (b.axes.length > a.axes.length ? b : a));
        const to = pointOrigin(best.axes, best.locale, lurls);
        const url = pageUrl(to ? best.rel.slice(to.folder.length + 1) : best.rel, base(), best.patterns);
        if (url === null) return null;
        if (to?.folder === from?.folder) return '/' + url.slice(base().replace(/\/?$/, '/').length);
        const origin = to?.origin ?? siteOrigin;
        if (!origin) { fail(`the link to \`${site}\` goes to the site's page \`${url}\` from ${from!.origin}'s: set \`sinter({ site })\`, so it can be absolute`); return null; }
        return origin + url;
      };
    };
  };
  /** a page per entry's entries (`data-sn-for` on `<html>` without axes), or null */
  const templatePages = (file: string, locale?: string): NonNullable<CompileResult['pages']> | null => templateOf(file, locale)?.pages ?? null;
  /** an entry's URL in each language that has it (the entry with its key in that language's list) */
  const entryUrls = (v: { source: string; page?: { key: string }; axes?: AxisValue[] }, from: string | null = null): Record<string, string> | null => {
    const by = v.page ? translations.get(translationKey(v.source, v.axes ?? [], v.page.key)) : undefined;
    if (!by) return null;
    return Object.fromEntries([...by].map(([l, path]) => { const at = pointPrefix(l, v.axes ?? [], lurls); return [l, elsewhere(l, v.axes ?? [], from) + (at ? prefixed([path], at)[0]! : path)]; }));
  };
  /** a point's origin when it is not the page's (`from`, its origin's folder, null for the site's): its URLs are absolute */
  const elsewhere = (l: string | null, axes: AxisValue[], from: string | null) => { const o = pointOrigin(axes, l, lurls); return (o?.folder ?? null) === from ? '' : o?.origin ?? siteOrigin ?? ''; };
  /** where an entry's language chooser is, at its unprefixed path: the base language's entry's, else the first's */
  const entryChooser = (v: { source: string; page?: { key: string }; axes?: AxisValue[] }): string | null => {
    const at = entryChooserPath(translations, translationKey(v.source, v.axes ?? [], v.page!.key), locales!.base);
    // under its axes' segments (`/acme/blog/hello`), the language's chooser
    const segs = pointPrefix(null, v.axes ?? [], lurls);
    return at && segs ? prefixed([at], segs)[0]! : at;
  };
  /** dev: the entry a URL names on a `<html data-sn-for>` page (its path, under `base`), else its first */
  const devEntry = (file: string, url: string, locale?: string, axes: AxisValue[] = []): { value: unknown; path: string; key: string } | undefined => {
    let pages: CompileResult['pages'] | null | undefined;
    try { pages = (axes.length ? templateOf(file, locale, axes) : templateOf(file, locale))?.pages; } catch { return undefined; }
    if (!pages) return undefined;
    let path = decodeURIComponent(url.split(/[?#]/)[0]!).replace(/\/$/, '');
    const at = pointPrefix(locale ?? null, axes, lurls);
    if (at) { const b = base().replace(/\/?$/, '/'); if (path.startsWith(`${b}${at}/`)) path = b.replace(/\/$/, '') + path.slice(b.length + at.length); }
    return pages.entries.find((e) => decodeURIComponent(e.path) === path) ?? pages.entries[0];
  };
  /**
   * builds: each `<html data-sn-for>` page becomes one input per entry, a virtual page at the entry's path (`blog/hello.html`
   * for `/blog/hello`), compiled with its entry; the template itself is no input. A path another page or a file in
   * `public/` has fails the build.
   */
  const pagesInputs = (): string[] | null => {
    if (!sourceEntries().some((f) => templateOf(f))) return null;
    const pl = points(true);
    translations = pl.translations;
    return pl.points.map(fileOf);
  };
  /** a page's HTML: its file, or for a page in a language its source's */
  const readPage = (file: string) => readFileSync(virtual.get(file)?.source ?? file, 'utf8');
  /** a source page's `data-sn-path` under a language's prefix, after the base (`/de/article/:slug`) */
  const prefixed = (patterns: string[], locale: string) => prefixPaths(patterns, locale, resolved?.base);
  /**
   * A page's point's prefixes for its link templates (the compiler's `points`): its whole prefix (`de/acme`) with the
   * pages built over the same axes, then its language's (`de`) with the others; null for a page under no prefix
   */
  const pointLevels = (file: string): Array<{ prefix: string; pages: string[] }> | null => {
    const v = virtual.get(file);
    if (!v?.locale && !v?.axes?.some((a) => a.segment)) return null;
    const lists = (f: string) => (templateOf(f)?.axes ?? []).map((a) => a.src).join('\0'), mine = lists(v.source);
    const paths = (fs: string[]) => fs.flatMap((f) => pagePaths(relOf(f), resolved?.base ?? '/', describeSource(f).path));
    const same = sourceEntries().filter((f) => mine && lists(f) === mine), rest = sourceEntries().filter((f) => !same.includes(f));
    const out = [{ prefix: pointPrefix(v.locale ?? null, v.axes ?? [], lurls), pages: paths(same) }, { prefix: v.locale ? segmentOf(v.locale, locales) : '', pages: paths(rest) }];
    return out.filter((x) => x.prefix && x.pages.length);
  };
  /** `localePrefix`: every path a source page answers at, without a language (a link template's start is checked against them) */
  const sitePaths = () => sourceEntries().flatMap((f) => pagePaths(relOf(f), resolved?.base ?? '/', describeSource(f).path));
  /** a source page's URL in each language (for `localeUrl()` and `hreflang`), or null for a page whose paths all have parameters */
  const localeUrls = (source: string, axes: AxisValue[] = [], from: string | null = null): Record<string, string> | null => {
    const b = resolved?.base?.startsWith('/') ? resolved.base : '/';
    const pats = describeSource(source).path, out: Record<string, string> = {};
    for (const l of locales!.list) {
      const at = pointPrefix(l, axes, lurls);
      const u = at ? pageUrl(`${at}/${relOf(source)}`, b, prefixed(pats, at)) : pageUrl(relOf(source), b, pats);
      if (u === null) return null;
      out[l] = elsewhere(l, axes, from) + u;
    }
    return out;
  };
  /** every page with the paths it answers at, and what another page can request ahead for it */
  /** a page's description (its patterns, what can be requested ahead), compiled once; a page in a language, under its prefix */
  /** a page's description's options: no prerender (nothing evaluated); a page in a language, under its prefix */
  const describeOptions = (file: string): Parameters<typeof compile>[1] => {
    const p = proj(), v = virtual.get(file);
    // with the APIs and specs: what is requested ahead is the page's own request (its base, its configured shape)
    return { ...compileOptionsOf(p), file: v?.source ?? file, dev, helpers: helpersOf(p.helpers), readFile: readVia(p), ...(dev ? {} : { globCache, componentCache, ...(entries().length >= LINK_DESCRIPTIONS ? { definitions: describedDefinitions } : {}) }), ...contentOpts(v?.locale), ...(v?.page ? { page: v.page } : {}), ...(v?.axes ? { axes: v.axes } : {}), describeOnly: true, ...(v?.locale ? { locale: { name: v.locale, urls: null, base: resolved?.base ?? '/', ...(cpaths() ? { paths: cpaths()! } : {}) } } : {}) };
  };
  /** a page's description compiled (`describeOnly`: a walk), or the one of a page that does not compile */
  const describeCompiled = (file: string): Described => {
    try {
      const r = compile(readPage(file), describeOptions(file));
      return { parts: r.prefetch, path: r.path, off: !!r.prefetchOff, keep: r.permanent ?? [], swapOff: !!r.swapOff, keptSource: r.keptSource ?? {}, keptBound: r.keptBound ?? [], effect: r.loadEffect ?? null };
    } catch { return { parts: null, path: [], off: false, keep: [], swapOff: true, keptSource: {}, keptBound: [], effect: 'it did not compile' }; }
  };
  /**
   * A build's page of its own is described without a walk (redesign-notes/page-walked-once.md) unless `SN_LATE_DESCRIBE=0`:
   * what the other pages read of it before it compiles is its head (`pageHead`: its paths, `data-sn-prefetch="off"`,
   * `data-sn-swap="off"`), and what it can have requested ahead (`parts`) is read off its own compile's first pass
   * (`describedPrefetch`), which only what waits for every page reads: the page modules' prefetch import
   * (`prefetchLater`, `latePages`) and the prefetch module. Null when it is, or why its description is compiled: its
   * loads' effects (`prerender: 'auto'`) and what a swap keeps (`swap`) are read as pages compile, an embedded
   * resource is not requested ahead (`embed`); a template's entries share their template's (`entryDescription`).
   */
  const lateWhy = (file: string): string | null => {
    if (dev) return 'dev';
    if (process.env.SN_LATE_DESCRIBE === '0') return 'off';
    if (virtual.get(file)?.page) return 'an entry';
    if (spec()?.mode === 'auto') return "prerender: 'auto'";
    if (options.swap) return 'swaps';
    // (an embedded resource is not requested ahead: the build compile embeds where the description does not)
    if (options.embed) return 'embed';
    return null;
  };
  /** the build's descriptions by route (`SN_PASS_LOG=1`): read off the page's head, or compiled and why */
  const lateStat = (why: string | null) => {
    if (why === 'dev') return;
    if (why === null) LATE_STATS.head++;
    else LATE_STATS.compiled[why] = (LATE_STATS.compiled[why] ?? 0) + 1;
  };
  /** a page's description, once per build (`described`) */
  const describe = (file: string) => {
    if (!described.has(file)) {
      const v = virtual.get(file);
      const kept = entryDescription(v);
      if (kept) { described.set(file, kept); return kept; }
      let why = lateWhy(file);
      if (why === null) {
        try {
          const h = pageHead(readPage(file), describeOptions(file));
          described.set(file, { parts: null, path: h.path, off: h.prefetchOff, keep: [], swapOff: h.swapOff, keptSource: {}, keptBound: [], effect: null, late: true });
          lateStat(null);
          if (describeAudit) {
            const d = described.get(file)!;
            if (!auditedDescriptions.has(file)) auditedDescriptions.set(file, describeCompiled(file));
            const was = auditedDescriptions.get(file)!;
            for (const k of ['path', 'off', 'swapOff'] as const) if (JSON.stringify(was[k]) !== JSON.stringify(d[k])) throw new Error(`sinter describe audit: ${relOf(file)}: \`${k}\` read off the page's head is ${JSON.stringify(d[k])}, its description's ${JSON.stringify(was[k])}`);
          }
          return described.get(file)!;
        } catch (e) {
          if (String((e as Error)?.message).startsWith('sinter describe audit')) throw e;
          why = 'its head did not read';
        }
      }
      lateStat(why);
      described.set(file, describeCompiled(file));
      if (v?.page) entriesDescribed.set(`${v.source}\0${v.locale ?? ''}`, { page: v.page.path, d: described.get(file)! });
    }
    return described.get(file)!;
  };
  /** a page's description read off its own build compile (the fields `describe` reads of a `describeOnly` compile) */
  const describedBy = (out: CompileResult): Described => ({ parts: out.prefetch, path: out.path, off: !!out.prefetchOff, keep: out.permanent ?? [], swapOff: !!out.swapOff, keptSource: out.keptSource ?? {}, keptBound: out.keptBound ?? [], effect: out.loadEffect ?? null });
  /**
   * (`lateWhy`) what each page described off its head can have requested ahead, from its build compile's first pass
   * (`describedPrefetch`), or from its description compiled after all where that does not say (`LATE_STATS.late`)
   */
  const lateParts = new Map<string, PrefetchParts | null>();
  const takeParts = (file: string, out: CompileResult) => {
    const r = describedPrefetch(out);
    if (r && 'parts' in r) { lateParts.set(file, r.parts); return; }
    const why = r?.why ?? 'not compiled for it';
    LATE_STATS.late[why] = (LATE_STATS.late[why] ?? 0) + 1;
    lateParts.set(file, (auditedDescriptions.get(file) ?? describeCompiled(file)).parts);
  };
  /** a page's description as what waits for every page reads it: its parts its compile's where its head stood for it */
  const finalDescription = (file: string): Described => {
    const d = describe(file);
    return d.late ? { ...d, parts: lateParts.get(file) ?? null } : d;
  };
  /**
   * build: the pages compiled or failed, and once every page is (`lateWait`): what waits for every page's parts (a
   * page that failed fails the build; it does not hold the others)
   */
  const lateSettled = new Set<string>();
  let lateReady: { promise: Promise<void>; resolve(): void } | null = null;
  const lateWait = () => (lateReady ??= (() => { let resolve!: () => void; const promise = new Promise<void>((r) => (resolve = r)); return { promise, resolve }; })());
  const lateSettle = (file: string) => { lateSettled.add(file); if (entries().every((f) => lateSettled.has(f))) lateWait().resolve(); };
  /**
   * build: the page modules compiled before every page had (`lateWhy`), each with the prefetch import it was given and
   * its result, written again (`moduleWith`) if the import every page decides differs
   */
  const latePages = new Map<string, { out: CompileResult; group: string | undefined; prefetch: string | null }>();
  /**
   * `SN_DESCRIBE_AUDIT=1` (redesign-notes/page-walked-once.md): a page described off its head is described the old way
   * beside it (`describeOnly`), and its build compile's description must be that one, every field but the loads'
   * effect, which only \`prerender: 'auto'\` reads and which is never described this way; the first difference throws.
   * Every page's build compile is also compared with its description, every field, and a difference printed with the
   * counts at exit (\`sinter describe audit: …\`): what a description taken from the build compile would change.
   */
  const describeAudit = process.env.SN_DESCRIBE_AUDIT === '1';
  const auditedDescriptions = new Map<string, Described>();
  const auditDescription = (file: string, out: CompileResult) => {
    const d0 = describe(file), d = auditedDescriptions.get(file) ?? d0, kind = virtual.get(file)?.page ? 'entry' : 'own';
    const text = (x: unknown) => JSON.stringify(x);
    // the build compile's own fields (its `prefetch` the pass with decided branches in place), and those the route reads
    const own = describedBy(out), b = d0.late ? { ...own, parts: lateParts.get(file) ?? null } : own;
    const fields = (Object.keys(own) as Array<keyof Described>).filter((k) => text(d[k]) !== text(own[k]));
    DESCRIBE_AUDIT[fields.length ? 'differ' : 'same'][kind]++;
    if (fields.includes('effect')) DESCRIBE_AUDIT.effect[kind]++;
    if (fields.some((k) => k !== 'effect')) console.error(`sinter describe audit: ${relOf(file)} (${kind}), the build compile's own: ${fields.map((k) => `${k}: described ${text(d[k])?.slice(0, 300)}, compiled ${text(own[k])?.slice(0, 300)}`).join('; ')}`);
    // (`parts` where the route reads them: with next-page data on, `prefetchData`; without it nothing reads them)
    const wrong = auditedDescriptions.has(file) ? (Object.keys(b) as Array<keyof Described>).filter((k) => k !== 'effect' && (k !== 'parts' || lateParts.has(file)) && text(d[k]) !== text(b[k])) : [];
    if (wrong.length) throw new Error(`sinter describe audit: ${relOf(file)}: its build compile's description differs from its description in ${wrong.map((k) => `\`${k}\`: described ${text(d[k])?.slice(0, 300)}, compiled ${text(b[k])?.slice(0, 300)}`).join('; ')}`);
  };
  /** a source page's description, as written (no language's prefix) */
  const describeSource = (source: string) => {
    if (!sourceDescribed.has(source)) {
      const p = proj(), html = readFileSync(source, 'utf8');
      const opts = { ...compileOptionsOf(p), file: source, dev, helpers: helpersOf(p.helpers), readFile: readVia(p), ...(dev ? {} : { globCache, componentCache }), ...contentOpts() };
      const compiled = () => { try { return compile(html, opts).path; } catch { return []; } };
      // (a build: its paths read off its head, as a page's description's are, unless `SN_LATE_DESCRIBE=0`)
      let path: string[] | null = null;
      if (!dev && process.env.SN_LATE_DESCRIBE !== '0') try { path = pageHead(html, opts).path; LATE_STATS.sources++; } catch { /* compiled */ }
      if (path && describeAudit) { const was = compiled(); if (JSON.stringify(was) !== JSON.stringify(path)) throw new Error(`sinter describe audit: ${relOf(source)}: its paths read off its head are ${JSON.stringify(path)}, compiled ${JSON.stringify(was)}`); }
      sourceDescribed.set(source, path ?? compiled());
    }
    return { path: sourceDescribed.get(source)! };
  };
  /** every page, with its `data-sn-path` patterns: where it is written and what its links name (page-urls.ts) */
  const pageEntries = (): PageEntry[] => entries().map((file) => ({ rel: relOf(file), patterns: describe(file).path }));
  const appPages = () => {
    if (pagesCache) return pagesCache;
    const out: Array<{ paths: string[]; parts: PrefetchParts | null; swaps: boolean; file: string; effect: string | null }> = [];
    for (const file of entries()) {
      const d = describe(file);
      // `<html data-sn-prefetch="off">`: neither described nor in the rules
      if (d.off) continue;
      out.push({ paths: pagePaths(urlRel(relOf(file)), resolved?.base ?? '/', d.path), parts: d.parts, swaps: !!options.swap && !d.swapOff, file, effect: d.effect });
    }
    return (pagesCache = out);
  };
  /** the pages one page's lists name (next-page data, swaps): its origin's, or the site's own (`group`: an origin's folder) */
  const inGroup = (file: string, group: string | undefined) => groupOf(relOf(file))?.folder === group;
  /** the module of a group's next-page data and its swap list: one per origin, as two origins' pages share paths */
  const prefetchId = (group?: string) => (group ? `${PREFIX}prefetch-${group}.js` : PREFETCH);
  const swapId = (group?: string) => (group ? `${PREFIX}swap-${group}.js` : SWAP);
  /** with swaps on: the pages that swap and the names each keeps (swap-build.ts); a page with `data-sn-swap="off"` is not one */
  const swapPages = (group?: string): SwapPage[] => entries().filter((file) => inGroup(file, group)).flatMap((file) => {
    const d = describe(file);
    return d.swapOff ? [] : [{ m: pagePaths(urlRel(relOf(file)), resolved?.base ?? '/', d.path), k: d.keep }];
  });
  const prefetchPages = (group?: string) => appPages().map((x) => (described.get(x.file)?.late ? { ...x, parts: finalDescription(x.file).parts } : x)).filter((x): x is { paths: string[]; parts: PrefetchParts; swaps: boolean; file: string; effect: string | null } => !!x.parts && inGroup(x.file, group));
  /** how the Speculation Rules are delivered, or null for none */
  const spec = () => {
    // inline by default: it works with no server setup (a CSP in the page gets the rules' hash, see withRulesHash)
    const o = speculation;
    if (o === false) return null;
    if (o === true) return { mode: 'prefetch' as const, delivery: 'inline' as const };
    return { mode: o.prerender === 'auto' ? 'auto' as const : o.prerender ? 'prerender' as const : 'prefetch' as const, delivery: o.delivery ?? 'inline' };
  };
  /** the rules' JSON for links to the app's pages, or null; `samePage`: a page with same-page links (query-links.ts), whose own URLs are left out */
  /**
   * The Speculation Rules' pages: every page's paths, but a `<html data-sn-for>` page's entries are its pattern, once
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
  // `prerender: 'auto'`: the pages that do nothing on load but read are prerendered, the others prefetched
  const rulesOf = (mode: 'prefetch' | 'prerender' | 'auto', samePage: boolean) => {
    const entry = new Set<string>(), pages = appPages().filter((x) => !x.swaps);
    const quiet = (x: { file: string; effect: string | null }) => mode == 'prerender' || (mode == 'auto' && !x.effect && !appEffect());
    const lists = { prefetch: [] as string[], prerender: [] as string[] };
    for (const v of virtual.values()) if (v.page) entry.add(v.page.path);
    for (const x of pages) lists[quiet(x) ? 'prerender' : 'prefetch'].push(...x.paths.filter((p) => !entry.has(p)));
    // a `<html data-sn-for>` page's entries: its pattern, once, as quiet as the entry the plugin described
    const patterns = new Set<string>();
    for (const v of virtual.values()) {
      const x = v.page && pages.find((y) => y.paths.includes(v.page!.path));
      const pt = x && templatePattern(v.source);
      if (x && pt && !patterns.has(pt)) { patterns.add(pt); lists[quiet(x) ? 'prerender' : 'prefetch'].push(pt); }
    }
    return speculationRules(lists, samePage);
  };
  /**
   * `prerender: 'auto'`: the first load-time effect of the app's modules every page may import (config, early, helpers,
   * actions; `prerender-build.ts`), null for none: with one, no page is prerendered. Checked once per build (dev: per change)
   */
  let appEffects: { for: unknown; effect: string | null } | null = null;
  const appEffect = () => {
    const p = proj();
    if (appEffects?.for !== p) {
      const files = [p.config, p.early].filter((x): x is string => !!x).map((u) => resolve(root, u.replace(/^\//, ''))).concat([p.helpersFile, p.actionsFile].filter((x): x is string => !!x));
      const seen = new Map<string, string | null>();
      appEffects = { for: p, effect: files.map((f) => moduleEffect(f, root, seen)).find((e) => e) ?? null };
    }
    return appEffects.effect;
  };
  /**
   * builds: a link in a finished page to a path a `<html data-sn-for>` pattern matches, but no entry was written at, fails
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
  /** a `<html data-sn-for>` page's pattern, as its template writes it (read once per build) */
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
    // (the pages of a group mostly have the same rules: hashed once while they do)
    if (json !== hashedRules?.json) hashedRules = { json, hash: `sha256-${createHash('sha256').update(json).digest('base64')}` };
    speculationHash = hashedRules.hash;
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
    // what `sinter check` and the editor compile against (the last load that worked; with languages, the base one's),
    // and the types of the namespaces app code imports
    if (!c.error) { writeSnapshot(root, p.contentFile, c, locales?.base ?? c.languages?.base); writeNamespaceTypes(p.contentFile, c); }
    return c;
  };
  /** what every compile gets of the collections */
  // a build without `localePrefix` is in the content module's base language (`languages()`), its one language
  const contentOpts = (locale0?: string) => { const locale = locale0 ?? (!locales ? content?.languages?.base : undefined); return content ? {
    collections: collectionsIn(content, locale), ...(content.perPoint.size ? { perCollections: content.perPoint } : {}), ...(content.error ? { collectionsError: content.error } : {}),
    ...(content.namespaces.size ? { contentNs: contentNsAt(locale) } : {}),
  } : {}; };
  /** the content namespaces' formatters, loaded in Node (a build folds a call over constants with it) */
  const formatters = new Map<string, (entry: unknown, args: unknown, locale: string | null) => unknown>();
  /** a formatter module's `inline(entry)`, when it has one: the source of a function the build compiles in place of a call */
  const inliners = new Map<string, (entry: unknown) => string | null>();
  /** a formatter module's `pack(entry)`, when it has one: the smaller form of an entry written into a page for its modules */
  const packers = new Map<string, (entry: unknown) => unknown>();
  /** a namespace's entries as a page's `data-sn-ns` holds them: each packed by its formatter */
  const packed = (format: string, entries: Record<string, unknown>) => { const p = packers.get(format); return p ? Object.fromEntries(Object.entries(entries).map(([k, e]) => [k, e == null ? e : p(e)])) : entries; };
  /** a namespace's formatter module, as the page imports it: a path from the root as written, or a package */
  const formatSpec = (f: string) => f;
  /** the content namespaces in a language: each one's entries by id (docs/proposals/messages.md §1) */
  const contentNsAt = (locale?: string): NonNullable<Parameters<typeof compile>[1]['contentNs']> => {
    const out: NonNullable<Parameters<typeof compile>[1]['contentNs']> = {};
    if (!content) return out;
    // a namespace loaded per language: an entry missing in the page's is its chain's (`de-AT`, then `de`, then the base)
    const order = locale && locales ? chain(locale, locales).reverse() : [locale];
    for (const [exp, d] of content.namespaces) {
      const entries: Record<string, unknown> = {};
      for (const x of order) {
        const l = collectionsIn(content, x ?? undefined).get(exp);
        for (const e of (l?.value ?? []) as Array<Record<string, unknown>>) entries[String(e[l!.key])] = e;
      }
      out[d.name] = { entries, format: formatSpec(d.format), export: exp, ...(d.module ? { module: d.module } : {}), ...(formatters.get(d.format) ? { formatFn: formatters.get(d.format)! } : {}), ...(inliners.get(d.format) ? { inlineFn: inliners.get(d.format)! } : {}) };
    }
    return out;
  };
  /** the helpers manifest with the content namespaces in it: each one's entries' ids its members (the base language's) */
  const helpersOf = (h: ReturnType<typeof proj>['helpers']): ReturnType<typeof proj>['helpers'] => {
    if (!content?.namespaces.size) return h;
    const lists = collectionsIn(content, locales?.base ?? content.languages?.base);
    const namespaces = { ...h.namespaces };
    for (const [exp, d] of content.namespaces) {
      if (namespaces[d.name]) throw new Error(`sinter: the content module's namespace \`${d.name}\` (\`${exp}\`) and the helpers module's \`${d.name}\` have one name: a name calls one namespace`);
      // one loaded per axis: every point's ids (a page's calls are checked against its point's at compile)
      const pp = content.perPoint.get(exp);
      const ids = pp ? [...new Set([...pp.values.values()].flatMap((v) => (v as Array<Record<string, unknown>>).map((e) => String(e[pp.key]))))]
        : (() => { const l = lists.get(exp); return ((l?.value ?? []) as Array<Record<string, unknown>>).map((e) => String(e[l!.key])); })();
      namespaces[d.name] = { module: `${CONTENT_NS}${d.name}`, members: ids.sort(), ...(d.type ? { type: d.type } : {}) };
    }
    return { ...h, namespaces };
  };
  /** builds: the `file:` lists already built (compile's `globCache`), cleared with the reads */
  const globCache: NonNullable<Parameters<typeof compile>[1]['globCache']> = new Map();
  /** builds: the component files as read and kinded (compile's `componentCache`), cleared with the reads */
  const componentCache = new Map<string, unknown>();
  /** builds: each `<html data-sn-for>` template's first pass, walked once for all its entries (compile's `templates`), cleared with the reads */
  const templates = new Map<string, unknown>();
  /** (docs/proposals/compile-once.md, (5)): builds: shared definitions, recorded on one page and linked into the next */
  const definitions = new Map<string, unknown>();
  /** (docs/proposals/redesign-notes/stage4-units.md): builds: the first passes' definitions, compiled once and placed on each page */
  const buildUnits = new Map<string, unknown>();
  const readVia = (p: ReturnType<typeof project>) => (dev ? p.readFile : (path: string) => {
    let r = buildReads.get(path);
    if (!r) { try { r = { text: p.readFile(path) }; } catch (error) { r = { error }; } buildReads.set(path, r); }
    if ('error' in r) throw r.error;
    return r.text;
  });
  /** the build's helper calls that folded, by page and call, for the cross-check at its end */
  /** Vite's HTML step skipped for pages it does not change (configResolved), and those pages, by file, while it runs */
  let htmlSkip = false;
  const htmlKept = new Map<string, string>(), htmlCount = { kept: 0, through: 0 };
  const foldCalls = new Map<string, FoldCall[]>();
  /**
   * The cross-check (fold-cross.ts) of a build: on this thread at its `buildEnd` (`SN_CROSS_LATE=0`, and this
   * repository's tests unless one asks with `SN_CROSS_LATE=1`), or in a worker that loads its fresh copy of the helpers
   * as the build starts and runs the calls beside Vite's HTML step (fold-late.ts); the last plugin waits for it, and a
   * difference fails the build there, as at `buildEnd` (the same message), after Vite emptied `dist/`.
   */
  const crossLateOn = () => (process.env.SN_CROSS_LATE ?? (process.env.VITEST ? '0' : '1')) !== '0';
  let crossLater: CrossWorker | null = null, crossPending: Promise<CrossAnswer> | null = null;
  const helpersConfig = () => (resolved ? { configFile: resolved.configFile ?? false, mode: resolved.mode, ...(resolved.configFile ? {} : { alias: resolved.resolve.alias }) } : {});
  /** the check on this thread: a fresh copy of the helpers module, the calls again */
  const crossHere = async (pages: Array<[string, FoldCall[]]>): Promise<CrossAnswer> => {
    const p = proj();
    const fresh = await loadHelpers({ root, helpersFile: p.helpersFile, manifest: p.helpers, fresh: true, ...helpersConfig(), cache: foldCache });
    return fresh.module ? { bad: crossCheck(fresh.module, pages) } : { error: fresh.error ?? 'it did not load' };
  };
  const crossReport = (ctx: { error(m: string): never }, a: CrossAnswer) => {
    if ('error' in a) resolved?.logger.warn(coded('SN534', `the helper calls that ran at build time could not be checked again in a fresh copy of the helpers module (${a.error.split('\n')[0]}): a helper that keeps state between calls would go unnoticed`));
    else if (a.bad.length) ctx.error(`sinter: error SN534 helper-not-folded: ${crossMessage(a.bad)}\n  docs: \`npx sinter docs SN534\`, ${docsUrl('SN534')}`);
  };
  /**
   * the site's core (docs/proposals/site-core.md): the parts of the core the build's pages use, and the pages compiled
   * so far; a build serves the core's flags module once every page is in (`load` waits for it), with the parts no page
   * uses off. Dev serves it as written, every part on.
   */
  const coreUsed = new Set<string>(), coreDone = new Set<string>();
  let coreReady: { promise: Promise<void>; resolve(): void } | null = null;
  const coreWait = () => (coreReady ??= (() => { let resolve!: () => void; const promise = new Promise<void>((r) => (resolve = r)); return { promise, resolve }; })());
  const coreCheck = () => { if (entries().every((f) => coreDone.has(f))) coreWait().resolve(); };
  /**
   * Until `ready` (every page of the build is in `done`). A page that never compiles would hold the wait forever: no page
   * compiled for 30 s is an error naming the pages left.
   */
  const everyPage = async (ready: Promise<void>, done: ReadonlySet<string>, what: string) => {
    for (let n = -1; ;) {
      let t: ReturnType<typeof setTimeout> | undefined;
      const waited = await Promise.race([ready.then(() => true), new Promise<false>((r) => (t = setTimeout(() => r(false), 30_000)))]);
      clearTimeout(t);
      if (waited) return;
      if (done.size === n) throw new Error(`sinter: ${what} waits for every page to compile, and these did not: ${entries().filter((f) => !done.has(f)).map(relOf).join(', ')}`);
      n = done.size;
    }
  };
  /** the core's flags module, as this build resolves it: next to this file (dist/runtime/flags.js; src/runtime/flags.ts when run from source, as the tests do) */
  const FLAGS = (() => { for (const f of ['./runtime/flags.js', './runtime/flags.ts']) try { return realpathSync(fileURLToPath(new URL(f, import.meta.url))); } catch { /* the other */ } return null; })();
  const logFold = (page: string, key: string, args: FoldArg[], result: string, id: number) => {
    // ids count from 0 when the page's calls start afresh: what an earlier run logged is replaced
    const calls = id === 0 || !foldCalls.has(page) ? foldCalls.set(page, []).get(page)! : foldCalls.get(page)!;
    calls.push({ key, args, hash: hashOf(result), id });
  };

  /**
   * What a page compiles with that decides what it means and what is reported about it: the project's options, its
   * language, its URLs (`$site`, `$canonical`), its entry and axes, the content and the helpers as the build loaded them.
   * The build's compile adds what it writes (modules, styles, images, the early script); `sinter check` and the editor
   * take it as it is (`api.pageOptions`), so they report what the build does. `outside`: a file that is no page of the
   * build, in its base language: a page the editor has open, or a component it compiles through a use of its own (no
   * page's options, `static` and the paths, and its URLs as if it were a page at its path).
   */
  const pageOptions = (p: ReturnType<typeof project>, file: string, url?: string, outside?: 'page' | 'component') => {
    const rel = relOf(file);
    // a page in a language: compiled from its source (diagnostics, components, layouts as written), in that language
    const v = virtual.get(file), src = v?.source ?? file;
    const one = pageLang(file);
    // `<html data-sn-for>`: an entry's page (a build's input), or in dev the entry the URL names
    const page = v?.page ?? (dev && url ? devEntry(src, url, v?.locale, v?.axes) : undefined);
    const group = groupOf(rel)?.folder;
    return {
      ...(outside === 'component' ? { ...compileOptionsOf(p), ...(p.swap ? { swap: true } : {}) } : compileOptionsOf(p, src)),
      file: src, dev, helpers: helpersOf(p.helpers), readFile: readVia(p), ...contentOpts(v?.locale ?? (outside ? locales?.base : undefined)),
      ...(page ? { page } : {}), ...(v?.axes ? { axes: v.axes } : {}), ...(axisLists().length ? { axisLists: axisLists() } : {}), ...(axisUrlsOf(file) ? { axisUrls: axisUrlsOf(file)! } : {}), ...(pointLevels(file) ? { points: pointLevels(file)! } : {}),
      ...(lazyPkgs.length ? { lazyScript } : {}),
      ...(helpersNow ? { helperValues: helpersNow.module, helperFold: helpersNow.fold } : {}),
      // build-time constants and pages with nothing to run do not depend on the early script: `firstPaint: false` turns off only that
      prerender: true as const,
      ...(p.changesRequests ? { changesRequests: true } : {}),
      ...(v?.locale ? { locale: { name: v.locale, urls: v.page ? entryUrls(v, group ?? null) : localeUrls(src, v.axes, group ?? null), base: resolved?.base ?? '/', list: locales!.list, pages: sitePaths(), ...(cpaths() ? { paths: cpaths()! } : {}) } }
        : outside && locales ? { locale: { name: locales.base, urls: null, base: resolved?.base ?? '/', list: locales.list, pages: sitePaths(), ...(cpaths() ? { paths: cpaths()! } : {}) } }
        : one ? { locale: { name: one, urls: null, base: resolved?.base ?? '/', prefix: false as const } } : {}),
      ...(options.origins?.length || apiOrigins(p.apis).length ? { origins: [...(options.origins ?? []), ...apiOrigins(p.apis)] } : {}),
      ...(resolved?.base?.startsWith('/') ? { base: resolved.base } : {}),
      ...(siteOrigin || groupOf(rel) ? { urls: urlsOf(rel, outside === 'component' ? [] : outside ? describedPaths(file) : out0Path(file)) } : {}),
    } satisfies Partial<Parameters<typeof compile>[1]>;
  };
  /**
   * `sinter check` and the editor: a source page's options as the build compiles it, in the base language when it is
   * built per language (`localePrefix`), as the template it is when it is built per entry or axis value; a file that is
   * no page of the build (`component`: a component compiled through a use of its own) in the base language
   */
  const checkPageOptions = (p: ReturnType<typeof project>, source: string, component = false) => {
    if (component || !sourceEntries().includes(source)) return pageOptions(p, source, undefined, component ? 'component' : 'page');
    const file = locales || templateOf(source)?.axes?.length
      ? points(false).points.map(fileOf).find((f) => (virtual.get(f)?.source ?? f) === source && (!locales || virtual.get(f)?.locale === locales.base)) ?? source
      : source;
    return pageOptions(p, file);
  };

  /** compiles one page; `earlySrc`: where the page loads its early chunk (dev), else the build injects the tag */
  const build = (html: string, file: string, earlySrc: string | null, styles?: StyleSheet[], lineHeights?: Map<string, number>, zeros?: Map<string, number | null>, minifyStyles?: StyleSheet[], url?: string): { out: CompileResult; p: ReturnType<typeof project> } => {
    const rel = relOf(file);
    const p = proj();
    const v = virtual.get(file), src = v?.source ?? file;
    const fatal = strictly(p.diagnostics).filter((d) => d.severity === 'error');
    if (fatal.length) throw new Error(`sinter: ${fatal.map(formatDiagnostic).join('\n')}`);
    // a warning about the options (a deprecated one): once per build
    for (const d of p.diagnostics) if (d.severity === 'warning' && !warnedOptions.has(d.message)) { warnedOptions.add(d.message); resolved?.logger.warn(formatDiagnostic(d)); }
    // a page not seen before may be a new one (dev); a build's pages per entry are all known from the start
    // (in a build, a page whose source is already one of the source pages changes no list: the pages stay as they were)
    if (!seen.has(file)) {
      if (!dev && !pageInputs) sourceEntries();
      const kept = !dev && !pageInputs ? sourceKept : null, known = !!kept && kept.seen === seen.size && kept.set.has(src);
      seen.add(file);
      if (known) kept.seen = seen.size;
      if (dev || (!pageInputs && !known)) pagesCache = null;
    }
    const group = groupOf(rel)?.folder;
    // (described off their heads: the import every page decides, guessed from the pages compiled so far, and the
    // module written again where the guess was wrong, once every page has compiled: `latePages`)
    const late = prefetchData && lateWhy(file) === null;
    // (the audit: every page described the old way where the old route describes them, before the first compile)
    if (describeAudit && !dev && !auditedDescriptions.size) for (const f of entries()) if (lateWhy(f) === null) auditedDescriptions.set(f, describeCompiled(f));
    const prefetch = !prefetchData ? null : late ? ([...lateParts].some(([f, x]) => !!x && !describe(f).off && inGroup(f, group)) ? prefetchId(group) : null) : prefetchPages(group).length ? prefetchId(group) : null;
    const out = compile(html, {
      ...pageOptions(p, file, url),
      sourcemap: dev || !!resolved?.build.sourcemap, moduleSrc: `${PREFIX}${rel}.js`, ...(dev ? {} : { globCache, componentCache, templates, ...(process.env.SN_NO_LINK ? {} : { definitions }), units: buildUnits }), prefetch,
      check: typecheckOn() && !dev,
      // a build: each distinct call that folds is run again at its end in a fresh copy of the module (fold-cross.ts)
      ...(helpersNow?.module && !dev ? { foldLog: (key: string, args: FoldArg[], result: string, id: number) => logFold(v?.page ? rel : relOf(src), key, args, result, id) } : {}),
      ...(images ? { images: imageHost(rel, styles)! } : {}),
      ...(styles?.length ? { styles } : {}),
      ...(minifyStyles ? { minify: { styles: minifyStyles } } : {}),
      ...(lineHeights?.size ? { normalLineHeight: (f: string) => lineHeights.get(f) ?? null } : {}),
      ...(zeros?.size ? { zeroWidth: (f: string) => zeros.get(f) ?? null } : {}),
      ...(firstPaint && !dev ? { paintCss: `${PAINT_CSS}${rel}.css` } : {}),
      ...(remoteConfig ? { remoteImages: dev ? devRemote(remoteConfig, resolved?.base ?? '/') : remoteConfig } : {}),
      ...(firstPaint ? { early: { module: p.early, src: earlySrc } } : {}),
      ...(firstPaint ? { observe: true } : {}),
      ...(options.embed && !dev ? { embed: true } : {}),
      componentCss: (name) => `${COMPONENT_CSS}${name}.css`,
      ...(p.swap ? { swapList: swapId(group) } : {}),
      ...(late ? { prefetchLater: true as const } : {}),
    });
    if (late) takeParts(file, out);
    if (late) latePages.set(`${PREFIX}${rel}.js`, { out, group, prefetch }); else latePages.delete(`${PREFIX}${rel}.js`);
    if (describeAudit && !dev) auditDescription(file, out);
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
    if (!dev) { for (const c of out.core ?? []) coreUsed.add(c); coreDone.add(file); coreCheck(); }
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
    if (out.contentNs) pageNs.set(rel, out.contentNs);
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
    const libs = options.libraries?.length ? proj().libraries : [];
    if ((id.includes('/node_modules/') || sinterFile(file)) && !libraryOf(libs, file)) return null;
    // a module of a lazy package (a component library listed in `lazy`) is the package: it loads whole with it
    const lib = libraryOf(libs, file);
    if (lib && lazyPackage(lib.name, lazyPkgs)) return null;
    if (!mentions(code, lazyPkgs)) return null;
    const s = scanLazy(code, file, lazyPkgs, sameFile(file, proj().helpersFile));
    if (!s.lazy.length && !s.problems.length && !s.drop?.length) return null;
    if (isComponentScript(root, file, libs)) return null;
    // a helper module that reaches the package, and the modules between: they load whole with it, when a let first needs them
    if (lazyReachOf(proj()).whole(proj().helpers).has(file)) return null;
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
    api: { options, source: (file: string) => virtual.get(file)?.source ?? file, pageOptions: checkPageOptions },

    /**
     * No modulepreload polyfill unless the app asks for one: every browser sinter's pages rely on
     * (`commandfor`, Speculation Rules, `blocking="render"`) preloads modules natively, and the
     * polyfill is ~400 B gzip in every page's bundle. Without it an older browser loads the same
     * modules, one import after the other.
     */
    config(user, env) {
      // a sinter app is a multi-page app: every page under the root is an entry, as the dev server serves any
      // of them, unless the config names its own input
      const b = user.build as { rollupOptions?: { input?: unknown }; rolldownOptions?: { input?: unknown }; outDir?: string } | undefined;
      const own = buildInput(b);
      const r = resolve(user.root ?? process.cwd());
      // a component library's own repository: its fixture pages, not its components' files
      const lib = ownLibrary(r);
      const pages = env.command === 'build' && own === undefined
        ? Object.fromEntries((lib ? lib.pages : htmlPages(r, { build: { outDir: b?.outDir ?? 'dist' }, publicDir: resolve(r, typeof user.publicDir === 'string' ? user.publicDir : 'public') } as ResolvedConfig))
          .map((f) => [relative(r, f).split(sep).join('/').replace(/\.html$/, ''), f]))
        : null;
      const mpa = { ...(user.appType === undefined ? { appType: 'mpa' as const } : {}), ...(pages && Object.keys(pages).length ? { build: { rollupOptions: { input: pages } } } : {}) };
      // dev: the lazy packages are pre-bundled at startup (no page imports them statically, so the scan would not find them)
      // component libraries ship source the plugin compiles: never pre-bundled
      const libs = librariesOf(options.libraries);
      const deps = lazyPkgs.length || libs.length ? { optimizeDeps: { ...(lazyPkgs.length ? { include: lazyPkgs } : {}), ...(libs.length ? { exclude: libs } : {}) } } : {};
      const mp = user.build?.modulePreload;
      const polyfill = mp === false || (typeof mp === 'object' && mp.polyfill !== undefined) ? {} : { modulePreload: { polyfill: false } };
      // one sinter for the app and its libraries: a library linked from outside the root (`file:`, `npm link`) would
      // import its own copy, whose `instance()` knows none of the app's mounts (Vite merges this with the app's list)
      return { ...deps, ...mpa, build: { ...mpa.build, ...polyfill }, resolve: { dedupe: [SELF] } };
    },

    async configResolved(config) {
      root = config.root;
      dev = config.command === 'serve';
      configPhase = !dev;
      resolved = config;
      // the build's walks of the app's modules (the lazy packages' reach, `prerender: 'auto'`) follow its aliases, as Vite does
      setAppAliases(root, config.resolve.alias);
      // the fold check's analyses, kept on disk by content for the next build (not in this repository's tests, unless one
      // asks: `SN_FOLD_CACHE=1`; `SN_FOLD_CACHE=0` turns it off); `vite --force` reads none of them
      // Vite's HTML step skipped for pages it does not change (html-step.ts): builds, no plugin but sinter's with an HTML
      // hook, none of what the step does to every page (a CSP nonce, one CSS file, a chunk import map, extra asset
      // sources); `SN_HTML_SKIP=0` sends every page through it
      const html = config.html as { cspNonce?: string; additionalAssetSources?: unknown } | undefined;
      htmlSkip = !dev && process.env.SN_HTML_SKIP !== '0' && !html?.cspNonce && !html?.additionalAssetSources && config.build.cssCodeSplit !== false
        && !(config.environments?.client?.build as { chunkImportMap?: unknown } | undefined)?.chunkImportMap
        && !config.plugins.some((x) => x.transformIndexHtml && !SINTER_PLUGINS.has(x.name));
      htmlKept.clear();
      const keep = process.env.SN_FOLD_CACHE ?? (process.env.VITEST ? '0' : '1');
      foldCache.dir = keep === '0' ? null : resolve(root, 'node_modules/.cache/sinter/fold');
      foldCache.fresh = !!config.optimizeDeps?.force;
      // dev: a component library's files are served wherever they really are (a workspace link outside the root)
      if (dev && options.libraries?.length) {
        const allow = (config.server.fs as { allow?: string[] }).allow;
        if (Array.isArray(allow)) for (const l of proj().libraries) if (!allow.includes(l.real)) allow.push(l.real);
      }
      // the content module's collections, before anything compiles (a build's errors stop it here); its `languages()` are
      // the site's languages
      content = await loadCollections();
      if (content?.error) {
        if (!dev) throw new Error(`sinter: ${content.error}`);
        config.logger.error(`sinter: ${content.error}`);
      }
      // the content namespaces' formatters, in Node: a build folds a call over constants with them
      formatters.clear();
      for (const d of content?.namespaces.values() ?? []) {
        if (formatters.has(d.format)) continue;
        try {
          const file = d.format.startsWith('/') ? resolve(root, `.${d.format}`) : d.format;
          const mod = await importModule({ root, configFile: config.configFile ?? false, mode: config.mode, ...(config.configFile ? {} : { alias: config.resolve.alias }) }, file);
          if (typeof mod.inline === 'function') inliners.set(d.format, mod.inline as (entry: unknown) => string | null);
          if (typeof mod.pack === 'function') packers.set(d.format, mod.pack as (entry: unknown) => unknown);
          if (typeof mod.format === 'function') formatters.set(d.format, mod.format as (entry: unknown, args: unknown, locale: string | null) => unknown);
          else throw new Error('it exports no `format(entry, args, locale)`');
        } catch (e) {
          const m = `sinter: the content namespace \`${d.name}\`'s formatter \`${d.format}\` could not be loaded: ${String((e as Error)?.message ?? e).split('\n')[0]}`;
          if (!dev) throw new Error(m);
          config.logger.error(m);
        }
      }
      const declared = content?.languages ?? null;
      // an inlang project the content module does not read: the built-in messages that read it are gone
      if (existsSync(resolve(root, 'project.inlang', 'settings.json')) && !content?.namespaces.size && !warnedOptions.has('messages')) {
        warnedOptions.add('messages');
        config.logger.warn('sinter: project.inlang is not read: the messages are a content namespace now. Export `inlang()` from the content module (`export const messages = inlang()` and `export const locales = languages(({ root }) => inlangLocales(\'project.inlang\', root))`, from `@tiaforge-ui/sinter/messages/content`), or run `npx sinter migrate --write` (docs/messages.md)');
      }
      if (declared && !options.localePrefix) config.logger.warn(`sinter: the content module declares languages (${declared.list.join(', ')}), and \`localePrefix\` is off: no page is built per language. Turn it on, \`sinter({ localePrefix: true })\`.`);
      if (options.localePrefix) {
        if (!declared) throw new Error('sinter({ localePrefix }): the site has no languages. Export them from the content module (src/sinter.content.ts): `export const locales = languages({ base: \'en\', list: [\'en\', \'de\'] })` from `@tiaforge-ui/sinter/content`, or from an inlang project, `languages(({ root }) => inlangLocales(\'project.inlang\', root))` from `@tiaforge-ui/sinter/messages/content`');
        locales = {
          base: declared.base, list: [...declared.list],
          ...(declared.fallbacks ? { fallbacks: Object.fromEntries(Object.entries(declared.fallbacks).map(([k, v]) => [k, [...v]])) } : {}),
          ...(declared.paths ? { paths: { ...declared.paths } } : {}),
          ...(declared.codes ? { codes: Object.fromEntries(Object.entries(declared.codes).map(([k, v]) => [k, [...v]])) } : {}),
          ...(declared.domains ? { domains: { ...declared.domains } } : {}),
        };
        lurls = locales.paths || (locales.domains && !dev) ? { ...(locales.paths ? { paths: locales.paths } : {}), ...(locales.domains && !dev ? { domains: locales.domains } : {}) } : null;
        // the build: each page once per language, as `<root>/<locale>/<page>` (resolved and loaded below)
        const b = config.build as { rollupOptions?: { input?: unknown }; rolldownOptions?: { input?: unknown } };
        sourceInput = buildInput(b);
        if (!dev) {
          const input = entries();
          if (b.rolldownOptions) b.rolldownOptions.input = input;
          if (b.rollupOptions) b.rollupOptions.input = input;
        }
      }
      // `<html data-sn-for>`: one input per entry, before the build starts (its inputs are fixed from here)
      if (!dev) {
        const b = config.build as { rollupOptions?: { input?: unknown }; rolldownOptions?: { input?: unknown } };
        sourceInput ??= buildInput(b);
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
      // the project (its components, libraries, helpers' manifest, specs, messages) is read again after any change on disk:
      // registered first, so the listeners below see the new one; a library outside the root is watched for it
      for (const ev of ['change', 'add', 'unlink'] as const) s.watcher.on(ev, () => { devProject = null; });
      for (const l of proj().libraries) if (l.dir !== root) s.watcher.add(join(l.real, relative(l.dir, l.folder)));
      // an HTML, component or helpers change triggers a full reload in v0.1
      s.watcher.on('change', (file) => {
        // the helpers module, or a file it reaches: loaded again before the next page compiles
        if (helpersNow?.files.includes(file) || file === proj().helpersFile) nodeHelpers = null;
        // a page's resources may have changed: the next-page module is described again
        if (file.endsWith('.html') || watched.has(file)) { described.clear(); entriesDescribed.clear(); axisListsKept = null; axisIndexKept = null; pagesCache = null; invalidate(PREFETCH); invalidate(SWAP); devEarly.clear(); }
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
          described.clear(); entriesDescribed.clear(); axisListsKept = null; axisIndexKept = null; pagesCache = null; invalidate(PREFETCH); devEarly.clear();
          s.ws.send({ type: 'full-reload' });
        }, (e) => s.config.logger.error(`sinter: ${(e as Error).message}`));
      });
      // a `file:` glob's list changes when a file it matches is added or removed
      for (const ev of ['add', 'unlink'] as const) s.watcher.on(ev, (file) => {
        if (!inGlob(file)) return;
        described.clear(); entriesDescribed.clear(); axisListsKept = null; axisIndexKept = null; pagesCache = null; invalidate(PREFETCH); invalidate(SWAP); devEarly.clear();
        s.ws.send({ type: 'full-reload' });
      });
    },

    /** build: the pages that have something to run early (bundled into one file each in generateBundle) */
    async buildStart() {
      unhashedPages = 0;
      gzipped.clear();
      // the pages are the client environment's (an SSR environment building beside it compiles none): its calls only
      if (isClient(this)) foldCalls.clear();
      strictFailures.clear();
      speculationHashes.clear();
      sharedHead = null;
      earlyPages.clear();
      unlisted.clear();
      earlyFiles.clear();
      pageMessages.clear();
      described.clear(); entriesDescribed.clear(); axisListsKept = null; axisIndexKept = null;
      lateParts.clear(); latePages.clear(); lateSettled.clear(); lateReady = null; auditedDescriptions.clear();
      pagesCache = null;
      buildReads.clear();
      globCache.clear();
      componentCache.clear();
      templates.clear();
      definitions.clear();
      buildUnits.clear();
      describedDefinitions.clear();
      templatesKept.clear();
      sourceKept = null;
      buildProject = null;
      configPhase = false;
      if (dev) return;
      // a fresh instance each build: under `--watch`, edits to the helpers count, and nothing a helper kept from the
      // last build (or the memo, by the instance) carries over into this one (the project read first, for both)
      nodeHelpers = null;
      const p = buildProject = project(root, options);
      await helpersReady();
      // the cross-check's worker, loading its fresh copy of the helpers while the pages compile (a build's own: none
      // carries over under --watch); without one, or if it cannot start, the check runs on this thread at buildEnd
      crossLater?.stop();
      crossLater = null;
      crossPending = null;
      if (isClient(this) && crossLateOn() && helpersNow?.module && p.helpersFile) {
        try { crossLater = crossWorker({ root, helpersFile: p.helpersFile, ...helpersConfig() }); } catch { crossLater = null; }
      }
      // the modules that declare helpers: one an early binding calls may be shared with the page bundle (shared-build.ts)
      compiled.clear(); decisions.clear(); shared.clear(); unshared.clear(); registered.clear(); specFiles.clear();
      helperFiles = new Set();
      if (firstPaint && isClient(this)) {
        const h = p.helpers, mods = [h.module, ...Object.values(h.from ?? {}).map((o) => o.module), ...Object.values(h.namespaces).flatMap((n) => [n.module, ...Object.values(n.from ?? {}).map((o) => o.module)])];
        // resolved as the build resolves them (extensions, aliases, packages), to the files the page bundle loads
        for (const m of new Set(mods)) {
          if (!m) continue;
          const r = await this.resolve(m, resolve(root, 'index.html'));
          if (!r || r.external || !isAbsolute(r.id)) continue;
          const f = realOf(r.id.replace(/[?#].*$/, ''));
          if (p.helpersFile && sameFile(f, p.helpersFile)) continue;
          specFiles.set(m, f);
          helperFiles.add(f);
        }
      }
      pagesDone = new Promise((ok) => { pagesReady = ok; });
      if (!helperFiles.size || !entries().length) pagesReady();
      appEarly = p.early;
      // a content namespace loaded per language: an entry missing in a language, through its chain, is the base's (SN522)
      if (content && locales) for (const [exp, d] of content.namespaces) {
        const lists = (l: string) => (content!.perLocale.get(l)?.get(exp)?.value ?? []) as Array<Record<string, unknown>>;
        const key = content.perLocale.get(locales.base)?.get(exp)?.key;
        if (!key) continue;
        const ids = (l: string) => new Set(lists(l).map((e) => String(e[key])));
        const base = ids(locales.base);
        for (const l of locales.list) {
          if (l === locales.base) continue;
          const order = chain(l, locales).filter((x) => x !== locales!.base), have = order.map(ids);
          const missing = [...base].filter((k) => !have.some((h) => h.has(k)));
          if (missing.length) this.warn(coded('SN522', `${missing.length} entr${missing.length === 1 ? 'y' : 'ies'} of \`${d.name}\` not in \`${l}\` (the ${locales.base} one is used): ${missing.slice(0, 10).join(', ')}${missing.length > 10 ? ', …' : ''}`));
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
      // the placeholders a server fills (data-sn-resource), next to the pages: what a middleware reads to know each page's requests
      if (embedPages.size) {
        const b = resolved?.base ?? '/', root_ = b.startsWith('/') ? b.replace(/\/?$/, '/') : '/';
        // a page on its own domain: its paths under its folder, as the server sees a request it rewrote there (`origins`)
        const under = (rel: string, paths: string[]) => { const g = groupOf(rel); return g ? paths.map((x) => (x.startsWith(`${root_}${g.folder}/`) ? x : `${root_}${g.folder}/${x.slice(root_.length)}`)) : paths; };
        const pages = [...embedPages].sort(([a], [b]) => a.localeCompare(b)).map(([rel, p]) => ({ file: p.file, paths: under(rel, p.paths), ...(p.arrays ? { arrays: p.arrays } : {}), data: p.data }));
        // the site's URLs, which sinter-axum follows as a host follows _redirects: 301s, and rewrites to a page's file
        const routes: Array<Route & { choose?: true }> = b.startsWith('/') ? siteRoutes().map((x) => (x.file && !x.choose ? { ...x, file: pageFile(x.file, b, describe(resolve(root, x.file)).path) } : x.file ? { ...x, file: chooserFile(x.file) } : x)) : [];
        // each origin's: matched under its folder, to its domain's URL (a redirect's location), from the file in its folder
        if (b.startsWith('/')) for (const folder of groups()) {
          const own = pageEntries().filter((x) => groupOf(x.rel)?.folder === folder);
          for (const r of pageRoutes(own.map((x) => ({ rel: urlRel(x.rel), patterns: x.patterns })), b)) routes.push({ ...r, from: `${root_}${folder}/${r.from.slice(root_.length)}`, ...(r.file ? { file: `${folder}/${pageFile(r.file, b, own.find((x) => urlRel(x.rel) === r.file)?.patterns ?? [])}` } : {}) });
        }
        // a request on an origin's domain whose first segment is one of its folder's (`de`, `about`, `sitemap.xml`) is that
        // folder's file; any other (the shared assets, an API) is the site's
        const origins: Record<string, { folder: string; top: string[] }> = {};
        if (b.startsWith('/')) for (const folder of groups()) {
          const v = [...virtual.values()].find((x) => pointOrigin(x.axes ?? [], x.locale, lurls)?.folder === folder)!;
          const top = new Set<string>(['sitemap.xml']);
          for (const x of pageEntries().filter((y) => groupOf(y.rel)?.folder === folder)) for (const f of [urlRel(x.rel), pageFile(urlRel(x.rel), b, x.patterns)]) top.add(f.split('/')[0]!);
          if (locales) for (const c of choosers(false)) if (c.fileName.startsWith(`${folder}/`)) top.add(c.fileName.slice(folder.length + 1).split('/')[0]!);
          origins[new URL(pointOrigin(v.axes ?? [], v.locale, lurls)!.origin).host] = { folder, top: [...top].sort() };
        }
        // a server picks the language at a fixed unprefixed URL too (`/about/`, `/`), where a host serves the chooser file
        if (locales && b.startsWith('/')) for (const s of sourceEntries()) { const u = pageUrl(relOf(s), b, describeSource(s).path); if (u) routes.push({ from: u, to: u, status: 200, file: chooserFile(relOf(s)), choose: true }); }
        this.emitFile({ type: 'asset', fileName: EMBED_FILE, source: JSON.stringify({ version: 2, pages, ...(routes.length ? { routes } : {}), ...(locales ? { locales: manifestLocales(locales, b) } : {}), ...(Object.keys(origins).length ? { origins } : {}) }, null, 2) + '\n' });
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
      const runtimeId = earlyPages.size ? (await this.resolve(EARLY_PKG, resolve(root, 'index.html')))?.id ?? null : null;
      // every early script of this build through one builder (`earlySession`)
      const session = earlyPages.size ? await earlySession(runtimeId) : null;
      const bundleEarly = (code: string, keys: Set<string>, rt: string[] | null, what: string, own: string[] = []) => earlyScript(code, keys, rt, what, runtimeId, undefined, own, session);
      fontPages.clear();
      if (earlyPages.size) {
        // the app's early module runs once, from the shared script, before any page's bindings
        const app = appEarly ? `import ${JSON.stringify(appEarly)};\n` : '';
        // a page whose bundled stylesheets have `font-display: swap` faces loads them after `load`
        // (docs/first-paint.md#fonts-after-the-load): its early file calls the runtime's `fonts`, and `deferFonts` moves the faces
        textOf.clear();
        for (const rel of earlyPages.keys()) for (const f of pageCss(bundle, rel)) {
          const a = bundle[f];
          if (a?.type === 'asset' && deferredFaces(String(a.source), preloads, await textFamiliesOf(bundle as never, f))) { fontPages.add(rel); break; }
        }
        const pages = new Map([...earlyPages].map(([rel, code]) => {
          const own = app && code.startsWith(app) ? code.slice(app.length) : code;
          return [rel, fontPages.has(rel) ? own.replace(/import \{([^}]*)\} from '@tiaforge-ui\/sinter\/runtime\/early';/, (_, n: string) => `import {${n.replace(/\s*$/, '')}, fonts } from '${EARLY_PKG}';`) + '\nfonts();\n' : own];
        }));
        // the shared script: every export a page imports, but an export of PAGE_OWN only when every page imports it
        const imported = [...pages.values()].map(runtimeNames);
        const names = [...new Set(imported.flat())].filter((n) => !PAGE_OWN.has(n) || imported.every((x) => x.includes(n))).sort();
        const sharedKeys = new Set<string>();
        sharedHead = { fileName: '', ...await bundleEarly(`${app}import { ${names.join(', ')} } from '${EARLY_PKG}';\nglobalThis[Symbol.for(${JSON.stringify(RT_KEY)})] = { ${names.join(', ')} };\n`, sharedKeys, null, 'every page') };
        // pages whose early source is the same text (on a blog, every post's) share one build: its output and the content
        // keys its modules call depend on that source and the runtime names alone (a nested `vite build` is ~15 ms)
        const built = new Map<string, { out: Awaited<ReturnType<typeof bundleEarly>>; keys: Set<string> }>();
        const jobs = new Map<string, { src: string; take: string[]; own: string[]; rel: string }>();
        const ids = new Map<string, string>();
        for (const [rel, code] of pages) {
          // the shared modules this early file imports and the page's bundle reaches: their namespaces on the global
          const reach = shared.size ? pageModules(bundle, rel) : new Set<string>();
          const regs = [...earlyImports(code).keys()].map((spec) => ({ spec, file: specFile(spec) })).filter((x): x is { spec: string; file: string } => !!x.file && shared.has(x.file) && reach.has(x.file));
          if (regs.length) registered.set(rel, new Set(regs.map((x) => x.file)));
          const rt = runtimeNames(code), src = registration(regs) + code, take = rt.filter((n) => names.includes(n)), own = rt.filter((n) => !names.includes(n));
          const id = JSON.stringify([src, take, own]);
          ids.set(rel, id);
          if (!jobs.has(id)) jobs.set(id, { src, take, own, rel });
        }
        const one = async (j: { src: string; take: string[]; own: string[] }, what: string) => {
          const keys = new Set(sharedKeys);
          return { ...await bundleEarly(j.src, keys, j.take, what, j.own), keys };
        };
        if (shapesOn()) {
          // sources that differ only in literals share one build, a free identifier in each literal's place (early-opaque.ts)
          const js = [...jobs];
          const outs = await shareOpaque(js.map(([, j]) => ({ src: j.src, extra: JSON.stringify([j.take, j.own]), what: j.rel })), (src, i, what) => one({ ...js[i]![1], src }, what), (x) => gzipSync(x).length, Object.keys(r.define ?? {}));
          js.forEach(([id], i) => { const { keys, ...o } = outs[i]!; built.set(id, { out: { ...o, map: null }, keys }); });
        } else for (const [id, j] of jobs) { const { keys, ...o } = await one(j, j.rel); built.set(id, { out: o, keys }); }
        for (const rel of pages.keys()) {
          const b = built.get(ids.get(rel)!)!;
          earlyKeys.set(rel, new Set(b.keys));
          // (each page its own record: the shared modules' keys are filled into it below)
          earlyFiles.set(rel, { ...b.out });
        }
      }
      // each shared module's key, from its own copy's chunk: in the stubs and in the early files that register it
      if (shared.size) {
        const chunks = Object.values(bundle).filter((c): c is Extract<typeof c, { type: 'chunk' }> => c.type === 'chunk');
        const keys = new Map<string, string>();
        for (const f of shared.keys()) {
          const own = chunks.find((c) => c.facadeModuleId === f + OWN) ?? chunks.find((c) => c.moduleIds.includes(f + OWN));
          keys.set(sharedMark(f), sharedKey(own?.fileName ?? f));
        }
        const fill = (code: string) => code.replace(SHARED_MARKS, (m) => keys.get(m) ?? m);
        for (const c of chunks) if (c.code.includes('__SN_SHARED__')) c.code = fill(c.code);
        for (const f of earlyFiles.values()) f.code = fill(f.code);
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
        const common = sharedHead?.code ?? '';
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
      // a content namespace app code imports: the entries a page's modules call (its bundle's and its early file's), in
      // its language, written into the page
      if (moduleNs.size || earlyKeys.size) for (const rel of new Set([...earlyFiles.keys(), ...runtimeOf.keys()])) {
        if (runtimeOf.get(rel)?.length === 0) continue;
        const entry = entryChunk(bundle, rel) as Extract<(typeof bundle)[string], { type: 'chunk' }> | undefined;
        const want = new Map<string, Set<string>>(), seen = new Set<string>(), todo = entry ? [entry.fileName] : [];
        const add = (ns: string, k: string) => { if (!want.has(ns)) want.set(ns, new Set()); want.get(ns)!.add(k); };
        for (const x of earlyKeys.get(rel) ?? []) { const [ns, k] = x.split('\0') as [string, string]; add(ns, k); }
        while (todo.length) {
          const c = bundle[todo.pop()!];
          if (!c || c.type !== 'chunk' || seen.has(c.fileName)) continue;
          seen.add(c.fileName);
          for (const id of c.moduleIds) for (const [ns, keys] of moduleNs.get(id) ?? []) for (const k of keys) add(ns, k);
          todo.push(...c.imports, ...c.dynamicImports);
        }
        if (!want.size) continue;
        const at = pageNs.get(rel) ?? contentNsAt(pageLang(resolve(root, rel)));
        const lang = pageLang(resolve(root, rel));
        const tags = [...want].map(([ns, keys]) => `<script type="application/json" data-sn-ns="${attr(ns)}"${lang ? ` lang="${attr(lang)}"` : ''}>${JSON.stringify(packed(at[ns]?.format ?? '', Object.fromEntries([...keys].sort().map((k) => [k, at[ns]?.entries[k] ?? null])))).replace(/</g, '\\u003c')}</script>`);
        pageMessages.set(rel, tags.join(''));
      }
      heads();
    },

    transform(code, id) {
      // the app's own modules: a renamed export of the main entry fails naming the new one
      if (!id.includes('/node_modules/') && !sinterFile(id) && /\.[cm]?[jt]sx?(\?|$)/.test(id)) { const gone = retiredExport(code); if (gone) this.error(`${relative(root, id.replace(/[?#].*$/, ''))}: ${gone}`); }
      // (an app module that calls a message that is not plain text gets the formatter: `withFormatter`)
      const f = collect(this, code, id);
      return lazyTransform(this, f?.code ?? code, id) ?? f ?? null;
    },

    resolveId(id, importer) {
      // a component's top-level `<script>`: its module, `task-ring.html.script.ts`, beside its file (load gives its code)
      const inline = inlineScriptId(id, importer);
      if (inline) return inline;
      // a page in a language: no file of its own (load gives its source's HTML)
      if ((locales || pageInputs || virtual.size) && id.endsWith('.html')) { const abs = resolve(root, id.replace(/^\//, '')); if (virtual.has(id) || virtual.has(abs)) return virtual.has(id) ? id : abs; }
      // a component's script imports its generated base from its own HTML file
      if (importer && id.endsWith('.html') && !importer.endsWith('.html')) {
        const file = resolve(dirname(importer.replace(/[?#].*$/, '')), id);
        // (`src/components/<name>.html` or `src/components/<name>/<name>.html`, the app's or a library's)
        const name = componentOfHtml(root, file, options.libraries?.length ? proj().libraries : []);
        if (name) return `\0${COMPONENT_BASE}${name}.js`;
      }
      // a build with source maps: page modules keep a plain id, as Rolldown drops the map of a `\0` module
      if (id.startsWith(PREFIX) && !dev && maps.has(id)) return id;
      if (id.startsWith(PREFIX)) return '\0' + id;
      return null;
    },

    async load(id) {
      if (virtual.has(id)) return readPage(id);
      {
        const s = inlineScriptSource(id);
        if (s) { this.addWatchFile(s.html); return { code: s.code, map: s.map }; }
      }
      // the site's core (docs/proposals/site-core.md), once every page has said what it uses
      if (!dev && id === FLAGS) {
        coreCheck();
        await everyPage(coreWait().promise, coreDone, 'the core');
        resolved?.logger.info(`sinter: the site's core keeps ${[...coreUsed].sort().join(', ') || 'nothing optional'}`);
        // a helper module an early file may share (shared-build.ts): the swap's code for its own copy stays
        await everyPage(pagesDone, compiled, 'the core');
        const share = topLevelAwait(resolved?.build.target) && [...earlyPages.values()].some((code) => [...earlyImports(code).keys()].some((spec) => { const f = specFile(spec); return !!f && helperFiles.has(f); }));
        // an API with a token: the core's calls into the token module (src/token.ts)
        return flagsModule(coreUsed, share, !!options.swap, !!proj().apis?.list.some((a) => a.token));
      }
      // a helper module the early files share: the stub, which takes their instance (shared-build.ts)
      if (!dev && helperFiles.size && !id.startsWith('\0') && !/[?#]/.test(id) && isAbsolute(id)) {
        const f = realOf(id);
        if (helperFiles.has(f) && await decideShared(this, f)) return sharedStub(f, shared.get(f)!);
      }
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
        if (!r) for (const l of options.libraries?.length ? proj().libraries : []) {
          r = await this.resolve(lz.spec, join(l.folder, 'index.js'));
          if (r) { spec = r.id; break; }
        }
        if (dev) return loaderModule(spec, null);
        if (r) lazyIds.set(lz.spec, r.id);
        return loaderModule(spec, r?.id ?? null);
      }
      if (id === `\0${PREFIX}img-check.js`) return IMAGE_CHECK;
      if (id === `\0${PREFIX}warn-relay.js`) return WARN_RELAY;
      // (pages described off their heads: their compiles' parts, once every page has compiled)
      if (!dev && (id === `\0${PREFETCH}` || /^\0\/@sinter\/prefetch-[\w-]+\.js$/.test(id)) && lateParts.size) await everyPage(lateWait().promise, lateSettled, 'the next-page data');
      if (id === `\0${PREFETCH}`) return prefetchModule(prefetchPages(), proj().helpers);
      if (id === `\0${SWAP}`) return swapModule(swapPages());
      // an origin's own (`prefetch-acme.js`, `swap-acme.js`)
      const og = id.startsWith(`\0${PREFIX}`) ? /^(prefetch|swap)-([\w-]+)\.js$/.exec(id.slice(1 + PREFIX.length)) : null;
      if (og && groups().has(og[2]!)) return og[1] === 'prefetch' ? prefetchModule(prefetchPages(og[2]), proj().helpers) : swapModule(swapPages(og[2]));
      const key = id.startsWith('\0' + PREFIX) ? id.slice(1) : !dev && maps.has(id) ? id : null;
      if (key === null) return null;
      // a page module compiled before every page had: its prefetch import as every page decides it (`latePages`)
      const lp = latePages.get(key);
      if (lp) {
        await everyPage(lateWait().promise, lateSettled, 'the next-page data');
        const want = prefetchPages(lp.group).length ? prefetchId(lp.group) : null;
        if (latePages.get(key) === lp) {
          latePages.delete(key);
          if (want !== lp.prefetch) {
            const again = moduleWith(lp.out, want);
            if (!again) throw new Error(`sinter: page module ${key} cannot be written again`);
            setModule(key, again.module, again.map);
            LATE_STATS.rewritten++;
          }
        }
      }
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
      // `prerender: 'auto'`: which pages links prerender, and why each other one is only prefetched
      if (spec()?.mode == 'auto') {
        const pages = appPages().filter((x) => !x.swaps), app = appEffect(), quiet = pages.filter((x) => !x.effect && !app);
        const why = pages.filter((x) => !quiet.includes(x)).map((x) => `${relOf(x.file)} (${x.effect})`);
        if (app) resolved?.logger.info(`sinter: links prerender no page, since every page runs the app's modules and one of them does something as it loads: ${app} (prerender: 'auto', docs/navigation.md)`);
        else if (pages.length) resolved?.logger.info(`sinter: links prerender ${quiet.length ? quiet.map((x) => relOf(x.file)).join(', ') : 'no page'}${why.length ? `; they prefetch ${why.slice(0, 10).join(', ')}${why.length > 10 ? `, and ${why.length - 10} more` : ''}` : ''} (prerender: 'auto', docs/navigation.md)`);
      }
    },

    async buildEnd(error) {
      // a `static` pattern that matches no page: a renamed page would drop out of the check unnoticed
      const missing = !error && !dev && Array.isArray(options.static) ? staticPages(root, options.static).unmatched([...seen].map((f) => virtual.get(f)?.source ?? f)) : [];
      if (missing.length) this.error(`sinter({ static }): no page matches ${missing.map((m) => `\`${m}\``).join(', ')} (paths relative to the root, such as \`about.html\` or \`docs/**\`)`);
      // the helper calls that folded, again in a fresh copy of the helpers module, the pages in reverse order
      if (!error && !dev && foldCalls.size && isClient(this)) {
        const pages = [...foldCalls];
        foldCalls.clear();
        // with the worker (`SN_CROSS_LATE`): it runs them while Vite writes the pages, and the build waits for it after
        // Vite's HTML step (`crossLate`, the last plugin); else here, on this thread, as before
        const log = process.env.SN_CROSS_LOG === '1' ? (m: string) => console.error(`sinter cross: ${m}`) : () => {};
        if (crossLater) {
          const w = crossLater;
          crossLater = null;
          crossPending = w.run(pages).then((a) => { log('worker'); return a; }, (e) => { log(`here (the worker failed: ${(e as Error)?.message ?? e})`); return crossHere(pages); });
        } else { log('here'); crossReport(this, await crossHere(pages)); }
      }
      crossLater?.stop();
      crossLater = null;
      if (error || !typecheckOn() || dev || !units.size) return;
      const { check } = await import('./check/index.js');
      const p = proj();
      const r = check({ ...checkOptionsOf(p), helpers: helpersOf(p.helpers), units: [...units.values()], share: true });
      buildUnits.clear();
      // type errors fail the build, its line counting them and the warnings apart (as `sinter check`'s); warnings alone
      // (SN538) are printed as the pages' are, and strict mode makes them errors
      const ds = strictly(r.diagnostics), errors = ds.filter((d) => d.severity === 'error').length;
      if (errors) this.error(`sinter check: ${errors} type error(s), ${ds.length - errors} warning(s)\n${ds.map(formatDiagnostic).join('\n')}`);
      for (const d of ds) console.warn(formatDiagnostic(d));
    },

    transformIndexHtml: {
      order: 'pre',
      // builds: every page compiled (or failed) counts toward deciding the shared modules
      async handler(html, ctx) {
        try { return await compileHtml(); } finally { if (!dev) { pageDone(ctx.filename); lateSettle(ctx.filename); } }
        async function compileHtml() {
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
        // dev: the app's modules may call any entry of a content namespace they import, in the page's language
        const at = dev && content?.namespaces.size ? (out.contentNs ?? contentNsAt(pageLang(file))) : null;
        const tags = at ? Object.entries(at).filter(([, d]) => d.module).map(([ns, d]) => `<script type="application/json" data-sn-ns="${attr(ns)}">${JSON.stringify(packed(d.format ?? '', d.entries)).replace(/</g, '\\u003c')}</script>`).join('') : '';
        return tags ? page.replace(/<head[^>]*>/, (h) => h + tags) : page;
        }
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
      if (!images || !STYLE_ID.test(id) || /[?&](inline|url|raw)\b/.test(id) || id.includes('/node_modules/') || sinterFile(id)) return null;
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
        ...(options.images && options.images.widths ? { widths: options.images.widths } : {}),
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
      // (before the url()s below: the copies are stylesheets of the bundle too)
      await deferFonts(this, bundle as never);
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
          ...(options.images && options.images.widths ? { widths: options.images.widths } : {}),
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
        const rel = relOf(ctx.filename), early = earlyFiles.get(rel), own = headFiles.get(rel);
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
        // shared helper modules the page's bundle reaches: their own copies, for a swap or fetched with the page
        if (shared.size && ctx.bundle) html = withShared(html, rel, ctx.bundle, base);
        const inline = pageMessages.get(rel);
        if (!early && !own && !inline) return html;
        // a page in one language: the messages its app modules call, before any script that reads them
        const tags: string[] = inline ? [inline] : [];
        // the shared head script, then the page's: classic scripts, run in order
        if (early && sharedHead) tags.push(`<script src="${attr(base + sharedHead.fileName)}"></script>`);
        if (own) tags.push(`<script src="${attr(base + own)}"></script>`);
        if (early) report(rel, { fileName: own!, ...early }, null, ctx.bundle ? () => pageModules(ctx.bundle!, rel) : null);
        // first in the head, before the stylesheets (a classic script waits for the stylesheets before it) and the page
        // module (which the hold script changes as the parser inserts it): the early requests leave at once
        const at = html.search(/<link\b[^>]*\brel=["']?(stylesheet|modulepreload)|<script\b/i);
        const block = tags.join('\n  ');
        return at >= 0 ? html.slice(0, at) + block + '\n  ' + html.slice(at) : html.replace('</head>', `  ${block}\n</head>`);
      },
    },
  };

  /**
   * builds, before Vite writes the pages: the CSS files a page links, as Vite's HTML step finds them (the
   * stylesheets its entry chunk and their static imports import; a CSS-only chunk is still in the bundle here)
   */
  function pageCss(bundle: Record<string, unknown>, rel: string): string[] {
    type C = { type: string; fileName: string; isEntry?: boolean; facadeModuleId?: string | null; imports?: string[]; viteMetadata?: { importedCss: Set<string> } };
    const entry = entryChunk(bundle, rel) as C | undefined;
    const out = new Set<string>(), seen = new Set<string>(), todo = entry ? [entry.fileName] : [];
    while (todo.length) {
      const f = todo.pop()!;
      if (seen.has(f)) continue;
      seen.add(f);
      const c = bundle[f] as C | undefined;
      if (c?.type !== 'chunk') continue;
      for (const css of c.viteMetadata?.importedCss ?? []) out.add(css);
      todo.push(...(c.imports ?? []));
    }
    return [...out];
  }

  /**
   * builds: a font file a bundled stylesheet names, as its bytes: a file of the bundle (Vite writes the URL from the
   * base, or relative to the stylesheet under a relative base), a `data:` URI, a remote file (Google Fonts'; cached),
   * or a file of the project or its public folder. Null when it cannot be had.
   */
  async function bundleFont(bundle: Record<string, { type: string; source?: string | Uint8Array }>, sheet: string, url: string): Promise<Uint8Array | null> {
    const r = resolved!;
    if (!/^(data:|https?:\/\/)/i.test(url)) {
      const path = decodeURI(url.replace(/[?#].*$/, ''));
      const base = r.base.startsWith('/') ? r.base : '';
      const name = base && path.startsWith(base) ? path.slice(base.length) : path.startsWith('/') ? path.slice(1) : posix.join(posix.dirname(sheet), path);
      const a = bundle[name];
      if (a?.type === 'asset' && a.source !== undefined) return typeof a.source == 'string' ? new Uint8Array(Buffer.from(a.source)) : a.source;
    }
    return readFont(url, resolve(r.build.outDir, sheet)).catch(() => null);
  }
  /** builds: the text families of a bundled stylesheet's faces without `font-display`, from their files (`textOf`) */
  function textFamiliesOf(bundle: Record<string, { type: string; source?: string | Uint8Array }>, sheet: string): Promise<Set<string>> {
    let p = textOf.get(sheet);
    if (!p) {
      const a = bundle[sheet], css = typeof a?.source == 'string' ? a.source : Buffer.from(a?.source ?? '').toString('utf8');
      textOf.set(sheet, (p = textFamilies(css, async (url) => { const b = await bundleFont(bundle, sheet, url); return b && isTextFont(b); })));
    }
    return p;
  }

  /**
   * Builds: web fonts after the window's `load` (docs/first-paint.md#fonts-after-the-load), once Vite has written each
   * page's stylesheet links. On a page of `fontPages` (its early file calls the runtime's `fonts`), the faces to defer
   * (`deferredFaces`: `swap` faces and text fonts' faces without `font-display`, not those `fonts.preload` names) leave
   * each bundled stylesheet it links and go, from all of them in order, into a stylesheet of their own: one file per
   * distinct set (`fonts-<hash>.css` beside the CSS assets), linked in `<noscript data-sn-fonts>` at the start of the
   * head, which the early file reads. Each stylesheet that lost faces gets their fitted
   * fallback faces (`fallbackFaces`), and every stylesheet of the page names the fitted families after their web
   * fonts (`withFallbackFamilies`): a stylesheet that changed is replaced, on that page, with a copy. A page without
   * an early file that links one of those stylesheets gets the same copies, and the faces' file as a plain
   * stylesheet link before the first of them (render-blocking, as the faces were), so every page shares one
   * stylesheet; its fonts load as they always did, with the fitted fallbacks while they swap. The original is
   * removed when no page links it, unless a manifest names it.
   */
  async function deferFonts(ctx: { emitFile(f: { type: 'asset'; fileName: string; source: string }): string }, bundle: Record<string, { type: string; fileName: string; source?: string | Uint8Array; code?: string }>) {
    if (!fontPages.size) return;
    const r = resolved!, dir = r.build.assetsDir;
    const text = (s: string | Uint8Array | undefined) => (typeof s == 'string' ? s : Buffer.from(s ?? '').toString('utf8'));
    const hash = (x: string) => createHash('sha256').update(x).digest('base64url').slice(0, 8);
    /** each bundled stylesheet: without its deferred faces and with their fitted fallback faces, or null with nothing deferred */
    const splits = new Map<string, { css: string; faces: string[]; families: string[] } | null>();
    /** the stylesheets a copy replaced on some page */
    const copied = new Set<string>();
    const emitted = new Set<string>();
    const emit = (fileName: string, source: string) => { if (!emitted.has(fileName) && !bundle[fileName]) ctx.emitFile({ type: 'asset', fileName, source }); emitted.add(fileName); };
    // a family no font list of the build's stylesheets names needs no fitted fallback (a Google Fonts URL asks for more than the CSS uses)
    const allCss = Object.values(bundle).filter((o) => o.type === 'asset' && o.fileName.endsWith('.css')).map((o) => text(o.source)).join('\n');
    const listed = (family: string) => withFallbackFamilies(allCss, [family]) != allCss;
    // the pages with an early file first (they decide which stylesheets lose faces), then the other pages that link one
    const others = Object.values(bundle).filter((o) => o.type === 'asset' && /\.html?$/i.test(o.fileName) && !fontPages.has(o.fileName)).map((o) => o.fileName);
    for (const rel of [...fontPages, ...others]) {
      const page = bundle[rel], early = fontPages.has(rel);
      if (page?.type !== 'asset') continue;
      let html = text(page.source);
      const base = pageBase(r.base, rel), faces: string[] = [], sheets: Array<{ tag: string; href: string; name: string }> = [];
      let last = '', first = '', cors = false;
      for (const m of html.matchAll(/<link\b[^>]*>/gi)) {
        const tag = m[0];
        if (!/\brel=["']?stylesheet\b/i.test(tag)) continue;
        const href = /\bhref=["']([^"']+)["']/i.exec(tag)?.[1] ?? '';
        const name = href.startsWith(base) ? href.slice(base.length) : '', a = name ? bundle[name] : undefined;
        if (a?.type !== 'asset' || !name.endsWith('.css')) continue;
        // (a page without an early file only follows what the early pages decided)
        if (!early && !splits.has(name)) continue;
        if (!splits.has(name)) {
          const split = deferredFaces(text(a.source), preloads, await textFamiliesOf(bundle, name));
          // a system font fitted to each deferred face of a text font, for the text painted before it (fallbackFaces)
          const fb = split && await fallbackFaces(split.faces, split.css, listed, async (url) => { const b = await bundleFont(bundle, name, url); return b && isTextFont(b) ? fitMetrics(b) : null; });
          splits.set(name, split && fb ? { css: split.css + fb.css, faces: split.faces.map((f) => rebaseFace(f, posix.dirname(name), dir)), families: fb.families } : null);
        }
        sheets.push({ tag, href, name });
      }
      if (!early && !sheets.some((x) => splits.get(x.name))) continue;
      // the fitted families go after their web fonts in the font lists of every stylesheet of the page
      const families = [...new Set(sheets.flatMap((x) => splits.get(x.name)?.families ?? []))];
      for (const { tag, href, name } of sheets) {
        const c = splits.get(name), was = text(bundle[name]!.source), css = withFallbackFamilies(c?.css ?? was, families);
        if (c) { faces.push(...c.faces); cors ||= /\scrossorigin\b/i.test(tag); }
        if (css == was) { if (c) { last = tag; first ||= tag; } continue; }
        // Vite's name less its hash (`index-B3xk2_9a.css`), then the copy's own
        const fileName = `${name.slice(0, -4).replace(/-[\w-]{8}$/, '')}-${hash(css)}.css`;
        emit(fileName, css);
        copied.add(name);
        const now = tag.replace(href, base + fileName);
        html = html.replace(tag, now);
        if (c) { last = now; first ||= now; }
      }
      if (!faces.length) continue;
      const source = faces.join('\n') + '\n', fileName = `${dir}/fonts-${hash(source)}.css`;
      emit(fileName, source);
      if (!early) {
        // no early file to load them after `load`: a stylesheet, before the first that lost them (render-blocking, as they were)
        const link = `<link rel="stylesheet"${cors ? ' crossorigin' : ''} href="${base}${fileName}">`;
        page.source = html.replace(first, link + first);
        continue;
      }
      // inert for a visitor with scripts, a stylesheet without (render-blocking, as the faces were); at the start of the
      // head, where the early file, which runs before the stylesheets are parsed, finds it: its attributes repeat the link's
      const at = /<meta\s+charset[^>]*>/i.exec(html) ?? /<head[^>]*>/i.exec(html);
      const tag = `<noscript data-sn-fonts="${base}${fileName}"${cors ? ' crossorigin' : ''}><link rel="stylesheet"${cors ? ' crossorigin' : ''} href="${base}${fileName}"></noscript>`;
      html = at ? html.slice(0, at.index + at[0].length) + tag + html.slice(at.index + at[0].length) : html.replace(last, last + tag);
      page.source = html;
    }
    // a stylesheet no page links any more: only its copies are served (Vite's manifest, which names the CSS files
    // each entry imports, keeps it)
    if (r.build.manifest || r.build.ssrManifest) return;
    for (const name of copied) {
      const file = posix.basename(name);
      if (!Object.values(bundle).some((o) => o.fileName !== name && (o.type === 'chunk' ? (o.code ?? '').includes(file) : /\.(html?|css|js|json|xml)$/i.test(o.fileName) && text(o.source).includes(file)))) delete bundle[name];
    }
  }

  /**
   * builds: a page's entry chunk (the first entry whose facade is the page), through an index of the bundle's entries
   * made once per bundle: each page looked for it in every chunk, resolving its path once per chunk (at 400 pages,
   * ~140 ms of generateBundle). A hit is checked to still be in the bundle; a miss looks the slow way.
   */
  function entryChunk(bundle: Record<string, unknown>, rel: string): unknown {
    type C = { type: string; fileName: string; isEntry?: boolean; facadeModuleId?: string | null };
    let idx = entryIndex.get(bundle);
    if (!idx) {
      idx = new Map();
      for (const c of Object.values(bundle) as C[]) if (c.type === 'chunk' && c.isEntry && c.facadeModuleId && !idx.has(c.facadeModuleId)) idx.set(c.facadeModuleId, c);
      entryIndex.set(bundle, idx);
    }
    const id = resolve(root, rel), hit = idx.get(id) as C | undefined;
    if (hit && bundle[hit.fileName] === hit) return hit;
    return (Object.values(bundle) as C[]).find((c) => c.type === 'chunk' && c.isEntry && c.facadeModuleId === id);
  }

  /** builds: the real paths of the modules a page's bundle loads with it (its entry chunk and their static imports) */
  function pageModules(bundle: Record<string, unknown>, rel: string): Set<string> {
    const chunks = Object.values(bundle) as Array<{ type: string; fileName: string; isEntry?: boolean; facadeModuleId?: string | null; imports?: string[]; moduleIds?: string[] }>;
    const entry = entryChunk(bundle, rel) as (typeof chunks)[number] | undefined;
    const out = new Set<string>(), seen = new Set<string>(), todo = entry ? [entry.fileName] : [];
    while (todo.length) {
      const f = todo.pop()!;
      if (seen.has(f)) continue;
      seen.add(f);
      const c = bundle[f] as (typeof chunks)[number] | undefined;
      if (c?.type !== 'chunk') continue;
      for (const id of c.moduleIds ?? []) if (!id.startsWith('\0') && isAbsolute(id)) out.add(realOf(id));
      todo.push(...(c.imports ?? []));
    }
    return out;
  }

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
    // each module's info read once: the pages reach mostly the same modules (the runtime's), and a read crosses into the bundler
    const infos = new Map<string, ReturnType<typeof ctx.getModuleInfo>>();
    const infoOf = (id: string) => { let m = infos.get(id); if (m === undefined && !infos.has(id)) infos.set(id, (m = ctx.getModuleInfo(id))); return m ?? null; };
    const errors: string[] = [];
    for (const page of pages) {
      const prev = new Map<string, string | null>([[page, null]]), todo = [page];
      while (todo.length) {
        const id = todo.shift()!;
        for (const next of infoOf(id)?.importedIds ?? []) if (!prev.has(next)) { prev.set(next, id); todo.push(next); }
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
        if (id.startsWith('\0') || id.includes('/node_modules/') || sinterFile(id)) continue;
        const by = infoOf(id)?.dynamicImporters.find((d) => prev.has(d));
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
    // a package and the subpaths imported from it (`@tiaforge-ui/sinter-markdown` is `…/parser`), as `lazy` names them
    const ids = specs.flatMap((spec) => {
      const hits = [...lazyIds].filter(([s]) => s === spec || s.startsWith(spec + '/')).map(([, id]) => ({ spec, id: id as string | undefined }));
      return hits.length ? hits : [{ spec, id: undefined as string | undefined }];
    });
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
   * Builds, shared helper modules (shared-build.ts) the page's bundle reaches: where its early file has the module, the
   * own copy is named for a swap (`<link data-sn-shared>`, inert: a swap runs no head script, so it imports the copy
   * beside the page module); where it does not, the copy and the chunks it imports are fetched with the page
   * (modulepreload), as the module would have been.
   */
  function withShared(html: string, rel: string, bundle: Record<string, unknown>, base: string): string {
    type C = { type: string; fileName: string; facadeModuleId?: string | null; imports?: string[]; moduleIds?: string[] };
    const chunks = Object.values(bundle).filter((c): c is C => (c as C).type === 'chunk') as C[];
    const reach = pageModules(bundle, rel), own = registered.get(rel), tags: string[] = [];
    for (const f of shared.keys()) {
      if (!reach.has(f)) continue;
      const c = chunks.find((x) => x.facadeModuleId === f + OWN) ?? chunks.find((x) => x.moduleIds?.includes(f + OWN));
      if (!c) continue;
      if (own?.has(f)) { tags.push(`<link data-sn-shared href="${attr(base + c.fileName)}">`); continue; }
      for (const todo = [c.fileName], seen = new Set<string>(); todo.length;) {
        const n = todo.shift()!;
        if (seen.has(n)) continue;
        seen.add(n);
        if (!html.includes(`"${base}${n}"`) && !tags.some((t) => t.includes(`"${base}${n}"`))) tags.push(`<link rel="modulepreload" crossorigin href="${attr(base + n)}">`);
        todo.push(...((bundle[n] as C | undefined)?.imports ?? []));
      }
    }
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
    // (nothing to measure for a line nobody sees)
    if (!reasons || !infoShown()) return;
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
      shared += gzipSize(c.code);
      todo.push(...(c.imports ?? []));
    }
    const size = chunk ? `${kb(gzipSize(chunk.code))} gzip${shared ? ` + ${kb(shared)} gzip shared` : ''}` : 'runtime';
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
        gz += gzipSize(c.code);
        todo.push(...(c.imports ?? []));
      }
      out.push(`${label} ${(gz / 1000).toFixed(1)} kB gzip`);
    }
    return out.length ? `; lazy: ${out.join(', ')}` : '';
  }

  /**
   * The modules of 4 kB or more (before gzip) that a page downloads twice, in its early file and in its page bundle
   * (docs/first-paint.md#own-copies), and why the helper modules its early file imports were not shared.
   */
  function twice(rel: string, modules: Record<string, { renderedLength: number }>, reach: Set<string>): string {
    // a module the early file shares is a stub in the page bundle, under the module's own id
    const own = registered.get(rel);
    const big = Object.entries(modules).filter(([id, m]) => { const f = realOf(id.replace(/[?#].*$/, '')); return m.renderedLength >= 4000 && !id.startsWith('\0') && isAbsolute(id) && reach.has(f) && !own?.has(f); })
      .sort((a, b) => b[1].renderedLength - a[1].renderedLength);
    if (!big.length) return '';
    const why = [...earlyImports(earlyPages.get(rel) ?? '').keys()].map(specFile).filter((f): f is string => !!f && unshared.has(f) && reach.has(f))
      .map((f) => `${relOf(f)} is not shared: ${unshared.get(f)}`);
    return `; in the page bundle too: ${big.map(([id, m]) => `${relOf(realOf(id.replace(/[?#].*$/, '')))} ${(m.renderedLength / 1000).toFixed(1)} kB`).join(', ')}${why.length ? ` (${why.join('; ')})` : ''}`;
  }

  /** One line per page: the early file's size (gzip) and its language files'; over the budget a warning naming the largest modules. */
  function report(rel: string, early: { fileName: string; code: string; modules: Record<string, { renderedLength: number }> } | null, langs: Record<string, { code: string }> | null, reach: (() => Set<string>) | null = null) {
    const kb = (n: number) => `${(n / 1000).toFixed(1)} kB`;
    // the shared head script is on the first paint's path too: it counts toward the budget
    const own = early ? gzipSize(early.code) : 0, common = early && sharedHead ? gzipSize(sharedHead.code) : 0, gz = own + common;
    const logger = resolved?.logger;
    // under the budget: an info line, written only when it is printed
    if ((!early || gz <= budget) && !infoShown()) return;
    const files = langs ? `, messages ${Object.entries(langs).map(([l, f]) => `${l} ${kb(gzipSize(f.code))}`).join(', ')} gzip` : '';
    const line = `sinter: early script of ${rel}: ${early ? `${early.fileName} ${kb(own)} gzip${common ? ` + ${sharedHead!.fileName} ${kb(common)} gzip (shared)` : ''}` : 'none'}${files}${early && reach ? twice(rel, early.modules, reach()) : ''}`;
    if (!early || gz <= budget) { logger?.info(line); return; }
    const top = Object.entries({ ...sharedHead?.modules, ...early.modules }).sort((a, b) => b[1].renderedLength - a[1].renderedLength).slice(0, 5)
      .map(([id, m]) => `${id.includes(PREFIX) ? `the early bindings of ${rel}` : relative(root, id.replace(/^\0/, '')).split(sep).join('/')} ${kb(m.renderedLength)}`);
    const msg = `${line}, over the first-paint budget of ${kb(budget)}. It renders before the first paint: keep heavy imports out of src/sinter.early.ts and of the helpers early bindings call. Largest (before gzip): ${top.join(', ')}`;
    const warning = coded('SN523', msg.replace(/^sinter: /, ''));
    if (logger) logger.warn(warning); else console.warn(warning);
  }

  // Google Fonts as the app's own CSS (`fonts`, on by default; see fonts-build.ts), and the faces to preload
  const fontSheets = new Map<string, string>();
  let downloadFont: ((url: string) => Promise<string | null>) | null = null;
  const download = () => (downloadFont ??= fontDownloader(resolve(root, 'node_modules/.cache/sinter/fonts')));
  const preloads: FontFaceRef[] = ((options.fonts || undefined)?.preload ?? []).map(faceOf);
  /** build: the faces each page preloads, by its path relative to the root (the HTML file's name in the bundle) */
  const pagePreloads = new Map<string, FontFaceRef[]>();
  const fonts: Plugin = {
    name: 'sinter:fonts',
    enforce: 'pre',
    transformIndexHtml: {
      order: 'pre',
      async handler(html, ctx) {
        const dev = !!ctx.server;
        // first the preloads: they read the Google Fonts links, which the bundling below rewrites
        if (preloads.length) {
          const out = await preloadFonts(html, download(), preloads, dev);
          html = out.html;
          if (!dev) pagePreloads.set(relative(root, ctx.filename).split(sep).join('/'), out.preloaded);
        }
        if (dev || !fontsBundled) return html;
        const out = await bundleFonts(html, download());
        for (const [id, url] of out.ids) fontSheets.set(id, url);
        for (const url of out.failed) resolved?.logger.warn(coded('SN526', `could not download ${url}; the page keeps the link (sinter({ fonts: { bundle: false } }) turns this off)`));
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
    // the site's own pages: an origin's are served by the proxy that maps its domain to its folder
    const pages = pageRoutes(pageEntries().filter((x) => !groupOf(x.rel)), b);
    if (!locales) return pages;
    const choosers = pageRoutes(sourceEntries().map((f) => ({ rel: relOf(f), patterns: describeSource(f).path })), b).map((r) => ({ ...r, status: 200 as const, file: r.file ?? r.from.slice((b.startsWith('/') ? b.replace(/\/?$/, '/') : '/').length), choose: true as const }));
    const dynamic = (r: Route) => /[:*]/.test(r.from);
    const all = [...pages, ...choosers];
    return [...all.filter((r) => !dynamic(r)), ...all.filter(dynamic)];
  };
  /** `localePrefix`: where a source page's language chooser is written (its unprefixed URL's file), and that URL */
  const chooserFile = (rel: string, axes: AxisValue[] = []) => {
    const at = pointPrefix(null, axes, lurls);
    return at ? pageFile(`${at}/${rel}`, base(), prefixed(describeSource(resolve(root, rel)).path, at)) : pageFile(rel, base(), describeSource(resolve(root, rel)).path);
  };
  const chooserUrl = (source: string, axes: AxisValue[] = []) => {
    const at = pointPrefix(null, axes, lurls);
    return (at ? pageUrl(`${at}/${relOf(source)}`, base(), prefixed(describeSource(source).path, at)) : pageUrl(relOf(source), base(), describeSource(source).path)) ?? base();
  };
  /** a source page's language chooser (under its axes' segments): its languages' URLs, the base language's when nothing else decides */
  const chooserFor = (source: string, script: boolean, axes: AxisValue[] = []) => {
    const b = base().startsWith('/') ? base().replace(/\/?$/, '/') : '/', urls = localeUrls(source, axes, pointOrigin(axes)?.folder ?? null);
    const site = pointOrigin(axes)?.origin ?? siteOrigin;
    return chooserHtml({
      base: b, locales: locales!, urls, script,
      fallback: urls ? urls[locales!.base]! : b + locales!.base + '/',
      hreflang: site && urls ? hreflangTags(site, urls, chooserUrl(source, axes), locales!.codes) : '',
    });
  };
  /**
   * `localePrefix`: what the build writes at the unprefixed URLs, from the points: a chooser at each entry's unprefixed
   * path (to the visitor's language's translation, else the base's; only where no page is), a chooser at each other
   * source page's unprefixed file and old file URL, and at `404.html` and `200.html` a copy of the base language's
   * page, which hosts look for there
   */
  const choosers = (script: boolean): Array<{ fileName: string; source: string; ifFree?: true } | { fileName: string; copyOf: string }> => {
    const out: Array<{ fileName: string; source: string; ifFree?: true } | { fileName: string; copyOf: string }> = [];
    const b = base().startsWith('/') ? base().replace(/\/?$/, '/') : '/';
    const templates = new Set<string>(), done = new Set<string>();
    for (const v of virtual.values()) {
      if (!v.page) continue;
      templates.add(v.source);
      const k = translationKey(v.source, v.axes ?? [], v.page.key);
      if (done.has(k)) continue;
      done.add(k);
      const urls = entryUrls(v, pointOrigin(v.axes ?? [])?.folder ?? null)!, at = entryChooser(v)!;
      const fallback = urls[locales!.base] ?? Object.values(urls)[0]!;
      const full = Object.fromEntries(locales!.list.map((l) => [l, urls[l] ?? fallback]));
      const og = pointOrigin(v.axes ?? []), site = og?.origin ?? siteOrigin;
      const fileName = (og ? `${og.folder}/` : '') + decodeURIComponent(at.startsWith(b) ? at.slice(b.length) : at.replace(/^\//, '')) + '.html';
      out.push({ fileName, source: chooserHtml({ base: b, locales: locales!, urls: full, script, fallback, hreflang: site ? hreflangTags(site, urls, at, locales!.codes) : '' }), ifFree: true });
    }
    // each other source page, at each variant of its axes (the base language's points list them)
    const variants = new Map<string, AxisValue[][]>();
    for (const v of virtual.values()) if (v.axes?.length && !v.page && v.locale === locales!.base) {
      if (!variants.has(v.source)) variants.set(v.source, []);
      variants.get(v.source)!.push(v.axes);
    }
    for (const src of sourceEntries()) {
      if (templates.has(src)) continue;
      const rel = relOf(src);
      for (const axes of variants.get(src) ?? [[]]) {
        // under the point's folder without its language: an origin's folder first (`acme/about/index.html`, its `/about/`)
        const og = pointOrigin(axes), under = (f: string) => (og ? `${og.folder}/${f}` : f);
        const at = pointPrefix(null, axes, lurls), file = under(chooserFile(rel, axes)), own = under(at ? `${at}/${rel}` : rel);
        if (/(^|\/)(404|200)\.html?$/.test(rel)) { out.push({ fileName: own, copyOf: `${pointFolder(locales!.base, axes, lurls)}/${rel}` }); continue; }
        out.push({ fileName: file, source: chooserFor(src, script, axes) });
        if (file !== own) out.push({ fileName: own, source: chooserFor(src, script, axes) });
      }
    }
    return out;
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
    // a page in a language, or at an axis's value (`/acme/about/`): its point
    if (locales || entries().some((f) => virtual.get(f)?.axes)) return devLocales(path, q, req, res, next);
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
    const at = pointAt(path);
    if (!at) return next();
    if ('chooser' in at) return send(chooserFor(at.chooser, true, at.axes));
    if (at.moved) return moved(at.moved);
    server!.transformIndexHtml(b + relOf(at.file), readPage(at.file), req.originalUrl).then(send, next);
  };
  /**
   * dev with `localePrefix`: the point a URL names (a page in a language, its file; `moved` when it is a page's other
   * form), else the source page whose unprefixed URL it is (its chooser), else null
   */
  const pointAt = (path: string): { file: string; moved?: string } | { chooser: string; axes: AxisValue[] } | null => {
    const b = base().startsWith('/') ? base() : '/';
    for (const f of entries()) {
      const rel = relOf(f), pats = describe(f).path, url = pageUrl(rel, b, pats);
      if (!(path === b + rel || pagePaths(rel, b, pats).some((x) => matches(x, path)))) continue;
      return movesToDirectory(rel, b, pats) && path !== url ? { file: f, moved: url! } : { file: f };
    }
    // a source's unprefixed URL, under each variant of its axes (the base language's points list them)
    const variants = new Map<string, AxisValue[][]>();
    for (const v of virtual.values()) if (v.axes?.length && v.locale === locales?.base) {
      if (!variants.has(v.source)) variants.set(v.source, []);
      if (!variants.get(v.source)!.some((a) => a.map((x) => x.key).join() === v.axes!.map((x) => x.key).join())) variants.get(v.source)!.push(v.axes);
    }
    for (const s of sourceEntries()) {
      for (const axes of variants.get(s) ?? [[]]) {
        const at = pointPrefix(null, axes, lurls), rel = at ? `${at}/${relOf(s)}` : relOf(s), pats = at ? prefixed(describeSource(s).path, at) : describeSource(s).path;
        if (path === b + rel || pagePaths(rel, b, pats).some((x) => matches(x, path))) return { chooser: s, axes };
      }
    }
    return null;
  };
  /**
   * builds with `site`: the sitemap's files (sitemap-build.ts), from each page's finished HTML (`built`, by its file):
   * a page's URL as its canonical link names it, each language's with the others and the chooser as alternates, and
   * a pattern's URLs from `sitemap.paths`. 404.html, 200.html, `noindex` pages, pages whose canonical link names
   * another URL and patterns without values are left out, and the build's line names them.
   */
  const sitemap = async (fail: (m: string) => never, all: PageEntry[], built: Map<string, string>, g: { folder: string; origin: string } | null = null): Promise<Array<{ fileName: string; source: string }>> => {
    // one per origin: its own pages, at its URLs, at its folder's root
    const siteOrigin = g?.origin ?? siteOriginOf();
    const served = (rel: string) => (g ? rel.slice(g.folder.length + 1) : rel);
    if (!siteOrigin || sitemapOptions === false) return [];
    const info = (m: string) => resolved?.logger.info(`sinter: ${m}`);
    if (relativeBase(base())) { info('no sitemap.xml with a relative base: the build does not know the URLs the site is served at'); return []; }
    const own = resolved?.publicDir ? resolve(resolved.publicDir, 'sitemap.xml') : null;
    if (own && existsSync(own)) { info(`sitemap.xml: the app's own (${relOf(own)}) is kept`); return []; }
    const b = base().replace(/\/?$/, '/'), given = sitemapOptions.paths ?? {}, used = new Set<string>();
    const urls: SitemapUrl[] = [], seen = new Set<string>(), left: string[] = [], known = new Set<string>();
    const add = (u: SitemapUrl) => { if (!seen.has(u.loc)) { seen.add(u.loc); urls.push(u); } };
    // the pages of each source page at each value of its axes: one, or one per language (its alternates)
    const groups = new Map<string, Array<{ page: PageEntry; locale: string | null; html: string; axes: AxisValue[] }>>();
    for (const page of all) {
      const html = built.get(page.rel), v = virtual.get(resolve(root, page.rel));
      if (html === undefined) continue;
      const g = [v ? relOf(v.source) : page.rel, ...(v?.axes ?? []).map((a) => a.key)].join('\0');
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g)!.push({ page, locale: v?.locale ?? null, html, axes: v?.axes ?? [] });
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
    for (const [g, list] of [...groups].sort(([x], [y]) => x.localeCompare(y))) {
      const src = g.split('\0')[0]!, axes = list[0]!.axes;
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
        const url = pageUrl(served(x.page.rel), base(), x.page.patterns);
        if (url === null) continue;
        const loc = siteOrigin + url, canonical = canonicalOf(x.html);
        if (canonical !== null && canonical !== loc) { left.push(`${x.page.rel} (its canonical link names ${canonical})`); continue; }
        fixed.push({ locale: x.locale, loc });
      }
      const alternates = (locs: Array<{ locale: string | null; loc: string }>, unprefixed: string) =>
        locales && locs.length ? { ...Object.fromEntries(locs.map((l) => [l.locale!, l.loc])), 'x-default': siteOrigin + unprefixed } : undefined;
      // (every language's URL, absolute: one on its own domain is in that domain's sitemap, and an alternate here)
      const every = locales && lurls?.domains && fixed.length ? localeUrls(source, axes, '\0') : null;
      const alt = every ? { ...every, 'x-default': siteOrigin + (chooserUrl(source, axes)) } : alternates(fixed, locales ? chooserUrl(source, axes) : '');
      for (const f of fixed) add({ loc: f.loc, ...(alt ? { alternates: alt } : {}) });
      // the patterns with parameters, as the page writes them (without a language's prefix)
      const patterns = (locales ? describeSource(source).path : list[0]!.page.patterns).filter((p) => p.includes(':'));
      for (const pattern of patterns) {
        const has = pattern in given;
        known.add(pattern);
        if (has) used.add(pattern);
        if (!pages.length) continue;
        // a page with a fixed URL too: its canonical link names that URL at every path it answers at
        const fixedUrl = pageUrl(served(pages[0]!.page.rel), base(), pages[0]!.page.patterns);
        if (fixedUrl !== null) { left.push(`${src} ${pattern} (its canonical link names ${siteOrigin + fixedUrl})`); continue; }
        const own = pages.map((x) => canonicalOf(x.html)).find((c) => c !== null);
        if (own) { left.push(`${src} ${pattern} (its canonical link names ${own})`); continue; }
        if (!has) { left.push(`${src} ${pattern} (no values in sitemap.paths)`); continue; }
        for (const value of await valuesOf(pattern)) {
          const locs = pages.map((x) => ({ locale: x.locale, loc: siteOrigin + fill(x.locale ? prefixed([pattern], segmentOf(x.locale, locales))[0]! : pattern, value, src) }));
          const a = alternates(locs, locales ? fill(pattern, value, src) : '');
          for (const l of locs) add({ loc: l.loc, ...(a ? { alternates: a } : {}) });
        }
      }
    }
    const unknown = Object.keys(given).filter((k) => !used.has(k));
    if (unknown.length) fail(`sinter({ sitemap: { paths } }): no page has the pattern \`${unknown[0]}\`; ${known.size ? `the patterns with parameters are ${[...known].map((p) => `\`${p}\``).join(', ')}` : 'no page has a pattern with parameters'}`);
    const files = sitemapFiles(urls, siteOrigin + b).map((f) => (g ? { ...f, fileName: `${g.folder}/${f.fileName}` } : f));
    info(`${g ? `${g.folder}/` : ''}sitemap.xml: ${urls.length} URL${urls.length === 1 ? '' : 's'}${files.length > 1 ? ` in ${files.length - 1} files` : ''}${left.length ? `; left out: ${left.slice(0, 10).join(', ')}${left.length > 10 ? `, and ${left.length - 10} more` : ''}` : ''}`);
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
        const v = virtual.get(ctx.filename), list = all.some((x) => x.rel === rel) ? all : [...all, page];
        const other = axisLists().length ? pointLinks(list)(rel, (why) => resolved?.logger.warn(`sinter: ${rel}: ${why}`)) : undefined;
        return relocateHtml(html, page, list, base(), locales?.list, v ? pointPrefix(v.locale ?? null, v.axes ?? [], lurls) || null : undefined, other);
      },
    },
    /**
     * builds: each page's finished HTML gets its links and, for a page with a fixed path, its relative URLs
     * for its new place; it moves into its directory, and a redirect file takes its old place
     */
    async generateBundle(_, bundle) {
      if (dev) return;
      const all = pageEntries(), by = new Map<string, string>(), built = new Map<string, string>();
      let named: Map<string, string[]> | undefined;
      // a page on its own domain is written under its origin's folder, at its URL there; the pages it links to are its origin's
      const asServed = (x: PageEntry): PageEntry => ({ rel: urlRel(x.rel), patterns: x.patterns });
      const linked = new Map<string, PageEntry[]>();
      const links = axisLists().length ? pointLinks(all) : null;
      const linkedOf = (rel: string) => {
        const k = groupOf(rel)?.folder ?? '';
        if (!linked.has(k)) linked.set(k, all.filter((x) => sameGroup(x.rel, rel)).map(asServed));
        return linked.get(k)!;
      };
      for (const page of all) {
        const g = groupOf(page.rel), served = g ? asServed(page) : page;
        const to = (g ? `${g.folder}/` : '') + pageFile(served.rel, base(), page.patterns), a = bundle[page.rel];
        if (a?.type !== 'asset') continue;
        let html = typeof a.source === 'string' ? a.source : Buffer.from(a.source).toString('utf8');
        // a page in a language with a URL: its other languages' URLs, and its chooser's, for search engines
        const site = g?.origin ?? siteOrigin;
        const v = virtual.get(resolve(root, page.rel)), urls = v?.locale && site ? (v.page ? entryUrls(v, g?.folder ?? null) : localeUrls(v.source, v.axes, g?.folder ?? null)) : null;
        if (v && urls) html = html.replace('</head>', `  ${hreflangTags(site!, urls, v.page ? entryChooser(v)! : chooserUrl(v.source, v.axes), locales!.codes)}\n</head>`);
        // links stay in the page's point: its language and its axes' values (`/cart/` on acme's German page is theirs)
        const other = links?.(page.rel, (why) => this.error(`sinter: ${v ? relOf(v.source) : page.rel} (${page.rel}): ${why}`));
        const source = relocateHtml(html, served, g ? linkedOf(page.rel) : all, base(), locales?.list, v ? pointPrefix(v.locale ?? null, v.axes ?? [], lurls) || null : undefined, other);
        built.set(page.rel, source);
        if (to === page.rel) { a.source = source; continue; }
        if (bundle[to]) this.error(`sinter: ${page.rel} is written as ${to}, its URL ${pageUrl(served.rel, base(), page.patterns)}, and ${by.get(to) ?? to} is there too: rename one of them`);
        by.set(to, page.rel);
        delete bundle[page.rel];
        this.emitFile({ type: 'asset', fileName: to, source });
        // a link the page module builds at run time still names the old file: it arrives through the redirect
        // (every page module read once for every page's file, the first time a page moves)
        named ??= filesNamed(all.map((x) => x.rel), all.flatMap((x) => { const code = modules.get(`${PREFIX}${x.rel}.js`); return code ? [[x.rel, code] as const] : []; }), base().startsWith('/') ? base().replace(/\/$/, '') : '');
        for (const other of named.get(page.rel) ?? []) {
          resolved?.logger.warn(coded('SN521', `${other} builds a link to ${page.rel} at run time, which is served at ${pageUrl(page.rel, base(), page.patterns)} now: it arrives through a redirect. Write the URL in the expression (\`'${pageUrl(page.rel, base(), page.patterns)}?…'\`)`));
        }
        // the old URL still arrives: a redirect to the page's URL (relative under a relative base)
        const url = relativeBase(base()) ? `./${posix.basename(to, '/index.html')}/` : pageUrl(served.rel, base(), page.patterns)!;
        this.emitFile({ type: 'asset', fileName: page.rel, source: redirectHtml(url) });
      }
      // languages: at each source page's unprefixed URL, a chooser (404.html and 200.html: the base language's page,
      // which hosts look for there); at a moved source page's old file URL, the chooser too (one hop to a language)
      if (locales) {
        const script = [...runtimeOf.values()].some((r) => r.length);
        for (const c of choosers(script)) {
          if ('copyOf' in c) {
            const a = bundle[c.copyOf];
            if (a?.type === 'asset') this.emitFile({ type: 'asset', fileName: c.fileName, source: rebaseHtml(String(a.source), '/' + posix.dirname(c.copyOf), '/' + posix.dirname(c.fileName).replace(/^\.$/, '')) });
          } else if (!c.ifFree || !bundle[c.fileName]) this.emitFile({ type: 'asset', fileName: c.fileName, source: c.source });
        }
      }
      brokenEntryLinks((m) => this.error(m), built);
      for (const f of await sitemap((m) => this.error(m), all.filter((x) => !groupOf(x.rel)), built)) this.emitFile({ type: 'asset', ...f });
      for (const folder of groups()) {
        const own = all.filter((x) => groupOf(x.rel)?.folder === folder);
        for (const f of await sitemap((m) => this.error(m), own, built, groupOf(own[0]!.rel))) this.emitFile({ type: 'asset', ...f });
      }
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
  // `compileHints`: the hint first in each page module, its source map a line further down
  const compileHints: Plugin = {
    name: 'sinter:compile-hints',
    enforce: 'post',
    apply: 'build',
    generateBundle(_, bundle) {
      if (!options.compileHints) return;
      const HINT = '//# allFunctionsCalledOnLoad\n';
      for (const c of Object.values(bundle)) {
        if (c.type !== 'chunk' || !c.isEntry || c.code.startsWith(HINT)) continue;
        c.code = HINT + c.code;
        if (c.map) c.map.mappings = ';' + c.map.mappings;
        const m = bundle[c.fileName + '.map'];
        if (m?.type === 'asset' && typeof m.source === 'string') { const j = JSON.parse(m.source) as { mappings: string }; j.mappings = ';' + j.mappings; m.source = JSON.stringify(j); }
      }
    },
  };
  // the cross-check's answer, waited for last (after Vite's HTML step): a plugin named as the main one, so a difference
  // fails the build with the same message as at `buildEnd`
  const crossLate: Plugin = {
    name: 'sinter',
    enforce: 'post',
    generateBundle: {
      order: 'post',
      async handler() {
        if (!crossPending) return;
        const t0 = performance.now();
        const a = await crossPending;
        if (process.env.SN_CROSS_LOG === '1') console.error(`sinter cross: waited ${Math.round(performance.now() - t0)} ms after Vite's HTML step`);
        crossPending = null;
        crossReport(this, a);
      },
    },
  };
  // Vite's HTML step for a page it does not change (html-step.ts): the page is kept after sinter's last HTML hook
  // before the step (`sinter:fonts`), Vite parses a stand-in, and the page is back before the first one after it
  // (`sinter:early`): everything after the step sees the page Vite would have written. Only in an app whose other
  // plugins have no HTML hook (they would see the stand-in), and not with what the step does to every page
  const htmlIn: Plugin = {
    name: 'sinter:html-in',
    enforce: 'pre',
    transformIndexHtml: {
      order: 'pre',
      handler(html, ctx) {
        if (dev) return html;
        if (!htmlSkip || typeof html !== 'string' || viteStepNeeded(html)) { htmlCount.through++; return html; }
        htmlCount.kept++;
        htmlKept.set(ctx.filename, html);
        return STEP_STAND_IN;
      },
    },
  };
  const htmlOut: Plugin = {
    name: 'sinter:html-out',
    enforce: 'post',
    transformIndexHtml: {
      order: 'post',
      handler(html, ctx) {
        const kept = htmlKept.get(ctx.filename);
        if (kept === undefined) return html;
        htmlKept.delete(ctx.filename);
        if (html !== STEP_STAND_IN) throw new Error(`sinter: ${relOf(ctx.filename)}: Vite's HTML step changed the page sinter kept out of it (another plugin's HTML hook?); build with SN_HTML_SKIP=0 and report it`);
        return kept;
      },
    },
    // `SN_HTML_LOG=1`: how many pages Vite's step parsed, and how many it was given a stand-in for
    generateBundle() {
      if (process.env.SN_HTML_LOG === '1') console.error(`sinter html: ${htmlCount.kept} pages kept out of Vite's HTML step, ${htmlCount.through} through it${htmlSkip ? '' : ' (off for this app)'}`);
      htmlCount.kept = htmlCount.through = 0;
    },
  };
  return [main, htmlOut, post, cssImages, fonts, htmlIn, fontCheck, pages, compileHints, crossLate];
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
