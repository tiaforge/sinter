// The build's probe of a `<html data-sn-for>` page (src/vite.ts `templateOf`): it reads the page's entries, its axes'
// entries and the SN340/SN341 errors from a description (`describeOnly`, one pass, nothing evaluated) instead of a
// compile of the page. These are the walk's, so a description gives exactly what the page's own compile gives.
import { expect, test } from 'vitest';
import { compile, type CompileOptions } from '../../src/compiler/index.js';

const files: Record<string, string> = {
  '/app/content/acme/posts/a.md': '---\ntitle: Acme A\nslug: a\n---\n',
  '/app/content/acme/posts/c.md': '---\ntitle: Acme C\nslug: c\n---\n',
  '/app/content/globex/posts/b.md': '---\ntitle: Globex B\n---\n',
  '/app/content/posts/x.md': '---\ntitle: X\n---\n',
  '/app/content/posts/y.md': '---\ntitle: Y\nslug: y/z\n---\n',
};
const collections = new Map([['tenants', { key: 'key', value: [{ key: 'acme', name: 'Acme' }, { key: 'globex', name: 'Globex' }] }]]);
const base: CompileOptions = {
  file: '/app/blog/post.html', root: '/app', dev: false, moduleSrc: '/m.js', collections,
  readFile: (p) => { const t = files[p]; if (t === undefined) throw new Error('no ' + p); return t; },
  listFiles: (d) => Object.keys(files).filter((f) => f.startsWith(d)),
  helpers: { module: null, names: [], namespaces: {} },
};
const axes = `<!doctype html><html data-sn-for="tenant in tenants; post in posts" data-sn-path="/blog/:slug"><head><title data-sn-text="tenant.name + ': ' + post.title"></title></head><body>
<sn-resource name="tenants" src="content:tenants"></sn-resource>
<sn-resource name="posts" src="file:/content/{tenant.key}/posts/*.md"></sn-resource>
<h1 data-sn-text="tenant.name"></h1><section data-sn-state="{ n: 0 }"><button data-sn-on-click="n++" data-sn-text="n"></button></section>
<template data-sn-if="post.title.length > 3"><p data-sn-text="post.title"></p></template></body></html>`;
const plain = `<!doctype html><html data-sn-for="post in posts" data-sn-path="/notes/:slug"><head><title data-sn-text="post.title"></title></head><body>
<sn-resource name="posts" src="file:/content/posts/*.md"></sn-resource><p data-sn-text="post.title"></p></body></html>`;

/** what the probe reads, from a compile with these options */
const probe = (html: string, o: Partial<CompileOptions>) => {
  const out = compile(html, { ...base, ...o });
  return { pages: out.pages ?? null, axes: out.axes ?? null, fatal: out.diagnostics.filter((d) => d.severity === 'error' && /^SN34[01]$/.test(d.code)) };
};

test.each([
  ['axes, at no value', axes, {}],
  ['axes, at the outer value', axes, { axes: [{ value: { key: 'globex', name: 'Globex' }, key: 'globex', segment: 'globex' }] }],
  ['the page\'s own entries, one with a bad path (SN340)', plain, {}],
  ['in a language', plain, { locale: { name: 'de', urls: null, base: '/' } }],
])('a description gives the entries and errors the page\'s compile gives: %s', (_, html, o) => {
  const described = probe(html, { ...o, describeOnly: true }), compiled = probe(html, { ...o, prerender: true });
  expect(described).toEqual(compiled);
  expect(described.pages ?? described.axes).not.toBeNull();
});

test('the bad entry is reported, the others listed', () => {
  const d = probe(plain, { describeOnly: true });
  expect(d.pages!.entries.map((e) => e.path)).toEqual(['/notes/x']);
  expect(d.fatal.map((x) => x.code)).toEqual(['SN340']);
});
