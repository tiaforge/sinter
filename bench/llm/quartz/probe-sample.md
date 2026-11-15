## src/pages/_view.qz

```
<script>
  import { page } from 'qz:app';
  import { send, json } from '~lib/api.js';
  import Badge from '~lib/Badge.qz';

  let { data } = $inputs();

  // the loaded list, overwritten locally by optimistic changes until the next load
  let incidents = $from(data.incidents);
  let query = $cell('');
  let title = $cell('');
  let severity = $cell('medium');
  let fieldErrors = $cell({});
  let error = $cell('');

  let status = $from(page.url.searchParams.get('status'));
  let shown = $from(incidents.filter((i) =>
    (!status || i.status === status) && i.title.toLowerCase().includes(query.trim().toLowerCase())));

  const filters = [['all', '/'], ['open', '?status=open'], ['resolved', '?status=resolved']];
  const patch = (id, change) => { incidents = incidents.map((i) => (i.id === id ? { ...i, ...change } : i)); };

  async function create(event) {
    event.preventDefault();
    error = '';
    const r = await send('POST', '/incidents', { title, severity });
    const body = await json(r);
    if (r?.ok) { incidents = [body.incident, ...incidents]; title = ''; fieldErrors = {}; }
    else if (r?.status === 422) fieldErrors = body.errors ?? {};
    else error = 'Could not report the incident. Try again.';
  }

  async function setStatus(incident, next) {
    const old = incident.status;
    patch(incident.id, { status: next });
    error = '';
    const r = await send('PATCH', `/incidents/${incident.id}`, { status: next });
    if (!r?.ok) {
      patch(incident.id, { status: old });
      error = `Could not mark "${incident.title}" as ${next}: ${(await json(r)).error ?? 'the server refused'}.`;
    }
  }

  async function remove(incident) {
    const before = incidents;
    incidents = incidents.filter((i) => i.id !== incident.id);
    error = '';
    const r = await send('DELETE', `/incidents/${incident.id}`);
    if (!r?.ok && r?.status !== 404) { incidents = before; error = `Could not delete "${incident.title}".`; }
  }
</script>

<h1>Incidents</h1>

<form data-testid="create" onsubmit={create}>
  <input name="title" placeholder="What happened?" sync:value={title} aria-invalid={!!fieldErrors.title} />
  <select name="severity" sync:value={severity}>
    <option>low</option>
    <option>medium</option>
    <option>high</option>
  </select>
  <button type="submit">Report</button>
  [[for [field, messages] in Object.entries(fieldErrors) by field]]
    <p data-testid="error">{field} {messages.join(', ')}</p>
  [[end]]
</form>

<div class="bar">
  <input data-testid="search" type="search" placeholder="Search titles" sync:value={query} />
  <nav>
    [[for [name, href] in filters by name]]
      <a data-testid="filter-{name}" {href} toggle:active={(status ?? 'all') === name}>{name}</a>
    [[end]]
  </nav>
</div>

[[if error]]
  <p data-testid="error" role="alert">{error}</p>
[[end]]

<p data-testid="count">{shown.length} incidents</p>

<ul>
  [[for incident in shown by incident.id]]
    <li data-testid="incident">
      <a href="/incidents/{incident.id}">{incident.title}</a>
      <Badge kind="severity" value={incident.severity} />
      <Badge kind="status" value={incident.status} />
      [[if incident.status === 'open']]
        <button type="button" data-testid="resolve" onclick={() => setStatus(incident, 'resolved')}>Resolve</button>
      [[else]]
        <button type="button" data-testid="reopen" onclick={() => setStatus(incident, 'open')}>Reopen</button>
      [[end]]
      <button type="button" data-testid="delete" onclick={() => remove(incident)}>Delete</button>
    </li>
  [[else]]
    <li class="empty">No incidents match.</li>
  [[end]]
</ul>

<style>
  form, .bar { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; margin-bottom: 12px; }
  form p { flex-basis: 100%; margin: 0; }
  nav { display: flex; gap: 8px; }
  nav a { text-transform: capitalize; }
  nav a.active { font-weight: 700; text-decoration: none; }
  ul { list-style: none; padding: 0; }
  li { display: flex; gap: 8px; align-items: center; padding: 8px 0; border-bottom: 1px solid #e2e4e9; }
  li > a { flex: 1; }
</style>
```

## src/pages/_data.js

```js
import { API } from '~lib/api.js';

// runs on the server for the first load and in the browser after that; never cached
export async function fetchData({ fetch }) {
  const r = await fetch(`${API}/incidents`);
  if (!r.ok) throw new Error(`the incident API answered ${r.status}`);
  return { incidents: (await r.json()).incidents };
}
```

## From the framework's documentation

### Reactive state
`$cell` declares state that updates the page when it changes: `let count = $cell(0);`. Objects and arrays
are deeply reactive: `todos.push(item)` updates every place that reads `todos`.

`$from` declares a value computed from other state: `let doubled = $from(count * 2);`. It recomputes when
what it reads changes. For a longer computation use `$from.by(() => { … })`.

`$inputs` reads what the parent passes: `let { title, done = false } = $inputs();`. `$watch(() => { … })`
runs a function after the page updates, again whenever what it read changes.

### Markup
`[[if cond]] … [[elif other]] … [[else]] … [[end]]` shows one branch. `[[for item, i in list by item.id]]
… [[else]] … [[end]]` repeats its content; `by` gives each item a stable identity, and `[[else]]` shows when
the list is empty. `[[wait promise]] … [[done value]] … [[failed error]] … [[end]]` shows a promise's states.

`sync:value={name}` keeps an input and a variable in step. `toggle:active={on}` adds the class `active`
while `on` is true. Event handlers are attributes: `onclick={save}`.

### Pages and data
Pages are files under `src/pages/`: `src/pages/_view.qz` is `/`, `src/pages/about/_view.qz` is `/about`,
and a folder in braces is a parameter: `src/pages/posts/{slug}/_view.qz` is `/posts/:slug`. `_frame.qz`
wraps every page below it.

A `_data.js` beside a page exports `fetchData`, which returns the page's `data`; `_data.server.js` runs only
on the server. The page reads it with `let { data } = $inputs();`. `qz:app` gives the current `page`
(its `url` and `params`), `qz:nav` gives `goto` and `invalidate`.
