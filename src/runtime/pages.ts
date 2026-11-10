// The query parameters a paginated resource sends for a page: shared by the pager, the early file
// and the compiler (preloads, sinter-embed.json), so all of them write the same request.
import type { Paginate } from '../ir.js';

type Cfg = Omit<Paginate, 'cursor' | 'start'>;
type Dir = 'first' | 'prev' | 'next' | 'last';

/** the page size, and the direction where the mode has one */
export function base(cfg: Cfg, dir: Dir | null, size = cfg.size): Record<string, string> {
  const p: Record<string, string> = { [cfg.sizeParam]: String(size) };
  if (dir) p[cfg.directionParam] = cfg.directionValues?.[dir] ?? dir;
  return p;
}

/**
 * Page `n` (1-based) by number: offset mode sends `page-param`, or with `offset-param` the number
 * of items to skip; keyset (with `offset-param`) sends the skip with the `first` direction.
 */
export function pageParams(cfg: Cfg, n: number): Record<string, string> {
  if (cfg.mode === 'offset') return cfg.offsetParam ? { [cfg.offsetParam]: String((n - 1) * cfg.size), ...base(cfg, null) } : { [cfg.pageParam]: String(n), ...base(cfg, null) };
  return { [cfg.offsetParam!]: String((n - 1) * cfg.size), ...base(cfg, 'first') };
}

/**
 * The query parameters of the first page, as the pager sends them on the first load (and after a
 * `src` change), when there is no `start-page`.
 */
export function firstParams(cfg: Cfg): Record<string, string> {
  return cfg.mode === 'offset' ? pageParams(cfg, 1) : base(cfg, 'first');
}

/** the first load's parameters when it starts at page `n` (`start-page`) */
export function startParams(cfg: Cfg, n: number): Record<string, string> {
  return n > 1 ? pageParams(cfg, n) : firstParams(cfg);
}

/** what `start-page` evaluates to, as a page: a whole number from 1 (`"3"`, `3`), anything else page 1 */
export function toPage(v: unknown): number {
  const n = typeof v == 'number' ? Math.floor(v) : Number.parseInt(String(v ?? ''), 10);
  return Number.isFinite(n) && n >= 1 ? n : 1;
}
