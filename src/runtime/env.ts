// Everything sinter needs from the outside world, in one injectable object, so
// the testing module can drive time, scheduling, navigation and fetch exactly.

export interface Env {
  now(): number;
  setTimeout(fn: () => void, ms: number, kind?: 'debounce' | 'timeout' | 'backoff' | 'clock'): unknown;
  clearTimeout(handle: unknown): void;
  queueMicrotask(fn: () => void): void;
  /** the only way sinter navigates */
  navigate(url: string): void;
  fetch(request: Request): Promise<Response>;
  storage(): Storage | null;
  session(): Storage | null;
  /** current location (href) */
  href(): string;
  replaceState(url: string): void;
  random(): number;
  /** add a window-level listener (pagehide, pageshow, popstate) */
  listen(type: string, fn: (e: Event) => void): () => void;
  createEventSource(url: string): EventSource;
}

const g = globalThis as typeof globalThis & Window;

export const defaultEnv: Env = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => g.setTimeout(fn, ms),
  clearTimeout: (h) => g.clearTimeout(h as number),
  queueMicrotask: (fn) => g.queueMicrotask(fn),
  navigate: (url) => { g.location.assign(url); },
  fetch: (req) => g.fetch(req),
  storage: () => { try { return g.localStorage; } catch { return null; } },
  session: () => { try { return g.sessionStorage; } catch { return null; } },
  href: () => g.location.href,
  replaceState: (url) => g.history.replaceState(g.history.state, '', url),
  random: () => Math.random(),
  listen: (type, fn) => { g.addEventListener(type, fn); return () => g.removeEventListener(type, fn); },
  createEventSource: (url) => new EventSource(url, { withCredentials: true }),
};
