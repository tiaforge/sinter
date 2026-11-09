// Runtime checks for the DOM sinks that cannot be closed at build time.

export { BAD_KEY, $k } from './keys.js';

/** Attributes whose value is a URL (and `…srcset`): the ones `urlAllowed` checks; the compiler skips the check for the rest. */
export const URL_ATTR = /^(href|src|action|formaction|poster|cite|data|ping|xlink:href)$/;

/** Allowed schemes: http(s), mailto, tel and configured extras; javascript:, vbscript: and data: never. */
export const schemesOf = (extra: string[]) => new Set(['http:', 'https:', 'mailto:', 'tel:', ...extra
  .map((s) => s.toLowerCase().replace(/:?$/, ':'))
  .filter((s) => !/^(javascript|vbscript|data):$/.test(s))]);

/** Whether `value` may be written to attribute `name` of `el`; parsed by the browser's own URL parser. */
export function urlAllowed(el: Element, name: string, value: string, base: string, schemes: Set<string>): boolean {
  const ok = (v: string, attr: string) => {
    try {
      const p = new URL(v, base).protocol;
      return schemes.has(p) || (/^(data|blob):$/.test(p) && attr == 'src' && /^(img|video|audio|source)$/.test(el.localName));
    } catch { return false; }
  };
  name = name.toLowerCase();
  if (name.endsWith('srcset')) return value.split(',').every((c) => ok(c.trim().split(/\s+/)[0]!, 'src'));
  return !URL_ATTR.test(name) || ok(value, name);
}

/** Style values that could load URLs. */
export const STYLE_BAD = /url\(|image(-set)?\(|\\/i;

