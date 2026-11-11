# sinter for VS Code

Editor support for [sinter](https://github.com/tiaforge/sinter) pages, from the project's own
`sinter lsp`:

- sinter's diagnostics as you type, in pages and in components, each linked to its explanation
- type errors as you type, hover types, completion inside `data-sn-*` expressions and go to
  definition (TypeScript 7 in the project; with older TypeScript, type errors on save)
- a quick fix for every "Did you mean …?"
- completion of sinter's attributes and elements in HTML

The extension does nothing in folders without `node_modules/@tiaforge-ui/sinter`.

Settings: `sinter.server.path`, `sinter.trace.server`. Command: `sinter: Restart language server`.
