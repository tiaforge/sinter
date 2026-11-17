// Which parts of the core a site's pages use (docs/proposals/site-core.md). Every part is on here, so the
// core works for any page: tests, dev, and an app that does not build with the Vite plugin. A build with
// `sinter({ siteCore: true })` serves this module with the union of what its pages' IRs use (`coreParts`,
// src/core-parts.ts) and every other part `false`; the bundler inlines the constants and drops the code
// they guard. One core per site: every page of a build shares the same chunk, so the next page's core is
// already cached, and a swap can mount any page of the site with it.
//
// Keep each name in step with CORE_PARTS (src/core-parts.ts), which decides them from the IR.

/** `data-sn-for`: keyed lists (reconcile, keys, the early script's rows) */
export const LIST = true;
/** `data-sn-if` / `data-sn-else`, `<sn-component use>`: branches */
export const BRANCH = true;
/** `data-sn-get|post|put|patch|delete|call`: actions (concurrency, the request, `then`/`catch`) */
export const ACTION = true;
/** bindings inside a `<dialog>` (`NodeDef.dl`): they wait while it is closed */
export const DIALOG = true;
/** delegated events: handlers, models and actions listen at the mount root (`IR.ev`) */
export const EVENTS = true;
/** `data-sn-model` */
export const MODEL = true;
/** `data-sn-prop`: properties of custom elements, set again once they are defined */
export const PROP = true;
/** `data-sn-style` */
export const STYLE = true;
/** `<sn-resource>`: loaders, the shared GET, the store */
export const RESOURCE = true;
