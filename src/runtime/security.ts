// Runtime checks for the DOM sinks that cannot be closed at build time.

const FORBIDDEN = new Set(['constructor', '__proto__', 'prototype']);

/** Guard for computed member access in expressions: `obj[k]` compiles to `obj[$k(k)]`. */
export function $k<K>(key: K): K {
  if (typeof key === 'string' && FORBIDDEN.has(key)) throw new TypeError(`sinter: access to [${JSON.stringify(key)}] is not allowed`);
  return key;
}

export const URL_ATTRS = new Set(['href', 'src', 'action', 'formaction', 'poster', 'cite', 'data', 'ping', 'xlink:href']);
const MEDIA = new Set(['img', 'video', 'audio', 'source']);
const BASE_SCHEMES = ['http:', 'https:', 'mailto:', 'tel:'];
const NEVER = new Set(['javascript:', 'vbscript:', 'data:']);

export function allowedSchemes(extra: string[]): Set<string> {
  const s = new Set(BASE_SCHEMES);
  for (const x of extra) {
    const v = x.toLowerCase().replace(/:?$/, ':');
    if (!NEVER.has(v)) s.add(v);
  }
  return s;
}

/** Whether a URL value may be written to `attr` of an element with `tag`. */
export function urlAllowed(value: string, attr: string, tag: string, base: string, schemes: Set<string>): boolean {
  let url: URL;
  try { url = new URL(value, base); } catch { return false; }
  const proto = url.protocol.toLowerCase();
  if (schemes.has(proto)) return true;
  if ((proto === 'data:' || proto === 'blob:') && attr === 'src' && MEDIA.has(tag.toLowerCase())) return true;
  return false;
}

export function srcsetAllowed(value: string, tag: string, base: string, schemes: Set<string>): boolean {
  // each candidate is "url [descriptor]", separated by commas
  for (const part of value.split(',')) {
    const u = part.trim().split(/\s+/)[0];
    if (u && !urlAllowed(u, 'src', tag, base, schemes)) return false;
  }
  return true;
}

export function styleValueAllowed(value: string): boolean {
  const v = value.toLowerCase();
  return !(v.includes('url(') || v.includes('image(') || v.includes('image-set(') || v.includes('\\'));
}

/** Encodes one interpolated URL value; `.` and `..` cannot climb path segments. */
export function encodeSegment(v: unknown): string {
  const s = String(v ?? '');
  if (s === '.') return '%2E';
  if (s === '..') return '%2E%2E';
  return encodeURIComponent(s);
}
