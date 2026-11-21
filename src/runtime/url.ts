// URL templates and `$url`: shared by the runtime and the early file, so a request the early file
// starts has exactly the URL the runtime computes for the same resource.
import { BAD_KEY } from './keys.js';
import type { UrlTemplate } from '../ir.js';

/** Encodes one interpolated URL value. */
export const encodeSegment = (v: unknown): string => encodeURIComponent(String(v ?? '')).replace(/^\.\.?$/, (d) => d.replace(/\./g, '%2E'));

/**
 * One value of a URL template that is not a whole query value, encoded; in the path (`q` false) a dot segment or a
 * list is refused: URL parsers turn %2E%2E back into `..`, so a path value cannot be a dot segment at all. A link's
 * template whose values are all of this kind compiles to `"/profile/" + $hv(a.author.username)`.
 */
export const $hv = (v: unknown, q?: boolean | 1): string => {
  if (!q && (v == '.' || v == '..' || Array.isArray(v))) throw Error(`refused ${Array.isArray(v) ? 'an array' : `\`${v}\``} as a URL path value`);
  return encodeSegment(v);
};

/**
 * A URL template's query whose values include whole query values (`?tag={t}&limit=10`), as the compiler writes it
 * (compiler/compile.ts `urlCode`): each part either a parameter already written (`"limit=10"`, `"q=" + $hv(v, 1)`)
 * or `[key, value]`, a whole value: an array repeats the key (its null items left out), null, undefined or an empty
 * array leaves the parameter out. The same string `expand` makes of that query.
 */
export const $hq = (parts: Array<string | [string, unknown]>): string => {
  const o: string[] = [];
  for (const p of parts) {
    if (typeof p == 'string') o.push(p);
    else for (const x of Array.isArray(p[1]) ? p[1] : [p[1]]) if (x != null) o.push(p[0] + '=' + encodeSegment(x));
  }
  return o.length ? '?' + o.join('&') : '';
};

/** Fills a URL template: each value encoded, an array query value a repeated key, null leaves the parameter out. */
export function expand(tpl: UrlTemplate, s: any, fns: Array<(s: any) => any>): string {
  let out = '', query = false, dropped = false;
  tpl.forEach((p, i) => {
    if (typeof p == 'string') {
      // after a dropped parameter, its `&` separator goes too
      out += dropped && p[0] == '&' && /[?&]$/.test(out) ? p.slice(1) : p;
      dropped = false;
      query ||= /[?#]/.test(p);
      return;
    }
    let v = fns[p]!(s);
    const next = tpl[i + 1], key = query && (next == null || /^[&#]/.test(next as string)) && /[?&]([^?&=#]*)=$/.exec(out);
    // a whole query value: an array is a repeated key (its null items left out), and null,
    // undefined or an empty array leaves the parameter out
    if (key && Array.isArray(v)) v = (v = v.filter((x) => x != null)).length ? v.map(encodeSegment).join(`&${key[1]}=`) : null;
    else if (v != null) v = $hv(v, query);
    if (key && v == null) {
      out = out.replace(/[^?&=#]*=$/, '');
      dropped = true;
      return;
    }
    out += v ?? '';
  });
  return out.replace(/[?&](?=#|$)/, '');
}

const at = (i: number) => (v: unknown[]) => v[i];
/**
 * A link's URL template (`data-sn-href`), filled as an action's: `tpl`'s numbers index `vals`, the values its
 * interpolations had. The compiled binding of one with a whole query value calls it (`$href(["?tag=", 0], [t])`).
 */
export const $href = (tpl: UrlTemplate, vals: unknown[]): string => expand(tpl, vals, vals.map((_, i) => at(i)));

/** A URL with query parameters set (a paginated resource's page): the runtime's request and the early file's are the same string. */
export function withParams(url: string, params: Record<string, string> | null): string {
  if (!params) return url;
  const [path, hash] = url.split('#'), i = path!.indexOf('?'), base = i < 0 ? path! : path!.slice(0, i), q = new URLSearchParams(i < 0 ? '' : path!.slice(i + 1));
  for (const k in params) q.set(k, params[k]!);
  return `${base}?${q}${hash ? '#' + hash : ''}`;
}

/** A path's non-empty segments: `/a//b/` is `a`, `b`, as a page's `data-sn-path` patterns match it everywhere. */
export const segments = (path: string) => path.split('/').filter(Boolean);
/** Whether a pattern's segments (`/article/:slug`) match a path's: as many, the literal ones equal (`:name` is any one segment). */
export const segsMatch = (want: string[], segs: string[]) => want.length == segs.length && want.every((w, i) => w[0] == ':' || w == segs[i]);

/** `$url`: the query parameters (the last of a repeated name), and the `:name` segments of the first path pattern that matches. */
export function readUrl(href: string, patterns: string[] = []): Record<string, string | string[]> {
  const out = Object.create(null), u = new URL(href);
  for (const [k, v] of u.searchParams) if (!BAD_KEY.test(k)) out[k] = v;
  const segs = segments(u.pathname);
  for (const p of patterns) {
    const want = segments(p);
    if (!segsMatch(want, segs)) continue;
    want.forEach((w, i) => {
      if (w[0] != ':') return;
      try { out[w.slice(1)] = decodeURIComponent(segs[i]!); } catch { out[w.slice(1)] = segs[i]; }
    });
    break;
  }
  return out;
}
