// @vitest-environment node
// `data-sn-pages` in a build (docs/static-pages.md#a-page-per-entry): one HTML file per entry of a `file:` glob, at the
// page's pattern filled from the entry, with its canonical link and in the sitemap; the template is no page of its own;
// the Speculation Rules name the pattern once; a path another page has fails the build.
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { build, createServer } from 'vite';
import { afterAll, describe, expect, test } from 'vitest';
import sinter from '../../src/vite.js';

const src = resolve(__dirname, '../../src');
const alias = [{ find: /^@tiaforge-ui\/sinter\/(.+)$/, replacement: `${src}/$1.ts` }, { find: /^@tiaforge-ui\/sinter$/, replacement: `${src}/index.ts` }];
const tmp = mkdtempSync(join(tmpdir(), 'sinter-pages-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

let n = 0;
function app(files: Record<string, string>) {
  const root = join(tmp, `app-${n++}`);
  for (const [f, s] of Object.entries(files)) { mkdirSync(join(root, f, '..'), { recursive: true }); writeFileSync(join(root, f), s); }
  return root;
}
const blog = {
  'content/posts/hello.md': '---\ntitle: Hello\ndate: 2026-11-02\n---\nHi.\n',
  'content/posts/recap.md': '---\ntitle: Recap\ndate: 2026-12-30\n---\nThe year.\n',
  'src/layouts/site-layout.html': '<!doctype html><html lang="en" data-sn-layout="{ title: string }"><head><title data-sn-text="title"></title></head><body><slot></slot></body></html>',
  'blog/post.html': `<site-layout data-sn-path="/blog/:slug" data-sn-pages="post in posts" data-sn-prop="{ title: post.title }">
  <sn-resource name="posts" src="file:/content/posts/*.md" order="-date"></sn-resource>
  <article><h1 data-sn-text="post.title"></h1><time data-sn-text="post.date"></time></article>
</site-layout>`,
  'index.html': `<site-layout data-sn-prop="{ title: 'Blog' }">
  <sn-resource name="posts" src="file:/content/posts/*.md" order="-date"></sn-resource>
  <ul><template data-sn-for="p in posts"><li><a data-sn-attr="{ href: '/blog/' + p.slug }" data-sn-text="p.title"></a></li></template></ul>
</site-layout>`,
};
async function run(root: string, input: string[], o: Parameters<typeof sinter>[0] = {}) {
  let error: string | null = null;
  try {
    await build({ root, logLevel: 'silent', plugins: [sinter({ site: 'https://example.com', speculation: 'prefetch', ...o })], resolve: { alias },
      build: { outDir: join(root, 'dist'), emptyOutDir: true, rollupOptions: { input: Object.fromEntries(input.map((f) => [f.replace(/\.html$/, ''), join(root, f)])) } } });
  } catch (e) { error = String((e as Error).message); }
  const read = (f: string) => readFileSync(join(root, 'dist', f), 'utf8');
  return { error, read, has: (f: string) => existsSync(join(root, 'dist', f)) };
}

describe('data-sn-pages in a build', () => {
  test('a file per entry at its path, its entry folded in, the template not written, no JavaScript', async () => {
    const root = app(blog);
    const r = await run(root, ['index.html', 'blog/post.html']);
    expect(r.error).toBe(null);
    expect(r.has('blog/post.html')).toBe(false);
    const hello = r.read('blog/hello.html');
    expect(hello).toContain('<title>Hello</title>');
    expect(hello).toContain('<h1>Hello</h1><time>2026-11-02</time>');
    expect(hello).toContain('<link rel="canonical" href="https://example.com/blog/hello">');
    expect(hello).not.toContain('<script type="module"');
    expect(r.read('blog/recap.html')).toContain('<h1>Recap</h1>');
    expect(existsSync(join(root, 'dist/assets'))).toBe(false);
    // the index links to them; the sitemap lists them; no rewrite is needed for a file at its path
    expect(r.read('index.html')).toMatch(/<a href="\/blog\/recap">Recap<\/a>.*<a href="\/blog\/hello">Hello<\/a>/s);
    const sitemap = r.read('sitemap.xml');
    expect(sitemap).toContain('<loc>https://example.com/blog/hello</loc>');
    expect(sitemap).toContain('<loc>https://example.com/blog/recap</loc>');
    expect(r.has('_redirects') ? r.read('_redirects') : '').not.toContain('/blog/:slug');
    // the Speculation Rules: the pattern once, not each entry
    const rules = /<script type="speculationrules">(.*?)<\/script>/s.exec(r.read('index.html'))![1]!;
    expect(rules).toContain('"/blog/:slug');
    expect(rules).not.toContain('/blog/hello');
  }, 60_000);

  test('an entry whose path another page has: the build fails, naming both', async () => {
    const root = app({ ...blog, 'blog/hello.html': '<!doctype html><html><head><title>x</title></head><body>mine</body></html>' });
    const r = await run(root, ['index.html', 'blog/post.html', 'blog/hello.html']);
    expect(r.error).toMatch(/blog\/post\.html: the entry at `\/blog\/hello` would be written where `blog\/hello\.html` is \(data-sn-pages\)/);
  }, 60_000);

  test('a link to an entry that does not exist fails the build (SN343), with the one it was likely meant for', async () => {
    const root = app({ ...blog, 'about.html': '<site-layout data-sn-prop="{ title: \'About\' }"><p>See <a href="/blog/helo">the first post</a>, or <a href="/blog/recap?x=1#top">the recap</a>.</p></site-layout>' });
    const r = await run(root, ['index.html', 'blog/post.html', 'about.html']);
    expect(r.error).toMatch(/SN343 broken-entry-link: about\.html links to `\/blog\/helo`, which `\/blog\/:slug` \(blog\/post\.html\) matches, but no entry is there\. Did you mean `\/blog\/hello`\?/);
    expect(r.error).not.toMatch(/recap/);
  }, 60_000);

  test('the declaration\'s errors fail the build (the template is no input to report them)', async () => {
    const root = app({ ...blog, 'blog/post.html': blog['blog/post.html'].replace('data-sn-path="/blog/:slug"', 'data-sn-path="/blog/:year/:slug"') });
    const r = await run(root, ['index.html', 'blog/post.html']);
    expect(r.error).toMatch(/SN341 .*has no `year` to fill `:year`/);
  }, 60_000);

  test('with localePrefix: each language\'s entries, paired by key, with alternates, localeUrl() and a chooser', async () => {
    const root = app({
      'project.inlang/settings.json': JSON.stringify({ baseLocale: 'en', locales: ['en', 'de'] }), 'messages/en.json': '{}', 'messages/de.json': '{}',
      'content/en/posts/hello.md': '---\nid: 1\ntitle: Hello\n---\n', 'content/en/posts/only.md': '---\nid: 2\ntitle: English only\n---\n',
      'content/de/posts/hallo.md': '---\nid: 1\ntitle: Hallo\n---\n',
      'blog/post.html': `<!doctype html><html data-sn-path="/blog/:slug" data-sn-pages="post in posts"><head><title data-sn-text="post.title"></title></head><body>
<sn-resource name="posts" src="file:/content/{$locale}/posts/*.md" key="id"></sn-resource>
<h1 data-sn-text="post.title"></h1><a hreflang="de" data-sn-attr="{ href: localeUrl('de') }">Deutsch</a></body></html>`,
      'index.html': '<!doctype html><html><head><title>x</title></head><body>x</body></html>',
    });
    const r = await run(root, ['index.html', 'blog/post.html'], { localePrefix: true });
    expect(r.error).toBe(null);
    const en = r.read('en/blog/hello.html'), de = r.read('de/blog/hallo.html');
    expect(en).toContain('<h1>Hello</h1>');
    expect(de).toContain('<h1>Hallo</h1>');
    expect(en).toMatch(/<html[^>]* lang="en"/);
    // translations by key: the German page of post 1 is /de/blog/hallo
    expect(en).toContain('<a hreflang="de" href="/de/blog/hallo">Deutsch</a>');
    expect(en).toContain('<link rel="alternate" hreflang="de" href="https://example.com/de/blog/hallo">');
    expect(de).toContain('<link rel="alternate" hreflang="en" href="https://example.com/en/blog/hello">');
    // an entry in one language only: no page in the other, no alternate, no link
    expect(r.has('en/blog/only.html')).toBe(true);
    expect(r.has('de/blog/only.html')).toBe(false);
    expect(r.read('en/blog/only.html')).not.toContain('hreflang="de" href');
    // the chooser at the unprefixed path, to each language's translation (a site with no JavaScript: to the base one)
    const chooser = r.read('blog/hello.html');
    expect(chooser).toContain('<meta http-equiv="refresh" content="0; url=/en/blog/hello">');
    expect(chooser).toContain('<a href="/de/blog/hallo" hreflang="de">de</a>');
    expect(chooser).toContain('noindex');
  }, 60_000);

  test('next-page data: each entry at its own path, with what it requests ahead (one description for all)', async () => {
    const root = app({ ...blog, 'blog/post.html': blog['blog/post.html'].replace('</article>', `</article>
  <sn-resource name="related" src="/api/related?tag={$url.tag}" key="id" items="posts"></sn-resource>
  <ul><template data-sn-for="p in related"><li data-sn-text="p.title"></li></template></ul>`) });
    await run(root, ['index.html', 'blog/post.html'], { prefetch: true });
    const js = readdirSync(join(root, 'dist/assets')).filter((f) => f.endsWith('.js')).map((f) => readFileSync(join(root, 'dist/assets', f), 'utf8')).join('\n').replace(/\s+/g, '');
    // (minified: either quote)
    for (const slug of ['hello', 'recap']) expect(js).toMatch(new RegExp(`m:\\[["\`]/blog/${slug}["\`]\\],r:\\[\\{s:\\[["\`]/api/related\\?tag=["\`],0\\]`));
  }, 60_000);

  test('the dev server: an entry\'s URL is its page', async () => {
    const root = app(blog);
    const server = await createServer({ root, logLevel: 'silent', resolve: { alias }, plugins: [sinter({ site: 'https://example.com' })], server: { port: 0 } });
    await server.listen();
    try {
      const base = server.resolvedUrls!.local[0]!.replace(/\/$/, '');
      const recap = await (await fetch(`${base}/blog/recap`)).text();
      expect(recap).toContain('<h1>Recap</h1>');
      expect(recap).toContain('<title>Recap</title>');
      const hello = await (await fetch(`${base}/blog/hello`)).text();
      expect(hello).toContain('<h1>Hello</h1>');
    } finally { await server.close(); }
  }, 60_000);
});

