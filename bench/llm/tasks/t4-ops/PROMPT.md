Build an operations board web app with {{FRAMEWORK}} in this directory. Start from an empty project:
set it up yourself, the way the framework recommends.

The backend already exists: `api/server.mjs` (run `node api/server.mjs`, it listens on
http://localhost:{{API_PORT}}), documented in `api/API.md`. Do not change the API. The app must call it at
`http://localhost:{{API_PORT}}` from the browser or from its own server, whichever you prefer. Several people
use it at the same time, and the app must keep up with their changes while it is open.

## Signing in

- `/login`: a form with `data-testid="login"`, inputs `name="username"` and `name="password"`, and a
  submit button. A wrong password shows the API's message in an element with `data-testid="error"`.
- Every other page needs a signed-in user. Opening one signed out goes to `/login`; after signing in,
  the user lands on the page they first asked for, with its query string (for example
  `/?status=open&page=2`), or on `/` if they came to `/login` directly.
- Signing in lasts across reloads and new tabs, until the user signs out.
- Every signed-in page shows the user's name in `data-testid="user"` and a button `data-testid="logout"`.
  Signing out goes to `/login`; a reload after that stays signed out.
- When the API answers 401 (the token stopped working), the user goes to `/login` as if signed out.

## `/`: the board

- The incidents, 10 per page, from the API's pages. Each is an element with `data-testid="incident"` holding
  its title as a link to `/incidents/<id>` (in `data-testid="title"`), its severity in `data-testid="severity"`
  and its status in `data-testid="status"` (the API's values as text).
- `data-testid="page"` reads `Page <n> of <pages>`; links or buttons `data-testid="prev"` and
  `data-testid="next"` move one page (absent or disabled at either end).
- A search field `<input data-testid="search">` (matched by the API, `q`), a status filter
  `<select data-testid="status-filter">` with the options `all`, `open` and `resolved`, and a sort
  `<select data-testid="sort">` with `newest` and `severity`. They combine.
- The page, search, status and sort are in the URL (`?page=2&q=disk&status=open&sort=severity`; leave out
  what is at its default), so reloading, sharing a link and the browser's Back and Forward buttons show the
  same board. Changing the search, status or sort goes back to page 1. Typing in the search updates the board
  without a button, but it must not send one request per keystroke.
- A form `data-testid="create"`: input `name="title"`, `<select name="severity">` (`low`, `medium`, `high`)
  and a submit button. A created incident shows on the board without a reload and the title field is
  cleared; the API's 422 message for a field goes in `data-testid="error"`, keeping what was typed.
- **Live.** While the board is open, other people's changes show within 3 seconds and without a reload:
  an incident created while page 1 of the newest-first board is shown appears at its top (a board that
  is filtered, sorted or on another page may simply refresh what it shows); a changed title or status
  shows where the incident is listed; a deleted incident disappears.
- **Resolve and reopen.** Each open incident has a button `data-testid="resolve"`, each resolved one
  `data-testid="reopen"`. The status shown changes at once, without waiting for the server (writes can take
  seconds). If the server refuses (any non-2xx), the old status comes back and `data-testid="error"` says
  the change failed.
- **Rename.** Each incident has a button `data-testid="edit"`, which turns its title into an input
  `name="title"`; pressing Enter saves it, Escape cancels. The new title shows at once. If someone else
  changed the incident in the meantime (the API's 409), show `data-testid="conflict"` saying so, and show
  the incident as the server has it now (its current title).
- **Delete with undo.** Each incident has a button `data-testid="delete"`. The incident disappears at once
  and a button `data-testid="undo"` appears for 5 seconds. Undo puts the incident back as it was, and
  nothing is deleted on the server. Without undo, the incident is deleted on the server once the 5 seconds
  are over.

## `/incidents/<id>`

- An `<h1>` with the title, and the severity, status and `updatedBy` (in `data-testid="updated-by"`),
  kept up to date live like the board.
- A link back to the board.
- For an id that does not exist, or that someone deletes while the page is open, show
  `data-testid="not-found"`.

## How it is checked

Automated browser tests run against your app, with the API on port {{API_PORT}}. They run, in this
directory:

```sh
npm install
npm run build
npm run preview -- --port {{PORT}} --host 127.0.0.1
```

and then open http://127.0.0.1:{{PORT}}. Make sure these three commands work and that `npm run build`
succeeds without errors. Styling is up to you; it is not graded, but keep the page usable.
When you are done, stop any servers you started.
