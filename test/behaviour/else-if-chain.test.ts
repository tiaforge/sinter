// @vitest-environment jsdom
// An else-if chain (`<template data-sn-else data-sn-if>`, then a plain `data-sn-else`) shows one branch at most: at the
// page's level, in a loop's rows, over state the page changes and over constants the build could decide.
import { expect, test } from 'vitest';
import { compile } from '../../src/compiler/index.js';
import { render } from '../../src/testing/index.js';

const CHAIN = (v: string) => `<template data-sn-if="${v} === 'a'"><p>A</p></template>
      <template data-sn-else data-sn-if="${v} === 'b'"><p>B</p></template>
      <template data-sn-else data-sn-if="${v} === 'c'"><p>C</p></template>
      <template data-sn-else><p>ELSE</p></template>`;
const shown = (el: Element) => [...el.querySelectorAll('p')].map((p) => p.textContent).join(',');

test('at the page\'s level, over state the page changes: one branch, the else where none holds', async () => {
  const { root, settle } = await render(`<div data-sn-state="{ k: 'b' }"><button data-sn-on-click="k = k === 'b' ? 'c' : k === 'c' ? 'z' : 'a'"></button><div id="x">${CHAIN('k')}</div></div>`);
  const x = root.querySelector('#x')!, b = root.querySelector('button')!;
  expect(shown(x)).toBe('B');
  b.click(); await settle();
  expect(shown(x)).toBe('C');
  b.click(); await settle();
  expect(shown(x)).toBe('ELSE');
  b.click(); await settle();
  expect(shown(x)).toBe('A');
});

test('two branches that both hold: the first one alone', async () => {
  const { root } = await render(`<div data-sn-state="{ a: true, b: true }"><button data-sn-on-click="a = false"></button><template data-sn-if="a"><p>A</p></template><template data-sn-else data-sn-if="b"><p>B</p></template></div>`);
  expect(shown(root)).toBe('A');
});

test('in a loop\'s rows (Caley\'s email reader): each row its one branch', async () => {
  const { root, settle } = await render(`<div data-sn-state="{ xs: ['b', 'z', 'a', 'c'] }"><button data-sn-on-click="xs = ['z', 'c']"></button><template data-sn-for="x in xs"><div class="row">${CHAIN('x')}</div></template></div>`);
  expect([...root.querySelectorAll('.row')].map(shown)).toEqual(['B', 'ELSE', 'A', 'C']);
  root.querySelector('button')!.click(); await settle();
  expect([...root.querySelectorAll('.row')].map(shown)).toEqual(['ELSE', 'C']);
});

test('over constants: built without SN102, one branch in the markup', async () => {
  const html = `<!doctype html><html><head></head><body data-sn-state="{ k: 'b' }"><div id="x">${CHAIN('k')}</div><template data-sn-for="x in ['z']"><div class="row">${CHAIN('x')}</div></template></body></html>`;
  const out = compile(html, { file: '/p/index.html', root: '/p', dev: false, helpers: { module: null, names: [], namespaces: {} }, readFile: () => { throw new Error('none'); } });
  expect(out.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
  const { root } = await render(html.replace(/^.*<body/, '<body').replace(/<\/html>$/, ''));
  expect(shown(root.querySelector('#x')!)).toBe('B');
  expect(shown(root.querySelector('.row')!)).toBe('ELSE');
});

test('an else-if after nothing: SN102', () => {
  const out = compile('<!doctype html><html><head></head><body data-sn-state="{ k: 1 }"><button data-sn-on-click="k = 2"></button><template data-sn-else data-sn-if="k"><p></p></template></body></html>',
    { file: '/p/index.html', root: '/p', dev: false, helpers: { module: null, names: [], namespaces: {} }, readFile: () => { throw new Error('none'); } });
  expect(out.diagnostics.map((d) => d.code)).toContain('SN102');
});
