// What a helper's result may hold of its arguments (docs/spec.md, Helpers' summaries), read from its body: a summary
// (`Flow`) that says which of its parameters' objects, at which paths, may be at which paths of the result. A helper gets
// one only when every construct in its body is one the analysis understands (the allow-list below); any other is
// today's rule, anything below every argument. No annotation is read or trusted.
//
// The analysis. A value is a set of references: to the object at a path below a parameter, or to an object the helper
// made (an allocation site: each expression that makes one, an object or array literal, `new Map()`, a built-in's fresh
// result, a call of a summarized function). What a site holds lives in one heap per helper, not on the variables that
// name it, so every name of an object (two locals, a loop variable, a callback's parameter, an element taken back out)
// sees a write through any other. A write into an object a parameter's reference names is a write into the page's
// state: the helper has no summary. Locals, block scopes and sites persist across the passes over the body, which repeat
// until nothing grows (each holds whatever is ever assigned to it). The result is the references it may be, expanded
// through the heap: a parameter's object at a path of the result is a flow.
//
// Understood: parameters (plain, with a default); `const` and `let` locals, array and object destructuring; `if`,
// `return`, `throw`, `try`, `for…of`, `for`, `while`, blocks; literals, templates, operators; member reads; object and
// array literals with spreads; `?:`, `&&`, `||`, `??`; arrow callbacks of the built-ins that take one, and functions of
// the modules the build reads that have a summary themselves; the built-ins below, each read for what it does on any
// receiver it may have (an object, an array, a `Map`, a `Set`, a `Date`, a string). Not understood: `this`, `arguments`,
// `eval`, `await`, `yield`, `switch`, a function that leaves the helper, a write to a module-level variable or into a
// parameter's object, a call of an unknown function or method, a callback given to a call that does not say what it does
// with it, recursion.
import { readFileSync, statSync } from 'node:fs';
import { resolveImport, FoldCache } from './fold-check.js';
import { parseModule } from './compiler/index.js';
import { lineCol } from './line-col.js';

/** one flow: the object at `sub` of the result may be the object at `src.slice(1)` of parameter `src[0]` */
export interface FlowPiece { sub: string[]; src: string[] }
/** a helper's summary: its flows (`[]`: its result holds none of its arguments' objects); `why`: why there is none */
export type Flow = { flows: FlowPiece[] } | { why: string };

type N = { type: string; start: number; end: number; [k: string]: any };
/** a reference: the object at `path` below parameter `root` (`'0'`, `'1'`, …), or the object site `root` (`'@…'`, no path) */
interface Ref { root: string; path: string[] }
/** a value during the analysis: the references it may be */
type V = Ref[];
/** what a site is: its kind says what built-ins do on it; `opaque`, a fresh object whose shape is not known (a summarized call's result, `JSON.parse()`) */
type Kind = 'object' | 'array' | 'map' | 'set' | 'date' | 'url' | 'opaque';
interface Site {
  id: string; kind: Kind;
  /** what it holds, by member (`*` any member, `**` at any depth; a Map's keys at KEY, its values at `*`) */
  heap: Map<string, Map<string, Ref>>;
  /** a module constant's object (shared by every call): no write into it is the helper's own */
  shared?: string;
  /** an opaque site: the flows of the call that made it, its arguments' values, and its path in that call's result */
  from?: { call: { flows: FlowPiece[]; args: V[] }; prefix: string[] };
  children?: Map<string, Site>;
  /** it stands for itself at every depth below (an opaque site past the depth the analysis follows) */
  deep?: boolean;
}

class Unproven extends Error {}

/** a Map's keys: a page's paths have them at `*`, with its values */
const KEY = '#key';
/** methods whose result is a primitive on any receiver they exist on */
const PRIM_METHODS = new Set(['includes', 'indexOf', 'lastIndexOf', 'join', 'has', 'startsWith', 'endsWith', 'trim', 'trimStart', 'trimEnd',
  'toLowerCase', 'toUpperCase', 'toLocaleLowerCase', 'toLocaleUpperCase', 'substring', 'substr', 'charAt', 'charCodeAt', 'codePointAt',
  'padStart', 'padEnd', 'repeat', 'search', 'localeCompare', 'normalize', 'toFixed', 'toPrecision', 'getTime', 'toISOString', 'getFullYear',
  'getMonth', 'getDate', 'getDay', 'getHours', 'getMinutes', 'getSeconds', 'getMilliseconds', 'getTimezoneOffset', 'getUTCFullYear',
  'getUTCMonth', 'getUTCDate', 'getUTCDay', 'getUTCHours', 'getUTCMinutes', 'getUTCSeconds', 'test']);
/** methods whose result is a fresh array of primitives */
const FRESH_ARRAY_METHODS = new Set(['split', 'match', 'matchAll', 'exec']);
const DATE_SETTERS = /^set(UTC)?(FullYear|Month|Date|Hours|Minutes|Seconds|Milliseconds|Time)$/;
const GLOBAL_PRIM = /^(String|Number|Boolean|parseInt|parseFloat|isNaN|isFinite|encodeURIComponent|decodeURIComponent|encodeURI|decodeURI)$/;
const isFn = (n: N | undefined) => !!n && (n.type === 'ArrowFunctionExpression' || n.type === 'FunctionExpression');

/** a path as the analysis keeps it: cut after `**`, three `*` in a row and anything past 12 segments widened to `**` */
const widen = (p: string[]): string[] => {
  const k = p.indexOf('**');
  if (k >= 0) return p.slice(0, k + 1);
  if (p.length >= 3 && p.at(-1) === '*' && p.at(-2) === '*' && p.at(-3) === '*') return [...p.slice(0, -3), '**'];
  return p.length > 12 ? [...p.slice(0, 11), '**'] : p;
};
const refKey = (r: Ref) => `${r.root}\0${r.path.join('\0')}`;
const union = (...vs: V[]): V => { const out: V = [], seen = new Set<string>(); for (const v of vs) for (const r of v) { const k = refKey(r); if (!seen.has(k)) { seen.add(k); out.push(r); } } return out; };
const isParam = (r: Ref) => r.root[0] !== '@';

interface ModuleInfo { file: string; text: string; ast: N; messages: Set<string>; fns: Map<string, N>; consts: Map<string, N>; lets: Set<string>; imports: Map<string, { from: string; name: string }>; exports: Map<string, string | { from: string; name: string } | null>; stars: string[] }

const modules = new Map<string, { stamp: string; info: ModuleInfo | null }>();
const cache = new FoldCache();

function moduleOf(file: string, root: string): ModuleInfo | null {
  let stamp: string;
  try { const s = statSync(file); stamp = `${s.mtimeMs}:${s.size}`; } catch { return null; }
  const hit = modules.get(file);
  if (hit?.stamp === stamp) return hit.info;
  let info: ModuleInfo | null = null;
  try {
    const text = readFileSync(file, 'utf8'), ast = parseModule(text, file) as unknown as N;
    info = { file, text, ast, messages: new Set(), fns: new Map(), consts: new Map(), lets: new Set(), imports: new Map(), exports: new Map(), stars: [] };
    const declare = (d: N) => {
      if (d.type === 'FunctionDeclaration' && d.id) info!.fns.set(d.id.name, d);
      if (d.type === 'VariableDeclaration') for (const v of d.declarations) {
        if (v.id.type !== 'Identifier') continue;
        if (d.kind === 'const' && v.init && /^(ArrowFunctionExpression|FunctionExpression)$/.test(v.init.type)) info!.fns.set(v.id.name, v.init);
        else if (d.kind === 'const' && v.init) info!.consts.set(v.id.name, v.init);
        else info!.lets.add(v.id.name);
      }
    };
    for (const s of ast.body as N[]) {
      if (s.type === 'ImportDeclaration') {
        const from = resolveImport(String(s.source.value), file, root, cache);
        // sinter's messages (`m.inbox_title()`): each is a function that returns a string
        if (String(s.source.value) === '@tiaforge-ui/sinter/messages') { for (const sp of s.specifiers) info.messages.add(sp.local.name); continue; }
        for (const sp of s.specifiers) if (sp.type === 'ImportSpecifier' && from) info.imports.set(sp.local.name, { from, name: sp.imported.name ?? sp.imported.value });
      } else if (s.type === 'ExportNamedDeclaration') {
        if (s.declaration) { declare(s.declaration); const d = s.declaration; for (const n of d.id ? [d.id.name] : d.declarations?.map((x: N) => x.id.name) ?? []) info.exports.set(n, n); }
        const from = s.source ? resolveImport(String(s.source.value), file, root, cache) : null;
        for (const sp of s.specifiers ?? []) {
          const local = sp.local.name ?? sp.local.value, exported = sp.exported.name ?? sp.exported.value;
          info.exports.set(exported, s.source ? (from ? { from, name: local } : null) : local);
        }
      } else if (s.type === 'ExportAllDeclaration' && !s.exported) {
        const from = resolveImport(String(s.source.value), file, root, cache);
        if (from) info.stars.push(from);
      } else declare(s);
    }
  } catch { info = null; }
  modules.set(file, { stamp, info });
  return info;
}

/** the declaration an exported name of `file` stands for: its module and its local name */
function exported(file: string, name: string, root: string, seen = new Set<string>()): { m: ModuleInfo; local: string } | null {
  if (seen.has(file)) return null;
  seen.add(file);
  const m = moduleOf(file, root);
  if (!m) return null;
  const e = m.exports.get(name);
  if (typeof e === 'string') return { m, local: e };
  if (e) return exported(e.from, e.name, root, seen);
  if (e === null) return null;
  for (const s of m.stars) { const r = exported(s, name, root, seen); if (r) return r; }
  return null;
}


/** The summaries of a project's helpers: by the helpers module's exported name (or `ns$member`, unsummarized), read from their bodies. */
export function helperFlows(helpersFile: string, root: string): (name: string) => Flow {
  const done = new Map<N, Flow>(), active = new Set<N>();

  const summarize = (fn: N, m: ModuleInfo): Flow => {
    const hit = done.get(fn);
    if (hit) return hit;
    if (active.has(fn)) return { why: 'it calls itself' };
    active.add(fn);
    let out: Flow;
    try { out = { flows: summaryOf(fn, m) }; } catch (e) { out = { why: e instanceof Unproven ? e.message : `the build could not read it: ${(e as Error).message}` }; } finally { active.delete(fn); }
    done.set(fn, out);
    return out;
  };

  /** the function a name stands for in module `m` (a function of it or an import from the modules the build reads) */
  const callee = (name: string, m: ModuleInfo): { fn: N; m: ModuleInfo } | null => {
    const f = m.fns.get(name);
    if (f) return { fn: f, m };
    const imp = m.imports.get(name);
    if (!imp) return null;
    const r = exported(imp.from, imp.name, root);
    const g = r?.m.fns.get(r.local);
    return g ? { fn: g, m: r!.m } : null;
  };

  /** a scope: its locals (the references each may be) and local functions; reads and writes go up to the enclosing ones */
  interface Scope { vars: Map<string, Map<string, Ref>>; fns: Map<string, N>; up: Scope | null }
  const lookup = (sc: Scope | null, name: string): Scope | null => { for (let x = sc; x; x = x.up) if (x.vars.has(name) || x.fns.has(name)) return x; return null; };

  /** a helper's flows: its body read until nothing grows, then its result expanded through the heap */
  function summaryOf(fn: N, m: ModuleInfo): FlowPiece[] {
    const where = (n: N) => { const { line, col } = lineCol(m.text, n.start); return `${m.file.startsWith(root) ? m.file.slice(root.length + 1) : m.file}:${line}:${col}`; };
    const no = (what: string, n: N): never => { throw new Unproven(`${what} (${where(n)})`); };
    /** the analysis's state, kept across passes: sites, scopes (by their node), how much they hold */
    const sites = new Map<string, Site>(), scopes = new Map<N, Scope>(), ids = new Map<N, number>(), running = new Set<N>();
    let size = 0, shared: string | null = null;
    const add = (into: Map<string, Ref>, v: V) => { for (const r of v) { const k = refKey(r); if (!into.has(k)) { into.set(k, r); size++; } } };
    const scopeOf = (node: N, up: Scope | null): Scope => { let s = scopes.get(node); if (!s) scopes.set(node, (s = { vars: new Map(), fns: new Map(), up })); return s; };

    /** the site an expression makes (one per node, and per `tag` where one node makes several) */
    const site = (n: N, kind: Kind, tag = ''): Site => {
      if (!ids.has(n)) ids.set(n, ids.size);
      const id = `@${ids.get(n)}${tag}`;
      let s = sites.get(id);
      if (!s) { sites.set(id, (s = { id, kind, heap: new Map() })); if (shared) s.shared = shared; size++; }
      return s;
    };
    const ref = (s: Site): Ref => ({ root: s.id, path: [] });
    /** a fresh object whose shape is not known: any member of it may be a fresh object too */
    const opaque = (n: N, tag = ''): Site => { const s = site(n, 'opaque', tag); s.from ??= { call: { flows: [], args: [] }, prefix: [] }; return s; };
    const put = (s: Site, seg: string, v: V) => { if (!v.length) return; let h = s.heap.get(seg); if (!h) s.heap.set(seg, (h = new Map())); add(h, v); };
    const siteOf = (r: Ref) => sites.get(r.root)!;

    /** an opaque site's member: a fresh object too, perhaps (made in the call, holding what its flows say is there) */
    const child = (s: Site, seg: string): Site => {
      if (s.from!.prefix.length >= 4) { s.deep = true; return s; }
      s.children ??= new Map();
      let c = s.children.get(seg);
      if (!c) {
        const id = `${s.id}/${seg}`;
        c = sites.get(id) ?? { id, kind: 'opaque', heap: new Map(), from: { call: s.from!.call, prefix: [...s.from!.prefix, seg] } };
        sites.set(id, c);
        s.children.set(seg, c);
        size++;
        populate(c);
      }
      put(s, seg, [ref(c)]);
      return c;
    };
    /** an opaque site holds what the flows of its call say is at its path of the result */
    const populate = (s: Site) => {
      const { call: { flows, args }, prefix } = s.from!;
      for (const f of flows) {
        if (f.sub.length <= prefix.length && !f.sub.includes('**')) continue;
        let i = 0, deep = false;
        for (; i < prefix.length; i++) {
          if (f.sub[i] === '**') { deep = true; break; }
          if (i >= f.sub.length || (f.sub[i] !== '*' && prefix[i] !== '*' && f.sub[i] !== prefix[i])) break;
        }
        if (!deep && i < prefix.length) continue;
        const v = mapped(args, f.src);
        const next = f.sub[prefix.length];
        if (deep || next === '**') put(s, '**', v);
        else if (f.sub.length === prefix.length + 1) put(s, next!, v);
        else child(s, next!);
      }
      for (const c of s.children?.values() ?? []) if (c !== s) populate(c);
    };
    /** a flow's source, given the call's arguments */
    const mapped = (args: V[], src: string[]): V => src.slice(1).reduce((v: V, seg) => (seg === '**' ? deepOf(v) : member(v, seg)), args[+src[0]!] ?? []);
    /** everything a value may hold at any depth: a parameter's references widened to `**`, sites and what they reach */
    const deepOf = (v: V): V => {
      const out: V = [], seen = new Set<string>();
      const go = (r: Ref) => {
        if (isParam(r)) { out.push({ root: r.root, path: widen([...r.path, '**']) }); return; }
        if (seen.has(r.root)) return;
        seen.add(r.root);
        out.push(r);
        for (const h of siteOf(r).heap.values()) for (const x of h.values()) go(x);
      };
      v.forEach(go);
      return union(out);
    };

    /** the member `prop` of a value (`*`: any member); a Map's keys are no member */
    const member = (v: V, prop: string): V => union(...v.map((r): V => {
      if (isParam(r)) return [{ root: r.root, path: r.path.at(-1) === '**' ? r.path : widen([...r.path, prop]) }];
      const s = siteOf(r);
      if (s.deep) return [r, ...[...s.heap.values()].flatMap((h) => [...h.values()])];
      if ((s.kind === 'array' && prop === 'length') || ((s.kind === 'map' || s.kind === 'set') && prop === 'size')) return [];
      const out: V = [];
      for (const [seg, h] of s.heap) if (seg !== KEY && (seg === prop || seg === '*' || seg === '**' || prop === '*')) out.push(...h.values());
      if (s.kind === 'opaque') out.push(ref(child(s, prop)));
      return out;
    }));
    /** what a list, a Set or a Map holds (its elements, items or values); what `forEach`, `find`, `filter`, … give a callback */
    const elements = (v: V): V => union(...v.map((r): V => (isParam(r) || ['array', 'set', 'map', 'opaque'].includes(siteOf(r).kind) ? member([r], '*') : [])));
    /** a list's indexes (primitive), a Set's items, a Map's keys */
    const keys = (v: V): V => union(...v.map((r): V => {
      if (isParam(r)) return member([r], '*');
      const s = siteOf(r);
      return s.kind === 'map' ? [...s.heap.get(KEY)?.values() ?? []] : s.kind === 'set' || s.kind === 'opaque' ? member([r], '*') : [];
    }));
    /** a pair `[key, value]` (a Map's entry, `entries()`), one site per node */
    const pair = (n: N, k: V, val: V): V => { const p = site(n, 'array', ':pair'); put(p, '0', k); put(p, '1', val); return [ref(p)]; };
    /** what iterating a value gives (a spread into an array, `for…of`, `Array.from`, `new Map()`): a list's elements, a Set's items, a Map's pairs; of a parameter's object, which the build does not know, either */
    const iterated = (v: V, n: N): V => union(...v.map((r): V => {
      const s = isParam(r) ? null : siteOf(r);
      if (s?.kind === 'array' || s?.kind === 'set') return member([r], '*');
      if (s?.kind === 'map') return pair(n, keys([r]), elements([r]));
      if (s && s.kind !== 'opaque') return [];
      // (a pair of a parameter's Map: its key and value at `*`, as a page's paths have them)
      const e = member([r], '*'), p = site(n, 'array', ':pair*');
      put(p, '*', e);
      return union(e, [ref(p)]);
    }));
    /** element `i` of what a pattern destructures: a list's at its index, anything else's as it iterates */
    const elementAt = (v: V, i: number, n: N): V => union(...v.map((r): V => (!isParam(r) && siteOf(r).kind === 'array' ? member([r], String(i)) : union(member([r], String(i)), iterated([r], n)))));
    /** a write into the objects a value may be: never into a parameter's or a module constant's; the sites it may be */
    const writable = (v: V, n: N): Site[] => v.map((r) => {
      if (isParam(r)) no('a write into an object of a parameter', n);
      const s = siteOf(r);
      if (s.shared) no(`a write into the module's \`${s.shared}\``, n);
      return s;
    });
    /** `{ ...from }`, `Object.assign(t, from)`: `from`'s own members into `t` */
    const copyInto = (t: Site[], from: V) => {
      for (const r of from) {
        const s = isParam(r) ? null : siteOf(r);
        if (!s || s.kind === 'opaque' || s.deep) { for (const x of t) put(x, '*', member([r], '*')); continue; }
        for (const [seg, h] of s.heap) if (seg !== KEY) for (const x of t) put(x, seg, [...h.values()]);
      }
    };
    /** a call of a function of the modules: its summary, with these arguments' values; its result, maybe a fresh object of its own */
    const apply = (name: string, g: { fn: N; m: ModuleInfo }, a: V[], n: N): V => {
      const s = summarize(g.fn, g.m);
      if ('why' in s) no(`a call of \`${name}\`, which has no summary: ${s.why}`, n);
      const flows = (s as { flows: FlowPiece[] }).flows;
      const r = opaque(n, `:${name}`);
      r.from!.call.flows = flows;
      r.from!.call.args = a;
      populate(r);
      return union([ref(r)], ...flows.filter((f) => !f.sub.length || f.sub[0] === '**').map((f) => mapped(a, f.src)));
    };

    function run(fn: N, given: V[] | undefined, up: Scope | null): V {
      if (fn.async || fn.generator) no(fn.async ? 'it is async' : 'it is a generator', fn);
      if (running.has(fn)) no('it calls itself', fn);
      running.add(fn);
      try { return body(fn, given, up); } finally { running.delete(fn); }
    }

    function body(fn: N, given: V[] | undefined, up: Scope | null): V {
      let cur: Scope = scopeOf(fn, up);
      /** a block's declarations are its own, kept by its node across passes */
      const inBlock = (node: N, f: () => void) => { const prev = cur; cur = scopeOf(node, prev); try { f(); } finally { cur = prev; } };
      const has = (k: string) => !!lookup(cur, k)?.vars.has(k);
      const get = (k: string): V => [...lookup(cur, k)!.vars.get(k)!.values()];
      const declare = (k: string, v: V) => { let h = cur.vars.get(k); if (!h) { cur.vars.set(k, (h = new Map())); size++; } add(h, v); };
      const assign = (name: string, v: V, n: N) => {
        if (!has(name)) { if (m.lets.has(name) || m.consts.has(name)) no(`a write to the module's \`${name}\``, n); no(`a write to \`${name}\`, which it does not declare`, n); }
        add(lookup(cur, name)!.vars.get(name)!, v);
      };
      const bind = (id: N, v: V) => {
        if (id.type === 'Identifier') declare(id.name, v);
        else if (id.type === 'ArrayPattern') id.elements.forEach((e: N | null, i: number) => {
          if (!e) return;
          if (e.type !== 'RestElement') return bind(e, elementAt(v, i, id));
          const rest = site(e, 'array');
          put(rest, '*', iterated(v, id));
          bind(e.argument, [ref(rest)]);
        });
        else if (id.type === 'ObjectPattern') for (const p of id.properties) {
          if (p.type === 'RestElement') { const rest = site(p, 'object'); copyInto([rest], v); bind(p.argument, [ref(rest)]); continue; }
          if (p.computed) value(p.key);
          bind(p.value, member(v, p.computed ? (p.key.type === 'Literal' ? String(p.key.value) : '*') : p.key.name ?? String(p.key.value)));
        }
        else if (id.type === 'AssignmentPattern') bind(id.left, union(v, value(id.right)));
        else no('a binding the build does not read', id);
      };
      /** a function given to a call: run with what the call gives it (a built-in's elements, a summarized function's arguments) */
      const callback = (f: N | undefined, args: V[], n: N): V => {
        if (f?.type === 'Identifier') {
          const local = lookup(cur, f.name);
          if (local?.fns.has(f.name)) {
            const g = local.fns.get(f.name)!;
            if (g.type === 'Caught') no(`\`${f.name}\`, a caught value`, f);
            return run(g, args, local);
          }
          if (local) no(`a callback \`${f.name}\`, a value`, f);
          // a built-in that makes a primitive of its argument (`.map(Number)`, `.filter(Boolean)`)
          if (GLOBAL_PRIM.test(f.name) && !m.fns.has(f.name) && !m.imports.has(f.name)) return [];
          const g = callee(f.name, m);
          if (!g) no(`a callback \`${f.name}\`, which the build cannot read`, f);
          return apply(f.name, g!, args, n);
        }
        if (!f || f.type !== 'ArrowFunctionExpression') no('a callback that is not an arrow function', f ?? n);
        return run(f!, args, cur);
      };
      /** the arguments of a call that takes no callback: a function given to it is unproven */
      const plain = (n: N): V[] => n.arguments.map((a: N) => { if (isFn(a)) no('a function given to a call that does not say what it does with it', a); return value(a); });

      const builtin = (n: N, o: string, method: string): V => {
        const a = n.arguments as N[];
        if (o === 'Math' || o === 'Number' || (o === 'Array' && method === 'isArray') || (o === 'Date' && method === 'now') || (o === 'JSON' && method === 'stringify')) { plain(n); return []; }
        if (o === 'JSON' && method === 'parse') { plain(n); return [ref(opaque(n))]; }
        if (o === 'Object') {
          if (method === 'keys') { plain(n); return [ref(site(n, 'array'))]; }
          if (method === 'values') { const [x] = plain(n); const s = site(n, 'array'); put(s, '*', member(x ?? [], '*')); return [ref(s)]; }
          if (method === 'entries') { const [x] = plain(n); const s = site(n, 'array'); put(s, '*', pair(n, [], member(x ?? [], '*'))); return [ref(s)]; }
          if (method === 'fromEntries') { const [x] = plain(n); const s = site(n, 'object'); put(s, '*', member(iterated(x ?? [], n), '1')); return [ref(s)]; }
          if (method === 'assign') { const [t, ...rest] = plain(n); const ts = writable(t ?? [], n); rest.forEach((x) => copyInto(ts, x)); return t ?? []; }
          if (method === 'freeze' || method === 'seal' || method === 'preventExtensions') return plain(n)[0] ?? [];
        }
        if (o === 'Array' && method === 'from') {
          const s = site(n, 'array');
          const els = iterated(a[0] ? value(a[0]) : [], n);
          put(s, '*', a[1] ? callback(a[1], [els, []], n) : els);
          return [ref(s)];
        }
        if (o === 'Array' && method === 'of') { const s = site(n, 'array'); put(s, '*', union(...plain(n))); return [ref(s)]; }
        return no(`a call of \`${o}.${method}()\``, n);
      };

      /** a method of a value whose kind the build may not know: what it does on each receiver it may be */
      const method = (n: N, recv: V, name: string): V => {
        const a = n.arguments as N[];
        const els = () => elements(recv);
        const fresh = (...held: V[]) => { const s = site(n, 'array'); put(s, '*', union(...held)); return [ref(s)]; };
        const changes = () => writable(recv, n);
        switch (name) {
          case 'map': return fresh(callback(a[0], [els(), [], recv], n));
          case 'flatMap': { const r = callback(a[0], [els(), [], recv], n); return fresh(r, elements(r)); }
          case 'forEach': callback(a[0], [els(), keys(recv), recv], n); return [];
          case 'some': case 'every': case 'findIndex': case 'findLastIndex': callback(a[0], [els(), [], recv], n); return [];
          case 'find': case 'findLast': callback(a[0], [els(), [], recv], n); return els();
          case 'filter': callback(a[0], [els(), [], recv], n); return fresh(els());
          case 'reduce': case 'reduceRight': {
            // the accumulator: its start and whatever the callback returns, until nothing grows
            if (a.length < 2) no(`\`${name}()\` without a start value`, n);
            let acc = value(a[1]);
            for (let i = 0; ; i++) {
              if (i > 8) no(`a \`${name}()\` whose value the build cannot settle`, n);
              const next = union(acc, callback(a[0], [acc, els(), [], recv], n));
              if (next.length === acc.length) return acc;
              acc = next;
            }
          }
          case 'sort': changes(); if (a[0]) callback(a[0], [els(), els()], n); return recv;
          case 'toSorted': if (a[0]) callback(a[0], [els(), els()], n); return fresh(els());
          case 'reverse': case 'copyWithin': changes(); plain(n); return recv;
          case 'fill': { const ss = changes(); const [v] = plain(n); for (const s of ss) put(s, '*', v ?? []); return recv; }
          case 'push': case 'unshift': { const ss = changes(); const v = union(...plain(n)); for (const s of ss) put(s, '*', v); return []; }
          case 'splice': { const ss = changes(); const v = union(...plain(n).slice(2)); const out = fresh(els()); for (const s of ss) put(s, '*', v); return out; }
          case 'pop': case 'shift': changes(); return els();
          case 'add': { const ss = changes(); const [v] = plain(n); for (const s of ss) put(s, '*', v ?? []); return recv; }
          case 'set': {
            const ss = changes();
            const [k, v] = plain(n);
            for (const s of ss) { if (s.kind === 'map') { put(s, KEY, k ?? []); put(s, '*', v ?? []); } else if (s.kind !== 'url') put(s, '*', union(k ?? [], v ?? [])); }
            return recv;
          }
          case 'delete': case 'clear': changes(); plain(n); return [];
          case 'get': plain(n); return union(...recv.map((r) => (!isParam(r) && siteOf(r).kind === 'url' ? [] : member([r], '*'))));
          case 'at': plain(n); return els();
          case 'keys': plain(n); return fresh(keys(recv));
          case 'values': plain(n); return fresh(els());
          case 'entries': plain(n); return fresh(pair(n, keys(recv), els()));
          case 'slice': plain(n); return fresh(els());
          case 'toReversed': plain(n); return fresh(els());
          case 'toSpliced': return fresh(els(), ...plain(n).slice(2));
          case 'with': return fresh(els(), plain(n)[1] ?? []);
          case 'concat': return fresh(els(), ...plain(n).map((v) => union(v, elements(v))));
          case 'flat': {
            const d = !a[0] ? 1 : a[0].type === 'Literal' && typeof a[0].value === 'number' && a[0].value <= 4 ? a[0].value : no('`flat()` to a depth the build does not know', n);
            let level = els(), all = level;
            for (let i = 0; i < d; i++) { level = elements(level); all = union(all, level); }
            return fresh(all);
          }
          case 'valueOf': return recv.filter((r) => isParam(r) || siteOf(r).kind !== 'date');
          // on an object of a parameter's (or an opaque one) these may be its own, returning anything below it
          case 'toString': case 'toLocaleString': case 'toJSON': plain(n); return deepOf(recv.filter((r) => isParam(r) || siteOf(r).kind === 'opaque'));
          case 'replace': case 'replaceAll':
            value(a[0]);
            if (isFn(a[1])) callback(a[1], [[], [], [], []], n); else value(a[1]);
            return [];
        }
        if (DATE_SETTERS.test(name)) { changes(); plain(n); return []; }
        if (PRIM_METHODS.has(name)) { plain(n); return []; }
        if (FRESH_ARRAY_METHODS.has(name)) { plain(n); return fresh(); }
        return no(`a call of the method \`${name}()\`, which the build does not know`, n);
      };

      const call = (n: N): V => {
        const c = n.callee.type === 'ChainExpression' ? n.callee.expression : n.callee;
        if (n.arguments.some((a: N) => a.type === 'SpreadElement')) no('a call with a spread argument', n);
        if (c.type === 'Identifier') {
          const local = lookup(cur, c.name);
          if (local?.fns.has(c.name)) {
            const g = local.fns.get(c.name)!;
            if (g.type === 'Caught') no(`\`${c.name}\`, a caught value`, c);
            return run(g, plain(n), local);
          }
          if (local) no(`a call of \`${c.name}\`, a value`, n);
          if (GLOBAL_PRIM.test(c.name) && !m.fns.has(c.name) && !m.imports.has(c.name)) { plain(n); return []; }
          if (c.name === 'structuredClone' && !m.fns.has(c.name) && !m.imports.has(c.name)) { plain(n); return [ref(opaque(n))]; }
          if (c.name === 'eval') no('`eval`', c);
          const g = callee(c.name, m);
          if (!g) no(`a call of \`${c.name}\`, which the build cannot read`, n);
          return apply(c.name, g!, plain(n), n);
        }
        if (c.type !== 'MemberExpression') no('a call of a computed value', n);
        const name = !c.computed && c.property.type === 'Identifier' ? c.property.name : null;
        if (!name) no('a call of a method named by a value', n);
        if (c.object.type === 'Identifier' && !lookup(cur, c.object.name) && !m.consts.has(c.object.name) && !m.fns.has(c.object.name) && !m.imports.has(c.object.name)) {
          // sinter's messages (`m.inbox_title()`): each is a function that returns a string
          if (m.messages.has(c.object.name)) { plain(n); return []; }
          return builtin(n, c.object.name, name!);
        }
        return method(n, value(c.object), name!);
      };

      const prop = (e: N): string => (!e.computed && e.property.type === 'Identifier' ? e.property.name : e.computed && e.property.type === 'Literal' ? String(e.property.value) : '*');
      const value = (e: N | null | undefined): V => {
        if (!e) return [];
        switch (e.type) {
          case 'Literal': return [];
          case 'TemplateLiteral': e.expressions.forEach(value); return [];
          case 'BinaryExpression': value(e.left); value(e.right); return [];
          case 'UnaryExpression': if (e.operator === 'delete') no('`delete`', e); value(e.argument); return [];
          case 'UpdateExpression':
            if (e.argument.type === 'Identifier') { assign(e.argument.name, [], e); return []; }
            if (e.argument.type !== 'MemberExpression') no('an update the build does not read', e);
            if (e.argument.computed) value(e.argument.property);
            writable(value(e.argument.object), e);
            return [];
          case 'ParenthesizedExpression': case 'TSAsExpression': case 'TSNonNullExpression': case 'TSSatisfiesExpression': case 'TSTypeAssertion': case 'ChainExpression': return value(e.expression);
          case 'ConditionalExpression': value(e.test); return union(value(e.consequent), value(e.alternate));
          case 'LogicalExpression': return union(value(e.left), value(e.right));
          case 'SequenceExpression': return e.expressions.map(value).at(-1);
          case 'Identifier': {
            if (has(e.name)) return get(e.name);
            const local = lookup(cur, e.name);
            if (local?.fns.has(e.name)) no(local.fns.get(e.name)!.type === 'Caught' ? `\`${e.name}\`, a caught value` : `the local function \`${e.name}\` used as a value`, e);
            if (/^(undefined|NaN|Infinity)$/.test(e.name)) return [];
            if (e.name === 'arguments' || e.name === 'eval') no(`\`${e.name}\``, e);
            const k = m.consts.get(e.name);
            if (k) return moduleConst(e.name, k);
            return no(`\`${e.name}\`, which the build cannot follow`, e);
          }
          case 'ThisExpression': return no('`this`', e);
          case 'MemberExpression': {
            if (e.computed) value(e.property);
            return member(value(e.object), prop(e));
          }
          case 'ObjectExpression': {
            const s = site(e, 'object');
            for (const p of e.properties) {
              if (p.type === 'SpreadElement') { copyInto([s], value(p.argument)); continue; }
              if (p.kind !== 'init' || p.method) no('a method or an accessor in an object', p);
              if (p.computed) value(p.key);
              put(s, p.computed ? (p.key.type === 'Literal' ? String(p.key.value) : '*') : p.key.name ?? String(p.key.value), value(p.value));
            }
            return [ref(s)];
          }
          case 'ArrayExpression': {
            const s = site(e, 'array');
            let spread = false;
            e.elements.forEach((x: N | null, i: number) => {
              if (!x) return;
              if (x.type === 'SpreadElement') { spread = true; put(s, '*', iterated(value(x.argument), x)); } else put(s, spread ? '*' : String(i), value(x));
            });
            return [ref(s)];
          }
          case 'CallExpression': return call(e);
          case 'NewExpression': {
            const c = e.callee.type === 'Identifier' && !lookup(cur, e.callee.name) && !m.fns.has(e.callee.name) && !m.imports.has(e.callee.name) && !m.consts.has(e.callee.name) ? e.callee.name : '';
            if (/^(Date|URL|URLSearchParams|RegExp)$/.test(c) || (c === 'Error' && e.arguments.length <= 1)) { plain(e); return [ref(site(e, c === 'Date' ? 'date' : c.startsWith('URL') ? 'url' : 'object'))]; }
            if (c === 'Set' || c === 'WeakSet') { const [x] = plain(e); const s = site(e, 'set'); put(s, '*', iterated(x ?? [], e)); return [ref(s)]; }
            if (c === 'Map' || c === 'WeakMap') {
              const [x] = plain(e);
              const s = site(e, 'map'), pairs = iterated(x ?? [], e);
              put(s, KEY, member(pairs, '0'));
              put(s, '*', member(pairs, '1'));
              return [ref(s)];
            }
            return no(`\`new ${c || '…'}()\``, e);
          }
          case 'AssignmentExpression': {
            const v = value(e.right);
            const kept = e.operator === '=' || /^(\|\||&&|\?\?)=$/.test(e.operator) ? v : [];
            if (e.left.type === 'Identifier') { assign(e.left.name, kept, e); return v; }
            if (e.left.type === 'MemberExpression') {
              if (e.left.computed) value(e.left.property);
              for (const s of writable(value(e.left.object), e)) put(s, prop(e.left), kept);
              return v;
            }
            return no('a destructuring assignment', e);
          }
          case 'ArrowFunctionExpression': case 'FunctionExpression': return no('a function that leaves the helper', e);
          case 'AwaitExpression': case 'YieldExpression': return no(`\`${e.type === 'AwaitExpression' ? 'await' : 'yield'}\``, e);
          default: return no(`a construct the build does not read (${e.type})`, e);
        }
      };
      /** a module constant: its value, read where nothing of the helper's is in scope; its objects are shared by every call */
      const moduleConst = (name: string, init: N): V => {
        const prev = cur, was = shared;
        cur = scopeOf(init, null);
        shared = name;
        try { return value(init); } finally { cur = prev; shared = was; }
      };

      let result: V = [];
      const stmt = (s: N) => {
        switch (s.type) {
          case 'BlockStatement': inBlock(s, () => s.body.forEach(stmt)); return;
          case 'ExpressionStatement': value(s.expression); return;
          case 'VariableDeclaration': for (const d of s.declarations) {
            // a local arrow function: run where it is called, with what it is given
            if (s.kind === 'const' && d.id.type === 'Identifier' && d.init?.type === 'ArrowFunctionExpression') { cur.fns.set(d.id.name, d.init); continue; }
            bind(d.id, d.init ? value(d.init) : []);
          } return;
          case 'ReturnStatement': result = union(result, value(s.argument)); return;
          case 'IfStatement': value(s.test); stmt(s.consequent); if (s.alternate) stmt(s.alternate); return;
          case 'ThrowStatement': value(s.argument); return;
          case 'TryStatement': {
            stmt(s.block);
            // what was thrown may be anything a callee threw: the caught value cannot be read
            if (s.handler) inBlock(s.handler, () => { if (s.handler.param) cur.fns.set(s.handler.param.name ?? '', { type: 'Caught', start: s.handler.start, end: s.handler.end }); stmt(s.handler.body); });
            if (s.finalizer) stmt(s.finalizer);
            return;
          }
          case 'ForOfStatement': {
            const it = iterated(value(s.right), s), d = s.left.type === 'VariableDeclaration' ? s.left.declarations[0].id : s.left;
            // (a loop over a variable declared outside it assigns that variable)
            if (!s.left.declarations) { if (d.type !== 'Identifier') no('a loop that destructures into names it does not declare', s); assign(d.name, it, s); }
            inBlock(s, () => { if (s.left.declarations) bind(d, it); stmt(s.body); });
            return;
          }
          case 'ForStatement': inBlock(s, () => { if (s.init) (s.init.type === 'VariableDeclaration' ? stmt(s.init) : value(s.init)); value(s.test); value(s.update); stmt(s.body); }); return;
          case 'WhileStatement': case 'DoWhileStatement': value(s.test); stmt(s.body); return;
          case 'BreakStatement': case 'ContinueStatement': case 'EmptyStatement': return;
          case 'TSTypeAliasDeclaration': case 'TSInterfaceDeclaration': return;
          default: no(`a statement the build does not read (${s.type})`, s);
        }
      };
      (fn.params as N[]).forEach((p, i) => {
        const id = p.type === 'AssignmentPattern' ? p.left : p.type === 'TSParameterProperty' ? p.parameter : p;
        if (id.type === 'RestElement') no('a rest parameter', p);
        const own: V = given ? given[i] ?? [] : [{ root: String(i), path: [] }];
        bind(id, p.type === 'AssignmentPattern' ? union(own, value(p.right)) : own);
      });
      if (fn.body.type === 'BlockStatement') fn.body.body.forEach(stmt); else result = value(fn.body);
      return result;
    }

    // (until nothing grows: a value assigned below reaches a read above, through chains of locals and of objects)
    let result: V = [];
    for (let pass = 0, before = -1; size !== before; pass++) {
      if (pass > 24) no('locals whose values the build cannot settle', fn);
      before = size;
      result = run(fn, undefined, null);
    }
    return resolve(result, fn);

    /** the result's flows: each parameter's reference it may be or reach through the heap, at the path it is reached by */
    function resolve(v: V, at: N): FlowPiece[] {
      const out = new Map<string, FlowPiece>();
      let budget = 50_000;
      const emit = (sub: string[], r: Ref) => { const f = { sub: widen(sub), src: [r.root, ...r.path] }; out.set(`${f.sub.join('.')}<${f.src.join('.')}`, f); };
      /** every parameter's reference a site reaches, at any depth */
      const below = (s: Site, sub: string[]) => { for (const r of deepOf([ref(s)])) if (isParam(r)) emit([...sub, '**'], r); };
      const visit = (r: Ref, sub: string[], stack: Set<string>) => {
        if (--budget < 0) no('a result the build cannot summarize', at);
        if (isParam(r)) return emit(sub, r);
        const s = siteOf(r);
        if (stack.has(s.id) || s.deep || sub.length > 12) return below(s, sub);
        stack.add(s.id);
        for (const [seg, h] of s.heap) for (const x of h.values()) visit(x, [...sub, seg === KEY ? '*' : seg], stack);
        stack.delete(s.id);
      };
      for (const r of v) visit(r, [], new Set());
      return [...out.values()];
    }
  }

  return (name: string): Flow => {
    const r = exported(helpersFile, name, root);
    if (!r) return { why: 'the build cannot find its declaration' };
    const fn = r.m.fns.get(r.local);
    if (!fn) return { why: 'it is not a function declaration or a `const` arrow function' };
    return summarize(fn, r.m);
  };
}
