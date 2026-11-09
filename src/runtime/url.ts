// URL templates and `$url`: shared by the runtime and the early file, so a request the early file
// starts has exactly the URL the runtime computes for the same resource.
import { BAD_KEY, encodeSegment } from './security.js';
import type { UrlTemplate } from '../ir.js';

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
    else if (v != null) {
      // URL parsers turn %2E%2E back into `..`, so a path value cannot be a dot segment at all
      if (!query && (v == '.' || v == '..' || Array.isArray(v))) throw Error(`refused ${Array.isArray(v) ? 'an array' : `\`${v}\``} as a URL path value`);
      v = encodeSegment(v);
    }
    if (key && v == null) {
      out = out.replace(/[^?&=#]*=$/, '');
      dropped = true;
      return;
    }
    out += v ?? '';
  });
  return out.replace(/[?&](?=#|$)/, '');
}

/** A URL with query parameters set (a paginated resource's page): the runtime's request and the early file's are the same string. */
export function withParams(url: string, params: Record<string, string> | null): string {
  if (!params) return url;
  const [path, hash] = url.split('#'), i = path!.indexOf('?'), base = i < 0 ? path! : path!.slice(0, i), q = new URLSearchParams(i < 0 ? '' : path!.slice(i + 1));
  for (const k in params) q.set(k, params[k]!);
  return `${base}?${q}${hash ? '#' + hash : ''}`;
}

/** `$url`: the query parameters, and the `:name` segments of the first path pattern that matches. */
export function readUrl(href: string, patterns: string[] = []): Record<string, string> {
  const out = Object.create(null), u = new URL(href);
  for (const [k, v] of u.searchParams) if (!BAD_KEY.test(k)) out[k] = v;
  const segs = u.pathname.split('/').filter(Boolean);
  for (const p of patterns) {
    const want = p.split('/').filter(Boolean);
    if (want.length != segs.length || want.some((w, i) => w[0] != ':' && w != segs[i])) continue;
    want.forEach((w, i) => {
      if (w[0] != ':') return;
      try { out[w.slice(1)] = decodeURIComponent(segs[i]!); } catch { out[w.slice(1)] = segs[i]; }
    });
    break;
  }
  return out;
}
