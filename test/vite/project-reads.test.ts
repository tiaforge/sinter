// @vitest-environment node
// A build reads the project (src/project.ts `project()`: the components, the libraries, the helpers' manifest) once for
// its config phase (the content module, the template probe) and once at its start, which its pages share; under
// `vite build --watch`, each rebuild reads it again at its start, so an edit counts.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, expect, test, vi } from 'vitest';

const reads = vi.hoisted(() => ({ n: 0 }));
vi.mock('../../src/project.js', async (orig) => {
  const m = await orig<typeof import('../../src/project.js')>();
  return { ...m, project: (...a: Parameters<typeof m.project>) => { reads.n++; return m.project(...a); } };
});
const { build } = await import('vite');
const { default: sinter } = await import('../../src/vite.js');

const src = resolve(__dirname, '../../src');
const alias = [{ find: /^@tiaforge-ui\/sinter\/runtime$/, replacement: `${src}/runtime-entry.ts` }, { find: /^@tiaforge-ui\/sinter\/(?:runtime\/)?([\w-]+)$/, replacement: `${src}/$1.ts` }, { find: /^@tiaforge-ui\/sinter$/, replacement: `${src}/index.ts` }];
const tmp = mkdtempSync(join(tmpdir(), 'sinter-project-reads-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

test('a build with a page per entry reads the project twice; a rebuild once more, and sees the edit', async () => {
  const root = join(tmp, 'app');
  mkdirSync(join(root, 'src/components'), { recursive: true });
  writeFileSync(join(root, 'src/sinter.helpers.ts'), 'export const up = (s: string) => s.toUpperCase();\n');
  writeFileSync(join(root, 'src/components/x-tag.html'), '<template><b>one</b></template>');
  mkdirSync(join(root, 'content/posts'), { recursive: true });
  for (const p of ['a', 'b', 'c']) writeFileSync(join(root, `content/posts/${p}.md`), `---\ntitle: ${p}\n---\nHi.\n`);
  writeFileSync(join(root, 'post.html'), `<!doctype html><html data-sn-for="post in posts" data-sn-path="/p/:slug"><head><title>x</title></head><body>
<sn-resource name="posts" src="file:/content/posts/*.md"></sn-resource><x-tag></x-tag><p data-sn-text="up(post.title)"></p></body></html>`);
  reads.n = 0;
  await build({ root, logLevel: 'silent', resolve: { alias }, plugins: [sinter({ static: true })], build: { outDir: join(root, 'dist'), emptyOutDir: true, rollupOptions: { input: { post: join(root, 'post.html') } } } });
  expect(reads.n).toBe(2);
  expect(readFileSync(join(root, 'dist/p/b.html'), 'utf8')).toContain('<b>one</b><p>B</p>');

  // a plain page beside it, which the rebuild is for
  writeFileSync(join(root, 'index.html'), '<!doctype html><html><head><title>i</title></head><body><p>i</p></body></html>');
  reads.n = 0;
  const watcher = await build({ root, logLevel: 'silent', resolve: { alias }, plugins: [sinter({ static: true })], build: { outDir: join(root, 'dist'), emptyOutDir: true, watch: {}, rollupOptions: { input: { post: join(root, 'post.html'), index: join(root, 'index.html') } } } }) as unknown as { on(e: string, f: (ev: { code: string; error?: Error }) => void): void; close(): Promise<void> };
  const ends: number[] = [];
  let wake: (() => void) | null = null, fail: ((e: unknown) => void) | null = null;
  watcher.on('event', (ev) => { if (ev.code === 'ERROR') fail?.(ev.error); if (ev.code === 'END') { ends.push(reads.n); wake?.(); } });
  const builds = (k: number) => new Promise<void>((done, f) => { fail = f; if (ends.length >= k) done(); else wake = () => { if (ends.length >= k) done(); }; });
  try {
    await builds(1);
    writeFileSync(join(root, 'src/components/x-tag.html'), '<template><b>two</b></template>');
    writeFileSync(join(root, 'index.html'), '<!doctype html><html><head><title>i</title></head><body><x-tag></x-tag></body></html>');
    await builds(2);
  } finally { await watcher.close(); }
  expect(ends).toEqual([2, 3]);
  expect(readFileSync(join(root, 'dist/p/b.html'), 'utf8')).toContain('<b>two</b><p>B</p>');
}, 120_000);
