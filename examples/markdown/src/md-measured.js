// md.js counted, for measure.mjs: how often `parse` ran, for how long and over how many characters. Only a
// build with MEASURE=1 uses it (vite.config.js points the helpers' import of md.js here), so the parser
// the pages use otherwise stays pure. One entry per copy of this module: the early file and the page
// module each bundle their own (`early`: this copy loaded while the document was being parsed).
import { parse as pure, kind } from './md.js?pure';

const stats = { parses: 0, ms: 0, bytes: 0, early: typeof document !== 'undefined' && document.readyState === 'loading' };
if (typeof window !== 'undefined') (window.__mdStats ??= []).push(stats);

export function parse(source, options) {
  const t0 = performance.now();
  stats.parses++;
  stats.bytes += source?.length ?? 0;
  try { return pure(source, options); } finally { stats.ms += performance.now() - t0; }
}

export { kind };
