// `sinter({ apis })` at runtime: each API's credentials and static headers on every request to it,
// sent the same way by the early file (so its response is taken), POST resources, and `apiOf`.
import { afterEach, describe, expect, test } from 'vitest';
import { parse } from 'yaml';
import { configured, requests, st, start } from '../../src/early.js';
import { $apis, apiOf, config, configure, header } from '../../src/runtime/config.js';
import { defaultEnv } from '../../src/runtime/env.js';
import { createRequestLayer } from '../../src/runtime/request.js';
import { compile } from '../../src/compiler/index.js';
import { mockRequests, render } from '../../src/testing/index.js';
import type { EarlyIR } from '../../src/ir.js';
import { apiProject, SPEC } from '../apis.test.js';

const doc = parse(SPEC);
const sent: Request[] = [];
const fetch = async (r: Request) => { sent.push(r); return Response.json({ ok: true }); };
afterEach(() => {
  sent.length = 0;
  for (const k of ['sinter.prefetched', 'sinter.early.page']) delete (globalThis as any)[Symbol.for(k)];
  configure({ env: defaultEnv, retry: null });
  config.apis = [];
});

describe('request settings per API', () => {
  test('credentials and static headers go with every request to the API, by its base; apiOf names it', async () => {
    $apis([{ n: 'main', b: 'https://api.example.com/v1', c: 'include', h: { 'X-Api': '2' } }, { n: 'site', b: '' }]);
    configure({ origins: ['https://api.example.com'] });
    const req = createRequestLayer({ ...defaultEnv, fetch }, []);
    await req.send('https://api.example.com/v1/contacts');
    await req.send('/config.json');
    expect([sent[0]!.credentials, sent[0]!.headers.get('X-Api')]).toEqual(['include', '2']);
    expect([sent[1]!.credentials, sent[1]!.headers.get('X-Api')]).toEqual(['same-origin', null]);
    expect([apiOf('https://api.example.com/v1/contacts?q=1'), apiOf('https://api.example.com/v10'), apiOf('/x')]).toEqual(['main', null, 'site']);
    configure({ origins: [] });
  });

  test('the early file sends the same request, so the page module takes its response; a middleware header still gets its own', async () => {
    configure({ env: { ...defaultEnv, fetch } });
    $apis([{ n: 'main', b: '/api', h: { 'X-Api': '2' } }]);
    const ir: Pick<EarlyIR, 'res'> = { res: [{ name: 'days', src: ['/api/days'], when: null, scope: 0, a: { h: { 'X-Api': '2' } } }] };
    const f = [() => ({})];
    start(() => ({ ir, fns: f, scopes: ($) => [st($, f[0]!, 0)], render: () => {} }), null, requests(undefined, configured));
    expect(sent.map((r) => [new URL(r.url).pathname, r.headers.get('X-Api')])).toEqual([['/api/days', '2']]);
    await createRequestLayer({ ...defaultEnv, fetch }, []).send('/api/days');
    expect(sent).toHaveLength(1);
    await createRequestLayer({ ...defaultEnv, fetch }, [header('Authorization', 'x')]).send('/api/days');
    expect(sent).toHaveLength(2);
  });

  test('render: a page written with paths of an API', async () => {
    const requests = mockRequests({ 'GET /v1/contacts': { contacts: [{ id: 1, name: 'Ada' }] } });
    const { root, settle } = await render('<sn-resource name="contacts" src="/contacts"></sn-resource><p data-sn-text="contacts[0].name"></p>', {
      requests, apis: { main: { openapi: doc, headers: { 'X-Api': '2' }, defaults: { 'GET /contacts': { items: 'contacts', key: 'id' } } } },
    });
    await settle();
    expect(root.querySelector('p')!.textContent).toBe('Ada');
    expect(requests.calls.map((c) => [c.url, c.headers['x-api']])).toEqual([['/v1/contacts', '2']]);
  });
});

describe('method="POST" resources', () => {
  test('loaded with a POST of its body, again when the body changes; shared by URL and body', async () => {
    const requests = mockRequests({ 'POST /v1/search': (req: { body: { q: string } }) => [{ id: 1, name: req.body.q }] });
    const { root, settle, flush } = await render(`
      <div data-sn-state="{ q: 'a' }">
        <sn-resource name="hits" src="/search" method="POST" body="{ q }" key="id"></sn-resource>
        <sn-resource name="same" src="/search" method="POST" body="{ q }" key="id"></sn-resource>
        <input data-sn-model="q"><p data-sn-text="hits[0].name + same[0].name"></p>
      </div>`, { requests, url: 'https://api.example.com/', apis: { main: { openapi: doc } } });
    await settle();
    expect(root.querySelector('p')!.textContent).toBe('aa');
    expect(requests.calls.map((c) => [c.method, c.url, c.body])).toEqual([['POST', '/v1/search', { q: 'a' }]]);
    const input = root.querySelector('input')!;
    input.value = 'b';
    input.dispatchEvent(new Event('input'));
    await flush();
    await settle();
    expect(root.querySelector('p')!.textContent).toBe('bb');
    expect(requests.calls.map((c) => c.body)).toEqual([{ q: 'a' }, { q: 'b' }]);
  });

  test('refused with cache, paginate, each; body needs POST; checked against the API', () => {
    const p = apiProject({ apis: { main: { openapi: 'openapi.yml' } } });
    const codes = (html: string) => compile(html, { file: `${p.root}/page.html`, root: p.root, dev: false, readFile: p.readFile, helpers: { module: null, names: [], namespaces: {} }, openapi: p.openapi, apis: p.apis })
      .diagnostics.map((d) => `${d.code} ${d.message}`);
    expect(codes('<sn-resource cache name="h" src="/search" method="POST" key="id"></sn-resource><p data-sn-text="h"></p>')[0]).toMatch(/^SN401 `cache` does not combine with `method="POST"`/);
    expect(codes('<sn-resource name="h" src="/search" body="{}" key="id"></sn-resource><p data-sn-text="h"></p>')[0]).toMatch(/^SN102 `body` needs `method="POST"`/);
    expect(codes('<sn-resource name="h" src="/contacts/{1}" method="POST" key="id"></sn-resource><p data-sn-text="h"></p>')[0]).toMatch(/^SN326 `POST \/contacts\/\{…\}` is no operation/);
  });
});

describe('the build: preloads, the early file, embedding', () => {
  const build = (o: Record<string, unknown>, html: string) => {
    const p = apiProject({ apis: { main: { openapi: 'openapi.yml', defaults: { 'GET /contacts': { items: 'contacts', key: 'id' } }, ...o } } });
    return compile(html, { file: `${p.root}/page.html`, root: p.root, dev: false, readFile: p.readFile, helpers: { module: null, names: [], namespaces: {} }, openapi: p.openapi, apis: p.apis, origins: ['https://api.example.com'], embed: !!o.embed, early: { module: null }, moduleSrc: '/x.js' });
  };
  const PAGE = '<html><head></head><body><sn-resource name="contacts" src="/contacts"></sn-resource><p data-sn-text="contacts.length"></p></body></html>';
  const link = (html: string) => /<link rel="preload" as="fetch"[^>]*>/.exec(html)?.[0] ?? null;

  test('a preload link: crossorigin, use-credentials for credentials: include, none for static headers', () => {
    expect(link(build({}, PAGE).html)).toBe('<link rel="preload" as="fetch" crossorigin="" href="https://api.example.com/v1/contacts">');
    expect(link(build({ credentials: 'include' }, PAGE).html)).toBe('<link rel="preload" as="fetch" crossorigin="use-credentials" href="https://api.example.com/v1/contacts">');
    expect(link(build({ headers: { 'X-Api': '2' } }, PAGE).html)).toBeNull();
  });

  test('the page module sets the APIs; the manifest lists the static headers', () => {
    expect(build({ headers: { 'X-Api': '2' } }, PAGE).module).toContain('$apis([{"n":"main","b":"https://api.example.com/v1","h":{"X-Api":"2"}},{"n":"site","b":""}]);');
    expect(build({}, PAGE).module).not.toContain('$apis');
    const embedded = build({ headers: { 'X-Api': '2' }, embed: true } as never, '<html><head></head><body><sn-resource name="contacts" src="/contacts?q={$url.q}"></sn-resource><p data-sn-text="contacts.length"></p></body></html>');
    expect(embedded.embed?.[0]).toMatchObject({ resource: 'contacts', headers: { 'X-Api': '2' } });
  });
});
