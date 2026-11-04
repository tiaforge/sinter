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
  /** add a window-level listener (pagehide, pageshow, popstate); returns the remover */
  listen(type: string, fn: (e: Event) => void): () => void;
}

const g = globalThis as typeof globalThis & Window;
const tryGet = (f: () => Storage) => { try { return f(); } catch { return null; } };

export const defaultEnv: Env = {
  now: Date.now,
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as number),
  queueMicrotask: (fn) => queueMicrotask(fn),
  navigate: (url) => g.location.assign(url),
  fetch: (req) => fetch(req),
  storage: () => tryGet(() => g.localStorage),
  session: () => tryGet(() => g.sessionStorage),
  href: () => g.location.href,
  replaceState: (url) => g.history.replaceState(g.history.state, '', url),
  random: Math.random,
  listen: (type, fn) => (g.addEventListener(type, fn), () => g.removeEventListener(type, fn)),
};
