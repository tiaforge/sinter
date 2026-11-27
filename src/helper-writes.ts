// Which parameters a helper writes into (docs/spec.md, Method classes: a helper changes none of its arguments).
// A syntactic check of the helpers' modules, with no false positives: a write counts only when its target's root is
// the parameter itself (never reassigned, not shadowed where it is written), reached by a chain of members, or through
// a `const` local initialized with such a chain (`const items = p.items`), a `for (const x of p.items)` variable or the
// element parameter of an inline callback of `forEach`, `map`, … over such a chain. Writes: an assignment, compound
// assignment, `++`/`--` or `delete` on a member; a call of a mutating method (`push`, `sort`, `set`, `add`, …);
// `Object.assign(<it>, …)`. A call that passes the parameter (or such a chain) on to a function of the modules that
// writes the parameter it lands in writes it too (a fixpoint over the calls). What it cannot see (a write through a
// value it does not follow, a function given as a value) is the dev build's to report (dev.ts, warning 37).
// The compiler reports a call of such a helper over page data (SN214).
import { relative, sep } from 'node:path';
import type { HelperManifest } from './compiler/compile.js';
import { parseModule } from './compiler/index.js';
import { FoldCache, moduleOf, resolveImport, targetOf } from './fold-check.js';
import { lineCol } from './line-col.js';

/** Where a helper writes into one of its parameters: the place, what it does there, and the functions on the way. */
export interface ParamWrite { file: string; line: number; col: number; what: string; chain: string[] }
/** Per helper, by the name compiled code calls (`fmt`, `ns$member`): per parameter, its write, or null. */
export type HelperWrites = Map<string, Array<ParamWrite | null>>;

type N = { type: string; start: number; end: number; [k: string]: any };
/** a call that passes a parameter on: the callee (a function of this module, or an import), the argument's position */
interface PassOn { to: { local: string } | { spec: string; name: string }; arg: number; param: number; at: number }
interface Fn { params: number; direct: Array<{ at: number; what: string } | null>; passes: PassOn[] }
interface Module { code: string; fns: Map<string, Fn> }

const MUTATORS = new Set(['push', 'pop', 'shift', 'unshift', 'splice', 'sort', 'reverse', 'fill', 'copyWithin', 'set', 'add', 'delete', 'clear']);
/** array methods whose first callback's first parameter is an element of the receiver */
const ITERATORS = new Set(['forEach', 'map', 'filter', 'find', 'findLast', 'findIndex', 'findLastIndex', 'some', 'every', 'flatMap']);
const SKIP = new Set(['type', 'start', 'end', 'loc', 'range', 'typeAnnotation', 'returnType', 'typeParameters', 'typeArguments', 'superTypeParameters', 'implements', 'decorators']);
const fnLike = (n: N | null | undefined): boolean => !!n && (n.type === 'FunctionDeclaration' || n.type === 'FunctionExpression' || n.type === 'ArrowFunctionExpression');

/** names a pattern binds */
function patternNames(p: N | null | undefined): string[] {
  switch (p?.type) {
    case 'Identifier': return [p.name];
    case 'ObjectPattern': return (p.properties as N[]).flatMap((x) => patternNames(x.type === 'RestElement' ? x.argument : x.value));
    case 'ArrayPattern': return (p.elements as Array<N | null>).flatMap((x) => patternNames(x));
    case 'RestElement': return patternNames(p.argument);
    case 'AssignmentPattern': return patternNames(p.left);
    case 'TSParameterProperty': return patternNames(p.parameter);
    default: return [];
  }
}
/** a parameter's own name: `p`, `p = …`, `p: T`; none for a destructured or rest one */
const paramName = (p: N): string | null => (p.type === 'Identifier' ? p.name : p.type === 'AssignmentPattern' && p.left.type === 'Identifier' ? p.left.name : p.type === 'TSParameterProperty' ? paramName(p.parameter) : null);
/** an expression without its TypeScript wrappers (`x!`, `x as T`, `<T>x`, `x satisfies T`) */
const bare = (n: N): N => (n.type === 'TSNonNullExpression' || n.type === 'TSAsExpression' || n.type === 'TSTypeAssertion' || n.type === 'TSSatisfiesExpression' || n.type === 'ParenthesizedExpression' ? bare(n.expression) : n);
/** the identifier a member chain starts from (`p` of `p.items[0].done`, `p` itself), else null */
function chainRoot(n: N): N | null {
  let cur = bare(n);
  if (cur.type === 'ChainExpression') cur = bare(cur.expression);
  while (cur.type === 'MemberExpression') cur = bare(cur.object.type === 'ChainExpression' ? cur.object.expression : cur.object);
  return cur.type === 'Identifier' ? cur : null;
}
const propName = (m: N): string | null => (!m.computed && m.property.type === 'Identifier' ? m.property.name : m.computed && m.property.type === 'Literal' && typeof m.property.value === 'string' ? m.property.value : null);

/** the identifiers a function's code assigns as a whole (`p = …`, `p += …`, `p++`, `for (p of …)`), in any scope */
function reassigned(body: N): Set<string> {
  const out = new Set<string>();
  const go = (n: N | null | undefined) => {
    if (!n || typeof n.type !== 'string') return;
    if (n.type === 'AssignmentExpression') for (const x of targets(n.left)) out.add(x);
    if (n.type === 'UpdateExpression' && bare(n.argument).type === 'Identifier') out.add(bare(n.argument).name);
    if ((n.type === 'ForOfStatement' || n.type === 'ForInStatement') && n.left.type !== 'VariableDeclaration') for (const x of targets(n.left)) out.add(x);
    for (const k of Object.keys(n)) { if (SKIP.has(k)) continue; const v = n[k]; if (Array.isArray(v)) v.forEach((c) => go(c)); else if (v && typeof v.type === 'string') go(v); }
  };
  const targets = (p: N): string[] => { const b = bare(p); return b.type === 'MemberExpression' ? [] : patternNames(b.type === 'Identifier' ? b : p); };
  go(body);
  return out;
}

/** One function's writes into its parameters, and the calls that pass them on. */
function analyzeFn(fn: N, top: Map<string, true>, imports: Map<string, { spec: string; name: string }>): Fn {
  const params = fn.params as N[];
  const out: Fn = { params: params.length, direct: params.map(() => null), passes: [] };
  const again = reassigned(fn);
  // scopes: a name to the parameter whose object it is part of, or null (shadowed)
  const scopes: Array<Map<string, number | null>> = [];
  const lookup = (name: string): number | null => { for (let i = scopes.length - 1; i >= 0; i--) if (scopes[i]!.has(name)) return scopes[i]!.get(name)!; return null; };
  /** the parameter a chain starts from (`p.items`, `items` a `const` of it), or null */
  const paramOf = (n: N): number | null => { const r = chainRoot(n); return r ? lookup(r.name) : null; };
  const declareFn = (f: N, bound: Map<string, number | null>) => {
    const s = new Map<string, number | null>(bound);
    for (const p of f.params as N[]) for (const x of patternNames(p)) if (!s.has(x)) s.set(x, null);
    // its `var`s and inner functions
    const hoist = (n: N | null | undefined) => {
      if (!n || typeof n.type !== 'string') return;
      if (fnLike(n)) { if (n.type === 'FunctionDeclaration' && n.id) s.set(n.id.name, null); return; }
      if (n.type === 'VariableDeclaration' && n.kind === 'var') for (const d of n.declarations) for (const x of patternNames(d.id)) s.set(x, null);
      if (n.type === 'ClassDeclaration' || n.type === 'ClassExpression') return;
      for (const k of Object.keys(n)) { if (SKIP.has(k)) continue; const v = n[k]; if (Array.isArray(v)) v.forEach((c) => hoist(c)); else if (v && typeof v.type === 'string') hoist(v); }
    };
    hoist(f.body);
    return s;
  };
  const write = (param: number | null, at: number, what: string) => { if (param !== null) out.direct[param] ??= { at, what }; };
  /** the `let`, `const`, classes and functions of a block: shadowed, or a `const` that is part of a parameter's object */
  const block = (stmts: N[]): Map<string, number | null> => {
    const s = new Map<string, number | null>();
    for (const st of stmts) {
      if (st.type === 'VariableDeclaration' && st.kind !== 'var') for (const d of st.declarations as N[]) for (const x of patternNames(d.id)) s.set(x, null);
      if ((st.type === 'ClassDeclaration' || st.type === 'FunctionDeclaration') && st.id) s.set(st.id.name, null);
    }
    return s;
  };
  const visit = (n: N | null | undefined): void => {
    if (!n || typeof n.type !== 'string') return;
    switch (n.type) {
      case 'FunctionDeclaration': case 'FunctionExpression': case 'ArrowFunctionExpression':
        scopes.push(declareFn(n, new Map()));
        visit(n.body);
        scopes.pop();
        return;
      case 'BlockStatement': case 'Program': case 'StaticBlock': {
        scopes.push(block(n.body));
        for (const st of n.body as N[]) visit(st);
        scopes.pop();
        return;
      }
      case 'SwitchStatement': {
        visit(n.discriminant);
        scopes.push(block((n.cases as N[]).flatMap((c) => c.consequent)));
        for (const c of n.cases as N[]) { visit(c.test); for (const st of c.consequent) visit(st); }
        scopes.pop();
        return;
      }
      case 'VariableDeclarator': {
        visit(n.init);
        // `const items = p.items`: the local is part of the parameter's object, while it is never assigned
        if (n.id.type === 'Identifier' && n.init && !again.has(n.id.name)) {
          const at = paramOf(n.init), decl = scopes[scopes.length - 1]!;
          if (at !== null && decl.has(n.id.name) && isChain(n.init) && kindOf(n) === 'const') decl.set(n.id.name, at);
        }
        return;
      }
      case 'ForStatement': case 'ForInStatement': case 'ForOfStatement': {
        const s = new Map<string, number | null>();
        const decl = n.type === 'ForStatement' ? n.init : n.left;
        if (decl?.type === 'VariableDeclaration' && decl.kind !== 'var') for (const d of decl.declarations as N[]) for (const x of patternNames(d.id)) s.set(x, null);
        if (n.type === 'ForOfStatement') visit(n.right);
        // `for (const x of p.items)`: `x` is an element of the parameter's object
        if (n.type === 'ForOfStatement' && decl?.type === 'VariableDeclaration' && decl.kind === 'const' && decl.declarations[0]?.id.type === 'Identifier' && isChain(n.right)) {
          const at = paramOf(n.right);
          if (at !== null) s.set(decl.declarations[0].id.name, at);
        }
        scopes.push(s);
        if (n.type === 'ForStatement') { visit(n.init); visit(n.test); visit(n.update); } else if (n.type === 'ForInStatement') { visit(n.right); }
        visit(n.body);
        scopes.pop();
        return;
      }
      case 'CatchClause':
        scopes.push(new Map(patternNames(n.param).map((x) => [x, null])));
        visit(n.body);
        scopes.pop();
        return;
      case 'ClassDeclaration': case 'ClassExpression':
        // a class's methods: `this` is not a parameter, and its own parameters shadow
        visitChildren(n);
        return;
      case 'AssignmentExpression':
        if (bare(n.left).type === 'MemberExpression') write(paramOf(n.left), n.start, `\`${text(n.left)} ${n.operator} …\``);
        visitChildren(n);
        return;
      case 'UpdateExpression':
        if (bare(n.argument).type === 'MemberExpression') write(paramOf(n.argument), n.start, `\`${text(n.argument)}${n.operator}\``);
        visitChildren(n);
        return;
      case 'UnaryExpression':
        if (n.operator === 'delete' && bare(n.argument).type === 'MemberExpression') write(paramOf(n.argument), n.start, `\`delete ${text(n.argument)}\``);
        visitChildren(n);
        return;
      case 'CallExpression': {
        const callee = bare(n.callee.type === 'ChainExpression' ? n.callee.expression : n.callee);
        const args = n.arguments as N[];
        if (callee.type === 'MemberExpression') {
          const name = propName(callee), recv = bare(callee.object);
          if (name && MUTATORS.has(name) && isChain(recv)) write(paramOf(recv), n.start, `\`${text(recv)}.${name}()\``);
          // `Object.assign(p.x, …)`
          if (name === 'assign' && recv.type === 'Identifier' && recv.name === 'Object' && lookup('Object') === null && args[0] && isChain(args[0])) write(paramOf(args[0]), n.start, `\`Object.assign(${text(args[0])}, …)\``);
          // `p.items.forEach((x) => { x.done = true; })`: `x` is an element of the parameter's object
          const cb = args[0] && bare(args[0]);
          if (name && ITERATORS.has(name) && cb && (cb.type === 'ArrowFunctionExpression' || cb.type === 'FunctionExpression') && isChain(recv)) {
            const at = paramOf(recv), first = cb.params[0] ? paramName(cb.params[0]) : null;
            visit(recv);
            scopes.push(declareFn(cb, new Map(first && at !== null && !reassigned(cb).has(first) ? [[first, at]] : [])));
            visit(cb.body);
            scopes.pop();
            for (const a of args.slice(1)) visit(a);
            return;
          }
        }
        // a call of a function of the modules: what it writes of the argument it is given, the caller writes of its parameter
        if (callee.type === 'Identifier' && lookup(callee.name) === null && !isLocal(callee.name)) {
          const to = top.has(callee.name) ? { local: callee.name } : imports.has(callee.name) ? imports.get(callee.name)! : null;
          if (to) args.forEach((a, i) => { if (a.type !== 'SpreadElement' && isChain(a)) { const p = paramOf(a); if (p !== null) out.passes.push({ to, arg: i, param: p, at: n.start }); } });
        }
        visitChildren(n);
        return;
      }
      default:
        visitChildren(n);
    }
  };
  /** declared anywhere in the scopes (shadowed: no longer the module's function) */
  const isLocal = (name: string) => scopes.some((s) => s.has(name));
  const isChain = (n: N): boolean => { const b = bare(n); if (b.type === 'Identifier') return true; if (b.type === 'ChainExpression') return isChain(b.expression); return b.type === 'MemberExpression' && isChain(b.object); };
  const kindOf = (d: N): string | null => declKinds.get(d) ?? null;
  const declKinds = new Map<N, string>();
  const mark = (n: N | null | undefined) => {
    if (!n || typeof n.type !== 'string') return;
    if (n.type === 'VariableDeclaration') for (const d of n.declarations) declKinds.set(d, n.kind);
    for (const k of Object.keys(n)) { if (SKIP.has(k)) continue; const v = n[k]; if (Array.isArray(v)) v.forEach((c) => mark(c)); else if (v && typeof v.type === 'string') mark(v); }
  };
  mark(fn.body);
  const visitChildren = (n: N) => { for (const k of Object.keys(n)) { if (SKIP.has(k)) continue; const v = n[k]; if (Array.isArray(v)) v.forEach((c) => visit(c)); else if (v && typeof v.type === 'string') visit(v); } };
  const code = currentCode;
  const text = (n: N) => { const t = code.slice(n.start, n.end).replace(/\s+/g, ' '); return t.length > 40 ? t.slice(0, 39) + '…' : t; };
  // the parameters: each its own, unless destructured, a rest, or assigned somewhere in the function
  const own = new Map<string, number | null>();
  params.forEach((p, i) => { const nm = paramName(p); for (const x of patternNames(p)) own.set(x, null); if (nm && !again.has(nm)) own.set(nm, i); });
  scopes.push(declareFn(fn, own));
  visit(fn.body);
  scopes.pop();
  return out;
}
let currentCode = '';

/** A module's functions (top-level declarations, `const f = (…) => …`, the default export), read once per text. */
const parsed = new Map<string, { code: string; module: Module }>();
function readModule(file: string, code: string): Module {
  const hit = parsed.get(file);
  if (hit && hit.code === code) return hit.module;
  const module: Module = { code, fns: new Map() };
  let ast: N;
  try { ast = parseModule(code, file) as unknown as N; } catch { parsed.set(file, { code, module }); return module; }
  const top = new Map<string, true>(), imports = new Map<string, { spec: string; name: string }>(), bodies: Array<[string, N]> = [];
  const declare = (d: N) => {
    if (d.type === 'FunctionDeclaration' && d.id) { top.set(d.id.name, true); bodies.push([d.id.name, d]); }
    else if (d.type === 'VariableDeclaration') for (const v of d.declarations as N[]) if (v.id.type === 'Identifier' && fnLike(v.init)) { top.set(v.id.name, true); bodies.push([v.id.name, v.init]); }
  };
  for (const st of ast.body as N[]) {
    if (st.type === 'ImportDeclaration' && st.importKind !== 'type') {
      for (const s of st.specifiers as N[]) if (s.importKind !== 'type') imports.set(s.local.name, { spec: String(st.source.value), name: s.type === 'ImportNamespaceSpecifier' ? '*' : s.type === 'ImportDefaultSpecifier' ? 'default' : (s.imported.name ?? String(s.imported.value)) });
    } else if (st.type === 'ExportNamedDeclaration' && st.declaration) declare(st.declaration);
    else if (st.type === 'ExportDefaultDeclaration' && fnLike(st.declaration)) { const name = st.declaration.id?.name ?? 'default'; top.set(name, true); bodies.push([name, st.declaration]); }
    else declare(st);
  }
  currentCode = code;
  for (const [name, body] of bodies) module.fns.set(name, analyzeFn(body, top, imports));
  parsed.set(file, { code, module });
  return module;
}

/**
 * Per parameter of export `name` of `file`, where it is written (directly, or by a function it passes it to); null
 * for a parameter it does not write, and `null` for an export that is no function of the modules the check reads.
 */
export function exportWrites(file: string, name: string, root: string, cache: FoldCache = new FoldCache()): Array<ParamWrite | null> | null {
  /** the function an export is: its module and local name, through re-exports */
  const fnOf = (f: string, exp: string, depth = 0): { file: string; local: string } | null => {
    if (depth > 50) return null;
    const m = moduleOf(f, cache);
    if (m.broken) return null;
    const e = m.exports.get(exp);
    if (e && 'local' in e) return readModule(f, m.code).fns.has(e.local) ? { file: f, local: e.local } : null;
    const via = e && 'spec' in e ? [e] : m.stars.map((spec) => ({ spec, name: exp }));
    for (const r of via) {
      if (r.name === '*') return null;
      const t = targetOf(r.spec, f, root, cache);
      const hit = t ? fnOf(t, r.name, depth + 1) : null;
      if (hit) return hit;
    }
    return null;
  };
  const start = fnOf(file, name);
  if (!start) return null;
  // the functions reachable from it, then their writes to a fixpoint
  const key = (x: { file: string; local: string }) => `${x.file}\0${x.local}`;
  const fns = new Map<string, { file: string; local: string; fn: Fn; code: string; writes: Array<ParamWrite | null> }>();
  const stack = [start];
  while (stack.length) {
    const s = stack.pop()!;
    if (fns.has(key(s))) continue;
    const m = readModule(s.file, moduleOf(s.file, cache).code);
    const fn = m.fns.get(s.local)!;
    fns.set(key(s), { ...s, fn, code: m.code, writes: fn.direct.map((d) => (d ? { file: s.file, ...lineCol(m.code, d.at), what: d.what, chain: [s.local] } : null)) });
    for (const p of fn.passes) {
      const t = 'local' in p.to ? (m.fns.has(p.to.local) ? { file: s.file, local: p.to.local } : null) : (() => { const f = targetOf(p.to.spec, s.file, root, cache); return f && p.to.name !== '*' ? fnOf(f, p.to.name) : null; })();
      if (t) { (p as PassOn & { target?: string }).target = key(t); stack.push(t); }
    }
  }
  for (let changed = true; changed;) {
    changed = false;
    for (const f of fns.values()) for (const p of f.fn.passes as Array<PassOn & { target?: string }>) {
      const t = p.target ? fns.get(p.target) : undefined, w = t?.writes[p.arg];
      if (w && !f.writes[p.param]) { f.writes[p.param] = { ...w, chain: [f.local, ...w.chain] }; changed = true; }
    }
  }
  return fns.get(key(start))!.writes;
}

/** The writes of each helper of a manifest, by the name compiled code calls (`fmt`, `ns$member`); only those that write. */
export function helperWrites(manifest: HelperManifest, root: string, helpersFile: string | null, cache: FoldCache = new FoldCache()): HelperWrites {
  const out: HelperWrites = new Map();
  const from = helpersFile ?? `${root}/src/sinter.helpers.js`;
  const one = (key: string, spec: string | null, name: string) => {
    const f = spec ? resolveImport(spec, from, root, cache) : null;
    let w: Array<ParamWrite | null> | null = null;
    try { w = f ? exportWrites(f, name, root, cache) : null; } catch { /* reads nothing of it */ }
    if (w?.some(Boolean)) out.set(key, w);
  };
  for (const h of manifest.names) { const o = manifest.from?.[h]; one(h, o?.module ?? manifest.module, o?.name ?? h); }
  for (const [ns, v] of Object.entries(manifest.namespaces)) {
    if (v.module === '@tiaforge-ui/sinter/messages' || v.module.startsWith('sinter:content/')) continue;
    for (const m of v.members) { const o = v.from?.[m]; one(`${ns}$${m}`, o?.module ?? v.module, o?.name ?? m); }
  }
  return out;
}

/** The writes of a function given as a value (testing's `render()`), from its own source: what it calls is unknown. */
export function functionWrites(fn: unknown, name: string): Array<ParamWrite | null> | null {
  if (typeof fn !== 'function') return null;
  const inner = (fn as unknown as Record<symbol, unknown>)[Symbol.for('sinter.memo')];
  // memo() copies its object arguments: the function it calls changes the copies
  if (typeof inner === 'function') return null;
  const src = Function.prototype.toString.call(fn);
  if (/\{\s*\[native code\]\s*\}\s*$/.test(src)) return null;
  for (const code of [`export const $f = (${src});\n`, `export const $f = ({ ${src} });\n`]) {
    try { parseModule(code, `/<${name}>.js`); } catch { continue; }
    const m = readModule(`/<${name}>.js`, code);
    let f = m.fns.get('$f');
    // a method written in an object literal: its one function
    if (!f) {
      const ast = parseModule(code, `/<${name}>.js`) as unknown as N;
      const obj = ast.body[0]?.declaration?.declarations?.[0]?.init;
      const fnNode = obj?.type === 'ObjectExpression' ? obj.properties[0]?.value : null;
      if (!fnLike(fnNode)) return null;
      currentCode = code;
      f = analyzeFn(fnNode, new Map(), new Map());
    }
    const w = f.direct.map((d) => (d ? { file: `<${name}>`, ...lineCol(code, d.at), what: d.what, chain: [name] } : null));
    return w.some(Boolean) ? w : null;
  }
  return null;
}

/** where a write is, for a message: `src/lib/x.ts:12:3`, with the functions on the way */
export function writePlace(w: ParamWrite, root: string): string {
  const file = w.file.startsWith('<') ? w.file : relative(root, w.file).split(sep).join('/');
  return `${file}:${w.line}:${w.col}${w.chain.length > 1 ? `, through ${w.chain.join(' → ')}` : ''}`;
}
