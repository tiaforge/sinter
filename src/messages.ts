// @tiaforge-ui/sinter/messages: the built-in messages. Imported only by pages and modules that
// use `m` (the compiler adds it for `m.key()` in markup; app code imports `m` from here), so an
// app without messages ships none of it.
//
// State lives on a global, shared by every copy of this module (the early file and the page
// bundle are bundled apart) and by the page's language files: the picker script (I18N_PICKER)
// chooses the locale and loads that language's file before the first paint; the page bundle
// reads the same dictionary.
import { config } from './runtime/config.js';

/** The messages, typed by the generated `src/sinter.messages.d.ts` (one method per key, `{param}`s as its argument). */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type -- filled in by declaration merging
export interface Messages {}

/** What the picker script, the language files and every copy of this module share. */
export interface I18nState {
  locale: string;
  base: string;
  locales: string[];
  /** localStorage key of the visitor's choice */
  storage: string;
  /** language file URL per locale, for this page */
  files: Record<string, string>;
  dicts: Record<string, Record<string, string>>;
  /** called by a language file once it has stored its dictionary */
  loaded?: (locale: string) => void;
  /** prototype (observe): the sheet that hides the base-language text until the page module has rendered */
  hide?: CSSStyleSheet;
  subs?: Set<() => void>;
}

const KEY = Symbol.for('sinter.i18n');
export const state = (): I18nState => ((globalThis as any)[KEY] ??= { locale: '', base: '', locales: [], storage: 'locale', files: {}, dicts: {} });

/** `{name}` placeholders; a missing parameter stays as written */
const fill = (s: string, p?: Record<string, unknown>) => (p ? s.replace(/\{(\w+)\}/g, (x, n) => (n in p ? String(p[n]) : x)) : s);

/** The message `key` in the current locale (the build filled in the base language where a translation is missing). */
export function t(key: string, params?: Record<string, unknown>): string {
  const s = state();
  return fill(s.dicts[s.locale]?.[key] ?? s.dicts[s.base]?.[key] ?? key, params);
}

export const m = new Proxy({}, {
  get: (_, k) => (typeof k == 'string' ? (p?: Record<string, unknown>) => t(k, p) : undefined),
}) as Messages;

export const getLocale = (): string => state().locale;

/** Resolves once the current locale's dictionary is there (the early file awaits it). */
export function ready(): Promise<void> {
  const s = state();
  if (!s.locale || s.dicts[s.locale]) return Promise.resolve();
  return new Promise((done) => {
    const prev = s.loaded;
    s.loaded = (l) => { prev?.(l); if (s.dicts[s.locale]) done(); };
  });
}

/**
 * Switches the language without a reload: stores the choice, loads this page's file for it (once),
 * sets `<html lang>` and re-renders what reads `$locale`. Unknown locales are ignored.
 */
export async function setLocale(locale: string): Promise<void> {
  const s = state();
  if (!s.locales.includes(locale)) return;
  try { localStorage.setItem(s.storage, locale); } catch { /* storage blocked */ }
  if (!s.dicts[locale] && s.files[locale]) await import(/* @vite-ignore */ s.files[locale]);
  s.locale = locale;
  document.documentElement.lang = locale;
  for (const f of s.subs ?? []) f();
}

/**
 * A page built in one language (`sinter({ localePrefix: true })`): the locale is fixed, and the page's own
 * messages are compiled into it. The messages the app's modules call (`m.key()` in a helper) are in the page,
 * in `<script type="application/json" data-sn-messages>`: nothing is loaded. The page module and the early
 * script call it before anything renders; an app's own `configure({ locale })` wins.
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

let mounted: { mark(path: string): void } | null = null;

/**
 * sinter's locale source: `$locale` reads it, `$locale = 'de'` switches (re-rendering once the
 * language file is there), `date()` and `number()` format with it. The page module calls it before
 * mounting and again with the mounted app; an app's own `configure({ locale })` wins.
 */
export function use(app?: { mark(path: string): void }): void {
  if (app) mounted = app;
  // mounted: every message is in the visitor's language now
  const h = app && state().hide;
  if (h) { document.adoptedStyleSheets = document.adoptedStyleSheets.filter((x) => x !== h); delete state().hide; }
  if (config.locale) return;
  config.locale = { get: getLocale, set: (l) => { void setLocale(l).then(() => mounted?.mark('$locale')); } };
}

/** Calls `fn` after each language switch; returns the unsubscribe function. */
export function onLocale(fn: () => void): () => void {
  const s = state();
  (s.subs ??= new Set()).add(fn);
  return () => { s.subs!.delete(fn); };
}
