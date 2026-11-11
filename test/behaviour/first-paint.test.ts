// First paint in the browser: the early chunk renders what needs no data (after the app's early
// module has picked the language), and the page module takes the DOM over without changing it.
import { expect, test } from 'vitest';
import { firstPaint, memoryStorage, mockRequests, render } from '@tiaforge-ui/sinter/testing';

let lang = 'en';
const text: Record<string, Record<string, string>> = {
  en: { nav: 'Main navigation', mail: 'Mail', week: 'Week', month: 'Month' },
  de: { nav: 'Hauptnavigation', mail: 'E-Mail', week: 'Woche', month: 'Monat' },
};
const m = Object.fromEntries(Object.keys(text.en!).map((k) => [k, () => text[lang]![k]!]));
// stands for the app's src/sinter.early.ts: picks the language before anything renders
const early = (storage: Storage) => () => { lang = storage.getItem('locale') ?? 'en'; };

const page = `<!doctype html><html lang="en" data-sn-state="{ view: 'week' }" data-sn-persist="view"><head></head>
<body data-sn-state="{ here: '/mail/' }">
  <sn-resource name="user" src="/api/user"></sn-resource>
  <nav data-sn-attr="{'aria-label': m.nav()}" data-sn-state="{ collapsed: false }">
    <input type="checkbox" data-sn-model="collapsed" data-sn-persist="nav-collapsed">
    <a href="/mail/" data-sn-attr="{'aria-current': here === '/mail/' ? 'page' : null, 'data-tooltip': m.mail()}"><span data-sn-text="m.mail()"></span></a>
    <span id="name" data-sn-text="user.name"></span>
  </nav>
  <main>
    <template data-sn-if="view === 'week'"><h1 data-sn-text="m.week()"></h1><p data-sn-text="user.name"></p></template>
    <template data-sn-else><h1 data-sn-text="m.month()"></h1></template>
  </main>
</body></html>`;

const shown = () => {
  const nav = document.querySelector('nav')!, a = nav.querySelector('a')!;
  return {
    label: nav.getAttribute('aria-label'), checked: nav.querySelector('input')!.checked, current: a.getAttribute('aria-current'),
    tooltip: a.dataset.tooltip, text: a.textContent, view: [...document.querySelectorAll('main h1')].map((h) => h.textContent).join(),
  };
};

test('first paint: build-time constants, then the early chunk in the visitor\'s language, persisted values read from storage', async () => {
  let storage = memoryStorage();
  await firstPaint(page, { helpers: { m }, storage, early: early(storage) });
  expect(shown()).toEqual({ label: 'Main navigation', checked: false, current: 'page', tooltip: 'Mail', text: 'Mail', view: 'Week' });
  expect(document.getElementById('name')!.textContent).toBe('');

  storage = memoryStorage();
  storage.setItem('locale', 'de');
  storage.setItem('sn:nav-collapsed', 'true');
  storage.setItem('sn:view', JSON.stringify({ view: 'month' }));
  await firstPaint(page, { helpers: { m }, storage, early: early(storage) });
  expect(shown()).toEqual({ label: 'Hauptnavigation', checked: true, current: 'page', tooltip: 'E-Mail', text: 'E-Mail', view: 'Monat' });
  lang = 'en';
});

test('without the early chunk (no script) the HTML has the build-time constants only', async () => {
  const { html } = await firstPaint(page, { helpers: { m } });
  expect(html).toContain('<a href="/mail/" data-sn="4" aria-current="page"><span data-sn="5"></span></a>');
});

test('the page module takes the first paint over without changing it, and adopts the early branch', async () => {
  const storage = memoryStorage();
  storage.setItem('locale', 'de');
  storage.setItem('sn:nav-collapsed', 'true');
  const requests = mockRequests({ 'GET /api/user': { name: 'Ada' } });
  // record what the page module changes after the early chunk
  const changes: string[] = [];
  let branch: Element | null = null;
  const watch = new MutationObserver((records) => {
    for (const r of records) {
      if (r.type === 'attributes' && (r.target as Element).getAttribute(r.attributeName!) !== r.oldValue) changes.push(`${(r.target as Element).localName}[${r.attributeName}]`);
      if (r.type === 'childList' && [...r.removedNodes].some((n) => n.nodeType === 1)) changes.push(`removed from ${(r.target as Element).localName}`);
      if (r.type === 'characterData' && r.target.textContent !== r.oldValue) changes.push(`text ${r.oldValue} → ${r.target.textContent}`);
    }
  });
  const { settle } = await render(page, {
    helpers: { m }, storage, requests,
    firstPaint: {
      early: early(storage),
      afterEarly: () => {
        branch = document.querySelector('main h1');
        watch.observe(document.body, { subtree: true, attributes: true, attributeOldValue: true, childList: true, characterData: true, characterDataOldValue: true });
      },
    },
  });
  expect(shown()).toEqual({ label: 'Hauptnavigation', checked: true, current: 'page', tooltip: 'E-Mail', text: 'E-Mail', view: 'Woche' });
  expect(changes).toEqual([]);
  await settle();
  watch.disconnect();
  // the branch element is the one the early chunk rendered, now bound: its data arrived
  expect(document.querySelector('main h1')).toBe(branch);
  expect(document.querySelector('main p')!.textContent).toBe('Ada');
  expect(document.getElementById('name')!.textContent).toBe('Ada');
  // after the data: only the elements waiting for it changed
  expect(changes.every((c) => /^text|^removed from (span|p)/.test(c))).toBe(true);
  lang = 'en';
});

test('an early branch that is not the one to show is replaced', async () => {
  const storage = memoryStorage();
  // the early chunk sees `week`; the page module's state says `month` (as if it changed in between)
  const { flush } = await render(page.replace("data-sn-state=\"{ view: 'week' }\"", "data-sn-state=\"{ view: 'week' }\" data-sn-on-x=\"view = 'month'\""), { helpers: { m }, storage, firstPaint: true, requests: mockRequests({ 'GET /api/user': {} }) });
  document.documentElement.dispatchEvent(new Event('x'));
  await flush();
  expect([...document.querySelectorAll('main h1')].map((h) => h.textContent)).toEqual(['Month']);
});

/** A document as the browser has it while it loads: readyState and its events, driven by the test. */
function loadingDoc() {
  let state = 'loading';
  const on: Record<string, Array<() => void>> = {};
  const doc = {
    get readyState() { return state; },
    addEventListener: (t: string, f: () => void) => (on[t] ??= []).push(f),
    removeEventListener: () => {},
    querySelectorAll: () => [],
  } as unknown as Document;
  const fire = (t: string) => { for (const f of on[t]?.splice(0) ?? []) f(); };
  return { doc, interactive: () => { state = 'interactive'; fire('readystatechange'); }, contentLoaded: () => fire('DOMContentLoaded') };
}
const tick = () => new Promise((r) => setTimeout(r));

test('the async page module mounts after the parse and after the early file has rendered, whichever runs first', async () => {
  const { start } = await import('../../src/early.js');
  const { rendered } = await import('../../src/runtime/env.js');
  delete (globalThis as any)[Symbol.for('sinter.early.page')];
  const order: string[] = [];
  const page = () => { order.push('early renders'); return { ir: {}, fns: [], scopes: () => [], render: () => {} }; };
  const { doc, interactive, contentLoaded } = loadingDoc();
  // the page module runs first, while the body is parsed
  void rendered(doc).then(() => order.push('page module mounts'));
  await tick();
  interactive();
  await tick();
  expect(order).toEqual([]);
  // then the deferred early file
  start(page, null, null, doc);
  await tick();
  contentLoaded();
  await tick();
  expect(order).toEqual(['early renders', 'page module mounts']);
});

test('an early file that failed to load does not hold the page module: it mounts at DOMContentLoaded', async () => {
  const { rendered } = await import('../../src/runtime/env.js');
  delete (globalThis as any)[Symbol.for('sinter.early.page')];
  const { doc, interactive, contentLoaded } = loadingDoc();
  let mounted = false;
  void rendered(doc).then(() => { mounted = true; });
  interactive();
  await tick();
  expect(mounted).toBe(false);
  contentLoaded();
  await tick();
  expect(mounted).toBe(true);
});

test('first paint: an early binding reads `$locale` from `configure({ locale })` in the app\'s early module; without it, the binding waits', async () => {
  const { configure } = await import('@tiaforge-ui/sinter');
  const html = '<!doctype html><html><head></head><body data-sn-state="{ n: 1 }" data-sn-persist="p"><p id="l" data-sn-text="$locale + n"></p></body></html>';
  try {
    await firstPaint(html, { storage: memoryStorage(), early: () => configure({ locale: { get: () => 'de', set: () => {} } }) });
    expect(document.getElementById('l')!.textContent).toBe('de1');
    configure({ locale: null });
    await firstPaint(html, { storage: memoryStorage() });
    expect(document.getElementById('l')!.textContent).toBe('');
  } finally { configure({ locale: null }); }
});

test('rows over embedded data render early, and the page module adopts them: the same nodes, nothing removed or rewritten', async () => {
  const data = JSON.stringify({ articles: [{ slug: 'a', title: 'First', tags: ['x', 'y'] }, { slug: 'b', title: 'Second', tags: ['z'] }] });
  const page = `<!doctype html><html><head><script type="application/json" data-sn-data="articles">${data}</script></head>
<body data-sn-state="{ n: 0 }">
  <sn-resource name="articles" src="/api/articles" items="articles" key="slug"></sn-resource>
  <ul><template data-sn-for="a in articles"><li><h2 data-sn-text="a.title"></h2><a data-sn-attr="{href: '/article/' + a.slug}">read</a>
    <template data-sn-for="t in a.tags" data-sn-key="t"><i data-sn-text="t"></i></template></li></template></ul>
</body></html>`;
  const changes: string[] = [];
  let early: Element[] = [];
  const watch = new MutationObserver((records) => {
    for (const r of records) {
      if (r.type === 'childList' && [...r.removedNodes, ...r.addedNodes].some((n) => n.nodeType === 1)) changes.push(`rows changed in ${(r.target as Element).localName}`);
      if (r.type === 'characterData') changes.push(`text ${r.oldValue} → ${r.target.textContent}`);
    }
  });
  const { settle } = await render(page, {
    firstPaint: {
      afterEarly: () => {
        early = [...document.querySelectorAll('li, i')];
        watch.observe(document.body, { subtree: true, childList: true, characterData: true, characterDataOldValue: true });
      },
    },
  });
  await settle();
  watch.disconnect();
  // rendered before the page module: two rows with their nested rows
  expect(early.map((e) => e.textContent!.replace(/\s+/g, ' ').trim())).toEqual(['Firstread xy', 'x', 'y', 'Secondread z', 'z']);
  // adopted: the same elements, now bound; nothing was added, removed or written again
  expect([...document.querySelectorAll('li, i')]).toEqual(early);
  expect(changes).toEqual([]);
  expect(document.querySelector('li a')!.getAttribute('href')).toBe('/article/a');
});

test('early rows whose nested if/else and lists rendered early are adopted with every binding: the else branch, elements after a nested template, and all their nodes go with the row', async () => {
  const data = JSON.stringify([{ id: 1, photo: false, n: 'Ann', tags: ['x'] }, { id: 2, photo: true, n: 'Bob', tags: [] }]);
  const page = `<!doctype html><html><head><script type="application/json" data-sn-data="cs">${data}</script></head>
<body>
  <sn-resource name="cs" src="/api/cs" key="id"></sn-resource>
  <button id="drop" data-sn-on-click="remove(cs[0])"></button>
  <ul><template data-sn-for="c in cs" data-sn-key="c.id"><template data-sn-if="c.photo"><b class="top">photo</b></template><li>
    <span class="av"><template data-sn-if="c.photo"><img alt=""></template><template data-sn-else><i data-sn-text="c.n[0]"></i></template></span>
    <template data-sn-for="t in c.tags" data-sn-key="t"><em data-sn-text="t"></em></template>
    <strong data-sn-text="c.n"></strong><u data-sn-text="c.photo ? 'yes' : 'no'"></u></li></template></ul>
</body></html>`;
  const changes: string[] = [];
  let early: Element[] = [];
  const watch = new MutationObserver((records) => {
    for (const r of records) if (r.type === 'childList' && [...r.removedNodes, ...r.addedNodes].some((n) => n.nodeType === 1)) changes.push(`rows changed in ${(r.target as Element).localName}`);
  });
  const { settle } = await render(page, {
    requests: mockRequests({}),
    firstPaint: {
      afterEarly: () => {
        early = [...document.querySelectorAll('li, i, img, em, b')];
        watch.observe(document.body, { subtree: true, childList: true });
      },
    },
  });
  await settle();
  watch.disconnect();
  const rows = () => [...document.querySelectorAll('li')].map((li) => li.textContent!.replace(/\s+/g, ''));
  // the else branch's initial, the nested list's row and the bindings after it, in both rows
  expect(rows()).toEqual(['AxAnnno', 'Bobyes']);
  expect(document.querySelectorAll('img, b.top').length).toBe(2);
  // adopted: the early nodes, nothing added or removed
  expect([...document.querySelectorAll('li, i, img, em, b')]).toEqual(early);
  expect(changes).toEqual([]);
  // removing a row takes the nodes its nested templates rendered with it
  (document.getElementById('drop') as HTMLButtonElement).click();
  await settle();
  expect(rows()).toEqual(['Bobyes']);
  expect(document.querySelectorAll('i, em, b.top').length).toBe(1);
});
