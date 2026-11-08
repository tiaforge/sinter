// Vite adapter: a thin wrapper around compile(). Every HTML entry is compiled
// in transformIndexHtml; its page module is served as a virtual module. With
// first paint on, each page also gets an early chunk: a second entry, loaded
// render-blocking before the page module, that renders what needs no data.
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
  /** an early chunk (with the shared chunks it loads) above this many bytes gzip is a build warning (default 10000) */
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

    /** build: one early chunk per page that has something to run early, as an entry of its own */
    buildStart(input) {
      if (dev || !firstPaint) return;
      const list = typeof input.input === 'string' ? [input.input] : Array.isArray(input.input) ? input.input : Object.values(input.input ?? {});
      for (const entry of list) {
        if (!entry.endsWith('.html')) continue;
        const file = resolve(root, entry);
        try {
          const { out } = build(readFileSync(file, 'utf8'), file, null);
          if (!out.early) continue;
          const name = relOf(file).replace(/(^|\/)index\.html$/, '').replace(/\.html$/, '').replace(/\//g, '-') || 'index';
          this.emitFile({ type: 'chunk', id: `${EARLY}${relOf(file)}.js`, name: `${name}-early` });
        } catch { /* reported when the page itself is compiled */ }
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

  // After bundling: the early chunk's tag (render-blocking, before the page module, where Vite's
  // HTML processing cannot merge it into the page entry), its preloads, and its size.
  const post: Plugin = {
    name: 'sinter:early',
    enforce: 'post',
    apply: 'build',
    transformIndexHtml: {
      order: 'post',
      handler(html, ctx) {
        if (!ctx.bundle || !ctx.filename.endsWith('.html')) return;
        const rel = relOf(ctx.filename);
        const chunk = Object.values(ctx.bundle).find((c) => c.type === 'chunk' && c.facadeModuleId === `\0${EARLY}${rel}.js`);
        if (!chunk || chunk.type !== 'chunk') return;
        const base = resolved?.base ?? '/';
        // what loads before the first paint: the chunk and its static imports, transitively
        const loads = [chunk];
        for (let i = 0; i < loads.length; i++) {
          for (const f of loads[i]!.imports) {
            const c = ctx.bundle[f];
            if (c?.type === 'chunk' && !loads.includes(c)) loads.push(c);
          }
        }
        const attr = (v: string) => v.replace(/[&"<>]/g, (c) => `&#${c.charCodeAt(0)};`);
        const tags = [
          ...loads.slice(1).filter((c) => !html.includes(`href="${attr(base + c.fileName)}"`)).map((c) => `<link rel="modulepreload" crossorigin href="${attr(base + c.fileName)}">`),
          `<script type="module" crossorigin src="${attr(base + chunk.fileName)}" blocking="render"></script>`,
        ].join('\n    ');
        report(rel, loads);
        const at = html.search(/<script type="module"|<link rel="modulepreload"/);
        return at >= 0 ? html.slice(0, at) + tags + '\n    ' + html.slice(at) : html.replace('</head>', `    ${tags}\n  </head>`);
      },
    },
  };

  /** One line per page: the early chunk's size (gzip, with the shared chunks it loads); over the budget a warning naming the largest modules. */
  function report(rel: string, loads: Array<{ fileName: string; code: string; modules: Record<string, { renderedLength: number }> }>) {
    const gz = loads.reduce((n, c) => n + gzipSync(c.code).length, 0);
    const kb = (n: number) => `${(n / 1000).toFixed(1)} kB`;
    const line = `sinter: early chunk of ${rel}: ${kb(gz)} gzip (${loads.length} file${loads.length > 1 ? 's' : ''})`;
    const logger = resolved?.logger;
    if (gz <= budget) { logger?.info(line); return; }
    const top = loads.flatMap((c) => Object.entries(c.modules)).sort((a, b) => b[1].renderedLength - a[1].renderedLength).slice(0, 5)
      .map(([id, m]) => `${id.includes(EARLY) ? `the early bindings of ${rel}` : relative(root, id.replace(/^\0/, '')).split(sep).join('/')} ${kb(m.renderedLength)}`);
    const msg = `${line}, over the early budget of ${kb(budget)}. It renders before the first paint: keep heavy imports out of src/sinter.early.ts and of the helpers early bindings call. Largest (minified, before gzip): ${top.join(', ')}`;
    if (logger) logger.warn(msg); else console.warn(msg);
  }

  return [main, post];
}
