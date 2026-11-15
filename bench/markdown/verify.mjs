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
await browser.close();
if (a === b) { console.log(`equal: ${a.length} characters of normalized HTML`); process.exit(0); }
let i = 0; while (a[i] === b[i]) i++;
console.log(`differ at ${i}:\n spike:  …${a.slice(Math.max(0, i - 150), i + 150)}\n to-hast: …${b.slice(Math.max(0, i - 150), i + 150)}`);
process.exit(1);
