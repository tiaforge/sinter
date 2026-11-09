// Pagination: keyset, offset and append modes, driven by page() calls.
import type { Paginate } from './ir.js';
import type { App, Feature, Pager, ResourceLoader } from './runtime/app.js';
import { SinterError } from './runtime/config.js';

type Dir = 'first' | 'prev' | 'next' | 'last';

interface Move {
  dir: Dir | 'page' | 'all';
  page: number;
  params: Record<string, string>;
  /** positions before the move, for from/to */
  from: number | null;
  to: number | null;
}

function base(cfg: Paginate, dir: Dir | null, size = cfg.size): Record<string, string> {
  const p: Record<string, string> = { [cfg.sizeParam]: String(size) };
  if (dir) p[cfg.directionParam] = cfg.directionValues?.[dir] ?? dir;
  return p;
}

/**
 * The query parameters of the first page, as the pager sends them on the first load (and after a
 * `src` change): the compiler builds the early file's request (and the preload) for a paginated
 * resource from these, so the runtime takes that response for its first load.
 */
export function firstParams(cfg: Paginate): Record<string, string> {
  return cfg.mode === 'offset' ? { [cfg.pageParam]: '1', ...base(cfg, null) } : base(cfg, 'first');
}

class PagerImpl implements Pager {
  private move: Move;
  private readonly cfg: Paginate;

  constructor(private readonly loader: ResourceLoader) {
    this.cfg = loader.def.paginate!;
    this.move = this.first();
    const m = loader.res.meta;
    if (this.cfg.mode === 'offset' || this.cfg.offsetParam) m.page = 1;
    Object.assign(m, { pages: null, from: null, to: null, hasPrev: false, hasNext: false });
  }

  private first(): Move {
    return { dir: this.cfg.mode === 'offset' ? 'page' : 'first', page: 1, params: firstParams(this.cfg), from: null, to: null };
  }

  reset(): void {
    this.move = this.first();
  }

  current(): unknown {
    if (this.cfg.mode === 'append' && this.move.dir !== 'first') {
      // refetch reloads everything loaded so far in one request
      const n = Math.max(this.cfg.size, this.loader.res.all().length);
      return { dir: 'all', page: 1, params: base(this.cfg, 'first', n), from: null, to: null } satisfies Move;
    }
    return this.move;
  }

  params(move: unknown): Record<string, string> {
    return (move as Move).params;
  }

  appends(move: unknown): boolean {
    return this.cfg.mode === 'append' && (move as Move).dir === 'next';
  }

  go(target: string | number): void {
    // a computed target: a direction, or a page number where the resource can jump; else the error path, no request
    const why = typeof target == 'number'
      ? this.cfg.mode != 'offset' && !this.cfg.offsetParam && 'keyset pagination cannot jump to a page number; add offset-param'
      : !['first', 'prev', 'next', 'last'].includes(target) && 'not a direction';
    if (why) {
      const l = this.loader, e = new SinterError(null, target, `page('${l.def.name}', ${JSON.stringify(target)}): ${why}`);
      l.app.warn(e.message);
      return l.failed(e);
    }
    const meta = this.loader.res.meta;
    // nowhere to go: prev and next do nothing past the ends (before the first load too), in every mode
    if (target == 'prev' ? !meta.hasPrev : target == 'next' && !meta.hasNext) return;
    const items = this.loader.res.all();
    const cursor = (item: unknown) => {
      if (this.cfg.cursor == null || item === undefined) return {};
      const scope = Object.create(this.loader.app.page);
      scope.$p = item;
      const c = this.loader.app.fns[this.cfg.cursor]!(scope) as Record<string, unknown>;
      const out: Record<string, string> = {};
      // like a URL template's query parameters: null and undefined fields are left out
      for (const [k, v] of Object.entries(c ?? {})) if (v != null) out[k] = String(v);
      return out;
    };
    let move: Move;
    const from = meta.from ?? null, to = meta.to ?? null;
    if (this.cfg.mode === 'offset') {
      const page = meta.page ?? 1;
      let n: number;
      if (typeof target === 'number') n = target;
      else if (target === 'first') n = 1;
      else if (target === 'prev') n = page - 1;
      else if (target === 'next') n = page + 1;
      else {
        if (meta.pages == null) { this.loader.app.warn(`page('${this.loader.def.name}', 'last') needs a known total`); return; }
        n = meta.pages;
      }
      n = Math.max(1, Math.floor(n));
      move = { dir: 'page', page: n, params: { [this.cfg.pageParam]: String(n), ...base(this.cfg, null) }, from, to };
    } else {
      if (typeof target === 'number') {
        // the server skips (n - 1) pages; prev/next continue by cursor from there
        let n = Math.max(1, Math.floor(target));
        if (meta.pages != null) n = Math.min(n, meta.pages);
        move = { dir: 'page', page: n, params: { [this.cfg.offsetParam!]: String((n - 1) * this.cfg.size), ...base(this.cfg, 'first') }, from, to };
        void this.loader.load(move);
        return;
      }
      if (this.cfg.mode === 'append' && target !== 'next') return;
      const dir = target as Dir;
      const c = dir === 'next' ? cursor(items[items.length - 1]) : dir === 'prev' ? cursor(items[0]) : {};
      move = { dir, page: 1, params: { ...c, ...base(this.cfg, dir) }, from, to };
    }
    void this.loader.load(move);
  }

  received(items: unknown[], total: number | null, mv: unknown): void {
    const move = mv as Move;
    if (move.dir !== 'all') this.move = move;
    const meta = this.loader.res.meta;
    const n = items.length;
    const size = this.cfg.size;
    const full = n >= size;
    const pages = total != null ? Math.max(1, Math.ceil(total / size)) : null;
    let from: number | null = null, to: number | null = null, hasPrev = false, hasNext = false;
    switch (move.dir) {
      case 'page':
        from = n ? (move.page - 1) * size + 1 : 0;
        to = n ? from + n - 1 : 0;
        hasPrev = move.page > 1;
        hasNext = pages != null ? move.page < pages : full;
        meta.page = move.page;
        break;
      case 'first':
        from = n ? 1 : 0; to = n; hasPrev = false; hasNext = full;
        break;
      case 'all':
        from = n ? 1 : 0; to = n; hasPrev = false; hasNext = meta.hasNext ?? full;
        break;
      case 'next':
        if (this.cfg.mode === 'append') {
          const all = this.loader.res.all().length;
          from = all ? 1 : 0; to = all; hasPrev = false; hasNext = full;
          break;
        }
        // past the end: nothing to count (`to` would come before `from`)
        from = n && move.to != null ? move.to + 1 : n ? null : 0;
        to = n ? (from != null ? from + n - 1 : null) : 0;
        hasPrev = true; hasNext = full;
        break;
      case 'prev':
        hasNext = true;
        if (!full) { from = n ? 1 : 0; to = n; hasPrev = false; break; }
        to = move.from != null ? move.from - 1 : null;
        from = to != null ? to - n + 1 : null;
        hasPrev = from == null || from > 1;
        break;
      case 'last':
        hasNext = false;
        if (total != null) { to = total; from = total - n + 1; hasPrev = from > 1; }
        else hasPrev = full;
        break;
    }
    // keyset with jumps: the page that holds the last item shown (after `last`, the last page)
    if (this.cfg.offsetParam && move.dir !== 'page') meta.page = to != null ? Math.max(1, Math.ceil(to / size)) : null;
    Object.assign(meta, { pages, from, to, hasPrev, hasNext });
    this.loader.res.onDirty('meta');
  }
}

const paginate: Feature = {
  name: 'paginate',
  install(app: App) {
    const pagers = new Map<string, PagerImpl>();
    app.ext.paginate = {
      pager(loader) {
        const p = new PagerImpl(loader);
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
