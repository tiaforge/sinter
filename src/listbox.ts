// `data-sn-listbox="list-id"`: a text input with a list of suggestions, the WAI-ARIA combobox
// pattern. The compiler marks the input (`role="combobox"`, `aria-controls`); this feature handles
// its keys. Without an id, the list is the nearest `[role="listbox"]` around the input. The options are the shown `[role="option"]` elements of the list, picked by clicking
// them, so the page's own `data-sn-on-click` decides what a pick does.
//
// ArrowDown/ArrowUp: mark the next or previous option (`aria-selected="true"`).
// Enter: click the marked option. Tab: click the marked one, or the only one.
// Escape: fire `dismiss` on the input (`data-sn-on-dismiss` hides the list).
// Typing unmarks; pressing the mouse on an option keeps the focus in the input.
import type { App, Feature } from './runtime/app.js';

/** the input's list: `aria-controls`, else the nearest listbox around it */
const listOf = (input: Element): Element | null => {
  const id = input.getAttribute('aria-controls');
  if (id) return input.ownerDocument.getElementById(id);
  for (let p = input.parentElement; p; p = p.parentElement) {
    const list = p.querySelector('[role="listbox"]');
    if (list) return list;
  }
  return null;
};
const options = (input: Element): HTMLElement[] => {
  const list = listOf(input);
  if (!list || list.closest('[hidden]')) return [];
  return [...list.querySelectorAll<HTMLElement>('[role="option"]')].filter((o) => !o.closest('[hidden]'));
};
const mark = (all: HTMLElement[], next: HTMLElement | null) => {
  for (const o of all) o.setAttribute('aria-selected', String(o == next));
  next?.scrollIntoView?.({ block: 'nearest' });
};

const listbox: Feature = {
  name: 'listbox',
  install(app: App) {
    const root = app.root;
    root.addEventListener('keydown', (e: Event) => {
      const input = (e.target as Element).closest?.('[role="combobox"]');
      if (!input || (e as KeyboardEvent).isComposing) return;
      const all = options(input);
      if (!all.length) return;
      const at = all.findIndex((o) => o.getAttribute('aria-selected') == 'true');
      const key = (e as KeyboardEvent).key;
      if (key == 'ArrowDown' || key == 'ArrowUp') {
        e.preventDefault();
        mark(all, key == 'ArrowDown' ? all[Math.min(at + 1, all.length - 1)]! : at > 0 ? all[at - 1]! : null);
      } else if ((key == 'Enter' && at >= 0) || (key == 'Tab' && (at >= 0 || all.length == 1))) {
        e.preventDefault();
        mark(all, null);
        all[Math.max(at, 0)]!.click();
      } else if (key == 'Escape') {
        e.preventDefault();
        mark(all, null);
        input.dispatchEvent(new CustomEvent('dismiss', { bubbles: true }));
      }
    });
    root.addEventListener('input', (e: Event) => {
      const input = (e.target as Element).closest?.('[role="combobox"]');
      if (input) mark(options(input), null);
    });
    root.addEventListener('mousedown', (e: Event) => {
      // only in lists that belong to a combobox: keep the focus in the input
      const option = (e.target as Element).closest?.('[role="option"]');
      const list = option?.closest('[role="listbox"]');
      if (list && [...root.querySelectorAll('[role="combobox"]')].some((c) => listOf(c) == list)) e.preventDefault();
    });
  },
};

export default listbox;
