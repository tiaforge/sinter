// The build's cross-check (fold-cross.ts) in a worker thread: it loads its fresh copy of the helpers module as the
// build starts, while the pages compile, and runs the pages' calls when the build has them (at its `buildEnd`), while
// Vite writes the pages; the build waits for it after Vite's HTML step (vite.ts, `SN_CROSS_LATE`). A copy of its own
// in a thread of its own: what the build's instance kept is not there, as in a fresh instance on the main thread.
import { parentPort, workerData } from 'node:worker_threads';
import { crossCheck, type CrossMismatch, type FoldCall } from './fold-cross.js';
import { importModule } from './helpers-node.js';

export interface CrossJob { root: string; helpersFile: string; configFile?: string | false; mode?: string; alias?: unknown }
/** the worker's answer: the differences, or why the fresh copy could not be loaded */
export type CrossAnswer = { bad: CrossMismatch[] } | { error: string };

const job = workerData as CrossJob;
const loaded: Promise<{ module: Record<string, unknown> } | { error: string }> = importModule({
  root: job.root, fresh: true,
  ...(job.configFile !== undefined ? { configFile: job.configFile } : {}), ...(job.mode ? { mode: job.mode } : {}), ...(job.alias ? { alias: job.alias } : {}),
}, job.helpersFile).then((module) => ({ module }), (e) => ({ error: (e as Error)?.message ?? String(e) }));

parentPort!.on('message', async (pages: Array<[string, FoldCall[]]>) => {
  const l = await loaded;
  const answer: CrossAnswer = 'error' in l ? { error: l.error } : { bad: crossCheck(l.module, pages) };
  parentPort!.postMessage(answer);
});
