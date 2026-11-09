// The fixed size of an element, from the stylesheets the page loads: a small cascade (selectors,
// layers, specificity, order, !important, inline style, custom properties) and value resolution
// (calc/min/max/clamp of px, rem and % of a parent with a fixed width). It answers only what
// does not depend on layout: anything else (a fluid parent, a media query or a state that could
// change the value, a selector it does not know, a value set at runtime) is `null`, and the image
// stays fluid. A wrong size would make it blurry; no size only costs bytes. See docs/images.md.
import * as csstree from 'css-tree';
import type { DefaultTreeAdapterMap } from 'parse5';

type P5Element = DefaultTreeAdapterMap['element'];
type P5Node = DefaultTreeAdapterMap['node'];
type P5Parent = DefaultTreeAdapterMap['parentNode'];
type P5Template = DefaultTreeAdapterMap['template'];

export interface StyleSheet {
  /** for messages */
  file: string;
  /** with `@import`s inlined (the adapter's job) */
  css: string;
}

/** An element's box in CSS px; `height` null: it follows the image's ratio. */
export interface FixedBox {
  width: number;
  height: number | null;
  /** `object-fit` / `object-position` as they apply, and whether they come from the inline style */
  fit: string | null;
  position: string | null;
  inlineFit: boolean;
}

type Match = 'yes' | 'no' | 'maybe';
/** [layer path (larger wins), specificity, order] */
interface Decl { prop: string; value: string; important: boolean; layer: number[]; spec: [number, number, number]; order: number; conditional: boolean; inline?: boolean;
  /** the preludes of the `@media` rules around it (all must match) */
  media?: string[] }
interface Rule { selectors: Array<{ ast: csstree.Selector; spec: [number, number, number] }>; decls: Decl[] }

/** the properties this reads (and their aliases), and what a declaration of any of them on a parent means */
const SIZE = { width: ['width', 'inline-size'], height: ['height', 'block-size'], 'min-width': ['min-width', 'min-inline-size'], 'max-width': ['max-width', 'max-inline-size'], 'min-height': ['min-height', 'min-block-size'], 'max-height': ['max-height', 'max-block-size'] } as const;
const GRID_TRACKS = /^(grid|grid-template(-columns|-areas)?|grid-auto-columns)$/;
const TABLE = new Set(['table', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th', 'caption']);
const BLOCK = new Set(['html', 'body', 'div', 'p', 'section', 'article', 'header', 'footer', 'main', 'nav', 'aside', 'figure', 'figcaption', 'li', 'ul', 'ol', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'dl', 'dd', 'dt', 'fieldset', 'details', 'summary', 'dialog', 'address', 'hgroup', 'menu', 'search', 'pre', 'hr']);
/** pseudo-classes that depend on state or on things not in the markup */
const STRUCTURAL = new Set(['first-child', 'last-child', 'only-child', 'nth-child', 'nth-last-child', 'first-of-type', 'last-of-type', 'only-of-type', 'nth-of-type', 'nth-last-of-type']);

const parsed = new Map<string, Rule[]>();

/** Rules of one stylesheet, parsed once per text. */
function rulesOf(css: string): Rule[] {
  let rules = parsed.get(css);
  if (rules) return rules;
  rules = [];
  const ranks = new Map<string, number[]>();
  /** each layer's children in order of first appearance */
  const kids = new Map<string, string[]>();
  let anon = 0, order = 0;
  const rank = (path: string[]): number[] => {
    const key = path.join('.');
    let r = ranks.get(key);
    if (r) return r;
    r = [];
    for (let i = 0; i < path.length; i++) {
      const parent = path.slice(0, i).join('.');
      const list = kids.get(parent) ?? [];
      if (!list.includes(path[i]!)) list.push(path[i]!);
      kids.set(parent, list);
      r.push(list.indexOf(path[i]!));
    }
    ranks.set(key, r);
    return r;
  };
  let ast: csstree.CssNode;
  try {
    ast = csstree.parse(css, { parseValue: false, parseCustomProperty: false, onParseError: () => {} });
  } catch {
    parsed.set(css, rules);
    return rules;
  }
  const visit = (list: csstree.List<csstree.CssNode> | null | undefined, layer: string[], conditional: boolean, parentSel: string | null, media: string[] = []) => {
    list?.forEach((node) => {
      if (node.type === 'Atrule') {
        const name = node.name.toLowerCase();
        const prelude = node.prelude ? csstree.generate(node.prelude).trim() : '';
        if (name === 'layer') {
          const names = prelude ? prelude.split(',').map((n) => n.trim().split('.')) : [[`\0anon${anon++}`]];
          if (!node.block) { for (const n of names) rank([...layer, ...n]); return; }
          const path = [...layer, ...names[0]!];
          rank(path);
          visit(node.block.children, path, conditional, parentSel, media);
        } else if (name === 'media' && node.block) {
          // a media query: kept, so a viewport's evaluation (layout.at()) knows whether it applies
          visit(node.block.children, layer, conditional, parentSel, [...media, prelude]);
        } else if (node.block) {
          // @supports, @container, @scope, @starting-style: may or may not apply
          visit(node.block.children, layer, true, parentSel, media);
        }
        return;
      }
      if (node.type !== 'Rule') return;
      let selText = csstree.generate(node.prelude);
      if (parentSel !== null) selText = selText.split(',').map((s) => (s.includes('&') ? s.replace(/&/g, `:is(${parentSel})`) : `:is(${parentSel}) ${s}`)).join(',');
      let selectors: Rule['selectors'];
      try {
        const list = csstree.parse(selText, { context: 'selectorList' }) as csstree.SelectorList;
        selectors = list.children.toArray().map((s) => ({ ast: s as csstree.Selector, spec: specificity(s as csstree.Selector) }));
      } catch {
        // a selector this cannot parse: its declarations may apply anywhere
        selectors = [{ ast: { type: 'Selector', children: new csstree.List<csstree.CssNode>().fromArray([{ type: 'PseudoClassSelector', name: '\0unknown', children: null }]) }, spec: [0, 0, 0] }];
      }
      const r = rank(layer);
      const decls: Decl[] = [];
      const nested = new csstree.List<csstree.CssNode>();
      const decl = (prop: string, value: string, important: boolean) =>
        decls.push({ prop: prop.startsWith('--') ? prop : prop.toLowerCase(), value: value.trim(), important, layer: layer.length ? r : [Infinity], spec: [0, 0, 0], order: order++, conditional, ...(media.length ? { media } : {}) });
      node.block.children.forEach((d) => {
        if (d.type === 'Declaration') decl(d.property, typeof d.value === 'object' && d.value.type === 'Raw' ? d.value.value : csstree.generate(d.value), !!d.important);
        else if (d.type === 'Rule' || d.type === 'Atrule') nested.push(d);
        else if (d.type === 'Raw') {
          // a block css-tree could not read as declarations: nested rules without `&` (`img { … }`)
          for (const seg of segments(d.value)) {
            if (seg.body === null) {
              const i = seg.head.indexOf(':');
              if (i < 0) continue;
              let value = seg.head.slice(i + 1);
              const important = /!\s*important\s*$/i.test(value);
              if (important) value = value.replace(/!\s*important\s*$/i, '');
              decl(seg.head.slice(0, i).trim(), value, important);
            } else {
              const sub = csstree.parse(`${seg.head}{${seg.body}}`, { parseValue: false, parseCustomProperty: false, onParseError: () => {} }) as csstree.StyleSheet;
              sub.children.forEach((x) => { nested.push(x); });
            }
          }
        }
      });
      if (decls.length) rules!.push({ selectors, decls });
      if (nested.size) visit(nested, layer, conditional, selText, media);
    });
  };
  visit((ast as csstree.StyleSheet).children, [], false, null);
  // a layer path is compared element by element; a layer's own rules beat its sublayers'
  for (const r of rules) for (const d of r.decls) if (d.layer[0] !== Infinity) d.layer = [...d.layer, Infinity];
  parsed.set(css, rules);
  return rules;
}

function specificity(sel: csstree.Selector): [number, number, number] {
  let a = 0, b = 0, c = 0;
  sel.children.forEach((n) => {
    if (n.type === 'IdSelector') a++;
    else if (n.type === 'ClassSelector' || n.type === 'AttributeSelector') b++;
    else if (n.type === 'TypeSelector' && n.name !== '*') c++;
    else if (n.type === 'PseudoElementSelector') c++;
    else if (n.type === 'PseudoClassSelector') {
      const name = n.name.toLowerCase();
      if (name === 'where') return;
      if (['is', 'not', 'has', 'matches'].includes(name) && n.children) {
        let best: [number, number, number] = [0, 0, 0];
        n.children.forEach((l) => (l as csstree.SelectorList).children?.forEach((s) => {
          const x = specificity(s as csstree.Selector);
          if (cmp3(x, best) > 0) best = x;
        }));
        a += best[0]; b += best[1]; c += best[2];
        return;
      }
      b++;
    }
  });
  return [a, b, c];
}

const cmp3 = (x: [number, number, number], y: [number, number, number]) => x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
const cmpLayer = (x: number[], y: number[]) => {
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const a = x[i] ?? -1, b = y[i] ?? -1;
    if (a !== b) return a > b ? 1 : -1;
  }
  return 0;
};
/** > 0: `x` wins over `y` */
function cascadeCmp(x: Decl, y: Decl): number {
  if (x.important !== y.important) return x.important ? 1 : -1;
  if (!!x.inline !== !!y.inline) return x.inline ? 1 : -1;
  const l = cmpLayer(x.layer, y.layer);
  if (l) return x.important ? -l : l;
  return cmp3(x.spec, y.spec) || x.order - y.order;
}

const isEl = (n: P5Node | null | undefined): n is P5Element => !!n && 'tagName' in n;
const attrOf = (el: P5Element, name: string) => el.attrs.find((a) => a.name === name)?.value;
const dynamic = (el: P5Element, kind: 'class' | 'style') => el.attrs.some((a) => a.name === `data-sn-${kind}`);
/**
 * Attributes a binding may change on `el`: `data-sn-attr`'s keys (literal, the compiler requires
 * it), `value`/`checked` for a model; 'all' when the keys cannot be read here.
 */
function boundAttrs(el: P5Element): Set<string> | 'all' {
  const out = new Set<string>();
  for (const a of el.attrs) {
    if (a.name === 'data-sn-model') { out.add('value'); out.add('checked'); }
    if (a.name !== 'data-sn-attr') continue;
    const text = a.value.trim();
    if (!text.startsWith('{')) return 'all';
    // the keys at the object's top level
    let depth = 0, start = 1;
    for (let i = 1; i < text.length; i++) {
      const ch = text[i]!;
      if (ch === '(' || ch === '[' || ch === '{') depth++;
      else if (ch === ')' || ch === ']' || ch === '}') { if (depth === 0) break; depth--; }
      else if (ch === '"' || ch === "'" || ch === '`') { const q = ch; for (i++; i < text.length && text[i] !== q; i++) if (text[i] === '\\') i++; }
      else if (ch === ',' && depth === 0) start = i + 1;
      else if (ch === ':' && depth === 0 && start >= 0) {
        const key = text.slice(start, i).trim().replace(/^(['"])(.*)\1$/, '$2');
        if (!/^[\w-]+$/.test(key)) return 'all';
        out.add(key.toLowerCase());
        start = -1;
      }
    }
    if (out.size === 0 && text !== '{}') return 'all';
  }
  return out;
}
const mayChange = (el: P5Element, name: string) => { const b = boundAttrs(el); return b === 'all' || b.has(name); };

interface Cascaded { value: string | null; ambiguous: boolean; inline: boolean }

export class Layout {
  private readonly rules: Rule[] = [];
  /** template content → its template, so the content's parent is where it renders */
  private readonly hosts = new Map<P5Parent, P5Element>();
  private readonly cascades = new Map<P5Element, Map<string, Decl[]>>();
  private readonly vars = new Map<P5Element, Map<string, string | null | undefined>>();
  private readonly widths = new Map<P5Element, number | null>();
  private root: P5Element | null = null;
  /** a viewport width: `@media` width conditions are decided for it (`at()`); undefined: they may or may not apply */
  private viewport: number | undefined;
  private readonly views = new Map<number, Layout>();

  constructor(sheets: StyleSheet[], doc: P5Parent) {
    let order = 0;
    // the browser's own defaults that move a box's edges: below every author rule, as the UA origin is
    for (const r of rulesOf(UA)) this.rules.push({ selectors: r.selectors, decls: r.decls.map((d) => ({ ...d, layer: [-1], order: order++ })) });
    for (const s of sheets) for (const r of rulesOf(s.css)) {
      // the order counts across sheets: later sheets win at equal layer and specificity
      this.rules.push({ selectors: r.selectors, decls: r.decls.map((d) => ({ ...d, order: order++ })) });
    }
    const walk = (p: P5Parent) => {
      for (const c of p.childNodes) {
        if (!isEl(c)) continue;
        if (c.tagName === 'html') this.root = c;
        if (c.tagName === 'template') { this.hosts.set((c as P5Template).content, c); walk((c as P5Template).content); }
        walk(c);
      }
    };
    walk(doc);
  }

  get empty() { return this.rules.length === 0; }

  /** The same page at a viewport `width` px wide: width media queries apply or do not. */
  at(width: number): Layout {
    let l = this.views.get(width);
    if (l) return l;
    l = Object.create(Layout.prototype) as Layout;
    Object.assign(l, {
      rules: this.rules, hosts: this.hosts, root: this.root, viewport: width, views: this.views,
      cascades: new Map(), vars: new Map(), widths: new Map(), bounds: new Map(),
    });
    this.views.set(width, l);
    return l;
  }

  /** every viewport width at which a width media query of the page's stylesheets starts or stops applying */
  breakpoints(): number[] {
    const out = new Set<number>();
    for (const r of this.rules) for (const d of r.decls) {
      const ranges = d.media ? mediaRanges(d.media) : null;
      if (ranges && ranges !== 'unknown') for (const [lo, hi] of ranges) { if (lo > 0) out.add(lo); if (Number.isFinite(hi)) out.add(hi); }
    }
    return [...out].sort((a, b) => a - b);
  }

  /**
   * The fixed box of `el` (an `<img>`); `fluid` when the stylesheets set its width but not to a
   * fixed size (or might); null when they do not set it (its `width` attribute decides).
   */
  box(el: P5Element): FixedBox | 'fluid' | null {
    if (this.empty) return null;
    const wc = this.cascaded(el, SIZE.width);
    if (!wc.ambiguous && wc.value === null) return null;
    const width = this.size(el, 'width');
    if (width === null) return 'fluid';
    let height = this.size(el, 'height');
    if (height === null) {
      const ar = this.cascaded(el, ['aspect-ratio']);
      if (ar.ambiguous) return null;
      const r = ar.value ? ratioOf(this.subst(ar.value, el)) : null;
      if (r === undefined) return 'fluid';
      if (r) height = Math.round(width / r);
    }
    const hc = this.cascaded(el, SIZE.height);
    if (height === null && (hc.ambiguous || (hc.value !== null && !/^auto$/i.test(hc.value.trim())))) return 'fluid';
    const fit = this.cascaded(el, ['object-fit']), pos = this.cascaded(el, ['object-position']);
    if (fit.ambiguous || pos.ambiguous) return 'fluid';
    return { width, height, fit: fit.value?.toLowerCase() ?? null, position: pos.value, inlineFit: fit.inline };
  }

  /**
   * An upper bound of a fluid image's rendered width in px (it may be narrower), or null when nothing
   * below the viewport bounds it: its own absolute `max-width`, its `width` attribute, and, while it
   * cannot overflow them, each container's fixed width or absolute `max-width` (`.prose { max-width:
   * 65ch }` is not absolute; `main { max-width: 1200px }` is). Feeds `sizes`; it never makes a box.
   */
  maxWidth(img: P5Element): number | null {
    if (this.empty) return null;
    return this.bound(img, true);
  }

  private readonly bounds = new Map<P5Element, number | null>();

  private bound(el: P5Element, isImg: boolean): number | null {
    if (!isImg && this.bounds.has(el)) return this.bounds.get(el)!;
    if (!isImg) this.bounds.set(el, null); // cycle guard
    const result = this.computeBound(el, isImg);
    if (!isImg) this.bounds.set(el, result);
    return result;
  }

  private computeBound(el: P5Element, isImg: boolean): number | null {
    if (el === this.root) return null;
    const parent = () => { const p = this.parentOf(el); return p ? this.bound(p, false) : null; };
    const dc = this.cascaded(el, ['display']);
    if (dc.ambiguous) return null;
    const display = (dc.value ?? (isImg ? 'inline' : BLOCK.has(el.tagName) ? 'block' : TABLE.has(el.tagName) ? 'table' : 'inline')).trim().toLowerCase();
    if (display === 'none') return null;
    // an inline box (a link around the image) and `contents` take their width from their container
    if (display === 'contents' || (display === 'inline' && !isImg)) return parent();
    const rem = this.rootFont();
    if (rem === null) return null;
    const fixed = this.size(el, 'width');
    if (fixed !== null) return fixed;
    const abs = (props: readonly string[]): number | null | undefined => {
      const c = this.cascaded(el, props);
      if (c.ambiguous) return undefined;
      if (c.value === null || /%|^\s*(none|auto)\s*$/i.test(c.value)) return null;
      const v = this.subst(c.value, el);
      return v === undefined ? undefined : evaluate(v, { rem, percent: 0 });
    };
    let own = abs(SIZE['max-width']) ?? null;
    if (isImg) {
      // the `width` attribute, when no stylesheet sets the width
      const wc = this.cascaded(el, SIZE.width);
      const a = attrOf(el, 'width');
      if (!wc.ambiguous && wc.value === null && a && /^\s*\d+\s*$/.test(a)) own = own === null ? Number(a) : Math.min(own, Number(a));
    }
    if (!this.contained(el, isImg)) return own;
    const p = parent();
    return p === null ? own : own === null ? p : Math.min(own, p);
  }

  /** `el` is no wider than its container's content box: no positioning out of flow, negative margin, `vw` or `min-width` */
  private contained(el: P5Element, isImg: boolean): boolean {
    const m = this.declsOf(el);
    // out of flow if any rule that may apply says so (`relative` from an `:has()` rule that may or may not match is fine)
    if (m.has('\0dynamic') || (m.get('position') ?? []).some((d) => !/^\s*(static|relative|sticky)\s*$/i.test(d.value))) return false;
    for (const [prop, list] of m) if (/^margin(-(left|right|inline|inline-start|inline-end))?$/.test(prop) && list.some((d) => /-\s*[\d.]|var\(|calc\(|min\(|max\(|clamp\(/.test(d.value))) return false;
    const minW = this.cascaded(el, SIZE['min-width']);
    if (minW.ambiguous || (minW.value !== null && !/^\s*(0[a-z%]*|auto)\s*$/i.test(minW.value))) return false;
    const pct = (v: string | null) => { const x = v === null ? null : /^\s*(\d+(?:\.\d+)?)%\s*$/.exec(v); return x ? Number(x[1]) <= 100 : false; };
    const maxW = this.cascaded(el, SIZE['max-width']);
    if (!maxW.ambiguous && pct(maxW.value)) return true;
    const w = this.cascaded(el, SIZE.width);
    if (w.ambiguous) return false;
    if (pct(w.value) || /^\s*fit-content\s*$/i.test(w.value ?? '')) return true;
    // an image's auto width is its own size; a box's fills its container
    return !isImg && (w.value === null || /^\s*auto\s*$/i.test(w.value));
  }

  private parentOf(el: P5Element): P5Element | null {
    let p = el.parentNode as P5Parent | null;
    while (p && !isEl(p as P5Node)) {
      const host = this.hosts.get(p);
      if (!host) return null;
      p = host.parentNode as P5Parent | null;
    }
    return (p as P5Element) ?? null;
  }

  private inTemplate(el: P5Element): boolean {
    for (let p = el.parentNode as P5Parent | null; p; p = (isEl(p as P5Node) ? (p as P5Element).parentNode : this.hosts.get(p) ?? null) as P5Parent | null) {
      if (this.hosts.has(p)) return true;
    }
    return false;
  }

  /** declarations of `el` per property, matched (or maybe matched), in no particular order */
  private declsOf(el: P5Element): Map<string, Decl[]> {
    let m = this.cascades.get(el);
    if (m) return m;
    m = new Map();
    for (const r of this.rules) {
      let best: { match: Match; spec: [number, number, number] } | null = null;
      for (const s of r.selectors) {
        const x = this.matches(s.ast.children.toArray(), el);
        if (x === 'no') continue;
        if (!best || (x === 'yes' && best.match === 'maybe') || (x === best.match && cmp3(s.spec, best.spec) > 0)) best = { match: x, spec: s.spec };
      }
      if (!best) continue;
      for (const d of r.decls) {
        // a media query: decided for this layout's viewport, else it may or may not apply
        let media = !!d.media;
        if (d.media && this.viewport !== undefined) {
          const ranges = mediaRanges(d.media);
          if (ranges !== 'unknown') {
            if (!ranges.some(([lo, hi]) => this.viewport! >= lo && this.viewport! < hi)) continue;
            media = false;
          }
        }
        const list = m.get(d.prop) ?? [];
        list.push({ ...d, spec: best.spec, conditional: d.conditional || media || best.match === 'maybe' });
        m.set(d.prop, list);
      }
    }
    const style = attrOf(el, 'style');
    if (dynamic(el, 'style')) m.set('\0dynamic', []);
    if (style) for (const part of style.split(';')) {
      const i = part.indexOf(':');
      if (i < 0) continue;
      let value = part.slice(i + 1).trim();
      const important = /!\s*important$/i.test(value);
      if (important) value = value.replace(/!\s*important$/i, '').trim();
      const raw = part.slice(0, i).trim();
      const prop = raw.startsWith('--') ? raw : raw.toLowerCase();
      const list = m.get(prop) ?? [];
      list.push({ prop, value, important, layer: [Infinity], spec: [1, 0, 0] as [number, number, number], order: Infinity, conditional: false, inline: true });
      m.set(prop, list);
    }
    this.cascades.set(el, m);
    return m;
  }

  /** the winning declaration among `props` (aliases share one value); ambiguous when one that may apply could win */
  private cascaded(el: P5Element, props: readonly string[]): Cascaded {
    const m = this.declsOf(el);
    const all = props.flatMap((p) => m.get(p) ?? []).sort((a, b) => cascadeCmp(b, a));
    const top = all.findIndex((d) => !d.conditional);
    // an inline style set at runtime (data-sn-style) can set anything
    const ambiguous = (top < 0 ? all.length > 0 : top > 0) || m.has('\0dynamic');
    const d = top >= 0 ? all[top]! : null;
    if (d && /^(inherit|initial|unset|revert|revert-layer)$/i.test(d.value.trim())) return { value: null, ambiguous: true, inline: false };
    return { value: d?.value ?? null, ambiguous, inline: !!d?.inline };
  }

  /** a custom property's computed value: undefined when ambiguous, null when not set */
  private variable(el: P5Element | null, name: string): string | null | undefined {
    if (!el) return null;
    let m = this.vars.get(el);
    if (!m) { m = new Map(); this.vars.set(el, m); }
    if (m.has(name)) return m.get(name);
    m.set(name, undefined); // cycle guard
    const c = this.cascaded(el, [name]);
    let v: string | null | undefined;
    if (c.ambiguous) v = undefined;
    else if (c.value === null) v = this.variable(this.parentOf(el), name);
    else v = this.subst(c.value, el);
    m.set(name, v);
    return v;
  }

  /** `var()` substituted; undefined when a variable is ambiguous or missing without a fallback */
  private subst(value: string, el: P5Element, depth = 0): string | undefined {
    if (depth > 20) return undefined;
    let out = '', i = 0;
    while (i < value.length) {
      const at = value.indexOf('var(', i);
      if (at < 0) { out += value.slice(i); break; }
      out += value.slice(i, at);
      let j = at + 4, level = 1;
      while (j < value.length && level) { if (value[j] === '(') level++; else if (value[j] === ')') level--; j++; }
      const inner = value.slice(at + 4, j - 1);
      const comma = topComma(inner);
      const name = (comma < 0 ? inner : inner.slice(0, comma)).trim();
      const fallback = comma < 0 ? null : inner.slice(comma + 1).trim();
      const v = this.variable(el, name);
      if (v === undefined) return undefined;
      const use = v ?? (fallback !== null ? this.subst(fallback, el, depth + 1) : undefined);
      if (use === undefined) return undefined;
      out += use;
      i = j;
    }
    return out;
  }

  private rootFont(): number | null {
    if (!this.root) return 16;
    const c = this.cascaded(this.root, ['font-size']);
    if (c.ambiguous) return null;
    if (c.value === null) return 16;
    const v = this.subst(c.value, this.root);
    const n = v === undefined ? null : evaluate(v, { rem: 16, percent: 16 });
    return n ?? null;
  }

  /** a fixed width or height of `el` in px, or null */
  private size(el: P5Element, axis: 'width' | 'height'): number | null {
    if (axis === 'width' && this.widths.has(el)) return this.widths.get(el)!;
    if (axis === 'width') this.widths.set(el, null); // cycle guard
    const result = this.computeSize(el, axis);
    if (axis === 'width') this.widths.set(el, result);
    return result;
  }

  private computeSize(el: P5Element, axis: 'width' | 'height'): number | null {
    const c = this.cascaded(el, SIZE[axis]);
    if (c.ambiguous || c.value === null) return null;
    const rem = this.rootFont();
    if (rem === null) return null;
    const value = this.subst(c.value, el);
    if (value === undefined) return null;
    const percent = /%/.test(value) ? this.basis(el, axis) : 0;
    if (percent === null) return null;
    let n = evaluate(value, { rem, percent });
    if (n === null || n <= 0) return null;
    // min/max with absolute values; a percentage max (max-inline-size: 100%) only shrinks, which `sizes` allows for
    for (const [prop, pick] of [[`max-${axis}`, Math.min], [`min-${axis}`, Math.max]] as const) {
      const mc = this.cascaded(el, SIZE[prop]);
      if (mc.ambiguous) { if (prop.startsWith('min')) return null; continue; }
      if (mc.value === null || /%/.test(mc.value) || /^(none|auto)$/i.test(mc.value.trim())) continue;
      const mv = this.subst(mc.value, el);
      const m = mv === undefined ? null : evaluate(mv, { rem, percent: 0 });
      if (m === null) { if (prop.startsWith('min')) return null; continue; }
      n = pick(n, m);
    }
    return Math.round(n * 100) / 100;
  }

  /** the width (or height) a percentage of `el` refers to: its parent's fixed content box, or null */
  private basis(el: P5Element, axis: 'width' | 'height'): number | null {
    const parent = this.parentOf(el);
    if (!parent) return null;
    const pd = this.declsOf(parent);
    const display = this.cascaded(parent, ['display']);
    if (display.ambiguous) return null;
    const d = (display.value ?? (BLOCK.has(parent.tagName) ? 'block' : 'inline')).toLowerCase().trim();
    if (d === 'inline' || d === 'contents' || d === 'none') return null;
    if (/flex/.test(d) && parent.childNodes.filter(isEl).length > 1) return null;
    if (/grid/.test(d)) for (const prop of pd.keys()) if (GRID_TRACKS.test(prop)) return null;
    const size = this.size(parent, axis);
    if (size === null) return null;
    // a percentage refers to the content box: with border-box sizing, the width less its padding and borders
    const bs = this.cascaded(parent, ['box-sizing']);
    if (bs.ambiguous) return null;
    if (!/^\s*border-box\s*$/i.test(bs.value ?? '')) return size;
    const edges = this.edges(parent, axis);
    return edges === null || edges >= size ? null : size - edges;
  }

  /** padding and border widths of `el` on both sides of `axis`, in px; null when one cannot be resolved */
  private edges(el: P5Element, axis: 'width' | 'height'): number | null {
    const rem = this.rootFont();
    if (rem === null) return null;
    let total = 0;
    for (const side of axis === 'width' ? ['left', 'right'] as const : ['top', 'bottom'] as const) {
      const pad = this.edge(el, 'padding', side, rem);
      const style = this.edge(el, 'border-style', side, rem);
      const width = this.edge(el, 'border-width', side, rem);
      if (pad === null || style === null || width === null) return null;
      total += (pad as number) + (/^(none|hidden)$/.test(style as string) ? 0 : (width as number));
    }
    return total;
  }

  /**
   * One side's padding, border width or border style, from the declarations that set it (longhand,
   * logical, shorthands) in cascade order; a horizontal, left-to-right writing mode.
   */
  private edge(el: P5Element, kind: 'padding' | 'border-width' | 'border-style', side: 'left' | 'right' | 'top' | 'bottom', rem: number): number | string | null {
    const initial = kind === 'border-style' ? 'none' : kind === 'border-width' ? 'medium' : '0';
    const v = this.sideValue(el, kind, side);
    if (v === undefined) return null;
    const raw = v ?? initial;
    if (kind === 'border-style') return raw.toLowerCase();
    const kw = { thin: 1, medium: 3, thick: 5 }[raw.toLowerCase() as 'thin'];
    if (kw !== undefined) return kw;
    if (/%/.test(raw)) return null;
    return evaluate(raw, { rem, percent: 0 });
  }

  /**
   * One side's padding, margin, border width or border style as written, from the declarations
   * that set it (longhand, logical, shorthands) in cascade order, in a horizontal left-to-right
   * writing mode; null when none sets it, undefined when that is not known.
   */
  private sideValue(el: P5Element, kind: 'padding' | 'margin' | 'border-width' | 'border-style', side: 'left' | 'right' | 'top' | 'bottom'): string | null | undefined {
    const logical = { left: 'inline-start', right: 'inline-end', top: 'block-start', bottom: 'block-end' }[side];
    const pair = side === 'left' || side === 'right' ? 'inline' : 'block';
    /** position of the side in a 1–4 value box shorthand (top right bottom left) and a 1–2 value logical pair */
    const box = { top: 0, right: 1, bottom: 2, left: 3 }[side], two = side === 'left' || side === 'top' ? 0 : 1;
    const props: Array<[string, (v: string[]) => string | undefined]> = kind === 'padding' || kind === 'margin'
      ? [[`${kind}-${side}`, (v) => v[0]], [`${kind}-${logical}`, (v) => v[0]], [`${kind}-${pair}`, (v) => v[two] ?? v[0]], [kind, (v) => boxValue(v, box)]]
      : [[`border-${side}-${kind.slice(7)}`, (v) => v[0]], [`border-${logical}-${kind.slice(7)}`, (v) => v[0]], [`border-${pair}-${kind.slice(7)}`, (v) => v[two] ?? v[0]], [kind, (v) => boxValue(v, box)],
        ...[`border-${side}`, `border-${logical}`, `border-${pair}`, 'border'].map((p): [string, (v: string[]) => string | undefined] => [p, (v) => borderPart(v, kind)])];
    const c = this.cascaded(el, props.map((x) => x[0]));
    if (c.ambiguous) return undefined;
    if (c.value === null) return null;
    const w = this.winner(el, props.map((x) => x[0]))!;
    const value = this.subst(w.value, el);
    if (value === undefined) return undefined;
    return props.find((x) => x[0] === w.prop)![1](splitTop(value)) ?? null;
  }

  // ---- fluid widths: an image's rendered width as a function of the viewport width

  /**
   * The rendered width of a fluid image at every viewport width, as `sizes`: the cascade per range
   * between the page's width media queries, widths linear in the viewport (`calc(50vw - 24px)`),
   * ranges split where a `min()`/`max-width` or a grid's column count changes. Grid tracks
   * (`repeat(3, 1fr)`, `repeat(auto-fill, minmax(200px, 1fr))`, gaps, `span`), flex rows (equal
   * `flex: 1` columns, wrapped items with a basis) and margins, padding and borders resolve; anything
   * else is null (the caller falls back to `maxWidth()`). Checked against Chromium at many widths.
   */
  fluidSizes(img: P5Element, intrinsic?: number): FluidSizes | null {
    if (this.empty || this.viewport !== undefined) return null;
    const cuts = this.breakpoints().filter((b) => b > MIN_VIEWPORT && b < MAX_VIEWPORT);
    const queue: Array<[number, number]> = [];
    // from the narrowest real screen: a split below it (min(48px, 100vw) at 48) would only add noise
    let lo = MIN_VIEWPORT;
    for (const b of cuts) { queue.push([lo, b]); lo = b; }
    queue.push([lo, Infinity]);
    const pieces: FluidPiece[] = [];
    for (let guard = 0; queue.length; guard++) {
      if (guard > 64) return null;
      const seg = queue.shift()!;
      const mid = Number.isFinite(seg[1]) ? (seg[0] + seg[1]) / 2 : seg[0] + 1000;
      let w: Lin | null;
      try {
        w = this.at(mid).imgWidth(img, seg, intrinsic);
      } catch (e) {
        if (!(e instanceof Split)) throw e;
        // exact: rounded only when written into `sizes`, or the range would still hold the crossover
        const at = e.at;
        if (!(at > seg[0] + 1e-6 && at < seg[1] - 1e-6)) return null;
        queue.unshift([seg[0], at], [at, seg[1]]);
        continue;
      }
      if (!w) return null;
      // a width of 0 or less on any real screen: not an image size the browser can use
      const from = Math.max(seg[0], MIN_VIEWPORT), to = Number.isFinite(seg[1]) ? seg[1] : Infinity;
      if (w.k * from + w.c < 1 || (Number.isFinite(to) ? w.k * to + w.c < 1 : w.k < 0)) return null;
      pieces.push({ from: seg[0], to: seg[1], k: w.k, c: w.c });
    }
    pieces.sort((a, b) => a.from - b.from);
    const merged: FluidPiece[] = [];
    for (const p of pieces) {
      const last = merged[merged.length - 1];
      if (last && Math.abs(last.k - p.k) < 1e-9 && Math.abs(last.c - p.c) < 0.01) last.to = p.to;
      else merged.push({ ...p });
    }
    const last = merged[merged.length - 1]!;
    const max = last.k > 1e-9 ? null : Math.max(...merged.map((p) => Math.max(p.k * Math.max(p.from, MIN_VIEWPORT) + p.c, Number.isFinite(p.to) ? p.k * p.to + p.c : p.c)));
    const sizes = merged.map((p, i) => (i === merged.length - 1 ? linCss(p) : `(max-width: ${maxWidthOf(p.to)}px) ${linCss(p)}`)).join(', ');
    const constant = merged.every((p) => Math.abs(p.k) < 1e-9) ? [...new Set(merged.map((p) => Math.round(p.c)))] : null;
    return { sizes, pieces: merged, max: max === null ? null : Math.ceil(max), constant };
  }

  /** an image's rendered width in this viewport range: its own width, else its `width` attribute, within min/max */
  private imgWidth(img: P5Element, seg: [number, number], intrinsic?: number): Lin | null {
    const parent = this.parentOf(img);
    if (!parent) return null;
    const pd = this.displayOf(parent);
    if (pd === null) return null;
    const avail = /grid/.test(pd) ? this.gridArea(parent, img, seg) : this.contentOf(parent, seg);
    if (!avail) return null;
    const wc = this.cascaded(img, SIZE.width);
    if (wc.ambiguous) return null;
    let w: Lin | null;
    if (wc.value !== null && !/^\s*auto\s*$/i.test(wc.value)) w = this.lin(img, wc.value, avail, seg);
    else {
      // auto: the width attribute (sinter writes the source's); a flex or grid item's is its content size
      if (/flex|grid/.test(pd)) return null;
      const a = attrOf(img, 'width');
      w = a && /^\s*\d+\s*$/.test(a) ? lin(Number(a)) : intrinsic ? lin(intrinsic) : null;
    }
    return w && this.minMax(img, w, avail, seg);
  }

  /** `width`/`height` of a box clamped by its `max-width` and `min-width` (lengths, % of `avail`) */
  private minMax(el: P5Element, w: Lin, avail: Lin, seg: [number, number]): Lin | null {
    const mx = this.cascaded(el, SIZE['max-width']);
    if (mx.ambiguous) return null;
    if (mx.value !== null && !/^\s*none\s*$/i.test(mx.value)) { const v = this.lin(el, mx.value, avail, seg); if (!v) return null; w = pick(w, v, seg, 'min'); }
    const mn = this.cascaded(el, SIZE['min-width']);
    if (mn.ambiguous) return null;
    if (mn.value !== null && !/^\s*(auto|0[a-z%]*)\s*$/i.test(mn.value)) { const v = this.lin(el, mn.value, avail, seg); if (!v) return null; w = pick(w, v, seg, 'max'); }
    return w;
  }

  /** a length (px, rem, vw, % of `percent`, calc/min/max/clamp) in this viewport range */
  private lin(el: P5Element, value: string, percent: Lin | null, seg: [number, number]): Lin | null {
    const rem = this.rootFont();
    if (rem === null) return null;
    const v = this.subst(value, el);
    return v === undefined ? null : evaluateLin(v, rem, percent, seg);
  }

  private displayOf(el: P5Element): string | null {
    if (el === this.root) return 'block';
    const c = this.cascaded(el, ['display']);
    if (c.ambiguous) return null;
    return (c.value ?? (BLOCK.has(el.tagName) ? 'block' : TABLE.has(el.tagName) ? 'table' : 'inline')).trim().toLowerCase();
  }

  /** the width an element's children are laid out in (its content box) */
  private contentOf(el: P5Element, seg: [number, number]): Lin | null {
    if (el === this.root) { const e = this.edges(el, 'width'); return e === null ? null : { k: 1, c: -e }; }
    const d = this.displayOf(el);
    if (d === null || d === 'none') return null;
    // an inline box, `contents`: its children are laid out in its container
    if (d === 'contents' || d === 'inline') { const p = this.parentOf(el); return p ? this.contentOf(p, seg) : null; }
    const box = this.borderBox(el, seg);
    const e = this.edges(el, 'width');
    return box && e !== null ? { k: box.k, c: box.c - e } : null;
  }

  /** a box's border-box width in this viewport range */
  private borderBox(el: P5Element, seg: [number, number]): Lin | null {
    const m = this.declsOf(el);
    if (m.has('\0dynamic') || (m.get('position') ?? []).some((d) => !/^\s*(static|relative|sticky)\s*$/i.test(d.value))) return null;
    if ((m.get('float') ?? []).some((d) => !/^\s*none\s*$/i.test(d.value))) return null;
    const parent = this.parentOf(el);
    if (!parent) return null;
    const pd = this.displayOf(parent), d = this.displayOf(el);
    if (pd === null || d === null) return null;
    let avail: Lin | null;
    if (/grid/.test(pd)) {
      // a grid item stretches over its area unless it is aligned otherwise
      for (const [who, prop] of [[parent, 'justify-items'], [el, 'justify-self']] as const) {
        const j = this.cascaded(who, [prop]);
        if (j.ambiguous || (j.value !== null && !/^\s*(normal|stretch|auto|legacy)\s*$/i.test(j.value))) return null;
      }
      avail = this.gridArea(parent, el, seg);
    } else if (/flex/.test(pd)) {
      const r = this.flexItem(parent, el, seg);
      if (r !== 'stretch') return r;
      avail = this.contentOf(parent, seg);
    } else avail = this.contentOf(parent, seg);
    if (!avail) return null;
    const bs = this.cascaded(el, ['box-sizing']);
    if (bs.ambiguous) return null;
    const borderBox = /^\s*border-box\s*$/i.test(bs.value ?? '');
    const e = this.edges(el, 'width');
    if (e === null) return null;
    const wc = this.cascaded(el, SIZE.width);
    if (wc.ambiguous) return null;
    let box: Lin;
    if (wc.value !== null && !/^\s*auto\s*$/i.test(wc.value)) {
      const v = this.lin(el, wc.value, avail, seg);
      if (!v) return null;
      box = borderBox ? v : { k: v.k, c: v.c + e };
    } else {
      // auto: a block-level box fills the available width less its margins; others shrink to their content
      if (!/^(block|list-item|flow-root|flex|grid|table-cell)$/.test(d)) return null;
      const ml = this.margin(el, 'left', avail, seg), mr = this.margin(el, 'right', avail, seg);
      if (!ml || !mr) return null;
      box = { k: avail.k - ml.k - mr.k, c: avail.c - ml.c - mr.c };
    }
    // min/max apply to the content box unless border-box
    const asBox = (v: Lin) => (borderBox ? v : { k: v.k, c: v.c + e });
    const mx = this.cascaded(el, SIZE['max-width']);
    if (mx.ambiguous) return null;
    if (mx.value !== null && !/^\s*none\s*$/i.test(mx.value)) { const v = this.lin(el, mx.value, avail, seg); if (!v) return null; box = pick(box, asBox(v), seg, 'min'); }
    const mn = this.cascaded(el, SIZE['min-width']);
    if (mn.ambiguous) return null;
    if (mn.value !== null && !/^\s*(auto|0[a-z%]*)\s*$/i.test(mn.value)) { const v = this.lin(el, mn.value, avail, seg); if (!v) return null; box = pick(box, asBox(v), seg, 'max'); }
    return box;
  }

  /** a horizontal margin (auto is 0 here: the box's width is auto or fixed, it does not center by changing width) */
  private margin(el: P5Element, side: 'left' | 'right', avail: Lin, seg: [number, number]): Lin | null {
    const raw = this.sideValue(el, 'margin', side);
    if (raw === undefined) return null;
    if (raw === null || /^\s*auto\s*$/i.test(raw)) return lin(0);
    return this.lin(el, raw, avail, seg);
  }

  /** a column gap (`column-gap`, `gap`, the old `grid-` names), `normal` is 0 */
  private columnGap(el: P5Element, avail: Lin, seg: [number, number]): Lin | null {
    const props = ['column-gap', 'grid-column-gap', 'gap', 'grid-gap'];
    const c = this.cascaded(el, props);
    if (c.ambiguous) return null;
    if (c.value === null) return lin(0);
    const w = this.winner(el, props)!;
    const parts = splitTop(this.subst(w.value, el) ?? '');
    const v = /gap$/.test(w.prop) && !/column/.test(w.prop) ? parts[1] ?? parts[0] : parts[0];
    if (!v || /^normal$/i.test(v)) return lin(0);
    return this.lin(el, v, avail, seg);
  }

  /** the declaration that wins among `props` (not one that may or may not apply) */
  private winner(el: P5Element, props: string[]): { prop: string; value: string } | null {
    const m = this.declsOf(el);
    const all = props.flatMap((p) => (m.get(p) ?? []).map((d) => ({ d, p }))).filter(({ d }) => !d.conditional).sort((a, b) => cascadeCmp(b.d, a.d));
    return all[0] ? { prop: all[0].p, value: all[0].d.value } : null;
  }

  /** the width of the grid area `el` is placed in: equal tracks, a gap, one column or a `span` */
  private gridArea(parent: P5Element, el: P5Element, seg: [number, number]): Lin | null {
    const pm = this.declsOf(parent);
    if (pm.has('grid') || pm.has('grid-template') || pm.has('grid-template-areas')) return null;
    const W = this.contentOf(parent, seg);
    if (!W) return null;
    const gap = this.columnGap(parent, W, seg);
    if (!gap) return null;
    const gc = this.cascaded(parent, ['grid-template-columns']);
    if (gc.ambiguous) return null;
    // the span
    const sc = this.cascaded(el, ['grid-column']);
    const em = this.declsOf(el);
    if (sc.ambiguous || em.has('grid-column-start') || em.has('grid-column-end') || em.has('grid-area')) return null;
    const spanText = (sc.value ?? 'auto').trim();
    const sm = /^span\s+(\d+)(\s*\/\s*auto)?$/i.exec(spanText);
    const full = /^1\s*\/\s*-1$/.test(spanText);
    if (!sm && !full && !/^auto$/i.test(spanText)) return null;
    const area = (track: Lin, n: number) => {
      const span = full ? n : sm ? Math.min(Number(sm[1]), n) : 1;
      return { k: track.k * span + gap.k * (span - 1), c: track.c * span + gap.c * (span - 1) };
    };
    if (gc.value === null || /^\s*none\s*$/i.test(gc.value)) return area(W, 1);
    const text = (this.subst(gc.value, el) ?? '').trim().toLowerCase();
    const auto = /^repeat\(\s*(auto-fill|auto-fit)\s*,\s*(.+)\)$/s.exec(text);
    if (auto) {
      const track = auto[2]!.trim();
      const mm = /^minmax\(\s*([^,]+?)\s*,\s*1fr\s*\)$/.exec(track);
      if (!mm) {
        // a fixed track: its width, however many fit
        const L = this.lin(el, track, W, seg);
        return L && !full && Math.abs(L.k) < 1e-9 && Math.abs(gap.k) < 1e-9 ? area(L, Infinity) : null;
      }
      const min = this.lin(el, mm[1]!, W, seg);
      if (!min || Math.abs(min.k) > 1e-9 || Math.abs(gap.k) > 1e-9 || W.k < -1e-9) return null;
      const step = min.c + gap.c;
      if (step <= 0) return null;
      const count = (v: number) => Math.max(1, Math.floor((W.k * v + W.c + gap.c) / step + 1e-9));
      const n0 = count(seg[0] + 0.01);
      // the viewport width at which one more column fits (a container of fixed width: never)
      if (W.k > 1e-9) {
        const next = ((n0 + 1) * step - gap.c - W.c) / W.k;
        if (next < seg[1]) throw new Split(next);
      }
      let n = n0;
      if (auto[1] === 'auto-fit') {
        // empty tracks collapse: the number of items matters
        if (parent.childNodes.some((c) => isEl(c) && c.tagName === 'template')) return null;
        n = Math.min(n, parent.childNodes.filter((c) => isEl(c)).length);
      }
      return area({ k: (W.k - 0) / n, c: (W.c - (n - 1) * gap.c) / n }, n);
    }
    // a fixed number of tracks; all equal
    const tracks: string[] = [];
    for (const t of splitTop(text)) {
      const rm = /^repeat\(\s*(\d+)\s*,\s*(.+)\)$/s.exec(t);
      if (rm) { for (let i = 0; i < Number(rm[1]); i++) tracks.push(...splitTop(rm[2]!)); } else tracks.push(t);
    }
    const norm = tracks.map((t) => t.replace(/\s+/g, '').replace(/^minmax\(0(px)?,(\d*\.?\d*)fr\)$/, '$2fr'));
    if (!norm.length || norm.some((t) => t !== norm[0])) return null;
    const n = norm.length;
    if (/^\d*\.?\d+fr$/.test(norm[0]!)) return area({ k: (W.k - (n - 1) * gap.k) / n, c: (W.c - (n - 1) * gap.c) / n }, n);
    const L = this.lin(el, tracks[0]!, W, seg);
    return L && area(L, n);
  }

  /** a flex item's border-box width; 'stretch' for a column container (the item fills it like a block) */
  private flexItem(parent: P5Element, el: P5Element, seg: [number, number]): Lin | null | 'stretch' {
    const flow = (prop: 'direction' | 'wrap'): string | null | undefined => {
      const props = [`flex-${prop}`, 'flex-flow'];
      const c = this.cascaded(parent, props);
      if (c.ambiguous) return undefined;
      if (c.value === null) return null;
      const w = this.winner(parent, props)!;
      const parts = splitTop(w.value.toLowerCase());
      if (w.prop !== 'flex-flow') return parts[0] ?? null;
      return parts.find((x) => (prop === 'direction' ? /^(row|column)/.test(x) : /wrap/.test(x))) ?? null;
    };
    const dir = flow('direction');
    if (dir === undefined) return null;
    if (dir && dir.startsWith('column')) {
      for (const [who, prop] of [[parent, 'align-items'], [el, 'align-self']] as const) {
        const a = this.cascaded(who, [prop]);
        if (a.ambiguous || (a.value !== null && !/^\s*(normal|stretch|auto)\s*$/i.test(a.value))) return null;
      }
      return 'stretch';
    }
    const W = this.contentOf(parent, seg);
    if (!W) return null;
    const gap = this.columnGap(parent, W, seg);
    if (!gap) return null;
    const flexOf = (x: P5Element): { grow: number; basis: string } | null => {
      const props = ['flex', 'flex-grow', 'flex-basis'];
      const c = this.cascaded(x, props);
      if (c.ambiguous) return null;
      let grow = 0, basis = 'auto';
      const m = this.declsOf(x);
      const decls = props.flatMap((p) => (m.get(p) ?? []).map((d) => ({ d, p }))).filter(({ d }) => !d.conditional).sort((a, b) => cascadeCmp(a.d, b.d));
      for (const { d, p } of decls) {
        const v = (this.subst(d.value, x) ?? '').trim().toLowerCase();
        if (p === 'flex-grow') grow = Number(v) || 0;
        else if (p === 'flex-basis') basis = v;
        else {
          const parts = splitTop(v);
          if (v === 'none') { grow = 0; basis = 'auto'; } else if (v === 'auto') { grow = 1; basis = 'auto'; } else if (v === 'initial') { grow = 0; basis = 'auto'; }
          else {
            const nums = parts.filter((t) => /^\d*\.?\d+$/.test(t)), other = parts.find((t) => !/^\d*\.?\d+$/.test(t));
            grow = nums.length ? Number(nums[0]) : 1;
            basis = other ?? '0%';
          }
        }
      }
      return { grow, basis };
    };
    const own = flexOf(el);
    if (!own) return null;
    const zero = (b: string) => /^0([a-z%]*)?$/.test(b);
    if (own.grow > 0 && zero(own.basis)) {
      // equal columns: every item grows alike from 0, and their number is known
      if (parent.childNodes.some((c) => isEl(c) && c.tagName === 'template')) return null;
      const items = parent.childNodes.filter((c): c is P5Element => isEl(c));
      for (const it of items) { const f = flexOf(it); if (!f || f.grow !== own.grow || !zero(f.basis)) return null; }
      const n = items.length;
      return { k: (W.k - (n - 1) * gap.k) / n, c: (W.c - (n - 1) * gap.c) / n };
    }
    if (own.grow === 0) {
      // a wrapped item with a basis (or width) keeps it: no line is shrunk to fit
      const wrap = flow('wrap');
      if (wrap === undefined || !wrap || !/^wrap/.test(wrap)) return null;
      let basis = own.basis;
      if (basis === 'auto') { const wc = this.cascaded(el, SIZE.width); if (wc.ambiguous || wc.value === null || /^\s*auto\s*$/i.test(wc.value)) return null; basis = wc.value; }
      if (basis === 'content') return null;
      const bs = this.cascaded(el, ['box-sizing']);
      const e = this.edges(el, 'width');
      if (bs.ambiguous || e === null) return null;
      const v = this.lin(el, basis, W, seg);
      if (!v) return null;
      return this.minMax(el, /^\s*border-box\s*$/i.test(bs.value ?? '') ? v : { k: v.k, c: v.c + e }, W, seg);
    }
    return null;
  }

  // ---- selectors

  private matches(parts: csstree.CssNode[], el: P5Element): Match {
    // split at the last combinator
    let i = parts.length - 1;
    while (i >= 0 && parts[i]!.type !== 'Combinator') i--;
    const compound = parts.slice(i + 1);
    let result = this.compound(compound, el);
    if (result === 'no' || i < 0) return result;
    const comb = (parts[i] as csstree.Combinator).name.trim() || ' ';
    const rest = parts.slice(0, i);
    const combine = (x: Match): Match => (x === 'no' ? 'no' : x === 'maybe' || result === 'maybe' ? 'maybe' : 'yes');
    if (comb === '>') return combine(this.ancestorMatch(rest, el, true));
    if (comb === ' ') return combine(this.ancestorMatch(rest, el, false));
    // siblings
    if (this.inTemplate(el)) return 'maybe';
    const sibs = (el.parentNode?.childNodes ?? []).filter(isEl);
    const at = sibs.indexOf(el);
    const before = comb === '+' ? sibs.slice(Math.max(0, at - 1), at) : sibs.slice(0, at);
    let any: Match = 'no';
    for (const s of before) {
      const x = this.matches(rest, s);
      if (x === 'yes') { any = 'yes'; break; }
      if (x === 'maybe') any = 'maybe';
    }
    result = combine(any);
    return result;
  }

  private ancestorMatch(rest: csstree.CssNode[], el: P5Element, direct: boolean): Match {
    let any: Match = 'no';
    for (let p = this.parentOf(el); p; p = direct ? null : this.parentOf(p)) {
      const x = this.matches(rest, p);
      if (x === 'yes') return 'yes';
      if (x === 'maybe') any = 'maybe';
    }
    return any;
  }

  private compound(nodes: csstree.CssNode[], el: P5Element): Match {
    let result: Match = 'yes';
    for (const n of nodes) {
      const x = this.simple(n, el);
      if (x === 'no') return 'no';
      if (x === 'maybe') result = 'maybe';
    }
    return result;
  }

  private simple(n: csstree.CssNode, el: P5Element): Match {
    switch (n.type) {
      case 'TypeSelector': return n.name === '*' || n.name.toLowerCase() === el.tagName ? 'yes' : 'no';
      case 'IdSelector': return mayChange(el, 'id') ? 'maybe' : attrOf(el, 'id') === unescape(n.name) ? 'yes' : 'no';
      case 'ClassSelector': return mayChange(el, 'class') ? 'maybe' : (attrOf(el, 'class') ?? '').split(/\s+/).includes(unescape(n.name)) ? 'yes' : dynamic(el, 'class') ? 'maybe' : 'no';
      case 'AttributeSelector': {
        const name = unescape(n.name.name).toLowerCase();
        const v = attrOf(el, name);
        const want = n.value ? (n.value.type === 'String' ? n.value.value : unescape(n.value.name)) : null;
        let ok: boolean;
        if (v === undefined) ok = false;
        else if (want === null || !n.matcher) ok = true;
        else {
          const ci = (n.flags ?? '').toLowerCase() === 'i';
          const a = ci ? v.toLowerCase() : v, b = ci ? want.toLowerCase() : want;
          switch (n.matcher) {
            case '=': ok = a === b; break;
            case '~=': ok = a.split(/\s+/).includes(b); break;
            case '|=': ok = a === b || a.startsWith(b + '-'); break;
            case '^=': ok = !!b && a.startsWith(b); break;
            case '$=': ok = !!b && a.endsWith(b); break;
            case '*=': ok = !!b && a.includes(b); break;
            default: return 'maybe';
          }
        }
        // an attribute a binding writes may be anything, whatever the markup says
        if (mayChange(el, name) || (name === 'class' && dynamic(el, 'class'))) return 'maybe';
        return ok ? 'yes' : 'no';
      }
      case 'PseudoElementSelector': return 'no';
      case 'PseudoClassSelector': {
        const name = n.name.toLowerCase();
        if (['where', 'is', 'matches', '-webkit-any', 'not'].includes(name) && n.children) {
          let any = 'no' as Match;
          n.children.forEach((l) => (l as csstree.SelectorList).children?.forEach((s) => {
            const x = this.matches((s as csstree.Selector).children.toArray(), el);
            if (x === 'yes') any = 'yes';
            else if (x === 'maybe' && any === 'no') any = 'maybe';
          }));
          if (name !== 'not') return any;
          return any === 'yes' ? 'no' : any === 'no' ? 'yes' : 'maybe';
        }
        if (name === 'root') return el === this.root ? 'yes' : 'no';
        if (STRUCTURAL.has(name)) return this.inTemplate(el) ? 'maybe' : this.structural(name, n, el);
        if (name === 'defined') return 'yes';
        // these match only in a shadow tree, never in the page's own stylesheets (Tailwind's theme is on `:root, :host`)
        if (name === 'host' || name === 'host-context') return 'no';
        if (name === 'scope') return el === this.root ? 'yes' : 'no';
        return 'maybe';
      }
      default: return 'maybe';
    }
  }

  private structural(name: string, n: csstree.PseudoClassSelector, el: P5Element): Match {
    const sibs = (el.parentNode?.childNodes ?? []).filter(isEl).filter((s) => !name.endsWith('of-type') || s.tagName === el.tagName);
    const i = sibs.indexOf(el), last = sibs.length - 1 - i;
    if (name.startsWith('first')) return i === 0 ? 'yes' : 'no';
    if (name.startsWith('last')) return last === 0 ? 'yes' : 'no';
    if (name.startsWith('only')) return sibs.length === 1 ? 'yes' : 'no';
    const arg = n.children?.first;
    if (!arg || arg.type !== 'Nth' || arg.selector) return 'maybe';
    const nth = arg.nth;
    const pos = (name.includes('last') ? last : i) + 1;
    if (nth.type === 'Identifier') return (nth.name === 'odd' ? pos % 2 === 1 : nth.name === 'even' ? pos % 2 === 0 : false) ? 'yes' : 'no';
    const a = nth.a === null ? 0 : Number(nth.a === '-' ? -1 : nth.a === '+' || nth.a === '' ? 1 : nth.a);
    const b = nth.b === null ? 0 : Number(nth.b);
    if (Number.isNaN(a) || Number.isNaN(b)) return 'maybe';
    if (a === 0) return pos === b ? 'yes' : 'no';
    return (pos - b) / a >= 0 && (pos - b) % a === 0 ? 'yes' : 'no';
  }
}

/** A block's text split into declarations (`body` null) and rules (`head { body }`), at the top level. */
function segments(text: string): Array<{ head: string; body: string | null }> {
  const out: Array<{ head: string; body: string | null }> = [];
  let start = 0, depth = 0, open = -1, quote = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quote) { if (ch === '\\') i++; else if (ch === quote) quote = ''; continue; }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '(' || ch === '[') depth++;
    else if (ch === ')' || ch === ']') depth--;
    else if (ch === '{') { if (depth === 0 && open < 0) open = i; depth++; }
    else if (ch === '}') {
      depth--;
      if (depth === 0 && open >= 0) { out.push({ head: text.slice(start, open).trim(), body: text.slice(open + 1, i) }); start = i + 1; open = -1; }
    } else if (ch === ';' && depth === 0) { const head = text.slice(start, i).trim(); if (head) out.push({ head, body: null }); start = i + 1; }
  }
  const rest = text.slice(start).trim();
  if (rest && open < 0) out.push({ head: rest, body: null });
  return out;
}

/** The user-agent styles that change horizontal edges (the HTML spec's rendering section). */
const UA = `body { margin: 8px } ul, ol, menu { padding-inline-start: 40px } figure, blockquote { margin-inline: 40px } dd { margin-inline-start: 40px }
fieldset { margin-inline: 2px; padding-inline: 0.75em; border: 2px groove }`;

/** px = k × viewport width + c */
interface Lin { k: number; c: number }
const lin = (c: number): Lin => ({ k: 0, c });
/** the range has to be split at a viewport width (where a min()/max() or a column count changes) */
class Split { constructor(readonly at: number) {} }
const MIN_VIEWPORT = 240, MAX_VIEWPORT = 4096;

export interface FluidPiece { from: number; to: number; k: number; c: number }
export interface FluidSizes {
  /** the `sizes` attribute */
  sizes: string;
  /** the width per viewport range: k × viewport + c px */
  pieces: FluidPiece[];
  /** the widest the image gets, or null when it grows with the viewport */
  max: number | null;
  /** the widths, when the image has a fixed width in every range (40 px on phones, 64 px elsewhere) */
  constant: number[] | null;
}

/** the smaller (or larger) of two widths over a viewport range; Split where they cross inside it */
function pick(a: Lin, b: Lin, seg: [number, number], which: 'min' | 'max'): Lin {
  const dk = a.k - b.k, dc = a.c - b.c;
  const at = (v: number) => dk * v + dc;
  const lo = at(seg[0]);
  const hi = Number.isFinite(seg[1]) ? at(seg[1]) : dk > 1e-9 ? Infinity : dk < -1e-9 ? -Infinity : dc;
  const aSmaller = lo <= 1e-6 && hi <= 1e-6, bSmaller = lo >= -1e-6 && hi >= -1e-6;
  if (!aSmaller && !bSmaller) throw new Split(-dc / dk);
  return (which === 'min') === aSmaller ? a : b;
}

const fmt = (n: number) => String(Math.round(n * 100) / 100);
/** a width as CSS: px, vw, or calc() of both */
function linCss(p: Lin): string {
  if (Math.abs(p.k) < 1e-9) return `${fmt(p.c)}px`;
  const vw = fmt(p.k * 100);
  if (Math.abs(p.c) < 0.005) return `${vw}vw`;
  return `calc(${vw}vw ${p.c < 0 ? '-' : '+'} ${fmt(Math.abs(p.c))}px)`;
}
/** the `max-width` of a range that ends at `to`: an inclusive media bound (767.0001) is 767, an exclusive one (768) 767.98 */
function maxWidthOf(to: number): string {
  const inclusive = to - EPS;
  return Math.abs(inclusive - Math.round(inclusive)) < 1e-6 ? fmt(Math.round(inclusive)) : fmt(to - 0.02);
}

/**
 * A length in a viewport range, linear in its width: px, rem, vw, % of `percent`, and calc(),
 * min(), max(), clamp() (which may split the range). Null for anything else.
 */
function evaluateLin(value: string, rem: number, percent: Lin | null, seg: [number, number]): Lin | null {
  const tokens = value.trim().toLowerCase().match(/-?\d*\.?\d+(?:e-?\d+)?(?:px|rem|vw|%)?|[a-z-]+\(|[()+*/,-]|\S+/g);
  if (!tokens) return null;
  let i = 0;
  type V = { k: number; c: number; len: boolean };
  const peek = () => tokens[i];
  const primary = (): V | null => {
    const t = tokens[i++];
    if (t === undefined) return null;
    if (t === '(' || t === 'calc(') { const v = sum(); if (tokens[i++] !== ')') return null; return v; }
    if (t === 'min(' || t === 'max(' || t === 'clamp(') {
      const args: V[] = [];
      for (;;) { const v = sum(); if (!v) return null; args.push(v); const s2 = tokens[i++]; if (s2 === ')') break; if (s2 !== ',') return null; }
      const pk = (a: V, b: V, w: 'min' | 'max'): V => ({ ...pick(a, b, seg, w), len: a.len || b.len });
      if (t === 'clamp(') { if (args.length !== 3) return null; return pk(args[0]!, pk(args[1]!, args[2]!, 'min'), 'max'); }
      return args.reduce((a, b) => pk(a, b, t === 'min(' ? 'min' : 'max'));
    }
    if (t === '-') { const v = primary(); return v && { k: -v.k, c: -v.c, len: v.len }; }
    const m = /^(-?\d*\.?\d+(?:e-?\d+)?)(px|rem|vw|%)?$/.exec(t);
    if (!m) return null;
    const n = Number(m[1]);
    if (!m[2]) return { k: 0, c: n, len: n === 0 };
    if (m[2] === 'px') return { k: 0, c: n, len: true };
    if (m[2] === 'rem') return { k: 0, c: n * rem, len: true };
    if (m[2] === 'vw') return { k: n / 100, c: 0, len: true };
    if (!percent) return null;
    return { k: percent.k * n / 100, c: percent.c * n / 100, len: true };
  };
  const product = (): V | null => {
    let v = primary();
    while (v && (peek() === '*' || peek() === '/')) {
      const op = tokens[i++], w = primary();
      if (!w) return null;
      if (op === '*') {
        // a length times a number only
        if (v.len && w.len) return null;
        const [l, n] = v.len ? [v, w] : [w, v];
        if (Math.abs(n.k) > 1e-12) return null;
        v = { k: l.k * n.c, c: l.c * n.c, len: v.len || w.len };
      } else {
        if (w.len || Math.abs(w.k) > 1e-12 || w.c === 0) return null;
        v = { k: v.k / w.c, c: v.c / w.c, len: v.len };
      }
    }
    return v;
  };
  const sum = (): V | null => {
    let v = product();
    while (v && (peek() === '+' || peek() === '-')) {
      const op = tokens[i++], w = product();
      if (!w) return null;
      v = op === '+' ? { k: v.k + w.k, c: v.c + w.c, len: v.len || w.len } : { k: v.k - w.k, c: v.c - w.c, len: v.len || w.len };
    }
    return v;
  };
  const v = sum();
  if (!v || i !== tokens.length || !v.len) return null;
  return { k: v.k, c: v.c };
}

const mediaCache = new Map<string, Array<[number, number]> | 'unknown'>();

/**
 * The viewport widths (px, `[from, to)`) at which all of `queries` (the preludes of nested `@media`
 * rules) apply on a screen: `min-width`, `max-width` and the range syntax (`width >= 40rem`), in
 * px, em or rem (16 px: media queries do not read the page's font size). 'unknown' for any other
 * feature (`hover`, `prefers-color-scheme`, `orientation`), whose value the build cannot know.
 */
function mediaRanges(queries: string[]): Array<[number, number]> | 'unknown' {
  const key = queries.join('\0');
  const r = mediaCache.get(key);
  if (r) return r;
  let acc: Array<[number, number]> = [[0, Infinity]];
  for (const q of queries) {
    const one = mediaList(q);
    if (one === 'unknown') { mediaCache.set(key, 'unknown'); return 'unknown'; }
    const next: Array<[number, number]> = [];
    for (const [a, b] of acc) for (const [c, d] of one) { const lo = Math.max(a, c), hi = Math.min(b, d); if (lo < hi) next.push([lo, hi]); }
    acc = next;
  }
  mediaCache.set(key, acc);
  return acc;
}

function mediaList(prelude: string): Array<[number, number]> | 'unknown' {
  const out: Array<[number, number]> = [];
  for (const raw of topCommas(prelude)) {
    let q = raw.trim().toLowerCase().replace(/^only\s+/, '');
    if (!q || /^not\b/.test(q) || /\bor\b|\bnot\b/.test(q)) return 'unknown';
    let type = 'all';
    const t = /^([a-z-]+)(\s+and\s+|$)/.exec(q);
    if (t && !q.startsWith('(')) { type = t[1]!; q = q.slice(t[0].length); }
    if (type === 'print' || type === 'speech' || (type !== 'all' && type !== 'screen')) continue;
    let lo = 0, hi = Infinity;
    for (const cond of q ? q.split(/\s+and\s+/) : []) {
      const r = widthCondition(cond.trim());
      if (r === null) return 'unknown';
      lo = Math.max(lo, r[0]); hi = Math.min(hi, r[1]);
    }
    if (lo < hi) out.push([lo, hi]);
  }
  return out;
}

const EPS = 1e-4;
/** one `(…)` condition on the viewport width, as `[from, to)` px; null when it is about something else */
function widthCondition(cond: string): [number, number] | null {
  const m = /^\((.*)\)$/s.exec(cond);
  if (!m) return null;
  const inner = m[1]!.trim();
  const len = (v: string): number | null => { const x = /^(-?\d*\.?\d+)(px|em|rem)?$/.exec(v.trim()); return x ? Number(x[1]) * (x[2] === 'em' || x[2] === 'rem' ? 16 : 1) : null; };
  const named = /^(min|max)-width\s*:\s*(.+)$/.exec(inner);
  if (named) { const v = len(named[2]!); if (v === null) return null; return named[1] === 'min' ? [v, Infinity] : [0, v + EPS]; }
  // range syntax: width >= 40rem, 30em < width <= 60em
  const parts = inner.split(/\s*(<=|>=|<|>|=)\s*/);
  if (parts.length !== 3 && parts.length !== 5) return null;
  let lo = 0, hi = Infinity;
  const apply = (op: string, value: number, widthOnLeft: boolean) => {
    // normalize to `width OP value`
    const o = widthOnLeft ? op : ({ '<': '>', '>': '<', '<=': '>=', '>=': '<=', '=': '=' } as Record<string, string>)[op]!;
    if (o === '>') lo = Math.max(lo, value + EPS); else if (o === '>=') lo = Math.max(lo, value);
    else if (o === '<') hi = Math.min(hi, value); else if (o === '<=') hi = Math.min(hi, value + EPS);
    else { lo = Math.max(lo, value); hi = Math.min(hi, value + EPS); }
  };
  if (parts.length === 3) {
    const [a, op, b] = parts as [string, string, string];
    if (a === 'width') { const v = len(b); if (v === null) return null; apply(op, v, true); }
    else if (b === 'width') { const v = len(a); if (v === null) return null; apply(op, v, false); }
    else return null;
  } else {
    const [a, op1, w, op2, b] = parts as [string, string, string, string, string];
    if (w !== 'width') return null;
    const va = len(a), vb = len(b);
    if (va === null || vb === null) return null;
    apply(op1, va, false); apply(op2, vb, true);
  }
  return [lo, hi];
}

function topCommas(s: string): string[] {
  const out: string[] = [];
  let depth = 0, cur = '';
  for (const ch of s) { if (ch === '(') depth++; if (ch === ')') depth--; if (ch === ',' && depth === 0) { out.push(cur); cur = ''; } else cur += ch; }
  out.push(cur);
  return out;
}

/** A CSS identifier with its escapes resolved: `w-\\[72px\\]` is the class `w-[72px]`. */
function unescape(s: string): string {
  return s.includes('\\') ? s.replace(/\\([0-9a-fA-F]{1,6}\s?|[^\n])/g, (_, e: string) => (/^[0-9a-fA-F]/.test(e) && /^[0-9a-fA-F]{1,6}\s?$/.test(e) ? String.fromCodePoint(parseInt(e, 16)) : e)) : s;
}

/** a side of a 1–4 value box shorthand: `a` / `a b` / `a b c` / `a b c d` (top right bottom left) */
function boxValue(v: string[], i: number): string | undefined {
  if (!v.length || v.length > 4) return undefined;
  const [t, r = t, b = t, l = r] = v;
  return [t, r, b, l][i];
}

const BORDER_STYLES = /^(none|hidden|dotted|dashed|solid|double|groove|ridge|inset|outset)$/i;
/** the width or style in a `border` shorthand (`1px solid red`); a part left out is the initial value */
function borderPart(v: string[], kind: 'border-width' | 'border-style'): string | undefined {
  if (kind === 'border-style') return v.find((x) => BORDER_STYLES.test(x)) ?? 'none';
  return v.find((x) => /^(thin|medium|thick)$/i.test(x) || /^-?[\d.]|^(calc|min|max|clamp)\(/i.test(x)) ?? 'medium';
}

/** a value's top-level space-separated parts (`calc(1px + 2px) solid` is two) */
function splitTop(v: string): string[] {
  const out: string[] = [];
  let depth = 0, cur = '';
  for (const ch of v.trim()) {
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    if (/\s/.test(ch) && depth === 0) { if (cur) out.push(cur); cur = ''; } else cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}

function topComma(s: string): number {
  let level = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '(') level++;
    else if (s[i] === ')') level--;
    else if (s[i] === ',' && level === 0) return i;
  }
  return -1;
}

/** `aspect-ratio`: a number, null for `auto`, undefined when it cannot be read */
function ratioOf(v: string | undefined): number | null | undefined {
  if (v === undefined) return undefined;
  const t = v.replace(/\bauto\b/i, '').trim();
  if (!t) return null;
  const m = /^(\d+(?:\.\d+)?)\s*(?:\/\s*(\d+(?:\.\d+)?))?$/.exec(t);
  if (!m) return undefined;
  const r = Number(m[1]) / (m[2] ? Number(m[2]) : 1);
  return r > 0 ? r : undefined;
}

/**
 * A length in px: numbers with px, rem or % (of `percent`), and calc(), min(), max(), clamp()
 * of them. Null for anything else (auto, em, vw, keywords).
 */
export function evaluate(value: string, units: { rem: number; percent: number }): number | null {
  const tokens = value.trim().toLowerCase().match(/-?\d*\.?\d+(?:e-?\d+)?(?:px|rem|%)?|[a-z-]+\(|[()+*/,-]|\S+/g);
  if (!tokens) return null;
  let i = 0;
  const peek = () => tokens[i];
  // values carry whether they are a length (px) or a plain number
  type V = { n: number; len: boolean };
  const primary = (): V | null => {
    const t = tokens[i++];
    if (t === undefined) return null;
    if (t === '(' || t === 'calc(') { const v = sum(); if (tokens[i++] !== ')') return null; return v; }
    if (t === 'min(' || t === 'max(' || t === 'clamp(') {
      const args: V[] = [];
      for (;;) { const v = sum(); if (!v) return null; args.push(v); const s = tokens[i++]; if (s === ')') break; if (s !== ',') return null; }
      if (t === 'clamp(') { if (args.length !== 3) return null; return { n: Math.min(Math.max(args[0]!.n, args[1]!.n), args[2]!.n), len: true }; }
      return { n: (t === 'min(' ? Math.min : Math.max)(...args.map((a) => a.n)), len: args.some((a) => a.len) };
    }
    if (t === '-') { const v = primary(); return v && { n: -v.n, len: v.len }; }
    const m = /^(-?\d*\.?\d+(?:e-?\d+)?)(px|rem|%)?$/.exec(t);
    if (!m) return null;
    const n = Number(m[1]);
    if (!m[2]) return { n, len: n === 0 };
    return { n: m[2] === 'px' ? n : m[2] === 'rem' ? n * units.rem : n * units.percent / 100, len: true };
  };
  const product = (): V | null => {
    let v = primary();
    while (v && (peek() === '*' || peek() === '/')) {
      const op = tokens[i++], w = primary();
      if (!w) return null;
      if (op === '*') v = { n: v.n * w.n, len: v.len || w.len };
      else { if (w.len || w.n === 0) return null; v = { n: v.n / w.n, len: v.len }; }
    }
    return v;
  };
  const sum = (): V | null => {
    let v = product();
    while (v && (peek() === '+' || peek() === '-')) {
      const op = tokens[i++], w = product();
      if (!w) return null;
      v = { n: op === '+' ? v.n + w.n : v.n - w.n, len: v.len || w.len };
    }
    return v;
  };
  const v = sum();
  if (!v || i !== tokens.length || !v.len) return null;
  return v.n;
}
