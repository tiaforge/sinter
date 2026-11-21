// `namesIn` (compile.ts) answers which helpers and namespace members the compiled code calls in one pass over the
// code, in place of one pattern per name; it must answer as that pattern does, for every name.
import { expect, test } from 'vitest';
import { namesIn } from '../../src/compiler/compile.js';

const pattern = (code: string, name: string) => new RegExp(`(?<![\\w$.])${name.replace(/\$/g, '\\$')}(?![\\w$])`).test(code);

test('namesIn answers as `(?<![\\w$.])name(?![\\w$])` does', () => {
  const codes = [
    '($) => md.parse($.$r.a)',
    '($) => md$parse($.x) + fmt(1)',
    '($) => $.$h.fmt(x)',
    'a.fmt(1); fmt2(); _fmt(); fmt$(); $fmt()',
    'fmt',
    ' fmt\n(x)',
    '"fmt" + `${fmt(1)}` + ns$m + ns$m$x + ns.$m',
    'x?.fmt(); [fmt]; {fmt}; !fmt; (fmt)',
    'café(1) + fmté',
    '',
  ];
  const names = ['fmt', 'md', 'md$parse', 'parse', 'ns$m', 'ns', 'm', '$m', '$', 'x', 'fmt2', '_fmt', 'fmt$', '$fmt', 'café', 'caf', 'a', 'r', '$r', 'h', '$h'];
  for (const code of codes) {
    // every name looked for in the one pass; none (each tested as its own pattern); half of them
    for (const asked of [names, [], names.filter((_, i) => i % 2)]) {
      const has = namesIn(code, asked);
      for (const name of names) expect(has(name), `${JSON.stringify(name)} in ${JSON.stringify(code)}`).toBe(pattern(code, name));
    }
  }
});
