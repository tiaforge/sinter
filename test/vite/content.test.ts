// @vitest-environment node
// The content module in a build (docs/resources.md#collections): its collections run once, before any page compiles,
// with `ctx.files`, `ctx.get` and `ctx.env` (from `.env`); a page reads one with `content:` and a page per entry (`data-sn-for` on `<html>`) is
// built from one. A loader that throws, or a result that is not a list of plain data with unique keys, fails the build.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { build } from 'vite';
import { afterAll, describe, expect, test } from 'vitest';
import sinter from '../../src/vite.js';
import { readSnapshot } from '../../src/content-node.js';

const src = resolve(__dirname, '../../src');
const alias = [{ find: /^@tiaforge-ui\/sinter\/(.+)$/, replacement: `${src}/$1.ts` }, { find: /^@tiaforge-ui\/sinter$/, replacement: `${src}/index.ts` }];
const tmp = mkdtempSync(join(tmpdir(), 'sinter-content-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

let n = 0;
async function run(files: Record<string, string>, input: string[], o: Parameters<typeof sinter>[0] = { static: true }) {
  const root = join(tmp, `app-${n++}`);
  for (const [f, s] of Object.entries(files)) { mkdirSync(join(root, f, '..'), { recursive: true }); writeFileSync(join(root, f), s); }
  let error: string | null = null;
  try {
    await build({ root, logLevel: 'silent', plugins: [sinter(o)], resolve: { alias }, build: { outDir: join(root, 'dist'), emptyOutDir: true, rollupOptions: { input: Object.fromEntries(input.map((f) => [f.replace(/\.html$/, ''), join(root, f)])) } } });
  } catch (e) { error = String((e as Error).message); }
  return { root, error, read: (f: string) => readFileSync(join(root, 'dist', f), 'utf8'), has: (f: string) => existsSync(join(root, 'dist', f)) };
}

const CONTENT = `import { collection } from '@tiaforge-ui/sinter/content';
export const posts = collection({ key: 'slug', load: ({ files }) => files('content/posts/*.md', { drafts: 'draft' }) });
export const tags = collection({
  key: 'slug',
  load: async ({ get }) => {
    const by = new Map();
    for (const p of await get(posts)) for (const t of p.tags ?? []) by.set(t, [...(by.get(t) ?? []), p.title]);
    return [...by].map(([slug, titles]) => ({ slug, titles }));
  },
});
export const site = collection({ key: 'id', load: ({ env, command }) => [{ id: 'site', name: env.SITE_NAME, command }] });
`;
const app = {
  '.env': 'SITE_NAME=My blog\n',
  'src/sinter.content.ts': CONTENT,
  'content/posts/hello.md': '---\ntitle: Hello\ntags: [news, intro]\n---\nHi.\n',
  'content/posts/recap.md': '---\ntitle: Recap\ntags: [news]\n---\nThe year.\n',
  'content/posts/wip.md': '---\ntitle: Soon\ndraft: true\n---\n',
  'index.html': '<!doctype html><html><head><title>x</title></head><body><sn-resource name="site" src="content:site"></sn-resource><sn-resource name="tags" src="content:tags" order="slug"></sn-resource><h1 data-sn-text="site[0].name + \' (\' + site[0].command + \')\'"></h1><ul><template data-sn-for="t in tags"><li data-sn-text="t.slug + \': \' + t.titles.join(\', \')"></li></template></ul></body></html>',
  'tag.html': '<!doctype html><html data-sn-path="/tag/:slug" data-sn-for="tag in tags"><head><title data-sn-text="tag.slug"></title></head><body><sn-resource name="tags" src="content:tags"></sn-resource><p data-sn-text="tag.titles.length"></p></body></html>',
};

describe('the content module in a build', () => {
  test('collections run before the pages: ctx.files with drafts, ctx.get, ctx.env from .env, ctx.command', async () => {
    const r = await run(app, ['index.html', 'tag.html']);
    expect(r.error).toBe(null);
    expect(r.read('index.html')).toContain('<h1>My blog (build)</h1>');
    expect(r.read('index.html')).toMatch(/<li>intro: Hello<\/li><li>news: Hello, Recap<\/li>/);
    // a page per tag, from a collection
    expect(r.read('tag/news.html')).toContain('<p>2</p>');
    expect(r.read('tag/intro.html')).toContain('<p>1</p>');
    expect(r.has('tag.html')).toBe(false);
  }, 60_000);

  test('a loader that throws, a result that is not a list, a Date, a duplicate key, an export that is no collection: the build fails, naming them', async () => {
    const bad = `import { collection } from '@tiaforge-ui/sinter/content';
export const a = collection({ key: 'id', load: async () => { throw new Error('CMS: 503 at https://cms.example.com/x?token=s3cr3t-value'); } });
export const b = collection({ key: 'id', load: () => ({ id: 1 }) });
export const c = collection({ key: 'id', load: () => [{ id: 1, at: new Date(0) }] });
export const d = collection({ key: 'id', load: () => [{ id: 1 }, { id: 1 }] });
export const helper = (x) => x;
`;
    const r = await run({ 'src/sinter.content.ts': bad, 'index.html': '<!doctype html><html><head><title>x</title></head><body>x</body></html>' }, ['index.html']);
    expect(r.error).toMatch(/`helper` is exported but not a collection/);
    expect(r.error).toMatch(/collection `a`: CMS: 503 at https:\/\/cms\.example\.com\/x\?…/);
    expect(r.error).not.toContain('s3cr3t');
    expect(r.error).toMatch(/collection `b`: its loader returned object, not a list/);
    expect(r.error).toMatch(/collection `c`: entry 0 is not plain data: `at` is a Date \(return `toISOString\(\)`\)/);
    expect(r.error).toMatch(/collection `d`: entries 0 and 1 have one `id`, `1`/);
  }, 60_000);

  test('the build writes the snapshot `sinter check` and the editor read; it is stale once the module changes', async () => {
    const r = await run(app, ['index.html']);
    expect(r.error).toBe(null);
    const snap = readSnapshot(r.root, join(r.root, 'src/sinter.content.ts'))!;
    expect(snap.stale).toBe(false);
    expect((snap.collections.get('site')!.value[0] as { name: string }).name).toBe('My blog');
    expect(snap.collections.get('posts')!.value.map((p) => (p as { slug: string }).slug)).toEqual(['hello', 'recap']);
    const later = new Date(Date.now() + 5000);
    const { utimesSync } = await import('node:fs');
    utimesSync(join(r.root, 'src/sinter.content.ts'), later, later);
    expect(readSnapshot(r.root, join(r.root, 'src/sinter.content.ts'))!.stale).toBe(true);
  }, 60_000);

  test('perLocale: a collection loaded once per language, each language\'s pages reading its own', async () => {
    const lang = { 'project.inlang/settings.json': JSON.stringify({ baseLocale: 'en', locales: ['en', 'de'] }), 'messages/en.json': '{}', 'messages/de.json': '{}' };
    const content = `import { collection } from '@tiaforge-ui/sinter/content';
const names = { en: ['Bolt', 'Anchor'], de: ['Bolzen', 'Anker'] };
export const products = collection({ key: 'sku', perLocale: true, load: ({ locale }) => names[locale].map((name, i) => ({ sku: 'p' + i, name })) });
`;
    const page = '<!doctype html><html><head><title>x</title></head><body><sn-resource name="products" src="content:products"></sn-resource><p data-sn-text="products.map((p) => p.name).join(\', \')"></p></body></html>';
    const r = await run({ ...lang, 'src/sinter.content.ts': content, 'index.html': page }, ['index.html'], { localePrefix: true });
    expect(r.error).toBe(null);
    expect(r.read('en/index.html')).toContain('<p>Bolt, Anchor</p>');
    expect(r.read('de/index.html')).toContain('<p>Bolzen, Anker</p>');
    // `sinter check` and the editor see the base language's
    expect((readSnapshot(r.root, join(r.root, 'src/sinter.content.ts'))!.collections.get('products')!.value[0] as { name: string }).name).toBe('Bolt');
    // a shared collection built from a per-language one, and perLocale without languages: errors
    const shared = content + "export const all = collection({ key: 'sku', load: ({ get }) => get(products) });\n";
    expect((await run({ ...lang, 'src/sinter.content.ts': shared, 'index.html': page }, ['index.html'], { localePrefix: true })).error).toMatch(/collection `all`: it gets `products`, which is loaded per language \(`perLocale`\): make it `perLocale: true` too/);
    expect((await run({ 'src/sinter.content.ts': content, 'index.html': page }, ['index.html'])).error).toMatch(/collection `products`: it is loaded per language .* needs `sinter\(\{ localePrefix \}\)`/);
  }, 120_000);

  test('chunks(): an index in pages, as a collection and a data-sn-pages page', async () => {
    const content = `import { collection, chunks } from '@tiaforge-ui/sinter/content';
export const posts = collection({ key: 'slug', load: ({ files }) => files('content/posts/*.md') });
export const postPages = collection({ key: 'n', load: async ({ get }) => chunks(await get(posts), 2) });
`;
    const files: Record<string, string> = { 'src/sinter.content.ts': content };
    for (const t of ['a', 'b', 'c', 'd', 'e']) files[`content/posts/${t}.md`] = `---\ntitle: ${t.toUpperCase()}\n---\n`;
    files['archive.html'] = '<!doctype html><html data-sn-path="/blog/page/:n" data-sn-for="p in postPages"><head><title data-sn-text="\'Page \' + p.n"></title></head><body><sn-resource name="postPages" src="content:postPages"></sn-resource><ul><template data-sn-for="post in p.items"><li data-sn-text="post.title"></li></template></ul><i data-sn-text="p.n + \'/\' + p.count"></i></body></html>';
    const r = await run(files, ['archive.html']);
    expect(r.error).toBe(null);
    expect(r.read('blog/page/1.html')).toMatch(/<li>A<\/li><li>B<\/li><\/ul><i>1\/3<\/i>/);
    expect(r.read('blog/page/3.html')).toMatch(/<li>E<\/li><\/ul><i>3\/3<\/i>/);
  }, 60_000);
});

