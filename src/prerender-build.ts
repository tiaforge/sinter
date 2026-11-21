// `prefetch: { html: { prerender: 'auto' } }`: which pages the Speculation Rules prerender. A prerendered page runs for
// a visitor who may never see it, so only a page that does nothing on load but read is prerendered: the compiler checks
// the page (`loadEffects()` in compile.ts), and this module the app's modules every page imports (config, early,
// helpers, actions), which run when the page loads. A module is free of load-time effects when the build can show it:
// every top-level statement declares something, and what it evaluates is a literal, a function, an object or array of
// those, `import.meta.env`, or a call of sinter's configuration functions; what it imports is such a module too, sinter,
// or a package whose package.json says `"sideEffects": false`. Anything else (a call, `new`, a property read of an
// import, a package that does not say) counts as an effect: the page is prefetched, not prerendered.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { parseModule } from './compiler/index.js';
import { appModule } from './fold-check.js';
import { lineCol } from './line-col.js';

/** sinter's functions an app calls at the top of its config module: they set configuration and do nothing else */
const CONFIGURES = new Set(['configure', 'header', 'onUnauthorized', 'loginRedirect', 'apiOf', 'memo', 'date', 'relative', 'number', 'bytes']);
const SINTER = /^@tiaforge-ui\/sinter(\/|$)/;

/**
 * The first load-time effect of a module or what it imports (`"<file>: <what>"`), or null when it has none the build can
 * see. `seen` caches results across calls (one per build; a module in a cycle counts as free while it is checked).
 */
export function moduleEffect(file: string, root: string, seen: Map<string, string | null> = new Map()): string | null {
  if (seen.has(file)) return seen.get(file)!;
  seen.set(file, null);
  let out: string | null;
  try { out = effectOf(file, readFileSync(file, 'utf8'), root, seen); } catch (e) { out = `${file}: could not be read (${(e as Error).message})`; }
  seen.set(file, out);
  return out;
}

function effectOf(file: string, source: string, root: string, seen: Map<string, string | null>): string | null {
  const ast = parseModule(source, file) as any;
  const at = (n: any, what: string) => `${file}:${lineCol(source, n.start).line}: ${what}`;
  const fromSinter = new Set<string>();
  // a module's imports first: what it imports runs before it
  for (const st of ast.body) {
    const spec: string | undefined = (st.type === 'ImportDeclaration' || st.type === 'ExportAllDeclaration' || (st.type === 'ExportNamedDeclaration' && st.source)) ? st.source.value : undefined;
    if (spec === undefined || st.importKind === 'type' || st.exportKind === 'type') continue;
    if (SINTER.test(spec)) {
      for (const s of st.specifiers ?? []) if (s.type === 'ImportSpecifier' && s.importKind !== 'type') fromSinter.add(s.local.name);
      continue;
    }
    // the app's own module (relative, root-absolute, or through the app's alias), found as the bundler finds it; an
    // alias to a package's file is the package
    const bare = !spec.startsWith('.') && !spec.startsWith('/');
    const target = appModule(spec, file, root);
    if (!bare || (target && !target.includes(`${sep}node_modules${sep}`))) {
      if (!target) return at(st, `imports \`${spec}\`, which the build cannot find`);
      const e = moduleEffect(target, root, seen);
      if (e) return e;
      continue;
    }
    if (!purePackage(spec, dirname(file))) return at(st, `imports \`${spec}\`, whose package.json does not say \`"sideEffects": false\``);
  }
  const pure = (n: any): boolean => {
    if (!n) return true;
    switch (n.type) {
      case 'Literal': case 'Identifier': case 'ArrowFunctionExpression': case 'FunctionExpression': case 'ThisExpression': return true;
      case 'TemplateLiteral': return n.expressions.every(pure);
      case 'ArrayExpression': return n.elements.every((e: any) => !e || pure(e.type === 'SpreadElement' ? e.argument : e));
      case 'ObjectExpression': return n.properties.every((p: any) => (p.type === 'SpreadElement' ? pure(p.argument) : (!p.computed || pure(p.key)) && pure(p.value)));
      case 'UnaryExpression': return n.operator !== 'delete' && pure(n.argument);
      case 'BinaryExpression': case 'LogicalExpression': return pure(n.left) && pure(n.right);
      case 'ConditionalExpression': return pure(n.test) && pure(n.consequent) && pure(n.alternate);
      case 'ClassExpression': return pureClass(n);
      // `import.meta.env.X`: Vite writes it in
      case 'MemberExpression': { let o = n; while (o.type === 'MemberExpression' && !o.computed) o = o.object; return o.type === 'MetaProperty'; }
      case 'CallExpression': return n.callee.type === 'Identifier' && fromSinter.has(n.callee.name) && CONFIGURES.has(n.callee.name) && n.arguments.every((a: any) => pure(a.type === 'SpreadElement' ? a.argument : a));
      case 'TSAsExpression': case 'TSSatisfiesExpression': case 'TSNonNullExpression': case 'TSTypeAssertion': case 'ParenthesizedExpression': return pure(n.expression);
      default: return false;
    }
  };
  const pureClass = (c: any) => !c.decorators?.length && (!c.superClass || pure(c.superClass))
    && c.body.body.every((m: any) => m.type !== 'StaticBlock' && !m.decorators?.length && (!m.computed || pure(m.key)) && (m.type !== 'PropertyDefinition' || !m.static || pure(m.value)));
  const declares = (d: any): boolean => {
    if (!d) return true;
    if (d.type === 'FunctionDeclaration' || d.type === 'TSDeclareFunction' || /^TS(Interface|TypeAlias|Enum|Module)Declaration$/.test(d.type) || d.declare) return d.type !== 'TSEnumDeclaration' || d.members.every((m: any) => pure(m.initializer));
    if (d.type === 'ClassDeclaration') return pureClass(d);
    if (d.type === 'VariableDeclaration') return d.declarations.every((v: any) => v.id.type === 'Identifier' && pure(v.init));
    return false;
  };
  for (const st of ast.body) {
    switch (st.type) {
      case 'ImportDeclaration': case 'ExportAllDeclaration': case 'TSImportEqualsDeclaration': case 'TSExportAssignment': continue;
      case 'ExportNamedDeclaration': if (declares(st.declaration)) continue; break;
      case 'ExportDefaultDeclaration': if (st.declaration.type === 'FunctionDeclaration' || (st.declaration.type === 'ClassDeclaration' ? pureClass(st.declaration) : pure(st.declaration))) continue; break;
      // `configure({ … })`: sinter's own configuration
      case 'ExpressionStatement': if (st.directive || pure(st.expression)) continue; break;
      case 'EmptyStatement': continue;
      default: if (declares(st)) continue;
    }
    return at(st, 'runs code as it loads');
  }
  return null;
}

/** whether a package says it has no side effects (`"sideEffects": false` in its package.json), found from `dir` up */
function purePackage(spec: string, dir: string): boolean {
  const name = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0]!;
  for (let d = resolve(dir); ; d = dirname(d)) {
    const f = join(d, 'node_modules', name, 'package.json');
    if (existsSync(f)) {
      try { return JSON.parse(readFileSync(f, 'utf8')).sideEffects === false; } catch { return false; }
    }
    if (dirname(d) === d) return false;
  }
}
