// What a page embeds of its build-time resources (`file:`, `content:`, a page's entry) for the code that runs in the
// browser (docs/proposals/redesign-notes/embed-fields.md): a read down to a small primitive is written into the code
// (`foldOf`), and nothing is embedded for it; what cannot be written there is embedded with only the paths the code
// reads (`resourceReads`, `prune`); whatever may take the value whole keeps it whole.
import { describe, expect, test } from 'vitest';
import { compile, type CompileOptions } from '../../src/compiler/index.js';
import { prune, resourceReads } from '../../src/compiler/embed-reads.js';

const long = 'x'.repeat(200);
const files: Record<string, string> = {
  'post.json': JSON.stringify({ title: 'Hello', slug: 'hello', n: 3, body: long, author: { name: 'Ada', bio: long, avatar: { url: '/a.png', alt: 'Ada' } }, tags: ['a', 'b'], secret: 'internal' }),
  'content/posts/a.md': '---\ntitle: A\n---\nBody of A, which the browser never reads.\n',
  'content/posts/b.md': '---\ntitle: B\n---\nBody of B.\n',
};
const build = (body: string, o: Partial<CompileOptions> = {}) => compile(`<!doctype html><html lang="en"><head></head><body>${body}</body></html>`, {
  file: '/p/index.html', root: '/p', dev: false, prerender: true, helpers: { module: null, names: ['fmt'], namespaces: {} },
  readFile: (f) => { const t = files[f.replace(/^\/p\//, '')]; if (t === undefined) throw new Error(`no such file: ${f}`); return t; },
  listFiles: (dir) => Object.keys(files).map((f) => `/p/${f}`).filter((f) => f.startsWith(dir.replace(/\/$/, '') + '/')),
  ...o,
} as CompileOptions);
/** the page's embedded `file:` values, parsed */
const embedded = (out: { html: string }) => [...out.html.matchAll(/<script type="application\/json" data-sn="\d+">([\s\S]*?)<\/script>/g)].map((m) => JSON.parse(m[1]!.replace(/\\u003c/g, '<')));
const errors = (out: ReturnType<typeof build>) => out.diagnostics.filter((d) => d.severity === 'error').map((d) => `${d.code} ${d.message}`);
const post = '<sn-resource name="post" src="file:./post.json" type="any"></sn-resource>';
/** something that runs in the browser, reading `expr` */
const live = (expr: string) => `<div data-sn-state="{ n: 0 }"><button data-sn-on-click="n++"></button><p data-sn-text="n + ' ' + (${expr})"></p></div>`;

describe('fold: a read down to a small primitive is written into the code', () => {
  test('the URL of a live resource from a build-time value: no embedded data, no `post` resource, the literal in the URL', () => {
    const out = build(`${post}<section data-sn-state="{ open: false }"><sn-resource name="comments" src="/api/comments?post={post.slug}" type="any"></sn-resource>
      <button data-sn-on-click="open = !open"></button><template data-sn-if="open"><i data-sn-text="comments.length"></i></template></section>`);
    expect(errors(out)).toEqual([]);
    expect(embedded(out)).toEqual([]);
    expect(out.module).toContain('"/api/comments" + $hq([["post", ((("hello")))]])');
    expect(out.module).not.toContain('$r.post');
    expect(out.module).not.toMatch(/"name":"post"/);
  });

  test('numbers, booleans, nested fields; a method of the value reads the literal', () => {
    const out = build(post + live('post.n + post.author.name.toUpperCase() + post.author.avatar.alt.length'));
    expect(embedded(out)).toEqual([]);
    expect(out.module).toContain('((3)) + (("Ada")).toUpperCase() + (("Ada")).length');
  });

  test('a long string is read from the embedded value, which keeps only it', () => {
    const out = build(post + live('post.body.length + post.slug'));
    expect(embedded(out)).toEqual([{ body: long }]);
    expect(out.module).toContain('$.$r.post.body.length + (("hello"))');
  });
});

describe('prune: what cannot be written into the code is embedded with only what the code reads', () => {
  test('an object read whole keeps its subtree; the other fields are left out', () => {
    expect(embedded(build(post + live('JSON.stringify(post.author.avatar)')))).toEqual([{ author: { avatar: { url: '/a.png', alt: 'Ada' } } }]);
  });

  test('a computed key keeps the object it indexes whole', () => {
    expect(embedded(build(post + live("post.author[n ? 'name' : 'bio']")))).toEqual([{ author: JSON.parse(files['post.json']!).author }]);
  });

  test('a list in the value is kept whole, read by a loop', () => {
    const out = build(post + `<div data-sn-state="{ n: 0 }"><button data-sn-on-click="n++"></button><template data-sn-for="t in post.tags"><i data-sn-text="t + n"></i></template></div>`);
    expect(embedded(out)).toEqual([{ tags: ['a', 'b'] }]);
  });

  test('a `file:` glob a loop reads at run time is embedded whole (lists are not pruned)', () => {
    const out = build('<sn-resource name="posts" src="file:/content/posts/*.md" type="any"></sn-resource><div data-sn-state="{ n: 0 }"><button data-sn-on-click="n++"></button><template data-sn-for="p in posts"><i data-sn-text="p.title + n"></i></template></div>');
    expect(embedded(out)[0]).toHaveLength(2);
    expect(embedded(out)[0][0]).toMatchObject({ title: 'A', body: 'Body of A, which the browser never reads.\n', slug: 'a' });
  });
});

describe('whole: the value can escape', () => {
  const whole = JSON.parse(files['post.json']!);
  test.each([
    ['passed to a helper', 'fmt(post)'],
    ['spread', 'JSON.stringify({ ...post })'],
    ['its keys listed', 'Object.keys(post).join()'],
    ['compared by identity', 'post === $el'],
    ['a method called on it', 'post.hasOwnProperty(\'secret\')'],
  ])('%s', (_, expr) => {
    const out = build(post + live(expr));
    expect(errors(out)).toEqual([]);
    expect(embedded(out)).toEqual([whole]);
  });

  test('held in state (an alias): whole, and nothing folds through it', () => {
    const out = build(post + '<div data-sn-state="{ p: post, n: 0 }"><button data-sn-on-click="n++"></button><p data-sn-text="n + p.title"></p></div>');
    expect(embedded(out)).toEqual([whole]);
  });

  test('sent as an action\'s body', () => {
    const out = build(post + '<button data-sn-post="/api/x" data-sn-body="post">send</button>');
    expect(errors(out)).toEqual([]);
    expect(embedded(out)).toEqual([whole]);
  });

  test('a write is an error (SN205, and `merge`/`upsert`/`remove` on one are SN332): nothing changes a build-time value', () => {
    const out = build(post + '<div data-sn-state="{ n: 0 }"><button data-sn-on-click="post.title = \'x\'; n++"></button><p data-sn-text="n + post.title"></p></div>');
    expect(errors(out)).toEqual([expect.stringMatching(/^SN205 /)]);
  });

  test('`select`: read below its path, embedded whole', () => {
    const out = build('<sn-resource name="a" src="file:./post.json" select="author" type="any"></sn-resource>' + live('JSON.stringify(a.avatar)'));
    expect(embedded(out)).toEqual([whole]);
  });

  test('dev: whole, and nothing folds (its modules change while the page stays)', () => {
    const out = build(post + live('post.slug'), { dev: true, prerender: false });
    expect(embedded(out)).toEqual([whole]);
  });
});

describe('resourceReads and prune', () => {
  test('the paths a function reads, and what makes every resource whole', () => {
    const r = resourceReads(['($) => ($.$r.a.b.c + $.$r.a.d?.e + f($.$r.b) + $.$r.c[$k(x)].y + $.$r.d["k"].z + $.$r.e.s.trim())']);
    expect(r).toEqual({ all: false, reads: new Map([['a', [['b', 'c'], ['d', 'e']]], ['b', [[]]], ['c', [[]]], ['d', [['k', 'z']]], ['e', [['s']]]]) });
    for (const c of ['($) => $.$r[name]', '($) => f($.$r)', '($) => { $.$r.a.b = 1 }', '($) => { $.$r.a.n++ }', '($) => { delete $.$r.a.b }', '($) => { const { $r } = $; return $r.a }', '($) => ({ $r }) ']) expect(resourceReads([c]).all).toBe(true);
    expect(resourceReads(['($) => ({ $r: 1 }).x', '($) => $.$meta.a.loading'])).toEqual({ all: false, reads: new Map() });
  });

  test('prune keeps the named keys in their order, and lists and what a path ends at whole', () => {
    const v = { b: 1, a: { x: 1, y: [1, { z: 2 }] }, c: 'c' };
    expect(prune(v, [['a', 'y', '0'], ['b']])).toEqual({ b: 1, a: { y: [1, { z: 2 }] } });
    expect(Object.keys(prune(v, [['c'], ['b']]) as object)).toEqual(['b', 'c']);
    expect(prune(v, [[]])).toBe(v);
    expect(prune([v], [['b']])).toEqual([v]);
    expect(prune(v, [])).toEqual({});
  });
});
