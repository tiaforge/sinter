// Expressions parsed once per source text. A build compiles many pages, and the same expressions recur in
// every page and at every node of a component tree (`$slot.node.url` in each link of a markdown article):
// acorn's parse was a quarter of a build's time (docs/proposals/collections.md#prototype). A parse depends only
// on its text and options, so its tree is kept and shared. Trees are frozen, at every depth: a shared tree
// changed by one caller would change it for the next, so a write throws instead of corrupting a later page.
import * as acorn from 'acorn';

type Options = Pick<acorn.Options, 'ecmaVersion' | 'sourceType' | 'allowAwaitOutsideFunction' | 'preserveParens'>;
type Kept = { ast: acorn.AnyNode } | { error: unknown };

/** the most trees kept; past it the cache starts over (source texts are short, and a site has a few thousand) */
const LIMIT = 50_000;
/**
 * By kind and options, then by the text itself: the text is the attribute's own string, whose hash the engine keeps,
 * where one key made of both was a new string to hash at every lookup (7% of a component tree's compile)
 */
const kept = new Map<string, Map<string, Kept>>();
let count = 0;

const optionsKey = (kind: string, o: Options) =>
  `${kind}\0${o.ecmaVersion ?? ''}\0${o.sourceType ?? ''}\0${o.allowAwaitOutsideFunction ? 1 : 0}\0${o.preserveParens ? 1 : 0}`;

function freeze<T>(v: T): T {
  if (v && typeof v === 'object' && !Object.isFrozen(v)) {
    Object.freeze(v);
    for (const x of Object.values(v)) freeze(x);
  }
  return v;
}

function cached<T extends acorn.AnyNode>(kind: string, src: string, o: Options, parse: () => T): T {
  const outer = optionsKey(kind, o);
  let texts = kept.get(outer);
  if (!texts) kept.set(outer, (texts = new Map()));
  let k = texts.get(src);
  if (!k) {
    try { k = { ast: freeze(parse()) }; } catch (error) { k = { error }; }
    if (++count > LIMIT) { kept.clear(); count = 1; kept.set(outer, (texts = new Map())); }
    texts.set(src, k);
  }
  if ('error' in k) throw k.error;
  return k.ast as T;
}

/** `acorn.parseExpressionAt(src, 0, options)`, parsed once per text and options; the tree is frozen */
export function parseExpression(src: string, options: Options = { ecmaVersion: 'latest' }): acorn.Expression {
  return cached('e', src, options, () => acorn.parseExpressionAt(src, 0, options as acorn.Options));
}

/** `acorn.parse(src, options)`, parsed once per text and options; the tree is frozen */
export function parseProgram(src: string, options: Options = { ecmaVersion: 'latest' }): acorn.Program {
  return cached('p', src, options, () => acorn.parse(src, options as acorn.Options));
}

/** names a binding pattern binds (`x`, `{ a, b: [c] }`, `...rest`, `d = 1`), added to `out` */
export function patternNames(p: any, out: Set<string> = new Set()): Set<string> {
  if (!p) return out;
  if (p.type === 'Identifier') out.add(p.name);
  else if (p.type === 'ObjectPattern') for (const x of p.properties) patternNames(x.type === 'RestElement' ? x.argument : x.value, out);
  else if (p.type === 'ArrayPattern') for (const x of p.elements) patternNames(x, out);
  else if (p.type === 'RestElement') patternNames(p.argument, out);
  else if (p.type === 'AssignmentPattern') patternNames(p.left, out);
  return out;
}

/**
 * Each free reference in a tree: an identifier that names something outside it. Not a member's name (`x.node`), an
 * object literal's or a class's key (`{ node: … }`), a label, nor a name the tree binds itself where it is in scope
 * (a function's parameters and own name, a catch's parameter, a block's `let`/`const`/classes/functions, a
 * function's `var`s; destructured or not). `shorthand`: the property `{ node }` whose value it is, where writing the
 * reference out takes the key too. A name assigned (`x = 1`, `x++`) is a reference.
 */
export function freeRefs(ast: acorn.Node, ref: (id: acorn.Identifier, shorthand: acorn.Property | null) => void): void {
  /** the names declared directly in `stmts`; `vars`: also the `var`s and functions of a function's body (not of the functions in it) */
  const declared = (stmts: any[], into: Set<string>, vars: boolean): Set<string> => {
    for (const s of stmts) {
      if (s.type === 'VariableDeclaration' && s.kind !== 'var') for (const d of s.declarations) patternNames(d.id, into);
      else if ((s.type === 'ClassDeclaration' || s.type === 'FunctionDeclaration') && s.id) into.add(s.id.name);
    }
    if (vars) {
      const go = (n: any): void => {
        if (!n || typeof n.type !== 'string') return;
        if (n.type === 'VariableDeclaration' && n.kind === 'var') for (const d of n.declarations) patternNames(d.id, into);
        if (n.type === 'FunctionDeclaration') { if (n.id) into.add(n.id.name); return; }
        if (n.type === 'FunctionExpression' || n.type === 'ArrowFunctionExpression' || n.type === 'ClassDeclaration' || n.type === 'ClassExpression') return;
        for (const k of Object.keys(n)) {
          const v = n[k];
          if (Array.isArray(v)) v.forEach(go); else if (v && typeof v.type === 'string') go(v);
        }
      };
      stmts.forEach(go);
    }
    return into;
  };
  /** a binding pattern: its names are bound by the caller; its defaults and computed keys are read */
  const pattern = (p: any, bound: Set<string>): void => {
    if (!p || p.type === 'Identifier') return;
    if (p.type === 'ObjectPattern') {
      for (const x of p.properties) {
        if (x.type === 'RestElement') pattern(x.argument, bound);
        else { if (x.computed) visit(x.key, bound); pattern(x.value, bound); }
      }
    } else if (p.type === 'ArrayPattern') for (const x of p.elements) pattern(x, bound);
    else if (p.type === 'RestElement') pattern(p.argument, bound);
    else if (p.type === 'AssignmentPattern') { pattern(p.left, bound); visit(p.right, bound); }
    else visit(p, bound);
  };
  const visit = (n: any, bound: Set<string>): void => {
    if (!n || typeof n.type !== 'string') return;
    switch (n.type) {
      case 'Identifier': if (!bound.has(n.name)) ref(n, null); return;
      case 'MemberExpression': visit(n.object, bound); if (n.computed) visit(n.property, bound); return;
      case 'Property': case 'PropertyDefinition': case 'MethodDefinition':
        if (n.computed) visit(n.key, bound);
        if (n.shorthand && n.value.type === 'Identifier') { if (!bound.has(n.value.name)) ref(n.value, n); return; }
        visit(n.value, bound);
        return;
      case 'LabeledStatement': visit(n.body, bound); return;
      case 'BreakStatement': case 'ContinueStatement': case 'MetaProperty': case 'ImportDeclaration': case 'ExportAllDeclaration': return;
      case 'ExportNamedDeclaration': visit(n.declaration, bound); if (!n.source) for (const s of n.specifiers) visit(s.local, bound); return;
      case 'Program': { const inner = declared(n.body, new Set(bound), true); for (const s of n.body) visit(s, inner); return; }
      case 'BlockStatement': case 'StaticBlock': { const inner = declared(n.body, new Set(bound), false); for (const s of n.body) visit(s, inner); return; }
      case 'SwitchStatement': {
        visit(n.discriminant, bound);
        const inner = declared(n.cases.flatMap((c: any) => c.consequent), new Set(bound), false);
        for (const c of n.cases) { visit(c.test, inner); for (const s of c.consequent) visit(s, inner); }
        return;
      }
      case 'ForStatement': case 'ForInStatement': case 'ForOfStatement': {
        const head = n.type === 'ForStatement' ? n.init : n.left;
        const inner = head?.type === 'VariableDeclaration' ? declared([head], new Set(bound), false) : bound;
        for (const k of ['init', 'test', 'update', 'left', 'right', 'body']) visit(n[k], inner);
        return;
      }
      case 'VariableDeclarator': pattern(n.id, bound); visit(n.init, bound); return;
      case 'CatchClause': {
        const inner = patternNames(n.param, new Set(bound));
        pattern(n.param, inner);
        visit(n.body, inner);
        return;
      }
      case 'FunctionDeclaration': case 'FunctionExpression': case 'ArrowFunctionExpression': {
        const inner = new Set(bound);
        if (n.type === 'FunctionExpression' && n.id) inner.add(n.id.name);
        for (const p of n.params) patternNames(p, inner);
        // defaults are evaluated in the function's scope
        for (const p of n.params) pattern(p, inner);
        if (n.body.type !== 'BlockStatement') { visit(n.body, inner); return; }
        const body = declared(n.body.body, inner, true);
        for (const s of n.body.body) visit(s, body);
        return;
      }
      case 'ClassDeclaration': case 'ClassExpression': {
        const inner = n.type === 'ClassExpression' && n.id ? new Set([...bound, n.id.name]) : bound;
        visit(n.superClass, inner);
        visit(n.body, inner);
        return;
      }
    }
    for (const k of Object.keys(n)) {
      if (k === 'type' || k === 'start' || k === 'end') continue;
      const v = n[k];
      if (Array.isArray(v)) for (const c of v) visit(c, bound);
      else if (v && typeof v === 'object') visit(v, bound);
    }
  };
  visit(ast, new Set());
}
