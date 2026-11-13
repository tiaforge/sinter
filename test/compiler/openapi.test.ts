import { describe, expect, test } from 'vitest';
import { findOperation, matchResource, operationRef, operationUrl, operations, queryNames, walk, type OpenApiSpec } from '../../src/compiler/openapi.js';
import { compile } from '../../src/compiler/index.js';

const ok = { '200': { description: 'ok', content: { 'application/json': { schema: { $ref: '#/components/schemas/List' } } } } };
const doc = {
  openapi: '3.1.0',
  servers: [{ url: 'https://api.example.com/v1' }, { url: '/v1' }],
  paths: {
    '/articles': { get: { parameters: [{ name: 'tag', in: 'query' }, { $ref: '#/components/parameters/limit' }], responses: ok } },
    '/articles/feed': { get: { responses: ok } },
    '/articles/{slug}': { parameters: [{ name: 'slug', in: 'path' }], get: { responses: { '200': { $ref: '#/components/responses/One' } } } },
    '/files/{id}.json': { get: { responses: ok } },
    '/only-post': { post: { responses: ok } },
  },
  components: {
    parameters: { limit: { name: 'limit', in: 'query' } },
    responses: { One: { description: 'one', content: { 'application/vnd.x+json': { schema: { type: 'object', properties: { article: { $ref: '#/components/schemas/Article' } } } } } } },
    schemas: {
      List: { allOf: [{ $ref: '#/components/schemas/Count' }, { type: 'object', properties: { articles: { type: 'array', items: { $ref: '#/components/schemas/Article' } } } }] },
      Count: { type: 'object', properties: { count: { type: 'integer' } } },
      Article: { type: 'object', properties: { slug: { type: 'string' } } },
    },
  },
};
const specs: OpenApiSpec[] = [{ file: '/p/openapi.yml', doc }];
const path = (r: ReturnType<typeof matchResource>) => ('path' in r ? r.path : r);

describe('OpenAPI matching', () => {
  test('absolute and relative server prefixes; interpolations match parameters', () => {
    expect(path(matchResource(specs, ['https://api.example.com/v1/articles?tag=', 0]))).toBe('/articles');
    expect(path(matchResource(specs, ['/v1/articles/', 0]))).toBe('/articles/{slug}');
    expect(path(matchResource(specs, ['https://other.example/v1/articles']))).toBe('/articles');
  });

  test('a literal path beats a templated one; a literal segment can fill a parameter', () => {
    expect(path(matchResource(specs, ['/v1/articles/feed']))).toBe('/articles/feed');
    expect(path(matchResource(specs, ['/v1/articles/hello']))).toBe('/articles/{slug}');
  });

  test('mixed segments, and GET only', () => {
    expect(path(matchResource(specs, ['/v1/files/', 0, '.json']))).toBe('/files/{id}.json');
    expect(matchResource(specs, ['/v1/only-post'])).toEqual({ closest: '/only-post' });
  });

  test('no match names the closest path', () => {
    expect(matchResource(specs, ['/v1/articels'])).toEqual({ closest: '/articles' });
    expect(matchResource(specs, ['/elsewhere/articles'])).toEqual({ closest: '/articles' });
  });

  test('query parameters, path-level and $ref parameters; response $refs and +json', () => {
    const m = matchResource(specs, ['/v1/articles?tag=a']);
    expect('query' in m && m.query).toEqual(['tag', 'limit']);
    const one = matchResource(specs, ['/v1/articles/', 0]);
    expect('body' in one && walk(doc, one.body, 'article')).toEqual({ schema: { $ref: '#/components/schemas/Article' } });
  });

  test('walk follows allOf and reports what is there', () => {
    const m = matchResource(specs, ['/v1/articles']);
    const body = 'body' in m ? m.body : null;
    expect(walk(doc, body, 'count')).toEqual({ schema: { type: 'integer' } });
    expect(walk(doc, body, 'articels')).toEqual({ missing: 'articels', have: ['count', 'articles'] });
  });

  test('literal query names', () => {
    expect(queryNames(['/x?tag=', 0, '&limit=10&', 1, '=1&offset=', 2])).toEqual(['tag', 'limit', 'offset']);
    expect(queryNames(['/x'])).toEqual([]);
  });
});

describe('operation="…" on a resource', () => {
  const ops = {
    openapi: '3.1.0',
    servers: [{ url: 'https://api.example.com/v1' }],
    paths: {
      '/articles': { get: { operationId: 'GetArticles', summary: 'List articles', parameters: [{ name: 'tag', in: 'query' }, { name: 'limit', in: 'query' }], responses: ok }, post: { operationId: 'CreateArticle', responses: ok } },
      '/articles/{slug}': { parameters: [{ name: 'slug', in: 'path', required: true }], get: { responses: { '200': { $ref: '#/components/responses/One' } } } },
    },
    components: doc.components,
  };
  const opSpecs: OpenApiSpec[] = [{ file: '/p/openapi.yml', doc: ops }];
  const page = (html: string) => compile(`<div data-sn-state="{ t: '' }">${html}<p data-sn-text="a"></p></div>`, {
    file: '/p/page.html', root: '/p', dev: false, openapi: opSpecs,
    readFile: () => { throw new Error('missing'); }, helpers: { module: '/h.js', names: [], namespaces: {} },
  });
  const codes = (html: string) => page(html).diagnostics.map((d) => `${d.code} ${d.message}`);

  test('lists operations by operationId, or method and path', () => {
    expect(operations(opSpecs, 'get').map(operationRef)).toEqual(['GetArticles', 'GET /articles/{slug}']);
    const one = findOperation(opSpecs, 'GET /articles/{slug}');
    expect('path' in one && operationUrl(one)).toBe('https://api.example.com/v1/articles/{slug}');
    expect(findOperation(opSpecs, 'GetArticels')).toEqual({ closest: 'GetArticles' });
  });

  test('compiles to the same page as the src it stands for', () => {
    const viaSrc = page('<sn-resource name="a" src="https://api.example.com/v1/articles?tag={t}&limit={10}" items="articles" key="slug"></sn-resource>');
    const viaOp = page('<sn-resource name="a" operation="GetArticles" params="{ tag: t, limit: 10 }" items="articles" key="slug"></sn-resource>');
    expect(viaOp.diagnostics).toEqual([]);
    expect(viaOp.module).toBe(viaSrc.module);
    const path = page('<sn-resource name="a" operation="GET /articles/{slug}" params="{ slug: $url.slug }" items="article"></sn-resource>');
    expect(path.diagnostics).toEqual([]);
    expect(path.module).toBe(page('<sn-resource name="a" src="https://api.example.com/v1/articles/{$url.slug}" items="article"></sn-resource>').module);
  });

  test('unknown operations and parameters, missing path parameters, non-GET operations', () => {
    expect(codes('<sn-resource name="a" operation="GetArticels"></sn-resource>')).toEqual(['SN326 the OpenAPI spec has no operation `GetArticels`. Did you mean `GetArticles`?']);
    expect(codes('<sn-resource name="a" operation="CreateArticle"></sn-resource>')).toEqual(['SN326 `CreateArticle` is a POST operation: a resource loads with GET']);
    expect(codes('<sn-resource name="a" operation="GetArticles" params="{ tagg: t }"></sn-resource>')).toEqual(['SN327 `GetArticles` has no parameter `tagg`. Did you mean `tag`?']);
    expect(codes('<sn-resource name="a" operation="GET /articles/{slug}"></sn-resource>')).toEqual(['SN327 `GET /articles/{slug}` needs `slug` in `params`']);
    expect(codes('<sn-resource name="a" src="/v1/articles" operation="GetArticles"></sn-resource>')[0]).toBe('SN102 a resource loads from `src` or from `operation`, not both');
    expect(codes('<sn-resource name="a" src="/v1/articles" params="{ tag: t }"></sn-resource>')[0]).toMatch(/^SN102 `params` needs `operation`/);
  });
});
