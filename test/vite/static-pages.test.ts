// @vitest-environment node
// Pages without JavaScript (docs/static-pages.md): a page with nothing to run gets no script of sinter's, its
// stylesheets are linked, and it renders the same with JavaScript off; a page with data on the same site is unchanged.
import { createServer as http } from 'node:http';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { extname, join, resolve } from 'node:path';
import { build, createServer } from 'vite';
import { afterAll, describe, expect, test } from 'vitest';
import sinter from '../../src/vite.js';
import { engines } from '../browser.js';

const src = resolve(__dirname, '../../src');
const alias = [{ find: /^@tiaforge-ui\/sinter\/(.+)$/, replacement: `${src}/$1.ts` }, { find: /^@tiaforge-ui\/sinter$/, replacement: `${src}/index.ts` }];
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

/** A site: the files, then a build; the pages are its `.html` files at the root. */
async function site(files: Record<string, string>, options: Parameters<typeof sinter>[0] = {}) {
  const root = mkdtempSync(join(tmpdir(), 'sinter-static-'));
  dirs.push(root);
  for (const [f, text] of Object.entries(files)) {
    mkdirSync(join(root, f, '..'), { recursive: true });
    writeFileSync(join(root, f), text);
  }
  const pages = Object.keys(files).filter((f) => !f.includes('/') && f.endsWith('.html'));
  const out = join(root, 'dist');
  const logs: string[] = [];
  const log = (m: string) => { logs.push(m); };
  const logger = { info: log, warn: log, warnOnce: log, error: log, clearScreen() {}, hasErrorLogged: () => false, hasWarned: false };
  await build({ root, customLogger: logger, logLevel: 'info', plugins: [sinter(options)], resolve: { alias }, build: { outDir: out, emptyOutDir: true, rollupOptions: { input: pages.map((p) => join(root, p)) } } });
  const read = (f: string) => readFileSync(join(out, f), 'utf8');
  const assets = readdirSync(join(out, 'assets'));
  return { root, out, read, assets, logs };
}

const HEADER = `<template data-sn-component="{ title: string; nav: string }">
  <header class="h"><h1 data-sn-text="title"></h1><nav-list data-sn-prop="{ nav, items: [{ id: 'home', href: '/', label: 'Home' }, { id: 'about', href: '/about.html', label: 'About' }] }"></nav-list></header>
</template>
<style>.h { padding: 7px; }</style>
`;
const NAV = `<template data-sn-component="{ nav: string; items: { id: string; href: string; label: string }[] }">
  <ul><template data-sn-for="i in items"><li><a data-sn-attr="{ href: i.href }" data-sn-class="{ active: i.id === nav }" data-sn-text="i.label"></a></li></template></ul>
</template>
`;
const PAGE = (title: string, nav: string, body: string) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title></head><body>
<site-header data-sn-prop="{ title: '${title}', nav: '${nav}' }"></site-header>
<main data-sn-state="{ year: 2026 }">${body}<footer data-sn-text="'© ' + year"></footer></main>
</body></html>`;
const STATIC = {
  'src/components/site-header.html': HEADER,
  'src/components/nav-list.html': NAV,
  'index.html': PAGE('Home', 'home', '<p>Hello.</p>'),
  'about.html': PAGE('About', 'about', '<p>About us.</p>'),
};

/** Serves a build's output, as a static host does. */
async function serve(dir: string) {
  const types: Record<string, string> = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript' };
  const server = http((req, res) => {
    const path = decodeURIComponent((req.url ?? '/').split('?')[0]!);
    try {
      const body = readFileSync(join(dir, path.endsWith('/') ? path + 'index.html' : path));
      res.writeHead(200, { 'content-type': types[extname(path) || '.html'] ?? 'application/octet-stream' }).end(body);
    } catch { res.writeHead(404).end(); }
  });
  await new Promise<void>((r) => server.listen(0, r));
  return { url: `http://localhost:${(server.address() as { port: number }).port}`, close: () => server.close() };
}

test('a site with nothing to run: no script, no .js file, the scoped styles linked; the HTML is complete', async () => {
  const { read, assets, logs } = await site(STATIC);
  for (const page of ['index.html', 'about.html']) {
    const html = read(page);
    expect(html, page).not.toMatch(/<script(?! type="speculationrules")/);
    expect(html, page).not.toContain('modulepreload');
    expect(html, page).toMatch(/<link rel="stylesheet" crossorigin href="\/assets\/[^"]+\.css">/);
    expect(html, page).not.toContain('data-sn=');
    expect(html, page).not.toContain('<template');
  }
  expect(read('about.html')).toContain('<ul data-sn-c="nav-list"><li><a href="/">Home</a></li><li><a href="/about.html" class="active">About</a></li></ul>');
  expect(read('about.html')).toContain('<main><p>About us.</p><footer>© 2026</footer></main>');
  expect(assets.filter((f) => f.endsWith('.js'))).toEqual([]);
  expect(logs.join('\n')).toContain('sinter: index.html: no JavaScript');
});

test('a mixed site: the page with data keeps its scripts, the static page has none', async () => {
  const { read } = await site({
    ...STATIC,
    'app.html': `<!doctype html><html><head><title>App</title></head><body>
<sn-resource name="tasks" src="/api/tasks" type="any"></sn-resource>
<div data-sn-state="{ n: 0 }"><button data-sn-on-click="n++">+</button><b data-sn-text="n"></b></div>
</body></html>`,
  });
  expect(read('app.html')).toMatch(/<script type="module" crossorigin src="\/assets\/app-[^"]+\.js" async><\/script>/);
  expect(read('index.html')).not.toMatch(/<script(?! type="speculationrules")/);
});

test('a script the page writes is the page\'s own: it stays, and it is the only one', async () => {
  const { read } = await site({ ...STATIC, 'main.ts': 'document.documentElement.dataset.ran = "1";\n', 'index.html': PAGE('Home', 'home', '<p>Hello.</p>').replace('</head>', '<script type="module" src="./main.ts"></script></head>') });
  const scripts = read('index.html').match(/<script(?! type="speculationrules")[^>]*>/g) ?? [];
  expect(scripts).toHaveLength(1);
  expect(scripts[0]).toMatch(/src="\/assets\/index-[^"]+\.js"/);
});

test('in the browser, a static page is the same with JavaScript off as with it on', async () => {
  const { out } = await site(STATIC);
  const host = await serve(out);
  try {
    for (const engine of await engines()) {
      const browser = await engine.type.launch(engine.executablePath ? { executablePath: engine.executablePath } : {});
      try {
        const seen: string[] = [];
        for (const javaScriptEnabled of [false, true]) {
          const tab = await (await browser.newContext({ javaScriptEnabled })).newPage();
          await tab.goto(`${host.url}/about.html`);
          expect(await tab.$eval('.h', (el) => getComputedStyle(el).padding), engine.name).toBe('7px');
          seen.push(await tab.$eval('body', (el) => el.innerHTML));
        }
        expect(seen[0], engine.name).toBe(seen[1]);
        expect(seen[0]).toContain('class="active">About</a>');
      } finally {
        await browser.close();
      }
    }
  } finally {
    host.close();
  }
}, 120_000);

test('the dev server: no page module on a static page, the scoped styles served as CSS', async () => {
  const root = mkdtempSync(join(tmpdir(), 'sinter-static-dev-'));
  dirs.push(root);
  for (const [f, text] of Object.entries(STATIC)) {
    mkdirSync(join(root, f, '..'), { recursive: true });
    writeFileSync(join(root, f), text);
  }
  const server = await createServer({ root, logLevel: 'silent', plugins: [sinter()], resolve: { alias }, server: { port: 0 } });
  await server.listen();
  try {
    const base = server.resolvedUrls!.local[0]!.replace(/\/$/, '');
    const html = await (await fetch(`${base}/about.html`)).text();
    expect(html).not.toContain('/@sinter/about.html.js');
    const href = /<link rel="stylesheet" href="([^"]+)"/.exec(html)![1]!;
    const css = await fetch(base + href, { headers: { accept: 'text/css,*/*;q=0.1' } });
    expect(css.headers.get('content-type')).toContain('text/css');
    expect(await css.text()).toMatch(/padding:\s*7px/);
  } finally {
    await server.close();
  }
}, 60_000);

describe('sinter({ static })', () => {
  const footer = '<template data-sn-component="">\n<footer>\n  <button data-sn-on-click="$el.blur()">top</button>\n</footer>\n</template>\n';

  test('a matched page with nothing to run builds; one that needs the runtime fails with SN322 where it was written', async () => {
    await expect(site(STATIC, { static: ['index.html', 'about.html'] })).resolves.toBeDefined();
    const err = await site({ ...STATIC, 'src/components/site-footer.html': footer, 'about.html': PAGE('About', 'about', '<site-footer></site-footer>') }, { static: true }).catch((e: Error) => e);
    expect(String(err)).toMatch(/src\/components\/site-footer\.html:3:\d+ error SN322 ships-javascript: about\.html must ship no JavaScript \(`sinter\(\{ static \}\)`\), but `data-sn-on-click` runs in the browser/);
  });

  test('a pattern that matches no page fails the build', async () => {
    const err = await site(STATIC, { static: ['index.html', 'docs/**'] }).catch((e: Error) => e);
    expect(String(err)).toContain('sinter({ static }): no page matches `docs/**`');
  });

  test('the build says why a page ships JavaScript, and how much', async () => {
    const { logs } = await site({ ...STATIC, 'src/components/site-footer.html': footer, 'about.html': PAGE('About', 'about', '<site-footer></site-footer>') });
    expect(logs.join('\n')).toMatch(/sinter: about\.html: JavaScript \d+\.\d kB gzip(?: \+ \d+\.\d kB gzip shared)?: `data-sn-on-click` \(src\/components\/site-footer\.html:3\)/);
    expect(logs.join('\n')).toContain('sinter: index.html: no JavaScript');
  });
});

