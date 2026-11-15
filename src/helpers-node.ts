// The helpers module in Node (docs/spec.md, Helpers at build time): loaded before compiling, which
// stays synchronous, so that helper calls over build-time constants can run in the compiler. It is
// loaded through Vite with the app's own config, so its aliases and plugins apply: by the dev
// server's SSR environment in dev, else (the build, `sinter check`, `sinter lsp`) by a short-lived
// Vite server over the app's config file, in which sinter's own plugin stays inert. A module that
// fails to load in Node folds nothing, with one warning (SN533). Beside the module, each helper's
// verdict from the static check (fold-check.ts): whether its calls may run at build time at all.
import { relative, sep } from 'node:path';
import type { ViteDevServer } from 'vite';
import type { HelperManifest } from './compiler/compile.js';
import { FoldCache, foldVerdicts, type FoldVerdict } from './fold-check.js';

/** set while sinter loads a helpers module through a Vite server of its own: that server's sinter plugin does nothing */
const LOADING = Symbol.for('sinter.helpers.loading');
export const loadingHelpers = () => ((globalThis as Record<symbol, number>)[LOADING] ?? 0) > 0;

export interface NodeHelpers {
  /** the module's exports, or null: no helpers module, or it could not be loaded (`error`) */
  module: Record<string, unknown> | null;
  /** why it could not be loaded (SN533), or null */
  error: string | null;
  /** per helper, by the name compiled code calls (`fmt`, `ns$member`): may its calls run at build time */
  fold: Map<string, FoldVerdict>;
  /** the app's files the static check read (the helpers module and what it reaches): a change in one reloads */
  files: string[];
}

export interface LoadOptions {
  root: string;
  helpersFile: string | null;
  manifest: HelperManifest;
  /** the dev server: the module loads in its SSR environment (and is invalidated as any module there) */
  server?: ViteDevServer | null;
  /** the app's Vite config file (default: found in `root`), and the mode (default `production`) */
  configFile?: string | false;
  mode?: string;
  /** with `configFile: false` (a Vite started with an inline config): the aliases it resolved */
  alias?: unknown;
  /** the static check's per-module analyses, kept across loads (the language server) */
  cache?: FoldCache;
  /**
   * load packages through Vite too, not Node's own module cache, which every load in the process shares: an
   * instance of the module and of everything it imports of its own (the build's cross-check)
   */
  fresh?: boolean;
}

/** Loads the helpers module in Node and checks what of it may fold. Never throws: a failure is `error`. */
export async function loadHelpers(o: LoadOptions): Promise<NodeHelpers> {
  const cache = o.cache ?? new FoldCache();
  const check = () => {
    let fold = new Map<string, FoldVerdict>();
    try { fold = foldVerdicts(o.manifest, o.root, o.helpersFile, cache); } catch { /* nothing folds */ }
    return { fold, files: [...cache.modules.keys()].filter((f) => !f.includes(`${sep}node_modules${sep}`)) };
  };
  if (!o.helpersFile) return { module: null, error: null, ...check() };
  // the app's aliases apply to the static check too, as they do to the module
  const aliasesOf = (s: ViteDevServer) => cache.setAliases((s.config.resolve.alias as Array<{ find: string | RegExp; replacement: string }>).filter((a) => typeof a.replacement === 'string'));
  let server: ViteDevServer | null = o.fresh ? null : o.server ?? null, own = false;
  const g = globalThis as Record<symbol, number>;
  try {
    if (!server) {
      const { createServer } = await import('vite');
      g[LOADING] = (g[LOADING] ?? 0) + 1;
      own = true;
      server = await createServer({
        root: o.root, ...(o.configFile !== undefined ? { configFile: o.configFile } : {}), mode: o.mode ?? 'production',
        ...(o.alias ? { resolve: { alias: o.alias as never } } : {}),
        logLevel: 'silent', clearScreen: false, appType: 'custom',
        server: { middlewareMode: true, hmr: false, ws: false, watch: null },
        optimizeDeps: { noDiscovery: true, include: [] },
        ...(o.fresh ? { ssr: { noExternal: true } } : {}),
      });
    }
    aliasesOf(server);
    const module = await server.ssrLoadModule(o.helpersFile);
    return { module: module as Record<string, unknown>, error: null, ...check() };
  } catch (e) {
    return { module: null, error: (e as Error)?.message ?? String(e), ...check() };
  } finally {
    if (own) { g[LOADING]!--; await server?.close().catch(() => {}); }
  }
}

/** SN533's message: the helpers module could not be loaded in Node, so nothing folds */
export function unloadedMessage(root: string, helpersFile: string, error: string): string {
  return `the helpers module could not be loaded in Node (${relative(root, helpersFile).split(sep).join('/')}: ${error.split('\n')[0]}): no helper call is run at build time; the page works as before`;
}
