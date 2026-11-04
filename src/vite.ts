// Vite adapter: a thin wrapper around compile(). Every HTML entry is compiled
// in transformIndexHtml; its page module is served as a virtual module.
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';
import type { Plugin, ViteDevServer } from 'vite';
import { compile, formatDiagnostic, readHelperManifest, type HelperManifest } from './compiler/index.js';

export interface SinterOptions {
  /** helpers module, relative to the Vite root (default `src/sinter.helpers.js`, or `.ts`) */
  helpers?: string;
  /** app configuration module imported before mount (default `src/sinter.config.js`, or `.ts`) */
  config?: string;
}

const PREFIX = '/@sinter/';

export default function sinter(options: SinterOptions = {}): Plugin {
  let root = process.cwd();
  let dev = false;
  let server: ViteDevServer | null = null;
  const modules = new Map<string, string>();
  const watched = new Set<string>();

  const find = (given: string | undefined, base: string): string | null => {
    const candidates = given ? [given] : [`${base}.js`, `${base}.ts`];
    for (const c of candidates) if (existsSync(resolve(root, c))) return c;
    return null;
  };

  /** Reads a file only if it resolves inside the root, symlinks included. */
  const readInRoot = (path: string): string => {
    const real = realpathSync(path);
    const realRoot = realpathSync(root);
    if (real !== realRoot && !real.startsWith(realRoot + sep)) throw new Error(`outside the project root: ${path}`);
    return readFileSync(real, 'utf8');
  };

  const manifest = (): { helpers: HelperManifest; file: string | null } => {
    const rel = find(options.helpers, 'src/sinter.helpers');
    if (!rel) return { helpers: { module: null, names: [], namespaces: {} }, file: null };
    const file = resolve(root, rel);
    const helpers = readHelperManifest(readFileSync(file, 'utf8'), {
      module: '/' + rel.split(sep).join('/'),
      file,
      readFile: readInRoot,
      resolve: (spec, from) => {
        if (!spec.startsWith('.')) return null;
        const base = resolve(dirname(from), spec);
        for (const p of [base, base.replace(/\.js$/, '.ts'), `${base}.js`, `${base}.ts`]) if (existsSync(p)) return p;
        return null;
      },
    });
    return { helpers, file };
  };

  const watch = (file: string) => {
    if (watched.has(file)) return;
    watched.add(file);
    server?.watcher.add(file);
  };

  return {
    name: 'sinter',
    enforce: 'pre',

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

    transformIndexHtml: {
      order: 'pre',
      handler(html, ctx) {
        const file = ctx.filename;
        const rel = relative(root, file).split(sep).join('/');
        const moduleSrc = `${PREFIX}${rel}.js`;
        const { helpers, file: helpersFile } = manifest();
        const configRel = find(options.config, 'src/sinter.config');
        const out = compile(html, {
          file, root, dev, helpers, moduleSrc,
          config: configRel ? '/' + configRel.split(sep).join('/') : null,
          readFile: readInRoot,
        });
        for (const f of out.files) watch(f);
        if (helpersFile) watch(helpersFile);
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
