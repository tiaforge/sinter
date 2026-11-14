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
  /** why the last `fluidSizes()` gave up, when it is something the author can change (shared by `at()` views) */
  private readonly notes: { autoFitRows: P5Element | null } = { autoFitRows: null };

  /** a font family's `line-height: normal` as a multiple of its size (the smallest of its metrics), when the build has its file */
  private readonly normal: (family: string) => number | null;

  constructor(sheets: StyleSheet[], doc: P5Parent, opts: { normalLineHeight?: (family: string) => number | null } = {}) {
    this.normal = opts.normalLineHeight ?? (() => null);
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
      rules: this.rules, hosts: this.hosts, root: this.root, viewport: width, views: this.views, notes: this.notes, normal: this.normal,
      cascades: new Map(), vars: new Map(), widths: new Map(), bounds: new Map(), fonts: new Map(), heights: new Map(),
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
    this.notes.autoFitRows = null;
    if (this.empty || this.viewport !== undefined) return null;
    const cuts = this.breakpoints().filter((b) => b > MIN_VIEWPORT && b < MAX_VIEWPORT);
    const queue: Array<[number, number]> = [];
    // from the narrowest real screen: a split below it (min(48px, 100vw) at 48) would only add noise
    let lo = MIN_VIEWPORT;
    for (const b of cuts) { queue.push([lo, b]); lo = b; }
    queue.push([lo, Infinity]);
    const pieces: FluidPiece[] = [];
    for (let guard = 0; queue.length; guard++) {
      if (guard > 200) return null;
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

  /** The `auto-fit` grid whose rows from a template made the last `fluidSizes()` give up, if that was why. */
  get autoFitRows(): P5Element | null { return this.notes.autoFitRows; }

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
      // with n columns a track is between its minimum and minimum + step / n wide: once that is within
      // 15%, the rest is one width, the widest (`sizes` stays short; it overestimates by at most 15%)
      if (W.k > 1e-9 && auto[1] === 'auto-fill' && n0 >= 2 && step / n0 <= 0.15 * min.c) return area(lin(min.c + step / n0), n0);
      // the viewport width at which one more column fits (a container of fixed width: never); past the
      // widest screen the count stays, which only overestimates the image there
      if (W.k > 1e-9) {
        const next = ((n0 + 1) * step - gap.c - W.c) / W.k;
        if (next < Math.min(seg[1], MAX_VIEWPORT)) throw new Split(next);
      }
      let n = n0;
      if (auto[1] === 'auto-fit') {
        // empty tracks collapse: the number of items matters, and the rows of a template are known only at runtime
        if (parent.childNodes.some((c) => isEl(c) && c.tagName === 'template')) { this.notes.autoFitRows = parent; return null; }
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

  // ---- reserved space: the rows of a list whose data arrives after the first paint (docs/first-paint.md)
  //
  // Heights here are lower bounds: what the stylesheets fix is exact (a `height`, a grid row track),
  // and what depends on the data counts at its least: a bound text is one line, a `data-sn-if`, a
  // `data-sn-show`, a nested list, a float or anything the cascade cannot decide counts as nothing. A
  // placeholder of that height can only be shorter than the rows that replace it, never taller (unless
  // fewer rows arrive), so the page moves less than without it, and never back.

  private readonly fonts = new Map<P5Element, number | null>();
  private readonly heights = new Map<P5Element, Height>();

  /**
   * The CSS of a placeholder for `count` rows of `tpl` (a `<template data-sn-for>` outside templates),
   * per viewport range from the narrowest screen up (`from`: the range's start, 0 for the first), or
   * null when the rows' layout is not one the build follows (see `shape`), at any width.
   */
  reserve(tpl: P5Element, count: number): Reserved | null {
    if (this.empty || this.viewport !== undefined || count < 1) return null;
    const row = soleElement(tpl), parent = this.parentOf(tpl);
    if (!row || !parent) return null;
    const cuts = this.breakpoints().filter((b) => b > MIN_VIEWPORT && b < MAX_VIEWPORT);
    const shapeAt = (w: number) => this.at(w).shape(parent, row);
    const key = (s: Shape | null) => (s ? `${s.mode} ${s.columns}` : '');
    // ranges between breakpoints, split where the shape changes inside one (a column more in an auto-fill grid)
    const ranges: Array<[number, number, Shape]> = [];
    const split = (lo: number, hi: number, a: Shape | null, b: Shape | null): boolean => {
      if (!a || !b) return false;
      if (key(a) === key(b) || hi - lo <= 1) { ranges.push([lo, hi, a]); return true; }
      const mid = Math.floor((lo + hi) / 2), m = shapeAt(mid);
      return split(lo, mid, a, m) && split(mid, hi, m, b);
    };
    let lo = MIN_VIEWPORT;
    for (const b of [...cuts, MAX_VIEWPORT]) {
      if (!split(lo, b, shapeAt(lo), shapeAt(b - 0.5))) return null;
      lo = b;
    }
    const pieces: Reserved['pieces'] = [];
    let exact = true;
    for (const [a, b, s] of ranges) {
      // a range's height is its least: at either end (a height that follows the viewport is smallest at one of them)
      const x = this.at(a).space(parent, row, count, s), y = this.at(Math.max(a, b - 0.5)).space(parent, row, count, s);
      if (!x || !y) return null;
      const sp = x.height <= y.height ? x : y;
      exact &&= x.exact && y.exact && Math.abs(x.height - y.height) < 0.01;
      const decls = spaceCss(sp, row.tagName);
      const last = pieces[pieces.length - 1];
      if (last && last.decls === decls) continue;
      pieces.push({ from: pieces.length ? a : 0, decls });
    }
    if (!pieces.length || pieces.every((p) => /height:0px/.test(p.decls) && !/span/.test(p.decls))) return null;
    return { tag: placeholderTag(parent, row), pieces, exact };
  }

  /**
   * The element around `tpl` whose width follows its content, at some viewport width: a flex item
   * without a basis or width in a row, a float, an inline block, an absolutely positioned box without
   * a width. Its rows widen it when they arrive. `siblings`: other boxes move with it (a flex item
   * among others, a float).
   */
  contentSized(tpl: P5Element): { el: P5Element; siblings: boolean } | null {
    if (this.empty || this.viewport !== undefined) return null;
    const cuts = this.breakpoints().filter((b) => b > MIN_VIEWPORT && b < MAX_VIEWPORT);
    const widths = [MIN_VIEWPORT + 1, ...cuts.map((c) => c + 1)];
    for (const w of widths) {
      const r = this.at(w).sizedBy(tpl);
      if (r) return r;
    }
    return null;
  }

  private sizedBy(tpl: P5Element): { el: P5Element; siblings: boolean } | null {
    for (let el = this.parentOf(tpl); el && el !== this.root && el.tagName !== 'body'; el = this.parentOf(el)) {
      const m = this.declsOf(el);
      if (m.has('\0dynamic')) return null;
      const d = this.displayOf(el);
      if (d === null || d === 'none') return null;
      const wc = this.cascaded(el, SIZE.width);
      if (wc.ambiguous) return null;
      const auto = wc.value === null || /^\s*(auto|fit-content|max-content|min-content)\s*$/i.test(wc.value);
      // a width of its own (a length): its children cannot change it
      if (!auto && !/%/.test(wc.value!)) return null;
      const pos = this.cascaded(el, ['position']), fl = this.cascaded(el, ['float']);
      if (pos.ambiguous || fl.ambiguous) return null;
      if (auto && pos.value && /^\s*(absolute|fixed)\s*$/i.test(pos.value)) return { el, siblings: false };
      if (auto && fl.value && !/^\s*none\s*$/i.test(fl.value)) return { el, siblings: true };
      if (auto && /^inline-(block|flex|grid|table)$/.test(d)) return { el, siblings: false };
      const parent = this.parentOf(el);
      if (!parent) return null;
      const pd = this.displayOf(parent);
      if (pd === null) return null;
      if (/flex/.test(pd)) {
        const dir = this.flexFlow(parent, 'direction');
        if (dir === undefined) return null;
        if (dir && dir.startsWith('column')) {
          for (const [who, prop] of [[parent, 'align-items'], [el, 'align-self']] as const) {
            const a = this.cascaded(who, [prop]);
            if (a.ambiguous) return null;
            if (a.value !== null && !/^\s*(normal|stretch|auto)\s*$/i.test(a.value)) return { el, siblings: false };
          }
          continue;
        }
        const basis = this.flexBasis(el);
        if (basis === null) return null;
        if ((basis === 'auto' && auto) || basis === 'content') {
          const others = parent.childNodes.some((c) => isEl(c) && c !== el && c.tagName !== 'template' && c.tagName !== 'script' && c.tagName !== 'style');
          return { el, siblings: others };
        }
        return null;
      }
      // a grid item fills its area, a block its container: the question moves up (a percentage of it too)
      if (/grid/.test(pd)) return null;
      if (!/^(block|list-item|flow-root|table-cell|flex|grid)$/.test(d) && !/^(block|list-item|flow-root)$/.test(pd)) return null;
    }
    return null;
  }

  /** a flex item's basis as written (`auto`, `content`, `0`, a length), null when the cascade cannot tell */
  private flexBasis(el: P5Element): string | null {
    const props = ['flex', 'flex-basis'];
    const c = this.cascaded(el, props);
    if (c.ambiguous) return null;
    let basis = 'auto';
    const m = this.declsOf(el);
    const decls = props.flatMap((p) => (m.get(p) ?? []).map((d) => ({ d, p }))).filter(({ d }) => !d.conditional).sort((a, b) => cascadeCmp(a.d, b.d));
    for (const { d, p } of decls) {
      const v = (this.subst(d.value, el) ?? '').trim().toLowerCase();
      if (p === 'flex-basis') basis = v;
      else if (v === 'none' || v === 'auto' || v === 'initial') basis = 'auto';
      else { const other = splitTop(v).find((t) => !/^\d*\.?\d+$/.test(t)); basis = other ?? '0%'; }
    }
    return basis;
  }

  /** `flex-direction` or the wrap of `flex-flow`; null: the initial value, undefined: unknown */
  private flexFlow(parent: P5Element, prop: 'direction' | 'wrap'): string | null | undefined {
    const props = [`flex-${prop}`, 'flex-flow'];
    const c = this.cascaded(parent, props);
    if (c.ambiguous) return undefined;
    if (c.value === null) return null;
    const w = this.winner(parent, props)!;
    const parts = splitTop(w.value.toLowerCase());
    if (w.prop !== 'flex-flow') return parts[0] ?? null;
    return parts.find((x) => (prop === 'direction' ? /^(row|column)/.test(x) : /wrap/.test(x))) ?? null;
  }

  /** how the rows are laid out in their parent at this viewport width, if the build follows it */
  private shape(parent: P5Element, row: P5Element): Shape | null {
    const pd = this.displayOf(parent), rd = this.displayOf(row);
    if (pd === null || rd === null || this.declsOf(parent).has('\0dynamic')) return null;
    if (!this.inFlow(row)) return null;
    if (/^(block|list-item|flow-root)$/.test(pd)) return /^(block|list-item|flow-root|flex|grid|table)$/.test(rd) ? { mode: 'block', columns: 1 } : null;
    if (/^(inline-)?flex$/.test(pd)) {
      const dir = this.flexFlow(parent, 'direction');
      return dir && dir.startsWith('column') ? { mode: 'column', columns: 1 } : null;
    }
    if (/^(inline-)?grid$/.test(pd)) {
      // auto-placed rows, and nothing else in the grid that would take a cell first
      if (parent.childNodes.some((c) => isEl(c) && c.tagName !== 'template')) return null;
      const rm = this.declsOf(row);
      if (['grid-column', 'grid-column-start', 'grid-column-end', 'grid-row', 'grid-row-start', 'grid-row-end', 'grid-area'].some((p) => rm.has(p))) return null;
      const flow = this.cascaded(parent, ['grid-auto-flow']);
      if (flow.ambiguous || (flow.value !== null && !/^\s*row\s*$/i.test(flow.value))) return null;
      const n = this.gridColumns(parent);
      return n ? { mode: 'grid', columns: n } : null;
    }
    return null;
  }

  /** the number of columns of a grid at this viewport width: a track list, or auto-fill/auto-fit of one size */
  private gridColumns(parent: P5Element): number | null {
    const pm = this.declsOf(parent);
    if (pm.has('grid') || pm.has('grid-template') || pm.has('grid-template-areas')) return null;
    const gc = this.cascaded(parent, ['grid-template-columns']);
    if (gc.ambiguous) return null;
    if (gc.value === null || /^\s*none\s*$/i.test(gc.value)) return 1;
    const text = (this.subst(gc.value, parent) ?? '').trim().toLowerCase().replace(/\[[^\]]*\]/g, ' ');
    if (!text) return null;
    const auto = /^repeat\(\s*(auto-fill|auto-fit)\s*,\s*(.+)\)$/s.exec(text);
    if (auto) {
      const track = auto[2]!.trim(), mm = /^minmax\(\s*([^,]+?)\s*,\s*[^,]+\)$/.exec(track);
      const v = this.viewport!, seg: [number, number] = [v, v];
      const W = this.contentOf(parent, seg);
      if (!W) return null;
      const gap = this.columnGap(parent, W, seg);
      const L = this.lin(parent, mm ? mm[1]! : track, W, seg);
      if (!gap || !L) return null;
      const w = W.k * v + W.c, g = gap.k * v + gap.c, l = L.k * v + L.c;
      if (!(l > 0) || !(w > 0)) return null;
      return Math.max(1, Math.floor((w + g) / (l + g) + 1e-9));
    }
    let n = 0;
    for (const t of splitTop(text)) {
      const rm = /^repeat\(\s*(\d+)\s*,\s*(.+)\)$/s.exec(t);
      n += rm ? Number(rm[1]) * splitTop(rm[2]!).length : 1;
    }
    return n || null;
  }

  /** the placeholder's box for `count` rows in this shape, at this viewport width */
  private space(parent: P5Element, row: P5Element, count: number, s: Shape): Space | null {
    const h = this.height(row);
    const mt = this.vMargin(row, 'top'), mb = this.vMargin(row, 'bottom');
    if (mt === null || mb === null) return null;
    if (s.mode === 'block') {
      // margins between rows collapse; the outer ones stay on the placeholder, to collapse as the rows' would
      return { height: count * h.h + (count - 1) * collapse([mb, mt]), mt, mb, span: 0, exact: h.exact };
    }
    const gap = this.rowGap(parent);
    if (gap === null) return null;
    if (s.mode === 'column') return { height: count * (h.h + mt + mb) + (count - 1) * gap, mt: 0, mb: 0, span: 0, exact: h.exact };
    // grid: one item over as many rows as the rows fill; a row is as tall as its track, or its tallest item
    const rows = Math.ceil(count / s.columns);
    const track = this.autoRow(parent);
    const one = Math.max(h.h + mt + mb, track ?? 0);
    return { height: rows * one + (rows - 1) * gap, mt: 0, mb: 0, span: rows, exact: track !== null || h.exact };
  }

  /** a fixed `grid-auto-rows` (one size), or null */
  private autoRow(parent: P5Element): number | null {
    const c = this.cascaded(parent, ['grid-auto-rows']);
    if (c.ambiguous || c.value === null) return null;
    const v = this.subst(c.value, parent);
    if (v === undefined || splitTop(v).length !== 1) return null;
    return this.length(parent, v, null);
  }

  /** `row-gap` (`gap`, the old `grid-` names) in px; `normal` is 0; null when unknown */
  private rowGap(el: P5Element): number | null {
    const props = ['row-gap', 'grid-row-gap', 'gap', 'grid-gap'];
    const c = this.cascaded(el, props);
    if (c.ambiguous) return null;
    if (c.value === null) return 0;
    const w = this.winner(el, props)!;
    const v = splitTop(this.subst(w.value, el) ?? '')[0];
    if (!v || /^normal$/i.test(v)) return 0;
    return this.length(el, v, null);
  }

  /** positioned in the flow (static, relative, sticky; not floated) */
  private inFlow(el: P5Element): boolean {
    const pos = this.cascaded(el, ['position']), fl = this.cascaded(el, ['float']);
    if (pos.ambiguous || fl.ambiguous) return false;
    return (!pos.value || /^\s*(static|relative|sticky)\s*$/i.test(pos.value)) && (!fl.value || /^\s*none\s*$/i.test(fl.value));
  }

  /**
   * A length in px at this viewport width: px, rem, em (of `el`'s font size), vw, % of `percent`,
   * calc()/min()/max()/clamp() of them; null for anything else.
   */
  private length(el: P5Element, raw: string, percent: number | null): number | null {
    const rem = this.rootFont();
    let v = this.subst(raw, el);
    if (v === undefined || rem === null) return null;
    if (/\d(em|ex|ch|cap|ic|lh|rlh)\b/i.test(v)) {
      const em = this.fontSize(el);
      if (em === null) return null;
      // ex and ch count at their least: half the font size (most fonts' x-height and digit width are more)
      v = v.replace(/(-?\d*\.?\d+(?:e-?\d+)?)(em|ex|ch)\b/gi, (_, n: string, u: string) => `${Number(n) * em * (u.toLowerCase() === 'em' ? 1 : 0.5)}px`);
      if (/\d(cap|ic|lh|rlh)\b/i.test(v)) return null;
    }
    if (/\d(vw|vh|vmin|vmax|svh|lvh|dvh|svw|lvw|dvw)\b/i.test(v)) {
      if (this.viewport === undefined || /\d(vh|vmin|vmax|svh|lvh|dvh)\b/i.test(v)) return null;
      v = v.replace(/(-?\d*\.?\d+(?:e-?\d+)?)[sld]?vw\b/gi, (_, n: string) => `${(Number(n) * this.viewport!) / 100}px`);
    }
    if (/%/.test(v) && percent === null) return null;
    return evaluate(v, { rem, percent: percent ?? 0 });
  }

  /** the computed font size of `el` in px (inherited), null when the cascade cannot tell */
  private fontSize(el: P5Element): number | null {
    if (this.fonts.has(el)) return this.fonts.get(el)!;
    this.fonts.set(el, null); // cycle guard
    const parent = this.parentOf(el);
    const up = parent ? this.fontSize(parent) : 16;
    let out: number | null = up;
    const c = this.cascaded(el, ['font-size', 'font']);
    if (c.ambiguous) out = null;
    else if (c.value !== null) {
      const w = this.winner(el, ['font-size', 'font'])!;
      const raw = (w.prop === 'font' ? fontShorthand(this.subst(w.value, el) ?? '')?.size : this.subst(w.value, el)) ?? null;
      out = raw === null ? null : this.fontValue(el, raw.trim().toLowerCase(), up);
    } else if (el === this.root) out = 16;
    this.fonts.set(el, out);
    return out;
  }

  private fontValue(el: P5Element, v: string, up: number | null): number | null {
    const KEYWORDS: Record<string, number> = { 'xx-small': 9, 'x-small': 10, small: 13, medium: 16, large: 18, 'x-large': 24, 'xx-large': 32, 'xxx-large': 48 };
    if (v in KEYWORDS) return KEYWORDS[v]!;
    if (up === null) return null;
    if (v === 'inherit' || v === 'unset') return up;
    if (v === 'smaller') return up / 1.2;
    if (v === 'larger') return up * 1.2;
    // em and % of a font size are of the parent's
    const rem = this.rootFont();
    const s = this.subst(v, el);
    if (s === undefined || rem === null) return null;
    const px = s.replace(/(-?\d*\.?\d+(?:e-?\d+)?)em\b/gi, (_, n: string) => `${Number(n) * up}px`);
    if (/\d(ex|ch|cap|ic|lh|rlh|vh|vmin|vmax)\b/i.test(px)) return null;
    const vw = px.replace(/(-?\d*\.?\d+(?:e-?\d+)?)vw\b/gi, (_, n: string) => (this.viewport === undefined ? 'x' : `${(Number(n) * this.viewport) / 100}px`));
    return evaluate(vw, { rem, percent: up });
  }

  /** the computed `line-height` of `el` in px; `normal` from its font's metrics; null when the cascade cannot tell */
  private lineHeight(el: P5Element): number | null {
    for (let x: P5Element | null = el; x; x = this.parentOf(x)) {
      const c = this.cascaded(x, ['line-height', 'font']);
      if (c.ambiguous) return null;
      if (c.value === null) continue;
      const w = this.winner(x, ['line-height', 'font'])!;
      const sub = this.subst(w.value, x);
      if (sub === undefined) return null;
      // the shorthand sets line-height too: to `normal` when it leaves it out
      const v = (w.prop === 'font' ? fontShorthand(sub)?.lineHeight ?? 'normal' : sub).trim().toLowerCase();
      if (v === 'inherit' || v === 'unset') continue;
      if (v === 'normal' || v === 'initial') return this.normalLine(el);
      if (/^\d*\.?\d+$/.test(v)) { const f = this.fontSize(el); return f === null ? null : Number(v) * f; }
      // a length or percentage is computed where it is declared, and inherited as px
      const f = this.fontSize(x);
      return f === null ? null : this.length(x, v, f);
    }
    return this.normalLine(el);
  }

  /** `line-height: normal`: the font's own spacing, when the build has its file; else the font size (a lower bound for text fonts) */
  private normalLine(el: P5Element): number | null {
    const f = this.fontSize(el);
    if (f === null) return null;
    // the font's ratio less 1 px: engines round its ascent and descent to whole pixels
    const fam = this.fontFamily(el), r = fam ? this.normal(fam.toLowerCase()) : null;
    return r === null ? f : Math.max(0, r * f - 1);
  }

  /** the first family of `el`'s font-family (inherited), unquoted; null when unknown */
  private fontFamily(el: P5Element): string | null {
    for (let x: P5Element | null = el; x; x = this.parentOf(x)) {
      const c = this.cascaded(x, ['font-family', 'font']);
      if (c.ambiguous) return null;
      if (c.value === null) continue;
      const w = this.winner(x, ['font-family', 'font'])!;
      const sub = this.subst(w.value, x);
      const list = sub === undefined ? null : w.prop === 'font' ? fontShorthand(sub)?.family ?? null : sub;
      if (!list || /^\s*(inherit|unset)\s*$/i.test(list)) { if (list) continue; return null; }
      const first = topCommas(list)[0]!.trim().replace(/^(['"])(.*)\1$/, '$2');
      return first || null;
    }
    return null;
  }

  /** a vertical margin in px (auto and what cannot be read count as 0); null when it may be negative and is unknown */
  private vMargin(el: P5Element, side: 'top' | 'bottom'): number | null {
    const raw = this.sideValue(el, 'margin', side);
    if (raw === undefined) return null;
    if (raw === null || /^\s*auto\s*$/i.test(raw)) return 0;
    const v = this.length(el, raw, null);
    if (v === null) return /^\s*-/.test(raw) ? null : 0;
    return v;
  }

  /** padding and border on `side`, in px; what cannot be read counts as 0 (`exact` false) */
  private vEdge(el: P5Element, side: 'top' | 'bottom'): { v: number; exact: boolean } {
    let exact = true;
    const pad = this.sideValue(el, 'padding', side);
    let v = 0;
    if (pad === undefined) exact = false;
    else if (pad !== null) { const p = this.length(el, pad, null); if (p === null) exact = false; else v += Math.max(0, p); }
    const rem = this.rootFont() ?? 16;
    const style = this.edge(el, 'border-style', side, rem);
    if (style === null) exact = false;
    else if (!/^(none|hidden)$/.test(style as string)) {
      const raw = this.sideValue(el, 'border-width', side);
      const kw = { thin: 1, medium: 3, thick: 5 } as Record<string, number>;
      if (raw === undefined) exact = false;
      else { const r = (raw ?? 'medium').trim().toLowerCase(); const b = kw[r] ?? this.length(el, r, null); if (b === null) exact = false; else v += b; }
    }
    return { v, exact };
  }

  /**
   * A lower bound of `el`'s border-box height at this viewport width; `exact` when the stylesheets fix
   * it (a `height`). Hidden, out-of-flow and undecidable boxes are 0.
   */
  private height(el: P5Element): Height {
    const got = this.heights.get(el);
    if (got) return got;
    this.heights.set(el, { h: 0, exact: false }); // cycle guard
    const out = this.computeHeight(el);
    this.heights.set(el, out);
    return out;
  }

  private computeHeight(el: P5Element): Height {
    const zero = { h: 0, exact: false };
    if (attrOf(el, 'hidden') !== undefined || attrOf(el, 'data-sn-show') !== undefined) return zero;
    const d = this.displayOf(el);
    if (d === null) return zero;
    if (d === 'none') return { h: 0, exact: true };
    if (d === 'contents') return zero;
    const top = this.vEdge(el, 'top'), bottom = this.vEdge(el, 'bottom');
    const edges = top.v + bottom.v, edgesExact = top.exact && bottom.exact;
    const bs = this.cascaded(el, ['box-sizing']);
    const borderBox = !bs.ambiguous && /^\s*border-box\s*$/i.test(bs.value ?? '');
    const asBox = (v: number) => (borderBox ? Math.max(v, edges) : v + edges);
    const clamp = (h: number): number => {
      const mn = this.cascaded(el, SIZE['min-height']), mx = this.cascaded(el, SIZE['max-height']);
      if (!mn.ambiguous && mn.value !== null && !/^\s*auto\s*$/i.test(mn.value)) { const v = this.length(el, mn.value, null); if (v !== null) h = Math.max(h, asBox(v)); }
      if (!mx.ambiguous && mx.value !== null && !/^\s*none\s*$/i.test(mx.value)) { const v = this.length(el, mx.value, null); if (v !== null) h = Math.min(h, asBox(v)); }
      return h;
    };
    const hc = this.cascaded(el, SIZE.height);
    if (!hc.ambiguous && hc.value !== null && !/^\s*(auto|fit-content|max-content|min-content)\s*$/i.test(hc.value)) {
      const v = this.length(el, hc.value, null);
      if (v !== null) {
        const mn = this.cascaded(el, SIZE['min-height']), mx = this.cascaded(el, SIZE['max-height']);
        return { h: clamp(asBox(v)), exact: edgesExact && !mn.ambiguous && !mx.ambiguous && !bs.ambiguous };
      }
    }
    if (el.tagName === 'img' || el.tagName === 'svg' || el.tagName === 'video' || el.tagName === 'canvas' || el.tagName === 'iframe') {
      const b = el.tagName === 'img' ? this.box(el) : null;
      const a = attrOf(el, 'height');
      const own = b && b !== 'fluid' && b.height !== null ? b.height : a && /^\s*\d+(\.\d+)?\s*$/.test(a) ? Number(a) : 0;
      return { h: clamp(own + (borderBox ? 0 : edges)), exact: false };
    }
    let h = this.contentHeight(el, d, top.v > 0, bottom.v > 0) + edges;
    // a box with a ratio and a known width
    const ar = this.cascaded(el, ['aspect-ratio']);
    if (!ar.ambiguous && ar.value !== null && hc.value === null) {
      const r = ratioOf(this.subst(ar.value, el));
      const v = this.viewport!;
      const w = r ? this.borderBox(el, [v, v]) : null;
      if (r && w) h = Math.max(h, (w.k * v + w.c) / r);
    }
    return { h: clamp(h), exact: false };
  }

  /** a lower bound of the content height of `el` (display `d`); `padTop`/`padBottom`: a margin of a child cannot collapse through that side */
  private contentHeight(el: P5Element, d: string, padTop: boolean, padBottom: boolean): number {
    const kids = this.flow(el);
    const outer = (c: P5Element) => this.height(c).h + Math.max(0, this.vMargin(c, 'top') ?? 0) + Math.max(0, this.vMargin(c, 'bottom') ?? 0);
    if (/flex$/.test(d)) {
      const dir = this.flexFlow(el, 'direction');
      const items = kids.filter((k): k is P5Element => typeof k !== 'number');
      const lines = kids.filter((k): k is number => typeof k === 'number');
      if (dir && dir.startsWith('column')) {
        const gap = this.rowGap(el) ?? 0;
        const n = items.length + lines.length;
        return items.reduce((a, c) => a + outer(c), 0) + lines.reduce((a, b) => a + b, 0) + Math.max(0, n - 1) * gap;
      }
      return Math.max(0, ...items.map(outer), ...lines);
    }
    if (/grid$/.test(d)) return Math.max(0, ...kids.map((k) => (typeof k === 'number' ? k : outer(k))));
    if (d === 'table-row') return Math.max(0, ...kids.map((k) => (typeof k === 'number' ? k : this.height(k).h)));
    if (/^(table|inline-table|table-row-group|table-header-group|table-footer-group)$/.test(d)) return 0;
    // block flow: block children stacked with their margins collapsing, each run of inline content a line box
    const bfc = this.establishesBfc(el, d);
    let total = 0, pending: number[] = [], first = true;
    for (const k of kids) {
      if (typeof k === 'number') {
        if (pending.length && !(first && !padTop && !bfc)) total += collapse(pending);
        pending = []; total += k; first = false;
        continue;
      }
      const mt = this.vMargin(k, 'top') ?? 0, mb = this.vMargin(k, 'bottom') ?? 0;
      pending.push(mt);
      const h = this.height(k).h;
      if (h > 0) {
        if (!(first && !padTop && !bfc)) total += collapse(pending);
        total += h; pending = [mb]; first = false;
      } else pending.push(mb);
    }
    if (pending.length && !first && (padBottom || bfc)) total += collapse(pending);
    return total;
  }

  private establishesBfc(el: P5Element, d: string): boolean {
    if (/^(flow-root|inline-block|table-cell|table-caption)$/.test(d)) return true;
    const o = this.cascaded(el, ['overflow', 'overflow-y']);
    if (!o.ambiguous && o.value && /^(hidden|auto|scroll)/i.test(o.value.trim())) return true;
    const p = this.parentOf(el), pd = p ? this.displayOf(p) : null;
    return !!pd && /flex|grid/.test(pd);
  }

  /**
   * The in-flow content of a block container: its block-level children (elements), and each run of
   * inline content between them as a number, the run's least line box height. A bound text
   * (`data-sn-text`) is the whole content, one line.
   */
  private flow(el: P5Element): Array<P5Element | number> {
    if (attrOf(el, 'data-sn-text') !== undefined) { const lh = this.lineHeight(el) ?? 0; return lh > 0 ? [lh] : []; }
    const out: Array<P5Element | number> = [];
    let run: number | null = null;
    const strut = () => this.lineHeight(el) ?? 0;
    const add = (n: P5Node) => {
      if (!isEl(n)) {
        if (n.nodeName === '#text' && /\S/.test((n as { value: string }).value)) run = Math.max(run ?? 0, strut());
        return;
      }
      if (SKIPPED.has(n.tagName) || attrOf(n, 'hidden') !== undefined || attrOf(n, 'data-sn-show') !== undefined) return;
      const d = this.displayOf(n);
      if (d === null || d === 'none') return;
      if (!this.inFlow(n)) return;
      if (d === 'contents') { for (const c of n.childNodes) add(c); return; }
      if (/^(block|list-item|flow-root|flex|grid|table)$/.test(d)) {
        if (run !== null) { out.push(run); run = null; }
        out.push(n);
        return;
      }
      // inline-level: an inline box adds its own line height, an atomic one (inline-block, an image, a control) its box
      const h = this.inlineHeight(n, d);
      if (h > 0) run = Math.max(run ?? 0, h, strut());
    };
    for (const c of el.childNodes) add(c);
    if (run !== null) out.push(run);
    return out;
  }

  /** the least height an inline-level element adds to its line */
  private inlineHeight(el: P5Element, d: string): number {
    if (d === 'inline' && !REPLACED.has(el.tagName) && !CONTROLS.has(el.tagName)) {
      let h = 0;
      if (attrOf(el, 'data-sn-text') !== undefined || el.childNodes.some((c) => c.nodeName === '#text' && /\S/.test((c as { value: string }).value))) h = this.lineHeight(el) ?? 0;
      if (attrOf(el, 'data-sn-text') === undefined) for (const c of el.childNodes) {
        if (!isEl(c) || SKIPPED.has(c.tagName) || attrOf(c, 'hidden') !== undefined || attrOf(c, 'data-sn-show') !== undefined || !this.inFlow(c)) continue;
        const cd = this.displayOf(c);
        if (cd && cd !== 'none') h = Math.max(h, this.inlineHeight(c, cd === 'contents' ? 'inline' : cd));
      }
      return h;
    }
    return this.height(el).h + Math.max(0, this.vMargin(el, 'top') ?? 0) + Math.max(0, this.vMargin(el, 'bottom') ?? 0);
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

/** The placeholder of a list's rows: its tag, and its rule per viewport range from `from` px up (mobile first). */
export interface Reserved {
  tag: string;
  pieces: Array<{ from: number; decls: string }>;
  /** the stylesheets fix the rows' height: the placeholder is as tall as the rows (when `count` arrive) */
  exact: boolean;
}
interface Shape { mode: 'block' | 'column' | 'grid'; columns: number }
interface Space { height: number; mt: number; mb: number; span: number; exact: boolean }
interface Height { h: number; exact: boolean }

/** elements that lay out nothing in a row */
const SKIPPED = new Set(['template', 'script', 'style', 'link', 'meta', 'title', 'base', 'noscript', 'br', 'wbr', 'dialog', 'slot']);
const REPLACED = new Set(['img', 'svg', 'video', 'canvas', 'iframe', 'object', 'embed', 'audio']);
const CONTROLS = new Set(['input', 'button', 'select', 'textarea', 'meter', 'progress']);

/** a template's one element (whitespace and comments aside), or null */
function soleElement(tpl: P5Element): P5Element | null {
  const content = (tpl as P5Template).content;
  if (!content) return null;
  let one: P5Element | null = null;
  for (const c of content.childNodes) {
    if (isEl(c)) { if (one) return null; one = c; } else if (c.nodeName === '#text' && /\S/.test((c as { value: string }).value)) return null;
  }
  return one;
}

/** adjoining margins: the largest positive plus the most negative */
const collapse = (ms: number[]) => Math.max(0, ...ms) + Math.min(0, ...ms);

/** a placeholder valid where the rows are: an `<li>` in a list, else a `<div>` */
function placeholderTag(parent: P5Element, _row: P5Element): string {
  return /^(ul|ol|menu)$/.test(parent.tagName) ? 'li' : 'div';
}

function spaceCss(s: Space, _rowTag: string): string {
  const d = ['display:block', 'visibility:hidden', 'list-style:none', 'box-sizing:border-box', 'padding:0', 'border:0', 'margin:0', `height:${fmt(s.height)}px`, 'min-height:0', 'max-height:none', 'flex:none'];
  if (s.mt) d.push(`margin-top:${fmt(s.mt)}px`);
  if (s.mb) d.push(`margin-bottom:${fmt(s.mb)}px`);
  if (s.span) d.push('grid-column:1/-1', `grid-row:span ${s.span}`);
  return d.map((x) => `${x} !important`).join(';');
}

/** the size, line height and family of a `font` shorthand (`italic 600 1.5rem/1.1 "Source Sans", sans-serif`); null for a system font keyword */
function fontShorthand(v: string): { size: string; lineHeight: string | null; family: string } | null {
  const parts = splitTop(v.replace(/\s*\/\s*/g, '/'));
  const SIZE_TOKEN = /^(-?\d*\.?\d+(px|rem|em|ex|ch|%|pt|pc|vw|vh|vmin|vmax)|calc\(.*\)|min\(.*\)|max\(.*\)|clamp\(.*\)|var\(.*\)|(xx?x?-)?(small|large)|medium|smaller|larger)(\/.+)?$/i;
  const i = parts.findIndex((p) => SIZE_TOKEN.test(p));
  if (i < 0) return null;
  const [size, lh] = parts[i]!.split('/') as [string, string | undefined];
  const family = parts.slice(i + 1).join(' ');
  return family ? { size, lineHeight: lh ?? null, family } : null;
}

/**
 * The user-agent styles that change horizontal edges (the HTML spec's rendering section), and for
 * heights the font sizes and vertical margins, at their least (a top-level `<h1>` is 2em in some
 * browsers, 1.5em inside a section in others: 1.5em).
 */
const UA = `body { margin: 8px } ul, ol, menu { padding-inline-start: 40px } figure, blockquote { margin-inline: 40px } dd { margin-inline-start: 40px }
fieldset { margin-inline: 2px; padding-inline: 0.75em; border: 2px groove }
h1, h2 { font-size: 1.5em } h3 { font-size: 1.17em } h5 { font-size: 0.83em } h6 { font-size: 0.67em } small { font-size: smaller }
button, input, select, textarea { font-size: 13.333px }
h1 { margin-block: 0.67em } h2 { margin-block: 0.83em } h3, p, blockquote, figure, dl, pre, ul, ol, menu { margin-block: 1em } h4 { margin-block: 1.33em }
h5 { margin-block: 1.67em } h6 { margin-block: 2.33em } hr { margin-block: 0.5em }`;

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
