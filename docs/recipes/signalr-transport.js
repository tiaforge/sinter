// SignalR transport for <sn-sync>, in your app (sinter does not depend on @microsoft/signalr).
// In src/sinter.config.js:
//
//   import { HubConnectionBuilder } from '@microsoft/signalr';
//   import { configure } from '@tiaforge-ui/sinter';
//   import { signalRTransport } from './signalr-transport.js';
//
//   configure({
//     transport: (url) => url.startsWith('/hubs/')
//       ? signalRTransport(() => new HubConnectionBuilder().withUrl(url).build())
//       : undefined,
//   });
//
// Server: `await Clients.All.SendAsync("person_updated", new { person })`; the first argument is
// the payload. Hub method names are case-insensitive in SignalR, so keep event names distinct in
// more than case. Do not call withAutomaticReconnect(): sinter reconnects (session probe, backoff,
// refetch of everything the stream feeds), and two reconnect loops would race. Auth is the hub's:
// cookies, or withUrl(url, { accessTokenFactory }); request middleware does not apply.

/** @param {() => import('@microsoft/signalr').HubConnection} build a new, unstarted connection */
export function signalRTransport(build) {
  let hub = null;
  let deliver = null;
  const names = new Set();
  const add = (name) => {
    if (!hub || names.has(name)) return;
    names.add(name);
    const h = hub;
    h.on(name, (payload) => { if (hub === h) deliver(name, payload ?? null); });
  };
  return {
    connect(url, onEvent, onState, initial) {
      const h = hub = build();
      deliver = onEvent;
      names.clear();
      for (const n of initial) add(n);
      h.onclose(() => { if (hub === h) { hub = null; onState('error'); } });
      h.start().then(() => { if (hub === h) onState('open'); }, () => { if (hub === h) { hub = null; onState('error'); } });
    },
    listen: add,
    close() {
      const h = hub;
      hub = null; // nothing is reported after close()
      h?.stop().catch(() => {});
    },
  };
}
