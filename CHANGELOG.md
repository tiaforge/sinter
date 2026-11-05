# Changelog

Attribute names, function names and diagnostic codes are public API. Before
1.0, renames are allowed but listed here.

## 0.1.0 (unreleased)

First implementation of the v0.1 spec: compiler, runtime, `sse`,
`optimistic`, `paginate`, `persist`, Vite plugin and testing module.

- `configure({ transport })` picks the `<sn-sync>` transport per stream URL;
  `@tiaforge/sinter/ws` adds a WebSocket transport, and `llms.txt` has a
  SignalR recipe.
- `Transport.connect`'s `onEvent` now receives the parsed payload
  (`unknown`) instead of the raw string.
- `sinter check` type-checks expressions with the project's TypeScript:
  `type` on `<sn-resource>` and `<sn-event>`, OpenAPI specs
  (`sinter({ openapi })`), `sinter({ typecheck: true })` for `vite build`,
  `checkPage()` in `@tiaforge/sinter/check`. New codes: `SN208`, `SN307`,
  `SN308`, `SN504`, `SN505`, `SN506`.
- `sinter lsp`: a language server with diagnostics as you type, type errors,
  hover, completion, go to definition and a did-you-mean quick fix; a VS Code
  extension in `editors/vscode`; setup for other editors in `docs/editors.md`.
- `Diagnostic` has an optional `span` (what an editor underlines).
- Diagnostics link to `docs/diagnostics.md`, generated from the compiler.
- The core's size budget is 11 KB min+gzip (was 5 KB, never met).
