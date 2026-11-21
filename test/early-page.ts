// A hand-written early page object for tests of the early requests: its requests (`EarlyIR.res`, `as`) compiled as the
// compiler writes them into a page's early file (compiler/index.ts `earlyRequests`), over the function table `f` and
// one root scope, the state `f[0]` makes.
import { earlyRequests } from '../src/compiler/index.js';
import * as early from '../src/early.js';
import type { EarlyPage } from '../src/early.js';
import type { EarlyIR } from '../src/ir.js';

export function earlyPageOf(ir: Pick<EarlyIR, 'res' | 'as'>, f: Array<(s: any) => unknown>): EarlyPage {
  const r = earlyRequests(ir.res ?? [], ir.as);
  // eslint-disable-next-line no-new-func -- the early file's compiled requests
  const req = new Function('f', ...r.uses, `"use strict"; return ${r.code};`)(f, ...r.uses.map((u) => (early as Record<string, unknown>)[u]));
  return () => ({ ir: {}, fns: f, scopes: ($) => [early.st($, f[0]!, 0)], render: () => {}, req });
}
