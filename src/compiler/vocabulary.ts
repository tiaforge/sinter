// The whole attribute and element vocabulary, with one-line descriptions.
// The compiler, llms.txt and html-custom-data.json are all built from it.

export interface AttrDoc { name: string; value: string; doc: string }

export const ATTRIBUTES: AttrDoc[] = [
  { name: 'state', value: 'object literal', doc: 'declares local reactive state for the element and its subtree' },
  { name: 'let', value: 'object literal {name: expression}', doc: 'derived names for the element and its subtree, computed where they are read; later names may use earlier ones' },
  { name: 'text', value: 'value expression', doc: 'sets textContent; never HTML' },
  { name: 'attr', value: 'object literal {href: …}', doc: 'literal keys; null/false removes, true sets empty; URL values are checked; checked, selected, indeterminate and value also set the live property' },
  { name: 'class', value: 'object literal {unread: …}', doc: 'toggles each class' },
  { name: 'style', value: "object literal {'--color': …}", doc: 'sets each property with style.setProperty' },
  { name: 'show', value: 'value expression', doc: 'toggles the hidden attribute' },
  { name: 'prefetch', value: 'off', doc: 'on <html>: no other page prefetches this one\'s data or the page itself (Speculation Rules), and none prerenders it; for pages that do something when they load' },
  { name: 'transition', value: 'value expression (a name)', doc: 'the same thing on two pages: following a link from the element (or its row) to a page with an element of the same name morphs one into the other (view transitions; back too)' },
  { name: 'prop', value: 'object literal', doc: 'sets JS properties; custom elements only (one defined later gets them again through its setters). On a component\'s tag: its props, live and read-only' },
  { name: 'component', value: 'props type', doc: 'on the <template> of a component file (src/components/<name>.html): the props it takes, a TypeScript type literal such as { article: Article; compact?: boolean }' },
  { name: 'early', value: 'off', doc: 'on a component\'s tag (a use): this use is left out of the early script and renders when the page module runs (build-time constants are still in the HTML); for uses that may shift the layout when they render, to keep the early script small' },
  { name: 'import', value: 'lazy packages, comma-separated', doc: 'loads packages of sinter({ lazy }) when the element is rendered (at takeover outside templates, when its branch or row first renders inside one), instead of on first call' },
  { name: 'preload', value: 'lazy packages, comma-separated', doc: 'the build preloads packages of sinter({ lazy }) with the page (<link rel="modulepreload"> in its head): fetched in parallel with the page bundle, run on first call or by data-sn-import' },
  { name: 'ref', value: 'name', doc: 'in a component\'s markup: the element its script reads as this.refs.<name>, typed by its tag' },
  { name: 'layout', value: 'props type', doc: 'on the <html> of a layout file (src/layouts/<name>.html): the props it takes; a page that is only the layout\'s tag fills its slots, in the head and the body' },
  { name: 'head', value: 'props type', doc: 'on the <template> of a head component (src/components/<name>.html): its props, as data-sn-component; it holds any number of head elements (<title>, <meta>, <link>, …), inlined at its use in a head' },
  { name: 'emits', value: 'events type', doc: 'on the <template data-sn-component>: the events emit() sends and their detail types, e.g. { select: Article }' },
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
  { name: 'call', value: 'action call', doc: 'local action: calls a function from the actions module, e.g. pgp.decrypt(msg); a handler starts it with run(\'id\')' },
  { name: 'body', value: 'value expression', doc: 'JSON request body; overrides form serialization' },
  { name: 'trigger', value: 'DOM event name', doc: 'overrides the default trigger' },
  { name: 'debounce', value: 'milliseconds', doc: 'delays the trigger, resets on each event; without a method, delays the element\'s data-sn-on-* handlers' },
  { name: 'concurrency', value: 'block | queue | latest', doc: 'mutations only; default block for forms, queue otherwise' },
  { name: 'optimistic', value: 'handler expression', doc: 'patch/upsert/remove calls applied before the request, kept on success, rolled back on failure' },
  { name: 'then', value: 'handler expression', doc: 'runs after a 2xx response; $result = parsed body' },
  { name: 'catch', value: 'handler expression', doc: 'runs after an error; $error = {status, body, message, detail}. A form without it shows a 4xx `{errors: {name: message}}` on its fields (aria-invalid and the message); its markup reads the failure as `$error`' },
  { name: 'confirm', value: 'value expression', doc: 'asks this question before the action runs (configure({ confirm }), window.confirm by default); no question when falsy' },
  { name: 'encoding', value: 'json | form', doc: 'form: the body (data-sn-body, arrays as repeated keys, or the form) goes as application/x-www-form-urlencoded' },
  { name: 'retry', value: 'retry policy name', doc: 'mutations only: sends the request again as that policy of configure({ retry }) says (after a network error, a 5xx, a 429), with an Idempotency-Key; without it a write is sent once' },
  { name: 'apply', value: 'off', doc: 'turns write-through off for this mutation: its response is not applied to the resources it is about' },
  { name: 'path', value: 'URL patterns /a/:b …', doc: 'on <html>: the path shapes this page is served for; `:name` segments appear read-only in $url' },
  { name: 'data', value: 'resource name', doc: 'on <script type="application/json"> in <head>: initial data for a resource' },
];

export const ON_DOC: AttrDoc = { name: 'on-<event>', value: 'handler expression', doc: 'plain event handler, no request; e.g. data-sn-on-click' };
export const DEBOUNCE_ON_DOC: AttrDoc = { name: 'debounce-<event>', value: 'milliseconds', doc: 'delays only that event\'s data-sn-on-<event> handler (it runs with the last event); e.g. data-sn-debounce-input' };

export const ELEMENTS: Array<{ name: string; attrs: string[]; doc: string }> = [
  { name: 'sn-resource', attrs: ['name', 'src', 'method', 'body', 'call', 'each', 'key', 'items', 'total', 'order', 'when', 'paginate', 'page-size', 'size-param', 'cursor', 'direction-param', 'direction-values', 'page-param', 'offset-param', 'start-page', 'type', 'cache', 'refresh', 'then', 'early'], doc: 'a named, page-wide cache of server data; `cache` (or `cache="10m"`) shows the data from the last page load at once, then revalidates. `refresh="30s"` reloads it once that long has passed since its last load, whatever caused that load (server events, `refresh()`, a reconnect), in the background: `$meta.loading` stays false, and paused while the tab is hidden. `early="off"`: never preloaded or requested before the page module (for a resource whose request a middleware answers or changes). `then` is a handler run after each successful load (`$result`: what it loaded; the state around the resource in scope). Loading needs no attributes: concurrent loads of one URL share a request, a `src` change aborts the running one (latest wins), a change typed into a text field waits 250 ms for the next keystroke, a resource only dialogs read is requested with low priority, and a bfcache restore or going back online refetches' },
  { name: 'sn-sync', attrs: ['src'], doc: 'one server event stream' },
  { name: 'sn-component', attrs: ['use', 'data-sn-prop'], doc: 'a component chosen by data at runtime; `use` names it: ``use="`${b.type}-block`"`` (convention), `use="{ hero: \'hero-block\' }[b.type]"` (map) or `use="blockComponent(b)"` (helper); it must fit `ComponentName`, every candidate must exist, props are checked per candidate (narrowed for convention and map); a value outside the candidates renders nothing, or the `data-sn-else` template after it' },
  { name: 'sn-event', attrs: ['name', 'resource', 'op', 'item', 'set', 'when', 'fallback', 'then', 'type'], doc: 'maps one server event to a change message; child of <sn-sync>. `then` is a handler run after the change (payload fields and the state around the sync in scope), e.g. close(\'detail\'); with `then`, `resource` and `op` may be left out' },
];

// ---- key filters: `data-sn-on-keydown-<modifiers->key`, `data-sn-on-keyup-…`

export const KEY_ON_DOC: AttrDoc = {
  name: 'on-keydown-<key>', value: 'handler expression',
  doc: 'runs only for that key (also on-keyup-<key>): modifiers first, the key last, e.g. data-sn-on-keydown-j, -shift-n (N), -mod-enter (Ctrl, Cmd on Apple), -escape, -question (?); matches KeyboardEvent.key; other Ctrl/Alt/Meta held do not match; an ancestor\'s filter skips keys typed into fields; a match calls preventDefault()',
};

/** modifier names, as written, to their IR bit; `mod` is Ctrl, or Meta (Cmd) on Apple platforms */
export const MODIFIERS: Record<string, number> = { ctrl: 1, alt: 2, shift: 4, meta: 8, mod: 16 };
/** IR bit: Shift does not matter (a character that already says it, `?`, `1`), unless the filter names `shift` */
export const LOOSE_SHIFT = 32;

/** named keys: the name to `KeyboardEvent.key`; Shift must match exactly */
export const NAMED_KEYS: Record<string, string> = {
  escape: 'Escape', enter: 'Enter', tab: 'Tab', space: ' ', backspace: 'Backspace', delete: 'Delete', insert: 'Insert',
  home: 'Home', end: 'End', pageup: 'PageUp', pagedown: 'PageDown',
  arrowup: 'ArrowUp', arrowdown: 'ArrowDown', arrowleft: 'ArrowLeft', arrowright: 'ArrowRight', contextmenu: 'ContextMenu',
  ...Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`f${i + 1}`, `F${i + 1}`])),
};

/** characters an attribute name cannot spell (or `-`, the separator), by name; Shift does not matter for them, like digits */
export const CHAR_KEYS: Record<string, string> = {
  slash: '/', backslash: '\\', question: '?', period: '.', comma: ',', semicolon: ';', colon: ':', quote: "'", backquote: '`',
  minus: '-', plus: '+', equal: '=', asterisk: '*', bracketleft: '[', bracketright: ']',
};

/** common other spellings, for "did you mean" */
export const KEY_ALIASES: Record<string, string> = {
  esc: 'escape', return: 'enter', up: 'arrowup', down: 'arrowdown', left: 'arrowleft', right: 'arrowright', del: 'delete',
  ins: 'insert', pgup: 'pageup', pgdn: 'pagedown', spacebar: 'space', control: 'ctrl', cmd: 'meta', command: 'meta',
  option: 'alt', opt: 'alt', super: 'meta', win: 'meta', dot: 'period', hyphen: 'minus', dash: 'minus', equals: 'equal',
  questionmark: 'question', grave: 'backquote', apostrophe: 'quote',
  ...Object.fromEntries(Object.entries(CHAR_KEYS).map(([n, c]) => [c, n])),
};
