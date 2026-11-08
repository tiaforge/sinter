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
}

type SinterPlugins = [Plugin & { api: { options: SinterOptions } }, Plugin];

const PREFIX = '/@sinter/';
const EARLY = `${PREFIX}early/`;

export default function sinter(options: SinterOptions = {}): SinterPlugins {
  let root = process.cwd();
  let dev = false;
  let server: ViteDevServer | null = null;
  let resolved: ResolvedConfig | null = null;
  const modules = new Map<string, string>();
  const watched = new Set<string>();
  const units = new Map<string, CheckUnit>();
  const firstPaint = options.firstPaint !== false;
  /** build: the pages with an early module, and each one's bundled early file */
  const earlyPages = new Map<string, string>();
  const earlyFiles = new Map<string, { fileName: string; code: string; modules: Record<string, { renderedLength: number }> }>();
  const budget = options.earlyBudget ?? 10_000;

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
      ...(firstPaint ? { prerender: true, early: { module: p.early, src: earlySrc } } : {}),
    });
    if (out.early) modules.set(`${EARLY}${rel}.js`, out.early);
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

    configResolved(config) {
      root = config.root;
      dev = config.command === 'serve';
      resolved = config;
    },

    configureServer(s) {
      server = s;
      // an HTML, partial or helpers change triggers a full reload in v0.1
      s.watcher.on('change', (file) => {
        if (watched.has(file)) s.ws.send({ type: 'full-reload' });
      });
    },

    /** build: the pages that have something to run early (bundled into one file each in generateBundle) */
    buildStart(input) {
      earlyPages.clear();
      earlyFiles.clear();
      if (dev || !firstPaint) return;
      const list = typeof input.input === 'string' ? [input.input] : Array.isArray(input.input) ? input.input : Object.values(input.input ?? {});
      for (const entry of list) {
        if (!entry.endsWith('.html')) continue;
        const file = resolve(root, entry);
        try {
          const { out } = build(readFileSync(file, 'utf8'), file, null);
          if (out.early) earlyPages.set(relOf(file), out.early);
        } catch { /* reported when the page itself is compiled */ }
      }
    },

    /**
     * build: each page's early module bundled on its own into one file, with nothing imported, so
     * the first paint waits for one request. Modules it shares with the page bundle are copies:
     * state the app sets early (an i18n library's locale, configure()) is set again by the page.
     */
    async generateBundle() {
      if (!earlyPages.size) return;
      const vite = await import('vite');
      const r = resolved!, ENTRY = `${PREFIX}early-entry.js`;
      for (const [rel, code] of earlyPages) {
        const out = await vite.build({
          configFile: false, root, base: r.base, mode: r.mode, logLevel: 'silent', publicDir: false, define: r.define,
          resolve: { alias: r.resolve.alias, conditions: r.resolve.conditions },
          plugins: [{ name: 'sinter:early-entry', resolveId: (id) => (id === ENTRY ? '\0' + ENTRY : null), load: (id) => (id === '\0' + ENTRY ? code : null) }],
          build: {
            write: false, minify: r.build.minify, target: r.build.target, modulePreload: false, copyPublicDir: false, reportCompressedSize: false,
            rollupOptions: { input: ENTRY, output: { format: 'es', inlineDynamicImports: true } },
          },
        });
        const output = (Array.isArray(out) ? out[0] : out) as { output: Array<{ type: string; isEntry?: boolean; code?: string; modules?: Record<string, { renderedLength: number }> }> };
        const chunk = output.output.find((c) => c.type === 'chunk' && c.isEntry)!;
        const name = rel.replace(/(^|\/)index\.html$/, '').replace(/\.html$/, '').replace(/\//g, '-') || 'index';
        const fileName = `${r.build.assetsDir}/${name}-early-${createHash('sha256').update(chunk.code!).digest('base64url').slice(0, 8)}.js`;
        this.emitFile({ type: 'asset', fileName, source: chunk.code! });
        earlyFiles.set(rel, { fileName, code: chunk.code!, modules: chunk.modules ?? {} });
      }
    },

    resolveId(id) {
      if (id.startsWith(PREFIX)) return '\0' + id;
      return null;
    },

    load(id) {
      if (!id.startsWith('\0' + PREFIX)) return null;
      const code = modules.get(id.slice(1));
      if (code === undefined) throw new Error(`sinter: page module ${id.slice(1)} requested before its HTML was compiled`);
      return code;
    },

    async buildEnd(error) {
      if (error || !options.typecheck || dev || !units.size) return;
      const { check } = await import('./check/index.js');
      const p = project(root, options);
      const r = check({ root, units: [...units.values()], helpers: p.helpers, actions: p.actions, types: p.types, openapi: p.openapi });
      units.clear();
      if (r.diagnostics.length) this.error(`sinter check: ${r.diagnostics.length} type error(s)\n${r.diagnostics.map(formatDiagnostic).join('\n')}`);
    },

    transformIndexHtml: {
      order: 'pre',
      handler(html, ctx) {
        const file = ctx.filename;
        const rel = relOf(file);
        const moduleSrc = `${PREFIX}${rel}.js`;
        // dev: the tag goes in with the page; a build adds it after bundling (see the post plugin)
        const { out, p } = build(html, file, dev ? `${resolved?.base ?? '/'}${EARLY.slice(1)}${rel}.js` : null);
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
        const rel = relOf(ctx.filename), early = earlyFiles.get(rel);
        if (!early) return;
        const src = `${resolved?.base ?? '/'}${early.fileName}`.replace(/[&"<>]/g, (c) => `&#${c.charCodeAt(0)};`);
        const tag = `<script type="module" crossorigin src="${src}" blocking="render"></script>`;
        report(rel, early);
        const at = html.search(/<script type="module"|<link rel="modulepreload"/);
        return at >= 0 ? html.slice(0, at) + tag + '\n    ' + html.slice(at) : html.replace('</head>', `    ${tag}\n  </head>`);
      },
    },
  };

  /** One line per page: the early file's size (gzip); over the budget a warning naming the largest modules. */
  function report(rel: string, early: { fileName: string; code: string; modules: Record<string, { renderedLength: number }> }) {
    const gz = gzipSync(early.code).length;
    const kb = (n: number) => `${(n / 1000).toFixed(1)} kB`;
    const line = `sinter: early file of ${rel}: ${early.fileName} ${kb(gz)} gzip`;
    const logger = resolved?.logger;
    if (gz <= budget) { logger?.info(line); return; }
    const top = Object.entries(early.modules).sort((a, b) => b[1].renderedLength - a[1].renderedLength).slice(0, 5)
      .map(([id, m]) => `${id.includes(PREFIX) ? `the early bindings of ${rel}` : relative(root, id.replace(/^\0/, '')).split(sep).join('/')} ${kb(m.renderedLength)}`);
    const msg = `${line}, over the early budget of ${kb(budget)}. It renders before the first paint: keep heavy imports out of src/sinter.early.ts and of the helpers early bindings call. Largest (before gzip): ${top.join(', ')}`;
    if (logger) logger.warn(msg); else console.warn(msg);
  }

  return [main, post];
}
