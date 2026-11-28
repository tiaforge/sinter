// A `data-sn-if` whose condition is false when the page starts is not in the early file (docs/first-paint.md, "What an
// early file leaves out"): the early script would render nothing for it, and the page module mounts with it closed.
// The rule is small on purpose: the condition reads whole state fields, literals and operators; each field starts with
// a primitive written as a literal (or computed by the build and embedded) that nothing stored can replace. The first
// paint is the same with and without the binding, the page module takes over without writing, and the branch opens
// when its state changes. Anything else keeps the binding early, and its branch in the first paint. The tests under
// "one guard each" fail when exactly that guard is taken out of the rule.
import { afterEach, describe, expect, test } from 'vitest';
import { firstPaint, mockRequests, render } from '../../src/testing/index.js';
import { compileParts } from '../../src/compiler/compile.js';
import type { CompileOptions } from '../../src/compiler/index.js';
import type { FoldVerdict } from '../../src/fold-check.js';

afterEach(() => { localStorage.clear(); sessionStorage.clear(); });

const doc = (body: string, head = '') => `<!doctype html><html><head>${head}</head>${body}</html>`;
const yes: FoldVerdict = { fold: true };
/** the early file's `if` bindings of a page (`helpers`: functions the build may call, their values folded; one given as `undefined` is the browser's alone) */
function earlyIfs(html: string, components: Record<string, string> = {}, helpers: Record<string, unknown> = {}): number {
  const opts: CompileOptions = { file: '/app/index.html', root: '/app', dev: false, readFile: (f) => components[f.replace(/^.*\/([\w-]+)\.html$/, '$1')] ?? '', moduleSrc: '/page.js', helpers: { module: '/h.js', names: Object.keys(helpers), namespaces: {} }, helperValues: Object.fromEntries(Object.entries(helpers).filter(([, v]) => v !== undefined)), helperFold: new Map(Object.keys(helpers).filter((k) => helpers[k] !== undefined).map((k) => [k, yes])), prerender: true, early: { module: null } };
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

test('a page whose only early binding is such a branch keeps an early file, with nothing in it (what a build ties to it stays: fonts after the load)', async () => {
  const html = doc('<body data-sn-state="{ open: false }"><button id="t" data-sn-on-click="open = true">o</button><template data-sn-if="open"><p id="x">x</p></template></body>');
  const opts: CompileOptions = { file: '/app/index.html', root: '/app', dev: false, readFile: () => '', moduleSrc: '/page.js', helpers: { module: '/h.js', names: [], namespaces: {} }, prerender: true, early: { module: null } };
  const early = compileParts(html, opts).early;
  expect(early).toMatchObject({ ir: { roots: [], templates: [] }, fns: [] });
  // a page with nothing early at all has none, as before
  expect(compileParts(html.replace('<template data-sn-if="open"><p id="x">x</p></template>', ''), opts).early ?? null).toBeNull();
  // and it loads as any page: the page module waits for the early file, which does nothing
  const { wrote, flush } = await takeover(html);
  expect(wrote).toEqual([]);
  click('t');
  await flush();
  expect(has('x')).toBe(true);
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

test('an else: kept, the else is in the first paint and taken over; an else-if chain: each branch an if of its own, the open one painted', async () => {
  const html = doc(`<body data-sn-state="{ open: false, a: false, b: false, on: false }">
    <input type="checkbox" data-sn-model="on" data-sn-persist="on">
    <button id="t" data-sn-on-click="open = true; a = true; b = true">o</button>
    <template data-sn-if="open"><p id="yes">y</p></template><template data-sn-else><p id="no">n</p></template>
    <template data-sn-if="a"><p id="ca">a</p></template><template data-sn-else data-sn-if="b"><p id="cb">b</p></template><template data-sn-else><p id="cc">c</p></template>
  </body>`);
  // the if with an else, and the chain's open branch (`!(a || b)`); its two closed ones are left out
  expect(earlyIfs(html)).toBe(2);
  await firstPaint(html);
  expect([has('yes'), has('no'), has('ca'), has('cb'), has('cc')]).toEqual([false, true, false, false, true]);
  // a chain whose middle branch is open at the start: that one is painted
  const mid = html.replace('b: false', 'b: true');
  await firstPaint(mid);
  expect([has('ca'), has('cb'), has('cc')]).toEqual([false, true, false]);
  expect((await takeover(mid)).wrote).toEqual([]);
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

test('a field that reads another state\'s field is not known to start as written: kept, and a stored value reaches it in the first paint', async () => {
  const html = (persist: string) => doc(`<body data-sn-state="{ pinned: false, on: false }">
    <input type="checkbox" data-sn-model="on" data-sn-persist="on">
    <input id="p" type="checkbox" data-sn-model="pinned"${persist}>
    <div data-sn-state="{ shown: pinned }"><button data-sn-on-click="shown = !shown">t</button><template data-sn-if="shown"><nav id="menu">menu</nav></template></div>
  </body>`);
  expect(earlyIfs(html(''))).toBe(1);
  expect(earlyIfs(html(' data-sn-persist="pinned"'))).toBe(1);
  // the stored value reaches the inner state as the early script makes it, and the page module agrees
  localStorage.setItem('sn:pinned', 'true');
  const stored = await takeover(html(' data-sn-persist="pinned"'), { storage: localStorage });
  expect(stored.painted).toContain('id="menu"');
  expect(stored.wrote).toEqual([]);
});

/** the names of a state literal's own fields */
const fieldsOf = (state: string) => { const out: string[] = []; let depth = 0; for (const m of state.matchAll(/[{}[\]]|(?<![\w$'.])([A-Za-z_]\w*)\s*:/g)) { if (m[1]) { if (depth === 1) out.push(m[1]); } else depth += '{['.includes(m[0]) ? 1 : -1; } return out; };
/**
 * a page with one branch over `cond`, its state `state`; a handler writes every field (none is a constant of the build),
 * and a persisted model of another field (`on`) keeps the page an early file
 */
const one = (state: string, cond: string, more = '') => doc(`<body data-sn-state="${state}"><input type="checkbox" data-sn-model="on" data-sn-persist="on"><button id="t" data-sn-on-click="${fieldsOf(state).filter((k) => k !== 'on').map((k) => `${k} = ${k === 'open' ? '!open' : k}`).join('; ')}">t</button>${more}<template data-sn-if="${cond}"><p id="x">x</p></template></body>`);

test('the values a field may start with: a string, a number, a negative number, a boolean, null, as literals', () => {
  expect(earlyIfs(one('{ open: false, on: false }', 'open'))).toBe(0);
  expect(earlyIfs(one("{ open: false, view: 'grid', on: false }", "view !== 'grid'"))).toBe(0);
  expect(earlyIfs(one('{ open: false, n: 3, on: false }', 'n > 5 || open'))).toBe(0);
  expect(earlyIfs(one('{ open: false, n: -1, on: false }', 'n >= 0'))).toBe(0);
  expect(earlyIfs(one('{ open: false, sel: null, on: false }', 'sel !== null'))).toBe(0);
  expect(earlyIfs(one("{ open: false, q: '', on: false }", '`${q}` || (open ? 1 : 0)'))).toBe(0);
  // open at the start: kept
  expect(earlyIfs(one("{ open: false, view: 'grid', on: false }", "view === 'grid'"))).toBe(1);
  expect(earlyIfs(one('{ open: false, sel: null, on: false }', 'sel === null'))).toBe(1);
});

describe('one guard each: the page is closed at the start in every case, and only the guard keeps the binding', () => {
  test('a member of what a field holds is not read (a string\'s length, an object\'s field)', () => {
    expect(earlyIfs(one("{ open: false, name: '', on: false }", 'name.length'))).toBe(1);
    expect(earlyIfs(one('{ open: false, sel: { busy: false }, on: false }', 'open || sel.busy'))).toBe(1);
  });

  test('a call of any kind is not read: a global, a helper, a method that answers for a locale', () => {
    expect(earlyIfs(one('{ open: false, on: false }', "open || Number('1') > 2"))).toBe(1);
    expect(earlyIfs(one('{ open: false, on: false }', 'closed(open)'), {}, { closed: () => false })).toBe(1);
    expect(earlyIfs(one("{ open: false, name: 'i', on: false }", "open && name.toLocaleUpperCase() === 'I'"))).toBe(1);
  });

  test('anything but a state\'s field is not read: the URL', () => {
    expect(earlyIfs(one('{ open: false, on: false }', 'open && $url.menu'))).toBe(1);
    expect(earlyIfs(one('{ open: false, on: false }', '$url.menu'))).toBe(1);
  });

  test('an initializer that is not a literal: operators, another field, the URL, a call', () => {
    expect(earlyIfs(one('{ open: false, n: 1 + 1, on: false }', 'n > 5'))).toBe(1);
    expect(earlyIfs(one('{ open: !true, on: false }', 'open'))).toBe(1);
    expect(earlyIfs(doc('<body data-sn-state="{ a: false, b: a, on: false }"><input type="checkbox" data-sn-model="on" data-sn-persist="on"><button data-sn-on-click="b = !b">t</button><template data-sn-if="b"><p>x</p></template></body>'))).toBe(1);
    expect(earlyIfs(one('{ open: !!$url.menu, on: false }', 'open'))).toBe(1);
    expect(earlyIfs(one('{ open: Math.random() > 2, on: false }', 'open'))).toBe(1);
    expect(earlyIfs(one('{ open: closed(), on: false }', 'open'), {}, { closed: undefined })).toBe(1);
    expect(earlyIfs(one("{ open: false, name: 'i'.toLocaleUpperCase(), on: false }", "open && name === 'X'"))).toBe(1);
  });

  test('a field that holds a list or an object, read whole', () => {
    expect(earlyIfs(one('{ open: false, list: [], on: false }', '!list'))).toBe(1);
    expect(earlyIfs(one('{ open: false, sel: {}, on: false }', "sel == ''"))).toBe(1);
  });

  test('a value the build computed that is no primitive once read back from its JSON (an object)', () => {
    const made = one("{ open: false, conf: make('a'), on: false }", '!conf', '<b data-sn-text="on ? conf.k : \'\'"></b><button data-sn-on-click="conf = null">x</button>');
    expect(earlyIfs(made, {}, { make: (k: string) => ({ k }) })).toBe(1);
    // (a primitive one is read: closed, and left out)
    const flag = one("{ open: false, big: over('a'), on: false }", 'big', '<b data-sn-text="on ? big : \'\'"></b><button data-sn-on-click="big = true">x</button>');
    expect(earlyIfs(flag, {}, { over: (k: string) => k.length > 3 })).toBe(0);
  });

  test('a persisted model of the field itself', () => {
    expect(earlyIfs(one('{ open: false, on: false }', 'on'))).toBe(1);
  });

  test('a persisted state\'s field', () => {
    expect(earlyIfs(doc('<body><div data-sn-state="{ open: false }" data-sn-persist="ui"><button data-sn-on-click="open = !open">t</button><template data-sn-if="open"><p>x</p></template></div></body>'))).toBe(1);
  });

  test('a persisted model that writes below a field, anywhere on the page: nothing on the page is taken to start as written', () => {
    expect(earlyIfs(one('{ open: false, prefs: { dense: false }, on: false }', 'open', '<input type="checkbox" data-sn-model="prefs.dense" data-sn-persist="dense">'))).toBe(1);
    expect(earlyIfs(one('{ open: false, list: [{ done: false }], on: false }', 'open', '<template data-sn-for="x in list"><input type="checkbox" data-sn-model="x.done" data-sn-persist="done"></template>'))).toBe(1);
  });

  test('a condition that throws over the values is not known to be false', () => {
    expect(earlyIfs(one('{ open: false, on: false }', "'a' in open"))).toBe(1);
  });
});

// The cases below are the review's (round 1 of the branch): each passes on main, and failed while the rule followed a
// condition into what its fields hold. A copy of an object is the object: a persisted model that writes through the
// copy writes what the condition reads.
describe('what a stored value reaches through a copy of an object opens the branch in the first paint', () => {
  async function opensInFirstPaint(html: string, key: string, stored: string, id: string, options: Parameters<typeof render>[1] = {}) {
    // nothing stored: closed
    await firstPaint(html, { ...options, storage: localStorage });
    expect(has(id)).toBe(false);
    // the stored value: the early script applies it (`pm`), and the object the condition reads is the one it wrote
    localStorage.setItem(key, stored);
    await firstPaint(html, { ...options, storage: localStorage });
    expect(has(id), 'the branch is in the first paint').toBe(true);
    const t = await takeover(html, { ...options, storage: localStorage });
    expect(t.painted).toContain(`id="${id}"`);
    expect(t.wrote, 'the takeover writes nothing').toEqual([]);
    expect(has(id)).toBe(true);
  }

  test('a child state copies an object, a persisted model writes into the copy', async () => {
    await opensInFirstPaint(doc(`<body data-sn-state="{ prefs: { open: false } }">
      <div data-sn-state="{ mine: prefs }"><input type="checkbox" data-sn-model="mine.open" data-sn-persist="k"></div>
      <template data-sn-if="prefs.open"><nav id="menu">menu</nav></template>
    </body>`), 'sn:k', 'true', 'menu');
  });

  test('the branch before the model in the document, and two copies deep', async () => {
    await opensInFirstPaint(doc(`<body data-sn-state="{ prefs: { open: false } }">
      <template data-sn-if="prefs.open"><nav id="menu">menu</nav></template>
      <div data-sn-state="{ a: prefs }"><div data-sn-state="{ b: a }"><input type="checkbox" data-sn-model="b.open" data-sn-persist="k"></div></div>
    </body>`), 'sn:k', 'true', 'menu');
  });

  test('a component keeps the object it is given in its own state, and persists a field of it', async () => {
    const components = { 'c-tog': '<template data-sn-props="{ value: object }"><label data-sn-state="{ mine: value }"><input type="checkbox" data-sn-model="mine.open" data-sn-persist="k">x</label></template>' };
    await opensInFirstPaint(doc(`<body data-sn-state="{ prefs: { open: false } }">
      <c-tog data-sn-with="{ value: prefs }"></c-tog>
      <template data-sn-if="prefs.open"><nav id="menu">menu</nav></template>
    </body>`), 'sn:k', 'true', 'menu', { components });
  });

  test('an element of a state list, copied and persisted', async () => {
    await opensInFirstPaint(doc(`<body data-sn-state="{ list: [{ on: false }] }">
      <div data-sn-state="{ first: list[0] }"><input type="checkbox" data-sn-model="first.on" data-sn-persist="k"></div>
      <template data-sn-if="list[0].on"><nav id="menu">menu</nav></template>
    </body>`), 'sn:k', 'true', 'menu');
  });

  test('a form that edits a copy of the page\'s filter, its text persisted: the "clear" button over the filter', async () => {
    await opensInFirstPaint(doc(`<body data-sn-state="{ filter: { q: '' } }">
      <form data-sn-state="{ f: filter }"><input data-sn-model="f.q" data-sn-persist="q"></form>
      <template data-sn-if="filter.q"><button id="clear">clear</button></template>
    </body>`), 'sn:q', '"abc"', 'clear');
  });
});

// The build evaluates a helper's own result; the browser (early script and page module alike) reads it back from JSON,
// where `Infinity` and `NaN` are `null`. The rule reads the value as the browser does.
describe('a value the build computed counts as what its JSON gives back', () => {
  async function paintedFromEmbedded(html: string, helpers: Record<string, unknown>, id: string) {
    // what the page module renders from the same page without the early script: the branch is open
    const plain = await render(html, { helpers });
    await plain.settle();
    expect(has(id), 'open for the page module').toBe(true);
    await firstPaint(html, { helpers });
    expect(has(id), 'the branch is in the first paint').toBe(true);
    const t = await takeover(html, { helpers });
    expect(t.wrote, 'the takeover writes nothing').toEqual([]);
  }

  test('Infinity (an unlimited plan): `!limit` is false over the number, true over the embedded null', async () => {
    const cap = (plan: string) => (plan === 'free' ? Infinity : 10);
    await paintedFromEmbedded(doc(`<body data-sn-state="{ limit: cap('free'), keep: false }">
      <input type="checkbox" data-sn-model="keep" data-sn-persist="keep"><button data-sn-on-click="limit = 5">buy</button>
      <template data-sn-if="!limit"><p id="none">no limit</p></template><b data-sn-text="keep ? limit : ''"></b>
    </body>`), { cap }, 'none');
  });

  test('NaN (the mean of no values): `mean == null` over the embedded value', async () => {
    const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
    await paintedFromEmbedded(doc(`<body data-sn-state="{ mean: avg([]), keep: false }">
      <input type="checkbox" data-sn-model="keep" data-sn-persist="keep"><button data-sn-on-click="mean = 5">add</button>
      <template data-sn-if="mean == null"><p id="none">no data</p></template><b data-sn-text="keep ? mean : ''"></b>
    </body>`), { avg }, 'none');
  });
});

test('a sibling field that throws in the head script (it reads the body): the branch the page module mounts closed is not painted', async () => {
  // `wide()` throws before the body is parsed, and the head script then knows no field of the state: over `undefined`
  // it would paint the list (so on main), and the page module would take it out
  const helpers = { wide: () => document.body.childElementCount > 100 };
  const html = doc(`<body data-sn-state="{ view: 'grid', wide: wide() }">
    <button id="t" data-sn-on-click="view = 'list'">list</button>
    <template data-sn-if="view !== 'grid'"><nav id="list">list</nav></template>
    <p id="w" data-sn-class="{ wide: wide }">x</p>
  </body>`);
  const plain = await render(html, { helpers });
  await plain.settle();
  expect(has('list')).toBe(false);
  await firstPaint(html, { helpers });
  expect(has('list'), 'the first paint has no list').toBe(false);
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
