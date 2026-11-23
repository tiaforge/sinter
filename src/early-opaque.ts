// Early scripts that differ only in literals, shared through opaque placeholders (docs/proposals/redesign-notes/
// early-script-shapes.md, "Proof"). Pages whose early sources are the same program but for some literals are built
// once, each such literal replaced by a free identifier that occurs nowhere else; the built output is parsed and each
// page's literals put where the identifiers are, as syntax. The minifier cannot know what a free identifier holds, so
// whatever it did to the program it did for every value the literal may have: the result is a correct build of each
// page. It is not always the page's own build's bytes: where the minifier would have computed from the value
// (`"/api/" + "post-1"` folded), the shared output keeps the expression.
import { parse, tokenizer, tokTypes, type Node } from 'acorn';
import { ancestor, fullAncestor } from 'acorn-walk';
import type { Built } from './early-shapes.js';

const env = (k: string) => (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env[k];

/** a string or number literal of the source: where, as written, its value, and whether a free identifier may stand in its place */
type Site = { start: number; end: number; raw: string; value: string | number; lift: boolean };

/**
 * Constructs whose literal a build step reads by value (Vite's plugins: `import()`, `import.meta.glob`, `new URL(…,
 * import.meta.url)`, workers, `require`): a source with any of them lifts nothing.
 */
const READ_BY_PLUGINS = /\bimport\s*[.(]|\brequire\s*\(|\bnew\s+(?:URL|Worker|SharedWorker)\b/;

/**
 * The source's string and number literals and its skeleton (the source with each of them masked). Pages of one
 * skeleton are the same program but for these values, so which may be lifted is decided once for the shape
 * (`liftable`). Null when the source does not tokenize.
 */
export function sites(src: string): { sites: Site[]; skeleton: string } | null {
  const out: Site[] = [];
  let skeleton = '', at = 0;
  try {
    for (const t of tokenizer(src, { ecmaVersion: 'latest', sourceType: 'module' })) {
      if (t.type !== tokTypes.string && t.type !== tokTypes.num) continue;
      out.push({ start: t.start, end: t.end, raw: src.slice(t.start, t.end), value: (t as unknown as { value: string | number }).value, lift: false });
      skeleton += src.slice(at, t.start) + '\0';
      at = t.end;
    }
  } catch { return null; }
  return { sites: out, skeleton: skeleton + src.slice(at) };
}

/**
 * Marks the literals of `c` (cut from `src`) a free identifier may stand for: an expression the program only
 * evaluates. Not a module specifier or import attribute, a property or class member's name, a directive, `delete`'s
 * operand, `require`'s argument; and nothing in a program with a construct whose literal a build step reads by value
 * (`import()`, `import.meta`, `new URL`, a worker), which the skeleton shows. False when the source does not parse.
 */
export function liftable(src: string, c: { sites: Site[]; skeleton: string }): boolean {
  let ast: Node;
  try { ast = parse(src, { ecmaVersion: 'latest', sourceType: 'module' }); } catch { return false; }
  if (READ_BY_PLUGINS.test(c.skeleton)) return true;
  const ok = new Set<number>();
  fullAncestor(ast, (n: Node, _st: unknown, anc: Node[]) => {
    const l = n as Node & { value?: unknown; regex?: unknown; bigint?: unknown };
    if (n.type !== 'Literal' || l.regex || l.bigint !== undefined || (typeof l.value !== 'string' && typeof l.value !== 'number')) return;
    const p = anc[anc.length - 2] as (Node & Record<string, unknown>) | undefined;
    if (!p) return;
    if (/^(?:Import|Export\w*)Declaration$|^ImportExpression$|^ImportAttribute$|Specifier$/.test(p.type)) return;
    if ((p.type === 'Property' || p.type === 'PropertyDefinition' || p.type === 'MethodDefinition') && p.key === n && !p.computed) return;
    if (p.type === 'ExpressionStatement' && p.directive !== undefined) return;
    if (p.type === 'UnaryExpression' && p.operator === 'delete') return;
    if (p.type === 'CallExpression' && (p.callee as Node & { name?: string }).type === 'Identifier' && (p.callee as { name?: string }).name === 'require') return;
    ok.add(n.start);
  });
  for (const x of c.sites) x.lift = ok.has(x.start);
  return true;
}

/** a build's counts, summed over the process (`SN_EARLY_SHAPES_LOG=1` or the audit prints them at exit) */
export const opaqueStats = { sources: 0, builds: 0, shapes: 0, shared: 0, audited: 0, same: 0, usedValue: 0, rawBytes: 0, gzipBytes: 0, fallbacks: new Map<string, number>() };
const fallback = (why: string, n = 1) => opaqueStats.fallbacks.set(why, (opaqueStats.fallbacks.get(why) ?? 0) + n);
let exitHook = false;

/** where a placeholder is in a built output, and how its literal goes there */
type Ref = { start: number; end: number; i: number; at: 'value' | 'object' | 'statement' | 'property'; open: number; close: number };

/**
 * The references to the placeholders (`names`) in `code`, as syntax: the output is parsed, and every occurrence of a
 * name must be a reference the walk finds (not in a string, not a key, a member's name, a declaration or a target;
 * no `with`). Made once per shape. Null when that does not hold or `code` does not parse.
 */
export function references(code: string, names: string[]): Ref[] | null {
  let ast: Node;
  try { ast = parse(code, { ecmaVersion: 'latest', sourceType: 'script', allowReturnOutsideFunction: true }); } catch { return null; }
  const index = new Map(names.map((n, i) => [n, i]));
  const refs: Ref[] = [];
  let bad = false;
  ancestor(ast, {
    // a `with` could make a name resolve to an object's property (none in module code; refused all the same)
    WithStatement() { bad = true; },
    Identifier(n: Node, _st: unknown, anc: Node[]) {
      const i = index.get((n as Node & { name: string }).name);
      if (i === undefined) return;
      const p = anc[anc.length - 2] as (Node & Record<string, unknown>) | undefined;
      // a reference only: never written, declared, a shorthand property (none can come from a source that only reads it)
      if (!p || (p.type === 'AssignmentExpression' && p.left === n) || p.type === 'UpdateExpression' || (p.type === 'Property' && p.shorthand) || ((p.type === 'ForInStatement' || p.type === 'ForOfStatement') && p.left === n)) { bad = true; return; }
      let at: Ref['at'] = 'value', open = -1, close = -1;
      if (p.type === 'MemberExpression' && p.object === n) at = 'object';
      else if (p.type === 'ExpressionStatement') at = 'statement';
      else if (p.type === 'MemberExpression' && p.computed && p.property === n) {
        // `a[P]`: the brackets, if nothing but space is between them and the name (`a.name` for an identifier name)
        open = code.lastIndexOf('[', n.start); close = code.indexOf(']', n.end);
        if (/^\s*$/.test(code.slice(open + 1, n.start)) && /^\s*$/.test(code.slice(n.end, close))) {
          at = 'property';
          if (p.optional && code.slice(open - 2, open) === '?.') open -= 2;
        }
      }
      refs.push({ start: n.start, end: n.end, i, at, open, close });
    },
  });
  if (bad) return null;
  let count = 0;
  for (const n of names) count += code.split(n).length - 1;
  if (count !== refs.length) return null;
  return refs.sort((a, b) => a.start - b.start);
}

/**
 * `code` with each reference written as its literal (`texts[i]`, as the minifier prints it): a number before a
 * member's dot as `1 .x` (`1e3.x` and `.5.x` need nothing), a statement that would be a directive in parentheses,
 * `a[P]` with an identifier name as `a.name`, as the minifier writes `a["name"]` (the same property).
 */
export function writeRefs(code: string, refs: Ref[], texts: string[], numeric: boolean[]): string {
  let out = '', at = 0;
  for (const r of refs) {
    const t = texts[r.i]!, name = !numeric[r.i] && r.at === 'property' ? cooked(t) : null;
    if (name !== null && IDENT.test(name)) { out += code.slice(at, r.open) + (code.slice(r.open, r.open + 2) === '?.' ? '?.' : '.') + name; at = r.close + 1; continue; }
    const text = r.at === 'object' && numeric[r.i] ? (/^\d+$/.test(t) ? `${t} ` : /^[\d.e+-]+$/i.test(t) && /[.e]/i.test(t) ? t : `(${t})`) : r.at === 'statement' ? `(${t})` : t;
    out += code.slice(at, r.start) + text;
    at = r.end;
  }
  return out + code.slice(at);
}

/** `code` with every reference to `names` written as `texts` (`references`, then `writeRefs`); null where refused */
export function substitute(code: string, names: string[], texts: string[], numeric: boolean[]): string | null {
  const refs = references(code, names);
  return refs && writeRefs(code, refs, texts, numeric);
}

/** an identifier name (reserved words included: `a.if` is `a["if"]`), in the ASCII the minifier writes as one */
const IDENT = /^[A-Za-z_$][\w$]*$/;
/** a printed string literal's value when it is plain ('…', "…", `…` with no escape or substitution), else null */
const cooked = (t: string) => (/^(['"`])[^\\'"`$\n\r]*\1$/.test(t) ? t.slice(1, -1) : null);

/** the n-th placeholder name for a nonce: an identifier no source has */
const nameOf = (nonce: string, i: number) => `__sn_lit${i}_${nonce}__`;

/**
 * Builds every source of `items` (`extra`: what else its build depends on, the runtime names), one build per shape.
 * `build` runs one nested build; `avoid`: names the build's own steps replace (`define`'s keys). `SN_EARLY_SHAPES_AUDIT=1`: every page written from a shared build is built from its
 * own source too and compared; a difference the minifier makes once it sees the value (`minify` of both: equal) is
 * counted with its bytes, any other throws.
 */
export async function shareOpaque(items: Array<{ src: string; extra: string; what: string }>, build: (src: string, i: number, what: string) => Promise<Built>, gzip: (s: string) => number, avoid: string[] = []): Promise<Built[]> {
  const audit = env('SN_EARLY_SHAPES_AUDIT') === '1';
  if ((audit || env('SN_EARLY_SHAPES_LOG') === '1') && !exitHook) {
    exitHook = true;
    (globalThis as { process?: NodeJS.Process }).process?.on('exit', () => {
      const s = opaqueStats, f = [...s.fallbacks].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${n} ${k}`).join('; ');
      console.error(`sinter early shapes (opaque): ${s.sources} distinct early sources, ${s.builds} nested builds (${s.shapes} shared shapes for ${s.shared} sources)${audit ? `; audited ${s.audited}: ${s.same} the same bytes, ${s.usedValue} where the minifier used the value (${s.rawBytes} B raw, ${s.gzipBytes} B gzip more in all)` : ''}; built alone: ${f || 'none'}`);
    });
  }
  const out: Array<Built | undefined> = new Array(items.length);
  opaqueStats.sources += items.length;
  const cuts = items.map((x) => sites(x.src));
  // by shape: the same program with every literal masked, and the same runtime names
  const groups = new Map<string, number[]>();
  items.forEach((x, i) => {
    const c = cuts[i];
    if (!c) { fallback('a source that does not parse'); return; }
    const k = x.extra + '\0\0' + c.skeleton;
    groups.set(k, [...groups.get(k) ?? [], i]);
  });
  const todo = items.map((_, i) => i).filter((i) => !cuts[i]);
  for (const members of groups.values()) {
    const c0 = cuts[members[0]!]!;
    if (!liftable(items[members[0]!]!.src, c0)) { fallback('a source that does not parse', members.length); todo.push(...members); continue; }
    for (const m of members) cuts[m]!.sites.forEach((x, j) => { x.lift = c0.sites[j]!.lift; });
    const vary = c0.sites.map((_, j) => j).filter((j) => members.some((m) => cuts[m]!.sites[j]!.raw !== c0.sites[j]!.raw));
    // a literal that differs where it cannot be lifted splits the shape by its value
    const fixed = vary.filter((j) => members.some((m) => !cuts[m]!.sites[j]!.lift));
    const lifted = vary.filter((j) => !fixed.includes(j));
    const sub = new Map<string, number[]>();
    for (const m of members) { const k = fixed.map((j) => cuts[m]!.sites[j]!.raw).join('\0'); sub.set(k, [...sub.get(k) ?? [], m]); }
    for (const ms of sub.values()) {
      if (ms.length < 2 || !lifted.length) {
        if (fixed.length && ms.length < 2) fallback('a literal that differs where a placeholder cannot stand');
        todo.push(...ms);
        continue;
      }
      const first = items[ms[0]!]!.src;
      let nonce = 0;
      // a name no source of the shape has, and no name the build replaces (`define`'s keys)
      while (ms.some((m) => items[m]!.src.includes(`_${nonce.toString(36)}__`)) || avoid.some((k) => k.includes(`_${nonce.toString(36)}__`))) nonce++;
      const names = lifted.map((_, i) => nameOf(nonce.toString(36), i));
      // the shape: the first page's source, each lifted literal a free identifier
      let shapeSrc = '', at = 0;
      lifted.forEach((j, i) => { const s = c0.sites[j]!; shapeSrc += first.slice(at, s.start) + names[i]; at = s.end; });
      shapeSrc += first.slice(at);
      // every page's literals as the minifier prints them: one build of a call with all of them as arguments, so each
      // is printed by the same pipeline as the shape
      const values = ms.map((m) => lifted.map((j) => cuts[m]!.sites[j]!.raw));
      const distinct = [...new Set(values.flat())];
      opaqueStats.builds += 2;
      const [shape, printed] = [await build(shapeSrc, ms[0]!, `${items[ms[0]!]!.what} and ${ms.length - 1} more of its shape`), await build(`${nameOf(nonce.toString(36), 99999)}(${distinct.join(', ')});\n`, ms[0]!, `the literals of ${items[ms[0]!]!.what}'s shape`)];
      const valueOf = new Map(ms.flatMap((m) => lifted.map((j) => [cuts[m]!.sites[j]!.raw, cuts[m]!.sites[j]!.value] as const)));
      const texts = printedArgs(printed.code, distinct, valueOf);
      if (!texts) { fallback('literals the minifier does not print one by one', ms.length); todo.push(...ms); continue; }
      const entry = Object.keys(shape.modules).find((id) => shape.modules[id]!.code?.includes(names[0]!));
      const refs = references(shape.code, names), mrefs = entry ? references(shape.modules[entry]!.code!, names) : [];
      let ok = !!refs && !!mrefs && ![...shape.keys].some((k) => names.some((x) => k.includes(x)));
      const written: Built[] = [];
      if (ok) for (const [n, m] of ms.entries()) {
        const t = values[n]!.map((r) => texts.get(r)!), num = lifted.map((j) => typeof cuts[m]!.sites[j]!.value === 'number');
        const modules = { ...shape.modules };
        if (entry) {
          const mc = writeRefs(shape.modules[entry]!.code!, mrefs!, values[n]!, num);
          modules[entry] = { ...shape.modules[entry]!, code: mc, renderedLength: shape.modules[entry]!.renderedLength + mc.length - shape.modules[entry]!.code!.length };
        }
        written.push({ code: writeRefs(shape.code, refs!, t, num), map: null, modules, keys: new Set(shape.keys) });
      }
      if (!ok) { fallback('an output where a placeholder is not a plain reference', ms.length); todo.push(...ms); continue; }
      opaqueStats.shapes++; opaqueStats.shared += ms.length;
      for (const [n, m] of ms.entries()) {
        out[m] = written[n]!;
        if (!audit) continue;
        opaqueStats.audited++; opaqueStats.builds++;
        const own = await build(items[m]!.src, m, items[m]!.what);
        const log = env('SN_EARLY_SHAPES_AUDIT_LOG');
        if (own.code === written[n]!.code) { opaqueStats.same++; if (log) (await import('node:fs')).appendFileSync(log, `${items[m]!.what}\tsame\t0\n`); continue; }
        // a difference is allowed only where the minifier, once it sees the value, makes the two the same
        const again = (await build(`${written[n]!.code}\n`, m, `${items[m]!.what} once more`)).code, mine = (await build(`${own.code}\n`, m, `${items[m]!.what} once more`)).code;
        if (again !== mine) throw new Error(`sinter: SN_EARLY_SHAPES_AUDIT: the early script of ${items[m]!.what}, written from its shape's build, differs from its own build other than by what the minifier computes from the value:\n${written[n]!.code}\n${own.code}`);
        opaqueStats.usedValue++;
        opaqueStats.rawBytes += written[n]!.code.length - own.code.length;
        opaqueStats.gzipBytes += gzip(written[n]!.code) - gzip(own.code);
        if (log) (await import('node:fs')).appendFileSync(log, `${items[m]!.what}\tused the value\t${written[n]!.code.length - own.code.length}\n`);
      }
    }
  }
  for (const i of todo.sort((a, b) => a - b)) { opaqueStats.builds++; out[i] = await build(items[i]!.src, i, items[i]!.what); }
  return out as Built[];
}

/** each literal of `raws` as printed in `code` (one call of them all), or null when a printed argument is not that literal */
function printedArgs(code: string, raws: string[], valueOf: Map<string, string | number>): Map<string, string> | null {
  let ast: Node;
  try { ast = parse(code, { ecmaVersion: 'latest', sourceType: 'script' }); } catch { return null; }
  type Arg = Node & { value?: unknown; expressions?: unknown[]; quasis?: Array<{ value: { cooked: string } }> };
  const found: Arg[][] = [];
  ancestor(ast, { CallExpression(n: Node) { const c = n as Node & { callee: Node & { name?: string }; arguments: Arg[] }; if (c.callee.type === 'Identifier' && c.callee.name?.startsWith('__sn_lit99999_')) found.push(c.arguments); } });
  const a = found.length === 1 ? found[0]! : null;
  if (!a || a.length !== raws.length) return null;
  const out = new Map<string, string>();
  for (const [i, raw] of raws.entries()) {
    const n = a[i]!, want = valueOf.get(raw);
    const got = n.type === 'Literal' ? n.value : n.type === 'TemplateLiteral' && !n.expressions!.length ? n.quasis![0]!.value.cooked : Symbol();
    if (!Object.is(got, want)) return null;
    out.set(raw, code.slice(n.start, n.end));
  }
  return out;
}
