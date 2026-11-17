// <sn-sync>: one connection per stream URL; translates server events into change messages, gates every
// reconnect with the session probe, refetches after reconnects and steps aside
// for the back/forward cache. The transport is EventSource unless
// configure({ transport }) picks another for the stream URL.
import type { EventDef, SyncDef } from './ir.js';
import { config, SinterError } from './runtime/config.js';
import type { App, Feature, Transport } from './runtime/app.js';
import { clean } from './runtime/store.js';
import { doubled, jittered } from './backoff.js';

const MIN_BACKOFF = 1000;

/** A stream's state, as `$meta.<resource>.live` shows it; a resource fed by several streams shows the worst. */
type Live = 'connecting' | 'open' | 'retrying';
const WORSE: Record<Live, number> = { open: 0, connecting: 1, retrying: 2 };

/** JSON payloads are parsed; anything else is delivered as the raw string. */
export const parsePayload = (data: string): unknown => { try { return JSON.parse(data); } catch { return data; } };

/** The default transport: one EventSource. */
export function eventSourceTransport(): Transport {
  let es: EventSource | null = null;
  let deliver: ((name: string, payload: unknown) => void) | null = null;
  const names = new Set<string>();
  const add = (name: string) => {
    if (!es || names.has(name)) return;
    names.add(name);
    es.addEventListener(name, (e) => deliver?.(name, parsePayload((e as MessageEvent).data)));
  };
  return {
    connect(url, onEvent, onState, initial) {
      deliver = onEvent;
      es = new EventSource(url, { withCredentials: true });
      es.onopen = () => onState('open');
      es.onerror = () => onState('error');
      names.clear();
      for (const n of initial) add(n);
    },
    listen: add,
    close() { es?.close(); es = null; },
  };
}

/**
 * One stream URL's connection, shared by every `<sn-sync>` on the page that resolves to it. What it has of the
 * page (`app`, `subs`, `changed`, `heard`) is set by each page that uses it: with swaps on, the next page takes
 * an open connection over (sse-handover.ts, docs/proposals/stream-handover.md); the rest is the connection's.
 */
export class Connection {
  t: Transport | null = null;
  private backoff = MIN_BACKOFF;
  private timer: unknown = null;
  private closed = false;
  private hidden = false;
  everOpen = false;
  /** `connecting` until the first open, `retrying` from a failure until it is open again */
  state: Live = 'connecting';
  /** each mapped event with the scope its expressions are evaluated in: its `<sn-sync>`'s state, or the page */
  subs: Array<[EventDef, any]> = [];

  /** `heard`: the names the app's islands and component scripts listen to (`app.on`), the feature's since install */
  constructor(public app: App, readonly url: string, public changed: () => void, public heard: Set<string>) {}

  listen(name: string): void { this.t?.listen?.(name); }

  private set(state: Live): void {
    if (this.state === state) return;
    this.state = state;
    this.changed();
  }

  start(): void {
    const env = this.app.env;
    this.app.addCleanup(env.listen('pagehide', () => { this.hidden = true; this.stop(); }));
    this.app.addCleanup(env.listen('pageshow', () => {
      if (!this.hidden) return;
      this.hidden = false;
      this.closed = false;
      this.set('connecting');
      void this.probe();
    }));
    this.app.addCleanup(() => { this.closed = true; this.stop(); });
    this.open();
  }


  private open(): void {
    if (this.closed && !this.hidden) return;
    const custom = this.app.transport(this.url) ?? config.transport?.(this.url);
    const t = custom ?? eventSourceTransport();
    this.t = t;
    t.connect(this.url, (name, data) => this.event(name, data), (state) => {
      if (this.t !== t) return;
      if (state === 'open') {
        const reconnect = this.everOpen;
        this.backoff = MIN_BACKOFF;
        this.everOpen = true;
        this.set('open');
        if (!custom) this.app.streamOpened?.(this.url);
        // events sent while disconnected are lost: refetch everything this stream feeds (the page's as it is
        // now: a page that took the connection over refetches its own)
        if (reconnect) for (const name of new Set(this.subs.map(([e]) => e.resource))) if (name) void this.app.resource(name).refetch();
      } else {
        t.close();
        this.t = null;
        this.set('retrying');
        void this.probe();
      }
      // every connect (the first, a reconnect, after the back/forward cache) subscribes the mapped names and
      // those `app.on` listens to, whenever its listener came
    }, [...new Set([...this.subs.map(([e]) => e.name), ...this.heard])]);
  }

  private stop(): void {
    this.t?.close();
    this.t = null;
    if (this.timer != null) { this.app.env.clearTimeout(this.timer); this.timer = null; }
  }

  /** The session probe gates every reconnect: 2xx reconnects, 401 leads to login, an outage backs off. */
  private async probe(): Promise<void> {
    if (this.closed || this.hidden) return;
    if (!config.sessionProbe) { this.wait(() => this.open()); return; }
    let status: number;
    try {
      status = (await this.app.req.raw(config.sessionProbe, { retry: false })).status;
    } catch (e) {
      status = e instanceof SinterError ? e.status ?? 0 : 0;
    }
    if (this.closed || this.hidden) return;
    if (status >= 200 && status < 300) this.open();
    else if (status !== 401) this.wait(() => void this.probe());
    // 401: the request layer's onUnauthorized handles login
  }

  private wait(fn: () => void): void {
    const delay = jittered(this.backoff, this.app.env.random, 0.25);
    this.backoff = doubled(this.backoff);
    this.timer = this.app.env.setTimeout(() => { this.timer = null; fn(); }, delay, 'backoff');
  }

  private event(name: string, payload: unknown): void {
    // rendered with the next frame: a burst of events renders once
    this.app.streamed(() => { for (const [def, base] of this.subs) if (def.name === name) this.apply(def, base, payload); });
    this.app.serverEvent(name, payload);
  }

  private apply(def: EventDef, base: any, payload: unknown): void {
    const app = this.app;
    const scope = Object.create(base);
    scope.$p = payload && typeof payload === 'object' ? payload : {};
    try {
      if (def.when != null && !app.fns[def.when]!(scope)) return;
      // `then` runs once the change is applied (a refetch: requested), unless the payload could not be applied
      if (def.resource && !this.change(def, def.resource, scope, payload)) return;
      if (def.then != null) app.exec(def.then, scope, def.w);
    } catch (e) {
      app.warn(28, def.name, (e as Error).message, payload);
    }
  }

  /** Applies the event's change message; false when the payload lacks what it needs. */
  private change(def: EventDef, name: string, scope: any, payload: unknown): boolean {
    const app = this.app;
    const r = app.resource(name);
    const paginated = !!app.ir.resources.find((x) => x.name === name)?.paginate;
    switch (def.op) {
      case 'refetch':
        void r.refetch(scope.$p);
        break;
      case 'upsert': {
        const item = def.item != null ? app.fns[def.item]!(scope) : payload;
        if (item == null || typeof item !== 'object') {
          if (def.fallback !== 'refetch') return false;
          void r.refetch(scope.$p);
        } else if (paginated && !r.has(item as object)) void r.refetch();
        else r.upsert(clean(item) as object);
        break;
      }
      case 'patch': {
        if (r.isCollection && !this.hasKey(r.key!, scope.$p, def)) return false;
        const key = r.keyOf(scope.$p);
        if (!r.isCollection || r.has(key)) r.patch(key, clean(app.fns[def.set!]!(scope)));
        break;
      }
      case 'remove': {
        if (r.isCollection && !this.hasKey(r.key!, scope.$p, def)) return false;
        r.remove(r.keyOf(scope.$p));
        break;
      }
    }
    return true;
  }

  private hasKey(fields: string[], payload: Record<string, unknown>, def: EventDef): boolean {
    const missing = fields.filter((f) => payload[f] === undefined);
    if (missing.length) this.app.warn(29, def.name, missing.join(', '), def.resource, payload);
    return missing.length === 0;
  }
}

const sse: Feature = {
  name: 'sse',
  install(app: App) {
    // connect after mount has created resources and loaders, unless the app is gone by then
    let alive = true;
    app.addCleanup(() => { alive = false; });
    // names `app.on` listens to, from install on: a component script's `connected()` in the mount, an island
    // before the stream starts or while it retries; each connect subscribes them all
    const heard = new Set<string>();
    let conns: Map<string, Connection> | undefined;
    app.onListen.push((name) => { heard.add(name); for (const c of conns?.values() ?? []) c.listen(name); });
    app.env.queueMicrotask(() => {
      if (!alive) return;
      // one connection per resolved stream URL, however many <sn-sync> elements use it
      conns = new Map<string, Connection>();
      /** the connections feeding each resource: its `$meta.live` is the worst of their states */
      const feeders = new Map<string, Set<Connection>>();
      const publish = () => {
        for (const [name, cs] of feeders) {
          const r = app.resource(name);
          const live = [...cs].reduce<Live>((w, c) => (WORSE[c.state] > WORSE[w] ? c.state : w), 'open');
          if (r.meta.live !== live) { r.meta.live = live; r.onDirty?.('meta'); }
        }
      };
      const cs = conns;
      for (const def of app.ir.syncs ?? []) {
        const base = app.scopeOf(def.scope ?? -1);
        const url = app.url(def.src, base);
        let c = cs.get(url);
        if (!c) cs.set(url, c = new Connection(app, url, publish, heard));
        for (const e of def.events) {
          c.subs.push([e, base]);
          if (e.resource) (feeders.get(e.resource) ?? feeders.set(e.resource, new Set()).get(e.resource)!).add(c);
        }
      }
      // a prerendered page connects once it is shown: no stream for a page nobody may ever see
      app.shown(() => { if (alive) for (const c of cs.values()) c.start(); });
    });
  },
};

export default sse;
