// One way in (docs/proposals/swap-navigation.md, step 2): every navigation is an intent the app's handlers
// see in order (`App.nav`); the first that takes it has it, else a push or replace loads the page and a
// traversal reads `$url` again. Links become intents through one shared listener (links.ts).
import { expect, test } from 'vitest';
import { links } from '../../src/links.js';
import type { Intent } from '../../src/runtime/app.js';
import { render } from '../../src/testing/index.js';

const PAGE = `
  <span data-sn-text="$url.q ?? '-'"></span>
  <button id="go" data-sn-on-click="navigate('/next')"></button>
  <button id="rep" data-sn-on-click="navigate('/next', { replace: true })"></button>
  <a id="a" href="/other?x=1">a</a>
  <a id="tab" href="/other" target="_blank">tab</a>
  <a id="dl" href="/file" download>dl</a>
  <a id="ext" href="/elsewhere" rel="external">ext</a>
  <a id="stop" href="/stopped" data-sn-on-click="$event.preventDefault()">stop</a>`;

async function setup(take: (i: Intent) => string | undefined = () => undefined) {
  const r = await render(PAGE, { url: 'http://localhost/' });
  await r.settle();
  const seen: Intent[] = [];
  r.app.nav.push((i) => { seen.push(i); return take(i); });
  const click = async (id: string, o: MouseEventInit = {}) => {
    const ev = new MouseEvent('click', { bubbles: true, cancelable: true, ...o });
    r.root.querySelector(`#${id}`)!.dispatchEvent(ev);
    await r.settle();
    return ev.defaultPrevented;
  };
  return { ...r, seen, click };
}

test('navigate(): an intent with its kind and trigger; nothing takes it, the page loads', async () => {
  const p = await setup();
  await p.click('go');
  await p.click('rep');
  expect(p.seen.map((i) => [i.to, i.kind, (i.trigger as Element)?.id])).toEqual([
    ['http://localhost/next', 'push', 'go'],
    ['http://localhost/next', 'replace', 'rep'],
  ]);
  expect(p.navigations).toEqual(['http://localhost/next', 'replace http://localhost/next']);
});

test('a handler that takes it: no load', async () => {
  const p = await setup(() => 'mine');
  await p.click('go');
  expect(p.navigations).toEqual([]);
  expect(p.app.take({ to: 'http://localhost/x', kind: 'push' })).toBe('mine');
});

test('the first handler that takes it has it; the ones after it are not asked', async () => {
  const p = await setup(() => 'first');
  const after: Intent[] = [];
  p.app.nav.push((i) => { after.push(i); return 'second'; });
  expect(p.app.take({ to: 'http://localhost/x', kind: 'push' })).toBe('first');
  expect(after).toEqual([]);
});

test('links: a plain click is an intent; a taken one prevents the default, an untaken one is the browser\'s', async () => {
  const p = await setup((i) => (i.to.includes('?x=1') ? 'mine' : undefined));
  links(p.app);
  links(p.app); // once per app
  expect(await p.click('a')).toBe(true);
  expect(p.seen.map((i) => [i.to, i.kind, (i.trigger as Element).id])).toEqual([['http://localhost/other?x=1', 'push', 'a']]);
  // a modifier, another target, a download, rel="external", a default the page prevented: no intent
  expect(await p.click('a', { ctrlKey: true })).toBe(false);
  expect(await p.click('tab')).toBe(false);
  expect(await p.click('dl')).toBe(false);
  expect(await p.click('ext')).toBe(false);
  expect(await p.click('stop')).toBe(true);
  expect(p.seen).toHaveLength(1);
});

test('Back and Forward: a traversal intent first; taken, `$url` is not read again', async () => {
  let takeIt = false;
  const p = await setup((i) => (i.kind == 'traverse' && takeIt ? 'mine' : undefined));
  // two entries the page wrote (as a same-page link would)
  p.app.env.pushState!('http://localhost/?q=1');
  p.app.env.pushState!('http://localhost/?q=2');
  await p.back();
  expect(p.root.querySelector('span')!.textContent).toBe('1');
  takeIt = true;
  await p.back();
  // the address is the first entry, the page still shows what it read before: the handler had it
  expect(p.url()).toBe('http://localhost/');
  expect(p.root.querySelector('span')!.textContent).toBe('1');
  expect(p.seen.filter((i) => i.kind == 'traverse').map((i) => i.to)).toEqual(['http://localhost/?q=1', 'http://localhost/']);
});
