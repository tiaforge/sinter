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
import type { App, BoundBinding, Feature } from './runtime/app.js';

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
    app.ext.keys = ({ b, el }: BoundBinding, e: KeyboardEvent) => {
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
  },
};

export default keys;
