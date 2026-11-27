// What a component script, or a module that makes an event, can give the page (docs/spec.md, Aliases): a value the build
// proves holds none of the page's objects, whatever the code read to make it. Allowed: a primitive (a literal,
// arithmetic, a comparison, `!`, a template, `String()`, `Number()`, `Math.*()`), a fresh value (an object or array
// literal of allowed values, `structuredClone()`, `JSON.parse()`, a new `Map`, `Set`, `Date`, `URL`), and a `const` of
// the module declared once whose value is allowed. Anything else may be one of the page's objects (a prop, a parameter,
// a DOM property, an import's result).

/** an acorn (and acorn-typescript) node */
export type N = { type: string; start: number; end: number; [k: string]: any };

const FRESH_NEW = /^(Map|Set|WeakMap|WeakSet|Date|URL|URLSearchParams|RegExp|Error|TypeError|RangeError|Array|Object)$/;
const PRIM_CALL = /^(String|Number|Boolean|parseInt|parseFloat|isNaN|isFinite|encodeURIComponent|decodeURIComponent|encodeURI|decodeURI)$/;

/** The module's `const`s that are its only binding of their name (no parameter, `let`, function or import shares it), by name. */
export function moduleConsts(ast: N): Map<string, N | null> {
  const count = new Map<string, number>(), consts = new Map<string, N | null>();
  const bind = (id: N | null | undefined) => {
    if (!id) return;
    if (id.type === 'Identifier') count.set(id.name, (count.get(id.name) ?? 0) + 1);
    else if (id.type === 'ObjectPattern') for (const p of id.properties) bind(p.type === 'RestElement' ? p.argument : p.value);
    else if (id.type === 'ArrayPattern') for (const e of id.elements) bind(e);
    else if (id.type === 'AssignmentPattern') bind(id.left);
    else if (id.type === 'RestElement') bind(id.argument);
  };
  const walk = (n: N | null | undefined) => {
    if (!n || typeof n.type !== 'string') return;
    if (n.type === 'VariableDeclarator') { bind(n.id); if (n.id.type === 'Identifier' && (n as any).__const) consts.set(n.id.name, n.init ?? null); }
    if (n.type === 'VariableDeclaration') for (const d of n.declarations) if (n.kind === 'const') (d as any).__const = true;
    if (/Function/.test(n.type)) { if (n.id) bind(n.id); for (const p of n.params ?? []) bind(p.type === 'TSParameterProperty' ? p.parameter : p); }
    if (n.type === 'CatchClause') bind(n.param);
    if ((n.type === 'ClassDeclaration' || n.type === 'ClassExpression') && n.id) bind(n.id);
    if (n.type === 'ImportSpecifier' || n.type === 'ImportDefaultSpecifier' || n.type === 'ImportNamespaceSpecifier') bind(n.local);
    for (const k in n) {
      if (k === 'type' || k === 'start' || k === 'end' || k === 'loc') continue;
      const v = n[k];
      if (Array.isArray(v)) for (const x of v) walk(x as N); else if (v && typeof v === 'object' && typeof (v as N).type === 'string') walk(v as N);
    }
  };
  walk(ast);
  for (const k of [...consts.keys()]) if (count.get(k) !== 1) consts.delete(k);
  return consts;
}

/** Whether `e` surely holds none of the page's objects (see the top of the file); `consts`: the module's (`moduleConsts`). */
export function allowedValue(e: N | null | undefined, consts: Map<string, N | null> = new Map(), seen: Set<string> = new Set()): boolean {
  if (!e) return true;
  const ok = (x: N | null | undefined) => allowedValue(x, consts, seen);
  switch (e.type) {
    case 'Literal': return true;
    case 'TemplateLiteral': case 'BinaryExpression': case 'UpdateExpression': return true;
    case 'UnaryExpression': return e.operator !== 'delete';
    case 'ParenthesizedExpression': case 'TSAsExpression': case 'TSNonNullExpression': case 'TSSatisfiesExpression': case 'TSTypeAssertion': return ok(e.expression);
    case 'ConditionalExpression': return ok(e.consequent) && ok(e.alternate);
    case 'LogicalExpression': return ok(e.left) && ok(e.right);
    case 'SequenceExpression': return ok(e.expressions.at(-1));
    case 'Identifier': {
      if (/^(undefined|NaN|Infinity)$/.test(e.name)) return true;
      if (!consts.has(e.name) || seen.has(e.name)) return false;
      seen.add(e.name);
      try { return ok(consts.get(e.name)); } finally { seen.delete(e.name); }
    }
    case 'ArrayExpression': return e.elements.every((x: N | null) => !x || (x.type === 'SpreadElement' ? ok(x.argument) : ok(x)));
    case 'ObjectExpression': return e.properties.every((p: N) => (p.type === 'SpreadElement' ? ok(p.argument) : p.kind === 'init' && !p.method && !p.computed && ok(p.value)));
    case 'NewExpression': return e.callee.type === 'Identifier' && FRESH_NEW.test(e.callee.name) && e.arguments.every((a: N) => a.type !== 'SpreadElement' && ok(a));
    case 'CallExpression': {
      const c = e.callee;
      if (c.type === 'Identifier') return c.name === 'structuredClone' || PRIM_CALL.test(c.name);
      if (c.type === 'MemberExpression' && !c.computed && c.object.type === 'Identifier') {
        const o = c.object.name, m = c.property.name;
        return o === 'Math' || (o === 'JSON' && (m === 'parse' || m === 'stringify')) || (o === 'Date' && m === 'now') || (o === 'Number' && /^(parseInt|parseFloat|isInteger|isFinite|isNaN)$/.test(m)) || (o === 'Array' && m === 'isArray');
      }
      return false;
    }
    default: return false;
  }
}

/**
 * Whether a component script keeps none of the page's objects in its state: every use of `this.state` is a write of an
 * allowed value to one field (`this.state.dragging = true`), or a read of one field where only a primitive comes out of it
 * (a comparison, arithmetic, `!`, a test); `this` itself never leaves (passed, stored, read by a computed key). Else why
 * not, with where (`at` makes a node's place).
 */
export function freshState(ast: N, at: (n: N) => string): string | null {
  const consts = moduleConsts(ast);
  let why: string | null = null;
  const fail = (w: string, n: N) => { why ??= `${w} (${at(n)})`; };
  /** a read of `n`'s value used only for a primitive: the operand of an operator, a test */
  const primitiveUse = (n: N, parent: N | undefined, up: N[]): boolean => {
    if (!parent) return true;
    switch (parent.type) {
      case 'BinaryExpression': case 'UnaryExpression': case 'TemplateLiteral': return true;
      case 'IfStatement': case 'WhileStatement': case 'DoWhileStatement': case 'ForStatement': return parent.test === n;
      case 'ConditionalExpression': return parent.test === n || primitiveUse(parent, up.at(-1), up.slice(0, -1));
      case 'LogicalExpression': case 'ParenthesizedExpression': case 'TSAsExpression': case 'TSNonNullExpression': return primitiveUse(parent, up.at(-1), up.slice(0, -1));
      case 'ExpressionStatement': return true;
      default: return false;
    }
  };
  const walk = (n: N | null | undefined, up: N[]) => {
    if (!n || typeof n.type !== 'string' || why) return;
    if (n.type === 'ThisExpression') {
      const p = up.at(-1), pp = up.at(-2), ppp = up.at(-3);
      if (!p || p.type !== 'MemberExpression' || p.object !== n) return fail('`this` used as a value', n);
      if (p.computed) return fail('a member of `this` read by a computed key', n);
      if (p.property.type !== 'Identifier' || p.property.name !== 'state') return;
      // `this.state` itself
      if (!pp || pp.type !== 'MemberExpression' || pp.object !== p || pp.computed) return fail('`this.state` used as a value', p);
      // `this.state.<field>`: written, or read for a primitive
      if (ppp?.type === 'AssignmentExpression' && ppp.left === pp) {
        if (ppp.operator !== '=' && !/^[-+*/%]=|\*\*=|<<=|>>>?=|[&|^]=$/.test(ppp.operator)) return fail(`\`this.state.${pp.property.name} ${ppp.operator}\``, ppp);
        if (ppp.operator === '=' && !allowedValue(ppp.right, consts)) return fail(`\`this.state.${pp.property.name}\` given a value the build cannot follow`, ppp);
        return;
      }
      if (ppp?.type === 'UpdateExpression') return;
      if (!primitiveUse(pp, ppp, up.slice(0, -3))) return fail(`\`this.state.${pp.property.name}\` read where its value goes on`, pp);
      return;
    }
    for (const k in n) {
      if (k === 'type' || k === 'start' || k === 'end' || k === 'loc') continue;
      const v = n[k];
      if (Array.isArray(v)) for (const x of v) walk(x as N, [...up, n]);
      else if (v && typeof v === 'object' && typeof (v as N).type === 'string') walk(v as N, [...up, n]);
    }
  };
  walk(ast, []);
  return why;
}
