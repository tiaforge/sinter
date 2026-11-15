import type { Item } from './sinter.types.js';

/** `Ada Lovelace` → `AL` */
export function initials(name: string): string {
  return name.split(/\s+/).filter(Boolean).map((w) => w[0]!.toUpperCase()).join('');
}

/** the items of a tree, at every depth */
export function count(items: Item[]): number {
  return items.reduce((n, i) => n + 1 + count(i.children ?? []), 0);
}
