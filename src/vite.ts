// Vite adapter: a thin wrapper around compile(). Every HTML entry is compiled
// in transformIndexHtml; its page module is served as a virtual module.
import { createHash } from 'node:crypto';
import { relative, resolve, sep } from 'node:path';
import type { Plugin, ResolvedConfig, ViteDevServer } from 'vite';
import { compile, formatDiagnostic, FIRST_PAINT_SCRIPT, type CheckUnit, type FirstPaintOptions } from './compiler/index.js';
import { project, type ProjectOptions } from './project.js';

export interface SinterOptions extends ProjectOptions {
  /** run `sinter check` at the end of `vite build` and fail it on type errors (needs TypeScript) */
  typecheck?: boolean;
  /**
   * first paint (default true): bindings whose value is known at build time are written into the
   * HTML; locale text and persisted controls come from a small render-blocking script. `false`
   * leaves every binding to the page module.
   */
  firstPaint?: boolean;
  /** the app's locales, when the browser picks one (see SinterLocale) */
  locale?: SinterLocale;
}

/**
 * How the page picks its locale before any script of the app has run: the stored choice, then
 * the browser's languages, then the first locale. The first-paint script sets `<html lang>` to
 * it; the app reads `document.documentElement.lang` to start its i18n library in the same one.
 */
export interface SinterLocale {
  /** supported locales; the first is the fallback the HTML is written in */
  locales: string[];
  /** localStorage key holding the visitor's choice (a plain locale string, e.g. `de`) */
  storage?: string;
  /** use `navigator.languages` when nothing is stored (default true) */
  navigator?: boolean;
  /**
   * module (root-relative) with a function that switches the helpers' locale at build time, as
   * `path` (its default export) or `path#name`; e.g. paraglide's `src/paraglide/runtime.js#setLocale`.
   * Without it, with several locales, bindings that call helpers wait for the page module.
   */
  use?: string;
}

const PREFIX = '/@sinter/';
const FIRST_PAINT_ID = `${PREFIX}first-paint.js`;
const FIRST_PAINT_HASH = createHash('sha256').update(FIRST_PAINT_SCRIPT).digest('hex').slice(0, 8);

/** The helpers module and the locale switch, loaded in Node for first paint. */
type Loaded = { helpers: Record<string, unknown> | null; use: ((locale: string) => void) | null };

export default function sinter(options: SinterOptions = {}): Plugin & { api: { options: SinterOptions } } {
  let root = process.cwd();
  let dev = false;
  let server: ViteDevServer | null = null;
  let resolved: ResolvedConfig | null = null;
  /** a module server of its own for `vite build`, to load the helpers in Node */
  let loader: ViteDevServer | null = null;
  let loading: Promise<Loaded> | null = null;
  let firstPaintUsed = false;
  const warned = new Set<string>();
  const warnOnce = (m: string) => { if (!warned.has(m)) { warned.add(m); console.warn(m); } };
  const locale = checkLocale(options.locale);

  const loadModule = async (file: string): Promise<Record<string, unknown>> => {
    if (server) return server.ssrLoadModule(file);
    if (!loader) {
      const { createServer } = await import('vite');
      loader = await createServer({
        configFile: false, root, logLevel: 'silent', appType: 'custom', plugins: [], resolve: { alias: resolved?.resolve.alias ?? [] },
        server: { middlewareMode: true, hmr: false, ws: false, watch: null }, optimizeDeps: { noDiscovery: true, include: [] },
      });
    }
    return loader.ssrLoadModule(file);
  };

  /** helpers and the locale switch; failures leave the bindings that need them to the page module */
  const loadFirstPaint = async (helpersFile: string | null): Promise<Loaded> => {
    let helpers: Record<string, unknown> | null = null, use: Loaded['use'] = null;
    if (helpersFile) {
      try { helpers = await loadModule(helpersFile); } catch (e) {
        warnOnce(`sinter: first paint: the helpers module cannot be loaded in Node (${(e as Error).message.split('\n')[0]}); bindings that call helpers render when the page module runs`);
      }
    }
    if (locale?.use) {
      const [path, name = 'default'] = locale.use.split('#') as [string, string?];
      try {
        const fn = (await loadModule(resolve(root, path)))[name];
        if (typeof fn !== 'function') throw new Error(`\`${name}\` is not a function`);
        use = fn as (l: string) => void;
      } catch (e) {
        warnOnce(`sinter: first paint: locale.use \`${locale.use}\` cannot be loaded (${(e as Error).message.split('\n')[0]}); bindings that call helpers render when the page module runs`);
      }
    }
    return { helpers, use };
  };
  const modules = new Map<string, string>();
  const watched = new Set<string>();
  const units = new Map<string, CheckUnit>();

  const watch = (file: string) => {
    if (watched.has(file)) return;
    watched.add(file);
    server?.watcher.add(file);
  };

  return {
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

    resolveId(id) {
      if (id.startsWith(PREFIX)) return '\0' + id;
      return null;
    },

    load(id) {
      if (id === '\0' + FIRST_PAINT_ID) return FIRST_PAINT_SCRIPT;
      if (!id.startsWith('\0' + PREFIX)) return null;
      const code = modules.get(id.slice(1));
      if (code === undefined) throw new Error(`sinter: page module ${id.slice(1)} requested before its HTML was compiled`);
      return code;
    },

    generateBundle() {
      if (!firstPaintUsed) return;
      this.emitFile({ type: 'asset', fileName: `${resolved!.build.assetsDir}/sinter-first-paint-${FIRST_PAINT_HASH}.js`, source: FIRST_PAINT_SCRIPT });
    },

    async closeBundle() {
      const l = loader;
      loader = null;
      loading = null;
      await l?.close();
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
      async handler(html, ctx) {
        const file = ctx.filename;
        const rel = relative(root, file).split(sep).join('/');
        const moduleSrc = `${PREFIX}${rel}.js`;
        const p = project(root, options);
        if (p.diagnostics.length) throw new Error(`sinter: ${p.diagnostics.map(formatDiagnostic).join('\n')}`);
        let firstPaint: FirstPaintOptions | undefined;
        if (options.firstPaint !== false) {
          // the dev server reloads changed helpers itself; a build loads them once
          const loaded = await (dev ? loadFirstPaint(p.helpersFile) : (loading ??= loadFirstPaint(p.helpersFile)));
          const base = resolved?.base ?? '/';
          firstPaint = {
            helpers: loaded.helpers,
            locale: locale ? { ...locale, use: loaded.use } : null,
            // `vite-ignore`: a classic script Vite leaves as it is
            script: { src: dev ? `${base}${FIRST_PAINT_ID.slice(1)}` : `${base}${resolved!.build.assetsDir}/sinter-first-paint-${FIRST_PAINT_HASH}.js`, attrs: { 'vite-ignore': '' } },
          };
        }
        const out = compile(html, {
          file, root, dev, helpers: p.helpers, actions: p.actions, moduleSrc, config: p.config, readFile: p.readFile,
          check: !!options.typecheck && !dev, openapi: p.openapi, complexity: p.complexity, checkCycles: p.checkCycles,
          ...(firstPaint ? { firstPaint } : {}),
        });
        if (out.firstPaint) firstPaintUsed = true;
        if (out.check) units.set(file, out.check);
        for (const f of out.files) watch(f);
        if (p.helpersFile) watch(p.helpersFile);
        if (p.actionsFile) watch(p.actionsFile);
        const errors = out.diagnostics.filter((d) => d.severity === 'error');
        for (const d of out.diagnostics) if (d.severity === 'warning') console.warn(formatDiagnostic(d));
        if (errors.length) {
          const err = new Error(`sinter: ${errors.length} error(s)\n${errors.map(formatDiagnostic).join('\n')}`) as Error & { loc?: unknown; id?: string };
          err.id = errors[0]!.file;
          err.loc = { file: errors[0]!.file, line: errors[0]!.line, column: errors[0]!.col };
          throw err;
        }
        modules.set(moduleSrc, out.module);
        server?.moduleGraph.getModuleById('\0' + moduleSrc) && server.moduleGraph.invalidateModule(server.moduleGraph.getModuleById('\0' + moduleSrc)!);
        return out.html;
      },
    },
  };
}

/** The `locale` option, refused when it names no locales or a value of the wrong type. */
function checkLocale(l: SinterLocale | undefined): SinterLocale | null {
  if (l == null) return null;
  const bad = (m: string): never => { throw new Error(`sinter: locale: ${m}`); };
  if (typeof l !== 'object') bad("takes an object, e.g. `{ locales: ['en', 'de'], storage: 'locale' }`");
  if (!Array.isArray(l.locales) || !l.locales.length || !l.locales.every((x) => typeof x === 'string' && /^[A-Za-z]{2,8}(-[A-Za-z0-9]{1,8})*$/.test(x))) bad('`locales` is a non-empty list of language tags, the fallback first');
  for (const k of Object.keys(l)) if (!['locales', 'storage', 'navigator', 'use'].includes(k)) bad(`\`${k}\` is not an option; the options are \`locales\`, \`storage\`, \`navigator\` and \`use\``);
  if (l.storage !== undefined && (typeof l.storage !== 'string' || !l.storage)) bad('`storage` is a localStorage key');
  if (l.navigator !== undefined && typeof l.navigator !== 'boolean') bad('`navigator` is true or false');
  if (l.use !== undefined && (typeof l.use !== 'string' || !l.use)) bad("`use` is a module path, optionally with `#export`, e.g. `src/paraglide/runtime.js#setLocale`");
  return l;
}
