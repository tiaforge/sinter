// Fan-out resources: `each="a in accounts"` loads one request per list item into one collection.
import type { App, Feature, ResourceLoader } from './runtime/app.js';

interface Source {
  c: AbortController | null;
  seq: number;
  /** keys of this source's last response */
  keys: Set<string>;
  answered: boolean;
}

const isAbort = (e: unknown) => e instanceof DOMException && e.name == 'AbortError';

/**
 * Sources are keyed by their resolved URL. An item belongs to a source when it came in that
 * source's last response, or when `src` resolves to the source's URL with the item itself in
 * place of the list item, so an item a server event added is replaced by the next response.
 */
function fanOut(l: ResourceLoader, app: App) {
  const { def, res: r } = l;
  const each = def.each!;
  const sources = new Map<string, Source>();
  const queued = new Set<string>();
  let pending = 0, again: Promise<void> | null = null, loud = false;

  const urlOf = (item: unknown) => {
    if (!item || typeof item != 'object') return null;
    try { return app.url(def.src, Object.assign(Object.create(l.scope()), { [each.item]: item })); } catch { return null; }
  };
  /** the confirmed items minus those of source `u`, plus `items` */
  const swap = (u: string, s: Source, items: any[]) => {
    const mine = (x: any) => s.keys.has(r.keyOf(x)) || urlOf(x) === u;
    r.replace([...(r.base().items as any[]).filter((x) => !mine(x)), ...items]);
  };

  /** `quiet`: a background reload (`refresh`): `$meta.loading` stays false */
  async function load(u: string, quiet?: boolean) {
    const s = sources.get(u);
    if (!s) return;
    s.c?.abort();
    const ctl = (s.c = new AbortController()), n = ++s.seq, mark = r.startLoad();
    let loaded = false, failed = false, items: any[] = [];
    if (!quiet) { pending++; l.loading(true); }
    try {
      const body = await l.get(u, ctl.signal);
      if (n != s.seq || sources.get(u) != s) return;
      items = l.items(body);
      swap(u, s, items);
      s.keys = new Set(items.map((x) => r.keyOf(x)));
      s.answered = loaded = true;
      r.meta.error = null;
      // loadedAt: every current source has answered once
      if ([...sources.values()].every((x) => x.answered)) r.meta.loadedAt = app.env.now();
    } catch (e) {
      if (n != s.seq || isAbort(e)) return;
      s.answered = failed = true;
      l.failed(e, quiet);
    } finally {
      r.endLoad(mark, loaded);
      if (n == s.seq) s.c = null;
      if (!quiet) l.loading(--pending > 0);
      else if (loaded) r.onDirty('meta');
    }
    // once per source that answered: `$result` is its items
    if (loaded) l.done(items);
    if (loaded || failed) for (const f of l.settled) f(loaded);
  }

  l.changed = () => {
    const scope = l.scope();
    let list: unknown = [];
    try {
      if (def.when == null || app.fns[def.when]!(scope)) list = app.fns[each.list]!(scope) ?? [];
    } catch (e) { app.warn(17, def.name, (e as Error).message); }
    const want = new Set<string>();
    for (const item of Array.isArray(list) ? list : [...(list as Iterable<unknown>)]) {
      const u = urlOf(item);
      if (u != null) want.add(u);
    }
    for (const [u, s] of sources) {
      if (want.has(u)) continue;
      s.seq++;
      s.c?.abort();
      sources.delete(u);
      swap(u, s, []);
    }
    for (const u of want) {
      if (sources.has(u)) continue;
      sources.set(u, { c: null, seq: 0, keys: new Set(), answered: false });
      void load(u);
    }
    // nothing to load: loaded once the list itself is (an empty list is an answer, a pending one is not)
    if (!sources.size && r.meta.loadedAt == null && (!each.of || app.resource(each.of).meta.loadedAt != null)) {
      r.meta.loadedAt = app.env.now();
      r.onDirty('meta');
    }
    l.loading(pending > 0);
  };
  l.start = () => l.changed();
  l.load = () => Promise.all([...sources.keys()].map((u) => load(u))).then(() => {});
  // a hint (an event's payload) that resolves to one source's URL reloads only that source;
  // several refetches in one task share one round of requests
  l.refetch = (hint?: object, quiet?: boolean) => {
    const u = hint ? urlOf(hint) : null;
    queued.add(u != null && sources.has(u) ? u : '*');
    if (!quiet) loud = true;
    return (again ??= Promise.resolve().then(() => {
      again = null;
      const urls = queued.has('*') ? [...sources.keys()] : [...queued], q = !loud;
      queued.clear();
      loud = false;
      return Promise.all(urls.map((x) => load(x, q))).then(() => {});
    }));
  };
  l.inflight = () => [...sources.values()].some((s) => s.c != null);
}

const each: Feature = {
  name: 'each',
  install(app: App) {
    app.ext.each = { fanOut: (loader) => fanOut(loader, app) };
  },
};

export default each;
