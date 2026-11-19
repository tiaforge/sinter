// @vitest-environment jsdom
// Tree slots (docs/proposals/component-libraries.md, section 4): a root's declared slot filled at
// placements deep inside its expansion, through shared definitions, with the fill compiled in the
// caller's scope and read through the run-time scope chain.
import { describe, expect, test } from 'vitest';
import { compile } from '../../src/compiler/index.js';
import { render } from '../../src/testing/index.js';

// a generic document tree: blocks and inlines by `type`, links anywhere
const BLOCKS = "{ para: 'x-para', list: 'x-list' }";
const INLINES = "{ text: 'x-text', em: 'x-em', link: 'x-link' }";
const inl = (list = 'node.children') => `<template data-sn-for="n in ${list}"><sn-component use="${INLINES}[n.type]" data-sn-prop="{ node: n }"></sn-component></template>`;
const TREE = {
  'x-doc': `<template data-sn-props="{ doc: any; link: Slot<{ node: any }>; emph: Slot<{ node: any }> }"><div class="doc"><template data-sn-for="b in doc.children"><sn-component use="${BLOCKS}[b.type]" data-sn-prop="{ node: b }"></sn-component></template></div></template>`,
  'x-para': `<template data-sn-props="{ node: any }"><p>${inl()}</p></template>`,
  'x-list': `<template data-sn-props="{ node: any }"><ul><template data-sn-for="i in node.children"><li><template data-sn-for="b in i.children"><sn-component use="${BLOCKS}[b.type]" data-sn-prop="{ node: b }"></sn-component></template></li></template></ul></template>`,
  'x-text': '<template data-sn-props="{ node: any }"><span data-sn-text="node.value"></span></template>',
  'x-em': `<template data-sn-props="{ node: any }"><slot name="emph" data-sn-prop="{ node }"><em>${inl()}</em></slot></template>`,
  // deep inside: its root is the tree placement
  'x-link': `<template data-sn-props="{ node: any }"><slot name="link" data-sn-prop="{ node }"><a data-sn-attr="{ href: node.url }">${inl()}</a></slot></template>`,
};
const t = (value: string) => ({ type: 'text', value });
const link = (url: string, ...children: any[]) => ({ type: 'link', url, children });
const DOC = { children: [
  { type: 'para', children: [t('a '), link('/1', t('one')), t(' b')] },
  { type: 'list', children: [{ children: [{ type: 'para', children: [{ type: 'em', children: [link('/2', t('two'))] }] }] }] },
] };
const docState = JSON.stringify(DOC).replace(/"/g, "'");

describe('a recursive tree with a link fill', () => {
  test('the fill reaches every depth, with the children; the default renders without one', async () => {
    const page = (fill: string) => `<div data-sn-state="{ doc: ${docState}, rel: 'ugc' }"><x-doc data-sn-prop="{ doc }">${fill}</x-doc></div>`;
    const { root } = await render(page('<a slot="link" data-sn-attr="{ href: $slot.node.url, rel }"><slot></slot> ↗</a>'), { components: TREE });
    expect([...root.querySelectorAll('a')].map((a) => `${a.getAttribute('href')}|${a.getAttribute('rel')}|${a.textContent}`)).toEqual(['/1|ugc|one ↗', '/2|ugc|two ↗']);
    // depth: the second link is in a list item's paragraph's emphasis
    expect(root.querySelector('li p em a')).not.toBeNull();
    const plain = await render(page(''), { components: TREE });
    expect([...plain.root.querySelectorAll('a')].map((a) => `${a.getAttribute('href')}|${a.getAttribute('rel')}|${a.textContent}`)).toEqual(['/1|null|one', '/2|null|two']);
  });

  test('a fill that writes the caller\'s state, and reads it: a change renders the fills', async () => {
    const page = `<div data-sn-state="{ doc: ${docState}, seen: '', mark: '' }"><p id="seen" data-sn-text="seen"></p><button id="m" data-sn-on-click="mark = '*'"></button>
      <x-doc data-sn-prop="{ doc }"><b slot="link" data-sn-on-click="seen = seen + $slot.node.url" data-sn-text="mark + $slot.node.url"></b></x-doc></div>`;
    const { root, flush } = await render(page, { components: TREE });
    const bs = () => [...root.querySelectorAll('b')];
    expect(bs().map((b) => b.textContent)).toEqual(['/1', '/2']);
    bs()[1]!.click(); bs()[0]!.click();
    await flush();
    expect(root.querySelector('#seen')!.textContent).toBe('/2/1');
    (root.querySelector('#m') as HTMLElement).click();
    await flush();
    expect(bs().map((b) => b.textContent)).toEqual(['*/1', '*/2']);
  });

  test('a fill in the caller\'s row writes that row\'s state', async () => {
    const page = `<main><template data-sn-for="d in [{ id: 1, doc: ${docState} }, { id: 2, doc: ${docState} }]"><section data-sn-state="{ n: 0 }"><i data-sn-text="d.id + ':' + n"></i>
      <x-doc data-sn-prop="{ doc: d.doc }"><b slot="link" data-sn-on-click="n = n + 1"></b></x-doc></section></template></main>`;
    const { root, flush } = await render(page, { components: TREE });
    const sections = [...root.querySelectorAll('section')];
    (sections[1]!.querySelectorAll('b')[1] as HTMLElement).click();
    await flush();
    expect(sections.map((x) => x.querySelector('i')!.textContent)).toEqual(['1:0', '2:1']);
  });


});

describe('app-wide looks: a wrapper', () => {
  test('its root is the tree root: its own link fill everywhere, a forwarded slot the page fills, the page\'s class on the root', async () => {
    const WRAP = `<template data-sn-props="{ doc: any; emph: Slot<{ node: any }> }"><x-doc data-sn-prop="{ doc }"><a slot="link" class="w" data-sn-attr="{ href: $slot.node.url }"><slot></slot></a><slot name="emph" slot="emph" data-sn-prop="{ node: $slot.node }"></slot></x-doc></template>`;
    const page = (fill: string) => `<div data-sn-state="{ doc: ${docState} }"><x-wrap class="page" data-sn-prop="{ doc }">${fill}</x-wrap></div>`;
    const { root } = await render(page('<strong slot="emph"><slot></slot></strong>'), { components: { ...TREE, 'x-wrap': WRAP } });
    expect(root.querySelector('div.doc.page')).not.toBeNull();
    expect([...root.querySelectorAll('a.w')].map((a) => `${a.getAttribute('href')}:${a.textContent}`)).toEqual(['/1:one', '/2:two']);
    // the page's fill for the forwarded slot, with the children
    expect(root.querySelector('li p strong a.w')?.textContent).toBe('two');
    expect(root.querySelector('em')).toBeNull();
    // left unfilled by the page: the wrapper's slot shows its children, here none, so the library's default
    const plain = await render(page(''), { components: { ...TREE, 'x-wrap': WRAP } });
    expect(plain.root.querySelector('li p em a.w')?.textContent).toBe('two');
  });
});

describe('a nested root boundary', () => {
  test('a root written in a fill starts a new contract: the outer fill does not reach its tree', async () => {
    const inner = JSON.stringify({ children: [{ type: 'para', children: [link('/in', t('in'))] }] }).replace(/"/g, "'");
    const page = `<div data-sn-state="{ doc: ${docState}, inner: ${inner} }"><x-doc data-sn-prop="{ doc }"><span slot="link" class="outer"><x-doc data-sn-prop="{ doc: inner }"></x-doc></span></x-doc></div>`;
    const { root } = await render(page, { components: TREE });
    expect(root.querySelectorAll('span.outer')).toHaveLength(2);
    // inside each outer fill, the inner tree's link is its default
    expect([...root.querySelectorAll('span.outer a')].map((a) => `${a.getAttribute('href')}:${a.textContent}`)).toEqual(['/in:in', '/in:in']);
  });
});

test('state a fill reads reaches it through components used inside one another (a link in an emphasis in an emphasis)', async () => {
  const deep = JSON.stringify({ children: [{ type: 'para', children: [{ type: 'em', children: [{ type: 'em', children: [link('/d', t('d'))] }] }] }] }).replace(/"/g, "'");
  const { root, flush } = await render(`<div data-sn-state="{ doc: ${deep}, rel: 'a' }"><button id="r" data-sn-on-click="rel = 'b'"></button><x-doc data-sn-prop="{ doc }"><a slot="link" data-sn-attr="{ rel }"><slot></slot></a></x-doc></div>`, { components: TREE });
  expect(root.querySelector('em em a')!.getAttribute('rel')).toBe('a');
  (root.querySelector('#r') as HTMLElement).click();
  await flush();
  expect(root.querySelector('em em a')!.getAttribute('rel')).toBe('b');
});
