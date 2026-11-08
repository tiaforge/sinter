// @tiaforge-ui/sinter/early: what a page's early chunk runs before the first paint. It renders,
// once, the bindings the compiler found renderable before any data: page-level values from state
// (persisted values read from storage) and helpers, and the branch of each such `data-sn-if`.
// No reactivity, no requests: the page module mounts later and takes the rendered DOM over
// (an early branch is adopted, not rendered again).
import { config } from './runtime/config.js';
import { schemesOf, STYLE_BAD, urlAllowed } from './runtime/security.js';
import type { Binding, EarlyIR, NodeDef } from './ir.js';

export { $k } from './runtime/security.js';

/** On a `data-sn-if` template the early chunk rendered: the branch, its nodes and end marker, for the runtime to adopt. */
export const EARLY = Symbol.for('sinter.early');
export interface EarlyBranch { br: number; nodes: Node[]; end: Comment }

type Fn = (...a: any[]) => any;

export function early(doc: Document, o: { ir: EarlyIR; fns: Fn[] }): void {
  const { ir, fns } = o, env = config.env, schemes = schemesOf(config.urlSchemes);
  // what is not available before data throws, and the binding is left to the page module
  const base = new Proxy(Object.create(null), {
    get(_, k) {
      if (k == '$locale' && config.locale) return config.locale.get();
      throw Error('sinter: not available early');
    },
  });
  const read = (key: string): unknown => {
    try {
      const v = env.storage()?.getItem('sn:' + key);
      return v == null ? undefined : JSON.parse(v);
    } catch { return undefined; }
  };
  const byId = new Map<number, Element>();
  for (const el of doc.querySelectorAll('[data-sn]')) byId.set(+el.getAttribute('data-sn')!, el);
  bind(ir.roots, ir.roots.map((n) => byId.get(n.id!) ?? null), base);

  function bind(defs: NodeDef[], els: Array<Element | null>, s0: any) {
    const scopes: any[] = [], todo: Array<[Binding, Element, any]> = [];
    defs.forEach((nd, i) => {
      const el = els[i];
      let s = nd.p >= 0 ? scopes[nd.p] ?? s0 : s0;
      if (nd.state != null) {
        let obj: any = {};
        try { obj = fns[nd.state]!(s); } catch { /* a field that throws: none known */ }
        // as the persist feature does at mount
        const v = nd.persist ? read(nd.persist) : undefined;
        if (v && typeof v == 'object') for (const k of Object.keys(obj)) if (Object.hasOwn(v, k)) obj[k] = (v as any)[k];
        s = Object.assign(Object.create(s), { ['$s' + nd.sid]: obj });
      }
      scopes[i] = s;
      if (el) for (const b of nd.b) {
        if (b.k == 'model' && b.p != null) {
          const v = read(b.p);
          if (v !== undefined) try { fns[b.a!]!(s, v); } catch { /* ignored */ }
        }
        todo.push([b, el, s]);
      }
    });
    // persisted values are in place before anything is written, as at mount
    for (const [b, el, s] of todo) {
      if (b.k == 'else') continue;
      let v: any;
      try { v = fns[b.f!]!(s); } catch { continue; }
      if (b.k == 'if') branch(el as HTMLTemplateElement, b, v, s, defs, els);
      else write(el as never, b, v);
    }
  }

  function branch(tpl: HTMLTemplateElement, b: Binding, v: unknown, s: any, defs: NodeDef[], els: Array<Element | null>) {
    const other = b.y != null ? els[b.y] as HTMLTemplateElement | null : null;
    const br = v ? 1 : other ? 2 : 0;
    if (!br) return;
    const [t, x] = br == 1 ? [tpl, b.x!] : [other!, defs[b.y!]!.b.find((e) => e.k == 'else')!.x!];
    const def = ir.templates[x];
    const content = t.content, one = content.firstChild == content.lastChild && content.firstChild?.nodeType == 1 && (content.firstChild as Element).localName != 'template';
    const frag = content.cloneNode(true) as DocumentFragment, nodes = [...frag.childNodes];
    const end = new Comment();
    tpl.after(end);
    end.before(...nodes);
    (tpl as any)[EARLY] = { br, nodes, end } satisfies EarlyBranch;
    if (!def) return;
    // the runtime's path walk: path[0] is a child of the content, the rest descend
    const found = def.nodes.map((nd) => {
      const path = nd.path!;
      let n: Node | null = one ? (path[0] == 0 ? nodes[0]! : null) : nodes[path[0]!] ?? null;
      for (let k = 1; k < path.length && n; k++) {
        n = n.firstChild;
        for (let c = path[k]!; c-- && n;) n = n.nextSibling;
      }
      return n && (n as Element).localName == nd.tag ? n as Element : null;
    });
    bind(def.nodes, found, Object.create(s));
  }

  /** As the runtime's first write. */
  function write(el: HTMLElement & HTMLInputElement & HTMLSelectElement, b: Binding, v: any) {
    const n = b.n!;
    switch (b.k) {
      case 'text': el.textContent = '' + (v ?? ''); break;
      case 'show': el.hidden = !v; break;
      case 'class':
        if (n) { if (v || el.hasAttribute('class')) el.classList.toggle(n, !!v); }
        else if (v?.[0]) el.classList.toggle(v[0], !!v[1]);
        break;
      case 'attr':
        if (/^(checked|selected|indeterminate|value)$/.test(n) && n in el) (el as any)[n] = n == 'value' ? (v == null || v === false || v === true ? '' : v) : v != null && v !== false;
        if (v == null || v === false) el.removeAttribute(n);
        else if (urlAllowed(el, n, (v = v === true ? '' : '' + v), el.baseURI, schemes)) el.setAttribute(n, v);
        break;
      case 'style':
        if (v == null || v === false) el.style.removeProperty(n);
        else if (!STYLE_BAD.test(v)) el.style.setProperty(n, v);
        break;
      case 'model': {
        const has = (x: string) => Array.isArray(v) && v.map(String).includes(x);
        if (n == 'checkbox') el.checked = Array.isArray(v) ? has(el.value) : !!v;
        else if (n == 'radio') el.checked = v != null && '' + v == el.value;
        else if (n == 'multi') for (const opt of el.options) opt.selected = has(opt.value);
        else if (el.value != (v ?? '')) el.value = v ?? '';
      }
    }
  }
}
