# sinter for VS Code

Editor support for [sinter](https://github.com/tiaforge/sinter) pages, from the project's own
`sinter lsp`:

- sinter's diagnostics as you type, in pages and in components, each linked to its explanation
- type errors as you type, hover types, completion inside `data-sn-*` expressions and go to
  definition (TypeScript 7 in the project; with older TypeScript, type errors on save)
- a quick fix for every "Did you mean …?"
- completion of sinter's attributes and elements in HTML
- single-file components: TypeScript highlighting in a component's `<script lang="ts">`, and completion,
  hover, go to definition and type errors there, typed by the component's props, events, refs and state
  (TypeScript 7; with older TypeScript, type errors on save)

The extension turns off VS Code's own check of `<script>` elements in HTML (`html.validate.scripts`),
which reads every script as JavaScript and would report the types of a `<script lang="ts">` as errors:
sinter checks them instead. Set it back in your settings if you want it.

The extension does nothing in folders without `node_modules/@tiaforge-ui/sinter`.

Settings: `sinter.server.path`, `sinter.trace.server`. Command: `sinter: Restart language server`.
