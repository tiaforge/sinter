// The parts of the core a page module uses, read from its IR (docs/proposals/site-core.md). A build's
// union of them is what the site's core keeps (src/runtime/flags.ts); every other part is compiled away.
// Conservative: a part is used when anything in the IR, or the page's expression functions, could reach its code.
import type { Binding, IR, NodeDef } from './ir.js';

/** every part, in the order of src/runtime/flags.ts */
export const CORE_PARTS = ['LIST', 'BRANCH', 'ACTION', 'DIALOG', 'EVENTS', 'MODEL', 'PROP', 'STYLE', 'RESOURCE', 'TWIN', 'SIGNEDOUT', 'POPOVER',
  'TEXTRUN', 'SHOW', 'CLASSX', 'ATTR', 'FN_DIALOG', 'FN_ITEMS', 'FN_REFRESH', 'FN_PAGE', 'FN_EMIT', 'FN_RUN'] as const;
export type CorePart = (typeof CORE_PARTS)[number];

const BY_KIND: Partial<Record<Binding['k'], CorePart>> = { for: 'LIST', if: 'BRANCH', ch: 'BRANCH', model: 'MODEL', prop: 'PROP', style: 'STYLE' };
/**
 * The store functions (`$f`, compiler/expr.ts `STORE_FNS`) by the part that keeps them. The compiled handlers are their
 * only callers, and name each one (`$.$f.merge(…)`). `navigate` and `signOut` are always there (the package's `navigate()`
 * and `signOut()` call them), `closePopover` is `POPOVER` (`IR.po`).
 */
const BY_FN: Record<string, CorePart> = {
  openDialog: 'FN_DIALOG', closeDialog: 'FN_DIALOG', upsert: 'FN_ITEMS', merge: 'FN_ITEMS', remove: 'FN_ITEMS',
  refresh: 'FN_REFRESH', page: 'FN_PAGE', emit: 'FN_EMIT', run: 'FN_RUN',
};

/** `fns`: the page's expression functions, as the compiler wrote them (the store functions they name) */
export function coreParts(ir: Pick<IR, 'roots' | 'templates' | 'actions' | 'resources' | 'ev' | 'tw' | 'po'>, fns: readonly string[] = []): CorePart[] {
  const used = new Set<CorePart>();
  const node = (nd: NodeDef) => {
    if (nd.dl) used.add('DIALOG');
    for (const b of nd.b) {
      const k = BY_KIND[b.k];
      if (k) used.add(k);
      // the writers: a text binding with a name is a text run's, a class binding without one takes its class from the value
      if (b.k == 'text' && b.n) used.add('TEXTRUN');
      if (b.k == 'show') used.add('SHOW');
      if (b.k == 'class' && !b.n) used.add('CLASSX');
      if (b.k == 'attr') used.add('ATTR');
      if (b.k == 'on') used.add('EVENTS');
      if (b.k == 'on' && b.x != null) used.add('ACTION');
    }
  };
  ir.roots.forEach(node);
  for (const t of ir.templates) t?.nodes.forEach(node);
  if (ir.actions.length) used.add('ACTION');
  if (ir.resources.length) used.add('RESOURCE');
  // embedded data that is the signed-out answer (`ResourceDef.so`): not used while a token is stored
  if (ir.resources.some((r) => r.so)) used.add('SIGNEDOUT');
  // an action's element with an id (or bound attributes): its twin in an if's new branch may take a running action over
  if (ir.tw && used.has('ACTION') && used.has('BRANCH')) used.add('TWIN');
  if (ir.ev?.length) used.add('EVENTS');
  if (ir.po) used.add('POPOVER');
  for (const c of fns) for (const m of c.matchAll(/\$f\.(\w+)/g)) { const p = BY_FN[m[1]!]; if (p) used.add(p); }
  // a model listens for `input`/`change`, a dialog's bindings for `toggle`: dispatch is where they do
  if (used.has('MODEL') || used.has('DIALOG')) used.add('EVENTS');
  return CORE_PARTS.filter((p) => used.has(p));
}

/**
 * the flags module for a build whose pages use `parts` (src/runtime/flags.ts, with the other parts off); `shared`: an early
 * file may share a helper module with its page bundle (`SHARED`); `swap`: the build has swaps on (`SWAP`); `token`: an
 * API has a token (`TOKEN`)
 */
export function flagsModule(parts: Iterable<string>, shared = false, swap = false, token = false): string {
  const on = new Set(parts);
  return CORE_PARTS.map((p) => `export const ${p} = ${on.has(p)};`).join('\n') + `\nexport const SHARED = ${shared};\nexport const SWAP = ${swap};\nexport const TOKEN = ${token};\nexport const use = undefined;\n`;
}
