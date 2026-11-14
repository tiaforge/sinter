// Vite adapter: a thin wrapper around compile(). Every HTML entry is compiled
// in transformIndexHtml; its page module is served as a virtual module. With
// first paint on, each page also gets an early script: classic scripts first in the
// head (one shared by every page, one of the page's own) that render what needs no
// data as the parser inserts it, before the first paint, with nothing render-blocking.
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, posix, relative, resolve, sep } from 'node:path';
import { gzipSync } from 'node:zlib';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import type { Plugin, ResolvedConfig, ViteDevServer } from 'vite';
import { applyStrict, compile, formatDiagnostic, formatWarning, strictPromotes, type Code, type CheckUnit, type Diagnostic, type CompileResult, type SourceMap } from './compiler/index.js';
import { lazyOf, project, staticPages, strictOf, type ProjectOptions } from './project.js';
import { CHUNK_MARK, chainText, helperProblem, isComponentScript, LAZY, lazyPackage, lineCol, loaderModule, mentions, parseLazyId, reachLazy, rewriteLazy, scanLazy, stubModule } from './lazy-build.js';
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
import { pageRoutes, rebaseHtml, redirectHtml, redirectsFile, relocateHtml, type PageEntry, type Route } from './page-urls.js';
import { chooserHtml, hreflangTags, readLocales, type Locales } from './locales-build.js';
import { familyLineHeights } from './font-metrics.js';
import { faceName, faceOf, fontDownloader, fontFileDownloader, inlineFonts, preloadFonts, preloadLocalFonts, usesFamily, type FontFaceRef, type FontPreload } from './fonts-build.js';
import { componentBase } from './components-build.js';
import { COMPONENT_NAME } from './compiler/components.js';
import { apiOrigins } from './compiler/apis.js';

export interface SinterOptions extends ProjectOptions {
  /** run `sinter check` at the end of `vite build` and fail it on type errors (needs TypeScript) */
  typecheck?: boolean;
  /**
   * first paint (default true): build-time constants (and the base language's messages) are written
   * into the HTML, and each page gets an early script (the app's `src/sinter.early.ts`, then the
   * bindings that need no data): classic scripts first in the head, which render each element as the
   * parser inserts it (`observe` in early.ts). `false`: everything waits for the page module.
   */
  firstPaint?: boolean;
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
  let root = process.cwd();
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
            transform(src, id) { if (messages && !id.includes('/node_modules/') && /\.[cm]?[jt]sx?$/.test(id)) for (const k of moduleKeys(src, id).keys) keys.add(k); },
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
    const r = reachLazy(file, lazyPkgs, root);
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
  const described = new Map<string, { parts: PrefetchParts | null; path: string[]; off: boolean }>();
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
  const virtual = new Map<string, { source: string; locale: string }>();
  /** the build's input as the app wrote it, before `localePrefix` turns it into one input per page and language */
  let sourceInput: unknown = undefined;
  const sourceDescribed = new Map<string, string[]>();
  /** build: why each page needs the runtime, by its path relative to the root (empty: it ships none) */
  const runtimeOf = new Map<string, RuntimeReason[]>();
  let pagesCache: Array<{ paths: string[]; parts: PrefetchParts | null }> | null = null;
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

  const watch = (file: string) => {
    if (watched.has(file)) return;
    watched.add(file);
    server?.watcher.add(file);
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
  const entries = () => (locales ? sourceEntries().flatMap((s) => locales!.list.map((l) => virtualOf(s, l))) : sourceEntries());
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
      const p = project(root, options), v = virtual.get(file);
      try {
        // with the APIs and specs: what is requested ahead is the page's own request (its base, its configured shape)
        const r = compile(readPage(file), { file: v?.source ?? file, root, dev, helpers: p.helpers, actions: p.actions, readFile: p.readFile, lazy: p.lazy, openapi: p.openapi, apis: p.apis, ...(v ? { locale: { name: v.locale, urls: null, base: resolved?.base ?? '/' } } : {}) });
        described.set(file, { parts: r.prefetch, path: r.path, off: !!r.prefetchOff });
      } catch { described.set(file, { parts: null, path: [], off: false }); }
    }
    return described.get(file)!;
  };
  /** a source page's description, as written (no language's prefix) */
  const describeSource = (source: string) => {
    if (!sourceDescribed.has(source)) {
      const p = project(root, options);
      try { sourceDescribed.set(source, compile(readFileSync(source, 'utf8'), { file: source, root, dev, helpers: p.helpers, actions: p.actions, readFile: p.readFile, lazy: p.lazy, openapi: p.openapi, apis: p.apis }).path); }
      catch { sourceDescribed.set(source, []); }
    }
    return { path: sourceDescribed.get(source)! };
  };
  /** every page, with its `data-sn-path` patterns: where it is written and what its links name (page-urls.ts) */
  const pageEntries = (): PageEntry[] => entries().map((file) => ({ rel: relOf(file), patterns: describe(file).path }));
  const appPages = () => {
    if (pagesCache) return pagesCache;
    const out: Array<{ paths: string[]; parts: PrefetchParts | null }> = [];
    for (const file of entries()) {
      const d = describe(file);
      // `<html data-sn-prefetch="off">`: neither described nor in the rules
      if (d.off) continue;
      out.push({ paths: pagePaths(relOf(file), resolved?.base ?? '/', d.path), parts: d.parts });
    }
    return (pagesCache = out);
  };
  const prefetchPages = () => appPages().filter((x): x is { paths: string[]; parts: PrefetchParts } => !!x.parts);
  /** how the Speculation Rules are delivered, or null for none */
  const spec = () => {
    // inline by default: it works with no server setup (a CSP in the page gets the rules' hash, see withRulesHash)
    const o = options.speculation ?? 'prefetch';
    return o === false ? null : typeof o === 'string' ? { mode: o, delivery: 'inline' as const } : { mode: o.mode, delivery: o.delivery ?? 'inline' };
  };
  /** the rules' JSON for links to the app's pages, or null; `samePage`: a page with same-page links (query-links.ts), whose own URLs are left out */
  const rulesJson = (samePage = false) => { const s = spec(); return s ? speculationRules(s.mode, appPages().flatMap((x) => x.paths), samePage) : null; };
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

  /** compiles one page; `earlySrc`: where the page loads its early chunk (dev), else the build injects the tag */
  const build = (html: string, file: string, earlySrc: string | null, styles?: StyleSheet[], lineHeights?: Map<string, number>): { out: CompileResult; p: ReturnType<typeof project> } => {
    const rel = relOf(file);
    const p = project(root, options);
    // a page in a language: compiled from its source (diagnostics, components, layouts as written), in that language
    const v = virtual.get(file), src = v?.source ?? file;
    const lang = v && p.messages ? { ...p.messages.dicts[p.messages.base], ...p.messages.dicts[v.locale] } : null;
    const fatal = strictly(p.diagnostics).filter((d) => d.severity === 'error');
    if (fatal.length) throw new Error(`sinter: ${fatal.map(formatDiagnostic).join('\n')}`);
    // a warning about the options (a deprecated one): once per build
    for (const d of p.diagnostics) if (d.severity === 'warning' && !warnedOptions.has(d.message)) { warnedOptions.add(d.message); resolved?.logger.warn(formatDiagnostic(d)); }
    if (!seen.has(file)) { seen.add(file); pagesCache = null; }
    const prefetch = options.prefetch !== false && prefetchPages().length ? PREFETCH : null;
    const out = compile(html, {
      file: src, root, dev, sourcemap: dev || !!resolved?.build.sourcemap, helpers: p.helpers, actions: p.actions, moduleSrc: `${PREFIX}${rel}.js`, config: p.config, readFile: p.readFile, prefetch,
      check: !!options.typecheck && !dev, openapi: p.openapi, apis: p.apis, complexity: p.complexity, componentNames: p.componentNames, checkCycles: p.checkCycles, lazy: p.lazy,
      ...(lazyPkgs.length ? { lazyScript } : {}),
      ...(images ? { images: imageHost(rel, styles)! } : {}),
      ...(styles?.length ? { styles } : {}),
      ...(lineHeights?.size ? { normalLineHeight: (f: string) => lineHeights.get(f) ?? null } : {}),
      ...(firstPaint && !dev ? { paintCss: `${PAINT_CSS}${rel}.css` } : {}),
      ...(remoteConfig ? { remoteImages: dev ? devRemote(remoteConfig, resolved?.base ?? '/') : remoteConfig } : {}),
      ...(firstPaint ? { prerender: true, early: { module: p.early, src: earlySrc } } : {}),
      ...((firstPaint || lang) && p.messages ? { baseMessages: lang ?? p.messages.dicts[p.messages.base] ?? {} } : {}),
      ...(v ? { locale: { name: v.locale, urls: localeUrls(src), base: resolved?.base ?? '/' } } : {}),
      ...(options.origins?.length || apiOrigins(p.apis).length ? { origins: [...(options.origins ?? []), ...apiOrigins(p.apis)] } : {}),
      ...(firstPaint ? { observe: true } : {}),
      ...(options.embed && !dev ? { embed: true } : {}),
      componentCss: (name) => `${COMPONENT_CSS}${name}.css`,
      ...(p.isStatic(src) ? { static: true } : {}),
      ...(resolved?.base?.startsWith('/') ? { base: resolved.base } : {}),
      ...(siteOrigin ? { urls: urlsOf(rel, out0Path(file)) } : {}),
    });
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
   * package). The helpers module may not reach a lazy package at all.
   */
  const lazyTransform = (ctx: { error(e: string | { message: string; id?: string; loc?: { line: number; column: number } }): never }, code: string, id: string) => {
    if (!lazyPkgs.length || id.startsWith('\0') || id.includes('/node_modules/') || !/\.[cm]?[jt]sx?(\?|$)/.test(id)) return null;
    const file = id.replace(/[?#].*$/, '');
    const helpers = project(root, options).helpersFile;
    if (helpers && file === helpers) {
      const r = reachLazy(file, lazyPkgs, root)[0];
      if (r) { const d = helperProblem(root, r, file); ctx.error({ message: `sinter: SN324 ${d.message}`, id: file, loc: { line: 1, column: 0 } }); }
    }
    if (!mentions(code, lazyPkgs)) return null;
    const s = scanLazy(code, file, lazyPkgs);
    if (!s.lazy.length && !s.problems.length) return null;
    if (isComponentScript(root, file)) return null;
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
      const deps = lazyPkgs.length ? { optimizeDeps: { include: lazyPkgs } } : {};
      const mp = user.build?.modulePreload;
      if (mp === false || (typeof mp === 'object' && mp.polyfill !== undefined)) return deps;
      return { ...deps, build: { modulePreload: { polyfill: false } } };
    },

    async configResolved(config) {
      root = config.root;
      dev = config.command === 'serve';
      resolved = config;
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
        // a page's resources may have changed: the next-page module is described again
        if (file.endsWith('.html') || watched.has(file)) { described.clear(); pagesCache = null; invalidate(PREFETCH); devEarly.clear(); }
        if (watched.has(file)) s.ws.send({ type: 'full-reload' });
      });
    },

    /** build: the pages that have something to run early (bundled into one file each in generateBundle) */
    async buildStart(input) {
      unhashedPages = 0;
      strictFailures.clear();
      speculationHashes.clear();
      sharedHead = null;
      earlyPages.clear();
      unlisted.clear();
      earlyFiles.clear();
      languageFiles.clear();
      pageMessages.clear();
      described.clear();
      pagesCache = null;
      if (dev) return;
      const p = project(root, options);
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
      if (!firstPaint && !messages) return;
      const list = typeof input.input === 'string' ? [input.input] : Array.isArray(input.input) ? input.input : Object.values(input.input ?? {});
      for (const entry of list) {
        if (!entry.endsWith('.html')) continue;
        const file = resolve(root, entry);
        try {
          const { out } = build(readPage(file), file, null);
          if (out.early && firstPaint) earlyPages.set(relOf(file), out.early);
          for (const o of out.unlistedOrigins ?? []) unlisted.add(o);
        } catch { /* reported when the page itself is compiled */ }
      }
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
        for (const l of virtual.has(resolve(root, rel)) ? [virtual.get(resolve(root, rel))!.locale] : messages.locales) {
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
      if (locales && id.endsWith('.html')) { const abs = resolve(root, id.replace(/^\//, '')); if (virtual.has(id) || virtual.has(abs)) return virtual.has(id) ? id : abs; }
      // a component's script imports its generated base from its own HTML file
      if (importer && id.endsWith('.html') && !importer.endsWith('.html')) {
        const file = resolve(dirname(importer.replace(/[?#].*$/, '')), id);
        const name = file.slice(0, -5).split(sep).pop()!;
        if (dirname(file) === resolve(root, 'src/components') && COMPONENT_NAME.test(name)) return `\0${COMPONENT_BASE}${name}.js`;
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
      if (css.startsWith(`\0${COMPONENT_CSS}`)) return componentCss.get(css.slice(COMPONENT_CSS.length + 1, -4)) ?? '';
      if (id.startsWith(`\0${COMPONENT_BASE}`)) return componentBase(id.slice(COMPONENT_BASE.length + 1, -3));
      // lazy packages: the loader (one `import()` of the package) and each importer's stubs
      const lz = id.startsWith(`\0${LAZY}`) ? parseLazyId(id.slice(1)) : null;
      if (lz && lazyPackage(lz.spec, lazyPkgs)) {
        if (lz.names) return stubModule(lz.spec, lz.names);
        if (dev) return loaderModule(lz.spec, null);
        const r = await this.resolve(lz.spec, resolve(root, 'index.html'));
        if (r) lazyIds.set(lz.spec, r.id);
        return loaderModule(lz.spec, r?.id ?? null);
      }
      // dev: the picker, and each language's whole dictionary
      if (id === `\0${PREFIX}i18n.js`) return I18N_PICKER;
      if (id === `\0${PREFIX}img-check.js`) return IMAGE_CHECK;
      if (id === `\0${PREFIX}warn-relay.js`) return WARN_RELAY;
      if (id === `\0${PREFETCH}`) return prefetchModule(prefetchPages(), project(root, options).helpers);
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
      if (error || !options.typecheck || dev || !units.size) return;
      const { check } = await import('./check/index.js');
      const p = project(root, options);
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
        const styles = (images && /<img\b|<[a-z][a-z0-9]*-/i.test(html)) || (firstPaint && /data-sn-for|<[a-z][a-z0-9]*-/i.test(html)) ? await stylesOf(html, virtual.get(file)?.source ?? file, project(root, options)) : undefined;
        // the fonts' `line-height: normal`, for the space of lists (builds)
        const lineHeights = styles?.length && firstPaint && !dev && /data-sn-for|<[a-z][a-z0-9]*-/i.test(html) ? await lineHeightsOf(styles) : undefined;
        let { out, p } = build(html, file, earlySrc, styles, lineHeights);
        // images the compiler did not know yet: analysed, then the page is compiled again with them
        if (images && out.images?.pending.length) {
          await images.analyze(out.images.pending);
          ({ out, p } = build(html, file, earlySrc, styles, lineHeights));
        }
        for (const w of out.remoteWidths ?? []) remoteWidths.add(w);
        // the page's early file from this compile (with the stylesheets), which wrote the page: its ids are the page's
        if (!dev && firstPaint) { if (out.early) earlyPages.set(rel, out.early); else earlyPages.delete(rel); }
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
    const mark = new RegExp(`(["'\`])${CHUNK_MARK}(.+?)__\\1`, 'g');
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
    generateBundle(_, bundle) {
      if (dev) return;
      const all = pageEntries(), by = new Map<string, string>();
      for (const page of all) {
        const to = pageFile(page.rel, base(), page.patterns), a = bundle[page.rel];
        if (a?.type !== 'asset') continue;
        let html = typeof a.source === 'string' ? a.source : Buffer.from(a.source).toString('utf8');
        // a page in a language with a URL: its other languages' URLs, and its chooser's, for search engines
        const v = virtual.get(resolve(root, page.rel)), urls = v && siteOrigin ? localeUrls(v.source) : null;
        if (v && urls) html = html.replace('</head>', `  ${hreflangTags(siteOrigin!, urls, chooserUrl(v.source))}\n</head>`);
        const source = relocateHtml(html, page, all, base(), locales?.list);
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
        for (const src of sourceEntries()) {
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
