// Default row keys (docs/spec.md, Default keys): a list chosen between resources keys by their key fields when every
// candidate has the same ones; a list of strings or numbers needs no `data-sn-key` (the runtime keys it by value).
import { expect, test } from 'vitest';
import { compile } from '../../src/compiler/index.js';

const keysOf = (body: string) => {
  const out = compile(`<sn-resource name="a" src="/a" key="slug"></sn-resource><sn-resource name="b" src="/b" key="slug"></sn-resource>
    <sn-resource name="c" src="/c" key="id"></sn-resource><sn-resource name="n" src="/n"></sn-resource>
    <div data-sn-state="{ f: false }" data-sn-let="{ list: f ? a : b, mixed: f ? a : c }"><button data-sn-on-click="f = !f"></button>${body}</div>`, {
    file: '/p/page.html', root: '/p', dev: false, readFile: () => { throw new Error('none'); },
    helpers: { module: '/h.js', names: ['vis'], namespaces: {} },
  });
  expect(out.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
  const ir = JSON.parse(/const ir = (\{.*?\});\n/.exec(out.module)![1]!) as { templates: Array<{ keyFields?: string[]; key?: number }> };
  return ir.templates.map((t) => t.keyFields ?? (t.key != null ? 'explicit' : null));
};
const row = (list: string) => `<template data-sn-for="x in ${list}"><i data-sn-text="x.v"></i></template>`;

test('a choice between resources with the same key keys by it: through lets, ?:, ||, ??, filter/toSorted, a helper given one and an empty literal beside one', () => {
  expect(keysOf([row('list'), row('(f ? a : b)'), row('(a || b)'), row('(a ?? b)'), row('list.filter((y) => y.v)'), row('list.toSorted()'), row('vis(b, 1)'), row('(f ? a : [])'), row('a')].join(''))).toEqual(
    [['slug'], ['slug'], ['slug'], ['slug'], ['slug'], ['slug'], ['slug'], ['slug'], ['slug']]);
});

test('candidates with other keys, or none, a helper given two resources, and an explicit key are left as they are', () => {
  expect(keysOf([row('mixed'), row('(f ? a : n)'), row('vis(a, b)'), `<template data-sn-for="x in list" data-sn-key="x.v"><i></i></template>`].join(''))).toEqual(
    [null, null, null, 'explicit']);
});

test('a list of strings or numbers needs no data-sn-key (SN103 is retired)', () => {
  expect(keysOf(`<template data-sn-for="x in ['a', 'a', 'b']"><i data-sn-text="x"></i></template><template data-sn-for="k in Object.keys({ p: 1 })"><i data-sn-text="k"></i></template>`)).toEqual([null, null]);
});
