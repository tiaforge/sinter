// Pagination: keyset, offset and append modes, driven by page() calls.
import type { Paginate } from './ir.js';
import type { App, Feature, Pager, ResourceLoader } from './runtime/app.js';

type Dir = 'first' | 'prev' | 'next' | 'last';

interface Move {
  dir: Dir | 'page' | 'all';
  page: number;
  params: Record<string, string>;
  /** positions before the move, for from/to */
  from: number | null;
  to: number | null;
}

class PagerImpl implements Pager {
  private move: Move;
  private readonly cfg: Paginate;

  constructor(private readonly loader: ResourceLoader) {
    this.cfg = loader.def.paginate!;
    this.move = this.first();
    const m = loader.res.meta;
    if (this.cfg.mode === 'offset') m.page = 1;
    Object.assign(m, { pages: null, from: null, to: null, hasPrev: false, hasNext: false });
  }

  private base(dir: Dir | null, size = this.cfg.size): Record<string, string> {
    const p: Record<string, string> = { [this.cfg.sizeParam]: String(size) };
    if (dir) p[this.cfg.directionParam] = dir;
    return p;
  }

  private first(): Move {
    if (this.cfg.mode === 'offset') return { dir: 'page', page: 1, params: { [this.cfg.pageParam]: '1', ...this.base(null) }, from: null, to: null };
    return { dir: 'first', page: 1, params: this.base('first'), from: null, to: null };
  }

  reset(): void {
    this.move = this.first();
  }

  current(): unknown {
    if (this.cfg.mode === 'append' && this.move.dir !== 'first') {
      // refetch reloads everything loaded so far in one request
      const n = Math.max(this.cfg.size, this.loader.res.all().length);
      return { dir: 'all', page: 1, params: this.base('first', n), from: null, to: null } satisfies Move;
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
    const meta = this.loader.res.meta;
    const items = this.loader.res.all();
    const cursor = (item: unknown) => {
      if (this.cfg.cursor == null || item === undefined) return {};
      const scope = Object.create(this.loader.app.page);
      scope.$p = item;
      const c = this.loader.app.fns[this.cfg.cursor]!(scope) as Record<string, unknown>;
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(c ?? {})) out[k] = v == null ? '' : String(v);
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
      else if (target === 'last') {
        if (meta.pages == null) { this.loader.app.warn(`page('${this.loader.def.name}', 'last') needs a known total`); return; }
        n = meta.pages;
      } else return;
      n = Math.max(1, Math.floor(n));
      move = { dir: 'page', page: n, params: { [this.cfg.pageParam]: String(n), ...this.base(null) }, from, to };
    } else {
      if (typeof target === 'number') {
        this.loader.app.warn('keyset pagination cannot jump to a page number; use paginate="offset"');
        return;
      }
      if (this.cfg.mode === 'append' && target !== 'next') return;
      const dir = target as Dir;
      const c = dir === 'next' ? cursor(items[items.length - 1]) : dir === 'prev' ? cursor(items[0]) : {};
      move = { dir, page: 1, params: { ...c, ...this.base(dir) }, from, to };
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
        from = move.to != null ? move.to + 1 : null;
        to = from != null ? from + n - 1 : null;
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
