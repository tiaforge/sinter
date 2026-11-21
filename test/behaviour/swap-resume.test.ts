// The swap's stub and history writes (docs/proposals/swap-navigation.md §5): a `$url` write or a script's
// `replaceState` while a swap waits for its page aborts the browser's navigation, not the swap; the stub
// navigates again, and that navigation takes on what the first one fetched. A stand-in for `navigation` here
// (aborting the navigation in progress at each history write, as the browser does); the swap's rest
// (`prepare`) is a stand-in too, which counts its fetches.
import { afterAll, beforeAll, expect, test, vi } from 'vitest';
import type { Prepared } from '../../src/swap.js';

const prepared: Array<(p: Prepared) => void> = [], committed: string[] = [], signals: AbortSignal[] = [];
vi.mock('../../src/swap-run.js', () => ({
  prepare: (_s: unknown, i: { to: string }, signal: AbortSignal) => (signals.push(signal), new Promise<Prepared>((r) => { prepared.push(r); }).then((p) => p && (async () => { committed.push(i.to); }))),
}));

interface Run { ctl: AbortController; pre?: () => Promise<void>; handler: () => Promise<void> }
const done: string[] = [];
class FakeNavigation extends EventTarget {
  currentEntry = { key: 'k0', index: 0 };
  cur: Run | null = null;
  fire(url: string, type: string, same: boolean) {
    const ctl = new AbortController(), runs: Run[] = [];
    const e = Object.assign(new Event('navigate', { cancelable: true }), {
      canIntercept: true, hashChange: false, downloadRequest: null, formData: null, navigationType: type, sourceElement: null,
      signal: ctl.signal, destination: { url: new URL(url, location.href).href, key: '', index: 1, sameDocument: same },
      intercept(o: { precommitHandler?: () => Promise<void>; handler: () => Promise<void> }) { runs.push({ ctl, pre: o.precommitHandler, handler: o.handler }); },
    });
    // the browser aborts the navigation in progress before a new one's event (a history write's too)
    const was = this.cur;
    this.cur = null;
    if (was) was.ctl.abort();
    this.dispatchEvent(e);
    return { e, run: runs[0] };
  }
  navigate(url: string, o: { history?: string } = {}) {
    const { run, e } = this.fire(url, o.history == 'replace' ? 'replace' : 'push', false);
    if (run) {
      this.cur = run;
      void (async () => {
        try { await run.pre?.(); } catch { return; }
        if (run.ctl.signal.aborted) return;
        this.cur = null;
        done.push(e.destination.url);
        await run.handler();
      })();
    }
    return { committed: Promise.resolve(), finished: Promise.resolve() };
  }
  /** `history.replaceState()`: a same-document navigation, which aborts the one in progress */
  write(url: string) { this.fire(url, 'replace', true); }
}

const g = globalThis as unknown as { navigation?: FakeNavigation; NavigateEvent?: unknown };
const tick = () => new Promise((r) => setTimeout(r, 0));

beforeAll(async () => {
  g.navigation = new FakeNavigation();
  g.NavigateEvent = class { sourceElement = null };
  Object.defineProperty((g.NavigateEvent as { prototype: object }).prototype, 'sourceElement', { value: null });
  const { swap } = await import('../../src/swap.js');
  const cleanups: Array<() => void> = [];
  const app = { root: document, ext: {}, env: { href: () => location.href, navigate: () => {} }, addCleanup: (f: () => void) => { cleanups.push(f); } };
  swap([{ m: ['/'] }, { m: ['/next'] }]).install(app as never);
});
afterAll(() => { delete g.navigation; delete g.NavigateEvent; });

test('history writes while the page is fetched: it is fetched once, and swapped in once it is ready', async () => {
  const to = new URL('/next', location.href).href;
  g.navigation!.navigate(to);
  await tick();
  expect(prepared).toHaveLength(1);
  // a write every few milliseconds while the page loads: each aborts the browser's navigation, which goes again
  for (let k = 0; k < 4; k++) {
    g.navigation!.write(`/?q=${k}`);
    await tick();
    await tick();
  }
  expect(prepared).toHaveLength(1);
  expect(committed).toEqual([]);
  prepared[0]!(async () => {});
  for (let k = 0; k < 5; k++) await tick();
  expect(done).toEqual([to]);
  expect(committed).toEqual([to]);
});

test('another navigation while the page is fetched: the swap is aborted, the new one fetches its own', async () => {
  g.navigation!.navigate(new URL('/next?b', location.href).href);
  await tick();
  const n = signals.length;
  g.navigation!.write('/?q=x');
  await tick();
  await tick();
  expect(signals[n - 1]!.aborted).toBe(false);
  g.navigation!.navigate(new URL('/', location.href).href);
  await tick();
  expect(signals[n - 1]!.aborted).toBe(true);
  expect(signals).toHaveLength(n + 1);
  expect(signals[n]!.aborted).toBe(false);
});
