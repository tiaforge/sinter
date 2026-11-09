// The early file's renderer, compiled per page: what `@tiaforge-ui/sinter/early` used to interpret
// from the early IR (the state scopes with persisted values, then each binding's first write, and
// each early `data-sn-if` branch with its bindings) as straight-line code over the early table `f`.
// It calls only the writers the page's bindings use, so the early file bundles only those (a page
// with no attribute binding carries no URL check). Same order and same failures as the interpreter
// had: every scope (persisted values applied) before any write; a binding that throws is left to the
// page module; an element that is missing is skipped.
import type { Binding, EarlyIR, NodeDef } from '../ir.js';

/** The early module's exports the renderer calls, by binding kind (`class` without a name: a `[name, on]` pair). */
const WRITER: Record<string, string> = { text: 'text', show: 'show', attr: 'attr', style: 'style', model: 'model' };

export interface EarlyRender {
  /** `($) => scopes`: the root nodes' scopes over the base scope `$` (the early requests read them too) */
  scopes: string;
  /** `(d, s) => void`: renders over the document `d`, `s` the root scopes */
  render: string;
  /** the early module's exports both call */
  uses: string[];
}

export function earlyRender(ir: EarlyIR): EarlyRender {
  const uses = new Set<string>();
  const use = (n: string) => (uses.add(n), n);
  const str = JSON.stringify;

  /** each node's scope, in `s`, over `base`: its state (persisted values applied), its persisted models */
  const scopeLines = (defs: NodeDef[], base: string): string[] => {
    const out = ['const s = [];'];
    defs.forEach((nd, i) => {
      const p = (nd.p ?? -1) >= 0 ? `s[${nd.p}]` : base;
      out.push(`s[${i}] = ${nd.state != null ? `${use('st')}(${p}, f[${nd.state}], ${nd.sid}${nd.persist ? `, ${str(nd.persist)}` : ''})` : p};`);
      for (const b of nd.b) if (b.k == 'model' && b.p != null) out.push(`${use('pm')}(s[${i}], ${str(b.p)}, f[${b.a}]);`);
    });
    return out;
  };

  /** the writes of one node list; `n`: its elements (an array expression), in `defs` order */
  const writeLines = (defs: NodeDef[]): string[] => {
    const out: string[] = [];
    defs.forEach((nd, i) => {
      for (const b of nd.b) {
        if (b.k == 'else') continue;
        const call = (wr: string, name?: string) => `${use('w')}(n[${i}], f[${b.f}], s[${i}], ${wr}${name !== undefined ? `, ${str(name)}` : ''});`;
        if (b.k == 'if') out.push(call(`(t, v) => ${use('iff')}(t, v, ${b.y != null ? `n[${b.y}]` : 'null'}, ${branch(b.x!)}, ${elseOf(defs, b)}, s[${i}])`));
        else if (b.k == 'class') out.push(b.n ? call(use('cls'), b.n) : call(use('pair')));
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
    return `(ns, b) => { const n = [${els.join(', ')}]; ${[...scopeLines(def.nodes, 'b'), ...writeLines(def.nodes)].join(' ')} }`;
  };
  const elseOf = (defs: NodeDef[], b: Binding): string => {
    if (b.y == null) return '0';
    const e = defs[b.y]!.b.find((x) => x.k == 'else');
    return e ? branch(e.x!) : '0';
  };

  const scopes = `($) => { ${scopeLines(ir.roots, '$').join(' ')} return s; }`;
  const ids = ir.roots.map((nd) => nd.id);
  const writes = writeLines(ir.roots);
  const render = writes.length ? `(d, s) => { const n = ${use('byId')}(d, ${str(ids)}); ${writes.join(' ')} }` : '() => {}';
  return { scopes, render, uses: [...uses].sort() };
}
