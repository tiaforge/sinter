// <sn-sync>: translates server events into change messages, gates every
// reconnect with the session probe, refetches after reconnects and steps aside
// for the back/forward cache. The transport is EventSource unless
// configure({ transport }) picks another for the stream URL.
import type { EventDef, SyncDef } from './ir.js';
import { config, SinterError } from './runtime/config.js';
import type { App, Feature, Transport } from './runtime/app.js';
import { clean } from './runtime/store.js';

const MIN_BACKOFF = 1000;
const MAX_BACKOFF = 30_000;

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

class Connection {
  private t: Transport | null = null;
  private backoff = MIN_BACKOFF;
  private timer: unknown = null;
  private closed = false;
  private hidden = false;
  private everOpen = false;
  private readonly url: string;
  private readonly fed: string[];

  constructor(private readonly app: App, private readonly def: SyncDef) {
    this.url = app.url(def.src, app.page);
    this.fed = [...new Set(def.events.map((e) => e.resource))];
  }

  start(): void {
    const env = this.app.env;
    this.app.addCleanup(env.listen('pagehide', () => { this.hidden = true; this.stop(); }));
    this.app.addCleanup(env.listen('pageshow', () => {
      if (!this.hidden) return;
      this.hidden = false;
      this.closed = false;
      void this.probe();
    }));
    this.app.onListen.push((name) => this.t?.listen?.(name));
    this.app.addCleanup(() => { this.closed = true; this.stop(); });
    this.open();
  }

  private names(): string[] {
    return [...new Set(this.def.events.map((e) => e.name))];
  }

  private open(): void {
    if (this.closed && !this.hidden) return;
    const custom = this.app.transport(this.url) ?? config.transport?.(this.url);
    const t = custom ?? eventSourceTransport();
    this.t = t;
    const reconnect = this.everOpen;
    t.connect(this.url, (name, data) => this.event(name, data), (state) => {
      if (this.t !== t) return;
      if (state === 'open') {
        this.backoff = MIN_BACKOFF;
        this.everOpen = true;
        if (!custom) this.app.streamOpened?.(this.url);
        // events sent while disconnected are lost: refetch everything this stream feeds
        if (reconnect) for (const name of this.fed) void this.app.resource(name).refetch();
      } else {
        t.close();
        this.t = null;
        void this.probe();
      }
    }, this.names());
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
      status = (await this.app.req.raw(config.sessionProbe)).status;
    } catch (e) {
      status = e instanceof SinterError ? e.status : 0;
    }
    if (this.closed || this.hidden) return;
    if (status >= 200 && status < 300) this.open();
    else if (status !== 401) this.wait(() => void this.probe());
    // 401: the request layer's onUnauthorized handles login
  }

  private wait(fn: () => void): void {
    const delay = Math.round(this.backoff * (0.75 + this.app.env.random() * 0.5));
    this.backoff = Math.min(this.backoff * 2, MAX_BACKOFF);
    this.timer = this.app.env.setTimeout(() => { this.timer = null; fn(); }, delay, 'backoff');
  }

  private event(name: string, payload: unknown): void {
    for (const def of this.def.events) if (def.name === name) this.apply(def, payload);
    this.app.serverEvent(name, payload);
  }

  private apply(def: EventDef, payload: unknown): void {
    const app = this.app;
    const scope = Object.create(app.page);
    scope.$p = payload && typeof payload === 'object' ? payload : {};
    const r = app.resource(def.resource);
    try {
      if (def.when != null && !app.fns[def.when]!(scope)) return;
      const paginated = !!app.ir.resources.find((x) => x.name === def.resource)?.paginate;
      switch (def.op) {
        case 'refetch':
          void r.refetch();
          return;
        case 'upsert': {
          const item = def.item != null ? app.fns[def.item]!(scope) : payload;
          if (item == null || typeof item !== 'object') {
            if (def.fallback === 'refetch') void r.refetch();
            return;
          }
          if (paginated && !r.has(item as object)) { void r.refetch(); return; }
          r.upsert(clean(item) as object);
          return;
        }
        case 'patch': {
          if (r.isCollection && !this.hasKey(r.key!, scope.$p, def)) return;
          const key = r.keyOf(scope.$p);
          if (r.isCollection && !r.has(key)) return;
          r.patch(key, clean(app.fns[def.set!]!(scope)));
          return;
        }
        case 'remove': {
          if (r.isCollection && !this.hasKey(r.key!, scope.$p, def)) return;
          const key = r.keyOf(scope.$p);
          r.remove(key);
          return;
        }
      }
    } catch (e) {
      app.warn(`event \`${def.name}\` could not be applied: ${(e as Error).message}`, payload);
    }
  }

  private hasKey(fields: string[], payload: Record<string, unknown>, def: EventDef): boolean {
    const missing = fields.filter((f) => payload[f] === undefined);
    if (missing.length) this.app.warn(`event \`${def.name}\` payload is missing key field(s) ${missing.join(', ')} for \`${def.resource}\``, payload);
    return missing.length === 0;
  }
}

const sse: Feature = {
  name: 'sse',
  install(app: App) {
    // connect after mount has created resources and loaders
    app.env.queueMicrotask(() => {
      for (const def of app.ir.syncs) new Connection(app, def).start();
    });
  },
};

export default sse;
