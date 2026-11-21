// Built-in helpers. Each reads the current locale, so bindings that call them
// re-run when `$locale` changes.
import { config } from './config.js';
import { envOf } from './env.js';

const locale = () => config.locale?.get();

/**
 * A page in one language (`localePrefix`, or a build in its content's base language): the locale the built-in
 * formatters use, unless the app's `configure({ locale })` set one. The page module and the early file call it.
 */
export function $lang(l: string): void {
  config.locale ??= { get: () => l, set: () => {} };
}

// Building an Intl formatter costs far more than formatting with it: one per kind, locale and
// options, reused. A locale switch reads another key, so nothing needs clearing.
const cache = new Map<string, Intl.DateTimeFormat | Intl.RelativeTimeFormat | Intl.NumberFormat>();
function fmt<T extends Intl.DateTimeFormat | Intl.RelativeTimeFormat | Intl.NumberFormat>(
  make: new (l: string | undefined, o: any) => T, kind: string, o?: object,
): T {
  const l = locale(), key = `${kind}\0${l ?? ''}\0${o ? JSON.stringify(o) : ''}`;
  let f = cache.get(key) as T | undefined;
  if (!f) {
    // a bounded map: options from markup are few, but a helper fed computed options must not grow it forever
    if (cache.size >= 200) cache.clear();
    cache.set(key, (f = new make(l, o)));
  }
  return f;
}

const toDate = (v: unknown): Date | null => {
  if (v == null || v === '') return null;
  const d = v instanceof Date ? v : new Date(v as string | number);
  return Number.isNaN(d.getTime()) ? null : d;
};

type Style = 'full' | 'long' | 'medium' | 'short';

/**
 * A calendar date (`2026-11-11`): JavaScript reads it as midnight UTC (a date-time without an offset is local),
 * so it is the same day for every visitor only when it is shown in UTC too
 */
export const isCalendarDate = (v: unknown): v is string => typeof v == 'string' && /^\d{4}-\d\d-\d\d$/.test(v);

/**
 * A date, a time, or both: `date(v)`, `date(v, 'long')`, `date(v, 'medium', 'short')` (with the time),
 * `date(v, null, 'short')` (the time only). A calendar date (`2026-03-04`) is that day wherever it is shown.
 */
export function date(v: unknown, style: Style | null = 'medium', timeStyle?: Style): string {
  const d = toDate(v);
  if (!d) return '';
  const o: Intl.DateTimeFormatOptions = { ...(style ? { dateStyle: style } : {}), ...(timeStyle ? { timeStyle } : {}) };
  if (!style && !timeStyle) o.dateStyle = 'medium';
  return fmt(Intl.DateTimeFormat, 'd', { ...o, timeZone: !timeStyle && isCalendarDate(v) ? 'UTC' : undefined }).format(d);
}

const UNITS: Array<[Intl.RelativeTimeFormatUnit, number]> = [
  ['year', 31536000], ['month', 2592000], ['week', 604800], ['day', 86400], ['hour', 3600], ['minute', 60], ['second', 1],
];

/** "3 days ago", relative to `now` (default: the clock `$now` reads; a binding calling it follows `$now`). */
export function relative(v: unknown, now: unknown = envOf(config).now()): string {
  const d = toDate(v), n = toDate(now);
  if (!d || !n) return '';
  const diff = (d.getTime() - n.getTime()) / 1000;
  const rtf = fmt(Intl.RelativeTimeFormat, 'r', { numeric: 'auto' });
  for (const [unit, secs] of UNITS) {
    if (Math.abs(diff) >= secs || unit === 'second') return rtf.format(Math.round(diff / secs), unit);
  }
  return '';
}

export function number(v: unknown, opts?: Intl.NumberFormatOptions): string {
  if (v == null || v === '' || Number.isNaN(Number(v))) return '';
  return fmt(Intl.NumberFormat, 'n', opts).format(Number(v));
}

const BYTE_UNITS = ['byte', 'kilobyte', 'megabyte', 'gigabyte', 'terabyte'];

export function bytes(v: unknown): string {
  let n = Number(v);
  if (v == null || v === '' || Number.isNaN(n)) return '';
  let i = 0;
  while (Math.abs(n) >= 1024 && i < BYTE_UNITS.length - 1) { n /= 1024; i++; }
  return fmt(Intl.NumberFormat, 'n', { style: 'unit', unit: BYTE_UNITS[i], unitDisplay: 'short', maximumFractionDigits: i ? 1 : 0 }).format(n);
}
