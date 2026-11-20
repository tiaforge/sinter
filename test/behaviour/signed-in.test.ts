// `data-sn-signed-in` (docs/apis.md#pages-that-need-a-session): a page that needs a session of its API's token sends a
// visitor with none to the API's `signIn`, with the return URL: the early script before anything paints, the page module
// at mount without it (and on a swap), after a 401 that took the token and when `$url` makes the condition true; not
// after `signOut()`; a guarded page's data is not requested ahead while signed out; the build refuses what cannot work.
import { afterEach, describe, expect, test } from 'vitest';
import { compile, type CompileOptions } from '../../src/compiler/index.js';
import { resolveApis, type ApiOptions } from '../../src/compiler/apis.js';
import type { OpenApiSpec } from '../../src/compiler/openapi.js';
import { config, configure, setEnv } from '../../src/runtime/config.js';
import { defaultEnv } from '../../src/runtime/env.js';
import { tokens } from '../../src/runtime/request.js';
import { HOVER } from '../../src/prefetch.js';
import { memoryStorage, mockRequests, render } from '../../src/testing/index.js';
import { TOKEN_SPEC } from '../fixtures/token-spec.js';
import * as runtime from '../../src/runtime-entry.js';
import { instance } from '../../src/index.js';
import guardFeature from '../../src/signed-in.js';
import { $tokens } from '../../src/token.js';

afterEach(() => {
  for (const k of ['sinter.prefetched', 'sinter.early.page']) delete (globalThis as any)[Symbol.for(k)];
  setEnv(defaultEnv); configure({ request: [] });
  config.apis = []; tokens.on = undefined;
});

const api = () => ({
  main: {
    openapi: TOKEN_SPEC,
    defaults: { 'GET /user': { select: 'user' }, 'GET /articles': { select: 'articles', key: 'slug' }, 'GET /feed': { select: 'articles', key: 'slug' } },
    token: { storage: 'local:jwt' as const, signIn: { to: '/login', returnUrl: { allow: ['/'], param: 'next' } } },
  },
});
const withToken = (t: string | null) => { const s = memoryStorage(); if (t) s.setItem('jwt', t); return s; };
const page = (guard = '') => `<html data-sn-path="/settings /" data-sn-signed-in${guard ? `="${guard}"` : ''}><head></head><body>
  <sn-resource name="user" src="/user"></sn-resource>
  <p data-sn-text="user ? user.username : '-'"></p>
  <button data-sn-on-click="$url.feed = 'following'">feed</button>
  <button id="out" data-sn-on-click="signOut()">out</button>
</body></html>`;

describe('the page module', () => {
  test('no token: to sign in, in the current entry, with the return URL; a token: stays', async () => {
    let r = await render(page(), { requests: mockRequests({}), apis: api(), storage: withToken(null), url: 'http://localhost/settings?tab=1' });
    expect(r.navigations).toEqual(['replace /login?next=%2Fsettings%3Ftab%3D1']);
    r = await render(page(), { requests: mockRequests({ 'GET /api/user': { user: { username: 'ada' } } }), apis: api(), storage: withToken('t'), url: 'http://localhost/settings' });
    await r.settle();
    expect(r.navigations).toEqual([]);
  });

  test('a condition over $url: only when it holds, also when a change makes it hold', async () => {
    const r = await render(page("$url.feed == 'following'"), { requests: mockRequests({}), apis: api(), storage: withToken(null), url: 'http://localhost/' });
    await r.settle();
    expect(r.navigations).toEqual([]);
    r.root.querySelector('button')!.click();
    await r.settle();
    expect(r.navigations).toEqual(['replace /login?next=%2F%3Ffeed%3Dfollowing']);
  });

  test('a 401 that takes the token sends the visitor on; signOut() leaves it to the handler', async () => {
    const storage = withToken('stale');
    let r = await render(page(), { requests: mockRequests({ 'GET /api/user': { status: 401, body: {} } }), apis: api(), storage, url: 'http://localhost/settings' });
    await r.settle();
    expect([storage.getItem('jwt'), r.navigations]).toEqual([null, ['replace /login?next=%2Fsettings']]);
    r = await render(page(), { requests: mockRequests({ 'GET /api/user': { user: { username: 'ada' } } }), apis: api(), storage: withToken('t'), url: 'http://localhost/settings' });
    await r.settle();
    (r.root.querySelector('#out') as HTMLButtonElement).click();
    await r.settle();
    expect(r.navigations).toEqual([]);
  });
});

describe('the early script', () => {
  test('signed out: to sign in before anything renders or is requested', async () => {
    const requests = mockRequests({});
    const r = await render(page(), { requests, apis: api(), storage: withToken(null), url: 'http://localhost/settings', firstPaint: { afterEarly: () => {
      expect(document.documentElement.hidden).toBe(false);
    } } });
    // once: in a browser the page module does not mount after it, and render() does not count its own again
    expect(r.navigations).toEqual(['replace /login?next=%2Fsettings']);
    expect(requests.calls).toEqual([]);
  });

  test('signIn a path: to it, the return URL stored as loginRedirect stores it', async () => {
    const requests = mockRequests({}), session = memoryStorage(), a = api();
    a.main.token = { ...a.main.token, signIn: '/login' as never };
    const r = await render(page(), { requests, apis: a, storage: withToken(null), session, url: 'http://localhost/settings?tab=1#x', firstPaint: true });
    expect(r.navigations).toEqual(['replace /login']);
    expect(session.getItem('sn:return')).toBe('/settings?tab=1#x');
    expect(requests.calls).toEqual([]);
  });
});

describe('next-page data', () => {
  test('a guarded page\'s data is not requested ahead while signed out', async () => {
    const LIST = '<a href="/settings">settings</a>';
    const fire = (el: Element) => { const e = new Event('pointerover', { bubbles: true }); Object.defineProperty(e, 'pointerType', { value: 'mouse' }); el.dispatchEvent(e); };
    for (const [t, n] of [[null, 0], ['t', 1]] as const) {
      const requests = mockRequests({ 'GET /api/user': { user: { username: 'ada' } } });
      const r = await render(LIST, { requests, apis: api(), storage: withToken(t), pages: { 'settings.html': page() } });
      fire(r.root.querySelector('a')!);
      await r.advance(HOVER);
      await r.settle();
      expect(requests.calls.length).toBe(n);
    }
  });
});

describe('the build', () => {
  function build(html: string, apis: Record<string, ApiOptions & { openapi?: unknown }>, more: Partial<CompileOptions> = {}) {
    const openapi: OpenApiSpec[] = [];
    const a = resolveApis({ apis: apis as Record<string, ApiOptions> }, (doc) => (openapi.push({ file: '/app/spec.json', doc }), openapi.length - 1), openapi, '/app/vite.config.js');
    const opts = { file: '/app/index.html', root: '/app', dev: false, readFile: () => '', moduleSrc: '/page.js', helpers: { module: null, names: [], namespaces: {} }, prerender: true, early: { module: null }, apis: a.apis!, openapi, origins: ['https://api.example.com'], ...more } as CompileOptions;
    return compile(html, opts);
  }
  const errors = (out: { diagnostics: Array<{ code: string; message: string; severity: string }> }) => out.diagnostics.filter((d) => d.severity === 'error').map((d) => `${d.code} ${d.message}`);
  const main = { openapi: TOKEN_SPEC as unknown as string, token: { storage: 'local:jwt' as const, signIn: '/login' } };

  test('with swaps: the guard runs at each boot, the mount a swap makes', async () => {
    const out = build('<html data-sn-signed-in><head></head><body><p>Settings</p></body></html>', { main }, { swap: true });
    const names = /^import \{ ([^}]*) \} from '@tiaforge-ui\/sinter\/runtime';$/gm;
    const imports = [...out.module.matchAll(names)].map((m) => m[1]).join(', ');
    const code = out.module.replace(/^import .*$/gm, '').replaceAll('import.meta.url', '$url');
    const seen: string[] = [];
    setEnv({ ...defaultEnv, storage: () => memoryStorage(), session: () => memoryStorage(), href: () => 'http://localhost/settings', replace: (u) => { seen.push(u); } });
    const SWAPPING = Symbol.for('sinter.swapping'), PAGES = Symbol.for('sinter.pages');
    (globalThis as Record<symbol, unknown>)[SWAPPING] = true;
    try {
      await new Function('$sinter', 'sn$signed_in', '$tokens', '$url', `return (async () => { const { ${imports} } = $sinter; ${code} })();`)(runtime, guardFeature, $tokens, 'http://localhost/assets/s.js');
    } finally { delete (globalThis as Record<symbol, unknown>)[SWAPPING]; }
    expect(seen).toEqual([]);
    try { instance(document).destroy(); } catch { /* none mounted */ }
    const app = (globalThis as any)[PAGES]['http://localhost/assets/s.js'].boot();
    expect(seen).toEqual(['/login']);
    app.destroy();
  });

  test('the page module loads the guard, the early script checks first; the page is never static', () => {
    const out = build('<html data-sn-signed-in><head></head><body><p>Settings</p></body></html>', { main });
    expect(errors(out)).toEqual([]);
    expect(out.module).toContain("from '@tiaforge-ui/sinter/runtime/signed-in'");
    expect(out.early).toContain('"si":');
  });

  test('refused: no API with a token, no signIn, two APIs with tokens, the sign-in page itself, a condition over more than $url, not on <html>', () => {
    const p = (attr = 'data-sn-signed-in', path = '/settings') => `<html data-sn-path="${path}" ${attr}><head></head><body data-sn-state="{ x: 1 }"><p>x</p></body></html>`;
    expect(errors(build(p(), { main: { openapi: TOKEN_SPEC as unknown as string } }))[0]).toContain('SN347 `data-sn-signed-in` needs an API with a `token`');
    expect(errors(build(p(), { main: { ...main, token: { storage: 'local:jwt' } } }))[0]).toContain('has no `token.signIn`');
    expect(errors(build(p(), { main: { ...main, default: true }, other: { base: '/o', operations: { 'GET /x': {} }, token: { storage: 'local:o', signIn: '/in' } } }))[0]).toContain('`main` and `other` have a `token`');
    expect(errors(build(p('data-sn-signed-in', '/login'), { main }))[0]).toContain('on the sign-in page');
    expect(errors(build(p('data-sn-signed-in="$now.getTime() > 0"'), { main }))[0]).toContain('reads only `$url`');
    expect(errors(build('<html><head></head><body><div data-sn-signed-in></div></body></html>', { main }))[0]).toContain('SN102 `data-sn-signed-in` belongs on `<html>`');
  });
});
