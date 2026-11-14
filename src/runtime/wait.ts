// A timer counted as busy while it waits, so the testing module's settle waits for it: the URL's
// typing commit (typing.ts). The resource loader keeps its own inline, with the same pause. The core
// imports nothing from here: a module the core imports goes whole into an app's shared chunk, so
// every page would carry this.
import { TYPING, type App } from './app.js';

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
