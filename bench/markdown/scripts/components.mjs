// Writes src/components/md-*.html: one component per mdast node type, dispatched with
// <sn-component use> over two maps (block content, phrasing content). Run: node scripts/components.mjs
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';

const dir = new URL('../src/components/', import.meta.url);
rmSync(dir, { recursive: true, force: true });
mkdirSync(dir, { recursive: true });

const BLOCK = { paragraph: 'md-p', h1: 'md-h1', h2: 'md-h2', h3: 'md-h3', h4: 'md-h4', h5: 'md-h5', h6: 'md-h6',
  ul: 'md-ul', ol: 'md-ol', blockquote: 'md-blockquote', code: 'md-code', thematicBreak: 'md-hr', html: 'md-html', table: 'md-table' };
const INLINE = { text: 'md-text', emphasis: 'md-em', strong: 'md-strong', delete: 'md-del', inlineCode: 'md-inline-code',
  break: 'md-br', link: 'md-a', image: 'md-img', html: 'md-html-inline' };
const map = (m) => `{ ${Object.entries(m).map(([k, v]) => `${k}: '${v}'`).join(', ')} }`;
const blockKey = (n) => `md.kind(${n})`;

const blocks = (list = 'node.children', v = 'n') => `<template data-sn-for="${v} in ${list}"><sn-component use="${map(BLOCK)}[${blockKey(v)}]" data-sn-prop="{ node: ${v} }"></sn-component></template>`;
const inlines = (list = 'node.children', v = 'n') => `<template data-sn-for="${v} in ${list}"><sn-component use="${map(INLINE)}[${v}.type]" data-sn-prop="{ node: ${v} }"></sn-component></template>`;

const files = {
  // public: block content of a tree
  'md-doc': `<div class="md">${blocks('doc ? doc.children : []')}</div>`,
  'md-p': `<p>${inlines()}</p>`,
  ...Object.fromEntries([1, 2, 3, 4, 5, 6].map((d) => [`md-h${d}`, `<h${d}>${inlines()}</h${d}>`])),
  'md-ul': `<ul>${li()}</ul>`,
  'md-ol': `<ol data-sn-attr="{ start: node.start == null || node.start == 1 ? null : node.start }">${li()}</ol>`,
  'md-blockquote': `<blockquote>${blocks()}</blockquote>`,
  'md-code': `<pre><code data-sn-attr="{ class: node.lang ? 'language-' + node.lang : null }" data-sn-text="node.value"></code></pre>`,
  'md-hr': `<hr>`,
  // raw HTML is never markup: shown as written
  'md-html': `<pre class="md-raw" data-sn-text="node.value"></pre>`,
  'md-table': `<table><thead><template data-sn-for="r in node.children.slice(0, 1)"><tr>${cells('th')}</tr></template></thead>`
    + `<tbody><template data-sn-for="r in node.children.slice(1)"><tr>${cells('td')}</tr></template></tbody></table>`,
  // phrasing content: every run of text needs an element of its own today
  'md-text': `<span data-sn-text="node.value"></span>`,
  'md-em': `<em>${inlines()}</em>`,
  'md-strong': `<strong>${inlines()}</strong>`,
  'md-del': `<del>${inlines()}</del>`,
  'md-inline-code': `<code data-sn-text="node.value"></code>`,
  'md-br': `<br>`,
  'md-a': `<a data-sn-attr="{ href: node.url, title: node.title }">${inlines()}</a>`,
  'md-img': `<img data-sn-attr="{ src: node.url, alt: node.alt, title: node.title }">`,
  'md-html-inline': `<span class="md-raw" data-sn-text="node.value"></span>`,
};

function li() {
  // a tight list's paragraphs render without <p>, as CommonMark's HTML does
  return `<template data-sn-for="i in node.children"><li data-sn-class="{ task: i.checked != null }">`
    + `<template data-sn-if="i.checked != null"><input type="checkbox" disabled data-sn-attr="{ checked: i.checked }"></template>`
    + `<template data-sn-for="n in i.children">`
    + `<template data-sn-if="!node.spread && n.type == 'paragraph'">${inlines('n.children', 'm')}</template>`
    + `<template data-sn-else><sn-component use="${map(BLOCK)}[${blockKey('n')}]" data-sn-prop="{ node: n }"></sn-component></template>`
    + `</template></li></template>`;
}
function cells(tag) {
  return `<template data-sn-for="(c, k) in r.children"><${tag} data-sn-attr="{ align: node.align && node.align[k] }">${inlines('c.children', 'm')}</${tag}></template>`;
}

for (const [name, body] of Object.entries(files)) {
  const props = name === 'md-doc' ? '{ doc?: any }' : '{ node: any }';
  writeFileSync(new URL(`${name}.html`, dir), `<template data-sn-component="${props}">\n  ${body}\n</template>\n`);
}
console.log(Object.keys(files).length, 'components');
