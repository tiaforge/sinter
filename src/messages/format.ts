// @tiaforge-ui/sinter/messages/format: the formatter of the messages' content namespace (docs/proposals/messages.md §2).
// A pure function of a message's compact form (what `inlang()` in ./content.ts parses the inlang files into), its
// arguments and the page's language, so the build folds a call over constants and the browser runs one over data.

/** a pattern: text, and placeholders by input name, formatted with `number` or `datetime` and their options */
export type Part = string | { v: string; f?: 'number' | 'datetime'; o?: Record<string, string> };

/** a selector: an input's value, through `plural` (`Intl.PluralRules`, `ordinal` for `type=ordinal`) or as it is */
export interface Selector { n: string; f: 'plural' | 'ordinal' | null }

/** a message: a pattern (`p`), or selectors and their variants, each its keys (a value or `*`) and its pattern */
export type Message = { p: Part[] } | { s: Selector[]; v: Array<[string[], Part[]]> };

const fill = (p: Part[], args: Record<string, unknown> | undefined, locale?: string | null) => p.map((x) => {
  if (typeof x === 'string') return x;
  if (!args || !(x.v in args)) return `{${x.v}}`;
  const v = args[x.v];
  // a formatted placeholder: `Intl` in the page's language, with the placeholder's options
  if (x.f === 'number') return new Intl.NumberFormat(locale ?? undefined, x.o as Intl.NumberFormatOptions).format(Number(v));
  if (x.f === 'datetime') return new Intl.DateTimeFormat(locale ?? undefined, x.o as Intl.DateTimeFormatOptions).format(new Date(v as string | number));
  return String(v);
}).join('');

/**
 * A message as the source of a function of its arguments, for the build to compile in place of a `format` call, or
 * null when it needs `format`: a plain pattern (no selectors, no formatted placeholders) is its text and parameters,
 * a parameter missing at run time as written.
 */
export function inline(entry: unknown): string | null {
  const m = ((entry as { m?: Message } | null)?.m ?? entry) as Message;
  if (!m || !('p' in m) || m.p.some((x) => typeof x !== 'string' && x.f)) return null;
  if (m.p.every((x) => typeof x === 'string')) return `() => ${JSON.stringify(m.p.join(''))}`;
  return `(p = {}) => ${m.p.map((x) => (typeof x === 'string' ? JSON.stringify(x) : `(${JSON.stringify(x.v)} in p ? p[${JSON.stringify(x.v)}] : ${JSON.stringify(`{${x.v}}`)})`)).join(' + ')}`;
}

/**
 * The message in `locale` with `args`. A variant is chosen as MessageFormat 2 chooses: each selector gives a value
 * (an input's string; for a plural, its exact number and its category in the language); a variant matches when each of
 * its keys is that value or `*`; of the matches, the best at the first selector where they differ wins (an exact number
 * over a category over `*`).
 */
export function format(entry: unknown, args?: Record<string, unknown>, locale?: string | null): string {
  const m = ((entry as { m?: Message } | null)?.m ?? entry) as Message;
  if ('p' in m) return fill(m.p, args, locale);
  const values = m.s.map((s) => {
    const x = args?.[s.n];
    if (!s.f) return { exact: String(x), category: null as string | null };
    const n = Number(x);
    const rules = new Intl.PluralRules(locale ?? undefined, { type: s.f === 'ordinal' ? 'ordinal' : 'cardinal' });
    return { exact: String(n), category: Number.isFinite(n) ? rules.select(n) : null };
  });
  let best: { score: number[]; p: Part[] } | null = null;
  for (const [keys, p] of m.v) {
    const score: number[] = [];
    let ok = true;
    keys.forEach((k, i) => {
      const v = values[i]!;
      if (k === '*') score.push(0);
      else if (k === v.exact) score.push(2);
      else if (k === v.category) score.push(1);
      else ok = false;
    });
    if (!ok) continue;
    if (!best || score.some((x, i) => x !== best!.score[i] && x > best!.score[i]! && score.slice(0, i).every((y, j) => y === best!.score[j]))) best = { score, p };
  }
  return best ? fill(best.p, args, locale) : '';
}
