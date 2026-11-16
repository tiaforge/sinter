// Spike (docs/proposals/parallel-build.md): a build's page compiles in worker threads. compile() is pure given its
// options, but some of them are functions or per-build caches the plugin holds. What crosses to a worker is the
// options' data; each worker rebuilds the rest once, from the same inputs the plugin read: the project (its reads and
// listings, with a read cache and a `file:` list cache of its own), the helpers module and its fold verdicts (loaded
// again, in the worker), the content module's collections (sent once, as data), and the image analyses (a sharp of its
// own, over the same disk cache). What a compile did that the plugin keeps (each folded call, each component script
// asked about lazy packages) comes back with its result, and the plugin applies it as if it had compiled the page itself.
import { existsSync } from 'node:fs';
import { Worker } from 'node:worker_threads';
import type { CompileOptions, CompileResult, FoldArg } from './compiler/compile.js';
import type { ProjectOptions } from './project.js';
import type { Collections } from './content-node.js';

/** what every worker gets once, before its first job */
export interface PoolInit {
  root: string;
  project: ProjectOptions;
  /** how the plugin loaded the helpers module (helpers-node.ts); null: no helpers module */
  helpers: { configFile: string | false; mode: string; alias?: unknown } | null;
  content: { collections: Collections; perLocale: Map<string, Collections>; error: string | null } | null;
  /** the images' disk cache; null: images off */
  images: { cacheDir: string } | null;
  lazy: string[];
}

/** the options' functions, by name: each worker rebuilds the ones a job names */
export type Rebuilt = 'readFile' | 'listFiles' | 'globCache' | 'collections' | 'helpers' | 'foldLog' | 'componentCss' | 'lazyScript' | 'lazyModule';

export interface Job {
  html: string;
  /** compile()'s options without the functions and caches below */
  options: Omit<CompileOptions, 'readFile' | 'listFiles' | 'globCache' | 'collections' | 'helperValues' | 'helperFold' | 'foldLog' | 'componentCss' | 'lazyScript' | 'lazyModule' | 'images' | 'normalLineHeight' | 'zeroWidth'>;
  rebuild: Rebuilt[];
  /** the language whose collections the page reads */
  locale?: string;
  /** the image host's data: the worker adds `info` and `url` from its own sharp */
  images?: { prefix: string; widths?: number[]; ignore?: boolean; stylesheet?: string; styles?: CompileOptions['styles'] };
  lineHeights?: Array<[string, number]>;
  zeros?: Array<[string, number | null]>;
}

export interface JobResult {
  out: CompileResult;
  /** the last compile's folded calls, in order */
  folds: Array<[string, FoldArg[], string, number]>;
  /** the component scripts the compile asked about lazy packages (the plugin logs each once) */
  lazyAsked: string[];
}

type Reply = ({ id: number; ok: true; result: JobResult } | { id: number; ok: false; error: { message: string; stack?: string } }) & { ms: number };

export class CompilePool {
  private workers: Worker[] = [];
  private idle: Worker[] = [];
  private queue: Array<{ id: number; job: Job; resolve: (r: JobResult) => void; reject: (e: Error) => void }> = [];
  private running = new Map<number, { resolve: (r: JobResult) => void; reject: (e: Error) => void }>();
  private next = 0;
  private ready: Promise<void>;
  /** jobs each worker ran, and the time it spent on them (the spike's measurements) */
  readonly stats: Array<{ jobs: number; ms: number; initMs: number }> = [];

  constructor(size: number, init: PoolInit) {
    // beside this module once built; from the sources (the test suite), the built one (`npm run build` first)
    let url = new URL('./compile-worker.js', import.meta.url);
    if (!existsSync(url)) url = new URL('../dist/compile-worker.js', import.meta.url);
    const starts: Array<Promise<void>> = [];
    for (let i = 0; i < size; i++) {
      const w = new Worker(url, { workerData: init });
      w.unref();
      const stat = { jobs: 0, ms: 0, initMs: 0 };
      this.stats.push(stat);
      starts.push(new Promise((ok, fail) => {
        w.once('message', (m: { ready: true; initMs: number } | { ready: false; error: string }) => {
          if (m.ready) { stat.initMs = m.initMs; ok(); } else fail(new Error(`sinter: a compile worker did not start: ${m.error}`));
        });
        w.once('error', fail);
      }));
      w.on('message', (m: Reply | { ready: boolean }) => {
        if ('ready' in m) return;
        const r = m;
        stat.jobs++;
        stat.ms += r.ms;
        const p = this.running.get(r.id);
        this.running.delete(r.id);
        this.idle.push(w);
        this.pump();
        if (!p) return;
        if (r.ok) p.resolve(r.result);
        else { const e = new Error(r.error.message); if (r.error.stack) e.stack = r.error.stack; p.reject(e); }
      });
      w.on('error', (e: Error) => { for (const p of this.running.values()) p.reject(e); this.running.clear(); });
      this.workers.push(w);
    }
    this.ready = Promise.all(starts).then(() => { this.idle.push(...this.workers); this.pump(); });
  }

  run(job: Job): Promise<JobResult> {
    return new Promise((resolve, reject) => {
      this.queue.push({ id: this.next++, job, resolve, reject });
      this.pump();
    });
  }

  private pump() {
    while (this.idle.length && this.queue.length) {
      const w = this.idle.pop()!, j = this.queue.shift()!;
      this.running.set(j.id, j);
      w.postMessage({ id: j.id, job: j.job });
    }
  }

  async started(): Promise<void> { await this.ready; }

  async close(): Promise<void> {
    await Promise.all(this.workers.map((w) => w.terminate()));
    this.workers = [];
    this.idle = [];
  }
}
