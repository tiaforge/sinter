// What may fold (docs/spec.md, Helpers at build time): a helper call over build-time constants runs
// in the compiler only when the code it can reach uses nothing but the globals ECMAScript defines.
// This is the static check, per exported function: the functions it calls and the modules it imports
// are followed (into packages, resolved with production conditions, the same in dev and in the
// build), and a module's top-level code counts for every function in it. The answer is a verdict per
// helper (may fold, or why not, with where); nothing here runs the code. Per-module analyses are
// cached by file and content, so the language server does not redo them on every keystroke.
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { parseModule } from './compiler/index.js';
import { lineCol } from './line-col.js';
import type { HelperManifest } from './compiler/compile.js';

/** May fold, or why not: the name or member, the file and position where it is reached, and the chain of functions to it. */
export type FoldVerdict = { fold: true } | { fold: false; reason: string; file: string; line: number; col: number; chain: string[] };

/**
 * The globals a helper may use and still fold: ECMAScript's own, deterministic ones, and five web-platform
 * utilities that behave the same in Node and browsers (`TextEncoder`, `TextDecoder`, `URL`, `URLSearchParams`,
 * `structuredClone`; the last three are allowed in expressions too). Not `Date`, `Intl`, `WeakRef`,
 * `FinalizationRegistry`, `eval`, `Function` or `globalThis`, nor anything else a host adds (`window`,
 * `document`, `process`, `fetch`, timers, `console`).
 */
export const FOLD_GLOBALS = new Set([
  'Object', 'Array', 'Math', 'JSON', 'Map', 'Set', 'WeakMap', 'WeakSet', 'RegExp', 'String', 'Number', 'Boolean', 'Symbol', 'BigInt',
  'Error', 'TypeError', 'RangeError', 'SyntaxError', 'ReferenceError', 'EvalError', 'URIError', 'AggregateError',
  'Promise', 'Reflect', 'Proxy', 'ArrayBuffer', 'DataView', 'Int8Array', 'Uint8Array', 'Uint8ClampedArray', 'Int16Array', 'Uint16Array',
  'Int32Array', 'Uint32Array', 'Float32Array', 'Float64Array', 'BigInt64Array', 'BigUint64Array',
  'parseInt', 'parseFloat', 'isNaN', 'isFinite', 'encodeURIComponent', 'decodeURIComponent', 'encodeURI', 'decodeURI',
  'NaN', 'Infinity', 'undefined',
  'TextEncoder', 'TextDecoder', 'URL', 'URLSearchParams', 'structuredClone',
]);
/** members that read the clock, the locale or chance, or write markup, whatever object they are read from */
const BAD_MEMBERS = /^(toLocale\w*|localeCompare|innerHTML|outerHTML|insertAdjacentHTML)$/;
/** production conditions, without `browser`: what the build-time run loads in Node, the same in dev and in the build */
export const FOLD_CONDITIONS = ['production', 'node', 'import', 'module', 'default'];

type N = { type: string; start: number; end: number; [k: string]: any };
/** a reference out of a unit: a function or the top level of this module, or an export of another */
type Edge = { local: string } | { spec: string; name: string | '*' | '<side>' };
interface Unit { name: string; edges: Edge[]; bad: { reason: string; at: number } | null }
interface ModuleInfo {
  file: string; code: string;
  /** by unit name; `<top>` is the module's top-level code */
  units: Map<string, Unit>;
  /** exported name → local unit, re-export (`spec`, `name`), or `*` re-exports */
  exports: Map<string, { local: string } | { spec: string; name: string | '*' }>;
  stars: string[];
  /** a problem reading the module itself */
  broken?: string;
  /** the unit any export stands for (a CSS module's class names) */
  any?: string;
}

/** Per-module analyses, by file, valid while the file's mtime and size are unchanged; and package resolutions. */
export class FoldCache {
  readonly modules = new Map<string, { stamp: string; info: ModuleInfo }>();
  readonly resolved = new Map<string, string | null>();
  /** the app's `resolve.alias` (from its Vite config), applied before a specifier is resolved */
  aliases: Array<{ find: string | RegExp; replacement: string }> = [];
  clear() { this.modules.clear(); this.resolved.clear(); }
  setAliases(a: Array<{ find: string | RegExp; replacement: string }>) {
    if (JSON.stringify(a.map((x) => [String(x.find), x.replacement])) !== JSON.stringify(this.aliases.map((x) => [String(x.find), x.replacement]))) this.resolved.clear();
    this.aliases = a;
  }
}

const stampOf = (f: string) => { const s = statSync(f); return `${s.mtimeMs}:${s.size}`; };

/** A specifier imported from `from`: an app file (relative, `/` from the root), or a package with production conditions. */
export function resolveImport(spec: string, from: string, root: string, cache?: FoldCache): string | null {
  const key = `${spec}\0${dirname(from)}`;
  if (cache?.resolved.has(key)) return cache.resolved.get(key)!;
  const out = resolveUncached(aliased(spec, cache?.aliases ?? []), from, root);
  cache?.resolved.set(key, out);
  return out;
}

type Alias = { find: string | RegExp; replacement: string };
/** each app's `resolve.alias`, by its root: set from its Vite config (the plugin, a load of the helpers module) */
const APP_ALIASES = new Map<string, Alias[]>();
/** The app's `resolve.alias` (Vite's resolved list), for the build's walks of the app's modules (`appModule`). */
export function setAppAliases(root: string, alias: unknown): void {
  if (Array.isArray(alias)) APP_ALIASES.set(resolve(root), alias.filter((a): a is Alias => !!a && typeof a.replacement === 'string'));
}

/**
 * The app's own module a specifier imported from `from` names, as the bundler finds it: relative, root-absolute, or
 * either through the app's alias; resolved as `resolveImport` resolves it (one list of extensions). Null for a package
 * (a bare specifier the alias leaves bare), or a file that is not found.
 */
export function appModule(spec: string, from: string, root: string): string | null {
  const s = aliased(spec, APP_ALIASES.get(resolve(root)) ?? []);
  if (!s.startsWith('.') && !s.startsWith('/') && !/^[A-Za-z]:[\\/]/.test(s)) return null;
  return resolveUncached(s, from, root);
}

/** a specifier with the app's first matching alias applied, as Vite applies them */
function aliased(spec: string, aliases: readonly Alias[]): string {
  for (const a of aliases) {
    if (typeof a.find === 'string') { if (spec === a.find || spec.startsWith(a.find + '/')) return a.replacement + spec.slice(a.find.length); }
    else if (a.find.test(spec)) return spec.replace(a.find, a.replacement);
  }
  return spec;
}

const EXTS = ['', '.ts', '.tsx', '.mts', '.js', '.mjs', '.cjs', '.jsx', '.json', '/index.ts', '/index.js', '/index.mjs'];
const fileFor = (b: string) => {
  for (const q of [b, b.replace(/\.js$/, '.ts'), b.replace(/\.mjs$/, '.mts'), ...EXTS.slice(1).map((e) => b + e)]) {
    try { if (existsSync(q) && statSync(q).isFile()) return q; } catch { /* next */ }
  }
  return null;
};

function resolveUncached(spec: string, from: string, root: string): string | null {
  const bare = spec.replace(/[?#].*$/, '');
  if (bare.startsWith('.')) return fileFor(resolve(dirname(from), bare));
  if (bare.startsWith(root) || (/^[A-Za-z]:[\\/]/.test(bare))) return fileFor(bare);
  if (bare.startsWith('/')) return fileFor(resolve(root, '.' + bare)) ?? fileFor(bare);
  if (bare.startsWith('node:') || /^[a-z]+:/.test(bare)) return null;
  const m = /^((?:@[^/]+\/)?[^/]+)(\/.*)?$/.exec(bare);
  if (!m) return null;
  const [, pkg, sub] = m as unknown as [string, string, string | undefined];
  // a package importing itself by its name (Node's self-reference): through its own `exports`, before node_modules
  const self = selfPackage(from);
  if (self && self.json.name === pkg && self.json.exports != null) {
    const target = exportsTarget(self.json, sub ? '.' + sub : '.');
    return target ? fileFor(join(self.dir, target)) : null;
  }
  for (let dir = dirname(from); ; dir = dirname(dir)) {
    const base = join(dir, 'node_modules', pkg);
    if (existsSync(join(base, 'package.json'))) {
      let json: any;
      try { json = JSON.parse(readFileSync(join(base, 'package.json'), 'utf8')); } catch { return null; }
      const target = exportsTarget(json, sub ? '.' + sub : '.');
      if (target) return fileFor(join(base, target));
      if (sub) return fileFor(join(base, sub));
      return fileFor(join(base, json.module ?? json.main ?? 'index.js'));
    }
    if (dirname(dir) === dir) return null;
  }
}

/** The package a file is in: the nearest package.json above it, read (null when there is none or it does not parse). */
export function selfPackage(from: string): { dir: string; json: any } | null {
  for (let dir = dirname(from); ; dir = dirname(dir)) {
    const f = join(dir, 'package.json');
    if (existsSync(f)) { try { return { dir, json: JSON.parse(readFileSync(f, 'utf8')) }; } catch { return null; } }
    if (dirname(dir) === dir) return null;
  }
}

/** Whether a bare specifier names the package `from` is in, which has `exports` (Node's self-reference). */
export function isSelfReference(spec: string, from: string): boolean {
  const m = /^((?:@[^/]+\/)?[^/]+)(\/.*)?$/.exec(spec.replace(/[?#].*$/, ''));
  const self = m && !spec.startsWith('.') && !spec.startsWith('/') ? selfPackage(from) : null;
  return !!self && self.json.name === m![1] && self.json.exports != null;
}

/** The file a package's `exports` gives a subpath under production conditions; null without `exports`. */
function exportsTarget(json: any, subpath: string): string | null {
  let e = json.exports;
  if (e == null) return null;
  if (typeof e === 'string' || Array.isArray(e) || !Object.keys(e).some((k) => k.startsWith('.'))) e = { '.': e };
  let entry = e[subpath], star = '';
  if (entry === undefined) {
    for (const k of Object.keys(e)) {
      const i = k.indexOf('*');
      if (i >= 0 && subpath.startsWith(k.slice(0, i)) && subpath.endsWith(k.slice(i + 1))) { entry = e[k]; star = subpath.slice(i, subpath.length - (k.length - i - 1)); break; }
    }
  }
  const pick = (v: any): string | null => {
    if (typeof v === 'string') return v.replace('*', star);
    if (Array.isArray(v)) { for (const x of v) { const r = pick(x); if (r) return r; } return null; }
    if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) if (FOLD_CONDITIONS.includes(k)) { const r = pick(x); if (r) return r; }
    return null;
  };
  return entry === undefined ? null : pick(entry);
}

// ---- one module

function analyze(file: string, code: string): ModuleInfo {
  const info: ModuleInfo = { file, code, units: new Map(), exports: new Map(), stars: [] };
  if (/\.json$/i.test(file)) { info.units.set('<top>', { name: '<top>', edges: [], bad: null }); info.exports.set('default', { local: '<top>' }); return info; }
  let ast: N;
  try { ast = parseModule(code, file) as unknown as N; } catch (e) { info.broken = `cannot be parsed: ${(e as Error).message}`; return info; }
  // module-level bindings: imports, and the names of top-level declarations (a function is a unit of its own)
  const imports = new Map<string, { spec: string; name: string | '*' }>();
  const topNames = new Map<string, string>();
  const typeOnly = (n: N) => n.importKind === 'type' || n.exportKind === 'type';
  const fnLike = (n: N | null | undefined) => !!n && (n.type === 'FunctionDeclaration' || n.type === 'FunctionExpression' || n.type === 'ArrowFunctionExpression');
  // `const parse = memo(parseDocument)` (memo.ts): a function of its own, as foldable as what it calls; memo() only wraps it
  const memoOf = (n: N | null | undefined) => !!n && n.type === 'CallExpression' && n.callee.type === 'Identifier'
    && imports.get(n.callee.name)?.name === 'memo' && /(^|\/)sinter\/memo(\.[jt]s)?$|^@tiaforge-ui\/sinter\/memo$/.test(imports.get(n.callee.name)!.spec);
  const unitBodies: Array<{ name: string; node: N }> = [];
  const topRest: N[] = [];
  const declare = (d: N, exported: string | null) => {
    if (d.type === 'FunctionDeclaration' && d.id) { topNames.set(d.id.name, d.id.name); unitBodies.push({ name: d.id.name, node: d }); if (exported) info.exports.set(exported === '*' ? d.id.name : exported, { local: d.id.name }); return; }
    if (d.type === 'VariableDeclaration') {
      for (const v of d.declarations as N[]) {
        if (v.id.type === 'Identifier' && (fnLike(v.init) || memoOf(v.init))) { topNames.set(v.id.name, v.id.name); unitBodies.push({ name: v.id.name, node: v.init }); }
        else { for (const n of patternNames(v.id)) topNames.set(n, '<top>'); topRest.push(v); }
        if (exported) for (const n of patternNames(v.id)) info.exports.set(n, { local: topNames.get(n)! });
      }
      return;
    }
    if (d.type === 'ClassDeclaration' && d.id) { topNames.set(d.id.name, '<top>'); topRest.push(d); if (exported) info.exports.set(d.id.name, { local: '<top>' }); return; }
    if (d.type.startsWith('TS')) return;
    topRest.push(d);
  };
  for (const st of ast.body as N[]) {
    if (typeOnly(st)) continue;
    if (st.type === 'ImportDeclaration') {
      for (const s of st.specifiers as N[]) {
        if (typeOnly(s)) continue;
        imports.set(s.local.name, { spec: String(st.source.value), name: s.type === 'ImportNamespaceSpecifier' ? '*' : s.type === 'ImportDefaultSpecifier' ? 'default' : (s.imported.name ?? String(s.imported.value)) });
      }
      // a side-effect import runs that module's top level
      if (!st.specifiers.length) topRest.push({ type: 'SideEffect', start: st.start, end: st.end, spec: String(st.source.value) });
    } else if (st.type === 'ExportNamedDeclaration') {
      if (st.declaration) declare(st.declaration, '*');
      for (const s of st.specifiers as N[]) {
        if (typeOnly(s)) continue;
        const exported = s.exported.name ?? String(s.exported.value), local = s.local.name ?? String(s.local.value);
        if (st.source) info.exports.set(exported, { spec: String(st.source.value), name: local });
        else info.exports.set(exported, { local });
      }
    } else if (st.type === 'ExportAllDeclaration') {
      if (st.exported) info.exports.set(st.exported.name ?? String(st.exported.value), { spec: String(st.source.value), name: '*' });
      else info.stars.push(String(st.source.value));
    } else if (st.type === 'ExportDefaultDeclaration') {
      const d = st.declaration as N;
      if (fnLike(d)) { const name = d.id?.name ?? 'default'; topNames.set(name, name); unitBodies.push({ name, node: d }); info.exports.set('default', { local: name }); }
      else if (d.type === 'Identifier') info.exports.set('default', { local: d.name });
      else { topRest.push(d); info.exports.set('default', { local: '<top>' }); }
    } else declare(st, null);
  }
  // resolve an export's local names (declared later than the export list): a top-level name's unit, or an import
  for (const [k, v] of info.exports) {
    if (!('local' in v) || v.local === '<top>' || unitBodies.some((u) => u.name === v.local)) continue;
    const imp = imports.get(v.local);
    info.exports.set(k, imp ? { spec: imp.spec, name: imp.name } : { local: topNames.get(v.local) ?? '<top>' });
  }
  const unit = (name: string, nodes: N[], params: N | null) => {
    const u: Unit = { name, edges: [], bad: null };
    const fail = (reason: string, at: number) => { u.bad ??= { reason, at }; };
    const edge = (e: Edge) => { if (!u.edges.some((x) => JSON.stringify(x) === JSON.stringify(e))) u.edges.push(e); };
    const scopes: Array<Set<string>> = [];
    const isLocal = (n: string) => scopes.some((s) => s.has(n));
    const ref = (n: string, at: number) => {
      if (isLocal(n)) return;
      if (topNames.has(n)) { edge({ local: topNames.get(n)! }); return; }
      const imp = imports.get(n);
      if (imp) { edge({ spec: imp.spec, name: imp.name }); return; }
      if (n === 'arguments' && scopes.length) return;
      if (!FOLD_GLOBALS.has(n)) fail(`\`${n}\``, at);
    };
    walkScoped(params ? [params, ...nodes] : nodes, scopes, ref, (m, at) => fail(m, at), (spec, name, at) => {
      const imp = imports.get(spec);
      // `ns.member` on a namespace import: that export only
      if (imp && imp.name === '*' && !isLocal(spec)) { edge({ spec: imp.spec, name }); return true; }
      void at;
      return false;
    }, (spec) => edge({ spec, name: '<side>' }), name === '<top>' ? undefined : (w, at, how) => {
      // a function that assigns the module's own binding (a counter) gives results that depend on the calls before it
      if (!isLocal(w) && topNames.get(w) === '<top>') fail(`${how} the module's \`${w}\``, at);
    });
    return u;
  };
  info.units.set('<top>', unit('<top>', topRest, null));
  for (const b of unitBodies) info.units.set(b.name, unit(b.name, [b.node], null));
  return info;
}

/** names bound by a pattern */
function patternNames(p: N): string[] {
  switch (p?.type) {
    case 'Identifier': return [p.name];
    case 'ObjectPattern': return (p.properties as N[]).flatMap((x) => patternNames(x.type === 'RestElement' ? x.argument : x.value));
    case 'ArrayPattern': return (p.elements as Array<N | null>).flatMap((x) => (x ? patternNames(x) : []));
    case 'RestElement': return patternNames(p.argument);
    case 'AssignmentPattern': return patternNames(p.left);
    case 'TSParameterProperty': return patternNames(p.parameter);
    default: return [];
  }
}

/** keys of a node that hold no value code (types, property names) */
const SKIP = new Set(['type', 'start', 'end', 'loc', 'range', 'typeAnnotation', 'returnType', 'typeParameters', 'typeArguments', 'superTypeParameters', 'implements', 'decorators']);

/**
 * Walks value code with lexical scopes: `ref(name)` for each identifier read that no scope binds, `bad` for what
 * never folds (a member that reads the clock or writes markup, `import.meta.env`, `import()`, `with`), `member`
 * for `ns.x` (true: handled), `side` for a side-effect import.
 */
function walkScoped(nodes: N[], scopes: Array<Set<string>>, ref: (n: string, at: number) => void, bad: (m: string, at: number) => void,
  member: (obj: string, prop: string, at: number) => boolean, side: (spec: string) => void, write?: (name: string, at: number, how: string) => void) {
  /** the `var`s and functions of a function body (not of nested functions) */
  const hoisted = (body: N, into: Set<string>) => {
    const go = (n: N | null | undefined) => {
      if (!n || typeof n.type !== 'string') return;
      if (n.type === 'VariableDeclaration' && n.kind === 'var') for (const d of n.declarations) for (const x of patternNames(d.id)) into.add(x);
      if (n.type === 'FunctionDeclaration') { if (n.id) into.add(n.id.name); return; }
      if (n.type === 'FunctionExpression' || n.type === 'ArrowFunctionExpression' || n.type === 'ClassDeclaration' || n.type === 'ClassExpression') return;
      for (const k of Object.keys(n)) { if (SKIP.has(k)) continue; const v = n[k]; if (Array.isArray(v)) v.forEach((c) => c && go(c)); else if (v && typeof v.type === 'string') go(v); }
    };
    go(body);
  };
  /** the `let`, `const`, classes and functions declared directly in a block */
  const lexical = (stmts: N[], into: Set<string>) => {
    for (const s of stmts) {
      if (s.type === 'VariableDeclaration' && s.kind !== 'var') for (const d of s.declarations) for (const x of patternNames(d.id)) into.add(x);
      if ((s.type === 'ClassDeclaration' || s.type === 'FunctionDeclaration') && s.id) into.add(s.id.name);
    }
  };
  const visit = (n: N | null | undefined, parent: N | null, key: string) => {
    if (!n || typeof n.type !== 'string') return;
    if (n.type.startsWith('TS') && !['TSAsExpression', 'TSSatisfiesExpression', 'TSNonNullExpression', 'TSTypeAssertion', 'TSParameterProperty', 'TSInstantiationExpression'].includes(n.type)) return;
    switch (n.type) {
      case 'SideEffect': side(n.spec); return;
      case 'Identifier':
        if (isRead(parent, key)) {
          ref(n.name, n.start);
          // `Math` and `Reflect` only as `Math.max(…)`, `Math.PI`: never as a value (an alias, destructured, passed on)
          if (RESTRICTED.has(n.name) && !scopes.some((s) => s.has(n.name)) && !(parent?.type === 'MemberExpression' && key === 'object' && !parent.computed)) bad(`\`${n.name}\` as a value`, n.start);
        }
        return;
      // `import.meta` in any form: the environment, and the module's own URL (the build machine's path)
      case 'MetaProperty':
        bad(parent?.type === 'MemberExpression' && parent.object === n && !parent.computed && parent.property.name === 'env' ? '`import.meta.env`' : '`import.meta`', n.start);
        return;
      case 'ImportExpression': bad('`import()`', n.start); break;
      case 'WithStatement': bad('`with`', n.start); break;
      case 'AssignmentExpression': case 'UpdateExpression': {
        // a binding it assigns (`n++`, `n = …`). What it changes inside an object (a table of ids, a counter in a
        // member, `re.lastIndex = 0` before a scan) is not read here: the build runs its calls again in a fresh copy
        // of the module, in another order (`crossCheck`), which finds the results that depend on the calls before
        const t: N = n.type === 'AssignmentExpression' ? n.left : n.argument;
        if (t.type === 'Identifier' && write) write(t.name, n.start, 'writing');
        break;
      }
      case 'MemberExpression': {
        const prop = !n.computed ? n.property.name : n.property.type === 'Literal' ? String(n.property.value) : null;
        if (prop && BAD_MEMBERS.test(prop)) bad(`\`.${prop}\``, n.property.start);
        // the way to `Function` from any value, and to any object's prototype
        if (prop === 'constructor' || prop === '__proto__') bad(`\`.${prop}\``, n.property.start);
        if (n.object.type === 'Identifier' && n.object.name === 'Math' && prop === 'random' && !scopes.some((s) => s.has('Math'))) bad('`Math.random`', n.start);
        // an error's stack names the build machine's files
        if (prop === 'stack' && stackOf(n.object)) bad('`.stack` of an error', n.property.start);
        if (n.object.type === 'Identifier' && prop && member(n.object.name, prop, n.start)) { if (n.computed) visit(n.property, n, 'property'); return; }
        break;
      }
      case 'FunctionDeclaration': case 'FunctionExpression': case 'ArrowFunctionExpression': {
        const s = new Set<string>();
        if (n.type === 'FunctionExpression' && n.id) s.add(n.id.name);
        for (const p of n.params as N[]) for (const x of patternNames(p)) s.add(x);
        if (n.body.type === 'BlockStatement') { hoisted(n.body, s); lexical(n.body.body, s); }
        scopes.push(s);
        for (const p of n.params as N[]) visitPattern(p);
        if (n.body.type === 'BlockStatement') for (const st of n.body.body) visit(st, n.body, 'body'); else visit(n.body, n, 'body');
        scopes.pop();
        return;
      }
      case 'BlockStatement': case 'StaticBlock': {
        const s = new Set<string>();
        lexical(n.body, s);
        scopes.push(s);
        for (const st of n.body) visit(st, n, 'body');
        scopes.pop();
        return;
      }
      case 'ForStatement': case 'ForInStatement': case 'ForOfStatement': {
        const s = new Set<string>();
        const init = n.type === 'ForStatement' ? n.init : n.left;
        if (init?.type === 'VariableDeclaration' && init.kind !== 'var') for (const d of init.declarations) for (const x of patternNames(d.id)) s.add(x);
        scopes.push(s);
        for (const k of ['init', 'left', 'right', 'test', 'update', 'body']) if (n[k]) visit(n[k], n, k);
        scopes.pop();
        return;
      }
      case 'SwitchStatement': {
        visit(n.discriminant, n, 'discriminant');
        const s = new Set<string>();
        lexical((n.cases as N[]).flatMap((c) => c.consequent), s);
        scopes.push(s);
        for (const c of n.cases) { if (c.test) visit(c.test, c, 'test'); for (const st of c.consequent) visit(st, c, 'consequent'); }
        scopes.pop();
        return;
      }
      case 'CatchClause': {
        const s = new Set<string>(n.param ? patternNames(n.param) : []);
        scopes.push(s);
        if (n.param) visitPattern(n.param);
        visit(n.body, n, 'body');
        scopes.pop();
        return;
      }
      case 'ClassDeclaration': case 'ClassExpression': {
        const s = new Set<string>(n.id ? [n.id.name] : []);
        scopes.push(s);
        if (n.superClass) visit(n.superClass, n, 'superClass');
        visit(n.body, n, 'body');
        scopes.pop();
        return;
      }
      case 'VariableDeclarator': visitPattern(n.id); if (n.init) visit(n.init, n, 'init'); return;
    }
    for (const k of Object.keys(n)) {
      if (SKIP.has(k)) continue;
      const v = n[k];
      if (Array.isArray(v)) { for (const c of v) if (c && typeof c.type === 'string') visit(c, n, k); }
      else if (v && typeof v.type === 'string') visit(v, n, k);
    }
  };
  /** a pattern's default values and computed keys are code; its names are bindings */
  const visitPattern = (p: N | null) => {
    if (!p) return;
    if (p.type === 'AssignmentPattern') { visitPattern(p.left); visit(p.right, p, 'right'); }
    else if (p.type === 'ObjectPattern') for (const x of p.properties) { if (x.type === 'RestElement') visitPattern(x.argument); else { if (x.computed) visit(x.key, x, 'key'); visitPattern(x.value); } }
    else if (p.type === 'ArrayPattern') for (const x of p.elements) visitPattern(x);
    else if (p.type === 'RestElement') visitPattern(p.argument);
    else if (p.type === 'TSParameterProperty') visitPattern(p.parameter);
    else if (p.type === 'MemberExpression') visit(p, null, '');
  };
  /** names bound to an error: a catch clause's parameter, or a variable initialized by constructing one */
  const errors = new Set<string>();
  const findErrors = (n: N | null | undefined) => {
    if (!n || typeof n.type !== 'string') return;
    if (n.type === 'CatchClause' && n.param) for (const x of patternNames(n.param)) errors.add(x);
    if (n.type === 'VariableDeclarator' && n.id.type === 'Identifier' && isErrorMade(n.init)) errors.add(n.id.name);
    if (n.type === 'AssignmentExpression' && n.left.type === 'Identifier' && isErrorMade(n.right)) errors.add(n.left.name);
    for (const k of Object.keys(n)) { if (SKIP.has(k)) continue; const v = n[k]; if (Array.isArray(v)) v.forEach((c) => c && findErrors(c)); else if (v && typeof v.type === 'string') findErrors(v); }
  };
  for (const n of nodes) findErrors(n);
  const stackOf = (o: N): boolean => {
    while (/^(TSAsExpression|TSSatisfiesExpression|TSNonNullExpression|TSTypeAssertion|ParenthesizedExpression)$/.test(o.type)) o = o.expression;
    return isErrorMade(o) || (o.type === 'Identifier' && errors.has(o.name));
  };
  const top = new Set<string>();
  scopes.push(top);
  for (const n of nodes) visit(n, null, '');
  scopes.pop();
}

/** globals that may only be the object of a member access (`Math.max`), never a value: through a value, a
 * member the check refuses by name (`random`) can be reached by another name */
const RESTRICTED = new Set(['Math', 'Reflect']);

/** `new Error(…)`, `TypeError(…)`: an expression that constructs an error */
function isErrorMade(n: N | null | undefined): boolean {
  return !!n && (n.type === 'NewExpression' || n.type === 'CallExpression') && n.callee.type === 'Identifier' && /^(\w*Error)$/.test(n.callee.name);
}

/** whether the identifier at `parent[key]` is read (not a property name, a label, or a binding) */
function isRead(parent: N | null, key: string): boolean {
  if (!parent) return true;
  switch (parent.type) {
    case 'MemberExpression': return key !== 'property' || parent.computed;
    case 'Property': case 'PropertyDefinition': case 'MethodDefinition': return key === 'value' ? parent.type !== 'MethodDefinition' : key !== 'key' || parent.computed;
    case 'LabeledStatement': case 'BreakStatement': case 'ContinueStatement': return false;
    case 'VariableDeclarator': return key !== 'id';
    case 'FunctionDeclaration': case 'FunctionExpression': case 'ArrowFunctionExpression': return key !== 'id' && key !== 'params';
    case 'ClassDeclaration': case 'ClassExpression': return key !== 'id';
    case 'CatchClause': return key !== 'param';
    case 'ExportSpecifier': case 'ImportSpecifier': case 'ImportDefaultSpecifier': case 'ImportNamespaceSpecifier': return false;
    default: return true;
  }
}

// ---- reachability

/** a module that is no JavaScript (a stylesheet, an image), by its extension or a query (`?raw`, `?url`) */
const CODE = /\.(?:[cm]?[jt]sx?|json)$/i;
const isNotCode = (spec: string, file: string) => /\?/.test(spec) || (/\.\w+$/.test(file) && !CODE.test(file));
/** a resolved import: its file, with the query of a module that is not JavaScript (`x.css?raw` is not `x.css`) */
const targetOf = (spec: string, from: string, root: string, cache: FoldCache): string | null => {
  const t = resolveImport(spec, from, root, cache);
  return t && isNotCode(spec, t) ? t + (/\?[^#]*/.exec(spec)?.[0] ?? '') : t;
};

/**
 * A stylesheet or an asset as the static check sees it. Imported for its effect (`import './x.css'`) it is an
 * empty module; `?raw` is the file's text, the same in Node and in the build; any other value it gives (an
 * asset's URL, `?url`, `?inline`, a CSS module's class names) is the build's own, hashed or processed, which the
 * module runner in Node does not give: a helper that reaches one does not fold.
 */
function assetModule(file: string): ModuleInfo {
  const raw = /\?(?:.*&)?raw(?:&|$)/.test(file);
  const value: Unit = { name: 'default', edges: [], bad: raw ? null : { reason: 'its value is the build\'s own (an asset\'s URL with a hash, a stylesheet as built), not what Node sees', at: 0 } };
  return { file, code: '', units: new Map([['<top>', { name: '<top>', edges: [], bad: null }], ['default', value]]), exports: new Map([['default', { local: 'default' }]]), stars: [], any: 'default' };
}

/** the module of a file, analysed once per content */
function moduleOf(file: string, cache: FoldCache): ModuleInfo {
  if (isNotCode(file, file.replace(/\?.*$/, ''))) return assetModule(file);
  const hit = cache.modules.get(file);
  // an in-memory module (a function's own source) has no file
  if (hit && hit.stamp === '' && !hit.info.broken && !existsSync(file)) return hit.info;
  let stamp = '';
  try { stamp = stampOf(file); } catch { /* reported by the read */ }
  if (hit && hit.stamp === stamp) return hit.info;
  let info: ModuleInfo;
  try { info = analyze(file, readFileSync(file, 'utf8')); } catch (e) { info = { file, code: '', units: new Map(), exports: new Map(), stars: [], broken: `cannot be read: ${(e as Error).message}` }; }
  cache.modules.set(file, { stamp, info });
  return info;
}

/**
 * The verdict for one export of a module: whether everything it can reach (its function, what that calls,
 * the top level of every module on the way, through re-exports) uses only `FOLD_GLOBALS`.
 */
export function foldVerdict(file: string, name: string, root: string, cache: FoldCache = new FoldCache()): FoldVerdict {
  const seen = new Set<string>();
  const rel = (f: string) => relative(root, f).split(sep).join('/');
  type Step = { file: string; unit: string; chain: string[] };
  const stack: Step[] = [];
  /** an export of a module: the units it stands for (re-exports followed), or a verdict */
  const exportUnits = (f: string, exp: string, chain: string[], depth = 0): FoldVerdict | null => {
    const m = moduleOf(f, cache);
    if (m.broken) return { fold: false, reason: `${rel(f)} ${m.broken}`, file: f, line: 1, col: 1, chain };
    if (depth > 50) return null;
    // imported for its effect: its top level runs, nothing it exports is read
    if (exp === '<side>') { stack.push({ file: f, unit: '<top>', chain }); return null; }
    if (exp === '*') { for (const u of m.units.keys()) stack.push({ file: f, unit: u, chain }); for (const [k] of m.exports) { const v = exportUnits(f, k, chain, depth + 1); if (v) return v; } return null; }
    const e = m.exports.get(exp) ?? (m.any ? { local: m.any } : undefined);
    if (e && 'local' in e) { stack.push({ file: f, unit: e.local, chain }); stack.push({ file: f, unit: '<top>', chain }); return null; }
    const via = e && 'spec' in e ? [e] : m.stars.map((spec) => ({ spec, name: exp }));
    for (const r of via) {
      const t = targetOf(r.spec, f, root, cache);
      if (!t) { if (e) return { fold: false, reason: `\`${r.spec}\` cannot be resolved`, file: f, line: 1, col: 1, chain }; continue; }
      if (!e && !moduleOf(t, cache).exports.has(exp) && !moduleOf(t, cache).stars.length) continue;
      stack.push({ file: f, unit: '<top>', chain });
      return exportUnits(t, r.name, chain, depth + 1);
    }
    if (!e && !m.stars.length) return { fold: false, reason: `${rel(f)} exports no \`${exp}\``, file: f, line: 1, col: 1, chain };
    return null;
  };
  const first = exportUnits(file, name, [name]);
  if (first) return first;
  while (stack.length) {
    const s = stack.pop()!;
    const key = `${s.file}\0${s.unit}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const m = moduleOf(s.file, cache);
    const u = m.units.get(s.unit);
    if (!u) continue;
    const chain = s.unit === '<top>' ? [...s.chain, `${rel(s.file)} (top level)`] : s.chain.at(-1) === s.unit ? s.chain : [...s.chain, s.unit];
    if (u.bad) return { fold: false, reason: u.bad.reason, file: s.file, ...lineCol(m.code, u.bad.at), chain };
    for (const e of u.edges) {
      if ('local' in e) { stack.push({ file: s.file, unit: e.local, chain }); continue; }
      const t = targetOf(e.spec, s.file, root, cache);
      if (!t) return { fold: false, reason: `\`${e.spec}\` cannot be resolved with production conditions`, file: s.file, line: 1, col: 1, chain };
      const v = exportUnits(t, e.name, chain);
      if (v) return v;
    }
  }
  return { fold: true };
}

/**
 * The verdict for each helper of a manifest, by the name compiled code calls (`fmt`, `ns$member`); the
 * built-in messages are not app helpers. Module specifiers are the manifest's (`/src/lib/x.ts` from the
 * root, or a package resolved from the helpers module).
 */
export function foldVerdicts(manifest: HelperManifest, root: string, helpersFile: string | null, cache: FoldCache = new FoldCache()): Map<string, FoldVerdict> {
  const out = new Map<string, FoldVerdict>();
  const from = helpersFile ?? resolve(root, 'src/sinter.helpers.js');
  const fileOf = (spec: string) => resolveImport(spec, from, root, cache);
  const one = (key: string, spec: string | null, name: string) => {
    const f = spec ? fileOf(spec) : null;
    out.set(key, f ? foldVerdict(f, name, root, cache) : { fold: false, reason: `\`${spec}\` cannot be resolved`, file: from, line: 1, col: 1, chain: [name] });
  };
  for (const h of manifest.names) { const o = manifest.from?.[h]; one(h, o?.module ?? manifest.module, o?.name ?? h); }
  for (const [ns, v] of Object.entries(manifest.namespaces)) {
    if (v.module === '@tiaforge-ui/sinter/messages' || v.module.startsWith('sinter:content/')) continue;
    for (const m of v.members) { const o = v.from?.[m]; one(`${ns}$${m}`, o?.module ?? v.module, o?.name ?? m); }
  }
  return out;
}

/**
 * The verdict for a function given as a value (testing's `render()` and `firstPaint()` take helpers that way): its
 * own source, read with `toString()`. What it closes over is unknown, so a name from outside it does not fold.
 */
export function functionVerdict(fn: unknown, name: string): FoldVerdict {
  const no = (reason: string): FoldVerdict => ({ fold: false, reason, file: `<${name}>`, line: 1, col: 1, chain: [name] });
  if (typeof fn !== 'function') return no('not a function');
  // a memoized function (memo.ts): as foldable as the one it calls, its cache being the memo's own
  const inner = (fn as unknown as Record<symbol, unknown>)[Symbol.for('sinter.memo')];
  if (typeof inner === 'function') return functionVerdict(inner, name);
  const src = Function.prototype.toString.call(fn);
  if (/\{\s*\[native code\]\s*\}\s*$/.test(src)) return no('a built-in or bound function, whose source cannot be read');
  const cache = new FoldCache();
  // a function or arrow expression, else a method (`parse(s) { … }`, as an object literal writes it)
  for (const code of [`export const ${'$f'} = (${src});\n`, `export const ${'$f'} = ({ ${src} });\n`]) {
    const file = `/<${name}>.js`;
    const info = analyze(file, code);
    if (info.broken) continue;
    cache.modules.set(file, { stamp: '', info });
    const v = foldVerdict(file, '$f', '/', cache);
    return v.fold ? v : { ...v, file: `<${name}>`, chain: [name] };
  }
  return no('a function whose source cannot be read');
}

/** A verdict as a sentence, for SN322 and the docs: why a helper's call stays in the browser. */
export function foldReason(v: FoldVerdict, root: string): string | null {
  if (v.fold) return null;
  const where = `${relative(root, v.file).split(sep).join('/')}:${v.line}:${v.col}`;
  const through = v.chain.length > 1 ? `, through ${v.chain.join(' → ')}` : '';
  // a name or member the code reads, or something about a module (unresolvable, unparsable)
  return /^`[^`]+`$/.test(v.reason) && !/cannot be resolved/.test(v.reason)
    ? `it reaches ${v.reason} (${where}${through}), which is not one of the globals a build-time call may use`
    : `${v.reason} (${where}${through})`;
}
