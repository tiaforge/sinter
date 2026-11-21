// @vitest-environment jsdom
// Templates written alike in several shared definitions are kept once (compile.ts, shareTemplates): a tree
// library's loop over a node's children, in each component that has children. The kept loop renders inside
// every definition that had a copy, nested in one another, reading each one's own props (`$pp`), through
// updates, and with the fills the tree passes down.
import { describe, expect, test } from 'vitest';
import { render } from '../../src/testing/index.js';

const INLINES = "{ text: 'x-text', em: 'x-em', strong: 'x-strong', link: 'x-link' }";
// the loop each component with children writes: its own copy, the same markup
const kids = `<template data-sn-for="n in node.children"><sn-component use="${INLINES}[n.type]" data-sn-with="{ node: n }"></sn-component></template>`;
const TREE = {
  'x-doc': `<template data-sn-props="{ doc: any; link: Slot<{ node: any }> }"><p class="doc"><template data-sn-for="b in doc.children"><sn-component use="${INLINES}[b.type]" data-sn-with="{ node: b }"></sn-component></template></p></template>`,
  'x-text': '<template data-sn-props="{ node: any }"><span data-sn-text="node.value"></span></template>',
  'x-em': `<template data-sn-props="{ node: any }"><em data-sn-attr="{ title: node.note }">${kids}</em></template>`,
  'x-strong': `<template data-sn-props="{ node: any }"><strong data-sn-attr="{ title: node.note }">${kids}</strong></template>`,
  'x-link': `<template data-sn-props="{ node: any }"><slot name="link" data-sn-with="{ node }"><a data-sn-attr="{ href: node.url }">${kids}</a></slot></template>`,
};
const t = (value: string) => ({ type: 'text', value });
const DOC = { children: [
  { type: 'em', note: 'e1', children: [t('a'), { type: 'strong', note: 's1', children: [t('b'), { type: 'em', note: 'e2', children: [t('c')] }] }] },
  { type: 'link', url: '/x', children: [{ type: 'strong', note: 's2', children: [t('d')] }] },
] };
const state = (doc: unknown) => JSON.stringify(doc).replace(/"/g, "'");
// a page that writes `doc`, so the tree renders in the browser (a constant one is written into the HTML at build time)
const page = (doc: unknown, fill = '') => `<div data-sn-state="{ doc: ${state(doc)} }"><button id="clear" data-sn-on-click="doc = { children: [] }"></button><x-doc data-sn-with="{ doc }">${fill}</x-doc></div>`;
const shape = (root: ParentNode) => root.querySelector('.doc')!.innerHTML.replace(/<!--[^>]*-->/g, '').replace(/ data-sn-c="[^"]*"/g, '');

describe('templates shared by several definitions', () => {
  test('the copies are kept once, and read their definition\'s props as `$pp`', async () => {
    const { app } = await render(page(DOC), { components: TREE, dev: false });
    const empty = app.ir.templates.filter((x) => !x.nodes.length && x.item === undefined).length;
    // x-em, x-strong and x-link each had the loop; two of them now point at the first
    expect(empty).toBeGreaterThanOrEqual(2);
    expect(app.fns.some((f) => String(f).includes('$pp'))).toBe(true);
  });

  test('nested in one another, each renders its own children and props', async () => {
    const { root } = await render(page(DOC), { components: TREE, dev: false });
    expect(shape(root)).toBe('<em title="e1"><span>a</span><strong title="s1"><span>b</span><em title="e2"><span>c</span></em></strong></em>'
      + '<a href="/x"><strong title="s2"><span>d</span></strong></a>');
  });

  test('a change inside a shared loop renders in the right definition', async () => {
    const page = `<div data-sn-state="{ doc: ${state(DOC)} }"><button id="go" data-sn-on-click="doc = { children: [{ type: 'strong', note: 'S', children: [{ type: 'em', note: 'E', children: [t2] }, t3] }] }"></button><x-doc data-sn-with="{ doc }"></x-doc></div>`
      .replace('t2', "{ type: 'text', value: 'y' }").replace('t3', "{ type: 'text', value: 'z' }");
    const { root, flush } = await render(page, { components: TREE, dev: false });
    (root.querySelector('#go') as HTMLElement).click();
    await flush();
    expect(shape(root)).toBe('<strong title="S"><em title="E"><span>y</span></em><span>z</span></strong>');
  });

  test('a fill passed down the tree reaches through the shared loops', async () => {
    const { root } = await render(page({ children: [{ type: 'em', children: [{ type: 'strong', children: [{ type: 'link', url: '/deep', children: [t('in')] }] }] }] },
      '<b slot="link" data-sn-text="\'fill \' + $slot.node.url"></b>'), { components: TREE, dev: false });
    expect(shape(root)).toBe('<em><strong><b>fill /deep</b></strong></em>');
  });
});
