// @vitest-environment node
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { build, createServer } from 'vite';
import { afterAll, expect, test } from 'vitest';
import sinter from '../../src/vite.js';

const root = resolve(__dirname, '../fixtures/vite-app');
const src = resolve(__dirname, '../../src');
const out = mkdtempSync(join(tmpdir(), 'sinter-vite-'));
afterAll(() => rmSync(out, { recursive: true, force: true }));

const alias = ['sse', 'optimistic', 'paginate', 'persist', 'early']
  .map((f) => ({ find: `@tiaforge-ui/sinter/${f}`, replacement: `${src}/${f}.ts` }))
  .concat([{ find: '@tiaforge-ui/sinter', replacement: `${src}/index.ts` }]);

async function run(outDir: string) {
  return build({ root, logLevel: 'silent', plugins: [sinter()], resolve: { alias }, build: { outDir, emptyOutDir: true, minify: false } });
}

test('builds a page: rewritten HTML, page module, helpers, namespace members and called actions', async () => {
  await run(out);
  const html = readFileSync(join(out, 'index.html'), 'utf8');
  expect(html).not.toContain('data-sn-');
  expect(html).not.toContain('sn-resource');
  expect(html).toMatch(/<script type="module" crossorigin src="\/assets\/[^"]+\.js"><\/script>/);
  const js = readdirSync(join(out, 'assets')).filter((f) => f.endsWith('.js')).map((f) => readFileSync(join(out, 'assets', f), 'utf8')).join('\n');
  expect(js).toContain('People');
  expect(js).toContain('toUpperCase');
  expect(js).toContain('X-Sinter');
  expect(js).toContain('hello from the actions module');
  expect(js).not.toContain('never called');
  expect(js).not.toContain('tree-shaken');
  expect(js).not.toMatch(/(^|[^.\w$])eval\(|new Function\(/);
});

test('compile errors fail the build with the diagnostic', async () => {
  const page = join(root, 'index.html');
  const original = readFileSync(page, 'utf8');
  writeFileSync(page, original.replace('data-sn-model="q"', 'data-sn-modle="q"'));
  try {
    await expect(run(join(out, 'bad'))).rejects.toThrow(/SN101 unknown-attribute: `data-sn-modle` is not a sinter attribute. Did you mean `data-sn-model`\?/);
  } finally {
    writeFileSync(page, original);
  }
});

test('typecheck: type errors fail `vite build` with SN208', async () => {
  const page = join(root, 'index.html');
  const original = readFileSync(page, 'utf8');
  writeFileSync(page, original.replace('</body>', '<p data-sn-text="(1).nope"></p></body>'));
  try {
    await expect(build({
      root, logLevel: 'silent', plugins: [sinter({ typecheck: true })], resolve: { alias },
      build: { outDir: join(out, 'typecheck'), emptyOutDir: true, minify: false },
    })).rejects.toThrow(/SN208 type-error: Property 'nope' does not exist on type '1'/);
  } finally {
    writeFileSync(page, original);
    rmSync(join(root, '.sinter'), { recursive: true, force: true });
  }
});

test('first paint: one self-contained early file per page, render-blocking before the page module', async () => {
  const dir = join(out, 'first-paint');
  const logs: string[] = [];
  await build({
    root, resolve: { alias }, build: { outDir: dir, emptyOutDir: true, minify: false },
    customLogger: { info: (m: string) => { logs.push(m); }, warn: (m: string) => { logs.push(m); }, warnOnce: () => {}, error: () => {}, clearScreen: () => {}, hasErrorLogged: () => false, hasWarned: false } as never,
    plugins: [sinter({ earlyBudget: 1 })],
  });
  const html = readFileSync(join(dir, 'index.html'), 'utf8');
  const early = /<script type="module" crossorigin src="\/assets\/(index-early-[\w-]+\.js)" blocking="render"><\/script>/.exec(html);
  expect(early).not.toBeNull();
  const page = /<script type="module" crossorigin src="\/assets\/(index-[\w-]+\.js)"><\/script>/.exec(html);
  expect(page).not.toBeNull();
  expect(html.indexOf(early![0])).toBeLessThan(html.indexOf(page![0]));
  const code = readFileSync(join(dir, 'assets', early![1]!), 'utf8');
  // everything in one file: the app's early module, the early runtime, the message the early binding calls
  expect(code).not.toMatch(/^\s*import\b|\bimport\(/m);
  expect(code).toMatch(/dataset\.early = ["']yes["']/);
  expect(code).toContain('People');
  expect(code).toContain('not available early');
  // not the page's other helpers, nor the runtime
  expect(code).not.toContain('toUpperCase');
  expect(code).not.toContain('mount(');
  // the build reports the early file's size, and warns over the budget with the largest modules
  expect(logs.find((l) => l.includes('early file of index.html'))).toMatch(/early file of index\.html: assets\/index-early-[\w-]+\.js [\d.]+ kB gzip, over the early budget of 0\.0 kB.*Largest \(before gzip\): /s);
  // `firstPaint: false`: everything waits for the page module
  await build({ root, logLevel: 'silent', resolve: { alias }, build: { outDir: join(dir, 'off'), emptyOutDir: true, minify: false }, plugins: [sinter({ firstPaint: false })] });
  const off = readFileSync(join(dir, 'off', 'index.html'), 'utf8');
  expect(off).not.toContain('early');
  expect(off).not.toContain('blocking');
});

test('first paint in the dev server: the early chunk as a module of its own, before the page module', async () => {
  const server = await createServer({ root, logLevel: 'silent', resolve: { alias }, server: { middlewareMode: true, hmr: false, ws: false }, appType: 'custom', plugins: [sinter()] });
  try {
    const html = await server.transformIndexHtml('/index.html', readFileSync(join(root, 'index.html'), 'utf8'));
    expect(html).toMatch(/<script type="module" src="\/@sinter\/early\/index\.html\.js" blocking="render"><\/script><script type="module" src="\/@sinter\/index\.html\.js"><\/script>/);
    const js = await server.transformRequest('/@sinter/early/index.html.js');
    expect(js?.code).toContain('sinter.early.js');
  } finally {
    await server.close();
  }
});
