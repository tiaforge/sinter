// `data-sn-pages` in a build (compile's `templates`): a template's first pass is walked once and kept, and each entry
// is only evaluated again before its second pass. Every entry's page must be what it is compiled on its own: its HTML,
// module, early script, diagnostics and the helper calls it logs. Some templates cannot share their walk (an entry's URL
// in the program) and some entries are compiled the usual way (nothing to decide, constants for the layout, errors).
import { describe, expect, test } from 'vitest';
import { compile, type ImageHost, type ImageInfo } from '../../src/compiler/index.js';
import type { FoldVerdict } from '../../src/fold-check.js';

const posts: Record<string, string> = {
  'content/posts/a.md': '---\ntitle: Alpha\ndraft: true\ntags: []\n---\nFirst.\n',
  'content/posts/b.md': '---\ntitle: Beta\ndraft: false\ntags: [x]\n---\nSecond.\n',
  'content/posts/c.md': '---\ntitle: Gamma\ndraft: false\ntags: [x, y, z]\n---\nThird.\n',
};
// a tree per entry, rendered by components that use each other (shared definitions in the first pass)
const docs: Record<string, string> = {
  'content/docs/one.json': JSON.stringify({ slug: 'one', doc: { children: [{ type: 'text', value: 'plain' }] } }),
  'content/docs/two.json': JSON.stringify({ slug: 'two', doc: { children: [{ type: 'link', url: '/a', children: [{ type: 'text', value: 'a' }, { type: 'link', url: '/b', children: [{ type: 'text', value: 'b' }] }] }] } }),
  'content/docs/three.json': JSON.stringify({ slug: 'three', doc: { children: [] } }),
};
const INL = "{ text: 'x-text', link: 'x-link' }";
const components: Record<string, string> = {
  'x-doc': `<template data-sn-component="{ doc: any }"><div><template data-sn-for="n in doc.children"><sn-component use="${INL}[n.type]" data-sn-prop="{ node: n }"></sn-component></template></div></template>`,
  'x-text': '<template data-sn-component="{ node: any }"><span data-sn-text="node.value"></span></template>',
  'x-link': `<template data-sn-component="{ node: any }"><a data-sn-attr="{ href: node.url }"><template data-sn-for="n in node.children"><sn-component use="${INL}[n.type]" data-sn-prop="{ node: n }"></sn-component></template></a></template>`,
};
// a tree with images: a post with one, and posts without
const IMG = "{ text: 'x-text', image: 'x-image' }";
components['x-idoc'] = `<template data-sn-component="{ doc: any }"><div><template data-sn-for="n in doc.children"><sn-component use="${IMG}[n.type]" data-sn-prop="{ node: n }"></sn-component></template></div></template>`;
components['x-image'] = '<template data-sn-component="{ node: any }"><img data-sn-attr="{ src: node.url, alt: node.alt }"></template>';
const idocs: Record<string, string> = {
  'content/idocs/one.json': JSON.stringify({ slug: 'one', doc: { children: [{ type: 'text', value: 'no image' }] } }),
  'content/idocs/two.json': JSON.stringify({ slug: 'two', doc: { children: [{ type: 'image', url: '/img/photo.jpg', alt: 'A photo' }] } }),
  'content/idocs/three.json': JSON.stringify({ slug: 'three', doc: { children: [{ type: 'text', value: 'none either' }] } }),
};
const photo: ImageInfo = { width: 1600, height: 1067, alpha: false, kind: 'photo', color: '#8a7f6e', bytes: 200_000, hash: 'abc' };
const host: ImageHost = { info: (f) => (f === '/p/img/photo.jpg' ? photo : undefined), url: (v) => `/i/photo-${v.width}.${v.format}`, stylesheet: '/@sinter/img/post.css' };
const files: Record<string, string> = { ...posts, ...docs, ...idocs };
for (const [k, s] of Object.entries(components)) files[`src/components/${k}.html`] = s;

type Options = Parameters<typeof compile>[1];
const base = (o: Partial<Options>): Options => ({
  file: '/p/blog/post.html', root: '/p', dev: false, prerender: true, componentNames: Object.keys(components),
  helpers: { module: null, names: [], namespaces: {} },
  readFile: (f) => { const t = files[f.replace(/^\/p\//, '')]; if (t === undefined) throw new Error(`no such file: ${f}`); return t; },
  listFiles: (d) => Object.keys(files).map((f) => `/p/${f}`).filter((f) => f.startsWith(d.replace(/\/$/, '') + '/')),
  ...o,
} as Options);
const page = (body: string, list = 'file:/content/posts/*.md', name = 'post', of = 'posts') => `<!doctype html><html lang="en" data-sn-path="/blog/:slug" data-sn-pages="${name} in ${of}"><head><title data-sn-text="${name}.slug"></title></head><body>
<sn-resource name="${of}" src="${list}"></sn-resource>
${body}
</body></html>`;

/** each entry compiled on its own and with the template kept: what each gives, and how many entries shared the walk */
function both(html: string, o: Partial<Options> = {}, perEntry: (e: { path: string }) => Partial<Options> = () => ({})) {
  const entries = compile(html, base(o)).pages!.entries;
  expect(entries.length).toBeGreaterThan(1);
  const templates = new Map<string, unknown>();
  const aloneValues = { ...o.helperValues }, keptValues = { ...o.helperValues };
  const run = (kept: boolean) => entries.map((e) => {
    const calls: unknown[] = [];
    // (helper results are memoized per helpers module, for the process: each run gets its own, so each logs its calls afresh)
    const fresh = o.helperValues ? { helperValues: kept ? keptValues : aloneValues } : {};
    const out = compile(html, base({ ...o, ...fresh, ...perEntry(e), page: e, ...(kept ? { templates } : {}), foldLog: (...a: unknown[]) => { calls.push(a); } }));
    return { path: e.path, html: out.html, module: out.module, early: out.early, runtime: out.runtime, static: out.static, diagnostics: out.diagnostics, calls };
  });
  const alone = run(false), kept = run(true);
  const t = [...templates.values()][0] as { hits: number } | null | undefined;
  return { alone, kept, hits: t?.hits ?? 0, refused: templates.size === 1 && t === null };
}
const same = (r: ReturnType<typeof both>) => { for (let i = 0; i < r.alone.length; i++) expect(r.kept[i]).toEqual(r.alone[i]); };

describe('a data-sn-pages template walked once for all its entries', () => {
  test('a condition on the entry, decided another way per entry', () => {
    const r = both(page('<h1 data-sn-text="post.title"></h1><template data-sn-if="post.draft"><p class="draft">Draft</p></template><template data-sn-else><p>Published</p></template>'));
    same(r);
    expect(r.hits).toBe(3);
    expect(r.kept.map((x) => /<p[^>]*>(\w+)<\/p>/.exec(x.html)![1])).toEqual(['Draft', 'Published', 'Published']);
  });

  test('a loop over the entry, unrolled to another length per entry', () => {
    const r = both(page('<ul><template data-sn-for="t in post.tags"><li data-sn-text="t"></li></template></ul>'));
    same(r);
    expect(r.hits).toBe(3);
    expect(r.kept.map((x) => (x.html.match(/<li>/g) ?? []).length)).toEqual([0, 1, 3]);
  });

  test('a tree of components that use each other: what each entry renders of it differs', () => {
    const r = both(page('<x-doc data-sn-prop="{ doc: d.doc }"></x-doc>', 'file:/content/docs/*.json', 'd', 'ds'));
    same(r);
    expect(r.hits).toBe(3);
    expect(r.kept.find((x) => x.path === '/blog/two')!.html).toContain('<a href="/a"><span>a</span><a href="/b"><span>b</span></a></a>');
    expect(r.kept.every((x) => x.runtime.length === 0)).toBe(true);
  });

  test('state the page writes beside the entry: its module and early script as compiled alone', () => {
    const r = both(page('<section data-sn-state="{ n: 0 }"><button data-sn-on-click="n++" data-sn-text="n"></button><template data-sn-if="post.draft"><b>Draft</b></template><p data-sn-text="post.title + n"></p></section>'), { early: { module: null, src: null } });
    same(r);
    expect(r.hits).toBe(3);
    expect(r.kept[0]!.runtime.length).toBeGreaterThan(0);
  });

  test('a helper that runs at build time: the calls each entry logs, as compiled alone', () => {
    const shout: FoldVerdict = { fold: true };
    const r = both(page('<template data-sn-if="shout(post.title) == \'BETA\'"><p>B</p></template><p data-sn-text="shout(post.title)"></p>'), {
      helpers: { module: '/h.js', names: ['shout'], namespaces: {} }, helperValues: { shout: (s: string) => s.toUpperCase() }, helperFold: new Map([['shout', shout]]),
    });
    same(r);
    expect(r.hits).toBe(3);
    expect(r.kept.flatMap((x) => x.calls).length).toBeGreaterThan(0);
  });
});

describe('what is compiled the usual way', () => {
  test('nothing to decide: the first pass is the page', () => {
    const r = both(page('<h1 data-sn-text="post.title"></h1>'));
    same(r);
    expect(r.hits).toBe(0);
  });

  test('`$canonical`, the entry\'s own URL, compiled into the program: the walk is not shared', () => {
    const r = both(page('<template data-sn-if="post.draft"><p>Draft</p></template><a data-sn-attr="{ href: $canonical }">here</a>'), {},
      (e) => ({ urls: { site: 'https://example.com', canonical: `https://example.com${e.path}`, origin: 'https://example.com' } }));
    same(r);
    expect(r.refused).toBe(true);
    expect(r.kept[1]!.html).toContain('href="https://example.com/blog/b"');
    // known from the first entry's walk, before any other entry is compiled
    const html = page('<template data-sn-if="post.draft"><p>Draft</p></template><a data-sn-attr="{ href: $canonical }">here</a>');
    const e = compile(html, base({})).pages!.entries[0]!, templates = new Map<string, unknown>();
    compile(html, base({ page: e, templates, urls: { site: 'https://example.com', canonical: `https://example.com${e.path}`, origin: 'https://example.com' } }));
    expect([...templates.values()]).toEqual([null]);
  });

  test('`localeUrl()` from the entry\'s translations: the walk is not shared', () => {
    const r = both(page('<template data-sn-if="post.draft"><p>Draft</p></template><a data-sn-attr="{ href: localeUrl(\'de\') }">de</a>'), {},
      (e) => ({ locale: { name: 'en', urls: { en: e.path, de: `/de${e.path}` }, base: '/' } }));
    same(r);
    expect(r.refused).toBe(true);
  });

  test('`$site` is the same for every entry: shared', () => {
    const r = both(page('<template data-sn-if="post.draft"><p>Draft</p></template><a data-sn-attr="{ href: $site }">home</a>'), {},
      (e) => ({ urls: { site: 'https://example.com', canonical: `https://example.com${e.path}`, origin: 'https://example.com' } }));
    same(r);
    expect(r.hits).toBe(3);
  });

  test('a page with errors: reported as compiled alone', () => {
    const r = both(page('<template data-sn-if="post.draft"><p>Draft</p></template><p data-sn-text="nope.x"></p>'));
    same(r);
    expect(r.kept[0]!.diagnostics.some((d) => d.severity === 'error')).toBe(true);
  });

  test('images in a tree, where an entry has one: its constants from the evaluation, shared', () => {
    const r = both(page('<x-idoc data-sn-prop="{ doc: d.doc }"></x-idoc>', 'file:/content/idocs/*.json', 'd', 'ds'), { images: host });
    same(r);
    expect(r.hits).toBe(3);
    expect(r.kept.find((x) => x.path === '/blog/two')!.html).toMatch(/<img[^>]*srcset="[^"]*\/i\/photo-/);
  });

  test('a constant class the layout reads, written into the first pass\'s markup (`constants`): the usual two passes', () => {
    const r = both(page('<template data-sn-if="post.draft"><p>Draft</p></template><div data-sn-class="{ wide: !post.draft }"><p>x</p></div>'), {
      styles: [{ file: '/p/style.css', css: '.wide { width: 900px } p { line-height: 20px }' }],
    });
    same(r);
    expect(r.refused).toBe(true);
    expect(r.kept.map((x) => /class="wide"/.test(x.html))).toEqual([false, true, true]);
  });

  test('the second entry walks the template too: a program that differs from the kept one is not shared', () => {
    // (what an entry may not change, changed: `<x-flag>` is a component for the later entries only, so only their
    // programs hold its condition; decided from the first entry's program, it would stay in the browser)
    const flag = '<template data-sn-component="{ on: boolean }"><template data-sn-if="on"><b>Draft</b></template><template data-sn-else><b>Live</b></template></template>';
    const r = both(page('<x-flag data-sn-prop="{ on: post.draft }"></x-flag><template data-sn-if="post.draft"><i>d</i></template>'), {}, (e) => ({
      readFile: (f: string) => { const t = f === '/p/src/components/x-flag.html' && e.path !== '/blog/a' ? flag : files[f.replace(/^\/p\//, '')]; if (t === undefined) throw new Error(`no such file: ${f}`); return t; },
      componentNames: [...Object.keys(components), ...(e.path === '/blog/a' ? [] : ['x-flag'])],
    }));
    same(r);
    expect(r.refused).toBe(true);
    expect(r.kept[1]!.html).toContain('<b>Live</b>');
  });
});

// The build describes one entry of a template and gives every other entry that description at its own path (vite's
// `entryDescription`): what a page can request ahead reads the URL only, never the entry.
describe('an entry\'s description is its template\'s, at the entry\'s path', () => {
  const describeAll = (html: string, o: Partial<Options> = {}) => {
    const entries = compile(html, base(o)).pages!.entries;
    return entries.map((e) => { const r = compile(html, base({ ...o, page: e, describeOnly: true })); return { page: e.path, path: r.path, parts: r.prefetch, off: !!r.prefetchOff }; });
  };
  const swapped = (d: ReturnType<typeof describeAll>) => d.map((x) => JSON.stringify({ ...x, page: 0, path: x.path.map((p) => (p.endsWith(x.page) ? p.slice(0, -x.page.length) + '<entry>' : p)), parts: x.parts && { ...x.parts, path: x.parts.path.map((p) => (p.endsWith(x.page) ? p.slice(0, -x.page.length) + '<entry>' : p)) } }));
  const BODY = `<sn-resource name="c" src="/api/comments?tag={$url.tag}" key="id" items="comments"></sn-resource>
<sn-resource name="mine" src="/api/comments?post={post.slug}" key="id" items="comments"></sn-resource>
<template data-sn-if="post.draft"><p>Draft</p></template><ul><template data-sn-for="x in c"><li data-sn-text="x.id"></li></template><template data-sn-for="x in mine"><li data-sn-text="x.id"></li></template></ul>`;

  test('a request over the URL, ahead; one over the entry, not: the same for every entry', () => {
    const d = describeAll(page(BODY));
    expect(new Set(swapped(d)).size).toBe(1);
    expect(d[1]!.path).toEqual(['/blog/b']);
    expect(d[1]!.parts!.res.length).toBe(1);
    expect(d[1]!.parts!.path).toEqual(['/blog/b']);
  });

  test('in one language: under its prefix', () => {
    const d = describeAll(page(BODY), { locale: { name: 'de', urls: null, base: '/' } });
    expect(new Set(swapped(d)).size).toBe(1);
    expect(d[1]!.path).toEqual(['/de/blog/b']);
  });
});
