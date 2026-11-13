import { describe, expect, test } from 'vitest';
import { matchResource, queryNames, walk, type OpenApiSpec } from '../../src/compiler/openapi.js';

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
