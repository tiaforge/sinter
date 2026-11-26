// `navigate()` to this page with another query, with the Navigation API, where the browser commits the URL only
// after the intercepted navigation's handler has started (WebKit, intermittently), here in a later task, after the
// flush (held until the test releases it): `$url` is read from the navigation's destination, not from the address bar, which still shows the URL being left.
import { afterEach, beforeEach, expect, test } from 'vitest';
import { render } from '../../src/testing/index.js';
import { navigate } from '../../src/runtime/app.js';

/** commits the URL into the page's environment; whether it does so before the handlers run (the spec) or after (late) */
let commit: (url: string) => void = () => {}, late = true;
/** the late commits not made yet */
const held: Array<() => void> = [], release = () => { for (const c of held.splice(0)) c(); };

class FakeNavigation extends EventTarget {
  currentEntry = { key: 'k0', index: 0 };
  navigate(url: string, o: { history?: string; info?: unknown } = {}) {
    const to = new URL(url, location.href).href, handlers: Array<() => Promise<void>> = [];
    const e = Object.assign(new Event('navigate', { cancelable: true }), {
      canIntercept: true, hashChange: false, downloadRequest: null, formData: null, navigationType: o.history == 'replace' ? 'replace' : 'push',
      info: o.info, signal: new AbortController().signal, destination: { url: to, key: '', index: 1, sameDocument: false }, sourceElement: null,
      intercept(x: { handler(): Promise<void> }) { handlers.push(x.handler); },
    });
    this.dispatchEvent(e);
    if (handlers.length && !late) commit(to);
    for (const h of handlers) void h();
    if (handlers.length && late) held.push(() => commit(to));
    return { committed: Promise.resolve(), finished: Promise.resolve() };
  }
}

const g = globalThis as { navigation?: unknown; NavigateEvent?: unknown };
beforeEach(() => {
  held.length = 0;
  g.navigation = new FakeNavigation();
  g.NavigateEvent = class {};
  Object.defineProperty((g.NavigateEvent as { prototype: object }).prototype, 'sourceElement', { get: () => null });
});
afterEach(() => { delete g.navigation; delete g.NavigateEvent; });

test.each([true, false])('navigate() to another query renders `$url`, the URL committed after the handler starts (%s)', async (after) => {
  late = after;
  const r = await render(`<output data-sn-text="($url.start ?? '') + '/' + ($url.end ?? '')"></output>
    <p data-sn-text="JSON.stringify($url.t)"></p><select multiple data-sn-model="$url.t"><option>a</option><option>b</option></select>
    <button data-sn-on-click="navigate('?start=2026-11-10&end=2026-11-16&t=a&t=b')">go</button>`, { url: 'http://localhost:3000/dates/' });
  commit = (u) => r.app.env.pushState!(u);
  const out = () => r.root.querySelector('output')!.textContent;
  await r.settle();
  expect(out()).toBe('/');
  // a handler's `navigate()`
  r.root.querySelector('button')!.click();
  await r.settle();
  release();
  expect(r.url()).toBe('http://localhost:3000/dates/?start=2026-11-10&end=2026-11-16&t=a&t=b');
  expect(out()).toBe('2026-11-10/2026-11-16');
  expect(r.root.querySelector('p')!.textContent).toBe('["a","b"]');
  // app code's `navigate()` (a component's script)
  navigate('?start=2026-12-01&end=2026-12-07&t=b');
  await r.settle();
  release();
  expect(out()).toBe('2026-12-01/2026-12-07');
  expect(r.root.querySelector('p')!.textContent).toBe('["b"]');
  expect(r.history()).toEqual(['http://localhost:3000/dates/', 'http://localhost:3000/dates/?start=2026-11-10&end=2026-11-16&t=a&t=b', 'http://localhost:3000/dates/?start=2026-12-01&end=2026-12-07&t=b']);
});

test('before the URL is committed, a `$url` write builds on the URL navigated to, and a navigation back is not dropped', async () => {
  late = true;
  const r = await render(`<output data-sn-text="($url.start ?? '') + '/' + ($url.x ?? '')"></output>
    <button id="go" data-sn-on-click="navigate('?start=2')">go</button><button id="x" data-sn-on-click="$url.x = 'y'">x</button>`, { url: 'http://localhost:3000/dates/' });
  commit = (u) => r.app.env.pushState!(u);
  const out = () => r.root.querySelector('output')!.textContent;
  const urls = () => r.historyWrites().map((w) => w.url);
  await r.settle();
  // a write in the page while the address bar still shows `/dates/`: the query it writes keeps `start`
  r.root.querySelector<HTMLElement>('#go')!.click();
  await r.settle();
  r.root.querySelector<HTMLElement>('#x')!.click();
  await r.settle();
  expect(out()).toBe('2/y');
  expect(urls()).toEqual(['http://localhost:3000/dates/?start=2&x=y']);
  release();
  await r.settle();
  // back to the query the address bar still shows, before the navigation away commits: it is followed
  navigate('?start=3');
  await r.settle();
  navigate('?start=2');
  await r.settle();
  release();
  await r.settle();
  expect(out()).toBe('2/');
  expect(r.url()).toBe('http://localhost:3000/dates/?start=2');
});
