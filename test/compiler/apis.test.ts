import { describe, expect, test } from 'vitest';
import { compile } from '../../src/compiler/index.js';
import type { ProjectOptions } from '../../src/project.js';
import { apiProject } from '../apis.test.js';

const main = (extra: Record<string, unknown> = {}): ProjectOptions => ({
  apis: { main: { openapi: 'openapi.yml', defaults: { 'GET /contacts': { items: 'contacts', key: 'id' } }, ...extra } },
});

function page(html: string, options: ProjectOptions = main(), check = false) {
  const p = apiProject(options);
  expect(p.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
  return compile(`<div data-sn-state="{ q: '', tab: 'a' }">${html}</div>`, {
    file: `${p.root}/page.html`, root: p.root, dev: false, readFile: p.readFile, check,
    helpers: { module: null, names: [], namespaces: {} }, openapi: p.openapi, apis: p.apis,
  });
}
const codes = (html: string, options?: ProjectOptions, check?: boolean) => page(html, options, check).diagnostics.map((d) => `${d.code} ${d.message}`);
const USE = '<p data-sn-text="contacts.length"></p>';

describe('paginate: the server\'s names, once per API', () => {
  const list = (pg: string) => `<sn-resource name="contacts" src="/contacts" paginate="{ ${pg} }"></sn-resource>${USE}`;
  const wire = { paginate: { params: { size: 'per_page', page: 'p', offset: 'skip', direction: 'dir' }, directions: { prev: 'back' } } };
  test('a list on the API sends its names; its own `params` and `directions` win', () => {
    const own = page(list('offset: true, size: 5'), main(wire)).module;
    expect(own).toMatch(/"sizeParam":"per_page".*"directionParam":"dir","pageParam":"p".*"offsetParam":"skip"/);
    const keyset = page(list('keyset: { after: id }, size: 5'), main(wire)).module;
    expect(keyset).toContain('"directionValues":{"prev":"back"}');
    // a keyset list does not send the offset unless it jumps
    expect(keyset).not.toContain('"offsetParam"');
    expect(page(list('keyset: { after: id }, size: 5, jump: true'), main(wire)).module).toContain('"offsetParam":"skip"');
    const over = page(list("offset: true, size: 5, params: { size: 'n' }"), main(wire)).module;
    expect(over).toMatch(/"sizeParam":"n".*"pageParam":"p"/);
  });
  test('the API\'s setting is checked', () => {
    const bad = (pg: unknown) => apiProject(main({ paginate: pg })).diagnostics.map((d) => d.message);
    expect(bad({ params: { sise: 'n' } })).toEqual(['sinter({ apis }): `main.paginate.params.sise` is not a key; the keys are `size`, `page`, `offset`, `direction`']);
    expect(bad({ params: { size: 'a b' } })).toEqual(['sinter({ apis }): `main.paginate.params.size` is a query parameter name']);
    expect(bad({ order: 'x' })).toEqual(['sinter({ apis }): `main.paginate.order` is not a setting; it takes `params` and `directions`']);
    expect(bad('limit')).toEqual(["sinter({ apis }): `main.paginate` takes an object: `{ params: { size: 'per_page' }, directions: { prev: 'backward' } }`"]);
  });
});

describe('paths relative to an API', () => {
  test('compile to the URL the base and path make, with the configured shape', () => {
    const viaApi = page(`<sn-resource name="contacts" src="/contacts?q={q}"></sn-resource>${USE}`);
    const viaUrl = page(`<sn-resource name="contacts" src="https://api.example.com/v1/contacts?q={q}" items="contacts" key="id"></sn-resource>${USE}`, { openapi: 'openapi.yml' });
    expect(viaApi.diagnostics).toEqual([]);
    // the same page module, plus the APIs for the runtime (`$apis`, for `apiOf` and request settings)
    const own = (m: string) => m.split('\n').filter((l) => !/\$apis\b/.test(l)).join('\n');
    expect(own(viaApi.module)).toBe(viaUrl.module);
    expect(viaApi.module).toContain('$apis([{"n":"main","b":"https://api.example.com/v1"},{"n":"site","b":""}]);');
  });

  test('actions and other APIs: a path, the method from the attribute', () => {
    const o = { apis: { main: { openapi: 'openapi.yml', defaults: { 'GET /contacts': { items: 'contacts', key: 'id' } } }, files: { base: '/files', operations: { 'POST /upload': {} } } }, defaultApi: 'main' };
    const html = `<sn-resource name="contacts" src="/contacts"></sn-resource><template data-sn-for="c in contacts"><button data-sn-delete="/contacts/{c.id}">x</button></template><form data-sn-post="files:/upload"></form>`;
    const viaApi = page(html, o);
    expect(viaApi.diagnostics).toEqual([]);
    expect(viaApi.module).toContain('"https://api.example.com/v1/contacts/"');
    expect(viaApi.module).toContain('"/files/upload"');
  });

  test('unknown operations, APIs and methods (SN326)', () => {
    expect(codes(`<sn-resource name="contacts" src="/contacs"></sn-resource>${USE}`)).toEqual(['SN326 `GET /contacs` is no operation of the API `main`. Did you mean `/contacts`?']);
    expect(codes(`<sn-resource name="contacts" src="/v1/contacts"></sn-resource>${USE}`)[0]).toMatch(/is no operation of the API `main`. Did you mean `\/contacts`\?/);
    expect(codes(`<sn-resource name="contacts" src="nope:/contacts"></sn-resource>${USE}`)[0]).toMatch(/^SN326 no API `nope`; the APIs are `main`, `site`/);
    expect(codes('<template data-sn-for="c in [{id: 1}]" data-sn-key="c.id"><button data-sn-put="/contacts/{c.id}">x</button></template>')[0]).toMatch(/^SN326 `PUT \/contacts\/\{…\}` is no operation of the API `main`/);
    expect(codes('<sn-sync src="/events"></sn-sync>')[0]).toMatch(/^SN326 `GET \/events` is no operation/);
  });

  test('query parameters (SN327): undeclared, required, sent by paginate, declared in the config', () => {
    expect(codes(`<sn-resource name="contacts" src="/contacts?qq={q}"></sn-resource>${USE}`)).toEqual(['SN327 `GET /contacts` of the API `main` declares no query parameter `qq`. Did you mean `q`?']);
    expect(codes(`<sn-resource name="contacts" src="/contacts" paginate="{ offset: true, size: 20, params: { size: 'per' } }"></sn-resource>${USE}`)[0])
      .toMatch(/declares no query parameter `per` \(sent by `paginate`\)/);
    expect(codes(`<sn-resource name="contacts" src="/contacts" paginate="{ offset: true, size: 20, params: { size: 'limit', offset: 'q' } }"></sn-resource>${USE}`)).toEqual([]);
    expect(codes('<sn-resource name="r" src="/reports"></sn-resource><p data-sn-text="r.n"></p>')).toEqual(['SN327 `GET /reports` of the API `main` needs the query parameter `from`']);
    expect(codes('<sn-resource name="r" src="/reports?from={q}&filter[name]={q}"></sn-resource><p data-sn-text="r.n"></p>')).toEqual([]);
    const withQuery = main({ defaults: { 'GET /contacts': { items: 'contacts', key: 'id', query: ['tag'] } } });
    expect(codes(`<sn-resource name="contacts" src="/contacts?tag=x"></sn-resource>${USE}`, withQuery)).toEqual([]);
  });

  test('absolute URLs (SN328), with the path to write', () => {
    expect(codes(`<sn-resource name="contacts" src="https://api.example.com/v1/contacts"></sn-resource>${USE}`)[0])
      .toBe('SN328 `https://api.example.com/v1/contacts` names the origin of the API `main`: write `/contacts`');
    expect(codes(`<sn-resource name="contacts" src="https://elsewhere.example/x"></sn-resource>${USE}`)[0]).toMatch(/^SN328 `https:\/\/elsewhere.example\/x` names an origin/);
  });

  test('the shape is said once (SN330 different, SN518 the same)', () => {
    expect(codes(`<sn-resource name="contacts" src="/contacts" items="people"></sn-resource>${USE}`)[0])
      .toBe('SN330 `items` of `GET /contacts` is `contacts` (`main.defaults`), not `people`: every page reads one shape from an endpoint');
    expect(codes(`<sn-resource name="contacts" src="/contacts" key="id"></sn-resource>${USE}`)[0])
      .toBe('SN518 `key` of `GET /contacts` is configured as `id` (`main.defaults`): remove it here');
  });

  test('operations the config declares: site, streams, and their type', () => {
    const o = { apis: { main: { openapi: 'openapi.yml', defaults: { 'GET /contacts': { items: 'contacts', key: 'id' } }, operations: { 'GET /events': {} } }, site: { operations: { 'GET /config.json': { type: 'Config' } } } } };
    expect(codes(`<sn-resource name="contacts" src="/contacts"></sn-resource>${USE}<sn-sync src="/events"></sn-sync><sn-resource name="config" src="site:/config.json"></sn-resource><p data-sn-text="config"></p>`, o)).toEqual([]);
    const untyped = { apis: { main: { operations: { 'GET /stats': {} } } } };
    expect(codes('<sn-resource name="stats" src="/stats"></sn-resource><p data-sn-text="stats"></p>', untyped, true))
      .toEqual(['SN504 resource `stats` has no type: expressions using it are not checked']);
  });

  test('a key from the config makes a collection (no SN517, paginate allowed)', () => {
    const o = { apis: { main: { openapi: 'openapi.yml', defaults: { 'GET /contacts': { items: 'contacts' } } } } };
    expect(codes(`<sn-resource name="contacts" src="/contacts"></sn-resource>${USE}`, o)[0]).toMatch(/^SN517/);
    expect(codes(`<sn-resource name="contacts" src="/contacts" paginate="{ offset: true, size: 20, params: { size: 'limit', offset: 'q' } }"></sn-resource>${USE}`)).toEqual([]);
  });

  test('without apis, nothing changes', () => {
    expect(codes(`<sn-resource name="contacts" src="/api/contacts" key="id"></sn-resource>${USE}`, {})).toEqual([]);
  });
});
