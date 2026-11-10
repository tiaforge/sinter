# Attribute reference

Every directive is a `data-sn-*` attribute or an `<sn-*>` element; anything else is a build error with a suggestion. Generated from the compiler's vocabulary (`npm run docs`). `llms.txt` has the same list for LLMs.

## Show data

Bind values to the page.

| Attribute | Value | Meaning |
| --- | --- | --- |
| `data-sn-text` | value expression | sets textContent; never HTML |
| `data-sn-attr` | object literal {href: …} | literal keys; null/false removes, true sets empty; URL values are checked; checked, selected, indeterminate and value also set the live property |
| `data-sn-class` | object literal {unread: …} | toggles each class |
| `data-sn-style` | object literal {'--color': …} | sets each property with style.setProperty |
| `data-sn-show` | value expression | toggles the hidden attribute |
| `data-sn-prop` | object literal | sets JS properties; custom elements only (one defined later gets them again through its setters). On a component's tag: its props, live and read-only |
| `data-sn-for` | item in list \| (item, i) in list | repeats a &lt;template&gt; per item |
| `data-sn-key` | value expression | row identity; defaults to the resource key or object identity |
| `data-sn-if` | value expression | renders a &lt;template&gt; while truthy |
| `data-sn-else` |  | on a &lt;template&gt; directly after an if template |

## Keep state

Local state next to the markup that uses it.

| Attribute | Value | Meaning |
| --- | --- | --- |
| `data-sn-state` | object literal | declares local reactive state for the element and its subtree |
| `data-sn-let` | object literal {name: expression} | derived names for the element and its subtree, computed where they are read; later names may use earlier ones |
| `data-sn-model` | state path | two-way binding for form controls |
| `data-sn-persist` | storage key | persists the model or state in localStorage under sn: |

## Send changes

Turn an element into a request. Details: [actions](actions.md).

| Attribute | Value | Meaning |
| --- | --- | --- |
| `data-sn-get` | URL template | GET action; latest wins |
| `data-sn-post` | URL template | POST action |
| `data-sn-put` | URL template | PUT action |
| `data-sn-patch` | URL template | PATCH action |
| `data-sn-delete` | URL template | DELETE action |
| `data-sn-call` | action call | local action: calls a function from the actions module, e.g. pgp.decrypt(msg); a handler starts it with run('id') |
| `data-sn-body` | value expression | JSON request body; overrides form serialization |
| `data-sn-trigger` | DOM event name | overrides the default trigger |
| `data-sn-debounce` | milliseconds | delays the trigger, resets on each event; without a method, delays the element's data-sn-on-* handlers |
| `data-sn-encoding` | json \| form | form: the body (data-sn-body, arrays as repeated keys, or the form) goes as application/x-www-form-urlencoded |
| `data-sn-concurrency` | block \| queue \| latest | mutations only; default block for forms, queue otherwise |
| `data-sn-confirm` | value expression | asks this question before the action runs (configure({ confirm }), window.confirm by default); no question when falsy |
| `data-sn-retry` | retry policy name | mutations only: sends the request again as that policy of configure({ retry }) says (after a network error, a 5xx, a 429), with an Idempotency-Key; without it a write is sent once |
| `data-sn-apply` | off | turns write-through off for this mutation: its response is not applied to the resources it is about |

## After a request

What happens on screen around a response. Details: [optimistic updates](actions.md#optimistic-updates).

| Attribute | Value | Meaning |
| --- | --- | --- |
| `data-sn-optimistic` | handler expression | patch/upsert/remove calls applied before the request, kept on success, rolled back on failure |
| `data-sn-then` | handler expression | runs after a 2xx response; $result = parsed body |
| `data-sn-catch` | handler expression | runs after an error; $error = {status, body, message, detail}. A form without it shows a 4xx `{errors: {name: message}}` on its fields (aria-invalid and the message); its markup reads the failure as `$error` |

## React to events

Handlers without a request. Details: [events](actions.md), [key filters](actions.md).

| Attribute | Value | Meaning |
| --- | --- | --- |
| `data-sn-on-<event>` | handler expression | plain event handler, no request; e.g. data-sn-on-click |
| `data-sn-debounce-<event>` | milliseconds | delays only that event's data-sn-on-&lt;event&gt; handler (it runs with the last event); e.g. data-sn-debounce-input |
| `data-sn-listbox` | id of the suggestion list, or empty | on a text input: arrow keys mark a [role=option] of that list (empty: the nearest [role=listbox] around the input), Enter or Tab clicks it, Escape fires `dismiss` |

## Components

In a component file in `src/components/`. Details: [components](components.md).

| Attribute | Value | Meaning |
| --- | --- | --- |
| `data-sn-component` | props type | on the &lt;template&gt; of a component file (src/components/&lt;name&gt;.html): the props it takes, a TypeScript type literal such as { article: Article; compact?: boolean } |
| `data-sn-emits` | events type | on the &lt;template data-sn-component&gt;: the events emit() sends and their detail types, e.g. { select: Article } |
| `data-sn-ref` | name | in a component's markup: the element its script reads as this.refs.&lt;name&gt;, typed by its tag |

## Pages and navigation

Set on `<html>` or on shared elements. Details: [navigation](navigation.md), [first paint](first-paint.md).

| Attribute | Value | Meaning |
| --- | --- | --- |
| `data-sn-path` | URL patterns /a/:b … | on &lt;html&gt;: the path shapes this page is served for; `:name` segments appear read-only in $url |
| `data-sn-prefetch` | off | on &lt;html&gt;: no other page prefetches this one's data or the page itself (Speculation Rules), and none prerenders it; for pages that do something when they load |
| `data-sn-transition` | value expression (a name) | the same thing on two pages: following a link from the element (or its row) to a page with an element of the same name morphs one into the other (view transitions; back too) |
| `data-sn-data` | resource name | on &lt;script type="application/json"&gt; in &lt;head&gt;: initial data for a resource |

## Elements

### `<sn-resource>`

A named, page-wide cache of server data. Details: [resources](resources.md).

- **Where the data comes from:** `name`, `src`, `call`, `each`, `when`, `early`
- **What it looks like:** `key`, `items`, `total`, `order`, `type`
- **How fresh it is:** `cache`, `refresh`, `then`
- **Pagination:** `paginate`, `page-size`, `size-param`, `cursor`, `direction-param`, `direction-values`, `page-param`, `offset-param`, `start-page`

### `<sn-sync>`

`src`. One server event stream.

### `<sn-component>`

`use`, `data-sn-prop`. A component chosen by data at runtime; `use` names it: ``use="`${b.type}-block`"`` (convention), `use="{ hero: 'hero-block' }[b.type]"` (map) or `use="blockComponent(b)"` (helper); it must fit `ComponentName`, every candidate must exist, props are checked per candidate (narrowed for convention and map); a value outside the candidates renders nothing, or the `data-sn-else` template after it.

### `<sn-event>`

`name`, `resource`, `op`, `item`, `set`, `when`, `fallback`, `then`, `type`. Maps one server event to a change message; child of &lt;sn-sync&gt;. `then` is a handler run after the change (payload fields and the state around the sync in scope), e.g. close('detail'); with `then`, `resource` and `op` may be left out.

## Names available in expressions

- **Magic names:** `$event`, `$el`, `$url`, `$now`, `$locale`, `$result`, `$error`, `$meta`.
- **Store functions:** `refresh()`, `upsert()`, `patch()`, `remove()`, `page()`, `showModal()`, `close()`, `reset()`, `emit()`, `run()`.
- **Built-in helpers:** `date()`, `time()`, `datetime()`, `relative()`, `number()`, `bytes()`.
