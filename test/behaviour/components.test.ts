// Components (docs/proposals/components.md): expanded at build time, props live and
// read-only, slots in the caller's scope, events out through emit(), the tag replaced by
// the component's single root.
import { describe, expect, test } from 'vitest';
import { firstPaint, mockRequests, render } from '../../src/testing/index.js';
import { compile } from '../../src/compiler/index.js';

const PREVIEW = `<template data-sn-props="{ article: { slug: string; title: string; description: string }; compact?: boolean }" data-sn-emits="{ select: string }">
  <article class="preview" data-sn-class="{ compact }">
    <a data-sn-attr="{ href: '/article/' + article.slug }" data-sn-on-click="$event.preventDefault(); emit('select', article.slug)"><h2 data-sn-text="article.title"></h2></a>
    <slot name="meta"></slot>
    <p data-sn-text="article.description"></p>
    <slot><em>no extra</em></slot>
  </article>
</template>`;

const ARTICLES = [
  { slug: 'a', title: 'A', description: 'about a', createdAt: '2026-01-01' },
  { slug: 'b', title: 'B', description: 'about b', createdAt: '2026-01-02' },
];

function compileErrors(html: string, components: Record<string, string>) {
  const files: Record<string, string> = {};
  for (const [k, v] of Object.entries(components)) files[`/p/src/components/${k}.html`] = v;
  const out = compile(html, { file: '/p/index.html', root: '/p', dev: false, helpers: { module: null, names: [], namespaces: {} }, readFile: (p) => { if (p in files) return files[p]!; throw new Error('missing'); } });
  return out.diagnostics;
}

describe('markup-only components', () => {
  test('props, slots in the caller\'s scope, fallback content, the root replaces the tag', async () => {
    const requests = mockRequests({ 'GET /api/articles': ARTICLES });
    const { root, settle, flush } = await render(`
      <sn-resource name="articles" src="/api/articles" key="slug"></sn-resource>
      <div data-sn-state="{ narrow: false, sel: '' }">
        <button id="narrow" data-sn-on-click="narrow = !narrow">narrow</button>
        <p id="sel" data-sn-text="sel"></p>
        <template data-sn-for="a in articles">
          <article-preview class="item" data-sn-with="{ article: a, compact: narrow }" data-sn-on-select="sel = $event.detail">
            <span slot="meta" data-sn-text="a.createdAt"></span>
          </article-preview>
        </template>
      </div>`, { requests, components: { 'article-preview': PREVIEW } });
    await settle();
    const items = root.querySelectorAll('article');
    expect(items).toHaveLength(2);
    expect(root.querySelector('article-preview')).toBeNull();
    expect(items[0]!.className).toBe('preview item');
    expect(items[0]!.getAttribute('data-sn-c')).toBe('article-preview');
    expect(items[0]!.querySelector('h2')!.textContent).toBe('A');
    expect(items[0]!.querySelector('a')!.getAttribute('href')).toBe('/article/a');
    expect(items[0]!.querySelector('span')!.textContent).toBe('2026-01-01');
    expect(items[1]!.querySelector('em')!.textContent).toBe('no extra');
    // a live prop
    (root.querySelector('#narrow') as HTMLButtonElement).click();
    await flush();
    expect(items[0]!.classList.contains('compact')).toBe(true);
    // an event out
    (items[1]!.querySelector('a') as HTMLAnchorElement).click();
    await flush();
    expect(root.querySelector('#sel')!.textContent).toBe('b');
  });

  test('a prop read inside the component\'s own loop is the caller\'s, also when the loops share a name', async () => {
    const OTHER = `<template data-sn-props="{ label: string; items: string[] }">
  <ul><template data-sn-for="a in items" data-sn-key="a"><li data-sn-text="label + a"></li></template></ul>
</template>`;
    const r2 = await render(`<div data-sn-state="{ rows: [{ n: 'r', items: ['1', '2'] }] }">
      <template data-sn-for="a in rows"><other-list data-sn-with="{ label: a.n, items: a.items }"></other-list></template></div>`, { components: { 'other-list': OTHER } });
    await r2.settle();
    expect([...r2.root.querySelectorAll('li')].map((l) => l.textContent)).toEqual(['r1', 'r2']);
  });

  test('the component\'s own state, an optional prop\'s default from it, and nesting', async () => {
    const COUNTER = `<template data-sn-props="{ label: string; step?: number }">
  <span data-sn-state="{ n: 0, step: 1 }"><button data-sn-on-click="n = n + step" data-sn-text="label + ': ' + n"></button></span>
</template>`;
    const PANEL = `<template data-sn-props="{ title: string }">
  <section><h3 data-sn-text="title"></h3><x-counter data-sn-with="{ label: title, step: 5 }"></x-counter><x-counter data-sn-with="{ label: 'plain' }"></x-counter><slot></slot></section>
</template>`;
    const { root, flush } = await render(`<div data-sn-state="{ t: 'T' }"><x-panel data-sn-with="{ title: t }"><b data-sn-text="t + '!'"></b></x-panel></div>`,
      { components: { 'x-counter': COUNTER, 'x-panel': PANEL } });
    const [five, one] = root.querySelectorAll('button');
    expect(root.querySelector('h3')!.textContent).toBe('T');
    expect(root.querySelector('b')!.textContent).toBe('T!');
    five!.click(); one!.click(); one!.click();
    await flush();
    expect(five!.textContent).toBe('T: 5');
    expect(one!.textContent).toBe('plain: 2');
  });

  test('data-sn-model on a component: the value prop and its change event', async () => {
    const RATING = `<template data-sn-props="{ value: number }" data-sn-emits="{ change: number }">
  <div><template data-sn-for="i in [1, 2, 3]" data-sn-key="i"><button data-sn-class="{ on: i <= value }" data-sn-on-click="emit('change', i)" data-sn-text="i"></button></template><input type="checkbox"></div>
</template>`;
    const { root, flush } = await render(`<div data-sn-state="{ draft: { stars: 1 } }"><rating-input data-sn-model="draft.stars"></rating-input><p data-sn-text="draft.stars"></p></div>`,
      { components: { 'rating-input': RATING } });
    expect(root.querySelectorAll('button.on')).toHaveLength(1);
    root.querySelectorAll('button')[2]!.click();
    await flush();
    expect(root.querySelector('p')!.textContent).toBe('3');
    expect(root.querySelectorAll('button.on')).toHaveLength(3);
    // a native change bubbling from inside is not the component's
    const box = root.querySelector('input')!;
    box.checked = true; box.dispatchEvent(new Event('change', { bubbles: true }));
    await flush();
    expect(root.querySelector('p')!.textContent).toBe('3');
  });

  test('first paint: a component over embedded data and state renders before the page module', async () => {
    const { root } = await firstPaint(`<div data-sn-state="{ now: '--:--' }"><live-clock data-sn-with="{ time: now }"></live-clock></div>`,
      { components: { 'live-clock': '<template data-sn-props="{ time: string }"><time data-sn-text="time"></time></template>' } });
    expect(root.querySelector('time')!.textContent).toBe('--:--');
  });
});

describe('an action on a component\'s tag, triggered by its event', () => {
  // a sortable's `move`: the action on the tag sends it, its body and optimistic change read `$event.detail`
  const SORT = `<template data-sn-props="{ items: { id: number; title: string; rank: number }[] }" data-sn-emits="{ move: { id: number; rank: number } }">
  <ul><template data-sn-for="t in items" data-sn-key="t.id"><li><span data-sn-text="t.title"></span><button data-sn-on-click="emit('move', { id: t.id, rank: -t.rank })">top</button></li></template></ul>
</template>`;
  const TASKS = [{ id: 1, title: 'a', rank: 1 }, { id: 2, title: 'b', rank: 2 }];

  async function move(status: number) {
    const requests = mockRequests({ 'GET /api/tasks': TASKS, 'PUT /api/tasks/order': status === 200 ? {} : { status } });
    const r = await render(`
      <sn-resource name="tasks" src="/api/tasks" key="id" order="rank"></sn-resource>
      <div data-sn-state="{ failed: false }">
        <x-sort data-sn-with="{ items: tasks }" data-sn-put="/api/tasks/order" data-sn-trigger="move"
                data-sn-body="{ id: $event.detail.id, rank: $event.detail.rank }"
                data-sn-optimistic="merge(tasks.find((t) => t.id === $event.detail.id), { rank: $event.detail.rank })"
                data-sn-write-through="off" data-sn-catch="failed = true"></x-sort>
        <p data-sn-show="failed">failed</p>
      </div>`, { requests, components: { 'x-sort': SORT } });
    await r.settle();
    const order = () => [...r.root.querySelectorAll('li span')].map((s) => s.textContent).join('');
    expect(order()).toBe('ab');
    r.root.querySelectorAll('button')[1]!.click();
    await r.flush();
    return { ...r, requests, order };
  }

  test('the change shows before the answer, and is kept on success', async () => {
    const p = await move(200);
    expect(p.order()).toBe('ba');
    expect(p.requests.calls.at(-1)).toMatchObject({ method: 'PUT', path: '/api/tasks/order', body: { id: 2, rank: -2 } });
    await p.settle();
    expect(p.order()).toBe('ba');
    expect((p.root.querySelector('p') as HTMLElement).hidden).toBe(true);
  });

  test('a failure rolls the change back', async () => {
    const p = await move(500);
    expect(p.order()).toBe('ba');
    await p.settle().catch(() => {});
    expect(p.order()).toBe('ab');
    expect((p.root.querySelector('p') as HTMLElement).hidden).toBe(false);
  });

  test('data-sn-when on the tag guards the action, reading the event', async () => {
    const requests = mockRequests({ 'GET /api/tasks': TASKS, 'PUT /api/tasks/order': {} });
    const r = await render(`
      <sn-resource name="tasks" src="/api/tasks" key="id" order="rank"></sn-resource>
      <x-sort data-sn-with="{ items: tasks }" data-sn-put="/api/tasks/order" data-sn-trigger="move"
              data-sn-when="$event.detail.id !== 1" data-sn-body="{ id: $event.detail.id }"
              data-sn-optimistic="merge(tasks.find((t) => t.id === $event.detail.id), { rank: $event.detail.rank })"></x-sort>`, { requests, components: { 'x-sort': SORT } });
    await r.settle();
    const puts = () => requests.calls.filter((c) => c.method === 'PUT').length;
    r.root.querySelectorAll('button')[0]!.click();
    await r.settle();
    expect(puts()).toBe(0);
    r.root.querySelectorAll('button')[1]!.click();
    await r.settle();
    expect(puts()).toBe(1);
  });

});

describe('component diagnostics', () => {
  const C = { 'x-card': '<template data-sn-props="{ title: string; n?: number }" data-sn-emits="{ pick: number }"><div><h1 data-sn-text="title"></h1><slot name="foot"></slot></div></template>' };
  const codes = (html: string, c: Record<string, string> = C) => compileErrors(html, c).map((d) => `${d.code} ${d.message}`);

  test('props: unknown and missing', () => {
    expect(codes('<x-card data-sn-with="{ titel: \'a\' }"></x-card>')).toEqual([
      expect.stringMatching(/^SN313 `titel` is not a prop of `<x-card>`; its props are `title`, `n`. Did you mean `title`\?/),
      expect.stringMatching(/^SN313 `<x-card>` needs the prop `title`/),
    ]);
  });

  test('the component sees only its props: a caller name is an error naming the prop to add', () => {
    const d = compileErrors('<div data-sn-state="{ q: 1 }"><x-q></x-q></div>', { 'x-q': '<template data-sn-props=""><p data-sn-text="q"></p></template>' });
    expect(d.map((x) => x.code)).toEqual(['SN201']);
    expect(d[0]!.file).toBe('/p/src/components/x-q.html');
    expect(d[0]!.message).toMatch(/`q` is not defined in component `<x-q>`.*\(included from index.html:1\)/);
    expect(d[0]!.hint).toMatch(/data-sn-with="\{ q: q \}"/);
  });

  test('slots, events, the root, tag attributes', () => {
    expect(codes('<x-card data-sn-with="{ title: \'a\' }"><b slot="fot"></b><i></i></x-card>')).toEqual([
      expect.stringMatching(/^SN314 `<x-card>` has no slot `fot`. Its slots are `foot`. Did you mean `foot`\?/),
      expect.stringMatching(/^SN314 `<x-card>` has no default `<slot>`/),
    ]);
    expect(codes('<x-card data-sn-with="{ title: \'a\' }" data-sn-on-pik="1" data-sn-on-click="1"></x-card>')).toEqual([expect.stringMatching(/^SN315 `<x-card>` does not emit `pik`; it declares `pick`/)]);
    expect(codes('<x-e></x-e>', { 'x-e': '<template data-sn-props="" data-sn-emits="{ a: number }"><button data-sn-on-click="emit(\'b\', 1)"></button></template>' }))
      .toEqual([expect.stringMatching(/^SN315 `<x-e>` does not declare the event `b`/)]);
    expect(codes('<x-two></x-two>', { 'x-two': '<template data-sn-props=""><p></p><p></p></template>' })).toEqual([expect.stringMatching(/^SN312 a component's root renders at most one element; `<x-two>` has 2 elements/)]);
    expect(codes('<x-card data-sn-with="{ title: \'a\' }" data-sn-text="1"></x-card>')).toEqual([expect.stringMatching(/^SN102 `data-sn-text` cannot be on a component's tag/)]);
    // an action's guard goes on the tag with the action, in the caller's scope (sinter-alloy S2)
    expect(codes('<x-card data-sn-with="{ title: \'a\' }" data-sn-post="/x" data-sn-trigger="pick" data-sn-when="$event.detail > 0"></x-card>')).toEqual([]);
    expect(codes('<x-id></x-id><x-id></x-id>', { 'x-id': '<template data-sn-props=""><dialog id="edit"></dialog></template>' }))
      .toEqual([expect.stringMatching(/^SN209 `<x-id>` is used 2 times on this page, and its markup has `id="edit"`/)]);
  });

  test('a cycle with no template between', () => {
    expect(codes('<x-a></x-a>', { 'x-a': '<template data-sn-props=""><div><x-b></x-b></div></template>', 'x-b': '<template data-sn-props=""><p><x-a></x-a></p></template>' }))
      .toEqual([expect.stringMatching(/^SN306 `<x-a>` → `<x-b>` → `<x-a>` uses itself with no/)]);
  });

  test('a component tag written directly in a table', () => {
    expect(codes('<table><tbody><x-row></x-row></tbody></table>', { 'x-row': '<template data-sn-props=""><tr><td>1</td></tr></template>' }))
      .toEqual([expect.stringMatching(/^SN102 `<x-row>` is written in a table/)]);
    expect(codes('<table><tbody><template data-sn-for="r in [1]" data-sn-key="r"><x-row></x-row></template></tbody></table>', { 'x-row': '<template data-sn-props=""><tr><td>1</td></tr></template>' })).toEqual([]);
  });
});

describe('data-sn-early="off"', () => {
  const CLOCK = '<template data-sn-props="{ time: string }"><time data-sn-text="time"></time></template>';
  // a helper: not a build-time constant, so only the early script renders it before the page module
  const PAGE = (early: string) => `<div data-sn-state="{ now: label() }"><live-clock data-sn-with="{ time: now }"${early}></live-clock><b data-sn-text="now"></b></div>`;
  // a label only the browser knows (a helper over what it closes over does not run at build time)
  const clockText = '--:--';
  const helpers = { label: () => clockText };

  test('a use with it is left out of the early script and renders when the page module runs; another use is not', async () => {
    const both = `${PAGE(' data-sn-early="off"')}${PAGE('')}`;
    const early = await firstPaint(both, { helpers, components: { 'live-clock': CLOCK } });
    expect([...early.root.querySelectorAll('time')].map((t) => t.textContent)).toEqual(['', '--:--']);
    // the page's own binding still renders early
    expect(early.root.querySelector('b')!.textContent).toBe('--:--');
    const { root } = await render(both, { helpers, components: { 'live-clock': CLOCK } });
    expect([...root.querySelectorAll('time')].map((t) => t.textContent)).toEqual(['--:--', '--:--']);
  });

  test('the early module holds less; the attribute belongs on the tag', () => {
    const out = (page: string, c = CLOCK) => compile(page, { file: '/p/index.html', root: '/p', dev: false, helpers: { module: '/h.js', names: ['label'], namespaces: {} }, early: { module: null },
      readFile: (p) => { if (p === '/p/src/components/live-clock.html') return c; throw new Error('missing'); } });
    expect((out(PAGE(' data-sn-early="off"')).early ?? '').length).toBeLessThan((out(PAGE('')).early ?? '').length);
    expect(out(PAGE(' data-sn-early="later"')).diagnostics.map((d) => d.code)).toEqual(['SN401']);
    expect(out(PAGE(''), CLOCK.replace('<template ', '<template data-sn-early="off" ')).diagnostics.map((d) => d.code)).toEqual(['SN102']);
  });
});

test('a data-sn-if on a constant prop is decided at build time: dropped when the use leaves it out, its content in place when it is true', async () => {
  const BADGE = '<template data-sn-props="{ label?: string }"><span><template data-sn-if="label"><b data-sn-text="label"></b></template>x</span></template>';
  const { root } = await render('<x-badge></x-badge><x-badge data-sn-with="{ label: \'new\' }"></x-badge>', { components: { 'x-badge': BADGE } });
  const [a, b] = root.querySelectorAll('span');
  expect(a!.querySelector('b')).toBeNull();
  // decided at build time: no template, no binding
  expect(a!.querySelector('template')).toBeNull();
  expect(b!.querySelector('template')).toBeNull();
  expect(b!.querySelector('b')!.textContent).toBe('new');
});

describe('slot content the build decides or unrolls stays its writer\'s', () => {
  // the box: a component whose slot the outer component fills, with styles of its own
  const box = '<template data-sn-props=""><div><slot></slot></div></template><style>p { color: red }</style>';

  test('a `data-sn-if` the first paint decides: its branch emits the writer\'s events and is outside the box\'s styles', async () => {
    const outer = `<template data-sn-props="{ on: boolean }" data-sn-emits="{ ping: void }">
  <section><x-box><template data-sn-if="!on"><p class="mine" data-sn-on-click="emit('ping')">p</p></template></x-box></section></template>`;
    const r = await render('<main data-sn-state="{ n: 0 }"><x-outer data-sn-with="{ on: false }" data-sn-on-ping="n++"></x-outer><b data-sn-text="n"></b></main>',
      { components: { 'x-box': box, 'x-outer': outer }, firstPaint: true });
    await r.flush();
    const p = r.root.querySelector<HTMLElement>('.mine')!;
    expect(p.parentElement!.tagName).toBe('DIV');
    expect(p.getAttribute('data-sn-s')).toBe('x-outer');
    p.click(); await r.flush();
    expect(r.root.querySelector('b')!.textContent).toBe('1');
  });

  test('a loop over a constant list the first paint unrolls: its rows see the writer\'s state and their item', async () => {
    const outer = `<template data-sn-props=""><section data-sn-state="{ label: 'a' }"><x-box>
  <template data-sn-for="x in [1, 2]" data-sn-key="x"><p class="row" data-sn-text="label + x"></p></template></x-box></section></template>`;
    const r = await render('<main><x-outer></x-outer></main>', { components: { 'x-box': box, 'x-outer': outer }, firstPaint: true });
    await r.flush();
    const rows = [...r.root.querySelectorAll('.row')];
    expect(rows.map((p) => p.textContent)).toEqual(['a1', 'a2']);
    expect(rows.map((p) => p.getAttribute('data-sn-s'))).toEqual(['x-outer', 'x-outer']);
    expect(r.root.querySelector('template')).toBeNull();
  });
});
