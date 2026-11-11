// Lazy packages (`sinter({ lazy: ['openpgp'] })`, docs/lazy.md): app code imports the package as it
// always has; the plugin points those imports at a generated module of async stubs that share one
// `import()` of the package, so the package is a chunk of its own, loaded on first call. This file is
// the build side: reading a module's imports of lazy packages (and refusing uses a stub cannot serve:
// SN324), rewriting them, the generated modules, and walking the app's imports (helpers, component
// scripts). The runtime side is `lazy.ts`.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';
import { parseModule } from './compiler/index.js';
import type { Diagnostic } from './compiler/diagnostics.js';

/** where the generated modules are served: `<pkg>.js` the loader, `<pkg>.js?n=a,b` the stubs of one importer */
export const LAZY = '/@sinter/lazy/';
/** the build writes the URL of each lazy chunk where the generated code has this (patched in generateBundle) */
export const CHUNK_MARK = '__SN_CHUNK__';

/** the lazy package a specifier names (`openpgp`, `openpgp/lightweight`), or null */
export function lazyPackage(spec: string, pkgs: readonly string[]): string | null {
  for (const p of pkgs) if (spec === p || spec.startsWith(p + '/')) return spec;
  return null;
}

/** the loader module's id for a package specifier */
export const loaderId = (spec: string) => `${LAZY}${spec}.js`;
/** the stubs module's id for a package specifier and the export names one importer calls */
export const stubId = (spec: string, names: Iterable<string>) => `${LAZY}${spec}.js?n=${[...new Set(names)].sort().map(encodeURIComponent).join(',')}`;

/** a generated module's id (after the `\0` and the prefix): the package specifier, and the stub names (null: the loader) */
export function parseLazyId(id: string): { spec: string; names: string[] | null } | null {
  const at = id.indexOf(LAZY);
  if (at < 0) return null;
  const rest = id.slice(at + LAZY.length);
  const q = rest.indexOf('?n=');
  const path = q < 0 ? rest : rest.slice(0, q);
  if (!path.endsWith('.js')) return null;
  const spec = path.slice(0, -3);
  if (q < 0) return { spec, names: null };
  const list = rest.slice(q + 3);
  return { spec, names: list ? list.split(',').map(decodeURIComponent) : [] };
}

/**
 * The loader: one cached `import()` of the package for every stub, `data-sn-import`, and the
 * component scripts that load with it. `chunk`: the id the build writes the chunk's URL for (null in dev).
 */
export function loaderModule(spec: string, chunk: string | null, runtime = '@tiaforge-ui/sinter/lazy'): string {
  const url = chunk === null ? 'null' : JSON.stringify(CHUNK_MARK + chunk + '__');
  return `import { lazy } from ${JSON.stringify(runtime)};\nexport const load = lazy(() => import(${JSON.stringify(spec)}), ${url}, import.meta.url);\n`;
}

const IDENT = /^[A-Za-z_$][\w$]*$/;
/** One importer's stubs: each export it calls, as a function that loads the package, then calls it. */
export function stubModule(spec: string, names: string[]): string {
  const lines = [`import { load } from ${JSON.stringify(loaderId(spec))};`];
  names.forEach((n, i) => lines.push(`const $${i} = (...a) => load().then((m) => m[${JSON.stringify(n)}](...a));`));
  if (names.length) lines.push(`export { ${names.map((n, i) => `$${i} as ${IDENT.test(n) ? n : JSON.stringify(n)}`).join(', ')} };`);
  return lines.join('\n') + '\n';
}

/** whether the code may import a lazy package at all (a quick test before parsing) */
export function mentions(code: string, pkgs: readonly string[]): boolean {
  return pkgs.some((p) => code.includes(`'${p}`) || code.includes(`"${p}`) || code.includes('`' + p));
}

export interface LazyImport {
  /** the package specifier */
  spec: string;
  /** offsets of the specifier's string literal (quotes included) */
  start: number;
  end: number;
  /** the export names the module calls */
  names: Set<string>;
}

export interface LazyScan {
  /** each value import of a lazy package: rewritten to its stubs */
  lazy: LazyImport[];
  /** uses a stub cannot serve (SN324), at an offset into the code */
  problems: Array<{ message: string; offset: number }>;
  /** the module's static value imports and re-exports (type-only ones left out), by specifier */
  imports: string[];
}

type N = { type: string; start: number; end: number; [k: string]: any };

/** keys that hold only types, and TypeScript nodes that hold a value expression */
const TYPE_KEYS = new Set(['typeAnnotation', 'returnType', 'typeParameters', 'typeArguments', 'superTypeParameters', 'superTypeArguments', 'implements', 'predicate']);
const TS_VALUE = new Set(['TSAsExpression', 'TSSatisfiesExpression', 'TSNonNullExpression', 'TSTypeAssertion', 'TSInstantiationExpression', 'TSParameterProperty', 'TSExportAssignment']);
const TS_WRAP = new Set(['TSAsExpression', 'TSSatisfiesExpression', 'TSNonNullExpression', 'TSTypeAssertion', 'ParenthesizedExpression']);
const COMBINATORS = new Set(['all', 'allSettled', 'race', 'any']);

/** Every value node, with its parents; type annotations and TypeScript's type nodes are skipped. */
function walk(node: N, parents: N[], keys: string[], visit: (n: N, parents: N[], keys: string[]) => void) {
  if (node.type.startsWith('TS') && !TS_VALUE.has(node.type)) return;
  visit(node, parents, keys);
  parents.push(node);
  for (const k of Object.keys(node)) {
    if (k === 'type' || TYPE_KEYS.has(k)) continue;
    const v = node[k];
    if (Array.isArray(v)) { for (const c of v) if (c && typeof c.type === 'string') { keys.push(k); walk(c, parents, keys, visit); keys.pop(); } }
    else if (v && typeof v === 'object' && typeof v.type === 'string') { keys.push(k); walk(v, parents, keys, visit); keys.pop(); }
  }
  parents.pop();
}

/** whether the identifier at `parent[key]` reads a binding (not a property name, a label, or a declaration) */
function isReference(parent: N | undefined, key: string): boolean {
  if (!parent) return true;
  switch (parent.type) {
    case 'MemberExpression': return key !== 'property' || parent.computed;
    case 'Property': case 'PropertyDefinition': case 'MethodDefinition': return key !== 'key' || parent.computed;
    case 'ImportSpecifier': case 'ImportDefaultSpecifier': case 'ImportNamespaceSpecifier': return false;
    case 'ExportSpecifier': return key === 'local';
    case 'LabeledStatement': case 'BreakStatement': case 'ContinueStatement': return false;
    case 'VariableDeclarator': return key !== 'id';
    case 'FunctionDeclaration': case 'FunctionExpression': case 'ArrowFunctionExpression': return key !== 'id' && key !== 'params';
    case 'ClassDeclaration': case 'ClassExpression': return key !== 'id';
    case 'CatchClause': return key !== 'param';
    case 'MetaProperty': return false;
    default: return true;
  }
}

/**
 * Whether the value of `parents[at]` is waited for: awaited, returned, the body of an arrow function,
 * chained with `.then`/`.catch`/`.finally`, discarded with `void`, or one of the promises `Promise.all`
 * (and its siblings) waits for. Through `as`, `!`, `satisfies`, `?:` branches and the right of `&&`/`||`/`??`.
 */
function waited(parents: N[], at: number): boolean {
  let cur = parents[at]!, i = at - 1;
  for (; i >= 0; i--) {
    const p = parents[i]!;
    if (TS_WRAP.has(p.type) || p.type === 'ChainExpression' || (p.type === 'ConditionalExpression' && p.test !== cur) || (p.type === 'LogicalExpression' && p.right === cur)) { cur = p; continue; }
    break;
  }
  const p = parents[i];
  if (!p) return false;
  if (p.type === 'AwaitExpression' || p.type === 'ReturnStatement' || p.type === 'YieldExpression') return true;
  if (p.type === 'ArrowFunctionExpression' && p.body === cur) return true;
  if (p.type === 'UnaryExpression' && p.operator === 'void') return true;
  const gp = parents[i - 1];
  if (p.type === 'MemberExpression' && p.object === cur && !p.computed && ['then', 'catch', 'finally'].includes(p.property.name) && gp?.type === 'CallExpression' && gp.callee === p) return true;
  if (p.type === 'ArrayExpression' && gp?.type === 'CallExpression' && gp.arguments[0] === p) {
    const c = gp.callee;
    if (c.type === 'MemberExpression' && !c.computed && c.object.type === 'Identifier' && c.object.name === 'Promise' && COMBINATORS.has(c.property.name)) return waited(parents, i - 1);
  }
  return false;
}

/**
 * Reads a module's imports of lazy packages: each value import (rewritten to stubs), and every use a
 * stub cannot serve. A value imported from a lazy package may only be called, and each call must be
 * waited for (`await`, `return`, `.then`, `void`): a stub returns a Promise, also for a function that
 * is sync in the package. Type-only imports and uses are left alone.
 */
export function scanLazy(code: string, file: string, pkgs: readonly string[]): LazyScan {
  const out: LazyScan = { lazy: [], problems: [], imports: [] };
  const ast = parseModule(code, file) as unknown as N;
  /** local name → the import it binds: a namespace, or one export */
  const locals = new Map<string, { imp: LazyImport; name: string | null }>();
  const typeOnly = (n: N) => n.importKind === 'type' || n.exportKind === 'type';
  for (const st of ast.body as N[]) {
    if (st.type === 'ImportDeclaration') {
      const spec = String(st.source.value);
      if (typeOnly(st)) continue;
      const values = (st.specifiers as N[]).filter((s) => !typeOnly(s));
      if (values.length || !st.specifiers.length) out.imports.push(spec);
      const pkg = lazyPackage(spec, pkgs);
      if (!pkg) continue;
      if (!st.specifiers.length) { out.problems.push({ message: `\`import '${spec}'\` runs the package for its side effects, which needs it loaded at once; \`sinter({ lazy })\` loads ${spec} on first call. Remove the import, or load it with \`await import('${spec}')\` where it is needed`, offset: st.start }); continue; }
      const imp: LazyImport = { spec, start: st.source.start, end: st.source.end, names: new Set() };
      out.lazy.push(imp);
      for (const s of values) {
        if (s.type === 'ImportNamespaceSpecifier') locals.set(s.local.name, { imp, name: null });
        else if (s.type === 'ImportDefaultSpecifier') locals.set(s.local.name, { imp, name: 'default' });
        else locals.set(s.local.name, { imp, name: s.imported.type === 'Identifier' ? s.imported.name : String(s.imported.value) });
      }
    } else if ((st.type === 'ExportNamedDeclaration' || st.type === 'ExportAllDeclaration') && st.source) {
      if (typeOnly(st)) continue;
      const spec = String(st.source.value);
      if (st.type === 'ExportNamedDeclaration' && (st.specifiers as N[]).every(typeOnly) && st.specifiers.length) continue;
      out.imports.push(spec);
      if (lazyPackage(spec, pkgs)) out.problems.push({ message: `re-exporting \`${spec}\` hands out its values, which need it loaded at once; \`sinter({ lazy })\` loads ${spec} on first call. Import what you call where you call it`, offset: st.start });
    }
  }
  if (!locals.size) return out;
  const nonCall = (what: string, spec: string) => `\`${what}\` needs ${spec} loaded at once, but \`sinter({ lazy })\` loads it on first call: only awaited calls of its exports work here. Load it with \`await import('${spec}')\` where it is needed, or move this into a component script, which loads with the package`;
  const unwaited = (what: string, spec: string) => `\`${what}(…)\` is not awaited: \`sinter({ lazy })\` loads ${spec} on first call, so every call returns a Promise. Write \`await ${what}(…)\`, return it, chain \`.then\`, or discard it with \`void\``;
  walk(ast, [], [], (n, parents, keys) => {
    if (n.type !== 'Identifier' || !locals.has(n.name)) return;
    const parent = parents[parents.length - 1], key = keys[keys.length - 1] ?? '';
    if (parent?.type === 'ImportDeclaration' || !isReference(parent, key)) return;
    const { imp, name } = locals.get(n.name)!;
    if (name === null) {
      // a namespace: `ns.member(…)`, waited for
      const m = parent;
      const member = m?.type === 'MemberExpression' && m.object === n ? (!m.computed ? m.property.name : m.property.type === 'Literal' && typeof m.property.value === 'string' ? m.property.value : null) : null;
      const call = parents[parents.length - 2];
      if (member === null || call?.type !== 'CallExpression' || call.callee !== m || call.optional || m.optional) {
        out.problems.push({ message: nonCall(member === null ? n.name : `${n.name}.${member}`, imp.spec), offset: n.start });
        return;
      }
      if (!waited(parents, parents.length - 2)) { out.problems.push({ message: unwaited(`${n.name}.${member}`, imp.spec), offset: n.start }); return; }
      imp.names.add(member);
      return;
    }
    if (parent?.type !== 'CallExpression' || parent.callee !== n || parent.optional) { out.problems.push({ message: nonCall(n.name, imp.spec), offset: n.start }); return; }
    if (!waited(parents, parents.length - 1)) { out.problems.push({ message: unwaited(n.name, imp.spec), offset: n.start }); return; }
    imp.names.add(name);
  });
  return out;
}

/** The module with each lazy import pointed at its stubs (only the specifiers change: the lines stay). */
export function rewriteLazy(code: string, scan: LazyScan): string {
  let out = code;
  for (const imp of [...scan.lazy].sort((a, b) => b.start - a.start)) out = out.slice(0, imp.start) + JSON.stringify(stubId(imp.spec, imp.names)) + out.slice(imp.end);
  return out;
}

/** 1-based line and column of an offset */
export function lineCol(code: string, offset: number): { line: number; col: number } {
  let line = 1, last = -1;
  for (let i = 0; i < offset && i < code.length; i++) if (code.charCodeAt(i) === 10) { line++; last = i; }
  return { line, col: offset - last };
}

/** a relative or root-absolute specifier as a file, the way the app's modules are found */
export function resolveFile(spec: string, from: string, root: string): string | null {
  if (!spec.startsWith('.') && !spec.startsWith('/')) return null;
  const b = spec.startsWith('/') ? resolve(root, '.' + spec.replace(/[?#].*$/, '')) : resolve(dirname(from), spec.replace(/[?#].*$/, ''));
  for (const q of [b, b.replace(/\.js$/, '.ts'), b.replace(/\.mjs$/, '.mts'), `${b}.ts`, `${b}.js`, `${b}.tsx`, `${b}.mjs`, `${b}/index.ts`, `${b}/index.js`]) {
    if (/\.[cm]?[jt]sx?$/.test(q) && existsSync(q)) return q;
  }
  return null;
}

export interface Reach {
  /** the lazy package specifier reached */
  spec: string;
  /** the modules from the start to the one that imports it (absolute paths) */
  chain: string[];
}

/**
 * The lazy packages a module reaches through static value imports of the app's modules (type-only
 * imports are no edge), each with the shortest chain. `cache`: scans by file, shared between calls.
 */
export function reachLazy(start: string, pkgs: readonly string[], root: string, cache: Map<string, LazyScan | null> = new Map(), read: (f: string) => string = (f) => readFileSync(f, 'utf8')): Reach[] {
  const scanOf = (f: string): LazyScan | null => {
    if (!cache.has(f)) {
      let s: LazyScan | null = null;
      try { s = scanLazy(read(f), f, pkgs); } catch { s = null; }
      cache.set(f, s);
    }
    return cache.get(f)!;
  };
  const found = new Map<string, Reach>();
  const prev = new Map<string, string | null>([[start, null]]);
  const queue = [start];
  const chainTo = (f: string) => { const c: string[] = []; for (let x: string | null = f; x; x = prev.get(x) ?? null) c.unshift(x); return c; };
  while (queue.length) {
    const f = queue.shift()!;
    if (f.includes(`${sep}node_modules${sep}`)) continue;
    const s = scanOf(f);
    if (!s) continue;
    for (const spec of s.imports) {
      const pkg = lazyPackage(spec, pkgs);
      if (pkg) { if (!found.has(pkg)) found.set(pkg, { spec: pkg, chain: chainTo(f) }); continue; }
      const next = resolveFile(spec, f, root);
      if (next && !prev.has(next)) { prev.set(next, f); queue.push(next); }
    }
  }
  return [...found.values()];
}

/** a chain for a message: `src/a.ts → src/b.ts → openpgp` */
export function chainText(root: string, r: Reach): string {
  return [...r.chain.map((f) => relative(root, f).split(sep).join('/')), r.spec].join(' → ');
}

/** whether a file is a component's script (`src/components/<name>.ts` beside its `<name>.html`) */
export function isComponentScript(root: string, file: string): boolean {
  const dir = resolve(root, 'src/components');
  if (dirname(file) !== dir) return false;
  const m = /^([a-z][a-z0-9]*-[a-z0-9-]*)\.[cm]?[jt]s$/.exec(file.slice(dir.length + 1));
  return !!m && existsSync(resolve(dir, `${m[1]}.html`));
}

/**
 * `sinter check`: SN324 in the app's modules: the helpers, actions, config and early modules, the
 * component scripts, and every app module they import. A helper module may not reach a lazy package
 * at all (helpers run synchronously while a binding renders); a component script may use it freely
 * (it loads with the package).
 */
export function lazyDiagnostics(root: string, pkgs: readonly string[], starts: Array<string | null>, helpersFile: string | null, scripts: string[]): Diagnostic[] {
  if (!pkgs.length) return [];
  const out: Diagnostic[] = [];
  const cache = new Map<string, LazyScan | null>();
  const seen = new Set<string>();
  const visit = (f: string) => {
    if (seen.has(f) || f.includes(`${sep}node_modules${sep}`)) return;
    seen.add(f);
    let code: string;
    try { code = readFileSync(f, 'utf8'); } catch { return; }
    let s: LazyScan;
    try { s = scanLazy(code, f, pkgs); } catch (e) { out.push({ severity: 'error', code: 'SN324', message: `cannot read ${relative(root, f)} to check its imports of lazy packages: ${(e as Error).message}`, file: f, line: 1, col: 1 }); return; }
    cache.set(f, s);
    if (!isComponentScript(root, f)) for (const p of s.problems) out.push({ severity: 'error', code: 'SN324', message: p.message, file: f, ...lineCol(code, p.offset) });
    for (const spec of s.imports) { const n = resolveFile(spec, f, root); if (n) visit(n); }
  };
  for (const f of [...starts, ...scripts]) if (f) visit(f);
  if (helpersFile) for (const r of reachLazy(helpersFile, pkgs, root, cache)) out.push(helperProblem(root, r, helpersFile));
  return out;
}

/** SN324 for a helper module that reaches a lazy package */
export function helperProblem(root: string, r: Reach, helpersFile: string): Diagnostic {
  return {
    severity: 'error', code: 'SN324', file: helpersFile, line: 1, col: 1,
    message: `the helpers module reaches ${r.spec}, which \`sinter({ lazy })\` loads on first call: helpers run while a binding renders and cannot wait for a download (${chainText(root, r)}). Compute the value in an action or a \`<sn-resource call>\`, or take ${r.spec} out of \`lazy\``,
  };
}
