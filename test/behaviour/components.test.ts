// Components (docs/proposals/components.md): expanded at build time, props live and
// read-only, slots in the caller's scope, events out through emit(), the tag replaced by
// the component's single root.
import { describe, expect, test } from 'vitest';
import { firstPaint, mockRequests, render } from '../../src/testing/index.js';
import { compile } from '../../src/compiler/index.js';

const PREVIEW = `<template data-sn-component="{ article: { slug: string; title: string; description: string }; compact?: boolean }" data-sn-emits="{ select: string }">
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
          <article-preview class="item" data-sn-prop="{ article: a, compact: narrow }" data-sn-on-select="sel = $event.detail">
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
    const OTHER = `<template data-sn-component="{ label: string; items: string[] }">
  <ul><template data-sn-for="a in items" data-sn-key="a"><li data-sn-text="label + a"></li></template></ul>
</template>`;
    const r2 = await render(`<div data-sn-state="{ rows: [{ n: 'r', items: ['1', '2'] }] }">
      <template data-sn-for="a in rows"><other-list data-sn-prop="{ label: a.n, items: a.items }"></other-list></template></div>`, { components: { 'other-list': OTHER } });
    await r2.settle();
    expect([...r2.root.querySelectorAll('li')].map((l) => l.textContent)).toEqual(['r1', 'r2']);
  });

  test('the component\'s own state, an optional prop\'s default from it, and nesting', async () => {
    const COUNTER = `<template data-sn-component="{ label: string; step?: number }">
  <span data-sn-state="{ n: 0, step: 1 }"><button data-sn-on-click="n = n + step" data-sn-text="label + ': ' + n"></button></span>
</template>`;
    const PANEL = `<template data-sn-component="{ title: string }">
  <section><h3 data-sn-text="title"></h3><x-counter data-sn-prop="{ label: title, step: 5 }"></x-counter><x-counter data-sn-prop="{ label: 'plain' }"></x-counter><slot></slot></section>
</template>`;
    const { root, flush } = await render(`<div data-sn-state="{ t: 'T' }"><x-panel data-sn-prop="{ title: t }"><b data-sn-text="t + '!'"></b></x-panel></div>`,
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
    const RATING = `<template data-sn-component="{ value: number }" data-sn-emits="{ change: number }">
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
    const { root } = await firstPaint(`<div data-sn-state="{ now: '--:--' }"><live-clock data-sn-prop="{ time: now }"></live-clock></div>`,
      { components: { 'live-clock': '<template data-sn-component="{ time: string }"><time data-sn-text="time"></time></template>' } });
    expect(root.querySelector('time')!.textContent).toBe('--:--');
  });
});

describe('component diagnostics', () => {
  const C = { 'x-card': '<template data-sn-component="{ title: string; n?: number }" data-sn-emits="{ pick: number }"><div><h1 data-sn-text="title"></h1><slot name="foot"></slot></div></template>' };
  const codes = (html: string, c: Record<string, string> = C) => compileErrors(html, c).map((d) => `${d.code} ${d.message}`);

  test('props: unknown and missing', () => {
    expect(codes('<x-card data-sn-prop="{ titel: \'a\' }"></x-card>')).toEqual([
      expect.stringMatching(/^SN313 `titel` is not a prop of `<x-card>`; its props are `title`, `n`. Did you mean `title`\?/),
      expect.stringMatching(/^SN313 `<x-card>` needs the prop `title`/),
    ]);
  });

  test('the component sees only its props: a caller name is an error naming the prop to add', () => {
    const d = compileErrors('<div data-sn-state="{ q: 1 }"><x-q></x-q></div>', { 'x-q': '<template data-sn-component=""><p data-sn-text="q"></p></template>' });
    expect(d.map((x) => x.code)).toEqual(['SN201']);
    expect(d[0]!.file).toBe('/p/src/components/x-q.html');
    expect(d[0]!.message).toMatch(/`q` is not defined in component `<x-q>`.*\(included from index.html:1\)/);
    expect(d[0]!.hint).toMatch(/data-sn-prop="\{ q: q \}"/);
  });

  test('slots, events, the root, tag attributes', () => {
    expect(codes('<x-card data-sn-prop="{ title: \'a\' }"><b slot="fot"></b><i></i></x-card>')).toEqual([
      expect.stringMatching(/^SN314 `<x-card>` has no slot `fot`. Its slots are `foot`. Did you mean `foot`\?/),
      expect.stringMatching(/^SN314 `<x-card>` has no default `<slot>`/),
    ]);
    expect(codes('<x-card data-sn-prop="{ title: \'a\' }" data-sn-on-pik="1" data-sn-on-click="1"></x-card>')).toEqual([expect.stringMatching(/^SN315 `<x-card>` does not emit `pik`; it declares `pick`/)]);
    expect(codes('<x-e></x-e>', { 'x-e': '<template data-sn-component="" data-sn-emits="{ a: number }"><button data-sn-on-click="emit(\'b\', 1)"></button></template>' }))
      .toEqual([expect.stringMatching(/^SN315 `<x-e>` does not declare the event `b`/)]);
    expect(codes('<x-two></x-two>', { 'x-two': '<template data-sn-component=""><p></p><p></p></template>' })).toEqual([expect.stringMatching(/^SN312 a component has one root element; `<x-two>` has 2 elements/)]);
    expect(codes('<x-card data-sn-prop="{ title: \'a\' }" data-sn-text="1"></x-card>')).toEqual([expect.stringMatching(/^SN102 `data-sn-text` cannot be on a component's tag/)]);
    expect(codes('<x-id></x-id><x-id></x-id>', { 'x-id': '<template data-sn-component=""><dialog id="edit"></dialog></template>' }))
      .toEqual([expect.stringMatching(/^SN209 `<x-id>` is used 2 times on this page, and its markup has `id="edit"`/)]);
  });

  test('a cycle with no template between', () => {
    expect(codes('<x-a></x-a>', { 'x-a': '<template data-sn-component=""><div><x-b></x-b></div></template>', 'x-b': '<template data-sn-component=""><p><x-a></x-a></p></template>' }))
      .toEqual([expect.stringMatching(/^SN306 `<x-a>` → `<x-b>` → `<x-a>` uses itself with no/)]);
  });

  test('a component tag written directly in a table', () => {
    expect(codes('<table><tbody><x-row></x-row></tbody></table>', { 'x-row': '<template data-sn-component=""><tr><td>1</td></tr></template>' }))
      .toEqual([expect.stringMatching(/^SN102 `<x-row>` is written in a table/)]);
    expect(codes('<table><tbody><template data-sn-for="r in [1]" data-sn-key="r"><x-row></x-row></template></tbody></table>', { 'x-row': '<template data-sn-component=""><tr><td>1</td></tr></template>' })).toEqual([]);
  });
});

describe('data-sn-early="off"', () => {
  const CLOCK = (early: string) => `<template data-sn-component="{ time: string }"${early}><time data-sn-text="time"></time></template>`;
  // a helper: not a build-time constant, so only the early script renders it before the page module
  const PAGE = `<div data-sn-state="{ now: label() }"><live-clock data-sn-prop="{ time: now }"></live-clock><b data-sn-text="now"></b></div>`;
  const helpers = { label: () => '--:--' };

  test('the component is left out of the early script and renders when the page module runs', async () => {
    const early = await firstPaint(PAGE, { helpers, components: { 'live-clock': CLOCK(' data-sn-early="off"') } });
    expect(early.root.querySelector('time')!.textContent).toBe('');
    // the page's own binding still renders early
    expect(early.root.querySelector('b')!.textContent).toBe('--:--');
    const { root } = await render(PAGE, { helpers, components: { 'live-clock': CLOCK(' data-sn-early="off"') } });
    expect(root.querySelector('time')!.textContent).toBe('--:--');
  });

  test('the early module holds less', () => {
    const early = (c: string) => compile(PAGE, { file: '/p/index.html', root: '/p', dev: false, helpers: { module: '/h.js', names: ['label'], namespaces: {} }, early: { module: null },
      readFile: (p) => { if (p === '/p/src/components/live-clock.html') return c; throw new Error('missing'); } }).early ?? '';
    expect(early(CLOCK(' data-sn-early="off"')).length).toBeLessThan(early(CLOCK('')).length);
    expect(compile(PAGE, { file: '/p/index.html', root: '/p', dev: false, helpers: { module: '/h.js', names: ['label'], namespaces: {} },
      readFile: () => CLOCK(' data-sn-early="later"') }).diagnostics.map((d) => d.code)).toEqual(['SN401']);
  });
});
