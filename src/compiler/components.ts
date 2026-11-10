// Components (docs/proposals/components.md): a file in `src/components/` whose name is
// its tag. The compiler expands each use at build time, so a component's markup is page
// markup; this module reads component files and the contract they declare.

/** A prop or event name in a type literal, with where it is written in the type text. */
export interface Member { name: string; optional: boolean; offset: number }

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
    out.push({ name: (m[1] ?? m[2] ?? m[3])!, optional: !!m[4], offset: i });
    i += m[0].length;
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
  }
  return out;
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
  return /^data-sn-(prop|model|persist|class|attr|style|show|transition|get|post|put|patch|delete|call|body|trigger|debounce|concurrency|optimistic|then|catch|confirm|encoding|apply|retry)$/.test(name)
    || name.startsWith('data-sn-on-') || name.startsWith('data-sn-debounce-');
}
