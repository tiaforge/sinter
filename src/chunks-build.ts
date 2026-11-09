// Chunking of multi-page builds (`sinter({ chunks })`, Vite 8 / Rolldown only). Rolldown splits
// the modules several pages share into one chunk per set of pages that import them; in an app with
// a handful of pages many of those are a few hundred bytes, and each is a request of its own.
//   - a shared chunk below `minSize` is copied into every chunk that imports it (Rolldown's
//     `codeSplitting.experimentalInlineCommonChunks`): the page loads one file less. A chunk a lazy
//     (dynamically imported) chunk also uses stays shared, so a page never has two instances of a
//     module, and a lazy chunk is never pulled into what a page loads up front. Rolldown turns
//     `strictExecutionOrder` on for this (module bodies run in source order wherever they end up).
//   - `runtime`: sinter's own modules that pages load up front and share, and the modules every page
//     loads, go into one `sinter-<hash>.js`, instead of being spread over the shared chunks.
// The helpers and actions modules are side-effect free (their contract: pure functions, actions
// that return data), and are built as such: under `strictExecutionOrder` a page that calls nothing of
// a module the actions module re-exports would otherwise still load it.
import { realpathSync } from 'node:fs';
import { dirname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface ChunkOptions {
  /** shared chunks smaller than this (bytes of their modules' code, before minifying) are copied into the chunks that import them; 0: none (default 10000) */
  minSize?: number;
  /** sinter's own modules that two or more pages load up front, and what every page loads, in one shared chunk (default true) */
  runtime?: boolean;
}

export const CHUNK_MIN_SIZE = 10_000;

/** the directory of sinter's own modules (dist/ when installed, src/ in sinter's tests) */
const own = (() => {
  const dir = dirname(fileURLToPath(import.meta.url));
  try { return realpathSync(dir); } catch { return dir; }
})();

/** a module of sinter's runtime, or one of Vite's helpers every page bundle with an import needs */
export const isRuntimeModule = (id: string) => id.startsWith(own + sep) || /^\0vite\/(modulepreload-polyfill|preload-helper)\.js$/.test(id);

type Output = { format?: string; codeSplitting?: unknown; advancedChunks?: unknown; manualChunks?: unknown; inlineDynamicImports?: unknown; preserveModules?: unknown };
type ModuleInfo = { importers: readonly string[]; isEntry: boolean };
type Context = { getModuleInfo(id: string): ModuleInfo | null };

/**
 * The `sinter` group: sinter's runtime, and the modules every page loads up front (the app's config
 * module, its helpers, what they import), which would otherwise be a chunk of their own beside it,
 * or copies in every page. `pages`: the number of entries.
 */
function sinterGroup(pages: number) {
  // per module, the entries that import it statically (directly or through other modules)
  const reach = new Map<string, Set<string>>();
  const entriesOf = (id: string, ctx: Context): Set<string> => {
    const known = reach.get(id);
    if (known) return known;
    const out = new Set<string>();
    reach.set(id, out); // a cycle meets an empty set, then the rest of the walk fills it
    const info = ctx.getModuleInfo(id);
    if (!info) return out;
    if (info.isEntry) out.add(id);
    for (const by of info.importers) for (const e of entriesOf(by, ctx)) out.add(e);
    return out;
  };
  return {
    name: (id: string, ctx: Context) => (isRuntimeModule(id) || entriesOf(id, ctx).size >= pages ? 'sinter' : null),
    tags: ['$initial' as const],
    minShareCount: 2,
  };
}

/**
 * The `codeSplitting` option for a build's output, or null to leave the output as it is: a single
 * page, an output that is not ES modules, or one whose chunking the app configures itself.
 * `entrySignatures`: the input's `preserveEntrySignatures`, which inlining needs to be `false`.
 */
export function codeSplitting(options: ChunkOptions, output: Output, pages: number, entrySignatures: unknown) {
  if (pages < 2) return null;
  if ((output.format ?? 'es') !== 'es' && output.format !== 'esm') return null;
  if (output.codeSplitting !== undefined || output.advancedChunks || output.manualChunks || output.inlineDynamicImports || output.preserveModules) return null;
  const minSize = options.minSize ?? CHUNK_MIN_SIZE;
  const inline = minSize > 0 && entrySignatures === false;
  const runtime = options.runtime !== false;
  if (!inline && !runtime) return null;
  return {
    ...(runtime ? { groups: [sinterGroup(pages)] } : {}),
    ...(inline ? { experimentalInlineCommonChunks: { maxSize: minSize } } : {}),
  };
}

/** the module of Rolldown's runtime helpers: its own chunk, which every chunk with a wrapped module imports */
const RUNTIME_ID = '\0rolldown/runtime.js';
const PREFIX = '__sinter_rt_';

type Chunk = { type: 'chunk'; fileName: string; name: string; code: string; isEntry: boolean; isDynamicEntry: boolean; imports: string[]; dynamicImports: string[]; moduleIds: string[]; map?: unknown };
type Bundle = Record<string, Chunk | { type: 'asset'; fileName: string }>;

/** `./x.js` from the chunk `from` to the file `to` (both paths from the output root) */
const spec = (from: string, to: string) => {
  const a = from.split('/').slice(0, -1), b = to.split('/');
  let i = 0;
  while (i < a.length && i < b.length - 1 && a[i] === b[i]) i++;
  const up = a.length - i;
  return (up ? '../'.repeat(up) : './') + b.slice(i).join('/');
};
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** `{a as b, c}` → [['a', 'b'], ['c', 'c']], or null for anything else */
const names = (list: string) => {
  const out: Array<[string, string]> = [];
  for (const part of list.split(',').map((p) => p.trim()).filter(Boolean)) {
    const m = /^([\w$]+)(?:\s+as\s+([\w$]+))?$/.exec(part);
    if (!m) return null;
    out.push([m[1]!, m[2] ?? m[1]!]);
  }
  return out;
};

/**
 * Inlining shared chunks (Rolldown's `experimentalInlineCommonChunks`) puts Rolldown's runtime
 * helpers in a chunk of their own (half a kilobyte, a registry of the inlined chunks, so one
 * instance per page): one request more on every page. When the `sinter` chunk (the `runtime`
 * group) imports nothing but those helpers, they move into it, which the pages load anyway, and
 * every import of the helpers is pointed at it. It keeps its name: its hash covers the helpers'
 * file name, so theirs. Returns false when nothing changed (no such chunks, a source map, or an
 * import of the helpers this does not know how to rewrite).
 */
export function mergeRuntime(bundle: Bundle): boolean {
  const chunks = Object.values(bundle).filter((c): c is Chunk => c.type === 'chunk');
  const rt = chunks.find((c) => c.moduleIds.length === 1 && c.moduleIds[0] === RUNTIME_ID && !c.isEntry && !c.isDynamicEntry);
  const host = chunks.find((c) => c.name === 'sinter' && !c.isEntry && !c.isDynamicEntry);
  if (!rt || !host || chunks.some((c) => c.map) || rt.imports.length || rt.dynamicImports.length) return false;
  // the host keeps its name: it imports the helpers, so its hash covers theirs; and nothing else statically, so it is evaluated before its importers
  if (host.imports.length !== 1 || host.imports[0] !== rt.fileName) return false;
  // the helpers: one trailing `export{…}`, nothing imported
  const tail = /export\s*\{([^}]*)\}\s*;?\s*$/.exec(rt.code);
  const exported = tail ? names(tail[1]!) : null;
  const body = tail ? rt.code.slice(0, tail.index) : '';
  if (!exported || /\b(import|export)\b/.test(body) || /\bthis\b/.test(body)) return false;
  const importers = chunks.filter((c) => c !== rt && c.imports.includes(rt.fileName));
  // every importer's import of the helpers, rewritten, before anything changes
  const edits = new Map<Chunk, Array<[string, string]>>();
  for (const c of importers) {
    const re = new RegExp(`import\\s*\\{([^}]*)\\}\\s*from\\s*(["'])${escape(spec(c.fileName, rt.fileName))}\\2;?`, 'g');
    const found = [...c.code.matchAll(re)];
    // another form (a namespace import, a re-export, an import() of the helpers): left as Rolldown wrote it
    if (!found.length || c.code.split(spec(c.fileName, rt.fileName)).length - 1 !== found.length) return false;
    const list: Array<[string, string]> = [];
    for (const m of found) {
      const n = names(m[1]!);
      if (!n || n.some(([imported]) => !exported.some(([, e]) => e === imported))) return false;
      list.push([m[0], c === host ? `const{${n.map(([i, l]) => `${i}:${l}`).join(',')}}=${PREFIX};` : `import{${n.map(([i, l]) => `${PREFIX}${i} as ${l}`).join(',')}}from"@@HOST@@";`]);
    }
    edits.set(c, list);
  }
  // the host: the helpers first (in a function: no name meets the host's), then its own code, then their exports
  let code = host.code;
  for (const [from, to] of edits.get(host) ?? []) code = code.replace(from, () => to);
  const helpers = `const ${PREFIX}=(()=>{${body}return{${exported.map(([local, e]) => `${e}:${local}`).join(',')}}})();`;
  const reexport = `const{${exported.map(([, e]) => `${e}:${PREFIX}${e}`).join(',')}}=${PREFIX};export{${exported.map(([, e]) => `${PREFIX}${e}`).join(',')}};`;
  code = helpers + code + '\n' + reexport;
  host.code = code;
  delete bundle[rt.fileName];
  for (const c of chunks) {
    if (c === rt || c === host) continue;
    for (const [from, to] of edits.get(c) ?? []) c.code = c.code.replace(from, () => to.replace('@@HOST@@', spec(c.fileName, host.fileName)));
    // Vite's list of a lazy chunk's dependencies, if it is written already
    c.code = c.code.split(`"${rt.fileName}"`).join(`"${host.fileName}"`);
    const fix = (list: string[]) => [...new Set(list.map((f) => (f === rt.fileName ? host.fileName : f)))].filter((f) => f !== c.fileName);
    c.imports = fix(c.imports);
    c.dynamicImports = fix(c.dynamicImports);
  }
  host.imports = host.imports.filter((f) => f !== rt.fileName);
  return true;
}
