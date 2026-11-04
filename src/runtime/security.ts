// Runtime checks for the DOM sinks that cannot be closed at build time.

/** Keys that could reach prototypes; dropped from input and refused in computed access. */
export const BAD_KEY = /^(constructor|__proto__|prototype)$/;

/** Guard for computed member access in expressions: `obj[k]` compiles to `obj[$k(k)]`. */
export const $k = <K>(key: K): K => {
  if (BAD_KEY.test(key as string)) throw TypeError(`sinter: [${String(key)}] is not allowed`);
  return key;
};

const URL_ATTR = /^(href|src|action|formaction|poster|cite|data|ping|xlink:href)$/;

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

/** Encodes one interpolated URL value. */
export const encodeSegment = (v: unknown): string => encodeURIComponent(String(v ?? '')).replace(/^\.\.?$/, (d) => d.replace(/\./g, '%2E'));
