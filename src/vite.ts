// Vite adapter: a thin wrapper around compile(). Every HTML entry is compiled
// in transformIndexHtml; its page module is served as a virtual module. With
// first paint on, each page also gets an early chunk: a second entry, loaded
// render-blocking before the page module, that renders what needs no data.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';
import { gzipSync } from 'node:zlib';
import type { Plugin, ResolvedConfig, ViteDevServer } from 'vite';
import { compile, formatDiagnostic, type CheckUnit, type CompileResult } from './compiler/index.js';
import { project, type ProjectOptions } from './project.js';
import { I18N_PICKER, languageFile, moduleKeys, type MessagesProject } from './i18n-build.js';
import { PAINT_SCRIPT } from './paint-build.js';
import { loadImages, MIME, type Images } from './images.js';
import type { ImageHost, ImageVariant } from './compiler/index.js';

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
  images?: false | { widths?: number[] };
}

type SinterPlugins = [Plugin & { api: { options: SinterOptions } }, Plugin];

const PREFIX = '/@sinter/';
const EARLY = `${PREFIX}early/`;
/** the page's image rules (a CSS module the page module imports) */
const IMG_CSS = `${PREFIX}img-css/`;
/** dev: where the image variants are served */
const IMG = `${PREFIX}img/`;

export default function sinter(options: SinterOptions = {}): SinterPlugins {
  let root = process.cwd();
  let dev = false;
  let server: ViteDevServer | null = null;
  let resolved: ResolvedConfig | null = null;
  const modules = new Map<string, string>();
  const watched = new Set<string>();
  const units = new Map<string, CheckUnit>();
  const firstPaint = options.firstPaint !== false;
  let pickerFile = '';
  let paintFile = '';
  /** build: the pages with an early module, and each one's bundled early file */
  const earlyPages = new Map<string, string>();
  const earlyFiles = new Map<string, { fileName: string; code: string; modules: Record<string, { renderedLength: number }> }>();
  const budget = options.earlyBudget ?? 10_000;
  /** built-in messages: keys each module calls (`m.key`), keys each page's markup calls, and each page's language files */
  const moduleMessages = new Map<string, string[]>();
  const markupMessages = new Map<string, string[]>();
  const languageFiles = new Map<string, Record<string, { fileName: string; code: string }>>();
  let messages: MessagesProject | null = null;
  let images: Images | null = null;
  /** image variants by file name, and each page's image rules */
  const variants = new Map<string, ImageVariant>();
  const imageCss = new Map<string, string>();
  const imageHost = (rel: string): ImageHost | undefined => {
    if (!images) return undefined;
    const img = images, base = resolved?.base ?? '/';
    const prefix = dev ? `${base}${IMG.slice(1)}` : `${base}${resolved!.build.assetsDir}/`;
    const widths = options.images ? options.images.widths : undefined;
    return { info: (f) => img.info(f), url: (v) => prefix + img.fileName(v), ignore: true, stylesheet: `${IMG_CSS}${rel}.css`, ...(widths ? { widths } : {}) };
  };
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

  /** compiles one page; `earlySrc`: where the page loads its early chunk (dev), else the build injects the tag */
  const build = (html: string, file: string, earlySrc: string | null): { out: CompileResult; p: ReturnType<typeof project> } => {
    const rel = relOf(file);
    const p = project(root, options);
    if (p.diagnostics.length) throw new Error(`sinter: ${p.diagnostics.map(formatDiagnostic).join('\n')}`);
    const out = compile(html, {
      file, root, dev, helpers: p.helpers, actions: p.actions, moduleSrc: `${PREFIX}${rel}.js`, config: p.config, readFile: p.readFile,
      check: !!options.typecheck && !dev, openapi: p.openapi, complexity: p.complexity, checkCycles: p.checkCycles,
      ...(images ? { images: imageHost(rel)! } : {}),
      ...(firstPaint ? { prerender: true, early: { module: p.early, src: earlySrc } } : {}),
    });
    if (out.early) modules.set(`${EARLY}${rel}.js`, out.early);
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
      // an HTML, partial or helpers change triggers a full reload in v0.1
      s.watcher.on('change', (file) => {
        if (watched.has(file)) s.ws.send({ type: 'full-reload' });
      });
    },

    /** build: the pages that have something to run early (bundled into one file each in generateBundle) */
    buildStart(input) {
      earlyPages.clear();
      earlyFiles.clear();
      languageFiles.clear();
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
        earlyFiles.set(rel, { fileName, code: chunk.code!, modules: chunk.modules ?? {} });
      }
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
      if (id.startsWith(PREFIX)) return '\0' + id;
      return null;
    },

    load(id) {
      if (id.startsWith(`\0${IMG_CSS}`)) return imageCss.get(id.slice(IMG_CSS.length + 1, -4)) ?? '';
      // dev: the picker, and each language's whole dictionary
      if (id === `\0${PREFIX}i18n.js`) return I18N_PICKER;
      if (id === `\0${PREFIX}paint.js`) return PAINT_SCRIPT;
      const lang = id.startsWith(`\0${PREFIX}messages/`) && messages ? id.slice(`\0${PREFIX}messages/`.length, -3) : null;
      if (lang && messages?.dicts[lang]) return languageFile(lang, { ...messages.dicts[messages.base], ...messages.dicts[lang] });
      if (!id.startsWith('\0' + PREFIX)) return null;
      const code = modules.get(id.slice(1));
      if (code === undefined) throw new Error(`sinter: page module ${id.slice(1)} requested before its HTML was compiled`);
      return code;
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
        let { out, p } = build(html, file, earlySrc);
        // images the compiler did not know yet: analysed, then the page is compiled again with them
        if (images && out.images?.pending.length) {
          await images.analyze(out.images.pending);
          ({ out, p } = build(html, file, earlySrc));
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
        const errors = out.diagnostics.filter((d) => d.severity === 'error');
        for (const d of out.diagnostics) if (d.severity === 'warning') console.warn(formatDiagnostic(d));
        if (errors.length) {
          const err = new Error(`sinter: ${errors.length} error(s)\n${errors.map(formatDiagnostic).join('\n')}`) as Error & { loc?: unknown; id?: string };
          err.id = errors[0]!.file;
          err.loc = { file: errors[0]!.file, line: errors[0]!.line, column: errors[0]!.col };
          throw err;
        }
        modules.set(moduleSrc, out.module);
        invalidate(moduleSrc);
        invalidate(`${EARLY}${rel}.js`);
        // dev: the picker first in the head, with every language's whole dictionary (else, with an early
        // file, the paint script); a build adds them after bundling
        const base = resolved?.base ?? '/', early = out.early != null;
        if (dev && out.messages && messages) {
          for (const f of Object.values(messages.files)) watch(f);
          const tag = pickerTag(`${base}${PREFIX.slice(1)}i18n.js`, Object.fromEntries(messages.locales.map((l) => [l, `${base}${PREFIX.slice(1)}messages/${l}.js`])), early);
          return out.html.replace(/<head[^>]*>/, (h) => h + tag);
        }
        if (dev && early) return out.html.replace(/<head[^>]*>/, (h) => h + paintTag(`${base}${PREFIX.slice(1)}paint.js`));
        return out.html;
      },
    },
  };

  // After bundling: the early file's tag (render-blocking, before the page module, where Vite's
  // HTML processing cannot merge it into the page entry) and its size.
  const post: Plugin = {
    name: 'sinter:early',
    enforce: 'post',
    apply: 'build',
    transformIndexHtml: {
      order: 'post',
      handler(html, ctx) {
        const rel = relOf(ctx.filename), early = earlyFiles.get(rel), langs = languageFiles.get(rel);
        const base = resolved?.base ?? '/';
        // the page bundle is `async`: it does not wait for the stylesheets as a deferred module does,
        // and mounts once the document is parsed and the early file has rendered (see the page module)
        if (ctx.chunk) html = html.replace(`<script type="module" crossorigin src="${base}${ctx.chunk.fileName}">`, (t) => t.slice(0, -1) + ' async>');
        if (!early && !langs) return html;
        const tags: string[] = [];
        // the picker before the early file: it runs while the head is parsed, so the language file it adds blocks the first paint too;
        // it (or, without messages, the paint script) also holds the first paint where `blocking` is not supported
        if (langs) tags.push(pickerTag(base + pickerFile, Object.fromEntries(Object.entries(langs).map(([l, f]) => [l, base + f.fileName])), !!early));
        else if (early) tags.push(paintTag(base + paintFile));
        if (early) tags.push(`<script type="module" crossorigin src="${attr(base + early.fileName)}" blocking="render"></script>`);
        report(rel, early ?? null, langs ?? null);
        const at = html.search(/<script type="module"|<link rel="modulepreload"/);
        const block = tags.join('\n    ');
        return at >= 0 ? html.slice(0, at) + block + '\n    ' + html.slice(at) : html.replace('</head>', `    ${block}\n  </head>`);
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

  return [main, post];
}
