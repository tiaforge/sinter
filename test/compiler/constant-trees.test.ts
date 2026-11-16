// Constant trees (docs/proposals/component-libraries.md, section 5, items 5 and 6): a generic tree from a `file:`
// resource, rendered by recursive components dispatched with `<sn-component use>`, is written into the page as
// plain HTML at build time, with its images optimized and its fills in place; a node whose only run-time need is a
// handler over constants and its own `$el` stays an element with that handler, and the rest is plain HTML.
import { describe, expect, test } from 'vitest';
import { compile, type CompileOptions, type ImageHost, type ImageInfo, type ImageVariant } from '../../src/compiler/index.js';
import type { FoldVerdict } from '../../src/fold-check.js';

/** a dispatcher over the children of `of`: text in place, other nodes by their type */
const kids = (of: string) => `<template data-sn-for="n in ${of}.children"><template data-sn-if="n.type === 'text'"><template data-sn-text="n.value"></template></template><template data-sn-else><sn-component use="\`x-\${n.type}\`" data-sn-prop="{ node: n }"></sn-component></template></template>`;
const COMPONENTS: Record<string, string> = {
  'doc-view': `<template data-sn-component="{ doc: any; link: Slot<{ href: string; text: string }> }"><article>${kids('doc')}</article></template>`,
  'x-heading': `<template data-sn-component="{ node: any }"><h2>${kids('node')}</h2></template>`,
  'x-para': `<template data-sn-component="{ node: any }"><p>${kids('node')}</p></template>`,
  'x-list': `<template data-sn-component="{ node: any }"><ul>${kids('node')}</ul></template>`,
  'x-item': `<template data-sn-component="{ node: any }"><li>${kids('node')}</li></template>`,
  'x-link': '<template data-sn-component="{ node: any }"><slot name="link" data-sn-prop="{ href: node.url, text: node.value }"><a data-sn-attr="{ href: node.url }" data-sn-text="node.value"></a></slot></template>',
  'x-image': '<template data-sn-component="{ node: any }"><img data-sn-attr="{ src: node.url, alt: node.alt }"></template>',
  'x-code': '<template data-sn-component="{ node: any }"><pre><code data-sn-text="node.value"></code></pre></template>',
};
const COPY = '<template data-sn-component="{ node: any }"><pre><code data-sn-text="node.value"></code><button type="button" data-sn-on-click="copy($el)">Copy</button></pre></template>';
const t = (value: string) => ({ type: 'text', value });
const DOC = { type: 'doc', children: [
  { type: 'heading', children: [t('Getting started')] },
  { type: 'para', children: [t('Read the '), { type: 'link', url: '/guide/', value: 'guide' }, t(' first.')] },
  { type: 'list', children: [{ type: 'item', children: [{ type: 'para', children: [t('one '), { type: 'link', url: '/a/', value: 'a' }] }] }, { type: 'item', children: [t('two')] }] },
  { type: 'image', url: 'img/photo.jpg', alt: 'A photo' },
  { type: 'code', value: 'npm install' },
] };
const PAGE = (fill = '<a slot="link" class="lnk" data-sn-attr="{ href: $slot.href }" data-sn-text="$slot.text"></a>', extra = '') => `<!doctype html><html><head></head><body><sn-resource name="doc" src="file:./doc.json"></sn-resource>
<doc-view data-sn-prop="{ doc }">${fill}</doc-view>${extra}</body></html>`;
const ARTICLE = '<article><h2>Getting started</h2><p>Read the <a class="lnk" href="/guide/">guide</a> first.</p><ul><li><p>one <a class="lnk" href="/a/">a</a></p></li><li>two</li></ul>';

const photo: ImageInfo = { width: 1600, height: 1067, alpha: false, kind: 'photo', color: '#8a7f6e', bytes: 200_000, hash: 'abc' };
const host: ImageHost = { info: (f) => (f === '/p/img/photo.jpg' ? photo : undefined), url: (v: ImageVariant) => `/i/photo-${v.width}.${v.format}` };

function build(html: string, o: Partial<CompileOptions> & { more?: Record<string, string> } = {}) {
  const { more: components = {}, ...opts } = o;
  const all = { ...COMPONENTS, ...components };
  const files: Record<string, string> = { '/p/doc.json': JSON.stringify(DOC) };
  for (const [k, v] of Object.entries(all)) files[`/p/src/components/${k}.html`] = v;
  return compile(html, {
    file: '/p/index.html', root: '/p', dev: false, prerender: true, componentNames: Object.keys(all),
    helpers: { module: null, names: [], namespaces: {} },
    readFile: (p) => { if (p in files) return files[p]!; throw new Error(`missing ${p}`); }, ...opts,
  });
}
const bodyOf = (html: string) => /<body>([\s\S]*)<\/body>/.exec(html)![1]!;
const errors = (out: ReturnType<typeof build>) => out.diagnostics.filter((d) => d.severity === 'error').map((d) => `${d.code} ${d.message}`);

describe('a constant tree is plain HTML', () => {
  test('from a file, through recursive components and a link fill: no script, no templates, no anchors, no text markers', () => {
    const out = build(PAGE(), { static: true });
    expect(errors(out)).toEqual([]);
    expect(out.static).toBe(true);
    expect(bodyOf(out.html)).toBe(`\n${ARTICLE}<img src="img/photo.jpg" alt="A photo"><pre><code>npm install</code></pre></article>`);
    expect(out.html).not.toMatch(/<template|<script|<!--/);
  });

  test('its local image is optimized like one written in the page', () => {
    const out = build(PAGE(), { static: true, images: host });
    expect(errors(out)).toEqual([]);
    expect(out.static).toBe(true);
    expect(bodyOf(out.html)).toContain('<picture><source type="image/avif" srcset="/i/photo-480.avif 480w');
    expect(bodyOf(out.html)).toContain('alt="A photo" srcset="/i/photo-480.jpeg 480w');
    expect(out.html).not.toMatch(/<template|<script|<!--/);
  });

  test('a copy button on the code block: the page ships only its handler, the tree around it is plain HTML', () => {
    const out = build(PAGE(), { more: { 'x-code': COPY }, helpers: { module: '/h.js', names: ['copy'], namespaces: {} } });
    expect(errors(out)).toEqual([]);
    expect(bodyOf(out.html)).toMatch(new RegExp(`^\\n${ARTICLE.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}<img src="img/photo.jpg" alt="A photo"><pre><code>npm install</code><button type="button" data-sn="\\d+">Copy</button></pre></article>$`));
    const ir = JSON.parse(/const ir = (\{.*\});/.exec(out.module)![1]!);
    expect(ir.templates).toEqual([]);
    expect(ir.roots).toEqual([{ tag: 'button', b: [{ k: 'on', f: expect.any(Number), n: 'click' }], id: expect.any(Number) }]);
    expect(out.module).toMatch(/\(\$\) => \{\s*copy\(\$\.\$el\)\s*\}/);
    expect(out.html).not.toMatch(/<template|<!--/);
  });

  test('a helper over the tree folds into it (step 8): the text is the helper\'s result', () => {
    const upper: FoldVerdict = { fold: true };
    const para = `<template data-sn-component="{ node: any }"><p><template data-sn-for="n in node.children"><template data-sn-if="n.type === 'text'"><template data-sn-text="shout(n.value)"></template></template><template data-sn-else><sn-component use="\`x-\${n.type}\`" data-sn-prop="{ node: n }"></sn-component></template></template></p></template>`;
    const out = build(PAGE(), { static: true, more: { 'x-para': para }, helpers: { module: '/h.js', names: ['shout'], namespaces: {} }, helperValues: { shout: (s: string) => s.toUpperCase() }, helperFold: new Map([['shout', upper]]) });
    expect(errors(out)).toEqual([]);
    expect(out.static).toBe(true);
    expect(bodyOf(out.html)).toContain('<p>READ THE <a class="lnk" href="/guide/">guide</a> FIRST.</p>');
  });
});

describe('what stays the runtime\'s', () => {
  test('a node with state of its own keeps the tree for the runtime, which reads the file\'s value from the head', () => {
    const code = '<template data-sn-component="{ node: any }"><pre data-sn-state="{ copied: false }"><code data-sn-text="node.value"></code><button type="button" data-sn-on-click="copied = true" data-sn-text="copied ? \'Copied\' : \'Copy\'"></button></pre></template>';
    const out = build(PAGE(), { more: { 'x-code': code } });
    expect(errors(out)).toEqual([]);
    expect(out.module).toContain('$.$r.doc');
    // the value, written once into the head for what reads it in the browser
    expect(out.html).toMatch(/<script type="application\/json"[^>]*>\{"type":"doc"/);
    expect(out.html).toContain('<template');
  });

  test('a tree over the expansion limit: rendered in the browser, with SN536 at the use that crosses it', () => {
    const out = build(PAGE(), { expansionLimit: 10 });
    expect(out.diagnostics.map((d) => [d.code, d.severity])).toEqual([['SN536', 'warning']]);
    expect(out.html).toContain('<template');
    expect(out.module).toContain('$.$r.doc');
  });
});
