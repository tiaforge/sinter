// Everything sinter needs from the outside world, in one injectable object, so
// the testing module can drive time, scheduling, navigation and fetch exactly.
import { meeting } from './handoff.js';

export interface Env {
  now(): number;
  setTimeout(fn: () => void, ms: number, kind?: 'debounce' | 'timeout' | 'backoff' | 'clock'): unknown;
  clearTimeout(handle: unknown): void;
  queueMicrotask(fn: () => void): void;
  /** the only way sinter navigates */
  navigate(url: string): void;
  /** `navigate(url, { replace: true })`: a navigation that replaces the current entry; absent: `location.replace` */
  replace?(url: string): void;
  fetch(request: Request): Promise<Response>;
  storage(): Storage | null;
  session(): Storage | null;
  /** current location (href) */
  href(): string;
  replaceState(url: string): void;
  /** a new history entry (a `$url` write a user's event caused); absent: `history.pushState` (location.ts) */
  pushState?(url: string): void;
  /** a same-page link's `#hash` (query-links.ts): a fragment navigation in the current entry; absent: `location.replace` */
  fragment?(hash: string): void;
  /** whether an event is the user's (its `$url` writes push a history entry); absent: `isTrusted`. The testing module counts its simulated events */
  trusted?(e: Event): boolean;
  random(): number;
  /** add a window-level listener (pagehide, pageshow, popstate, visibilitychange); returns the remover */
  listen(type: string, fn: (e: Event) => void): () => void;
  /** whether the page is hidden (a background tab, a prerendered page); absent: never */
  hidden?(): boolean;
  /** runs `fn` before the next frame is painted (requestAnimationFrame); absent: changes from server events flush in a microtask */
  frame?(fn: () => void): void;
}

const g = globalThis as typeof globalThis & Window;
const tryGet = (f: () => Storage) => { try { return f(); } catch { return null; } };

/** The environment the runtime uses: the default, with what `configure({ env })` overrides. */
export const envOf = (c: { env: Partial<Env> | null }): Env => (c.env ? { ...defaultEnv, ...c.env } : defaultEnv);

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
  // visibilitychange fires at the document and bubbles to the window
  hidden: () => g.document?.visibilityState == 'hidden',
  frame: g.requestAnimationFrame ? (fn) => { g.requestAnimationFrame(fn); } : undefined,
};

/**
 * Resolves once the document is parsed (`readyState` past `loading`): the page module is `async`
 * and may run while the body is still being parsed, so it mounts after this. Never on a page a
 * server ended with its error text (`<body data-sn-failed>`, sinter-axum): nothing there to mount.
 */
export const parsed = (doc: Document = document): Promise<void> => new Promise((resolve) => {
  const done = () => { if (!doc.body?.hasAttribute('data-sn-failed')) resolve(); };
  if (doc.readyState != 'loading') return done();
  const on = () => { if (doc.readyState != 'loading') { doc.removeEventListener('readystatechange', on); done(); } };
  doc.addEventListener('readystatechange', on);
});

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
