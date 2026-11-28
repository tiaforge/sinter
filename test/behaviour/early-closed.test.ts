// A `data-sn-if` that the state's initial values close is not in the early file (docs/first-paint.md, "What an early
// file leaves out"): the early script would evaluate it false and render nothing. The first paint is the same with
// and without it, the page module takes over without writing, and the branch opens when its state changes. Whatever
// the early script may see differently from the build (a stored value, the URL, a value the build cannot compute)
// keeps the binding early, and its branch in the first paint.
import { afterEach, expect, test } from 'vitest';
import { firstPaint, mockRequests, render } from '../../src/testing/index.js';
import { compileParts } from '../../src/compiler/compile.js';
import type { CompileOptions } from '../../src/compiler/index.js';

afterEach(() => { localStorage.clear(); sessionStorage.clear(); });

const doc = (body: string, head = '') => `<!doctype html><html><head>${head}</head>${body}</html>`;
/** the early file's `if` bindings of a page, by the id of the element in each branch */
function earlyIfs(html: string, components: Record<string, string> = {}): number {
  const opts: CompileOptions = { file: '/app/index.html', root: '/app', dev: false, readFile: (f) => components[f.replace(/^.*\/([\w-]+)\.html$/, '$1')] ?? '', moduleSrc: '/page.js', helpers: { module: '/h.js', names: [], namespaces: {} }, prerender: true, early: { module: null } };
  const ir = compileParts(html, opts).early?.ir;
  if (!ir) return 0;
  return [...ir.roots, ...ir.templates.flatMap((t) => t?.nodes ?? [])].flatMap((n) => n.b).filter((b) => b.k === 'if').length;
}
const has = (id: string) => document.getElementById(id) !== null;
const click = (id: string) => (document.getElementById(id) as HTMLElement).click();

/** mounts over the first paint, and returns what the takeover wrote into the body (it should be nothing) */
async function takeover(html: string, options: Parameters<typeof render>[1] = {}) {
  const records: MutationRecord[] = [];
  let painted = '';
  const o = new MutationObserver((rs) => { records.push(...rs); });
  const r = await render(html, { ...options, firstPaint: { afterEarly: () => { painted = document.body.innerHTML; o.observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true }); } } });
  await r.settle();
  records.push(...o.takeRecords());
  o.disconnect();
  // (the page module's own marks on what it adopted are not content)
  const wrote = records.filter((m) => m.type !== 'attributes' || !/^data-sn/.test(m.attributeName ?? ''));
  return { ...r, painted, wrote: wrote.map((m) => `${m.type} ${m.target.nodeName}${m.attributeName ? ` ${m.attributeName}` : ''}`) };
}

const MENU = doc(`<body data-sn-state="{ open: false, on: false }">
  <input id="on" type="checkbox" data-sn-model="on" data-sn-persist="on">
  <button id="t" data-sn-on-click="open = !open">menu</button>
  <template data-sn-if="open"><nav id="menu">menu</nav></template>
</body>`);

test('a branch the initial state closes: not in the early file, not in the first paint, and it opens with its state', async () => {
  expect(earlyIfs(MENU)).toBe(0);
  await firstPaint(MENU);
  expect(has('menu')).toBe(false);
  const { wrote, flush } = await takeover(MENU);
  expect(wrote).toEqual([]);
  expect(has('menu')).toBe(false);
  click('t');
  await flush();
  expect(has('menu')).toBe(true);
  click('t');
  await flush();
  expect(has('menu')).toBe(false);
});

test('a page whose only early binding is such a branch has no early file', () => {
  const html = doc('<body data-sn-state="{ open: false }"><button data-sn-on-click="open = true">o</button><template data-sn-if="open"><p>x</p></template></body>');
  const opts: CompileOptions = { file: '/app/index.html', root: '/app', dev: false, readFile: () => '', moduleSrc: '/page.js', helpers: { module: '/h.js', names: [], namespaces: {} }, prerender: true, early: { module: null } };
  expect(compileParts(html, opts).early ?? null).toBeNull();
});

test('a branch the initial state opens stays early, and is taken over', async () => {
  const html = MENU.replace('open: false', 'open: true');
  expect(earlyIfs(html)).toBe(1);
  await firstPaint(html);
  expect(has('menu')).toBe(true);
  let early: Element | null = null;
  const r = await render(html, { firstPaint: { afterEarly: () => { early = document.getElementById('menu'); } } });
  await r.settle();
  expect(early).not.toBeNull();
  expect(document.getElementById('menu')).toBe(early);
});

test('an else, and an else-if chain: kept, the else is in the first paint and taken over', async () => {
  const html = doc(`<body data-sn-state="{ open: false, a: false, b: false, on: false }">
    <input type="checkbox" data-sn-model="on" data-sn-persist="on">
    <button id="t" data-sn-on-click="open = true; a = true; b = true">o</button>
    <template data-sn-if="open"><p id="yes">y</p></template><template data-sn-else><p id="no">n</p></template>
    <template data-sn-if="a"><p id="ca">a</p></template><template data-sn-else data-sn-if="b"><p id="cb">b</p></template><template data-sn-else><p id="cc">c</p></template>
  </body>`);
  await firstPaint(html);
  expect([has('yes'), has('no'), has('ca'), has('cb'), has('cc')]).toEqual([false, true, false, false, true]);
  let no: Element | null = null, cc: Element | null = null;
  const r = await render(html, { firstPaint: { afterEarly: () => { no = document.getElementById('no'); cc = document.getElementById('cc'); } } });
  await r.settle();
  expect(no).not.toBeNull();
  expect(document.getElementById('no')).toBe(no);
  expect(document.getElementById('cc')).toBe(cc);
  click('t');
  await r.flush();
  expect([has('yes'), has('no'), has('ca'), has('cb'), has('cc')]).toEqual([true, false, true, false, false]);
});

test('a persisted model writes the field the branch reads: kept, and the stored value opens it in the first paint', async () => {
  const html = doc(`<body data-sn-state="{ open: false }">
    <input id="m" type="checkbox" data-sn-model="open" data-sn-persist="menu-open">
    <template data-sn-if="open"><nav id="menu">menu</nav></template>
  </body>`);
  expect(earlyIfs(html)).toBe(1);
  await firstPaint(html, { storage: localStorage });
  expect(has('menu')).toBe(false);
  localStorage.setItem('sn:menu-open', 'true');
  await firstPaint(html, { storage: localStorage });
  expect(has('menu')).toBe(true);
  const { wrote } = await takeover(html, { storage: localStorage });
  expect(wrote).toEqual([]);
  expect(has('menu')).toBe(true);
});

test('a persisted state: kept, and the stored field opens the branch in the first paint', async () => {
  const html = doc(`<body><div data-sn-state="{ open: false }" data-sn-persist="ui">
    <button data-sn-on-click="open = !open">t</button>
    <template data-sn-if="open"><nav id="menu">menu</nav></template>
  </div></body>`);
  expect(earlyIfs(html)).toBe(1);
  localStorage.setItem('sn:ui', '{"open":true}');
  await firstPaint(html, { storage: localStorage });
  expect(has('menu')).toBe(true);
});

test('a field that reads another state\'s field: left out when that one is the build\'s value in the browser too, kept behind a persisted one', async () => {
  const html = (persist: string) => doc(`<body data-sn-state="{ pinned: false, on: false }">
    <input type="checkbox" data-sn-model="on" data-sn-persist="on">
    <input id="p" type="checkbox" data-sn-model="pinned"${persist}>
    <div data-sn-state="{ shown: pinned }"><button data-sn-on-click="shown = !shown">t</button><template data-sn-if="shown"><nav id="menu">menu</nav></template></div>
  </body>`);
  expect(earlyIfs(html(''))).toBe(0);
  expect(earlyIfs(html(' data-sn-persist="pinned"'))).toBe(1);
  // the stored value reaches the inner state as the early script makes it, and the page module agrees
  localStorage.setItem('sn:pinned', 'true');
  const stored = await takeover(html(' data-sn-persist="pinned"'), { storage: localStorage });
  expect(stored.wrote).toEqual([]);
  // a field over another field of its own state is no build-time value: kept
  expect(earlyIfs(doc('<body data-sn-state="{ a: false, b: a, on: false }"><input type="checkbox" data-sn-model="on" data-sn-persist="on"><button data-sn-on-click="b = !b">t</button><template data-sn-if="b"><p>x</p></template></body>'))).toBe(1);
});

test('what the build cannot evaluate keeps the binding: the URL, the clock, a helper, a method that answers for a locale', async () => {
  const one = (state: string, cond: string, names: string[] = []) => {
    const html = doc(`<body data-sn-state="${state}"><input type="checkbox" data-sn-model="on" data-sn-persist="on"><button data-sn-on-click="open = !open">t</button><template data-sn-if="${cond}"><p id="x">x</p></template></body>`);
    const opts: CompileOptions = { file: '/app/index.html', root: '/app', dev: false, readFile: () => '', moduleSrc: '/page.js', helpers: { module: '/h.js', names, namespaces: {} }, prerender: true, early: { module: null } };
    const ir = compileParts(html, opts).early?.ir;
    return ir ? ir.roots.flatMap((n) => n.b).filter((b) => b.k === 'if').length : 0;
  };
  // the reference: closed, and left out
  expect(one('{ open: false, on: false }', 'open')).toBe(0);
  expect(one("{ open: false, sel: { busy: false, keys: [] }, on: false }", 'open || (!sel.busy && sel.keys.length > 0)')).toBe(0);
  // a condition with a call of any kind is not read: kept
  expect(one("{ open: false, sel: { busy: false, keys: [] }, on: false }", "open || sel.keys.includes('a')")).toBe(1);
  expect(one('{ open: false, on: false }', 'open && $url.menu')).toBe(1);
  expect(one('{ open: false, on: false }', '$url.menu')).toBe(1);
  expect(one('{ open: !!$url.menu, on: false }', 'open')).toBe(1);
  expect(one('{ open: Math.random() > 2, on: false }', 'open')).toBe(1);
  expect(one('{ open: closed(), on: false }', 'open', ['closed'])).toBe(1);
  expect(one('{ open: false, on: false }', 'closed(open)', ['closed'])).toBe(1);
  expect(one("{ open: false, name: 'i', on: false }", "open && name.toLocaleUpperCase() === 'I'")).toBe(1);
  expect(one("{ open: false, name: 'i'.toLocaleUpperCase(), on: false }", "open && name === 'X'")).toBe(1);
});

test('the URL opens a branch over state it initializes, in the first paint', async () => {
  const html = doc(`<body data-sn-state="{ open: $url.menu == '1' }"><button data-sn-on-click="open = !open">t</button><template data-sn-if="open"><nav id="menu">menu</nav></template></body>`);
  expect(earlyIfs(html)).toBe(1);
});

const ROWS = doc(`<body data-sn-state="{ open: false }">
  <sn-resource name="list" src="/api/list"></sn-resource>
  <button id="t" data-sn-on-click="open = !open">t</button>
  <ul><template data-sn-for="x in list"><li><template data-sn-if="open"><i class="more" data-sn-text="x.t"></i></template><template data-sn-if="x.on"><b class="on" data-sn-text="x.t"></b></template></li></template></ul>
</body>`, '<script type="application/json" data-sn-resource="list">[{"t":"a","on":true},{"t":"b","on":false}]</script>');

test('in a row over embedded data: the branch over state is left out of the row, the one over the item is painted', async () => {
  // the list, and the row's branch over the item
  expect(earlyIfs(ROWS)).toBe(1);
  await firstPaint(ROWS);
  expect(document.querySelectorAll('li').length).toBe(2);
  expect(document.querySelectorAll('b.on').length).toBe(1);
  expect(document.querySelectorAll('i.more').length).toBe(0);
  const { wrote, flush } = await takeover(ROWS);
  expect(wrote).toEqual([]);
  click('t');
  await flush();
  expect([...document.querySelectorAll('i.more')].map((e) => e.textContent)).toEqual(['a', 'b']);
});

const COMPONENTS = {
  'c-menu': '<template data-sn-props="{ open: boolean, id: string }"><div><template data-sn-if="open"><nav data-sn-attr="{ id: id }">menu</nav></template></div></template>',
  'c-own': '<template data-sn-props="{ id: string, first: boolean }"><div data-sn-state="{ shown: first }"><button data-sn-attr="{ id: id + \'-t\' }" data-sn-on-click="shown = !shown">t</button><template data-sn-if="shown"><nav data-sn-attr="{ id: id }">menu</nav></template></div></template>',
};

test('in a component: closed in one use and open in another, by the state each use passes or starts with', async () => {
  const html = doc(`<body data-sn-state="{ a: false, b: true }">
    <button id="t" data-sn-on-click="a = !a; b = !b">t</button>
    <c-menu data-sn-with="{ open: a, id: 'ma' }"></c-menu>
    <c-menu data-sn-with="{ open: b, id: 'mb' }"></c-menu>
    <c-menu data-sn-with="{ open: !!$url.menu, id: 'mu' }"></c-menu>
    <c-own data-sn-with="{ id: 'oa', first: false }"></c-own>
    <c-own data-sn-with="{ id: 'ob', first: true }"></c-own>
  </body>`);
  await firstPaint(html, { components: COMPONENTS });
  expect([has('ma'), has('mb'), has('mu'), has('oa'), has('ob')]).toEqual([false, true, false, false, true]);
  const { wrote, flush } = await takeover(html, { components: COMPONENTS });
  expect(wrote).toEqual([]);
  expect([has('ma'), has('mb'), has('mu'), has('oa'), has('ob')]).toEqual([false, true, false, false, true]);
  click('t');
  click('oa-t');
  click('ob-t');
  await flush();
  expect([has('ma'), has('mb'), has('mu'), has('oa'), has('ob')]).toEqual([true, false, false, true, false]);
  // with the URL: the third use's branch is in the first paint
  const withUrl = await takeover(html, { components: COMPONENTS, url: 'http://localhost/?menu=1' });
  expect(withUrl.painted).toContain('id="mu"');
  expect(withUrl.wrote).toEqual([]);
});

test('Back to the page, its rows from the page cache: the branch is closed as on a load, and the page takes over', async () => {
  const html = doc(`<body data-sn-state="{ open: false }">
    <sn-resource name="list" src="/api/list" key="id"></sn-resource>
    <button id="t" data-sn-on-click="open = !open">t</button>
    <template data-sn-if="open"><nav id="menu">menu</nav></template>
    <template data-sn-if="$meta.list.loading && !list.length"><p id="loading">…</p></template>
    <ul><template data-sn-for="x in list"><li data-sn-text="x.t"></li></template></ul>
  </body>`);
  const requests = () => mockRequests({ 'GET /api/list': [{ id: 1, t: 'a' }] });
  // the first visit: opened, then left (the page writes what it showed)
  const first = await render(html, { requests: requests(), session: sessionStorage, firstPaint: true });
  await first.settle();
  click('t');
  await first.flush();
  expect(has('menu')).toBe(true);
  // back (the next render leaves the first page, which writes its rows): state starts again, it is not stored
  let painted: boolean | null = null;
  const back = await render(html, { requests: requests(), session: sessionStorage, traverse: true, firstPaint: { afterEarly: () => { painted = has('menu'); } } });
  expect(painted).toBe(false);
  await back.settle();
  expect(has('menu')).toBe(false);
  expect(document.querySelectorAll('li').length).toBe(1);
  click('t');
  await back.flush();
  expect(has('menu')).toBe(true);
});

test('a model that is not persisted: its setter is not in the early file', () => {
  const code = (persist: string) => {
    const html = doc(`<body data-sn-state="{ q: 'x', on: false }"><input type="checkbox" data-sn-model="on" data-sn-persist="on"><input data-sn-model="q"${persist}></body>`);
    const opts: CompileOptions = { file: '/app/index.html', root: '/app', dev: false, readFile: () => '', moduleSrc: '/page.js', helpers: { module: '/h.js', names: [], namespaces: {} }, prerender: true, early: { module: null } };
    return compileParts(html, opts).early!.fns.join('\n');
  };
  expect(code(' data-sn-persist="q"')).toContain('$.$s0.q = v');
  expect(code('')).not.toContain('$.$s0.q = v');
  // (the persisted one's stays)
  expect(code('')).toContain('$.$s0.on = v');
});
