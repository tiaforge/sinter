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

/**
 * Resolves once the document is parsed (`readyState` past `loading`): the page module is `async`
 * and may run while the body is still being parsed, so it mounts after this.
 */
export const parsed = (doc: Document = document): Promise<void> => new Promise((done) => {
  if (doc.readyState != 'loading') return done();
  const on = () => { if (doc.readyState != 'loading') { doc.removeEventListener('readystatechange', on); done(); } };
  doc.addEventListener('readystatechange', on);
});

/**
 * Responses the early file requested before the page module ran, handed to the request layer
 * once each. The early file and the page bundle are bundled apart: they meet through a global.
 */
export interface Prefetched {
  /** starts the request for a URL (once) */
  add(url: string): void;
  /** the response started for this request, if it is the request the early file sent (method, URL, credentials, headers); else null */
  take(request: Request, signal: AbortSignal): Promise<Response> | null;
  /** aborts and forgets what no resource took */
  sweep(): void;
}
const PREFETCHED = Symbol.for('sinter.prefetched');
export const prefetched = (): Prefetched | undefined => (globalThis as any)[PREFETCHED];
export const setPrefetched = (p: Prefetched) => { (globalThis as any)[PREFETCHED] = p; };

/** Where the early file and the page module meet: whether the early file started, and when it has rendered. */
export interface Meeting { started: boolean; done: Promise<void>; finish(): void }
export const meeting = (): Meeting => ((globalThis as any)[Symbol.for('sinter.early.page')] ??= (() => {
  let finish!: () => void;
  const done = new Promise<void>((r) => { finish = r; });
  return { started: false, done, finish };
})());

/** Whether DOMContentLoaded has fired: every deferred script (the early file among them) has run or failed. */
const contentLoaded = (doc: Document) => doc.readyState == 'complete' || ((performance.getEntriesByType?.('navigation')[0] as PerformanceNavigationTiming | undefined)?.domContentLoadedEventStart ?? 0) > 0;

/**
 * What the page module awaits before it mounts on a page with an early file (`@tiaforge-ui/sinter/early`): the document is
 * parsed and the early file has rendered (with built-in messages, once the dictionary arrived).
 * The page module is `async` and may run before the early file: it waits for it to start, or for
 * DOMContentLoaded (by then the early file has started, unless it failed to load).
 */
export async function rendered(doc: Document = document): Promise<void> {
  await parsed(doc);
  const m = meeting();
  if (!m.started && !contentLoaded(doc)) await new Promise((r) => doc.addEventListener('DOMContentLoaded', r, { once: true }));
  if (m.started) await m.done;
}
