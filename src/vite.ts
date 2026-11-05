// Vite adapter: a thin wrapper around compile(). Every HTML entry is compiled
// in transformIndexHtml; its page module is served as a virtual module.
import { relative, sep } from 'node:path';
import type { Plugin, ViteDevServer } from 'vite';
import { compile, formatDiagnostic, type CheckUnit } from './compiler/index.js';
import { project, type ProjectOptions } from './project.js';

export interface SinterOptions extends ProjectOptions {
  /** run `sinter check` at the end of `vite build` and fail it on type errors (needs TypeScript) */
  typecheck?: boolean;
}

const PREFIX = '/@sinter/';

export default function sinter(options: SinterOptions = {}): Plugin & { api: { options: SinterOptions } } {
  let root = process.cwd();
  let dev = false;
  let server: ViteDevServer | null = null;
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
      if (!id.startsWith('\0' + PREFIX)) return null;
      const code = modules.get(id.slice(1));
      if (code === undefined) throw new Error(`sinter: page module ${id.slice(1)} requested before its HTML was compiled`);
      return code;
    },

    async buildEnd(error) {
      if (error || !options.typecheck || dev || !units.size) return;
      const { check } = await import('./check/index.js');
      const p = project(root, options);
      const r = check({ root, units: [...units.values()], helpers: p.helpers, types: p.types });
      units.clear();
      if (r.diagnostics.length) this.error(`sinter check: ${r.diagnostics.length} type error(s)\n${r.diagnostics.map(formatDiagnostic).join('\n')}`);
    },

    transformIndexHtml: {
      order: 'pre',
      handler(html, ctx) {
        const file = ctx.filename;
        const rel = relative(root, file).split(sep).join('/');
        const moduleSrc = `${PREFIX}${rel}.js`;
        const p = project(root, options);
        const out = compile(html, {
          file, root, dev, helpers: p.helpers, moduleSrc, config: p.config, readFile: p.readFile,
          check: !!options.typecheck && !dev,
        });
        if (out.check) units.set(file, out.check);
        for (const f of out.files) watch(f);
        if (p.helpersFile) watch(p.helpersFile);
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
