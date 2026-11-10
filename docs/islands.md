# Islands

Attributes cover showing and changing API data. For imperative work such as editors, canvases,
charts or encryption, write a plain custom element. It gets data in through properties and sends
events out through DOM events; sinter never looks inside it.

```html
<template data-sn-if="selected">
  <mail-reader data-sn-prop="{message: selected, unlocked: vaultUnlocked}"
               data-sn-on-reader-flag="patch('messages', selected, {is_flagged: $event.detail})"></mail-reader>
</template>
```

```js
class MailReader extends HTMLElement {
  set message(m) { this.#m = m; this.#render(); }
  #m = null;
  #render() { /* draw this.#m into this element */ }
  flag() {
    this.dispatchEvent(new CustomEvent('reader-flag', { bubbles: true, detail: true }));
  }
}
customElements.define('mail-reader', MailReader);
```

## Data in

`data-sn-prop` takes an object literal and assigns each entry as a JavaScript property, so the
island receives objects and arrays, not strings. It works on custom elements only.

The island's module may define the element after the page has mounted (a lazy `import()`). Values
set before that are not lost: when the element is defined, sinter sets the latest value of each
property again through your class's setter.

## Events out

An island dispatches `CustomEvent`s with lowercase kebab-case names (`reader-flag`) that bubble.
`data-sn-on-<name>` handles them like any other event, with the payload in `$event.detail`.

Handlers run at every level the event bubbles through until one calls `$event.preventDefault()`.
If an event may be final at some level, dispatch it with `cancelable: true`.

## Instance API

An island can also use the store directly:

```js
import { instance } from '@tiaforge-ui/sinter';

const app = instance(document);              // the instance mounted on the document

const messages = app.resource('messages');
messages.subscribe(change => { /* ... */ });
messages.patch(msg, { is_read: true });

app.request('/api/email/raw?id=7');          // fetch through the request layer
app.optimistic(() => messages.remove(msg), () => app.request(url, { method: 'DELETE' }));

app.on('new_email', payload => notify(payload));  // any server event, mapped or not
```

| Method | Purpose |
| --- | --- |
| `instance(root)` | The instance mounted on `root`. Throws if there is none. |
| `resource(name)` | The store handle of a declared [resource](resources.md). |
| `request(url, init)` | `fetch` through the request layer, with the same 401 handling as actions. |
| `optimistic(change, run)` | Applies `change` as a layer and settles it with the promise from `run`: kept when it resolves, rolled back when it rejects. |
| `on(event, fn)` | Subscribes to a server event by name (see [sync.md](sync.md)). Returns the unsubscribe function. |
| `state(el)` | The state handle (`get()` and `update(fn)`) of the nearest `data-sn-state` scope. |

`app.on` receives every event on the stream, including ones no `<sn-event>` maps, and fires after
all mappings have run.

## Rules

- Islands never write to nodes sinter manages, and sinter never touches an island's children.
- Store writes from an island go to the base data, like server events. For a change the server
  hasn't confirmed, use `app.optimistic()`, so it rolls back on failure and stays consistent with
  incoming events.
- There can be several instances, one per mount root. There is no global one, so always pass the
  root to `instance()`.
