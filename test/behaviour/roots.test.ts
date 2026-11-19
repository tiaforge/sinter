// The component root (docs/proposals/component-libraries.md, section 3), in the browser: roots that
// are replaced when their condition changes, and the tag's attributes on shared definitions.
import { describe, expect, test } from 'vitest';
import { firstPaint, mockRequests, render } from '../../src/testing/index.js';

const NODE = `<template data-sn-props="{ node: { id: number; name: string; open: boolean; kids: any[] } }" data-sn-emits="{ pick: string }">
  <li data-sn-attr="{ 'data-id': node.id }">
    <span data-sn-text="node.name"></span>
    <ul><template data-sn-for="k in node.kids" data-sn-key="k.id"><tree-node class="child" title="inner" data-sn-class="{ open: k.open }" data-sn-on-click="$event.stopPropagation(); emit('pick', k.name)" data-sn-prop="{ node: k }"></tree-node></template></ul>
  </li>
</template>`;
const TREE = [{ id: 1, name: 'a', open: true, kids: [{ id: 2, name: 'b', open: false, kids: [{ id: 3, name: 'c', open: true, kids: [] }] }] }];

describe('the tag\'s attributes on a shared definition', () => {
  test('a recursion point\'s plain attributes, bound classes and handlers reach the root its definition renders', async () => {
    const requests = mockRequests({ 'GET /api/t': TREE });
    const { root, settle, flush, state } = await render(`<sn-resource name="tree" src="/api/t" key="id"></sn-resource>
      <div data-sn-state="{ picked: [] }"><p id="picked" data-sn-text="picked.join(',')"></p>
      <ul><template data-sn-for="t in tree" data-sn-key="t.id"><tree-node data-sn-prop="{ node: t }" data-sn-on-pick="picked = [...picked, $event.detail]"></tree-node></template></ul></div>`,
    { requests, components: { 'tree-node': NODE } });
    await settle();
    const li = (id: number) => root.querySelector(`li[data-id="${id}"]`)!;
    expect(li(1).className).toBe('');
    expect(li(2).className).toBe('child');
    expect(li(3).className).toBe('child open');
    expect(li(2).getAttribute('title')).toBe('inner');
    (li(3).querySelector('span') as HTMLElement).click();
    await flush();
    expect(root.querySelector('#picked')!.textContent).toBe('c');
    void state;
  });
});

describe('a choice as root', () => {
  const BLOCK = `<template data-sn-props="{ b: { type: string; text: string } }"><sn-component use="\`\${b.type}-block\`" data-sn-prop="{ b }"></sn-component></template>`;
  const HERO = '<template data-sn-props="{ b: { text: string } }"><h1 data-sn-text="b.text"></h1></template>';
  const TEXT = '<template data-sn-props="{ b: { text: string } }"><p data-sn-text="b.text"></p></template>';
  test('a dispatcher with no wrapper: the tag\'s attributes land on the chosen component\'s root, and follow a change', async () => {
    const { root, flush } = await render(`<div data-sn-state="{ blocks: [{ type: 'hero', text: 'H' }, { type: 'text', text: 'T' }], hot: true }"><i id="cool" data-sn-on-click="hot = false"></i>
      <template data-sn-for="b in blocks"><any-block class="blk" data-sn-class="{ hot }" data-sn-prop="{ b }"></any-block></template></div>`,
    { components: { 'any-block': BLOCK, 'hero-block': HERO, 'text-block': TEXT } });
    await flush();
    expect([...root.querySelectorAll('.blk')].map((e) => `${e.localName}.${e.className}:${e.textContent}`)).toEqual(['h1.blk hot:H', 'p.blk hot:T']);
    (root.querySelector('#cool') as HTMLElement).click();
    await flush();
    expect([...root.querySelectorAll('.blk')].map((e) => e.className)).toEqual(['blk', 'blk']);
  });
});

describe('roots replaced when their condition changes', () => {
  const BUTTON = `<template data-sn-props="{ href?: string; label: string }">
  <template data-sn-if="href"><a class="btn" data-sn-attr="{ href }" data-sn-text="label"></a></template>
  <template data-sn-else><button class="btn" type="button" data-sn-text="label"></button></template>
</template>`;
  test('in a keyed list: each row\'s root is replaced on its own, with the tag\'s class and handler', async () => {
    const page = `<div data-sn-state="{ items: [{ id: 1, to: '/a' }, { id: 2, to: '' }], n: 0 }"><p id="n" data-sn-text="n"></p><i id="swap" data-sn-on-click="items = [{ id: 2, to: '/b' }, { id: 1, to: '' }]"></i>
      <template data-sn-for="it in items" data-sn-key="it.id"><ui-button class="row" data-sn-prop="{ href: it.to, label: 'L' + it.id }" data-sn-on-click="$event.preventDefault(); n = n + it.id"></ui-button></template></div>`;
    const { root, flush } = await render(page, { components: { 'ui-button': BUTTON } });
    await flush();
    const shape = () => [...root.querySelectorAll('.row')].map((e) => `${e.localName}:${e.textContent}`);
    expect(shape()).toEqual(['a:L1', 'button:L2']);
    (root.querySelector('#swap') as HTMLElement).click();
    await flush();
    expect(shape()).toEqual(['a:L2', 'button:L1']);
    (root.querySelector('button.row') as HTMLButtonElement).click();
    (root.querySelector('a.row') as HTMLAnchorElement).click();
    await flush();
    expect(root.querySelector('#n')!.textContent).toBe('3');
  });

  test('first paint: a root decided at build time, and one decided early, which the takeover keeps', async () => {
    const page = `<div data-sn-state="{ to: '/x' }"><ui-button class="one" data-sn-prop="{ label: 'Fixed' }"></ui-button><ui-button class="two" data-sn-prop="{ href: to, label: 'Go' }"></ui-button></div>`;
    const early = await firstPaint(page, { components: { 'ui-button': BUTTON } });
    const shape = (r: ParentNode) => [...r.querySelectorAll('.btn')].map((e) => `${e.localName}.${e.className}:${e.textContent}`);
    expect(shape(early.root)).toEqual(['button.btn one:Fixed', 'a.btn two:Go']);
    const { root } = await render(page, { components: { 'ui-button': BUTTON } });
    expect(shape(root)).toEqual(shape(early.root));
  });
});
