// @tiaforge-ui/sinter/messages: the built-in messages. Imported only by pages and modules that
// use `m` (the compiler adds it for `m.key()` in markup; app code imports `m` from here), so an
// app without messages ships none of it.
//
// A page has one language, chosen at build (docs/proposals/axes.md §7): its markup's messages are compiled into it,
// and the messages its app modules call are written into the page (`<script type="application/json"
// data-sn-messages>`), which `fixed()` reads. State lives on a global, shared by every copy of this module (the early
// file and the page bundle are bundled apart), and a swap adds the next page's messages to it.
import { config } from './runtime/config.js';

/** The messages, typed by the generated `src/sinter.messages.d.ts` (one method per key, `{param}`s as its argument). */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type -- filled in by declaration merging
export interface Messages {}

/** What every copy of this module shares: the page's language and its messages. */
export interface I18nState {
  locale: string;
  base: string;
  locales: string[];
  dicts: Record<string, Record<string, string>>;
}

const KEY = Symbol.for('sinter.i18n');
export const state = (): I18nState => ((globalThis as any)[KEY] ??= { locale: '', base: '', locales: [], dicts: {} });

/** `{name}` placeholders; a missing parameter stays as written */
const fill = (s: string, p?: Record<string, unknown>) => (p ? s.replace(/\{(\w+)\}/g, (x, n) => (n in p ? String(p[n]) : x)) : s);

/** The message `key` in the page's language (the build filled in the base language where a translation is missing). */
export function t(key: string, params?: Record<string, unknown>): string {
  const s = state();
  return fill(s.dicts[s.locale]?.[key] ?? s.dicts[s.base]?.[key] ?? key, params);
}

export const m = new Proxy({}, {
  get: (_, k) => (typeof k == 'string' ? (p?: Record<string, unknown>) => t(k, p) : undefined),
}) as Messages;

export const getLocale = (): string => state().locale;

/**
 * A page in its one language: the locale is fixed, and the page's own messages are compiled into it. The messages
 * the app's modules call (`m.key()` in a helper) are in the page, in `<script type="application/json"
 * data-sn-messages>`: nothing is loaded. The page module and the early script call it before anything renders; an
 * app's own `configure({ locale })` wins.
 */
export function fixed(locale: string): void {
  const s = state();
  s.locale = s.base = locale;
  s.locales = [locale];
  if (!s.dicts[locale]) {
    let d: Record<string, string> = {};
    try { const e = document.querySelector('script[data-sn-messages]'); if (e?.textContent) d = JSON.parse(e.textContent); } catch { /* none */ }
    s.dicts[locale] = d;
  }
  config.locale ??= { get: () => locale, set: () => {} };
}
