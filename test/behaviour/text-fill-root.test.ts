// @vitest-environment jsdom
// A text fill (`<template slot data-sn-text>`) of a `<slot>` that is a component's root: the root renders one
// text node. Over constants (expanded at build time) and over state (a choice at run time) alike.
import { expect, test } from 'vitest';
import { compileParts } from '../../src/compiler/index.js';
import { render } from '../../src/testing/index.js';

const components = {
  'x-doc': '<template data-sn-component="{ doc: any; link: Slot<{ node: any }> }"><p><template data-sn-for="n in doc"><sn-component use="{ link: \'x-l\', text: \'x-t\' }[n.type]" data-sn-prop="{ node: n }"></sn-component></template></p></template>',
  'x-l': '<template data-sn-component="{ node: any }"><slot name="link" data-sn-prop="{ node }"><a data-sn-attr="{ href: node.url }" data-sn-text="node.text"></a></slot></template>',
  'x-t': '<template data-sn-component="{ node: any }"><span data-sn-text="node.text"></span></template>',
};
const DOC = "[{ type: 'text', text: 'see ' }, { type: 'link', url: '/a', text: 'this' }]";
const fill = '<template slot="link" data-sn-text="$slot.node.text + \' (\' + $slot.node.url + \')\'"></template>';

test('over constants', async () => {
  // (render throws on an error: SN312 before this rule)
  const { root } = await render(`<div data-sn-state="{ doc: ${DOC} }"><x-doc data-sn-prop="{ doc }">${fill}</x-doc></div>`, { components });
  expect(root.querySelector('p')!.textContent).toBe('see this (/a)');
  expect(root.querySelector('a')).toBeNull();
});

test('over state', async () => {
  const { root, settle } = await render(`<div data-sn-state="{ doc: ${DOC} }"><button id="w" data-sn-on-click="doc = [{ type: 'link', url: '/b', text: 'that' }]">w</button><x-doc data-sn-prop="{ doc }">${fill}</x-doc></div>`, { components });
  expect(root.querySelector('p')!.textContent).toBe('see this (/a)');
  (root.querySelector('#w') as HTMLButtonElement).click();
  await settle();
  expect(root.querySelector('p')!.textContent).toBe('that (/b)');
  expect(root.querySelector('a')).toBeNull();
});

test('a tag whose root is a text fill: an attribute on it has no element to land on (SN334)', () => {
  const C: Record<string, string> = { 'x-box': '<template data-sn-component="{ label: Slot<{ n: number }> }"><slot name="label" data-sn-prop="{ n: 1 }"><b>x</b></slot></template>' };
  const codes = (tag: string) => compileParts(`<!doctype html><html><head></head><body>${tag}<template slot="label" data-sn-text="'n=' + $slot.n"></template></x-box></body></html>`, {
    file: '/p/index.html', root: '/p', dev: false, prerender: true, helpers: { module: null, names: [], namespaces: {} }, componentNames: Object.keys(C),
    readFile: (f) => { const m = /\/src\/components\/(.+)\.html$/.exec(f); if (m && m[1]! in C) return C[m[1]!]!; throw new Error('missing'); },
  }).diagnostics.map((d) => `${d.code} ${d.message}`);
  expect(codes('<x-box>')).toEqual([]);
  expect(codes('<x-box class="big">')).toEqual([expect.stringMatching(/^SN334 `<x-box>`'s root is a text here \(a text fill of the `<slot>` at the root\), so `class` on its tag has no element to land on/)]);
});
