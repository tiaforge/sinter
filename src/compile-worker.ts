// Spike (docs/proposals/parallel-build.md): one compile worker (compile-pool.ts). It reads the project, loads the
// helpers module and sharp once, then compiles what the plugin sends, rebuilding the options' functions from them.
import { parentPort, workerData } from 'node:worker_threads';
import { resolve } from 'node:path';
import { compile, type CompileOptions, type CompileResult } from './compiler/index.js';
import type { FoldArg } from './compiler/compile.js';
import { project } from './project.js';
import { loadHelpers, type NodeHelpers } from './helpers-node.js';
import { FoldCache } from './fold-check.js';
import { collectionsIn, type LoadedContent } from './content-node.js';
import { loadImages, type Images } from './images.js';
import { lazyHelpers, reachLazy } from './lazy-build.js';
import type { Job, JobResult, PoolInit } from './compile-pool.js';

const COMPONENT_CSS = '/@sinter/component-css/';
const init = workerData as PoolInit;
const port = parentPort!;

const t0 = performance.now();
let p: ReturnType<typeof project>, helpers: NodeHelpers | null = null, images: Images | null = null;
const reads = new Map<string, { text: string } | { error: unknown }>();
const globCache: NonNullable<CompileOptions['globCache']> = new Map();
const content: LoadedContent | null = init.content ? { ...init.content, files: [] } : null;
try {
  p = project(init.root, init.project);
  if (init.helpers) helpers = await loadHelpers({ root: init.root, helpersFile: p.helpersFile, manifest: p.helpers, configFile: init.helpers.configFile, mode: init.helpers.mode, ...(init.helpers.alias ? { alias: init.helpers.alias } : {}), cache: new FoldCache() });
  if (init.images) images = await loadImages(init.images.cacheDir, false);
  port.postMessage({ ready: true, initMs: performance.now() - t0 });
} catch (e) {
  port.postMessage({ ready: false, error: String((e as Error)?.stack ?? e) });
}

const readFile = (path: string) => {
  let r = reads.get(path);
  if (!r) { try { r = { text: p.readFile(path) }; } catch (error) { r = { error }; } reads.set(path, r); }
  if ('error' in r) throw r.error;
  return r.text;
};

async function run(job: Job): Promise<JobResult> {
  const folds: JobResult['folds'] = [], lazyAsked: string[] = [];
  const has = new Set(job.rebuild);
  const lineHeights = job.lineHeights ? new Map(job.lineHeights) : null, zeros = job.zeros ? new Map(job.zeros) : null;
  const options = (): CompileOptions => ({
    ...job.options,
    ...(has.has('readFile') ? { readFile } : {}) as { readFile: CompileOptions['readFile'] },
    ...(has.has('listFiles') ? { listFiles: p.listFiles } : {}),
    ...(has.has('globCache') ? { globCache } : {}),
    ...(has.has('collections') && content ? { collections: collectionsIn(content, job.locale), ...(content.error ? { collectionsError: content.error } : {}) } : {}),
    ...(has.has('helpers') && helpers ? { helperValues: helpers.module, helperFold: helpers.fold } : {}),
    ...(has.has('foldLog') ? { foldLog: (key: string, args: FoldArg[], result: string, id: number) => { folds.push([key, args, result, id]); } } : {}),
    ...(has.has('componentCss') ? { componentCss: (name: string) => `${COMPONENT_CSS}${name}.css` } : {}),
    ...(has.has('lazyScript') ? { lazyScript: (module: string) => { lazyAsked.push(module); return reachLazy(resolve(init.root, '.' + module), init.lazy, init.root, undefined, undefined, false, p.libraries).map((x) => x.spec); } } : {}),
    ...(has.has('lazyModule') ? { lazyModule: (m: string) => lazyHelpers(init.root, init.lazy, undefined, p.libraries).reach(m) } : {}),
    ...(job.images && images ? { images: { ...job.images, info: (f: string) => images!.info(f), url: (v) => job.images!.prefix + images!.fileName(v) } } : {}),
    ...(lineHeights ? { normalLineHeight: (f: string) => lineHeights.get(f) ?? null } : {}),
    ...(zeros ? { zeroWidth: (f: string) => zeros.get(f) ?? null } : {}),
  } as CompileOptions);
  let out: CompileResult = compile(job.html, options());
  // images the worker's sharp did not know yet: analysed, then the page is compiled again (as the plugin does)
  if (images && job.images && out.images?.pending.length) {
    await images.analyze(out.images.pending);
    folds.length = 0;
    lazyAsked.length = 0;
    out = compile(job.html, options());
  }
  return { out, folds, lazyAsked };
}

port.on('message', async (m: { id: number; job: Job }) => {
  const t = performance.now();
  try {
    const result = await run(m.job);
    port.postMessage({ id: m.id, ok: true, result, ms: performance.now() - t });
  } catch (e) {
    const err = e as Error;
    port.postMessage({ id: m.id, ok: false, error: { message: String(err?.message ?? e), ...(err?.stack ? { stack: err.stack } : {}) }, ms: performance.now() - t });
  }
});
