# Component libraries

A component library is a package of sinter components that ships source: component `.html` files,
their scripts, helper modules and types. The app's sinter compiles them as it compiles the app's own
components, so a library's components get everything an app component gets: build-time constants,
the early script, embedded data, type checks and scoped styles. Precompiled output would lose all of
them.

## Using one

Install the package and name it in the config:

```js
// vite.config.js
import { defineConfig } from 'vite';
import sinter from '@tiaforge-ui/sinter/vite';

export default defineConfig({
  plugins: [sinter({ libraries: ['@acme/ui'] })],
});
```

Its public components are then tags on any page, layout or component of the app, with props, slots,
events and fills as for the app's own:

```html
<ui-card data-sn-with="{ title: post.title }"><p data-sn-text="post.summary"></p></ui-card>

<ui-tree data-sn-with="{ items: folders }">
  <button slot="node" data-sn-text="$slot.item.label" data-sn-on-click="open = $slot.item.id"></button>
</ui-tree>
```

- **A prefix per library.** A library's components share their first segment (`ui-card`, `ui-tree`:
  `ui`), and the library owns it. Two configured libraries with one prefix, or an app component
  whose name starts with a library's prefix, fail the build (`SN337`). A tag with the prefix names
  one of the library's components, or is an error (`SN339`).
- **Public and internal.** The app uses the library's public components. Its internal ones are its
  own: an app using one is `SN339`, which lists the public ones. `ComponentName` (the candidates of
  `<sn-component use>` in the app's markup) holds the app's components and the libraries' public ones.
- **No shadowing.** To change how a library component looks or behaves everywhere, write a wrapper
  component of your own with fills for its slots ([app-wide looks](components.md#tree-slots)), and
  use the wrapper.
- **Helpers are a namespace.** The app re-exports the library from its helpers module, and markup
  calls them through the name it chose:

  ```ts
  // src/sinter.helpers.ts
  export * as ui from '@acme/ui';
  ```

  ```html
  <p data-sn-text="ui.initials(author.name)"></p>
  ```

  The re-export is followed into the package like a relative one, through the package's entry to
  the module that declares each helper: the page imports a helper from that module, and what folds
  at build time and what waits for a [lazy package](lazy.md#helpers-that-wait) is decided per
  module, as for the app's own helpers.
- **Helpers that feed components run at every read.** A prop is its expression, evaluated wherever the
  component reads it, at every read; in a recursive component (a tree that renders its children with
  itself) a helper in a prop runs again on each level and each render. Make such a helper cheap on repeat
  calls with `memo()` ([expressions.md](expressions.md#memoized-helpers)): `export const parse =
  memo(parseImpl)`. Its results are frozen and shared by every caller, so a component that needs to change
  one works on a copy.
- **Types.** A library's props, slot data and helper results are typed by the library's own types
  module. The app names a library's types by re-exporting them from `src/sinter.types.ts`:

  ```ts
  export type { Item } from '@acme/ui';
  ```

- **Styles.** A library's scoped styles are in the cascade layer `sinter-lib`, which sinter declares
  first in the page's stylesheet. The app's unlayered CSS and its own layers win over a library's
  rules without raising specificity. An app that wants the libraries elsewhere among its layers
  declares the order itself, before its other CSS: `@layer reset, sinter-lib, app;`.
- **Where a problem is.** A diagnostic in a library's file names the file in the package, then where
  the app uses it:

  ```
  @acme/ui/sinter/components/internal/ui-node.html:4:7 error SN101 unknown-attribute: … used at src/pages/post.html:12
  ```

- **Workspaces.** A library linked into `node_modules` from elsewhere (a monorepo workspace, `npm
  link`) is read where it really is, outside the project root. In dev it is left out of Vite's
  dependency pre-bundling, served through the link and watched: a change to one of its components
  reloads the pages that use it.
- **One copy of sinter.** A linked library has a `node_modules` of its own, usually with its
  own sinter (its dev dependency). The plugin adds sinter to Vite's `resolve.dedupe`, so the library's
  `import … from '@tiaforge-ui/sinter'` gets the app's copy: a second copy's `instance()` knows none of the app's
  mounts. Without the plugin (a bundler of its own, a test setup), dedupe it yourself. When two copies are loaded
  anyway, `instance()` of the copy that did not mount the page throws `sinter: mounted by another copy`, and in
  dev the app's copy warns with the cause, so code that catches the error still leaves a trace. A library that
  pins another sinter version gets the app's copy too: its `peerDependencies` range is what `SN537` checks.
  sinter itself can be linked the same way (`npm link`, `file:` to a checkout): its own files are a package to
  the plugin wherever they really are, never checked or rewritten as the app's modules.
- **Versions.** A library lists the sinter versions it supports in `peerDependencies`; the app's
  sinter warns when its own version is outside the range, or when a library lists none (`SN537`).

## Writing one

A library is a package whose `package.json` names a folder laid out like an app's `src/`:

```json
{
  "name": "@acme/ui",
  "type": "module",
  "sinter": "./sinter",
  "exports": { ".": "./sinter/index.ts" },
  "peerDependencies": { "@tiaforge-ui/sinter": "^0.18.0" }
}
```

```
sinter/
  components/            public: what apps use
    ui-card.html
    ui-card.ts           a script, as an app component's
    ui-tree.html
    internal/            the library's own
      ui-node.html
  sinter.helpers.ts      helpers, re-exported by the package's entry
  sinter.types.ts        the types its components name
  index.ts               the entry: export * from './sinter.helpers.js'; export type * from './sinter.types.js'
fixtures/
  index.html             pages that use its public components, for its own checks
```

- **Components** are written as in an app ([components](components.md)). Every name starts with the
  library's prefix (`SN337` otherwise). Internal components may be used by any component of the
  library, public or internal.
- **Type names** in `data-sn-props`, `Slot<T>` and `data-sn-emits` resolve against
  `sinter.types.ts`, whatever the app's types module exports.
- **Scripts** work as in the app: `import { UiCardComponent } from './ui-card.html'`, a class per
  instance, with `this.props`, `this.state`, `this.refs` and `this.root`. `sinter check` in the
  library writes the base classes' declarations to `sinter/sinter.components.d.ts`.
- **Tree slots** stop at the package: a placement in a library component is filled by the nearest
  root of the same library that declares its name, and a library root written in the app's markup
  (or in another library's) starts a new contract. Every slot a root declares must be placed by a
  component of the library (`SN331`), and `<sn-component use>` in a component with slots or tree
  placements names its candidates by a template string or a map, which choose among the library's
  own components, internal ones included (`SN312`, `SN339`). See [tree slots](components.md#tree-slots).
- **Lazy packages.** A helper module of the library that imports a package of the app's `sinter({
  lazy })` loads whole when a let first needs it, as the app's own would. The app decides what is
  lazy, not the library. Keep helpers that do not need a heavy dependency in a module that does not
  import it, and re-export both from the entry: those stay ordinary helpers, usable in any binding,
  and the heavy module is not in the page's bundle. A lazy package that only the library depends on
  (in its own `node_modules`) is resolved from the library.

### Checking a library

A library has no pages of its own, and `sinter check` checks a component through the pages that use
it. Keep fixture pages in `fixtures/` beside the `sinter` folder, using the public components with
the cases you support. `npx sinter check` in the library's repository finds them when there is no
Vite config with pages, configures the library as the app's `libraries` would, and compiles and
type-checks them, the declared-slot and `<sn-component use>` rules included. The same rules are
checked again in each app's build.

The fixtures call the library's helpers as an app does, through a namespace. Their modules sit beside
them, as an app's sit in `src/`: `fixtures/sinter.helpers.ts`, `fixtures/sinter.types.ts`, and so on.
The helpers module imports the library by its own name, which a
package with `exports` may do (Node's self-reference), resolved through its own `exports` with
production conditions:

```ts
// fixtures/sinter.helpers.ts in @acme/ui's repository
export * as ui from '@acme/ui';
```

## Diagnostics

| Code | When |
| --- | --- |
| `SN337` (`invalid-library`) | A package in `libraries` is not installed, has no `"sinter"` field or folder with `components/`, has a component both public and internal, or names its components with more than one prefix; two libraries share a prefix, or an app component has a library's prefix |
| `SN339` (`library-component`) | The app uses an internal component, a tag with a library's prefix names none of its components, or a `<sn-component use>` map in a library names a component outside it |
| `SN537` (`library-version`, warning) | sinter's version is outside a library's `peerDependencies` range, or the library lists none |
