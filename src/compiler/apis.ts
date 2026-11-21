// `sinter({ apis })`: the APIs an app calls, resolved for the compiler, `sinter check` and the editor.
// A path written on a page (`src="billing:/invoices"`, `data-sn-delete="/contacts/{c.id}"`) is relative
// to one of them. Endpoints an API's config declares (`operations`) become a generated OpenAPI
// document, so matching, types and checks treat them as the spec's own. Pure; the project reads files.
import { authOf, deref, type Json, type OpenApiSpec } from './openapi.js';
import type { Diagnostic } from './diagnostics.js';
import type { UrlTemplate } from '../ir.js';
import { CONTENT, FILE } from './files.js';

/** What an endpoint returns, said once (`defaults` for the spec's operations, `operations` for others). */
export interface OperationShape {
  /** the path in the response where the data is (`articles`); default: the response itself */
  select?: string;
  total?: string;
  key?: string;
  /** a type from the types module, as `<sn-resource type>` */
  type?: string;
  /** query parameters the spec leaves out */
  query?: string[];
}

export interface ApiOptions {
  /** the URL every path is relative to: `/api`, `https://api.example.com/v1`; default: the spec's first server */
  base?: string;
  /** local OpenAPI 3 files (JSON or YAML) */
  openapi?: string | string[];
  credentials?: 'omit' | 'same-origin' | 'include';
  /** static headers for every request to this API; they are compiled into the page bundle */
  headers?: Record<string, string>;
  /** for operations of the spec, by `METHOD /path` */
  defaults?: Record<string, OperationShape>;
  /** endpoints the spec does not have, by `METHOD /path` */
  operations?: Record<string, OperationShape>;
  /** how this API's lists page: its parameter names and direction values, for every `paginate` of a resource on it */
  paginate?: PaginateWire;
  /** the API a path without `api:` goes to; with one API (besides `site`) it is that one */
  default?: boolean;
  /** a token the browser keeps and sends to this API (docs/apis.md#a-token) */
  token?: TokenOptions;
}

/**
 * `apis.<name>.token`: where the token is stored, how it is sent, which responses issue it. Sent only to the API's
 * own requests; the header name and default scheme come from the spec's `securitySchemes` (`http` bearer, `apiKey`
 * in a header) when it has them.
 */
export interface TokenOptions {
  /** `'local:<key>'` (localStorage) or `'session:<key>'` (sessionStorage): read on every request */
  storage: `local:${string}` | `session:${string}`;
  /** the header the token goes in; default: the spec's scheme's, else `Authorization` */
  header?: string;
  /** the word before the token (`'Token'`, `'Bearer'`), `''` for none; default: `Bearer` for an `http` bearer scheme or `Authorization` without a spec, else none */
  scheme?: string;
  /** where an action's 401 goes (`loginRedirect`'s options; a path: with the return URL stored for `takeReturnUrl`) */
  signIn?: string | { to: string; returnUrl?: { allow: string[]; param?: string } };
  /** the operations whose 2xx response issues a token, and where in the body: `{ 'POST /users/login': 'user.token' }` */
  from?: Record<string, string>;
  /** the operations that need the token (`METHOD /path`), besides those the spec's `security` says; default without a spec: all */
  required?: string[];
}

/** `token`, resolved. */
export interface TokenDef {
  storage: 'local' | 'session';
  key: string;
  header: string;
  /** the word before the token, `''` for none */
  scheme: string;
  signIn?: { to: string; returnUrl?: { allow: string[]; param?: string } };
  /** `METHOD /path` → where the token is in the body */
  from: Record<string, string>;
  /** the operations that need the token, `METHOD /path` as the spec writes them; null: every operation */
  required: string[] | null;
}

/**
 * A server's pagination parameters (docs/pagination.md): the names it reads, the values it gives the directions, and
 * the path in its response that says whether there are more items in the direction asked for.
 */
export interface PaginateWire {
  params?: { size?: string; page?: string; offset?: string; direction?: string };
  directions?: Partial<Record<'first' | 'prev' | 'next' | 'last', string>>;
  more?: string;
}

/** A response path, as `select` and `total` take them: dot-separated field names (`has_more`, `meta.has_more`). */
export const RESPONSE_PATH = /^[^.\s]+(\.[^.\s]+)*$/;

/** One API, resolved. */
export interface ApiDef {
  name: string;
  /** no trailing `/`; `''` is the page's own origin */
  base: string;
  /** indexes into the specs passed to the compiler: the API's own specs, then its `operations` document */
  specs: number[];
  credentials?: 'omit' | 'same-origin' | 'include';
  headers?: Record<string, string>;
  /** shapes by `METHOD /path` (method in capitals), from `defaults` and `operations` */
  shapes: Record<string, OperationShape>;
  paginate?: PaginateWire;
  token?: TokenDef;
}

export interface ApisDef {
  list: ApiDef[];
  /** the API a path without `api:` goes to (`default: true`, or the only one); null when several are configured and none is the default */
  defaultApi: string | null;
}

/** `apis.<name>.paginate`, checked: string values for the known keys; undefined when it is wrong (reported). */
function paginateWire(raw: unknown, where: string, fail: (m: string) => void): PaginateWire | undefined {
  const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
  if (!isObj(raw)) { fail(`\`${where}\` takes an object: \`{ params: { size: 'per_page' }, directions: { prev: 'backward' } }\``); return undefined; }
  const out: PaginateWire = {};
  for (const [k, keys] of [['params', ['size', 'page', 'offset', 'direction']], ['directions', ['first', 'prev', 'next', 'last']]] as const) {
    const v = raw[k];
    if (v === undefined) continue;
    if (!isObj(v)) { fail(`\`${where}.${k}\` takes an object of strings`); return undefined; }
    for (const [n, x] of Object.entries(v)) {
      if (!(keys as readonly string[]).includes(n)) { fail(`\`${where}.${k}.${n}\` is not a key; the keys are ${keys.map((y) => `\`${y}\``).join(', ')}`); return undefined; }
      if (typeof x !== 'string' || !x || (k === 'params' && !/^[\w.\-[\]]+$/.test(x))) { fail(`\`${where}.${k}.${n}\` is ${k === 'params' ? 'a query parameter name' : 'a non-empty string'}`); return undefined; }
    }
    (out as Record<string, unknown>)[k] = { ...v };
  }
  if (raw.more !== undefined) {
    if (typeof raw.more !== 'string' || !RESPONSE_PATH.test(raw.more)) { fail(`\`${where}.more\` is a path in the response, such as \`'has_more'\``); return undefined; }
    out.more = raw.more;
  }
  for (const k of Object.keys(raw)) if (k !== 'params' && k !== 'directions' && k !== 'more') { fail(`\`${where}.${k}\` is not a setting; it takes \`params\`, \`directions\` and \`more\``); return undefined; }
  return out;
}

/** The headers a spec's security schemes send a token in (`http` bearer, `apiKey` in a header), with their default scheme word. */
function specHeaders(docs: unknown[]): Array<{ header: string; scheme: string }> {
  const out = new Map<string, string>();
  for (const doc of docs) {
    const ss = (doc as { components?: { securitySchemes?: Record<string, unknown> } })?.components?.securitySchemes;
    if (!ss || typeof ss !== 'object') continue;
    for (const raw of Object.values(ss)) {
      const x = deref(doc, raw);
      if (x?.type === 'http' && typeof x.scheme === 'string' && x.scheme.toLowerCase() === 'bearer') out.set('authorization', 'Bearer');
      else if (x?.type === 'apiKey' && x.in === 'header' && typeof x.name === 'string' && !out.has(x.name.toLowerCase())) out.set(x.name.toLowerCase(), '');
    }
  }
  return [...out].map(([header, scheme]) => ({ header: header === 'authorization' ? 'Authorization' : header, scheme }));
}

/** The operations of these documents whose `security` needs a token, as `METHOD /path`. */
function tokenOperations(docs: unknown[]): string[] {
  const out: string[] = [];
  for (const doc of docs) {
    const paths = (doc as { paths?: Record<string, unknown> })?.paths;
    if (!paths || typeof paths !== 'object') continue;
    for (const [path, raw] of Object.entries(paths)) {
      const item = deref(doc, raw);
      for (const m of METHODS) {
        const op = item ? deref(doc, item[m.toLowerCase()]) : null;
        if (op && authOf(doc as Json, op) === 'token') out.push(`${m} ${path}`);
      }
    }
  }
  return out;
}

/** `apis.<name>.token`, checked (SN329) and resolved against the API's specs; `has`: whether the API has the operation. */
function tokenOf(raw: unknown, name: string, docs: unknown[], has: (method: string, path: string) => boolean, fail: (m: string) => void): TokenDef | undefined {
  const where = `${name}.token`;
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) { fail(`\`${where}\` takes an object: \`{ storage: 'local:token', from: { 'POST /login': 'token' } }\``); return undefined; }
  const t = raw as Record<string, unknown>;
  const keys = ['storage', 'header', 'scheme', 'signIn', 'from', 'required'];
  for (const k of Object.keys(t)) if (!keys.includes(k)) { fail(`\`${where}.${k}\` is not a token setting; the settings are ${keys.map((x) => `\`${x}\``).join(', ')}`); return undefined; }
  const st = typeof t.storage === 'string' ? /^(local|session):(.+)$/.exec(t.storage) : null;
  if (!st) { fail(`\`${where}.storage\` is \`'local:<key>'\` (localStorage) or \`'session:<key>'\` (sessionStorage), e.g. \`'local:token'\``); return undefined; }
  if (t.header != null && (typeof t.header !== 'string' || !/^[!#$%&'*+.^\w|~-]+$/.test(t.header))) { fail(`\`${where}.header\` is a header name, e.g. \`'Authorization'\``); return undefined; }
  if (t.scheme != null && (typeof t.scheme !== 'string' || !/^([A-Za-z][\w.~+/-]*)?$/.test(t.scheme))) { fail(`\`${where}.scheme\` is the word before the token (\`'Bearer'\`, \`'Token'\`), or \`''\` for none`); return undefined; }
  let signIn: TokenDef['signIn'];
  if (t.signIn != null) {
    const v = t.signIn as { to?: unknown; returnUrl?: { allow?: unknown; param?: unknown } };
    const path = (x: unknown): x is string => typeof x === 'string' && /^\/(?![/\\])/.test(x);
    if (path(v)) signIn = { to: v, returnUrl: { allow: ['/'] } };
    else if (v && typeof v === 'object' && path(v.to) && (v.returnUrl == null || (Array.isArray(v.returnUrl.allow) && v.returnUrl.allow.every(path) && (v.returnUrl.param == null || typeof v.returnUrl.param === 'string')))) {
      signIn = { to: v.to, ...(v.returnUrl ? { returnUrl: { allow: [...v.returnUrl.allow as string[]], ...(v.returnUrl.param != null ? { param: v.returnUrl.param as string } : {}) } } : {}) };
    } else { fail(`\`${where}.signIn\` is a same-origin path (\`'/login'\`), or \`loginRedirect\`'s options, \`{ to: '/login', returnUrl: { allow: ['/'], param: 'next' } }\``); return undefined; }
  }
  const from: Record<string, string> = {};
  if (t.from != null) {
    if (typeof t.from !== 'object' || Array.isArray(t.from)) { fail(`\`${where}.from\` maps operations to where the token is in their response: \`{ 'POST /users/login': 'user.token' }\``); return undefined; }
    for (const [key, at] of Object.entries(t.from)) {
      const op = parseOperationKey(key);
      if (!op) { fail(`\`${where}.from\` names operations as \`METHOD /path\`, not \`${key}\``); return undefined; }
      if (!has(op.method, op.path)) { fail(`\`${where}.from\` names \`${key}\`, which is no operation of the API \`${name}\``); return undefined; }
      if (typeof at !== 'string' || !/^[\w$-]+(\.[\w$-]+)*$/.test(at)) { fail(`\`${where}.from['${key}']\` is where the token is in the response body, a dotted path such as \`'user.token'\``); return undefined; }
      from[key] = at;
    }
  }
  let listed: string[] | null = null;
  if (t.required != null) {
    if (!Array.isArray(t.required)) { fail(`\`${where}.required\` is a list of operations, \`['GET /me']\``); return undefined; }
    listed = [];
    for (const key of t.required as unknown[]) {
      const op = typeof key === 'string' ? parseOperationKey(key) : null;
      if (!op || !has(op.method, op.path)) { fail(`\`${where}.required\` names \`${String(key)}\`, which is no operation of the API \`${name}\` (\`METHOD /path\`)`); return undefined; }
      listed.push(key as string);
    }
  }
  const found = specHeaders(docs);
  if (t.header == null && found.length > 1) { fail(`\`${where}.header\`: the spec sends a token in ${found.map((f) => `\`${f.header}\``).join(' or ')}; say which`); return undefined; }
  const header = (t.header as string | undefined) ?? found[0]?.header ?? 'Authorization';
  const spec = found.find((f) => f.header.toLowerCase() === header.toLowerCase());
  const scheme = (t.scheme as string | undefined) ?? spec?.scheme ?? (!found.length && header.toLowerCase() === 'authorization' ? 'Bearer' : '');
  // without a spec and without a list, every operation needs it
  const required = listed == null && !docs.length ? null : [...new Set([...tokenOperations(docs), ...(listed ?? [])])];
  return { storage: st[1] as 'local' | 'session', key: st[2]!, header, scheme, ...(signIn ? { signIn } : {}), from, required };
}

/**
 * A token at runtime (`$apis`): `s` its storage (`l`ocal, `s`ession) and `k` its key, `h` the header, `p` what goes
 * before the token (`'Token '`), `r` the GET paths that need it (absent: all), `f` the operations
 * whose response issues it and where in the body, `i` where an action's 401 goes. Nothing of the token itself.
 */
export interface RuntimeToken { s: 'l' | 's'; k: string; h: string; p: string; r?: string[]; f?: Record<string, string>; i?: string | NonNullable<TokenDef['signIn']> }

/** `signIn` as the page carries it: a path alone when it is the path form (its return URL allowed anywhere, stored, no parameter) */
export function signInWire(s: NonNullable<TokenDef['signIn']>): string | NonNullable<TokenDef['signIn']> {
  return s.returnUrl && !s.returnUrl.param && s.returnUrl.allow.length === 1 && s.returnUrl.allow[0] === '/' ? s.to : s;
}

/** What the runtime gets of an API (the page module's `$apis`, the testing module): name, base, credentials, static headers, token. */
export function runtimeApi(a: ApiDef): { n: string; b: string; c?: 'omit' | 'same-origin' | 'include'; h?: Record<string, string>; t?: RuntimeToken } {
  const t = a.token;
  return {
    n: a.name, b: a.base, ...(a.credentials ? { c: a.credentials } : {}), ...(a.headers ? { h: a.headers } : {}),
    ...(t ? { t: { s: t.storage === 'local' ? 'l' as const : 's' as const, k: t.key, h: t.header, p: t.scheme ? t.scheme + ' ' : '', ...(t.required ? { r: t.required.filter((k) => k.startsWith('GET ')).map((k) => k.slice(4)) } : {}), ...(Object.keys(t.from).length ? { f: t.from } : {}), ...(t.signIn ? { i: signInWire(t.signIn) } : {}) } } : {}),
  };
}

/** The built-in API of the page's own origin. */
export const SITE = 'site';

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;

/** `GET /a/{b}` → `{ method: 'get', path: '/a/{b}' }`, or null. */
export function parseOperationKey(key: string): { method: Lowercase<typeof METHODS[number]>; path: string } | null {
  const m = /^(GET|POST|PUT|PATCH|DELETE) (\/\S*)$/.exec(key);
  return m ? { method: m[1]!.toLowerCase() as Lowercase<typeof METHODS[number]>, path: m[2]! } : null;
}

/** A base: `''`, a same-origin path (`/api`), or an `http(s)://` origin with an optional path; never a trailing `/`. */
export function validBase(b: string): boolean {
  if (b === '') return true;
  if (b.endsWith('/')) return false;
  if (/^\/(?![/\\])/.test(b)) return !/[?#{}]/.test(b);
  return /^https?:\/\/[^/?#{}\\]+(\/[^?#{}]*)?$/i.test(b);
}

/** The spec's first server URL with its variables' defaults, without a trailing `/` (the default of `base`). */
export function specBase(doc: unknown): string {
  const servers = (doc as { servers?: unknown })?.servers;
  const s = Array.isArray(servers) ? servers[0] as { url?: unknown; variables?: Record<string, { default?: unknown }> } | undefined : undefined;
  if (!s || typeof s.url !== 'string') return '';
  return s.url.replace(/\{([^}]+)\}/g, (_, n: string) => String(s.variables?.[n]?.default ?? '')).replace(/\/+$/, '');
}

/** The generated OpenAPI document of an API's `operations`: its paths, path and query parameters; no responses (the type is the config's). */
export function operationsDoc(operations: Record<string, OperationShape>): Record<string, unknown> {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const [key, shape] of Object.entries(operations)) {
    const op = parseOperationKey(key);
    if (!op) continue;
    const params = [
      ...[...op.path.matchAll(/\{([^}]+)\}/g)].map((m) => ({ name: m[1], in: 'path', required: true })),
      ...(shape.query ?? []).map((name) => ({ name, in: 'query' })),
    ];
    (paths[op.path] ??= {})[op.method] = { parameters: params, responses: {} };
  }
  return { openapi: '3.0.3', info: { title: 'sinter({ apis }) operations', version: '0' }, servers: [{ url: '/' }], paths };
}

/** The origins of the absolute bases (`https://api.example.com`), for the allowlist. */
export function apiOrigins(apis: ApisDef | null | undefined): string[] {
  const out = new Set<string>();
  for (const a of apis?.list ?? []) {
    const m = /^https?:\/\/[^/]+/i.exec(a.base);
    if (m) out.add(new URL(m[0]).origin);
  }
  return [...out];
}

/** The API a written path names (`billing:/x` → billing, `/x` → the default), and the path; or why not. */
export function apiOf(apis: ApisDef, value: string): { api: ApiDef; path: string; prefix: number } | { error: string; prefix: number } {
  const m = /^([A-Za-z_][\w-]*):(?=\/)/.exec(value);
  const name = m ? m[1]! : apis.defaultApi;
  const prefix = m ? m[0].length : 0;
  if (name == null) return { error: `several APIs are configured and none is the default (\`default: true\`): write the API, e.g. \`${apis.list.find((a) => a.name !== SITE)?.name ?? 'main'}:/…\``, prefix };
  const api = apis.list.find((a) => a.name === name);
  if (!api) return { error: `no API \`${name}\`; the APIs are ${apis.list.map((a) => `\`${a.name}\``).join(', ')}`, prefix };
  return { api, path: value.slice(prefix), prefix };
}

/** The text of a URL attribute with its values as markers, for matching before it is compiled (the `key` of a resource). */
export function shapeTemplate(value: string): UrlTemplate {
  const out: UrlTemplate = [];
  let lit = '', depth = 0, q: string | null = null;
  for (let i = 0; i < value.length; i++) {
    const c = value[i]!;
    if (depth) {
      if (q) { if (c === '\\') i++; else if (c === q) q = null; continue; }
      if (c === '"' || c === "'" || c === '`') q = c;
      else if (c === '{') depth++;
      else if (c === '}' && --depth === 0) out.push(0);
      continue;
    }
    if (c === '{') { if (lit) out.push(lit); lit = ''; depth = 1; continue; }
    lit += c;
  }
  if (lit) out.push(lit);
  return out;
}

/** Specs whose index is in `api.specs`, with their indexes. */
export const specsOf = (all: OpenApiSpec[], api: ApiDef) => api.specs.map((i) => ({ i, spec: all[i]! })).filter((x) => x.spec);

/** `sinter({ defaultApi })` and `render({ defaultApi })`: the default is a setting of the API it names */
export const defaultApiRenamed = (fn: string, name: unknown) =>
  `${fn}({ defaultApi }) is renamed to \`apis: { ${typeof name === 'string' && /^[A-Za-z_][\w-]*$/.test(name) ? name : 'main'}: { default: true } }\`: the default is a setting of the API, beside its \`base\` and \`openapi\``;

/** `sinter({ apis })`, checked (SN329) and resolved; each API's specs are loaded into `openapi`. */
export function resolveApis(
  options: { apis?: Record<string, ApiOptions>; openapi?: unknown },
  loadSpec: (spec: unknown) => number | null, openapi: OpenApiSpec[], configFile: string,
): { apis: ApisDef | null; diagnostics: Diagnostic[] } {
  const diagnostics: Diagnostic[] = [];
  const fail = (message: string) => diagnostics.push({ severity: 'error', code: 'SN329', message: `sinter({ apis }): ${message}`, file: configFile, line: 1, col: 1 });
  const given = options.apis;
  if (typeof given !== 'object' || given === null || Array.isArray(given)) {
    fail('takes an object of APIs by name, e.g. `apis: { main: { base: \'/api\', openapi: \'openapi.yml\' } }`');
    return { apis: null, diagnostics };
  }
  if (options.openapi != null) fail('`openapi` moves into an API: `apis: { main: { openapi: … } }`; remove the top-level `openapi`');
  const entries = Object.entries(given);
  if (!entries.some(([n]) => n === SITE)) entries.push([SITE, {}]);
  const list: ApiDef[] = [], defaults: string[] = [];
  for (const [name, raw] of entries) {
    if (!/^[A-Za-z_][\w-]*$/.test(name)) { fail(`\`${name}\` is not an API name: a letter or \`_\`, then letters, digits, \`_\` and \`-\``); continue; }
    if (name === FILE) { fail('`file` is the built-in source of the project\'s own files (`src="file:./post.txt"`): name the API otherwise'); continue; }
    if (name === CONTENT) { fail('`content` is the built-in source of the content module\'s collections (`src="content:posts"`): name the API otherwise'); continue; }
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) { fail(`\`${name}\` takes an object (\`base\`, \`openapi\`, \`credentials\`, \`headers\`, \`defaults\`, \`operations\`, \`paginate\`, \`default\`, \`token\`)`); continue; }
    const a = raw as ApiOptions & Record<string, unknown>;
    for (const k of Object.keys(a)) if (!['base', 'openapi', 'credentials', 'headers', 'defaults', 'operations', 'paginate', 'default', 'token'].includes(k)) fail(`\`${name}.${k}\` is not an API setting; the settings are \`base\`, \`openapi\`, \`credentials\`, \`headers\`, \`defaults\`, \`operations\`, \`paginate\`, \`default\` and \`token\``);
    if (a.default != null && typeof a.default !== 'boolean') fail(`\`${name}.default\` is \`true\` or \`false\``);
    if (a.default === true) defaults.push(name);
    const paginate = a.paginate == null ? undefined : paginateWire(a.paginate, `${name}.paginate`, fail);
    const specs: number[] = [];
    for (const rel of (a.openapi == null ? [] : Array.isArray(a.openapi) ? a.openapi : [a.openapi]) as unknown[]) {
      const i = loadSpec(rel);
      if (i != null) specs.push(i);
    }
    let base = specs.length ? specBase(openapi[specs[0]!]!.doc) : '';
    if ('base' in a) {
      if (a.base === undefined) fail(`\`${name}.base\` is \`undefined\` (an environment variable that is not set?); it does not fall back to the spec's server`);
      else if (typeof a.base !== 'string' || !validBase(a.base)) fail(`\`${name}.base\` must be \`''\`, a same-origin path (\`/api\`) or an \`https://\` URL, with no trailing \`/\`, not \`${String(a.base)}\``);
      else base = a.base;
    }
    if (name === SITE && base !== '') { fail('`site` is the page\'s own origin: its `base` cannot be changed'); base = ''; }
    if (a.credentials != null && !['omit', 'same-origin', 'include'].includes(a.credentials)) fail(`\`${name}.credentials\` is \`'omit'\`, \`'same-origin'\` or \`'include'\``);
    if (a.headers != null && (typeof a.headers !== 'object' || Object.values(a.headers).some((v) => typeof v !== 'string'))) fail(`\`${name}.headers\` is an object of header names and string values`);
    const shapes: Record<string, OperationShape> = {};
    const has = (method: string, path: string) => specs.some((i) => {
      const paths = (openapi[i]!.doc as { paths?: Record<string, Record<string, unknown>> }).paths;
      return !!paths && typeof paths[path] === 'object' && paths[path] !== null && method in paths[path]!;
    });
    const shapeOk = (where: string, key: string, shape: unknown): shape is OperationShape => {
      if (typeof shape !== 'object' || shape === null || Array.isArray(shape)) { fail(`\`${where}['${key}']\` takes an object (\`select\`, \`total\`, \`key\`, \`type\`, \`query\`)`); return false; }
      for (const [k, v] of Object.entries(shape)) {
        if (k === 'query') { if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) fail(`\`${where}['${key}'].query\` is a list of parameter names`); }
        else if (k === 'items') fail(`\`${where}['${key}'].items\` is renamed to \`select\`, as \`<sn-resource select>\`: the path in the response where the data is, a list or one object (\`select: 'articles'\`)`);
        else if (!['select', 'total', 'key', 'type'].includes(k)) fail(`\`${where}['${key}'].${k}\` is not a shape setting; the settings are \`select\`, \`total\`, \`key\`, \`type\` and \`query\``);
        else if (typeof v !== 'string' || !v.trim()) fail(`\`${where}['${key}'].${k}\` is a non-empty string`);
      }
      return true;
    };
    const keyOk = (where: string, key: string) => {
      const op = parseOperationKey(key);
      if (!op) fail(`\`${where}\` names operations as \`METHOD /path\` (\`GET /contacts/{id}\`), not \`${key}\``);
      return op;
    };
    for (const [key, shape] of Object.entries(a.defaults ?? {})) {
      const op = keyOk(`${name}.defaults`, key);
      if (!op || !shapeOk(`${name}.defaults`, key, shape)) continue;
      if (!has(op.method, op.path)) { fail(`\`${name}.defaults\` names \`${key}\`, which ${specs.length ? 'its spec does not have' : 'has no spec'}: an endpoint the spec does not have goes in \`${name}.operations\``); continue; }
      shapes[key] = shape;
    }
    const ops: Record<string, OperationShape> = {};
    for (const [key, shape] of Object.entries(a.operations ?? {})) {
      const op = keyOk(`${name}.operations`, key);
      if (!op || !shapeOk(`${name}.operations`, key, shape)) continue;
      if (has(op.method, op.path)) { fail(`\`${name}.operations\` names \`${key}\`, which the spec has: its shape goes in \`${name}.defaults\``); continue; }
      ops[key] = shape;
      shapes[key] = shape;
    }
    const ownSpecs = specs.length;
    if (Object.keys(ops).length) {
      openapi.push({ file: configFile, doc: operationsDoc(ops), config: name });
      specs.push(openapi.length - 1);
    }
    const token = a.token == null ? undefined : tokenOf(a.token, name, specs.slice(0, ownSpecs).map((i) => openapi[i]!.doc), (m, k) => has(m, k) || !!ops[`${m.toUpperCase()} ${k}`], fail);
    list.push({ name, base, specs, shapes, ...(paginate ? { paginate } : {}), ...(a.credentials ? { credentials: a.credentials } : {}), ...(a.headers && Object.keys(a.headers).length ? { headers: { ...a.headers } } : {}), ...(token ? { token } : {}) });
  }
  const own = list.filter((x) => x.name !== SITE);
  let defaultApi: string | null = defaults[0] ?? (own.length === 1 ? own[0]!.name : null);
  if (defaults.length > 1) { fail(`one API is the default, not ${defaults.map((n) => `\`${n}\``).join(' and ')} (\`default: true\`)`); defaultApi = null; }
  return { apis: { list, defaultApi }, diagnostics };
}
