// Page URLs on a static server with no configuration: serves a build of examples/static-site (made by
// measure.mjs: bench/static/out/<label>/dist) with Python's http.server, which serves a directory's
// index.html and redirects `/x` to `/x/`, and nothing else. For each page it requests `/x`, `/x/` and
// `/x.html`, following redirects (HTTP and `<meta http-equiv="refresh">`), and then follows every internal
// link of every page: does it arrive at once, through a redirect, or not at all?
//   node bench/static/urls.mjs --label <name>
import { spawn } from 'node:child_process';
import { join } from 'node:path';

const arg = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : fallback; };
const label = arg('label', 'branch'), dist = join(import.meta.dirname, 'out', label, 'dist');
const port = 8100 + Math.floor(Math.random() * 800);
const server = spawn('python3', ['-m', 'http.server', String(port), '--directory', dist], { stdio: 'ignore' });
const origin = `http://127.0.0.1:${port}`;
for (let i = 0; i < 50; i++) { try { await fetch(origin); break; } catch { await new Promise((r) => setTimeout(r, 100)); } }

/** follows HTTP redirects and HTML refreshes; returns the steps and the page reached */
async function visit(path) {
  const steps = [];
  let url = path;
  for (let i = 0; i < 5; i++) {
    const r = await fetch(origin + url, { redirect: 'manual' });
    if (r.status >= 300 && r.status < 400) { url = new URL(r.headers.get('location'), origin + url).pathname; steps.push(`${r.status} → ${url}`); continue; }
    if (r.status !== 200) { steps.push(String(r.status)); return { steps, ok: false }; }
    const html = await r.text();
    const refresh = /<meta http-equiv="refresh" content="0; url=([^"]+)">/.exec(html);
    if (refresh) { url = new URL(refresh[1], origin + url).pathname; steps.push(`refresh → ${url}`); continue; }
    steps.push('200');
    return { steps, ok: true, url, html, title: /<title>([^<]*)<\/title>/.exec(html)?.[1] ?? '' };
  }
  return { steps, ok: false };
}

const pages = ['', 'about', 'docs/getting-started', 'status'];
console.log(`## ${label}\n\n| request | result |\n| --- | --- |`);
const reached = new Map();
for (const p of pages) {
  for (const path of p ? [`/${p}`, `/${p}/`, `/${p}.html`] : ['/', '/index.html']) {
    const v = await visit(path);
    console.log(`| \`${path}\` | ${v.steps.join(', ')}${v.ok ? ` (${v.title})` : ''} |`);
    if (v.ok) reached.set(v.url, v.html);
  }
}
let direct = 0, redirected = 0, broken = 0;
const seen = new Set();
for (const [from, html] of reached) {
  for (const m of html.matchAll(/<a\b[^>]*\shref="([^"]+)"/g)) {
    const to = new URL(m[1], origin + from);
    if (to.origin !== origin || seen.has(`${from} ${to.pathname}`)) continue;
    seen.add(`${from} ${to.pathname}`);
    const v = await visit(to.pathname);
    if (!v.ok) broken++; else if (v.steps.length > 1) redirected++; else direct++;
  }
}
console.log(`\nInternal links: ${direct} arrive at once, ${redirected} through a redirect, ${broken} broken.\n`);
server.kill();
