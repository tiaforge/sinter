// The library's helpers, in two modules under one namespace. An app re-exports the package as a
// namespace (`export * as md from '@tiaforge-ui/sinter-markdown'` in its src/sinter.helpers.ts) and calls
// `md.parse`, `md.headings` and `md.text` in markup.
//
// - parse.ts imports the parser. An app that lists the parser's package in `sinter({ lazy })` makes it
//   load when a let first needs it; the let waits for it.
// - tree.ts reads a parsed tree and imports no parser, so `md.headings` and `md.text` stay ordinary
//   helpers either way: they render early and fold at build time.
export { parse } from './parse.js';
export { headings, text } from './tree.js';
