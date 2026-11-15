// Where the bytes go in RealWorld's pages, as a browser receives them (docs/proposals/component-libraries.md, step 2):
// (a) the bytes before the first stylesheet, the first preload or modulepreload and the first script with a `src` are
// discovered; (b) the bytes before the LCP element's start tag; (c) the whole page, gzip. Per build directory, plain
// or embedded (serve.mjs fills the data slots), each page loaded once in Chromium against the mock API (api.mjs).
//   node api.mjs &   node byte-points.mjs <label>=<dist>[:embed] …
import { spawn } from 'node:child_process';
import { gzipSync } from 'node:zlib';
import { chromium } from 'playwright';

const PAGES = [['index', '/'], ['article', '/article/article-3'], ['profile', '/profile/author1'], ['login', '/login'], ['register', '/register'], ['editor', '/editor'], ['settings', '/settings']];
const builds = process.argv.slice(2).map((a, i) => { const [label, rest] = a.split('='); const [dir, mode] = rest.split(':'); return { label, dir, mode, port: 4510 + i }; });
const servers = builds.map((b) => spawn(process.execPath, [new URL('./serve.mjs', import.meta.url).pathname, b.dir, String(b.port), ...(b.mode ? [b.mode] : [])], { stdio: 'ignore' }));
await new Promise((r) => setTimeout(r, 800));
const browser = await chromium.launch();
const out = [];
try {
  for (const b of builds) for (const [page, path] of PAGES) {
    const url = `http://127.0.0.1:${b.port}${path}`;
    const html = await (await fetch(url)).text();
    const first = (re) => { const m = re.exec(html); return m ? m.index : null; };
    const ctx = await browser.newContext();
    // the build's API is RealWorld's public one: here, the mock
    await ctx.route('https://api.realworld.show/**', async (r) => {
      const u = new URL(r.request().url());
      const res = await fetch(`http://localhost:4400${u.pathname.replace(/^\/api/, '/api')}${u.search}`);
      r.fulfill({ status: res.status, contentType: 'application/json', body: await res.text() });
    });
    await ctx.route(/code\.ionicframework\.com|fonts\.(googleapis|gstatic)\.com/, (r) => r.fulfill({ status: 200, contentType: 'text/css', body: '' }));
    const tab = await ctx.newPage();
    await tab.addInitScript(() => {
      window.__lcp = null;
      new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__lcp = e.element; }).observe({ type: 'largest-contentful-paint', buffered: true });
    });
    await tab.goto(url, { waitUntil: 'networkidle' });
    await tab.waitForTimeout(300);
    // the LCP element's start tag in the HTML as sent: its tag and first class (or id); an element the runtime made
    // from nothing in the HTML (innerHTML of an island) counts at its nearest ancestor that is there
    const sigs = await tab.evaluate(() => {
      const out = [];
      for (let e = window.__lcp; e && e !== document.documentElement; e = e.parentElement) {
        const cls = e.classList[0], id = e.id;
        out.push({ tag: e.localName, cls: cls ?? null, id: id || null, text: e.textContent.trim().slice(0, 40) });
      }
      return out;
    });
    let lcpAt = null, lcp = null;
    for (const s of sigs) {
      const re = s.id ? new RegExp(`<${s.tag}\\b[^>]*\\bid="${s.id}"`) : s.cls ? new RegExp(`<${s.tag}\\b[^>]*\\bclass="(?:[^"]*\\s)?${s.cls.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s"]`) : null;
      const at = re ? first(re) : null;
      if (at != null) { lcpAt = at; lcp = `${s.tag}${s.id ? '#' + s.id : s.cls ? '.' + s.cls : ''}${s === sigs[0] ? '' : ` (around ${sigs[0].tag}${sigs[0].cls ? '.' + sigs[0].cls : ''})`}`; break; }
    }
    out.push({
      build: b.label, page, bytes: html.length, gzip: gzipSync(html, { level: 6 }).length,
      stylesheet: first(/<link\b[^>]*\brel="stylesheet"/), preload: first(/<link\b[^>]*\brel="(?:modulepreload|preload)"/), script: first(/<script\b[^>]*\bsrc=/),
      body: first(/<body[\s>]/), lcp, lcpAt,
      headTemplates: [...html.slice(0, html.search(/<body[\s>]/)).matchAll(/<template id="(sn-t-\d+)"/g)].map((m) => m[1]),
    });
    await ctx.close();
  }
} finally { await browser.close(); for (const s of servers) s.kill(); }
console.log(JSON.stringify(out, null, 1));
