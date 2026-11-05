// WebSocket transport for <sn-sync>. Opt in from the config module:
//   configure({ transport: (url) => url.startsWith('/ws/') ? webSocketTransport() : undefined })
// The stream URL stays an http(s) URL in the HTML (the compiler's URL rules apply); the
// transport opens it as ws(s). Server to client only: actions still go over HTTP.
import { config } from './runtime/config.js';
import type { Transport } from './runtime/app.js';

export interface WebSocketTransportOptions {
  /** subprotocols for the WebSocket constructor */
  protocols?: string | string[];
  /**
   * Turns one text message into `[event name, payload]`, or `null` to skip it. Default: the
   * message is JSON `{"event": "<name>", "data": <payload>}`.
   */
  decode?: (message: string) => [name: string, payload: unknown] | null;
}

/** The default message format: `{"event": "contact_updated", "data": {…}}`. */
export function decodeMessage(message: string): [string, unknown] | null {
  let m: unknown;
  try { m = JSON.parse(message); } catch { return null; }
  if (!m || typeof m !== 'object' || typeof (m as { event?: unknown }).event !== 'string') return null;
  return [(m as { event: string }).event, (m as { data?: unknown }).data ?? null];
}

/**
 * One WebSocket per stream. Delivers the mapped event names and those islands listen to later;
 * other messages are dropped, as EventSource drops events nobody listens for. A close, clean or
 * not, reports `error`: `<sn-sync>` then runs the session probe, backs off and reconnects.
 */
export function webSocketTransport(options: WebSocketTransportOptions = {}): Transport {
  const decode = options.decode ?? decodeMessage;
  let ws: WebSocket | null = null;
  const names = new Set<string>();
  return {
    connect(url, onEvent, onState, initial) {
      const u = new URL(url, config.env.href());
      u.protocol = u.protocol === 'http:' ? 'ws:' : u.protocol === 'https:' ? 'wss:' : u.protocol;
      names.clear();
      for (const n of initial) names.add(n);
      const s = ws = new WebSocket(u.href, options.protocols);
      s.onopen = () => { if (ws === s) onState('open'); };
      s.onclose = () => { if (ws === s) { ws = null; onState('error'); } };
      s.onmessage = (e) => {
        if (ws !== s || typeof e.data !== 'string') return;
        const m = decode(e.data);
        if (m && names.has(m[0])) onEvent(m[0], m[1]);
      };
    },
    listen(name) { names.add(name); },
    close() {
      const s = ws;
      ws = null; // handlers check this first: nothing is reported after close()
      s?.close();
    },
  };
}
