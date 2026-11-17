// The parts of the core a page module uses, read from its IR (docs/proposals/site-core.md). A build's
// union of them is what the site's core keeps (src/runtime/flags.ts); every other part is compiled away.
// Conservative: a part is used when anything in the IR could reach its code.
import type { Binding, IR, NodeDef } from './ir.js';

/** every part, in the order of src/runtime/flags.ts */
export const CORE_PARTS = ['LIST', 'BRANCH', 'ACTION', 'DIALOG', 'EVENTS', 'MODEL', 'PROP', 'STYLE', 'RESOURCE'] as const;
export type CorePart = (typeof CORE_PARTS)[number];

const BY_KIND: Partial<Record<Binding['k'], CorePart>> = { for: 'LIST', if: 'BRANCH', ch: 'BRANCH', model: 'MODEL', prop: 'PROP', style: 'STYLE' };

export function coreParts(ir: Pick<IR, 'roots' | 'templates' | 'actions' | 'resources' | 'ev'>): CorePart[] {
  const used = new Set<CorePart>();
  const node = (nd: NodeDef) => {
    if (nd.dl) used.add('DIALOG');
    for (const b of nd.b) {
      const k = BY_KIND[b.k];
      if (k) used.add(k);
      if (b.k == 'on') used.add('EVENTS');
      if (b.k == 'on' && b.x != null) used.add('ACTION');
    }
  };
  ir.roots.forEach(node);
  for (const t of ir.templates) t?.nodes.forEach(node);
  if (ir.actions.length) used.add('ACTION');
  if (ir.resources.length) used.add('RESOURCE');
  if (ir.ev?.length) used.add('EVENTS');
  // a model listens for `input`/`change`, a dialog's bindings for `toggle`: dispatch is where they do
  if (used.has('MODEL') || used.has('DIALOG')) used.add('EVENTS');
  return CORE_PARTS.filter((p) => used.has(p));
}

/** the flags module for a build whose pages use `parts` (src/runtime/flags.ts, with the other parts off) */
export function flagsModule(parts: Iterable<string>): string {
  const on = new Set(parts);
  return CORE_PARTS.map((p) => `export const ${p} = ${on.has(p)};`).join('\n') + '\nexport const use = undefined;\n';
}
