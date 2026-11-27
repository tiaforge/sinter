// What a helper's result may hold of its arguments (docs/spec.md, Aliases), read from its body: a summary (`Flow`) that
// says which of its parameters' objects, at which paths, may be at which paths of the result. A helper gets one only when
// every construct in its body is one the analysis understands (the allow-list below); any other is today's rule, anything
// below every argument. No annotation is read or trusted.
//
// Understood: parameters (plain, with a default); `const` and `let` locals (each holds whatever is ever assigned to it),
// array and object destructuring; `if`, `return`, `throw`, `for…of`, `for`, `while`, blocks; literals, templates,
// operators; member reads; object and array literals with spreads; `?:`, `&&`, `||`, `??`; calls of other functions of
// the modules the build reads that have a summary themselves; the built-ins whose results are primitive or fresh
// (`String()`, `Math.*`, `JSON.*`, `Object.keys`, string and number methods), the list methods whose results are elements
// or contents of their receiver (`find`, `filter`, `slice`, `map` with an arrow callback, …), `new Date`, `Set`, `Map`.
// A write is understood only into a value the function made (a local object or `Date`), never into what a parameter holds.
// Not understood: `this`, `arguments`, `eval`, `await`, `yield`, a closure that is not an arrow callback of a list method,
// a write to a module-level variable or into a parameter's object, a call of an unknown function or method, recursion.
import { readFileSync, statSync } from 'node:fs';
import { resolveImport, FoldCache } from './fold-check.js';
import { parseModule } from './compiler/index.js';
import { lineCol } from './line-col.js';

/** one flow: the object at `sub` of the result may be the object at `path` of parameter `param` */
export interface FlowPiece { sub: string[]; src: string[] }
/** a helper's summary: its flows (`[]`: its result holds none of its arguments' objects); `why`: why there is none */
export type Flow = { flows: FlowPiece[] } | { why: string };

type N = { type: string; start: number; end: number; [k: string]: any };
/** a value during the analysis: what it may hold, by source (`src[0]` the parameter's index, then the path) */
type V = FlowPiece[];

class Unproven extends Error {}

const FRESH_METHODS = new Set(['includes', 'indexOf', 'lastIndexOf', 'findIndex', 'findLastIndex', 'some', 'every', 'join',
  'toString', 'toLocaleString', 'has', 'startsWith', 'endsWith', 'trim', 'trimStart', 'trimEnd', 'toLowerCase', 'toUpperCase',
  'toLocaleLowerCase', 'toLocaleUpperCase', 'split', 'substring', 'substr', 'charAt', 'charCodeAt', 'codePointAt', 'padStart', 'padEnd',
  'repeat', 'replace', 'replaceAll', 'match', 'matchAll', 'search', 'localeCompare', 'normalize', 'toFixed', 'toPrecision', 'getTime',
  'toISOString', 'toJSON', 'getFullYear', 'getMonth', 'getDate', 'getDay', 'getHours', 'getMinutes', 'getSeconds', 'getMilliseconds',
  'getTimezoneOffset', 'getUTCFullYear', 'getUTCMonth', 'getUTCDate', 'getUTCDay', 'getUTCHours', 'getUTCMinutes', 'valueOf', 'test', 'exec', 'at:string']);
const ELEMENT_METHODS = new Set(['find', 'findLast', 'at', 'get']);
const CONTENT_METHODS = new Set(['filter', 'slice', 'toSorted', 'toReversed', 'values', 'keys', 'concat', 'flat', 'toSpliced', 'with']);
const CALLBACK_FRESH = new Set(['some', 'every', 'findIndex', 'findLastIndex', 'forEach']);
const DATE_SETTERS = /^set(UTC)?(FullYear|Month|Date|Hours|Minutes|Seconds|Milliseconds|Time)$/;
const GLOBAL_PRIM = /^(String|Number|Boolean|parseInt|parseFloat|isNaN|isFinite|encodeURIComponent|decodeURIComponent|encodeURI|decodeURI|structuredClone)$/;

/** the pieces of member `prop` of a value with pieces `v` (expr.ts `memberPieces`) */
const member = (v: V, prop: string): V => v.flatMap((p) => (!p.sub.length ? [{ sub: [], src: [...p.src, prop] }]
  : p.sub[0] === '**' ? [p] : p.sub[0] === '*' || prop === '*' || p.sub[0] === prop ? [{ sub: p.sub.slice(1), src: p.src }] : []));
const element = (v: V): V => member(v, '*');
const contents = (v: V): V => v.map((p) => (p.sub.length ? p : { sub: ['*'], src: [...p.src, '*'] }));
const at = (sub: string[], v: V): V => v.map((p) => ({ sub: [...sub, ...p.sub], src: p.src }));
/**
 * What iterating a value gives (a spread into an array, `for…of`, `Array.from`, array destructuring): its elements, or,
 * for a `Map`, pairs of its keys and values. Which one the build does not know of a parameter, so both.
 */
const iterated = (v: V): V => { const e = element(v); return [...e, ...at(['*'], e)]; };
/** `entries()`: pairs of an index or key and an element */
const entries = (v: V): V => at(['*', '*'], element(v));
const union = (...vs: V[]): V => { const out: V = [], seen = new Set<string>(); for (const v of vs) for (const p of v) { const k = p.sub.join('.') + '<' + p.src.join('.'); if (!seen.has(k)) { seen.add(k); out.push(p); } } return out; };
/** the value itself may be one of the arguments' objects (as opposed to a fresh one holding some): a write into it is a write into a parameter's */
const isArgument = (v: V) => v.some((p) => !p.sub.length);

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
    try { out = { flows: analyze(fn, m) }; } catch (e) { out = { why: e instanceof Unproven ? e.message : `the build could not read it: ${(e as Error).message}` }; } finally { active.delete(fn); }
    done.set(fn, out);
    return out;
  };

  /** the summary of a function a name stands for in module `m` (a local function or an import from the modules the build reads) */
  const callee = (name: string, m: ModuleInfo): { fn: N; m: ModuleInfo } | null => {
    const f = m.fns.get(name);
    if (f) return { fn: f, m };
    const imp = m.imports.get(name);
    if (!imp) return null;
    const r = exported(imp.from, imp.name, root);
    const g = r?.m.fns.get(r.local);
    return g ? { fn: g, m: r!.m } : null;
  };

  /** a function's scope: its locals (what each may hold) and local arrow functions; reads and writes go up to the enclosing ones */
  interface Scope { vars: Map<string, V>; fns: Map<string, N>; up: Scope | null }
  const lookup = (sc: Scope | null, name: string): Scope | null => { for (let x = sc; x; x = x.up) if (x.vars.has(name) || x.fns.has(name)) return x; return null; };

  function analyze(fn: N, m: ModuleInfo, given?: V[], up: Scope | null = null): V {
    const where = (n: N) => { const { line, col } = lineCol(m.text, n.start); return `${m.file.startsWith(root) ? m.file.slice(root.length + 1) : m.file}:${line}:${col}`; };
    const no = (what: string, n: N): never => { throw new Unproven(`${what} (${where(n)})`); };
    if (fn.async || fn.generator) no(fn.async ? 'it is async' : 'it is a generator', fn);
    const scope: Scope = { vars: new Map(), fns: new Map(), up };
    /** the innermost block's scope: a `for` loop's or a block's declarations are its own */
    let cur: Scope = scope;
    const inBlock = (f: () => void) => { const prev = cur; cur = { vars: new Map(), fns: new Map(), up: prev }; try { f(); } finally { cur = prev; } };
    const env = {
      has: (k: string) => !!lookup(cur, k)?.vars.has(k),
      get: (k: string) => lookup(cur, k)?.vars.get(k),
      set: (k: string, v: V) => { const x = lookup(cur, k); (x && x.vars.has(k) ? x : cur).vars.set(k, v); },
      declare: (k: string, v: V) => { cur.vars.set(k, union(cur.vars.get(k) ?? [], v)); },
    };
    const assign = (name: string, v: V, n: N) => {
      if (!env.has(name)) { if (m.lets.has(name) || m.consts.has(name)) no(`a write to the module's \`${name}\``, n); no(`a write to \`${name}\`, which it does not declare`, n); }
      env.set(name, union(env.get(name)!, v));
    };
    const bind = (id: N, v: V) => {
      if (id.type === 'Identifier') env.declare(id.name, v);
      else if (id.type === 'ArrayPattern') id.elements.forEach((e: N | null) => e && bind(e.type === 'RestElement' ? e.argument : e, e.type === 'RestElement' ? at(['*'], iterated(v)) : iterated(v)));
      else if (id.type === 'ObjectPattern') for (const p of id.properties) {
        if (p.type === 'RestElement') bind(p.argument, contents(v));
        else bind(p.value.type === 'AssignmentPattern' ? p.value.left : p.value, p.computed ? member(v, '*') : member(v, p.key.name ?? String(p.key.value)));
      }
      else if (id.type === 'AssignmentPattern') { bind(id.left, union(v, value(id.right))); }
      else no('a binding the build does not read', id);
    };
    /**
     * `v` stored into the object `target` (an expression) holds: recorded on the local it is reached from, through its
     * member chain (`out.push(x)`, `next.date = d`, `next.a.b = x`); stored into anything else, unproven
     */
    const storeInto = (target: N, v: V, n: N) => {
      const path: string[] = [];
      let t = target;
      for (;;) {
        if (t.type === 'MemberExpression') { path.unshift(t.computed ? '*' : t.property.name); t = t.object; }
        else if (t.type === 'TSNonNullExpression' || t.type === 'ParenthesizedExpression') t = t.expression;
        // an element a local's method returns (`groups.get(k).push(x)`): inside one of its elements
        else if (t.type === 'CallExpression' && t.callee.type === 'MemberExpression' && !t.callee.computed && ELEMENT_METHODS.has(t.callee.property.name)) { path.unshift('*'); t = t.callee.object; }
        else break;
      }
      if (t.type !== 'Identifier' || !env.has(t.name)) no('a write into an object the build cannot follow', n);
      assign(t.name, at(path, v), n);
    };
    /** a write into the value of `target`: allowed into what the function made, never into an argument's object */
    const writeInto = (target: V, n: N) => { if (isArgument(target)) no('a write into an object of a parameter', n); };
    const callback = (f: N | undefined, args: V[], n: N): V => {
      // a built-in that makes a primitive of its argument (`.map(Number)`)
      if (f?.type === 'Identifier' && GLOBAL_PRIM.test(f.name) && !lookup(cur, f.name) && !m.fns.has(f.name) && !m.imports.has(f.name)) return [];
      // a function of the modules (`.map(messageKey)`): its summary, given the arguments
      if (f?.type === 'Identifier' && !lookup(cur, f.name)) {
        const g = callee(f.name, m);
        if (!g) no(`a callback \`${f.name}\`, which the build cannot read`, f);
        return apply(f.name, g!, args, n);
      }
      if (!f || f.type !== 'ArrowFunctionExpression') no('a callback that is not an arrow function', f ?? n);
      return analyze(f!, m, args, cur);
    };
    /** a call of a function of the modules: its summary, with these arguments' values */
    const apply = (name: string, g: { fn: N; m: ModuleInfo }, a: V[], n: N): V => {
      const s = summarize(g.fn, g.m);
      if ('why' in s) no(`a call of \`${name}\`, which has no summary: ${s.why}`, n);
      return union(...(s as { flows: FlowPiece[] }).flows.map((p) => at(p.sub, p.src.slice(1).reduce((v: V, seg) => (seg === '**' ? v.map((x) => ({ sub: ['**'], src: x.src })) : member(v, seg)), a[+p.src[0]!] ?? []))));
    };
    const call = (n: N): V => {
      const c = n.callee.type === 'ChainExpression' ? n.callee.expression : n.callee;
      if (n.arguments.some((a: N) => a.type === 'SpreadElement')) no('a call with a spread argument', n);
      const args = () => n.arguments.map((a: N) => (a.type === 'ArrowFunctionExpression' ? [] : value(a)));
      if (c.type === 'Identifier') {
        const local = lookup(cur, c.name);
        if (local?.fns.has(c.name)) return analyze(local.fns.get(c.name)!, m, args(), local);
        if (env.has(c.name)) no(`a call of \`${c.name}\`, a value`, n);
        if (GLOBAL_PRIM.test(c.name) && !m.fns.has(c.name) && !m.imports.has(c.name)) { args(); return []; }
        const g = callee(c.name, m);
        if (!g) no(`a call of \`${c.name}\`, which the build cannot read`, n);
        return apply(c.name, g!, args(), n);
      }
      if (c.type !== 'MemberExpression') no('a call of a computed value', n);
      const method = !c.computed && c.property.type === 'Identifier' ? c.property.name : null;
      if (!method) no('a call of a method named by a value', n);
      if (c.object.type === 'Identifier' && m.messages.has(c.object.name) && !lookup(cur, c.object.name)) { args(); return []; }
      if (c.object.type === 'Identifier' && !env.has(c.object.name) && !m.consts.has(c.object.name) && !m.fns.has(c.object.name) && !m.imports.has(c.object.name)) {
        const o = c.object.name;
        if (o === 'Math' || o === 'Number' || (o === 'JSON' && (method === 'parse' || method === 'stringify')) || (o === 'Date' && method === 'now') || (o === 'Object' && method === 'keys') || (o === 'Array' && method === 'isArray')) { args(); return []; }
        if (o === 'Object' && method === 'values') return contents(value(n.arguments[0]));
        if (o === 'Object' && method === 'entries') return entries(value(n.arguments[0]));
        if (o === 'Array' && method === 'from') return n.arguments[1] ? at(['*'], callback(n.arguments[1], [iterated(value(n.arguments[0])), []], n)) : at(['*'], iterated(value(n.arguments[0])));
        if (o === 'Array' && method === 'of') return union(...args().map((v: V) => at(['*'], v)));
        if (o === 'Object' && method === 'assign') {
          const [t, ...rest] = args();
          writeInto(t!, n);
          return union(t!, ...rest.map(contents));
        }
        no(`a call of \`${o}.${method}()\``, n);
      }
      const recv = value(c.object);
      if (method === 'map' || method === 'flatMap') {
        const r = callback(n.arguments[0], [element(recv), [], recv], n);
        return method === 'map' ? at(['*'], r) : union(at(['*'], r), r);
      }
      if (CALLBACK_FRESH.has(method!) || ELEMENT_METHODS.has(method!) || CONTENT_METHODS.has(method!) || method === 'reduce' || method === 'sort') {
        // a predicate or comparator: it must be understood (it runs), what it returns does not reach the result
        if (n.arguments[0]?.type === 'ArrowFunctionExpression') callback(n.arguments[0], [element(recv), element(recv), recv], n);
      }
      if (method === 'reduce') {
        // the accumulator: its start and whatever the callback returns, until nothing grows
        if (n.arguments.length < 2) no('`reduce()` without a start value', n);
        let acc = value(n.arguments[1]);
        for (let i = 0; ; i++) {
          if (i > 6) no('a `reduce()` whose value the build cannot settle', n);
          const next = union(acc, callback(n.arguments[0], [acc, element(recv), [], recv], n));
          if (next.length === acc.length) return acc;
          acc = next;
        }
      }
      if (FRESH_METHODS.has(method!) || CALLBACK_FRESH.has(method!)) { args(); return []; }
      if (ELEMENT_METHODS.has(method!)) { args(); return element(recv); }
      if (method === 'entries') return entries(recv);
      if (CONTENT_METHODS.has(method!)) return union(contents(recv), ...args().map((v: V) => (method === 'concat' ? union(contents(v), at(['*'], v)) : method === 'with' ? at(['*'], v) : [])));
      if (method === 'sort' || method === 'reverse' || method === 'push' || method === 'unshift' || method === 'splice' || method === 'pop' || method === 'shift' || method === 'add' || method === 'set' || method === 'delete' || method === 'clear' || DATE_SETTERS.test(method!)) {
        writeInto(recv, n);
        const a = args();
        // what it stores becomes the local's: its elements (`push`, `add`, `splice`'s items) or its values (`set`)
        const stored = method === 'push' || method === 'unshift' || method === 'add' || method === 'set' ? a : method === 'splice' ? a.slice(2) : [];
        if (stored.some((v: V) => v.length)) storeInto(c.object, at(['*'], union(...stored)), n);
        return method === 'sort' || method === 'reverse' ? recv : method === 'pop' || method === 'shift' ? element(recv) : method === 'splice' ? contents(recv) : [];
      }
      return no(`a call of the method \`${method}()\`, which the build does not know`, n);
    };
    const value = (e: N | null | undefined): V => {
      if (!e) return [];
      switch (e.type) {
        case 'Literal': return [];
        case 'TemplateLiteral': e.expressions.forEach(value); return [];
        case 'BinaryExpression': value(e.left); value(e.right); return [];
        case 'UnaryExpression': if (e.operator === 'delete') no('`delete`', e); value(e.argument); return [];
        case 'UpdateExpression': if (e.argument.type === 'Identifier') { assign(e.argument.name, [], e); return []; } writeInto(value(e.argument.object), e); return [];
        case 'ParenthesizedExpression': case 'TSAsExpression': case 'TSNonNullExpression': case 'TSSatisfiesExpression': case 'TSTypeAssertion': case 'ChainExpression': return value(e.expression);
        case 'ConditionalExpression': value(e.test); return union(value(e.consequent), value(e.alternate));
        case 'LogicalExpression': return union(value(e.left), value(e.right));
        case 'SequenceExpression': return e.expressions.map(value).at(-1);
        case 'Identifier': {
          if (env.has(e.name)) return env.get(e.name)!;
          if (lookup(cur, e.name)?.fns.has(e.name)) no(lookup(cur, e.name)!.fns.get(e.name)!.type === 'Caught' ? `\`${e.name}\`, a caught value` : `the local function \`${e.name}\` used as a value`, e);
          if (/^(undefined|NaN|Infinity)$/.test(e.name)) return [];
          if (e.name === 'arguments' || e.name === 'eval') no(`\`${e.name}\``, e);
          const k = m.consts.get(e.name);
          if (k) return moduleConst(e.name, k);
          return no(`\`${e.name}\`, which the build cannot follow`, e);
        }
        case 'ThisExpression': return no('`this`', e);
        case 'MemberExpression': {
          const prop = !e.computed && e.property.type === 'Identifier' ? e.property.name : e.computed && e.property.type === 'Literal' ? String(e.property.value) : '*';
          if (e.computed) value(e.property);
          if (prop === 'length') { value(e.object); return []; }
          return member(value(e.object), prop);
        }
        case 'ObjectExpression': return union(...e.properties.map((p: N): V => {
          if (p.type === 'SpreadElement') return contents(value(p.argument));
          if (p.kind !== 'init' || p.method) no('a method or an accessor in an object', p);
          if (p.computed) value(p.key);
          return at([p.computed ? '*' : p.key.name ?? String(p.key.value)], value(p.value));
        }));
        case 'ArrayExpression': return union(...e.elements.map((x: N | null): V => (!x ? [] : x.type === 'SpreadElement' ? at(['*'], iterated(value(x.argument))) : at(['*'], value(x)))));
        case 'CallExpression': return call(e);
        case 'NewExpression': {
          const c = e.callee.type === 'Identifier' ? e.callee.name : '';
          const a = e.arguments.map((x: N) => value(x));
          if (/^(Date|URL|URLSearchParams|RegExp|Error|TypeError|RangeError)$/.test(c)) return [];
          // a Set holds the items it is given; a Map, the keys and values of the pairs it is given
          if (/^(Set|WeakSet)$/.test(c) && !env.has(c)) return at(['*'], iterated(a[0] ?? []));
          if (/^(Map|WeakMap)$/.test(c) && !env.has(c)) return at(['*'], element(iterated(a[0] ?? [])));
          return no(`\`new ${c || '…'}()\``, e);
        }
        case 'AssignmentExpression': {
          const v = value(e.right);
          if (e.left.type === 'Identifier') { assign(e.left.name, e.operator === '=' || /^(\|\||&&|\?\?)=$/.test(e.operator) ? v : [], e); return v; }
          if (e.left.type === 'MemberExpression') {
            const target = value(e.left.object);
            writeInto(target, e);
            // the local object now holds what was written, at that member
            if (v.length) storeInto(e.left.object, at([e.left.computed ? '*' : e.left.property.name], v), e);
            return v;
          }
          return no('a destructuring assignment', e);
        }
        case 'ArrowFunctionExpression': case 'FunctionExpression': return no('a function that leaves the helper', e);
        case 'AwaitExpression': case 'YieldExpression': return no(`\`${e.type === 'AwaitExpression' ? 'await' : 'yield'}\``, e);
        default: return no(`a construct the build does not read (${e.type})`, e);
      }
    };
    const constCache = new Map<string, V>();
    const moduleConst = (name: string, init: N): V => {
      if (constCache.has(name)) return constCache.get(name)!;
      constCache.set(name, []);
      // a module constant: its value as an expression of nothing (no parameters); what it holds is no argument's
      const v = value(init);
      if (v.length) no(`the module's \`${name}\``, init);
      constCache.set(name, v);
      return v;
    };
    let result: V = [];
    const stmt = (s: N) => {
      switch (s.type) {
        case 'BlockStatement': inBlock(() => s.body.forEach(stmt)); return;
        case 'ExpressionStatement': value(s.expression); return;
        case 'VariableDeclaration': for (const d of s.declarations) {
          // a local arrow function: analyzed where it is called, with what it is given
          if (s.kind === 'const' && d.id.type === 'Identifier' && d.init?.type === 'ArrowFunctionExpression') { cur.fns.set(d.id.name, d.init); continue; }
          bind(d.id, d.init ? value(d.init) : []);
        } return;
        case 'ReturnStatement': result = union(result, value(s.argument)); return;
        case 'IfStatement': value(s.test); stmt(s.consequent); if (s.alternate) stmt(s.alternate); return;
        case 'ThrowStatement': value(s.argument); return;
        case 'TryStatement': {
          stmt(s.block);
          // what was thrown may be anything a callee threw: the caught value cannot be read
          if (s.handler) inBlock(() => { if (s.handler.param) cur.fns.set(s.handler.param.name ?? '', { type: 'Caught', start: s.handler.start, end: s.handler.end }); stmt(s.handler.body); });
          if (s.finalizer) stmt(s.finalizer);
          return;
        }
        case 'ForOfStatement': {
          const it = value(s.right), d = s.left.type === 'VariableDeclaration' ? s.left.declarations[0].id : s.left;
          if (d.type === 'Identifier' && !s.left.declarations && !env.has(d.name)) no('a loop over a name it does not declare', s);
          // (a loop over a variable declared outside it assigns that variable)
          if (!s.left.declarations) { if (d.type !== 'Identifier') no('a loop that destructures into names it does not declare', s); assign(d.name, iterated(it), s); }
          inBlock(() => { if (s.left.declarations) bind(d, iterated(it)); stmt(s.body); });
          return;
        }
        case 'ForStatement': inBlock(() => { if (s.init) (s.init.type === 'VariableDeclaration' ? stmt(s.init) : value(s.init)); value(s.test); value(s.update); stmt(s.body); }); return;
        case 'WhileStatement': case 'DoWhileStatement': value(s.test); stmt(s.body); return;
        case 'BreakStatement': case 'ContinueStatement': case 'EmptyStatement': return;
        case 'TSTypeAliasDeclaration': case 'TSInterfaceDeclaration': return;
        default: no(`a statement the build does not read (${s.type})`, s);
      }
    };
    // (locals hold whatever is ever assigned to them: twice over the body, so a value assigned below reaches a read above)
    const params = fn.params as N[];
    params.forEach((p, i) => {
      const id = p.type === 'AssignmentPattern' ? p.left : p.type === 'TSParameterProperty' ? p.parameter : p;
      if (id.type === 'RestElement') no('a rest parameter', p);
      const own: V = given ? given[i] ?? [] : [{ sub: [], src: [String(i)] }];
      bind(id, p.type === 'AssignmentPattern' ? union(own, value(p.right)) : own);
    });
    // (until nothing grows: a value assigned below reaches a read above, through chains of locals)
    let size = -1;
    for (let pass = 0; ; pass++) {
      if (pass > 8) no('locals whose values the build cannot settle', fn);
      result = [];
      if (fn.body.type === 'BlockStatement') fn.body.body.forEach(stmt); else result = value(fn.body);
      const now = result.length + [...scope.vars.values()].reduce((a, v) => a + v.length, 0);
      if (now === size) break;
      size = now;
    }
    return result;
  }

  return (name: string): Flow => {
    const r = exported(helpersFile, name, root);
    if (!r) return { why: 'the build cannot find its declaration' };
    const fn = r.m.fns.get(r.local);
    if (!fn) return { why: 'it is not a function declaration or a `const` arrow function' };
    return summarize(fn, r.m);
  };
}
