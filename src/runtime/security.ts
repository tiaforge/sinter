// Runtime checks for the DOM sinks that cannot be closed at build time.

export { BAD_KEY, $k } from './keys.js';

/** Attributes whose value is a URL (and `…srcset`): the ones `urlAllowed` checks; the compiler skips the check for the rest. */
export const URL_ATTR = /^(href|src|action|formaction|poster|cite|data|ping|xlink:href)$/;

/** Allowed schemes: http(s), mailto, tel and configured extras; javascript:, vbscript: and data: never. */
export const schemesOf = (extra: string[]) => new Set(['http:', 'https:', 'mailto:', 'tel:', ...extra
  .map((s) => s.toLowerCase().replace(/:?$/, ':'))
  .filter((s) => !/^(javascript|vbscript|data):$/.test(s))]);

/**
 * The scheme a URL parser gives `value` (with `:`), or null for a relative URL (the base's): the URL
 * standard's steps up to the scheme, without parsing the rest. Leading C0 controls and spaces are
 * stripped and tabs and newlines removed everywhere, then a scheme is a letter followed by letters,
 * digits, `+`, `-` or `.`, ended by `:`; anything else is relative. Checked against the browser's
 * parser on 200,000 generated strings (security.test.ts runs Node's); about 15 times cheaper than
 * `new URL()`, which made writing a link cost more than creating its element.
 */
export const schemeOf = (value: string): string | null => {
  const m = /^[\0- ]*([a-z][a-z\d+.-]*):/i.exec(value.replace(/[\t\n\r]/g, ''));
  return m ? m[1]!.toLowerCase() + ':' : null;
};

/**
 * Whether `value` may be written to attribute `name` of `el`: its scheme is allowed, a relative URL
 * judged by the scheme of `base`: the base URL of the document it is written into (`<base href>` can
 * make it `ftp:` or `webcal:`, and then a relative link has that scheme). Not the element's own
 * `baseURI`: a row is written while it is a clone in its template's inert document (`about:blank`). Only the scheme is checked: a URL the
 * browser cannot parse further is an invalid link, as in static HTML.
 */
export function urlAllowed(el: Element, name: string, value: string, base: string, schemes: Set<string>): boolean {
  const ok = (v: string, attr: string) => {
    const p = schemeOf(v) ?? schemeOf(base);
    return !!p && (schemes.has(p) || (/^(data|blob):$/.test(p) && attr == 'src' && /^(img|video|audio|source)$/.test(el.localName)));
  };
  name = name.toLowerCase();
  if (name.endsWith('srcset')) return value.split(',').every((c) => ok(c.trim().split(/\s+/)[0]!, 'src'));
  return !URL_ATTR.test(name) || ok(value, name);
}

/** Style values that could load URLs. */
export const STYLE_BAD = /url\(|image(-set)?\(|\\/i;

