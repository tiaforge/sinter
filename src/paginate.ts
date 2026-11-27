// Pagination: keyset, offset and append modes, driven by page() calls. With `model` (paginate) (offset
// lists), the URL is the single source: page() writes the parameter and the pager follows it.
import type { Paginate } from './ir.js';
import type { App, Feature, Pager, ResourceLoader } from './runtime/app.js';
import { SinterError } from './runtime/config.js';
import { base, firstParams, pageParams, toPage } from './runtime/pages.js';
// off in a build whose every pager keeps its page in the URL (`model`): the moves in memory go (src/runtime/flags.ts)
import { MOVES } from './runtime/flags.js';

type Dir = 'first' | 'prev' | 'next' | 'last';

interface Move {
  dir: Dir | 'page' | 'all';
  page: number;
  params: Record<string, string>;
  /** positions before the move, for from/to */
  from: number | null;
  to: number | null;
}

export { firstParams } from './runtime/pages.js';

/** One resource's pager: `page()` calls `go`. */
function pager(loader: ResourceLoader): Pager & { go(target: string | number): void } {
  const cfg = loader.def.paginate!, app = loader.app, res = loader.res;
  // a pager that moves in memory, in a build whose pagers all follow the URL (the MOVES part): not one of its pages'
  if (!MOVES && !cfg.model) throw Error(`sinter: ${loader.def.name}: no MOVES in this build's core`);
  let move: Move = { dir: cfg.mode === 'numbered' ? 'page' : 'first', page: 1, params: firstParams(cfg), from: null, to: null };
  /** `model` (paginate): the page of the last request, and whether the last load failed */
  let requested = 1, failed = false;
  const m = res.meta;
  if (cfg.mode === 'numbered' || cfg.skipParam) m.page = 1;
  Object.assign(m, { pages: null, from: null, to: null, hasPrev: false, hasNext: false });
  if (cfg.model) loader.settled.push((ok) => { failed = !ok; });

  /** `model` (paginate): the page the parameter names (`?page=abc` is page 1) */
  const param = () => toPage(app.page.$url[cfg.model!]);

  const at = (n: number): Move => ({ dir: 'page', page: n, params: pageParams(cfg, n), from: null, to: null });

  /** `model` (paginate): the parameter set to page `n` (page 1 deletes it); `kind` the history entry (location.ts) */
  const write = (n: number, kind: number) => app.ext.location!.set(cfg.model!, n > 1 ? '' + n : null, kind);

  /** The page a page number or direction names, counting from page `from`; `last` without a total warns: null. */
  const pageOf = (target: string | number, from: number, pages: number | null): number | null => {
    if (target == 'last' && pages == null) { app.warn(30, loader.def.name); return null; }
    return Math.max(1, Math.floor(typeof target == 'number' ? target : target == 'first' ? 1 : target == 'prev' ? from - 1 : target == 'next' ? from + 1 : pages!));
  };

  /**
   * `model` (paginate): page() loads nothing; it writes the page it moves to (a push) and the pager follows.
   * `prev`/`next` count from the page last requested (after a failure, the page shown); past the ends,
   * and `next` while a page loads with no total known, they do nothing.
   */
  const toUrl = (target: string | number) => {
    const meta = res.meta;
    // `when` is false: no list to move
    if (loader.url() == null) return;
    const from = failed ? meta.page ?? 1 : requested, pages: number | null = meta.pages ?? null;
    if (target == 'prev' ? from <= 1 : target == 'next' && (pages != null ? from >= pages : loader.inflight() || !meta.hasNext)) return;
    let n = pageOf(target, from, pages);
    if (n == null) return;
    if (pages != null) n = Math.min(n, pages);
    // the page asked for already: loaded again only after a failure (the URL does not change)
    if (n == requested && n == param()) { if (failed) void loader.load(at(n)); return; }
    write(n, 4);
  };

  return {
    reset(why = 2) {
      if (MOVES && !cfg.model) {
        move = cfg.mode === 'numbered' ? at(1) : { dir: 'first', page: 1, params: firstParams(cfg), from: null, to: null };
        return;
      }
      // the first URL after mount restores the URL's page, Back and Forward load it; any other change of
      // the resource's URL (a filter) starts at page 1, a replace (Back restores the page)
      const fresh = why == 2 && !app.ext.location!.back;
      if (fresh && param() > 1) write(1, 1);
      move = at(fresh ? 1 : param());
    },

    follow() {
      if (!cfg.model || loader.url() == null) return;
      const n = param();
      if (n != requested) void loader.load(at(n));
    },

    current() {
      // `model` (paginate): every request (a reload, a retry) is the page the URL names
      if (!MOVES || cfg.model) return at(param());
      if (cfg.mode === 'append' && move.dir !== 'first') {
        // reload reloads everything loaded so far in one request
        const n = Math.max(cfg.size, res.all().length);
        return { dir: 'all', page: 1, params: base(cfg, 'first', n), from: null, to: null } satisfies Move;
      }
      return move;
    },

    params(mv) {
      if (!MOVES || cfg.model) requested = (mv as Move).page;
      return (mv as Move).params;
    },

    appends: (mv) => MOVES && cfg.mode === 'append' && (mv as Move).dir === 'next',

    go(target) {
      // a computed target: a direction, or a page number where the resource can jump; else the error path, no request
      const why = typeof target == 'number'
        ? cfg.mode != 'numbered' && !cfg.skipParam && 'keyset pagination cannot jump to a page number; add `jump: true` to paginate'
        : !['first', 'prev', 'next', 'last'].includes(target) && 'not a direction';
      if (why) {
        const e = new SinterError(null, target, `page(${loader.def.name}, ${JSON.stringify(target)}): ${why}`);
        app.warn(e.message);
        return loader.failed(e);
      }
      const meta = res.meta;
      if (!MOVES || cfg.model) return toUrl(target);
      // nowhere to go: prev and next do nothing past the ends (before the first load too), in every mode
      if (target == 'prev' ? !meta.hasPrev : target == 'next' && !meta.hasNext) return;
      const items = res.all();
      const cursor = (item: unknown) => {
        if (cfg.cursor == null || item === undefined) return {};
        const scope = Object.create(app.page);
        scope.$p = item;
        const c = app.fns[cfg.cursor]!(scope) as Record<string, unknown>;
        const out: Record<string, string> = {};
        // like a URL template's query parameters: null and undefined fields are left out
        for (const [k, v] of Object.entries(c ?? {})) if (v != null) out[k] = String(v);
        return out;
      };
      let mv: Move;
      const from = meta.from ?? null, to = meta.to ?? null;
      if (cfg.mode === 'numbered') {
        const n = pageOf(target, meta.page ?? 1, meta.pages ?? null);
        if (n == null) return;
        mv = { dir: 'page', page: n, params: pageParams(cfg, n), from, to };
      } else {
        if (typeof target === 'number') {
          // the server skips (n - 1) pages; prev/next continue by cursor from there
          let n = pageOf(target, 1, null)!;
          if (meta.pages != null) n = Math.min(n, meta.pages);
          mv = { dir: 'page', page: n, params: pageParams(cfg, n), from, to };
          void loader.load(mv);
          return;
        }
        if (cfg.mode === 'append' && target !== 'next') return;
        const dir = target as Dir;
        const c = dir === 'next' ? cursor(items[items.length - 1]) : dir === 'prev' ? cursor(items[0]) : {};
        mv = { dir, page: 1, params: { ...c, ...base(cfg, dir) }, from, to };
      }
      void loader.load(mv);
    },

    received(items, total, mv, more) {
      const mo = mv as Move;
      if (mo.dir !== 'all') move = mo;
      const meta = res.meta;
      const n = items.length;
      const size = cfg.size;
      // more items in the direction asked for: what the server says (`more`), else a guess from a full page
      const full = more ?? n >= size;
      const pages = total != null ? Math.max(1, Math.ceil(total / size)) : null;
      let from: number | null = null, to: number | null = null, hasPrev = false, hasNext = false;
      // a page by number (a `model` pager's every move)
      if (!MOVES || mo.dir == 'page') {
        from = n ? (mo.page - 1) * size + 1 : 0;
        to = n ? from + n - 1 : 0;
        hasPrev = mo.page > 1;
        hasNext = more ?? (pages != null ? mo.page < pages : full);
        meta.page = mo.page;
      } else switch (mo.dir) {
        case 'first':
          from = n ? 1 : 0; to = n; hasPrev = false; hasNext = full;
          break;
        case 'all':
          from = n ? 1 : 0; to = n; hasPrev = false; hasNext = more ?? meta.hasNext ?? full;
          break;
        case 'next':
          if (cfg.mode === 'append') {
            const all = res.all().length;
            from = all ? 1 : 0; to = all; hasPrev = false; hasNext = full;
            break;
          }
          // past the end: nothing to count (`to` would come before `from`)
          from = n && mo.to != null ? mo.to + 1 : n ? null : 0;
          to = n ? (from != null ? from + n - 1 : null) : 0;
          hasPrev = true; hasNext = full;
          break;
        case 'prev':
          hasNext = true;
          if (!full) { from = n ? 1 : 0; to = n; hasPrev = false; break; }
          to = mo.from != null ? mo.from - 1 : null;
          from = to != null ? to - n + 1 : null;
          hasPrev = more ?? (from == null || from > 1);
          break;
        case 'last':
          hasNext = false;
          if (total != null) { to = total; from = total - n + 1; hasPrev = from > 1; }
          else hasPrev = full;
          break;
      }
      // keyset with jumps: the page that holds the last item shown (after `last`, the last page)
      if (MOVES && cfg.skipParam && mo.dir !== 'page') meta.page = to != null ? Math.max(1, Math.ceil(to / size)) : null;
      Object.assign(meta, { pages, from, to, hasPrev, hasNext });
      res.onDirty('meta');
    },
  };
}

const paginate: Feature = {
  name: 'paginate',
  install(app: App) {
    const pagers = new Map<string, ReturnType<typeof pager>>();
    app.ext.paginate = {
      pager(loader) {
        const p = pager(loader);
        pagers.set(loader.def.name, p);
        return p;
      },
      page(name, target) {
        const p = pagers.get(name);
        if (!p) throw new Error(`sinter: resource \`${name}\` is not paginated`);
        p.go(target);
      },
    };
  },
};

export default paginate;
