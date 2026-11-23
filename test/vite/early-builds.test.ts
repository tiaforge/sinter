// @vitest-environment node
// The early scripts of a build (src/vite.ts `generateBundle`): pages whose early source is the same text share one
// nested build, and each page's head script has the bytes it has when its page is built alone; a page whose early
// source differs gets its own build. Every one goes through one Vite builder (one resolved config) per build.
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, expect, test, vi } from 'vitest';

/** the nested early-script builds (`vite.build`, or a builder's `build`, whose input is the early entry), and the builders */
const early = vi.hoisted(() => ({ n: 0, builders: 0 }));
vi.mock('vite', async (orig) => {
  const vite = await orig<typeof import('vite')>();
  const isEarly = (c: import('vite').InlineConfig) => JSON.stringify(c.build?.rolldownOptions?.input ?? c.build?.rollupOptions?.input ?? '').includes('early-entry');
  return {
    ...vite,
    build: (c: import('vite').InlineConfig) => {
      if (isEarly(c)) early.n++;
      return vite.build(c);
    },
    createBuilder: async (c: import('vite').InlineConfig, legacy?: boolean | null) => {
      const b = await vite.createBuilder(c, legacy);
      if (!isEarly(c)) return b;
      early.builders++;
      const build = b.build.bind(b);
      return Object.assign(b, { build: (e: Parameters<typeof build>[0]) => { early.n++; return build(e); } });
    },
  };
});
const { build } = await import('vite');
const { default: sinter } = await import('../../src/vite.js');

const src = resolve(__dirname, '../../src');
const alias = [{ find: /^@tiaforge-ui\/sinter\/runtime$/, replacement: `${src}/runtime-entry.ts` }, { find: /^@tiaforge-ui\/sinter\/(?:runtime\/)?([\w-]+)$/, replacement: `${src}/$1.ts` }, { find: /^@tiaforge-ui\/sinter$/, replacement: `${src}/index.ts` }];
const tmp = mkdtempSync(join(tmpdir(), 'sinter-early-builds-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const page = (api: string) => `<!doctype html><html><head><meta charset="utf-8"><title>x</title></head><body>
<sn-resource name="items" src="${api}?q={$url.q}" select="items" key="id" type="any"></sn-resource>
<ul><template data-sn-for="i in items"><li data-sn-text="i.name"></li></template></ul>
</body></html>
`;
const PAGES: Record<string, string> = { a: page('/api/items'), b: page('/api/items'), c: page('/api/other') };

/** builds `names` of PAGES in one app; each page's head scripts (shared, own) by name, and the nested early builds it ran */
async function site(names: string[]) {
  const root = join(tmp, names.join(''));
  mkdirSync(root, { recursive: true });
  for (const n of names) writeFileSync(join(root, `${n}.html`), PAGES[n]!);
  const before = early.n, builders = early.builders;
  await build({ root, logLevel: 'silent', resolve: { alias }, plugins: [sinter()], build: { outDir: join(root, 'dist'), emptyOutDir: true, rollupOptions: { input: Object.fromEntries(names.map((n) => [n, join(root, `${n}.html`)])) } } });
  const assets = readdirSync(join(root, 'dist/assets'));
  const heads = Object.fromEntries(names.map((n) => {
    const html = readFileSync(join(root, 'dist', n, 'index.html'), 'utf8');
    const own = [...html.matchAll(/<script src="\/assets\/([\w-]+-head-[\w-]+\.js)">/g)].map((m) => m[1]!).find((f) => !f.startsWith('sinter-head-'))!;
    return [n, { file: own, code: readFileSync(join(root, 'dist/assets', own), 'utf8') }];
  }));
  return { heads, builds: early.n - before, builders: early.builders - builders, shared: assets.find((f) => f.startsWith('sinter-head-')) };
}

test('pages with the same early source share one build, with the bytes each has built alone; another source builds apart', async () => {
  const all = await site(['a', 'b', 'c']);
  // the shared head script, a's and b's (one build), c's
  expect(all.builds).toBe(3);
  expect(all.builders).toBe(1);
  expect(all.heads.a!.code).toBe(all.heads.b!.code);
  expect(all.heads.a!.code).not.toBe(all.heads.c!.code);
  expect(all.heads.c!.code).toContain('/api/other');
  for (const n of ['a', 'c']) {
    const alone = await site([n]);
    expect(alone.builds).toBe(2);
    expect(alone.heads[n]).toEqual(all.heads[n]);
  }
}, 120_000);
