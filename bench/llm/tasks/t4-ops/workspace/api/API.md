# Ops API

Run it with `node api/server.mjs` (port 3001; `PORT=…` to change it). JSON in and out, CORS open to any
origin. The data lives in memory and is shared by everyone using the API: other people create, edit,
resolve and delete incidents at the same time. Two accounts exist: `alice` / `alice-pw` and `bob` / `bob-pw`.

Every `/api/` endpoint except `/api/login` needs a token: `Authorization: Bearer <token>`, or
`?token=<token>` in the URL (for `EventSource`, which cannot send headers). Without a valid one it answers
`401 { error }`.

| Method and path | Body | Answer |
| --- | --- | --- |
| `POST /api/login` | `{ username, password }` | `200 { token, user: { username } }` or `401 { error }` |
| `GET /api/me` | | `200 { user: { username } }` |
| `POST /api/logout` | | `204`; the user's tokens stop working |
| `GET /api/incidents` | | `200 { incidents: Incident[], total, page, pages }`. Query: `page` (from 1), `per` (default 10), `status` (`open` or `resolved`), `q` (title contains, ignoring case), `sort` (`newest`, the default, or `severity`: high first, then newest) |
| `POST /api/incidents` | `{ title, severity }` | `201 { incident }` or `422 { errors: { [field]: string[] } }` |
| `GET /api/incidents/:id` | | `200 { incident }` or `404` |
| `PATCH /api/incidents/:id` | `{ version, title?, status? }` | `200 { incident }` (its `version` goes up by one); `409 { error, incident }` when `version` is not the incident's current one (someone else changed it; `incident` is the current state); `422`; `404`; or `500 { error }` when the server refuses |
| `DELETE /api/incidents/:id` | | `204` or `404` |
| `GET /api/events` | | Server-sent events, one per change by anyone: `incident.created` and `incident.updated` with `{ incident }`, `incident.deleted` with `{ id }` |

```ts
type Incident = { id: number; title: string; severity: 'low' | 'medium' | 'high'; status: 'open' | 'resolved';
  version: number; createdAt: string; updatedBy: string };
```

Writes can take seconds on a bad network.
