// Text without an element (docs/proposals/component-libraries.md, section 3): `data-sn-text` on a
// `<template>` renders a text node. One node slot, found from the node before it; an anchor pair
// outside rows.
import { describe, expect, test } from 'vitest';
import { compile } from '../../src/compiler/index.js';
import { firstPaint, render } from '../../src/testing/index.js';

const out = (html: string) => compile(html, { file: '/p/index.html', root: '/p', dev: false, helpers: { module: null, names: [], namespaces: {} }, readFile: () => { throw new Error('missing'); } });

describe('the markup', () => {
  test('outside rows: an anchor pair around the slot; in a row: after the element before it, or after an empty comment', () => {
    const o = out(`<div data-sn-state="{ n: 'x', xs: ['a'] }"><p>Hi <template data-sn-text="n"></template>!</p>
      <ul><template data-sn-for="x in xs"><li><b>b</b><template data-sn-text="x"></template> <template data-sn-text="x"></template></li></template></ul></div>`);
    expect(o.diagnostics).toEqual([]);
    expect(o.html).toContain('<p>Hi <!--sn 1--><!----><!--/sn-->!</p>');
    expect(o.html).toMatch(/<template id="sn-t-0"><li><b>b<\/b><!----> <!----><!----><\/li><\/template>/);
  });

  test('a literal folds into the HTML as text', () => {
    expect(out(`<p>a<template data-sn-text="'b'"></template>c</p>`).html).toContain('<p>abc</p>');
  });

  test('errors: with data-sn-if or data-sn-for on the same template, other attributes, content, $el', () => {
    const codes = (h: string) => out(`<div data-sn-state="{ v: 1 }">${h}</div>`).diagnostics.map((d) => `${d.code} ${d.message}`);
    expect(codes('<template data-sn-text="v" data-sn-if="v"></template>')).toContainEqual(expect.stringMatching(/^SN333 `data-sn-text` and `data-sn-if` on one `<template>`/));
    expect(codes('<template data-sn-text="v" data-sn-for="x in [1]"></template>')).toContainEqual(expect.stringMatching(/^SN333 `data-sn-text` and `data-sn-for`/));
    expect(codes('<template data-sn-text="v" data-sn-class="{ a: v }"></template>')).toEqual([expect.stringMatching(/^SN333 `data-sn-class` on a `<template data-sn-text>`: a text node has no element/)]);
    expect(codes('<template data-sn-text="v">x</template>')).toEqual([expect.stringMatching(/^SN333 a `<template data-sn-text>` renders its text and nothing else/)]);
    expect(codes('<template data-sn-text="$el.id"></template>')).toEqual([expect.stringMatching(/^SN213 `\$el` in a text without an element/)]);
  });
});

const HIGHLIGHT = `<div data-sn-state="{ q: 'an', title: 'banana band' }">
  <input id="q" data-sn-model="q">
  <h2><template data-sn-for="p in title.split(new RegExp('(' + q + ')')).filter((x) => x).map((t) => ({ text: t, match: t === q }))">
    <template data-sn-if="p.match"><mark data-sn-text="p.text"></mark></template>
    <template data-sn-else><template data-sn-text="p.text"></template></template>
  </template></h2>
  <p id="side">[<template data-sn-text="q"></template><template data-sn-text="q.toUpperCase()"></template>]</p>
</div>`;

describe('in the browser', () => {
  test('search highlighting: runs of text beside elements, side by side, empty, and changing', async () => {
    const { root, flush } = await render(HIGHLIGHT);
    await flush();
    const h2 = () => root.querySelector('h2')!;
    expect(h2().textContent!.replace(/\s+/g, '')).toBe('bananaband');
    expect([...h2().querySelectorAll('mark')].map((m) => m.textContent)).toEqual(['an', 'an', 'an']);
    expect(root.querySelector('#side')!.textContent).toBe('[anAN]');
    const q = root.querySelector('#q') as HTMLInputElement;
    q.value = 'band'; q.dispatchEvent(new Event('input'));
    await flush();
    expect([...h2().querySelectorAll('mark')].map((m) => m.textContent)).toEqual(['band']);
    expect(root.querySelector('#side')!.textContent).toBe('[bandBAND]');
    // empty: the slot keeps its place, and text comes back into it
    q.value = ''; q.dispatchEvent(new Event('input'));
    await flush();
    expect(root.querySelector('#side')!.textContent).toBe('[]');
    q.value = 'b'; q.dispatchEvent(new Event('input'));
    await flush();
    expect(root.querySelector('#side')!.textContent).toBe('[bB]');
  });

  test('a write finds its text again from the node before it, when the text node was replaced', async () => {
    const { root, flush, state } = await render('<div data-sn-state="{ n: \'a\' }"><p><template data-sn-text="n"></template></p><button data-sn-on-click="n = n + \'!\'"></button></div>');
    await flush();
    const p = root.querySelector('p')!;
    // a translation extension replaces the text node
    const t = [...p.childNodes].find((c) => c.nodeType === 3)!;
    t.replaceWith(document.createTextNode('translated'));
    (root.querySelector('button') as HTMLButtonElement).click();
    await flush();
    expect(p.textContent).toBe('a!');
    void state;
  });

  test('first paint and takeover: text side by side, empty, and in rows; the takeover changes nothing', async () => {
    const page = `<div data-sn-state="{ a: 'x', e: '', xs: ['p', 'q'] }"><p id="pair"><template data-sn-text="a"></template><template data-sn-text="a + a"></template><template data-sn-text="e"></template>.</p>
      <ul><template data-sn-for="x in xs"><li><template data-sn-text="x"></template>-<template data-sn-text="x + '!'"></template></li></template></ul></div>`;
    const text = (r: ParentNode) => [r.querySelector('#pair')!.textContent, ...[...r.querySelectorAll('li')].map((li) => li.textContent)];
    const early = await firstPaint(page);
    expect(text(early.root)).toEqual(['xxx.', 'p-p!', 'q-q!']);
    const { root } = await render(page);
    expect(text(root)).toEqual(text(early.root));
  });
});
