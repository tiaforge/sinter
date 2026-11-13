// `sinter({ apis })`: the APIs an app calls, resolved for the compiler, `sinter check` and the editor.
// A path written on a page (`src="billing:/invoices"`, `data-sn-delete="/contacts/{c.id}"`) is relative
// to one of them. Endpoints an API's config declares (`operations`) become a generated OpenAPI
// document, so matching, types and checks treat them as the spec's own. Pure; the project reads files.
import type { OpenApiSpec } from './openapi.js';

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
