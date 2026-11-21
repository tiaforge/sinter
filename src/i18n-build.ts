// Build side of the built-in messages: reading the inlang project, the generated types, which
// keys a module uses, the per-page language files and the picker script. Node only.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { ancestor, base, simple } from 'acorn-walk';
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
  const where = (pos: number) => { const before = code.slice(0, pos).split('\n'); return `${id}:${before.length}:${before.at(-1)!.length + 1}`; };
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

/** acorn-walk's walker, with TypeScript's nodes: expressions inside casts are walked, types skipped */
const tsBase = new Proxy(base as Record<string, unknown>, {
  get(t, k: string) {
    if (k in t) return t[k];
    if (/^TS(As|Satisfies|NonNull)Expression$|^TSTypeAssertion$|^TSInstantiationExpression$/.test(k)) return (n: any, st: unknown, c: (n: unknown, st: unknown) => void) => c(n.expression, st);
    return () => {};
  },
});
