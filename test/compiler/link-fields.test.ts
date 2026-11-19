// Linking (docs/proposals/compile-once.md, (5)) records what a definition changes field by field of the compiler, by what
// each field holds. Every field is classified in `LINK_FIELDS` (src/compiler/link.ts): one this test finds unlisted, or
// holding another kind than listed, fails it, so a new field is classified before linking can miss what it holds.
import { expect, test } from 'vitest';
import { compilerFields } from '../../src/compiler/compile.js';
import { LINK_FIELDS } from '../../src/compiler/link.js';

const INL = "{ text: 'x-text', link: 'x-link' }";
const components: Record<string, string> = {
  'x-doc': `<template data-sn-props="{ doc: any }"><div><template data-sn-for="n in doc.children"><sn-component use="${INL}[n.type]" data-sn-with="{ node: n }"></sn-component></template></div></template>`,
  'x-text': '<template data-sn-props="{ node: any }"><span data-sn-text="node.value"></span></template>',
  'x-link': `<template data-sn-props="{ node: any }"><a data-sn-attr="{ href: node.url }"><template data-sn-for="n in node.children"><sn-component use="${INL}[n.type]" data-sn-with="{ node: n }"></sn-component></template></a></template>`,
  'x-count': '<template data-sn-props="{ start: number }"><span data-sn-state="{ n: start }"><button data-sn-on-click="n++" data-sn-text="n"></button></span></template>',
};
const files: Record<string, string> = {
  '/p/doc.json': JSON.stringify({ children: [{ type: 'text', value: 'a' }, { type: 'link', url: '/b', children: [{ type: 'text', value: 'b' }] }] }),
  '/p/content/posts/a.md': '---\ntitle: A\n---\nA.\n',
  '/p/content/posts/b.md': '---\ntitle: B\n---\nB.\n',
};
for (const [k, s] of Object.entries(components)) files[`/p/src/components/${k}.html`] = s;
const base = {
  file: '/p/index.html', root: '/p', dev: false, prerender: true, componentNames: Object.keys(components),
  helpers: { module: null, names: [], namespaces: {} },
  readFile: (f: string) => { if (f in files) return files[f]!; throw new Error(`no such file: ${f}`); },
  listFiles: (d: string) => Object.keys(files).filter((f) => f.startsWith(d.replace(/\/$/, '') + '/')),
};
const page = (body: string) => `<!doctype html><html lang="en"><head></head><body>${body}</body></html>`;
const PAGES: Array<[string, Record<string, unknown>]> = [
  [page('<sn-resource name="doc" src="file:./doc.json"></sn-resource><x-doc data-sn-with="{ doc }"></x-doc><x-count data-sn-with="{ start: 1 }"></x-count>'), {}],
  [page('<section data-sn-state="{ wide: false }"><div data-sn-class="{ wide }"><img src="img/a.jpg" alt=""></div><button data-sn-on-click="wide = !wide">w</button></section>'),
    { styles: [{ file: '/p/s.css', css: '.wide { width: 900px } img { width: 100% }' }], images: { info: () => null, url: () => '/i.jpg', stylesheet: '/@sinter/img.css' } }],
  ['<!doctype html><html lang="en" data-sn-path="/blog/:slug" data-sn-for="post in posts"><head><title data-sn-text="post.title"></title></head><body><sn-resource name="posts" src="file:/content/posts/*.md"></sn-resource><h1 data-sn-text="post.title"></h1></body></html>', {}],
  [page('<div data-sn-state="{ q: \'\' }"><input data-sn-model="q"><p data-sn-text="q.length"></p></div>'), { check: true }],
];

test('every field of the compiler is in LINK_FIELDS, holding what it lists', () => {
  const seen = new Map<string, Set<string>>();
  for (const [html, more] of PAGES) for (const [k, kind] of compilerFields(html, { ...base, ...more } as never)) (seen.get(k) ?? seen.set(k, new Set()).get(k)!).add(kind);
  const unlisted = [...seen.keys()].filter((k) => !(k in LINK_FIELDS));
  expect(unlisted, 'fields to classify in LINK_FIELDS (src/compiler/link.ts)').toEqual([]);
  const wrong = [...seen].flatMap(([k, kinds]) => [...kinds].filter((x) => !LINK_FIELDS[k]!.kinds.includes(x)).map((x) => `${k}: ${x}`));
  expect(wrong, 'fields holding a kind LINK_FIELDS does not list').toEqual([]);
  // and nothing listed that the compiler no longer has
  expect(Object.keys(LINK_FIELDS).filter((k) => !seen.has(k))).toEqual([]);
});
