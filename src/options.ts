// `data-sn-options`: keys move a mark through a list of options, and Enter clicks the marked one. A
// text field with suggestions (the WAI-ARIA combobox) is one use; a menu, a selectable list or a
// command palette are others. The focus stays on the element with the attribute (the owner); the
// mark is `aria-activedescendant` on it, `data-sn-marked` on the option, and `aria-selected` on an
// option whose role takes it. The options are the shown, enabled `[role=option]` and
// `[role=menuitem…]` elements of the list, picked by clicking them, so the page's own
// `data-sn-on-click` decides what a pick does.
//
// The list: the element whose id the attribute names; else the owner itself when it holds options;
// else the nearest listbox or menu around it (a text field rendered in a loop).
//
// ArrowDown/ArrowUp mark the next or previous option (ArrowRight/ArrowLeft in a list with
// `aria-orientation="horizontal"`, not in a text field, whose caret they move). Home/End: the first
// and last (not in a text field). Enter clicks the marked option; Space too, outside a text field;
// Tab clicks the marked one, or the only one, in a text field. Escape fires `dismiss` on the owner, and
// stays with the list only when it closes something (see below).
// Typing unmarks; pressing the mouse on an option of a list outside the owner keeps the focus where it is.
import type { App, Feature } from './runtime/app.js';

const ITEM = '[role="option"],[role="menuitem"],[role="menuitemcheckbox"],[role="menuitemradio"]';
const LIST = '[role="listbox"],[role="menu"],[role="menubar"]';
const CONTROL = 'input,textarea,select,button,a[href],[contenteditable]:not([contenteditable="false"]),[tabindex]';
const SELECTABLE = 'option';
let ids = 0;

const isText = (el: Element) => el.localName == 'textarea'
  || (el.localName == 'input' && !/^(button|submit|reset|checkbox|radio|image|file|color|range)$/.test((el as HTMLInputElement).type));

/** the owner's list: the element its value names, the owner when it holds options, else the nearest list around it */
const listOf = (owner: Element): Element | null => {
  const id = owner.getAttribute('data-sn-options');
  if (id) return owner.ownerDocument.getElementById(id);
  if (owner.querySelector(ITEM)) return owner;
  for (let p = owner.parentElement; p; p = p.parentElement) {
    const list = p.querySelector(LIST);
    if (list) return list;
  }
  return null;
};
const optionsOf = (owner: Element): HTMLElement[] => {
  const list = listOf(owner);
  if (!list || list.closest('[hidden]')) return [];
  return [...list.querySelectorAll<HTMLElement>(ITEM)].filter((o) => !o.closest('[hidden]') && o.getAttribute('aria-disabled') != 'true');
};
const markedOf = (all: HTMLElement[]) => all.findIndex((o) => o.hasAttribute('data-sn-marked'));
const mark = (owner: Element, all: HTMLElement[], next: HTMLElement | null) => {
  for (const o of all) {
    if (o == next) o.setAttribute('data-sn-marked', '');
    else o.removeAttribute('data-sn-marked');
    if (o.getAttribute('role') == SELECTABLE) o.setAttribute('aria-selected', String(o == next));
  }
  if (next) {
    if (!next.id) next.id = `sn-o-${++ids}`;
    owner.setAttribute('aria-activedescendant', next.id);
    next.scrollIntoView?.({ block: 'nearest' });
  } else owner.removeAttribute('aria-activedescendant');
};

const feature: Feature = {
  name: 'options',
  install(app: App) {
    const root = app.root;
    // removed on destroy, so a page mounted again (tests) does not handle each key twice
    const ctl = new AbortController(), on = { signal: ctl.signal };
    app.addCleanup(() => ctl.abort());
    root.addEventListener('keydown', (e: Event) => {
      const t = e.target as Element, owner = t.closest?.('[data-sn-options]');
      if (!owner || (e as KeyboardEvent).isComposing) return;
      // a control of its own inside the list (a filter field, a button) keeps its keys, unless it is an option
      if (t != owner && !t.closest(ITEM) && t.matches(CONTROL)) return;
      const all = optionsOf(owner);
      if (!all.length) return;
      const text = isText(owner), at = markedOf(all), key = (e as KeyboardEvent).key;
      const across = !text && (listOf(owner)?.getAttribute('aria-orientation') ?? owner.getAttribute('aria-orientation')) == 'horizontal';
      const [prev, next] = across ? ['ArrowLeft', 'ArrowRight'] : ['ArrowUp', 'ArrowDown'];
      const to = (o: HTMLElement | null) => { e.preventDefault(); mark(owner, all, o); };
      if (key == next) to(all[Math.min(at + 1, all.length - 1)]!);
      // in a text field, up from the first option goes back to the field; elsewhere the mark stays
      else if (key == prev) to(at > 0 ? all[at - 1]! : text ? null : all[0]!);
      else if (!text && key == 'Home') to(all[0]!);
      else if (!text && key == 'End') to(all[all.length - 1]!);
      else if (((key == 'Enter' || (key == ' ' && !text)) && at >= 0) || (text && key == 'Tab' && (at >= 0 || all.length == 1))) {
        e.preventDefault();
        const pick = all[Math.max(at, 0)]!;
        // a text field's mark goes with the pick (its list usually closes); a menu's or a list's stays
        if (text) mark(owner, all, null);
        pick.click();
      } else if (key == 'Escape') {
        mark(owner, all, null);
        const kept = !owner.dispatchEvent(new CustomEvent('dismiss', { bubbles: true, cancelable: true }));
        // Escape is the list's when it closes something: a text field's suggestions, a mark, or a
        // `dismiss` handler that calls `$event.preventDefault()`; otherwise it goes on (a dialog closes)
        if (text || at >= 0 || kept) e.preventDefault();
      }
    }, on);
    root.addEventListener('input', (e: Event) => {
      const owner = (e.target as Element).closest?.('[data-sn-options]');
      if (owner && isText(owner)) mark(owner, optionsOf(owner), null);
    }, on);
    root.addEventListener('mousedown', (e: Event) => {
      // an option of a list outside its owner (a text field's suggestions): the focus stays in the owner
      const option = (e.target as Element).closest?.(ITEM);
      if (!option) return;
      for (const owner of root.querySelectorAll('[data-sn-options]')) {
        const list = listOf(owner);
        if (list && list != owner && !owner.contains(list) && list.contains(option)) return e.preventDefault();
      }
    }, on);
  },
};

export default feature;
