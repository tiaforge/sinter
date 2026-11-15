// The package's entry: its helpers, which the app re-exports as a namespace
// (`export * as ui from '@fixture/ui'`), and its types. Each helper is imported from the module that
// declares it: `outline` needs no parser, `words` reaches `@fixture/heavy`.
export * from './sinter.helpers.js';
export * from './outline.js';
export * from './parse.js';
export type * from './sinter.types.js';
