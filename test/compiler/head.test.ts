// Heads parsed so that every element stays where it is written (docs/proposals/layouts.md, Parsing the head).
import { describe, expect, test } from 'vitest';
import * as parse5 from 'parse5';
import { parseDocument } from '../../src/compiler/head.js';
import { compile } from '../../src/compiler/index.js';

const run = (html: string, components: Record<string, string> = {}) => {
  const files: Record<string, string> = {};
  for (const [k, v] of Object.entries(components)) files[`/p/src/components/${k}.html`] = v;
  return compile(html, { file: '/p/index.html', root: '/p', dev: false, helpers: { module: null, names: [], namespaces: {} }, readFile: (p) => { if (p in files) return files[p]!; throw new Error('missing'); } });
};

describe('parseDocument', () => {
  test('a head the standard parser keeps is parsed as it parses it', () => {
    const html = '<!doctype html><html><head>\n<meta charset="utf-8"><title>t</title>\n<link rel="stylesheet" href="/a.css"></head><body><p>x</p></body></html>';
    expect(parse5.serialize(parseDocument(html))).toBe(parse5.serialize(parse5.parse(html)));
  });

  test('an unknown element keeps its place, and so do the elements after it', () => {
    const html = '<!doctype html><html><head>\n  <meta charset="utf-8">\n  <x-seo a="1"></x-seo>\n  <slot name="head"></slot>\n  <link rel="stylesheet" href="/a.css">\n</head><body><p>x</p></body></html>';
    const out = parse5.serialize(parseDocument(html));
    expect(out).toBe('<!DOCTYPE html><html><head>\n  <meta charset="utf-8">\n  <x-seo a="1"></x-seo>\n  <slot name="head"></slot>\n  <link rel="stylesheet" href="/a.css">\n</head><body><p>x</p></body></html>');
  });

  test('offsets are those of the source', () => {
    const html = '<!doctype html><html><head>\n<x-seo></x-seo><title>t</title></head><body><p id="b">x</p></body></html>';
    const doc = parseDocument(html);
    const head = (doc.childNodes[1] as parse5.DefaultTreeAdapterMap['element']).childNodes[0] as parse5.DefaultTreeAdapterMap['element'];
    const seo = head.childNodes.find((c) => c.nodeName === 'x-seo') as parse5.DefaultTreeAdapterMap['element'];
    const title = head.childNodes.find((c) => c.nodeName === 'title') as parse5.DefaultTreeAdapterMap['element'];
    expect(html.slice(seo.sourceCodeLocation!.startOffset, seo.sourceCodeLocation!.endOffset)).toBe('<x-seo></x-seo>');
    expect(html.slice(title.sourceCodeLocation!.startOffset, title.sourceCodeLocation!.endOffset)).toBe('<title>t</title>');
    const body = (doc.childNodes[1] as parse5.DefaultTreeAdapterMap['element']).childNodes.find((c) => c.nodeName === 'body') as parse5.DefaultTreeAdapterMap['element'];
    const p = body.childNodes[0] as parse5.DefaultTreeAdapterMap['element'];
    expect(html.slice(p.sourceCodeLocation!.startOffset, p.sourceCodeLocation!.endOffset)).toBe('<p id="b">x</p>');
  });
});

describe('the compiled head', () => {
  test('a body element in the head is SN320, at its place', () => {
    const d = run('<!doctype html><html><head>\n<title>t</title>\n<div>x</div>\n</head><body></body></html>').diagnostics;
    expect(d.map((x) => `${x.code} ${x.line}:${x.col}`)).toEqual(['SN320 3:1']);
  });

  test('text in the head is SN320', () => {
    expect(run('<!doctype html><html><head><x-a></x-a>hello</head><body></body></html>').diagnostics.map((x) => x.code)).toContain('SN320');
  });

  test('a resource or a stream in the head is SN320: they go in the body; the rest of the page still sees the resource', () => {
    const out = run('<!doctype html><html><head><sn-resource name="a" src="/api/a"></sn-resource><link rel="stylesheet" href="/a.css"></head><body><p data-sn-text="a"></p></body></html>');
    expect(out.diagnostics.map((d) => `${d.code} ${d.message}`)).toEqual(['SN320 `<sn-resource>` goes in the body, not the `<head>`']);
    expect(run('<!doctype html><html><head><sn-sync src="/api/events"></sn-sync></head><body></body></html>').diagnostics.map((d) => d.code)).toEqual(['SN320']);
  });
});

describe('head bindings', () => {
  const errs = (head: string) => run(`<!doctype html><html><head>${head}</head><body></body></html>`).diagnostics.filter((d) => d.severity === 'error').map((d) => `${d.code} ${d.message}`);
  test('a <meta name|property|itemprop> binds its content', () => {
    expect(errs('<meta name="description" data-sn-attr="{ content: \'a\' + 1 }">')).toEqual([]);
    expect(errs('<meta property="og:title" data-sn-attr="{ content: \'a\' + 1 }">')).toEqual([]);
    expect(errs('<meta itemprop="name" data-sn-attr="{ content: \'a\' + 1 }">')).toEqual([]);
  });
  test('nothing else of a meta binds', () => {
    expect(errs('<meta http-equiv="refresh" data-sn-attr="{ content: \'0;url=/x\' }">')).toEqual([expect.stringMatching(/^SN207 a `<meta http-equiv>` cannot carry bindings/)]);
    expect(errs('<meta charset="utf-8" data-sn-attr="{ content: \'x\' }">')).toEqual([expect.stringMatching(/^SN207 a `<meta charset>` cannot carry bindings/)]);
    expect(errs('<meta data-sn-attr="{ content: \'x\' }">')).toEqual([expect.stringMatching(/^SN207 a bound `<meta>` names what it is/)]);
    expect(errs('<meta name="x" data-sn-attr="{ name: \'y\' }">')).toEqual([expect.stringMatching(/^SN207 a `<meta>` binds only `content`; `name` stays as written/)]);
    expect(errs('<meta name="x" data-sn-show="true">')).toEqual([expect.stringMatching(/^SN207 `<meta>` takes only `data-sn-attr="\{ content: … \}"`/)]);
    expect(errs('<link rel="canonical" data-sn-attr="{ href: \'/x\' }">')).toEqual([expect.stringMatching(/^SN207 `<link>` cannot carry sinter bindings/)]);
  });
  test('a constant is written into the HTML at build time, for scrapers', () => {
    const out = compile('<!doctype html><html><head><meta name="description" data-sn-attr="{ content: \'About\' }"><title data-sn-text="\'T\'"></title></head><body></body></html>',
      { file: '/p/index.html', root: '/p', dev: false, prerender: true, helpers: { module: null, names: [], namespaces: {} }, readFile: () => { throw new Error('missing'); } });
    expect(out.html).toMatch(/<meta name="description" (data-sn="\d+" )?content="About">/);
    expect(out.html).toMatch(/<title( data-sn="\d+")?>T<\/title>/);
  });
});

describe('SN321 inside templates', () => {
  const codes = (head: string) => run(`<!doctype html><html><head>${head}</head><body></body></html>`).diagnostics.filter((d) => d.code === 'SN321').map((d) => d.message);
  test('the branches of one if/else are one; a duplicate of a branch at the top level, or in one branch, is not', () => {
    expect(codes('<template data-sn-if="1"><title>a</title></template><template data-sn-else><title>b</title></template>')).toEqual([]);
    expect(codes('<title>t</title><template data-sn-if="1"><title>a</title></template>')).toEqual([expect.stringMatching(/^a second `<title>` in the head/)]);
    expect(codes('<template data-sn-if="1"><title>a</title><title>b</title></template>')).toEqual([expect.stringMatching(/^a second `<title>` in the head/)]);
    expect(codes('<template data-sn-if="1"><meta name="description" content="a"></template><template data-sn-else><title>b</title></template><title>c</title>')).toEqual([expect.stringMatching(/^a second `<title>`/)]);
  });
  test('in a data-sn-for template, one per row', () => {
    expect(codes('<template data-sn-for="x in [1, 2]"><meta property="og:title" content="a"></template>')).toEqual([expect.stringMatching(/^`<meta property="og:title">` in a `data-sn-for` template: the head would have one per row/)]);
    expect(codes('<template data-sn-for="x in [1, 2]"><meta property="og:image" content="a"></template>')).toEqual([]);
  });
});
