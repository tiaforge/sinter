// The `file:` source (docs/resources.md#files): a file of the project read at build time, a constant
// resource whose value reaches the browser as embedded data in the head, with no request.
import { describe, expect, test } from 'vitest';
import { compile } from '../../src/compiler/index.js';
import { resolveApis } from '../../src/compiler/apis.js';
import { firstPaint, mockRequests, render } from '../../src/testing/index.js';

const files = {
  'post.txt': 'Hello <world> </script> ok',
  'data/tags.json': JSON.stringify({ tags: [{ id: 1, name: 'a' }, { id: 2, name: 'b' }] }),
  'src/components/x-note.html': '<template data-sn-props="{}"><p><sn-resource name="note" src="file:./note.txt"></sn-resource><span data-sn-text="note"></span></p></template>',
  'src/components/note.txt': 'from the component folder',
};

/** compiles a page under /p with the files above (paths relative to /p) */
const build = (html: string, more: Record<string, string> = {}, o: Record<string, unknown> = {}) => compile(html, {
  file: '/p/index.html', root: '/p', dev: false, helpers: { module: null, names: [], namespaces: {} }, componentNames: ['x-note'],
  readFile: (f) => { const t = { ...files, ...more }[f.replace(/^\/p\//, '')]; if (t === undefined) throw new Error(`no such file: ${f}`); return t; },
  listFiles: (dir) => { const d = dir.replace(/\/$/, '') + '/'; const all = Object.keys({ ...files, ...more }).map((f) => `/p/${f}`).filter((f) => f.startsWith(d)); if (!all.length && !Object.keys({ ...files, ...more }).some((f) => `/p/${f}`.startsWith(d))) throw new Error(`no such folder: ${dir}`); return all; },
  ...o,
});
const warnings = (out: ReturnType<typeof build>) => out.diagnostics.filter((d) => d.severity === 'warning').map((d) => `${d.code} ${d.message}`);
/** the value a `file:` resource embeds in the page's head (its first, by id) */
const embedded = (out: ReturnType<typeof build>) => JSON.parse(/<script type="application\/json" data-sn="\d+">([\s\S]*?)<\/script>/.exec(out.html)![1]!.replace(/\\u003c/g, '<'));
/** a page whose browser code reads the resource `r` (so its value is embedded): a handler writes the state the text reads */
const reads = (res: string, expr = 'r') => `<!doctype html><html lang="en"><head></head><body>${res}<div data-sn-state="{ n: 0 }"><button data-sn-on-click="n++"></button><p data-sn-text="n + JSON.stringify(${expr})"></p></div></body></html>`;

const posts = {
  'content/posts/hello.md': '---\ntitle: Hello\ndate: 2026-11-02\ntags: [a, b]\n---\n# Hello\n\nText.\n',
  'content/posts/2026/recap.md': '---\ntitle: Recap\ndate: 2026-12-30\ndraft: true\n---\nThe year.\n',
  'content/posts/zebra.md': '---\ntitle: Zebra\ndate: 2026-01-15\nslug: the-zebra\n---\nStripes.\n',
  'content/posts/notes.txt': 'not markdown',
};
const errors = (out: ReturnType<typeof build>) => out.diagnostics.filter((d) => d.severity === 'error').map((d) => `${d.code} ${d.message}`);

describe('a file: resource', () => {
  test('text and JSON (with items and key), a constant status, no request', async () => {
    const requests = mockRequests({});
    const r = await render(`<sn-resource name="post" src="file:./post.txt"></sn-resource>
      <sn-resource name="tags" src="file:/data/tags.json" items="tags" key="id"></sn-resource>
      <p data-sn-text="post"></p><ul><template data-sn-for="t in tags"><li data-sn-text="t.name"></li></template></ul>
      <i data-sn-text="[$meta.post.loading, $meta.post.error, $meta.post.loadedAt, $meta.tags.loading].join(',')"></i>`, { files, requests });
    await r.settle();
    expect(r.root.querySelector('p')!.textContent).toBe('Hello <world> </script> ok');
    expect([...r.root.querySelectorAll('li')].map((x) => x.textContent)).toEqual(['a', 'b']);
    expect(r.root.querySelector('i')!.textContent).toBe('false,,,false');
    expect(requests.calls).toEqual([]);
    // reloads when the page is shown again or the network returns: nothing for a file
    await r.window('online');
    await r.window('pageshow');
    await r.settle();
    expect(requests.calls).toEqual([]);
  });

  test('the value is embedded data in the head, early with the first paint; not in the embed manifest; a dependency of the page', async () => {
    const out = build(`<!doctype html><html><head></head><body><sn-resource name="post" src="file:./post.txt"></sn-resource><p data-sn-text="post"></p></body></html>`, {}, { embed: true });
    expect(errors(out)).toEqual([]);
    expect(out.html).toMatch(/<script type="application\/json" data-sn="\d+">"Hello \\u003cworld> \\u003c\/script> ok"<\/script>/);
    expect(out.embed).toEqual([]);
    expect(out.files).toContain('/p/post.txt');
    const { root } = await firstPaint(`<!doctype html><html><head></head><body><sn-resource name="post" src="file:./post.txt"></sn-resource><p data-sn-text="post"></p></body></html>`, { files });
    expect(root.querySelector('p')!.textContent).toBe('Hello <world> </script> ok');
  });

  test('a relative path resolves against the file that writes it: a component\'s, from its folder', async () => {
    const r = await render('<x-note></x-note>', { files, components: { 'x-note': files['src/components/x-note.html'] } });
    expect(r.root.querySelector('span')!.textContent).toBe('from the component folder');
  });

  test('SN332: an interpolation, outside the root, a missing file, broken JSON, items over text', () => {
    const one = (src: string, extra = '') => errors(build(`<sn-resource name="r" src="${src}"${extra}></sn-resource><p data-sn-text="r"></p>`, { 'bad.json': '{ nope' }));
    expect(one('file:./{x}.txt')).toEqual([expect.stringMatching(/^SN332 a `file:` path is a literal/)]);
    expect(one('file:../secret.txt')).toEqual([expect.stringMatching(/^SN332 `\.\.\/secret\.txt` is outside the project root/)]);
    expect(one('file:/../etc/passwd')).toEqual([expect.stringMatching(/^SN332 .* is outside the project root/)]);
    expect(one('file:./gone.txt')).toEqual([expect.stringMatching(/^SN332 `file:\.\/gone\.txt`: no such file in the project \(`gone\.txt`\)/)]);
    // the project's readFile refuses a symlink whose real place is outside the root
    const linked = errors(build('<sn-resource name="r" src="file:./link.txt"></sn-resource><p data-sn-text="r"></p>', {}, { readFile: (f: string) => { throw new Error(`outside the project root: ${f}`); } }));
    expect(linked).toEqual([expect.stringMatching(/^SN332 `file:\.\/link\.txt` is a link to a file outside the project root \(`link\.txt`\)/)]);
    expect(one('file:./bad.json')).toEqual([expect.stringMatching(/^SN332 `bad\.json` is not valid JSON/)]);
    expect(one('file:./post.txt', ' items="x"')).toEqual([expect.stringMatching(/^SN332 `items` picks a list out of a JSON file/)]);
    expect(one('file:')).toEqual([expect.stringMatching(/^SN332 `file:` needs a path/)]);
  });

  test('SN332: what would load, page or change it', () => {
    for (const a of ['refresh="30s"', 'cache', 'paginate="{ numbered: true, size: 2 }"', 'when="true"', 'then="x = 1"', 'early="off"', 'order="name"', 'method="POST"']) {
      const e = errors(build(`<div data-sn-state="{ x: 0 }"><sn-resource name="r" src="file:./post.txt" ${a}></sn-resource><p data-sn-text="r"></p></div>`));
      expect(e.some((x) => x.startsWith(`SN332 \`${a.split('=')[0]}\``)), a).toBe(true);
    }
    const json = (body: string) => errors(build(`<sn-resource name="tags" src="file:/data/tags.json" items="tags" key="id"></sn-resource>${body}`));
    expect(json('<button data-sn-on-click="refresh(tags)"></button><p data-sn-text="tags.length"></p>')).toEqual([expect.stringMatching(/^SN332 `refresh\(\)` would load or change `tags`/)]);
    expect(json('<button data-sn-on-click="upsert(tags, { id: 3 })"></button><p data-sn-text="tags.length"></p>')).toEqual([expect.stringMatching(/^SN332 `upsert\(\)`/)]);
    expect(json('<template data-sn-for="t in tags"><button data-sn-on-click="remove(t)"></button></template>')).toEqual([expect.stringMatching(/^SN332 `remove\(\)` (would load or )?changes? `tags`, a `file:` resource/)]);
    expect(json('<sn-sync src="/s"><sn-event name="added" resource="tags" op="upsert"></sn-event></sn-sync><p data-sn-text="tags.length"></p>')).toEqual([expect.stringMatching(/^SN332 an `<sn-event>` changes `tags`/)]);
  });

  test('SN332: file: is a resource\'s source only, not an action\'s or a stream\'s', () => {
    expect(errors(build('<button data-sn-post="file:./post.txt"></button>'))).toEqual([expect.stringMatching(/^SN332 `file:` is a source for `<sn-resource src>`.*An action sends a request/)]);
    expect(errors(build('<sn-resource name="r" src="/api/r"></sn-resource><sn-sync src="file:./s"><sn-event name="x" resource="r" op="refresh"></sn-event></sn-sync><p data-sn-text="r"></p>'))).toEqual([expect.stringMatching(/^SN332 .*A stream sends a request/)]);
  });

  test('with sinter({ apis }): file: is read as a file, and `file` is a reserved API name (SN329)', async () => {
    const r = await render('<sn-resource name="post" src="file:./post.txt"></sn-resource><p data-sn-text="post"></p>', { files, apis: { main: { base: '/api' } } });
    expect(r.root.querySelector('p')!.textContent).toBe('Hello <world> </script> ok');
    const bad = resolveApis({ apis: { file: { base: '/files' } } }, () => null, [], 'vite.config.ts');
    expect(bad.diagnostics.map((d) => `${d.code} ${d.message}`)).toEqual([expect.stringMatching(/^SN329 sinter\(\{ apis \}\): `file` is the built-in source of the project's own files/)]);
    const content = resolveApis({ apis: { content: { base: '/c' } } }, () => null, [], 'vite.config.ts');
    expect(content.diagnostics.map((d) => `${d.code} ${d.message}`)).toEqual([expect.stringMatching(/^SN329 sinter\(\{ apis \}\): `content` is the built-in source of the content module's collections/)]);
  });
});

describe('a markdown file is an entry: its frontmatter and its body', () => {
  test('frontmatter fields and `body`; YAML\'s core schema (dates stay strings); a file without frontmatter is `{ body }`', () => {
    const out = build(reads('<sn-resource name="r" src="file:/content/posts/hello.md" type="any"></sn-resource>'), posts);
    expect(errors(out)).toEqual([]);
    expect(embedded(out)).toEqual({ title: 'Hello', date: '2026-11-02', tags: ['a', 'b'], body: '# Hello\n\nText.\n' });
    const plain = build(reads('<sn-resource name="r" src="file:./plain.md"></sn-resource>'), { 'plain.md': '# Just text\n' });
    expect(errors(plain)).toEqual([]);
    expect(embedded(plain)).toEqual({ body: '# Just text\n' });
  });

  test('folds into the page: a title from the frontmatter, no script', () => {
    const out = build('<!doctype html><html><head></head><body><sn-resource name="post" src="file:/content/posts/hello.md"></sn-resource><h1 data-sn-text="post.body.length > 0 ? \'yes\' : \'no\'"></h1></body></html>', posts, { prerender: true });
    expect(errors(out)).toEqual([]);
    expect(out.html).toContain('<h1>yes</h1>');
  });

  test('SN332: invalid YAML, anchors and aliases, tags, a field sinter writes, a list as frontmatter, `items`', () => {
    const one = (md: string, extra = '') => errors(build(`<sn-resource name="r" src="file:./x.md"${extra}></sn-resource><p data-sn-text="r.body"></p>`, { 'x.md': md }));
    expect(one('---\ntitle: [unclosed\n---\nx')).toEqual([expect.stringMatching(/^SN332 `x\.md`: its frontmatter is not valid YAML/)]);
    expect(one('---\na: &x 1\nb: *x\n---\nx')).toEqual([expect.stringMatching(/^SN332 `x\.md`: its frontmatter uses an (alias|anchor)/)]);
    expect(one('---\na: !custom 1\n---\nx')).toEqual([expect.stringMatching(/^SN332 `x\.md`: its frontmatter is not valid YAML|uses a tag/)]);
    expect(one('---\nbody: mine\n---\nx')).toEqual([expect.stringMatching(/^SN332 `x\.md`: its frontmatter has a field `body`, which sinter writes/)]);
    expect(one('---\n- a\n- b\n---\nx')).toEqual([expect.stringMatching(/^SN332 `x\.md`: its frontmatter is not a set of fields/)]);
    expect(one('# x', ' items="a"')).toEqual([expect.stringMatching(/^SN332 `items` picks a list out of a JSON file; a markdown file is one entry/)]);
  });
});

describe('a glob is a list: one entry per file', () => {
  test('entries with `slug`, `dir` and `path`, sorted by path; a text file is `{ body }`; `key` is `slug`', () => {
    const out = build(reads('<sn-resource name="r" src="file:/content/posts/**/*" type="any"></sn-resource>'), posts, { dev: true });
    expect(errors(out)).toEqual([]);
    const list = embedded(out) as Array<Record<string, unknown>>;
    expect(list.map((e) => [e.slug, e.dir, e.path])).toEqual([
      ['recap', '2026', '/content/posts/2026/recap.md'],
      ['hello', '', '/content/posts/hello.md'],
      ['notes', '', '/content/posts/notes.txt'],
      ['the-zebra', '', '/content/posts/zebra.md'],
    ]);
    expect(list[2]).toEqual({ body: 'not markdown', slug: 'notes', dir: '', path: '/content/posts/notes.txt' });
    expect(out.globs).toEqual([{ dir: '/p/content/posts', match: expect.any(String) }]);
    expect(out.files).toContain('/p/content/posts/hello.md');
  });

  test('`*` stays in its folder, `**` crosses folders, `{a,b}` alternates', () => {
    const slugs = (glob: string) => (embedded(build(reads(`<sn-resource name="r" src="file:${glob}" type="any"></sn-resource>`), posts, { dev: true })) as Array<{ slug: string }>).map((e) => e.slug);
    expect(slugs('/content/posts/*.md')).toEqual(['hello', 'the-zebra']);
    expect(slugs('/content/posts/**/*.md')).toEqual(['recap', 'hello', 'the-zebra']);
    expect(slugs('/content/posts/{hello,zebra}.md')).toEqual(['hello', 'the-zebra']);
    expect(slugs('/content/*/h?llo.md')).toEqual(['hello']);
  });

  test('`order` sorts once, at build time, descending with `-`; `drafts` leaves entries out of a build and keeps them in dev', () => {
    const list = (o: Record<string, unknown>) => (embedded(build(reads('<sn-resource name="r" src="file:/content/posts/**/*.md" type="any" order="-date" drafts="draft"></sn-resource>'), posts, o)) as Array<{ slug: string }>).map((e) => e.slug);
    expect(list({ dev: true })).toEqual(['recap', 'hello', 'the-zebra']);
    expect(list({ dev: false })).toEqual(['hello', 'the-zebra']);
    // strings in the page's language, numbers by value, a missing value last
    const people = { 'people/a.json': '{"name":"Ödön","n":10}', 'people/b.json': '{"name":"Zed","n":9}', 'people/c.json': '{"name":"Abe"}' };
    const by = (order: string, lang: string) => (embedded(build(reads(`<sn-resource name="r" src="file:/people/*.json" type="any" order="${order}"></sn-resource>`).replace('lang="en"', `lang="${lang}"`), people)) as Array<{ name: string }>).map((e) => e.name);
    expect(by('name', 'de')).toEqual(['Abe', 'Ödön', 'Zed']);
    expect(by('name', 'sv')).toEqual(['Abe', 'Zed', 'Ödön']);
    expect(by('n', 'en')).toEqual(['Zed', 'Ödön', 'Abe']);
  });

  test('the list renders, at build time, in order', () => {
    const out = build('<!doctype html><html lang="en"><head></head><body><sn-resource name="posts" src="file:/content/posts/*.md" order="slug"></sn-resource><ul><template data-sn-for="p in posts"><li data-sn-text="p.slug"></li></template></ul></body></html>', posts, { prerender: true });
    expect(errors(out)).toEqual([]);
    expect(out.html).toMatch(/<li>hello<\/li>.*<li>the-zebra<\/li>/s);
  });

  test('SN332: a JSON file that is not an object, a field sinter writes, two entries with one slug, `items`, `drafts` on one file; SN539: no match', () => {
    const one = (glob: string, more: Record<string, string>, extra = '') => errors(build(reads(`<sn-resource name="r" src="file:${glob}" type="any"${extra}></sn-resource>`), more));
    expect(one('/d/*.json', { 'd/a.json': '[1, 2]' })).toEqual([expect.stringMatching(/^SN332 `a\.json` is not an object: each file of a glob is one entry/)]);
    expect(one('/d/*.json', { 'd/a.json': '{"path":"x"}' })).toEqual([expect.stringMatching(/^SN332 `a\.json` has a field `path`, which sinter writes/)]);
    expect(one('/d/**/*.md', { 'd/x/a.md': 'a', 'd/y/a.md': 'b' })).toEqual([expect.stringMatching(/^SN332 two files have the slug `a`: `d\/x\/a\.md` and `d\/y\/a\.md`; give one of them a `slug` of its own/)]);
    expect(one('/d/*.md', { 'd/a.md': 'a' }, ' items="x"')).toEqual([expect.stringMatching(/^SN332 `items` picks a list out of a JSON file; a glob is a list already/)]);
    expect(one('/content/posts/hello.md', posts, ' drafts="draft"')).toEqual([expect.stringMatching(/^SN332 `drafts` leaves entries out of a list; this `file:` source is one file/)]);
    const none = build(reads('<sn-resource name="r" src="file:/content/posts/*.mdx" type="any"></sn-resource>'), posts);
    expect(errors(none)).toEqual([]);
    expect(warnings(none)).toContainEqual(expect.stringMatching(/^SN539 `file:\/content\/posts\/\*\.mdx` matches no file/));
    // an interpolation is still not a path
    expect(one('/content/{x}/*.md', posts)).toEqual([expect.stringMatching(/^SN332 a `file:` path is a literal/)]);
  });

  test('types for `sinter check`: `type` as written, and what sinter adds beside it (a glob\'s per entry)', () => {
    const res = (r: string) => { const c = build(reads(r), posts, { check: true }).check!.resources[0]!; return [c.type, c.file?.list, c.file?.adds, c.file?.values.length]; };
    expect(res('<sn-resource name="r" src="file:/content/posts/*.md"></sn-resource>')).toEqual([null, true, '{ slug: string; dir: string; path: string } & { body: string }', 0]);
    expect(res('<sn-resource name="r" src="file:/content/posts/*.md" type="Post"></sn-resource>')).toEqual(['Post', true, '{ slug: string; dir: string; path: string } & { body: string }', 2]);
    expect(res('<sn-resource name="r" src="file:/content/posts/hello.md" type="Post"></sn-resource>')).toEqual(['Post', false, '{ body: string }', 1]);
    expect(res('<sn-resource name="r" src="file:/content/posts/hello.md"></sn-resource>')).toEqual([null, false, '{ body: string }', 0]);
    // each file's own value, its body blanked, to check against `type`
    const v = build(reads('<sn-resource name="r" src="file:/content/posts/*.md" type="Post"></sn-resource>'), posts, { check: true }).check!.resources[0]!.file!.values[0]!;
    expect([v.file, JSON.parse(v.json)]).toEqual(['/p/content/posts/hello.md', { title: 'Hello', date: '2026-11-02', tags: ['a', 'b'], body: '', slug: 'hello', dir: '', path: '/content/posts/hello.md' }]);
    const untypedJson = build(reads('<sn-resource name="r" src="file:/people/*.json"></sn-resource>'), { 'people/a.json': '{}' }, { check: true });
    expect(warnings(untypedJson)).toContainEqual(expect.stringMatching(/^SN504 resource `r` has no type/));
  });
});

describe('`{$locale}` in a path: each language\'s build reads its own folder', () => {
  const both = { 'content/en/posts/a.md': '---\ntitle: Hello\n---\n', 'content/de/posts/a.md': '---\ntitle: Hallo\n---\n' };
  const page = '<!doctype html><html><head></head><body><sn-resource name="posts" src="file:/content/{$locale}/posts/*.md"></sn-resource><ul><template data-sn-for="p in posts"><li data-sn-text="p.title"></li></template></ul></body></html>';
  test('with `localePrefix` (a page in a language): that language\'s files', () => {
    for (const [name, title] of [['en', 'Hello'], ['de', 'Hallo']]) {
      const out = build(page, both, { prerender: true, locale: { name, urls: null, base: '/' } });
      expect(errors(out)).toEqual([]);
      expect(out.html).toContain(`<li>${title}</li>`);
    }
  });
  test('without it: SN332, since the language is the visitor\'s', () => {
    expect(errors(build(page, both))).toEqual([expect.stringMatching(/^SN332 `\{\$locale\}` in a `file:` path needs `sinter\(\{ localePrefix \}\)`/)]);
  });
});

