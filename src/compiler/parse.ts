// Expressions parsed once per source text. A build compiles many pages, and the same expressions recur in
// every page and at every node of a component tree (`$slot.node.url` in each link of a markdown article):
// acorn's parse was a quarter of a build's time (docs/proposals/collections.md#prototype). A parse depends only
// on its text and options, so its tree is kept and shared. Trees are frozen, at every depth: a shared tree
// changed by one caller would change it for the next, so a write throws instead of corrupting a later page.
import * as acorn from 'acorn';

type Options = Pick<acorn.Options, 'ecmaVersion' | 'sourceType' | 'allowAwaitOutsideFunction' | 'preserveParens'>;
type Kept = { ast: acorn.AnyNode } | { error: unknown };

/** the most trees kept; past it the cache starts over (source texts are short, and a site has a few thousand) */
const LIMIT = 50_000;
const kept = new Map<string, Kept>();

const keyOf = (kind: string, src: string, o: Options) =>
  `${kind}\0${o.ecmaVersion ?? ''}\0${o.sourceType ?? ''}\0${o.allowAwaitOutsideFunction ? 1 : 0}\0${o.preserveParens ? 1 : 0}\0${src}`;

function freeze<T>(v: T): T {
  if (v && typeof v === 'object' && !Object.isFrozen(v)) {
    Object.freeze(v);
    for (const x of Object.values(v)) freeze(x);
  }
  return v;
}

function cached<T extends acorn.AnyNode>(key: string, parse: () => T): T {
  let k = kept.get(key);
  if (!k) {
    try { k = { ast: freeze(parse()) }; } catch (error) { k = { error }; }
    if (kept.size >= LIMIT) kept.clear();
    kept.set(key, k);
  }
  if ('error' in k) throw k.error;
  return k.ast as T;
}

/** `acorn.parseExpressionAt(src, 0, options)`, parsed once per text and options; the tree is frozen */
export function parseExpression(src: string, options: Options = { ecmaVersion: 'latest' }): acorn.Expression {
  return cached(keyOf('e', src, options), () => acorn.parseExpressionAt(src, 0, options as acorn.Options));
}

/** `acorn.parse(src, options)`, parsed once per text and options; the tree is frozen */
export function parseProgram(src: string, options: Options = { ecmaVersion: 'latest' }): acorn.Program {
  return cached(keyOf('p', src, options), () => acorn.parse(src, options as acorn.Options));
}
