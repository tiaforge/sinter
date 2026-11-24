// Key filters: `data-sn-on-keydown-j`, `-shift-n`, `-mod-enter`, `-escape`, and the same on keyup.
// The compiler turns the attribute into the event (`n`), the key to match (`q`, a
// `KeyboardEvent.key`, letters in lowercase) and modifier bits (`m`); this feature decides per event.
//
// - Letters match `key` without regard to case, Shift must be held exactly when the filter names
//   it (`n` is n, `shift-n` is N, Caps Lock does not matter). When `key` is not a Latin letter (a
//   Cyrillic layout, or a dead key from Option on a Mac), the physical key (`code`, `KeyN`) counts.
// - Other characters (`?`, `1`, `slash`) match `key`, which already says whether Shift was needed,
//   so Shift is not checked unless named; with AltGr held, Ctrl and Alt are not checked either.
// - Named keys (`escape`, `enter`, `space`, `arrowdown`…) and every filter: the modifiers held are
//   exactly the ones named; `mod` is Meta on Apple platforms and Ctrl elsewhere.
// - Keys pressed in a field (text input, textarea, select, contenteditable) or Enter and Space on
//   a button, link, checkbox or the like are theirs: only a filter on that element itself matches.
// - Never during IME composition. A match calls `preventDefault()`; repeats match.
// - `page-` (bit 64): also for a key no element from the target up took, from wherever its element is (`pageKeys`;
//   the compiler marks its element `data-sn-keys`).
import { HANDLERS, type App, type BoundBinding, type Feature } from './runtime/app.js';

const g = globalThis as { navigator?: { platform?: string; userAgentData?: { platform?: string } } };

/** the key belongs to the focused element: typing, or activating a control */
const own = (t: HTMLElement, q: string) => {
  const n = t.localName, act = q == 'Enter' || q == ' ';
  return (t.isContentEditable ?? !!t.closest?.('[contenteditable]:not([contenteditable=false])')) || n == 'textarea' || n == 'select'
    || (n == 'input' ? act || !/^(button|submit|reset|checkbox|radio|image|file|color)$/.test((t as HTMLInputElement).type) : act && /^(button|a|summary)$/.test(n));
};

const keys: Feature = {
  name: 'keys',
  install(app: App) {
    const nav = g.navigator, mac = /mac|iphone|ipad|ipod/i.test(nav?.userAgentData?.platform ?? nav?.platform ?? '');
    const match = app.ext.keys = ({ b, el }: BoundBinding, e: KeyboardEvent) => {
      const q = b.q!, m = b.m ?? 0, k = e.key ?? '', t = e.target as HTMLElement;
      if (e.isComposing || (t != el && t.localName && own(t, q))) return false;
      if (/^[a-z]$/.test(q) ? k.toLowerCase() != q && (/^[a-z]$/i.test(k) || e.code != 'Key' + q.toUpperCase()) : k != q) return false;
      const loose = m & 32, altGr = loose && e.getModifierState?.('AltGraph');
      const want = (m & 15) | (m & 16 ? (mac ? 8 : 1) : 0);
      const have = (altGr ? 0 : (e.ctrlKey ? 1 : 0) | (e.altKey ? 2 : 0)) | (e.shiftKey ? 4 : 0) | (e.metaKey ? 8 : 0);
      if ((want ^ have) & (loose && !(m & 4) ? 11 : 15)) return false;
      e.preventDefault();
      return true;
    };
    // page-wide filters (`page-`, on elements the compiler marks `data-sn-keys`): for a key the walk from the target up
    // left, those that match, in the page's order; not outside an open modal dialog (the page behind it is inert), nor
    // in an `inert` subtree
    app.ext.pageKeys = (e, on) => {
      if (!/^key/.test(e.type)) return;
      const els = app.root.querySelectorAll('[data-sn-keys]');
      let modal: Element | undefined;
      if (els.length) for (const d of app.root.querySelectorAll('dialog[open]')) if (d.matches(':modal')) modal = d;
      for (const el of els) {
        if ((modal && !modal.contains(el)) || el.closest('[inert]')) continue;
        const hs = (el as Element & { [HANDLERS]?: BoundBinding[] })[HANDLERS];
        if (hs?.map) for (const rb of hs) if (rb.b.m! >= 64 && rb.b.n == e.type && match(rb, e as KeyboardEvent)) on(rb, e);
      }
    };
  },
};

export default keys;
