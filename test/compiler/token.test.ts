// The build with an API's `token` (docs/apis.md#a-token): its operations are requested by the early script with the
// token, never preloaded by a link, and not embedded; `configure({ request })` no longer makes that API late (other
// APIs keep the rule); the page module installs the token module; nothing of the token but its storage key is written.
import { describe, expect, test } from 'vitest';
import { compileParts } from '../../src/compiler/compile.js';
import { compile, type CompileOptions } from '../../src/compiler/index.js';
import { resolveApis, type ApiOptions } from '../../src/compiler/apis.js';
import type { OpenApiSpec } from '../../src/compiler/openapi.js';
import { TOKEN_SPEC } from '../fixtures/token-spec.js';

const OTHER = {
  openapi: '3.0.3', info: { title: 'o', version: '1' }, servers: [{ url: '/other' }],
  paths: { '/stats': { get: { responses: { '200': { description: 'ok', content: { 'application/json': { schema: { type: 'object' } } } } } } } },
};

function apisOf(apis: Record<string, ApiOptions & { openapi?: unknown }>) {
  const openapi: OpenApiSpec[] = [];
  const r = resolveApis({ apis: apis as Record<string, ApiOptions>, defaultApi: 'main' }, (doc) => (openapi.push({ file: '/app/spec.json', doc }), openapi.length - 1), openapi, '/app/vite.config.js');
  return { apis: r.apis!, openapi, diagnostics: r.diagnostics };
}

const MAIN = { openapi: TOKEN_SPEC as unknown as string, defaults: { 'GET /user': { items: 'user' }, 'GET /articles': { items: 'articles', key: 'slug' } }, token: { storage: 'local:jwt' as const, scheme: 'Token', from: { 'POST /users/login': 'user.token' } } };
const PAGE = `<!doctype html><html><head></head><body>
  <sn-resource name="user" src="/user"></sn-resource>
  <sn-resource name="articles" src="/articles"></sn-resource>
  <sn-resource name="stats" src="other:/stats" type="any"></sn-resource>
  <template data-sn-if="$meta.user.loadedAt && !user"><a href="/login">Sign in</a></template>
  <ul><template data-sn-for="a in articles" data-sn-key="a.slug"><li data-sn-text="a.slug"></li></template></ul>
  <p data-sn-text="stats"></p>
</body></html>`;

function build(o: Partial<CompileOptions> = {}, apis: Record<string, ApiOptions & { openapi?: unknown }> = { main: MAIN, other: { openapi: OTHER as unknown as string } }) {
  const a = apisOf(apis);
  expect(a.diagnostics).toEqual([]);
  const opts: CompileOptions = { file: '/app/index.html', root: '/app', dev: false, readFile: () => '', moduleSrc: '/page.js', helpers: { module: null, names: [], namespaces: {} }, prerender: true, early: { module: null }, apis: a.apis, openapi: a.openapi, origins: ['https://api.example.com'], ...o } as CompileOptions;
  const out = compile(PAGE, opts);
  expect(out.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
  const res = ((compileParts(PAGE, opts).early?.ir as any)?.res ?? []) as Array<{ name: string; a?: { t?: unknown; r?: 1 } }>;
  return { out, res, preloads: [...out.html.matchAll(/rel="preload" as="fetch"[^>]* href="([^"]+)"/g)].map((m) => m[1]) };
}

describe('an API with a token', () => {
  test('its operations are requested early with the token (those that need it marked), never preloaded; another API is preloaded', () => {
    const { res, preloads } = build();
    expect(preloads).toEqual(['/other/stats']);
    const t = { s: 'l', k: 'jwt', h: 'Authorization', p: 'Token ' };
    expect(res.map((r) => [r.name, r.a])).toEqual([['user', { t, r: 1 }], ['articles', { t }]]);
  });

  test('a request middleware no longer makes it late; another API keeps that rule', () => {
    const { res, preloads } = build({ changesRequests: true });
    expect(preloads).toEqual([]);
    expect(res.map((r) => r.name)).toEqual(['user', 'articles']);
  });

  test('embedding: the server has no token, so none of its operations gets a placeholder', () => {
    const { out } = build({ embed: true });
    expect((out.embed ?? []).map((s) => s.resource)).toEqual(['stats']);
  });

  test('the page module installs the token module; the early file reads whether one is stored for the signed-out branch', () => {
    const { out } = build();
    expect(out.module).toContain("import { $tokens } from '@tiaforge-ui/sinter/runtime/token';");
    expect(out.module).toContain('$tokens();');
    expect(out.early).toContain('$so("l", "jwt")');
  });

  test('nothing of the token is written into the HTML; the bundle and early file name only its storage key', () => {
    const { out } = build();
    expect(out.html).not.toContain('jwt');
    expect(out.html).not.toContain('Token');
    expect(out.module).toContain('"k":"jwt"');
  });

  test('an app without a token: no token module, and middleware makes its APIs late as before', () => {
    const { out, res, preloads } = build({ changesRequests: true }, { main: { ...MAIN, token: undefined } as ApiOptions, other: { openapi: OTHER as unknown as string } });
    expect(out.module).not.toContain('$tokens');
    expect([res, preloads]).toEqual([[], []]);
  });
});

describe('`token` in the config', () => {
  const fail = (token: unknown) => apisOf({ main: { openapi: TOKEN_SPEC as unknown as string, token: token as never } }).diagnostics.map((d) => d.message);
  test('the header, the scheme and the operations that need it come from the spec', () => {
    const t = apisOf({ main: { openapi: TOKEN_SPEC as unknown as string, token: { storage: 'session:jwt' } } }).apis.list[0]!.token!;
    expect(t).toEqual({ storage: 'session', key: 'jwt', header: 'Authorization', scheme: '', from: {}, required: ['GET /user', 'GET /feed', 'POST /articles/{slug}/favorite'] });
    const bearer = apisOf({ main: { openapi: { ...OTHER, components: { securitySchemes: { b: { type: 'http', scheme: 'bearer' } } } } as unknown as string, token: { storage: 'local:t' } } }).apis.list[0]!.token!;
    expect([bearer.header, bearer.scheme, bearer.required]).toEqual(['Authorization', 'Bearer', []]);
    // no spec: given, or `Authorization: Bearer` for every operation
    const none = apisOf({ main: { base: '/v1', operations: { 'GET /me': {} }, token: { storage: 'local:t' } } }).apis.list[0]!.token!;
    expect([none.header, none.scheme, none.required]).toEqual(['Authorization', 'Bearer', null]);
  });
  test('mistakes are SN329 with the fix', () => {
    expect(fail({ storage: 'jwt' })[0]).toContain("`main.token.storage` is `'local:<key>'` (localStorage) or `'session:<key>'`");
    expect(fail({ storage: 'local:t', from: { 'POST /nope': 'token' } })[0]).toContain('`main.token.from` names `POST /nope`, which is no operation of the API `main`');
    expect(fail({ storage: 'local:t', required: ['GET /nope'] })[0]).toContain('`main.token.required` names `GET /nope`');
    expect(fail({ storage: 'local:t', signIn: 'https://evil.example/' })[0]).toContain('`main.token.signIn` is a same-origin path');
    expect(fail({ storage: 'local:t', cookie: true })[0]).toContain('`main.token.cookie` is not a token setting');
    expect(fail({ storage: 'local:t', scheme: 'Two words' })[0]).toContain('`main.token.scheme` is the word before the token');
  });
});
