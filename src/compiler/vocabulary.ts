// The whole attribute and element vocabulary, with one-line descriptions.
// The compiler, llms.txt and html-custom-data.json are all built from it.

export interface AttrDoc { name: string; value: string; doc: string }

export const ATTRIBUTES: AttrDoc[] = [
  { name: 'state', value: 'object literal', doc: 'declares local reactive state for the element and its subtree' },
  { name: 'text', value: 'value expression', doc: 'sets textContent; never HTML' },
  { name: 'attr', value: 'object literal {href: …}', doc: 'literal keys; null/false removes, true sets empty; URL values are checked' },
  { name: 'class', value: 'object literal {unread: …}', doc: 'toggles each class' },
  { name: 'style', value: "object literal {'--color': …}", doc: 'sets each property with style.setProperty' },
  { name: 'show', value: 'value expression', doc: 'toggles the hidden attribute' },
  { name: 'prop', value: 'object literal', doc: 'sets JS properties; custom elements only' },
  { name: 'model', value: 'state path', doc: 'two-way binding for form controls' },
  { name: 'for', value: 'item in list | (item, i) in list', doc: 'repeats a <template> per item' },
  { name: 'key', value: 'value expression', doc: 'row identity; defaults to the resource key or object identity' },
  { name: 'if', value: 'value expression', doc: 'renders a <template> while truthy' },
  { name: 'else', value: '', doc: 'on a <template> directly after an if template' },
  { name: 'persist', value: 'storage key', doc: 'persists the model or state in localStorage under sn:' },
  { name: 'get', value: 'URL template', doc: 'GET action; latest wins' },
  { name: 'post', value: 'URL template', doc: 'POST action' },
  { name: 'put', value: 'URL template', doc: 'PUT action' },
  { name: 'patch', value: 'URL template', doc: 'PATCH action' },
  { name: 'delete', value: 'URL template', doc: 'DELETE action' },
  { name: 'body', value: 'value expression', doc: 'JSON request body; overrides form serialization' },
  { name: 'trigger', value: 'DOM event name', doc: 'overrides the default trigger' },
  { name: 'debounce', value: 'milliseconds', doc: 'delays the trigger, resets on each event' },
  { name: 'concurrency', value: 'block | queue | latest', doc: 'mutations only; default block for forms, queue otherwise' },
  { name: 'optimistic', value: 'handler expression', doc: 'patch/upsert/remove calls applied before the request, rolled back on failure' },
  { name: 'then', value: 'handler expression', doc: 'runs after a 2xx response; $result = parsed body' },
  { name: 'catch', value: 'handler expression', doc: 'runs after an error; $error = {status, body, message}' },
  { name: 'path', value: 'URL patterns /a/:b …', doc: 'on <html>: the path shapes this page is served for; `:name` segments appear read-only in $url' },
  { name: 'data', value: 'resource name', doc: 'on <script type="application/json"> in <head>: initial data for a resource' },
];

export const ON_DOC: AttrDoc = { name: 'on-<event>', value: 'handler expression', doc: 'plain event handler, no request; e.g. data-sn-on-click' };

export const ELEMENTS: Array<{ name: string; attrs: string[]; doc: string }> = [
  { name: 'sn-resource', attrs: ['name', 'src', 'key', 'items', 'total', 'order', 'when', 'paginate', 'page-size', 'size-param', 'cursor', 'direction-param', 'page-param', 'type', 'cache'], doc: 'a named, page-wide cache of server data; `cache` (or `cache="10m"`) shows the data from the last page load at once, then revalidates' },
  { name: 'sn-sync', attrs: ['src'], doc: 'one server event stream' },
  { name: 'sn-event', attrs: ['name', 'resource', 'op', 'item', 'set', 'when', 'fallback', 'type'], doc: 'maps one server event to a change message; child of <sn-sync>' },
  { name: 'sn-include', attrs: ['src'], doc: 'inlines a partial at build time' },
];
