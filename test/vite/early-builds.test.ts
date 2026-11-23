// @vitest-environment node
// The early scripts of a build (src/vite.ts `generateBundle`): pages whose early source is the same text share one
// nested build, and each page's head script has the bytes it has when its page is built alone; a page whose early
// source differs gets its own build. Every one goes through one Vite builder (one resolved config) per build. Pages whose
// early sources differ only in literals share one build of their shape (src/early-shapes.ts), and each still gets the
// bytes of its own build; the shapes' rules are tested on the bundler directly at the end.
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { afterAll, beforeAll, expect, test, vi } from 'vitest';

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
const walk = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)]));
const tmp = mkdtempSync(join(tmpdir(), 'sinter-early-builds-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
// the counts below are the builds without the self-check (`SN_EARLY_SHAPES_AUDIT=1` builds every page from its own source)
const audit = process.env.SN_EARLY_SHAPES_AUDIT;
beforeAll(() => { delete process.env.SN_EARLY_SHAPES_AUDIT; });
afterAll(() => { if (audit !== undefined) process.env.SN_EARLY_SHAPES_AUDIT = audit; });

const page = (api: string) => `<!doctype html><html><head><meta charset="utf-8"><title>x</title></head><body>
<sn-resource name="items" src="${api}?q={$url.q}" select="items" key="id" type="any"></sn-resource>
<ul><template data-sn-for="i in items"><li data-sn-text="i.name"></li></template></ul>
</body></html>
`;
const PAGES: Record<string, string> = {
  a: page('/api/items'), b: page('/api/items'), c: page('/api/other'),
  // one shape, a literal apart (the same length), and one whose program differs
  s1: page('/api/item-aa'), s2: page('/api/item-bb'), s3: page('/api/item-cc'), s4: page('/api/item-dd'), s5: page('/api/item-ee'),
  s6: page('/api/item-ff'), t: page('/api/item-gg').replace('?q={$url.q}', '?q={$url.q}&amp;r={$url.r}'),
};

/** builds `names` of PAGES in one app; each page's head scripts (shared, own) by name, and the nested early builds it ran */
async function site(names: string[], tag = '') {
  const root = join(tmp, names.join('') + tag);
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
  const files = Object.fromEntries(walk(join(root, 'dist')).map((f) => [relative(root, f), readFileSync(f, 'utf8')]));
  return { heads, files, builds: early.n - before, builders: early.builders - builders, shared: assets.find((f) => f.startsWith('sinter-head-')) };
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

test('pages whose early sources differ in one literal share one build of their shape, each with the bytes of its own', async () => {
  const names = ['s1', 's2', 's3', 's4', 's5', 's6', 't'];
  const all = await site(names);
  // the shared head script; the shape once and its first two pages from their own source (the check); t apart
  expect(all.builds).toBe(5);
  expect(all.builders).toBe(1);
  expect(all.heads.s1!.code).toContain('/api/item-aa');
  expect(all.heads.s6!.code).toContain('/api/item-ff');
  for (const n of ['s3', 's6', 't']) {
    const alone = await site([n]);
    expect(alone.builds).toBe(2);
    expect(alone.heads[n]).toEqual(all.heads[n]);
  }
  // with the sharing off, a build of its own per source and the same files
  process.env.SN_EARLY_SHAPES = '0';
  try {
    const off = await site(names, '-off');
    expect(off.builds).toBe(8);
    expect(off.files).toEqual(all.files);
  } finally {
    delete process.env.SN_EARLY_SHAPES;
  }
}, 120_000);

// The shapes' rules on the bundler itself (Rolldown, minified, one IIFE, as an early script is): every page's script
// must be what its own source builds to, and the counts say which pages shared a build.
const { rolldown } = await import('rolldown');
const { shareBuilds, shapeStats, cut } = await import('../../src/early-shapes.js');
const mini = async (code: string) => {
  const b = await rolldown({ input: 'e', plugins: [{ name: 'e', resolveId: (id) => (id === 'e' ? id : null), load: (id) => (id === 'e' ? code : null) }] });
  const c = (await b.generate({ format: 'iife', minify: true })).output[0];
  return { code: c.code, map: null, modules: c.modules as Record<string, { renderedLength: number; code?: string | null }>, keys: new Set<string>() };
};
/** each source's script through `shareBuilds` against its own build; the nested builds run and the fallbacks by reason */
async function shapes(srcs: string[]) {
  const builds = shapeStats.builds, falls = new Map(shapeStats.fallbacks);
  const got = await shareBuilds(srcs.map((src, i) => ({ src, extra: '', what: `p${i}` })), (src) => mini(src));
  for (const [i, src] of srcs.entries()) expect(got[i]!.code).toBe((await mini(src)).code);
  return { builds: shapeStats.builds - builds, fell: Object.fromEntries([...shapeStats.fallbacks].map(([k, n]) => [k, n - (falls.get(k) ?? 0)]).filter(([, n]) => n)) };
}
const of = (f: (i: number) => string, n = 6) => Array.from({ length: n }, (_, i) => f(i + 1));

test('each kind of literal shares a build: identifiers, integers and other strings of one length, numbers', async () => {
  // a string that is an identifier (an object key and a member become `.k`), a canonical integer (`x["12"]` is `x[12]`),
  // one led by a digit, any other; and a number, with or without trailing zeros
  for (const src of [
    of((i) => `globalThis.x = [f("alpha${i}"), ({ "key${i}": 1 }), g["name${i}"]];`),
    of((i) => `globalThis.x = [f("100${i}"), g["100${i}"]];`),
    of((i) => `globalThis.x = f("2024-01-0${i}");`),
    of((i) => `globalThis.x = f("/api/comments?post=post-${i}");`),
    of((i) => `globalThis.x = [f(123${i}), f(12${i}0)];`),
    // a value twice (one placeholder for both), and concatenated with the shape's own literal at build time
    of((i) => `globalThis.x = [f("ab-${i}", "ab-${i}"), "/api/" + "ab-${i}"];`),
    // the early script's form: a folded read in a function of the table, a URL built from it
    of((i) => `const f = [($) => ((("post-${i}"))), ($) => ({})]; globalThis.req = (q, n) => q(() => "/api/comments" + h([["post", f[0](n[0])]]));`),
  ]) expect(await shapes(src)).toEqual({ builds: 3, fell: {} });
  expect(cut('f("a\\u0041b-1")')!.lits[0]!.kind).toBe(null);
}, 60_000);

test('a page falls back to its own build where a literal is not lifted, has another kind, or the shape differs', async () => {
  // computed with: a member of the literal, a comparison, arithmetic on a number, a `case`, a binding's initializer
  for (const src of [
    of((i) => `globalThis.x = "ab-0${i}".indexOf("-");`),
    of((i) => `globalThis.x = g === "ab-0${i}";`),
    of((i) => `globalThis.x = 123${i} + 1;`),
    of((i) => `switch (g) { case "ab-0${i}": h(); }`),
    of((i) => `const a = "ab-0${i}"; globalThis.x = a;`),
  ]) expect(await shapes(src)).toEqual({ builds: 6, fell: { 'a literal not lifted: a literal a minifier may compute with': 6 } });
  // a string that needs escaping, one too short, a number of one digit, one printed with an exponent
  expect(await shapes(of((i) => `globalThis.x = f("ab'${i}");`))).toEqual({ builds: 6, fell: { 'a literal not lifted: a string with characters that need escaping': 6 } });
  expect(await shapes(of((i) => `globalThis.x = f(${i});`))).toEqual({ builds: 6, fell: { 'a literal not lifted: a one-digit number': 6 } });
  expect(await shapes(of((i) => `globalThis.x = f(${i}000);`))).toEqual({ builds: 6, fell: { 'a literal not lifted: a number printed with an exponent': 6 } });
  // the minifier carries a passed literal into a computation (through an array): the check sees the difference
  // and the rest of the shape is built page by page
  expect(await shapes(of((i) => `globalThis.x = ["ab-0${i}"][0].indexOf("-");`))).toEqual({ builds: 7, fell: { 'differs from its own build once written': 5 } });
  // another length is another kind: four pages of one, two of the other (too few to share)
  expect(await shapes([...of((i) => `globalThis.x = f("ab-${i}");`, 4), 'globalThis.x = f("ab-10");', 'globalThis.x = f("ab-11");'])).toEqual({ builds: 5, fell: { 'a kind of literal with fewer than 4 pages': 2 } });
  // two values that are equal on one page and not on the others
  expect(await shapes([...of((i) => `globalThis.x = f("ab-${i}", "cd-${i}");`, 4), 'globalThis.x = f("ab-9", "ab-9");'])).toEqual({ builds: 4, fell: { 'a kind of literal with fewer than 4 pages': 1 } });
  // a page whose program differs is a shape of its own
  expect(await shapes([...of((i) => `globalThis.x = f("ab-${i}");`, 4), 'globalThis.x = g("ab-9");'])).toEqual({ builds: 4, fell: {} });
}, 60_000);
