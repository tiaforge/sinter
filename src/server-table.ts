// The server layer's path table (src/server.ts): apart from it so that test/server/cases.test.ts runs it on the
// shared cases (test/fixtures/server-cases.json, `match`) without it being the `./server` entry's API.
import { segments, segsMatch } from './runtime/url.js';

/**
 * Paths to rules, the first in their order: exact paths and literal patterns in maps (by the path's
 * non-empty segments), `:name` patterns split once, by segment count. A path no rule has is `Infinity`.
 */
export function pathTable(rules: Array<{ pattern: string; exact: boolean }>): (path: string) => number {
  const exact = new Map<string, number>(), literal = new Map<string, number>(), patterns: Array<[number, string[]]> = [];
  rules.forEach(({ pattern, exact: x }, i) => {
    if (x) { if (!exact.has(pattern)) exact.set(pattern, i); }
    else if (pattern.includes(':')) patterns.push([i, segments(pattern)]);
    else { const k = segments(pattern).join('/'); if (!literal.has(k)) literal.set(k, i); }
  });
  return (path: string): number => {
    const segs = segments(path);
    let best = Math.min(exact.get(path) ?? Infinity, literal.get(segs.join('/')) ?? Infinity);
    for (const [i, want] of patterns) { if (i >= best) break; if (segsMatch(want, segs)) { best = i; break; } }
    return best;
  };
}
