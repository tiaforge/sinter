// A timer counted as busy while it waits, so the testing module's settle waits for it: the URL's
// typing commit (location.ts). The resource loader keeps its own inline (cheaper in the core), with
// the same pause.
import type { App } from './app.js';

/** How long a change from typing waits for the next keystroke (a resource's request, the URL's commit). */
export const TYPING = 250;

export interface Wait {
  /** (re)starts the timer: `fn` runs once, `ms` after the last start */
  start(fn: () => void, ms?: number): void;
  stop(): void;
  on(): boolean;
}

export function wait(app: Pick<App, 'env' | 'busy'>): Wait {
  let t: unknown = null;
  const stop = () => { if (t != null) { app.env.clearTimeout(t); t = null; app.busy--; } };
  return {
    stop,
    on: () => t != null,
    start(fn, ms = TYPING) {
      stop();
      app.busy++;
      t = app.env.setTimeout(() => { t = null; app.busy--; fn(); }, ms, 'debounce');
    },
  };
}
