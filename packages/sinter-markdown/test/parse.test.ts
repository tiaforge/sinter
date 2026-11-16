// md.parse and its options (proposal, section 10), and the helpers that read a tree. These are plain
// functions: tested in Node, with no sinter involved.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, test } from 'vitest';
import { parse } from '../sinter/parse.js';
import { headings, text } from '../sinter/tree.js';
import { PKG } from './app.js';

const t = (value: string) => ({ type: 'text', value });
const para = (...children: unknown[]) => ({ type: 'paragraph', children });

describe('the tree', () => {
  test('CommonMark: headings, emphasis, code, quotes, lists, breaks; plain data, no positions', () => {
    const doc = parse('# Hi *there*\n\n> a  \n> b\n\n1. one\n2. two\n\n```ts meta\nlet x\n```\n\n---\n');
    expect(doc).toEqual({ type: 'root', children: [
      { type: 'heading', depth: 1, slug: 'hi-there', children: [t('Hi '), { type: 'emphasis', children: [t('there')] }] },
      { type: 'blockquote', children: [para(t('a'), { type: 'break' }, t('b'))] },
      { type: 'list', ordered: true, start: 1, spread: false, children: [
        { type: 'listItem', checked: null, children: [para(t('one'))] },
        { type: 'listItem', checked: null, children: [para(t('two'))] },
      ] },
      { type: 'code', lang: 'ts', meta: 'meta', value: 'let x' },
      { type: 'thematicBreak' },
    ] });
    expect(JSON.parse(JSON.stringify(doc))).toEqual(doc);
  });

  test('GFM: tables, task lists, strikethrough, autolinks; no footnotes', () => {
    const doc = parse('| a | b |\n| :- | -: |\n| 1 | **2** |\n\n- [x] done\n- [ ] not\n\n~~gone~~ www.example.com\n\n[^1]\n\n[^1]: a note');
    expect(doc.children[0]).toEqual({ type: 'table', align: ['left', 'right'], children: [
      { type: 'tableRow', children: [{ type: 'tableCell', children: [t('a')] }, { type: 'tableCell', children: [t('b')] }] },
      { type: 'tableRow', children: [{ type: 'tableCell', children: [t('1')] }, { type: 'tableCell', children: [{ type: 'strong', children: [t('2')] }] }] },
    ] });
    expect(doc.children[1]).toMatchObject({ type: 'list', children: [{ checked: true }, { checked: false }] });
    expect(doc.children[2]).toEqual(para({ type: 'delete', children: [t('gone')] }, t(' '), { type: 'link', url: 'http://www.example.com', title: null, children: [t('www.example.com')] }));
    // footnotes are not an extension here: their syntax stays text
    expect(text(doc.children[3]!)).toBe('[^1]');
  });

  test('entities are decoded by the table, never by the DOM', () => {
    expect(parse('Fish &amp; chips &copy; &#x41; &unknown;')).toEqual({ type: 'root', children: [para(t('Fish & chips © A &unknown;'))] });
  });

  test('references are resolved, definitions leave the tree; text runs are merged', () => {
    const doc = parse('[a][r] and [r] and ![i][img]\n\n[r]: /u "T"\n[img]: /i.png\n[r]: /ignored');
    expect(doc.children).toEqual([para(
      { type: 'link', url: '/u', title: 'T', children: [t('a')] }, t(' and '),
      { type: 'link', url: '/u', title: 'T', children: [t('r')] }, t(' and '),
      { type: 'image', url: '/i.png', title: null, alt: 'i' },
    )]);
  });

  test('a loose list: every item\'s paragraphs are <p>', () => {
    expect(parse('- a\n- b\n').children[0]).toMatchObject({ spread: false });
    expect(parse('- a\n\n- b\n').children[0]).toMatchObject({ spread: true });
    expect(parse('3. a\n4. b\n').children[0]).toMatchObject({ ordered: true, start: 3 });
  });

  test('no source is an empty document', () => {
    for (const s of [undefined, null, '', '   \n']) expect(parse(s)).toEqual({ type: 'root', children: [] });
  });

  test('kept: the same source and options give the same frozen tree, whatever the options look like', () => {
    const a = parse('# a\n\n*b*');
    expect(parse('# a\n\n*b*')).toBe(a);
    // the options are normalized before the tree is looked up: these policies are all the default
    expect(parse('# a\n\n*b*', {})).toBe(a);
    expect(parse('# a\n\n*b*', { html: 'text', headings: 'keep', images: 'keep' })).toBe(a);
    expect(parse('# a\n\n*b*', { base: '/x' })).toBe(parse('# a\n\n*b*', { base: '/x/' }));
    // another policy or another source is another tree
    expect(parse('# a\n\n*b*', { headings: 'strong' })).not.toBe(a);
    expect(parse('# a\n\n*c*')).not.toBe(a);
    expect(parse(null)).toBe(parse(''));
    // frozen at every depth: a caller cannot change the tree another one reads
    expect(Object.isFrozen(a) && Object.isFrozen(a.children) && Object.isFrozen(a.children[1]) && Object.isFrozen((a.children[1] as { children: object[] }).children[0])).toBe(true);
    expect(() => { (a.children as unknown[]).push(1); }).toThrow(TypeError);
  });

  test('an invalid option throws every time, and keeps nothing', () => {
    expect(() => parse('x', { html: 'raw' as never })).toThrow(TypeError);
    expect(() => parse('x', { html: 'raw' as never })).toThrow(TypeError);
  });

  test('pure: the same source gives an equal tree, and parsing changes nothing it is given', () => {
    const o = { headings: 'strong' as const };
    expect(parse('# a\n\n*b*', o)).toEqual(parse('# a\n\n*b*', o));
    expect(o).toEqual({ headings: 'strong' });
  });
});

describe('headings: slugs and md.headings', () => {
  test('slugs from the text, as GitHub writes them, unique in the document', () => {
    const doc = parse('# Getting started!\n\n## Getting started\n\n## `md.parse` & *you*\n\n## Ünïcode 2\n\n##\n\n> ### Inside a quote');
    expect(headings(doc)).toEqual([
      { depth: 1, id: 'md-getting-started', text: 'Getting started!' },
      { depth: 2, id: 'md-getting-started-1', text: 'Getting started' },
      { depth: 2, id: 'md-mdparse--you', text: 'md.parse & you' },
      { depth: 2, id: 'md-ünïcode-2', text: 'Ünïcode 2' },
      { depth: 2, id: 'md-section', text: '' },
      { depth: 3, id: 'md-inside-a-quote', text: 'Inside a quote' },
    ]);
  });

  test('md.headings of nothing is empty', () => {
    expect(headings(undefined)).toEqual([]);
    expect(headings(null)).toEqual([]);
  });
});

describe('md.text', () => {
  test('inline content runs together, blocks are separated by a blank line', () => {
    const doc = parse('# Title\n\nA *b* `c` ![alt](/x.png)\\\nd\n\n- one\n- two\n\n```\ncode\n```');
    expect(text(doc)).toBe('Title\n\nA b c alt d\n\none\n\ntwo\n\ncode');
    expect(text(doc.children[0]!)).toBe('Title');
    expect(text(null)).toBe('');
  });
  test('a description and a reading time from it', () => {
    const doc = parse('Some *words* here, and more words.');
    expect(text(doc).split(/\s+/).length).toBe(6);
  });
});

describe('options', () => {
  test('headings: \'strong\' turns every heading into a paragraph of strong text', () => {
    const doc = parse('# A\n\n> ## B', { headings: 'strong' });
    expect(doc.children).toEqual([para({ type: 'strong', children: [t('A')] }), { type: 'blockquote', children: [para({ type: 'strong', children: [t('B')] })] }]);
    expect(headings(doc)).toEqual([]);
  });

  test('images: \'link\' turns every image into a link to it, the alt text as its text', () => {
    expect(parse('![a photo](/p.jpg) ![](/q.jpg)', { images: 'link' }).children).toEqual([para(
      { type: 'link', url: '/p.jpg', title: null, children: [t('a photo')] }, t(' '),
      { type: 'link', url: '/q.jpg', title: null, children: [t('/q.jpg')] },
    )]);
  });

  test('base: relative image and link URLs become root paths; absolute URLs, fragments and .md links stay', () => {
    const doc = parse('![d](./diagram.png) ![e](img/e.png) [x](../x.html) [md](./other.md#a) [abs](https://e.com/a) [root](/r) [frag](#h) [q](?a=1) [mail](mailto:a@b.c)', { base: '/content/posts' });
    const urls = (doc.children[0] as { children: Array<{ type: string; url?: string }> }).children.filter((n) => n.url).map((n) => n.url);
    expect(urls).toEqual(['/content/posts/diagram.png', '/content/posts/img/e.png', '/content/x.html', './other.md#a', 'https://e.com/a', '/r', '#h', '?a=1', 'mailto:a@b.c']);
    expect(() => parse('x', { base: 'content/' })).toThrow(/`base` is a folder from the project root/);
    expect(() => parse('x', { base: '//cdn/' })).toThrow(/`base`/);
  });

  test('an unknown option value is an error that lists the values', () => {
    expect(() => parse('x', { html: 'raw' as never })).toThrow("md.parse: `html` is 'drop', 'text', 'allow', not \"raw\"");
    expect(() => parse('x', { headings: 'drop' as never })).toThrow(/`headings` is 'keep', 'strong'/);
  });

  const RAW = 'a <b>bold</b> <kbd>K</kbd> <!-- c -->\n\n<div class="x">block</div>\n\n<script>alert(1)</script>';
  test('html: \'text\' (the default) shows raw HTML as written, as text', () => {
    expect(parse(RAW)).toEqual(parse(RAW, { html: 'text' }));
    expect(parse(RAW).children).toEqual([
      para(t('a <b>bold</b> <kbd>K</kbd> <!-- c -->')),
      para(t('<div class="x">block</div>')),
      para(t('<script>alert(1)</script>')),
    ]);
  });

  test('html: \'drop\' removes it', () => {
    expect(parse(RAW, { html: 'drop' }).children).toEqual([para(t('a bold K '))]);
  });

  test('html: \'allow\' keeps kbd, sub, sup and mark, without their attributes, and the rest as text', () => {
    const doc = parse('<kbd>Ctrl</kbd>+<kbd onclick="x()">C</kbd>, H<sub>2</sub>O, x<sup>*2*</sup>, <mark>hi <b>there</b></mark>, <kbd>open', { html: 'allow' });
    expect(doc.children).toEqual([para(
      { type: 'kbd', children: [t('Ctrl')] }, t('+'), { type: 'kbd', children: [t('C')] }, t(', H'),
      { type: 'sub', children: [t('2')] }, t('O, x'),
      { type: 'sup', children: [{ type: 'emphasis', children: [t('2')] }] }, t(', '),
      { type: 'mark', children: [t('hi <b>there</b>')] },
      // an element left open is shown as written
      t(', <kbd>open'),
    )]);
  });

  test('html: \'allow\' keeps <details> and its <summary>, parsed as markdown, around the blocks between', () => {
    const doc = parse('<details open>\n<summary>More *here*</summary>\n\nHidden **text**.\n\n- a\n\n</details>\n\nAfter.', { html: 'allow' });
    expect(doc.children).toEqual([
      { type: 'details', open: true, summary: [t('More '), { type: 'emphasis', children: [t('here')] }], children: [
        para(t('Hidden '), { type: 'strong', children: [t('text')] }, t('.')),
        { type: 'list', ordered: false, start: null, spread: false, children: [{ type: 'listItem', checked: null, children: [para(t('a'))] }] },
      ] },
      para(t('After.')),
    ]);
    expect(parse('<details>\n\nx\n\n</details>', { html: 'allow' }).children).toEqual([{ type: 'details', open: false, summary: [], children: [para(t('x'))] }]);
    // with no end, the start is shown as written
    expect(parse('<details>\n\nx', { html: 'allow' }).children).toEqual([para(t('<details>')), para(t('x'))]);
  });
});

describe('the modules', () => {
  test('tree.ts, where md.headings and md.text live, does not import the parser', () => {
    const src = readFileSync(join(PKG, 'sinter/tree.ts'), 'utf8');
    expect([...src.matchAll(/^import .* from '([^']+)'/gm)].map((m) => m[1])).toEqual(['./sinter.types.js']);
  });

  test('sinter/parser.js is what scripts/build-parser.mjs writes from the locked dependencies', () => {
    const r = spawnSync(process.execPath, [join(PKG, 'scripts/build-parser.mjs'), '--check'], { encoding: 'utf8' });
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
  });

  test('the parser decodes entities with its table: no DOM, no innerHTML, no debug', () => {
    const src = readFileSync(join(PKG, 'sinter/parser.js'), 'utf8');
    expect(src).not.toMatch(/innerHTML|document\.createElement|createDebug|localStorage|navigator/);
    expect(src).toMatch(/const characterEntities = \{/);
  });
});
