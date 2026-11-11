# Editor setup

`sinter lsp` is a language server for the HTML files of a sinter project: errors as you type, hover,
completion and refactorings. It runs from the project's own `@tiaforge-ui/sinter`, so the editor
always matches the compiler the build uses.

| Feature | Needs |
| --- | --- |
| sinter's diagnostics as you type, in pages and components | any TypeScript, or none |
| Type errors (`SN208`) as you type, hover types, completion in expressions, go to definition | TypeScript 7 in the project |
| Type errors on save | TypeScript 5 or 6 |
| Did-you-mean quick fix | any |
| Extract to helper / action (refactoring, and the quick fix for `SN507`) | any; parameter types need TypeScript 7 |

The server finds pages and plugin options (`openapi`, `types`, …) in the Vite config, like
`sinter check`. It writes generated files to `.sinter/`; add that to `.gitignore`.

## VS Code

Install the extension from `editors/vscode` (until it is on the Marketplace and Open VSX):

```sh
cd editors/vscode && npm install && npm run package
code --install-extension sinter-vscode-0.1.0.vsix
```

It starts `sinter lsp` for every HTML file under a folder with `node_modules/@tiaforge-ui/sinter`,
one server per installation, and adds sinter's attributes and elements to HTML completion.
Settings: `sinter.server.path` (a CLI other than the project's), `sinter.trace.server`. Command:
`sinter: Restart language server`.

## Neovim (0.11+)

```lua
vim.lsp.config('sinter', {
  cmd = { 'npx', '--no-install', 'sinter', 'lsp', '--stdio' },
  filetypes = { 'html' },
  root_markers = { 'vite.config.ts', 'vite.config.js', 'package.json' },
})
vim.lsp.enable('sinter')
```

## Helix

In `languages.toml`, next to the HTML server Helix already uses:

```toml
[language-server.sinter]
command = "npx"
args = ["--no-install", "sinter", "lsp", "--stdio"]

[[language]]
name = "html"
language-servers = ["vscode-html-language-server", "sinter"]
```

## Emacs (Eglot)

```elisp
(add-to-list 'eglot-server-programs
             '((html-mode mhtml-mode) . ("npx" "--no-install" "sinter" "lsp" "--stdio")))
```

Eglot runs one server per buffer, so this replaces the HTML language server for these modes.

## Zed

Zed adds language servers only through extensions, and there is no sinter extension for Zed.

## Other editors

Any LSP client works: run `npx sinter lsp --stdio` in the project root for `html` files. The server
supports full-text sync, published diagnostics, hover, completion (trigger `.`, with resolve),
definition, code actions (`quickfix` and `refactor.extract`, with `codeAction/resolve` when the
client supports resolving `edit`), and `workspace/didChangeWatchedFiles` (it registers its own
watchers when the client allows dynamic registration). Extracting into a module that does not exist
yet needs `workspace.workspaceEdit.resourceOperations` with `create`; without it, the action is
offered only where the module exists.

## Extract to helper

On an expression in an attribute, the code actions (VS Code: the light bulb, or *Refactor…*) offer
**Extract to helper**. The expression moves into a new exported function of the helpers module
(`src/sinter.helpers.js` or `.ts`, or the `helpers` path of the plugin options; created when there
is none, as `.ts` in a TypeScript project), and the attribute calls it. A selection inside the
expression extracts just that part (the smallest whole expression around the selection).

```html
<!-- before; the cursor in the data-sn-text value -->
<template data-sn-for="(c, i) in contacts">
  <li data-sn-text="c.name.toUpperCase() + ' (' + c.tags.join(', ') + ')'"></li>
</template>
<!-- after -->
<template data-sn-for="(c, i) in contacts">
  <li data-sn-text="textValue(c)"></li>
</template>
```

```ts
// src/sinter.helpers.ts
import type { Contact } from './sinter.types';

export function textValue(c: Contact) {
  return c.name.toUpperCase() + ' (' + c.tags.join(', ') + ')';
}
```

Save the helpers module so the page sees the new function.

- **Parameters** are the expression's free names: loop variables and indexes, state, `data-sn-let`
  names, resources, payload fields, `$event`, `$el`, `$result` and the other magic names, and names
  an arrow function in the expression binds around the selection. `$meta.contacts` is passed as a
  whole (`contactsMeta`). Helpers, helper namespaces, store functions and JavaScript globals are not
  parameters; the module imports what it needs (`date` from the package, a namespace's module).
- **Types.** With TypeScript 7 the parameters are typed as TypeScript sees them in the page (type
  annotations in a `.ts` module, JSDoc `@param` in a `.js` one, types-module names imported).
  Without it they are `unknown`, to fill in.
- **Name.** It comes from the attribute (`textValue`, `showValue`, `urlPart` in a URL) or the
  assignment (`nextQuery`), made unique against helpers, actions, state, resources and the module's
  own declarations. There is no rename: rename it in the module and the page by hand.
- **Handlers.** Helpers are pure, so assignments and store calls stay in the page and the value of
  an assignment is extracted: `query = c.name.trim()` → `query = nextQuery(c)`. A selection over
  several assignments offers one helper per value. When they write properties of one state object
  and none reads what an earlier one wrote, it also offers one helper returning an object that the
  handler merges: `draft.title = …; draft.body = …` →
  `Object.assign(draft, draftChanges(draft, sig))`. Handlers have no destructuring or local
  variables, so other writes cannot share one call. A part that assigns, calls a store function, a
  mutating method or a method of `$event`/`$el` is not offered.
- **Extract to action.** On `data-sn-call` (and `<sn-resource call>`), this moves the whole call
  into a new action that makes it and forwards the context:
  `data-sn-call="send(wrap(draft.body, sig), draft.to)"` → `data-sn-call="runSend(draft, sig)"` with
  `export function runSend(draft, sig, ctx) { return send(wrap(draft.body, sig), draft.to, ctx); }`.
  An argument alone can still be a helper.
- **Only valid extractions are offered.** Each one is compiled first; one the compiler would reject
  (a `data-sn-state` or `data-sn-attr` object literal as a whole, an attribute written with
  character references) is not offered.
- **Dependencies get coarser.** `textValue(c)` re-runs when anything in `c` changes, not only
  `c.name`.
