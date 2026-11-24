// The build's cross-check of build-time helper calls (docs/spec.md, Helpers at build time). A build
// shares one instance of the helpers module across its pages, while each page in the browser has its
// own; a helper whose result depends on the calls before it (a table of ids, a counter kept in an
// object) gives each page what the build's page order made of it. The compiler reports each distinct
// call that folded, once per page (`foldLog`); at the end of the build they run again in a fresh
// instance of the module, the pages in reverse order, and any result that differs fails the build
// (SN534). Each call also runs twice within its page, which finds what differs from one call to the
// next; only this sees what another page's calls left behind.

import { createHash } from 'node:crypto';
import { cloneArg, resultKey, type FoldArg } from './compiler/compile.js';

/** a page's call as the build keeps it: its arguments (another call's result by id) and a hash of its result */
export interface FoldCall { key: string; args: FoldArg[]; hash: string; id: number }
export interface CrossMismatch { key: string; args: string[]; page: string; got: string }

/** what the build keeps of a result: a hash of its tagged JSON, not the JSON (a parse tree per page adds up) */
export const hashOf = (result: string): string => createHash('sha1').update(result).digest('base64');

/** a helper by the name compiled code calls (`fmt`, `ns$member`) */
const valueOf = (m: Record<string, unknown>, key: string): unknown => {
  const i = key.indexOf('$');
  return i < 0 ? m[key] : (m[key.slice(0, i)] as Record<string, unknown> | undefined)?.[key.slice(i + 1)];
};

const short = (s: string) => (s.length > 60 ? s.slice(0, 57) + '…' : s);
const shown = (v: unknown) => short(v === undefined ? 'undefined' : JSON.stringify(v) ?? String(v));

/**
 * Runs each page's calls again in `module`, the pages in reverse order, each page's in its order; an argument
 * that was another call's result is that call's result here (the chain runs again). The calls whose results differ.
 */
export function crossCheck(module: Record<string, unknown>, pages: ReadonlyArray<readonly [string, readonly FoldCall[]]>): CrossMismatch[] {
  const out: CrossMismatch[] = [];
  for (const [page, calls] of [...pages].reverse()) {
    const results = new Map<number, unknown>();
    for (const c of calls) {
      const f = valueOf(module, c.key);
      const args = c.args.map((x) => ('r' in x ? results.get(x.r) : cloneArg(x.v)));
      let got: string;
      try {
        if (typeof f !== 'function') throw new Error('no such helper');
        const v = (f as (...a: unknown[]) => unknown)(...args);
        results.set(c.id, v);
        got = resultKey(v);
        if (hashOf(got) !== c.hash) got = shown(v);
        else continue;
      } catch (e) { got = `threw (${(e as Error)?.message ?? String(e)})`; }
      out.push({ key: c.key, args: c.args.map((x) => ('r' in x ? `<the result of an earlier call>` : shown(x.v))), page, got });
    }
  }
  return out;
}

/** SN534's message for a build whose cross-check found results that differ. */
export function crossMessage(m: readonly CrossMismatch[]): string {
  const helpers = [...new Set(m.map((x) => x.key.replace('$', '.') + '()'))];
  const lines = m.slice(0, 6).map((x) => `  ${x.key.replace('$', '.')}(${x.args.join(', ')}) on ${x.page}: another result than in the build (${x.got}) in a fresh copy of the helpers module`);
  if (m.length > 6) lines.push(`  … and ${m.length - 6} more`);
  return `${helpers.join(', ')} gave other results when the build's calls ran again in a fresh copy of the helpers module, the pages in reverse order: ${helpers.length > 1 ? 'their results depend' : 'its result depends'} on the calls before (state kept between calls, such as a table of ids or a counter), so each page would show what the build's page order made of it\n${lines.join('\n')}\n  hint: keep no state between calls in a helper that runs at build time, or call it where it runs in the browser (a handler)`;
}
