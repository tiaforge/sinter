import * as csstree from 'css-tree';

// Components (docs/proposals/components.md): a file in `src/components/` whose name is
// its tag. The compiler expands each use at build time, so a component's markup is page
// markup; this module reads component files and the contract they declare.

/** A prop or event name in a type literal, with where it is written in the type text. */
export interface Member {
  name: string;
  optional: boolean;
  offset: number;
  /** the member's type as written (`Article`, `Slot<{ row: Row }>`) */
  type?: string;
  /** `Slot<T>`: a slot that passes `T` to its fill (docs/components.md, Slots that pass data); T as written */
  slot?: string;
}

/**
 * The members of a TypeScript type literal (`{ article: Article; compact?: boolean }`), at its
 * top level: names, whether they are optional, and their offsets in `text`. Null when the
 * text is not a type literal (an alias such as `Props`): its members are then unknown to the
 * compiler, and only `sinter check` checks them.
 */
export function typeMembers(text: string): Member[] | null {
  let i = 0;
  const ws = () => { while (i < text.length && /\s/.test(text[i]!)) i++; };
  ws();
  if (text[i] !== '{') return null;
  const close = matching(text, i);
  if (close < 0) return null;
  const tail = text.slice(close + 1).trim();
  if (tail !== '') return null;
  const out: Member[] = [];
  i++;
  while (i < close) {
    // skip separators and comments
    while (i < close && /[\s;,]/.test(text[i]!)) i++;
    if (text.startsWith('//', i)) { i = text.indexOf('\n', i); if (i < 0) i = close; continue; }
    if (text.startsWith('/*', i)) { const e = text.indexOf('*/', i); i = e < 0 ? close : e + 2; continue; }
    if (i >= close) break;
    if (text.startsWith('readonly ', i)) i += 9;
    const m = /^(?:([A-Za-z_$][\w$]*)|'([^']*)'|"([^"]*)")\s*(\?)?\s*:/.exec(text.slice(i, close));
    if (!m) return null;
    const member: Member = { name: (m[1] ?? m[2] ?? m[3])!, optional: !!m[4], offset: i };
    out.push(member);
    i += m[0].length;
    const from = i;
    // the member's type, up to the next separator at depth 0
    let depth = 0;
    while (i < close) {
      const c = text[i]!;
      if (c === '\'' || c === '"' || c === '`') { i = endOfString(text, i); continue; }
      if ('{[(<'.includes(c)) depth++;
      else if ('}])>'.includes(c)) { if (c !== '>' || text[i - 1] !== '=') depth--; }
      else if (depth === 0 && (c === ';' || c === ',' || c === '\n')) break;
      i++;
    }
    member.type = text.slice(from, i).trim();
    const slot = /^Slot\s*<([\s\S]*)>$/.exec(member.type);
    if (slot) member.slot = slot[1]!.trim();
  }
  return out;
}

/** A use of `Slot` as a type (`Slot<…>`) anywhere in a type's text. */
export const SLOT_TYPE = /(?<![\w$.])Slot\s*</;

/**
 * A props type literal without its `Slot<T>` members: what callers pass with `data-sn-prop`, what a
 * script's `this.props` holds. Slots are filled with markup, not passed. The text unchanged when it
 * has none, or is not a type literal.
 */
export function withoutSlots(text: string): string {
  const members = typeMembers(text.trim() === '' ? '{}' : text);
  if (!members?.some((m) => m.slot !== undefined)) return text;
  const kept = members.filter((m) => m.slot === undefined).map((m) => text.slice(m.offset, m.offset + memberLength(text, m)).trim().replace(/[;,]$/, ''));
  return kept.length ? `{ ${kept.join('; ')} }` : '{}';
}

/** The length of a member's text from its offset, up to (not including) its separator. */
function memberLength(text: string, m: Member): number {
  const at = text.indexOf(':', m.offset);
  const t = m.type ?? '';
  const end = text.indexOf(t, at) + t.length;
  return end - m.offset;
}

function endOfString(text: string, i: number): number {
  const q = text[i]!;
  i++;
  while (i < text.length && text[i] !== q) i += text[i] === '\\' ? 2 : 1;
  return i + 1;
}

function matching(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const c = text[i]!;
    if (c === '\'' || c === '"' || c === '`') { i = endOfString(text, i) - 1; continue; }
    if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return i;
  }
  return -1;
}

/** A component's name: its file name, which must contain a `-` (a valid custom element name). */
export const COMPONENT_NAME = /^[a-z][a-z0-9]*(-[a-z0-9]+)+$/;

/**
 * DOM events a component's root may dispatch itself, which a caller handles without the
 * component declaring them in `data-sn-emits`.
 */
export const DOM_EVENTS = new Set([
  'click', 'dblclick', 'auxclick', 'contextmenu', 'input', 'change', 'beforeinput', 'submit', 'reset', 'invalid', 'select',
  'keydown', 'keyup', 'keypress', 'focus', 'blur', 'focusin', 'focusout', 'wheel', 'scroll', 'scrollend', 'toggle', 'beforetoggle',
  'close', 'cancel', 'load', 'error', 'copy', 'cut', 'paste', 'drag', 'dragstart', 'dragend', 'dragenter', 'dragleave', 'dragover', 'drop',
  'pointerdown', 'pointerup', 'pointermove', 'pointerover', 'pointerout', 'pointerenter', 'pointerleave', 'pointercancel',
  'gotpointercapture', 'lostpointercapture', 'mousedown', 'mouseup', 'mousemove', 'mouseover', 'mouseout', 'mouseenter', 'mouseleave',
  'touchstart', 'touchend', 'touchmove', 'touchcancel', 'animationstart', 'animationend', 'animationiteration', 'animationcancel',
  'transitionstart', 'transitionend', 'transitionrun', 'transitioncancel', 'compositionstart', 'compositionupdate', 'compositionend',
]);

/**
 * The sinter attributes a caller may write on a component's tag: they move onto its root with
 * the caller's scope. Everything else that would change the component's content (`data-sn-text`,
 * `data-sn-state`, …) belongs inside the component.
 */
export function callerAttribute(name: string): boolean {
  return /^data-sn-(prop|model|persist|early|class|attr|style|show|transition|get|post|put|patch|delete|call|body|trigger|debounce|concurrency|optimistic|then|catch|confirm|encoding|apply|retry)$/.test(name)
    || name.startsWith('data-sn-on-') || name.startsWith('data-sn-debounce-');
}

/** at-rules that cannot be scoped: they stay at the top of the stylesheet */
const GLOBAL_AT = new Set(['import', 'font-face', 'keyframes', '-webkit-keyframes', 'property', 'counter-style', 'font-feature-values', 'font-palette-values', 'page', 'namespace', 'charset']);

/**
 * A component's `<style>`, scoped with native `@scope`: from its roots (the component's root, and the
 * slot content it passes into other components) to the boundaries (a nested component's root, slot
 * content). At-rules that cannot be scoped (`@keyframes`, `@font-face`, `@import`, …) stay outside.
 *
 * In `@scope`, a selector without `:scope` or `&` matches only below the scope root, so the root
 * itself (`.preview`, the `.compact` of `.compact p`) would never match. Each such selector gets a
 * copy whose first compound may be the root, `.compact p, :where(:scope):is(.compact) p`, with the
 * same specificity (`:where()` adds none). Selectors are otherwise as written.
 */
export function scopeCss(css: string, name: string): string {
  const { global, scoped } = splitCss(css);
  const sel = JSON.stringify(name);
  const out = [...global];
  if (scoped.length) out.push(`@scope ([data-sn-c=${sel}], [data-sn-s=${sel}]) to ([data-sn-c], [data-sn-s]) {\n${scoped.join('\n')}\n}`);
  return out.join('\n') + '\n';
}

/**
 * A component's root rules, for an element that is its root through another component's tag (its
 * root is `<ui-button>`, whose own root renders): the selectors that can match the scope root
 * itself (one compound, `.primary`, or `:scope`), against `[data-sn-r~="<name>"]` outside `@scope`,
 * with the same specificity. Rules that reach inside are not copied: inside, the markup is the other
 * component's. Inside `@media` and `@supports` too. Null when there are none.
 */
export function rootCss(css: string, name: string): string | null {
  const ast = csstree.parse(css, { parseValue: false, parseAtrulePrelude: false }) as csstree.StyleSheet;
  const mark = `:where([data-sn-r~=${JSON.stringify(name)}])`;
  const out: string[] = [];
  const rule = (r: csstree.Rule): string | null => {
    if (r.prelude.type !== 'SelectorList') return null;
    const sels: string[] = [];
    r.prelude.children.forEach((sel) => {
      if (sel.type !== 'Selector') return;
      const nodes = sel.children.toArray();
      if (nodes.some((n) => n.type === 'Combinator')) return;
      const text = csstree.generate(sel);
      if (/^(:scope|&)$/.test(text)) { sels.push(mark); return; }
      if (/:scope\b|&/.test(text)) return;
      const pe = nodes.findIndex((n) => n.type === 'PseudoElementSelector');
      const compound = (pe < 0 ? nodes : nodes.slice(0, pe)).map((n) => csstree.generate(n)).join('');
      const tail = pe < 0 ? '' : nodes.slice(pe).map((n) => csstree.generate(n)).join('');
      sels.push(`${mark}:is(${compound})${tail}`);
    });
    return sels.length ? `${sels.join(', ')}{${csstree.generate(r.block).slice(1, -1)}}` : null;
  };
  const visit = (n: csstree.CssNode): string | null => {
    if (n.type === 'Rule') return rule(n);
    if (n.type === 'Atrule' && n.block && /^(media|supports|container|layer)$/i.test(n.name)) {
      const inner: string[] = [];
      n.block.children.forEach((c) => { const x = visit(c); if (x) inner.push(x); });
      return inner.length ? `@${n.name} ${n.prelude ? csstree.generate(n.prelude) : ''}{${inner.join('')}}` : null;
    }
    return null;
  };
  ast.children.forEach((n) => { if (!(n.type === 'Atrule' && GLOBAL_AT.has(n.name.toLowerCase()))) { const x = visit(n); if (x) out.push(x); } });
  return out.length ? out.join('\n') + '\n' : null;
}

/** `.compact p` → `.compact p, :where(:scope):is(.compact) p`: the first compound may also be the scope root. */
function withRoot(rule: csstree.Rule) {
  if (rule.prelude.type !== 'SelectorList') return;
  const extra: csstree.CssNode[] = [];
  rule.prelude.children.forEach((selector) => {
    if (selector.type !== 'Selector') return;
    const text = csstree.generate(selector);
    if (/:scope\b|&/.test(text)) return;
    const nodes = selector.children.toArray();
    const cut = nodes.findIndex((n) => n.type === 'Combinator');
    const first = cut < 0 ? nodes : nodes.slice(0, cut);
    // a sibling of the root is outside the scope: nothing to add
    const comb = cut < 0 ? null : (nodes[cut] as csstree.Combinator).name;
    if (comb === '+' || comb === '~') return;
    // a pseudo-element cannot go into `:is()`: it follows it
    const pe = first.findIndex((n) => n.type === 'PseudoElementSelector');
    const compound = (pe < 0 ? first : first.slice(0, pe)).map((n) => csstree.generate(n)).join('');
    if (!compound) return;
    const tail = [...(pe < 0 ? [] : first.slice(pe)), ...(cut < 0 ? [] : nodes.slice(cut))].map((n) => {
      const g = csstree.generate(n);
      return n.type === 'Combinator' ? (g.trim() ? ` ${g.trim()} ` : ' ') : g;
    }).join('');
    extra.push(csstree.parse(`:where(:scope):is(${compound})${tail}`, { context: 'selector' }));
  });
  for (const x of extra) rule.prelude.children.appendData(x);
}

function splitCss(css: string): { global: string[]; scoped: string[] } {
  const ast = csstree.parse(css, { parseValue: false, parseAtrulePrelude: false }) as csstree.StyleSheet;
  const global: string[] = [], scoped: string[] = [];
  ast.children.forEach((node) => {
    if (node.type === 'Atrule' && (GLOBAL_AT.has(node.name.toLowerCase()) || (node.name.toLowerCase() === 'layer' && !node.block))) { global.push(csstree.generate(node)); return; }
    // the rules of the scope, inside `@media` and `@supports` too; not rules nested in rules (relative to their parent)
    const visit = (n: csstree.CssNode) => {
      if (n.type === 'Rule') return withRoot(n);
      if (n.type === 'Atrule' && n.block) n.block.children.forEach(visit);
    };
    visit(node);
    scoped.push(csstree.generate(node));
  });
  return { global, scoped };
}
