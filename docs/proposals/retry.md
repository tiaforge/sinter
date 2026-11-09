# Proposal: retry policies

Status: accepted and implemented, 2026-11-09 (spec: Retry policies, under Actions). The open questions below were decided as recommended: background refreshes skip `retry.get`, unknown policy names are found at runtime (a dev warning at mount, the action fails), and leaving the page asks only while a write waits for a retry. Target: the groupware app (drafts, notes, events), where a write
made while the connection is down must not get lost and the user must know before leaving the page.

## Summary

- A write is resent only when its element names a retry policy: `data-sn-retry="drafts"`. Without one
  it is sent once and fails as today.
- Policies are named objects in the config module. One of them can be the default for every GET
  (`retry.get`); writes have no default.
- Retries follow the stream's connection rules: after a network error the session probe decides
  (2xx: try again, 401: login, anything else: wait longer).
- Each write carries an `Idempotency-Key`, one per trigger, the same on every attempt.
- The request layer's own automatic resend is removed: nothing is resent unless a policy says so.
- While a write waits for a retry, its element keeps `aria-busy`, its optimistic layer stays, and
  leaving the page asks first (`beforeunload`).
- The queue lives as long as the page. Nothing is stored; a write that gets a 401 is lost.

## Configuration

```js
// src/sinter.config.js
import { configure } from '@tiaforge-ui/sinter';
import { retry } from '@tiaforge-ui/sinter/retry';

configure({
  sessionProbe: '/api/user',
  retry: retry({
    policies: {
      drafts:  { backoff: ['1s', '30s'] },                 // until it succeeds or the page is closed
      network: { backoff: ['1s', '10s'], retries: 3 },
      hourly:  { backoff: ['5m', '5m'], retries: 3 },
    },
    get: 'network',                                         // default policy for every GET; absent: no retry
  }),
});
```

The config module imports the policies through `retry()`, as it imports `webSocketTransport()`: the
module's code ships with the config module only in apps that use it, and core carries only the hook.

| Field | Default | Meaning |
| --- | --- | --- |
| `backoff` | `['1s', '30s']` | first wait and longest wait; each failure doubles the wait, ±25 % jitter (the stream's rule, `backoff.ts`). `['5m', '5m']` is a fixed interval |
| `retries` | none: no limit | how many times the request is sent again after the first try |
| `maxAge` | none: no limit | `'10m'`: no new try once this long has passed since the trigger |
| `key` | `'Idempotency-Key'` | header carrying the write's key; `false` sends none. Ignored for GET |

Durations are written as in `refresh` and `cache` (`30s`, `5m`, `1h`). Without `retries` and
`maxAge`, a policy retries for as long as the page is open.

## On the element

```html
<form data-sn-put="/api/notes/{note.id}" data-sn-retry="drafts" data-sn-concurrency="latest"
      data-sn-optimistic="patch('notes', note, {title, body})">
```

- `data-sn-retry` takes a policy name. It is allowed on actions with `data-sn-post`, `-put`,
  `-patch` or `-delete`.
- Build errors:
  - no value: `SN401`;
  - on a GET action, on `data-sn-call`, or on an element without an action: `SN102`.
- GET actions and resources use `retry.get`; they take no `data-sn-retry`.
- An unknown policy name is found at runtime, since the compiler does not read the config module:
  dev builds warn at mount, and the action fails with `$error.message` "unknown retry policy".

## What is retried

| Response | Effect |
| --- | --- |
| network error, timeout (`status: 0`) | wait out the backoff, then probe `sessionProbe`: 2xx sends again, 401 ends it (`onUnauthorized`, the write is lost), anything else waits longer. Without `sessionProbe`: send again after the backoff |
| 5xx | a failed try: wait out the backoff, send again (no probe: the server answered) |
| 429, or 503 with `Retry-After` | wait for the longer of the backoff and `Retry-After` (seconds or an HTTP date). If that is after the policy's last allowed try, fail now with this response as `$error` |
| a 429 without `Retry-After` | a failed try, as 5xx |
| 404 on a retried `DELETE` | success: the earlier try deleted it. `$result` is `null`; write-through rule 4 still removes the row. A 404 on the first try stays an error |
| any other 4xx | fail now |
| 2xx | success |

"The policy's last allowed try": the deadline set by `maxAge`, or, with `retries`, the time the
remaining tries take at the longest wait. A policy with neither never fails early.

When the policy gives up, the action fails as an action without a policy does: the optimistic layer is
rolled back, then `data-sn-catch`, or the form's field errors and `$error` (see "Server errors on
forms" below), or `sn-error` and `onError`. `$error` is the last response's.

Cross-origin APIs must list `Retry-After` in `Access-Control-Expose-Headers`, or the browser hides it
and a 429 counts as a failed try.

## Idempotency keys

- One key per trigger, made when the action triggers (`crypto.randomUUID()`, else 16 random bytes
  from `getRandomValues`, for plain-HTTP dev servers). It is sent on the first try too.
- Set before the middleware chain, so every try carries the same key. Middleware runs on every try,
  so a CSRF header or a refreshed token is current each time.
- **Server contract** (documented, not checked): remember a key with its response for at least as
  long as the longest policy can retry. Answer a repeated key with the remembered response. Answer
  `409` while the first request with that key is still running, and `422` when the key comes with a
  different body.
- **Servers that ignore the header.** The browser cannot tell "never reached the server" from
  "applied, but the response was lost". So:
  - `PUT` with the full target state, `DELETE` (the 404 rule above) and a `PATCH` that sets fields
    are safe to resend.
  - A `PATCH` that increments or appends is not.
  - **`POST` that creates is not: a lost response and a resend make a duplicate.** The docs say so,
    and recommend client-generated ids (`PUT /api/notes/{uuid}`), which make the create idempotent
    on any server.

## While a write waits

- The request counts as running for its element: `aria-busy` stays, and the element's concurrency
  policy applies.
  - `latest`: a newer trigger replaces the waiting write. After reconnecting only the newest draft is
    sent. This is the policy for autosave and drafts.
  - `queue`: later triggers from that element wait behind it, in order.
  - `block` (forms by default): the form stays disabled until the write settles. A draft form should
    therefore say `data-sn-concurrency="latest"`, or the user cannot keep typing.
- Writes from different elements are not ordered with each other: they run in parallel. A page that
  must not run two writes to one item at once disables the second while the first is pending
  (`data-sn-attr="{disabled: $meta.notes.pending}"` for actions with an optimistic layer, or the
  element's own state).
- The optimistic layer lives until the request or its policy settles (the spec said: until the
  request settles, including the 30 s timeout). Server events and refetches write to the base under
  it, as they do now.
- When the write succeeds after the page reloaded the data (an `online` refetch, a stream reconnect),
  nothing special is needed: a commit is a confirmed write, and a load in flight replays it.
- `then` runs when the write finally succeeds, possibly minutes later, against the page's state at
  that time. When the element has left the page meanwhile, `then` still runs in its scope; errors
  bubble from the nearest ancestor still on the page, as now.
- `online` ends the current wait: waiting writes probe at once instead of at their next try.
- A running try is never aborted (as now). A waiting write is not aborted on `pagehide` either; in
  the back/forward cache its timer is frozen, and on `pageshow` it probes again.

### Leaving the page

- While at least one write waits for a retry, the page has a `beforeunload` listener, so the browser
  asks before a link, a reload or closing the tab. Browsers show their own text; a custom message is
  ignored. The listener is removed once nothing waits, so it does not keep the page out of the
  back/forward cache otherwise.
- Nothing is sent on `pagehide`: the policy decides when to send, and a page leaving does not change
  that.
- **Mobile:** iOS Safari never asks, and a tab closed from the app switcher fires nothing usable.
  There, closing the page loses the waiting writes without warning. Documented.
- In-page feedback is markup: an element with `aria-busy` is pending, and
  `body:has(form[aria-busy]) .unsaved { display: block }` shows a banner without anything new.

### Dev builds

Each failed try and each resend is logged, as write-through is:
`retry (drafts): PUT /api/notes/7 failed: network error; probing in 4 s (try 2)`,
`retry (drafts): PUT /api/notes/7 succeeded on try 3`, `retry (network): GET /api/notes gave up after 4 tries`.

## Reads (`retry.get`)

- Every GET goes through `retry.get` when it is set: resource loads (shared loads of one `src`
  included, one retry for all), `each` sources, pages, background refreshes, and GET actions.
- A GET waiting for a retry is aborted like a running one: a `src` change, `when` turning falsy, a
  newer trigger of a GET action (latest wins).
- `$meta.<name>.loading` stays true while an ordinary load waits for a retry (false for a background
  refresh, as now). `error` is set only when the policy gives up.
- **With `refresh`:** a refresh that fails is retried by the policy first; once the policy gives up,
  the load has failed, and `refresh`'s own doubling wait starts from there. So the two back off one
  after the other. The alternative (refreshes skip `retry.get`, since they retry anyway) is listed
  under open questions.
- **Unchanged reloads (`versions`):** unaffected; they look at the response that finally arrives.
- Not covered: the session probe of streams and of retries (each has its own backoff), and the early
  file's requests (see below).

## Removing the automatic resend

Today the request layer sends a GET, HEAD, OPTIONS, PUT or DELETE once more after a network error
(`request.ts`). It goes:

- Writes without a policy are sent exactly once.
- Reads without `retry.get` are sent once; a failed load sets `$meta.<name>.error` at once and
  recovers on the next `online`, stream reconnect, refresh or `refresh()`.
- **Kept, because they are their own documented rules, not a resend of a failed request:** stream
  reconnects and their probe; the reloads on `online`, back/forward-cache restore and after a
  reconnect; `refresh`; `cache` revalidation; and the early file: when the early response for a
  request failed, the runtime sends its own request instead (it would have sent it anyway). That
  last one is in the loop being removed, so it moves out as its own rule.

The CHANGELOG lists it under Changed.

## Server errors on forms (PR #7)

PR #7 adds field errors and `$error` to forms that have no `data-sn-catch`. With a policy:

- Only the final failure reaches it. A 422 is not retried, so fields are marked at once.
- A retry is not a new send: errors are not cleared between tries (there are none to clear: a try
  that will be retried has not failed yet).
- `$error` in a form stays the last failed send; it does not show "waiting for a retry".

## Cost

- Core: the hook in the request layer (a policy per request) and the `beforeunload` count. Removing
  the resend loop pays for part of it.
- `retry` module: estimated 0.8–1 KB gzip, in the config module's bundle only for apps that call
  `retry()`. It uses `backoff.ts` with the stream and refresh modules.
- Measured and recorded in `scripts/size.mjs` when implemented.

## Not in this proposal

- Writes that survive a navigation or a closed tab (a stored outbox), which would also need
  rebuilding optimistic layers on the next page and coordinating tabs.
- A page-wide signal of waiting writes (`$meta`, an event): `aria-busy` covers it.
- Retrying `data-sn-call` actions: the function may send several requests. A later version could
  pass the key in its context (`ctx.idempotencyKey`) and leave the retry to it.
- Policies written as functions.
- A default policy for writes.

## Open questions

1. Background refreshes and `retry.get`: should a refresh skip the policy (it retries by itself), or
   use it, as above?
2. Unknown policy names: is a dev warning at mount plus a failing action enough, or should the
   compiler read `retry({ policies })` from the config module to report it at build time?
3. A `beforeunload` question also while the first try of a policy write is still running, not only
   once it waits for a retry? (Mutations already use `keepalive`, so a running first try usually
   completes after the page has gone.)

## Implementation outline

1. `src/retry.ts`: `retry({ policies, get })`, the policy loop (probe, backoff, `Retry-After`,
   deadlines, the DELETE 404 rule), keys, the dev log.
2. Request layer: `SendInit.retry` (a policy name), the key header, the resend loop removed and the
   early-file fallback kept as its own rule, `beforeunload` while writes wait.
3. Actions: `data-sn-retry` in the IR, the policy passed by `send()`, waiting counted as running.
4. Compiler: the attribute in the vocabulary, `SN401`/`SN102`, html-custom-data, the LSP.
5. Tests: behaviour tests with the testing module's clock (offline, probe, 5xx, 429, DELETE 404,
   `latest` drafts, `beforeunload`), the GET default with `refresh`, and a recipe
   (`docs/recipes/offline-draft.html`) with its test.
6. Docs: spec section under the request layer, the optimistic layer's lifetime, llms.txt, CHANGELOG.
