// The core's flags in the test suite (vitest.config.ts aliases src/runtime/flags.ts here). A build compiles away the
// parts of the core no page uses (docs/proposals/site-core.md); here each part is off until a page that uses it
// mounts (`use`, called by `mount` with the page's IR), and every test starts with them all off again
// (test/core-flags-setup.ts). The core reads them through its namespace import, so a change applies at once. A
// page whose IR does not show a part it needs fails here, in the test that mounts it, not in an app.
import { coreParts } from '../src/core-parts.js';
import type { IR } from '../src/ir.js';

/** not parts: decided by the build from its `apis`, its `swap` option and its early files; always on here */
export const TOKEN = true, SWAP = true, SHARED = true;

export let LIST = false, BRANCH = false, ACTION = false, DIALOG = false, EVENTS = false, MODEL = false, PROP = false, STYLE = false, RESOURCE = false, TWIN = false, POPOVER = false;
export let TEXTRUN = false, SHOW = false, CLASSX = false, ATTR = false, KEYED = false, ORDER = false;
export let FN_DIALOG = false, FN_ITEMS = false, FN_REFRESH = false, FN_PAGE = false, FN_EMIT = false, FN_RUN = false, MOVES = false;

const on = new Set<string>();
/** parts a test's core was built without (`without`): a page that uses one does not turn it on */
const left = new Set<string>();
const apply = () => {
  LIST = on.has('LIST'); BRANCH = on.has('BRANCH'); ACTION = on.has('ACTION'); DIALOG = on.has('DIALOG'); EVENTS = on.has('EVENTS');
  MODEL = on.has('MODEL'); PROP = on.has('PROP'); STYLE = on.has('STYLE'); RESOURCE = on.has('RESOURCE'); TWIN = on.has('TWIN'); POPOVER = on.has('POPOVER');
  TEXTRUN = on.has('TEXTRUN'); SHOW = on.has('SHOW'); CLASSX = on.has('CLASSX'); ATTR = on.has('ATTR'); KEYED = on.has('KEYED'); ORDER = on.has('ORDER');
  FN_DIALOG = on.has('FN_DIALOG'); FN_ITEMS = on.has('FN_ITEMS'); FN_REFRESH = on.has('FN_REFRESH'); FN_PAGE = on.has('FN_PAGE'); FN_EMIT = on.has('FN_EMIT'); FN_RUN = on.has('FN_RUN'); MOVES = on.has('MOVES');
};

/** a page mounts: its parts join those of the pages mounted before it in this test (`fns`: its expression functions, whose code names the store functions) */
export function use(ir: IR, fns: unknown[] = []): void {
  for (const p of coreParts(ir, fns.map(String))) if (!left.has(p)) on.add(p);
  apply();
}

/** every part off, as at the start of a test; `all`: every part on (a test about the core itself, not a page) */
export function reset(all = false): void {
  on.clear();
  left.clear();
  if (all) for (const p of ['LIST', 'BRANCH', 'ACTION', 'DIALOG', 'EVENTS', 'MODEL', 'PROP', 'STYLE', 'RESOURCE', 'TWIN', 'POPOVER', 'TEXTRUN', 'SHOW', 'CLASSX', 'ATTR', 'KEYED', 'ORDER', 'FN_DIALOG', 'FN_ITEMS', 'FN_REFRESH', 'FN_PAGE', 'FN_EMIT', 'FN_RUN', 'MOVES']) on.add(p);
  apply();
}

/** the core of a build that left `parts` out (its IR missed them), until the next `reset`: for tests of what then fails */
export function without(...parts: string[]): void {
  for (const p of parts) { left.add(p); on.delete(p); }
  apply();
}
