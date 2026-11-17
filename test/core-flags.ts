// The core's flags in the test suite (vitest.config.ts aliases src/runtime/flags.ts here). A build compiles away the
// parts of the core no page uses (docs/proposals/site-core.md); here each part is off until a page that uses it
// mounts (`use`, called by `mount` with the page's IR), and every test starts with them all off again
// (test/core-flags-setup.ts). The core reads them through its namespace import, so a change applies at once. A
// page whose IR does not show a part it needs fails here, in the test that mounts it, not in an app.
import { coreParts } from '../src/core-parts.js';
import type { IR } from '../src/ir.js';

export let LIST = false, BRANCH = false, ACTION = false, DIALOG = false, EVENTS = false, MODEL = false, PROP = false, STYLE = false, RESOURCE = false;

const on = new Set<string>();
const apply = () => {
  LIST = on.has('LIST'); BRANCH = on.has('BRANCH'); ACTION = on.has('ACTION'); DIALOG = on.has('DIALOG'); EVENTS = on.has('EVENTS');
  MODEL = on.has('MODEL'); PROP = on.has('PROP'); STYLE = on.has('STYLE'); RESOURCE = on.has('RESOURCE');
};

/** a page mounts: its parts join those of the pages mounted before it in this test */
export function use(ir: IR): void {
  for (const p of coreParts(ir)) on.add(p);
  apply();
}

/** every part off, as at the start of a test; `all`: every part on (a test about the core itself, not a page) */
export function reset(all = false): void {
  on.clear();
  if (all) for (const p of ['LIST', 'BRANCH', 'ACTION', 'DIALOG', 'EVENTS', 'MODEL', 'PROP', 'STYLE', 'RESOURCE']) on.add(p);
  apply();
}
