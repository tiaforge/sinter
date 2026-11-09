// Unchanged reloads. A reload of a `src` resource whose response carries the version (`ETag`,
// else `Last-Modified`) of the response the data was last replaced with, while nothing has
// changed the data since (server events, action results, confirmed optimistic layers, writes
// during the load), is the data the store already holds: it is not parsed or stored, nothing
// re-renders and `then` does not run. A 304 that reaches the page (a middleware sent the
// condition) counts the same. sinter sends no conditional headers itself: the browser's HTTP
// cache revalidates when the server sends `Cache-Control: no-cache`.
// Added to pages whose resources are reloaded as a matter of course: those with `refresh` or an
// `<sn-sync>` (refetch events, reconnects). Not for `call` and `each` resources.
import { UNCHANGED, type Feature, type ResourceLoader } from './runtime/app.js';

/** What identifies a response's content: its `ETag`, else its `Last-Modified`. */
export const versionOf = (res: Response): string | null => res.headers.get('ETag') ?? res.headers.get('Last-Modified');

function watch(l: ResourceLoader) {
  if (l.def.call || l.def.each) return;
  /** confirmed changes to the data: a version is only valid while there are none since */
  let changes = 0, version: { req: string; v: string; at: number } | null = null;
  /** the version of the response a load is storing; whether the data was unchanged while it ran */
  let next: { req: string; v: string | null; clean: boolean } | null = null;
  l.res.subscribe(() => { changes++; });
  l.get = async (req, signal, lo) => {
    const at = changes, g = await l.got(req, signal, lo), v = g.res.ok || g.res.status == 304 ? versionOf(g.res) : null;
    if (version && version.req == req && version.at == changes && (g.res.status == 304 || v == version.v)) return UNCHANGED;
    const body = await g.body();
    // writes made during the load are replayed on top of the response: the data is not that version
    next = { req, v, clean: changes == at };
    return body;
  };
  l.settled.push((ok) => {
    const n = next;
    next = null;
    // an unchanged response keeps the version; a stored one replaces it (after the store's own changes)
    if (n) version = ok && n.clean && n.v != null ? { req: n.req, v: n.v, at: changes } : null;
  });
}

const versions: Feature = {
  name: 'versions',
  install(app) {
    app.ext.versions = { watch };
  },
};

export default versions;
