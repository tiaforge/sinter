// Matches a resource's `src` against OpenAPI specs: which GET operation it calls,
// the JSON schema of what `items` selects, and the query parameters the operation
// declares. Pure; the adapter parses the spec files.
import type { UrlTemplate } from '../ir.js';
import { suggest } from './diagnostics.js';

export interface OpenApiSpec {
  /** absolute path, for messages */
  file: string;
  /** the parsed document (OpenAPI 3.0 or 3.1) */
  doc: unknown;
  /** a document generated from `sinter({ apis })`: the API whose `operations` it holds (`file` is the Vite config) */
  config?: string;
}

export interface OpenApiMatch {
  spec: number;
  /** the spec's path key, e.g. `/articles/{slug}` */
  path: string;
  /** schema of the response body, or null when the operation has no JSON 2xx response */
  body: unknown;
  /** names of the query parameters the operation declares */
  query: string[];
  /** the declared query parameters that are required */
  required: string[];
  /** query parameters declared with `style: deepObject` (`filter[name]=…`) */
  deep: string[];
  /** schema of the JSON request body, or null */
  request: unknown;
}

export type Method = 'get' | 'post' | 'put' | 'patch' | 'delete';

export type Json = Record<string, unknown>;
const INTERP = '\u0000';

const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Follows `$ref`s inside the document (`#/components/…`); external refs resolve to null. */
export function deref(doc: unknown, v: unknown, seen = 0): Json | null {
  if (!isObj(v)) return null;
  if (typeof v.$ref !== 'string') return v;
  if (seen > 32 || !v.$ref.startsWith('#/')) return null;
  let cur: unknown = doc;
  for (const raw of v.$ref.slice(2).split('/')) {
    const key = raw.replace(/~1/g, '/').replace(/~0/g, '~');
    cur = isObj(cur) ? cur[key] : undefined;
  }
  return deref(doc, cur, seen + 1);
}

/** `/api/x/{…}?a={…}` as text, interpolations replaced by a marker. */
function flatten(src: UrlTemplate): { path: string; query: string } {
  const text = src.map((p) => (typeof p === 'string' ? p : INTERP)).join('');
  const q = text.indexOf('?');
  return q < 0 ? { path: text, query: '' } : { path: text.slice(0, q), query: text.slice(q + 1) };
}

function serverPrefixes(doc: Json): string[] {
  const servers = Array.isArray(doc.servers) && doc.servers.length ? doc.servers : [{ url: '/' }];
  return servers.filter(isObj).map((s) => {
    const vars = isObj(s.variables) ? s.variables : {};
    const url = String(s.url ?? '/').replace(/\{([^}]+)\}/g, (_, n: string) => String((vars[n] as Json | undefined)?.default ?? ''));
    return url.replace(/\/+$/, '');
  });
}

const segments = (p: string) => p.split('/').filter((s, i, a) => !(s === '' && (i === 0 || i === a.length - 1)));

/** Score of a spec path against the request path segments, or -1. Literal matches beat parameters. */
function score(specPath: string, segs: string[]): number {
  const want = segments(specPath);
  if (want.length !== segs.length) return -1;
  let n = 0;
  for (let i = 0; i < want.length; i++) {
    const w = want[i]!, s = segs[i]!;
    if (!w.includes('{')) {
      if (w !== s) return -1;
      n += 2;
      continue;
    }
    if (w.replace(/\{[^}]+\}/g, INTERP) === s) { n += 1; continue; }
    if (s.includes(INTERP)) return -1;
    const re = new RegExp('^' + w.split(/\{[^}]+\}/).map((x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[^/]+') + '$');
    if (!re.test(s)) return -1;
    n += 1;
  }
  return n;
}

/** The request path after the server prefix, for each spec whose servers it starts with. */
function relativePaths(doc: Json, path: string): string[] {
  const out: string[] = [];
  const origin = /^https?:\/\/[^/]+/i.exec(path)?.[0] ?? '';
  for (const prefix of serverPrefixes(doc)) {
    let rest: string | null = null;
    if (/^https?:\/\//i.test(prefix)) rest = path.toLowerCase().startsWith(prefix.toLowerCase()) ? path.slice(prefix.length) : null;
    else {
      const p = path.slice(origin.length);
      rest = p.startsWith(prefix) ? p.slice(prefix.length) : null;
    }
    if (rest !== null && (rest === '' || rest.startsWith('/'))) out.push(rest);
  }
  return out;
}

export function matchResource(specs: OpenApiSpec[], src: UrlTemplate): OpenApiMatch | { closest: string | null } {
  return matchOperation(specs, src, 'get');
}

/**
 * The operation a request with this method and URL template calls. `only`: the specs of one API
 * (`sinter({ apis })`), whose paths the template is written relative to (no server prefix).
 */
export function matchOperation(specs: OpenApiSpec[], src: UrlTemplate, method: Method, only?: number[]): OpenApiMatch | { closest: string | null } {
  const { path } = flatten(src);
  let best: { spec: number; path: string; score: number } | null = null;
  specs.forEach((spec, i) => {
    if (!isObj(spec.doc) || !isObj(spec.doc.paths)) return;
    if (only && !only.includes(i)) return;
    for (const rest of only ? [path] : relativePaths(spec.doc, path)) {
      const segs = segments(rest);
      for (const [key, item] of Object.entries(spec.doc.paths)) {
        if (!isObj(item) || !isObj(item[method])) continue;
        const s = score(key, segs);
        if (s >= 0 && (!best || s > best.score)) best = { spec: i, path: key, score: s };
      }
    }
  });
  if (!best) {
    const want = path.replace(/^https?:\/\/[^/]+/i, '').split(INTERP).join('{}');
    const keys = specs.flatMap((s, i) => (isObj(s.doc) && isObj(s.doc.paths) && (!only || only.includes(i)) ? Object.keys(s.doc.paths).filter((k) => !only || isObj((s.doc as Json & { paths: Json }).paths[k]) && isObj(((s.doc as Json & { paths: Json }).paths[k] as Json)[method])) : []));
    const norm = new Map(keys.map((k) => [k.replace(/\{[^}]+\}/g, '{}'), k]));
    // the request path still carries the server prefix; compare its tails too
    const tails = want.split('/').map((_, i, a) => '/' + a.slice(i).join('/'));
    let close: string | undefined;
    for (const t of tails) if ((close = suggest(t, norm.keys()))) break;
    return { closest: close ? norm.get(close)! : null };
  }
  const { spec, path: key } = best as { spec: number; path: string };
  const doc = specs[spec]!.doc as Json;
  const item = deref(doc, (doc.paths as Json)[key])!;
  const op = deref(doc, item[method])!;
  const declared = [...(Array.isArray(item.parameters) ? item.parameters : []), ...(Array.isArray(op.parameters) ? op.parameters : [])]
    .map((p) => deref(doc, p)).filter((p): p is Json => !!p && p.in === 'query');
  const params = declared.map((p) => String(p.name));
  return {
    spec, path: key, body: responseSchema(doc, op), query: params, request: jsonSchema(doc, deref(doc, op.requestBody)),
    required: declared.filter((p) => p.required === true).map((p) => String(p.name)),
    deep: declared.filter((p) => p.style === 'deepObject').map((p) => String(p.name)),
  };
}

function responseSchema(doc: Json, op: Json): unknown {
  const responses = deref(doc, op.responses);
  if (!responses) return null;
  const key = Object.keys(responses).filter((k) => /^2(\d\d|XX)$/i.test(k)).sort()[0];
  return jsonSchema(doc, key ? deref(doc, responses[key]) : null);
}

/** The JSON schema of a response or request body object. */
function jsonSchema(doc: Json, res: Json | null): unknown {
  const content = res && isObj(res.content) ? res.content : null;
  if (!content) return null;
  const media = Object.keys(content).find((m) => /^application\/json\b/i.test(m)) ?? Object.keys(content).find((m) => /\+json\b/i.test(m));
  const m = media ? deref(doc, content[media]) : null;
  return m?.schema ?? null;
}

/** Properties an object schema has, through `allOf`, `oneOf` and `anyOf`. */
export function properties(doc: unknown, schema: unknown, seen = 0): Map<string, unknown> {
  const out = new Map<string, unknown>();
  const s = deref(doc, schema);
  if (!s || seen > 16) return out;
  if (isObj(s.properties)) for (const [k, v] of Object.entries(s.properties)) out.set(k, v);
  for (const key of ['allOf', 'oneOf', 'anyOf']) {
    if (Array.isArray(s[key])) for (const sub of s[key]) for (const [k, v] of properties(doc, sub, seen + 1)) if (!out.has(k)) out.set(k, v);
  }
  return out;
}

/** Walks a dotted path (`data.items`) into a schema: the schema there, or the segment that is missing. */
export function walk(doc: unknown, schema: unknown, path: string): { schema: unknown } | { missing: string; have: string[] } {
  let cur = schema;
  for (const seg of path.split('.')) {
    const props = properties(doc, cur);
    if (!props.has(seg)) return { missing: seg, have: [...props.keys()] };
    cur = props.get(seg);
  }
  return { schema: cur };
}

/** Query parameter names written literally in a URL template's query string. */
export function queryNames(src: UrlTemplate): string[] {
  const { query } = flatten(src);
  if (!query) return [];
  return query.split('&').map((kv) => kv.split('=')[0]!).filter((k) => k && !k.includes(INTERP)).map((k) => {
    try { return decodeURIComponent(k); } catch { return k; }
  });
}

const SCHEMAS = '#/components/schemas/';

const isObjectSchema = (s: Json | null) => !!s && (s.type === 'object' || isObj(s.properties) || Array.isArray(s.allOf));

/** JSON with object keys sorted, so two copies of one schema compare equal. */
const canon = (v: unknown): string => Array.isArray(v) ? `[${v.map(canon).join(',')}]`
  : isObj(v) ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canon(v[k])}`).join(',')}}` : JSON.stringify(v);

/** Component object schemas by their canonical JSON: specs often inline a copy of a schema instead of a `$ref` (RealWorld's list response does). */
const byShape = new WeakMap<object, Map<string, string>>();
function shapes(doc: unknown): Map<string, string> {
  if (!isObj(doc)) return new Map();
  let m = byShape.get(doc);
  if (m) return m;
  m = new Map();
  const comps = isObj(doc.components) && isObj(doc.components.schemas) ? doc.components.schemas : {};
  for (const [name, s] of Object.entries(comps)) if (isObj(s) && isObjectSchema(s) && !m.has(canon(s))) m.set(canon(s), name);
  byShape.set(doc, m);
  return m;
}

/**
 * The component schema an object (or an array of objects) is, by name: `{ $ref: '#/components/schemas/Article' }` → `Article`;
 * an inline object schema identical to a component schema counts as that schema.
 */
export function namedSchema(doc: unknown, schema: unknown): { name: string; array: boolean } | null {
  if (!isObj(schema)) return null;
  if (typeof schema.$ref === 'string' && schema.$ref.startsWith(SCHEMAS)) {
    return isObjectSchema(deref(doc, schema)) ? { name: schema.$ref.slice(SCHEMAS.length).replace(/~1/g, '/').replace(/~0/g, '~'), array: false } : null;
  }
  if (schema.type === 'array') {
    const inner = namedSchema(doc, schema.items);
    return inner && !inner.array ? { name: inner.name, array: true } : null;
  }
  if (isObjectSchema(schema)) {
    const name = shapes(doc).get(canon(schema)) ?? projectionOf(doc, schema);
    return name ? { name, array: false } : null;
  }
  return null;
}

/**
 * The component schema an inline object is a projection of: every property it has is in the component
 * with the same schema (a list item without the `body` field is still an Article). At least three
 * properties, and one best candidate (the component with the fewest properties more), else null.
 */
function projectionOf(doc: unknown, schema: Json): string | null {
  const props = properties(doc, schema);
  if (props.size < 3 || !isObj(doc) || !isObj(doc.components) || !isObj(doc.components.schemas)) return null;
  let best: { name: string; extra: number } | null = null, tie = false;
  for (const [name, c] of Object.entries(doc.components.schemas)) {
    if (!isObj(c) || !isObjectSchema(c)) continue;
    const cp = properties(doc, c);
    if (cp.size <= props.size || ![...props].every(([k, v]) => cp.has(k) && canon(cp.get(k)) === canon(v))) continue;
    const extra = cp.size - props.size;
    if (!best || extra < best.extra) { best = { name, extra }; tie = false; } else if (extra === best.extra) tie = true;
  }
  return best && !tie ? best.name : null;
}

/** Where a response holds objects of named schemas: the response itself, or its top-level properties. */
export function responseEntities(doc: unknown, schema: unknown): Array<{ p: string; s: string; a?: 1 }> {
  const root = namedSchema(doc, schema);
  if (root) return [{ p: '', s: root.name, ...(root.array ? { a: 1 as const } : {}) }];
  const out: Array<{ p: string; s: string; a?: 1 }> = [];
  for (const [k, v] of properties(doc, schema)) {
    const n = namedSchema(doc, v);
    if (n) out.push({ p: k, s: n.name, ...(n.array ? { a: 1 as const } : {}) });
  }
  return out;
}

/** The single property a request body wraps its object in (`{ article: {…} }` → `article`), or null. */
export function wrapperKey(doc: unknown, schema: unknown): string | null {
  const props = properties(doc, schema);
  if (props.size !== 1) return null;
  const [k, v] = [...props][0]!;
  const inner = deref(doc, v);
  return inner && (inner.type === 'object' || isObj(inner.properties) || Array.isArray(inner.allOf)) ? k : null;
}

/** The named object schema a member path inside an item schema leads to (`['author']` in Article → `Profile`), or null. */
export function namedAt(doc: unknown, schema: unknown, path: string[]): string | null {
  let cur = schema;
  for (const seg of path) {
    const props = properties(doc, cur);
    if (!props.has(seg)) return null;
    cur = props.get(seg);
  }
  const n = namedSchema(doc, cur);
  return n && !n.array ? n.name : null;
}

/** Property names of an object schema (through `$ref`, `allOf`, …). */
export const propertyNames = (doc: unknown, schema: unknown): string[] => [...properties(doc, schema).keys()];
