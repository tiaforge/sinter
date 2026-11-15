import type { Item } from './sinter.types.js';

/** the labels of a tree, depth first: needs only the tree, never the parser */
export function outline(items: Item[]): string[] {
  return items.flatMap((i) => [i.label, ...outline(i.children ?? [])]);
}
