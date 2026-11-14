// Paths to the app's APIs (`sinter({ apis })`) in markup, without TypeScript: completion of the
// operations a `src` or an action's method attribute can name, the URL a path calls on hover, go to
// the operation in the spec or the config, and quick fixes for SN326, SN328, SN330 and SN518.
import { readFileSync } from 'node:fs';
import { apiOf, shapeTemplate, type ApiDef, type ApisDef } from '../compiler/apis.js';
import { deref, matchOperation, namedSchema, walk, type Method, type OpenApiSpec } from '../compiler/openapi.js';
import { elementAt } from './markup.js';

/** What the paths need of a project: its specs and its APIs. */
export interface PathProject { openapi: OpenApiSpec[]; apis: ApisDef | null }

const ACTIONS = ['get', 'post', 'put', 'patch', 'delete'] as const;

/** An operation of an API, as completion offers it. */
interface Candidate { api: ApiDef; method: Method; path: string; id: string | null; summary: string | null; spec: number; ref: string }

/** The attribute holding a path that the offset is in: its value's range (quotes excluded) and the method the place implies. */
function pathAt(text: string, offset: number) {
  const hit = elementAt(text, offset);
  if (!hit) return null;
  const el = hit.el, attrs = el.sourceCodeLocation?.attrs ?? {};
  const names = [...(el.tagName === 'sn-resource' || el.tagName === 'sn-sync' ? ['src'] : []), ...ACTIONS.map((m) => `data-sn-${m}`)];
  for (const name of names) {
    const a = attrs[name];
    if (!a || offset < a.startOffset || offset > a.endOffset) continue;
    const raw = text.slice(a.startOffset, a.endOffset);
    const q = raw.search(/["']/);
    if (q < 0) return null;
    const from = a.startOffset + q + 1, close = raw.slice(q + 1).search(/["']/);
    const to = close < 0 ? a.endOffset : from + close;
    if (offset < from || offset > to) return null;
    const method: Method = name === 'src' ? (el.tagName === 'sn-resource' && el.attrs.find((x) => x.name === 'method')?.value.trim() === 'POST' ? 'post' : 'get') : name.slice('data-sn-'.length) as Method;
    const attrOf = (n: string) => el.attrs.find((x) => x.name === n)?.value;
    return { el, name, from, to, value: text.slice(from, to), method, attrOf, resource: el.tagName === 'sn-resource', stream: el.tagName === 'sn-sync' };
  }
  return null;
}

/** Whether `i` is inside a `{…}` value of a URL template (TypeScript's part: completion and hover of the expression). */
function inValue(value: string, i: number): boolean {
  let depth = 0, q: string | null = null;
  for (let k = 0; k < i; k++) {
    const c = value[k]!;
    if (depth && q) { if (c === '\\') k++; else if (c === q) q = null; continue; }
    if (depth && (c === '"' || c === "'" || c === '`')) q = c;
    else if (c === '{') depth++;
    else if (c === '}' && depth) depth--;
  }
  return depth > 0;
}

/** Every operation of the configured APIs with this method. */
function candidates(p: PathProject, method: Method): Candidate[] {
  const out: Candidate[] = [];
  for (const api of p.apis?.list ?? []) {
    for (const i of api.specs) {
      const doc = p.openapi[i]?.doc as { paths?: Record<string, unknown> } | undefined;
      for (const [path, raw] of Object.entries(doc?.paths ?? {})) {
        const item = deref(doc, raw);
        const op = item ? deref(doc, item[method]) : null;
        if (!op) continue;
        const ref = `${api.name === p.apis!.defaultApi ? '' : api.name + ':'}${path}`;
        out.push({ api, method, path, id: typeof op.operationId === 'string' ? op.operationId : null, summary: typeof op.summary === 'string' ? op.summary : null, spec: i, ref });
      }
    }
  }
  return out;
}

/** How well a candidate matches what was typed: 1 best … 4 fuzzy, 0 not at all (an empty query matches all at 1). */
function rank(c: Candidate, typed: string): number {
  const q = typed.toLowerCase().replace(/^\//, '');
  if (!q) return 1;
  const path = c.path.toLowerCase(), id = c.id?.toLowerCase() ?? '';
  const segs = path.split('/').filter(Boolean);
  if (id.startsWith(q) || segs.some((s) => s.startsWith(q))) return 1;
  if (path.startsWith('/' + q) || c.ref.toLowerCase().startsWith(typed.toLowerCase())) return 2;
  const hay = [c.ref, c.id ?? '', c.summary ?? '', c.api.name].join(' ').toLowerCase();
  if (hay.includes(q)) return 3;
  let k = 0;
  for (const ch of hay) if (ch === q[k]) k++;
  return k === q.length ? 4 : 0;
}

/** A path with placeholders to fill in: a snippet (`{${1:slug}\}`), or empty braces for editors without snippets. */
function insertOf(path: string, snippets: boolean): string {
  let n = 0;
  return snippets
    ? path.replace(/[$\\]/g, (c) => '\\' + c).replace(/\{([^}]+)\}/g, (_, name: string) => `{\${${++n}:${name}}\\}`)
    : path.replace(/\{[^}]+\}/g, '{}');
}

export interface PathCompletion {
  label: string;
  detail: string;
  documentation?: string;
  filterText: string;
  sortText: string;
  insert: string;
  snippet: boolean;
  from: number;
  to: number;
}

/**
 * Completion inside a path: the operations of the APIs (matched anywhere in the path, the id, the
 * summary and the API's name, and ranked), or after `?`/`&` the query parameters the operation
 * declares. Null when the offset is not in such a value, is in a `{…}` value, or there are no APIs.
 */
export function pathCompletions(text: string, offset: number, p: PathProject, snippets: boolean): PathCompletion[] | null {
  const at = pathAt(text, offset);
  if (!at || !p.apis || inValue(at.value, offset - at.from)) return null;
  const typed = text.slice(at.from, offset);
  const q = typed.indexOf('?');
  if (q >= 0) {
    // the query: the operation's declared parameters not given yet
    const t = target(p, at.value, at.method);
    if (!t || !('path' in t.match)) return [];
    const m = t.match;
    const start = at.from + Math.max(typed.lastIndexOf('?'), typed.lastIndexOf('&')) + 1;
    const given = new Set(at.value.slice(q + 1).split('&').map((kv) => kv.split('=')[0]));
    const declared = [...m.query, ...(t.api.shapes[`${at.method.toUpperCase()} ${m.path}`]?.query ?? [])];
    return declared.filter((n) => !given.has(n) || n === text.slice(start, offset)).map((n, i) => ({
      label: n, detail: `${m.required.includes(n) ? 'required ' : ''}query parameter of ${at.method.toUpperCase()} ${m.path}`,
      filterText: text.slice(start, offset), sortText: String(i).padStart(4, '0'), insert: `${n}=`, snippet: false, from: start, to: offset,
    }));
  }
  const pathEnd = at.value.indexOf('?') < 0 ? at.to : at.from + at.value.indexOf('?');
  // `billing:/inv`: that API's operations, ranked by the rest
  const named = /^([A-Za-z_][\w-]*):/.exec(typed);
  const list = candidates(p, at.method)
    .filter((c) => !named || c.api.name === named[1])
    .map((c) => ({ c, r: rank(c, named ? typed.slice(named[0].length) : typed) }))
    .filter((x) => x.r > 0)
    .sort((a, b) => a.r - b.r || Number(a.c.api.name !== p.apis!.defaultApi) - Number(b.c.api.name !== p.apis!.defaultApi) || a.c.path.length - b.c.path.length || a.c.path.localeCompare(b.c.path));
  return list.map(({ c }, i) => {
    const prefix = c.api.name === p.apis!.defaultApi ? '' : c.api.name + ':';
    return {
      label: c.ref,
      detail: `${c.method.toUpperCase()} ${c.api.base}${c.path}${c.id ? ` · ${c.id}` : ''}`,
      ...(c.summary ? { documentation: c.summary } : {}),
      // the server filters and ranks: the editor keeps every item, in this order
      filterText: typed,
      sortText: String(i).padStart(4, '0'),
      insert: prefix + insertOf(c.path, snippets),
      snippet: snippets && c.path.includes('{'),
      from: at.from, to: pathEnd,
    };
  });
}

/** The operation a written path calls, and its API. */
function target(p: PathProject, value: string, method: Method) {
  if (!p.apis || /^https?:\/\//i.test(value)) return null;
  const r = apiOf(p.apis, value);
  if ('error' in r) return null;
  return { api: r.api, match: matchOperation(p.openapi, shapeTemplate(r.path), method, r.api.specs), path: r.path };
}

/** Markdown for a hover on a path: the method and the absolute URL with the page's values, the spec's template, the API, the operation and its shape. */
export function pathHover(text: string, offset: number, p: PathProject, fileName: (file: string) => string): string | null {
  const at = pathAt(text, offset);
  if (!at || !p.apis || inValue(at.value, offset - at.from)) return null;
  const t = target(p, at.value, at.method);
  if (!t || !('path' in t.match)) return null;
  const m = t.match, spec = p.openapi[m.spec]!, doc = spec.doc as { paths: Record<string, Record<string, Record<string, unknown>>> };
  const op = deref(doc, deref(doc, doc.paths[m.path])?.[at.method]);
  const shape = t.api.shapes[`${at.method.toUpperCase()} ${m.path}`];
  const out = [`**${at.method.toUpperCase()}** \`${t.api.base}${t.path}\``, `\`${m.path}\` of the API \`${t.api.name}\``];
  if (typeof op?.summary === 'string') out.push(op.summary);
  if (m.query.length) out.push('Query: ' + m.query.map((q) => `\`${q}\`${m.required.includes(q) ? ' (required)' : ''}`).join(', '));
  if (at.resource) {
    const where = spec.config ? 'operations' : 'defaults';
    const fact = (k: 'items' | 'key' | 'type') => {
      if (shape?.[k] != null) return `\`${k}\`: \`${shape[k]}\` (${t.api.name}.${where})`;
      const own = at.attrOf(k);
      if (own != null) return `\`${k}\`: \`${own}\` (element)`;
      if (k === 'type' && m.body != null) {
        const items = shape?.items ?? at.attrOf('items');
        const w = items ? walk(doc, m.body, items) : { schema: m.body };
        const n = 'schema' in w ? namedSchema(doc, w.schema) : null;
        if (n) return `\`type\`: \`${n.name}${n.array ? '[]' : ''}\` (spec)`;
      }
      return null;
    };
    const facts = (['items', 'key', 'type'] as const).map(fact).filter(Boolean);
    if (facts.length) out.push(facts.join(' · '));
  }
  out.push(`From \`${fileName(spec.file)}\``);
  return out.join('\n\n');
}

/** Where the operation a path calls is declared: its path in the spec, or its key in the config. */
export function pathDefinition(text: string, offset: number, p: PathProject, read: (file: string) => string = (f) => readFileSync(f, 'utf8')): { file: string; line: number; col: number } | null {
  const at = pathAt(text, offset);
  if (!at || !p.apis || inValue(at.value, offset - at.from)) return null;
  const t = target(p, at.value, at.method);
  if (!t || !('path' in t.match)) return null;
  const spec = p.openapi[t.match.spec]!;
  let src: string;
  try { src = read(spec.file); } catch { return null; }
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = spec.config
    ? new RegExp(`['"\`]${esc(`${at.method.toUpperCase()} ${t.match.path}`)}['"\`]`)
    : new RegExp(`^[ \\t]*['"]?${esc(t.match.path)}['"]?[ \\t]*:`, 'm');
  const hit = re.exec(src);
  if (!hit) return null;
  const before = src.slice(0, hit.index + (hit[0].length - hit[0].trimStart().length)).split('\n');
  return { file: spec.file, line: before.length, col: before[before.length - 1]!.length + 1 };
}

/** A diagnostic's quick fix on a path or a shape attribute: the attribute's new text (null removes it), and its range in the text. */
export function pathFix(text: string, from: number, to: number, code: string, message: string): { from: number; to: number; text: string; title: string } | null {
  const span = text.slice(from, to);
  const m = /^([\w-]+)\s*=\s*(["'])([\s\S]*)\2$/.exec(span);
  if (code === 'SN330' || code === 'SN518') {
    if (!m) return null;
    // the attribute and the whitespace before it
    let a = from;
    while (a > 0 && /[ \t]/.test(text[a - 1]!)) a--;
    return { from: a, to, text: '', title: `Remove \`${m[1]}\` (configured)` };
  }
  if (!m) return null;
  const [, name, q, value] = m as unknown as [string, string, string, string];
  if (code === 'SN328') {
    const w = /: write `([^`]+)`$/.exec(message);
    return w ? { from, to, text: `${name}=${q}${w[1]}${q}`, title: `Write \`${w[1]}\`` } : null;
  }
  if (code === 'SN326') {
    const s = /Did you mean `([^`]+)`\?/.exec(message);
    if (!s) return null;
    // the suggested path with the page's values in its parameters, in order; the query kept
    const pre = /^[A-Za-z_][\w-]*:(?=\/)/.exec(value)?.[0] ?? '';
    const qi = value.indexOf('?');
    const path = value.slice(pre.length, qi < 0 ? undefined : qi), query = qi < 0 ? '' : value.slice(qi);
    const values = [...path.matchAll(/\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\}/g)].map((x) => x[0]);
    const params = [...s[1]!.matchAll(/\{[^}]+\}/g)];
    if (params.length !== values.length) return null;
    let k = 0;
    const next = s[1]!.replace(/\{[^}]+\}/g, () => values[k++]!);
    return { from, to, text: `${name}=${q}${pre}${next}${query}${q}`, title: `Change to \`${pre}${next}\`` };
  }
  return null;
}
