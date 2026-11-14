// `sinter render page.html`: the testing module's render() on the command line. The page is compiled with the
// project's files and modules, mounted on a simulated DOM (jsdom), its requests answered by mocks or sent to a
// backend, then driven by steps (click, input, select, back, wait), and what happened is printed: the requests
// with their headers and statuses, the rendered markup, each resource's state, history writes and warnings.
// For coding agents: a page's data and behaviour, checked in one command, without a browser.
import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { format } from 'node:util';
import { formatDiagnostic } from './compiler/index.js';
import { componentBase } from './components-build.js';
import { pagePaths } from './page-paths.js';
import { project as readProject, viteProject } from './project.js';
import type { HistoryWrite, MockStream, RecordedCall, Rendered, RouteResponse } from './testing/index.js';

export const RENDER_USAGE = `usage: sinter render <page.html> [options] [steps]
  --root <dir>            the project (default: the current directory)
  --url <url>             the page's URL, for $url and path parameters (default: the page's own path)
  --api <file.json>       mock responses: { "GET /api/me": { "user": … }, "GET /api/x/3": { "status": 404 } }
  --api <http://host>     sends the requests no mock answers to this backend (both may be given)
  --storage <key=value>   a localStorage entry (repeatable); --session for sessionStorage
  --now <date>            sinter's clock (default 2026-01-01T09:00:00Z)
  --locale <tag>          the page's language
  --show <selector>       print only this part of the page
  --raw                   print the rendered markup as the DOM has it, not indented
  --json                  the report as JSON
steps, run in order after loading, each followed by what changed:
  --click <selector>      --input <selector>=<text>      --select <selector>=<value>
  --check <selector>      --submit <selector>            --back      --forward      --wait <ms|5s>
  --emit <event>=<json>   a server event on the page's streams (<sn-sync>)`;

export type Step =
  | { kind: 'click' | 'check' | 'submit'; selector: string }
  | { kind: 'input' | 'select'; selector: string; value: string }
  | { kind: 'back' }
  | { kind: 'forward' }
  | { kind: 'wait'; ms: number }
  | { kind: 'emit'; name: string; payload: unknown };

export interface RenderArgs {
  page: string;
  root: string;
  url: string | null;
  mocks: string[];
  backends: string[];
  storage: Array<[string, string]>;
  session: Array<[string, string]>;
  now: number | null;
  locale: string | null;
  show: string | null;
  raw: boolean;
  json: boolean;
  steps: Step[];
}

/** `<selector>=<value>`: the selector ends at the first `=` outside brackets, quotes and parentheses. */
export function splitAssignment(s: string): [string, string] | null {
  let depth = 0, quote = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (quote) { if (c === '\\') i++; else if (c === quote) quote = ''; continue; }
    if (c === '"' || c === "'") quote = c;
    else if (c === '[' || c === '(') depth++;
    else if (c === ']' || c === ')') depth--;
    else if (c === '=' && depth === 0 && i > 0) return [s.slice(0, i), s.slice(i + 1)];
  }
  return null;
}

export function duration(s: string): number | null {
  const m = /^(\d+(?:\.\d+)?)(ms|s|m)?$/.exec(s.trim());
  if (!m) return null;
  return Math.round(Number(m[1]) * (m[2] === 's' ? 1000 : m[2] === 'm' ? 60_000 : 1));
}

export function parseRenderArgs(argv: string[], cwd = process.cwd()): RenderArgs | string {
  const a: RenderArgs = { page: '', root: cwd, url: null, mocks: [], backends: [], storage: [], session: [], now: null, locale: null, show: null, raw: false, json: false, steps: [] };
  const pages: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]!;
    const [name, inline] = flag.startsWith('--') && flag.includes('=') && !/^--(input|select|storage|session)=/.test(flag) ? [flag.slice(0, flag.indexOf('=')), flag.slice(flag.indexOf('=') + 1)] : [flag, undefined];
    const value = (): string | null => inline ?? argv[++i] ?? null;
    const need = (v: string | null) => { if (v === null || v === '') throw `${name} needs a value`; return v; };
    try {
      switch (name) {
        case '--root': a.root = resolve(cwd, need(value())); break;
        case '--url': a.url = need(value()); break;
        case '--api': {
          const v = need(value());
          (/^https?:\/\//.test(v) ? a.backends : a.mocks).push(v);
          break;
        }
        case '--storage': case '--session': {
          const v = need(value()), eq = v.indexOf('=');
          if (eq <= 0) throw `${name} takes key=value, such as ${name} token=abc`;
          (name === '--storage' ? a.storage : a.session).push([v.slice(0, eq), v.slice(eq + 1)]);
          break;
        }
        case '--now': {
          const v = need(value()), t = /^\d+$/.test(v) ? Number(v) : Date.parse(v);
          if (Number.isNaN(t)) throw `--now takes a date, such as 2026-03-01T12:00:00Z`;
          a.now = t;
          break;
        }
        case '--locale': a.locale = need(value()); break;
        case '--show': a.show = need(value()); break;
        case '--raw': a.raw = true; break;
        case '--json': a.json = true; break;
        case '--click': case '--check': case '--submit': a.steps.push({ kind: name.slice(2) as 'click', selector: need(value()) }); break;
        case '--input': case '--select': {
          const v = need(value()), kv = splitAssignment(v);
          if (!kv) throw `${name} takes <selector>=<value>, such as ${name} "#q=${name === '--input' ? 'milk' : 'open'}"`;
          a.steps.push({ kind: name.slice(2) as 'input', selector: kv[0], value: kv[1] });
          break;
        }
        case '--emit': {
          const v = need(value()), eq = v.indexOf('=');
          const name = eq < 0 ? v : v.slice(0, eq);
          let payload: unknown = null;
          if (eq >= 0) { try { payload = JSON.parse(v.slice(eq + 1)); } catch { throw `--emit ${name}=…: the payload is JSON, such as --emit 'contact_updated={"contact":{"id":1}}'`; } }
          a.steps.push({ kind: 'emit', name, payload });
          break;
        }
        case '--back': a.steps.push({ kind: 'back' }); break;
        case '--forward': a.steps.push({ kind: 'forward' }); break;
        case '--wait': {
          const ms = duration(need(value()));
          if (ms === null) throw '--wait takes a duration: 500, 500ms, 5s or 1m';
          a.steps.push({ kind: 'wait', ms });
          break;
        }
        default:
          if (flag.startsWith('--')) throw `unknown option ${flag}`;
          pages.push(flag);
      }
    } catch (e) {
      if (typeof e === 'string') return e;
      throw e;
    }
  }
  if (pages.length !== 1) return pages.length ? `one page at a time (got ${pages.join(', ')})` : 'which page? such as sinter render index.html';
  a.page = resolve(a.root, pages[0]!);
  return a;
}

// ---- the DOM

/** jsdom's window as the globals the runtime and the testing module use, as Vitest's jsdom environment sets them. */
export async function installDom(url: string): Promise<() => void> {
  // (jsdom ships no types; the package needs none of them)
  type Dom = { window: Window & { close(): void } };
  let JSDOM: new (html: string, o: object) => Dom;
  try { ({ JSDOM } = await import('jsdom' as string) as { JSDOM: typeof JSDOM }); } catch {
    throw new Error('sinter render runs the page on jsdom: install it in the project (npm install -D jsdom)');
  }
  const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', { url, pretendToBeVisual: true });
  const win = dom.window as unknown as Record<string, unknown>;
  const g = globalThis as Record<string, unknown>;
  // Node's own fetch, streams, timers and AbortController stay: Request and fetch need Node's
  const keep = new Set(['undefined', 'globalThis', 'global', 'console', 'process', 'fetch', 'Request', 'Response', 'Headers', 'FormData', 'Blob', 'File', 'URL', 'URLSearchParams',
    'AbortController', 'AbortSignal', 'TextEncoder', 'TextDecoder', 'ReadableStream', 'WritableStream', 'TransformStream', 'structuredClone', 'setTimeout', 'clearTimeout',
    'setInterval', 'clearInterval', 'queueMicrotask', 'performance', 'crypto', 'atob', 'btoa', 'WebSocket', 'BroadcastChannel', 'MessageChannel', 'MessagePort']);
  // jsdom's events: its dispatchEvent takes only its own
  const replace = new Set(['Event', 'CustomEvent', 'EventTarget', 'DOMException']);
  const set: Array<[string, PropertyDescriptor | undefined]> = [];
  for (const key of Object.getOwnPropertyNames(win)) {
    if (keep.has(key) || key.startsWith('_') || (key in g && !replace.has(key))) continue;
    set.push([key, Object.getOwnPropertyDescriptor(g, key)]);
    const v = win[key];
    Object.defineProperty(g, key, { value: typeof v === 'function' && !/^[A-Z]/.test(key) ? (v as (...a: unknown[]) => unknown).bind(dom.window) : v, configurable: true, writable: true });
  }
  for (const key of ['window', 'self', 'top', 'parent']) {
    set.push([key, Object.getOwnPropertyDescriptor(g, key)]);
    Object.defineProperty(g, key, { value: dom.window, configurable: true, writable: true });
  }
  return () => {
    for (const [k, d] of set.reverse()) { if (d) Object.defineProperty(g, k, d); else delete g[k]; }
    dom.window.close();
  };
}

// ---- the app's modules

const SHARED = Symbol.for('sinter.render.shared');

/** This package's own module for an import of `@tiaforge-ui/sinter` (`''`) or a subpath (`'retry'`), beside this file. */
async function ownModule(sub: string): Promise<Record<string, unknown>> {
  // (paths, not URL objects: a simulated DOM may have replaced the global URL)
  const here = dirname(fileURLToPath(import.meta.url)), ext = import.meta.url.endsWith('.ts') ? '.ts' : '.js';
  const name = sub || 'index';
  for (const f of [`${name}${ext}`, `${name}/index${ext}`]) {
    const file = resolve(here, f);
    if (existsSync(file)) return import(pathToFileURL(file).href) as Promise<Record<string, unknown>>;
  }
  throw new Error(`no module @tiaforge-ui/sinter/${sub}`);
}

/** The app's modules loaded with Vite (TypeScript, the app's imports); without Vite, plain JavaScript with Node. */
export async function appLoader(root: string): Promise<{ load(file: string): Promise<Record<string, unknown>>; close(): Promise<void> }> {
  let vite: typeof import('vite') | null = null;
  try { vite = await import('vite'); } catch { /* none: JavaScript only */ }
  if (!vite) return { load: (f) => import(pathToFileURL(f).href) as Promise<Record<string, unknown>>, close: async () => {} };
  const shared: Record<string, Record<string, unknown>> = ((globalThis as Record<symbol, unknown>)[SHARED] ??= {}) as never;
  // the app's `@tiaforge-ui/sinter` is this one, so `configure()` in its config module configures the page rendered here
  const plugin: import('vite').Plugin = {
    name: 'sinter-render-shared',
    enforce: 'pre',
    resolveId(id, importer) {
      const m = /^@tiaforge-ui\/sinter(?:\/(.+))?$/.exec(id);
      if (m) return `\0sinter-shared:${m[1] ?? ''}`;
      // a component's script imports its base class from its HTML file, as the Vite plugin gives it
      if (importer && id.endsWith('.html') && !importer.endsWith('.html')) {
        const file = resolve(dirname(importer.replace(/[?#].*$/, '')), id);
        if (dirname(file) === resolve(root, 'src/components')) return `\0sinter-base:${basename(file, '.html')}`;
      }
      return null;
    },
    async load(id) {
      if (id.startsWith('\0sinter-base:')) return componentBase(id.slice('\0sinter-base:'.length));
      if (!id.startsWith('\0sinter-shared:')) return null;
      const sub = id.slice('\0sinter-shared:'.length);
      const mod = shared[sub] ??= await ownModule(sub);
      const names = Object.keys(mod).filter((k) => k !== 'default' && /^[A-Za-z_$][\w$]*$/.test(k));
      const get = `globalThis[Symbol.for('sinter.render.shared')][${JSON.stringify(sub)}]`;
      return `const m = ${get};\n${names.map((n) => `export const ${n} = m.${n};`).join('\n')}\n${'default' in mod ? 'export default m.default;' : ''}`;
    },
  };
  const server = await vite.createServer({
    root, configFile: false, logLevel: 'silent', appType: 'custom', plugins: [plugin],
    server: { middlewareMode: true, hmr: false, watch: null, ws: false },
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  return { load: (f) => server.ssrLoadModule(f) as Promise<Record<string, unknown>>, close: () => server.close() };
}

// ---- requests

interface Logged { call: RecordedCall; href: string; source: 'mock' | 'backend' | 'unmatched'; error?: string; step: number }

function readMocks(files: string[], root: string): Record<string, RouteResponse> {
  const routes: Record<string, RouteResponse> = {};
  for (const f of files) {
    const file = resolve(root, f);
    let data: unknown;
    try { data = JSON.parse(readFileSync(file, 'utf8')); } catch (e) { throw new Error(`--api ${f}: ${(e as Error).message}`); }
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error(`--api ${f}: an object of routes, such as { "GET /api/me": { "user": { "name": "Ada" } } }`);
    for (const [k, v] of Object.entries(data)) {
      if (!/^[A-Z]+\s+\S+$/.test(k.trim())) throw new Error(`--api ${f}: \`${k}\` is not a route: write the method and path, such as "GET /api/me"`);
      routes[k] = v as RouteResponse;
    }
  }
  return routes;
}

async function forward(backend: string, req: Request): Promise<Response> {
  const u = new URL(req.url), target = new URL(u.pathname + u.search, backend.replace(/\/*$/, '/'));
  const headers = new Headers(req.headers);
  headers.delete('host');
  const body = req.method === 'GET' || req.method === 'HEAD' ? undefined : await req.clone().arrayBuffer();
  const res = await fetch(target, { method: req.method, headers, ...(body ? { body } : {}), redirect: 'manual' });
  // as a fresh response: the page reads it in the simulated DOM's realm
  return new Response(res.status === 204 || res.status === 304 ? null : await res.arrayBuffer(), { status: res.status, statusText: res.statusText, headers: res.headers });
}

// ---- the report

export interface ResourceReport { name: string; loading: boolean; error: unknown; value: unknown; hint?: string }

export interface StepReport {
  step: string;
  requests: RequestReport[];
  history: HistoryWrite[];
  navigations: string[];
  changed: string[];
  resources: ResourceReport[];
  error?: string;
}

export interface RequestReport { method: string; url: string; headers: Record<string, string>; body?: unknown; status: number | null; source: Logged['source']; error?: string }

export interface RenderReport {
  page: string;
  paths: string[];
  url: string;
  urlMatches: boolean;
  requests: RequestReport[];
  rendered: string;
  resources: ResourceReport[];
  history: HistoryWrite[];
  navigations: string[];
  warnings: string[];
  /** what the page and the app's modules wrote to the console (other than the warnings) */
  console: string[];
  steps: StepReport[];
}

const SKIP_HEADERS = new Set(['accept']);

function requestReport(l: Logged, origin: string): RequestReport {
  const u = new URL(l.call.url, 'http://x');
  const shown = new URL(l.href).origin !== origin ? l.href : u.pathname + u.search;
  const headers = Object.fromEntries(Object.entries(l.call.headers).filter(([k]) => !SKIP_HEADERS.has(k)));
  return { method: l.call.method, url: shown, headers, ...(l.call.body != null ? { body: l.call.body instanceof FormData ? '(form data)' : l.call.body } : {}), status: l.call.status ?? null, source: l.source, ...(l.error ? { error: l.error } : {}) };
}

/** A path pattern (`/incidents/:id`) or a page path matches the URL's path. */
export function pathMatches(patterns: string[], path: string): boolean {
  return patterns.some((p) => {
    const a = p.split('/'), b = path.split('/');
    return a.length === b.length && a.every((s, i) => (s[0] === ':' ? b[i] !== '' : s === b[i]));
  });
}

/** The element tree as indented markup: one element a line, its text inline, comments and scripts left out. */
export function formatHtml(root: Element): string {
  const out: string[] = [];
  // `data-sn`: the runtime's id of a bound element, nothing the page's author wrote
  const attr = (name: string, value: string) => (value === '' ? ` ${name}` : ` ${name}="${value.replace(/"/g, '&quot;')}"`);
  // a control as it is now: its value and checked state are properties, which the attributes do not follow
  const attrs = (el: Element) => {
    const f = el as HTMLInputElement, control = /^(input|select|textarea)$/i.test(el.tagName), box = control && (f.type === 'checkbox' || f.type === 'radio');
    const list = [...el.attributes].filter((a) => a.name !== 'data-sn' && !(control && (a.name === 'value' || a.name === 'checked'))).map((a) => attr(a.name, a.value));
    if (control && !box && el.tagName !== 'TEXTAREA' && (f.value !== '' || el.hasAttribute('value'))) list.push(attr('value', f.value));
    if (box && el.hasAttribute('value')) list.push(attr('value', f.value));
    if (box && f.checked) list.push(' checked');
    return list.join('');
  };
  const text = (s: string) => s.replace(/\s+/g, ' ').trim();
  const VOID = /^(area|base|br|col|embed|hr|img|input|link|meta|source|track|wbr)$/i;
  const walk = (el: Element, depth: number) => {
    const tag = el.tagName.toLowerCase(), pad = '  '.repeat(depth), open = `<${tag}${attrs(el)}>`;
    if (tag === 'script' || tag === 'style') return;
    if (VOID.test(tag)) { out.push(pad + open); return; }
    // a template's content is not on the page: what it renders (rows, a branch) is its siblings
    if (tag === 'template') return;
    const kids = [...el.childNodes].filter((n) => n.nodeType === 1 || (n.nodeType === 3 && text(n.textContent ?? '')));
    if (kids.every((n) => n.nodeType === 3)) { out.push(`${pad}${open}${text(el.textContent ?? '')}</${tag}>`); return; }
    out.push(pad + open);
    for (const n of kids) {
      if (n.nodeType === 3) out.push('  '.repeat(depth + 1) + text(n.textContent ?? ''));
      else walk(n as Element, depth + 1);
    }
    out.push(`${pad}</${tag}>`);
  };
  walk(root, 0);
  return out.join('\n');
}

/** The lines of `after` that are not in `before` (`+`) and the reverse (`-`), in order (a longest common subsequence). */
export function lineDiff(before: string, after: string): string[] {
  const a = before.split('\n'), b = after.split('\n');
  if (a.length * b.length > 4_000_000) return before === after ? [] : ['(the page changed; too large to compare line by line)'];
  const n = a.length, m = b.length, dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
  const out: string[] = [];
  let i = 0, j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) { i++; j++; }
    else if (i < n && (j >= m || dp[i + 1]![j]! >= dp[i]![j + 1]!)) out.push('- ' + a[i++]);
    else out.push('+ ' + b[j++]);
  }
  return out;
}

function resources(r: Rendered): ResourceReport[] {
  const page = r.app.page as { $r: Record<string, unknown>; $meta: Record<string, { loading: boolean; error: unknown }> };
  return r.app.ir.resources.map((def) => {
    const meta = page.$meta[def.name], value = page.$r[def.name];
    const rep: ResourceReport = { name: def.name, loading: !!meta?.loading, error: meta?.error ?? null, value };
    // the response's wrapper stored as the value: `{ incident: {…} }` where the page reads `incident.title`
    if (!def.items && value && typeof value === 'object' && !Array.isArray(value)) {
      const keys = Object.keys(value);
      const only = keys.length === 1 ? (value as Record<string, unknown>)[keys[0]!] : null;
      if (only && typeof only === 'object') rep.hint = `the value is the whole response: items="${keys[0]}" stores its \`${keys[0]}\``;
    }
    return rep;
  });
}

function short(v: unknown, max = 160): string {
  let s: string;
  try { s = JSON.stringify(v, (_k, x) => (x instanceof FormData ? '(form data)' : x)) ?? String(v); } catch { s = String(v); }
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

function errorText(e: unknown): string {
  const x = e as { status?: number | null; message?: string };
  return x && typeof x.message === 'string' ? short(`${x.status ?? ''} ${x.message}`.trim(), 120) : short(e, 120);
}

function describe(s: Step): string {
  switch (s.kind) {
    case 'input': case 'select': return `--${s.kind} ${s.selector}=${s.value}`;
    case 'back': case 'forward': return `--${s.kind}`;
    case 'wait': return `--wait ${s.ms}ms`;
    case 'emit': return `--emit ${s.name}=${short(s.payload, 60)}`;
    default: return `--${s.kind} ${s.selector}`;
  }
}

async function runStep(r: Rendered, s: Step, streams: Map<string, MockStream>): Promise<void> {
  if (s.kind === 'emit') {
    const open = [...streams.values()].filter((x) => x.connected);
    if (!open.length) throw new Error('no stream is connected: the page has no <sn-sync>, or it has not connected');
    for (const x of open) x.emit(s.name, s.payload);
    return r.settle();
  }
  if (s.kind === 'back') return r.back().then(() => r.settle());
  if (s.kind === 'forward') return r.forward().then(() => r.settle());
  if (s.kind === 'wait') { await r.advance(s.ms); return r.settle(); }
  const el = document.querySelector(s.selector) as HTMLElement | null;
  if (!el) {
    // a component's tag is not on the page: the build expands it, and marks its root `data-sn-c`
    const tag = /(?:^|[\s>+~(,])([a-z][a-z0-9]*-[a-z0-9-]*)/.exec(s.selector)?.[1];
    const hint = tag && document.querySelector(`[data-sn-c="${tag}"]`) ? ` (components are expanded at build time: \`[data-sn-c="${tag}"]\` is the root of each <${tag}>)` : '';
    throw new Error(`no element matches \`${s.selector}\`${hint}`);
  }
  const fire = (type: string) => el.dispatchEvent(new Event(type, { bubbles: true }));
  switch (s.kind) {
    case 'click': el.click(); break;
    case 'check': {
      const box = el as HTMLInputElement;
      if (box.type !== 'checkbox' && box.type !== 'radio') throw new Error(`\`${s.selector}\` is not a checkbox or radio button`);
      box.click();
      break;
    }
    case 'submit': {
      const form = (el.tagName === 'FORM' ? el : el.closest('form')) as HTMLFormElement | null;
      if (!form) throw new Error(`\`${s.selector}\` is not a form or in one`);
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      break;
    }
    case 'input': {
      const f = el as HTMLInputElement;
      if (!('value' in f)) throw new Error(`\`${s.selector}\` is not a field`);
      f.value = s.value;
      fire('input');
      break;
    }
    case 'select': {
      const sel = el as unknown as HTMLSelectElement;
      if (sel.tagName !== 'SELECT') throw new Error(`\`${s.selector}\` is not a <select>`);
      if (![...sel.options].some((o) => o.value === s.value)) throw new Error(`\`${s.selector}\` has no option \`${s.value}\` (it has ${[...sel.options].map((o) => `\`${o.value}\``).join(', ') || 'none'})`);
      sel.value = s.value;
      fire('input');
      fire('change');
      break;
    }
  }
  await r.settle();
}

/** Renders the page and runs the steps; the report, or a message for an error the page cannot be rendered past. */
export async function renderPage(a: RenderArgs): Promise<RenderReport> {
  if (!existsSync(a.page)) throw new Error(`no such page: ${relative(process.cwd(), a.page) || a.page}`);
  const { options } = await viteProject(a.root);
  const p = readProject(a.root, options);
  const errors = p.diagnostics.filter((d) => d.severity === 'error');
  if (errors.length) throw new Error(errors.map(formatDiagnostic).join('\n'));
  const rel = relative(a.root, a.page).split('\\').join('/');

  // the page's URL: --url, else where the page answers (its first path without parameters)
  const html = readFileSync(a.page, 'utf8');
  // (on `<html>` or a layout's tag; the compiled page says for certain, below)
  const declared = /\sdata-sn-path\s*=\s*["']([^"']*)["']/i.exec(html)?.[1]?.trim().split(/\s+/).filter(Boolean) ?? [];
  let paths = pagePaths(rel, '/', declared);
  const url = new URL(a.url ?? paths.find((x) => !x.includes(':')) ?? '/' + rel, 'http://localhost/').href;

  // the console: the page's and the app's modules' output goes into the report, not between its lines
  const logged: string[] = [];
  const consoleWas = { ...console };
  for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    console[level] = (...args: unknown[]) => {
      const text = format(...args.map((x) => (x instanceof Error ? `${x.name}: ${x.message}` : x)));
      logged.push((level === 'log' || level === 'info' ? '' : `${level}: `) + text);
    };
  }
  // the DOM first: the runtime takes the DOM's classes (EventTarget, …) when it is imported
  const restore = typeof document === 'undefined' ? await installDom(url) : null;
  let loader: Awaited<ReturnType<typeof appLoader>> | null = null;
  try {
  const { render, mockRequests, mockStream, memoryStorage } = await import('./testing/index.js');
  const log: Logged[] = [];
  let step = 0;
  const routes = readMocks(a.mocks, a.root);
  const requests = mockRequests(
    Object.fromEntries(Object.entries(routes).map(([k, v]) => [k, (call: RecordedCall, req: Request) => { log.push({ call, href: req.url, source: 'mock', step }); return typeof v === 'function' ? (v as (c: RecordedCall, r: Request) => unknown)(call, req) : v; }])),
    {
      fallback: async (call, req) => {
        const entry: Logged = { call, href: req.url, source: a.backends.length ? 'backend' : 'unmatched', step };
        log.push(entry);
        if (!a.backends.length) return { status: 404, body: { error: `no mock for ${call.method} ${call.path}: add it to --api, or pass --api http://localhost:…` } };
        try { return await forward(a.backends[0]!, req); } catch (e) {
          entry.error = (e as Error).cause ? `${(e as Error).message}: ${((e as Error).cause as Error).message}` : (e as Error).message;
          throw e;
        }
      },
    },
  );

  loader = await appLoader(a.root);
  {
    // localStorage: the page's own (an app module may read it directly), filled from --storage
    const store = globalThis.localStorage ?? memoryStorage();
    const session = globalThis.sessionStorage ?? memoryStorage();
    store.clear(); session.clear();
    for (const [k, v] of a.storage) store.setItem(k, v);
    for (const [k, v] of a.session) session.setItem(k, v);
    try { if (globalThis.location && globalThis.location.href !== url) (globalThis as { history?: History }).history?.replaceState(null, '', url); } catch { /* another origin */ }

    const load = loader.load;
    const modules = async (file: string | null) => (file ? load(file) : {});
    const abs = (u: string | null) => (u ? resolve(a.root, u.replace(/^\//, '')) : null);
    // the config module first, as the page module imports it before mounting: request middleware, onError, …
    const { config } = await import('./runtime/config.js');
    const saved = { ...config, request: [...config.request] };
    if (p.config) await modules(abs(p.config));
    const helpers = await modules(p.helpersFile), actions = await modules(p.actionsFile);
    const scripts: Record<string, unknown> = {};
    for (const name of p.componentNames) {
      for (const ext of ['.ts', '.js']) {
        const f = resolve(a.root, 'src/components', name + ext);
        if (existsSync(f)) { scripts[name] = await load(f); break; }
      }
    }
    const messages = p.messages ? { [p.messages.base]: p.messages.dicts[p.messages.base]!, ...p.messages.dicts } : undefined;

    // every stream the page opens connects, and sends what --emit says
    const streams = new Map<string, MockStream>();
    const any = new Proxy({} as Record<string, MockStream>, { get: (_t, k) => { if (typeof k !== 'string') return undefined; if (!streams.has(k)) streams.set(k, mockStream()); return streams.get(k); } });
    const r = await render(html, {
      requests, streams: any, url, strict: false, storage: store, session, scripts,
      helpers: pick(helpers, p.helpers.names, Object.keys(p.helpers.namespaces)),
      actions: pick(actions, p.actions.names, Object.keys(p.actions.namespaces)),
      ...(messages ? { messages } : {}),
      ...(a.now !== null ? { now: a.now } : {}),
      ...(a.locale ? { locale: a.locale } : {}),
      project: { root: a.root, file: a.page, readFile: p.readFile, componentNames: p.componentNames, openapi: p.openapi, apis: p.apis },
    });
    let error: string | undefined;
    try { await r.settle(); } catch (e) { error = (e as Error).message; }

    paths = pagePaths(rel, '/', r.app.ir.path ?? []);
    const origin = new URL(url).origin;
    const shown = () => {
      const el = a.show ? document.querySelector(a.show) : document.body;
      if (!el) return `(no element matches \`${a.show}\`)`;
      return a.raw ? el.outerHTML : formatHtml(el);
    };
    const reqs = (n: number) => log.filter((l) => l.step === n).map((l) => requestReport(l, origin));
    const report: RenderReport = {
      page: rel, paths, url: url.startsWith(origin) ? url.slice(origin.length) : url, urlMatches: pathMatches(paths, new URL(url).pathname),
      requests: reqs(0), rendered: shown(), resources: resources(r), history: r.historyWrites(), navigations: [...r.navigations],
      warnings: [], console: [], steps: [],
    };
    if (error) report.warnings.push(error);
    let last = report.resources, before = report.rendered, writes = report.history.length, navs = report.navigations.length;
    for (const s of a.steps) {
      step++;
      const sr: StepReport = { step: describe(s), requests: [], history: [], navigations: [], changed: [], resources: [] };
      try { await runStep(r, s, streams); } catch (e) { sr.error = (e as Error).message; }
      const now = shown(), hist = r.historyWrites();
      const res = resources(r);
      Object.assign(sr, { requests: reqs(step), history: hist.slice(writes), navigations: r.navigations.slice(navs), changed: lineDiff(before, now), resources: res.filter((x, i) => short(x, 100_000) !== short(last[i], 100_000)) });
      last = res;
      before = now; writes = hist.length; navs = r.navigations.length;
      report.steps.push(sr);
      if (sr.error) break;
    }
    const here = (t: string) => t.split(a.root + '/').join('');
    const runtime = r.warnings().map((w) => here(w.message));
    report.warnings.unshift(...r.diagnostics.map((d) => formatDiagnostic({ ...d, file: relative(a.root, d.file) || d.file })), ...runtime);
    // the runtime prints its warnings too: those are in `warnings` already
    report.console = logged.map(here).filter((l) => !runtime.some((w) => l.replace(/^(warn|error): /, '').startsWith(w)));
    r.app.destroy();
    Object.assign(config, saved);
    return report;
  }
  } finally {
    await loader?.close();
    restore?.();
    Object.assign(console, consoleWas);
  }
}

function pick(mod: Record<string, unknown>, names: string[], namespaces: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const n of [...names, ...namespaces]) if (n in mod) out[n] = mod[n];
  return out;
}

export function formatReport(r: RenderReport): string {
  const out: string[] = [];
  const reqLines = (list: RequestReport[], indent: string) => {
    const w = Math.min(48, Math.max(0, ...list.map((q) => q.method.length + 1 + q.url.length)));
    for (const q of list) {
      const hs = Object.entries(q.headers).map(([k, v]) => `${k.replace(/(^|-)[a-z]/g, (c) => c.toUpperCase())}: ${v}`).join('  ');
      const status = q.error ? `failed: ${q.error}` : q.status === null ? 'no answer' : String(q.status);
      out.push(`${indent}${(q.method + ' ' + q.url).padEnd(w)}  ${hs ? hs + '  ' : ''}→ ${status} (${q.source === 'unmatched' ? 'no mock' : q.source})`);
      if (q.body !== undefined) out.push(`${indent}  body ${short(q.body)}`);
    }
    if (!list.length) out.push(`${indent}(none)`);
  };
  const resLines = (list: ResourceReport[], indent: string) => {
    const w = Math.max(0, ...list.map((x) => x.name.length));
    for (const x of list) {
      out.push(`${indent}${x.name.padEnd(w)}  loading: ${x.loading}  error: ${x.error ? errorText(x.error) : 'null'}  value: ${short(x.value)}`);
      if (x.hint) out.push(`${indent}${' '.repeat(w)}  ← ${x.hint}`);
    }
    if (!list.length) out.push(`${indent}(none)`);
  };
  const histLines = (list: HistoryWrite[], navs: string[], indent: string) => {
    for (const h of list) out.push(`${indent}${h.op} ${h.url.replace(/^http:\/\/localhost/, '')}`);
    for (const n of navs) out.push(`${indent}navigate ${n.replace(/^replace /, '(replace) ')}`);
  };
  out.push(`page      ${r.page} at ${r.paths.join(' ')}`);
  out.push(`url       ${r.url}${r.urlMatches ? '' : `   ← the page does not answer at this URL (it answers at ${r.paths.join(', ')})`}`);
  out.push('requests');
  reqLines(r.requests, '  ');
  out.push('rendered');
  out.push(r.rendered.split('\n').map((l) => '  ' + l).join('\n'));
  out.push('state');
  resLines(r.resources, '  ');
  if (r.history.length || r.navigations.length) { out.push('history'); histLines(r.history, r.navigations, '  '); }
  for (const s of r.steps) {
    out.push('', `step ${s.step}`);
    if (s.error) out.push(`  error: ${s.error}`);
    if (s.requests.length) { out.push('  requests'); reqLines(s.requests, '    '); }
    if (s.history.length || s.navigations.length) { out.push('  history'); histLines(s.history, s.navigations, '    '); }
    out.push('  changed');
    out.push(s.changed.length ? s.changed.map((l) => '    ' + l).join('\n') : '    (nothing on the page)');
    out.push('  state');
    if (s.resources.length) resLines(s.resources, '    ');
    else out.push('    (unchanged)');
  }
  if (r.console.length) { out.push('', 'console'); out.push(r.console.map((l) => l.split('\n').map((x) => '  ' + x).join('\n')).join('\n')); }
  out.push('', 'warnings');
  out.push(r.warnings.length ? r.warnings.map((w) => w.split('\n').map((l) => '  ' + l).join('\n')).join('\n') : '  (none)');
  return out.join('\n');
}

/** `sinter render …`: the exit code; the report on stdout, a usage or setup problem on stderr. */
export async function renderCommand(argv: string[]): Promise<number> {
  if (argv.includes('--help') || argv.includes('-h')) { console.log(RENDER_USAGE); return 0; }
  const a = parseRenderArgs(argv);
  if (typeof a === 'string') { console.error(`sinter render: ${a}\n${RENDER_USAGE}`); return 2; }
  let report: RenderReport;
  try { report = await renderPage(a); } catch (e) {
    console.error(`sinter render: ${(e as Error).message}`);
    if (process.env.SINTER_DEBUG) console.error((e as Error).stack);
    return 1;
  }
  console.log(a.json ? JSON.stringify(report, null, 2) : formatReport(report));
  return report.steps.some((s) => s.error) ? 1 : 0;
}
