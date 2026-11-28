// Which parts of the early runtime a site's head script uses, as src/runtime/flags.ts says for the core. Every part is
// on here, so the early runtime works for any page: dev, tests, and an early file bundled without the Vite plugin. A
// build (src/vite.ts, the early files' nested build) serves this module with what the site's pages' early files use
// (`CompileResult.earlyRuntime`, compiler/index.ts `earlyRuntimeParts`) and the rest `false`; the bundler inlines the
// constants and drops the code they guard. One head script per site: the flags are the site's, not a page's.

/** a page has embedded data its early file reads (`EarlyIR.emb`): `$r` early, and the token's read it makes */
export const EMBEDDED = true;
