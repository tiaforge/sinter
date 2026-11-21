// The chain with the Navigation API (links.ts): a stand-in for `navigation` whose `navigate()` fires a `navigate`
// event, as the browser does, so what a handler does with the event (cancels it, navigates again, intercepts it)
// runs here (at happy-dom's own origin, which a link to another site is told by); e2e/links runs the same in the browsers.
import { afterEach, beforeEach, expect, test } from 'vitest';
import { render } from '../../src/testing/index.js';

interface Fired { url: string; type: string; prevented: boolean; intercepted: boolean }
const fired: Fired[] = [];
/** whether the stand-in's events carry `sourceElement` (Chromium 135 on), and the element a click would give it */
let withSource = true, source: Element | null = null;

class FakeNavigation extends EventTarget {
  currentEntry = { key: 'k0', index: 0 };
  navigate(url: string, o: { history?: string; info?: unknown } = {}) {
    const f: Fired = { url: new URL(url, location.href).href, type: o.history == 'replace' ? 'replace' : 'push', prevented: false, intercepted: false };
    fired.push(f);
    const handlers: Array<() => Promise<void>> = [];
    const e = Object.assign(new Event('navigate', { cancelable: true }), {
      canIntercept: true, hashChange: false, downloadRequest: null, formData: null, navigationType: f.type, info: o.info,
      signal: new AbortController().signal, destination: { url: f.url, key: '', index: 1, sameDocument: false },
      intercept(x: { handler(): Promise<void> }) { f.intercepted = true; handlers.push(x.handler); },
    }, withSource ? { sourceElement: source } : {});
    this.dispatchEvent(e);
    f.prevented = e.defaultPrevented;
    for (const h of handlers) void h();
    return { committed: Promise.resolve(), finished: Promise.resolve() };
  }
}

const g = globalThis as { navigation?: unknown };
beforeEach(() => { g.navigation = new FakeNavigation(); fired.length = 0; withSource = true; source = null; });
afterEach(() => { delete g.navigation; });

test('typing waits to commit, then a link to this page: the guards are asked once', async () => {
  const r = await render(`<p data-sn-text="$url.sort ?? '-'"></p><input data-sn-model="$url.q">
    <div data-sn-state="{ asked: 0 }" data-sn-on-sn-navigate="asked++"><b id="asked" data-sn-text="asked"></b></div>
    <a href="?sort=new">new</a>`, { url: 'http://localhost:3000/' });
  await r.settle();
  const field = r.root.querySelector('input')!;
  field.value = 'sin'; field.dispatchEvent(new Event('input', { bubbles: true }));
  await r.flush();
  // the link's `navigate` event: cancelled while typing commits, then the link again, intercepted
  source = r.root.querySelector('a');
  (g.navigation as FakeNavigation).navigate('http://localhost:3000/?sort=new');
  await r.settle();
  expect(fired.map((f) => [f.url, f.prevented, f.intercepted])).toEqual([['http://localhost:3000/?sort=new', true, false], ['http://localhost:3000/?sort=new', false, true]]);
  expect(r.root.querySelector('#asked')!.textContent).toBe('1');
});

