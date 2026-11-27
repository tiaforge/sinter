// @vitest-environment node
// Whether a config module may change requests (request-hooks.ts): read from its syntax tree. A middleware that only
// reads the response keeps the early requests; anything the build cannot see through counts as changing them.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, test } from 'vitest';
import { changesRequests } from '../src/project.js';

const IMPORTS = "import { configure, onUnauthorized, header } from '@tiaforge-ui/sinter';\n";
const changes = (body: string) => changesRequests(IMPORTS + body);

describe('sinter\'s own hooks', () => {
  test('onUnauthorized only reads the response', () => {
    expect(changes('configure({ request: [onUnauthorized(async (req, res) => { location.href = "/"; return res; })], retry })')).toBe(false);
  });
  test('Caley\'s config, exactly', () => {
    expect(changesRequests(`// sinter app configuration, imported by every page before it mounts.
import { configure, onUnauthorized } from '@tiaforge-ui/sinter';
import { retryPolicies } from './lib/retry-policies.ts';
import { loginUrl } from './lib/return-url.ts';
import { withoutLocale } from './lib/locale-path.ts';
import './islands/common.ts';

configure({
  request: [
    // The same 401 handling as apiFetch (src/lib/api.ts): to the login page, which takes us back here after the sign-in.
    // On the login page itself a 401 from /api/user only means "not signed in": the user resource is null.
    onUnauthorized(async (req, res) => {
      if (withoutLocale(location.pathname) === '/') {
        return new URL(req.url).pathname === '/api/user' ? Response.json(null) : res;
      }
      location.href = loginUrl();
      return new Promise<Response>(() => {});
    }),
  ],
  // <sn-sync> reconnects only after this answers 2xx; a 401 goes to the login page. Retries ask it too.
  sessionProbe: '/api/user',
  retry: retryPolicies,
  urlSchemes: ['geo:', 'blob:'],
});
`, '/app/src/sinter.config.ts', '/app')).toBe(false);
  });
  test('header() changes requests, in the list or anywhere', () => {
    expect(changes("configure({ request: [header('X-Key', 'k')] })")).toBe(true);
    expect(changes("configure({ request: [onUnauthorized(h)] }); header('X-Key', 'k')")).toBe(true);
    expect(changes("configure({ onError: () => {} }); header('X-Key', 'k')")).toBe(true);
  });
  test('an onUnauthorized that is not sinter\'s counts as changing', () => {
    expect(changesRequests("import { configure } from '@tiaforge-ui/sinter';\nimport { onUnauthorized } from 'some-package';\nconfigure({ request: [onUnauthorized(h)] })")).toBe(true);
  });
});

describe('an app\'s own middleware', () => {
  test('passes the request on unchanged: inline, a module function, a const, a const list', () => {
    expect(changes('configure({ request: [async (req, next) => { const res = await next(req); if (res.status === 503) console.warn(req.url); return res; }] })')).toBe(false);
    expect(changes('configure({ request: [(req, next) => next(req).then((r) => r)] })')).toBe(false);
    expect(changes('function log(req, next) { console.log(req.url); return next(req); }\nconfigure({ request: [log] })')).toBe(false);
    expect(changes('const log = async (req, next) => { const t = Date.now(); const res = await next(req); console.log(Date.now() - t); return res; };\nconfigure({ request: [log, onUnauthorized(h)] })')).toBe(false);
    expect(changes('const request = [onUnauthorized(h)];\nconfigure({ request })')).toBe(false);
  });
  test('a new request, a written-into or reassigned one: changes', () => {
    expect(changes('configure({ request: [(req, next) => next(new Request(req, { headers: { A: "1" } }))] })')).toBe(true);
    expect(changes('configure({ request: [(req, next) => { req.headers.set("A", "1"); return next(req); }] })')).toBe(true);
    expect(changes('configure({ request: [(req, next) => { req = new Request(req); return next(req); }] })')).toBe(true);
    // through a function of the module that writes it
    expect(changes('function sign(r) { r.headers.set("A", "1"); }\nconfigure({ request: [(req, next) => { sign(req); return next(req); }] })')).toBe(true);
    // given to something the build cannot read
    expect(changes('configure({ request: [(req, next) => { window.tweak(req); return next(req); }] })')).toBe(true);
  });
  test('a hook that can veto or skip the request: changes', () => {
    expect(changes('configure({ request: [async (req, next) => { if (!navigator.onLine) return Response.error(); return next(req); }] })')).toBe(true);
    expect(changes('configure({ request: [async (req, next) => { if (!ok()) throw new Error("no"); return next(req); }] })')).toBe(true);
    expect(changes('configure({ request: [async (req, next) => (flag ? next(req) : Response.json(null))] })')).toBe(true);
    expect(changes('configure({ request: [async (req, next) => { try { return await next(req); } catch { return Response.error(); } }] })')).toBe(true);
    expect(changes('configure({ request: [async (req, next) => { for (let i = 0; i < 2; i++) await next(req); return next(req); }] })')).toBe(true);
    // never calls next, passes next on, or another argument
    expect(changes('configure({ request: [async (req, next) => Response.json(null)] })')).toBe(true);
    expect(changes('configure({ request: [(req, next) => other(req, next)] })')).toBe(true);
    expect(changes('configure({ request: [(req, next) => next(req, 1)] })')).toBe(true);
  });
  test('what the build cannot read: changes', () => {
    expect(changes('configure({ request: [...hooks] })')).toBe(true);
    expect(changes('configure({ request: hooks })')).toBe(true);
    expect(changes('configure({ request: [makeHook()] })')).toBe(true);
    expect(changes("import { hook } from 'a-package';\nconfigure({ request: [hook] })")).toBe(true);
    expect(changes('let request = [onUnauthorized(h)];\nrequest = [];\nconfigure({ request })')).toBe(true);
    expect(changes('configure(options)\nconst options = { request: [onUnauthorized(h)] }')).toBe(true);
    expect(changes('configure({ request: [onUnauthorized(h)] }); config.request.push(x)')).toBe(true);
  });
  test('the old answers stay', () => {
    expect(changesRequests('configure({ request: [auth] })')).toBe(true);
    expect(changesRequests('const request = [auth]; configure({ request })')).toBe(true);
    expect(changesRequests('configure({ onError: () => {} }) // request: none')).toBe(false);
    expect(changesRequests('configure({ sessionProbe: "/api/me" })')).toBe(false);
  });
});

describe('a hook imported from an app module', () => {
  const root = mkdtempSync(join(tmpdir(), 'sinter-hooks-'));
  afterAll(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'src', 'lib'), { recursive: true });
  writeFileSync(join(root, 'src', 'lib', 'hooks.ts'), `export function timing(req: Request, next: (r: Request) => Promise<Response>) { return next(req); }
export const signed = (req: Request, next: (r: Request) => Promise<Response>) => { stamp(req); return next(req); };
function stamp(r: Request) { r.headers.set('X-Stamp', '1'); }
const quiet = (req: Request, next: (r: Request) => Promise<Response>) => next(req);
export { quiet as alsoQuiet };
`);
  const config = join(root, 'src', 'sinter.config.ts');
  test('read through the import: passes on, or writes into the request', () => {
    expect(changesRequests(`${IMPORTS}import { timing } from './lib/hooks.ts';\nconfigure({ request: [timing] })`, config, root)).toBe(false);
    expect(changesRequests(`${IMPORTS}import { alsoQuiet } from './lib/hooks.ts';\nconfigure({ request: [alsoQuiet] })`, config, root)).toBe(false);
    expect(changesRequests(`${IMPORTS}import { signed } from './lib/hooks.ts';\nconfigure({ request: [signed] })`, config, root)).toBe(true);
    expect(changesRequests(`${IMPORTS}import { missing } from './lib/hooks.ts';\nconfigure({ request: [missing] })`, config, root)).toBe(true);
  });
});
