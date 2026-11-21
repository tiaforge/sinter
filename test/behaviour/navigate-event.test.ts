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

const g = globalThis as { navigation?: unknown; NavigateEvent?: unknown };
/** the browser's `NavigateEvent`, with `sourceElement` (Chromium 135 on) or without it (102 to 134) */
const events = (has: boolean) => { g.NavigateEvent = class { declare sourceElement: Element | null }; if (has) Object.defineProperty((g.NavigateEvent as { prototype: object }).prototype, 'sourceElement', { get: () => null }); };
beforeEach(() => { g.navigation = new FakeNavigation(); events(true); fired.length = 0; withSource = true; source = null; });
afterEach(() => { delete g.navigation; delete g.NavigateEvent; });

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

// Chromium 102 to 134 have the Navigation API, but their `navigate` event has no `sourceElement`: they take the path
// of browsers without the API, where a link is known by its click
test.each([true, false])('the link a navigation comes from is its trigger, with `sourceElement` or without it (%s)', async (has) => {
  events(withSource = has);
  const r = await render(`<p data-sn-text="$url.q ?? '-'"></p>
    <div data-sn-state="{ seen: '' }" data-sn-on-sn-navigate="seen = $event.to + ' ' + ($event.trigger?.id ?? '-')"><b id="seen" data-sn-text="seen"></b></div>
    <a id="here" href="?q=1">here</a><a id="ext" rel="external" href="?q=2">ext</a><a id="again" href="?q=1">again</a>
    <form id="find"><input name="q" value="9"></form>`, { url: 'http://localhost:3000/' });
  await r.settle();
  const seen = () => r.root.querySelector('#seen')!.textContent;
  /** a click on a link, and the browser's `navigate` event it fires unless the page prevented it */
  const click = (id: string) => {
    const a = r.root.querySelector(`#${id}`)!, ev = new MouseEvent('click', { bubbles: true, cancelable: true });
    a.dispatchEvent(ev);
    source = a;
    if (!ev.defaultPrevented) (g.navigation as FakeNavigation).navigate(new URL(a.getAttribute('href')!, 'http://localhost:3000/').href);
    source = null;
  };
  // with `sourceElement`, what the page does with each `navigate` event; without, the history its clicks write
  const last = () => (has ? `${fired.at(-1)!.intercepted} ${fired.at(-1)!.prevented}` : r.history().join(' '));
  // a link to this page: in the page
  click('here');
  await r.settle();
  expect(seen()).toBe('http://localhost:3000/?q=1 here');
  expect(last()).toBe(has ? 'true false' : 'http://localhost:3000/ http://localhost:3000/?q=1');
  // a link to the URL shown changes nothing (the stand-in's entries do not change the page's URL: only without it)
  click('again');
  await r.settle();
  expect(seen()).toBe('http://localhost:3000/?q=1 again');
  if (!has) expect(last()).toBe('http://localhost:3000/ http://localhost:3000/?q=1');
  // a same-origin link with `rel="external"`, a GET form: the browser's (a load)
  click('ext');
  await r.settle();
  expect(seen()).toBe('http://localhost:3000/?q=2 ext');
  expect(last()).toBe(has ? 'false false' : 'http://localhost:3000/ http://localhost:3000/?q=1');
  source = r.root.querySelector('#find');
  (g.navigation as FakeNavigation).navigate('http://localhost:3000/?q=9');
  await r.settle();
  expect(last()).toBe(has ? 'false false' : 'http://localhost:3000/ http://localhost:3000/?q=1');
  // without `sourceElement`, no `navigate` event is taken
  if (!has) expect(fired.every((f) => !f.prevented && !f.intercepted)).toBe(true);
});
