// A server layer for a build made with `sinter({ embed: true })`, on web-standard Request and Response:
// it answers the build's pages with their API data written into each placeholder (the head streamed
// first), and follows the build's URL rules. It runs wherever a fetch handler does: Node (Hono, srvx,
// @hono/node-server), Bun.serve, Deno.serve, Cloudflare Workers, Vercel and Netlify functions.
//
// The same layer as packages/sinter-axum and packages/sinter-aspnetcore, option for option; the URLs come
// from the browser runtime's own code (runtime/url.ts), so the request the server makes for a placeholder
// is the one the page would have made.
import { expand, readUrl, withParams } from './runtime/url.js';

/** A fetch handler: an app (Hono's `app.fetch`, a framework's handler) or the next one in a chain. Extra arguments (a Worker's `env` and `ctx`) are passed on. */
export type Handler = (request: Request, ...rest: any[]) => Response | Promise<Response>;

/** What a resolver receives: the placeholder's resource, the request the build describes for it (if any), the page's `$url` and the page request. */
export interface SlotRequest {
  /** the page's file in the build (`index.html`) */
  page: string;
  /** the resource's name */
  resource: string;
  /**
   * the request the build describes, filled from `$url`: the resource's `src`, a paginated one at its first
   * page (or the page `start-page` names); null when the build could not describe it, or its `when` does
   * not hold for this URL
   */
  url: string | null;
  /** the page URL's parameters: the query, then the path's `:name` segments */
  params: Record<string, string>;
  /** the page request (its headers include cookies: the data can be the user's) */
  request: Request;
  /** aborted when the page's time limit passes or the visitor goes away */
  signal: AbortSignal;
}

/**
 * Your code for a resource's data. It returns the data: a value (serialized as JSON), a JSON text
 * (`string`), its bytes (`Uint8Array`, `ArrayBuffer`), or a `Response` (a 2xx JSON one, as from `fetch`
 * or your API's handler). `null` or `undefined` leaves the resource to the browser.
 */
export type Resolver = (request: SlotRequest) => unknown;

/** A placeholder's entry in `data`: a resolver, or `'skip'` (the browser requests it). */
export type Entry = Resolver | 'skip';

/**
 * A build's placeholders as types, from the `sinter-embed.d.ts` the build writes next to `sinter-embed.json`:
 * per page, each placeholder's resource and whether the build describes its request.
 */
export interface BuildTypes { pages: Record<string, Record<string, boolean>> }

type Pages<B extends BuildTypes> = B['pages'];
type PageOf<B extends BuildTypes> = keyof Pages<B> & string;
/** every name `data` may use: a resource (every page's), or `page.html:resource` (one page's) */
type Names<B extends BuildTypes> = { [P in PageOf<B>]: (keyof Pages<B>[P] & string) | `${P}:${keyof Pages<B>[P] & string}` }[PageOf<B>];
/** per placeholder the build cannot describe: an entry under its name or its page's, boxed so the alternatives stay a union */
type Needs<B extends BuildTypes> = {
  [P in PageOf<B>]: { [R in keyof Pages<B>[P] & string]: Pages<B>[P][R] extends false ? { need: { [K in R]: Entry } | { [K in `${P}:${R}`]: Entry } } : never }[keyof Pages<B>[P] & string];
}[PageOf<B>];
type AllOf<U> = (U extends unknown ? (x: U) => void : never) extends (x: infer I) => void ? I : never;
type Required_<B extends BuildTypes> = [Needs<B>] extends [never] ? unknown : AllOf<Needs<B>> extends { need: infer N } ? N : unknown;

/**
 * `data`: an entry per resource the server fills itself or leaves to the browser. With the build's types
 * (`embed<Build>`), a name no placeholder has is a type error, and so is a placeholder whose request the
 * build cannot describe without an entry.
 */
export type Data<B extends BuildTypes = BuildTypes> = string extends PageOf<B> ? Record<string, Entry> : { [K in Names<B>]?: Entry } & Required_<B>;

/**
 * The layer's options. With the build's types (`embed<Build>`), `data` is required when the build has a
 * placeholder whose request it cannot describe.
 */
export type EmbedOptions<B extends BuildTypes = BuildTypes> = Options<B> & ([Needs<B>] extends [never] ? { data?: Data<B> } : { data: Data<B> });

interface Options<B extends BuildTypes> {
  /** the build's output directory (`sinter-embed.json` and the pages), read with `node:fs` (Node, Bun, Deno) unless `read` is given */
  dir?: string | URL;
  /** the build's `sinter-embed.json`, parsed or as text, instead of reading it from `dir` (a Worker imports it) */
  manifest?: unknown;
  /** reads a page of the build, by its file (`index.html`): instead of `node:fs`, for runtimes without it */
  read?: (file: string) => string | Uint8Array | Promise<string | Uint8Array>;
  /**
   * the app's own API, for same-origin paths, called in-process (no socket); default: the handler given to
   * `wrap`, or the `next` given to `fetch`
   */
  api?: Handler;
  /** an API on another server, for same-origin paths (`http://127.0.0.1:4000`): where the page's own origin proxies `/api` to; used before `api` */
  upstream?: string;
  /** origins whose absolute URLs are fetched (`https://api.example.com`), without the page's headers: sinter's own requests to another origin carry no cookies either */
  origins?: string[];
  /** per resource: your function for its data, or `'skip'`. `articles` applies to every page, `profile.html:articles` to one */
  data?: unknown;
  /** the page request's headers passed on to `api` and `upstream` (default `cookie`, `authorization`, `accept-language`) */
  forward?: string[];
  /** how long a page waits for its data, all placeholders together, in ms (default 500) */
  timeout?: number;
  /** the largest response put into a page (default 2 MiB) */
  maxBytes?: number;
  /**
   * whether the page is streamed (default): the head up to the first placeholder goes out at once, so the
   * browser loads stylesheets and scripts while the data is fetched. Without it, the page is sent in one
   * piece once the data is in, and a failure is its status (502, 504 on the time limit)
   */
  stream?: boolean;
  /** the pages' `Cache-Control` (default `private, no-cache`: the data may be the user's) */
  cacheControl?: string;
  /** the text sent instead of the rest of a page whose data could not be fetched */
  errorText?: string;
  /** where the browser goes when a page's data could not be fetched (`/error.html`): a page you serve with the error's status */
  errorRedirect?: string;
  /** the fetch for `upstream` and `origins` (default: the global one) */
  fetch?: typeof fetch;
  /** a placeholder's data could not be fetched; default: a `console.warn` */
  onError?: (failure: { page: string; resource: string; url: string | null; reason: string }) => void;
}

/** The layer: answers a request, or wraps a whole app. */
export interface Embed {
  /** Answers a page (with its data), a redirect or the manifest's 404; passes anything else to `next` (the static files, the app). */
  fetch(request: Request, next: Handler, ...rest: any[]): Promise<Response>;
  /** The app with the layer in front: `export default { fetch: sinter.wrap(app.fetch) }`. The app is also the in-process API, unless `api` is set. */
  wrap<H extends Handler>(handler: H): (request: Request, ...rest: any[]) => Promise<Response>;
}

// the manifest

type Part = string | { url: string };
type Cond = { url: string; eq?: string; ne?: string } | { not: Cond } | { and: Cond[] } | { or: Cond[] };
interface Slot { id: number; resource: string; src: Part[] | null; when?: true | Cond; query?: Array<[string, string]>; start?: { url: string; key: string; size: number; skip?: true; query: Array<[string, string]> } }
interface Route { from: string; to: string; status: number; file?: string; choose?: true }
interface Manifest { version: number; pages: Array<{ file: string; paths: string[]; data: Slot[] }>; routes?: Route[]; locales?: { base: string; list: string[]; at?: string } }
interface Page { file: string; paths: string[]; parts: Uint8Array[]; slots: Slot[] }

const FILE = 'sinter-embed.json';
const enc = new TextEncoder();

/** As JavaScript evaluates a `when` over `$url`: an absent value is `undefined`, an empty string is falsy. */
const holds = (c: Cond, p: Record<string, string>): boolean =>
  'not' in c ? !holds(c.not, p)
    : 'and' in c ? c.and.every((x) => holds(x, p))
    : 'or' in c ? c.or.some((x) => holds(x, p))
    : c.eq != null ? p[c.url] === c.eq
    : c.ne != null ? p[c.url] !== c.ne
    : !!p[c.url];

/** `start-page` as the runtime's `toPage`: the whole number `parseInt` reads, else (or below 1) page 1. */
const toPage = (v: string | undefined) => {
  const n = parseInt(v ?? '', 10);
  return Number.isFinite(n) && n >= 1 ? n : 1;
};

/** The request the build describes for a placeholder at this URL, if any and if its `when` holds. */
export function describedUrl(s: Slot, p: Record<string, string>): string | null {
  if (s.src == null) return null;
  // a `when` only the browser evaluates is the resolver's to decide (the startup check requires one)
  if (s.when && s.when !== true && !holds(s.when, p)) return null;
  // the runtime's template: literals, and indexes of functions that read `$url`
  const fns: Array<(x: Record<string, string>) => string | undefined> = [];
  const tpl = s.src.map((x) => (typeof x == 'string' ? x : (fns.push((v) => v[x.url]), fns.length - 1)));
  let url: string;
  try { url = expand(tpl, p, fns); } catch { return null; } // a path value of `.` or `..`, refused as in the browser
  let query = s.query;
  if (s.start) {
    const n = toPage(p[s.start.url]);
    if (n > 1) query = s.start.query.map(([k, v]) => [k, k == s.start!.key ? String(s.start!.skip ? (n - 1) * s.start!.size : n) : v]);
  }
  return query?.length ? withParams(url, Object.fromEntries(query)) : url;
}

/** Whether a `data-sn-path` pattern (`/article/:slug`) matches the path: as many segments, and the literal ones equal. */
const matches = (pattern: string, path: string) => {
  const w = pattern.split('/').filter(Boolean), s = path.split('/').filter(Boolean);
  return w.length == s.length && w.every((x, i) => x[0] == ':' || x == s[i]);
};

/** Cuts the page at each placeholder, in document order; one that is missing or not empty means the HTML and the manifest are from different builds. */
function split(file: string, html: string, slots: Slot[]): Pick<Page, 'parts' | 'slots'> {
  const at = slots.map((s) => {
    const open = `<script type="application/json" data-sn="${s.id}">`, i = html.indexOf(open);
    if (i < 0) throw Error(`sinter: ${file}: no placeholder for \`${s.resource}\` (data-sn="${s.id}"): the page and sinter-embed.json are from different builds`);
    const j = i + open.length;
    if (!html.startsWith('</script>', j)) throw Error(`sinter: ${file}: the placeholder for \`${s.resource}\` is not empty`);
    return { i, j, s };
  }).sort((a, b) => a.i - b.i);
  const parts: Uint8Array[] = [];
  let from = 0;
  for (const { j } of at) { parts.push(enc.encode(html.slice(from, j))); from = j; }
  parts.push(enc.encode(html.slice(from)));
  return { parts, slots: at.map((x) => x.s) };
}

/** Every `<` as a JSON unicode escape, so the data cannot close its `<script>` (or open a comment): the same JSON, since in valid JSON `<` is only ever inside a string. */
export function escape(json: Uint8Array): Uint8Array {
  let n = 0;
  for (let i = 0; i < json.length; i++) if (json[i] === 0x3c) n++;
  if (!n) return json;
  const out = new Uint8Array(json.length + n * 5), lt = enc.encode('\\u003c');
  for (let i = 0, o = 0; i < json.length; i++) {
    if (json[i] === 0x3c) { out.set(lt, o); o += 6; } else out[o++] = json[i]!;
  }
  return out;
}

const html = (v: string) => v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** The end of a page whose data failed, from inside its head: a redirect to the error page if there is one, then a body with the text. */
function errorTail(text: string, redirect?: string) {
  const go = redirect == null ? '' : `<meta http-equiv="refresh" content="0;url=${html(redirect)}"><script>location.replace(${JSON.stringify(redirect).replace(/</g, '\\u003c')})</script>`;
  return `${go}</head><body data-sn-failed><p>${html(text)}</p></body></html>`;
}

const isJson = (type: string | null) => {
  const t = (type ?? '').split(';')[0]!.trim().toLowerCase();
  return t == 'application/json' || t.endsWith('+json');
};

/** The visitor's language among the site's: the `locale` cookie the pages record, else the first of `Accept-Language` the site has (`de-AT` is `de`), else the base. */
function choose(l: { base: string; list: string[] }, h: Headers) {
  const find = (x: string) => {
    x = x.trim().toLowerCase();
    return l.list.find((c) => c.toLowerCase() == x) ?? l.list.find((c) => c.toLowerCase() == x.split('-')[0]);
  };
  for (const c of (h.get('cookie') ?? '').split(';')) {
    const t = c.trim();
    if (t.startsWith('locale=')) { const v = find(t.slice(7)); if (v) return v; }
  }
  for (const p of (h.get('accept-language') ?? '').split(',')) { const v = find(p.split(';')[0]!); if (v) return v; }
  return l.base;
}

// a placeholder's fill: its JSON, null (the browser requests it) or the failure's status
type Fill = Uint8Array | null | number;

// why a page's requests were aborted: made once, as an abort without a reason makes a DOMException each time
const LATE = new Error('sinter: the page\'s time limit passed'), LEFT = new Error('sinter: the visitor went away'), ENDED = new Error('sinter: the page ended');

/**
 * The layer for a build: reads its manifest and pages, and checks that every placeholder has a source (an
 * entry in `data`, or a request the build describes that this configuration can make); every problem is in
 * the error, one line each.
 */
export async function embed<B extends BuildTypes = BuildTypes>(options: EmbedOptions<B>): Promise<Embed> {
  const o = options;
  const dir = o.dir instanceof URL ? o.dir : o.dir != null ? o.dir.replace(/\/?$/, '/') : undefined;
  const fs = o.read ? null : await import('node:fs/promises');
  const read = o.read ?? ((file: string) => {
    if (dir == null) throw Error('sinter: embed() needs `dir`, or `manifest` and `read`');
    return fs!.readFile(dir instanceof URL ? new URL(file, dir) : dir + file, 'utf8');
  });
  const text = (v: string | Uint8Array) => (typeof v == 'string' ? v : new TextDecoder().decode(v));
  let m: Manifest;
  try {
    const raw = o.manifest ?? text(await read(FILE));
    m = typeof raw == 'string' ? JSON.parse(raw) : (raw as Manifest);
  } catch (e) {
    throw Error(`sinter: ${dir ?? ''}${FILE}: ${(e as Error).message} (built with sinter's Vite plugin, with \`embed: true\` or a \`data-sn-data\` placeholder?)`);
  }
  if (m?.version !== 1) throw Error(`sinter: ${FILE}: version ${m?.version} (this layer reads version 1)`);

  const data = (o.data ?? {}) as Record<string, Entry>;
  const origins = (o.origins ?? []).map((x) => x.replace(/\/+$/, ''));
  const upstream = o.upstream?.replace(/\/+$/, '');
  const allowed = (url: string) => origins.some((x) => url.startsWith(x) && /^([/?]|$)/.test(url.slice(x.length)));
  const sameOrigin = (url: string) => url[0] == '/' && url[1] != '/';

  // every placeholder has a source; every name is a placeholder's
  const problems: string[] = [];
  const names = new Set(m.pages.flatMap((p) => p.data.flatMap((s) => [s.resource, `${p.file}:${s.resource}`])));
  for (const n of Object.keys(data)) if (!names.has(n)) problems.push(`\`${n}\`: no page of the build has a placeholder for it`);
  for (const p of m.pages) for (const s of p.data) {
    if (data[`${p.file}:${s.resource}`] ?? data[s.resource]) continue;
    const first = typeof s.src?.[0] == 'string' ? s.src[0] : '';
    const why = s.src == null ? 'the build could not describe its request (its `src` or `start-page` calls a helper, or reads something other than `$url`)'
      : s.when === true ? 'its `when` is a condition only the browser can evaluate'
      : sameOrigin(first) || allowed(first) ? null
      : `\`${first}…\` is on an origin not allowed with \`origins\``;
    if (why) problems.push(`${p.file}: \`${s.resource}\`: ${why}; add \`${s.resource}: (req) => …\` or \`${s.resource}: 'skip'\` to \`data\``);
  }
  if (problems.length) throw Error(`sinter: ${problems.length} placeholder(s) have no source:\n  ${problems.join('\n  ')}`);

  const pages: Page[] = await Promise.all(m.pages.map(async (p) => ({ file: p.file, paths: p.paths, ...split(p.file, text(await read(p.file)), p.data) })));
  const routes = m.routes ?? [];
  const locales = m.locales && { ...m.locales, at: m.locales.at ?? '/' };
  const forward = (o.forward ?? ['cookie', 'authorization', 'accept-language']).map((h) => h.toLowerCase());
  const timeout = o.timeout ?? 500, maxBytes = o.maxBytes ?? 2 << 20, stream = o.stream ?? true;
  const cacheControl = o.cacheControl ?? 'private, no-cache';
  const tail = errorTail(o.errorText ?? 'Error, please retry later.', o.errorRedirect);
  const streamTail = enc.encode('</script>' + tail), errorDoc = enc.encode('<!DOCTYPE html><html><head><meta charset="utf-8">' + tail);
  const fetchFn = o.fetch ?? fetch;
  const onError = o.onError ?? ((f) => console.warn(`sinter: ${f.page}: \`${f.resource}\`: ${f.url ?? ''} ${f.reason}; the page ends with the error text`));

  // paths to pages and rules: literal paths by their segments, `:name` patterns in order
  const key = (path: string) => '/' + path.split('/').filter(Boolean).join('/');
  const pageLit = new Map<string, number>(), pagePat: Array<[number, string]> = [];
  pages.forEach((p, i) => p.paths.forEach((x) => (x.includes(':') ? pagePat.push([i, x]) : pageLit.has(key(x)) || pageLit.set(key(x), i))));
  const pageOf = (path: string) => {
    let best = pageLit.get(key(path)) ?? Infinity;
    for (const [i, x] of pagePat) { if (i >= best) break; if (matches(x, path)) { best = i; break; } }
    return best == Infinity ? null : pages[best]!;
  };
  // a redirect for exactly its `from`, a rewrite for a path its pattern matches; the first in order
  const routeOf = (path: string) => routes.find((r) => (r.status == 200 ? matches(r.from, path) : r.from == path));

  /** a response's body, if it is a 2xx JSON one within maxBytes; else why not */
  async function body(res: Response): Promise<Uint8Array | string> {
    if (!res.ok) { await res.body?.cancel(); return `status ${res.status}`; }
    if (!isJson(res.headers.get('content-type'))) { await res.body?.cancel(); return 'not JSON'; }
    if (Number(res.headers.get('content-length') ?? 0) > maxBytes) { await res.body?.cancel(); return `over ${maxBytes} bytes`; }
    if (!res.body) return new Uint8Array();
    const chunks: Uint8Array[] = [];
    let n = 0;
    for (const reader = res.body.getReader(); ;) {
      const { done, value } = await reader.read();
      if (done) break;
      n += value.length;
      if (n > maxBytes) { await reader.cancel(); return `over ${maxBytes} bytes`; }
      chunks.push(value);
    }
    if (chunks.length == 1) return chunks[0]!;
    const out = new Uint8Array(n);
    let at = 0;
    for (const c of chunks) { out.set(c, at); at += c.length; }
    return out;
  }

  /** a resolver's value as JSON bytes, null for none */
  async function value(v: unknown): Promise<Uint8Array | string | null> {
    if (v == null) return null;
    if (v instanceof Response) return body(v);
    if (typeof v == 'string') return enc.encode(v);
    if (v instanceof Uint8Array) return v;
    if (v instanceof ArrayBuffer) return new Uint8Array(v);
    return enc.encode(JSON.stringify(v));
  }

  function forwarded(from: Headers) {
    const h = new Headers({ accept: 'application/json' });
    for (const n of forward) { const v = from.get(n); if (v != null) h.set(n, v); }
    return h;
  }

  /** the data for one placeholder; never rejects */
  async function fill(req: SlotRequest, api: Handler, rest: any[]): Promise<Fill> {
    const entry = data[`${req.page}:${req.resource}`] ?? data[req.resource];
    let got: Uint8Array | string | null;
    try {
      if (entry === 'skip') return null;
      if (entry) got = await value(await entry(req));
      else if (req.url == null) return null; // no request at this URL (its `when` does not hold)
      else if (sameOrigin(req.url)) {
        const init = { headers: forwarded(req.request.headers), signal: req.signal };
        got = await body(upstream != null ? await fetchFn(upstream + req.url, init) : await api(new Request(new URL(req.url, req.request.url), init), ...rest));
      } else if (allowed(req.url)) got = await body(await fetchFn(req.url, { headers: { accept: 'application/json' }, signal: req.signal }));
      else return null;
    } catch (e) {
      if (req.signal.aborted) return 504;
      got = `threw ${(e as Error)?.message ?? e}`;
    }
    if (got == null || got instanceof Uint8Array) return got && escape(got);
    onError({ page: req.page, resource: req.resource, url: req.url, reason: got });
    return 502;
  }

  const pageHeaders = { 'content-type': 'text/html; charset=utf-8', 'cache-control': cacheControl };

  /** a page with its data: every placeholder fetched in parallel, the page streamed or sent whole */
  function render(request: Request, page: Page, api: Handler, rest: any[]): Response | Promise<Response> {
    if (request.method == 'HEAD') return new Response(null, { status: 200, headers: pageHeaders });
    const params = readUrl(request.url, page.paths);
    // one signal for the page's requests: aborted at the time limit, when the visitor goes away, or when the
    // page ended early. A listener rather than AbortSignal.any, and an abort only while something is still
    // pending, with a reason made once: on most pages nothing is aborted, and that costs nothing
    const stop = new AbortController(), signal = stop.signal, visitor = request.signal;
    const left = () => stop.abort(LEFT);
    if (visitor.aborted) stop.abort(LEFT);
    else visitor.addEventListener('abort', left, { once: true });
    let pending = page.slots.length;
    // the time limit, for every placeholder together: a resolver that ignores its signal does not hold the page
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<Fill>((ok) => { timer = setTimeout(() => { stop.abort(LATE); ok(504); }, timeout); });
    const fills = page.slots.map((s) =>
      Promise.race([fill({ page: page.file, resource: s.resource, url: describedUrl(s, params), params, request, signal }, api, rest).then((f) => (pending--, f)), late]));
    // the page is out (or ended early): stop whatever is still fetching
    const done = () => {
      clearTimeout(timer);
      visitor.removeEventListener('abort', left);
      if (pending > 0) stop.abort(ENDED);
    };
    if (!stream) return whole(page, fills, done);
    // the head up to the first placeholder at once; the rest as the data comes in, in order. A failed
    // placeholder ends the page there: still in the head, inside that placeholder's `<script>`
    let i = -1;
    const body = new ReadableStream<Uint8Array>({
      async pull(c) {
        if (i < 0) { i = 0; c.enqueue(page.parts[0]!); return; }
        if (i >= fills.length) { done(); c.close(); return; }
        const f = await fills[i]!;
        if (typeof f == 'number') { done(); c.enqueue(streamTail); c.close(); return; }
        if (f) c.enqueue(f);
        c.enqueue(page.parts[++i]!);
      },
      cancel: done,
    });
    return new Response(body, { status: 200, headers: pageHeaders });
  }

  /** an unstreamed page: its status is known once the data is in */
  async function whole(page: Page, fills: Array<Promise<Fill>>, done: () => void): Promise<Response> {
    const all = await Promise.all(fills);
    done();
    const failed = all.find((f): f is number => typeof f == 'number');
    if (failed != null) return new Response(errorDoc, { status: failed, headers: pageHeaders });
    let n = 0;
    for (const p of page.parts) n += p.length;
    for (const f of all) if (f instanceof Uint8Array) n += f.length;
    const out = new Uint8Array(n);
    let at = 0;
    page.parts.forEach((p, k) => {
      const f = k > 0 ? all[k - 1] : null;
      if (f instanceof Uint8Array) { out.set(f, at); at += f.length; }
      out.set(p, at);
      at += p.length;
    });
    return new Response(out, { status: 200, headers: { ...pageHeaders, 'content-length': String(n) } });
  }

  async function handle(request: Request, next: Handler, api: Handler, rest: any[]): Promise<Response> {
    if (request.method != 'GET' && request.method != 'HEAD') return next(request, ...rest);
    const url = new URL(request.url), path = url.pathname;
    // the manifest and its types describe the app's requests; they are not pages
    if (path == '/' + FILE || path == '/sinter-embed.d.ts') return new Response(null, { status: 404 });
    const route = routeOf(path);
    // an unprefixed URL of a site with languages: to the visitor's, temporary, as it differs per visitor
    if (locales && route?.choose) {
      const p = /[:*]/.test(route.from) ? path : route.to;
      const rest_ = p.startsWith(locales.at) ? p.slice(locales.at.length) : p.replace(/^\/+/, '');
      return new Response(null, { status: 302, headers: { location: `${locales.at}${choose(locales, request.headers)}/${rest_}${url.search}`, vary: 'Cookie, Accept-Language' } });
    }
    // an old file URL: a permanent redirect to the page's URL, with the query
    if (route && route.status != 200) return new Response(null, { status: route.status >= 300 && route.status < 400 ? route.status : 301, headers: { location: route.to + url.search } });
    const page = pageOf(path);
    if (page) return render(request, page, api, rest);
    // a path a page declares, for a page without embedded data: its file, as a host's rewrite serves it
    if (route?.file) return next(new Request(new URL('/' + route.file + url.search, url), request), ...rest);
    return next(request, ...rest);
  }

  return {
    fetch: (request, next, ...rest) => handle(request, next, o.api ?? next, rest),
    wrap: (handler) => (request, ...rest) => handle(request, handler, o.api ?? handler, rest),
  };
}
