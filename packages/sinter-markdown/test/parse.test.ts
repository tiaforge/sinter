// md.parse and its options (proposal, section 10), and the helpers that read a tree. These are plain
// functions: tested in Node, with no sinter involved.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, test } from 'vitest';
import { characterEntities } from 'character-entities';
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

  // scripts/autolink.js: GFM's autolink literals (the spec's examples), and what GFM leaves as text
  test('GFM autolinks: www., http(s)://, ftp:// and emails, as github.com links them', () => {
    const links = (s: string) => {
      const out: Array<[string, string]> = [];
      const walk = (n: any) => { if (n.type === 'link') out.push([n.url, text(n.children)]); n.children?.forEach(walk); };
      walk(parse(s));
      return out;
    };
    expect(links('www.commonmark.org/help, and (www.google.com/search?q=Markup+(business))')).toEqual([
      ['http://www.commonmark.org/help', 'www.commonmark.org/help'],
      ['http://www.google.com/search?q=Markup+(business)', 'www.google.com/search?q=Markup+(business)'],
    ]);
    expect(links('www.google.com/search?q=(business))+ok')).toEqual([['http://www.google.com/search?q=(business))+ok', 'www.google.com/search?q=(business))+ok']]);
    expect(links('www.google.com/search?q=commonmark&hl;')).toEqual([['http://www.google.com/search?q=commonmark', 'www.google.com/search?q=commonmark']]);
    expect(links('www.commonmark.org/he<lp')).toEqual([['http://www.commonmark.org/he', 'www.commonmark.org/he']]);
    expect(links('(Visit https://encrypted.google.com/search?q=Markup+(business)) or ftp://foo.bar.baz.')).toEqual([
      ['https://encrypted.google.com/search?q=Markup+(business)', 'https://encrypted.google.com/search?q=Markup+(business)'],
      ['ftp://foo.bar.baz', 'ftp://foo.bar.baz'],
    ]);
    expect(links('"http://google.com" ~~http://x.org~~ **http://inlines**')).toEqual([['http://google.com', 'http://google.com'], ['http://x.org', 'http://x.org'], ['http://inlines', 'http://inlines']]);
    expect(links('foo@bar.baz, hello+xyz@mail.example. a.b-c_d@a.b- mailto:x@y.zz xmpp:x@y.zz/home.')).toEqual([
      ['mailto:foo@bar.baz', 'foo@bar.baz'], ['mailto:hello+xyz@mail.example', 'hello+xyz@mail.example'],
      ['mailto:x@y.zz', 'mailto:x@y.zz'], ['xmpp:x@y.zz/home', 'xmpp:x@y.zz/home'],
    ]);
    // the last two segments of a domain have no underscore; www. needs a domain; a bare domain is text
    expect(links('www.xxx._yyy.zzz www._xxx.yyy.zzz www. www.x example.com config.md ASP.NET')).toEqual([['http://www._xxx.yyy.zzz', 'www._xxx.yyy.zzz']]);
    // a link's text, code and raw HTML are not searched
    expect(links('[see www.a.com](/u) `www.b.com` <a href="/v">www.c.com</a>')).toEqual([['/u', 'see www.a.com']]);
    // only these schemes come out
    expect(links('javascript:alert(1)//x.com data:text/html,www.a.com')).toEqual([]);
  });

  test('autolinks stay linear: long runs a scan could revisit parse in well under a second', () => {
    const hostile = [
      'a.'.repeat(1e5), 'a.'.repeat(1e5) + '@', 'a@'.repeat(5e4), '_'.repeat(1e5) + '@a.b', 'www.' + 'a.'.repeat(1e5),
      'x '.repeat(5e4) + 'www.a.b' + ')'.repeat(5e4), 'http://' + '('.repeat(1e5) + ')'.repeat(1e5),
      'www.a.b/' + '&a;'.repeat(3e4), 'www.a.b/' + '?'.repeat(1e5), 'www.a.b '.repeat(3e4), 'x@a.b '.repeat(3e4),
    ];
    for (const s of hostile) {
      const start = performance.now();
      parse(s);
      expect(performance.now() - start, JSON.stringify(s.slice(0, 12))).toBeLessThan(1000);
    }
  });

  // where markdown-it's tokens differ from mdast, parser-entry.js gives mdast's answer
  test('mdast from markdown-it: a fence info string decoded, an image alt as text, looseness by the items own paragraphs', () => {
    expect(parse('``` f&ouml;\\+o bar\nx\n```').children[0]).toEqual({ type: 'code', lang: 'fö+o', meta: 'bar', value: 'x' });
    expect(parse('![foo *bar* [baz](/u)](/i.png)', { images: 'keep' }).children[0]).toEqual(para({ type: 'image', url: '/i.png', title: null, alt: 'foo bar baz' }));
    // a paragraph inside a quote in an item does not make the list loose
    expect(parse('- a\n  > b\n- c').children[0]).toMatchObject({ type: 'list', spread: false });
    expect(parse('- a\n\n- c').children[0]).toMatchObject({ type: 'list', spread: true });
    // a task item's marker leaves its text; with nothing after it, or another letter in it, it is not a task
    expect(parse('- [x] a\n- [ ] \n- [y] b').children[0]).toMatchObject({ children: [
      { checked: true, children: [para(t('a'))] }, { checked: null }, { checked: null, children: [para(t('[y] b'))] },
    ] });
  });

  test('entities are decoded by the table, never by the DOM', () => {
    expect(parse('Fish &amp; chips &copy; &#x41; &unknown;')).toEqual({ type: 'root', children: [para(t('Fish & chips © A &unknown;'))] });
    // the packed table has every entry of character-entities: two code points, astral ones, names that differ by case
    expect(parse('&ThickSpace;&nvlt;&Afr;&fjlig;&AMP;&amp;').children).toEqual([para(t('\u205F\u200A<\u20D2\u{1D504}fj&&'))]);
    const wrong = Object.entries(characterEntities).filter(([name, value]) => text(parse(`x&${name};x`)) !== `x${value}x`);
    expect(wrong).toEqual([]);
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

  test('the parser decodes entities with its packed table: no DOM, no innerHTML, no debug', () => {
    const src = readFileSync(join(PKG, 'sinter/parser.js'), 'utf8');
    expect(src).not.toMatch(/innerHTML|document\.createElement|createDebug|localStorage|navigator/);
    expect(src).toMatch(/var _packed_entities_default = "9:Tab;:NewLine;n:excl;:QUOT,quot;/);
    expect(src).not.toMatch(/decode_data_html|Uint16Array|const characterEntities = \{/);
  });

  test('the parser leaves out what md.parse never runs: markdown-it\'s class and presets, linkify-it, the renderer, the typographer, mdurl, punycode', () => {
    const src = readFileSync(join(PKG, 'sinter/parser.js'), 'utf8');
    const modules = [...src.matchAll(/^\/\/ (node_modules\/\S+)$/gm)].map((m) => m[1]);
    expect(modules.length).toBeGreaterThan(40);
    expect(modules.filter((m) => !m.startsWith('node_modules/markdown-it/lib/'))).toEqual([]);
    expect(modules.filter((m) => /renderer|linkify|smartquotes|replacements|presets\/|\/lib\/index\.mjs$/.test(m))).toEqual([]);
  });
});
