// @vitest-environment jsdom
// A `<template data-sn-text>` after an anchor (a branch, a list) in a row or a branch: its path counts the
// anchor's two comments, so the text lands where it is written and stays there across renders.
import { expect, test } from 'vitest';
import { render } from '../../src/testing/index.js';

const shape = (n: Node): string => [...n.childNodes].map((c) => (c.nodeType === 3 ? (c as Text).data : c.nodeType === 1 ? `<${(c as Element).localName}>${shape(c)}</${(c as Element).localName}>` : '')).join('');
const page = (row: string, key = '') => `<div data-sn-state="{ d: [{ id: 1, on: true, t: 'T' }] }"><button id="w" data-sn-on-click="d = [{ id: 1, on: false, t: 'U' }, { id: 2, on: true, t: 'V' }]">w</button><p><template data-sn-for="x in d"${key}>${row}</template></p></div>`;

const cases: Array<[string, string, string, string]> = [
  ['a text in an element after an if', `<template data-sn-if="x.on"><b>!</b></template><i><template data-sn-text="x.t"></template></i>`, '<b>!</b><i>T</i>', '<i>U</i><b>!</b><i>V</i>'],
  ['in an <li>', `<li><template data-sn-if="x.on"><b>!</b></template><template data-sn-text="x.t"></template></li>`, '<li><b>!</b>T</li>', '<li>U</li><li><b>!</b>V</li>'],
  ['two ifs, then a text', `<template data-sn-if="x.on"><b>1</b></template><template data-sn-if="x.on"><b>2</b></template><template data-sn-text="x.t"></template>`, '<b>1</b><b>2</b>T', 'U<b>1</b><b>2</b>V'],
  ['inside an if branch', `<template data-sn-if="true"><template data-sn-if="x.on"><b>!</b></template><i><template data-sn-text="x.t"></template></i></template>`, '<b>!</b><i>T</i>', '<i>U</i><b>!</b><i>V</i>'],
  ['after a nested list', `<template data-sn-for="y in [1, 2]" data-sn-key="y"><b>-</b></template><template data-sn-text="x.t"></template>`, '<b>-</b><b>-</b>T', '<b>-</b><b>-</b>U<b>-</b><b>-</b>V'],
];

for (const [name, row, before, after] of cases) {
  for (const key of ['', ' data-sn-key="x.id"']) {
    test(`${name}${key ? ', keyed' : ''}`, async () => {
      const { root, settle } = await render(page(row, key));
      expect(shape(root.querySelector('p')!)).toBe(before);
      (root.querySelector('#w') as HTMLButtonElement).click();
      await settle();
      expect(shape(root.querySelector('p')!)).toBe(after);
    });
  }
}
