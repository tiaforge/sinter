// Streams across a swap (docs/proposals/stream-handover.md), with swaps on (`SWAP`, runtime/flags.ts): the old
// page's open connections are parked when its app is destroyed, inside a window the swap opens for the commit
// (swap-run.ts). The next page takes over each one whose URL it declares, with the same transport, instead of
// connecting again; the swap closes the rest once the next page has mounted. Events that arrive in between are
// held and replayed to the next page then, in order, before any live event.
import type { App } from './runtime/app.js';
import { config } from './runtime/config.js';
import type { Connection } from './sse.js';

/** one swap's window: the connections parked, and those taken over waiting for the replay */
export interface Window { parked: Map<string, Connection>; claimed: Connection[] }
/** the document's registry, shared with swap-run.ts: the window of the swap in progress, and how one closes */
interface Streams { w: Window | null; close?: (w: Window) => void; at?: number }

/** a held event, then a gap: past this many the oldest go, and the next page refetches what the stream feeds */
const CAP = 1000;

const streams = (): Streams | undefined => (globalThis as Record<symbol, Streams | undefined>)[Symbol.for('sinter.streams')];
/** the page's app: an app mounted on an element of the page never parks or claims */
const page = (app: App) => app.root === (globalThis as { document?: Document }).document;

/** the old app's cleanup: true when the connection is parked rather than closed */
export function park(c: Connection): boolean {
  const s = streams(), w = s?.w;
  // a transport made by the app's own `transport` option (`via` 1) is that app's
  if (!w || !c.t || c.via === 1 || !page(c.app) || w.parked.has(c.url)) return false;
  s.close ??= close;
  c.parked = true;
  // a connection the old page had taken over keeps what it held (a newer swap came before its replay)
  c.buf ??= [];
  c.subs = [];
  c.changed = () => {};
  w.parked.set(c.url, c);
  return true;
}

/**
 * The next app's install: the parked connection for `url`, taken over, if its transport came from the same
 * place (`config.transport`, or the default) and can deliver every name the next page maps.
 */
export function claim(app: App, url: string, heard: Set<string>, changed: () => void): Connection | undefined {
  const w = streams()?.w, c = w?.parked.get(url), t = c?.t;
  if (!t || !page(app) || c.via !== config.transport || app.transport(url)) return;
  // the names this page maps on the URL, and those `app.on` listens to. Its data came with its HTML: a resource
  // is stale when, since the fetch started, an event that feeds it reached the page before (`seen`), or could
  // not, the page before not listening to its name (an `EventSource` delivers no other)
  const names = new Set(heard), stale = new Set<string>(), at = streams()!.at, since = at && c.at === at ? c.seen : undefined;
  for (const def of app.ir.syncs ?? []) if (app.url(def.src, app.scopeOf(def.scope ?? -1)) === url) for (const e of def.events) {
    names.add(e.name);
    if (at && e.resource && (since?.has(e.name) || !c.names?.has(e.name))) stale.add(e.resource);
  }
  if (!t.listen && [...names].some((n) => !c.names?.has(n))) return;
  w!.parked.delete(url);
  w!.claimed.push(c);
  c.parked = false;
  c.app = app;
  c.heard = heard;
  c.changed = changed;
  for (const n of names) t.listen?.(n);
  c.names = new Set([...(c.names ?? []), ...names]);
  c.seen = undefined;
  // its data came with its HTML, older than those events: fetched again (one loading already asks the server now)
  for (const r of stale) { const x = app.resource(r); if (!x.meta.loading) void x.refresh(); }
  return c;
}

/**
 * An event the page shown applies while a swap fetches the next page's HTML: the next page's data is from that
 * response, so the names are noted, for its claim to refetch what they feed.
 */
export function seen(c: Connection, name: string): void {
  const at = streams()?.at;
  if (!at) return;
  if (c.at !== at) { c.at = at; c.seen = new Set(); }
  c.seen!.add(name);
}

/** an event while the connection is parked or waits for its replay */
export function hold(c: Connection, name: string, payload: unknown): void {
  const b = c.buf!;
  b.push([name, payload]);
  if (b.length > CAP) { b.shift(); c.lossy = true; }
}

/** a parked connection that failed: the next page connects anew */
export function forget(c: Connection): void {
  const w = streams()?.w;
  if (w?.parked.get(c.url) === c) w.parked.delete(c.url);
  c.buf = null;
}

/** the swap's window closes (swap-run.ts): what nobody took over closes, what was taken over is replayed */
function close(w: Window): void {
  for (const c of w.parked.values()) { c.buf = null; c.closed = true; c.t?.close(); c.t = null; }
  w.parked.clear();
  for (const c of w.claimed.splice(0)) {
    const held = c.buf ?? [];
    c.buf = null;
    // more than the cap arrived: what the stream feeds is fetched again, as after a reconnect
    if (c.lossy) { c.lossy = false; for (const r of new Set(c.subs.map(([e]) => e.resource))) if (r) void c.app.resource(r).refresh(); }
    for (const [n, p] of held) c.event(n, p);
  }
}
