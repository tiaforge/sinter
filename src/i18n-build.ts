// Build side of the built-in messages: reading the inlang project, the generated types, which
// keys a module uses, the per-page language files and the picker script. Node only.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { ancestor, base, simple } from 'acorn-walk';
import { lineCol } from './line-col.js';
import { parseModule } from './compiler/index.js';
import type { Diagnostic } from './compiler/index.js';

export { MESSAGES as MESSAGES_MODULE } from './compiler/index.js';
import { MESSAGES as MESSAGES_MODULE } from './compiler/index.js';

/**
 * The message keys a module uses through `m` imported from the messages module: `m.key` only.
 * Any other use of `m` (`m[k]`, passing `m` on) is an error, since the page's language file could
 * not be cut to what it uses.
 */
export function moduleKeys(code: string, id: string, from: string = MESSAGES_MODULE, exported = 'm', nested = false): { keys: string[]; errors: string[] } {
  if (!code.includes(from)) return { keys: [], errors: [] };
  let ast: ReturnType<typeof parseModule>;
  try { ast = parseModule(code, id.replace(/\?.*$/, '')); } catch { return { keys: [], errors: [] }; }
  const names = new Set<string>(), locals = new Set<unknown>();
  for (const st of ast.body) {
    if (st.type !== 'ImportDeclaration' || st.source.value !== from) continue;
    for (const s of st.specifiers) {
      if (s.type === 'ImportSpecifier' && (s.imported.type === 'Identifier' ? s.imported.name : s.imported.value) === exported) { names.add(s.local.name); locals.add(s.local); }
    }
  }
  if (!names.size) return { keys: [], errors: [] };
  const keys = new Set<string>(), errors: string[] = [], ok = new Set<unknown>(locals);
  const where = (pos: number) => { const { line, col } = lineCol(code, pos); return `${id}:${line}:${col}`; };
  ancestor(ast as never, {
    MemberExpression(n: any, _st: unknown, anc: any[]) {
      if (n.object.type === 'Identifier' && names.has(n.object.name)) {
        ok.add(n.object);
        if (n.computed || n.property.type !== 'Identifier') { errors.push(`${where(n.start)}: \`${n.object.name}[…]\`: messages are named literally (\`m.key()\`), so each page's language file holds only what it uses`); return; }
        // a nested id (`m.inbox.title`): the whole chain of names
        let key = n.property.name, at = n;
        if (nested) for (let i = anc.length - 2; i >= 0; i--) {
          const p = anc[i];
          if (p.type !== 'MemberExpression' || p.object !== at || p.computed || p.property.type !== 'Identifier') break;
          key += '.' + p.property.name;
          at = p;
        }
        keys.add(key);
      }
    },
  }, tsBase as never);
  simple(ast as never, {
    Identifier(n: any) {
      if (names.has(n.name) && !ok.has(n)) errors.push(`${where(n.start)}: \`${n.name}\` is used other than as \`${n.name}.key\`; call messages by name, e.g. \`${n.name}.nav_mail()\``);
    },
  }, tsBase as never);
  return { keys: [...keys].sort(), errors };
}

/**
 * The messages module's own value exports that read entries by a key the build does not see (src/messages.ts): `t(key)`,
 * and `state()`, whose `dicts` hold every entry. Any other name it exports reads none (`getLocale`, `install`, the
 * types), and a name not listed here is allowed: an import of it is no way to an entry.
 */
export const READS_BY_KEY = ['t', 'state'];

/** a way a module reaches the messages module that its statements decide (`statementReach`): where, which, the name */
export interface Reach { pos: number; how: 'namespace' | 'default' | 'import' | 'reexport' | 'export' | 'dynamic'; name: string }

const textOfNode = (n: any): unknown => (n?.type === 'Literal' ? n.value : n?.type === 'TemplateLiteral' && n.expressions.length === 0 ? n.quasis[0]?.value.cooked : undefined);
const nameOf = (n: any): string => (n?.type === 'Identifier' ? n.name : String(n?.value));

/**
 * SN350's reading: the ways a module reaches the namespace's module `from` that are decided exactly by its import and
 * export statements and by where the module is named, with no reading of what its identifiers refer to. A namespace or
 * default import; a named import of an export in `reads`; `export { m }` (or `export default m`) of the import, and
 * `export … from` / `export *` of the module when it passes on `exported` or an export in `reads`; `import()`,
 * `require()` and TypeScript's `import x = require()` of it. Types (`import type`, `{ type X }`) are never a way. Null for
 * none, and for a module that does not parse (its transform reports that).
 */
export function statementReach(code: string, id: string, from: string = MESSAGES_MODULE, exported = 'm', reads: readonly string[] = READS_BY_KEY): Reach | null {
  if (!code.includes(from)) return null;
  let ast: ReturnType<typeof parseModule>;
  try { ast = parseModule(code, id.replace(/\?.*$/, '')); } catch { return null; }
  const passes = new Set([exported, ...reads]), locals = new Set<string>();
  for (const st of ast.body as any[]) {
    if (st.type !== 'ImportDeclaration' || textOfNode(st.source) !== from || st.importKind === 'type') continue;
    for (const sp of st.specifiers) {
      if (sp.type === 'ImportNamespaceSpecifier') return { pos: sp.start, how: 'namespace', name: sp.local.name };
      if (sp.type === 'ImportDefaultSpecifier') return { pos: sp.start, how: 'default', name: sp.local.name };
      if (sp.importKind === 'type') continue;
      const name = nameOf(sp.imported);
      if (name === exported) locals.add(sp.local.name);
      else if (reads.includes(name)) return { pos: sp.start, how: 'import', name };
    }
  }
  for (const st of ast.body as any[]) {
    if (st.type === 'ExportAllDeclaration' && textOfNode(st.source) === from && st.exportKind !== 'type') return { pos: st.start, how: 'reexport', name: '*' };
    if (st.type === 'ExportNamedDeclaration' && st.exportKind !== 'type') for (const sp of st.specifiers ?? []) {
      if (sp.exportKind === 'type') continue;
      const local = nameOf(sp.local);
      if (st.source ? textOfNode(st.source) === from && passes.has(local) : locals.has(local)) return { pos: sp.start, how: st.source ? 'reexport' : 'export', name: local };
    }
    if (st.type === 'ExportDefaultDeclaration' && st.declaration?.type === 'Identifier' && locals.has(st.declaration.name)) return { pos: st.declaration.start, how: 'export', name: st.declaration.name };
  }
  let out: Reach | null = null;
  const visit = (n: any) => {
    if (out || !n || typeof n.type !== 'string') return;
    if ((n.type === 'ImportExpression' && textOfNode(n.source) === from) || (n.type === 'TSExternalModuleReference' && textOfNode(n.expression) === from)
      || (n.type === 'CallExpression' && n.callee?.type === 'Identifier' && n.callee.name === 'require' && textOfNode(n.arguments[0]) === from)) { out = { pos: n.start, how: 'dynamic', name: '' }; return; }
    for (const k of Object.keys(n)) {
      if (k === 'type' || k === 'start' || k === 'end' || k === 'loc' || k === 'range') continue;
      const v = n[k];
      if (Array.isArray(v)) for (const c of v) visit(c); else if (v && typeof v === 'object') visit(v);
    }
  };
  visit(ast);
  return out;
}

/**
 * Whether the entries a module can read of a namespace are the keys `moduleKeys` found for it (`keys`), and no more, so
 * that its uses may be rewritten (`inlineTexts`) and the page may keep only those keys for it (src/vite.ts). A yes needs
 * no way `statementReach` finds, and each occurrence of the name the module imports `exported` under to be `name.key`
 * with a key among `keys`, wherever it stands in the syntax tree (TypeScript's bodies, decorators, …), except where a name
 * is no reference: a property's own name, an enum member's, a label, the outer name of `export { x as m }`, a type.
 * Anything else is a no, among it another binding of the name (a parameter, `catch (m)`): the rewrite does not follow
 * scopes. A wrong yes would lose a text; a no only keeps more in the page. `keysWhy` says why not.
 */
export function keysOnly(code: string, id: string, from: string = MESSAGES_MODULE, exported = 'm', keys: string[] = moduleKeys(code, id, from, exported, true).keys): boolean {
  return keysWhy(code, id, from, exported, keys) === null;
}

/** why `keysOnly` says no, as `file:line:col: what`; null for a yes */
export function keysWhy(code: string, id: string, from: string = MESSAGES_MODULE, exported = 'm', keys: string[] = moduleKeys(code, id, from, exported, true).keys): string | null {
  if (!code.includes(from)) return null;
  let ast: ReturnType<typeof parseModule>;
  try { ast = parseModule(code, id.replace(/\?.*$/, '')); } catch { return `${id}: the module does not parse`; }
  const at = (pos: number) => { const { line, col } = lineCol(code, pos); return `${id}:${line}:${col}`; };
  const r = statementReach(code, id, from, exported);
  if (r) return `${at(r.pos)}: ${r.how === 'dynamic' ? '`import()` or `require()` of the module' : r.how === 'namespace' ? '`import * as`' : r.how === 'default' ? 'a default import' : `\`${r.name}\` ${r.how === 'import' ? 'imported' : 'passed on'}`}`;
  const names = new Set<string>(), known = new Set(keys);
  for (const st of ast.body as any[]) {
    if (st.type !== 'ImportDeclaration' || textOfNode(st.source) !== from || st.importKind === 'type') continue;
    for (const sp of st.specifiers) if (sp.type === 'ImportSpecifier' && sp.importKind !== 'type' && nameOf(sp.imported) === exported) names.add(sp.local.name);
  }
  let out: string | null = null;
  const visit = (n: any, up: any[]) => {
    if (out || !n || typeof n.type !== 'string') return;
    const p = up[up.length - 1];
    // (an ambient declaration has no code)
    if (n.declare === true) return;
    if (n.type === 'ImportDeclaration' || n.type === 'TSInterfaceDeclaration' || n.type === 'TSTypeAliasDeclaration' || ((n.type === 'ExportNamedDeclaration' || n.type === 'ExportAllDeclaration') && n.source)) return;
    if (n.type === 'Identifier' || n.type === 'JSXIdentifier') {
      if (!names.has(n.name)) return;
      // where a name is no reference: a property's own name, an enum member's, a label, `export { x as m }`'s outer name
      if (p && !p.computed && ((p.type === 'MemberExpression' && p.property === n) || (/^(Property|MethodDefinition|PropertyDefinition)$/.test(p.type) && p.key === n && !p.shorthand && p.value !== n))) return;
      if (p && ((p.type === 'TSEnumMember' && p.id === n) || (/^(LabeledStatement|BreakStatement|ContinueStatement)$/.test(p.type) && p.label === n) || (p.type === 'ExportSpecifier' && p.exported === n && p.local !== n))) return;
      // `name.key`, and a nested id's whole chain (as `moduleKeys` reads it)
      if (p?.type !== 'MemberExpression' || p.object !== n || p.computed || p.property.type !== 'Identifier') { out = `${at(n.start)}: \`${n.name}\` other than as \`${n.name}.key\` (another binding of the name, or a use the build does not read)`; return; }
      let key = p.property.name, w = p;
      for (let i = up.length - 2; i >= 0; i--) {
        const q = up[i];
        if (q.type !== 'MemberExpression' || q.object !== w || q.computed || q.property.type !== 'Identifier') break;
        key += '.' + q.property.name;
        w = q;
      }
      if (!known.has(key)) out = `${at(n.start)}: \`${n.name}.${key}\` where the build does not read it (a decorator)`;
      return;
    }
    up.push(n);
    for (const k of Object.keys(n)) {
      if (k === 'type' || k === 'start' || k === 'end' || k === 'loc' || k === 'range') continue;
      // what a node holds under these names is a type, whatever the node: erased, never run
      if (k === 'typeAnnotation' || k === 'returnType' || k === 'typeParameters' || k === 'typeArguments' || k === 'superTypeArguments' || k === 'superTypeParameters' || k === 'implements') continue;
      const v = n[k];
      if (Array.isArray(v)) for (const c of v) visit(c, up); else if (v && typeof v === 'object') visit(v, up);
    }
    up.pop();
  };
  visit(ast, []);
  return out;
}

/** a text as a JavaScript string literal, valid wherever it stands (`</script`, U+2028 and U+2029 escaped too) */
const lit = (s: string) => JSON.stringify(s).replace(/[<\u2028\u2029]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
/** the placeholders the messages module's `fill` replaces (src/messages.ts): the same expression */
const PLACEHOLDER = /\{(\w+)\}/g;
/** a write to what stands here: `x = …`, `x++`, `for (x of …)`, a destructuring target */
const written = (n: any, p: any) => (p?.type === 'AssignmentExpression' && p.left === n) || (p?.type === 'UpdateExpression' && p.argument === n)
  || (/^For(In|Of)Statement$/.test(p?.type) && p.left === n) || /^(ArrayPattern|ObjectPattern|RestElement)$/.test(p?.type) || (p?.type === 'AssignmentPattern' && p.left === n)
  || (p?.type === 'Property' && p.value === n && p.kind === 'init' && p.shorthand === false && p.method === false && p.__inPattern === true);

/**
 * The messages module's `t(key, p)` for a plain message (`text`, the entry as the page's dictionary holds it: a string)
 * as source, the same operations in the same order: the text itself when `p` is falsy, else each `{name}` replaced by
 * `String(p.name)` when `name in p`, and kept as written when not (src/messages.ts, `fill`). A function of its arguments.
 */
const textFn = (text: string): string => {
  const parts = text.split(PLACEHOLDER);
  if (parts.length === 1) return `()=>${lit(text)}`;
  const body = parts.map((x, i) => (i % 2 ? `(${lit(x)} in p?String(p[${lit(x)}]):${lit(`{${x}}`)})` : x ? lit(x) : '')).filter(Boolean).join('+');
  return `p=>p?${body}:${lit(text)}`;
};

/**
 * Step 1 of a page's dictionary (docs/messages.md#messages-in-the-early-script): in a module of a page's early script, each
 * use of a message whose entry in the page's language is a plain text (`textOf(key)` is a string: what the messages
 * module would read from the page's dictionary) is replaced by what the messages module would make of it, so the
 * early script needs neither the entry nor the module. Exact by construction, for every shape:
 * - `m.key()`, and a call whose arguments do not reach a placeholder of the text (it has none, or there are no
 *   arguments): the text, after the arguments are evaluated (`(a, b, "text")`);
 * - any other call (`m.key({ n: x })`, `m.key(params)`, a spread): the same call of a
 *   function that does what the messages module's `t` does (`textFn`);
 * - `m.key` not called (`label: m.key`): that function, through `ref` (`ref(f)` is `f`, marked pure): the caller
 *   checks whether a reference is left in the bundle, where the function is not the messages module's proxy (reading a
 *   property of it, or turning it into a string, differs), and builds again with `refs: false` if one is.
 * Left as written (the module then still reads the dictionary): an entry that is not a plain text (a plural, a formatted
 * placeholder) or that the page lacks, `m.key` written to or read a property of (`m.key[x]`), and every use in a
 * module where `m` may not be the import (`keysOnly` says no: another binding of the name, `export { m }`) or where
 * `String` may not be the global one (the function calls it). Every replacement is put in its place by one function
 * (`emit`), which writes a `;` before it where it starts an expression statement in a list of statements, nested
 * inside another replacement's arguments or not. Null when nothing is replaced. `left`: the ids of the uses left as
 * written.
 */
export function inlineTexts(code: string, id: string, textOf: (key: string) => unknown, o: { from?: string; exported?: string; ref?: string | null; before?: (key: string) => string | null } = {}): { code: string; left: string[]; done: string[]; refs: number; before: number; install: boolean } | null {
  const from = o.from ?? MESSAGES_MODULE, exported = o.exported ?? 'm';
  if (!code.includes(from)) return null;
  const r = moduleKeys(code, id, from, exported, true);
  if (r.errors.length || !r.keys.length || !keysOnly(code, id, from, exported, r.keys)) return null;
  let ast: ReturnType<typeof parseModule>;
  try { ast = parseModule(code, id.replace(/\?.*$/, '')); } catch { return null; }
  const names = new Set<string>();
  // (`String` imported is the module's own too: the walk below does not enter imports)
  let ownString = false;
  for (const st of ast.body as any[]) if (st.type === 'ImportDeclaration') for (const s of st.specifiers) {
    if (st.source.value === from) names.add(s.local.name);
    if (s.local.name === 'String' && st.importKind !== 'type' && s.importKind !== 'type') ownString = true;
  }
  if (ownString) return null;
  // the uses: each chain `m.a.b` as keysOnly reads it, its parent, and what `String` is
  const uses: Array<{ node: any; parent: any; key: string }> = [];
  /**
   * where an expression statement in a list of statements starts: a site there that begins with `(` would continue the
   * statement before it when that one has no semicolon (`a = b⏎m.x()` is two statements; `a = b⏎("x")` a call of `b`),
   * so it is written after a `;` of its own
   */
  const statementStarts = new Set<number>();
  const visit = (n: any, up: any[]) => {
    if (!n || typeof n.type !== 'string' || n.declare === true) return;
    if (n.type === 'ImportDeclaration' || n.type === 'TSInterfaceDeclaration' || n.type === 'TSTypeAliasDeclaration') return;
    const p = up[up.length - 1];
    if (n.type === 'ExpressionStatement' && /^(Program|BlockStatement|StaticBlock|SwitchCase|TSModuleBlock)$/.test(p?.type)) statementStarts.add(n.start);
    if (n.type === 'ObjectPattern') for (const q of n.properties) if (q.type === 'Property') q.__inPattern = true;
    if (n.type === 'Identifier' && n.name === 'String' && !(p && ((p.type === 'CallExpression' && p.callee === n) || (p.type === 'MemberExpression' && p.object === n) || (p.type === 'MemberExpression' && p.property === n && !p.computed) || (/^(Property|MethodDefinition|PropertyDefinition)$/.test(p.type) && p.key === n && !p.computed && !p.shorthand)))) ownString = true;
    if (n.type === 'Identifier' && names.has(n.name) && p?.type === 'MemberExpression' && p.object === n && !p.computed && p.property.type === 'Identifier') {
      let key = p.property.name, at = p, i = up.length - 2;
      for (; i >= 0; i--) {
        const q = up[i];
        if (q.type !== 'MemberExpression' || q.object !== at || q.computed || q.property.type !== 'Identifier') break;
        key += '.' + q.property.name;
        at = q;
      }
      uses.push({ node: at, parent: i >= 0 ? up[i] : null, key });
      // (its parent, for a write through a cast: `(m.key as any) = …`)
      let w = at, wi = i;
      while (wi >= 0 && /^(TSNonNullExpression|TSAsExpression|TSSatisfiesExpression|TSTypeAssertion|ParenthesizedExpression)$/.test(up[wi].type)) { w = up[wi]; wi--; }
      uses[uses.length - 1]!.parent = wi >= 0 ? up[wi] : null;
      (uses[uses.length - 1] as any).target = w;
      return;
    }
    up.push(n);
    for (const k of Object.keys(n)) {
      if (k === 'type' || k === 'start' || k === 'end' || k === 'loc' || k === 'range' || k === '__inPattern') continue;
      if (k === 'typeAnnotation' || k === 'returnType' || k === 'typeParameters' || k === 'typeArguments' || k === 'superTypeArguments' || k === 'superTypeParameters' || k === 'implements') continue;
      const v = n[k];
      if (Array.isArray(v)) for (const c of v) visit(c, up); else if (v && typeof v === 'object') visit(v, up);
    }
    up.pop();
  };
  visit(ast, []);
  if (ownString) return null;
  type Site = { start: number; end: number; out: () => string };
  const sites: Site[] = [], left = new Set<string>(), done = new Set<string>();
  let refs = 0, before = 0, install = false;
  // the source of a range, the sites inside it replaced
  /** a replacement as written in its place: the one way any of them reaches the output */
  const emit = (x: Site) => (statementStarts.has(x.start) ? ';' : '') + x.out();
  const render = (s: number, e: number, self?: Site): string => {
    let out = '', at = s;
    for (const x of sites) if (x !== self && x.start >= at && x.end <= e) { out += code.slice(at, x.start) + emit(x); at = x.end; }
    return out + code.slice(at, e);
  };
  for (const u of uses) {
    const text = textOf(u.key), p = u.parent, target = (u as any).target;
    if (typeof text !== 'string' || written(target, p) || (p?.type === 'MemberExpression' && p.object === target)) {
      left.add(u.key);
      // a call left as written that needs something first (`before`: the formatter's registration, for an entry that
      // is not a plain text): that, then the call; any other use of such an entry needs it at the module's top level
      const pre = text != null && typeof text !== 'string' ? o.before?.(u.key) ?? null : null;
      if (pre && p?.type === 'CallExpression' && p.callee === target) {
        const site: Site = { start: p.start, end: p.end, out: () => `(${pre},${render(p.start, p.end, site)})` };
        sites.push(site);
        before++;
      } else if (text != null && typeof text !== 'string') install = true;
      continue;
    }
    done.add(u.key);
    const fn = `(${textFn(text)})`, holes = [...text.matchAll(PLACEHOLDER)].map((x) => x[1]!);
    if (p?.type === 'CallExpression' && p.callee === target) {
      const args: any[] = p.arguments, spread = args.some((a) => a.type === 'SpreadElement');
      // each argument in parentheses of its own (a sequence stays one argument)
      const arg = (a: any) => (a.type === 'SpreadElement' ? `...(${render(a.argument.start, a.argument.end)})` : `(${render(a.start, a.end)})`);
      const argText = () => args.map(arg).join(',');
      const out = !spread && (!args.length || !holes.length) ? () => (args.length ? `(${argText()},${lit(text)})` : `(${lit(text)})`) : () => `(${fn}(${argText()}))`;
      sites.push({ start: p.start, end: p.end, out });
      continue;
    }
    // a tagged template, `new`, or a reference: the function in the use's place
    if ((p?.type === 'TaggedTemplateExpression' && p.tag === target) || (p?.type === 'NewExpression' && p.callee === target)) { sites.push({ start: u.node.start, end: u.node.end, out: () => fn }); continue; }
    if (o.ref === null) { left.add(u.key); done.delete(u.key); continue; }
    refs++;
    sites.push({ start: u.node.start, end: u.node.end, out: () => `(/* @__PURE__ */ ${o.ref ?? '(f=>f)'}(${fn}))` });
  }
  // (a key used both ways is left: the module still reads its entry)
  for (const k of left) done.delete(k);
  if (!sites.length) return null;
  sites.sort((a, b) => a.start - b.start);
  return { code: render(0, code.length), left: [...left].sort(), done: [...done].sort(), refs, before, install };
}

/**
 * The modules a module names: the sources of its imports, re-exports, `import()`s and `require()`s that are written as
 * a text (one that is computed is not known; a bundle resolves none of those). Null for a module that cannot be parsed.
 */
export function sourcesOf(code: string, id: string): string[] | null {
  let ast: ReturnType<typeof parseModule>;
  try { ast = parseModule(code, id.replace(/\?.*$/, '')); } catch { return null; }
  const out = new Set<string>();
  const text = (n: any): unknown => (n?.type === 'Literal' ? n.value : n?.type === 'TemplateLiteral' && n.expressions.length === 0 ? n.quasis[0]?.value.cooked : undefined);
  const add = (n: any) => { const t = text(n); if (typeof t === 'string') out.add(t); };
  const visit = (n: any) => {
    if (!n || typeof n.type !== 'string') return;
    if (n.type === 'ImportDeclaration' || n.type === 'ExportNamedDeclaration' || n.type === 'ExportAllDeclaration' || n.type === 'ImportExpression') add(n.source);
    if (n.type === 'TSExternalModuleReference') add(n.expression);
    if (n.type === 'CallExpression' && n.callee?.type === 'Identifier' && n.callee.name === 'require') add(n.arguments[0]);
    for (const k of Object.keys(n)) {
      if (k === 'type' || k === 'start' || k === 'end' || k === 'loc' || k === 'range') continue;
      const v = n[k];
      if (Array.isArray(v)) for (const c of v) visit(c); else if (v && typeof v === 'object') visit(v);
    }
  };
  visit(ast);
  return [...out];
}

/**
 * acorn-walk's walker, with TypeScript's nodes: expressions inside casts are walked, types skipped; the code of a
 * `namespace` body, an `enum`'s initializers, a constructor's parameter properties and `export =` too
 */
const tsBase = new Proxy(base as Record<string, unknown>, {
  get(t, k: string) {
    if (k in t) return t[k];
    if (/^TS(As|Satisfies|NonNull)Expression$|^TSTypeAssertion$|^TSInstantiationExpression$|^TSExportAssignment$/.test(k)) return (n: any, st: unknown, c: (n: unknown, st: unknown) => void) => c(n.expression, st);
    type C = (n: unknown, st: unknown, how?: string) => void;
    if (k === 'TSModuleDeclaration') return (n: any, st: unknown, c: C) => { if (!n.declare && n.body) c(n.body, st); };
    if (k === 'TSModuleBlock') return (n: any, st: unknown, c: C) => { for (const s of n.body) c(s, st, 'Statement'); };
    if (k === 'TSEnumDeclaration') return (n: any, st: unknown, c: C) => { if (!n.declare) for (const x of n.members ?? n.body?.members ?? []) if (x.initializer) c(x.initializer, st, 'Expression'); };
    if (k === 'TSParameterProperty') return (n: any, st: unknown, c: C) => c(n.parameter, st, 'Pattern');
    return () => {};
  },
});
