# Incident API

Run it with `node api/server.mjs` (port 3001; `PORT=… ` to change it). JSON in and out, CORS open to
any origin. The data lives in memory and is shared by everyone using the API: other people create,
resolve and delete incidents too.

| Method and path | Body | Answer |
| --- | --- | --- |
| `GET /api/incidents` | | `200 { incidents: Incident[] }`, newest first. Optional `?status=open` or `?status=resolved`. |
| `POST /api/incidents` | `{ title: string, severity: "low" \| "medium" \| "high" }` | `201 { incident: Incident }`, or `422 { errors: { [field]: string[] } }` (empty title, title over 80 characters, unknown severity) |
| `GET /api/incidents/:id` | | `200 { incident: Incident }` or `404` |
| `PATCH /api/incidents/:id` | `{ status: "open" \| "resolved" }` | `200 { incident: Incident }`, `404`, `422`, or `500 { error: string }` when the server refuses the change |
| `DELETE /api/incidents/:id` | | `204` or `404` |
| `GET /api/incidents/:id/comments` | | `200 { comments: Comment[] }`, oldest first, or `404` |
| `POST /api/incidents/:id/comments` | `{ body: string }` | `201 { comment: Comment }`, `404`, or `422` |

```ts
type Incident = { id: number; title: string; severity: 'low' | 'medium' | 'high'; status: 'open' | 'resolved'; createdAt: string };
type Comment = { id: number; incidentId: number; body: string; createdAt: string };
```

Writes can be slow on a bad network, and the server can refuse a status change with a `500`.
