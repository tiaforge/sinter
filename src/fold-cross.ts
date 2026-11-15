// The build's cross-check of build-time helper calls (docs/spec.md, Helpers at build time). A build
// shares one instance of the helpers module across its pages, while each page in the browser has its
// own; a helper whose result depends on the calls before it (a table of ids, a counter kept in an
// object) gives each page what the build's page order made of it. The compiler reports each distinct
// call that folded, once per page (`foldLog`); at the end of the build they run again in a fresh
// instance of the module, the pages in reverse order, and any result that differs fails the build
// (SN534). This replaces running each call twice within its page, which cannot see another page's calls.

export interface FoldCall { key: string; args: unknown[]; json: string }
export interface CrossMismatch { key: string; args: unknown[]; page: string; json: string; got: string }

/** a helper by the name compiled code calls (`fmt`, `ns$member`) */
const valueOf = (m: Record<string, unknown>, key: string): unknown => {
  const i = key.indexOf('$');
  return i < 0 ? m[key] : (m[key.slice(0, i)] as Record<string, unknown> | undefined)?.[key.slice(i + 1)];
};

/** Runs each page's calls again in `module`, the pages in reverse order; the calls whose results differ. */
export function crossCheck(module: Record<string, unknown>, pages: ReadonlyArray<readonly [string, readonly FoldCall[]]>): CrossMismatch[] {
  const out: CrossMismatch[] = [];
  for (const [page, calls] of [...pages].reverse()) {
    for (const c of calls) {
      const f = valueOf(module, c.key);
      let got: string;
      try { got = typeof f === 'function' ? JSON.stringify((f as (...a: unknown[]) => unknown)(...structuredClone(c.args))) ?? 'undefined' : 'no such helper'; } catch (e) { got = `threw (${(e as Error)?.message ?? String(e)})`; }
      if (got !== c.json) out.push({ key: c.key, args: c.args, page, json: c.json, got });
    }
  }
  return out;
}

const short = (s: string) => (s.length > 60 ? s.slice(0, 57) + '…' : s);

/** SN534's message for a build whose cross-check found results that differ. */
export function crossMessage(m: readonly CrossMismatch[]): string {
  const helpers = [...new Set(m.map((x) => x.key.replace('$', '.') + '()'))];
  const lines = m.slice(0, 6).map((x) => `  ${x.key.replace('$', '.')}(${x.args.map((a) => short(JSON.stringify(a) ?? 'undefined')).join(', ')}) on ${x.page}: ${short(x.json)} in the build, ${short(x.got)} in a fresh copy of the helpers module`);
  if (m.length > 6) lines.push(`  … and ${m.length - 6} more`);
  return `${helpers.join(', ')} gave other results when the build's calls ran again in a fresh copy of the helpers module, the pages in reverse order: ${helpers.length > 1 ? 'their results depend' : 'its result depends'} on the calls before (state kept between calls, such as a table of ids or a counter), so each page would show what the build's page order made of it\n${lines.join('\n')}\n  hint: keep no state between calls in a helper that runs at build time, or call it where it runs in the browser (a handler)`;
}
