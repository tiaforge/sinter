// The page's array parameters as lists. Apart from url.ts (which the core imports) so that a page
// without them carries none of it: a module the core imports goes whole into an app's shared chunk.
import { BAD_KEY } from './keys.js';

/** The array parameters (`IR.urlArrays`) of `href` as lists in `out`: every value of a repeated name, `[]` when absent. */
export function lists(href: string, names: string[], out: Record<string, unknown>): Record<string, unknown> {
  const q = new URL(href).searchParams;
  for (const n of names) if (!BAD_KEY.test(n)) out[n] = q.getAll(n);
  return out;
}
