// "Extract to helper" and "Extract to action": moves an expression of a page (or the part
// of it the selection covers) into a named function of the helpers or actions module, and
// calls the function in its place. The expression's free names (loop variables, state,
// resources, `$event` and the other magic names) become parameters, typed by TypeScript when
// the project has TypeScript 7. Every extraction is compiled before it is offered: one the
// compiler would reject (a `data-sn-state` that must stay a literal, …) is not offered.
//
// Handlers cannot become helpers (helpers are pure; assignments and store calls stay in the
// page), so in a handler the computed value of an assignment is extracted and the assignment
// stays: `query = c.name.trim()` becomes `query = nextQuery(c)`. Several assignments are
// extracted one helper per value, or, when they write properties of one state object, into one
// helper returning an object the handler merges back: `Object.assign(draft, draftChanges(draft))`.
// sinter handlers have no destructuring and no local variables, so that is the only one-call form.
import * as acorn from 'acorn';
import { dirname, join, relative, resolve } from 'node:path';
import type { CheckExpr, CheckUnit } from '../compiler/check-unit.js';
import type { HelperManifest } from '../compiler/compile.js';
import { ALL_MAGIC, BUILTIN_HELPERS, GLOBALS, MUTATORS, READ_ONLY, STORE_FNS } from '../compiler/expr.js';
import { PACKAGE, parseModule, type Diagnostic } from '../compiler/index.js';
import type { Project, ProjectOptions } from '../project.js';
import type { Range } from './server.js';

type Node = acorn.AnyNode & { start: number; end: number };
const PARSE: acorn.Options = { ecmaVersion: 'latest', sourceType: 'module' };

export interface ExtractContext {
  /** the HTML file (a page or a partial) and its current text */
  file: string;
  text: string;
  root: string;
  /** the check units of the project's pages; the first that has the expression is used */
  units: CheckUnit[];
  project: Project;
  options: ProjectOptions;
  /** a module's current text (open buffer, else disk), or null when it does not exist */
  read(file: string): string | null;
  /** the compiler's errors in `file` when it reads `text` and the modules export these names */
  trial(text: string, helpers: HelperManifest, actions: HelperManifest): Diagnostic[];
  /** TypeScript's hover text at a 1-based position of `file` (`const c: Contact`); absent without TypeScript 7 */
  typeAt?(line: number, col: number): Promise<string | null>;
  /** type names the types module exports */
  typeNames: string[];
  /** the client applies `CreateFile` operations (needed when the module does not exist yet) */
  canCreate: boolean;
}

export interface TextEdit { range: Range; newText: string }
export type WorkspaceEdit =
  | { changes: Record<string, TextEdit[]> }
  | { documentChanges: Array<{ kind: 'create'; uri: string; options: { ignoreIfExists: boolean } } | { textDocument: { uri: string; version: null }; edits: TextEdit[] }> };

interface Param {
  /** the parameter's name in the function */
  name: string;
  /** what the call site passes (`c`, `$meta.contacts`) */
  arg: string;
  /** offset in the HTML text where TypeScript is asked for its type */
  at: number;
}

interface Fn {
  name: string;
  params: Param[];
  /** what the function returns, as source text with parameters renamed */
  body: string;
  /** names the body takes from the module's scope (helpers, namespaces, the action it calls) */
  uses: Set<string>;
  /** actions: the name of the trailing context parameter */
  ctx?: string;
}

/** One way to extract, as offered to the editor. */
export interface Plan {
  title: string;
  target: 'helpers' | 'actions';
  fns: Fn[];
  /** replacements in the HTML text, absolute offsets */
  html: Array<{ start: number; end: number; text: string }>;
}

interface Module {
  file: string;
  /** root-relative URL, as the compiler's manifests name modules */
  url: string;
  ts: boolean;
  /** current text, or null when the file does not exist yet */
  text: string | null;
  /** names declared or imported at its top level */
  bound: Set<string>;
  /** offset after its last import (0 without imports) */
  importsEnd: number;
}

// ---- positions

function lineStarts(text: string): number[] {
  const out = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') out.push(i + 1);
  return out;
}
const offsetAt = (starts: number[], p: { line: number; character: number }) =>
  (starts[Math.min(p.line, starts.length - 1)] ?? 0) + p.character;
function positionAt(starts: number[], offset: number): { line: number; character: number } {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid]! <= offset) lo = mid; else hi = mid - 1;
  }
  return { line: lo, character: offset - starts[lo]! };
}
const rangeOf = (starts: number[], start: number, end: number): Range => ({ start: positionAt(starts, start), end: positionAt(starts, end) });

// ---- the expression under the selection

interface Found {
  unit: CheckUnit;
  e: CheckExpr;
  /** absolute offset of `e.src[0]` in the HTML */
  start: number;
  /** the attribute the expression is in */
  attr: string;
  /** offset where the attribute value starts */
  valueStart: number;
  /** `data-sn-call` / `call`: `e.src` is the argument list as `[…]`, written `(…)` in the HTML */
  callArgs: boolean;
}

/** The attribute whose value contains `offset`, from the text before it. */
function attributeBefore(text: string, offset: number): { name: string; valueStart: number } | null {
  const from = Math.max(0, offset - 4000);
  const m = /([^\s"'<>/=]+)\s*=\s*(["'])((?:(?!\2)[^])*)$/.exec(text.slice(from, offset));
  return m ? { name: m[1]!.toLowerCase(), valueStart: offset - m[3]!.length } : null;
}

function findExpr(ctx: ExtractContext, starts: number[], a: number, b: number, whole: boolean): Found | null {
  let best: (Found & { len: number; inside: boolean }) | null = null;
  const seen = new Set<string>();
  for (const unit of ctx.units) {
    for (const e of unit.exprs) {
      if (e.loc.file !== ctx.file || e.broken) continue;
      const start = offsetAt(starts, { line: e.loc.line - 1, character: e.loc.col - 1 });
      const key = `${start}:${e.src}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const callArgs = e.returns?.kind === 'call' && !!e.returns.args;
      const shown = callArgs ? `(${e.src.slice(1, -1)})` : e.src;
      // an attribute with character references (`&quot;`) is not the source the compiler saw
      if (ctx.text.slice(start, start + shown.length) !== shown) continue;
      const attr = attributeBefore(ctx.text, start);
      if (!attr) continue;
      const spanStart = callArgs ? attr.valueStart : start;
      const end = start + shown.length;
      const inside = a >= spanStart && b <= end;
      const covered = whole && a <= spanStart && b >= end;
      if (!inside && !covered) continue;
      const len = end - spanStart;
      // inside: the innermost expression; covered (a diagnostic's range): the outermost
      if (!best || (inside && (!best.inside || len < best.len)) || (!inside && !best.inside && len > best.len)) {
        best = { unit, e, start, attr: attr.name, valueStart: attr.valueStart, callArgs, len, inside };
      }
    }
  }
  return best;
}

// ---- syntax

interface Site { node: Node; bound: Set<string>; parent: Node | null; key: string }

function children(n: Node): Array<[string, Node]> {
  const out: Array<[string, Node]> = [];
  for (const key of Object.keys(n)) {
    if (key === 'type' || key === 'start' || key === 'end' || key === 'loc' || key === 'range') continue;
    const v = (n as unknown as Record<string, unknown>)[key];
    if (Array.isArray(v)) { for (const c of v) if (c && typeof c === 'object' && 'type' in c) out.push([key, c as Node]); }
    else if (v && typeof v === 'object' && 'type' in v) out.push([key, v as Node]);
  }
  return out;
}

function patternNames(p: Node, out: Set<string>): void {
  switch (p.type) {
    case 'Identifier': out.add(p.name); break;
    case 'ObjectPattern': for (const q of p.properties) patternNames((q.type === 'RestElement' ? q.argument : q.value) as Node, out); break;
    case 'ArrayPattern': for (const q of p.elements) if (q) patternNames(q as Node, out); break;
    case 'AssignmentPattern': patternNames(p.left as Node, out); break;
    case 'RestElement': patternNames(p.argument as Node, out); break;
    default: break;
  }
}

/** the names a function binds for its body: parameters and the body's own declarations */
function functionScope(n: Node, bound: Set<string>): Set<string> {
  const inner = new Set(bound);
  if (n.type !== 'ArrowFunctionExpression' && n.type !== 'FunctionExpression') return inner;
  for (const p of n.params) patternNames(p as Node, inner);
  if (n.body.type === 'BlockStatement') {
    for (const st of n.body.body) if (st.type === 'VariableDeclaration') for (const d of st.declarations) patternNames(d.id as Node, inner);
  }
  return inner;
}

/** Every node, with the names functions inside the expression bind around it. */
function sites(root: Node): Site[] {
  const out: Site[] = [];
  const visit = (n: Node, bound: Set<string>, parent: Node | null, key: string) => {
    out.push({ node: n, bound, parent, key });
    const inner = n.type === 'ArrowFunctionExpression' || n.type === 'FunctionExpression' ? functionScope(n, bound) : bound;
    for (const [k, c] of children(n)) visit(c, inner, n, k);
  };
  visit(root, new Set(), null, '');
  return out;
}

const PATTERNS = new Set(['ObjectPattern', 'ArrayPattern', 'AssignmentPattern', 'RestElement']);

/** an expression that can be replaced by a call without changing what is around it */
function extractable(s: Site): boolean {
  const { node: n, parent: p, key } = s;
  if (!(n.type.endsWith('Expression') || n.type === 'Identifier' || n.type === 'Literal' || n.type === 'TemplateLiteral')) return false;
  if (!p) return true;
  if (PATTERNS.has(p.type) || (key === 'params')) return false;
  if (p.type === 'MemberExpression' && key === 'property' && !p.computed) return false;
  if (p.type === 'Property' && (key === 'key' ? !p.computed : p.shorthand)) return false;
  if (p.type === 'Property' && PATTERNS.has((p as unknown as { value: Node }).value.type)) return false;
  // a method's receiver is its `this`: `c.name.trim` is not a function value
  if ((p.type === 'CallExpression' || p.type === 'NewExpression') && key === 'callee') return false;
  if (p.type === 'AssignmentExpression' && key === 'left') return false;
  if (p.type === 'UpdateExpression') return false;
  if (p.type === 'UnaryExpression' && p.operator === 'delete') return false;
  if (p.type === 'TaggedTemplateExpression' && key === 'tag') return false;
  return true;
}

/** nothing worth a function: a name, a literal, a plain member path, `!` or `-` of one */
function trivial(n: Node): boolean {
  if (n.type === 'Identifier' || n.type === 'Literal') return true;
  if (n.type === 'UnaryExpression') return n.operator !== 'delete' && trivial(n.argument as Node);
  if (n.type === 'TemplateLiteral') return n.expressions.length === 0;
  if (n.type === 'MemberExpression') return !n.computed && trivial(n.object as Node) && n.object.type !== 'Literal';
  return false;
}

/** The static member path `draft.emails.length` → ['draft', 'emails', 'length']; null when not one. */
function staticPath(n: Node): string[] | null {
  if (n.type === 'Identifier') return [n.name];
  if (n.type === 'MemberExpression' && !n.computed && n.property.type === 'Identifier') {
    const o = staticPath(n.object as Node);
    return o ? [...o, n.property.name] : null;
  }
  return null;
}

interface Ref {
  /** a free name, or `$meta.<resource>` */
  name: string;
  /** where the reference is written in `src` (`$meta.contacts` as a whole) */
  start: number;
  end: number;
  /** where TypeScript is asked for its type */
  at: number;
  /** bound by a function of the page's expression around the extracted part (`x` in `list.map(x => …)`) */
  local: boolean;
}

/** The free names of `node`, in source order; `outer` are names functions around it bind. */
function refsOf(node: Node, outer: Set<string>): Ref[] {
  const out: Ref[] = [];
  const visit = (n: Node, bound: Set<string>) => {
    switch (n.type) {
      case 'Identifier':
        if (!bound.has(n.name)) out.push({ name: n.name, start: n.start, end: n.end, at: n.start, local: outer.has(n.name) });
        return;
      case 'MemberExpression':
        // `$meta.contacts`: the resource's status object is the parameter, so the resource stays read
        if (n.object.type === 'Identifier' && n.object.name === '$meta' && !bound.has('$meta') && !outer.has('$meta') && !n.computed && n.property.type === 'Identifier') {
          out.push({ name: `$meta.${n.property.name}`, start: n.object.start, end: n.property.end, at: n.property.start, local: false });
          return;
        }
        visit(n.object as Node, bound);
        if (n.computed) visit(n.property as Node, bound);
        return;
      case 'Property':
        if (n.computed) visit(n.key as Node, bound);
        visit(n.value as Node, bound);
        return;
      case 'ArrowFunctionExpression':
      case 'FunctionExpression': {
        const inner = functionScope(n, bound);
        for (const p of n.params) defaults(p as Node, inner);
        visit(n.body as Node, inner);
        return;
      }
      case 'VariableDeclarator':
        defaults(n.id as Node, bound);
        if (n.init) visit(n.init as Node, bound);
        return;
      case 'LabeledStatement': visit(n.body as Node, bound); return;
      case 'BreakStatement': case 'ContinueStatement': return;
      default:
        for (const [, c] of children(n)) visit(c, bound);
    }
  };
  /** default values and computed keys inside a pattern */
  const defaults = (p: Node, bound: Set<string>) => {
    if (p.type === 'AssignmentPattern') { defaults(p.left as Node, bound); visit(p.right as Node, bound); }
    else if (p.type === 'ObjectPattern') {
      for (const q of p.properties) {
        if (q.type === 'RestElement') continue;
        if (q.computed) visit(q.key as Node, bound);
        defaults(q.value as Node, bound);
      }
    } else if (p.type === 'ArrayPattern') { for (const q of p.elements) if (q) defaults(q as Node, bound); }
  };
  visit(node, new Set());
  return out.sort((x, y) => x.start - y.start);
}

/** Why `node` (part of a handler) cannot be a pure helper, or null. */
function impurity(node: Node, scopeNames: Set<string>): string | null {
  let why: string | null = null;
  const visit = (n: Node, bound: Set<string>) => {
    if (why) return;
    if (n.type === 'AssignmentExpression' || n.type === 'UpdateExpression') { why = 'assigns'; return; }
    if (n.type === 'UnaryExpression' && n.operator === 'delete') { why = 'deletes'; return; }
    if (n.type === 'CallExpression') {
      const c = n.callee as Node;
      if (c.type === 'Identifier' && STORE_FNS.includes(c.name) && !bound.has(c.name) && !scopeNames.has(c.name)) { why = 'calls a store function'; return; }
      if (c.type === 'MemberExpression' && !c.computed && c.property.type === 'Identifier') {
        const method = c.property.name;
        const root = staticPath(c.object as Node)?.[0];
        if (MUTATORS.has(method) && !READ_ONLY.has(method)) { why = 'mutates'; return; }
        if (root === 'Object' && ['assign', 'defineProperty', 'defineProperties', 'setPrototypeOf'].includes(method)) { why = 'mutates'; return; }
        if ((root === '$event' || root === '$el') && !READ_ONLY.has(method)) { why = 'has a side effect'; return; }
      }
    }
    const inner = n.type === 'ArrowFunctionExpression' || n.type === 'FunctionExpression' ? functionScope(n, bound) : bound;
    for (const [, c] of children(n)) visit(c, inner);
  };
  visit(node, new Set());
  return why;
}

// ---- modules

function relativeSpec(fromFile: string, target: string, keepExtension: boolean): string {
  let s = relative(dirname(fromFile), target).split('\\').join('/');
  if (!keepExtension) s = s.replace(/\.d\.ts$|\.[cm]?[jt]sx?$/, '');
  return s.startsWith('.') ? s : './' + s;
}

function readModule(ctx: ExtractContext, file: string): Module {
  const text = ctx.read(file);
  const ts = /\.[cm]?tsx?$/.test(file);
  const bound = new Set<string>();
  let importsEnd = 0;
  if (text !== null) {
    let ast: acorn.Program | null = null;
    try { ast = parseModule(text, file); } catch { /* a module that does not parse: nothing is known to be bound */ }
    for (const st of ast?.body ?? []) {
      const d = (st.type === 'ExportNamedDeclaration' || st.type === 'ExportDefaultDeclaration') && st.declaration ? st.declaration as Node : st as Node;
      if (st.type === 'ImportDeclaration') {
        for (const s of st.specifiers) bound.add(s.local.name);
        importsEnd = text.indexOf('\n', st.end) + 1 || text.length;
      } else if (d.type === 'VariableDeclaration') {
        for (const v of d.declarations) patternNames(v.id as Node, bound);
      } else if ('id' in d && d.id && (d.id as Node).type === 'Identifier') {
        bound.add((d.id as acorn.Identifier).name);
      }
    }
  }
  return { file, url: '/' + relative(ctx.root, file).split('\\').join('/'), ts, text, bound, importsEnd };
}

/** The helpers module: the project's, the configured path, else a new one (`.ts` in a TypeScript project). */
function helpersModule(ctx: ExtractContext): Module {
  const p = ctx.project;
  if (p.helpersFile) return readModule(ctx, p.helpersFile);
  if (ctx.options.helpers) return readModule(ctx, resolve(ctx.root, ctx.options.helpers));
  const ts = [p.types, p.actionsFile].some((f) => f && /\.[cm]?tsx?$/.test(f)) || ctx.read(join(ctx.root, 'tsconfig.json')) !== null;
  return readModule(ctx, join(ctx.root, 'src', `sinter.helpers.${ts ? 'ts' : 'js'}`));
}

interface Imports {
  /** spec → value names */
  values: Map<string, Set<string>>;
  /** local name → spec, `import * as` */
  namespaces: Map<string, string>;
}

/** The imports `target` needs for names the function bodies use; null when one cannot be provided. */
function importsFor(ctx: ExtractContext, target: Module, kind: 'helpers' | 'actions', uses: Set<string>, helpersFile: string | null): Imports | null {
  const out: Imports = { values: new Map(), namespaces: new Map() };
  const add = (spec: string, name: string) => out.values.set(spec, (out.values.get(spec) ?? new Set()).add(name));
  const nsSpec = (module: string) => (module.startsWith('/') ? relativeSpec(target.file, join(ctx.root, module), true) : module);
  const { helpers, actions } = ctx.project;
  for (const u of uses) {
    if (target.bound.has(u)) continue;
    if (BUILTIN_HELPERS.includes(u) && !helpers.names.includes(u)) add(PACKAGE, u);
    else if (helpers.namespaces[u]) out.namespaces.set(u, nsSpec(helpers.namespaces[u].module));
    else if (kind === 'actions' && actions.namespaces[u]) out.namespaces.set(u, nsSpec(actions.namespaces[u].module));
    else if (kind === 'actions' && helpers.names.includes(u) && helpersFile) add(relativeSpec(target.file, helpersFile, false), u);
    // a helper the helpers module re-exports, or an action it does not declare itself
    else return null;
  }
  return out;
}

// ---- planning

const CAP = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const IDENT = /^[A-Za-z_$][\w$]*$/;

/** a name from the attribute: `textValue`, `showValue`; a URL interpolation is a `urlPart` */
function valueName(attr: string): string {
  const stem = attr.replace(/^data-sn-/, '');
  if (/^(get|post|put|patch|delete|src)$/.test(stem)) return 'urlPart';
  const camel = stem.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase()).replace(/[^\w$]/g, '');
  return IDENT.test(camel) ? `${camel}Value` : 'extracted';
}

/** Names a new function must not take: everything a page's expression or the modules could mean by it. */
function takenNames(ctx: ExtractContext, modules: Module[]): Set<string> {
  const { helpers, actions } = ctx.project;
  const taken = new Set<string>([
    ...helpers.names, ...Object.keys(helpers.namespaces), ...actions.names, ...Object.keys(actions.namespaces),
    ...BUILTIN_HELPERS, ...STORE_FNS, ...GLOBALS, ...ALL_MAGIC, 'ctx',
  ]);
  for (const unit of ctx.units) {
    for (const r of unit.resources) taken.add(r.name);
    for (const f of unit.frames) {
      if (f.kind === 'state') for (const n of f.names) taken.add(n);
      else if (f.kind === 'loop') { taken.add(f.item); if (f.index) taken.add(f.index); }
      else taken.add(f.name);
    }
  }
  for (const m of modules) for (const n of m.bound) taken.add(n);
  return taken;
}

function unique(base: string, taken: Set<string>): string {
  let name = base;
  for (let i = 2; taken.has(name); i++) name = `${base}${i}`;
  taken.add(name);
  return name;
}

/**
 * The extractions offered for a selection (`range`) in `ctx.file`. `whole`: the range is a
 * diagnostic's, covering an attribute; the expression in it is extracted as a whole. Each plan
 * has been compiled: none makes the page fail to build.
 */
export function plans(ctx: ExtractContext, range: Range, o: { whole?: boolean } = {}): Plan[] {
  const starts = lineStarts(ctx.text);
  const a = offsetAt(starts, range.start);
  const b = offsetAt(starts, range.end);
  const found = findExpr(ctx, starts, a, b, !!o.whole);
  if (!found) return [];
  const { unit, e, start, callArgs } = found;
  const src = e.src;

  let root: Node;
  const statements: Node[] = [];
  try {
    if (e.mode === 'value') root = acorn.parseExpressionAt(src, 0, PARSE) as Node;
    else {
      root = acorn.parse(src, PARSE) as Node;
      for (const st of (root as unknown as acorn.Program).body) {
        if (st.type === 'EmptyStatement') continue;
        if (st.type !== 'ExpressionStatement') return [];
        statements.push(st.expression as Node);
      }
    }
  } catch {
    return [];
  }

  // the selection inside `src`, without surrounding blanks; the callee of a call counts as all of it
  const whole = !!o.whole || a < start || (a <= start && b >= start + src.length);
  let ra = Math.max(0, a - start);
  let rb = Math.min(src.length, b - start);
  while (ra < rb && /\s/.test(src[ra]!)) ra++;
  while (rb > ra && /\s/.test(src[rb - 1]!)) rb--;
  const empty = whole || ra === rb;

  const scopeNames = new Set<string>([...(e.payload?.names ?? []), ...unit.resources.map((r) => r.name)]);
  for (const i of e.frames) {
    const f = unit.frames[i]!;
    if (f.kind === 'state') for (const n of f.names) scopeNames.add(n);
    else if (f.kind === 'loop') { scopeNames.add(f.item); if (f.index) scopeNames.add(f.index); }
    else scopeNames.add(f.name);
  }
  const { helpers, actions } = ctx.project;
  const helperish = (n: string) => helpers.names.includes(n) || !!helpers.namespaces[n] || BUILTIN_HELPERS.includes(n);

  const helperMod = helpersModule(ctx);
  const actionMod = ctx.project.actionsFile ? readModule(ctx, ctx.project.actionsFile) : null;
  const allSites = sites(root);
  const siteOf = (n: Node) => allSites.find((s) => s.node === n)!;

  /** a function returning `nodes` (one: its value; several: an object of them under `keys`) */
  const fnOf = (nodes: Node[], name: string, keys?: string[]): Fn | null => {
    const params: Param[] = [];
    const byArg = new Map<string, Param>();
    const uses = new Set<string>();
    const renames: Array<{ start: number; end: number; name: string }> = [];
    const names = new Set<string>();
    const pending: Array<{ ref: Ref; base: string }> = [];
    for (const n of nodes) {
      for (const ref of refsOf(n, siteOf(n).bound)) {
        if (ref.local || scopeNames.has(ref.name) || ALL_MAGIC.includes(ref.name)) {
          pending.push({ ref, base: ref.name });
        } else if (ref.name.startsWith('$meta.')) {
          pending.push({ ref, base: `${ref.name.slice(6)}Meta` });
        } else if (helperish(ref.name)) {
          uses.add(ref.name);
        } else if (GLOBALS.has(ref.name)) {
          continue;
        } else {
          // a store function, an action or a name the compiler did not resolve
          return null;
        }
      }
    }
    for (const { ref } of pending) if (!ref.name.startsWith('$meta.')) names.add(ref.name);
    for (const { ref, base } of pending) {
      let p = byArg.get(ref.name);
      if (!p) {
        let pname = base;
        if (ref.name.startsWith('$meta.')) {
          for (let i = 2; names.has(pname) || uses.has(pname) || GLOBALS.has(pname); i++) pname = `${base}${i}`;
          names.add(pname);
        }
        p = { name: pname, arg: ref.name, at: start + ref.at };
        byArg.set(ref.name, p);
        params.push(p);
      }
      if (p.name !== ref.name) renames.push({ start: ref.start, end: ref.end, name: p.name });
    }
    const text = (n: Node) => {
      let s = '';
      let at = n.start;
      for (const r of renames.filter((x) => x.start >= n.start && x.end <= n.end).sort((x, y) => x.start - y.start)) {
        s += src.slice(at, r.start) + r.name;
        at = r.end;
      }
      s += src.slice(at, n.end);
      return n.type === 'SequenceExpression' ? `(${s})` : s;
    };
    const body = keys
      ? `{\n${nodes.map((n, i) => `    ${IDENT.test(keys[i]!) ? keys[i] : JSON.stringify(keys[i])}: ${text(n)},`).join('\n')}\n  }`
      : text(nodes[0]!);
    return { name, params, body, uses };
  };
  const call = (f: Fn) => `${f.name}(${f.params.map((p) => p.arg).join(', ')})`;

  const out: Plan[] = [];
  const helperTitle = (f: Fn) => `Extract to helper \`${f.name}\` in ${relative(ctx.root, helperMod.file).split('\\').join('/')}`;
  const pure = (n: Node) => e.mode === 'value' || !impurity(n, scopeNames);

  /** one helper returning `node`, called in its place */
  const helperPlan = (node: Node, base: string) => {
    if (trivial(node) || !pure(node)) return;
    const taken = takenNames(ctx, [helperMod, ...(actionMod ? [actionMod] : [])]);
    const f = fnOf([node], unique(base, taken));
    if (f) out.push({ title: helperTitle(f), target: 'helpers', fns: [f], html: [{ start: start + node.start, end: start + node.end, text: call(f) }] });
  };

  type Assign = { node: Node; left: Node; right: Node; path: string[] | null; op: string };
  const assignment = (n: Node): Assign | null =>
    n.type === 'AssignmentExpression' ? { node: n, left: n.left as Node, right: n.right as Node, path: staticPath(n.left as Node), op: n.operator } : null;
  const assignBase = (x: Assign) => `next${CAP(x.path ? x.path[x.path.length - 1]!.replace(/^\$/, '') : 'value')}`;

  /** several assignments: one helper per computed value, and one returning an object when they write one state object */
  const assignmentsPlans = (stmts: Node[]) => {
    const list = stmts.map(assignment).filter((x): x is Assign => !!x);
    const worth = list.filter((x) => !trivial(x.right) && pure(x.right));
    if (worth.length >= 2) {
      const taken = takenNames(ctx, [helperMod, ...(actionMod ? [actionMod] : [])]);
      const fns: Fn[] = [];
      for (const x of worth) {
        const f = fnOf([x.right], unique(assignBase(x), taken));
        if (!f) return;
        fns.push(f);
      }
      out.push({
        title: `Extract ${fns.length} computed values to helpers (${fns.map((f) => `\`${f.name}\``).join(', ')})`,
        target: 'helpers', fns,
        html: worth.map((x, i) => ({ start: start + x.right.start, end: start + x.right.end, text: call(fns[i]!) })),
      });
    }
    // Object.assign(draft, draftChanges(…)): consecutive `=` to properties of one object,
    // none reading what an earlier one wrote
    if (list.length < 2 || list.length !== stmts.length) return;
    const parent = list[0]!.path?.slice(0, -1);
    if (!parent?.length || parent[0]!.startsWith('$')) return;
    const keys: string[] = [];
    for (const x of list) {
      if (x.op !== '=' || !x.path || x.path.length !== parent.length + 1 || x.path.slice(0, -1).join('.') !== parent.join('.') || !pure(x.right)) return;
      if (keys.includes(x.path[x.path.length - 1]!)) return;
      keys.push(x.path[x.path.length - 1]!);
    }
    const written: string[][] = [];
    for (const x of list) {
      for (const r of readPaths(x.right)) {
        if (written.some((w) => w.every((s, i) => r[i] === undefined || r[i] === s) || r.every((s, i) => w[i] === s))) return;
      }
      written.push(x.path!);
    }
    const taken = takenNames(ctx, [helperMod, ...(actionMod ? [actionMod] : [])]);
    const f = fnOf(list.map((x) => x.right), unique(`${parent[parent.length - 1]!}Changes`, taken), keys);
    if (!f) return;
    out.push({
      title: `Extract the ${list.length} assignments to helper \`${f.name}\` (returns an object, merged with Object.assign)`,
      target: 'helpers', fns: [f],
      html: [{ start: start + list[0]!.node.start, end: start + list[list.length - 1]!.node.end, text: `Object.assign(${parent.join('.')}, ${call(f)})` }],
    });
  };

  /** the static paths an expression reads, cut at the first computed or call step */
  const readPaths = (n: Node): string[][] => {
    const paths: string[][] = [];
    for (const s of sites(n)) {
      if (s.parent && s.parent.type === 'MemberExpression' && s.key === 'object') continue;
      if (s.parent && s.parent.type === 'MemberExpression' && s.key === 'property' && !s.parent.computed) continue;
      if (s.parent?.type === 'Property' && s.key === 'key' && !s.parent.computed) continue;
      let cur = s.node;
      while (cur.type === 'MemberExpression' && (cur.computed || !staticPath(cur))) cur = cur.object as Node;
      const p = staticPath(cur);
      if (p && !s.bound.has(p[0]!)) paths.push(p);
    }
    return paths;
  };

  /** the smallest replaceable expression covering the selection */
  const covering = (): Site | null => {
    let best: Site | null = null;
    for (const s of allSites) {
      if (s.node.start > ra || s.node.end < rb || !extractable(s)) continue;
      if (!best || s.node.end - s.node.start < best.node.end - best.node.start) best = s;
    }
    return best;
  };

  if (callArgs) {
    const args = (root as acorn.ArrayExpression).elements.filter((x): x is acorn.Expression => !!x && x.type !== 'SpreadElement') as Node[];
    const inArg = args.find((x) => x.start <= ra && x.end >= rb);
    if (empty || !inArg) {
      actionPlan();
      if (!whole && inArg) helperPlan(inArg, valueName(found.attr));
    } else {
      const s = covering();
      if (s && s.node !== root) helperPlan(s.node, valueName(found.attr));
    }
  } else if (e.mode === 'value') {
    if (empty) helperPlan(root, valueName(found.attr));
    else {
      const s = covering();
      if (s) helperPlan(s.node, valueName(found.attr));
    }
  } else {
    const touched = empty && !whole
      ? statements.filter((st) => st.start <= ra && st.end >= ra)
      : whole ? statements : statements.filter((st) => st.end > ra && st.start < rb);
    if (whole || touched.length > 1) {
      const list = touched.map(assignment).filter((x): x is Assign => !!x);
      if (list.length === 1) helperPlan(list[0]!.right, assignBase(list[0]!));
      else assignmentsPlans(touched);
    } else if (touched.length === 1) {
      const st = touched[0]!;
      const x = assignment(st);
      if (empty) {
        if (x) helperPlan(x.right, assignBase(x));
        const all = statements.map(assignment).filter(Boolean);
        if (x && all.length >= 2) assignmentsPlans(statements);
      } else {
        const s = covering();
        if (s && x && (s.node === x.node || (s.node.start <= x.left.start && s.node.end >= x.right.end))) helperPlan(x.right, assignBase(x));
        else if (s && !(x && s.node.start < x.left.end)) helperPlan(s.node, x ? assignBase(x) : valueName(found.attr));
      }
    }
  }

  /** `data-sn-call="mail.send(buildMime(draft), to)"` → a new action that makes the call */
  function actionPlan() {
    if (!actionMod || actionMod.text === null) return;
    const callee = ctx.text.slice(found!.valueStart, start).replace(/\($/, '').trim();
    const m = /^([\w$]+)(?:\.([\w$]+))?$/.exec(callee);
    if (!m) return;
    const taken = takenNames(ctx, [helperMod, actionMod]);
    const f = fnOf([root], unique(`run${CAP(m[2] ?? m[1]!)}`, taken));
    if (!f) return;
    f.uses.add(m[1]!);
    const inner = f.body.slice(1, -1).trim();
    const ctxName = ['ctx', 'context', '$ctx'].find((n) => !f.params.some((p) => p.name === n) && !f.uses.has(n))!;
    f.ctx = ctxName;
    f.body = `${callee}(${inner ? `${inner}, ` : ''}${ctxName})`;
    out.push({
      title: `Extract to action \`${f.name}\` in ${relative(ctx.root, actionMod.file).split('\\').join('/')}`,
      target: 'actions', fns: [f],
      html: [{ start: found!.valueStart, end: start + src.length, text: call(f) }],
    });
  }

  // compile each before offering it: no new errors in this file
  if (!out.length) return out;
  const key = (d: Diagnostic) => `${d.code}\0${d.message}`;
  const before = new Set(ctx.trial(ctx.text, helpers, actions).map(key));
  return out.filter((plan) => {
    const mod = plan.target === 'helpers' ? helperMod : actionMod!;
    if (mod.text === null && !ctx.canCreate) return false;
    const uses = new Set(plan.fns.flatMap((f) => [...f.uses]));
    if (!importsFor(ctx, mod, plan.target, uses, ctx.project.helpersFile)) return false;
    let text = ctx.text;
    for (const h of [...plan.html].sort((x, y) => y.start - x.start)) text = text.slice(0, h.start) + h.text + text.slice(h.end);
    const names = plan.fns.map((f) => f.name);
    const h2: HelperManifest = plan.target === 'helpers' ? { ...helpers, module: helpers.module ?? helperMod.url, names: [...helpers.names, ...names] } : helpers;
    const a2: HelperManifest = plan.target === 'actions' ? { ...actions, names: [...actions.names, ...names] } : actions;
    return ctx.trial(text, h2, a2).every((d) => before.has(key(d)));
  });
}

// ---- types

/** Internal declarations of `sinter check` that app code cannot import. */
const INTERNAL_TYPES = new Set(['Err', 'El', 'Ev', 'Item', 'Attrs', 'Store', 'PathValue', 'CallArgs']);
/** Types the package exports. */
const PACKAGE_TYPES = new Set(['Meta', 'CallContext']);

/**
 * The type in TypeScript's hover text for a name (`let query: string`, `const i: 0`,
 * `(property) contacts: Meta`), widened like a parameter would be; null when there is none.
 */
export function typeFromHover(hover: string): string | null {
  const m = /^(?:\(([\w ]+)\)\s+)?(?:(const|let|var)\s+)?[\w$]+\??:\s*([^]+)$/.exec(hover.trim());
  if (!m) return null;
  // one line: an object type's members as TypeScript prints them, `{ to: string; body: string; }`
  const t = m[3]!.trim().replace(/\s*\n\s*/g, ' ');
  if (/^-?\d[\d_.e+-]*n?$/.test(t)) return t.endsWith('n') ? 'bigint' : 'number';
  if (/^(["'`]).*\1$/.test(t)) return 'string';
  if (t === 'true' || t === 'false') return 'boolean';
  return t;
}

/** A type the module can write, with the names it imports from the types module and the package; null when it cannot. */
function importable(t: string, typeNames: string[]): { text: string; types: string[]; pkg: string[] } | null {
  if (/\.\.\.|import\(|\$O\d|\btypeof\b/.test(t)) return null;
  const plain = t.replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, '""');
  const types = new Set<string>();
  const pkg = new Set<string>();
  for (const m of plain.matchAll(/(?<![\w$.])[A-Za-z_$][\w$]*/g)) {
    const n = m[0];
    if (typeNames.includes(n)) types.add(n);
    else if (PACKAGE_TYPES.has(n)) pkg.add(n);
    else if (INTERNAL_TYPES.has(n)) return null;
  }
  return { text: t, types: [...types], pkg: [...pkg] };
}

// ---- the edit

/** The workspace edit for a plan: the call in the HTML, the function (and its imports) in the module. */
export async function editFor(ctx: ExtractContext, plan: Plan, uriOf: (file: string) => string): Promise<WorkspaceEdit> {
  const helperMod = helpersModule(ctx);
  const mod = plan.target === 'helpers' ? helperMod : readModule(ctx, ctx.project.actionsFile!);
  const starts = lineStarts(ctx.text);
  const uses = new Set(plan.fns.flatMap((f) => [...f.uses]));
  const imports = importsFor(ctx, mod, plan.target, uses, ctx.project.helpersFile)!;
  const typeImports = new Map<string, Set<string>>();
  const typesSpec = ctx.project.types ? relativeSpec(mod.file, ctx.project.types, false) : null;

  /** the parameter's type as the module writes it */
  const typeOf = async (p: Param): Promise<string> => {
    const pos = positionAt(starts, p.at);
    const hover = ctx.typeAt ? await ctx.typeAt(pos.line + 1, pos.character + 1) : null;
    const t = hover ? typeFromHover(hover) : null;
    const ok = t ? importable(t, ctx.typeNames) : null;
    if (!ok || (ok.types.length && !typesSpec)) return 'unknown';
    const need = (spec: string, names: string[]) => { for (const n of names) typeImports.set(spec, (typeImports.get(spec) ?? new Set()).add(n)); };
    if (mod.ts) {
      need(typesSpec!, ok.types.filter((n) => !mod.bound.has(n)));
      need(PACKAGE, ok.pkg.filter((n) => !mod.bound.has(n)));
      return ok.text;
    }
    // JSDoc: types from elsewhere are written as `import('…').Name`
    return ok.text.replace(/(?<![\w$.'"])[A-Za-z_$][\w$]*(?![\w$'"])/g, (n) =>
      ok.types.includes(n) ? `import('${typesSpec}').${n}` : ok.pkg.includes(n) ? `import('${PACKAGE}').${n}` : n);
  };

  const blocks: string[] = [];
  for (const f of plan.fns) {
    const params: Array<{ name: string; type: string }> = [];
    for (const p of f.params) params.push({ name: p.name, type: await typeOf(p) });
    if (f.ctx) {
      if (mod.ts && !mod.bound.has('CallContext')) typeImports.set(PACKAGE, (typeImports.get(PACKAGE) ?? new Set()).add('CallContext'));
      params.push({ name: f.ctx, type: mod.ts ? 'CallContext' : `import('${PACKAGE}').CallContext` });
    }
    const ret = `  return ${f.body};`;
    if (mod.ts) {
      blocks.push(`export function ${f.name}(${params.map((p) => `${p.name}: ${p.type}`).join(', ')}) {\n${ret}\n}\n`);
    } else {
      const doc = params.length ? `/**\n${params.map((p) => ` * @param {${p.type}} ${p.name}`).join('\n')}\n */\n` : '';
      blocks.push(`${doc}export function ${f.name}(${params.map((p) => p.name).join(', ')}) {\n${ret}\n}\n`);
    }
  }

  const importLines: string[] = [];
  for (const [spec, names] of typeImports) if (names.size) importLines.push(`import type { ${[...names].sort().join(', ')} } from '${spec}';`);
  for (const [spec, names] of imports.values) importLines.push(`import { ${[...names].sort().join(', ')} } from '${spec}';`);
  for (const [local, spec] of imports.namespaces) importLines.push(`import * as ${local} from '${spec}';`);

  const htmlUri = uriOf(ctx.file);
  const htmlEdits = plan.html.map((h) => ({ range: rangeOf(starts, h.start, h.end), newText: h.text }));
  const modUri = uriOf(mod.file);
  if (mod.text === null) {
    const text = (importLines.length ? importLines.join('\n') + '\n\n' : '') + blocks.join('\n');
    const zero = { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } };
    return {
      documentChanges: [
        { kind: 'create', uri: modUri, options: { ignoreIfExists: true } },
        { textDocument: { uri: modUri, version: null }, edits: [{ range: zero, newText: text }] },
        { textDocument: { uri: htmlUri, version: null }, edits: htmlEdits },
      ],
    };
  }
  const ms = lineStarts(mod.text);
  const end = mod.text.length;
  // a module without imports gets them at the top, then a blank line
  const imported = importLines.length ? importLines.join('\n') + '\n' + (mod.importsEnd === 0 ? '\n' : '') : '';
  const sep = mod.text.trim() === '' ? '' : mod.text.endsWith('\n\n') ? '' : mod.text.endsWith('\n') ? '\n' : '\n\n';
  const modEdits: TextEdit[] = mod.text.slice(mod.importsEnd).trim() === ''
    // nothing after the imports: one insertion, so the order of the two is not the client's to choose
    ? [{ range: rangeOf(ms, mod.importsEnd, end), newText: imported + blocks.join('\n') }]
    : [
      ...(imported ? [{ range: rangeOf(ms, mod.importsEnd, mod.importsEnd), newText: imported }] : []),
      { range: rangeOf(ms, end, end), newText: sep + blocks.join('\n') },
    ];
  return { changes: { [htmlUri]: htmlEdits, [modUri]: modEdits } };
}

/**
 * The extract quick fix for a diagnostic about one expression: its range covers the attribute
 * (or the expression), and the expression is extracted as a whole. For the complexity warning:
 * `server.ts` offers it for the codes in `EXTRACT_FIX_CODES`.
 */
export function fixPlans(ctx: ExtractContext, diagnostic: { range: Range }): Plan[] {
  return plans(ctx, diagnostic.range, { whole: true });
}
