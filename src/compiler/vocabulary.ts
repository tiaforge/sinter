// The whole attribute and element vocabulary, with one-line descriptions.
// The compiler, llms.txt and html-custom-data.json are all built from it.

export interface AttrDoc { name: string; value: string; doc: string }

export const ATTRIBUTES: AttrDoc[] = [
  { name: 'state', value: 'object literal', doc: 'declares local reactive state for the element and its subtree' },
  { name: 'let', value: 'object literal {name: expression}', doc: 'derived names for the element and its subtree, computed where they are read; later names may use earlier ones' },
  { name: 'text', value: 'value expression', doc: 'sets textContent; never HTML' },
  { name: 'attr', value: 'object literal {href: …}', doc: 'literal keys; null/false removes, true sets empty; URL values are checked' },
  { name: 'class', value: 'object literal {unread: …}', doc: 'toggles each class' },
  { name: 'style', value: "object literal {'--color': …}", doc: 'sets each property with style.setProperty' },
  { name: 'show', value: 'value expression', doc: 'toggles the hidden attribute' },
  { name: 'prop', value: 'object literal', doc: 'sets JS properties; custom elements only (one defined later gets them again through its setters)' },
  { name: 'model', value: 'state path', doc: 'two-way binding for form controls' },
  { name: 'for', value: 'item in list | (item, i) in list', doc: 'repeats a <template> per item' },
  { name: 'key', value: 'value expression', doc: 'row identity; defaults to the resource key or object identity' },
  { name: 'if', value: 'value expression', doc: 'renders a <template> while truthy' },
  { name: 'else', value: '', doc: 'on a <template> directly after an if template' },
  { name: 'listbox', value: 'id of the suggestion list, or empty', doc: 'on a text input: arrow keys mark a [role=option] of that list (empty: the nearest [role=listbox] around the input), Enter or Tab clicks it, Escape fires `dismiss`' },
  { name: 'persist', value: 'storage key', doc: 'persists the model or state in localStorage under sn:' },
  { name: 'get', value: 'URL template', doc: 'GET action; latest wins' },
  { name: 'post', value: 'URL template', doc: 'POST action' },
  { name: 'put', value: 'URL template', doc: 'PUT action' },
  { name: 'patch', value: 'URL template', doc: 'PATCH action' },
  { name: 'delete', value: 'URL template', doc: 'DELETE action' },
  { name: 'call', value: 'action call', doc: 'local action: calls a function from the actions module, e.g. pgp.decrypt(msg)' },
  { name: 'body', value: 'value expression', doc: 'JSON request body; overrides form serialization' },
  { name: 'trigger', value: 'DOM event name', doc: 'overrides the default trigger' },
  { name: 'debounce', value: 'milliseconds', doc: 'delays the trigger, resets on each event; without a method, delays the element\'s data-sn-on-* handlers' },
  { name: 'concurrency', value: 'block | queue | latest', doc: 'mutations only; default block for forms, queue otherwise' },
  { name: 'optimistic', value: 'handler expression', doc: 'patch/upsert/remove calls applied before the request, kept on success, rolled back on failure' },
  { name: 'then', value: 'handler expression', doc: 'runs after a 2xx response; $result = parsed body' },
  { name: 'catch', value: 'handler expression', doc: 'runs after an error; $error = {status, body, message, detail}' },
  { name: 'confirm', value: 'value expression', doc: 'asks this question before the action runs (configure({ confirm }), window.confirm by default); no question when falsy' },
  { name: 'encoding', value: 'json | form', doc: 'form: the body (data-sn-body, arrays as repeated keys, or the form) goes as application/x-www-form-urlencoded' },
  { name: 'path', value: 'URL patterns /a/:b …', doc: 'on <html>: the path shapes this page is served for; `:name` segments appear read-only in $url' },
  { name: 'data', value: 'resource name', doc: 'on <script type="application/json"> in <head>: initial data for a resource' },
];

export const ON_DOC: AttrDoc = { name: 'on-<event>', value: 'handler expression', doc: 'plain event handler, no request; e.g. data-sn-on-click' };
export const DEBOUNCE_ON_DOC: AttrDoc = { name: 'debounce-<event>', value: 'milliseconds', doc: 'delays only that event\'s data-sn-on-<event> handler (it runs with the last event); e.g. data-sn-debounce-input' };

export const ELEMENTS: Array<{ name: string; attrs: string[]; doc: string }> = [
  { name: 'sn-resource', attrs: ['name', 'src', 'call', 'each', 'key', 'items', 'total', 'order', 'when', 'paginate', 'page-size', 'size-param', 'cursor', 'direction-param', 'direction-values', 'page-param', 'offset-param', 'type', 'cache', 'then'], doc: 'a named, page-wide cache of server data; `cache` (or `cache="10m"`) shows the data from the last page load at once, then revalidates. `then` is a handler run after each successful load (`$result`: what it loaded; the state around the resource in scope)' },
  { name: 'sn-sync', attrs: ['src'], doc: 'one server event stream' },
  { name: 'sn-event', attrs: ['name', 'resource', 'op', 'item', 'set', 'when', 'fallback', 'then', 'type'], doc: 'maps one server event to a change message; child of <sn-sync>. `then` is a handler run after the change (payload fields and the state around the sync in scope), e.g. close(\'detail\'); with `then`, `resource` and `op` may be left out' },
  { name: 'sn-include', attrs: ['src'], doc: 'inlines a partial at build time' },
];
