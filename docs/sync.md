# Live updates

`<sn-sync>` connects a page to a stream of server events and turns each event into a change on a
[resource](resources.md): add or replace an item, patch fields, remove it, or reload the list. Lists
on screen update by themselves, and optimistic changes stay consistent when an event arrives
mid-request.

```html
<sn-resource name="people" src="/api/people" key="id" order="name"></sn-resource>

<sn-sync src="/api/events">
  <sn-event name="person_updated" resource="people" op="upsert" item="person"></sn-event>
  <sn-event name="person_removed" resource="people" op="remove"></sn-event>
</sn-sync>

<ul>
  <template data-sn-for="p in people"><li data-sn-text="p.name"></li></template>
</ul>
```

The server sends [Server-Sent Events](https://developer.mozilla.org/docs/Web/API/Server-sent_events)
with a JSON payload:

```text
event: person_updated
data: {"person": {"id": 7, "name": "Ada"}}

event: person_removed
data: {"id": 7}
```

`item="person"` reads `payload.person`. For `remove` (and `patch`) the key comes from the payload,
using the resource's `key` fields: here `id`. See [recipes/sse-sync.html](recipes/sse-sync.html).

## Change messages

Whatever the transport, the store only understands four changes:

| `op` | Effect | Needs |
| --- | --- | --- |
| `upsert` | add the item, or replace the one with the same key | `item` (default: the whole payload) |
| `patch` | merge fields into the item with that key | `set`, key in the payload |
| `remove` | delete the item with that key | key in the payload |
| `refetch` | reload the resource | nothing |

## `<sn-event>` attributes

| Attribute | Meaning |
| --- | --- |
| `name` | The event name: the SSE event name, or whatever the transport reports. |
| `resource` | Target resource. |
| `op` | `upsert`, `patch`, `remove` or `refetch`. |
| `item` | Expression for `upsert`. Default: the whole payload. |
| `set` | Object literal for `patch`, e.g. `{flags, is_read: flags.includes('\\Seen')}`. |
| `when` | Skip the event unless this is truthy, e.g. `mailbox === $url.mailbox`. |
| `fallback` | `refetch`: reload when `item` evaluates to null, for servers that send some updates without a body. |
| `then` | Handler run after the change is applied, see [Reacting to events](#reacting-to-events). |
| `type` | The payload's type, for `sinter check` ([type-checking.md](type-checking.md)). |

Attributes are expressions evaluated against the event's parsed payload: its fields are bare names.
State declared around the `<sn-sync>` is in scope too, and `src` of `<sn-sync>` is evaluated the
same way. Loop variables and resources are not in scope.

```html
<sn-event name="message_changed" resource="messages" op="patch"
          set="{flags, is_read: flags.includes('\\Seen')}"
          when="mailbox === sel.mailbox"></sn-event>
```

Here `mailbox` is a payload field and `sel` is state. Events with no `<sn-event>` are still
delivered to [islands](islands.md).

## Reacting to events

`then` is a handler expression, like `data-sn-then` on an [action](actions.md). It runs after the
change is applied (for `refetch`: once the reload is requested, not when it finishes), and may
assign state. With `then`, `resource` and `op` can be left out: the event only runs its handler.

```html
<body data-sn-state="{ sel: null, notice: '' }">
  <sn-sync src="/api/events">
    <sn-event name="person_removed" resource="people" op="remove"
              then="sel?.id === id && close('person')"></sn-event>
    <sn-event name="notice" then="notice = text"></sn-event>
  </sn-sync>
</body>
```

- The handler runs for every event that passes `when`. It does not run when the payload can't be
  applied: a `patch` or `remove` without the key fields, or an `upsert` without an item and no
  `fallback`.
- Store functions are in scope (`refresh`, `upsert`, `patch`, `remove`, `page`, `showModal`,
  `close('id')`, `run('id')`) and win over payload fields of the same name.
- There is no element, so `close()` must name its dialog, and `reset()` and `emit()` are errors
  (`SN203`). `$event` and `$result` are not defined, and assigning to a payload field is an error.
- A state name wins over a payload field of the same name. With a typed payload (`type`), such a
  clash is a `sinter check` error; without a type, pick names the payloads don't use.
- `data-sn-let` names declared around the `<sn-sync>` resolve like state, before payload fields.
  A `data-sn-let` that reads `$el` is `SN201` here, since there is no element.

## Transports

SSE is the default. The transport is chosen per stream URL in the config module
([configuration.md](configuration.md)); the URL in the HTML stays an http(s) URL.

```js
import { configure } from '@tiaforge-ui/sinter';
import { webSocketTransport } from '@tiaforge-ui/sinter/ws';

configure({
  transport: (url) => url.startsWith('/ws/') ? webSocketTransport() : undefined, // undefined: EventSource
});
```

### WebSocket

`webSocketTransport({ protocols, decode })` opens the URL as `ws:` or `wss:`. Each text message is
JSON:

```json
{ "event": "person_updated", "data": { "person": { "id": 7, "name": "Ada" } } }
```

`decode(message)` can read another format: return `[name, payload]`, or `null` to ignore the
message.

### SignalR

Copy [recipes/signalr-transport.js](recipes/signalr-transport.js) into your app: sinter does not
depend on `@microsoft/signalr`. Hub method names are the event names and the first argument is the
payload (`Clients.All.SendAsync("person_updated", new { person })`). The page is the same as with
SSE, see [recipes/signalr.html](recipes/signalr.html).

```js
import { HubConnectionBuilder } from '@microsoft/signalr';
import { signalRTransport } from './signalr-transport.js';

configure({
  transport: (url) => url.startsWith('/hubs/')
    ? signalRTransport(() => new HubConnectionBuilder().withUrl(url).build())
    : undefined,
});
```

- Don't call `withAutomaticReconnect()`. sinter reconnects, and two reconnect loops would race.
- SignalR treats hub method names case-insensitively: keep event names distinct in more than case.

### Your own transport

A transport is an object with `connect(url, onEvent, onState, names)`, an optional `listen(name)`
and `close()`:

- `onEvent(name, payload)` delivers one event with its **parsed** payload.
- `onState('open')` once connected; `onState('error')` when the connection is lost, cleanly or not.
  Nothing is reported after `close()`.
- `names` are the event names the page maps. `listen(name)` adds one an island subscribes to later.
- A transport never reconnects by itself.

Actions always go over HTTP, so `then`/`catch`, optimistic updates and 401 handling work the same
on every transport. Auth on a WebSocket or hub belongs to the transport: browsers send cookies, but
request middleware does not apply.

## Connection status

`$meta.<resource>.live` is the state of the stream that feeds a resource (a resource is fed by a stream
when one of its `<sn-event>` elements names it in `resource`):

| `live` | Meaning |
| --- | --- |
| `'connecting'` | Until the stream first opens, and while a page restored from the back/forward cache reconnects. |
| `'open'` | The stream is connected. |
| `'retrying'` | The stream failed; sinter is probing the session and backing off. It is `'open'` again after a reconnect, and the resource is refetched once. |
| `null` | No `<sn-event>` feeds this resource. |

When several streams feed a resource, `live` is the worst of their states, so an indicator never says
"open" while one of them is down.

```html
<span data-badge data-sn-text="$meta.services.live === 'open' ? 'Live' : 'Reconnecting…'"
      data-sn-attr="{ 'data-tone': $meta.services.live === 'open' ? 'success' : 'warning' }"></span>
```

Reading `live` of a resource that no `<sn-event>` feeds is the warning [SN516](diagnostics.md#sn516-unfed-live): it is always `null`.

The state is not an error: events sent while the stream was down are caught up by the refetch, and
the data stays on screen. A page that never reads `live` pays nothing for it. A prerendered page
reads `'connecting'` until it is shown. A custom transport sets it through `onState('open' | 'error')`.

## Connection rules

- **One connection per URL.** `<sn-sync>` elements whose `src` resolves to the same URL share one
  connection, and all their `<sn-event>` mappings apply, each in its own `<sn-sync>`'s scope. An
  event mapped twice applies twice; islands receive it once.
- **Reconnects go through the session probe.** `EventSource` can't see the HTTP status, so after an
  error sinter calls the `sessionProbe` URL from the config module through the request layer: 2xx
  reconnects, 401 follows the normal login redirect, a network error waits and probes again.
  Offline is never treated as logged out.
- **Backoff** starts at 1 s, doubles up to 30 s with jitter, and resets after a successful
  reconnect.
- **Missed events are caught up.** After a reconnect, every resource fed by that stream is
  refetched once, because events sent while disconnected are lost.
- **Back/forward cache.** The connection closes on `pagehide` and reopens on `pageshow`, so an open
  stream doesn't keep the page out of the cache. Reopening goes through the probe, so a page
  restored after logout is redirected to login.
- **Refetches coalesce.** Several `refetch` messages for one resource in the same task cause one
  request.
- **Streams aren't shared across tabs.** Each tab opens its own connection.

### Paginated resources

On a paginated resource, an `upsert` for an item that isn't on the current page becomes a
`refetch` of the current page. `patch` and `remove` apply only to items already present. On an
`each` resource, `refetch` reloads only the source the payload resolves to.

## Deploying streams

Each open `EventSource` holds one HTTP connection. HTTP/1.1 browsers allow 6 per origin, so with
more than 5 tabs open the next page stops loading. Serve streams over HTTP/2 or HTTP/3, where one
connection carries about 100 streams. Any TLS reverse proxy such as nginx or Caddy provides it. The
WebSocket transport is not counted against that limit either.

Dev builds warn once when a stream's origin was reached over HTTP/1.1.
