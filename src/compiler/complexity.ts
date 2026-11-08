// SN507: expressions too complex for markup. Markup holds filters, conditions, single
// assignments and short calls; logic belongs in a helper (pure) or an action (side effects).
// The measure is the expression's structure, never its length in characters.
import type { Node } from 'acorn';

export interface ComplexityLimits {
  /** `;`-separated statements in one handler */
  statements: number;
  /** comma sequences `(a, b)` in one expression */
  sequences: number;
  /** steps one `&&`, `||`, `??` or `?:` used as a statement may run: `a && close()` is 1, `a && (b = 1, close())` is 2 */
  guarded: number;
  /** nesting of `?:`: `a ? b : c` is 1, `a ? b : c ? d : e` is 2 */
  ternaries: number;
  /** operations in one arrow function's body (`p => p.name.includes(q)` has 3); a block body `{ … }` always counts as too many */
  arrow: number;
  /** operations in one expression (each statement of a handler, each property value of an object attribute), the backstop */
  operations: number;
}

export interface ComplexityOptions extends Partial<ComplexityLimits> {
  /** `warn` (default), `error` fails the build, `off` checks nothing */
  level?: 'warn' | 'error' | 'off';
}

export const COMPLEXITY_DEFAULTS: ComplexityLimits = { statements: 4, sequences: 0, guarded: 1, ternaries: 2, arrow: 8, operations: 15 };

/** limit names, as the config spells them */
export const COMPLEXITY_LIMITS = Object.keys(COMPLEXITY_DEFAULTS) as Array<keyof ComplexityLimits>;

export interface Excess { limit: keyof ComplexityLimits; value: number; max: number; offset: number; message: string }

// nodes that are data or names, not operations: literals, identifiers, object and array literals,
// template text, spreads, and the parentheses-free wrappers acorn adds
const NOT_OPERATIONS = new Set([
  'Literal', 'Identifier', 'ObjectExpression', 'ArrayExpression', 'Property', 'TemplateElement', 'TemplateLiteral',
  'SpreadElement', 'ExpressionStatement', 'Program', 'ParenthesizedExpression', 'ChainExpression', 'ThisExpression',
]);

type AnyNode = Node & Record<string, any>;

function children(n: AnyNode): AnyNode[] {
  const out: AnyNode[] = [];
  for (const k of Object.keys(n)) {
    if (k === 'type' || k === 'start' || k === 'end' || k === 'loc' || k === 'range') continue;
    const v = n[k];
    if (Array.isArray(v)) { for (const c of v) if (c && typeof c.type === 'string') out.push(c); }
    else if (v && typeof v.type === 'string') out.push(v);
  }
  return out;
}

/** operations in a subtree; `a.b.c` is one (a member path is a name), `computed` access counts */
function operations(n: AnyNode): number {
  let count = 0;
  const walk = (x: AnyNode) => {
    if (x.type === 'MemberExpression' && !x.computed) {
      // a.b.c: the path is one name, its object is walked for what it contains
      let o = x;
      while (o.type === 'MemberExpression' && !o.computed) o = o.object;
      walk(o);
      return;
    }
    if (!NOT_OPERATIONS.has(x.type)) count++;
    // a property key is a name, its value may hold operations
    if (x.type === 'Property') { if (x.computed) walk(x.key); walk(x.value); return; }
    for (const c of children(x)) walk(c);
  };
  walk(n);
  return count;
}

/** `(a, b)` unwrapped from parentheses */
const unwrap = (n: AnyNode): AnyNode => (n.type === 'ParenthesizedExpression' ? unwrap(n.expression) : n);

/** steps a statement runs: a sequence is its items, a guard is what it guards */
function steps(n: AnyNode): number {
  n = unwrap(n);
  if (n.type === 'SequenceExpression') return n.expressions.reduce((s: number, e: AnyNode) => s + steps(e), 0);
  return 1;
}

/** the largest number of steps a condition used as a statement runs, nested guards multiplied out */
function guardedSteps(n: AnyNode): { steps: number; at: number } | null {
  n = unwrap(n);
  let best: { steps: number; at: number } | null = null;
  const take = (branch: AnyNode, at: number) => {
    const b = unwrap(branch);
    // a branch that is itself a guard: `a && (b ? c() : d())` runs 2 levels of decisions
    const inner = isGuard(b) ? guardedSteps(b) : null;
    const s = inner ? inner.steps + 1 : steps(b);
    if (!best || s > best.steps) best = { steps: s, at };
  };
  if (n.type === 'LogicalExpression') take(n.right, n.start);
  else if (n.type === 'ConditionalExpression') { take(n.consequent, n.start); take(n.alternate, n.start); }
  else if (n.type === 'SequenceExpression') for (const e of n.expressions) { const g = guardedSteps(e); if (g && (!best || g.steps > best.steps)) best = g; }
  return best;
}

/** a guard has an effect in a branch: an assignment, update or call (else it is a plain condition value) */
function isGuard(n: AnyNode): boolean {
  n = unwrap(n);
  if (n.type !== 'LogicalExpression' && n.type !== 'ConditionalExpression') return false;
  const branches = n.type === 'LogicalExpression' ? [n.right] : [n.consequent, n.alternate];
  return branches.some((b: AnyNode) => hasEffect(b));
}
function hasEffect(n: AnyNode): boolean {
  n = unwrap(n);
  if (n.type === 'AssignmentExpression' || n.type === 'UpdateExpression' || n.type === 'CallExpression' || n.type === 'SequenceExpression') return true;
  if (n.type === 'LogicalExpression') return hasEffect(n.right);
  if (n.type === 'ConditionalExpression') return hasEffect(n.consequent) || hasEffect(n.alternate);
  return false;
}

/** The first limit an expression exceeds, or null. `exprs` are a handler's statements, or one value expression. */
export function measure(exprs: Node[], handler: boolean, limits: ComplexityLimits): Excess | null {
  const over = (limit: keyof ComplexityLimits, value: number, offset: number, what: string): Excess | null =>
    value > limits[limit] ? { limit, value, max: limits[limit], offset, message: what } : null;

  if (handler) {
    const n = exprs.length;
    const e = over('statements', n, exprs[limits.statements]?.start ?? 0, `${n} statements in one handler (limit \`statements\`: ${limits.statements})`);
    if (e) return e;
  }
  for (const x of exprs as AnyNode[]) {
    // sequences, ternary depth and arrows anywhere in the expression
    let sequences = 0, firstSeq = 0, depthMax = 0, depthAt = 0;
    let found: Excess | null = null;
    const walk = (n: AnyNode, depth: number) => {
      if (found) return;
      if (n.type === 'SequenceExpression') { if (!sequences++) firstSeq = n.start; }
      if (n.type === 'ConditionalExpression') {
        depth++;
        if (depth > depthMax) { depthMax = depth; depthAt = n.start; }
      }
      if (n.type === 'ArrowFunctionExpression' || n.type === 'FunctionExpression') {
        if (n.body.type === 'BlockStatement') {
          found = { limit: 'arrow', value: Infinity, max: limits.arrow, offset: n.start, message: 'an arrow function with a block body `{ … }` (limit `arrow`)' };
          return;
        }
        const ops = operations(n.body);
        found = over('arrow', ops, n.start, `${ops} operations in one arrow function (limit \`arrow\`: ${limits.arrow})`);
        if (found) return;
        // the body's own ternaries start a new count: `x => a ? b : c` inside a ternary is its own expression
        walk(n.body, 0);
        return;
      }
      for (const c of children(n)) walk(c, depth);
    };
    walk(x, 0);
    if (found) return found;
    const seq = over('sequences', sequences, firstSeq, `${sequences} comma sequence${sequences === 1 ? '' : 's'} \`(a, b)\` (limit \`sequences\`: ${limits.sequences})`);
    if (seq && limits.sequences > 0) return seq;
    if (handler && isGuard(x)) {
      const g = guardedSteps(x);
      if (g) {
        const e = over('guarded', g.steps, g.at, `a condition used as a statement runs ${g.steps} steps (limit \`guarded\`: ${limits.guarded})`);
        if (e) return e;
      }
    }
    if (seq) return seq;
    const t = over('ternaries', depthMax, depthAt, `\`?:\` nested ${depthMax} deep (limit \`ternaries\`: ${limits.ternaries})`);
    if (t) return t;
    const ops = operations(x);
    const o = over('operations', ops, x.start, `${ops} operations in one expression (limit \`operations\`: ${limits.operations})`);
    if (o) return o;
  }
  return null;
}
