// @tiaforge-ui/sinter/messages: the messages' runtime. Imported only by pages and modules that
// use `m` (the compiler adds it for `m.key()` in markup; app code imports `m` from here), so an
// app without messages ships none of it.
//
// The runtime of the messages' content namespace (`inlang()`, docs/messages.md): a page has one language, chosen at
// build; its markup's messages are compiled into it, and the messages its app modules call are written into the page
// (`<script type="application/json" data-sn-ns="m">`), which `install()` reads. State lives on a global, shared by
// every copy of this module (the early file and the page bundle are bundled apart), and a swap adds the next page's
// entries to it.
import { config } from './runtime/config.js';

/**
 * The messages, typed by the generated `sinter.namespaces.d.ts` next to the content module (`inlang()`'s types: nested
 * objects for dotted ids, each message a function of its inputs).
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type -- filled in by declaration merging
export interface Entries {}
/** the messages' type: `Entries` */
export type Messages = Entries;

/** What every copy of this module shares: the page's language and its messages. */
export interface I18nState {
  locale: string;
  base: string;
  locales: string[];
  dicts: Record<string, Record<string, unknown>>;
  /** the content namespace's formatter (`inlang()`'s), for an entry that is not a plain text */
  format?: (entry: unknown, args: unknown, locale: string) => string;
}

const KEY = Symbol.for('sinter.i18n');
export const state = (): I18nState => ((globalThis as any)[KEY] ??= { locale: '', base: '', locales: [], dicts: {} });

/** `{name}` placeholders; a missing parameter stays as written */
const fill = (s: string, p?: Record<string, unknown>) => (p ? s.replace(/\{(\w+)\}/g, (x, n) => (n in p ? String(p[n]) : x)) : s);

/** The message `key` in the page's language (the build filled in the base language where a translation is missing). */
export function t(key: string, params?: Record<string, unknown>): string {
  const s = state(), e: any = s.dicts[s.locale]?.[key] ?? s.dicts[s.base]?.[key] ?? key;
  // a plain message is its text (`pack()`); any other goes through the namespace's formatter
  return typeof e == 'string' ? fill(e, params) : s.format ? s.format(e, params, s.locale) : key;
}

/** `m.key()`, and a nested id's `m.inbox.title()` */
const at = (path: string): unknown => new Proxy((p?: Record<string, unknown>) => t(path, p), {
  get: (f, k) => (typeof k == 'string' ? at(path ? `${path}.${k}` : k) : (f as any)[k]),
});
export const m = at('') as Messages;

export const getLocale = (): string => state().locale;

/**
 * The messages as a content namespace (`inlang()`, docs/proposals/messages.md §2): the page module calls it with the
 * page's language and the namespace's formatter; the entries the app's modules call are in the page, in
 * `<script type="application/json" data-sn-ns="m">`, packed (`pack()`). The page's one language is the locale
 * `date()` and `number()` format in, unless the app's `configure({ locale })` set one.
 */
export function install(locale: string, format?: I18nState['format'] | null, name = 'm'): void {
  const s = state();
  if (format) s.format = format;
  s.locale = s.base = locale;
  s.locales = [locale];
  if (!s.dicts[locale]) {
    s.dicts[locale] = {};
    try { const e = document.querySelector(`script[data-sn-ns="${name}"]`); if (e?.textContent) s.dicts[locale] = JSON.parse(e.textContent); } catch { /* none */ }
  }
  config.locale ??= { get: () => locale, set: () => {} };
}
