// Step 1's measurements (docs/proposals/component-libraries.md, Plan): headless Chromium, one fresh
// context per run, median of RUNS. Needs both builds and both servers:
//   MEASURE=1 npm run build && MEASURE=1 SINTER_EMBED=1 npm run build   (MEASURE: the parser counts its calls)
//   node server.mjs dist 4390 & node server.mjs dist-embed 4391 &
// (the island page, RealWorld's marked + DOMPurify body, is the comparison point for LCP)
//   node measure.mjs > results/<date>.json
import { chromium } from 'playwright';
import { readFileSync, readdirSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { article, comments, tree } from './data.mjs';

const RUNS = Number(process.env.RUNS ?? 5);
const PLAIN = 'http://127.0.0.1:4390', EMBED = 'http://127.0.0.1:4391';
const med = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? +(s[Math.floor(s.length / 2)]).toFixed(1) : null; };
const out = {};

// ---- sizes
const sizes = (dir) => Object.fromEntries(readdirSync(`${dir}/assets`).filter((f) => f.endsWith('.js')).map((f) => {
  const b = readFileSync(`${dir}/assets/${f}`);
  return [f.replace(/-[\w-]{8}\.js$/, '.js'), { raw: b.length, gzip: gzipSync(b, { level: 6 }).length }];
}));
out.bytes = { plain: sizes('dist'), embed: sizes('dist-embed') };
const md = article(Number(process.env.BLOCKS ?? 300)), t = tree(md);
let nodes = 0; const byType = {};
(function w(n) { nodes++; byType[n.type] = (byType[n.type] ?? 0) + 1; (n.children ?? []).forEach(w); })(t);
out.article = { markdownBytes: md.length, treeJsonBytes: JSON.stringify(t).length, mdastNodes: nodes, byType };
out.comments = { count: comments().length, markdownBytes: comments().reduce((s, c) => s + c.body.length, 0) };
// the parser alone, in Node (warm)
{ const ms = []; for (let i = 0; i < 15; i++) { const t0 = performance.now(); tree(md); ms.push(performance.now() - t0); } out.article.parseNodeMs = med(ms.slice(5)); }

const browser = await chromium.launch();

/** Load `url`, wait until the page is quiet, return what the page saw. */
async function load(url, { block } = {}) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  if (block) await page.route(block, (r) => r.abort());
  await page.addInitScript(() => {
    const w = window; w.__m = { first: 0, last: 0, lcp: 0, fcp: 0, errors: [] };
    new PerformanceObserver((l) => { for (const e of l.getEntries()) w.__m.lcp = e.startTime; }).observe({ type: 'largest-contentful-paint', buffered: true });
    new PerformanceObserver((l) => { for (const e of l.getEntries()) if (e.name === 'first-contentful-paint') w.__m.fcp = e.startTime; }).observe({ type: 'paint', buffered: true });
    new MutationObserver(() => { const n = performance.now(); w.__m.first ||= n; w.__m.last = n; }).observe(document, { subtree: true, childList: true, characterData: true, attributes: true });
    document.addEventListener('securitypolicyviolation', (e) => w.__m.errors.push(e.violatedDirective));
  });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/404|ERR_FAILED/.test(m.text())) errors.push(m.text()); });
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('Performance.enable');
  await page.goto(url, { waitUntil: 'load' });
  // quiet: no mutation for 300 ms
  await page.waitForFunction(() => window.__m.last && performance.now() - window.__m.last > 300, null, { timeout: 30000, polling: 50 });
  const r = await page.evaluate(() => {
    const m = window.__m, main = document.querySelector('main');
    const api = performance.getEntriesByType('resource').find((e) => /\/api\//.test(e.name));
    const count = { elements: 0, templates: 0, defsFilled: 0, defsEmpty: 0, comments: 0, texts: 0, emptyTexts: 0 };
    const walk = document.createTreeWalker(main, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_COMMENT | NodeFilter.SHOW_TEXT);
    for (let n = walk.nextNode(); n; n = walk.nextNode()) {
      if (n.nodeType === 8) count.comments++;
      else if (n.nodeType === 3) { if (n.data.trim()) count.texts++; else count.emptyTexts++; }
      else if (n.localName === 'template') { count.templates++; if (n.hasAttribute('data-sn-def')) n.content.firstChild ? count.defsFilled++ : count.defsEmpty++; }
      else count.elements++;
    }
    // what a template holds is not in the tree walk: a filled definition holds a copy of the component
    let inert = 0;
    for (const t of main.querySelectorAll('template')) inert += t.content.querySelectorAll('*').length;
    count.nodesInsideTemplates = inert;
    // bindings: one per template in place (a for, an if, a candidate's for over \`use\`), plus the
    // element bindings of the md-* components (text, attr, class), by the element that carries them
    const bound = { span: 1, code: 1, a: 1, img: 1, ol: 1, li: 1, input: 1, th: 1, td: 1 };
    let el = 0;
    for (const e of main.querySelectorAll('*')) el += (e.localName === 'code' && e.parentElement?.localName === 'pre' ? 2 : e.localName === 'pre' && e.classList.contains('md-raw') ? 1 : bound[e.localName] ?? 0);
    count.bindings = count.templates + el;
    return { lcp: m.lcp, fcp: m.fcp, firstMutation: m.first, lastMutation: m.last, apiEnd: api ? api.responseEnd : null, md: window.__mdStats ?? [], csp: m.errors, count };
  });
  const metrics = Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map((x) => [x.name, x.value]));
  await cdp.send('HeapProfiler.collectGarbage');
  const heap = (await cdp.send('Runtime.getHeapUsage')).usedSize;
  r.scriptMs = metrics.ScriptDuration * 1000; r.layoutMs = (metrics.LayoutDuration + metrics.RecalcStyleDuration) * 1000; r.heapMB = heap / 1048576;
  r.errors = errors;
  return { r, page, ctx, cdp };
}

async function series(name, url, opts) {
  const runs = [];
  for (let i = 0; i < RUNS; i++) { const { r, ctx } = await load(url, opts); runs.push(r); await ctx.close(); }
  const one = runs.at(-1);
  const parses = (rr) => rr.md.reduce((s, x) => s + x.parses, 0);
  out.pages ??= {};
  out.pages[name] = {
    url,
    lcp: med(runs.map((x) => x.lcp)), fcp: med(runs.map((x) => x.fcp)),
    apiEnd: med(runs.filter((x) => x.apiEnd).map((x) => x.apiEnd)),
    // from the API's response to the last DOM change: JSON, parse, render (with embedded data: from navigation)
    rendered: med(runs.map((x) => x.lastMutation)),
    renderAfterApi: med(runs.filter((x) => x.apiEnd).map((x) => x.lastMutation - x.apiEnd)),
    parseMs: med(runs.map((x) => x.md.reduce((s, y) => s + y.ms, 0))),
    parses: parses(one), parsedBytes: one.md.reduce((s, x) => s + x.bytes, 0), parsesBy: one.md.map((x) => ({ early: x.early, parses: x.parses, ms: +x.ms.toFixed(1) })),
    scriptMs: med(runs.map((x) => x.scriptMs)), styleLayoutMs: med(runs.map((x) => x.layoutMs)), heapMB: med(runs.map((x) => x.heapMB)),
    dom: one.count, errors: [...new Set(runs.flatMap((x) => [...x.errors, ...x.csp]))],
  };
  const x = out.pages[name];
  console.error(name, JSON.stringify({ lcp: x.lcp, rendered: x.rendered, parses: x.parses, parseMs: x.parseMs, errors: x.errors }));
}

await series('article', `${PLAIN}/article/`);
await series('articleEmbedded', `${EMBED}/article/`);
await series('articleEmbeddedEarlyOnly', `${EMBED}/article/`, { block: /\/assets\/article-(?!head-)[^/]*\.js$/ });
await series('tree', `${PLAIN}/tree/`);
await series('islandMarkedDompurify', `${PLAIN}/island/`);
await series('treeEmbedded', `${EMBED}/tree/`);
await series('comments', `${PLAIN}/comments/`);
await series('commentsEmbedded', `${EMBED}/comments/`);

// ---- re-render with the same source (a state the let reads changes) and per streamed chunk
async function clicks(url, sel, n) {
  const { page, ctx } = await load(url);
  const per = [];
  for (let i = 0; i < n; i++) {
    const before = await page.evaluate(() => { const p = document.querySelector('#article p'); if (p) p.__kept = 1; return window.__mdStats.reduce((s, x) => s + x.parses, 0); });
    const ms = await page.evaluate((sel) => new Promise((res) => {
      const t0 = performance.now();
      document.querySelector(sel).click();
      // sinter renders a state change in a microtask or the next frame: wait for the frame after it
      requestAnimationFrame(() => setTimeout(() => res(performance.now() - t0), 0));
    }), sel);
    const after = await page.evaluate(() => ({ p: window.__mdStats.reduce((s, x) => s + x.parses, 0), els: document.querySelectorAll('main *:not(template)').length, kept: !!document.querySelector('#article p')?.__kept }));
    per.push({ ms: +ms.toFixed(1), parses: after.p - before, elements: after.els, firstParagraphKept: after.kept });
  }
  await ctx.close();
  return per;
}
const rr = await clicks(`${PLAIN}/article/`, '#touch', 5);
out.rerender = { medianMs: med(rr.map((x) => x.ms)), parsesPerRender: rr[0].parses, runs: rr };
const st = await clicks(`${PLAIN}/stream/`, '#next', 24);
out.stream = { chunkChars: 2000, perChunk: st, medianMs: med(st.map((x) => x.ms)), lastMs: st.at(-1).ms, parsesPerChunk: st[1].parses };

// ---- a walk over elements and comments at mount, on a page of 20,000 nodes
{
  const ctx = await browser.newContext(); const page = await ctx.newPage();
  await page.goto(`${PLAIN}/tree/`); // any same-origin page; the walk runs on a body built here
  out.walk20k = await page.evaluate(() => {
    document.body.replaceChildren();
    const root = document.createElement('div'); document.body.append(root);
    // 20,000 nodes: 16,000 elements in nested blocks (1 in 10 with data-sn), 4,000 comments
    let made = 0;
    const build = (parent, depth) => {
      for (let i = 0; i < 8 && made < 20000; i++) {
        const e = document.createElement(depth % 2 ? 'span' : 'p'); made++;
        if (made % 10 === 0) e.setAttribute('data-sn', String(made));
        parent.append(e);
        if (made % 5 === 0) { parent.append(document.createComment('sn')); made++; }
        if (depth < 4) build(e, depth + 1);
      }
    };
    while (made < 20000) build(root, 0);
    const time = (fn) => { const ms = []; for (let i = 0; i < 25; i++) { const t0 = performance.now(); fn(); ms.push(performance.now() - t0); } ms.sort((a, b) => a - b); return +ms[12].toFixed(3); };
    let c = 0;
    return {
      nodes: (() => { const w = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_COMMENT); let k = 0; while (w.nextNode()) k++; return k; })(),
      querySelectorAll: time(() => { c = document.querySelectorAll('[data-sn]').length; }),
      treeWalkerElementsAndComments: time(() => { const w = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_COMMENT); c = 0; while (w.nextNode()) c++; }),
      treeWalkerCommentsOnly: time(() => { const w = document.createTreeWalker(root, NodeFilter.SHOW_COMMENT); c = 0; while (w.nextNode()) c++; }),
      walkCheckingData: time(() => { const w = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_COMMENT); c = 0; for (let n = w.nextNode(); n; n = w.nextNode()) if (n.nodeType === 8 ? n.data.startsWith('sn') : n.hasAttribute('data-sn')) c++; }),
    };
  });
  await ctx.close();
}

await browser.close();
console.log(JSON.stringify(out, null, 2));
