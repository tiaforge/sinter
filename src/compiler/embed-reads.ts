// What the browser's code reads of the page's build-time resources (`file:`, `content:`, a page's entry), so that the
// page embeds only that (docs/proposals/redesign-notes/embed-fields.md). The compiled functions are the code that runs:
// every read of a resource is `<scope>.$r.<name>` there (expr.ts `emitName`), so each one's tree says exactly what it
// reads. A read follows the member chain from `$r.<name>` while each member is a fixed key (`post.author.name`); where
// it stops, it reads the value there whole, whatever it does with it next (a helper's argument, a spread, a loop, an
// identity comparison, a computed key, a method's receiver). A write, or `$r` itself taken whole or by a computed name,
// makes every resource whole.
import type { AnyNode } from 'acorn';
import { parseExpression } from './parse.js';

/** each resource's read paths (members after its name; `[]` the whole value), or `all` when any may be read whole */
export type ResourceReads = { all: true } | { all: false; reads: Map<string, string[][]> };

/** the paths the functions read under `$r`, by resource (`ResourceReads`) */
export function resourceReads(codes: Iterable<string>): ResourceReads {
  const reads = new Map<string, string[][]>();
  let all = false;
  const keyOf = (m: any): string | null => (!m.computed && m.property.type === 'Identifier' ? m.property.name
    : m.computed && m.property.type === 'Literal' && (typeof m.property.value === 'string' || typeof m.property.value === 'number') ? String(m.property.value) : null);
  /** from the member `$r` at `stack`'s end: the path its chain reads */
  const climb = (stack: any[]) => {
    let cur = stack[stack.length - 1], i = stack.length - 2;
    const segs: string[] = [];
    for (;;) {
      let p = stack[i];
      while (p?.type === 'ChainExpression') { cur = p; p = stack[--i]; }
      if (p?.type === 'MemberExpression' && p.object === cur) {
        const k = keyOf(p);
        if (k === null) break;
        segs.push(k); cur = p; i--;
        continue;
      }
      // a method call: its receiver is read whole
      if (p?.type === 'CallExpression' && p.callee === cur) { segs.pop(); break; }
      // a write: the value is no longer what the build embedded
      if ((p?.type === 'AssignmentExpression' && p.left === cur) || (p?.type === 'UpdateExpression') || (p?.type === 'UnaryExpression' && p.operator === 'delete')) { all = true; return; }
      break;
    }
    if (!segs.length) { all = true; return; }
    const [name, ...rest] = segs as [string, ...string[]];
    let list = reads.get(name);
    if (!list) reads.set(name, (list = []));
    list.push(rest);
  };
  const visit = (n: any, stack: any[]) => {
    if (all || !n || typeof n.type !== 'string') return;
    stack.push(n);
    if (n.type === 'MemberExpression' && keyOf(n) === '$r') climb(stack);
    // `$r` by itself (destructured, a parameter): anything may be read
    else if (n.type === 'Identifier' && n.name === '$r') { all = true; return; }
    for (const k in n) {
      if (k === 'type' || k === 'start' || k === 'end') continue;
      // a member's or a property's name is no read of a variable
      if (k === 'property' && n.type === 'MemberExpression' && !n.computed) continue;
      if (k === 'key' && (n.type === 'Property' || n.type === 'PropertyDefinition' || n.type === 'MethodDefinition') && !n.computed && !n.shorthand) continue;
      const v = n[k];
      if (Array.isArray(v)) for (const x of v) visit(x, stack);
      else if (v && typeof v === 'object' && typeof v.type === 'string') visit(v, stack);
    }
    stack.pop();
  };
  for (const c of new Set(codes)) {
    if (c === '0' || !c.includes('$r')) continue;
    let ast: AnyNode;
    // a function that does not parse: what it reads is unknown
    try { ast = parseExpression(c); } catch { return { all: true }; }
    visit(ast, []);
    if (all) return { all: true };
  }
  return { all: false, reads };
}

const plainObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;

/**
 * `v` with only what `paths` read: at each depth, a plain object keeps the keys some path names (in their order), and
 * what a path ends at is kept whole; a list or any other value is kept whole. A key no path names is left out.
 */
export function prune(v: unknown, paths: readonly string[][]): unknown {
  if (paths.some((p) => !p.length) || !plainObject(v)) return v;
  const by = new Map<string, string[][]>();
  for (const [k, ...rest] of paths) { let l = by.get(k!); if (!l) by.set(k!, (l = [])); l.push(rest); }
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(v)) if (by.has(k)) out[k] = prune(v[k], by.get(k)!);
  return out;
}
