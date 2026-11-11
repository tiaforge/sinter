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

  test('sinter elements may sit in the head, and the head elements after them stay there', () => {
    const out = run('<!doctype html><html><head><sn-resource name="a" src="/api/a"></sn-resource><link rel="stylesheet" href="/a.css"></head><body><p data-sn-text="a"></p></body></html>');
    expect(out.diagnostics).toEqual([]);
    expect(out.html).toMatch(/<head>.*<link rel="stylesheet" href="\/a.css">.*<\/head>/s);
  });
});
