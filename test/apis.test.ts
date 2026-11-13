import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { project, type ProjectOptions } from '../src/project.js';
import { apiOf, apiOrigins, validBase } from '../src/compiler/apis.js';

export const SPEC = `openapi: 3.0.3
info: { title: t, version: '1' }
servers: [{ url: 'https://api.example.com/v1' }]
paths:
  /contacts:
    get:
      operationId: ListContacts
      summary: All contacts
      parameters: [{ name: q, in: query }, { name: limit, in: query }]
      responses:
        '200':
          description: ok
          content: { application/json: { schema: { type: object, properties: { contacts: { type: array, items: { $ref: '#/components/schemas/Contact' } }, total: { type: integer } } } } }
    post:
      requestBody: { content: { application/json: { schema: { $ref: '#/components/schemas/Contact' } } } }
      responses: { '200': { description: ok, content: { application/json: { schema: { $ref: '#/components/schemas/Contact' } } } } }
  /contacts/{id}:
    get:
      parameters: [{ name: id, in: path, required: true }]
      responses: { '200': { description: ok, content: { application/json: { schema: { $ref: '#/components/schemas/Contact' } } } } }
    delete:
      parameters: [{ name: id, in: path, required: true }]
      responses: { '204': { description: gone } }
  /reports:
    get:
      parameters: [{ name: from, in: query, required: true }, { name: filter, in: query, style: deepObject }]
      responses: { '200': { description: ok, content: { application/json: { schema: { type: object, properties: { n: { type: integer } } } } } } }
  /search:
    post:
      requestBody: { content: { application/json: { schema: { type: object, properties: { q: { type: string } } } } } }
      responses: { '200': { description: ok, content: { application/json: { schema: { type: array, items: { $ref: '#/components/schemas/Contact' } } } } } }
components:
  schemas:
    Contact: { type: object, required: [id], properties: { id: { type: integer }, name: { type: string } } }
`;

export function apiProject(options: ProjectOptions, files: Record<string, string> = {}) {
  const root = mkdtempSync(join(tmpdir(), 'sinter-apis-'));
  for (const [p, text] of Object.entries({ 'openapi.yml': SPEC, 'vite.config.js': 'export default {};\n', ...files })) {
    mkdirSync(join(root, p, '..'), { recursive: true });
    writeFileSync(join(root, p), text);
  }
  return project(root, options);
}

const messages = (p: ReturnType<typeof project>) => p.diagnostics.map((d) => `${d.code} ${d.message}`);

describe('sinter({ apis })', () => {
  test('an API: base from the spec, its spec, its shapes; `site` built in; one API is the default', () => {
    const p = apiProject({ apis: { main: { openapi: 'openapi.yml', defaults: { 'GET /contacts': { items: 'contacts', key: 'id' } } } } });
    expect(messages(p)).toEqual([]);
    expect(p.apis!.defaultApi).toBe('main');
    expect(p.apis!.list.map((a) => [a.name, a.base, a.specs.length])).toEqual([['main', 'https://api.example.com/v1', 1], ['site', '', 0]]);
    expect(p.apis!.list[0]!.shapes['GET /contacts']).toEqual({ items: 'contacts', key: 'id' });
    expect(apiOrigins(p.apis)).toEqual(['https://api.example.com']);
  });

  test('operations become a generated spec; base, credentials and headers are kept', () => {
    const p = apiProject({ apis: { main: { base: '/api', openapi: 'openapi.yml', credentials: 'include', headers: { 'X-Api': '2' }, operations: { 'GET /v0/stats/{range}': { type: 'Stat[]', key: 'day', query: ['tz'] } } } } });
    expect(messages(p)).toEqual([]);
    const main = p.apis!.list[0]!;
    expect([main.base, main.credentials, main.headers, main.specs.length]).toEqual(['/api', 'include', { 'X-Api': '2' }, 2]);
    const gen = p.openapi[main.specs[1]!]!;
    expect(gen.config).toBe('main');
    expect((gen.doc as any).paths['/v0/stats/{range}'].get.parameters).toEqual([{ name: 'range', in: 'path', required: true }, { name: 'tz', in: 'query' }]);
  });

  test('invalid settings are SN329', () => {
    const bad = (o: ProjectOptions) => messages(apiProject(o));
    expect(bad({ apis: { main: { base: undefined } } })[0]).toMatch(/`main.base` is `undefined` \(an environment variable that is not set\?\)/);
    expect(bad({ apis: { main: { base: '/api/' } } })[0]).toMatch(/`main.base` must be/);
    expect(bad({ apis: { main: { openapi: 'openapi.yml', defaults: { 'GET /nope': {} } } } })[0]).toMatch(/`main.defaults` names `GET \/nope`, which its spec does not have/);
    expect(bad({ apis: { main: { openapi: 'openapi.yml', operations: { 'GET /contacts': { type: 'X' } } } } })[0]).toMatch(/which the spec has: its shape goes in `main.defaults`/);
    expect(bad({ apis: { main: { operations: { 'get /x': {} } } } })[0]).toMatch(/as `METHOD \/path`/);
    expect(bad({ apis: { a: {}, b: {} }, defaultApi: 'c' })[0]).toMatch(/`defaultApi` names `c`, which is no API/);
    expect(bad({ apis: { site: { base: '/x' } } })[0]).toMatch(/`site` is the page's own origin/);
    expect(bad({ apis: { main: { basee: '/x' } as never } })[0]).toMatch(/`main.basee` is not an API setting/);
    expect(bad({ openapi: 'openapi.yml', apis: { main: {} } })[0]).toMatch(/`openapi` moves into an API/);
  });

  test('several APIs need defaultApi for a path without api:', () => {
    const p = apiProject({ apis: { main: { base: '/api' }, billing: { base: '/billing' } } });
    expect(p.apis!.defaultApi).toBeNull();
    expect(apiOf(p.apis!, '/x')).toMatchObject({ error: expect.stringMatching(/several APIs are configured/) });
    expect(apiOf(p.apis!, 'billing:/x')).toMatchObject({ api: { name: 'billing' }, path: '/x', prefix: 8 });
    expect(apiOf(p.apis!, 'nope:/x')).toMatchObject({ error: expect.stringMatching(/no API `nope`/) });
    expect(apiOf(p.apis!, 'site:/config.json')).toMatchObject({ api: { name: 'site', base: '' } });
  });

  test('bases', () => {
    expect(['', '/api', 'https://a.example', 'https://a.example/v1'].every(validBase)).toBe(true);
    expect(['/', '/api/', '//evil.example', 'ftp://x', 'https://a.example/', '/a?x', 'api'].some(validBase)).toBe(false);
  });
});
