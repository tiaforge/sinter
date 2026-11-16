// @vitest-environment node
// `sinter({ swap: true })` in the build (docs/proposals/swap-navigation.md, step 3): the list of pages that
// swap with the names each keeps, a kept element as a reason to ship the module, and SN540 for a script a
// swap would not run. Off by default: nothing changes for an app that leaves it off.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { build, createServer } from 'vite';
import { afterAll, expect, test, vi } from 'vitest';
import sinter from '../../src/vite.js';

const src = resolve(__dirname, '../../src');
const alias = [{ find: /^@tiaforge-ui\/sinter\/(.+)$/, replacement: `${src}/$1.ts` }, { find: /^@tiaforge-ui\/sinter$/, replacement: `${src}/index.ts` }];
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

const page = (body: string, html = '<html>') => `<!doctype html>${html}<head><title>x</title></head><body>${body}</body></html>`;
const FILES: Record<string, string> = {
  'index.html': page('<a href="/about.html">About</a><aside data-sn-permanent="player"><audio controls></audio></aside>'),
  'about.html': page('<aside data-sn-permanent="player"></aside><nav data-sn-permanent="menu"></nav><script>track()</script>'),
  'login.html': page('<p>Log in</p>', '<html data-sn-swap="off">'),
  'post.html': page('<p>A post</p>', '<html data-sn-path="/post/:slug">'),
};

function app(files = FILES) {
  const root = mkdtempSync(join(tmpdir(), 'sinter-swap-'));
  dirs.push(root);
  for (const [f, text] of Object.entries(files)) {
    mkdirSync(join(root, f, '..'), { recursive: true });
    writeFileSync(join(root, f), text);
  }
  return root;
}

test('the list of pages that swap: their paths and kept names; a page that opts out is not in it', async () => {
  const root = app();
  const server = await createServer({ root, logLevel: 'silent', resolve: { alias }, server: { middlewareMode: true, hmr: false, ws: false }, appType: 'custom', plugins: [sinter({ swap: true })] });
  try {
    const js = (await server.transformRequest('/@sinter/swap.js'))!.code;
    // the stub with the list: `export default swap([...])`
    expect(js).toMatch(/^import \{ swap \} from "[^"]*\/swap\.ts";$/m);
    const list = JSON.parse(/export default swap\((.*)\);/.exec(js)![1]!) as Array<{ m: string[]; k?: string[] }>;
    const byPath = Object.fromEntries(list.map((x) => [x.m[0], x.k ?? []]));
    // (a page moves to a folder of its name: `/about/`)
    expect(byPath).toEqual({ '/': ['player'], '/about/': ['player', 'menu'], '/post/:slug': [] });
    expect(list.find((x) => x.m[0] === '/about/')!.m).toEqual(['/about/', '/about']);
  } finally {
    await server.close();
  }
});

test('a build: a kept element ships the module only with swaps on; SN540 names the inline script', async () => {
  const run = async (options: Parameters<typeof sinter>[0]) => {
    const root = app({ 'index.html': FILES['index.html']!, 'about.html': FILES['about.html']! });
    const logs: string[] = [];
    const log = (m: string) => { logs.push(m); };
    // (a page's warnings go to the console)
    const warn = vi.spyOn(console, 'warn').mockImplementation((m: string) => log(m));
    const logger = { info: log, warn: log, warnOnce: log, error: log, clearScreen() {}, hasErrorLogged: () => false, hasWarned: false };
    const out = await build({ root, customLogger: logger, logLevel: 'info', plugins: [sinter(options)], resolve: { alias }, build: { write: false, rollupOptions: { input: [join(root, 'index.html'), join(root, 'about.html')] } } });
    warn.mockRestore();
    const assets = (Array.isArray(out) ? out : [out]).flatMap((o) => ('output' in o ? o.output : []));
    const html = (f: string) => String((assets.find((a) => a.fileName === f) as { source?: string }).source);
    return { html, logs: logs.join('\n') };
  };
  const off = await run({});
  expect(off.html('index.html')).not.toContain('<script type="module"');
  expect(off.logs).not.toContain('SN540');
  const on = await run({ swap: true });
  expect(on.html('index.html')).toContain('<script type="module"');
  expect(on.html('index.html')).toContain('<aside data-sn-permanent="player">');
  // the swap fetches the next page itself: no Speculation Rules for pages that swap (here, every page)
  expect(off.html('index.html')).toContain('<script type="speculationrules">');
  expect(on.html('index.html')).not.toContain('speculationrules');
  expect(on.logs).toContain('SN540');
  expect(on.logs).toContain('an inline script in the body does not run when a link swaps this page in');
});
