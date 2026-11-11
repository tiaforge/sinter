// The compiler's side of write-through: provenance, response entities, schema names, SN510.
import { expect, test } from 'vitest';
import { compileParts, type CompileOptions } from '../../src/compiler/index.js';

const ref = (n: string) => ({ $ref: `#/components/schemas/${n}` });
const json = (schema: unknown) => ({ description: 'ok', content: { 'application/json': { schema } } });
const Article = { type: 'object', properties: { slug: { type: 'string' }, title: { type: 'string' }, body: { type: 'string' }, author: ref('Profile') } };
const SPEC = { file: '/p/openapi.json', doc: {
  openapi: '3.0.3',
  paths: {
    // the list inlines a projection of Article (no `body`), as RealWorld's spec does
    '/api/articles': { get: { responses: { '200': json({ type: 'object', properties: { articles: { type: 'array', items: { type: 'object', properties: { slug: { type: 'string' }, title: { type: 'string' }, author: ref('Profile') } } } } }) } } },
    '/api/articles/feed': { get: { responses: { '200': json({ type: 'object', properties: { articles: { type: 'array', items: ref('Article') } } }) } } },
    '/api/articles/{slug}': { get: { responses: { '200': json({ type: 'object', properties: { article: ref('Article') } }) } } },
    '/api/articles/{slug}/favorite': { post: { responses: { '200': json({ type: 'object', properties: { article: ref('Article') } }) } } },
    '/api/profiles/{username}/follow': { post: { responses: { '200': json({ type: 'object', properties: { profile: ref('Profile') } }) } } },
    '/api/articles/{slug}/comments': { get: { responses: { '200': json({ type: 'object', properties: { comments: { type: 'array', items: ref('Comment') } } }) } }, post: { requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { comment: { type: 'object', properties: { body: { type: 'string' } } } } } } } }, responses: { '200': json({ type: 'object', properties: { comment: ref('Comment') } }) } } },
  },
  components: { schemas: { Article, Profile: { type: 'object', properties: { username: { type: 'string' }, following: { type: 'boolean' } } }, Comment: { type: 'object', properties: { id: { type: 'integer' }, body: { type: 'string' } } } } },
} };
const opts = (openapi = true): CompileOptions => ({ file: '/p/page.html', root: '/p', dev: false, readFile: () => '', helpers: { module: null, names: [], namespaces: {} }, ...(openapi ? { openapi: [SPEC] } : {}) });
const page = (body: string) => `<!doctype html><html><head></head><body data-sn-state="{ feedOn: false }">
  <sn-resource name="articles" src="/api/articles" items="articles" key="slug"></sn-resource>
  <sn-resource name="feed" src="/api/articles/feed" items="articles" key="slug"></sn-resource>
  <sn-resource name="article" src="/api/articles/x" items="article"></sn-resource>
  <p data-sn-text="articles.length + feed.length + article.title"></p>${body}</body></html>`;

test('schema names: a `$ref`, an inline copy, and an inline projection of a component all name it', () => {
  const out = compileParts(page(''), opts());
  expect(out.ir.resources.map((r) => [r.name, r.sch])).toEqual([['articles', 'Article'], ['feed', 'Article'], ['article', 'Article']]);
});

test('provenance: a row (also of a `cond ? feed : articles` loop), a single, and the named entities along the path; the response entities and the body wrapper', () => {
  const out = compileParts(page(`
    <template data-sn-for="a in (feedOn ? feed : articles)"><button data-sn-post="/api/articles/{a.slug}/favorite">f</button></template>
    <button data-sn-post="/api/profiles/{article.author.username}/follow">follow</button>
    <form data-sn-post="/api/articles/{article.slug}/comments" data-sn-body="{comment: {body: 'x'}}"></form>`), opts());
  expect(out.diagnostics).toEqual([]);
  expect(out.ir.actions.map((a) => a.ap)).toEqual([
    { tg: [{ r: 'feed', v: 'a', s: 'Article' }, { r: 'articles', v: 'a', s: 'Article' }], t: 1, rs: [{ p: 'article', s: 'Article' }] },
    { tg: [{ r: 'article', s: 'Article' }, { r: 'article', p: ['author'], s: 'Profile' }], t: 1, rs: [{ p: 'profile', s: 'Profile' }] },
    { tg: [{ r: 'article', s: 'Article' }], t: 1, rs: [{ p: 'comment', s: 'Comment' }], rq: 'comment', u: 0 },
  ]);
  expect(out.features).toContain('apply');
});

test('without a spec: provenance only (rule 4 and the body-only update); no `ap` without reads; `data-sn-apply="off"` drops it; GET and call have none', () => {
  const out = compileParts(page(`
    <template data-sn-for="a in articles"><button data-sn-delete="/api/articles/{a.slug}">d</button></template>
    <button data-sn-post="/api/ping">p</button>
    <button data-sn-post="/api/articles/{article.slug}/favorite" data-sn-apply="off">f</button>
    <button data-sn-get="/api/articles/{article.slug}">g</button>`), opts(false));
  expect(out.diagnostics).toEqual([]);
  expect(out.ir.actions.map((a) => a.ap)).toEqual([{ tg: [{ r: 'articles', v: 'a' }] }, undefined, undefined, undefined]);
});

test('`data-sn-apply` takes `off` only, on mutations only', () => {
  const out = compileParts(page(`<button data-sn-post="/api/ping" data-sn-apply="on">p</button><button data-sn-get="/api/ping" data-sn-apply="off">g</button>`), opts(false));
  expect(out.diagnostics.map((d) => d.code + ' ' + d.message)).toEqual([
    'SN401 `data-sn-apply` takes `off`; write-through is on without the attribute',
    'SN102 `data-sn-apply` belongs to a mutation (`data-sn-post`, `-put`, `-patch`, `-delete`): a GET or a call has no write-through',
  ]);
});

test('SN510 names each redundant write: patch by key or provenance, upsert on the list\'s URL, remove on a DELETE of the row\'s URL; others pass', () => {
  const out = compileParts(page(`
    <template data-sn-for="a in articles">
      <button data-sn-post="/api/articles/{a.slug}/favorite" data-sn-then="patch(a, $result.article); patch(a, $result.article); saved = 1" data-sn-state="{ saved: 0 }">f</button>
    </template>
    <button data-sn-post="/api/profiles/{article.author.username}/follow" data-sn-then="patch(article, {author: $result.profile})">follow</button>
    <div data-sn-state="{ slug: 'x' }">
      <sn-resource name="comments" src="/api/articles/{slug}/comments" items="comments" key="id"></sn-resource>
      <p data-sn-text="comments.length"></p>
      <form data-sn-post="/api/articles/{slug}/comments" data-sn-then="upsert('comments', $result.comment); slug = slug"></form>
      <form data-sn-post="/api/articles/{slug}/comments" data-sn-then="upsert('articles', $result.comment)"></form>
      <template data-sn-for="c in comments"><button data-sn-delete="/api/articles/{slug}/comments/{c.id}" data-sn-then="remove(c)">x</button></template>
      <template data-sn-for="c in comments"><button data-sn-delete="/api/articles/{slug}/comments/{c.id}/flag" data-sn-then="remove(c)">x</button></template>
    </div>`), opts());
  expect(out.diagnostics.map((d) => `${d.code} ${d.line} ${d.message.slice(0, d.message.indexOf(' is what'))}`)).toEqual([
    "SN510 7 `patch(a, $result.article)`",
    "SN510 7 `patch(a, $result.article)`",
    "SN510 13 `upsert('comments', $result.comment)`",
    "SN510 15 `remove(c)`",
  ]);
  expect(out.diagnostics.every((d) => d.severity === 'warning')).toBe(true);
});
