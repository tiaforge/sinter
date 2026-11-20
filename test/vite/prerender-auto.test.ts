// @vitest-environment node
// `prefetch: { html: { prerender: 'auto' } }` (docs/navigation.md#speculation-rules): the build prerenders the pages
// it can show do nothing on load but read, and prefetches the rest; the prerender rule leaves out what a prefetched
// page's paths match. Both deliveries carry the same rules. The app's modules decide for every page.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { build, createLogger } from 'vite';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { compileParts } from '../../src/compiler/compile.js';
import { moduleEffect } from '../../src/prerender-build.js';
import sinter from '../../src/vite.js';

const src = resolve(__dirname, '../../src');
const alias = [{ find: /^@tiaforge-ui\/sinter\/runtime$/, replacement: `${src}/runtime-entry.ts` }, { find: /^@tiaforge-ui\/sinter\/(?:runtime\/)?(.+)$/, replacement: `${src}/$1.ts` }, { find: /^@tiaforge-ui\/sinter$/, replacement: `${src}/index.ts` }];
const dir = mkdtempSync(join(tmpdir(), 'sinter-prerender-auto-'));
const root = join(dir, 'app');
const page = (path: string, body: string) => `<!doctype html><html lang="en" data-sn-path="${path}"><head><meta charset="utf-8"><title>t</title></head><body>${body}</body></html>`;
const rulesOf = (html: string) => JSON.parse(/<script type="speculationrules">(.*?)<\/script>/.exec(html)![1]!);
const input = ['index.html', 'article.html', 'new.html', 'stream.html'];

beforeAll(() => {
  mkdirSync(join(root, 'src'), { recursive: true });
  // reads only, a stream (it connects once the page is shown)
  writeFileSync(join(root, 'index.html'), page('/', '<sn-resource name="a" src="/api/a" items="a" key="id"></sn-resource><ul><template data-sn-for="x in a"><li><a data-sn-attr="{ href: \'/article/\' + x.id }" data-sn-text="x.id"></a></li></template></ul><a href="/article/new">new</a>'));
  writeFileSync(join(root, 'article.html'), page('/article/:id', '<sn-resource name="a" src="/api/a/{$url.id}"></sn-resource><h1 data-sn-text="a?.title"></h1><button data-sn-post="/api/a/{$url.id}/like">like</button>'));
  // a `then` on its resource: it does something as it loads
  writeFileSync(join(root, 'new.html'), page('/article/new', '<div data-sn-state="{ d: null }"><sn-resource name="draft" src="/api/draft" then="d = $result"></sn-resource><p data-sn-text="d?.title ?? draft?.title"></p></div>'));
  writeFileSync(join(root, 'stream.html'), page('/live', '<sn-resource name="n" src="/api/n" items="n" key="id"></sn-resource><sn-sync src="/api/events"><sn-event name="n" resource="n" op="upsert" value="$event"></sn-event></sn-sync><i data-sn-text="n.length"></i>'));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

async function built(html: object, out: string) {
  const lines: string[] = [], logger = createLogger('silent');
  logger.info = (m: string) => { lines.push(m); };
  await build({ root, customLogger: logger, resolve: { alias }, build: { outDir: join(dir, out), emptyOutDir: true, minify: false, rollupOptions: { input: input.map((f) => join(root, f)) } }, plugins: [sinter({ prefetch: { html } as never })] });
  return lines;
}

test('inline: the quiet pages are prerendered, the others prefetched, and a prerendered pattern leaves out their paths', async () => {
  const lines = await built({ prerender: 'auto' }, 'inline');
  const rules = rulesOf(readFileSync(join(dir, 'inline', 'index.html'), 'utf8'));
  expect(rules.prerender[0].where.and[0].href_matches.sort()).toEqual(['/\\?*#*', '/article/:id/\\?*#*', '/article/:id\\?*#*', '/live\\?*#*']);
  // a link to /article/new matches /article/:id too: never prerendered
  expect(rules.prerender[0].where.and[1]).toEqual({ not: { href_matches: ['/article/new\\?*#*'] } });
  expect(rules.prefetch[0].where.and[0].href_matches).toEqual(['/article/new\\?*#*']);
  const log = lines.find((l) => l.includes("prerender: 'auto'"))!;
  expect(log).toMatch(/^sinter: links prerender (index|article|stream)\.html, (index|article|stream)\.html, (index|article|stream)\.html; they prefetch new\.html \(resource `draft` runs `then`\)/);
});

test('header: the rules file carries the same split', async () => {
  await built({ prerender: 'auto', delivery: 'header' }, 'header');
  const rules = JSON.parse(readFileSync(join(dir, 'header', 'speculation-rules.json'), 'utf8'));
  expect(Object.keys(rules)).toEqual(['prerender', 'prefetch']);
  expect(rules.prefetch[0].where.and[0].href_matches).toEqual(['/article/new\\?*#*']);
});

test('an app module that does something as it loads: no page is prerendered', async () => {
  writeFileSync(join(root, 'src', 'sinter.config.js'), "import { configure } from '@tiaforge-ui/sinter';\nconfigure({ onError: () => {} });\nfetch('/api/hit');\n");
  try {
    const lines = await built({ prerender: 'auto' }, 'config');
    const rules = rulesOf(readFileSync(join(dir, 'config', 'index.html'), 'utf8'));
    expect(Object.keys(rules)).toEqual(['prefetch']);
    expect(lines.find((l) => l.includes("prerender: 'auto'"))).toMatch(/links prerender no page, .*sinter\.config\.js:3: runs code as it loads/);
  } finally {
    rmSync(join(root, 'src', 'sinter.config.js'));
  }
});

test('the default and `prerender: true` are unchanged', async () => {
  await built(true as never, 'default');
  expect(Object.keys(rulesOf(readFileSync(join(dir, 'default', 'index.html'), 'utf8')))).toEqual(['prefetch']);
  await built({ prerender: true }, 'all');
  const all = rulesOf(readFileSync(join(dir, 'all', 'index.html'), 'utf8'));
  expect(Object.keys(all)).toEqual(['prerender']);
  expect(all.prerender[0].where.and).toHaveLength(2);
});

test('what a page does as it loads, as the compiler finds it', () => {
  const effect = (body: string) => compileParts(`<html><head></head><body>${body}</body></html>`, { file: '/t/p.html', root: '/t', dev: false, readFile: () => { throw new Error('no such file'); }, helpers: { module: null, names: [], namespaces: {} }, actions: { module: '/t/a.js', names: ['go'], namespaces: {} } }).loadEffect;
  expect(effect('<sn-resource name="a" src="/api/a"></sn-resource><i data-sn-text="a"></i><button data-sn-on-click="x = 1" data-sn-state="{ x: 0 }">x</button><form data-sn-post="/api/f"><button>s</button></form>')).toBeUndefined();
  expect(effect('<sn-resource name="a" call="go()"></sn-resource><i data-sn-text="a"></i>')).toBe('resource `a` loads with `call`');
  expect(effect('<sn-resource name="a" src="/api/a" method="POST" body="{ q: 1 }"></sn-resource><i data-sn-text="a"></i>')).toBe('resource `a` loads with `method="POST"`');
  expect(effect('<img src="/x.png" alt="" data-sn-state="{ n: 0 }" data-sn-on-load="n = 1">')).toBe('a handler of `load`, which the page may fire as it loads');
  expect(effect('<script>track()</script>')).toBe('an inline script');
  expect(effect('<script type="module" src="/src/analytics.js"></script>')).toBe('a script (`/src/analytics.js`)');
  expect(effect('<script type="application/ld+json">{}</script><template data-sn-if="1"><p>x</p></template>')).toBeUndefined();
  expect(effect('<template data-sn-if="1"><my-chart></my-chart></template>')).toBe('a custom element (`<my-chart>`)');
});

test('app modules: declarations, sinter\'s configuration and pure packages are quiet; anything else is an effect', () => {
  const m = join(dir, 'mods');
  mkdirSync(join(m, 'node_modules', 'pure'), { recursive: true });
  mkdirSync(join(m, 'node_modules', 'loud'), { recursive: true });
  writeFileSync(join(m, 'node_modules', 'pure', 'package.json'), '{ "name": "pure", "sideEffects": false }');
  writeFileSync(join(m, 'node_modules', 'loud', 'package.json'), '{ "name": "loud" }');
  const file = (name: string, text: string) => { writeFileSync(join(m, name), text); return join(m, name); };
  file('util.ts', 'export const API = `https://api.example`;\nexport function plus(a: number, b: number) { return a + b; }\nexport type T = { a: 1 };\n');
  const quiet = file('config.ts', "import { configure, onUnauthorized, loginRedirect } from '@tiaforge-ui/sinter';\nimport { API } from './util.js';\nimport { x } from 'pure';\nconst ENV = import.meta.env.MODE;\nconfigure({ request: [onUnauthorized(loginRedirect({ to: '/login' }))], onError: () => {} });\nexport class A { m() { return x; } }\nexport default { API, ENV };\n");
  expect(moduleEffect(quiet, m)).toBeNull();
  expect(moduleEffect(file('a.js', "import 'loud';\n"), m)).toMatch(/a\.js:1: imports `loud`, whose package\.json does not say `"sideEffects": false`/);
  expect(moduleEffect(file('b.js', "import { clearStored } from '@tiaforge-ui/sinter';\nclearStored();\n"), m)).toMatch(/b\.js:2: runs code as it loads/);
  expect(moduleEffect(file('c.js', "import './d.js';\n"), m)).toMatch(/d\.js: could not be read|cannot find/);
  file('e.js', "customElements.define('x-y', class extends HTMLElement {});\n");
  expect(moduleEffect(file('f.js', "import './e.js';\nexport const n = 1;\n"), m)).toMatch(/e\.js:1: runs code as it loads/);
  expect(moduleEffect(file('g.js', 'export const t = Date.now();\n'), m)).toMatch(/g\.js:1: runs code as it loads/);
});
