// Languages in the URL, checked: builds examples/multilingual-site with a checkout's sinter (its `dist/`, so
// `npm run build` there first), serves the output with Python's http.server (no configuration: a directory's
// index.html, `/x` redirected to `/x/`, nothing else), and checks what a visitor and a crawler get: each URL,
// the scripts each page ships, where the German pages' links go, the hreflang and canonical links, and in
// Chromium where a visitor lands by browser language, by the cookie the pages set, and without JavaScript.
//   node bench/static/locales.mjs [--repo <checkout>]
import { spawn } from 'node:child_process';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'vite';
import { chromium } from 'playwright';

const arg = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : fallback; };
const self = resolve(import.meta.dirname, '../..'), repo = resolve(arg('repo', self));
const site = join(self, 'examples/multilingual-site'), dist = join(import.meta.dirname, 'out', 'locales', 'dist');
const { default: sinter } = await import(pathToFileURL(join(repo, 'dist/vite.js')).href);
const logs = [];
const log = (m) => { logs.push(m); };
await build({
  root: site, configFile: false, appType: 'mpa', logLevel: 'info',
  customLogger: { info: log, warn: log, warnOnce: log, error: log, clearScreen() {}, hasErrorLogged: () => false, hasWarned: false },
  resolve: { alias: [{ find: /^@tiaforge-ui\/sinter\/(.+)$/, replacement: join(repo, 'dist/$1.js') }, { find: /^@tiaforge-ui\/sinter$/, replacement: join(repo, 'dist/index.js') }] },
  plugins: [sinter({ localePrefix: true, site: 'https://example.com', static: ['index.html', 'about.html', 'docs/**'] })],
  build: { outDir: dist, emptyOutDir: true, rollupOptions: { input: ['index.html', 'about.html', 'docs/getting-started.html', 'status.html'].map((p) => join(site, p)) } },
});

const port = 8100 + Math.floor(Math.random() * 800);
const server = spawn('python3', ['-m', 'http.server', String(port), '--directory', dist], { stdio: 'ignore' });
const origin = `http://127.0.0.1:${port}`;
for (let i = 0; i < 50; i++) { try { await fetch(origin); break; } catch { await new Promise((r) => setTimeout(r, 100)); } }

/** follows HTTP redirects and refreshes, as a browser without JavaScript does */
async function visit(path) {
  const steps = [];
  let url = path;
  for (let i = 0; i < 5; i++) {
    const r = await fetch(origin + url, { redirect: 'manual' });
    if (r.status >= 300 && r.status < 400) { url = new URL(r.headers.get('location'), origin + url).pathname; steps.push(`${r.status} → ${url}`); continue; }
    if (r.status !== 200) { steps.push(String(r.status)); return { steps }; }
    const html = await r.text();
    const refresh = /<meta http-equiv="refresh" content="0; url=([^"]+)">/.exec(html);
    if (refresh) { url = new URL(refresh[1], origin + url).pathname; steps.push(`chooser → ${url}`); continue; }
    steps.push('200');
    return { steps, url, html };
  }
  return { steps };
}

console.log('## Each URL, without JavaScript\n\n| request | result | `<html lang>` | `<title>` | scripts |\n| --- | --- | --- | --- | ---: |');
const pages = new Map();
for (const path of ['/', '/about/', '/about', '/about.html', '/en/', '/en/about/', '/de/', '/de/about/', '/de/about', '/de/about.html', '/de/docs/getting-started/', '/de/status/']) {
  const v = await visit(path);
  const scripts = v.html ? (v.html.match(/<script(?! type="speculationrules")[^>]*>/g) ?? []).length : '';
  console.log(`| \`${path}\` | ${v.steps.join(', ')} | ${v.html ? /<html lang="([^"]+)"/.exec(v.html)?.[1] : ''} | ${v.html ? /<title>([^<]*)/.exec(v.html)?.[1] : ''} | ${scripts} |`);
  if (v.html) pages.set(v.url, v.html);
}

console.log('\n## Links on the German pages\n');
let de = 0, other = [];
for (const [url, html] of pages) {
  if (!url.startsWith('/de/')) continue;
  for (const m of html.matchAll(/<a\b([^>]*)\shref="([^"]+)"/g)) {
    if (/hreflang=/.test(m[1])) continue;
    const to = new URL(m[2], origin + url).pathname;
    if (to.startsWith('/de/')) de++; else other.push(`${url} → ${to}`);
  }
}
console.log(`${de} links stay under /de/; ${other.length ? `elsewhere: ${other.join(', ')}` : 'none go elsewhere'} (the language switcher's links, with hreflang, aside).`);

console.log('\n## The head of /de/about/\n\n```');
for (const m of pages.get('/de/about/').matchAll(/<link rel="(?:alternate|canonical)"[^>]*>|<meta property="og:url"[^>]*>/g)) console.log(m[0]);
console.log('```');

console.log('\n## Where a visitor lands, in Chromium\n\n| visitor | opens | lands on |\n| --- | --- | --- |');
const browser = await chromium.launch();
const land = async (label, ctxOpts, path, cookie) => {
  const ctx = await browser.newContext(ctxOpts);
  if (cookie) await ctx.addCookies([{ name: 'locale', value: cookie, url: origin }]);
  const tab = await ctx.newPage();
  await tab.goto(origin + path);
  await tab.waitForLoadState('networkidle');
  console.log(`| ${label} | \`${path}\` | \`${new URL(tab.url()).pathname}\` |`);
  await ctx.close();
};
await land('browser in German', { locale: 'de-DE' }, '/about/');
await land('browser in French (no French pages)', { locale: 'fr-FR' }, '/about/');
await land('browser in German, last on an English page with a script (cookie `en`)', { locale: 'de-DE' }, '/about/', 'en');
await land('JavaScript off, browser in German', { locale: 'de-DE', javaScriptEnabled: false }, '/about/');
// the cookie, as the status page (the one that ships a script) sets it
const ctx = await browser.newContext({ locale: 'en-US' });
const tab = await ctx.newPage();
await tab.goto(origin + '/de/status/');
await tab.waitForLoadState('networkidle');
const cookie = (await ctx.cookies()).find((c) => c.name === 'locale')?.value;
await tab.goto(origin + '/');
await tab.waitForLoadState('networkidle');
console.log(`| browser in English, after visiting \`/de/status/\` (cookie \`${cookie}\`) | \`/\` | \`${new URL(tab.url()).pathname}\` |`);
await browser.close();
server.kill();
console.log('\n## The build\'s report\n\n```\n' + logs.filter((l) => /^sinter: .*(JavaScript|no JavaScript)/.test(l)).sort().join('\n') + '\n```');
