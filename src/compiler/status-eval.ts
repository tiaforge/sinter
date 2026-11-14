// Whether a compiled condition shows, given a resource's status and rows: a small evaluator over its syntax
// tree, for the build to tell which branches show while a list is loading with no rows (reserved space,
// compile.ts). It runs nothing: what it does not know (the URL, state, a helper, any other value) is
// UNKNOWN, and so is a result that depends on it. Status fields and rows are the only inputs.
import { parseExpressionAt } from 'acorn';

const UNKNOWN = Symbol('unknown');
type V = unknown;

/**
 * The truth of `code` (a compiled function, `($) => (…)`) when the resources `names` have `status`
 * (`$meta.<name>`) and `rows` (`$r.<name>`): true, false, or null when it cannot be told.
 */
export function shows(code: string, names: string[], status: { loading: boolean }, rows: unknown[]): boolean | null {
  let fn: any;
  try { fn = parseExpressionAt(code, 0, { ecmaVersion: 'latest' }); } catch { return null; }
  if (fn.type !== 'ArrowFunctionExpression' || fn.params.length !== 1 || fn.params[0].type !== 'Identifier') return null;
  const self = fn.params[0].name as string, set = new Set(names);
  const meta = { ...status, error: null, loadedAt: null, pending: 0 };
  const ev = (n: any): V => {
    switch (n.type) {
      case 'Literal': return n.value;
      case 'Identifier': return n.name === 'undefined' ? undefined : UNKNOWN;
      case 'TemplateLiteral': return n.expressions.length ? UNKNOWN : n.quasis[0].value.cooked;
      case 'ArrayExpression': return n.elements.length ? UNKNOWN : [];
      case 'ChainExpression': return ev(n.expression);
      case 'MemberExpression': {
        // `$.$meta.<name>` and `$.$r.<name>`
        const o = n.object;
        if (o.type === 'MemberExpression' && o.object.type === 'Identifier' && o.object.name === self && !o.computed && !n.computed) {
          if (o.property.name === '$meta' && set.has(n.property.name)) return meta;
          if (o.property.name === '$r' && set.has(n.property.name)) return rows;
          return UNKNOWN;
        }
        const v = ev(o);
        if (v === UNKNOWN) return UNKNOWN;
        if (v == null) return n.optional || o.optional ? undefined : UNKNOWN;
        const key = n.computed ? (n.property.type === 'Literal' ? n.property.value : UNKNOWN) : n.property.name;
        if (key === UNKNOWN) return UNKNOWN;
        if (v === meta) return key in meta ? (meta as any)[key] : UNKNOWN;
        if (Array.isArray(v) && key === 'length') return v.length;
        return UNKNOWN;
      }
      case 'UnaryExpression': {
        const v = ev(n.argument);
        if (v === UNKNOWN) return UNKNOWN;
        if (n.operator === '!') return !v;
        return UNKNOWN;
      }
      case 'LogicalExpression': {
        const a = ev(n.left);
        if (n.operator === '&&') { if (a !== UNKNOWN && !a) return a; const b = ev(n.right); return a === UNKNOWN ? (b !== UNKNOWN && !b ? b : UNKNOWN) : b; }
        if (n.operator === '||') { if (a !== UNKNOWN && a) return a; const b = ev(n.right); return a === UNKNOWN ? (b !== UNKNOWN && b ? b : UNKNOWN) : b; }
        if (n.operator === '??') { if (a === UNKNOWN) return UNKNOWN; return a ?? ev(n.right); }
        return UNKNOWN;
      }
      case 'ConditionalExpression': {
        const t = ev(n.test);
        if (t === UNKNOWN) { const a = ev(n.consequent), b = ev(n.alternate); return a !== UNKNOWN && b !== UNKNOWN && !!a === !!b ? a : UNKNOWN; }
        return t ? ev(n.consequent) : ev(n.alternate);
      }
      case 'BinaryExpression': {
        const a = ev(n.left), b = ev(n.right);
        if (a === UNKNOWN || b === UNKNOWN) return UNKNOWN;
        switch (n.operator) {
          case '==': return a == b; case '!=': return a != b; case '===': return a === b; case '!==': return a !== b;
          case '<': return (a as any) < (b as any); case '>': return (a as any) > (b as any); case '<=': return (a as any) <= (b as any); case '>=': return (a as any) >= (b as any);
          default: return UNKNOWN;
        }
      }
      default: return UNKNOWN;
    }
  };
  const v = ev(fn.body);
  return v === UNKNOWN ? null : !!v;
}
