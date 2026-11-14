// @tiaforge-ui/sinter/testing: compile in memory with the real compiler, mount
// into the test DOM, and drive requests, streams and time deterministically.
// No test-runner imports: works with Vitest or anything else, on jsdom or happy-dom.
import { compileParts } from '../compiler/compile.js';
import { earlyPage } from '../compiler/index.js';
import { formatDiagnostic } from '../compiler/diagnostics.js';
import { apiOrigins, resolveApis, type ApiOptions, type ApisDef } from '../compiler/apis.js';
import type { OpenApiSpec } from '../compiler/openapi.js';
import { compactIR } from '../ir.js';
import type { CompiledParts, HelperManifest } from '../compiler/compile.js';
import * as earlyExports from '../early.js';
import { early as runEarly } from '../early.js';
import { t as message, use as useMessages } from '../messages.js';
import { mount, scopeState, type App, type Feature, type Transport } from '../runtime/app.js';
import { config, type Middleware } from '../runtime/config.js';
import type { Env } from '../runtime/env.js';
import { $k } from '../runtime/security.js';
import * as builtins from '../runtime/helpers.js';
import { remote, resolveRemote, type RemoteImages } from '../remote.js';
import cache from '../cache.js';
import refresh from '../refresh.js';
import versions from '../versions.js';
import dev from '../dev.js';
import optimistic from '../optimistic.js';
import paginate from '../paginate.js';
import each from '../each.js';
import persist from '../persist.js';
import listbox from '../listbox.js';
import keys from '../keys.js';
import apply from '../apply.js';
import transition from '../transition.js';
import fields from '../fields.js';
import form from '../form.js';
import select from '../select.js';
import location from '../location.js';
import typing from '../typing.js';
import queryLinks from '../query-links.js';
import call from '../call.js';
import debounce from '../debounce.js';
import components from '../components.js';
import nested from '../nested.js';
import defs from '../defs.js';
import confirm from '../confirm.js';
import models from '../models.js';
import sse from '../sse.js';
import { lists, prefetch, type PrefetchPage } from '../prefetch.js';
import { pagePaths } from '../prefetch-build.js';

const FEATURES: Record<string, Feature> = { components, nested, defs, dev, sse, optimistic, paginate, persist, cache, versions, refresh, each, listbox, keys, apply, fields, form, select, location, typing, 'query-links': queryLinks, call, debounce, confirm, models, transition };

// ---- requests

export type RouteResponse =
  | ((call: RecordedCall) => unknown)
  | { status: number; body?: unknown; headers?: Record<string, string> }
  | object | string | number | boolean | null;

export interface RecordedCall {
  method: string;
  url: string;
  path: string;
  body: unknown;
  headers: Record<string, string>;
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
export function mockRequests(routes: Record<string, RouteResponse>): MockRequests {
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
    const route = table.find((r) => r.method === req.method && (r.path.includes('?') ? r.path === call.url : r.path === url.pathname));
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
          const v = typeof route.value === 'function' ? await (route.value as (c: RecordedCall) => unknown)(call) : route.value;
          resolve(toResponse(structuredClone(v)));
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
  /** action functions for `data-sn-call` and `<sn-resource call>`, and namespaces as objects of functions */
  actions?: Record<string, unknown>;
  /** other files the page reads, by path relative to the page (`src/components/x-y.html`) */
  files?: Record<string, string>;
  /** the app's components, by name: `{ 'article-preview': '<template data-sn-component="…">…</template>' }` */
  components?: Record<string, string>;
  /** the app's layouts, by name: `{ 'app-layout': '<!doctype html><html data-sn-layout="{ title: string }">…</html>' }`; the page is the layout's tag */
  layouts?: Record<string, string>;
  /** the scripts of components, by name: the module (`await import('../src/components/task-ring.ts')`) or the class */
  scripts?: Record<string, unknown>;
  /** localStorage and sessionStorage (default: empty ones); pass the previous page's to test what carries over */
  storage?: Storage;
  session?: Storage;
  /**
   * built-in messages, as the message files hold them: `{ en: { nav_mail: 'Mail' }, de: { … } }`,
   * the base language first. `m.key()` in the page reads them; the locale is `locale`, else the
   * stored choice (`locale` in `storage`), else the base; `$locale = 'de'` switches.
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
  /** an OpenAPI 3 document (parsed), as `sinter({ openapi })` gives the compiler: types resources and actions, and write-through knows the entities */
  openapi?: unknown;
  /**
   * the app's APIs, as `sinter({ apis })` (docs/apis.md), each spec a parsed OpenAPI 3 document: paths
   * on the page are relative to them, and requests carry their credentials and headers
   */
  apis?: Record<string, Omit<ApiOptions, 'openapi'> & { openapi?: unknown }>;
  defaultApi?: string;
  /** images from the API, as `sinter({ images: { remote } })`: a bound `<img src>` gets the service's `srcset` */
  remoteImages?: RemoteImages;
  /** the page's stylesheets, for the boxes of its images and the space of its lists (as the Vite plugin reads them from the page) */
  css?: string;
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
  /** URLs sinter tried to navigate to */
  navigations: string[];
  /** current page URL (after `$url` writes) */
  url(): string;
  /** the page's history entries (pushed by `$url` writes; a navigation adds none), oldest first */
  history(): string[];
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
export async function firstPaint(html: string, options: Pick<RenderOptions, 'helpers' | 'files' | 'components' | 'storage' | 'messages' | 'locale'> & FirstPaintTestOptions = {}): Promise<{ root: HTMLElement; html: string }> {
  if (current) { current.destroy(); current = null; }
  const { files, components } = options;
  const helpers = withMessages(options);
  const { parts } = compilePage(html, { helpers, ...(files ? { files } : {}), ...(components ? { components } : {}), firstPaint: true });
  writePage(parts.html, options.messages);
  const env = config.env;
  config.env = { ...env, storage: () => options.storage ?? null };
  if (options.messages) { config.locale = null; useMessages(); }
  try { paint(parts, helpers, options.early); } finally { config.env = env; }
  return { root: document.body, html: parts.html };
}

/**
 * Built-in messages: the shared state the picker and a language file would leave (locale picked
 * from `locale`, else the stored choice, else the base), and `m` as a helper namespace.
 */
function withMessages(o: Pick<RenderOptions, 'helpers' | 'messages' | 'locale' | 'storage'>): Record<string, unknown> {
  if (!o.messages) return o.helpers ?? {};
  const locales = Object.keys(o.messages), base = locales[0]!;
  let stored: string | null = null;
  try { stored = o.storage?.getItem('locale') ?? null; } catch { /* none */ }
  const locale = o.locale ?? (stored && locales.includes(stored) ? stored : base);
  (globalThis as any)[Symbol.for('sinter.i18n')] = { locale, base, locales, storage: 'locale', files: {}, dicts: structuredClone(o.messages) };
  document.documentElement.lang = locale;
  return { ...o.helpers, m: Object.fromEntries(Object.keys(o.messages[base]!).map((k) => [k, (p?: Record<string, unknown>) => message(k, p)])) };
}

/** The early chunk: the app's early module, then the early bindings with the helpers in scope. */
function paint(parts: CompiledParts, helpers: Record<string, unknown>, app?: () => void) {
  app?.();
  if (!parts.early) return;
  const names: string[] = ['$k'], values: unknown[] = [$k];
  for (const h of parts.early.helpers) { names.push(h); values.push(helpers[h]); }
  for (const [ns, members] of Object.entries(parts.early.namespaces)) {
    for (const m of members) { names.push(`${ns}$${m}`); values.push((helpers[ns] as Record<string, unknown>)[m]); }
  }
  // the compiled renderer, as the early file has it, with the early module's exports it calls
  const page = earlyPage(parts.early);
  for (const u of page.uses) { names.push(u); values.push((earlyExports as Record<string, unknown>)[u]); }
  // eslint-disable-next-line no-new-func -- tests only; pages load a compiled module
  const made = new Function(...names, `"use strict"; const f = [\n${parts.early.fns.join(',\n')}\n]; return ${page.code};`)(...values);
  runEarly(document, made);
}

function compilePage(html: string, options: RenderOptions): { parts: CompiledParts; manifest: HelperManifest; actions: Record<string, unknown>; apis: ApisDef | null } {
  const helpers = options.helpers ?? {};
  const manifest: HelperManifest = { module: null, names: [], namespaces: {} };
  for (const [k, v] of Object.entries(helpers)) {
    if (typeof v === 'function') manifest.names.push(k);
    else if (v && typeof v === 'object') manifest.namespaces[k] = { module: k, members: Object.keys(v) };
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
  for (const name of Object.keys(options.scripts ?? {})) files[`src/components/${name}.ts`] ??= 'export default class {}';
  const apis = options.apis ? testApis(options) : null;
  const parts = compileParts(html, {
    file: PAGE, root: '/test', dev: true, helpers: manifest, actions: actionManifest, moduleSrc: 'about:blank', componentNames: Object.keys(options.components ?? {}),
    // lazy packages: any name, loaded by nothing (a test calls the app's functions, which import what they need)
    lazy: true,
    readFile: (p) => {
      const rel = p.startsWith('/test/') ? p.slice('/test/'.length) : p;
      const hit = files[rel] ?? files[`./${rel}`] ?? files[p];
      if (hit === undefined) throw new Error(`no such file: ${p}`);
      return hit;
    },
    // compiled as a build does (both passes: build-time constants, decided branches, unrolled loops); `firstPaint` runs the early chunk
    prerender: true, ...(options.firstPaint ? { early: { module: null } } : {}),
    ...(apis ? { openapi: apis.specs, apis: apis.apis } : options.openapi ? { openapi: [{ file: 'openapi.yml', doc: options.openapi }] } : {}),
    ...(options.remoteImages ? { remoteImages: resolveRemote(options.remoteImages) } : {}),
    // static images stay as written in tests (no files to encode); the stylesheets size bound ones
    ...(options.css ? { images: { info: () => null, url: () => '', styles: [{ file: 'test.css', css: options.css }] } } : {}),
    // and hold the space of lists whose data comes later (the rules are the build's; the test reads the placeholder)
    ...(options.css ? { styles: [{ file: 'test.css', css: options.css }], paintCss: 'paint.css' } : {}),
  });
  const errors = parts.diagnostics.filter((d) => d.severity === 'error');
  if (errors.length) throw new Error(`sinter: build failed\n${errors.map(formatDiagnostic).join('\n')}`);
  return { parts, manifest, actions, apis: apis?.apis ?? null };
}

/** `apis` of the render options, resolved as the project resolves `sinter({ apis })`; an invalid one throws. */
function testApis(options: RenderOptions): { specs: OpenApiSpec[]; apis: ApisDef | null } {
  const specs: OpenApiSpec[] = [];
  const r = resolveApis({ apis: options.apis as Record<string, ApiOptions>, ...(options.defaultApi ? { defaultApi: options.defaultApi } : {}) },
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
  // as the picker script does: <html lang> is the picked locale
  if (messages) top.lang = (globalThis as any)[Symbol.for('sinter.i18n')].locale;
}

export async function render(html: string, options: RenderOptions = {}): Promise<Rendered> {
  if (current) { current.destroy(); current = null; }

  // compile with the real compiler
  const helpers = withMessages(options);
  const { parts, actions, apis } = compilePage(html, { ...options, helpers });
  // the page module's `$apis`: each API's base, credentials and headers
  config.apis = apis?.list.map((a) => ({ n: a.name, b: a.base, ...(a.credentials ? { c: a.credentials } : {}), ...(a.headers ? { h: a.headers } : {}) })) ?? [];
  // and their origins join the allowlist, as the page module's `$origins` does
  if (apis) config.origins = [...new Set([...config.origins, ...apiOrigins(apis)])];

  // function table, with helpers and namespace members in scope
  const names: string[] = ['$k'];
  const values: unknown[] = [$k];
  for (const h of parts.helpers.builtin) { names.push(h); values.push((builtins as Record<string, unknown>)[h]); }
  for (const h of parts.helpers.user) { names.push(h); values.push(helpers[h]); }
  for (const [ns, members] of Object.entries(parts.namespaces)) {
    for (const m of members) { names.push(`${ns}$${m}`); values.push((helpers[ns] as Record<string, unknown>)[m]); }
  }
  for (const c of parts.calls) {
    const [a, b] = c.split('.') as [string, string | undefined];
    names.push(`$a$${c.replace('.', '$')}`);
    values.push(b === undefined ? actions[a] : (actions[a] as Record<string, unknown>)[b]);
  }
  if (parts.remote) { names.push('$ri'); values.push(remote(parts.remote)); }
  for (const x of parts.lazy) { names.push(x.local); values.push(() => Promise.resolve()); }
  for (const x of parts.scripts) {
    const m = options.scripts?.[x.name];
    names.push(x.local);
    // the class: given itself, or the module's export the compiler found (testing's files are empty, so: the module's one class)
    const mod = m as Record<string, unknown> | undefined;
    values.push(typeof m === 'function' ? m : mod?.[x.export] ?? mod?.default ?? Object.values(mod ?? {}).find((v) => typeof v === 'function'));
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
  let at = 0;
  const timers: Timer[] = [];
  let nextTimer = 1;
  const navigations: string[] = [];
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
    fetch: (req) => Promise.reject(new Error(`unexpected network request: ${req.method} ${req.url}; pass \`requests: mockRequests({...})\``)),
    storage: () => store,
    session: () => session,
    href: () => href,
    replaceState: (url) => { href = entries[at] = new URL(url, href).href; },
    // a push drops the entries after the current one, as a browser's history does
    pushState: (url) => { href = new URL(url, href).href; entries.splice(++at, Infinity, href); },
    fragment: (hash) => { href = entries[at] = new URL(hash, href).href; },
    // the test's simulated events are the user's; the custom events sinter dispatches are not
    trusted: (e) => !(e instanceof CustomEvent),
    random: () => 0.5,
    hidden: () => hidden,
    ...(options.frames ? { frame: (fn: () => void) => { frameQueue.push(fn); } } : {}),
    listen: (type, fn) => {
      if (!winListeners.has(type)) winListeners.set(type, new Set());
      winListeners.get(type)!.add(fn);
      return () => winListeners.get(type)?.delete(fn);
    },
  };
  config.env = env;
  if (options.firstPaint) {
    const fp = options.firstPaint === true ? {} : options.firstPaint;
    if (options.messages) { config.locale = null; useMessages(); }
    paint(parts, helpers, fp.early);
    fp.afterEarly?.();
  }
  if (options.messages) {
    // sinter's messages are the locale source, as in a built page
    config.locale = null;
    useMessages();
  } else if (options.locale !== undefined) {
    let locale = options.locale;
    config.locale = { get: () => locale, set: (l) => { locale = l; } };
  }

  // next-page data: the other pages described as the build describes them
  const ahead: PrefetchPage[] = [];
  for (const [rel, page] of Object.entries(options.pages ?? {})) {
    const { parts: { prefetch: other } } = compilePage(page, { ...options, firstPaint: undefined });
    if (!other) continue;
    const ns = Object.entries(other.namespaces).flatMap(([n, ms]) => ms.map((m) => [`${n}$${m}`, (helpers[n] as Record<string, unknown>)[m]] as const));
    // eslint-disable-next-line no-new-func -- tests only; pages load a compiled module
    const f = new Function('$k', ...other.helpers, ...ns.map(([k]) => k), `"use strict"; return [\n${other.fns.join(',\n')}\n];`)($k, ...other.helpers.map((h) => helpers[h]), ...ns.map(([, v]) => v));
    ahead.push({ m: pagePaths(rel, '/', other.path), r: other.res, f, ...(other.a ? { a: other.a } : {}) });
  }

  const requests = options.requests;
  const app = mount(doc, {
    // the IR as the page module carries it
    ir: compactIR(parts.ir), fns, env,
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
  });
  current = app;
  if (options.messages) useMessages(app);

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
  return {
    root: doc.body, app, state, flush, settle, advance, navigations,
    url: () => href,
    history: () => [...entries],
    back: () => go(-1),
    forward: () => go(1),
    frame: async () => {
      for (let j = 0; j < 10; j++) await Promise.resolve();
      for (const fn of frameQueue.splice(0)) fn();
      check();
    },
    visibility: async (state) => {
      hidden = state === 'hidden';
      for (const fn of winListeners.get('visibilitychange') ?? []) fn(new Event('visibilitychange'));
      await flush();
    },
    window: async (type, props) => {
      const e = new Event(type);
      if (type === 'pageshow') Object.defineProperty(e, 'persisted', { value: true });
      for (const [k, v] of Object.entries(props ?? {})) Object.defineProperty(e, k, { value: v, writable: true });
      for (const fn of winListeners.get(type) ?? []) fn(e);
      await flush();
    },
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
