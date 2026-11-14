// `sinter({ apis })`: the APIs an app calls, resolved for the compiler, `sinter check` and the editor.
// A path written on a page (`src="billing:/invoices"`, `data-sn-delete="/contacts/{c.id}"`) is relative
// to one of them. Endpoints an API's config declares (`operations`) become a generated OpenAPI
// document, so matching, types and checks treat them as the spec's own. Pure; the project reads files.
import type { OpenApiSpec } from './openapi.js';
import type { Diagnostic } from './diagnostics.js';

/** What an endpoint returns, said once (`defaults` for the spec's operations, `operations` for others). */
export interface OperationShape {
  items?: string;
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
}

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
}

export interface ApisDef {
  list: ApiDef[];
  /** the API a path without `api:` goes to; null when several are configured and none is named */
  defaultApi: string | null;
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
  if (name == null) return { error: `several APIs are configured and \`defaultApi\` names none: write the API, e.g. \`${apis.list.find((a) => a.name !== SITE)?.name ?? 'main'}:/…\``, prefix };
  const api = apis.list.find((a) => a.name === name);
  if (!api) return { error: `no API \`${name}\`; the APIs are ${apis.list.map((a) => `\`${a.name}\``).join(', ')}`, prefix };
  return { api, path: value.slice(prefix), prefix };
}

/** Specs whose index is in `api.specs`, with their indexes. */
export const specsOf = (all: OpenApiSpec[], api: ApiDef) => api.specs.map((i) => ({ i, spec: all[i]! })).filter((x) => x.spec);

/** `sinter({ apis, defaultApi })`, checked (SN329) and resolved; each API's specs are loaded into `openapi`. */
export function resolveApis(
  options: { apis?: Record<string, ApiOptions>; defaultApi?: string; openapi?: unknown },
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
  const list: ApiDef[] = [];
  for (const [name, raw] of entries) {
    if (!/^[A-Za-z_][\w-]*$/.test(name)) { fail(`\`${name}\` is not an API name: a letter or \`_\`, then letters, digits, \`_\` and \`-\``); continue; }
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) { fail(`\`${name}\` takes an object (\`base\`, \`openapi\`, \`credentials\`, \`headers\`, \`defaults\`, \`operations\`)`); continue; }
    const a = raw as ApiOptions & Record<string, unknown>;
    for (const k of Object.keys(a)) if (!['base', 'openapi', 'credentials', 'headers', 'defaults', 'operations'].includes(k)) fail(`\`${name}.${k}\` is not an API setting; the settings are \`base\`, \`openapi\`, \`credentials\`, \`headers\`, \`defaults\` and \`operations\``);
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
      if (typeof shape !== 'object' || shape === null || Array.isArray(shape)) { fail(`\`${where}['${key}']\` takes an object (\`items\`, \`total\`, \`key\`, \`type\`, \`query\`)`); return false; }
      for (const [k, v] of Object.entries(shape)) {
        if (k === 'query') { if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) fail(`\`${where}['${key}'].query\` is a list of parameter names`); }
        else if (!['items', 'total', 'key', 'type'].includes(k)) fail(`\`${where}['${key}'].${k}\` is not a shape setting; the settings are \`items\`, \`total\`, \`key\`, \`type\` and \`query\``);
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
    if (Object.keys(ops).length) {
      openapi.push({ file: configFile, doc: operationsDoc(ops), config: name });
      specs.push(openapi.length - 1);
    }
    list.push({ name, base, specs, shapes, ...(a.credentials ? { credentials: a.credentials } : {}), ...(a.headers && Object.keys(a.headers).length ? { headers: { ...a.headers } } : {}) });
  }
  const own = list.filter((x) => x.name !== SITE);
  let defaultApi: string | null = options.defaultApi ?? (own.length === 1 ? own[0]!.name : null);
  if (options.defaultApi != null && !list.some((x) => x.name === options.defaultApi)) { fail(`\`defaultApi\` names \`${options.defaultApi}\`, which is no API`); defaultApi = null; }
  return { apis: { list, defaultApi }, diagnostics };
}
