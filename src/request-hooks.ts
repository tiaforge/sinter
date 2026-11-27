// Whether an app's config module may change the requests the page sends (`configure({ request })`), decided from its
// syntax tree: a request the early file sent before any middleware ran is only the same request when every middleware
// passes it on unchanged. When the build cannot see that, the answer is yes (project.ts `changesRequests`).
import { readFileSync } from 'node:fs';
import { parseModule } from './compiler/index.js';
import { appModule } from './fold-check.js';
import { functionFacts, reassigned, type PassOn } from './helper-writes.js';

type N = { type: string; start: number; end: number; [k: string]: any };
interface Mod { file: string; code: string; ast: N; imports: Map<string, { spec: string; name: string }>; top: Map<string, N> }

const SINTER = /^@tiaforge-ui\/sinter(\/.*)?$/;
/** functions of no module that never change their arguments: a request (or a part of it) may be passed to them */
const PURE_CALLS = new Set(['String', 'Number', 'Boolean', 'JSON.stringify', 'console.log', 'console.warn', 'console.error', 'console.info', 'console.debug', 'encodeURIComponent', 'decodeURIComponent']);
const PURE_NEW = new Set(['URL', 'URLSearchParams', 'Headers', 'Request', 'Response', 'Error']);
const SKIP = new Set(['type', 'start', 'end', 'loc', 'range', 'typeAnnotation', 'returnType', 'typeParameters', 'typeArguments']);
const fnLike = (n: N | null | undefined): boolean => !!n && (n.type === 'FunctionDeclaration' || n.type === 'FunctionExpression' || n.type === 'ArrowFunctionExpression');
const bare = (n: N): N => (n.type === 'TSNonNullExpression' || n.type === 'TSAsExpression' || n.type === 'TSSatisfiesExpression' || n.type === 'TSTypeAssertion' || n.type === 'ParenthesizedExpression' ? bare(n.expression) : n);
const keyName = (k: N | null | undefined) => (k?.type === 'Identifier' ? k.name : k?.type === 'Literal' ? String(k.value) : null);
const children = (n: N): N[] => Object.keys(n).filter((k) => !SKIP.has(k)).flatMap((k) => { const v = n[k]; return Array.isArray(v) ? v.filter((c) => c && typeof c.type === 'string') : v && typeof v.type === 'string' ? [v] : []; });
function walk(n: N, f: (n: N, parents: N[]) => boolean | void, parents: N[] = []): void {
  if (f(n, parents) === false) return;
  parents.push(n);
  for (const c of children(n)) walk(c, f, parents);
  parents.pop();
}
/** a dotted name of a callee: `header`, `console.log`; null for anything else */
const dotted = (n: N): string | null => { const b = bare(n); if (b.type === 'Identifier') return b.name; if (b.type === 'MemberExpression' && !b.computed) { const o = dotted(b.object); return o && `${o}.${b.property.name}`; } return null; };

function readMod(file: string, code: string): Mod | null {
  let ast: N;
  try { ast = parseModule(code, file) as unknown as N; } catch { return null; }
  const imports = new Map<string, { spec: string; name: string }>(), top = new Map<string, N>();
  for (const st0 of ast.body as N[]) {
    if (st0.type === 'ImportDeclaration') {
      if (st0.importKind === 'type') continue;
      for (const s of st0.specifiers as N[]) imports.set(s.local.name, { spec: String(st0.source.value), name: s.type === 'ImportSpecifier' ? keyName(s.imported)! : s.type === 'ImportDefaultSpecifier' ? 'default' : '*' });
      continue;
    }
    const st = st0.type === 'ExportNamedDeclaration' && st0.declaration ? st0.declaration : st0;
    if (st.type === 'FunctionDeclaration' && st.id) top.set(st.id.name, st);
    if (st.type === 'VariableDeclaration') for (const d of st.declarations as N[]) if (d.id.type === 'Identifier' && d.init) top.set(d.id.name, st.kind === 'const' ? d.init : { type: 'Unknown', start: d.start, end: d.end });
  }
  return { file, code, ast, imports, top };
}

/** a name's top-level value is reassigned anywhere in the module (a `let` or `var`, or a function declaration written over) */
const assignedAnywhere = (m: Mod, name: string) => reassigned(m.ast).has(name);

/**
 * Whether the config module may change requests. Errs toward yes. No: no `request` and no `header(` in it at all, or
 * every `request` is the `request` list of a `configure({ … })` call of sinter's whose entries each only read the
 * response: a call of sinter's `onUnauthorized(…)`, or a middleware the build can read (written inline, a function or
 * `const` of the module, or an export of an app module it imports) that passes the request it was given, untouched, to
 * `next`, at the start of its body. `read` reads an imported app module; `root` resolves the app's import paths.
 */
export function changesRequests(source: string, file = '/sinter.config.ts', root = '/', read: (file: string) => string = (f) => readFileSync(f, 'utf8')): boolean {
  const text = source.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
  if (!/\brequest\s*[:,}]/.test(text)) return /\bheader\s*\(/.test(text);
  if (/\bheader\s*\(/.test(text)) return true;
  const m = readMod(file, source);
  if (!m) return true;
  const fromSinter = (local: string, name: string) => { const i = m.imports.get(local); return !!i && i.name === name && SINTER.test(i.spec); };
  // every `request` the tree has: a key of the object literal given to configure(), nothing else
  let other = false;
  const lists: N[] = [];
  walk(m.ast, (n, parents) => {
    if (n.type === 'Identifier' && n.name === 'request') {
      const p = parents[parents.length - 1];
      // a function's parameter or a local named `request` is no option (the old check counted it)
      if (p && (fnLike(p) && (p.params as N[]).includes(n))) return;
      // `const request = [...]` at the top (read where configure() names it), and the value of `{ request }`
      if (p?.type === 'VariableDeclarator' && p.id === n && (m.ast.body as N[]).some((s) => s.declarations?.includes(p) || s.declaration?.declarations?.includes(p))) return;
      if (p?.type === 'Property' && p.shorthand && p.value === n) return;
      if (p?.type === 'Property' && p.key === n && !p.computed) {
        const obj = parents[parents.length - 2], call = parents[parents.length - 3];
        const ok = obj?.type === 'ObjectExpression' && call?.type === 'CallExpression' && call.arguments[0] === obj
          && bare(call.callee).type === 'Identifier' && fromSinter(bare(call.callee).name, 'configure');
        if (ok) { lists.push(p.value); return; }
      }
      other = true;
    }
  });
  if (other) return true;
  return !lists.every((v) => {
    let list = bare(v);
    // `const request = [...]; configure({ request })`: a module `const` it can read
    if (list.type === 'Identifier') { const d = m.top.get(list.name); list = d && !assignedAnywhere(m, list.name) ? bare(d) : list; }
    return list.type === 'ArrayExpression' && (list.elements as Array<N | null>).every((e) => !!e && responseOnly(m, e, root, read, fromSinter));
  });
}

/** an entry of the `request` list that only reads the response */
function responseOnly(m: Mod, e: N, root: string, read: (file: string) => string, fromSinter: (local: string, name: string) => boolean): boolean {
  const x = bare(e);
  if (x.type === 'CallExpression') {
    const c = bare(x.callee);
    // sinter's onUnauthorized: `next(req)` first, then the handler sees the response (runtime/config.ts)
    return c.type === 'Identifier' && fromSinter(c.name, 'onUnauthorized');
  }
  if (fnLike(x)) return passesRequest(m, x, root, read, new Set());
  if (x.type === 'Identifier') {
    const f = target(m, x.name, root, read);
    return !!f && passesRequest(f.mod, f.fn, root, read, new Set());
  }
  return false;
}

/** a function a name of `m` stands for: a function of the module, or an export of an app module it imports */
function target(m: Mod, name: string, root: string, read: (file: string) => string, depth = 0): { mod: Mod; fn: N } | null {
  if (depth > 20) return null;
  const local = m.top.get(name);
  if (local) return fnLike(bare(local)) && !assignedAnywhere(m, name) ? { mod: m, fn: bare(local) } : null;
  const i = m.imports.get(name);
  if (!i || i.name === '*' || i.name === 'default') return null;
  const file = appModule(i.spec, m.file, root);
  if (!file || /[\\/]node_modules[\\/]/.test(file)) return null;
  let code: string;
  try { code = read(file); } catch { return null; }
  const other = readMod(file, code);
  if (!other) return null;
  // `export function f`, `export const f = …`, or `export { g as f }` of a local
  let local2: string | null = null;
  for (const st of other.ast.body as N[]) {
    if (st.type !== 'ExportNamedDeclaration') continue;
    const d = st.declaration;
    if (d?.type === 'FunctionDeclaration' && d.id?.name === i.name) local2 = i.name;
    if (d?.type === 'VariableDeclaration' && d.kind === 'const' && (d.declarations as N[]).some((v) => v.id.name === i.name)) local2 = i.name;
    if (!d && !st.source) for (const s of st.specifiers as N[]) if (keyName(s.exported) === i.name) local2 = keyName(s.local);
  }
  return local2 ? target(other, local2, root, read, depth + 1) : null;
}

/**
 * A middleware `(req, next) => …` that passes `req` itself to `next`: every call of `next` has `req` as its only
 * argument, `next` is used for nothing else, `req` is never reassigned nor written into (helper-writes.ts, through the
 * functions it is passed to), and the first `next(req)` is in the body's top-level statements, outside any branch,
 * loop, `try` or nested function, with no `return` or `throw` before it: a middleware that can answer or refuse
 * before it calls `next` (a veto) does not count, nor one that may call it twice.
 */
function passesRequest(m: Mod, fn: N, root: string, read: (file: string) => string, seen: Set<N>): boolean {
  const [p0, p1] = fn.params as N[];
  if (!p0 || !p1 || bare(p0).type !== 'Identifier' || bare(p1).type !== 'Identifier' || fn.generator) return false;
  const req = bare(p0).name as string, next = bare(p1).name as string;
  const again = reassigned(fn.body);
  if (again.has(req) || again.has(next)) return false;
  // every use of `next` is a call `next(req)`; a nested function that declares either name again is not read
  let ok = true, calls = 0;
  walk(fn.body, (n, parents) => {
    if (!ok) return false;
    if (fnLike(n) && (n.params as N[]).some((q) => { const b = bare(q); return b.type === 'Identifier' && (b.name === req || b.name === next); })) { ok = false; return false; }
    if (n.type === 'Identifier' && n.name === next) {
      const p = parents[parents.length - 1];
      if (p?.type !== 'CallExpression' || p.callee !== n || p.arguments.length !== 1 || bare(p.arguments[0]).type !== 'Identifier' || bare(p.arguments[0]).name !== req) ok = false;
      else calls++;
    }
  });
  if (!ok || !calls) return false;
  // `req` written into, here or in a function it is passed to
  if (!seen.has(fn)) seen.add(fn);
  if (writes(m, fn, 0, root, read, new Set())) return false;
  // a request (or a part of it) given to anything the build cannot read
  let unread = false;
  walk(fn.body, (n) => {
    if (unread) return false;
    if (n.type !== 'CallExpression' && n.type !== 'NewExpression') return;
    const name = dotted(n.callee);
    if (name === next) return;
    const passes = (n.arguments as N[]).some((a) => rootsAt(a, req));
    if (!passes) return;
    if (n.type === 'NewExpression' ? !!name && PURE_NEW.has(name) : !!name && (PURE_CALLS.has(name) || m.top.has(name) || m.imports.has(name))) return;
    unread = true;
  });
  if (unread) return false;
  // the first `next(req)`: a top-level statement of the body, reached with no branch, and nothing returns or throws first
  if (fn.body.type !== 'BlockStatement') return direct(fn.body, next);
  for (const st of fn.body.body as N[]) {
    const has = contains(st, (n) => n.type === 'CallExpression' && bare(n.callee).type === 'Identifier' && bare(n.callee).name === next);
    if (has) return direct(st, next);
    if (contains(st, (n) => n.type === 'ReturnStatement' || n.type === 'ThrowStatement')) return false;
  }
  return false;
}

/** whether an expression is `req` or a member chain of it */
function rootsAt(a: N, req: string): boolean {
  let x = bare(a);
  if (x.type === 'SpreadElement') x = bare(x.argument);
  while (x.type === 'MemberExpression' || x.type === 'ChainExpression') x = bare(x.type === 'ChainExpression' ? x.expression : x.object);
  return x.type === 'Identifier' && x.name === req;
}

/** a node's subtree has a match, not looking into nested functions */
function contains(n: N, f: (n: N) => boolean): boolean {
  let hit = false;
  walk(n, (c) => { if (hit) return false; if (c !== n && fnLike(c)) return false; if (f(c)) { hit = true; return false; } });
  return hit;
}

/** `next(req)` reached from a statement (or an arrow's body) only through `return`, `await`, a declaration, `.then(…)` chains */
function direct(st: N, next: string): boolean {
  const isNext = (n: N) => n.type === 'CallExpression' && bare(n.callee).type === 'Identifier' && bare(n.callee).name === next;
  const down = (n: N | null | undefined): boolean => {
    if (!n) return false;
    const x = bare(n);
    if (isNext(x)) return true;
    switch (x.type) {
      case 'ExpressionStatement': return down(x.expression);
      case 'ReturnStatement': return down(x.argument);
      case 'AwaitExpression': return down(x.argument);
      case 'VariableDeclaration': return x.declarations.length === 1 && down(x.declarations[0].init);
      // `next(req).then(…)`: the call is the receiver
      case 'CallExpression': return bare(x.callee).type === 'MemberExpression' && down(bare(x.callee).object);
      case 'MemberExpression': return down(x.object);
      default: return false;
    }
  };
  return down(st);
}

/** whether a function writes into its parameter `i`, directly or through the functions of the app it passes it to */
function writes(m: Mod, fn: N, i: number, root: string, read: (file: string) => string, seen: Set<N>): boolean {
  if (seen.has(fn)) return false;
  seen.add(fn);
  const facts = functionFacts(fn as never, m.ast as never, m.code);
  if (facts.direct[i]) return true;
  return facts.passes.filter((p: PassOn) => p.param === i).some((p) => {
    const name = 'local' in p.to ? p.to.local : null;
    const t = name ? target(m, name, root, read) : (() => {
      // an import: the local name that stands for it
      const local = [...m.imports].find(([, v]) => 'spec' in p.to && v.spec === p.to.spec && v.name === p.to.name)?.[0];
      return local ? target(m, local, root, read) : null;
    })();
    // a function the build cannot read may write it
    return !t || writes(t.mod, t.fn, p.arg, root, read, seen);
  });
}
