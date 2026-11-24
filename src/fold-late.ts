// The cross-check's worker (fold-worker.ts), as the build starts it: it loads its copy of the helpers module at once,
// and `run` gives it the pages' calls and waits for its answer. Any failure of the worker itself (it cannot start,
// a call's arguments cannot be sent, it dies) rejects, and the build runs the check on its own thread instead.
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import type { FoldCall } from './fold-cross.js';
import type { CrossAnswer, CrossJob } from './fold-worker.js';

export interface CrossWorker { run(pages: Array<[string, FoldCall[]]>): Promise<CrossAnswer>; stop(): void }

/**
 * From the sources (this repository's tests run the plugin from src/), the worker reads TypeScript: each `.ts` file
 * transformed by the bundler's own transform (Node strips types only, and since Node 26 has no flag for more: the
 * compiler's parameter properties need a transform), and `.js` specifiers that name a `.ts` file resolved to it, as
 * the build's `tsc` output has them.
 */
const FROM_SOURCE = `const { registerHooks } = require('node:module'), { existsSync, readFileSync } = require('node:fs'), { fileURLToPath } = require('node:url');
const { workerData } = require('node:worker_threads'), { transformSync } = require(workerData.transformer);
registerHooks({
  resolve(spec, ctx, next) {
    if (spec.endsWith('.js') && ctx.parentURL && ctx.parentURL.endsWith('.ts')) { const u = new URL(spec.slice(0, -3) + '.ts', ctx.parentURL); if (u.protocol === 'file:' && existsSync(fileURLToPath(u))) return next(u.href, ctx); }
    return next(spec, ctx);
  },
  load(url, ctx, next) {
    if (!url.startsWith('file:') || !url.endsWith('.ts')) return next(url, ctx);
    const file = fileURLToPath(url), out = transformSync(file, readFileSync(file, 'utf8'), {});
    if (out.errors.length) throw new Error(file + ': ' + out.errors[0].message);
    return { format: 'module', source: out.code, shortCircuit: true };
  },
});
import(workerData.entry);`;

export function crossWorker(job: CrossJob): CrossWorker {
  const js = new URL('./fold-worker.js', import.meta.url), ts = new URL('./fold-worker.ts', import.meta.url);
  const fromSource = !existsSync(fileURLToPath(js)) && existsSync(fileURLToPath(ts));
  const worker = fromSource
    ? new Worker(FROM_SOURCE, { eval: true, workerData: { ...job, entry: ts.href, transformer: createRequire(import.meta.url).resolve('rolldown/utils') }, execArgv: ['--no-warnings'] })
    : new Worker(js, { workerData: job });
  // it never keeps the process alive: a build that stops before waiting for it leaves it behind
  worker.unref();
  let failed: Error | null = null;
  const fail = (e: unknown) => { failed ??= e instanceof Error ? e : new Error(String(e)); };
  worker.on('error', fail);
  worker.on('exit', (code) => fail(new Error(`the cross-check's worker stopped (${code})`)));
  return {
    run(pages) {
      return new Promise<CrossAnswer>((resolve, reject) => {
        if (failed) return reject(failed);
        worker.once('message', (a: CrossAnswer) => { resolve(a); void worker.terminate(); });
        worker.once('error', reject);
        worker.once('exit', (code) => reject(new Error(`the cross-check's worker stopped (${code})`)));
        try { worker.postMessage(pages); } catch (e) { reject(e); void worker.terminate(); }
      });
    },
    stop() { void worker.terminate(); },
  };
}
