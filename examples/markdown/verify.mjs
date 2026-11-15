// Correctness: the spike's rendered article against mdast-util-to-hast's HTML for the same tree,
// both normalized (no templates, comments or sinter attributes; md-text's <span>s unwrapped; raw
// HTML, which the spike shows as text and to-hast drops, left out of both). Needs `node server.mjs dist 4390`.
import { chromium } from 'playwright';
import { toHast } from 'mdast-util-to-hast';
import { toHtml } from 'hast-util-to-html';
import { article, tree } from './data.mjs';

const ref = toHtml(toHast(tree(article())));
const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto(`http://127.0.0.1:4390/${process.argv[2] ?? 'article'}/`);
await page.waitForFunction(() => document.querySelectorAll('#article p').length > 50);
await page.waitForTimeout(500);
const spike = await page.evaluate(() => document.querySelector('#article').innerHTML);
// normalized in a blank page: the spike's page enforces Trusted Types, which DOMParser falls under
const blank = await browser.newPage();
const norm = (html) => blank.evaluate((html) => {
  const root = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html').body;
  root.querySelectorAll('template, .md-raw').forEach((n) => n.remove());
  const w = document.createTreeWalker(root, NodeFilter.SHOW_COMMENT); const cs = []; while (w.nextNode()) cs.push(w.currentNode); cs.forEach((c) => c.remove());
  root.querySelectorAll('span:not([class])').forEach((s) => s.replaceWith(...s.childNodes));
  root.querySelectorAll('*').forEach((e) => {
    const keep = [...e.attributes].filter((a) => !/^(data-sn|class$|id$)/.test(a.name)).map((a) => [a.name, a.value]).sort();
    for (const a of [...e.attributes]) e.removeAttribute(a.name);
    for (const [k, v] of keep) e.setAttribute(k, v);
  });
  root.normalize();
  // to-hast writes a space after a task's checkbox and a line break after <br>; the spike does not
  return root.innerHTML.replace(/>\s+</g, '><').replace(/\s+/g, ' ').replace(/(<br>|<input[^>]*>) /g, '$1').trim();
}, html);
const a = await norm(spike), b = await norm(ref);

// prose CSS: what common selectors match in the spike's DOM (template and comment anchors in place)
// against the same markup without them (to-hast's HTML)
const SELECTORS = ['li:first-child', 'li:last-child', 'li:nth-child(odd)', 'tr:nth-child(even)', 'h2 + p', 'p + p', '.md > * + *', '.md > :first-child', 'ul:empty', ':is(p, li) > :first-child'];
const selectorsIn = (target) => target.evaluate((sel) => {
  const root = document.querySelector('#article');
  return Object.fromEntries(sel.map((x) => [x, [...root.querySelectorAll(x)].filter((e) => e.localName !== 'template').length]));
}, SELECTORS);
await blank.evaluate((html) => {
  const meta = document.createElement('div'); meta.id = 'article'; meta.className = 'md';
  meta.append(...new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html').body.childNodes);
  document.body.replaceChildren(meta);
}, ref);
const selectors = { spike: await selectorsIn(page), reference: await selectorsIn(blank) };
// the DOM shape: elements by tag, and text nodes that are only whitespace, in both
const shapeIn = (target) => target.evaluate(() => {
  const root = document.querySelector('#article'), tags = {};
  for (const e of root.querySelectorAll('*')) if (e.localName !== 'template') tags[e.localName] = (tags[e.localName] ?? 0) + 1;
  const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT); let ws = 0, text = 0;
  while (w.nextNode()) { if (w.currentNode.data.trim()) text++; else ws++; }
  return { tags, textNodes: text, whitespaceTextNodes: ws };
});
const shape = { spike: await shapeIn(page), reference: await shapeIn(blank) };
await browser.close();
const diff = Object.fromEntries([...new Set([...Object.keys(shape.spike.tags), ...Object.keys(shape.reference.tags)])]
  .map((t) => [t, (shape.spike.tags[t] ?? 0) - (shape.reference.tags[t] ?? 0)]).filter(([, d]) => d));
console.log(JSON.stringify({ selectors, extraElementsByTag: diff, text: { spike: [shape.spike.textNodes, shape.spike.whitespaceTextNodes], reference: [shape.reference.textNodes, shape.reference.whitespaceTextNodes] } }, null, 1));
if (a === b) { console.log(`equal: ${a.length} characters of normalized HTML`); process.exit(0); }
let i = 0; while (a[i] === b[i]) i++;
console.log(`differ at ${i}:\n spike:  …${a.slice(Math.max(0, i - 150), i + 150)}\n to-hast: …${b.slice(Math.max(0, i - 150), i + 150)}`);
process.exit(1);
