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
  const r = resolveApis({ apis: Object.fromEntries(Object.entries(apis).map(([k, v]) => [k, k === 'main' ? { ...v, default: true } : v])) as Record<string, ApiOptions> }, (doc) => (openapi.push({ file: '/app/spec.json', doc }), openapi.length - 1), openapi, '/app/vite.config.js');
  return { apis: r.apis!, openapi, diagnostics: r.diagnostics };
}

const MAIN = { openapi: TOKEN_SPEC as unknown as string, defaults: { 'GET /user': { select: 'user' }, 'GET /articles': { select: 'articles', key: 'slug' } }, token: { storage: 'local:jwt' as const, scheme: 'Token', from: { 'POST /users/login': 'user.token' } } };
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
  const eir = compileParts(PAGE, opts).early?.ir as any;
  // each request by the last segment of its URL
  const res = ((eir?.res ?? []) as Array<{ src: string[]; a?: number; r?: 1 }>).map((r) => ({ ...r, name: r.src[0]!.split('/').pop()! })), as = eir?.as ?? [];
  return { out, res, as, preloads: [...out.html.matchAll(/rel="preload" as="fetch"[^>]* href="([^"]+)"/g)].map((m) => m[1]) };
}

describe('an API with a token', () => {
  test('its operations are requested early with the token (those that need it marked), never preloaded; another API is preloaded', () => {
    const { res, as, preloads } = build();
    expect(preloads).toEqual(['/other/stats']);
    const t = { s: 'l', k: 'jwt', h: 'Authorization', p: 'Token ' };
    // one table of the API's settings; each request names it, and says whether it needs the token
    expect(res.map((r) => [r.name, r.a, r.r ?? null])).toEqual([['user', 0, 1], ['articles', 0, null]]);
    expect(as).toEqual([{ t }]);
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

  test('embedding: an operation whose token is optional gets a placeholder for the signed-out answer, requested early only with a token', () => {
    // GET /articles: no credentials, or the token (`[{}, { Token: [] }]`): a signed-in visitor's answer may differ
    const spec = structuredClone(TOKEN_SPEC) as any;
    spec.paths['/articles'].get.security = [{}, { Token: [] }];
    const apis = { main: { ...MAIN, openapi: spec as unknown as string }, other: { openapi: OTHER as unknown as string } };
    const { out, res } = build({ embed: true, changesRequests: true }, apis);
    // the token's own operation is still not embedded; the other API's is
    expect((out.embed ?? []).map((s) => s.resource).sort()).toEqual(['articles', 'stats']);
    const ir = compileParts(PAGE, { file: '/app/index.html', root: '/app', dev: false, readFile: () => '', moduleSrc: '/page.js', helpers: { module: null, names: [], namespaces: {} }, prerender: true, early: { module: null }, ...apisOf(apis), origins: ['https://api.example.com'], embed: true } as CompileOptions);
    expect((ir.ir.resources.find((r) => r.name === 'articles') as any).so).toBe(1);
    // requested early when a token is stored (`r`: not without one), as the page's own answer
    expect(res.map((r) => [r.name, r.r ?? null])).toEqual([['user', 1], ['articles', 1]]);
    // the early bindings read the embedded rows only while no token is stored
    const emb = (ir.early?.ir as any).emb.articles;
    expect(emb.t).toEqual({ s: 'l', k: 'jwt', h: 'Authorization', p: 'Token ' });
    // without the spec saying so, nothing changes
    const plain = build({ embed: true });
    expect((plain.out.embed ?? []).map((s) => s.resource)).toEqual(['stats']);
  });

  test('the page module installs the token module; the early file reads whether one is stored for the signed-out branch', () => {
    const { out } = build();
    expect(out.module).toContain("import { $tokens } from '@tiaforge-ui/sinter/runtime/token';");
    expect(out.module).toContain('$tokens();');
    expect(out.early).toContain('$so("l", "jwt")');
  });

  test('a branch over the data of an operation that needs the token is never open before the page module (null signed out and while it loads): not in the early file; the signed-out branch is', () => {
    const a = apisOf({ main: MAIN, other: { openapi: OTHER as unknown as string } });
    const page = PAGE.replace('<ul>', '<template data-sn-if="user && !$meta.user.error"><b data-sn-text="user.name"></b></template><template data-sn-if="user && !$meta.user.error"><i>in</i></template><template data-sn-else><u>out</u></template><ul>');
    const early = compileParts(page, { file: '/app/index.html', root: '/app', dev: false, readFile: () => '', moduleSrc: '/page.js', helpers: { module: null, names: [], namespaces: {} }, prerender: true, early: { module: null }, apis: a.apis, openapi: a.openapi, origins: ['https://api.example.com'] }).early!;
    const ifs = early.ir.roots.flatMap((n) => n.b).filter((b) => b.k === 'if');
    // the signed-out branch, and the one with an else (its else shows): not the plain one over `user`, whose condition
    // is `null && !null` once the state at mount is written in
    expect(ifs).toHaveLength(2);
    expect(ifs.filter((b) => b.z !== undefined)).toHaveLength(1);
    expect(early.fns.filter((c) => c.includes('null && !null'))).toHaveLength(1);
    expect(early.fns.some((c) => c.includes('$so("l", "jwt")'))).toBe(true);
  });

  test('such a branch whose condition, the state at mount written in, is not made of literals and operators alone: kept (the rule reads nothing else), though it is false where the build runs', () => {
    const a = apisOf({ main: MAIN, other: { openapi: OTHER as unknown as string } });
    const ifs = (cond: string) => {
      const page = PAGE.replace('<ul>', `<template data-sn-if="${cond}"><b data-sn-text="user.name"></b></template><ul>`);
      const early = compileParts(page, { file: '/app/index.html', root: '/app', dev: false, readFile: () => '', moduleSrc: '/page.js', helpers: { module: null, names: [], namespaces: {} }, prerender: true, early: { module: null }, apis: a.apis, openapi: a.openapi, origins: ['https://api.example.com'] }).early!;
      return early.fns.filter((c) => c.includes('[].length') || c.includes('null && !null')).length;
    };
    // the reference: left out, with its function
    expect(ifs('user && !$meta.user.error')).toBe(0);
    expect(ifs('(user || [].length) && !$meta.user.error')).toBe(1);
  });

  test('a signIn path needs none of loginRedirect\'s options; a signIn of its options passes signInTarget', () => {
    expect(build({}, { main: { ...MAIN, token: { ...MAIN.token, signIn: '/login' } }, other: { openapi: OTHER as unknown as string } }).out.module).toContain('$tokens();');
    const { out } = build({}, { main: { ...MAIN, token: { ...MAIN.token, signIn: { to: '/login', returnUrl: { allow: ['/'], param: 'next' } } } }, other: { openapi: OTHER as unknown as string } });
    expect(out.module).toContain("import { $tokens, signInTarget } from '@tiaforge-ui/sinter/runtime/token';");
    expect(out.module).toContain('$tokens(signInTarget);');
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
