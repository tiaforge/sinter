// `data-sn-for` on `<html>` (docs/static-pages.md#a-page-per-entry): a page once per entry of a `file:` glob it declares, at its
// `data-sn-path` pattern filled from the entry. Compiled as the template (no `page`), it lists its entries and their
// paths, its entry the list's first; with `page`, it is that entry's page, at its path, everything over it folded.
import { describe, expect, test } from 'vitest';
import { compile } from '../../src/compiler/index.js';

const files: Record<string, string> = {
  'content/posts/hello.md': '---\ntitle: Hello\n---\n# Hi\n',
  'content/posts/recap.md': '---\ntitle: Recap 2026\n---\nThe year.\n',
  'src/layouts/blog-layout.html': '<!doctype html><html lang="en" data-sn-props="{ title: string }"><head><title data-sn-text="title"></title></head><body><slot></slot></body></html>',
};
const build = (html: string, o: Record<string, unknown> = {}, more: Record<string, string> = {}) => compile(html, {
  file: '/p/blog/post.html', root: '/p', dev: false, prerender: true, helpers: { module: null, names: [], namespaces: {} },
  readFile: (f) => { const t = { ...files, ...more }[f.replace(/^\/p\//, '')]; if (t === undefined) throw new Error(`no such file: ${f}`); return t; },
  listFiles: (d) => Object.keys({ ...files, ...more }).map((f) => `/p/${f}`).filter((f) => f.startsWith(d.replace(/\/$/, '') + '/')),
  ...o,
});
const errors = (out: ReturnType<typeof build>) => out.diagnostics.filter((d) => d.severity === 'error').map((d) => `${d.code} ${d.message}`);
const PAGE = `<!doctype html><html lang="en" data-sn-path="/blog/:slug" data-sn-for="post in posts"><head><title data-sn-text="post.title"></title></head><body>
<sn-resource name="posts" src="file:/content/posts/*.md"></sn-resource>
<h1 data-sn-text="post.title"></h1><p data-sn-text="post.body.length"></p>
</body></html>`;

describe('data-sn-for on <html>: a page per entry', () => {
  test('as the template: every entry with the path it fills; its entry is the first', () => {
    const out = build(PAGE);
    expect(errors(out)).toEqual([]);
    expect(out.pages).toEqual({ name: 'post', of: 'posts', pattern: '/blog/:slug', entries: [
      { value: expect.objectContaining({ title: 'Hello', slug: 'hello' }), path: '/blog/hello', key: 'hello' },
      { value: expect.objectContaining({ title: 'Recap 2026', slug: 'recap' }), path: '/blog/recap', key: 'recap' },
    ] });
    expect(out.html).not.toContain('data-sn-for');
    expect(out.html).toContain('<h1>Hello</h1>');
  });

  test('one entry\'s page: at its path, its entry folded into the head and the body, no JavaScript', () => {
    const recap = build(PAGE).pages!.entries[1]!;
    const out = build(PAGE, { page: recap });
    expect(errors(out)).toEqual([]);
    expect(out.path).toEqual(['/blog/recap']);
    expect(out.pages).toBeUndefined();
    expect(out.html).toContain('<title>Recap 2026</title>');
    expect(out.html).toContain('<h1>Recap 2026</h1>');
    expect(out.html).not.toMatch(/data-sn="\d+"/);
    expect(out.runtime).toEqual([]);
    expect(out.diagnostics).toEqual([]);
  });

  test('on a layout\'s tag, as `data-sn-path` is', () => {
    const page = '<blog-layout data-sn-path="/blog/:slug" data-sn-for="post in posts" data-sn-with="{ title: post.title }"><sn-resource name="posts" src="file:/content/posts/*.md"></sn-resource><h1 data-sn-text="post.title"></h1></blog-layout>';
    const out = build(page, { page: build(page).pages!.entries[0]! });
    expect(errors(out)).toEqual([]);
    expect(out.html).toContain('<title>Hello</title>');
    expect(out.html).toContain('<h1>Hello</h1>');
  });

  test('SN340: the declaration', () => {
    const one = (html: string, list = '<sn-resource name="posts" src="file:/content/posts/*.md"></sn-resource>') => errors(build(`<!doctype html><html ${html}><head></head><body>${list}<p data-sn-text="posts.length"></p></body></html>`));
    expect(one('data-sn-for="post in posts"')).toEqual([expect.stringMatching(/^SN340 `data-sn-for` on `<html>` needs `data-sn-path` with exactly one pattern/)]);
    expect(one('data-sn-path="/blog /blog/:slug" data-sn-for="post in posts"')).toEqual([expect.stringMatching(/^SN340 .*exactly one pattern.*\(it is `\/blog \/blog\/:slug`\)/)]);
    expect(one('data-sn-path="/blog/:slug" data-sn-for="posts"')).toEqual([expect.stringMatching(/^SN340 `data-sn-for` on `<html>` takes `<name> in <list>`/)]);
    expect(one('data-sn-path="/blog/:slug" data-sn-for="page in posts"')).toEqual([expect.stringMatching(/^SN340 `page` cannot name the entry: it is a store function/)]);
    expect(one('data-sn-path="/blog/:slug" data-sn-for="post in pots"')).toEqual([expect.stringMatching(/^SN340 `pots` is not a resource of this page/)]);
    expect(one('data-sn-path="/blog/:slug" data-sn-for="post in posts"', '<sn-resource name="posts" src="file:/content/posts/hello.md"></sn-resource>')).toEqual([expect.stringMatching(/^SN340 `posts` is not a build-time list: `data-sn-for` on `<html>` takes a `file:` glob/)]);
    expect(errors(build('<div data-sn-for="post in posts"></div>'))).toEqual([expect.stringMatching(/^SN102 `data-sn-for` must be on a `<template>` \(or on `<html>`: the page once per entry\)/)]);
    expect(one('data-sn-path="/blog/:slug" data-sn-pages="post in posts"')).toEqual([expect.stringMatching(/^SN101 `data-sn-pages` is renamed to `data-sn-for`, on `<html>`/)]);
  });

  test('SN340: an entry that cannot fill the pattern, or two that fill one path', () => {
    const one = (pattern: string, more: Record<string, string>) => errors(build(`<!doctype html><html data-sn-path="${pattern}" data-sn-for="post in posts"><head></head><body><sn-resource name="posts" src="file:/d/**/*.md"></sn-resource><p data-sn-text="post.slug"></p></body></html>`, {}, more));
    expect(one('/blog/:year/:slug', { 'd/a.md': '---\ntitle: A\n---\n' })).toEqual([expect.stringMatching(/^SN340 `d\/a\.md` has no `year` to fill `:year`.*each entry fills `\/blog\/:year\/:slug`/)]);
    expect(one('/blog/:title', { 'd/a.md': '---\ntitle: a/b\n---\n' })).toEqual([expect.stringMatching(/^SN340 `d\/a\.md` has `title` `a\/b`, which is not one path segment/)]);
    expect(one('/blog/:title', { 'd/a.md': '---\ntitle: Same\n---\n', 'd/b.md': '---\ntitle: Same\n---\n' })).toEqual([expect.stringMatching(/^SN340 `d\/b\.md` and `d\/a\.md` would both be `\/blog\/Same`/)]);
    expect(one('/blog/:title', { 'd/a.md': '---\ntitle: A b\n---\n' })).toEqual([]);
    expect(build(`<!doctype html><html data-sn-path="/blog/:title" data-sn-for="post in posts"><head></head><body><sn-resource name="posts" src="file:/d/*.md"></sn-resource></body></html>`, {}, { 'd/a.md': '---\ntitle: A b\n---\n' }).pages!.entries[0]!.path).toBe('/blog/A%20b');
  });

  test('SN345: `$url.<param>` of the pattern reads the entry\'s field through the URL; a query parameter is fine', () => {
    const page = (expr: string) => `<!doctype html><html data-sn-path="/blog/:slug" data-sn-for="post in posts"><head></head><body><sn-resource name="posts" src="file:/content/posts/*.md"></sn-resource><p data-sn-text="${expr}"></p></body></html>`;
    expect(errors(build(page('$url.slug')))).toEqual([expect.stringMatching(/^SN345 `\$url\.slug` on a page per entry \(`data-sn-for` on `<html>`\): .* `:slug` is the entry's field, `post\.slug`/)]);
    expect(errors(build(page('$url.tab ?? post.slug')))).toEqual([]);
  });

  test('SN536 is an error on a page per entry (`data-sn-for` on `<html>`): one long entry would ship its body and the runtime', () => {
    const page = '<!doctype html><html data-sn-path="/blog/:slug" data-sn-for="post in posts"><head></head><body><sn-resource name="posts" src="file:/content/posts/*.md"></sn-resource><ul><template data-sn-for="w in post.body.split(\'\')"><li data-sn-text="w"></li></template></ul></body></html>';
    const out = build(page, { expansionLimit: 3 });
    expect(out.diagnostics.filter((d) => d.code === 'SN536').map((d) => d.severity)).toEqual(['error']);
    // elsewhere, a warning as before
    const plain = build('<!doctype html><html><head></head><body><ul><template data-sn-for="w in \'abcdef\'.split(\'\')"><li data-sn-text="w"></li></template></ul></body></html>', { expansionLimit: 3 });
    expect(plain.diagnostics.filter((d) => d.code === 'SN536').map((d) => d.severity)).toEqual(['warning']);
  });

  test('typed for `sinter check` as one item of its list', () => {
    const r = build(PAGE, { check: true }).check!.resources.find((x) => x.name === 'post')!;
    expect(r.item).toBe('posts');
  });
});
