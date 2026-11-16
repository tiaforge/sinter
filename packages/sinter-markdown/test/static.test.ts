// A page whose markdown is a file in the repo: md.parse runs at build time over the `file:` resource,
// the tree is expanded into plain HTML, and the page ships no JavaScript (proposal, sections 7, 9 and 11).
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { build } from 'vite';
import { JSDOM } from 'jsdom';
import { afterAll, beforeAll, expect, test } from 'vitest';
import sinter from '@tiaforge-ui/sinter/vite';
import { app, page, PKG } from './app.js';

const PAGE = page(`<sn-resource name="post" src="file:./post.md"></sn-resource>
<main data-sn-let="{ doc: md.parse(post.body, { base: '/' }) }">
  <nav><template data-sn-for="h in md.headings(doc)"><a data-sn-attr="{ href: '#' + h.id }" data-sn-text="h.text"></a></template></nav>
  <p class="summary" data-sn-text="md.text(doc).slice(0, 40)"></p>
  <md-doc id="article" data-sn-prop="{ doc }"></md-doc>
</main>`);
// The fixture article, every node type, without its nested list (see the last test)
const ARTICLE = readFileSync(join(PKG, 'fixtures/article.md'), 'utf8');
const FLAT = ARTICLE.replace('  - nested\n', '');
// raw HTML under html: 'allow'
const ALLOW = page(`<sn-resource name="post" src="file:./post.md"></sn-resource>
<main data-sn-let="{ doc: md.parse(post.body, { html: 'allow' }) }"><md-doc id="article" data-sn-prop="{ doc }"></md-doc></main>`);
const HTML = `Press <kbd>Ctrl</kbd>+<kbd>C</kbd>: H<sub>2</sub>O, x<sup>2</sup>, <mark>marked</mark>, <b>not kept</b>.

<details open>
<summary>More *here*</summary>

Hidden **text**.

</details>
`;
// one line inside a paragraph, a heading and a label: md-inline's root is a <span> with phrasing content
const INLINE = page(`<sn-resource name="post" src="file:./post.md"></sn-resource>
<main data-sn-let="{ line: md.parse(post.body) }">
  <p id="in-p">Title: <md-inline data-sn-prop="{ doc: line }"></md-inline>, and after.</p>
  <h2 id="in-h"><md-inline data-sn-prop="{ doc: line }"></md-inline></h2>
  <label id="in-label"><input type="checkbox"> <md-inline data-sn-prop="{ doc: line }"></md-inline></label>
  <p id="after-list"><md-inline data-sn-prop="{ doc: md.parse('- a list, left out\\n\\nthen a paragraph\\n\\n- another\\n\\n## and a heading') }"></md-inline></p>
</main>`);
// the fills of docs/markdown.md: a link and a heading chain that place their children, a table's wrapper, a code block
const FILLS = page(`<sn-resource name="post" src="file:./post.md"></sn-resource>
<main data-sn-let="{ doc: md.parse(post.body, { base: '/' }) }"><md-doc id="article" data-sn-prop="{ doc }">
  <a slot="link" rel="nofollow ugc" data-sn-attr="{ href: $slot.node.url }"><slot></slot></a>
  <template slot="heading" data-sn-if="$slot.node.depth === 1"><h1 data-sn-attr="{ id: 'md-' + $slot.node.slug }"><slot></slot></h1></template>
  <template data-sn-else><h2 data-sn-attr="{ id: 'md-' + $slot.node.slug }"><slot></slot> <a data-sn-attr="{ href: '#md-' + $slot.node.slug }">#</a></h2></template>
  <div slot="table" class="scroll"><slot></slot></div>
  <figure slot="code"><pre><code data-sn-text="$slot.node.value"></code></pre><figcaption data-sn-text="$slot.node.lang"></figcaption></figure>
</md-doc></main>`);
const LINE = 'A *title* with `code` and a [link](/x)\n\nand a second paragraph\n\n- a list, left out\n';
const diagram = readFileSync(join(PKG, 'fixtures/diagram.png'));
const apps = {
  flat: app({ 'post.md': FLAT, 'index.html': PAGE, 'diagram.png': diagram }),
  allow: app({ 'post.md': HTML, 'index.html': ALLOW }),
  article: app({ 'post.md': ARTICLE, 'index.html': PAGE, 'diagram.png': diagram }),
  inline: app({ 'post.md': LINE, 'index.html': INLINE }),
  fills: app({ 'post.md': ARTICLE, 'index.html': FILLS, 'diagram.png': diagram }),
};
const out: Record<string, { html: string; js: string[]; error: string | null }> = {};
beforeAll(async () => {
  for (const [name, a] of Object.entries(apps)) {
    let error: string | null = null;
    try {
      await build({ root: a.root, logLevel: 'silent', plugins: [sinter({ components: ['@tiaforge-ui/sinter-markdown'], static: ['index.html'] })], build: { outDir: join(a.root, 'dist'), emptyOutDir: true } });
    } catch (e) { error = (e as Error).message; }
    const dist = join(a.root, 'dist');
    out[name] = {
      html: existsSync(join(dist, 'index.html')) ? readFileSync(join(dist, 'index.html'), 'utf8') : '',
      js: existsSync(join(dist, 'assets')) ? readdirSync(join(dist, 'assets')).filter((f) => f.endsWith('.js')) : [],
      error,
    };
  }
});
afterAll(() => { for (const a of Object.values(apps)) a.remove(); });

const body = (name: keyof typeof apps) => /<div class="md" id="article">([\s\S]*?)<\/div>\s*<\/main>/.exec(out[name]!.html)?.[1] ?? '';
const noScript = (html: string) => html.replace(/<script type="speculationrules">[^<]*<\/script>/, '');

test('a static page: md.parse, md.headings and md.text fold, and the page ships no JavaScript', () => {
  for (const name of ['flat', 'allow'] as const) {
    const { html, js, error } = out[name]!;
    expect(error, name).toBe(null);
    expect(js, name).toEqual([]);
    // no script but the speculation rules sinter writes for prefetching internal links; no anchor, no template
    expect(noScript(html), name).not.toMatch(/<script|<template|<!--/);
  }
  expect(out.flat!.html).toContain('<nav><a href="#md-writing-with-sinter-markdown">Writing with sinter-markdown</a><a href="#md-lists">Lists</a><a href="#md-code">Code</a><a href="#md-a-heading-inside-it">A heading inside it</a><a href="#md-lists-1">Lists</a></nav>');
  expect(out.flat!.html).toContain('<p class="summary">Writing with sinter-markdown\n\nA paragrap</p>');
});

test('every node type is the HTML a markdown renderer writes, with no wrapper but the table\'s', () => {
  const b = body('flat');
  const parts = [
    '<h1 id="md-writing-with-sinter-markdown">Writing with sinter-markdown</h1>',
    '<p>A paragraph with <em>emphasis</em>, <strong>strong text</strong>, <del>strikethrough</del>, <code>inline code</code> and a <a href="https://example.com" title="Example">link</a>.\nA hard break follows<br>and an autolink: <a href="http://www.example.com">www.example.com</a>. Entities decode: Fish &amp; chips ©.</p>',
    // a tight list, its items without <p>; a link to another markdown file as written
    '<h2 id="md-lists">Lists</h2><ul><li>one</li><li>two, with a <a href="./other.md">reference link</a></li></ul>',
    // a loose list
    '<ol><li><p>first</p></li><li><p>second</p></li><li><p>third, after a blank line: the list is loose</p></li></ol>',
    '<ul><li class="task-list-item"><input type="checkbox" disabled="" checked="">a task that is done</li><li class="task-list-item"><input type="checkbox" disabled="">a task that is not</li></ul>',
    '<h2 id="md-code">Code</h2><pre><code class="language-js">console.log(\'hello\');</code></pre>',
    '<blockquote><p>A quote, with a paragraph.</p><h3 id="md-a-heading-inside-it">A heading inside it</h3></blockquote>',
    '<h2 id="md-lists-1">Lists</h2>',
    '<div class="md-table"><table><thead><tr><th align="left">Name</th><th align="right">Count</th></tr></thead><tbody><tr><td align="left">apples</td><td align="right">3</td></tr><tr><td align="left">pears</td><td align="right"><code>12</code></td></tr></tbody></table></div><hr>',
    // raw HTML, shown as written
    '<p>&lt;kbd&gt;Ctrl&lt;/kbd&gt; and &lt;script&gt;alert(1)&lt;/script&gt; are shown as written by default.</p>',
  ];
  let at = 0;
  for (const part of parts) {
    const i = b.indexOf(part, at);
    expect(i, part).toBeGreaterThanOrEqual(0);
    at = i + part.length;
  }
});

test('a local image from the repo, under `base`, is optimized as any image in a page', () => {
  const html = out.flat!.html;
  expect(html).toMatch(/<picture><source type="image\/webp" srcset="\/assets\/diagram-480-[^"]+ 480w, [^"]+"/);
  expect(html).toMatch(/<img src="\/assets\/diagram-1200-[^"]+\.png" alt="A diagram" title="The diagram" srcset="[^"]+" sizes="100vw" width="1200" height="600" decoding="async" ?>/);
});

test('html: \'allow\': kbd, sub, sup, mark and details with its summary, each by its own component', () => {
  expect(body('allow')).toBe('<p>Press <kbd>Ctrl</kbd>+<kbd>C</kbd>: H<sub>2</sub>O, x<sup>2</sup>, <mark>marked</mark>, &lt;b&gt;not kept&lt;/b&gt;.</p><details open=""><summary>More <em>here</em></summary><p>Hidden <strong>text</strong>.</p></details>');
});

test('the full article, its nested list included, is a static page', () => {
  expect(out.article!.error).toBe(null);
  expect(out.article!.js).toEqual([]);
  expect(noScript(out.article!.html)).not.toMatch(/<script|<template|<!--/);
  expect(out.article!.html).toContain('<li>two, with a <a href="./other.md">reference link</a><ul><li>nested</li></ul></li>');
});

test('the fills of the docs, which place their children, are expanded with the tree: a static page', () => {
  const { html, js, error } = out.fills!;
  expect(error).toBe(null);
  expect(js).toEqual([]);
  expect(noScript(html)).not.toMatch(/<script|<template|<!--/);
  expect(html).toContain('<h1 id="md-writing-with-sinter-markdown">Writing with sinter-markdown</h1>');
  expect(html).toMatch(/<h2 id="md-lists">Lists <a href="#md-lists">#<\/a><\/h2>/);
  expect(html).toMatch(/<a rel="nofollow ugc" href="\.\/other\.md">reference link<\/a>/);
  expect(html).toMatch(/<div class="scroll"><table>/);
  expect(html).toMatch(/<figure><pre><code>/);
});

test('md-inline is phrasing content: inside a <p>, a heading or a label, the page parses as written', () => {
  const { html, js, error } = out.inline!;
  expect(error).toBe(null);
  expect(js).toEqual([]);
  const line = '<span class="md">A <em>title</em> with <code>code</code> and a <a href="/x">link</a> and a second paragraph</span>';
  // as a browser parses the built page: the paragraph keeps its content (a <div> would have closed it)
  const doc = new JSDOM(html).window.document;
  expect(doc.querySelector('#in-p')!.innerHTML).toBe(`Title: ${line}, and after.`);
  expect(doc.querySelector('#in-h')!.innerHTML).toBe(line);
  expect(doc.querySelector('#in-label')!.innerHTML).toBe(`<input type="checkbox"> ${line}`);
  // a space only between two rendered blocks: none before the first, whatever was left out
  expect(doc.querySelector('#after-list')!.innerHTML).toBe('<span class="md">then a paragraph and a heading</span>');
  expect(doc.querySelectorAll('main > *').length).toBe(4);
});
