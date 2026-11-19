// @vitest-environment node
// What a build reads once (src/vite.ts: `buildReads`, `buildProject`): the project's files its compiles read and the
// project itself are kept for one build, so every page does not read every component again. Under `vite build
// --watch` each build starts afresh: a changed component, a changed `file:` source and a new component all show.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { build } from 'vite';
import { afterAll, expect, test } from 'vitest';
import sinter from '../../src/vite.js';

const src = resolve(__dirname, '../../src');
const alias = [{ find: /^@tiaforge-ui\/sinter\/(.+)$/, replacement: `${src}/$1.ts` }, { find: /^@tiaforge-ui\/sinter$/, replacement: `${src}/index.ts` }];
const tmp = mkdtempSync(join(tmpdir(), 'sinter-build-caches-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const page = (body: string) => `<!doctype html><html><head><title>x</title></head><body>${body}</body></html>`;

test('two pages that use one component and one file: both get them, read once per build', async () => {
  const root = join(tmp, 'two');
  const put = (f: string, s: string) => { mkdirSync(join(root, f, '..'), { recursive: true }); writeFileSync(join(root, f), s); };
  put('src/components/site-note.html', '<template data-sn-props="{ text: string }"><aside class="note" data-sn-text="text"></aside></template>');
  put('intro.txt', 'Hello');
  for (const p of ['a', 'b']) put(`${p}.html`, page(`<sn-resource name="intro" src="file:./intro.txt"></sn-resource><site-note data-sn-prop="{ text: intro + ' ${p}' }"></site-note>`));
  await build({ root, logLevel: 'silent', plugins: [sinter({ static: true })], resolve: { alias }, build: { outDir: join(root, 'dist'), emptyOutDir: true, rollupOptions: { input: { a: join(root, 'a.html'), b: join(root, 'b.html') } } } });
  expect(readFileSync(join(root, 'dist/a/index.html'), 'utf8')).toContain('<aside class="note">Hello a</aside>');
  expect(readFileSync(join(root, 'dist/b/index.html'), 'utf8')).toContain('<aside class="note">Hello b</aside>');
}, 60_000);

test('under `vite build --watch`, each build reads afresh: a changed component, a changed file, a new component', async () => {
  const root = join(tmp, 'watch');
  const put = (f: string, s: string) => { mkdirSync(join(root, f, '..'), { recursive: true }); writeFileSync(join(root, f), s); };
  put('src/components/site-note.html', '<template data-sn-props="{ text: string }"><aside class="note" data-sn-text="text"></aside></template>');
  put('intro.txt', 'one');
  put('index.html', page('<sn-resource name="intro" src="file:./intro.txt"></sn-resource><site-note data-sn-prop="{ text: intro }"></site-note>'));
  const watcher = await build({ root, logLevel: 'silent', plugins: [sinter({ static: true })], resolve: { alias }, build: { outDir: join(root, 'dist'), emptyOutDir: true, watch: {} } }) as unknown as { on(e: string, f: (ev: { code: string; error?: Error }) => void): void; close(): Promise<void> };
  const builds: string[] = [];
  let waiting: { done: () => void; fail: (e: unknown) => void } | null = null;
  watcher.on('event', (ev) => {
    if (ev.code === 'ERROR') waiting?.fail(ev.error);
    if (ev.code === 'END') { builds.push(readFileSync(join(root, 'dist/index.html'), 'utf8')); waiting?.done(); }
  });
  const seen = { n: 0 };
  const next = () => new Promise<void>((done, fail) => {
    const want = ++seen.n;
    if (builds.length >= want) return done();
    waiting = { done: () => { if (builds.length >= want) { waiting = null; done(); } }, fail };
  });
  try {
    await next();
    // the component and the file change; the page is touched so that the watcher rebuilds it
    put('src/components/site-note.html', '<template data-sn-props="{ text: string }"><aside class="changed" data-sn-text="text"></aside></template>');
    put('intro.txt', 'two');
    put('index.html', page('<sn-resource name="intro" src="file:./intro.txt"></sn-resource><site-note data-sn-prop="{ text: intro }"></site-note><!-- 2 -->'));
    await next();
    // a component that did not exist in the last build
    put('src/components/site-badge.html', '<template data-sn-props><b class="badge">new</b></template>');
    put('index.html', page('<sn-resource name="intro" src="file:./intro.txt"></sn-resource><site-note data-sn-prop="{ text: intro }"></site-note><site-badge></site-badge>'));
    await next();
  } finally { await watcher.close(); }
  expect(builds[0]).toContain('<aside class="note">one</aside>');
  expect(builds[1]).toContain('<aside class="changed">two</aside>');
  expect(builds[2]).toContain('<b class="badge">new</b>');
}, 120_000);
