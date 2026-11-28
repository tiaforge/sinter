// @tiaforge-ui/sinter/testing: compile in memory with the real compiler, mount
// into the test DOM, and drive requests, streams and time deterministically.
// No test-runner imports: works with Vitest or anything else, on jsdom or happy-dom.
import { compileParts } from '../compiler/compile.js';
import { inlineScripts } from '../compiler/components.js';
import { earlyPage } from '../compiler/index.js';
import { applyStrict, formatDiagnostic, strictOf, type Strict } from '../compiler/diagnostics.js';
import { apiOrigins, defaultApiRenamed, resolveApis, runtimeApi, type ApiOptions, type ApisDef } from '../compiler/apis.js';
import type { OpenApiSpec } from '../compiler/openapi.js';
import type { Diagnostic } from '../compiler/diagnostics.js';
import { compactIR } from '../ir.js';
import type { CompileLibrary, CompiledParts, HelperManifest } from '../compiler/compile.js';
import { functionVerdict, type FoldVerdict } from '../fold-check.js';
import { functionWrites, writePlace } from '../helper-writes.js';
import * as earlyExports from '../early.js';
import { configured, observe, requests } from '../early.js';
import { install as installMessages } from '../messages.js';
import { format as formatMessage, inline as inlineMessage } from '../messages/format.js';
import { flatten as flattenMessages } from '../messages/parse.js';
import { nsLocal } from '../compiler/expr.js';
import { instance, mount, scopeState, type App, type Feature, type Transport } from '../runtime/app.js';
import { config, type Middleware } from '../runtime/config.js';
import type { Env } from '../runtime/env.js';
import { tokens } from '../runtime/request.js';
import { $tokens, signInTarget } from '../token.js';
import signedIn from '../signed-in.js';
import { $k } from '../runtime/security.js';
import { $href, $hq, $hv } from '../runtime/url.js';
import * as builtins from '../runtime/helpers.js';
import { remote, resolveRemote, type RemoteImages } from '../remote.js';
import cache from '../cache.js';
import back from '../back.js';
import refresh from '../refresh.js';
import versions from '../versions.js';
import dev, { warningSink, type RuntimeWarning } from '../dev.js';
import type { EventSenders } from '../event-senders.js';
export { eventSenders, type EventSenders } from '../event-senders.js';
export type { RuntimeWarning } from '../dev.js';
import optimistic from '../optimistic.js';
import paginate from '../paginate.js';
import fanOut from '../for.js';
import persist from '../persist.js';
import options from '../options.js';
import keys from '../keys.js';
import writeThrough from '../write-through.js';
import transition from '../transition.js';
import fields from '../fields.js';
import form from '../form.js';
import select from '../select.js';
import location from '../location.js';
import typing from '../typing.js';
import queryLinks from '../query-links.js';
import navigate from '../navigate.js';
import call from '../call.js';
import debounce from '../debounce.js';
import components from '../components.js';
import nested from '../nested.js';
import lets from '../lets.js';
import confirm from '../confirm.js';
import models from '../models.js';
import sse from '../sse.js';
import { lists, prefetch, type PrefetchPage } from '../prefetch.js';
import * as prefetchExports from '../prefetch.js';
import { pagePaths } from '../prefetch-build.js';

const FEATURES: Record<string, Feature> = { components, nested, lets, dev, sse, optimistic, paginate, persist, cache, back, versions, refresh, for: fanOut, options, keys, 'write-through': writeThrough, fields, form, select, location, typing, 'query-links': queryLinks, navigate, call, debounce, confirm, models, transition, 'signed-in': signedIn };

// ---- requests

export type RouteResponse =
  | ((call: RecordedCall, request: Request) => unknown)
  | { status: number; body?: unknown; headers?: Record<string, string> }
  | object | string | number | boolean | null;

export interface RecordedCall {
  method: string;
  url: string;
  path: string;
  body: unknown;
  headers: Record<string, string>;
  /** the response's status, once answered (unset while waiting, and when the request failed or was aborted) */
  status?: number;
  /** whether a route answered it (false: `fallback` did) */
  matched?: boolean;
}

export interface MockRequestsOptions {
  /** answers the requests no route matches, instead of failing them (`render()` would rethrow the error) */
  fallback?: RouteResponse;
}

export interface MockRequests extends Middleware {
  /** every request that reached the mock, in order */
  readonly calls: RecordedCall[];
  /** requests waiting for settle() */
  readonly pending: number;
  /** answers every waiting request; returns how many */
  deliver(): Promise<number>;
  /** errors for unmatched requests; render() rethrows them */
  readonly errors: Error[];
}

function isResponseSpec(v: unknown): v is { status: number; body?: unknown; headers?: Record<string, string> } {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  const keys = Object.keys(v);
  return typeof (v as { status?: unknown }).status === 'number' && keys.every((k) => k === 'status' || k === 'body' || k === 'headers');
}

function toResponse(v: unknown): Response {
  if (v instanceof Response) return v;
  if (isResponseSpec(v)) {
    const headers = new Headers(v.headers);
    let body: string | null = null;
    if (v.body !== undefined && v.body !== null) {
      if (typeof v.body === 'string') { body = v.body; if (!headers.has('Content-Type')) headers.set('Content-Type', 'text/plain'); }
      else { body = JSON.stringify(v.body); if (!headers.has('Content-Type')) headers.set('Content-Type', 'application/json'); }
    }
    return new Response(v.status === 204 ? null : body, { status: v.status, headers });
  }
  if (v === undefined || v === null) return new Response(null, { status: 204 });
  return new Response(JSON.stringify(v), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

/** Request middleware answering `'METHOD /path'` routes. Responses are held until `settle()`. */
export function mockRequests(routes: Record<string, RouteResponse>, options: MockRequestsOptions = {}): MockRequests {
  const calls: RecordedCall[] = [];
  const errors: Error[] = [];
  const queue: Array<() => void> = [];
  const table = Object.entries(routes).map(([k, v]) => {
    const [method, path] = k.trim().split(/\s+/, 2) as [string, string];
    return { method: method.toUpperCase(), path, value: v, key: k };
  });

  const mw = (async (req: Request) => {
    const url = new URL(req.url);
    const text = req.method === 'GET' || req.method === 'HEAD' ? '' : await req.clone().text();
    const ct = req.headers.get('Content-Type') ?? '';
    let body: unknown = null;
    if (text) {
      if (ct.includes('json')) { try { body = JSON.parse(text); } catch { body = text; } }
      else if (ct.includes('multipart/form-data')) { try { body = await req.clone().formData(); } catch { body = text; } }
      else body = text;
    }
    const headers: Record<string, string> = {};
    req.headers.forEach((v, k) => { headers[k.toLowerCase()] = v; });
    const call: RecordedCall = { method: req.method, url: url.pathname + url.search, path: url.pathname, body, headers };
    calls.push(call);
    const route = table.find((r) => r.method === req.method && (r.path.includes('?') ? r.path === call.url : r.path === url.pathname))
      ?? (options.fallback !== undefined ? { method: req.method, path: url.pathname, value: options.fallback, key: '(fallback)' } : undefined);
    call.matched = !!route && route.key !== '(fallback)';
    if (!route) {
      const err = new Error(`unmatched request: ${req.method} ${call.url}\nregistered routes:\n${table.map((r) => `  ${r.key}`).join('\n') || '  (none)'}`);
      errors.push(err);
      throw err;
    }
    return new Promise<Response>((resolve, reject) => {
      const onAbort = () => reject(req.signal.reason ?? new DOMException('aborted', 'AbortError'));
      if (req.signal.aborted) return onAbort();
      req.signal.addEventListener('abort', onAbort, { once: true });
      queue.push(async () => {
        req.signal.removeEventListener('abort', onAbort);
        if (req.signal.aborted) return;
        try {
          const v = typeof route.value === 'function' ? await (route.value as (c: RecordedCall, r: Request) => unknown)(call, req) : route.value;
          const res = toResponse(v instanceof Response ? v : structuredClone(v));
          call.status = res.status;
          resolve(res);
        } catch (e) { reject(e); }
      });
    });
  }) as unknown as MockRequests;

  Object.defineProperties(mw, {
    calls: { value: calls },
    errors: { value: errors },
    pending: { get: () => queue.length },
    deliver: {
      value: async () => {
        const batch = queue.splice(0);
        for (const fn of batch) await fn();
        return batch.length;
      },
    },
  });
  return mw;
}

// ---- streams

export interface MockStream {
  readonly connected: boolean;
  /** delivers a server event with a JSON payload */
  emit(name: string, payload?: unknown): void;
  /** drops the connection, as a network error would */
  drop(): void;
  /** @internal */
  transport(): Transport;
}

export function mockStream(): MockStream {
  let onEvent: ((name: string, payload: unknown) => void) | null = null;
  let onState: ((s: 'open' | 'error') => void) | null = null;
  let connected = false;
  return {
    get connected() { return connected; },
    emit(name, payload) {
      if (!connected) throw new Error(`mockStream: cannot emit \`${name}\` while disconnected`);
      // through JSON, as over the wire: the page never shares the test's object
      onEvent?.(name, JSON.parse(JSON.stringify(payload ?? null)));
    },
    drop() {
      if (!connected) return;
      connected = false;
      onState?.('error');
    },
    transport() {
      return {
        connect(_url, ev, st) {
          onEvent = ev;
          onState = st;
          connected = true;
          queueMicrotask(() => { if (connected && onState === st) st('open'); });
        },
        close() { connected = false; onEvent = null; onState = null; },
      };
    },
  };
}

// ---- render

export interface RenderOptions {
  /**
   * What the events the page's code can make carry (`eventSenders(files, root)` of this module over the test's modules,
   * or a summary the test states): with it a handler's `$event` is followed, as in a build; without it, as in
   * `compile()`, no event's is (docs/spec.md, Aliases)
   */
  events?: EventSenders;
  requests?: MockRequests;
  streams?: Record<string, MockStream>;
  /** page URL, for `$url` (default `http://localhost/`) */
  url?: string;
  locale?: string;
  /** start time of sinter's clock */
  now?: number | Date;
  /**
   * browser frames: changes from server events wait for the next frame, which `frame()` runs (default:
   * no frames, so they flush in a microtask like any change, and `flush()` shows them)
   */
  frames?: boolean;
  /** helper functions, and namespaces as objects of functions */
  helpers?: Record<string, unknown>;
  /**
   * helper namespaces whose module reaches a lazy package (docs/lazy.md#helpers-that-wait), as the module's
   * exports and the function that loads it: a `data-sn-let` that calls one is `undefined` until `load()`
   * resolves (a rejection takes the unhandled-error path)
   */
  lazyHelpers?: Record<string, { members: string[]; load: () => Promise<Record<string, unknown>> }>;
  /** action functions for `data-sn-call` and `<sn-resource call>`, and namespaces as objects of functions */
  actions?: Record<string, unknown>;
  /** other files the page reads, by path relative to the page (`src/components/x-y.html`) */
  files?: Record<string, string>;
  /** the app's components, by name: `{ 'article-preview': '<template data-sn-props="…">…</template>' }` */
  components?: Record<string, string>;
  /** the app's layouts, by name: `{ 'app-layout': '<!doctype html><html data-sn-props="{ title: string }">…</html>' }`; the page is the layout's tag */
  layouts?: Record<string, string>;
  /** the scripts of components, by name: the module (`await import('../src/components/task-ring.ts')`) or the class */
  scripts?: Record<string, unknown>;
  /**
   * the early renderers of components, by name (docs/components.md#early-renderers): the module
   * (`await import('../src/components/doc-view.early.ts')`) or its default export; run by the early chunk (`firstPaint`)
   */
  earlyRenderers?: Record<string, unknown>;
  /** localStorage and sessionStorage (default: empty ones); pass the previous page's to test what carries over */
  storage?: Storage;
  session?: Storage;
  /**
   * the page is reached by Back or Forward, and the back/forward cache did not serve it: its resources show what
   * `session` holds of them (what the page showed as it was left, `unmount()` writes it) at once, then revalidate
   */
  traverse?: boolean;
  /** the person asked for less motion (`prefers-reduced-motion: reduce`): `data-sn-transition` morphs nothing */
  reducedMotion?: boolean;
  /**
   * the messages, as the inlang message files hold them: `{ en: { nav_mail: 'Mail' }, de: { … } }`, the base
   * language first (nested keys and complex messages too). They are the content namespace `m` `inlang()` gives a
   * build, and the page is in one language, `locale`, else the base: `m.key()` reads that language's message, and
   * writing `$locale` is SN203.
   */
  messages?: Record<string, Record<string, string>>;
  /**
   * first paint: compile with build-time constants and run the page's early chunk (the app's
   * early module, then the early bindings) before mounting, as the built page does in the browser
   */
  firstPaint?: true | FirstPaintTestOptions;
  /**
   * the app's other pages, by file (`'article.html'`), for next-page data: links to them request their
   * data ahead, as in a build. A page answers at its `data-sn-path` patterns, else at its file's paths
   */
  pages?: Record<string, string>;
  /** deprecated with `sinter({ openapi })`, until 1.0: `apis: { main: { openapi } }`. An OpenAPI 3 document (parsed), as `sinter({ openapi })` gives the compiler: types resources and actions, and write-through knows the entities */
  openapi?: unknown;
  /**
   * the app's APIs, as `sinter({ apis })` (docs/apis.md), each spec a parsed OpenAPI 3 document: paths
   * on the page are relative to them, and requests carry their credentials and headers
   */
  apis?: Record<string, Omit<ApiOptions, 'openapi'> & { openapi?: unknown }>;
  /** as `sinter({ images: { remote } })`: images from the API; a bound `<img src>` gets the service's `srcset` */
  images?: { remote?: RemoteImages };
  /** the page's stylesheets, for the boxes of its images and the space of its lists (as the Vite plugin reads them from the page) */
  css?: string;
  /**
   * as `sinter({ minifyHtml })`, but off by default here: minify the page's HTML as a build does, the
   * author's comments out, and white space `css` shows to render nothing (docs/minify.md)
   */
  minifyHtml?: boolean;
  /**
   * strict mode (docs/strict.md), as `sinter({ strict })` takes it (default: `SINTER_STRICT`; `false` wins over it, for a test that expects warnings): the page's
   * warnings throw like its errors, except the codes in `allow`, and a runtime warning makes the call
   * that ran it (`render`, `flush`, `settle`, `advance`, …) reject. Runtime warnings that depend on the
   * environment do not (`warnings()` has them)
   */
  strict?: boolean | { allow?: Record<string, string> };
  /**
   * `false`: the page compiles as a production build does, without the dev build's source positions and checks, and with
   * the build's own passes over the IR (templates several shared definitions write alike kept once). Default `true`.
   */
  dev?: boolean;
  /**
   * @internal `sinter render`: the page is a file of a project, compiled with the project's files, components,
   * layouts and APIs (as `sinter check` reads them) instead of `files`, `components`, `layouts` and `apis`
   */
  project?: RenderProject;
}

/** @internal a page of a project on disk, for `sinter render` */
export interface RenderProject {
  root: string;
  file: string;
  readFile: (path: string) => string;
  listFiles?: (dir: string) => string[];
  componentNames: string[];
  /** the component libraries (`sinter({ libraries })`) */
  libraries?: readonly CompileLibrary[];
  openapi: OpenApiSpec[];
  apis: ApisDef | null;
  /** the project's helpers manifest (where each helper is declared), and the lazy packages each declaring module reaches */
  helpers?: HelperManifest;
  lazyModule?: (module: string) => string[];
}

/** One write to the page's history: `push` adds an entry, `replace` and `fragment` change the current one. */
export interface HistoryWrite {
  op: 'push' | 'replace' | 'fragment';
  url: string;
}

export interface FirstPaintTestOptions {
  /** stands for the app's early module (`src/sinter.early.ts`): runs before the early bindings */
  early?: () => void;
  /** runs after the early chunk, before the page module mounts (e.g. to watch what mounting changes) */
  afterEarly?: () => void;
}

export interface Rendered {
  root: HTMLElement;
  app: App;
  /**
   * The nearest `data-sn-state` scope of `el`, to change state the way the page cannot from a test: `update(fn)`
   * marks the whole scope. A field the build used as a constant (nothing on the page writes it) has no bindings
   * left, so writing it throws: write it from a handler or a component script, as the page would.
   */
  state<T = any>(el: Element): StateHandle<T>;
  /** runs the scheduler until no binding is dirty */
  flush(): Promise<void>;
  /** flushes until every request, queue and debounce has finished */
  settle(): Promise<void>;
  /** moves sinter's clock: debounce, backoff, `$now` */
  advance(ms: number): Promise<void>;
  /** URLs sinter tried to navigate to (`navigate(url, { replace: true })`: prefixed `replace `) */
  navigations: string[];
  /** the runtime's warnings (and errors) since `render()`, strict mode or not */
  warnings(): RuntimeWarning[];
  /** current page URL (after `$url` writes) */
  url(): string;
  /** the page's history entries (pushed by `$url` writes; a navigation adds none), oldest first */
  history(): string[];
  /** every history write since `render()`, in order: what `history()` does not show, a replace */
  historyWrites(): HistoryWrite[];
  /** the build's warnings for the page (errors make `render()` throw) */
  diagnostics: Diagnostic[];
  /** Back and Forward: moves through `history()` and dispatches `popstate`; nothing past either end */
  back(): Promise<void>;
  forward(): Promise<void>;
  /** hides or shows the page (a background tab), then dispatches `visibilitychange` */
  visibility(state: 'hidden' | 'visible'): Promise<void>;
  /** with `frames`: runs what waits for the next frame (the browser's requestAnimationFrame) */
  frame(): Promise<void>;
  /** dispatches a window event to sinter; `props` are set on the event (`pageswap`/`pagereveal`: `viewTransition`, `activation`) */
  window(type: 'pagehide' | 'pageshow' | 'popstate' | 'online' | 'beforeunload' | 'pageswap' | 'pagereveal', props?: Record<string, unknown>): Promise<void>;
}

export interface StateHandle<T = any> {
  get(): T;
  update(fn: (state: T) => void): void;
}

interface Timer { id: number; at: number; fn: () => void; kind: string }

let current: App | null = null;
const realSetTimeout = globalThis.setTimeout.bind(globalThis);
const tick = () => new Promise<void>((r) => realSetTimeout(r, 0));
const PAGE = '/test/page.html';

/**
 * What the built page shows before its module has run: the page compiled with its build-time
 * constants, written into the document, and its early chunk run over it. Nothing is mounted:
 * bindings that wait for data are as the HTML has them.
 */
export async function firstPaint(html: string, options: Pick<RenderOptions, 'helpers' | 'files' | 'components' | 'scripts' | 'earlyRenderers' | 'storage' | 'messages' | 'locale' | 'lazyHelpers'> & FirstPaintTestOptions = {}): Promise<{ root: HTMLElement; html: string }> {
  if (current) { current.destroy(); current = null; }
  releaseLocale();
  const { files, components, scripts, earlyRenderers } = options;
  const helpers = withMessages(options);
  const { parts } = compilePage(html, { helpers, ...(files ? { files } : {}), ...(components ? { components } : {}), ...(scripts ? { scripts } : {}), ...(earlyRenderers ? { earlyRenderers } : {}), ...(options.lazyHelpers ? { lazyHelpers: options.lazyHelpers } : {}), ...(options.messages || options.locale !== undefined ? { ...(options.messages ? { messages: options.messages } : {}), ...(options.locale !== undefined ? { locale: options.locale } : {}) } : {}), firstPaint: true });
  writePage(parts.html, options.messages);
  const env = config.env;
  config.env = { ...env, storage: () => options.storage ?? null };
  if (options.messages) messagesLocale(options);
  else pageLocale(parts, options.locale);
  try { await paint(parts, helpers, options.early, earlyRenderers); } finally { config.env = env; }
  return { root: document.body, html: parts.html };
}

/** the locale sources `render()` and `firstPaint()` set for a page (its messages, the test's `locale`, its `<html lang>`) */
const ownSources = new WeakSet<object>();
/** a locale source the test configured itself that a render replaced (its messages, its `locale`): back at the next */
let testSource: typeof config.locale = null;
/** before a render replaces the locale source: one the test configured itself is kept for the next render */
function keepTestLocale() {
  if (testLocale()) testSource = config.locale;
}
/** the locale source as the last render left it (undefined: none set one) */
let lastSet: typeof config.locale | undefined;
/** a new page: the last page's locale source goes; one the test configured itself (`configure({ locale })`) stays, or comes back */
function releaseLocale() {
  if (testSource && config.locale === lastSet) config.locale = testSource;
  else if (config.locale && ownSources.has(config.locale)) config.locale = null;
  testSource = null;
  lastSet = undefined;
}
/** a locale source the test configured itself: the app sets its locale (`appLocale`) */
const testLocale = () => !!config.locale && !ownSources.has(config.locale);
/**
 * The page's locale source: the test's `locale` (as the app's `configure({ locale })`), else, in an app that sets no
 * locale, the page's literal `<html lang>`, as a built page's module sets it (`$lang`)
 */
function pageLocale(parts: CompiledParts, locale: string | undefined) {
  if (locale !== undefined) {
    keepTestLocale();
    let l = locale;
    ownSources.add(config.locale = { get: () => l, set: (x) => { l = x; } });
    lastSet = config.locale;
    return;
  }
  const lang = parts.lang;
  if (lang && !config.locale) ownSources.add(config.locale = { get: () => lang, set: () => {} });
  lastSet = config.locale;
}

/** the page's one language with messages: `locale`, else the base (the messages' first) */
const messagesLang = (o: Pick<RenderOptions, 'messages' | 'locale'>) => o.locale ?? Object.keys(o.messages!)[0]!;

/** the messages' entries in the page's language, as `inlang()` gives them: the base language's, then the page's over them */
function messageEntries(o: Pick<RenderOptions, 'messages' | 'locale'>): Record<string, { id: string; m: unknown }> {
  const all = Object.entries(o.messages!), lang = messagesLang(o), out: Record<string, { id: string; m: unknown }> = {};
  for (const [l, dict] of [all[0]!, ...all.filter(([l]) => l === lang)]) for (const [id, m] of flattenMessages(dict as Record<string, unknown>, `${l}.json`)) out[id] = { id, m };
  return out;
}

/** the messages: the namespace `m` as a helper (each of its functions the message in the page's language) */
function withMessages(o: Pick<RenderOptions, 'helpers' | 'messages' | 'locale' | 'storage'>): Record<string, unknown> {
  if (!o.messages) return o.helpers ?? {};
  const entries = messageEntries(o), lang = messagesLang(o);
  return { ...o.helpers, m: Object.fromEntries(Object.entries(entries).map(([k, e]) => [k, (p?: Record<string, unknown>) => formatMessage(e, p, lang)])) };
}

/** the messages module, as a built page's module installs it: the page's language (the locale source) and its entries */
function messagesLocale(o: Pick<RenderOptions, 'messages' | 'locale'>) {
  (globalThis as any)[Symbol.for('sinter.i18n')] = undefined;
  keepTestLocale();
  config.locale = null;
  const lang = messagesLang(o);
  installMessages(lang, formatMessage as never);
  (globalThis as any)[Symbol.for('sinter.i18n')].dicts[lang] = messageEntries(o);
  if (config.locale) ownSources.add(config.locale);
  lastSet = config.locale;
}

/** The early chunk: the app's early module, then the early bindings with the helpers in scope, as the page is parsed. */
async function paint(parts: CompiledParts, helpers: Record<string, unknown>, app?: () => void, renderers: Record<string, unknown> = {}) {
  app?.();
  if (!parts.early) return;
  const names: string[] = ['$k'], values: unknown[] = [$k];
  // the components' early renderers, by the component's name (the module's file name)
  for (const [local, mod] of Object.entries(parts.early.renderers ?? {})) {
    const m = renderers[/([^/]+)\.early\.[cm]?[jt]s$/.exec(mod)?.[1] ?? ''] as { default?: unknown } | undefined;
    names.push(local);
    values.push(typeof m === 'function' ? m : m?.default);
  }
  for (const h of parts.early.helpers) { names.push(h); values.push(helpers[h]); }
  // the built-in formatters the early bindings call, the package's, as a build imports them
  for (const x of parts.early.formatters ?? []) { names.push(x); values.push((builtins as Record<string, unknown>)[x]); }
  for (const [ns, members] of Object.entries(parts.early.namespaces)) {
    for (const m of members) { names.push(nsLocal(ns, m)); values.push((helpers[ns] as Record<string, unknown>)[m]); }
  }
  // the compiled renderer, as the early file has it, with the early module's exports it calls
  const page = earlyPage(parts.early);
  for (const u of page.uses) { names.push(u); values.push((earlyExports as Record<string, unknown>)[u]); }
  // eslint-disable-next-line no-new-func -- tests only; pages load a compiled module
  const made = new Function(...names, `"use strict"; const f = [\n${parts.early.fns.join(',\n')}\n]; return ${page.code};`)(...values);
  await parse(() => { configured(); observe(() => made, requests(configured)); });
}

/**
 * The document parsed again with `early` run from its head, where a page has its early script (`observe`): the
 * written page's nodes are taken out and inserted again one by one in document order, an element before its
 * children, as the parser inserts them, each insertion's observer callback run before the next; then
 * DOMContentLoaded. One node per parser chunk is the order that leaves the most elements open at each pass.
 * The early script stands after the head's leading `<meta>`s and the build-computed values the compiler wrote after
 * them (compile.ts `placeFolded`): there the dev server's tag is (`injectScript`), and a build's head scripts come no
 * earlier (src/vite.ts puts them before the first stylesheet, module preload or script, which is at or after that
 * place). So `early` starts with those nodes parsed, and nothing after them.
 */
async function parse(early: () => void) {
  const doc = document, top = doc.documentElement;
  const kids = [...top.childNodes];
  top.replaceChildren();
  let state: DocumentReadyState = 'loading';
  Object.defineProperty(doc, 'readyState', { configurable: true, get: () => state });
  const put = async (n: Node, parent: Node) => {
    const inner = [...n.childNodes];
    for (const c of inner) c.remove();
    parent.appendChild(n);
    // the observer's callback, a microtask queued by the insertion
    await Promise.resolve();
    for (const c of inner) await put(c, n);
  };
  /** a value the compiler wrote for the early script: `<script type="application/json" data-sn="id">` */
  const value = (n: Node) => n.nodeName == 'SCRIPT' && (n as Element).getAttribute('type') == 'application/json' && /^\d+$/.test((n as Element).getAttribute('data-sn') ?? '');
  try {
    const head = kids.find((k) => k.nodeName == 'HEAD');
    // a page without a <head> element (the parser makes one): the early script is the first thing in it
    if (!head) early();
    for (const k of kids) {
      if (k != head) { await put(k, top); continue; }
      const inner = [...head.childNodes];
      let at = 0;
      for (let i = 0; i < inner.length; i++) { const n = inner[i]!; if (n.nodeType == 1 && n.nodeName != 'META' && !value(n)) break; if (n.nodeType == 1) at = i + 1; }
      for (const c of inner) c.remove();
      // the head so far, parsed before any script ran (no observer has seen it)
      top.appendChild(head);
      for (const c of inner.slice(0, at)) head.appendChild(c);
      early();
      for (const c of inner.slice(at)) await put(c, head);
    }
    state = 'interactive';
    doc.dispatchEvent(new Event('DOMContentLoaded'));
  } finally {
    delete (doc as { readyState?: unknown }).readyState;
    // the early file's meeting with the page module: the next page starts without one
    delete (globalThis as Record<symbol, unknown>)[Symbol.for('sinter.early.page')];
  }
}

function compilePage(html: string, options: RenderOptions, strict: Strict = { on: false, allow: new Map() }): { parts: CompiledParts; manifest: HelperManifest; actions: Record<string, unknown>; apis: ApisDef | null; diagnostics: Diagnostic[] } {
  // renamed to the Vite plugin's spelling
  const was = options as { minify?: unknown; remoteImages?: unknown; defaultApi?: unknown };
  if (was.defaultApi !== undefined) throw new Error(defaultApiRenamed('render', was.defaultApi));
  if (was.minify !== undefined) throw new Error('render({ minify }) is renamed to `minifyHtml`, as in `sinter({ minifyHtml })`');
  if (was.remoteImages !== undefined) throw new Error('render({ remoteImages }) is renamed to `images: { remote }`, as in `sinter({ images: { remote } })`');
  const helpers = options.helpers ?? {};
  const manifest: HelperManifest = { module: null, names: [], namespaces: {} };
  for (const [k, v] of Object.entries(helpers)) {
    if (typeof v === 'function') manifest.names.push(k);
    else if (v && typeof v === 'object') manifest.namespaces[k] = { module: k, members: Object.keys(v) };
  }
  for (const [k, v] of Object.entries(options.lazyHelpers ?? {})) manifest.namespaces[k] = { module: `lazy:${k}`, members: v.members };
  // the messages are the content namespace `m`, as `inlang()` gives a build: not a namespace of the app's
  if (options.messages && manifest.namespaces.m) manifest.namespaces.m.module = 'sinter:content/m';
  // `sinter render`: where each helper is declared, so the helper modules that reach a lazy package are known (not the built-in messages)
  const real = options.project?.helpers;
  if (real) {
    if (real.module) manifest.module = real.module;
    if (real.from) manifest.from = real.from;
    for (const [k, v] of Object.entries(manifest.namespaces)) {
      const r = real.namespaces[k];
      if (r && !r.module.startsWith('sinter:content/')) manifest.namespaces[k] = { ...v, module: r.module, ...(r.from ? { from: r.from } : {}) };
    }
  }
  const actions = options.actions ?? {};
  const actionManifest: HelperManifest = { module: 'actions', names: [], namespaces: {} };
  for (const [k, v] of Object.entries(actions)) {
    if (typeof v === 'function') actionManifest.names.push(k);
    else if (v && typeof v === 'object') actionManifest.namespaces[k] = { module: k, members: Object.keys(v) };
  }
  const files: Record<string, string> = { ...options.files };
  for (const [name, text] of Object.entries(options.components ?? {})) files[`src/components/${name}.html`] = text;
  for (const [name, text] of Object.entries(options.layouts ?? {})) files[`src/layouts/${name}.html`] = text;
  // a script's and an early renderer's stand-ins go beside the component's HTML: in a folder of its own when it is in one
  const base = (name: string) => (files[`src/components/${name}/${name}.html`] !== undefined ? `src/components/${name}/${name}` : `src/components/${name}`);
  // (not for a single-file component: its `<script>` is its script, and `scripts` gives the class that stands for it)
  for (const name of Object.keys(options.scripts ?? {})) {
    if (inlineScripts(files[`${base(name)}.html`] ?? '').length) continue;
    // (the stand-in is the class's own code: the build reads a script for what it keeps in its state, docs/spec.md, Aliases)
    const given = options.scripts![name];
    const classes = typeof given === 'function' ? [given] : Object.values((given ?? {}) as Record<string, unknown>).filter((v) => typeof v === 'function');
    files[`${base(name)}.ts`] ??= classes.length ? classes.map((c, i) => `export ${i ? '' : 'default '}${(c as () => void).toString()}`).join('\n') : 'export default class {}';
  }
  for (const name of Object.keys(options.earlyRenderers ?? {})) files[`${base(name)}.early.ts`] ??= 'export default () => {};';
  const proj = options.project;
  const apis = proj ? { specs: proj.openapi, apis: proj.apis } : options.apis ? testApis(options) : null;
  // the messages: compiled in the page's one language, as a build compiles them
  const lang = options.messages ? messagesLang(options) : null;
  const parts = compileParts(html, {
    // the test sets the locale (`locale`, or its own `configure({ locale })`): the page's `<html lang>` is not it
    ...(!lang && (options.locale !== undefined || testLocale()) ? { appLocale: true } : {}),
    ...(lang ? {
      locale: { name: lang, urls: null, base: '/', prefix: false as const },
      contentNs: { m: { entries: messageEntries(options), format: '@tiaforge-ui/sinter/messages/format', formatFn: formatMessage as never, inlineFn: inlineMessage, module: '@tiaforge-ui/sinter/messages' } },
    } : {}),
    file: proj?.file ?? PAGE, root: proj?.root ?? '/test', dev: options.dev ?? true, helpers: manifest,
    ...(options.events ? { eventSenders: () => options.events! } : {}),
    ...(proj?.lazyModule ? { lazyModule: proj.lazyModule } : {}), actions: actionManifest, moduleSrc: 'about:blank', componentNames: proj?.componentNames ?? Object.keys(options.components ?? {}), ...(proj?.libraries?.length ? { libraries: proj.libraries } : {}),
    // lazy packages: any name, loaded by nothing (a test calls the app's functions, which import what they need)
    lazy: true,
    // helper calls over build-time constants run at build time, as in a build: each function's own source decides
    helperValues: helpers, helperFold: helperVerdicts(helpers), helperWrites: helperWritesOf(helpers),
    // helper modules that reach a lazy package: the namespaces in `lazyHelpers`
    ...(options.lazyHelpers ? { lazyModule: (m: string) => (m.startsWith('lazy:') ? ['(lazy)'] : []) } : {}),
    readFile: proj?.readFile ?? ((p) => {
      const rel = p.startsWith('/test/') ? p.slice('/test/'.length) : p;
      const hit = files[rel] ?? files[`./${rel}`] ?? files[p];
      if (hit === undefined) throw new Error(`no such file: ${p}`);
      return hit;
    }),
    // a glob lists the test's files below a folder (paths as the test wrote them, under the root `/test`)
    listFiles: proj?.listFiles ?? ((dir) => {
      const d = dir.replace(/\/$/, '') + '/';
      const all = Object.keys(files).map((f) => (f.startsWith('/') ? f : `/test/${f.replace(/^\.\//, '')}`));
      return all.filter((f) => f.startsWith(d));
    }),
    // compiled as a build does (both passes: build-time constants, decided branches, unrolled loops); `firstPaint` runs the early chunk
    prerender: true, ...(options.firstPaint ? { early: { module: null } } : {}),
    ...(apis ? { openapi: apis.specs, ...(apis.apis ? { apis: apis.apis } : {}) } : options.openapi ? { openapi: [{ file: 'openapi.yml', doc: options.openapi }] } : {}),
    ...(options.images?.remote ? { remoteImages: resolveRemote(options.images.remote) } : {}),
    // static images stay as written in tests (no files to encode); the stylesheets size bound ones
    ...(options.css ? { images: { info: () => null, url: () => '', styles: [{ file: 'test.css', css: options.css }] } } : {}),
    // and hold the space of lists whose data comes later (the rules are the build's; the test reads the placeholder)
    ...(options.css ? { styles: [{ file: 'test.css', css: options.css }], paintCss: 'paint.css' } : {}),
    // as a build does (`sinter({ minifyHtml })`, on by default there): the page's markup minified against `css`
    ...(options.minifyHtml ? { minify: { styles: options.css ? [{ file: 'test.css', css: options.css }] : [] } } : {}),
  });
  const diagnostics = strict.on ? applyStrict(parts.diagnostics, new Set(strict.allow.keys())) : parts.diagnostics;
  const errors = diagnostics.filter((d) => d.severity === 'error');
  if (errors.length) throw new Error(`sinter: build failed\n${errors.map(formatDiagnostic).join('\n')}`);
  return { parts, manifest, actions, apis: apis?.apis ?? null, diagnostics };
}

/** Whether each helper given may run at build time, by the name compiled code calls (fold-check.ts, from its own source). */
function helperVerdicts(helpers: Record<string, unknown>): Map<string, FoldVerdict> {
  const out = new Map<string, FoldVerdict>();
  for (const [k, v] of Object.entries(helpers)) {
    if (typeof v === 'function') out.set(k, functionVerdict(v, k));
    else if (v && typeof v === 'object') for (const [m, f] of Object.entries(v)) out.set(`${k}$${m}`, functionVerdict(f, `${k}.${m}`));
  }
  return out;
}

/** Where each helper given writes into a parameter (helper-writes.ts, from its own source): SN214 for a call over page data. */
function helperWritesOf(helpers: Record<string, unknown>): Map<string, Array<{ what: string; place: string } | null>> {
  const out = new Map<string, Array<{ what: string; place: string } | null>>();
  const one = (key: string, f: unknown, name: string) => {
    const ws = functionWrites(f, name);
    if (ws) out.set(key, ws.map((w) => (w ? { what: w.what, place: writePlace(w, '/') } : null)));
  };
  for (const [k, v] of Object.entries(helpers)) {
    if (typeof v === 'function') one(k, v, k);
    else if (v && typeof v === 'object') for (const [m, f] of Object.entries(v)) one(`${k}$${m}`, f, `${k}.${m}`);
  }
  return out;
}

/** What a module of the helpers manifest exports of the helpers given (`sinter render` loads them all), by export name. */
function helpersOf(m: HelperManifest, helpers: Record<string, unknown>, module: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const h of m.names) { const o = m.from?.[h]; if ((o?.module ?? m.module) === module) out[o?.name ?? h] = helpers[h]; }
  for (const [ns, v] of Object.entries(m.namespaces)) for (const k of v.members) {
    const o = v.from?.[k];
    if ((o?.module ?? v.module) === module) out[o?.name ?? k] = (helpers[ns] as Record<string, unknown> | undefined)?.[k];
  }
  return out;
}

/** `apis` of the render options, resolved as the project resolves `sinter({ apis })`; an invalid one throws. */
function testApis(options: RenderOptions): { specs: OpenApiSpec[]; apis: ApisDef | null } {
  const specs: OpenApiSpec[] = [];
  const r = resolveApis({ apis: options.apis as Record<string, ApiOptions> },
    (doc) => { specs.push({ file: 'openapi.yml', doc }); return specs.length - 1; }, specs, 'vite.config.js');
  if (r.diagnostics.length) throw new Error(`sinter: ${r.diagnostics.map(formatDiagnostic).join('\n')}`);
  return { specs, apis: r.apis };
}

/** The compiled page into the test document; the `<html>` element's own attributes as the browser has them. */
function writePage(html: string, messages?: unknown) {
  const doc = document;
  // parsed, not matched: an `<html>` in a comment or text before the real tag is not the element
  const page = new DOMParser().parseFromString(html, 'text/html').documentElement;
  page.querySelector('script[type="module"][src="about:blank"]')?.remove();
  const top = doc.documentElement;
  for (const a of [...top.attributes]) top.removeAttribute(a.name);
  for (const a of [...page.attributes]) top.setAttribute(a.name, a.value);
  top.innerHTML = page.innerHTML;
  void messages;
}

/** The error for a component with a script whose class `render({ scripts })` does not give. */
function noScriptClass(name: string, module: string, given: unknown): string {
  const pascal = name.replace(/(^|-)([a-z0-9])/g, (_, _d, c: string) => c.toUpperCase());
  const inline = /\.html\.script\.[jt]s$/.test(module);
  return `sinter: <${name}> has a script (${inline ? `the \`<script>\` in its HTML, \`${module}\`` : `\`${module}\``}) and render()'s \`scripts\` option gives `
    + (given === undefined ? 'no class for it' : 'no class in what it gives for it')
    + `: pass \`scripts: { '${name}': ${pascal} }\`, the class or ${inline ? 'a stand-in for it (a test cannot import the `<script>` block; its testable parts go in a module beside it)' : `the module (\`await import('..${module}')\`)`}`;
}

export async function render(html: string, options: RenderOptions = {}): Promise<Rendered> {
  if (current) { current.destroy(); current = null; }
  releaseLocale();

  // compile with the real compiler
  const helpers = withMessages(options);
  // `strict: false` on one test wins over SINTER_STRICT: that test expects its warnings
  const strict = options.strict === false ? { on: false, allow: new Map<string, string>() } : strictOf(options.strict);
  const { parts, manifest, actions, apis, diagnostics } = compilePage(html, { ...options, helpers }, strict);
  // the runtime's warnings: all of them for `warnings()`; in strict mode the next call rejects with the page's own
  const sink = warningSink(), seenWarnings: RuntimeWarning[] = [], failing: RuntimeWarning[] = [];
  sink.list.length = 0;
  sink.on = (w) => { seenWarnings.push(w); if (strict.on && !w.environment) failing.push(w); };
  const failOnWarnings = () => {
    if (!failing.length) return;
    const list = failing.splice(0);
    throw new Error(`sinter: ${list.length} runtime warning(s) in strict mode (docs/strict.md; \`render(html, { strict: false })\` turns it off for a test that expects them):\n${list.map((w) => w.message).join('\n')}`);
  };
  const strictly = <A extends unknown[]>(fn: (...a: A) => Promise<void>) => async (...a: A) => { await fn(...a); failOnWarnings(); };
  // the page module's `$apis`: each API's base, credentials, headers and token
  config.apis = apis?.list.map(runtimeApi) ?? [];
  // and an API with a token: the request layer sends it, as the page module's `$tokens()` sets up
  if (config.apis.some((a) => a.t)) $tokens(signInTarget); else tokens.on = undefined;
  // and their origins join the allowlist, as the page module's `$origins` does
  if (apis) config.origins = [...new Set([...config.origins, ...apiOrigins(apis)])];

  // function table, with helpers and namespace members in scope
  const names: string[] = ['$k'];
  const values: unknown[] = [$k];
  for (const h of parts.helpers.builtin) { names.push(h); values.push(h === '$href' ? $href : h === '$hv' ? $hv : h === '$hq' ? $hq : (builtins as Record<string, unknown>)[h]); }
  for (const h of parts.helpers.user) { names.push(h); values.push(helpers[h]); }
  for (const [ns, members] of Object.entries(parts.namespaces)) {
    for (const m of members) { names.push(nsLocal(ns, m)); values.push((helpers[ns] as Record<string, unknown>)[m]); }
  }
  for (const c of parts.calls) {
    const [a, b] = c.split('.') as [string, string | undefined];
    names.push(`$a$${c.replace('.', '$')}`);
    values.push(b === undefined ? actions[a] : (actions[a] as Record<string, unknown>)[b]);
  }
  if (parts.remote) { names.push('$ri'); values.push(remote(parts.remote)); }
  for (const x of parts.lazy) { names.push(x.local); values.push(() => Promise.resolve()); }
  for (const x of parts.lazyHelpers) {
    names.push(x.local);
    // `lazyHelpers`, else (`sinter render`) the module's helpers from those already loaded, by their export names
    values.push(options.lazyHelpers?.[x.module.slice('lazy:'.length)]?.load ?? (async () => helpersOf(manifest, helpers, x.module)));
  }
  for (const x of parts.scripts) {
    const m = options.scripts?.[x.name];
    names.push(x.local);
    // the class: given itself, or the module's export the compiler found (testing's files are empty, so: the module's one class)
    const mod = m as Record<string, unknown> | undefined;
    const cls = typeof m === 'function' ? m : mod?.[x.export] ?? mod?.default ?? Object.values(mod ?? {}).find((v) => typeof v === 'function');
    // the test runs no component's code of its own: a script's class comes from `scripts`, or mounting would fail inside the runtime
    if (typeof cls !== 'function') throw new Error(noScriptClass(x.name, x.module, m));
    values.push(cls);
  }
  // eslint-disable-next-line no-new-func -- tests only; pages load a compiled module
  const fns = new Function(...names, `"use strict"; return [\n${parts.fns.join(',\n')}\n];`)(...values);

  // the page
  const doc = document;
  writePage(parts.html, options.messages);

  // environment: fake clock, recorded navigation, in-memory storage
  let now = options.now instanceof Date ? options.now.getTime() : options.now ?? Date.parse('2026-01-01T09:00:00Z');
  let href = options.url ? new URL(options.url, 'http://localhost/').href : 'http://localhost/';
  const entries = [href];
  const writes: HistoryWrite[] = [];
  let at = 0;
  const timers: Timer[] = [];
  let nextTimer = 1;
  const navigations: string[] = [];
  let early: string | null = null;
  const store = options.storage ?? memoryStorage(), session = options.session ?? memoryStorage();
  const winListeners = new Map<string, Set<(e: Event) => void>>();
  let hidden = false;
  const frameQueue: Array<() => void> = [];
  const env: Env = {
    now: () => now,
    setTimeout: (fn, ms, kind = 'timeout') => { const t = { id: nextTimer++, at: now + ms, fn, kind }; timers.push(t); return t.id; },
    clearTimeout: (id) => { const i = timers.findIndex((t) => t.id === id); if (i >= 0) timers.splice(i, 1); },
    queueMicrotask: (fn) => queueMicrotask(fn),
    navigate: (url) => { navigations.push(url); },
    // the early script's sign-in redirect (`data-sn-signed-in`) is the page's: in a browser the page module does not mount after it
    replace: (url) => { if (url === early) { early = null; return; } navigations.push(`replace ${url}`); },
    fetch: (req) => Promise.reject(new Error(`unexpected network request: ${req.method} ${req.url}; pass \`requests: mockRequests({...})\``)),
    storage: () => store,
    session: () => session,
    href: () => href,
    replaceState: (url) => { href = entries[at] = new URL(url, href).href; writes.push({ op: 'replace', url: href }); },
    // a push drops the entries after the current one, as a browser's history does
    pushState: (url) => { href = new URL(url, href).href; entries.splice(++at, Infinity, href); writes.push({ op: 'push', url: href }); },
    fragment: (hash) => { href = entries[at] = new URL(hash, href).href; writes.push({ op: 'fragment', url: href }); },
    // the test's simulated events are the user's; the custom events sinter dispatches are not
    trusted: (e) => !(e instanceof CustomEvent),
    random: () => 0.5,
    hidden: () => hidden,
    traversal: () => !!options.traverse,
    reducedMotion: () => !!options.reducedMotion,
    ...(options.frames ? { frame: (fn: () => void) => { frameQueue.push(fn); } } : {}),
    listen: (type, fn) => {
      if (!winListeners.has(type)) winListeners.set(type, new Set());
      winListeners.get(type)!.add(fn);
      return () => winListeners.get(type)?.delete(fn);
    },
  };
  config.env = env;
  if (!options.messages) pageLocale(parts, options.locale);
  if (options.firstPaint) {
    const fp = options.firstPaint === true ? {} : options.firstPaint;
    if (options.messages) messagesLocale(options);
    const n = navigations.length;
    await paint(parts, helpers, fp.early, options.earlyRenderers);
    if (navigations.length > n && navigations.at(-1)!.startsWith('replace ')) early = navigations.at(-1)!.slice(8);
    fp.afterEarly?.();
  }
  if (options.messages) messagesLocale(options);

  // next-page data: the other pages described as the build describes them
  const ahead: PrefetchPage[] = [];
  for (const [rel, page] of Object.entries(options.pages ?? {})) {
    const { parts: { prefetch: other } } = compilePage(page, { ...options, firstPaint: undefined });
    if (!other) continue;
    const ns = Object.entries(other.namespaces).flatMap(([n, ms]) => ms.map((m) => [`${n}$${m}`, (helpers[n] as Record<string, unknown>)[m]] as const));
    // eslint-disable-next-line no-new-func -- tests only; pages load a compiled module
    const f = new Function('$k', ...other.uses, ...other.helpers, ...ns.map(([k]) => k), `"use strict"; return [\n${other.fns.join(',\n')}\n];`)($k, ...other.uses.map((u) => (prefetchExports as Record<string, unknown>)[u]), ...other.helpers.map((h) => helpers[h]), ...ns.map(([, v]) => v));
    ahead.push({ m: pagePaths(rel, '/', other.path), r: other.res, f, ...(other.a ? { a: other.a } : {}), ...(other.g ? { g: other.g } : {}) });
  }

  const requests = options.requests;
  let app: App;
  // a page that fails to mount leaves nothing behind: the next render starts afresh
  try { app = mount(doc, {
    // the IR as the page module carries it
    ir: compactIR(parts.ir, { names: options.dev ?? true }), fns, env,
    // as in a build, where every page has the app's prefetch feature
    features: [...parts.features.map((f) => FEATURES[f]!), prefetch(ahead, ahead.some((p) => p.a) ? lists : undefined)],
    request: [...config.request, ...(requests ? [requests] : [])],
    transport: (url) => {
      const path = new URL(url, href).pathname;
      const stream = options.streams?.[url] ?? options.streams?.[path];
      if (stream) return stream.transport();
      // a transport from configure() (e.g. a WebSocket or SignalR adapter over a fake connection)
      const configured = config.transport?.(url);
      if (configured) return configured;
      throw new Error(`no mock stream for ${url}; pass \`streams: { '${url}': mockStream() }\``);
    },
  }); } catch (e) { try { instance(doc).destroy(); } catch { /* not registered */ } throw e; }
  current = app;

  const check = () => {
    if (requests?.errors.length) throw requests.errors[0];
  };

  const flush = async () => {
    for (let i = 0; i < 50; i++) {
      for (let j = 0; j < 10; j++) await Promise.resolve();
      if (!app.isDirty) break;
      app.flush();
    }
    check();
  };

  const runDue = (until: number, kinds?: Set<string>) => {
    for (;;) {
      const due = timers.filter((t) => t.at <= until && (!kinds || kinds.has(t.kind))).sort((a, b) => a.at - b.at || a.id - b.id)[0];
      if (!due) return;
      timers.splice(timers.indexOf(due), 1);
      if (due.at > now) now = due.at;
      due.fn();
    }
  };

  const settle = async () => {
    for (let round = 0; round < 1000; round++) {
      await flush();
      await tick();
      if (requests && requests.pending) { await requests.deliver(); continue; }
      // a task the browser runs right after the event (a dialog's close releasing its bindings)
      if (timers.some((t) => t.kind === 'task' && t.at <= now)) { runDue(now, new Set(['task'])); continue; }
      const debounce = timers.filter((t) => t.kind === 'debounce').sort((a, b) => a.at - b.at)[0];
      if (debounce) { runDue(debounce.at, new Set(['debounce'])); continue; }
      // a request waiting between retries runs again only when the clock moves (advance)
      if (app.req.inflight > (app.req.waiting ?? 0) || app.busy > 0 || app.isDirty) continue;
      await flush();
      return;
    }
    throw new Error('settle(): requests did not finish after 1000 rounds');
  };

  const advance = async (ms: number) => {
    const until = now + ms;
    for (;;) {
      await flush();
      const before = timers.length;
      runDue(until);
      if (timers.length === before || !timers.some((t) => t.at <= until)) break;
    }
    now = until;
    await flush();
  };

  // the fields the build used as constants: a write to one would change nothing on the page
  const fixed = new Set(parts.fixedState ?? []);
  const snap = (v: unknown) => { try { return JSON.stringify(v); } catch { return v; } };
  const state = (el: Element): StateHandle => {
    const s = scopeState(el);
    // (a state nothing on the page writes, and nothing reads at run time, is left out of the build)
    if (!s) throw Error('sinter: no data-sn-state scope: the element has none, or nothing on the page writes or reads it at run time, so the build left it out');
    const [sid, obj] = s;
    return {
      get: () => obj,
      update: (fn) => {
        const touched = new Map<string, unknown>();
        const see = (k: string | symbol) => { if (typeof k === 'string' && !touched.has(k)) touched.set(k, snap(obj[k])); };
        fn(new Proxy(obj, {
          get: (t, k) => { see(k); return Reflect.get(t, k); },
          set: (t, k, v) => { see(k); return Reflect.set(t, k, v); },
          deleteProperty: (t, k) => { see(k); return Reflect.deleteProperty(t, k); },
        }));
        const frozen = [...touched].filter(([k, was]) => fixed.has(`$s${sid}.${k}`) && snap(obj[k]) !== was).map(([k]) => k);
        if (frozen.length) {
          throw Error(`sinter: nothing on the page writes ${frozen.map((k) => `\`${k}\``).join(', ')}, so the build made ${frozen.length > 1 ? 'them constants' : 'it a constant'} `
            + '(the first value is in the HTML, and no binding follows a change): write it from a handler or a component script, as the page would');
        }
        // `**`: the test may have changed anything under the state, rows included
        app.mark('$s' + sid + '.**');
      },
    };
  };

  const go = async (by: number) => {
    if (!entries[at + by]) return;
    href = entries[(at += by)]!;
    for (const fn of winListeners.get('popstate') ?? []) fn(new Event('popstate'));
    await flush();
  };

  await flush();
  failOnWarnings();
  return {
    root: doc.body, app, state, flush: strictly(flush), settle: strictly(settle), advance: strictly(advance), navigations,
    warnings: () => [...seenWarnings],
    url: () => href,
    history: () => [...entries],
    historyWrites: () => writes.map((w) => ({ ...w })),
    diagnostics: diagnostics.filter((d) => d.severity !== 'error'),
    back: strictly(() => go(-1)),
    forward: strictly(() => go(1)),
    frame: strictly(async () => {
      for (let j = 0; j < 10; j++) await Promise.resolve();
      for (const fn of frameQueue.splice(0)) fn();
      check();
    }),
    visibility: strictly(async (state: 'hidden' | 'visible') => {
      hidden = state === 'hidden';
      for (const fn of winListeners.get('visibilitychange') ?? []) fn(new Event('visibilitychange'));
      await flush();
    }),
    window: strictly(async (type: Parameters<Rendered['window']>[0], props?: Record<string, unknown>) => {
      const e = new Event(type);
      if (type === 'pageshow') Object.defineProperty(e, 'persisted', { value: true });
      for (const [k, v] of Object.entries(props ?? {})) Object.defineProperty(e, k, { value: v, writable: true });
      for (const fn of winListeners.get(type) ?? []) fn(e);
      await flush();
    }),
  };
}

/** An in-memory `Storage`, e.g. to share `session` between two render() calls. */
export function memoryStorage(): Storage {
  const m = new Map<string, string>();
  return {
    get length() { return m.size; },
    key: (i) => [...m.keys()][i] ?? null,
    getItem: (k) => m.get(k) ?? null,
    setItem: (k, v) => { m.set(k, String(v)); },
    removeItem: (k) => { m.delete(k); },
    clear: () => m.clear(),
  };
}
