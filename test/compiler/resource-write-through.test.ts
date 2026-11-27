// SN205 through state: a write in place into state that may hold a resource's data (`sel = row`, then `sel.n = 9`)
// would change the resource's own object, which production builds do not freeze (dev builds throw on it). The build
// follows the data from the resource through state, events' details, props and helper results (the alias records).
import { describe, expect, test } from 'vitest';
import { compileParts } from '../../src/compiler/index.js';

const components: Record<string, string> = {
  'row-pick': `<template data-sn-props="{ ys: Array<{ id: number; n: number }> }" data-sn-emits="{ pick: { id: number; n: number } }"><button data-sn-on-click="emit('pick', ys[0])"></button></template>`,
  'row-edit': `<template data-sn-props="{ item: { id: number; n: number } }"><button data-sn-on-click="item.n = 3"></button></template>`,
  'row-copy': `<template data-sn-props="{ item: { id: number; n: number } }"><div data-sn-state="{ cp: item }"><button data-sn-on-click="cp.n = 4"></button></div></template>`,
};
const compile = (html: string) => compileParts(`<sn-resource name="todos" src="/api/todos" key="id"></sn-resource>${html}`, {
  file: '/p/index.html', root: '/p', dev: false, componentNames: Object.keys(components),
  helpers: { module: '/src/sinter.helpers.ts', names: ['pick', 'fresh'], namespaces: {} },
  readFile: (f: string) => { const n = /components\/(.+)\.html$/.exec(f)?.[1]; if (n && n in components) return components[n]!; throw new Error('none'); },
  eventSenders: () => ({ unknown: null, risky: new Map() }),
});
const sn205 = (html: string) => compile(html).diagnostics.filter((d) => d.code === 'SN205');
const PICK = `<main data-sn-state="{ sel: null, list: [] }"><template data-sn-for="t in todos"><button data-sn-on-click="sel = t"></button></template>`;

describe('SN205 through state', () => {
  test('an assignment below the field: the field, where the data came from, and the fixes', () => {
    const ds = sn205(`${PICK}<button data-sn-on-click="sel.n = 9"></button></main>`);
    expect(ds).toHaveLength(1);
    expect(ds[0]).toMatchObject({ severity: 'error', line: 1 });
    expect(ds[0]!.message).toBe('`sel.n` is written in place, and `sel` may hold `todos`\'s data (from `sel = t`, index.html:1): the write would change the resource\'s own object, which the page\'s reads of `todos` do not see');
    expect(ds[0]!.hint).toContain('structuredClone(…)');
    expect(ds[0]!.hint).toContain('merge(…)');
  });

  test('each write form: ++, a mutating method, Object.assign, a list method on a stored list, data-sn-model', () => {
    for (const w of ['<button data-sn-on-click="sel.n++"></button>', '<button data-sn-on-click="sel.tags.push(1)"></button>', '<button data-sn-on-click="Object.assign(sel, { n: 1 })"></button>',
      '<button data-sn-on-click="list = todos; list.push(fresh())"></button>', '<input data-sn-model="sel.title">', '<button data-sn-on-click="sel.tags[0].k = 1"></button>']) {
      expect(sn205(`${PICK}${w}</main>`), w).toHaveLength(1);
    }
  });

  test('each way the data gets in: an element, an event\'s detail, a state initializer, a component\'s state from a prop, a loop over the field', () => {
    expect(sn205(`<main data-sn-state="{ sel: null }"><button data-sn-on-click="sel = todos[0]; sel.n = 1"></button></main>`)).toHaveLength(1);
    expect(sn205(`<main data-sn-state="{ sel: null }" data-sn-on-pick="sel = $event.detail"><row-pick data-sn-with="{ ys: todos }"></row-pick><button data-sn-on-click="sel.n = 1"></button></main>`)).toHaveLength(1);
    expect(sn205(`<main data-sn-state="{ sel: todos[0] }"><button data-sn-on-click="sel.n = 1"></button></main>`)).toHaveLength(1);
    expect(sn205(`<main><template data-sn-for="t in todos"><row-copy data-sn-with="{ item: t }"></row-copy></template></main>`)).toHaveLength(1);
    expect(sn205(`<main data-sn-state="{ sel: null, box: { all: [] } }"><button data-sn-on-click="box.all = todos"></button><template data-sn-for="x in box.all"><button data-sn-on-click="x.n = 1"></button></template></main>`)).toHaveLength(1);
    // through other state: a copy of the field's value
    expect(sn205(`${PICK}<button data-sn-on-click="list = [sel]; list[0].n = 2"></button></main>`)).toHaveLength(1);
  });

  test('a component cannot write through its prop at all (SN203), so a prop given the field needs no rule of its own', () => {
    expect(compile(`${PICK}<row-edit data-sn-with="{ item: sel }"></row-edit></main>`).diagnostics.map((d) => d.code)).toEqual(['SN203']);
  });

  test('no error: a copy, a spread one level deep, a primitive, the field reassigned, a fresh value, the resource\'s own forms', () => {
    expect(sn205(`<main data-sn-state="{ sel: null }"><button data-sn-on-click="sel = structuredClone(todos[0]); sel.n = 1"></button></main>`)).toEqual([]);
    expect(sn205(`<main data-sn-state="{ sel: null }"><button data-sn-on-click="sel = { ...todos[0] }; sel.n = 1"></button></main>`)).toEqual([]);
    expect(sn205(`<main data-sn-state="{ n: 0, sel: null }"><button data-sn-on-click="n = todos[0].n; n++"></button><button data-sn-on-click="sel = todos[0]; sel = null"></button></main>`)).toEqual([]);
    expect(sn205(`<main data-sn-state="{ sel: { n: 0 } }"><button data-sn-on-click="sel = fresh(); sel.n = 1"></button><button data-sn-on-click="sel.n = 2"></button></main>`)).toEqual([]);
    expect(sn205(`${PICK}<button data-sn-on-click="merge(sel, { n: 2 })"></button><button data-sn-on-click="remove(sel)"></button></main>`)).toEqual([]);
    // a list made of the rows is the page's own: its order changes no row
    expect(sn205(`<main data-sn-state="{ xs: [] }"><button data-sn-on-click="xs = [...todos]; xs.splice(0, 1)"></button></main>`)).toEqual([]);
  });

  test('a helper\'s result and an untraceable value are left to the dev freeze', () => {
    // the build does not read what a helper returns: a draft built from an item's fields is fresh, and would be reported
    expect(sn205(`<main data-sn-state="{ sel: null }"><button data-sn-on-click="sel = pick(todos); sel.n = 1"></button></main>`)).toEqual([]);
    expect(sn205(`<main data-sn-state="{ sel: null }"><button data-sn-on-click="sel = todos.reduce((a, t) => t, null); sel.n = 1"></button></main>`)).toEqual([]);
  });
});
