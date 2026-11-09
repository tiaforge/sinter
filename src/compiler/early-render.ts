// The early file's renderer, compiled per page: what `@tiaforge-ui/sinter/early` used to interpret
// from the early IR (the state scopes with persisted values, then each binding's first write, and
// each early `data-sn-if` branch with its bindings) as straight-line code over the early table `f`.
// It calls only the writers the page's bindings use, so the early file bundles only those (a page
// with no attribute binding carries no URL check). Same order and same failures as the interpreter
// had: every scope (persisted values applied) before any write; a binding that throws is left to the
// page module; an element that is missing is skipped.
import * as acorn from 'acorn';
import type { Binding, EarlyIR, NodeDef } from '../ir.js';
import { URL_ATTR } from '../runtime/security.js';

/**
 * A literal start that fixes the URL's scheme, which is what the browser's check (`urlAllowed`)
 * enforces: a relative path, query or fragment on the page's own origin (`/a`, `./`, `../`, `?`,
 * `#`; the parser reads `\` as `/`), or an allowed scheme (`http(s)://`, `mailto:`, `tel:`, whose
 * origin is the literal's). A `/` counts only with a next character that is no `/` or `\`: `'/' + v`
 * is `//host` (protocol-relative, another origin) when `v` starts with either.
 */
const SAFE_START = /^(\/[^/\\]|\.\.?[/\\]|\?|#|https?:\/\/|mailto:|tel:)/i;

/**
 * Whether the value of `code` (a value function `($) => (…)`) can only be a URL whose scheme is
 * fixed by its own literal start, or no value: then its attribute needs no check in the browser.
 */
export function fixedScheme(code: string): boolean {
  // (a value whose scheme the literal fixes; the origin is the page's, or the literal's own absolute URL)
  let e: any;
  try { e = (acorn.parseExpressionAt(code, 0, { ecmaVersion: 'latest' }) as any).body; } catch { return false; }
  const str = (x: any): string | null => x.type == 'Literal' && typeof x.value == 'string' ? x.value
    : x.type == 'TemplateLiteral' ? x.quasis[0].value.cooked ?? null
    : x.type == 'BinaryExpression' && x.operator == '+' ? str(x.left)
    : null;
  const safe = (x: any): boolean => {
    if (x.type == 'Literal' && (x.value === null || x.value === false)) return true;
    if (x.type == 'Identifier' && x.name == 'undefined') return false;
    if (x.type == 'ConditionalExpression') return safe(x.consequent) && safe(x.alternate);
    if (x.type == 'LogicalExpression') return x.operator == '&&' ? safe(x.right) : safe(x.left) && safe(x.right);
    // tabs and line breaks are removed by the URL parser before anything else: `'/\t' + v` is `'/' + v`
    const s = str(x);
    return s != null && SAFE_START.test(s.replace(/[\t\n\r]/g, ''));
  };
  return safe(e);
}

/** The early module's exports the renderer calls, by binding kind (`class` without a name: a `[name, on]` pair). */
const WRITER: Record<string, string> = { text: 'text', show: 'show', style: 'style', model: 'model' };

export interface EarlyRender {
  /** `($) => scopes`: the root nodes' scopes over the base scope `$` (the early requests read them too) */
  scopes: string;
  /** `(d, s, $) => void`: renders over the document `d`, `s` the root scopes, `$` the base scope */
  render: string;
  /** the early module's exports both call */
  uses: string[];
  /** by root node: the index of the node whose scope it has in `scopes` (-1: the base scope) */
  owner: number[];
}

export function earlyRender(ir: EarlyIR, fns: string[] = []): EarlyRender {
  const uses = new Set<string>();
  const use = (n: string) => (uses.add(n), n);
  const str = JSON.stringify;

  /**
   * each node's scope over `base`: a node that opens a state gets `s[i]` (persisted values applied),
   * any other node is its nearest such ancestor's (or `base`); `owner`: that node's index, -1 for `base`
   */
  const scopeOf = (defs: NodeDef[], base: string) => {
    const lines: string[] = [], expr: string[] = [], owner: number[] = [];
    defs.forEach((nd, i) => {
      const p = nd.p ?? -1, up = p >= 0 ? expr[p]! : base;
      owner[i] = nd.state != null ? i : p >= 0 ? owner[p]! : -1;
      expr[i] = nd.state != null ? `s[${i}]` : up;
      if (nd.state != null) lines.push(`s[${i}] = ${nd.persist ? `${use('sp')}(${up}, f[${nd.state}], ${nd.sid}, ${str(nd.persist)})` : `${use('st')}(${up}, f[${nd.state}], ${nd.sid})`};`);
      for (const b of nd.b) if (b.k == 'model' && b.p != null) lines.push(`${use('pm')}(${expr[i]}, ${str(b.p)}, f[${b.a}]);`);
    });
    if (lines.length) lines.unshift('const s = [];');
    return { lines, expr, owner };
  };

  /** the writes of one node list; `n`: its elements (an array expression), in `defs` order */
  const writeLines = (defs: NodeDef[], sc: string[]): string[] => {
    const out: string[] = [];
    defs.forEach((nd, i) => {
      for (const b of nd.b) {
        if (b.k == 'else') continue;
        const call = (wr: string, name?: string) => `${use('w')}(n[${i}], f[${b.f}], ${sc[i]}, ${wr}${name !== undefined ? `, ${str(name)}` : ''});`;
        if (b.k == 'if') out.push(call(`(t, v) => ${use('iff')}(t, v, ${b.y != null ? `n[${b.y}]` : 'null'}, ${branch(b.x!)}, ${elseOf(defs, b)}, ${sc[i]})`));
        else if (b.k == 'class') out.push(b.n ? call(use('cls'), b.n) : call(use('pair')));
        // an attribute needs the browser's URL check only if it is a URL attribute and its scheme is not fixed by the expression
        else if (b.k == 'attr') out.push(call(use(URL_ATTR.test(b.n!.toLowerCase()) || b.n!.toLowerCase().endsWith('srcset') ? (fns[b.f!] != null && fixedScheme(fns[b.f!]!) ? 'set' : 'attr') : 'set'), b.n));
        else if (WRITER[b.k]) out.push(call(use(WRITER[b.k]!), b.n));
      }
    });
    return out;
  };

  /** the renderer of a template's branch: `(ns, b) => …` over its cloned nodes and the branch's base scope */
  const branch = (x: number): string => {
    const def = ir.templates[x];
    if (!def || !def.nodes.length) return '0';
    const els = def.nodes.map((nd) => `${use('at')}(ns, ${str(nd.path)}, ${str(nd.tag)})`);
    const sc = scopeOf(def.nodes, 'b');
    return `(ns, b) => { const n = [${els.join(', ')}]; ${[...sc.lines, ...writeLines(def.nodes, sc.expr)].join(' ')} }`;
  };
  const elseOf = (defs: NodeDef[], b: Binding): string => {
    if (b.y == null) return '0';
    const e = defs[b.y]!.b.find((x) => x.k == 'else');
    return e ? branch(e.x!) : '0';
  };

  // the roots' state scopes, made before the early requests (which read them, by `owner`) and the render
  const root = scopeOf(ir.roots, '$');
  const scopes = root.lines.length ? `($) => { ${root.lines.join(' ')} return s; }` : '() => []';
  const ids = ir.roots.map((nd) => nd.id);
  const writes = writeLines(ir.roots, root.expr);
  const render = writes.length ? `(d, s, $) => { const n = ${use('byId')}(d, ${str(ids)}); ${writes.join(' ')} }` : '() => {}';
  return { scopes, render, uses: [...uses].sort(), owner: root.owner };
}
