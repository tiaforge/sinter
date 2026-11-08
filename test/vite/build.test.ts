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

const alias = ['sse', 'optimistic', 'paginate', 'persist']
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

test('first paint: build-time values in the HTML, the locale data and the first-paint script as an asset', async () => {
  const dir = join(out, 'first-paint');
  await build({
    root, logLevel: 'silent', resolve: { alias }, build: { outDir: dir, emptyOutDir: true, minify: false },
    plugins: [sinter({ locale: { locales: ['en', 'de'], storage: 'locale', use: 'src/i18n/locale.js#setLocale' } })],
  });
  const html = readFileSync(join(dir, 'index.html'), 'utf8');
  expect(html).toContain('<h1 data-sn="1">People</h1>');
  expect(html).toContain('<p data-sn="2">Hello</p>');
  expect(html).toMatch(/<script type="application\/json" id="sn-first-paint">\{"l":\{"locales":\["en","de"\],"storage":"locale"\},"t":\{"de":\[\[2,"text",null,"Hallo"\]\]\}\}<\/script>/);
  const script = /<script src="\/assets\/(sinter-first-paint-[0-9a-f]{8}\.js)" defer="" blocking="render"\s*><\/script>/.exec(html);
  expect(script).not.toBeNull();
  expect(html.indexOf(script![0])).toBeLessThan(html.indexOf('<script type="module"'));
  expect(readFileSync(join(dir, 'assets', script![1]!), 'utf8')).toContain('sinter first paint');
  // the page bundle is not render-blocking
  expect(html).not.toMatch(/<script type="module"[^>]*blocking/);
  // `firstPaint: false`: everything waits for the page module
  await build({ root, logLevel: 'silent', resolve: { alias }, build: { outDir: join(dir, 'off'), emptyOutDir: true, minify: false }, plugins: [sinter({ firstPaint: false })] });
  const off = readFileSync(join(dir, 'off', 'index.html'), 'utf8');
  expect(off).toContain('<h1 data-sn="1"></h1>');
  expect(off).not.toContain('first-paint');
});

test('first paint in the dev server: the helpers through the server, the script as a module of its own', async () => {
  const server = await createServer({
    root, logLevel: 'silent', resolve: { alias }, server: { middlewareMode: true, hmr: false, ws: false }, appType: 'custom',
    plugins: [sinter({ locale: { locales: ['en', 'de'], use: 'src/i18n/locale.js#setLocale' } })],
  });
  try {
    const html = await server.transformIndexHtml('/index.html', readFileSync(join(root, 'index.html'), 'utf8'));
    expect(html).toContain('<p data-sn="2">Hello</p>');
    expect(html).toContain('<script src="/@sinter/first-paint.js" defer="" blocking="render"');
    const js = await server.transformRequest('/@sinter/first-paint.js');
    expect(js?.code).toContain('sinter first paint');
  } finally {
    await server.close();
  }
});

test('the locale option is checked', () => {
  expect(() => sinter({ locale: { locales: [] } })).toThrow(/`locales` is a non-empty list/);
  expect(() => sinter({ locale: { locales: ['en'], store: 'x' } as never })).toThrow(/`store` is not an option/);
});
