# Transport e2e: SSE, WebSocket, SignalR against real servers

`<sn-sync>` over each transport in headless Chrome, against real backends rather than the fakes in
`test/behaviour/ws.test.ts` and `docs/recipes/signalr.test.ts`:

| transport | page | server |
| --- | --- | --- |
| SSE (default) | [`sse.html`](sse.html) | `text/event-stream` from [`server.mjs`](server.mjs) |
| WebSocket (`@tiaforge-ui/sinter/ws`) | [`ws.html`](ws.html) | the `ws` package in `server.mjs` |
| SignalR ([recipe](../../docs/recipes/signalr-transport.js), imported as is) | [`signalr.html`](signalr.html) | ASP.NET Core hub in [`signalr/`](signalr/Program.cs), behind `server.mjs` as a reverse proxy (HTTP and WebSocket upgrades), so the page sees one origin |

The pages are identical apart from the stream URL; [`src/sinter.config.js`](src/sinter.config.js)
picks the transport by URL.

Each transport runs the same steps:

1. The initial load shows the list and the stream connects. For SignalR, the hub must be reached over
   WebSocket: the client would otherwise fall back to SSE or long polling without saying so.
2. An upsert event and a remove event change the list; an event the page does not map changes nothing.
3. **Connection cut** (the server destroys the socket, as a network failure would) after a change
   that no event announced: sinter runs the session probe, reconnects and refetches, so the
   change appears.
4. After 1.5 s there is exactly one new connection: no second reconnect loop (EventSource's
   own retry, or SignalR's `withAutomaticReconnect()`).
5. Events arrive over the new connection.
6. SignalR only: the hub aborts the connection (a server-side close) → reconnect and refetch.

Step 3 is what catches a SignalR connection built with `withAutomaticReconnect()`, which the recipe
warns against: the client reconnects by itself, sinter is never told, and the missed change never
appears (checked by enabling it: step 3 fails).

```sh
npm install                       # in the repo root first: npm run build
CHROME=/path/to/chrome DOTNET=/path/to/dotnet node run.mjs          # or: node run.mjs sse,ws
```

SignalR needs the .NET 10 SDK; a user-local install is enough
(`dotnet-install.sh --channel 10.0 --install-dir ~/.dotnet`). The first run restores and builds the
hub (about a minute).

## Results

2026-11-05, Chrome 156 headless, .NET SDK 10.0.403, `@microsoft/signalr` 10.0.11, `ws` 8.22.0:
25/25 steps pass (8 per transport, plus the SignalR abort step).

Not covered: cross-origin streams, auth (cookies or `accessTokenFactory`), the back/forward cache
and long outages with backoff (those are covered by the happy-dom suites only), and other browsers.
