// `sinter({ apis: { <name>: { token } } })` at runtime (docs/apis.md#a-token): the token goes to that API's requests
// only, read from its storage on each request; signed out, a resource that needs it loads empty without a request
// (in the early script too); a 401 clears it; an action's 401 goes to the sign-in page; a response the config names
// stores it, and a change between none and one drops what the page kept.
import { afterEach, describe, expect, test } from 'vitest';
import { configured, requests as earlyRequests, st, start } from '../../src/early.js';
import { config, configure, setEnv } from '../../src/runtime/config.js';
import { defaultEnv } from '../../src/runtime/env.js';
import { createRequestLayer, tokens } from '../../src/runtime/request.js';
import { $tokens } from '../../src/token.js';
import { memoryStorage, mockRequests, render } from '../../src/testing/index.js';
import type { EarlyIR } from '../../src/ir.js';
import { TOKEN_SPEC } from '../fixtures/token-spec.js';


const api = (extra: Record<string, unknown> = {}) => ({
  main: {
    openapi: TOKEN_SPEC,
    defaults: { 'GET /user': { select: 'user' }, 'GET /articles': { select: 'articles', key: 'slug' }, 'GET /feed': { select: 'articles', key: 'slug' } },
    token: { storage: 'local:jwt' as const, scheme: 'Token', signIn: '/login', from: { 'POST /users/login': 'user.token' }, ...extra },
  },
});
const withToken = (t: string | null) => { const s = memoryStorage(); if (t) s.setItem('jwt', t); return s; };

afterEach(() => {
  for (const k of ['sinter.prefetched', 'sinter.early.page']) delete (globalThis as any)[Symbol.for(k)];
  setEnv(defaultEnv); configure({ request: [] });
  config.apis = []; tokens.on = undefined;
});

const PAGE = `<sn-resource name="user" src="/user"></sn-resource><sn-resource name="articles" src="/articles"></sn-resource>
  <p id="who" data-sn-text="$meta.user.loadedAt ? (user ? user.username : 'guest') : '…'"></p>
  <ul><template data-sn-for="a in articles"><li data-sn-text="a.slug"></li></template></ul>`;

describe('the token on requests', () => {
  test('stored: sent to the API, as its scheme says, to every operation; not to another origin', async () => {
    const requests = mockRequests({ 'GET /api/user': { user: { username: 'ada' } }, 'GET /api/articles': { articles: [{ slug: 'a' }] }, 'GET /other.json': {} });
    const { root, settle } = await render(PAGE + '<sn-resource name="other" src="site:/other.json"></sn-resource>', { requests, apis: { ...api(), site: { operations: { 'GET /other.json': { type: 'any' } } } }, storage: withToken('t1') });
    await settle();
    expect(root.querySelector('#who')!.textContent).toBe('ada');
    expect(requests.calls.map((c) => [c.path, c.headers.authorization ?? null])).toEqual([['/api/user', 'Token t1'], ['/api/articles', 'Token t1'], ['/other.json', null]]);
  });

  test('signed out: what needs the token loads empty, at once, without a request; the rest loads without it', async () => {
    const requests = mockRequests({ 'GET /api/articles': { articles: [{ slug: 'a' }] } });
    const { root, settle, app } = await render(PAGE, { requests, apis: api(), storage: withToken(null) });
    // loaded before any response: the first render already says signed out
    expect(root.querySelector('#who')!.textContent).toBe('guest');
    expect(app.resource('user').meta).toMatchObject({ loading: false, error: null });
    await settle();
    expect(requests.calls.map((c) => [c.path, c.headers.authorization ?? null])).toEqual([['/api/articles', null]]);
  });

  test('a token stored by a response the config names is used at once; the page-load cache and persisted state go', async () => {
    const requests = mockRequests({ 'POST /api/users/login': { user: { username: 'ada', token: 'new' } }, 'GET /api/user': { user: { username: 'ada' } } });
    const storage = withToken(null), session = memoryStorage();
    storage.setItem('sn:draft', '"x"');
    session.setItem('sn:c:["https://api.example.com/api/user","user",null]', '{}');
    const { root, settle } = await render(`<sn-resource name="user" src="/user"></sn-resource>
      <button data-sn-post="/users/login" data-sn-body="{ user: {} }" data-sn-then="refresh(user)">in</button>
      <p data-sn-text="user ? user.username : 'guest'"></p>`, { requests, apis: api(), storage, session });
    await settle();
    root.querySelector('button')!.click();
    await settle();
    expect(storage.getItem('jwt')).toBe('new');
    expect([storage.getItem('sn:draft'), session.length]).toEqual([null, 0]);
    expect(root.querySelector('p')!.textContent).toBe('ada');
    expect(requests.calls.map((c) => [c.path, c.headers.authorization ?? null])).toEqual([['/api/users/login', null], ['/api/user', 'Token new']]);
  });

  test('a 401 clears the token: a resource that needs it reads as signed out, one that does not loads without it', async () => {
    const requests = mockRequests({
      'GET /api/user': { status: 401, body: {} },
      'GET /api/articles': (c) => (c.headers.authorization ? { status: 401, body: {} } : { articles: [{ slug: 'anon' }] }),
    });
    const storage = withToken('stale');
    const { root, settle, app } = await render(PAGE, { requests, apis: api(), storage });
    await settle();
    expect(storage.getItem('jwt')).toBeNull();
    expect(root.querySelector('#who')!.textContent).toBe('guest');
    expect(app.resource('user').meta.error).toBeNull();
    expect(root.querySelector('li')!.textContent).toBe('anon');
  });

  test('an action\'s 401 that nothing shows goes to the sign-in page, with the return URL, signed in or out', async () => {
    const requests = mockRequests({ 'POST /api/articles/a/favorite': { status: 401, body: {} } });
    const page = `<button data-sn-post="/articles/{'a'}/favorite">fav</button>`;
    const session = memoryStorage(), storage = withToken('stale');
    let r = await render(page, { requests, apis: api(), storage, session, url: 'http://localhost/article/a' });
    r.root.querySelector('button')!.click();
    await r.settle();
    expect([r.navigations, session.getItem('sn:return'), storage.getItem('jwt')]).toEqual([['/login'], '/article/a', null]);
    expect(requests.calls.map((c) => c.headers.authorization)).toEqual(['Token stale']);
    r = await render(page, { requests, apis: api(), storage: withToken(null), url: 'http://localhost/article/a' });
    r.root.querySelector('button')!.click();
    await r.settle();
    // signed out: sent without a token, its 401 goes there too
    expect(r.navigations).toEqual(['/login']);
    expect(requests.calls.map((c) => c.headers.authorization ?? null)).toEqual(['Token stale', null]);
  });

  test('a 401 the page shows stays on the page: a form that reads `$error`, a `data-sn-catch`, a sign-in form sent without a token', async () => {
    const requests = mockRequests({ 'POST /api/users/login': { status: 401, body: { errors: { email: 'wrong' } } }, 'POST /api/articles/a/favorite': { status: 401, body: {} } });
    const { root, settle, navigations } = await render(`<div data-sn-state="{ e: null }">
      <form data-sn-post="/users/login" data-sn-body="{ user: {} }"><p id="f" data-sn-text="$error?.status"></p><button>in</button></form>
      <button id="fav" data-sn-post="/articles/{'a'}/favorite" data-sn-catch="e = $error.status">fav</button><p id="c" data-sn-text="e"></p></div>`, { requests, apis: api(), storage: withToken('t') });
    root.querySelector('form')!.requestSubmit();
    await settle();
    (root.querySelector('#fav') as HTMLButtonElement).click();
    await settle();
    expect(navigations).toEqual([]);
    expect([root.querySelector('#f')!.textContent, root.querySelector('#c')!.textContent]).toEqual(['401', '401']);
  });

  test('signOut(): the token goes, with what the page kept; the resources that need it read as signed out', async () => {
    const requests = mockRequests({ 'GET /api/user': { user: { username: 'ada' } }, 'GET /api/articles': (c) => ({ articles: [{ slug: c.headers.authorization ? 'mine' : 'anon' }] }) });
    const storage = withToken('t1');
    storage.setItem('sn:draft', '"x"');
    const { root, settle } = await render(PAGE + '<button data-sn-on-click="signOut()">out</button>', { requests, apis: api(), storage });
    await settle();
    expect(root.querySelector('#who')!.textContent).toBe('ada');
    root.querySelector('button')!.click();
    await settle();
    expect([storage.getItem('jwt'), storage.getItem('sn:draft')]).toEqual([null, null]);
    expect(root.querySelector('#who')!.textContent).toBe('guest');
    expect(root.querySelector('li')!.textContent).toBe('anon');
    expect(requests.calls.map((c) => c.path)).toEqual(['/api/user', '/api/articles', '/api/articles']);
  });

  test('session storage, and an API without a spec: the header and the operations that need it from the config, else all', async () => {
    const requests = mockRequests({ 'GET /v1/me': { name: 'ada' }, 'GET /v1/open': { n: 1 } });
    const ops = { 'GET /me': { type: 'any' }, 'GET /open': { type: 'any' } };
    const page = '<sn-resource name="me" src="/me"></sn-resource><sn-resource name="open" src="/open"></sn-resource><p data-sn-text="(me ? me.name : \'-\') + (open ? open.n : \'-\')"></p>';
    const session = memoryStorage();
    session.setItem('k', 's1');
    let r = await render(page, { requests, apis: { main: { base: '/v1', operations: ops, token: { storage: 'session:k', header: 'X-Key', scheme: '', required: ['GET /me'] } } }, session });
    await r.settle();
    expect(requests.calls.map((c) => [c.path, c.headers['x-key'] ?? null])).toEqual([['/v1/me', 's1'], ['/v1/open', 's1']]);
    requests.calls.length = 0;
    r = await render(page, { requests, apis: { main: { base: '/v1', operations: ops, token: { storage: 'session:k', header: 'X-Key', scheme: '', required: ['GET /me'] } } } });
    await r.settle();
    expect(r.root.querySelector('p')!.textContent).toBe('-1');
    requests.calls.length = 0;
    // no list: every operation needs it, `Authorization: Bearer` by default
    r = await render(page, { requests, apis: { main: { base: '/v1', operations: ops, token: { storage: 'local:k' } } }, storage: (() => { const s = memoryStorage(); s.setItem('k', 'b'); return s; })() });
    await r.settle();
    expect(requests.calls.map((c) => c.headers.authorization)).toEqual(['Bearer b', 'Bearer b']);
    requests.calls.length = 0;
    r = await render(page, { requests, apis: { main: { base: '/v1', operations: ops, token: { storage: 'local:k' } } } });
    await r.settle();
    expect([r.root.querySelector('p')!.textContent, requests.calls.length]).toEqual(['--', 0]);
  });
});

describe('the early script', () => {
  test('sends the token as the request layer does, so the page\'s request takes its response; signed out, nothing that needs it', async () => {
    const sent: Request[] = [];
    const fetch = async (r: Request) => { sent.push(r); return Response.json({ user: { username: 'ada' } }); };
    const storage = withToken('t1');
    setEnv({ ...defaultEnv, fetch, storage: () => storage });
    config.apis = [{ n: 'main', b: '/api', t: { s: 'l', k: 'jwt', h: 'Authorization', p: 'Token ', r: ['GET /user'] } }];
    $tokens();
    const t = { s: 'l' as const, k: 'jwt', h: 'Authorization', p: 'Token ' };
    const ir: Pick<EarlyIR, 'res'> = { res: [{ name: 'user', src: ['/api/user'], when: null, scope: 0, a: { t, r: 1 } }, { name: 'list', src: ['/api/articles'], when: null, scope: 0, a: { t } }] };
    const f = [() => ({})];
    const go = () => start(() => ({ ir, fns: f, scopes: ($) => [st($, f[0]!, 0)], render: () => {} }), null, earlyRequests(undefined, configured));
    go();
    expect(sent.map((r) => [new URL(r.url).pathname, r.headers.get('Authorization')])).toEqual([['/api/user', 'Token t1'], ['/api/articles', 'Token t1']]);
    const layer = createRequestLayer({ ...defaultEnv, fetch, storage: () => storage }, []);
    await layer.send('/api/user');
    await layer.send('/api/articles');
    expect(sent).toHaveLength(2);
    // signed out: the operation that needs it is not requested
    sent.length = 0;
    delete (globalThis as any)[Symbol.for('sinter.prefetched')];
    storage.removeItem('jwt');
    go();
    expect(sent.map((r) => [new URL(r.url).pathname, r.headers.get('Authorization')])).toEqual([['/api/articles', null]]);
  });

  test('a middleware that changes a request the early script sent: sent again, and a dev warning says why', async () => {
    const sent: Request[] = [];
    const fetch = async (r: Request) => { sent.push(r); return Response.json({}); };
    setEnv({ ...defaultEnv, fetch });
    config.apis = [{ n: 'main', b: '/api' }];
    const ir: Pick<EarlyIR, 'res'> = { res: [{ name: 'x', src: ['/api/x'], when: null, scope: 0 }] };
    const f = [() => ({})];
    start(() => ({ ir, fns: f, scopes: ($) => [st($, f[0]!, 0)], render: () => {} }), null, earlyRequests(undefined, configured));
    const layer = createRequestLayer({ ...defaultEnv, fetch }, [(req, next) => { const h = new Headers(req.headers); h.set('X-Extra', '1'); return next(new Request(req, { headers: h })); }]);
    const seen: string[] = [];
    layer.resent = (u) => seen.push(u);
    await layer.send('/api/x');
    expect(sent).toHaveLength(2);
    expect(seen).toEqual([new URL('/api/x', location.href).href]);
  });
});

describe('the first paint', () => {
  const header = `<sn-resource name="user" src="/user"></sn-resource>
    <template data-sn-if="$meta.user.loadedAt && !user"><a id="in" href="/login">Sign in</a></template>
    <template data-sn-if="$meta.user.loading"><span id="wait">…</span></template>`;

  test('signed out is known before the page module: the early script renders the signed-out branch, and the page module keeps it', async () => {
    const requests = mockRequests({});
    const { root, settle } = await render(header, { requests, apis: api(), storage: withToken(null), firstPaint: { afterEarly: () => {
      expect([!!document.querySelector('#in'), !!document.querySelector('#wait')]).toEqual([true, false]);
    } } });
    await settle();
    expect([!!root.querySelector('#in'), !!root.querySelector('#wait'), requests.calls.length]).toEqual([true, false, 0]);
  });

  test('with a token stored: loading, not signed out', async () => {
    const requests = mockRequests({ 'GET /api/user': { user: { username: 'ada' } } });
    const { root, settle } = await render(header, { requests, apis: api(), storage: withToken('t'), firstPaint: { afterEarly: () => {
      expect([!!document.querySelector('#in'), !!document.querySelector('#wait')]).toEqual([false, true]);
    } } });
    await settle();
    expect([!!root.querySelector('#in'), !!root.querySelector('#wait')]).toEqual([false, false]);
  });
});
