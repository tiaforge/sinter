# Attribute reference

Every directive is a `data-sn-*` attribute or an `<sn-*>` element; anything else is a build error with a suggestion. Generated from the compiler's vocabulary (`npm run docs`). `llms.txt` has the same list for LLMs. A *duration* is a number and `ms`, `s`, `m`, `h` or `d` (`300ms`, `30s`, `1d`), for `cache`, `refresh` and the debounces; a debounce also takes a bare number of milliseconds.

## Show data

Bind values to the page.

| Attribute | Value | Meaning |
| --- | --- | --- |
| `data-sn-text` | value expression | sets textContent (null and undefined: empty, no `?? ''` needed); never HTML. On a &lt;template&gt;: a text node with no element (a run of text beside elements); no other attribute on that template |
| `data-sn-attr` | object literal {href: …} | literal keys; null/false removes, true sets empty; URL values are checked; checked, selected, indeterminate and value also set the live property |
| `data-sn-class` | object literal {unread: …} | toggles each class |
| `data-sn-style` | object literal {'--color': …} | sets each property with style.setProperty |
| `data-sn-show` | value expression | toggles the hidden attribute |
| `data-sn-with` | object literal | sets JS properties; custom elements only (also one defined later). On a component's tag: its props, live and read-only. On a &lt;slot&gt; declared Slot&lt;T&gt;: the values its fill reads as $slot; on a named &lt;slot&gt; its component does not declare, a tree placement, filled by the nearest enclosing component declaring the name |
| `data-sn-for` | item in list \| (item, i) in list | repeats a &lt;template&gt; per item. On &lt;html&gt;: the page once per entry of a `file:` list, at `data-sn-path` filled from it |
| `data-sn-key` | value expression | row identity; inferred: resource key, object identity or value |
| `data-sn-if` | value expression | renders a &lt;template&gt; while truthy. Same id, same control: when the branch with focus is swapped, the element with its id in the new one takes focus (a toggle's two buttons: &lt;button id="follow" data-sn-delete=…&gt; and &lt;button id="follow" data-sn-post=…&gt;) |
| `data-sn-else` |  | on a &lt;template&gt; directly after an if template; with data-sn-if beside it, an else-if (&lt;template data-sn-else data-sn-if="q"&gt;). After a for template: the list's empty state, shown while it is empty and its resources have loaded, are not loading and have no error⟪FULL⟫ (a `when` that is falsy has not loaded; a `file:` list is decided at build time; a list of state, while empty); no else-if there (SN102)⟪SHORT⟫⟪END⟫. Lists, branches and chosen components render between two comments (`<ul><!--sn 4--><li>a</li><!--/sn--></ul>`): CSS sees plain children. Comments that are exactly `<!--sn-->`, `<!--sn 4-->`, `<!--/sn-->` or `<!---->` are reserved (SN105); `$el` in an if, for or use is SN213; keep HTML comments |

## Keep state

Local state next to the markup that uses it. `data-sn-model-<option>` attributes are the model's own, on the same field: `data-sn-model-debounce` delays the model, as `data-sn-debounce-<event>` delays a handler and `data-sn-debounce` an action.

| Attribute | Value | Meaning |
| --- | --- | --- |
| `data-sn-state` | object literal | declares local reactive state for the element and its subtree |
| `data-sn-let` | object literal {name: expression} | derived names for the element and its subtree, computed where they are read (a helper call included: keep an expensive one's results with `memo()`, configuration.md); later names may use earlier ones |
| `data-sn-model` | state path \| $url.&lt;param&gt; | two-way binding for form controls; on $url, the URL follows (a history entry; typing at each pause), and a &lt;select multiple&gt; or a checkbox with a value makes the parameter a list |
| `data-sn-model-debounce` | duration | delays the model's write until typing pauses (no second pause after it); Enter writes at once |
| `data-sn-persist` | storage key | persists the model or state in localStorage under sn: |

## Send changes

Turn an element into a request. Details: [actions](actions.md).

| Attribute | Value | Meaning |
| --- | --- | --- |
| `data-sn-post` | URL template | POST action |
| `data-sn-put` | URL template | PUT action |
| `data-sn-patch` | URL template | PATCH action |
| `data-sn-delete` | URL template | DELETE action |
| `data-sn-call` | action call | local action: a function of the actions module, e.g. pgp.decrypt(msg); a handler starts it with run('id'). The function gets a trailing context; its `ctx.request(url, { method, body })` encodes `body` as JSON: pass the object, not `JSON.stringify(…)` (a string) |
| `data-sn-body` | value expression | JSON request body; overrides form serialization |
| `data-sn-trigger` | DOM event name | overrides the default trigger |
| `data-sn-debounce` | duration | delays the action's trigger, resets on each event |
| `data-sn-encoding` | form | the body (data-sn-body, arrays as repeated keys, or the form) goes as application/x-www-form-urlencoded |
| `data-sn-concurrency` | block \| queue \| latest | what a trigger does while the action runs; default block for forms, queue otherwise |
| `data-sn-confirm` | value expression | asks this question before the action runs (configure({ confirm }), window.confirm by default); no question when falsy |
| `data-sn-retry` | retry policy name | sends the request again (with data-sn-call: each request ctx.request sends) as that policy of configure({ retry }) says (after a network error, a 5xx, a 429), with an Idempotency-Key; without it a write is sent once |
| `data-sn-write-through` | off | turns write-through off for this mutation: its response is not applied to the resources it is about |

## After a request

What happens on screen around a response. Details: [optimistic updates](actions.md#optimistic-updates).

| Attribute | Value | Meaning |
| --- | --- | --- |
| `data-sn-optimistic` | handler expression | merge/upsert/remove calls applied before the request, kept on success, rolled back on failure |
| `data-sn-then` | handler expression | runs after a 2xx response; $result = parsed body |
| `data-sn-catch` | handler expression | runs after an error; $error = {status, body, message, detail}. A form without it shows a 4xx `{errors: {name: message}}` on its fields (aria-invalid and the message); its markup reads the failure as `$error` |

## React to events

Handlers without a request. Details: [events](actions.md), [key filters](actions.md).

| Attribute | Value | Meaning |
| --- | --- | --- |
| `data-sn-on-<event>` | handler expression | plain event handler, no request; e.g. data-sn-on-click |
| `data-sn-debounce-<event>` | duration | delays only that event's data-sn-on-&lt;event&gt; handler (it runs with the last event); e.g. data-sn-debounce-input |
| `data-sn-options` | id of the list, or empty | arrows mark a [role=option\|menuitem] of the list (empty: inside the element, else the nearest listbox or menu), Enter clicks it, Escape fires `sn-dismiss`; focus stays on the element. Text field: a combobox |

## Components

In a component file in `src/components/`, and on a component's tag (`early`). Details: [components](components.md).

| Attribute | Value | Meaning |
| --- | --- | --- |
| `data-sn-props` | props type | the props a component or a layout takes, a TypeScript type literal, { article: Article; compact?: boolean }. On the &lt;template&gt; of a component file (src/components/&lt;name&gt;.html, or a component library's components/): a member cell: Slot&lt;{ row: Row }&gt; is a slot that passes data to its fill; its root renders at most one element (one element, a data-sn-if/data-sn-else chain of them, a component, &lt;sn-component use&gt; or a &lt;slot&gt;), or, a head component, any number of head elements (&lt;title&gt;, &lt;meta&gt;, &lt;link&gt;, …), inlined at its use in a head. On the &lt;html&gt; of a layout file (src/layouts/&lt;name&gt;.html): a page that is only the layout's tag fills its slots, in the head and the body. Either leaves it out when it takes no props |
| `data-sn-emits` | events type | on the &lt;template data-sn-props&gt;: the events emit() sends and their detail types, e.g. { select: Article } |
| `data-sn-early` | off | on a component's tag (a use): this use is left out of the early script and renders when the page module runs (build-time constants stay in the HTML); keeps the early script small |
| `data-sn-ref` | name | in a component's markup: the element its script reads as this.refs.&lt;name&gt;, typed by its tag |

## Pages and navigation

Set on `<html>` or on shared elements; `wait` on a box around a list. Details: [navigation](navigation.md), [first paint](first-paint.md).

| Attribute | Value | Meaning |
| --- | --- | --- |
| `data-sn-path` | URL patterns /a/:b … | on &lt;html&gt;: the path shapes this page is served for; `:name` segments appear read-only in $url |
| `data-sn-prefetch` | off | on &lt;html&gt;: no other page prefetches this one's data or the page itself (Speculation Rules), and none prerenders it; for pages that do something when they load |
| `data-sn-swap` | off | on &lt;html&gt;: links here load it; on a link: it loads its page |
| `data-sn-permanent` | name | with sinter({ swap }): kept as is (playing, scrolled) across a link to a page with the name; its bindings go on |
| `data-sn-transition` | value expression (a name) | the same thing on two pages: following a link from the element (or its row) to a page with an element of the same name morphs one into the other (view transitions; back too) |
| `data-sn-resource` | resource name | on &lt;script type="application/json"&gt; in &lt;head&gt;: initial data for a resource |
| `data-sn-wait` | off | on a box whose width follows its content (a flex item without a basis or width, a float) around a list over late data: what follows the box stays invisible while the list's first rows load (at most 3 s), so nothing shown moves when they widen it (builds, at the widths where it is so); off shows it, and SN529 says it moves |

## Lazy packages

When a package of `sinter({ lazy })` loads, on any element of a page, a layout or a component. Without either, on first call. Details: [lazy packages](lazy.md).

| Attribute | Value | Meaning |
| --- | --- | --- |
| `data-sn-import` | lazy packages, comma-separated | loads packages of sinter({ lazy }) when the element is rendered (at takeover outside templates, when its branch or row first renders inside one), instead of on first call |
| `data-sn-preload` | lazy packages, comma-separated | the build preloads packages of sinter({ lazy }) with the page (&lt;link rel="modulepreload"&gt;): fetched with the page bundle, run on first call or by data-sn-import |

## Set by sinter

Attributes sinter writes for CSS to style; writing one in markup is `SN101`.

| Attribute | Where |
| --- | --- |
| `data-sn-marked` | on the option a data-sn-options list marks |
| `data-sn-error` | on the message it inserts after a field with a server error |
| `data-sn-failed` | on the &lt;body&gt; of a page whose server render failed |

## Elements

### `<sn-resource>`

A named, page-wide cache of server data. Details: [resources](resources.md).

- **Where the data comes from:** `name`, `src`, `method`, `body`, `call`, `for`, `when`, `early`
- **What it looks like:** `key`, `items`, `total`, `order`, `drafts`, `fields`, `type`
- **How fresh it is:** `cache`, `refresh`, `then`
- **Pagination:** `paginate`

### `<sn-sync>`

`src`. One server event stream.

### `<sn-component>`

`use`, `data-sn-with`, `data-sn-early`. A component chosen by data at runtime; `use` names it: ``use="`${b.type}-block`"`` (convention), `use="{ hero: 'hero-block' }[b.type]"` (map) or `use="blockComponent(b)"` (helper); it must fit `ComponentName`, every candidate must exist, props are checked per candidate (narrowed for convention and map); a value outside the candidates renders nothing, or the `data-sn-else` template after it; `data-sn-early="off"` leaves it out of the early script.

### `<sn-event>`

`name`, `resource`, `op`, `value`, `when`, `then`, `type`. Maps one server event to a change message; child of &lt;sn-sync&gt;. `then`: a handler run after the change.

## Names available in expressions

- **Magic names:** `$event`, `$el`, `$url`, `$now`, `$locale`, `$result`, `$error`, `$meta`. Filled in by the build: `$site` and `$canonical` (the site's root and the page's URL, with `sinter({ site })`), `$slot` (in a fill of a slot declared `Slot<T>`, the values it passes) and `localeUrl(locale)` (this page in another language, with `sinter({ localePrefix: true })`). `$item`, in `paginate`'s cursor only, is the item at the page's edge.
- **Store functions:** `refresh()`, `upsert()`, `merge()`, `remove()`, `page()`, `openDialog()`, `closeDialog()`, `emit()`, `run()`, `navigate()`.
- **Built-in helpers:** `date()`, `relative()`, `number()`, `bytes()`.
