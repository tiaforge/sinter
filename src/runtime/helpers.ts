// Built-in helpers. Each reads the current locale, so bindings that call them
// re-run when `$locale` changes.
import { config } from './config.js';

const locale = () => config.locale?.get();

const toDate = (v: unknown): Date | null => {
  if (v == null || v === '') return null;
  const d = v instanceof Date ? v : new Date(v as string | number);
  return Number.isNaN(d.getTime()) ? null : d;
};

type Style = 'full' | 'long' | 'medium' | 'short';

export function date(v: unknown, style: Style = 'medium'): string {
  const d = toDate(v);
  return d ? new Intl.DateTimeFormat(locale(), { dateStyle: style }).format(d) : '';
}

export function time(v: unknown, style: Style = 'short'): string {
  const d = toDate(v);
  return d ? new Intl.DateTimeFormat(locale(), { timeStyle: style }).format(d) : '';
}

export function datetime(v: unknown, style: Style = 'medium'): string {
  const d = toDate(v);
  return d ? new Intl.DateTimeFormat(locale(), { dateStyle: style, timeStyle: 'short' }).format(d) : '';
}

const UNITS: Array<[Intl.RelativeTimeFormatUnit, number]> = [
  ['year', 31536000], ['month', 2592000], ['week', 604800], ['day', 86400], ['hour', 3600], ['minute', 60], ['second', 1],
];

/** "3 days ago", relative to `now` (default: the current time). */
export function relative(v: unknown, now: unknown = Date.now()): string {
  const d = toDate(v), n = toDate(now);
  if (!d || !n) return '';
  const diff = (d.getTime() - n.getTime()) / 1000;
  const fmt = new Intl.RelativeTimeFormat(locale(), { numeric: 'auto' });
  for (const [unit, secs] of UNITS) {
    if (Math.abs(diff) >= secs || unit === 'second') return fmt.format(Math.round(diff / secs), unit);
  }
  return '';
}

export function number(v: unknown, opts?: Intl.NumberFormatOptions): string {
  if (v == null || v === '' || Number.isNaN(Number(v))) return '';
  return new Intl.NumberFormat(locale(), opts).format(Number(v));
}

const BYTE_UNITS = ['byte', 'kilobyte', 'megabyte', 'gigabyte', 'terabyte'];

export function bytes(v: unknown): string {
  let n = Number(v);
  if (v == null || Number.isNaN(n)) return '';
  let i = 0;
  while (Math.abs(n) >= 1024 && i < BYTE_UNITS.length - 1) { n /= 1024; i++; }
  return new Intl.NumberFormat(locale(), { style: 'unit', unit: BYTE_UNITS[i], unitDisplay: 'short', maximumFractionDigits: i ? 1 : 0 }).format(n);
}
