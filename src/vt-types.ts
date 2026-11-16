// The types of a view transition for a navigation, for the stylesheet (docs/proposals/swap-navigation.md §8):
// on a swap (swap-run.ts) and on a page load (transition.ts). Apart from links.ts so that the swap's stub,
// which carries the chain, does not carry this.
import type { App } from './runtime/app.js';

/** an entry and the navigation's type, as `NavigationActivation` and a `pageswap` event's `activation` give them */
interface Activation { navigationType: string; from?: { index: number } | null; entry?: { index: number } | null }
interface Typed { viewTransition?: { types?: Set<string> } | null; activation?: Activation | null }

/**
 * The types of a view transition for a navigation (docs/proposals/swap-navigation.md §8), the same for a
 * swap and a page load, for `:active-view-transition-type()`: `sn-push`, `sn-replace` or `sn-traverse`,
 * and on a traversal `sn-back` or `sn-forward`, from the entries' indexes.
 */
export const vtTypes = (kind: string, from?: number, to?: number) =>
  ['sn-' + kind, ...(kind == 'traverse' && from != null && to != null && from != to ? [to < from ? 'sn-back' : 'sn-forward'] : [])];

/** page loads: the same types on the browser's transition (`pageswap` on the page left, `pagereveal` on the next), once per app */
export function loadTypes(app: App): void {
  if (app.ext.types) return;
  app.ext.types = true;
  const add = (e: Event, a?: Activation | null) => {
    const t = (e as Typed).viewTransition?.types;
    if (t && a) for (const x of vtTypes(a.navigationType, a.from?.index, a.entry?.index)) t.add(x);
  };
  const N = (globalThis as { navigation?: { activation?: Activation | null } }).navigation;
  app.addCleanup(app.env.listen('pageswap', (e) => {
    // (the page left is the current entry; `activation` is a platform object: its fields, not a copy)
    const a = (e as Typed).activation;
    add(e, a && { navigationType: a.navigationType, entry: a.entry, from: (N as { currentEntry?: { index: number } } | undefined)?.currentEntry });
  }));
  app.addCleanup(app.env.listen('pagereveal', (e) => add(e, N?.activation)));
}
