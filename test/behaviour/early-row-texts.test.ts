// @vitest-environment jsdom
// A `<template data-sn-text>` with no element before it, inside an element of a row, a branch or a choice's case
// (`<span><template data-sn-text>…</template></span>`): its marker is an empty comment, and the early script, which
// renders each root as the parser closes it, took that comment for an anchor whose end was not parsed yet. The
// text waited, and nothing wrote it again: the first paint lacked it until the page module took over.
// And a text right after an element whose own text is the same expression (a component's root showing the value the
// text shows after it): the early script took the second binding for the first, written already, and skipped it.
import { expect, test } from 'vitest';
import { firstPaint, render } from '../../src/testing/index.js';

const components = {
  'x-a': '<template data-sn-props="{ x: any }"><span><template data-sn-text="x.t"></template></span></template>',
  'x-b': '<template data-sn-props="{ x: any }"><b data-sn-text="x.t"></b></template>',
};
const data = [{ k: 'a', t: 'one', on: true }, { k: 'b', t: 'two', on: true }];
const page = (body: string) => `<!doctype html><html><head><script type="application/json" data-sn-resource="d">${JSON.stringify(data)}</script></head><body>
  <sn-resource name="d" src="/api/d"></sn-resource><main>${body}</main></body></html>`;

const cases = {
  'a choice in a row': `<template data-sn-for="x in d"><sn-component use="{ a: 'x-a', b: 'x-b' }[x.k]" data-sn-with="{ x }"></sn-component></template>`,
  'a choice in a branch': `<template data-sn-if="d.length"><sn-component use="{ a: 'x-a', b: 'x-b' }[d[0].k]" data-sn-with="{ x: d[0] }"></sn-component></template>`,
  'a row': `<template data-sn-for="x in d"><span><template data-sn-text="x.t"></template></span></template>`,
  'after an element showing the same value': `<template data-sn-for="x in d"><x-b data-sn-with="{ x }"></x-b><template data-sn-text="x.t"></template></template>`,
  'a branch in a row': `<template data-sn-for="x in d"><template data-sn-if="x.on"><span><template data-sn-text="x.t"></template></span></template></template>`,
};

for (const [name, body] of Object.entries(cases)) {
  test(`${name}: the first paint has the text, as the page module renders it`, async () => {
    const painted = (await firstPaint(page(body), { components })).root.querySelector('main')!.textContent;
    const { root, settle } = await render(page(body), { components, firstPaint: true });
    await settle();
    expect(painted).toBe(root.querySelector('main')!.textContent);
    expect(painted).toMatch(/^one/);
  });
}
