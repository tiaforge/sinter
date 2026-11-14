Build an incident board web app with {{FRAMEWORK}} in this directory. Start from an empty project: set it up
yourself, the way the framework recommends.

The backend already exists: `api/server.mjs` (run `node api/server.mjs`, it listens on
http://localhost:{{API_PORT}}), documented in `api/API.md`. Do not change the API. The app must call it at
`http://localhost:{{API_PORT}}` from the browser or from its own server, whichever you prefer. Other people use
the same API at the same time, so every page load must show the current data.

## Pages

**`/` (incident list)**

- Every incident in a list, newest first. Each one is an element with `data-testid="incident"` that
  contains its title as a link to `/incidents/<id>`, its severity in an element with
  `data-testid="severity"` (the text `low`, `medium` or `high`) and its status in an element with
  `data-testid="status"` (the text `open` or `resolved`).
- An element with `data-testid="count"` reads `<n> incidents`: the number currently listed.
- A search field, `<input data-testid="search">`: as the user types, only incidents whose title contains
  the text (ignoring case) stay listed. No button press.
- Three status filters, links or buttons with `data-testid="filter-all"`, `"filter-open"` and
  `"filter-resolved"`. The chosen filter is in the URL as `?status=open` or `?status=resolved` (none for
  all), so a reload or a shared link shows the same filter.
- A form with `data-testid="create"` to report an incident: a text input `name="title"`, a `<select
  name="severity">` with the options `low`, `medium` and `high`, and a submit button. On success the new
  incident appears at the top of the list, without a full page reload, and the title field is empty again.
  When the API answers 422, show its message for the field (for example `is required`) inside an
  element with `data-testid="error"`, and keep what the user typed.
- Each open incident has a button `data-testid="resolve"`; a resolved one has a button
  `data-testid="reopen"`. Clicking changes the status shown immediately, without waiting for the server
  (writes can take seconds). If the server refuses (any non-2xx), the old status comes back and an
  element with `data-testid="error"` explains that the change failed.
- Each incident has a button `data-testid="delete"`, which removes it from the list.

**`/incidents/<id>` (one incident)**

- An `<h1>` with the title, the severity and status with the same `data-testid`s as above.
- Its comments, oldest first, each in an element with `data-testid="comment"`.
- A form with `data-testid="comment-form"`: a `<textarea name="body">` and a submit button. A new comment
  appears in the list without a full page reload and the textarea is empty again.
- A link back to `/`.
- For an id that does not exist, show an element with `data-testid="not-found"` instead.

## How it is checked

Automated browser tests run against your app, with the API on port {{API_PORT}}. They run, in this directory:

```sh
npm install
npm run build
npm run preview -- --port {{PORT}} --host 127.0.0.1
```

and then open http://127.0.0.1:{{PORT}}. Make sure these three commands work and that `npm run build`
succeeds without errors. Styling is up to you; it is not graded, but keep the page usable.
When you are done, stop any servers you started.
