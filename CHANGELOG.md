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
