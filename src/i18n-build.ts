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
 * Whether the entries a module can read of a namespace are the keys `moduleKeys` found for it (`keys`), and no more.
 * `moduleKeys` reads the uses its walker reaches and reports the ones it does not accept; this asks the other way
 * round, of every node of the syntax tree whatever its type (TypeScript's `namespace` and `enum` bodies, parameter
 * properties, decorators, an `export { m }`, which that walker does not enter): each occurrence of a name the module
 * imports from the namespace's module `from` must be `name.key` with a key among `keys` (or stand where a name is no
 * reference: an import specifier, a property's name, inside a type), and the module must reach `from` in no other way: no other
 * export of it (`t`, `install`), no namespace or default import, no re-export, no `import()` or `require()` of it.
 * False for anything else, and for a module that cannot be parsed. Used where a wrong yes would lose a text (the
 * entries a page's head keeps, src/vite.ts); a wrong no only keeps more.
 */
export function keysOnly(code: string, id: string, from: string = MESSAGES_MODULE, exported = 'm', keys: string[] = moduleKeys(code, id, from, exported, true).keys): boolean {
  if (!code.includes(from)) return true;
  let ast: ReturnType<typeof parseModule>;
  try { ast = parseModule(code, id.replace(/\?.*$/, '')); } catch { return false; }
  const names = new Set<string>(), known = new Set(keys);
  const text = (n: any): unknown => (n?.type === 'Literal' ? n.value : n?.type === 'TemplateLiteral' && n.expressions.length === 0 ? n.quasis[0]?.value.cooked : undefined);
  for (const st of ast.body as any[]) {
    if (st.type !== 'ImportDeclaration' || text(st.source) !== from) continue;
    for (const s of st.specifiers) {
      if (s.type !== 'ImportSpecifier' || (s.imported.type === 'Identifier' ? s.imported.name : s.imported.value) !== exported) return false;
      names.add(s.local.name);
    }
  }
  let ok = true;
  const visit = (n: any, up: any[]) => {
    if (!ok || !n || typeof n.type !== 'string') return;
    const p = up[up.length - 1];
    // (an ambient declaration has no code)
    if (n.declare === true) return;
    switch (n.type) {
      case 'ImportDeclaration': case 'TSInterfaceDeclaration': case 'TSTypeAliasDeclaration': return;
      case 'ExportNamedDeclaration': case 'ExportAllDeclaration': if (text(n.source) === from) ok = false; break;
      case 'ImportExpression': if (text(n.source) === from) ok = false; break;
      case 'CallExpression': if (n.callee?.type === 'Identifier' && n.callee.name === 'require' && text(n.arguments[0]) === from) ok = false; break;
      case 'Identifier': case 'JSXIdentifier': {
        if (!names.has(n.name)) return;
        // where a name is no reference: a property's own name
        if (p && !p.computed && ((p.type === 'MemberExpression' && p.property === n) || (/^(Property|MethodDefinition|PropertyDefinition)$/.test(p.type) && p.key === n && !p.shorthand && p.value !== n))) return;
        // `name.key`, and a nested id's whole chain (as `moduleKeys` reads it)
        if (p?.type !== 'MemberExpression' || p.object !== n || p.computed || p.property.type !== 'Identifier') { ok = false; return; }
        let key = p.property.name, at = p;
        for (let i = up.length - 2; i >= 0; i--) {
          const q = up[i];
          if (q.type !== 'MemberExpression' || q.object !== at || q.computed || q.property.type !== 'Identifier') break;
          key += '.' + q.property.name;
          at = q;
        }
        if (!known.has(key)) ok = false;
        return;
      }
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
  return ok;
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

/** acorn-walk's walker, with TypeScript's nodes: expressions inside casts are walked, types skipped */
const tsBase = new Proxy(base as Record<string, unknown>, {
  get(t, k: string) {
    if (k in t) return t[k];
    if (/^TS(As|Satisfies|NonNull)Expression$|^TSTypeAssertion$|^TSInstantiationExpression$/.test(k)) return (n: any, st: unknown, c: (n: unknown, st: unknown) => void) => c(n.expression, st);
    return () => {};
  },
});
