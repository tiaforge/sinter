// The canonical form of a compile's result (docs/proposals/redesign-notes/stage5-assembly.md, step 0): the same result
// with every number the compiler hands out, and every name made from one, renumbered in a fixed order, so that two
// results that differ only by numbering are equal. It is the oracle for a route that is identical to another up to
// numbering; it never changes what a compile outputs unless asked (`SN_CANON=1` in `compile()`).
//
// What it renumbers, and in which order:
// - templates: in the order a walk of the IR reaches them from the roots (the page's, then the early file's), each
//   binding's templates (`templatesOf`) in turn, depth first; then any the walk does not reach, in their order;
// - the names made from a template's id, by the template that declares them (`item`, `index`, `ii`): `$i<id>` (which
//   must be the template's index: the runtime reads it), `$p<id>`, `$sl<id>`, a renamed loop name `<name>$<id>`;
// - state ids: in the order the nodes holding them come (roots, then templates in their new order), and `$s<sid>`;
// - functions: in the order `mapFns` meets them over the renumbered IR, then those it does not meet, in their order;
// - node ids (`data-sn`, `<!--sn N-->`, `$.$d(N)`, the early file's embedded data): in the order they appear in the
//   markup, then the IR's others in its order. A kept element's ids (`keptBase`, a million and up) keep theirs.
// Names are renamed in code by parsing it (acorn) and renaming identifiers, non-computed member properties and
// non-computed object keys that are one of the names above, and in paths by segment; never by a pattern over text,
// so a string that reads like a name (`'x$1'`, `US$2`) is left as it is.
import * as acorn from 'acorn';
import * as parse5 from 'parse5';
import type { DefaultTreeAdapterMap } from 'parse5';
import { mapFns, templatesOf, type Binding, type IR, type NodeDef, type TemplateDef } from '../ir.js';
import { eachPath } from '../paths.js';
import type { CompiledParts } from './compile.js';

/** at and above: a kept element's ids (`keptBase`), which are its name's, not handed out in order */
const KEPT = 1_000_000;

type Edit = { start: number; end: number; text: string };
const apply = (s: string, edits: Edit[]) => {
  let out = s;
  for (const e of [...edits].sort((a, b) => b.start - a.start)) out = out.slice(0, e.start) + e.text + out.slice(e.end);
  return out;
};

/** What `canonical` could not parse (code it left as it was): the audits print it with a difference. */
export const CANON_STATS = { unparsed: 0 };

/**
 * `code` with the names in `names` renamed, and `$.$d(N)` given `ids.get(N)`. Every identifier, non-computed member
 * property and non-computed object key whose name is in `names` is renamed; nothing else is touched. A shorthand
 * property (`{ x$1 }`) keeps its key: it is written out (`{ x$1: x$4 }`).
 */
export function renameCode(code: string, names: ReadonlyMap<string, string>, ids?: ReadonlyMap<number, number>): string {
  if (code === '0' || (!names.size && !ids?.size)) return code;
  let ast: acorn.Node;
  try { ast = acorn.parseExpressionAt(code, 0, { ecmaVersion: 'latest' }); } catch {
    try { ast = acorn.parse(code, { ecmaVersion: 'latest', sourceType: 'module', allowAwaitOutsideFunction: true }); } catch { CANON_STATS.unparsed++; return code; }
  }
  const edits: Edit[] = [];
  const name = (n: acorn.Identifier) => { const to = names.get(n.name); if (to !== undefined && to !== n.name) edits.push({ start: n.start, end: n.end, text: to }); };
  const visit = (n: unknown): void => {
    if (!n || typeof n !== 'object') return;
    if (Array.isArray(n)) { for (const x of n) visit(x); return; }
    const node = n as acorn.Node & Record<string, unknown>;
    if (typeof node.type !== 'string') return;
    switch (node.type) {
      case 'Identifier': name(node as unknown as acorn.Identifier); return;
      case 'PrivateIdentifier': return;
      case 'Literal': case 'TemplateElement': return;
      case 'MemberExpression': {
        const m = node as unknown as acorn.MemberExpression;
        visit(m.object);
        if (m.computed) visit(m.property); else if (m.property.type === 'Identifier') name(m.property);
        return;
      }
      case 'Property': {
        const p = node as unknown as acorn.Property;
        if (p.shorthand && p.value.type === 'Identifier' && names.has(p.value.name)) {
          const to = names.get(p.value.name)!;
          if (to !== p.value.name) edits.push({ start: p.start, end: p.end, text: `${p.value.name}: ${to}` });
          return;
        }
        if (p.computed) visit(p.key); else if (p.key.type === 'Identifier') name(p.key);
        visit(p.value);
        return;
      }
      case 'MethodDefinition': case 'PropertyDefinition': {
        const p = node as unknown as acorn.MethodDefinition;
        if (p.computed) visit(p.key);
        visit(p.value);
        return;
      }
      case 'CallExpression': {
        const c = node as unknown as acorn.CallExpression;
        const callee = c.callee;
        if (ids && callee.type === 'MemberExpression' && !callee.computed && callee.object.type === 'Identifier' && callee.object.name === '$'
          && callee.property.type === 'Identifier' && callee.property.name === '$d' && c.arguments.length === 1) {
          const a = c.arguments[0]!;
          if (a.type === 'Literal' && typeof a.value === 'number') {
            const to = ids.get(a.value);
            if (to !== undefined && to !== a.value) edits.push({ start: a.start, end: a.end, text: String(to) });
            visit(callee);
            return;
          }
        }
        break;
      }
    }
    for (const k of Object.keys(node)) if (k !== 'type' && k !== 'start' && k !== 'end' && k !== 'loc' && k !== 'range') visit(node[k]);
  };
  visit(ast);
  return edits.length ? apply(code, edits) : code;
}

/** a path (`$s3.x`, `$r.items.*.name`, `x$4.{$i4}`) with its segments renamed */
export function renamePath(p: string, names: ReadonlyMap<string, string>): string {
  if (!names.size) return p;
  return p.split('.').map((s) => (s[0] === '{' && s.endsWith('}') ? `{${names.get(s.slice(1, -1)) ?? s.slice(1, -1)}}` : names.get(s) ?? s)).join('.');
}

/** The name a template's `item`, `index` or `ii` takes when the template is numbered `j`, or null for a name of the page's. */
function templateName(v: string, j: number): string | null {
  let m: RegExpExecArray | null;
  if ((m = /^\$(i|p|sl)\d+$/.exec(v))) return `$${m[1]}${j}`;
  if ((m = /^(.*[^$])\$\d+$/.exec(v))) return `${m[1]}$${j}`;
  return null;
}

type P5Node = DefaultTreeAdapterMap['node'];
type P5Element = DefaultTreeAdapterMap['element'];
type P5Template = DefaultTreeAdapterMap['template'];

/** The markup's node ids (`data-sn`, anchor comments), in document order, template contents where they are. */
function markupIds(html: string): { ids: number[]; edits: (map: ReadonlyMap<number, number>, tmap: ReadonlyMap<number, number>) => Edit[] } {
  const doc = parse5.parse(html, { sourceCodeLocationInfo: true });
  const ids: number[] = [];
  const sites: Array<{ kind: 'attr' | 'comment' | 'head'; id: number; start: number; end: number; prefix: string }> = [];
  const heads: Array<{ parent: unknown; id: number; start: number; end: number }> = [];
  const walk = (n: P5Node) => {
    if (n.nodeName === '#comment') {
      const c = n as DefaultTreeAdapterMap['commentNode'], m = /^sn (\d+)$/.exec(c.data), loc = c.sourceCodeLocation;
      if (m && loc && +m[1]! < KEPT) { ids.push(+m[1]!); sites.push({ kind: 'comment', id: +m[1]!, start: loc.startOffset, end: loc.endOffset, prefix: '' }); }
      return;
    }
    if ('attrs' in n) {
      const el = n as P5Element;
      for (const a of el.attrs) {
        const loc = el.sourceCodeLocation?.attrs?.[a.name];
        if (a.name === 'data-sn' && /^\d+$/.test(a.value) && +a.value < KEPT && loc) { ids.push(+a.value); sites.push({ kind: 'attr', id: +a.value, start: loc.startOffset, end: loc.endOffset, prefix: '' }); }
        if (el.tagName === 'template' && a.name === 'id' && /^sn-t-\d+$/.test(a.value) && loc && el.sourceCodeLocation) {
          const id = +a.value.slice(5);
          sites.push({ kind: 'head', id, start: loc.startOffset, end: loc.endOffset, prefix: '' });
          heads.push({ parent: el.parentNode, id, start: el.sourceCodeLocation.startOffset, end: el.sourceCodeLocation.endOffset });
        }
      }
    }
    if ('childNodes' in n) for (const c of n.childNodes) walk(c as P5Node);
    if (n.nodeName === 'template') walk((n as P5Template).content as unknown as P5Node);
  };
  walk(doc as unknown as P5Node);
  return {
    ids,
    edits: (map, tmap) => {
      const edits: Edit[] = [];
      // head templates in a run of siblings: in their new ids' order, as `placeTemplates` places them
      const runs: Array<typeof heads> = [];
      for (const h of heads) {
        const last = runs[runs.length - 1], prev = last?.[last.length - 1];
        if (prev && prev.parent === h.parent && (h.start === prev.end || /^\s*$/.test(html.slice(prev.end, h.start)))) last!.push(h); else runs.push([h]);
      }
      const inRun = new Set<number>();
      for (const run of runs) {
        if (run.length < 2) continue;
        const order = [...run].sort((a, b) => (tmap.get(a.id) ?? a.id) - (tmap.get(b.id) ?? b.id));
        if (order.every((h, i) => h === run[i])) continue;
        const pieces = run.map((h) => ({ h, text: html.slice(h.start, h.end) }));
        const rename = (h: (typeof heads)[number], text: string) => {
          // the template's own id, and what it holds: its own sites, inside its range
          const own = sites.filter((s) => s.start >= h.start && s.end <= h.end);
          return apply(text, own.flatMap((s) => siteEdit(s, map, tmap)).map((e) => ({ ...e, start: e.start - h.start, end: e.end - h.start })));
        };
        run.forEach((h, i) => {
          const o = order[i]!;
          edits.push({ start: h.start, end: h.end, text: rename(o, pieces.find((p) => p.h === o)!.text) });
          for (const s of sites) if (s.start >= h.start && s.end <= h.end) inRun.add(s.start);
        });
      }
      for (const s of sites) if (!inRun.has(s.start)) edits.push(...siteEdit(s, map, tmap));
      return edits;
    },
  };
}

function siteEdit(s: { kind: 'attr' | 'comment' | 'head'; id: number; start: number; end: number }, map: ReadonlyMap<number, number>, tmap: ReadonlyMap<number, number>): Edit[] {
  if (s.kind === 'head') { const j = tmap.get(s.id); return j === undefined || j === s.id ? [] : [{ ...s, text: `id="sn-t-${j}"` }]; }
  const j = map.get(s.id);
  if (j === undefined || j === s.id) return [];
  return [{ ...s, text: s.kind === 'attr' ? `data-sn="${j}"` : `<!--sn ${j}-->` }];
}

/**
 * The functions in the order a compile makes them, as far as the IR shows it: the resources' own (where the page
 * declares them, before its markup), then the markup depth first (a node's state, then each binding's setter,
 * function and style parts, an action's functions at its handler, a loop's key and its template's nodes where the
 * binding is), then what `finishPage` makes: the signed-in guard's, each row template's lookup and maker, the lazy
 * modules', the URL templates'. Functions the IR names elsewhere follow in `mapFns`' order.
 */
function fnOrder(ir: IR): number[] {
  const out: number[] = [], seen = new Set<number>(), done = new Set<number>();
  const f = (i: number | null | undefined) => { if (typeof i === 'number' && !seen.has(i)) { seen.add(i); out.push(i); } };
  const url = (u: Array<string | number> | undefined) => u?.forEach((p) => { if (typeof p === 'number') f(p); });
  for (const r of ir.resources) { f(r.when); f(r.then); f(r.body); f(r.paginate?.cursor); f(r.paginate?.start); f(r.each?.list); f(r.call?.args); f(r.call?.run); }
  for (const x of ir.syncs ?? []) for (const e of x.events) { f(e.value); f(e.when); f(e.then); }
  const nodes = (ns: NodeDef[]) => {
    for (const n of ns) {
      f(n.state);
      for (const b of n.b) {
        f(b.a); if (b.k !== 'on' || b.x == null) f(b.f); if (b.s) { f(b.s.r); f(b.s.o); }
        if (b.k === 'on' && b.x != null) { f(b.f); const a = ir.actions[b.x]; if (a) { f(a.body); f(a.optimistic); f(a.then); f(a.catch); f(a.confirm); f(a.call?.args); f(a.call?.run); } }
        for (const x of templatesOf(b)) tpl(x);
      }
    }
  };
  const tpl = (x: number) => { const t = ir.templates[x]; if (!t || done.has(x)) return; done.add(x); f(t.key); nodes(t.nodes); };
  nodes(ir.roots);
  ir.templates.forEach((_, x) => tpl(x));
  f(ir.si?.f);
  for (const t of ir.templates) { f(t.find); f(t.make); }
  for (const i of ir.lm ?? []) f(i);
  for (const d of [...ir.resources, ...(ir.syncs ?? []), ...ir.actions]) { f(d.u); url('url' in d ? d.url : d.src); }
  return out;
}

/**
 * The canonical form of `parts`: a copy, renumbered as the module comment says. The type check's unit (`check`) is
 * left out: its numbers are its frames', which no output reads.
 */
export function canonical(parts: CompiledParts): CompiledParts {
  const ir = structuredClone(parts.ir) as IR;
  const early = parts.early ? structuredClone(parts.early) : parts.early;
  const T = ir.templates;
  // (each node once: a node object in two lists is renumbered once)
  const allNodes = (): NodeDef[] => [...new Set([...ir.roots, ...ir.templates.flatMap((t) => t.nodes), ...(early ? [...early.ir.roots, ...early.ir.templates.flatMap((t) => t?.nodes ?? [])] : [])])];

  // templates
  const order: number[] = [], seen = new Set<number>();
  const reach = (ns: NodeDef[]) => { for (const n of ns) for (const b of n.b) for (const x of templatesOf(b)) visit(x); };
  const visit = (x: number) => { if (seen.has(x) || !T[x]) return; seen.add(x); order.push(x); reach(T[x]!.nodes); if (early?.ir.templates[x]) reach(early.ir.templates[x]!.nodes); };
  reach(ir.roots);
  if (early) reach(early.ir.roots);
  T.forEach((_, i) => visit(i));
  const tmap = new Map(order.map((x, j) => [x, j]));
  const names = new Map<string, string>();
  const nameOf = (t: { item?: string; index?: string | null; ii?: string }, j: number) => {
    for (const v of [t.item, t.index, t.ii]) {
      if (!v) continue;
      const to = templateName(v, j);
      if (to !== null) names.set(v, to);
    }
  };
  order.forEach((x, j) => nameOf(T[x]!, j));
  const point = (b: Binding) => {
    if (b.k === 'for' || b.k === 'if') { if (b.x != null && tmap.has(b.x)) b.x = tmap.get(b.x)!; if (b.z != null && tmap.has(b.z)) b.z = tmap.get(b.z)!; }
    if (b.k === 'ch' && b.c) b.c = b.c.map((x) => tmap.get(x) ?? x);
  };
  for (const n of allNodes()) n.b.forEach(point);
  ir.templates = order.map((x, j) => ({ ...T[x]!, id: j }));
  if (early) {
    const et = early.ir.templates, out: typeof et = [];
    et.forEach((t, i) => { if (t) out[tmap.get(i) ?? i] = t; });
    for (let i = 0; i < out.length; i++) out[i] ??= null;
    early.ir.templates = out;
  }

  // state ids
  const smap = new Map<number, number>();
  for (const n of [...ir.roots, ...ir.templates.flatMap((t) => t.nodes)]) if (n.sid != null && !smap.has(n.sid)) smap.set(n.sid, smap.size);
  for (const n of allNodes()) if (n.sid != null && !smap.has(n.sid)) smap.set(n.sid, smap.size);
  for (const [a, b] of smap) names.set(`$s${a}`, `$s${b}`);
  for (const n of allNodes()) if (n.sid != null) n.sid = smap.get(n.sid)!;
  const rn = (v: string | null | undefined) => (v ? names.get(v) ?? v : v);
  for (const t of ir.templates) { if (t.item) t.item = rn(t.item)!; if (t.index) t.index = rn(t.index)!; if (t.ii) t.ii = rn(t.ii)!; }
  for (const t of early?.ir.templates ?? []) if (t) { if (t.item) t.item = rn(t.item)!; if (t.index) t.index = rn(t.index)!; }

  // node ids
  const markup = markupIds(parts.html);
  const nmap = new Map<number, number>();
  for (const id of markup.ids) if (!nmap.has(id)) nmap.set(id, nmap.size);
  for (const n of allNodes()) if (n.id != null && n.id < KEPT && !nmap.has(n.id)) nmap.set(n.id, nmap.size);
  // the embedded data's ids (its `<script data-sn>`, written into the page after the compile when it is a file's)
  for (const r of ir.resources) if (typeof r.data === 'number' && r.data < KEPT && !nmap.has(r.data)) nmap.set(r.data, nmap.size);
  for (const r of ir.resources) if (typeof r.data === 'number' && nmap.has(r.data)) r.data = nmap.get(r.data)!;
  for (const n of allNodes()) if (n.id != null && nmap.has(n.id)) n.id = nmap.get(n.id)!;
  if (early?.ir.emb) for (const e of Object.values(early.ir.emb)) if (nmap.has(e.id)) e.id = nmap.get(e.id)!;
  const html = apply(parts.html, markup.edits(nmap, tmap));

  // functions
  const forder = fnOrder(ir), fseen = new Set(forder);
  mapFns(ir, (i) => { if (!fseen.has(i)) { fseen.add(i); forder.push(i); } return i; });
  parts.fns.forEach((_, i) => { if (!fseen.has(i)) forder.push(i); });
  const fmap = new Map(forder.map((i, j) => [i, j]));
  mapFns(ir, (i) => fmap.get(i) ?? i);
  const memo = new Map<string, string>();
  const code = (c: string) => { let r = memo.get(c); if (r === undefined) memo.set(c, (r = renameCode(c, names, nmap))); return r; };
  const fns = forder.map((i) => code(parts.fns[i]!));
  eachPath(ir, (p, set) => { if (typeof p === 'string') set(renamePath(p, names) as never); }, (p, set) => { if (typeof p === 'string') set(renamePath(p, names) as never); });
  if (early) {
    early.fns = early.fns.map(code);
    const paths = (ns: NodeDef[]) => { for (const n of ns) for (const b of n.b) { if (b.d) b.d = b.d.map((p) => (typeof p === 'string' ? renamePath(p, names) : p)); if (b.w) b.w = b.w.map((p) => (typeof p === 'string' ? renamePath(p, names) : p)); } };
    paths(early.ir.roots);
    for (const t of early.ir.templates) if (t) paths(t.nodes);
  }
  const out: CompiledParts = { ...parts, html, ir, fns, ...(early !== undefined ? { early } : {}) };
  delete out.check;
  if (parts.json) out.json = new Map([...parts.json].map(([k, v]) => [nmap.get(k) ?? k, v] as [number, unknown]).sort((a, b) => a[0] - b[0]));
  if (parts.embed) out.embed = parts.embed.map((e) => ({ ...e, id: nmap.get(e.id) ?? e.id }));
  if (parts.fixedState) out.fixedState = parts.fixedState.map((p) => renamePath(p, names)).sort();
  if (parts.sources) out.sources = { ...parts.sources, fns: forder.map((i) => parts.sources!.fns[i] ?? null) };
  return out;
}

/** The canonical forms of two results as text, for an audit: equal when they differ by numbering only. */
export function canonicalText(parts: CompiledParts): string {
  return JSON.stringify(canonical(parts), (_, v) => (typeof v === 'function' ? '[fn]' : v instanceof Map ? [...v] : v instanceof Set ? [...v] : v));
}
