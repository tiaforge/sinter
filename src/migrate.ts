// `sinter migrate`: rewrites the URLs a project's markup writes into paths relative to its APIs
// (`sinter({ apis })`, docs/apis.md), and reports what to add to the config: the shapes every page
// agrees on (`defaults`), the endpoints no API declares (`operations`) and the query parameters the
// spec leaves out (`query`). Once the config has them, it removes the attributes they replace. It
// edits only attribute values and attributes, byte for byte, and never the Vite config (JavaScript
// it cannot rewrite safely).
import * as parse5 from 'parse5';
import type { DefaultTreeAdapterMap } from 'parse5';
import { apiOf, shapeTemplate, SITE, type ApisDef } from './compiler/apis.js';
import { matchOperation, type Method, type OpenApiSpec } from './compiler/openapi.js';
import type { Diagnostic } from './compiler/diagnostics.js';
import { pathFix } from './lsp/paths.js';

type P5Element = DefaultTreeAdapterMap['element'];
type P5Parent = DefaultTreeAdapterMap['parentNode'];

const ACTIONS = ['get', 'post', 'put', 'patch', 'delete'] as const;
const SHAPE = ['items', 'total', 'key', 'type'] as const;

export interface Rewrite { line: number; from: string; to: string }

/** One URL the markup writes: where, the method, and for a resource its shape attributes. */
interface Use { file: string; method: Method; value: string; shape: Partial<Record<typeof SHAPE[number], string>> | null; stream: boolean }

/** The path a URL becomes: relative to the API with the longest base it starts with, `api:` unless it is the default; null when it stays. */
export function relativeUrl(apis: ApisDef, value: string): string | null {
  if (/^[A-Za-z_][\w-]*:\//.test(value) && !/^https?:/i.test(value)) return null;
  const abs = /^https?:\/\//i.test(value);
  if (!abs && !value.startsWith('/')) return null;
  // a same-origin path is rewritten only under a same-origin base (`/api`): one under none may already be
  // relative to the default API, so it stays (and is reported, see `unsure`), and a second run changes nothing
  const own = apis.list
    .filter((a) => (abs ? /^https?:\/\//i.test(a.base) : a.base !== '' && !/^https?:\/\//i.test(a.base)))
    .filter((a) => value.toLowerCase().startsWith(a.base.toLowerCase()) && /^([/?#]|$)/.test(value.slice(a.base.length)))
    .sort((a, b) => b.base.length - a.base.length)[0];
  if (!own) return null;
  const rest = value.slice(own.base.length) || '/';
  const out = `${own.name === apis.defaultApi ? '' : own.name + ':'}${rest}`;
  return out === value ? null : out;
}

/** The URL attributes of a file's markup, at any depth (template content included). */
function* urlAttrs(text: string): Generator<{ el: P5Element; name: string; from: number; to: number; method: Method }> {
  const doc = /^\s*(<!doctype|<html[\s>])/i.test(text)
    ? parse5.parse(text, { sourceCodeLocationInfo: true })
    : parse5.parseFragment(text, { sourceCodeLocationInfo: true });
  const stack: P5Parent[] = [doc];
  while (stack.length) {
    const n = stack.pop()!;
    for (const c of n.childNodes) {
      if (!('tagName' in c)) continue;
      const el = c as P5Element;
      const names: Array<[string, Method]> = [];
      if (el.tagName === 'sn-resource' || el.tagName === 'sn-sync') names.push(['src', el.attrs.find((a) => a.name === 'method')?.value.trim() === 'POST' ? 'post' : 'get']);
      for (const m of ACTIONS) names.push([`data-sn-${m}`, m]);
      for (const [name, method] of names) {
        const loc = el.sourceCodeLocation?.attrs?.[name];
        if (!loc) continue;
        const raw = text.slice(loc.startOffset, loc.endOffset), q = raw.search(/["']/);
        if (q < 0) continue;
        const from = loc.startOffset + q + 1, close = raw.slice(q + 1).lastIndexOf(raw[q]!);
        yield { el, name, from, to: close < 0 ? loc.endOffset : from + close, method };
      }
      stack.push(el);
      if (el.tagName === 'template') stack.push((el as unknown as { content: P5Parent }).content);
    }
  }
}

/**
 * A file's markup with its URLs relative to the APIs, the rewrites made, every URL it writes (after the
 * rewrite), and the same-origin paths it could not decide.
 *
 * A same-origin path under no base, while the default API has one, is decided only in a file this run
 * migrates (it rewrites another URL of it): there the path was the page's own origin. It becomes
 * `site:/path` when no operation of the default API matches it (with `specs`), and is reported when one
 * does (the page's own, or the API's?). In a file migrated before, the path may already be relative to
 * the API (an endpoint not declared yet): it stays, and is reported when no operation matches it.
 */
export function migrateMarkup(text: string, file: string, apis: ApisDef, specs?: OpenApiSpec[]): { text: string; rewrites: Rewrite[]; uses: Use[]; unsure: Rewrite[] } {
  const edits: Array<{ from: number; to: number; text: string }> = [];
  const uses: Use[] = [];
  const unsure: Rewrite[] = [];
  const dflt = apis.list.find((a) => a.name === apis.defaultApi);
  const lineOf = (o: number) => text.slice(0, o).split('\n').length;
  const found = [...urlAttrs(text)].map((a) => ({ a, value: text.slice(a.from, a.to) }));
  const nexts = found.map(({ value }) => relativeUrl(apis, value));
  const migrating = nexts.some((n) => n != null);
  found.forEach(({ a, value }, i) => {
    let next = nexts[i] ?? null;
    if (next == null && dflt?.base && value.startsWith('/') && !value.startsWith('//')) {
      const site = `site:${value}`;
      const matches = specs ? 'path' in matchOperation(specs, shapeTemplate(value), a.method, dflt.specs) : true;
      if (migrating && !matches) next = site;
      else if (migrating || !matches) unsure.push({ line: lineOf(a.from), from: value, to: site });
    }
    if (next != null) edits.push({ from: a.from, to: a.to, text: next });
    const resource = a.el.tagName === 'sn-resource';
    uses.push({
      file, method: a.method, value: next ?? value, stream: a.el.tagName === 'sn-sync',
      shape: resource ? Object.fromEntries(SHAPE.flatMap((k) => { const v = a.el.attrs.find((x) => x.name === k)?.value; return v != null ? [[k, v.trim()]] : []; })) : null,
    });
  });
  let out = text;
  const rewrites: Rewrite[] = [];
  for (const e of edits.sort((x, y) => y.from - x.from)) {
    rewrites.unshift({ line: lineOf(e.from), from: text.slice(e.from, e.to), to: e.text });
    out = out.slice(0, e.from) + e.text + out.slice(e.to);
  }
  return { text: out, rewrites, uses, unsure };
}

export interface ConfigReport {
  /** `apis.<name>.defaults`: shapes every resource of an operation writes the same way, and query parameters the spec leaves out */
  defaults: Record<string, Record<string, Record<string, string | string[]>>>;
  /** `apis.<name>.operations`: endpoints no spec or config of the API declares */
  operations: Record<string, Record<string, Record<string, string | string[]>>>;
  /** operations whose resources disagree on a shape attribute: they keep their attributes */
  disagree: string[];
}

/** What to add to `sinter({ apis })` for the URLs the markup writes. */
export function configReport(uses: Use[], apis: ApisDef, specs: OpenApiSpec[]): ConfigReport {
  const report: ConfigReport = { defaults: {}, operations: {}, disagree: [] };
  const shapes = new Map<string, { api: string; key: string; list: Array<Use['shape']>; declared: boolean; resource: boolean }>();
  for (const u of uses) {
    if (/^https?:\/\//i.test(u.value)) continue;
    const r = apiOf(apis, u.value);
    if ('error' in r) continue;
    const m = matchOperation(specs, shapeTemplate(r.path), u.method, r.api.specs);
    const path = 'path' in m ? m.path : shapeTemplate(r.path.split('?')[0]!).map((p, i) => (typeof p === 'string' ? p : `{p${i}}`)).join('');
    const key = `${u.method.toUpperCase()} ${path}`;
    const id = `${r.api.name} ${key}`;
    const e = shapes.get(id) ?? { api: r.api.name, key, list: [], declared: 'path' in m, resource: false };
    if (u.shape) { e.list.push(u.shape); e.resource = true; }
    shapes.set(id, e);
  }
  for (const e of shapes.values()) {
    const configured = apis.list.find((a) => a.name === e.api)!.shapes[e.key] ?? {};
    const agreed: Record<string, string> = {};
    for (const k of SHAPE) {
      const values = new Set(e.list.map((s) => s?.[k]));
      if (configured[k] != null) continue;
      if (values.size === 1 && [...values][0] != null) agreed[k] = [...values][0]!;
      else if (values.size > 1 && [...values].some((v) => v != null)) report.disagree.push(`${e.api}: ${e.key} (${k})`);
    }
    if (!e.declared) ((report.operations[e.api] ??= {})[e.key] = { ...agreed, ...(e.resource && !agreed.type ? { '': 'type' } : {}) });
    else if (Object.keys(agreed).length) (report.defaults[e.api] ??= {})[e.key] = agreed;
  }
  return report;
}

/** The `apis` entries to paste: JavaScript object text, by API. */
export function formatReport(r: ConfigReport): string {
  const lines: string[] = [];
  for (const api of new Set([...Object.keys(r.defaults), ...Object.keys(r.operations)])) {
    lines.push(`  ${api === SITE ? 'site' : api}: {`);
    for (const [what, table] of [['defaults', r.defaults[api]], ['operations', r.operations[api]]] as const) {
      if (!table) continue;
      lines.push(`    ${what}: {`);
      for (const [k, shape] of Object.entries(table)) {
        // a resource's endpoint the spec does not have needs its type (until then it is warning SN504)
        const fields = Object.entries(shape).map(([f, v]) => (f === '' ? "/* type: '…' */" : `${f}: ${JSON.stringify(v)}`));
        lines.push(`      ${JSON.stringify(k)}: { ${fields.join(', ')} },`);
      }
      lines.push('    },');
    }
    lines.push('  },');
  }
  return lines.join('\n');
}

/** What the build reports about the migrated markup that migrate can fix or must name. */
export interface FollowUp {
  /** query parameters the operation does not declare, sent by the page (no likely typo): `query` in the config */
  query: Array<{ api: string; op: string; name: string }>;
  /** what only the author can fix: a likely typo of a query parameter, a required one left out */
  notes: string[];
  /** attributes restating a configured shape (SN518): removed with `--write` */
  redundant: Array<{ file: string; span: NonNullable<Diagnostic['span']> }>;
}

/** The build's SN327 and SN518 on the migrated markup, sorted into fixes and notes. */
export function followUp(diagnostics: Diagnostic[]): FollowUp {
  const out: FollowUp = { query: [], notes: [], redundant: [] };
  const seen = new Set<string>();
  for (const d of diagnostics) {
    const id = `${d.file}:${d.line}:${d.col}:${d.code}:${d.message}`;
    if (seen.has(id)) continue;
    seen.add(id);
    const at = `${d.file}:${d.line}`;
    if (d.code === 'SN518' && d.span) out.redundant.push({ file: d.file, span: d.span });
    if (d.code !== 'SN327') continue;
    const m = /^`([A-Z]+ [^`]+)` of the API `([^`]+)` declares no query parameter `([^`]+)`( \(sent by `paginate`\))?\.(.*)$/.exec(d.message);
    if (m && !m[5]!.includes('Did you mean')) out.query.push({ api: m[2]!, op: m[1]!, name: m[3]! });
    else out.notes.push(`${at}  ${d.message}`);
  }
  return out;
}

/** Adds the query parameters to declare to the report: in `operations` for an endpoint the config declares, else in `defaults`. */
export function addQuery(report: ConfigReport, query: FollowUp['query'], apis: ApisDef, specs: OpenApiSpec[]): void {
  for (const q of query) {
    const api = apis.list.find((a) => a.name === q.api);
    if (!api) continue;
    const [method, path] = q.op.split(' ') as [string, string];
    const inConfig = report.operations[q.api]?.[q.op] != null || api.specs.some((i) => specs[i]!.config && (specs[i]!.doc as { paths: Record<string, Record<string, unknown>> }).paths[path]?.[method.toLowerCase()] != null);
    const table = inConfig ? (report.operations[q.api] ??= {}) : (report.defaults[q.api] ??= {});
    const entry = (table[q.op] ??= {});
    const list = [...((api.shapes[q.op]?.query) ?? []), ...((entry.query as string[] | undefined) ?? [])];
    if (!list.includes(q.name)) entry.query = [...list, q.name];
  }
}

/** A file's text without the attributes at these spans (and the whitespace before each). */
export function removeAttributes(text: string, spans: Array<NonNullable<Diagnostic['span']>>): string {
  const offset = (line: number, col: number) => text.split('\n').slice(0, line - 1).reduce((n, l) => n + l.length + 1, 0) + col - 1;
  const ranges = [...new Map(spans.map((s) => [offset(s.line, s.col), offset(s.endLine, s.endCol)])).entries()].sort((a, b) => b[0] - a[0]);
  let out = text;
  for (const [from, to] of ranges) {
    const fix = pathFix(out, from, to, 'SN518', '');
    if (fix) out = out.slice(0, fix.from) + fix.text + out.slice(fix.to);
  }
  return out;
}
