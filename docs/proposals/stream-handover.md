# Proposal: streams that stay open across a swap

Status: proposed 2026-11-17, not implemented. It follows [swap-navigation.md](swap-navigation.md), whose
[§7](swap-navigation.md#7-what-the-core-and-the-features-need) and
[Not in this proposal](swap-navigation.md#not-in-this-proposal) left this for later ("a stream both pages
use could be handed over instead of reconnecting"). Asked for by caley (sinter main `623c354`, `swap: true`,
`localePrefix`, embed).

Decisions proposed:
- **The URL decides, not the element.** A connection survives a swap when the next page declares a
  `<sn-sync>` whose `src` resolves to the same URL, with the same transport. It makes no difference whether
  the `<sn-sync>` is in a kept element or in the page's own content. This is the existing
  one-connection-per-URL rule, applied across the swap.
- **Only the connection is handed over.** The transport, its state, its backoff and the "has it ever been
  open" flag carry over. The `<sn-event>` mappings, their scopes and the resources they feed are always the
  next page's. Nothing of the old page's code runs after its `destroy()`.
- **Events in the gap are buffered and replayed** to the next page, in order, before any live event.
- **The swap closes what nobody claimed**, once the next page has mounted. A timer can't do it, because the
  mount can be asynchronous.
- **Without a swap, nothing changes:** `destroy()` closes the app's streams as today (embed, tests, an app
  mounted on an element).

## The case

In caley, the rail (`<nav data-rail popover id="nav" data-sn-permanent="rail">`, in every app page through
the layout) holds `<sn-sync src="/events/stream">`, a `call` resource and a `<mail-notifier>` component
whose script shows desktop notifications for `new_email`. The mail page declares its own
`<sn-sync src="/events/stream">` with `<sn-event>`s for `email_updated`, `email_removed` and others, so the
two share one connection on that page.

Measured with Playwright: every swap closes the `EventSource` and opens a new one (5 swaps: 6 opened, 5
closed, never two at once). That is what [navigation.md](../navigation.md#swaps) promises ("what the old
page's code held for it starts again: … its resources and streams"). It costs two things:

1. **Events in the gap are lost.** These are the events sent between the old connection closing and the
   new one opening. caley's server (`src/sse.rs`) sends no event ids and ignores `Last-Event-ID`, so nothing
   replays them. For resources the loss is mostly hidden, because the next page fetches its resources
   anyway. The events sent after its fetches were answered but before its stream opened are still lost, and
   no refetch catches those up, since a first connect is not a reconnect. For `then` handlers and component
   scripts the loss is plain: a `new_email` in the gap never becomes a notification.
2. **A reconnect per click**: a request and a server-side subscription each time. With HTTP/1.1, the
   connection slot goes through close and reopen too.

The gap is not just one task. With built-in messages, a page's `$boot` is `async` and awaits `$ready()`
before it mounts (compiler/index.ts). With `localePrefix`, the messages are inline and the wait is short,
but other setups load a language file there. The old app is destroyed before `boot()` is called
(swap-run.ts, `swap()`), and the next page's streams connect in a microtask after its mount (sse.ts). The
gap runs from `old.destroy()` to that microtask.

## Goals

1. A connection whose URL both pages declare stays open through the swap: in caley, 5 swaps open 1
   `EventSource` and close none.
2. No event is lost or applied twice across the swap. An event in the gap reaches the next page's
   `<sn-event>`s, `then` handlers and `app.on` listeners once.
3. A URL the next page doesn't declare is closed by the end of the swap, as today.
4. `$meta.<resource>.live` on the next page starts at the handed-over connection's state (`'open'`), so an
   indicator doesn't flash "connecting" on every click.
5. Nothing changes for apps without swaps, for a `destroy()` that no swap follows, or for a load.

## Design

### 1. The rule

At the swap's commit, the old page's connections are **parked** instead of closed. The next page's `sse`
feature builds its connection map as today: one entry per resolved URL, in order. For each URL, it first
looks for a parked connection with that URL and the same transport factory. If it finds one, it **claims**
it instead of creating one. Once the next page has mounted, the swap closes every parked connection that
nobody claimed.

- **The resolved URL is the key**, the string `app.url(def.src, base)` returns. Interpolation is resolved
  with the next page's scope, as it is today (once, when the feature installs). `/rooms/{room}/events` on
  `/rooms/a` and on `/rooms/b` gives two different URLs: the first is closed and the second opened. That is
  correct, because they are two different subscriptions. Two `<sn-sync>`s of the next page with one URL
  claim one connection, as they share one today.
- **The same transport:** `app.transport(url) ?? config.transport?.(url)` names the factory. The
  config module runs once per document under swaps
  ([swap-navigation.md §6](swap-navigation.md#6-the-pages-code)), so its function is the same object on
  both pages. A connection made by another factory, or by the default `EventSource` where the next page
  would use a custom one, is not claimed. It is closed, and the next page opens its own.
- **Kept or not makes no difference.** The rail's `<sn-sync>` is in the next page's IR, because the
  layout writes it into every page and the next page's code takes the kept element over. The mail page's
  `<sn-sync>` is in the mail page's IR. Mail → settings keeps the connection: the settings page's rail
  declares the URL, and the mail page's `<sn-event>`s go with the mail page. Settings → mail keeps it too,
  and the mail page's mappings join the rail's.

### 2. Where a parked connection lives

There is one registry per document, `globalThis[Symbol.for('sinter.streams')]`, which follows the pattern
of `sinter.pages` and `sinter.swap`:

```ts
interface Parked {
  /** set by the swap from just before `old.destroy()` until it closes what is unclaimed */
  open: boolean;
  /** by resolved URL */
  conns: Map<string, Connection>;
}
```

The swap opens the window in `swap()`, just before `old.destroy()`, and closes it (§4). The `sse` feature
parks only while the window is open. Every other `destroy()` closes, as today. Without swaps the registry
is never created, so a page whose `<sn-sync>` was never swapped behaves exactly as now.

### 3. Parking and claiming

The `Connection` class is split into what belongs to the document and what belongs to the app:

- **The document's part** (moves across the swap): the transport `t`, `state`, `backoff`, `everOpen`,
  the backoff timer, and the delivery callback the transport was given. `t.connect(…)` is called once, and
  the callback stays the same function, so **transports need no change**: the default `EventSource`, the
  WebSocket transport, the SignalR recipe and a custom one all carry over.
- **The app's part** (rebuilt by each page): `app`, `subs` (each `[EventDef, scope]`), `changed` (that
  page's `publish` of `$meta.live`), and the listeners `start()` registers through `app.addCleanup`
  (`pagehide`, `pageshow`, `onListen`).

**Parking** (the old app's cleanup, window open): drop `app`, `subs` and `changed`, start a buffer, and put
the connection in `conns` under its URL. Only a connection with a live transport is parked (`connecting`
or `open`). One waiting in backoff (`retrying`, no transport, a timer) is stopped as today. The next page
opens its own connection, through the probe on its first error as always.

**Claiming** (the next app's `sse` microtask): take the connection out of `conns`, set its `app`, `subs`
and `changed`, register the next app's listeners, and call `t.listen(name)` for every event name the next
page maps or listens to through `app.on`. That is the names the old page didn't need, since `EventSource`
only delivers names it has a listener for. Then **replay the buffer** (§5) and call `changed()` once, so
`$meta.live` shows the carried state. `start()` doesn't call `open()` for a claimed connection.

Two details in today's `open()` have to move for this to be correct:
- The reconnect refetch reads `subs` from a closure taken when the connection opened. After a claim, a
  later reconnect would refetch the **old** page's resource names in the next app. It must read
  `this.subs` when the `'open'` state arrives.
- `this.app.streamOpened` (the dev HTTP/1.1 check) runs only on a real open, not on a claim, so a claimed
  stream isn't counted twice.

### 4. Closing what nobody claimed

The swap closes the window and the unclaimed connections **after `booted` has settled, at the next task**
(a `setTimeout(0)` in swap-run.ts, after `await booted`). By then the next page's `sse` microtask has run,
because microtasks finish before a task. It has to be the swap that does this, for three reasons:

- `$boot` may be `async` (built-in messages), so a timer started at the commit could fire before the next
  page mounts, and the connection would be closed for nothing.
- A next page without `<sn-sync>` has no `sse` feature, so nothing on that page could close the
  connections.
- A swap that fails reloads the page (`location.reload()`), which ends the document and its connections.
  A newer navigation that aborts the swap before the commit never opened the window. One that comes after
  the commit finds this swap's window still open. It closes it first (closing what nobody claimed), then
  opens its own.

`pagehide` while the window is open (a load started before the swap finished) closes the parked
connections. The registry listens once per document. That is the back/forward cache rule of
[sync.md](../sync.md#connection-rules): an open stream must not keep the page out of the cache.

### 5. Events in the gap

While parked, the delivery callback appends `[name, payload]` to the connection's buffer instead of
calling `app.streamed` and `app.serverEvent`. At the claim, the buffer is replayed through the same path
as a live event, in order, before the claim returns. Live events after the claim go straight through.
Each event is applied once, by the next page only:

- **`<sn-event>` mappings and `then`** run in the next page's scopes against the next page's resources.
  Events the next page doesn't map are dropped, as they are on any page. A `then` that the old page's
  `<sn-event>` had and the next page's doesn't is not run: the handler belongs to the page that declares it.
- **`app.on` listeners** (component scripts like `<mail-notifier>`, islands) get the replayed events
  through `serverEvent`. They register during the mount, which comes before the `sse` microtask, so
  they're there when the buffer is replayed.
- **Resources:** the next page's resources start their fetches at the mount, after the gap's events were
  sent. Mostly the response already contains those changes. Replaying them is harmless, because
  `upsert`, `patch` and `remove` are idempotent and `refetch`es coalesce. It is also what a live event
  arriving during the first fetch does today. The replay does not refetch on its own: the connection never
  dropped.
- **A cap:** at most 1000 events, or the window's close, whichever comes first. If the buffer overflows,
  the connection keeps the newest 1000 and is marked lossy. At the claim it then refetches every resource
  it feeds once, through the existing catch-up path that `everOpen` uses after a reconnect.

Event names the old page never listened to and the next page does: with `EventSource`, events of such a
name sent during the gap are not delivered, because there was no listener. The next page gets them from
the claim on. This is no worse than today, where every name is lost in the gap. A server that sends one
event type (`message`) with a `type` field in the payload avoids it. The docs say so (§8).

### 6. State, the probe, `$meta.live`

- **`$meta.<resource>.live`** on the next page starts at the claimed connection's state. The `feeders` map
  is the next page's, built from its own `<sn-event>`s, so a resource the old page fed and the next doesn't
  shows `null` as on any page.
- **An error while parked:** the transport reports `'error'`. With no app, the probe can't run (it uses
  `app.req` for the session probe and the login redirect), so the parked connection closes its transport,
  takes itself out of `conns`, and the next page opens its own. The gap's buffered events, if any, are
  dropped with it. The next page fetches its resources, as a page does today.
- **An error after the claim** goes through the probe and backoff as today, in the next app. `everOpen`
  is carried, so the reconnect refetches the next page's resources (§3).

### 7. Where the code goes

- `src/sse.ts`: the split, park, claim, buffer and replay; the registry type.
- `src/swap-run.ts`: in `swap()`, open the window before `old.destroy()`. After `await booted`, at the
  next task, close the window and what is unclaimed. Close an open window before a newer swap's commit
  (§4).
- Nothing in the compiler, the IR, the transports or the server.

### 8. Size

The handover costs bytes only on pages that use `sse`. The swap's share (opening and closing the window)
goes in `swap-run.ts`, which is loaded when a swap happens. Estimate: +200 B gzip for the `sse` feature,
+60 B for swap-run. If the `sse` share is measured over 150 B, it goes behind the build's `swap` option,
the same way the page module's `$boot` registration is (compiler/index.ts), so apps without swaps don't pay
it.

## Testing

- **Behaviour (`test/behaviour/sync.test.ts`, `destroy.test.ts`)**, with a fake transport and a fake
  `env`:
  - park on destroy with the window open, claim by the next app: `connect` called once, `close` never;
  - the next page with another URL, or the same URL with another transport: old closed at the window's
    close, new opened;
  - interpolated `src` (`/rooms/{room}/events`), same and different values;
  - events in the gap: applied once by the next page, in order, before a live event sent after the claim;
    `app.on` listeners get them; the old page's `then` doesn't run;
  - an async boot (a promise that resolves later): nothing is closed before it resolves;
  - buffer overflow: newest 1000 kept, fed resources refetched once;
  - an error while parked: the next page connects anew; after the claim, a reconnect refetches the next
    page's resources, not the old page's;
  - `$meta.live` is `'open'` from the next page's first flush;
  - `destroy()` with no window: closes as today (the existing destroy tests stay as they are).
- **E2E (`e2e/permanent`):** the dashboard page's stream across five swaps, a page without `<sn-sync>` and
  back. The `EventSource` count (opened and closed) is recorded the way swap-navigation's spike counted
  them, and an event sent by the server during a delayed swap (the test server holds the next page's HTML)
  arrives once on the next page. Chromium, Firefox and WebKit, as for the swap.
- **caley:** the Playwright count from the case (5 swaps: 1 opened, 0 closed; mail → settings → mail keeps
  one), and a `new_email` sent during a swap shows one notification.

## Not in this proposal

- **Event ids and `Last-Event-ID`.** sinter closes an `EventSource` on error and opens a new one after the
  probe, so the browser's own `Last-Event-ID` is not sent. Resuming from an id after a real disconnect would
  be a separate change in the transport and in the catch-up refetch. The handover doesn't need ids, because
  the connection never drops.
- **Streams across loads** (a `SharedWorker`, a connection per tab shared by tabs). Each tab still opens
  its own ([sync.md](../sync.md#connection-rules)).
- **Resources handed over** (the rail's `call` resource refetched on every swap). That is data, not a
  connection, and it is a decision of its own. `cache` covers part of it today.
- **Re-resolving `src` while a page is shown** (a stream URL that follows state). It is resolved once per
  page, as today.

## Docs

- `docs/sync.md`, Connection rules: "**Swaps keep a stream open.** With swaps on, a stream whose URL the
  next page also declares stays connected; events in between are delivered to the next page. Any other
  stream closes." Plus the note on event names (§5).
- `docs/navigation.md`, Swaps: "its resources and streams" becomes "its resources, and its streams unless
  the next page declares the same URL".
- swap-navigation.md: link this proposal from §7 and from Not in this proposal.
- CHANGELOG.

## Plan

One commit each:

1. The split of `Connection` (document part and app part) and the reconnect refetch reading
   `this.subs`, with no behaviour change. The existing tests pass unchanged.
2. The registry, parking, claiming and the window in swap-run.ts, without the buffer: events in the gap
   are dropped. Measured in caley: 1 opened per session.
3. The buffer, the replay and the cap.
4. Errors while parked, `pagehide` during the window, a newer swap after the commit.
5. E2E in `e2e/permanent`, size measured, the gate if it's needed (§8), docs.

## Open questions

- **The cap's value** (1000) and whether overflow should keep the newest or stop buffering. Keeping the
  newest plus a refetch seems right for resources, but `then` handlers lose the oldest events.
- **A `refetch` replayed while the next page's first fetch is in flight**: whether it coalesces with that
  fetch or sends a second request. The behaviour tests should pin it down. Today the same happens with a
  live event during a first load.
