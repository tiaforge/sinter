# Retries: writes that survive a dropped connection

By default a sinter app sends each request once. When the connection drops while a user saves a
draft, a note or an event, the write fails like any other request, unless its element names a
**retry policy**. Then sinter keeps the change on screen, waits for the connection to come back, and
sends the write again with the same idempotency key, so the server can tell a retry from a second
write.

| | |
| --- | --- |
| Opt in | per element: `data-sn-retry="drafts"` on a `data-sn-post`, `-put`, `-patch` or `-delete` |
| Policies | named in the config module: how long to wait, how often, for how long |
| Reads | one policy for every GET (`retry.get`), optional |
| While waiting | the element stays `aria-busy`, its optimistic change stays, leaving the page asks first |
| Lives | as long as the page: nothing is stored, so a closed tab loses waiting writes |


## Setup

```js
// src/sinter.config.js
import { configure } from '@tiaforge-ui/sinter';
import { retry } from '@tiaforge-ui/sinter/retry';

configure({
  sessionProbe: '/api/user',            // asked after a network error: is the session still there?
  retry: retry({
    policies: {
      drafts:  { backoff: ['1s', '30s'] },                 // until it succeeds or the page is closed
      network: { backoff: ['1s', '10s'], retries: 3 },
      hourly:  { backoff: ['5m', '5m'], retries: 3 },      // a fixed interval
    },
    get: 'network',                                         // every GET; leave it out to send GETs once
  }),
});
```

```html
<form data-sn-put="/api/notes/{note.id}" data-sn-retry="drafts" data-sn-concurrency="latest"
      data-sn-optimistic="patch('notes', note, draft)">
```

| Policy field | Default | Meaning |
| --- | --- | --- |
| `backoff` | `['1s', '30s']` | first and longest wait; each failure doubles the wait (±25 %) |
| `retries` | no limit | how many times the request is sent again after the first try |
| `maxAge` | no limit | no new try once this long has passed since the first |
| `key` | `'Idempotency-Key'` | the header for the write's key; `false` sends none |

The retry code is added to the config module's bundle only when the app calls `retry()`. Writes
have no default policy: whether a write may be sent twice depends on what its endpoint does, so
only its element opts in.

## Which writes to opt in

The browser cannot tell "the request never reached the server" from "the server applied it, but the
response was lost". A retry may therefore reach a server that has already done the write:

| Write | Safe to send again on any server? |
| --- | --- |
| `PUT` with the full target state (a draft, a note edited in place) | yes |
| `DELETE` | yes: a retry that gets 404 counts as success |
| `PATCH` that sets fields | yes |
| `PATCH` that increments or appends | no |
| **`POST` that creates** | **no: a lost response and a retry make a duplicate** |

For creates, let the client choose the id and `PUT` it (`PUT /api/notes/{uuid}`): a second `PUT` of
the same note changes nothing, whatever the server does with the key. A `POST` with a policy is
safe only when the server honours the idempotency key.

## The server side: idempotency keys

Every write with a policy carries `Idempotency-Key: <uuid>`, one per click or submit and the same
on every try. A server that supports it:

- remembers each key with its response for at least as long as the longest policy retries;
- answers a repeated key with the remembered response, without doing the write again;
- answers `409` while the first request with that key is still running;
- answers `422` when the same key comes with a different body.

A server that ignores the header still works for the writes marked safe above. Cross-origin APIs
must list `Idempotency-Key` in `Access-Control-Allow-Headers`, and `Retry-After` in
`Access-Control-Expose-Headers`; otherwise the browser hides it and a 429 is retried on the
policy's own schedule.

## What is sent again

| Response | What happens |
| --- | --- |
| network error or timeout | wait, then ask `sessionProbe`: 2xx sends again, 401 ends the write (the login redirect; the write is lost), anything else waits longer |
| 5xx | wait, send again |
| 429, or 503 with `Retry-After` | wait at least `Retry-After`; when that is later than the policy's last try, fail at once |
| 404 on a retried `DELETE` | success |
| other 4xx | fail at once: a 422 marks the form's fields as usual |

When the policy gives up, the action fails as one without a policy does: the optimistic change is
rolled back, then `data-sn-catch`, the form's field errors and `$error`, or `sn-error` and
`onError` run. A try that will be sent again is not a failure, so nothing is reported meanwhile.

## While a write waits

- **The element stays busy.** `aria-busy="true"` stays on until the write settles, so CSS can show
  that something is not saved yet, page-wide:
  ```css
  .unsaved { display: none; }
  body:has(form[aria-busy]) .unsaved { display: block; }
  ```
- **The optimistic change stays** on screen. Server events and reloads still update the data under
  it.
- **Concurrency.** `latest` drops the waiting write when a newer trigger comes, so after
  reconnecting only the newest draft is sent: use it for autosave. `queue` keeps later triggers
  behind it, in order. `block`, the default for forms, keeps the form disabled until the write
  settles, which is wrong for a draft the user keeps typing in.
- **`then` runs late.** It runs when the write finally succeeds, possibly minutes later.
- **Coming back online** ends the current wait at once.
- **Leaving the page asks first.** While a write waits, the browser shows its "Leave site?" dialog
  for links, reloads and closing the tab (in its own words; a custom message is ignored). iOS Safari
  never asks, and a tab closed from the app switcher fires nothing: there the waiting writes are
  lost without warning. Nothing is sent while the page is hidden; a page restored from the
  back/forward cache carries on waiting.

## Reads

`retry.get` names the policy for every GET: resource loads, `each` sources, pages and GET actions.
It does not cover background refreshes (`refresh` retries by itself), the session probe or
next-page data. A GET waiting for a retry is aborted like a running one when `src` changes or `when`
turns false, and `$meta.<name>.loading` stays true while it waits.

Without `retry.get`, a failed load sets `$meta.<name>.error` at once and nothing is sent again by
itself. Pages still recover on their own: on `online`, after a stream reconnects, on the next
`refresh`, or with `refresh('name')`.

## Development and tests

- Dev builds log every failed try and its outcome in the console:
  `sinter: retry (drafts): PUT /api/notes/7 try 1 failed (Failed to fetch); next in 1 s`. They warn
  at mount when an element names a policy `configure({ retry })` does not define. Such an action
  fails with "unknown retry policy"; with no `retry()` configured at all, it is sent once.
- In tests (`@tiaforge-ui/sinter/testing`), `settle()` does not wait for a request waiting between
  tries: `advance(ms)` moves the clock to its next try, `window('online')` ends the wait, and
  `window('beforeunload', { preventDefault })` shows whether the page would ask. A route that throws
  is a network error. See the recipe "Offline drafts" in [`llms.txt`](../llms.txt)
  ([`recipes/offline-draft.html`](recipes/offline-draft.html) with its test).
