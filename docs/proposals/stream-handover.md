# Proposal: streams that stay open across a swap

Status: steps 1 to 4 of the [Plan](#plan) implemented 2026-11-17 (`src/sse-handover.ts`, `src/sse.ts`, the
window in `src/swap-run.ts`, `test/behaviour/stream-handover.test.ts`, `test/vite/stream-handover-size.test.ts`);
step 5's browser runs in `e2e/permanent` are still to do. Proposed and revised the same day after a review against the code (the
transport comparison, the listened names, when the buffer is replayed, a window per swap, parked state,
document apps only, the size baseline, the tests). It follows [swap-navigation.md](swap-navigation.md), whose
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
- **Events in the gap are buffered and replayed** to the next page, in order, before any live event, once
  the next page has mounted and its `sn-page` listeners have run.
- **The swap closes what nobody claimed**, once the next page has mounted. A timer can't do it, because the
  mount can be asynchronous. Each swap has its own window, and a swap closes only its own.
- **Without a swap, nothing changes:** `destroy()` closes the app's streams as today (embed, tests, an app
  mounted on an element). Only the document's app parks or claims.
- **Only apps with swaps on pay for it** (decided 2026-11-17): the handover sits behind a build flag, so the
  `sse` code of an app without `swap: true` is byte for byte the same as after the step-1 refactor ([8](#8-size-only-with-swaps-on)).

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
   `<sn-event>`s and `then` handlers once, and the `app.on` listeners registered by then (§5 says which).
3. A URL the next page doesn't declare is closed by the end of the swap, as today.
4. `$meta.<resource>.live` on the next page is the handed-over connection's state (`'open'`) before the
   first paint, so an indicator doesn't flash "connecting" on every click. The mount itself still sets
   `'connecting'` (app.ts, `def.fed`); the claim, in the microtask after it, sets it again.
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
- **The same transport.** `app.transport(url) ?? config.transport?.(url)` returns a new `Transport` object
  on every call (src/ws.ts, the SignalR recipe), so the transports can't be compared. What is compared is
  where the transport came from, recorded when the connection opens: `via`, the `config.transport` function
  it was made by, or `null` for the default `EventSource`. A connection whose transport came from an app's
  mount-time `transport` option is never parked. A claim needs two things:
  - The next app has no override for the URL. The install asks `app.transport(url)`, as `open()` does today.
    If that returns a transport, the new connection uses it for its first open, so nothing is built and
    thrown away. Page modules mount with `{ ir, fns, features }` and no `transport`, so swapped pages
    never have an override.
  - `config.transport` is the same reference as the parked connection's `via`. The config module runs once
    per document under swaps ([swap-navigation.md §6](swap-navigation.md#6-the-pages-code)), so it stays the
    same unless app code reassigns it.

  Otherwise the parked connection is not claimed: it is closed, and the next page opens its own.
- **The transport must be able to take the next page's names.** `listen` is optional on a `Transport`. A
  parked connection whose transport has no `listen` is claimed only if every name the next page maps is
  among those it connected with. Otherwise it is closed and reopened.
- **Kept or not makes no difference.** The rail's `<sn-sync>` is in the next page's IR, because the
  layout writes it into every page and the next page's code takes the kept element over. The mail page's
  `<sn-sync>` is in the mail page's IR. Mail → settings keeps the connection: the settings page's rail
  declares the URL, and the mail page's `<sn-event>`s go with the mail page. Settings → mail keeps it too,
  and the mail page's mappings join the rail's.

### 2. Where a parked connection lives

There is one registry per document, `globalThis[Symbol.for('sinter.streams')]`, which follows the pattern
of `sinter.pages` and `sinter.swap`:

```ts
/** one swap's window: from just before `old.destroy()` until the swap closes it (§4) */
interface Window {
  /** parked, not yet claimed, by resolved URL */
  parked: Map<string, Connection>;
  /** claimed by the next page, waiting for the replay (§5) */
  claimed: Connection[];
}
interface Streams { window: Window | null }
```

The swap creates a `Window` in `swap()`, sets it as `streams.window` just before `old.destroy()`, and keeps
its own reference to close it (§4). The `sse` feature parks into `streams.window` while it is set. Every
other `destroy()` closes, as today. Without swaps the registry is never created, so a page whose
`<sn-sync>` was never swapped behaves exactly as now.

**Only the document's app** parks or claims (`app.root === document`, the guard `swap.ts` already uses for
the same reason). An app mounted on an element of the page and destroyed or mounted during the window
closes and opens its streams as today. It can't take the page's connection, and the page's connection
can't take its connection.

### 3. Parking and claiming

The `Connection` class is split into what belongs to the document and what belongs to the app:

- **The document's part** (moves across the swap): the transport `t`, `state`, `backoff`, `everOpen`,
  the backoff timer, and the delivery callback the transport was given. `t.connect(…)` is called once, and
  the callback stays the same function, so **transports need no change**: the default `EventSource`, the
  WebSocket transport, the SignalR recipe and a custom one all carry over.
- **The app's part** (rebuilt by each page): `app`, `subs` (each `[EventDef, scope]`), `changed` (that
  page's `publish` of `$meta.live`), and the listeners `start()` registers through `app.addCleanup`
  (`pagehide`, `pageshow`, `onListen`).

**Parking** (the old app's cleanup, window set): drop `app`, `subs` and `changed`, start a buffer, and put
the connection in `window.parked` under its URL. The test is whether a transport exists (`this.t != null`),
not the state. A connection waiting in backoff has no transport, and neither does one after `pageshow`,
which shows `connecting` while its probe runs. Both are stopped as today. The next page opens its own
connection, through the probe on its first error as always.

**While parked, nothing reaches an app.** The transport may still report a state. `'open'` can arrive for a
connection parked in `connecting`, and `'error'` can arrive in any state. `open()`'s `onState` callback
records the state and goes no further: no `changed()`, no `streamOpened`, no refetch (§6 has the error
case). `streamOpened` is not run for an open that happened while parked (implemented so: it is a dev
warning about HTTP/1.1, which the old page's open already checked for the URL).

**Claiming** (the next app's `sse` microtask, with the §1 conditions): take the connection out of
`window.parked` and add it to `window.claimed`. Set its `app`, `subs` and `changed`, and register the next
app's listeners: `pagehide` and `pageshow`, and `onListen`, so later `app.on()` calls add their names. Call
`t.listen(name)` for every name the next page maps. `EventSource` only delivers names it has a listener for,
so this covers the names the old page didn't need. Call `changed()` once, so `$meta.live` shows the carried
state before the first paint. `start()` doesn't call `open()` for a claimed connection. The buffer stays:
it is replayed when the window closes (§5), and events that arrive until then join it, so the order holds.

**Names from `app.on`.** The `sse` feature collects the names `app.on` listens to from its install on
(`heard`, through `onListen`, which it registers at install, before the mount's walk), so it also sees a
component script's `connected()` in the mount. Every connect subscribes the mapped names and `heard`. This
was fixed on its own before the handover (a name `app.on` listened to was lost after a reconnect, found in
caley's `<mail-notifier>`). At the claim, the connection calls `t.listen` for the next app's `heard` names
too.

Two details in today's `open()` have to change for this to be correct:
- The `reconnect` flag and the `subs` list are closure captures taken when the connection opened. After a
  claim, a later reconnect would refetch the **old** page's resource names in the next app. Both must read
  `this` (`this.everOpen`, `this.subs`) when the `'open'` state arrives.
- `this.app.streamOpened` (the dev HTTP/1.1 check) runs once per real open, never for the claim itself,
  so a claimed stream isn't counted twice.

### 4. Closing what nobody claimed

The swap closes its window **after `booted` has settled and `sn-page` has been dispatched, at the next
task**. That is a `setTimeout(0)` in swap-run.ts, scheduled after the `sn-page` dispatch. By then the next
page's `sse` microtask has run, because it is queued inside `mount()` and microtasks finish before a task.
This holds for a sync and an async `$boot`, and inside the view transition's update callback. Closing does
three things in order:

1. If `streams.window` is still this window, set it to `null`. A newer swap may have replaced it already
   (below).
2. Close every connection in `window.parked`.
3. Replay and stop buffering every connection in `window.claimed` (§5).

It has to be the swap that does this, for three reasons:

- `$boot` may be `async` (built-in messages), so a timer started at the commit could fire before the next
  page mounts, and the connection would be closed for nothing.
- A next page without `<sn-sync>` has no `sse` feature, so nothing on that page could close the
  connections.
- A swap that fails reloads the page (`location.reload()`), which ends the document and its connections.

**A newer swap.** A navigation that aborts a swap before its commit never opened a window, because the
commit returns before `swap()`. A swap B that commits while swap A's window is still open does two things:
- It moves A's unclaimed `parked` connections into its own window, since B's page may declare their URLs.
- It replays A's `claimed` connections before destroying A's app. They then park into B's window like any
  other connection, with their order intact.

A's close task then finds `streams.window` is no longer A's window, and both of A's lists are empty, so it
does nothing. **A window per swap** is what makes this safe: with a shared flag, A's stale task would close
the connections B parked before B's async boot claims them.

**A cap on time.** A `booted` that never settles would leave the window, and its parked connections, open
indefinitely. The swap closes the window after 10 s whatever happens. In practice a boot that slow is a
boot that failed, and the reload follows.

`pagehide` while the window is open (a load started before the swap finished) closes the parked
connections. The registry listens once per document. That is the back/forward cache rule of
[sync.md](../sync.md#connection-rules): an open stream must not keep the page out of the cache.

### 5. Events in the gap

From the park until its window closes, the delivery callback appends `[name, payload]` to the connection's
buffer instead of calling `app.streamed` and `app.serverEvent`. This covers the claim too. At the window's
close (§4), the buffer is replayed through the same path as a live event, in order, and live events go
straight through from then on.

The replay waits for the close, not the claim, so that listeners registered after the mount still get the
gap's events: islands and per-page app code register in `sn-page`, which swap-run.ts dispatches after
`await booted`, after the claim microtask. The cost is one task of delay for the events in the window.

Each event is applied once, by the next page only:

- **`<sn-event>` mappings and `then`** run in the next page's scopes against the next page's resources.
  Events the next page doesn't map are dropped, as they are on any page. A `then` that the old page's
  `<sn-event>` had and the next page's doesn't is not run: the handler belongs to the page that declares it.
- **`app.on` listeners** get the replayed events through `serverEvent` if they're registered by the
  window's close. That covers component scripts, whose `connected()` runs in the mount, and code in an
  `sn-page` listener. It does not cover a component script loaded with lazy packages: that one connects
  once its import resolves, which can be later. It misses the gap's events as it misses events before it
  connects on a page load.
- **Resources:** the next page's resources start their fetches at the mount, after the gap's events were
  sent. Mostly the response already contains those changes. Replaying them is harmless, because
  `upsert`, `patch` and `remove` are idempotent and `refetch`es coalesce. It is also what a live event
  arriving during the first fetch does today. The replay does not refetch on its own: the connection never
  dropped.
- **A cap:** at most 1000 events, along with the 10 s cap on the window (§4). If the buffer overflows,
  the connection keeps the newest 1000 and is marked lossy. At the replay it then refetches every resource
  it feeds once, through the existing catch-up path that `everOpen` uses after a reconnect.

Event names the old page never listened to and the next page does: with `EventSource`, events of such a
name sent during the gap are not delivered, because there was no listener. The next page gets them from
the claim on. This is no worse than today, where every name is lost in the gap. A server that sends one
event type (`message`) with a `type` field in the payload avoids it. The docs say so (§8).

### 6. State, the probe, `$meta.live`

- **`$meta.<resource>.live`** on the next page is `'connecting'` from the mount (as for any fed resource)
  and the claimed connection's state from the claim microtask, before the first paint. The `feeders` map is
  the next page's, built from its own `<sn-event>`s, so a resource the old page fed and the next doesn't
  shows `null` as on any page.
- **An error while parked** (before the claim): the transport reports `'error'`. With no app, the probe
  can't run (it uses `app.req` for the session probe and the login redirect), so the parked connection
  closes its transport, takes itself out of `window.parked`, and the next page opens its own. The gap's
  buffered events, if any, are dropped with it. The next page fetches its resources, as a page does today.
- **An error after the claim, before the replay:** the connection has its app again, so the error goes
  through the probe and backoff as usual. The buffer is still replayed at the window's close.
- **An error after the claim** goes through the probe and backoff as today, in the next app. `everOpen`
  is carried, so the reconnect refetches the next page's resources (§3).

### 7. Where the code goes

- `src/sse.ts`: the split, and the `if (SWAP)` calls into the handover.
- `src/sse-handover.ts` (new): park, claim, buffer and replay; the registry type.
- `src/runtime/flags.ts`, `src/core-parts.ts` (`flagsModule`): the `SWAP` flag, from the build's `swap` option.
- `src/swap-run.ts`: in `swap()`, take over an open window's parked connections and replay its claimed
  ones, then set a new window before `old.destroy()`. After the `sn-page` dispatch, at the next task, close
  its own window (§4), with a 10 s cap.
- Nothing in the compiler, the IR, the transports or the server.

### 8. Size: only with swaps on

The handover adds nothing to the `sse` code of an app that doesn't turn swaps on (decided 2026-11-17).
It sits behind a build-time constant in the core's flags module, as `SHARED` does
([runtime/flags.ts](../../src/runtime/flags.ts)):

```ts
/** `sinter({ swap: true })`: a stream whose URL the next page declares stays open across a swap */
export const SWAP = true;
```

- A build (src/vite.ts, `flagsModule` in src/core-parts.ts) serves it as `true` when the project has
  `swap: true` and as `false` otherwise. The bundler inlines the constant and drops what it guards, as it
  does for the core's parts.
- `flagsModule(parts, shared)` (src/core-parts.ts) takes a third argument, `swap`. `options.swap` is in
  scope where src/vite.ts serves the flags module. The mechanism is proven: `SHARED`, imported from the
  flags module, is already dropped from another chunk (swap-run, `test/vite/early-shared.test.ts`).
- The park, claim, buffer and replay live in their own module, `src/sse-handover.ts`. The package has
  `sideEffects: false`, so with nothing referencing it the module is dropped. `sse.ts` reaches it only
  through `if (SWAP && …)` branches. That means every parked-mode check (in the cleanup, the install,
  `event()`, `set()` and `onState`) is written with `SWAP` first, so the bundler drops the whole branch.
- **The baseline is the output after [Plan](#plan) step 1.** Step 1, the `Connection` split and the
  `this.everOpen` and `this.subs` reads, changes the `sse` bytes of every app; it is a fix as much as a
  refactor (§3). Its size delta is measured and reported on its own and kept to a minimum. From step 2 on,
  a build without swaps is byte-identical to the step-1 output.
- **There is no `sse` chunk to compare.** `sse` is a static import of the page modules and lands wherever
  the bundler puts shared code. The size test (`test/vite/stream-handover-size.test.ts`) builds a fixture
  with and without swaps and checks all of the JS output for what only the handover has (the registry's key,
  its fields). The identity with step 1 was checked once by the chunks' hashes (the same file names).
- Dev, and an app built without the Vite plugin, have every flag on, as for the core's parts, so they carry
  the handover module. In dev that is wanted: the same code path as a swap build. Without the plugin there
  are no swaps (the page list is the build's), so the window never opens and the module is dead bytes.
  That is the same trade the core's parts already make there.
- The swap's share (the windows) goes in `swap-run.ts`, which only swap builds carry.
- With swaps, the estimate was +250 B gzip for the handover module and +80 B for swap-run. Measured on a
  two-page fixture with one `<sn-sync>`: the chunk with the stream feature +506 B gzip, swap-run +161 B
  (minimal with swaps: 12869 B gzip, budget 13824). Without swaps: the same bytes as after step 1, which was
  itself 2 B smaller than before. Within the swap
  pages' budgets.

## Testing

- **Behaviour (`test/behaviour/sync.test.ts`, `destroy.test.ts`)**, with a fake transport and a fake
  `env`:
  - park on destroy with the window open, claim by the next app: `connect` called once, `close` never;
  - the next page with another URL: old closed at the window's close, new opened. The same URL with
    another `config.transport`, or with an app override: not claimed. A transport without `listen` and a
    new mapped name: closed and reopened;
  - interpolated `src` (`/rooms/{room}/events`), same and different values;
  - events in the gap and between claim and close: applied once by the next page, in order, before a live
    event sent after the close. `app.on` listeners registered in the mount and in `sn-page` get them. The
    old page's `then` doesn't run;
  - an async boot (a promise that resolves later): nothing is closed before it resolves. A boot that never
    resolves: closed at 10 s;
  - swap B committing before A's close task: A's parked connections are claimed by B's page, A's task
    closes nothing of B's;
  - `'open'` arriving while parked: no app touched, `streamOpened` once at the claim;
  - an element-mounted app destroyed and mounted during the window: neither parks nor claims;
  - buffer overflow: newest 1000 kept, fed resources refetched once;
  - an error while parked: the next page connects anew. After the claim, a reconnect refetches the next
    page's resources, not the old page's;
  - `$meta.live`: `'connecting'` after the mount's walk, `'open'` after the claim microtask, before any frame;
  - `destroy()` with no window: closes as today (the existing destroy tests stay as they are).
- **Size (`test/vite`):** a fixture without swaps, all JS output hashed, unchanged from step 1 (§8).
- **E2E (`e2e/permanent`):** it has no `<sn-sync>` today, so this needs a fixture: two pages with a stream
  in a kept element, one page with a second `<sn-sync>` on the same URL, one without, and an SSE endpoint
  in `run.mjs`'s server. Five swaps across them and back. The `EventSource` count (opened and closed) is
  recorded with a wrapper installed before the page's scripts, and an event sent by the server during a
  delayed swap (the server holds the next page's HTML) arrives once on the next page. Chromium, Firefox
  and WebKit, as for the swap.
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
  stream closes." Plus the note on names sent in the gap (§5).
- `docs/navigation.md`, Swaps: "its resources and streams" becomes "its resources, and its streams unless
  the next page declares the same URL".
- swap-navigation.md: link this proposal from §7 and from Not in this proposal.
- CHANGELOG.

## Plan

One commit each:

1. The split of `Connection` (document part and app part), and the reconnect reading `this.everOpen` and
   `this.subs`. No behaviour change, the existing tests pass unchanged, and the size delta is reported. This
   is the baseline for §8.
2. The `SWAP` flag and the size test. Then the registry, windows per swap, parking, claiming (transport
   origin, `listen`, document app only) and the close in swap-run.ts, without the buffer, so events in the
   gap are dropped. Measured in caley: 1 opened per session.
3. The buffer, the replay at the close, and the caps.
4. Parked state (`onState` while parked, errors), `pagehide` during the window, a newer swap before the
   close.
5. E2E fixture and runs in `e2e/permanent`, docs.

## Open questions

- **The cap's value** (1000) and whether overflow should keep the newest or stop buffering. Keeping the
  newest plus a refetch seems right for resources, but `then` handlers lose the oldest events.
- **A `refetch` replayed while the next page's first fetch is in flight**: whether it coalesces with that
  fetch or sends a second request. The behaviour tests should pin it down. Today the same happens with a
  live event during a first load.
