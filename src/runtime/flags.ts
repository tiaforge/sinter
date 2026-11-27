// Which parts of the core a site's pages use (docs/proposals/site-core.md). Every part is on here, so the
// core works for any page: dev, and an app that does not build with the Vite plugin. A build (src/vite.ts)
// serves this module with the union of what its pages' IRs use (`coreParts`,
// src/core-parts.ts) and every other part `false`; the bundler inlines the constants and drops the code
// they guard. One core per site: every page of a build shares the same chunk, so the next page's core is
// already cached, and a swap can mount any page of the site with it.
//
// Keep each name in step with CORE_PARTS (src/core-parts.ts), which decides them from the IR.

/** `data-sn-for`: keyed lists (reconcile, keys, the early script's rows) */
export const LIST = true;
/** `data-sn-if` / `data-sn-else`, `<sn-component use>`: branches */
export const BRANCH = true;
/** `data-sn-post|put|patch|delete|call`: actions (concurrency, the request, `then`/`catch`) */
export const ACTION = true;
/** bindings inside a `<dialog>` (`NodeDef.dl`): they wait while it is closed */
export const DIALOG = true;
/** delegated events: handlers, models and actions listen at the mount root (`IR.ev`) */
export const EVENTS = true;
/** `data-sn-model` */
export const MODEL = true;
/** `data-sn-with`: properties of custom elements, set again once they are defined */
export const PROP = true;
/** `data-sn-style` */
export const STYLE = true;
/** `<sn-resource>`: loaders, the shared GET, the store */
export const RESOURCE = true;
/**
 * an action's element with an `id` (or bound attributes, which may give it one), in a page with branches (`IR.tw`): a running
 * action goes on as the action of the element with its id in an if's new branch (same id, same control)
 */
export const TWIN = true;
/**
 * Not a part of the core: a helper module a page shares with its early file (docs/first-paint.md#own-copies), whose own
 * copy a swap imports beside the page module (it runs no early file). A build decides it from its early files
 * (`flagsModule`), so a site that shares nothing ships none of it.
 */
export const SHARED = true;
/** embedded data that is the signed-out answer (`ResourceDef.so`): the page requests it instead while a token is stored */
export const SIGNEDOUT = true;
/** `closePopover()` in a handler (`IR.po`) */
export const POPOVER = true;
/**
 * Not a part of the core: `sinter({ swap: true })`. A stream whose URL the next page declares stays open across a
 * swap (src/sse-handover.ts, docs/proposals/stream-handover.md). A build decides it from its `swap` option, so an
 * app without swaps ships none of it.
 */
export const SWAP = true;
/**
 * Not a part of the core: an API of `sinter({ apis })` has a `token` (src/token.ts). The core's calls into the token
 * module (a load or action signed out, a 401, `signOut()`) are there only then. A build decides it from its `apis`.
 */
export const TOKEN = true;
/**
 * Not a part of the core: the build has `sinter({ apis })` (the page modules' `$apis`). The request layer finds a request's
 * API (its credentials and static headers) only then. A build decides it from its `apis`.
 */
export const APIS = true;
/** `<template data-sn-text>`: text runs (their writer) */
export const TEXTRUN = true;
/** `data-sn-show` (its writer) */
export const SHOW = true;
/** `data-sn-class` with a value for its class, not an object of named classes (its writer) */
export const CLASSX = true;
/** `data-sn-attr`, `data-sn-href` and the other attribute bindings (their writer, with the URL attributes' scheme check) */
export const ATTR = true;
/** a resource with a `key`: keyed collections in the store (`src/runtime/store.ts`) */
export const KEYED = true;
/** a resource with an `order`: the store's sorting, by locale for strings */
export const ORDER = true;
/** `openDialog()` or `closeDialog()` in a handler (the compiled handlers name it: `$.$f.openDialog`) */
export const FN_DIALOG = true;
/** `upsert()`, `merge()` or `remove()` in a handler or an optimistic change */
export const FN_ITEMS = true;
/** `refresh()` in a handler */
export const FN_REFRESH = true;
/** `page()` in a handler */
export const FN_PAGE = true;
/** `emit()` in a handler */
export const FN_EMIT = true;
/** `run()` in a handler */
export const FN_RUN = true;
/**
 * a paginated resource without `model` (keyset, append, or numbered with its page in memory): the pager's moves by
 * direction and cursor (src/paginate.ts). Off, the pager only follows a `model` page in the URL.
 */
export const MOVES = true;
/**
 * Called with each page's IR and expression functions as it mounts; nothing here, nor in a build. The test suite's flags
 * (test/core-flags.ts) turn on the parts the mounted pages use and no others, so every test runs on the smallest core for
 * its pages.
 */
export const use: ((ir: import('../ir.js').IR, fns: unknown[]) => void) | undefined = undefined;
