// @tiaforge/sinter/testing: compile in memory with the real compiler, mount
// into the test DOM, and drive requests, streams and time deterministically.
// No test-runner imports: works with Vitest or anything else, on jsdom or happy-dom.
import { compileParts } from '../compiler/compile.js';
import { formatDiagnostic } from '../compiler/diagnostics.js';
import type { HelperManifest } from '../compiler/compile.js';
import { mount, type App, type Feature, type Transport } from '../runtime/app.js';
import { config, type Middleware } from '../runtime/config.js';
import type { Env } from '../runtime/env.js';
import { $k } from '../runtime/security.js';
import * as builtins from '../runtime/helpers.js';
import dev from '../dev.js';
import optimistic from '../optimistic.js';
import paginate from '../paginate.js';
import persist from '../persist.js';
import sse from '../sse.js';

const FEATURES: Record<string, Feature> = { dev, sse, optimistic, paginate, persist };

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
  let onEvent: ((name: string, data: string) => void) | null = null;
  let onState: ((s: 'open' | 'error') => void) | null = null;
  let connected = false;
  return {
    get connected() { return connected; },
    emit(name, payload) {
      if (!connected) throw new Error(`mockStream: cannot emit \`${name}\` while disconnected`);
      onEvent?.(name, JSON.stringify(payload ?? null));
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
  /** helper functions, and namespaces as objects of functions */
  helpers?: Record<string, unknown>;
  /** partials for `<sn-include>`, by path relative to the page */
  files?: Record<string, string>;
}

export interface Rendered {
  root: HTMLElement;
  app: App;
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
  /** dispatches pagehide/pageshow/popstate to sinter */
  window(type: 'pagehide' | 'pageshow' | 'popstate'): Promise<void>;
}

interface Timer { id: number; at: number; fn: () => void; kind: string }

let current: App | null = null;
const realSetTimeout = globalThis.setTimeout.bind(globalThis);
const tick = () => new Promise<void>((r) => realSetTimeout(r, 0));
const PAGE = '/test/page.html';

export async function render(html: string, options: RenderOptions = {}): Promise<Rendered> {
  if (current) { current.destroy(); current = null; }

  // compile with the real compiler
  const helpers = options.helpers ?? {};
  const manifest: HelperManifest = { module: null, names: [], namespaces: {} };
  for (const [k, v] of Object.entries(helpers)) {
    if (typeof v === 'function') manifest.names.push(k);
    else if (v && typeof v === 'object') manifest.namespaces[k] = { module: k, members: Object.keys(v) };
  }
  const files = options.files ?? {};
  const parts = compileParts(html, {
    file: PAGE, root: '/test', dev: true, helpers: manifest, moduleSrc: 'about:blank',
    readFile: (p) => {
      const rel = p.startsWith('/test/') ? p.slice('/test/'.length) : p;
      const hit = files[rel] ?? files[`./${rel}`] ?? files[p];
      if (hit === undefined) throw new Error(`no such file: ${p}`);
      return hit;
    },
  });
  const errors = parts.diagnostics.filter((d) => d.severity === 'error');
  if (errors.length) throw new Error(`sinter: build failed\n${errors.map(formatDiagnostic).join('\n')}`);

  // function table, with helpers and namespace members in scope
  const names: string[] = ['$k'];
  const values: unknown[] = [$k];
  for (const h of parts.helpers.builtin) { names.push(h); values.push((builtins as Record<string, unknown>)[h]); }
  for (const h of parts.helpers.user) { names.push(h); values.push(helpers[h]); }
  for (const [ns, members] of Object.entries(parts.namespaces)) {
    for (const m of members) { names.push(`${ns}$${m}`); values.push((helpers[ns] as Record<string, unknown>)[m]); }
  }
  // eslint-disable-next-line no-new-func -- tests only; pages load a compiled module
  const fns = new Function(...names, `"use strict"; return [\n${parts.fns.join(',\n')}\n];`)(...values);

  // the page
  const doc = document;
  const inner = /<html[^>]*>([\s\S]*)<\/html>/i.exec(parts.html)?.[1] ?? parts.html;
  doc.documentElement.innerHTML = inner.replace(/<script type="module" src="about:blank"><\/script>/, '');

  // environment: fake clock, recorded navigation, in-memory storage
  let now = options.now instanceof Date ? options.now.getTime() : options.now ?? Date.parse('2026-01-01T09:00:00Z');
  let href = options.url ? new URL(options.url, 'http://localhost/').href : 'http://localhost/';
  const timers: Timer[] = [];
  let nextTimer = 1;
  const navigations: string[] = [];
  const store = memoryStorage(), session = memoryStorage();
  const winListeners = new Map<string, Set<(e: Event) => void>>();
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
    replaceState: (url) => { href = new URL(url, href).href; },
    random: () => 0.5,
    listen: (type, fn) => {
      if (!winListeners.has(type)) winListeners.set(type, new Set());
      winListeners.get(type)!.add(fn);
      return () => winListeners.get(type)?.delete(fn);
    },
  };
  config.env = env;
  if (options.locale !== undefined) {
    let locale = options.locale;
    config.locale = { get: () => locale, set: (l) => { locale = l; } };
  }

  const requests = options.requests;
  const app = mount(doc, {
    ir: parts.ir, fns, env,
    features: parts.features.map((f) => FEATURES[f]!),
    request: [...config.request, ...(requests ? [requests] : [])],
    transport: (url) => {
      const path = new URL(url, href).pathname;
      const stream = options.streams?.[url] ?? options.streams?.[path];
      if (!stream) throw new Error(`no mock stream for ${url}; pass \`streams: { '${url}': mockStream() }\``);
      return stream.transport();
    },
  });
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
      const debounce = timers.filter((t) => t.kind === 'debounce').sort((a, b) => a.at - b.at)[0];
      if (debounce) { runDue(debounce.at, new Set(['debounce'])); continue; }
      if (app.req.inflight > 0 || app.busy > 0 || app.isDirty) continue;
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

  await flush();
  return {
    root: doc.body, app, flush, settle, advance, navigations,
    url: () => href,
    window: async (type) => {
      const e = new Event(type);
      if (type === 'pageshow') Object.defineProperty(e, 'persisted', { value: true });
      for (const fn of winListeners.get(type) ?? []) fn(e);
      await flush();
    },
  };
}

function memoryStorage(): Storage {
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
