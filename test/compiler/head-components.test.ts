// Head components (docs/proposals/layouts.md): `<template data-sn-head>` holds any number of head
// elements, inlined at the use in a head, with no wrapper.
import { describe, expect, test } from 'vitest';
import { compile } from '../../src/compiler/index.js';

const SEO = `<template data-sn-head="{ title?: string; image?: string }">
  <title data-sn-text="title ? title + ' · Blog' : 'Blog'">Blog</title>
  <template data-sn-if="image"><link rel="image_src" href="/x.png"></template>
  <og-tags data-sn-prop="{ t: title }"><meta name="x" content="in-og"></og-tags>
  <slot name="extra"></slot>
</template>`;
const OG = '<template data-sn-head="{ t?: string }"><template data-sn-if="t"><meta property="og:title" content="og"></template><slot></slot></template>';

function run(html: string, components: Record<string, string> = {}) {
  const files: Record<string, string> = {};
  for (const [k, v] of Object.entries({ 'seo-tags': SEO, 'og-tags': OG, ...components })) files[`/p/src/components/${k}.html`] = v;
  return compile(html, { file: '/p/index.html', root: '/p', dev: false, helpers: { module: null, names: [], namespaces: {} }, readFile: (p) => { if (p in files) return files[p]!; throw new Error('missing'); } });
}
const page = (head: string, body = '<p data-sn-text="post.title"></p>') =>
  `<!doctype html><html><head><meta charset="utf-8">${head}<link rel="stylesheet" href="/a.css"></head><body><sn-resource name="post" src="/api/post"></sn-resource>${body}</body></html>`;
const codes = (html: string, c?: Record<string, string>) => run(html, c).diagnostics.filter((d) => d.severity === 'error').map((d) => `${d.code} ${d.message}`);

describe('head components', () => {
  test('their elements take the tag\'s place in the head, with slots, nested head components and the caller\'s props', () => {
    const out = run(page('<seo-tags data-sn-prop="{ title: post?.title, image: false }"><meta slot="extra" name="robots" content="noindex"></seo-tags>'));
    expect(out.diagnostics).toEqual([]);
    const head = /<head>([\s\S]*)<\/head>/.exec(out.html)![1]!;
    expect(head).not.toMatch(/seo-tags|og-tags|<slot/);
    // the constant `image: false` dropped its branch at build time
    expect(head).not.toContain('image_src');
    expect(head).toMatch(/<title data-sn="\d+">Blog<\/title>[\s\S]*<template data-sn="\d+"><meta property="og:title" content="og"><\/template><meta name="x" content="in-og">[\s\S]*<meta name="robots" content="noindex">[\s\S]*<link rel="stylesheet" href="\/a.css">/);
    // the inner component's prop is the outer one's, which is the page's
    expect(out.module).toContain("($) => (($.$r.post?.title) ? ($.$r.post?.title) + ' · Blog' : 'Blog')");
    expect(out.module).toContain('($.$r.post?.title)');
  });

  test('a constant prop that is true keeps its branch', () => {
    expect(run(page('<seo-tags data-sn-prop="{ image: \'/a.png\' }"></seo-tags>')).html).toContain('<link rel="image_src" href="/x.png">');
  });

  test('a head component in a body, and a component in a head, are SN320', () => {
    expect(codes(page('', '<seo-tags></seo-tags>'))).toEqual([expect.stringMatching(/^SN320 `<seo-tags>` is a head component \(`data-sn-head`\): it goes in a `<head>`/)]);
    expect(codes(page('<x-box></x-box>', ''), { 'x-box': '<template data-sn-component=""><div></div></template>' })).toEqual([expect.stringMatching(/^SN320 `<x-box>` is a component with one root element, which cannot be in the `<head>`/)]);
  });

  test('a body element in a head component is SN320', () => {
    expect(codes(page('<x-bad></x-bad>', ''), { 'x-bad': '<template data-sn-head=""><title>t</title><div></div></template>' })).toEqual([expect.stringMatching(/^SN320 a head component holds head elements: `<div>` cannot be in `<x-bad>`/)]);
  });

  test('head elements in a data-sn-component: SN312 with the hint to declare it with data-sn-head', () => {
    const d = run(page('', '<x-two></x-two>'), { 'x-two': '<template data-sn-component=""><title>t</title><meta name="a" content="b"></template>' }).diagnostics.filter((x) => x.severity === 'error');
    expect(d.map((x) => x.code)).toEqual(['SN312']);
    expect(d[0]!.hint).toMatch(/declare it with `<template data-sn-head/);
  });

  test('the tag takes only data-sn-prop and slot content; a style beside it and a second declaration are errors', () => {
    expect(codes(page('<seo-tags class="a" data-sn-show="1"></seo-tags>'))).toEqual([
      expect.stringMatching(/^SN102 `class` cannot be on the tag of a head component/),
      expect.stringMatching(/^SN102 `data-sn-show` cannot be on the tag of a head component/),
    ]);
    expect(codes(page('<x-s></x-s>'), { 'x-s': '<template data-sn-head=""><title>t</title></template><style>title { color: red }</style>' })).toEqual([expect.stringMatching(/^SN320 the head component `<x-s>` has a `<style>` beside its template/)]);
    expect(codes(page('<x-d></x-d>'), { 'x-d': '<template data-sn-head="" data-sn-component=""><title>t</title></template>' })).toEqual([expect.stringMatching(/^SN312 `<x-d>` declares both/)]);
  });

  test('a wrong prop is SN313, as for every component', () => {
    expect(codes(page('<seo-tags data-sn-prop="{ titel: 1 }"></seo-tags>'))).toEqual([expect.stringMatching(/^SN313 `titel` is not a prop of `<seo-tags>`/)]);
  });
});
