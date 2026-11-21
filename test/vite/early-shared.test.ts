// @vitest-environment node
// Shared helper modules (docs/first-paint.md#own-copies): a module that declares helpers an early binding calls, and
// whose every export the early file imports, is in the page bundle as a stub that takes the early file's instance, or
// imports its own copy when the early file did not run. The own copy is named for a swap on the page whose early file
// has the module, and preloaded on a page whose early file does not. A module the early file uses in part stays a copy
// of its own, and the build says so. A build target without top-level await shares nothing.
import { createServer, type Server } from 'node:http';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { extname, join, resolve } from 'node:path';
import { build } from 'vite';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import sinter from '../../src/vite.js';
import { chromium } from '../browser.js';

const src = resolve(__dirname, '../../src');
const alias = [{ find: /^@tiaforge-ui\/sinter\/runtime$/, replacement: `${src}/runtime-entry.ts` }, { find: /^@tiaforge-ui\/sinter\/(?:runtime\/)?(.+)$/, replacement: `${src}/$1.ts` }, { find: /^@tiaforge-ui\/sinter$/, replacement: `${src}/index.ts` }];
const dir = mkdtempSync(join(tmpdir(), 'sinter-early-shared-'));
afterAll(() => { if (!process.env.SN_KEEP) rmSync(dir, { recursive: true, force: true }); });

/** an app: `big.shout` (one export) and `part.first` (one of two), their markers in their code */
function app(name: string, pages: Record<string, string>) {
  const root = join(dir, name);
  const put = (f: string, s: string) => { mkdirSync(join(root, f, '..'), { recursive: true }); writeFileSync(join(root, f), s); };
  put('src/big.ts', `const pad = ${JSON.stringify('BIG_HELPER '.repeat(500))};\nexport function shout(s: string | null | undefined): string { const t = (s ?? '').toUpperCase(); return t === pad ? '' : t + '!'; }\n`);
  put('src/part.ts', `const pad = ${JSON.stringify('PART_HELPER '.repeat(500))};\nexport function first(s: string | null | undefined): string { return s === pad ? '' : (s ?? '') + '.'; }\nexport function second(s: string): string { return s === pad ? '' : s; }\n`);
  put('src/sinter.helpers.ts', `export * as big from './big.js';\nexport * as part from './part.js';\n`);
  for (const [f, body] of Object.entries(pages)) put(f, `<!doctype html><html><head><meta charset="utf-8"><title>${f}</title></head><body>\n${body}\n</body></html>\n`);
  return root;
}

async function run(root: string, target?: string) {
  const logs: string[] = [];
  const out = join(root, 'dist');
  await build({
    root, logLevel: 'info', plugins: [sinter({ swap: true })], resolve: { alias },
    customLogger: { info: (m) => void logs.push(m), warn: (m) => void logs.push(m), warnOnce: (m) => void logs.push(m), error: (m) => void logs.push(m), clearScreen() {}, hasErrorLogged: () => false, hasWarned: false },
    build: {
      outDir: out, emptyOutDir: true, ...(target ? { target } : {}),
      rolldownOptions: { input: Object.fromEntries(readdirSync(root).filter((f) => f.endsWith('.html')).map((f) => [f.slice(0, -5), join(root, f)])) },
    },
  });
  const assets = readdirSync(join(out, 'assets')).filter((f) => f.endsWith('.js'));
  const read = (f: string) => readFileSync(join(out, 'assets', f), 'utf8');
  const html = (p: string) => readFileSync(join(out, p), 'utf8');
  /** the head scripts of a page, and its module script with the chunks it imports */
  const heads = (p: string) => [...html(p).matchAll(/<script src="\/assets\/([^"]+)"/g)].map((m) => m[1]!);
  const bundle = (p: string) => {
    const entry = /<script type="module" crossorigin src="\/assets\/([^"]+)"/.exec(html(p))![1]!;
    const seen = new Set<string>(), todo = [entry];
    while (todo.length) {
      const f = todo.pop()!;
      if (seen.has(f)) continue;
      seen.add(f);
      for (const m of read(f).matchAll(/(?:^|[;\n}])\s*import\s*(?:[^'"`;]*?from\s*)?["'`]\.\/([^"'`]+\.js)["'`]/g)) todo.push(m[1]!);
    }
    return [...seen];
  };
  /** whether the files contain `text` (a boolean: a failure does not print the bundle) */
  const has = (files: string[], text: string) => files.some((f) => read(f).includes(text));
  return { out, logs, assets, read, html, heads, bundle, has };
}

describe('a page whose early file calls a helper module', () => {
  let b: Awaited<ReturnType<typeof run>>;
  let own = '';
  beforeAll(async () => {
    b = await run(app('shared', {
      'index.html': `<main><p id="a" data-sn-text="big.shout($url.q)"></p><p id="b" data-sn-text="part.first($url.q)"></p></main>`,
      // big.shout in a handler only: not early, and in this page's bundle
      'other.html': `<main data-sn-state="{ s: '' }"><button data-sn-on-click="s = big.shout('x')">go</button><p id="s" data-sn-text="s"></p></main>`,
    }));
    own = b.assets.find((f) => b.read(f).includes('BIG_HELPER') && !b.heads('index.html').includes(f))!;
  }, 120_000);

  test('the module is in the early file once, and in the page bundle only as its own copy, which the page does not load', () => {
    expect(b.has(b.heads('index.html'), 'BIG_HELPER')).toBe(true);
    expect(b.has(b.heads('index.html'), 'sinter.shared')).toBe(true);
    expect(own).toBeTruthy();
    expect(b.bundle('index.html')).not.toContain(own);
    expect(b.has(b.bundle('index.html'), 'BIG_HELPER')).toBe(false);
    // the swap imports the own copy beside the page module; the page itself fetches nothing for it
    expect(b.html('index.html')).toContain(`<link data-sn-shared href="/assets/${own}">`);
    expect(b.html('index.html')).not.toContain(`modulepreload" crossorigin href="/assets/${own}"`);
  });

  test('the stub and the early file name the module by the same key; no mark is left', () => {
    expect(b.has(b.assets, '__SN_SHARED__')).toBe(false);
    const keys = (s: string) => new Set([...s.matchAll(/\bk[0-9a-f]{26}\b/g)].map((m) => m[0]));
    const early = keys(b.heads('index.html').map(b.read).join('\n')), stub = keys(b.bundle('index.html').map(b.read).join('\n'));
    expect(early.size).toBe(1);
    expect([...stub]).toEqual([...early]);
  });

  test('a page that reaches the module without it in its early file fetches the own copy with the page', () => {
    expect(b.html('other/index.html')).toContain(`<link rel="modulepreload" crossorigin href="/assets/${own}">`);
    expect(b.html('other/index.html')).not.toContain('data-sn-shared');
  });

  test('a module the early file uses in part stays a copy of its own, and the build names it', () => {
    expect(b.has(b.heads('index.html'), 'PART_HELPER')).toBe(true);
    expect(b.has(b.bundle('index.html'), 'PART_HELPER')).toBe(true);
    const line = b.logs.find((l) => l.includes('early script of index.html'))!;
    expect(line).toMatch(/in the page bundle too: src\/part\.ts \d+\.\d kB/);
    expect(line).toContain('src/part.ts is not shared: the early file of index.html uses 1 of its 2 exports');
    expect(line).not.toContain('src/big.ts');
  });

  test('the swap keeps its code for the own copy', () => {
    expect(b.has(b.assets.filter((f) => f.startsWith('swap-run-')), 'data-sn-shared')).toBe(true);
  });

  test.skipIf(!chromium)('in a browser: the early instance on a load, the own copy with the early file blocked', async () => {
    const server: Server = createServer((req, res) => {
      const path = new URL(req.url!, 'http://x').pathname;
      try {
        const body = readFileSync(join(b.out, path === '/' ? 'index.html' : path));
        res.setHeader('Content-Type', extname(path) === '.js' ? 'text/javascript' : 'text/html');
        res.end(body);
      } catch { res.statusCode = 404; res.end(); }
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/?q=hi`;
    const browser = await chromium!.launch();
    try {
      for (const blocked of [false, true]) {
        const page = await browser.newPage();
        const errors: string[] = [], scripts: string[] = [];
        page.on('pageerror', (e) => errors.push(String(e)));
        page.on('request', (r) => scripts.push(new URL(r.url()).pathname.replace('/assets/', '')));
        if (blocked) await page.route(/index-head-/, (r) => r.abort());
        await page.goto(url);
        await page.waitForFunction(() => document.querySelector('#a')?.textContent === 'HI!');
        await page.waitForLoadState('networkidle');
        expect(await page.textContent('#b')).toBe('hi.');
        expect(scripts.includes(own)).toBe(blocked);
        expect(errors).toEqual([]);
        await page.close();
      }
    } finally {
      await browser.close();
      server.close();
    }
  }, 60_000);
});

test('a build target without top-level await shares nothing, says why, and the swap has no code for an own copy', async () => {
  const b = await run(app('es2020', { 'index.html': `<main><p data-sn-text="big.shout($url.q)"></p></main>` }), 'es2020');
  expect(b.has(b.bundle('index.html'), 'BIG_HELPER')).toBe(true);
  expect(b.has(b.assets, 'sinter.shared')).toBe(false);
  expect(b.html('index.html')).not.toContain('data-sn-shared');
  expect(b.has(b.assets.filter((f) => f.startsWith('swap-run-')), 'data-sn-shared')).toBe(false);
  expect(b.logs.find((l) => l.includes('early script of index.html'))).toContain('src/big.ts is not shared: the build target (es2020) has no top-level await');
}, 120_000);

describe('the early runtime\'s stateless exports a page alone uses', () => {
  let b: Awaited<ReturnType<typeof run>>;
  beforeAll(async () => {
    b = await run(app('own', {
      // a numbered list's first page (`withParams`), on this page only
      'index.html': `<sn-resource name="rows" src="/api/rows?q={$url.q}" key="id" type="any" paginate="{ numbered: true, size: 3 }"></sn-resource><ul><template data-sn-for="r in rows"><li data-sn-text="r.id"></li></template></ul>`,
      'other.html': `<sn-resource name="one" src="/api/one?q={$url.q}" type="any"></sn-resource><p id="one" data-sn-text="one ? one.v : ''"></p>`,
    }));
  }, 120_000);

  test('are in that page\'s early file, not in the head script every page loads', () => {
    const shared = b.assets.find((f) => f.startsWith('sinter-head-'))!;
    const table = /sinter\.early\.rt`?\)?\]\s*=\s*\{([^}]*)\}/.exec(b.read(shared))![1]!;
    expect(table).toContain('requests');
    expect(table).not.toContain('withParams');
    // index's early file has its own, and takes the rest from the head script's global
    const own = b.heads('index.html').find((f) => f.startsWith('index-head-'))!;
    expect(b.read(own)).toContain('URLSearchParams');
    expect(b.read(own)).toContain('sinter.early.rt');
    expect(b.read(b.heads('other/index.html').find((f) => f.startsWith('other-head-'))!)).not.toContain('URLSearchParams');
  });

  test.skipIf(!chromium)('in a browser: the early request of the first page is the one the page module takes', async () => {
    const asked: string[] = [];
    const server: Server = createServer((req, res) => {
      const u = new URL(req.url!, 'http://x'), path = u.pathname;
      if (path === '/api/rows') { asked.push(u.search); res.setHeader('Content-Type', 'application/json'); return res.end(JSON.stringify([{ id: 1 }, { id: 2 }])); }
      try {
        const body = readFileSync(join(b.out, path === '/' ? 'index.html' : path));
        res.setHeader('Content-Type', extname(path) === '.js' ? 'text/javascript' : 'text/html');
        res.end(body);
      } catch { res.statusCode = 404; res.end(); }
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const browser = await chromium!.launch();
    try {
      const page = await browser.newPage();
      const errors: string[] = [];
      page.on('pageerror', (e) => errors.push(String(e)));
      await page.goto(`http://127.0.0.1:${(server.address() as { port: number }).port}/?q=x`);
      await page.waitForFunction(() => document.querySelectorAll('li').length === 2);
      await page.waitForLoadState('networkidle');
      expect(asked).toEqual(['?q=x&page=1&limit=3']);
      expect(errors).toEqual([]);
    } finally {
      await browser.close();
      server.close();
    }
  }, 60_000);
});
