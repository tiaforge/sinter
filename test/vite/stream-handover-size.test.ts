// @vitest-environment node
// The stream handover (docs/proposals/stream-handover.md §8) is only in builds with swaps on: the `SWAP` flag of
// the core's flags module is false without them, and the bundler drops the handover and every branch it guards.
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { build } from 'vite';
import { afterAll, expect, test } from 'vitest';
import sinter from '../../src/vite.js';

const src = resolve(__dirname, '../../src');
const alias = [{ find: /^@tiaforge-ui\/sinter\/runtime$/, replacement: `${src}/runtime-entry.ts` }, { find: /^@tiaforge-ui\/sinter\/(?:runtime\/)?(.+)$/, replacement: `${src}/$1.ts` }, { find: /^@tiaforge-ui\/sinter$/, replacement: `${src}/index.ts` }];
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>x</title></head><body>
<sn-resource name="c" src="/api/c" select="c" key="id"></sn-resource>
<sn-sync src="/events"><sn-event name="u" resource="c" op="upsert"></sn-event></sn-sync>
<ul><template data-sn-for="x in c"><li data-sn-text="x.id"></li></template></ul><a href="/b.html">b</a>
</body></html>`;

async function js(swap: boolean) {
  const root = mkdtempSync(join(tmpdir(), 'sinter-stream-size-'));
  dirs.push(root);
  writeFileSync(join(root, 'index.html'), PAGE);
  writeFileSync(join(root, 'b.html'), PAGE);
  await build({
    root, logLevel: 'silent', plugins: [sinter({ swap })], resolve: { alias },
    build: { outDir: join(root, 'dist'), rolldownOptions: { input: { index: join(root, 'index.html'), b: join(root, 'b.html') } } },
  });
  const dir = join(root, 'dist', 'assets');
  return readdirSync(dir).filter((f) => f.endsWith('.js')).map((f) => readFileSync(join(dir, f), 'utf8')).join('\n');
}

test('without swaps, nothing of the handover is in the build; with swaps, it is', async () => {
  const [off, on] = await Promise.all([js(false), js(true)]);
  // the stream feature is in both
  expect(off).toContain('EventSource');
  // the registry's key, and the fields only the handover sets
  for (const mark of ['sinter.streams', '.parked', '.lossy', '.via']) {
    expect(off.includes(mark), mark).toBe(false);
    expect(on.includes(mark), mark).toBe(true);
  }
}, 120_000);
