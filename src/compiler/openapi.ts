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
}

export interface OpenApiMatch {
  spec: number;
  /** the spec's path key, e.g. `/articles/{slug}` */
  path: string;
  /** schema of the response body, or null when the operation has no JSON 2xx response */
  body: unknown;
  /** names of the query parameters the operation declares */
  query: string[];
}

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
  const { path } = flatten(src);
  let best: { spec: number; path: string; score: number } | null = null;
  specs.forEach((spec, i) => {
    if (!isObj(spec.doc) || !isObj(spec.doc.paths)) return;
    for (const rest of relativePaths(spec.doc, path)) {
      const segs = segments(rest);
      for (const [key, item] of Object.entries(spec.doc.paths)) {
        if (!isObj(item) || !isObj(item.get)) continue;
        const s = score(key, segs);
        if (s >= 0 && (!best || s > best.score)) best = { spec: i, path: key, score: s };
      }
    }
  });
  if (!best) {
    const want = path.replace(/^https?:\/\/[^/]+/i, '').split(INTERP).join('{}');
    const keys = specs.flatMap((s) => (isObj(s.doc) && isObj(s.doc.paths) ? Object.keys(s.doc.paths) : []));
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
  const op = deref(doc, item.get)!;
  const params = [...(Array.isArray(item.parameters) ? item.parameters : []), ...(Array.isArray(op.parameters) ? op.parameters : [])]
    .map((p) => deref(doc, p)).filter((p): p is Json => !!p && p.in === 'query').map((p) => String(p.name));
  return { spec, path: key, body: responseSchema(doc, op), query: params };
}

function responseSchema(doc: Json, op: Json): unknown {
  const responses = deref(doc, op.responses);
  if (!responses) return null;
  const key = Object.keys(responses).filter((k) => /^2(\d\d|XX)$/i.test(k)).sort()[0];
  const res = key ? deref(doc, responses[key]) : null;
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
