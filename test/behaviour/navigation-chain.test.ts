// One way in (docs/proposals/swap-navigation.md, step 2): every navigation is an intent the app's handlers
// decide on (one chain per document, links.ts); every handler is asked, the core runs the first decision, and what happens without
// one (or when it cannot run) is the core's alone, by the intent's source. Links become intents through
// one shared listener (links.ts).
import { expect, test } from 'vitest';
import { RANK, chain, links } from '../../src/links.js';
import type { Decision, Intent } from '../../src/runtime/app.js';
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

async function setup(decide: (i: Intent) => Decision | undefined = () => undefined) {
  const r = await render(PAGE, { url: 'http://localhost/' });
  await r.settle();
  const seen: Intent[] = [], ran: string[] = [];
  const c = chain(r.app);
  c.add((i) => { seen.push(i); return decide(i); }, RANK.same);
  const click = async (id: string, o: MouseEventInit = {}) => {
    const ev = new MouseEvent('click', { bubbles: true, cancelable: true, ...o });
    r.root.querySelector(`#${id}`)!.dispatchEvent(ev);
    await r.settle();
    return ev.defaultPrevented;
  };
  return { ...r, c, seen, ran, click };
}

test('navigate(): an intent with its source, kind and trigger; no decision, the page loads', async () => {
  const p = await setup();
  await p.click('go');
  await p.click('rep');
  expect(p.seen.map((i) => [i.to, i.kind, i.source, (i.trigger as Element)?.id, i.from])).toEqual([
    ['http://localhost/next', 'push', 'call', 'go', 'http://localhost/'],
    ['http://localhost/next', 'replace', 'call', 'rep', 'http://localhost/'],
  ]);
  expect(p.navigations).toEqual(['http://localhost/next', 'replace http://localhost/next']);
});

test('a decision runs, once, and nothing loads; a run that cannot (false) is a load, by the core', async () => {
  let ok = true;
  const p = await setup(() => ({ name: 'mine', run: () => { p.ran.push('run'); return ok; } }));
  await p.click('go');
  expect(p.ran).toEqual(['run']);
  expect(p.navigations).toEqual([]);
  ok = false;
  await p.click('go');
  expect(p.navigations).toEqual(['http://localhost/next']);
});

test('every handler is asked; the first decision is the one that runs', async () => {
  const p = await setup(() => ({ name: 'first', run: () => { p.ran.push('first'); } }));
  const after: Intent[] = [];
  p.c.add((i) => { after.push(i); return { name: 'second', run: () => { p.ran.push('second'); } }; }, RANK.swap);
  expect(p.c.go({ from: 'http://localhost/', to: 'http://localhost/x', kind: 'push', source: 'call' })?.name).toBe('first');
  expect(after).toHaveLength(1);
  expect(p.ran).toEqual(['first']);
});

test('deciding runs nothing (next-page data asks), and observers see only what goes', async () => {
  const p = await setup(() => ({ name: 'mine', run: () => { p.ran.push('run'); } }));
  const went: string[] = [];
  p.c.onGo.push((i) => went.push(i.to));
  expect(p.c.decide({ from: 'http://localhost/', to: 'http://localhost/x', kind: 'push', source: 'link' })?.name).toBe('mine');
  expect(p.ran).toEqual([]);
  expect(went).toEqual([]);
  p.c.go({ from: 'http://localhost/', to: 'http://localhost/y', kind: 'push', source: 'call' });
  expect(went).toEqual(['http://localhost/y']);
});

test('links: a plain click is an intent; a decision prevents the default, none leaves it to the browser', async () => {
  const p = await setup((i) => (i.to.includes('?x=1') ? { name: 'mine' } : undefined));
  links(p.app);
  links(p.app); // once per app
  expect(await p.click('a')).toBe(true);
  expect(p.seen.map((i) => [i.to, i.kind, i.source, (i.trigger as Element).id])).toEqual([['http://localhost/other?x=1', 'push', 'link', 'a']]);
  // no decision for a link: the browser follows it, the core loads nothing itself
  p.c.go({ from: 'http://localhost/', to: 'http://localhost/elsewhere', kind: 'push', source: 'link' });
  expect(p.navigations).toEqual([]);
  // a modifier, another target, a download, rel="external", a default the page prevented: no intent
  const before = p.seen.length;
  expect(await p.click('a', { ctrlKey: true })).toBe(false);
  expect(await p.click('tab')).toBe(false);
  expect(await p.click('dl')).toBe(false);
  expect(await p.click('ext')).toBe(false);
  expect(await p.click('stop')).toBe(true);
  expect(p.seen.length).toBe(before);
});

test('Back and Forward: a traversal intent first; decided, `$url` is not read again', async () => {
  let takeIt = false;
  const p = await setup((i) => (i.kind == 'traverse' && takeIt ? { name: 'mine' } : undefined));
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
  expect(p.seen.filter((i) => i.kind == 'traverse').map((i) => [i.to, i.source])).toEqual([['http://localhost/?q=1', 'popstate'], ['http://localhost/', 'popstate']]);
});

test('handlers are asked in their rank, not in the order they were added', async () => {
  const p = await setup(() => undefined);
  const order: string[] = [];
  p.c.add(() => { order.push('swap'); }, RANK.swap);
  p.c.add(() => { order.push('views'); }, RANK.views);
  p.c.decide({ to: 'http://localhost/x', kind: 'push', source: 'link' });
  // the setup's handler has the rank of same-page links
  expect(order).toEqual(['views', 'swap']);
  expect(p.seen).toHaveLength(1);
});

test('a guard refuses when the navigation goes: nothing runs, nothing loads; deciding asks no guard', async () => {
  const p = await setup(() => ({ name: 'mine', run: () => { p.ran.push('run'); } }));
  const asked: string[] = [];
  p.c.guards.push((i) => { asked.push(i.to); return true; });
  // asked (next-page data): no guard
  p.c.decide({ to: 'http://localhost/a', kind: 'push', source: 'link' });
  expect(asked).toEqual([]);
  expect(p.c.go({ to: 'http://localhost/next', kind: 'push', source: 'call' })?.name).toBe('refused');
  await p.settle();
  expect(asked).toEqual(['http://localhost/next']);
  expect(p.ran).toEqual([]);
  expect(p.navigations).toEqual([]);
  // a refused link: its default prevented
  links(p.app);
  expect(await p.click('a')).toBe(true);
});

/** a stand-in app on an element of the document: what the chain reads of one */
function fakeApp(id: string) {
  const root = document.createElement('div'), cleanups: Array<() => void> = [], loads: string[] = [];
  root.id = id;
  document.body.append(root);
  const app = {
    root, ext: {}, loads,
    env: { href: () => 'http://localhost/', navigate: (u: string) => { loads.push(u); } },
    addCleanup: (f: () => void) => { cleanups.push(f); },
    destroy: () => { for (const f of cleanups.splice(0)) f(); root.remove(); },
  };
  return app as unknown as Parameters<typeof chain>[0] & { loads: string[]; destroy(): void };
}

test('one chain per document: two apps share its handlers in rank order, and a guard of either refuses for both', async () => {
  // (the earlier tests' app goes: the harness destroys it at the next render)
  await render('<p></p>');
  const a = fakeApp('a'), b = fakeApp('b'), order: string[] = [];
  chain(a).add(() => { order.push('a, swap'); }, RANK.swap);
  chain(b).add(() => { order.push('b, same'); }, RANK.same);
  // asked from either app: both handlers, in rank order
  chain(a).decide({ to: 'http://localhost/x', kind: 'push', source: 'link' });
  expect(order).toEqual(['b, same', 'a, swap']);
  // a guard of b refuses a's navigation: nothing loads
  let dirty = true;
  chain(b).guards.push(() => dirty);
  expect(chain(a).go({ to: 'http://localhost/next', kind: 'push', source: 'call' })?.name).toBe('refused');
  expect(a.loads).toEqual([]);
  // b goes, with its handlers and guards: a's navigation loads (with a's env)
  b.destroy();
  order.length = 0;
  expect(chain(a).go({ to: 'http://localhost/next', kind: 'push', source: 'call' })).toBeUndefined();
  expect(order).toEqual(['a, swap']);
  expect(a.loads).toEqual(['http://localhost/next']);
  dirty = false;
  a.destroy();
});
