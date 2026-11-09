// Vite adapter: a thin wrapper around compile(). Every HTML entry is compiled
// in transformIndexHtml; its page module is served as a virtual module. With
// first paint on, each page also gets an early chunk: a second entry, loaded
// render-blocking before the page module, that renders what needs no data.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { posix, relative, resolve, sep } from 'node:path';
import { gzipSync } from 'node:zlib';
import type { Plugin, ResolvedConfig, ViteDevServer } from 'vite';
import { compile, formatDiagnostic, type CheckUnit, type CompileResult, type SourceMap } from './compiler/index.js';
import { project, type ProjectOptions } from './project.js';
import { I18N_PICKER, languageFile, moduleKeys, type MessagesProject } from './i18n-build.js';
import { HOLD_SCRIPT, PAINT_SCRIPT } from './paint-build.js';
import { loadImages, MIME, type Images } from './images.js';
import { pageStyles } from './styles.js';
import { detectEngines, type StyleEngine } from './engines.js';
import { IMAGE_CHECK } from './image-check.js';
import { rewriteCssImages, type CssImageHost } from './css-images.js';
import { resolveRemote, type RemoteImages } from './remote.js';
import { devRemote, remoteMiddleware } from './remote-dev.js';
import type { ImageHost, ImageVariant, PrefetchParts, StyleSheet } from './compiler/index.js';
import { hasCspMeta, pagePaths, prefetchModule, speculationRules, withRulesHash } from './prefetch-build.js';
import { fontDownloader, inlineFonts } from './fonts-build.js';

export interface SinterOptions extends ProjectOptions {
  /** run `sinter check` at the end of `vite build` and fail it on type errors (needs TypeScript) */
  typecheck?: boolean;
  /**
   * first paint (default true): build-time constants are written into the HTML, and each page
   * gets an early chunk (the app's `src/sinter.early.ts`, then the bindings that need no data),
   * loaded render-blocking before the page module. `false`: everything waits for the page module.
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
   * next-page data (default true): when a link to another page of the app is about to be followed,
   * that page's data is requested, and the page shows it at once (then revalidates). `false`: off.
   */
  prefetch?: boolean;
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
   */
  fonts?: { inline?: boolean };
}

type SinterPlugins = [Plugin & { api: { options: SinterOptions } }, Plugin, Plugin, Plugin];

/** a base Vite resolves per file (`./`, ''): its URLs are relative to the page or stylesheet */
const relativeBase = (base: string) => base === '' || base.startsWith('.');
/** the base for URLs in the page at `rel` (root-relative): a relative base becomes the way up to the root */
const pageBase = (base: string, rel: string) => (relativeBase(base) ? '../'.repeat(rel.split('/').length - 1) || './' : base);

const PREFIX = '/@sinter/';
const EARLY = `${PREFIX}early/`;
/** the page's image rules (a CSS module the page module imports) */
const IMG_CSS = `${PREFIX}img-css/`;
/** dev: where the image variants are served */
const IMG = `${PREFIX}img/`;
const PREFETCH = `${PREFIX}prefetch.js`;
/** `speculation: { delivery: 'header' }`: the rules file, at the site root */
const RULES_FILE = 'speculation-rules.json';

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
  const watched = new Set<string>();
  const units = new Map<string, CheckUnit>();
  const firstPaint = options.firstPaint !== false;
  let pickerFile = '';
  let paintFile = '';
  /** pages that use `data-sn-transition`: they get the hold script (paint-build.ts), and its file */
  const holdPages = new Set<string>();
  let holdFile = '';
  /** build: the pages with an early module, and each one's bundled early file */
  const earlyPages = new Map<string, string>();
  /** pages whose early file is split (it has early requests): loaded `async` first, rendered by a stub */
  const splitPages = new Set<string>();
  /** origins of resources that could have been requested early, not listed in `origins` (reported once per build) */
  const unlisted = new Set<string>();
  const earlyFiles = new Map<string, { fileName: string; code: string; modules: Record<string, { renderedLength: number }>; stub?: string }>();
  const budget = options.earlyBudget ?? 10_000;
  /** built-in messages: keys each module calls (`m.key`), keys each page's markup calls, and each page's language files */
  const moduleMessages = new Map<string, string[]>();
  const markupMessages = new Map<string, string[]>();
  const languageFiles = new Map<string, Record<string, { fileName: string; code: string }>>();
  let messages: MessagesProject | null = null;
  let images: Images | null = null;
  // a template or origin that cannot work fails before Vite starts
  const remoteConfig = options.images && options.images.remote ? resolveRemote(options.images.remote) : null;
  /** build: the widths the pages ask the resizing service for (Vercel accepts only the ones it is told) */
  const remoteWidths = new Set<number>();
  /** image variants by file name, and each page's image rules */
  const variants = new Map<string, ImageVariant>();
  const imageCss = new Map<string, string>();
  let resolveId: ((id: string, importer?: string) => Promise<string | undefined>) | null = null;
  let engines: StyleEngine[] | null = null;
  const warned = new Set<string>();
  const warnOnce = (m: string) => { if (!warned.has(m)) { warned.add(m); resolved!.logger.warn(m); } };
  /** a stylesheet as Vite compiles it: Sass, Less, Stylus, the project's PostCSS, `@import` */
  const failedCss = new Set<string>();
  const compileCss = async (code: string, file: string) => {
    const { preprocessCSS } = await import('vite');
    try {
      const out = await preprocessCSS(code, file, resolved!);
      return { code: out.code, deps: [...(out.deps ?? [])] };
    } catch (e) {
      // e.g. a .scss file without sass installed: the build reports it; here its sizes are unknown
      if (!failedCss.has(file)) { failedCss.add(file); resolved!.logger.warn(`sinter: image sizes from ${relOf(file)} are not read: ${(e as Error).message.split('\n')[0]}`); }
      return null;
    }
  };
  /** the stylesheets the page loads, for the boxes they give its images */
  const stylesOf = async (html: string, file: string, p: ReturnType<typeof project>): Promise<StyleSheet[]> => {
    resolveId ??= resolved!.createResolver({ tryIndex: true });
    const r = resolveId;
    const modules = [p.config, p.early, p.helpersFile, p.actionsFile].filter((m): m is string => !!m);
    engines ??= detectEngines(root, resolved!.plugins.map((x) => x.name));
    return pageStyles(html, file, { root, publicDir: resolved!.publicDir || null, modules, resolve: (id, importer) => r(id, importer), compile: compileCss, engines, warn: warnOnce });
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
  /** build: the pages with inline rules and no CSP <meta>, whose CSP (if any) comes from a response header */
  let unhashedPages = 0;
  const seen = new Set<string>();
  let pagesCache: Array<{ paths: string[]; parts: PrefetchParts | null }> | null = null;
  const attr = (v: string) => v.replace(/[&"<>]/g, (c) => `&#${c.charCodeAt(0)};`);
  /**
   * the picker script's tag: it picks the locale and adds the page's language file before the first paint;
   * `early`: the page has an early file, so it also holds the first paint where `blocking` is not supported (paint-build.ts)
   */
  const pickerTag = (src: string, files: Record<string, string>, early: boolean) => `<script src="${attr(src)}" data-sn-i18n="${attr(JSON.stringify({ base: messages!.base, locales: messages!.locales, storage: 'locale', files }))}"${early ? ' data-sn-early' : ''}></script>`;
  /** a page with an early file and no messages: the render-blocking fallback alone */
  const paintTag = (src: string) => `<script src="${attr(src)}" data-sn-early></script>`;
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
  const entries = () => {
    const b = resolved?.build as { rollupOptions?: { input?: unknown }; rolldownOptions?: { input?: unknown } } | undefined;
    const input = b?.rolldownOptions?.input ?? b?.rollupOptions?.input;
    const list = typeof input === 'string' ? [input] : Array.isArray(input) ? input : input && typeof input === 'object' ? Object.values(input) : [];
    const files = (list as unknown[]).filter((f): f is string => typeof f === 'string' && f.endsWith('.html')).map((f) => resolve(root, f));
    if (!files.length && existsSync(resolve(root, 'index.html'))) files.push(resolve(root, 'index.html'));
    return [...new Set([...files, ...seen])].sort();
  };
  /** every page with the paths it answers at, and what another page can request ahead for it */
  const appPages = () => {
    if (pagesCache) return pagesCache;
    const p = project(root, options), out: Array<{ paths: string[]; parts: PrefetchParts | null }> = [];
    for (const file of entries()) {
      if (!described.has(file)) {
        try {
          const r = compile(readFileSync(file, 'utf8'), { file, root, dev, helpers: p.helpers, actions: p.actions, readFile: p.readFile });
          described.set(file, { parts: r.prefetch, path: r.path, off: !!r.prefetchOff });
        } catch { described.set(file, { parts: null, path: [], off: false }); }
      }
      const d = described.get(file)!;
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
  /** the rules' JSON for links to the app's pages, or null */
  const rulesJson = () => { const s = spec(); return s ? speculationRules(s.mode, appPages().flatMap((x) => x.paths)) : null; };
  /** where `delivery: 'header'` serves the rules: a fixed name, as the server's header names it */
  const rulesUrl = () => `${resolved?.base ?? '/'}${RULES_FILE}`;
  /** the Speculation Rules tag for links to the app's pages, or '' (none, or delivered by a header) */
  const speculationTag = () => {
    if (spec()?.delivery !== 'inline') return '';
    const json = rulesJson();
    if (!json) return '';
    speculationHash = `sha256-${createHash('sha256').update(json).digest('base64')}`;
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
  const build = (html: string, file: string, earlySrc: string | null, styles?: StyleSheet[]): { out: CompileResult; p: ReturnType<typeof project> } => {
    const rel = relOf(file);
    const p = project(root, options);
    if (p.diagnostics.length) throw new Error(`sinter: ${p.diagnostics.map(formatDiagnostic).join('\n')}`);
    if (!seen.has(file)) { seen.add(file); pagesCache = null; }
    const prefetch = options.prefetch !== false && prefetchPages().length ? PREFETCH : null;
    const out = compile(html, {
      file, root, dev, sourcemap: dev || !!resolved?.build.sourcemap, helpers: p.helpers, actions: p.actions, moduleSrc: `${PREFIX}${rel}.js`, config: p.config, readFile: p.readFile, prefetch,
      check: !!options.typecheck && !dev, openapi: p.openapi, complexity: p.complexity, checkCycles: p.checkCycles,
      ...(images ? { images: imageHost(rel, styles)! } : {}),
      ...(remoteConfig ? { remoteImages: dev ? devRemote(remoteConfig, resolved?.base ?? '/') : remoteConfig } : {}),
      ...(firstPaint ? { prerender: true, early: { module: p.early, src: earlySrc } } : {}),
      ...(options.origins?.length ? { origins: options.origins } : {}),
      ...(firstPaint && !dev ? { splitEarly: true } : {}),
    });
    if (out.early) setModule(`${EARLY}${rel}.js`, out.early, out.earlyMap);
    if (out.module.includes(`/transition';`)) holdPages.add(rel); else holdPages.delete(rel);
    messages = p.messages;
    if (out.messages) markupMessages.set(rel, out.messages);
    return { out, p };
  };
  const invalidate = (id: string) => {
    const m = server?.moduleGraph.getModuleById('\0' + id);
    if (m) server!.moduleGraph.invalidateModule(m);
  };

  const main: SinterPlugins[0] = {
    name: 'sinter',
    enforce: 'pre',
    api: { options },

    async configResolved(config) {
      root = config.root;
      dev = config.command === 'serve';
      resolved = config;
      if (options.images !== false) {
        images = await loadImages(resolve(root, 'node_modules/.cache/sinter/images'), dev);
        if (!images) config.logger.warn('sinter: images are not optimized, since sharp is not installed (npm install -D sharp), or sinter({ images: false }) to silence this');
      }
    },

    configureServer(s) {
      server = s;
      // dev: an image variant is encoded the first time it is requested (and cached)
      if (remoteConfig) s.middlewares.use(remoteMiddleware(remoteConfig, (m) => s.config.logger.warn(m)));
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
      // an HTML, partial or helpers change triggers a full reload in v0.1
      s.watcher.on('change', (file) => {
        // a page's resources may have changed: the next-page module is described again
        if (file.endsWith('.html') || watched.has(file)) { described.clear(); pagesCache = null; invalidate(PREFETCH); }
        if (watched.has(file)) s.ws.send({ type: 'full-reload' });
      });
    },

    /** build: the pages that have something to run early (bundled into one file each in generateBundle) */
    buildStart(input) {
      unhashedPages = 0;
      earlyPages.clear();
      splitPages.clear();
      unlisted.clear();
      earlyFiles.clear();
      languageFiles.clear();
      described.clear();
      pagesCache = null;
      if (dev) return;
      const p = project(root, options);
      messages = p.messages;
      // a missing translation falls back to the base language: reported once per locale
      if (messages) {
        for (const l of messages.locales) {
          if (l === messages.base) continue;
          const missing = Object.keys(messages.keys).filter((k) => !(k in (messages!.dicts[l] ?? {})));
          if (missing.length) this.warn(`sinter: ${missing.length} message(s) not translated to \`${l}\` (the ${messages.base} text is used): ${missing.slice(0, 10).join(', ')}${missing.length > 10 ? ', …' : ''}`);
        }
      }
      if (!firstPaint && !messages) return;
      const list = typeof input.input === 'string' ? [input.input] : Array.isArray(input.input) ? input.input : Object.values(input.input ?? {});
      for (const entry of list) {
        if (!entry.endsWith('.html')) continue;
        const file = resolve(root, entry);
        try {
          const { out } = build(readFileSync(file, 'utf8'), file, null);
          if (out.early && firstPaint) earlyPages.set(relOf(file), out.early);
          if (out.earlySplit) splitPages.add(relOf(file));
          for (const o of out.unlistedOrigins ?? []) unlisted.add(o);
        } catch { /* reported when the page itself is compiled */ }
      }
    },

    /**
     * build: each page's early module bundled on its own into one file, with nothing imported, so
     * the first paint waits for one request. Modules it shares with the page bundle are copies:
     * state the app sets early (an i18n library's locale, configure()) is set again by the page.
     */
    async generateBundle(_, bundle) {
      const r = resolved!, ENTRY = `${PREFIX}early-entry.js`;
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
      const vite = earlyPages.size ? await import('vite') : null;
      const rolldown = !!vite && 'rolldownVersion' in vite;
      for (const [rel, code] of earlyPages) {
        const keys = new Set<string>();
        earlyKeys.set(rel, keys);
        const out = await vite!.build({
          configFile: false, root, base: r.base, mode: r.mode, logLevel: 'silent', publicDir: false, define: r.define,
          resolve: { alias: r.resolve.alias, conditions: r.resolve.conditions },
          plugins: [{
            name: 'sinter:early-entry', resolveId: (id) => (id === ENTRY ? '\0' + ENTRY : null), load: (id) => (id === '\0' + ENTRY ? code : null),
            transform(src, id) { if (messages && !id.includes('/node_modules/') && /\.[cm]?[jt]sx?$/.test(id)) for (const k of moduleKeys(src, id).keys) keys.add(k); },
          }],
          build: {
            write: false, minify: r.build.minify, target: r.build.target, modulePreload: false, copyPublicDir: false, reportCompressedSize: false,
            // one file: dynamic imports inlined. Vite 8 bundles with Rolldown (`codeSplitting: false`; it
            // deprecates `inlineDynamicImports`), Vite 6 and 7 with Rollup, which knows only the latter.
            [rolldown ? 'rolldownOptions' : 'rollupOptions']: {
              input: ENTRY,
              // a split early file exports `render` for its stub (an app build drops entry exports by default)
              preserveEntrySignatures: 'strict',
              output: rolldown ? { format: 'es', codeSplitting: false } : { format: 'es', inlineDynamicImports: true },
            },
          },
        });
        const output = (Array.isArray(out) ? out[0] : out) as { output: Array<{ type: string; isEntry?: boolean; code?: string; modules?: Record<string, { renderedLength: number }> }> };
        const chunks = output.output.filter((c) => c.type === 'chunk');
        // only the entry is emitted: another chunk would be an import the early file cannot load
        if (chunks.length !== 1) this.error(`sinter: the early file of ${rel} came out as ${chunks.length} chunks; it must be one file with nothing imported`);
        const chunk = chunks[0]!;
        const name = rel.replace(/(^|\/)index\.html$/, '').replace(/\.html$/, '').replace(/\//g, '-') || 'index';
        const fileName = `${r.build.assetsDir}/${name}-early-${createHash('sha256').update(chunk.code!).digest('base64url').slice(0, 8)}.js`;
        this.emitFile({ type: 'asset', fileName, source: chunk.code! });
        // split: the render-blocking stub imports the early file (one module: the `async` tag already runs it) and renders
        let stub: string | undefined;
        if (splitPages.has(rel)) {
          const source = `import{render}from"./${fileName.slice(fileName.lastIndexOf('/') + 1)}";render();\n`;
          stub = `${r.build.assetsDir}/${name}-render-${createHash('sha256').update(source).digest('base64url').slice(0, 8)}.js`;
          this.emitFile({ type: 'asset', fileName: stub, source });
        }
        earlyFiles.set(rel, { fileName, code: chunk.code!, modules: chunk.modules ?? {}, ...(stub ? { stub } : {}) });
      }
      if (unlisted.size) resolved?.logger.info(`sinter: resources on ${[...unlisted].join(', ')} are requested when the page module runs; list ${unlisted.size > 1 ? 'these origins' : 'the origin'} in sinter({ origins: [...] }) (instead of configure({ origins }): every page adds them) to request them before it`);
      // Speculation Rules for a response header: one file at the site root, under a fixed name
      const rules = spec()?.delivery === 'header' ? rulesJson() : null;
      rulesWritten = !!rules;
      if (rules) this.emitFile({ type: 'asset', fileName: RULES_FILE, source: rules });
      // a morph pending: the first paint waits for the page module (pages that use data-sn-transition)
      holdFile = `${r.build.assetsDir}/sinter-hold-${createHash('sha256').update(HOLD_SCRIPT).digest('base64url').slice(0, 8)}.js`;
      if (holdPages.size) this.emitFile({ type: 'asset', fileName: holdFile, source: HOLD_SCRIPT });
      // the render-blocking fallback, for the pages with an early file and no picker to carry it (emitted at the end)
      paintFile = `${r.build.assetsDir}/sinter-paint-${createHash('sha256').update(PAINT_SCRIPT).digest('base64url').slice(0, 8)}.js`;
      const paint = () => { if ([...earlyFiles.keys()].some((rel) => !languageFiles.has(rel))) this.emitFile({ type: 'asset', fileName: paintFile, source: PAINT_SCRIPT }); };
      if (!messages) return paint();
      // per page and language, the keys the page calls: its markup, the modules of its bundle, its early file
      for (const [rel, own] of markupMessages) {
        const entry = Object.values(bundle).find((c) => c.type === 'chunk' && c.isEntry && c.facadeModuleId === resolve(root, rel));
        const keys = new Set([...own, ...(earlyKeys.get(rel) ?? [])]);
        const seen = new Set<string>(), todo = entry ? [entry.fileName] : [];
        while (todo.length) {
          const c = bundle[todo.pop()!];
          if (!c || c.type !== 'chunk' || seen.has(c.fileName)) continue;
          seen.add(c.fileName);
          for (const id of c.moduleIds) for (const k of moduleMessages.get(id) ?? []) keys.add(k);
          todo.push(...c.imports, ...c.dynamicImports);
        }
        if (!keys.size) continue;
        const name = rel.replace(/(^|\/)index\.html$/, '').replace(/\.html$/, '').replace(/\//g, '-') || 'index';
        const files: Record<string, { fileName: string; code: string }> = {};
        for (const l of messages.locales) {
          const dict: Record<string, string> = {};
          for (const k of [...keys].sort()) dict[k] = messages.dicts[l]?.[k] ?? messages.dicts[messages.base]![k]!;
          const code = languageFile(l, dict);
          const fileName = `${r.build.assetsDir}/${name}-${l}-${createHash('sha256').update(code).digest('base64url').slice(0, 8)}.js`;
          this.emitFile({ type: 'asset', fileName, source: code });
          files[l] = { fileName, code };
        }
        languageFiles.set(rel, files);
      }
      const picker = `${r.build.assetsDir}/sinter-i18n-${createHash('sha256').update(I18N_PICKER).digest('base64url').slice(0, 8)}.js`;
      if (languageFiles.size) this.emitFile({ type: 'asset', fileName: picker, source: I18N_PICKER });
      pickerFile = picker;
      paint();
    },

    transform(code, id) {
      collect(this, code, id);
      return null;
    },

    resolveId(id) {
      // a build with source maps: page modules keep a plain id, as Rolldown drops the map of a `\0` module
      if (id.startsWith(PREFIX) && !dev && maps.has(id)) return id;
      if (id.startsWith(PREFIX)) return '\0' + id;
      return null;
    },

    load(id) {
      if (id.startsWith(`\0${IMG_CSS}`)) return imageCss.get(id.slice(IMG_CSS.length + 1, -4)) ?? '';
      // dev: the picker, and each language's whole dictionary
      if (id === `\0${PREFIX}i18n.js`) return I18N_PICKER;
      if (id === `\0${PREFIX}paint.js`) return PAINT_SCRIPT;
      if (id === `\0${PREFIX}img-check.js`) return IMAGE_CHECK;
      if (id === `\0${PREFETCH}`) return prefetchModule(prefetchPages(), project(root, options).helpers);
      const lang = id.startsWith(`\0${PREFIX}messages/`) && messages ? id.slice(`\0${PREFIX}messages/`.length, -3) : null;
      if (lang && messages?.dicts[lang]) return languageFile(lang, { ...messages.dicts[messages.base], ...messages.dicts[lang] });
      const key = id.startsWith('\0' + PREFIX) ? id.slice(1) : !dev && maps.has(id) ? id : null;
      if (key === null) return null;
      const code = modules.get(key);
      if (code === undefined) throw new Error(`sinter: page module ${key} requested before its HTML was compiled`);
      const map = maps.get(key);
      return map ? { code, map } : code;
    },

    configurePreviewServer(s) {
      s.middlewares.use(rulesMiddleware(() => { try { return readFileSync(resolve(root, resolved!.build.outDir, RULES_FILE), 'utf8'); } catch { return null; } }));
    },

    closeBundle() {
      if (dev) return;
      // inline rules: name what a CSP must allow; header: what the server must send. Once per build
      // pages with a CSP <meta> got the hash: nothing to say. The rest may have a CSP header the build cannot see
      if (speculationHash && unhashedPages) resolved?.logger.info(`sinter: Speculation Rules are inline in the pages: nothing to do without a CSP; a CSP sent as a response header must allow them: add 'inline-speculation-rules' to its script-src (or '${speculationHash}', which changes with the pages). docs/navigation.md`);
      if (rulesWritten) resolved?.logger.info(`sinter: Speculation Rules in ${RULES_FILE}: send \`Speculation-Rules: "${rulesUrl()}"\` with every page and serve the file as application/speculationrules+json (docs/navigation.md)`);
    },

    async buildEnd(error) {
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
        const styles = images && /<img\b|<sn-include\b/i.test(html) ? await stylesOf(html, file, project(root, options)) : undefined;
        let { out, p } = build(html, file, earlySrc, styles);
        // images the compiler did not know yet: analysed, then the page is compiled again with them
        if (images && out.images?.pending.length) {
          await images.analyze(out.images.pending);
          ({ out, p } = build(html, file, earlySrc, styles));
        }
        for (const w of out.remoteWidths ?? []) remoteWidths.add(w);
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
        const errors = out.diagnostics.filter((d) => d.severity === 'error');
        for (const d of out.diagnostics) if (d.severity === 'warning') console.warn(formatDiagnostic(d));
        if (errors.length) {
          const err = new Error(`sinter: ${errors.length} error(s)\n${errors.map(formatDiagnostic).join('\n')}`) as Error & { loc?: unknown; id?: string };
          err.id = errors[0]!.file;
          err.loc = { file: errors[0]!.file, line: errors[0]!.line, column: errors[0]!.col };
          throw err;
        }
        setModule(moduleSrc, out.module, out.map);
        invalidate(moduleSrc);
        invalidate(`${EARLY}${rel}.js`);
        // dev: the picker first in the head, with every language's whole dictionary (else, with an early
        // file, the paint script); a build adds them after bundling
        const base = resolved?.base ?? '/', early = out.early != null;
        // dev: the console warns about images shown with too few pixels
        const checked = dev && images ? out.html.replace('</body>', `<script type="module" src="${base}${PREFIX.slice(1)}img-check.js"></script></body>`) : out.html;
        // Speculation Rules for links to the app's pages: the browser fetches (or prerenders) the next page
        const rules = speculationTag(), page = rules ? withRulesHash(checked.replace('</head>', `  ${rules}\n</head>`), speculationHash!) : checked;
        if (rules && !dev && !hasCspMeta(checked)) unhashedPages++;
        if (dev && out.messages && messages) {
          for (const f of Object.values(messages.files)) watch(f);
          const tag = pickerTag(`${base}${PREFIX.slice(1)}i18n.js`, Object.fromEntries(messages.locales.map((l) => [l, `${base}${PREFIX.slice(1)}messages/${l}.js`])), early);
          return page.replace(/<head[^>]*>/, (h) => h + tag);
        }
        if (dev && early) return page.replace(/<head[^>]*>/, (h) => h + paintTag(`${base}${PREFIX.slice(1)}paint.js`));
        return page;
      },
    },
  };

  // After bundling: the early file's tag (render-blocking, before the page module, where Vite's
  // HTML processing cannot merge it into the page entry) and its size.
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
        const rel = relOf(ctx.filename), early = earlyFiles.get(rel), langs = languageFiles.get(rel);
        // a relative base: URLs relative to the page, as Vite writes its own (`../assets/…` from `blog/post.html`)
        const base = pageBase(resolved?.base ?? '/', rel);
        // the page bundle is `async`: it does not wait for the stylesheets as a deferred module does,
        // and mounts once the document is parsed and the early file has rendered (see the page module)
        if (ctx.chunk) html = html.replace(`<script type="module" crossorigin src="${base}${ctx.chunk.fileName}">`, (t) => t.slice(0, -1) + ' async>');
        const hold = holdPages.has(rel);
        if (!early && !langs && !hold) return html;
        const tags: string[] = [];
        // before the page module's tag, which it changes as the parser inserts it
        if (hold) tags.push(`<script src="${attr(base + holdFile)}"></script>`);
        // the picker before the early file: it runs while the head is parsed, so the language file it adds blocks the first paint too;
        // it (or, without messages, the paint script) also holds the first paint where `blocking` is not supported
        if (langs) tags.push(pickerTag(base + pickerFile, Object.fromEntries(Object.entries(langs).map(([l, f]) => [l, base + f.fileName])), !!early));
        else if (early) tags.push(paintTag(base + paintFile));
        // a split early file renders from its stub, here; the file itself is loaded `async` before the stylesheets (below)
        if (early) tags.push(`<script type="module" crossorigin src="${attr(base + (early.stub ?? early.fileName))}" blocking="render"></script>`);
        if (early || langs) report(rel, early ?? null, langs ?? null);
        const at = html.search(/<script type="module"|<link rel="modulepreload"/);
        const block = tags.join('\n    ');
        html = at >= 0 ? html.slice(0, at) + block + '\n    ' + html.slice(at) : html.replace('</head>', `    ${block}\n  </head>`);
        if (!early?.stub) return html;
        // the split early file first in the head, before the stylesheets and the classic scripts that wait for them, so
        // the parser creates it at once; `async`, so it runs (and starts the page's requests) as soon as it has loaded
        const first = html.search(/<link\b[^>]*\brel=["']?stylesheet|<script\b/i);
        const tag = `<script type="module" crossorigin src="${attr(base + early.fileName)}" async></script>`;
        return first < 0 ? html.replace('</head>', `  ${tag}\n</head>`) : html.slice(0, first) + tag + '\n  ' + html.slice(first);
      },
    },
  };

  /** One line per page: the early file's size (gzip) and its language files'; over the budget a warning naming the largest modules. */
  function report(rel: string, early: { fileName: string; code: string; modules: Record<string, { renderedLength: number }> } | null, langs: Record<string, { code: string }> | null) {
    const kb = (n: number) => `${(n / 1000).toFixed(1)} kB`;
    const gz = early ? gzipSync(early.code).length : 0;
    const files = langs ? `, messages ${Object.entries(langs).map(([l, f]) => `${l} ${kb(gzipSync(f.code).length)}`).join(', ')} gzip` : '';
    const line = `sinter: early file of ${rel}: ${early ? `${early.fileName} ${kb(gz)} gzip` : 'none'}${files}`;
    const logger = resolved?.logger;
    if (!early || gz <= budget) { logger?.info(line); return; }
    const top = Object.entries(early.modules).sort((a, b) => b[1].renderedLength - a[1].renderedLength).slice(0, 5)
      .map(([id, m]) => `${id.includes(PREFIX) ? `the early bindings of ${rel}` : relative(root, id.replace(/^\0/, '')).split(sep).join('/')} ${kb(m.renderedLength)}`);
    const msg = `${line}, over the early budget of ${kb(budget)}. It renders before the first paint: keep heavy imports out of src/sinter.early.ts and of the helpers early bindings call. Largest (before gzip): ${top.join(', ')}`;
    if (logger) logger.warn(msg); else console.warn(msg);
  }

  // Google Fonts as the app's own CSS (`fonts`, on by default; see fonts-build.ts)
  const fontSheets = new Map<string, string>();
  let downloadFont: ((url: string) => Promise<string | null>) | null = null;
  const fonts: Plugin = {
    name: 'sinter:fonts',
    enforce: 'pre',
    apply: 'build',
    transformIndexHtml: {
      order: 'pre',
      async handler(html) {
        if (options.fonts?.inline === false) return html;
        downloadFont ??= fontDownloader(resolve(root, 'node_modules/.cache/sinter/fonts'));
        const out = await inlineFonts(html, downloadFont);
        for (const [id, url] of out.ids) fontSheets.set(id, url);
        for (const url of out.failed) resolved?.logger.warn(`sinter: could not download ${url}; the page keeps the link (sinter({ fonts: { inline: false } }) turns this off)`);
        return out.html;
      },
    },
    resolveId: (id) => (fontSheets.has(id) ? id : null),
    async load(id) {
      const url = fontSheets.get(id);
      return url ? ((await downloadFont!(url)) ?? '') : null;
    },
  };
  return [main, post, cssImages, fonts];
}
