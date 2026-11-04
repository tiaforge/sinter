// @vitest-environment node
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { build } from 'vite';
import { afterAll, expect, test } from 'vitest';
import sinter from '../../src/vite.js';

const root = resolve(__dirname, '../fixtures/vite-app');
const src = resolve(__dirname, '../../src');
const out = mkdtempSync(join(tmpdir(), 'sinter-vite-'));
afterAll(() => rmSync(out, { recursive: true, force: true }));

const alias = ['sse', 'optimistic', 'paginate', 'persist']
  .map((f) => ({ find: `@tiaforge/sinter/${f}`, replacement: `${src}/${f}.ts` }))
  .concat([{ find: '@tiaforge/sinter', replacement: `${src}/index.ts` }]);

async function run(outDir: string) {
  return build({ root, logLevel: 'silent', plugins: [sinter()], resolve: { alias }, build: { outDir, emptyOutDir: true, minify: false } });
}

test('builds a page: rewritten HTML, page module, helpers and namespace members', async () => {
  await run(out);
  const html = readFileSync(join(out, 'index.html'), 'utf8');
  expect(html).not.toContain('data-sn-');
  expect(html).not.toContain('sn-resource');
  expect(html).toMatch(/<script type="module" crossorigin src="\/assets\/[^"]+\.js"><\/script>/);
  const js = readdirSync(join(out, 'assets')).filter((f) => f.endsWith('.js')).map((f) => readFileSync(join(out, 'assets', f), 'utf8')).join('\n');
  expect(js).toContain('People');
  expect(js).toContain('toUpperCase');
  expect(js).toContain('X-Sinter');
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
