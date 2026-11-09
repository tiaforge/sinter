// `refresh` on `<sn-resource>`: the resource is reloaded once that long has passed since its
// last load, whatever caused that load (the first load, `refresh()`, a server event's refetch, a
// stream's reconnect, `src` changing), so with a stream feeding it, it rarely reloads by itself:
// only when nothing else has. A refresh is a background load: `$meta.loading` stays false, and
// a response with the version (`ETag`, `Last-Modified`) of the data shown is not parsed or stored
// again (the versions module, which every page with `refresh` has). Paused while the page is hidden (a background tab, a prerendered page); a refresh that
// fell due meanwhile runs when it is shown again. While `when` is falsy there is nothing to
// reload: the next load starts the clock again. A failure retries later, doubling the wait up to
// 30 s (never sooner than `refresh`), and reports once until a load succeeds again.
import type { App, Feature, ResourceLoader } from './runtime/app.js';

const MAX_BACKOFF = 30_000;

function watch(l: ResourceLoader, app: App) {
  if (l.def.refresh == null) return;
  const env = app.env, every = l.def.refresh;
  let timer: unknown = null, fails = 0, due = false;

  const stop = () => { if (timer != null) { env.clearTimeout(timer); timer = null; } };
  /** the next refresh in about `ms` (±10 %, so pages opened together do not reload together) */
  const arm = (ms: number) => {
    stop();
    timer = env.setTimeout(fire, Math.round(ms * (0.9 + env.random() * 0.2)), 'clock');
  };
  const fire = () => {
    timer = null;
    if (env.hidden?.()) { due = true; return; }
    // a running load settles and starts the clock again; with `when` falsy there is nothing to load
    if (l.inflight() || (!l.def.each && l.url() == null)) return;
    void l.refetch(undefined, true);
  };

  l.settled.push((ok) => {
    fails = ok ? 0 : fails + 1;
    arm(ok ? every : Math.max(every, Math.min(every * 2 ** fails, MAX_BACKOFF)));
  });
  app.addCleanup(env.listen('visibilitychange', () => {
    if (due && !env.hidden?.()) { due = false; fire(); }
  }));
  app.addCleanup(stop);
}

const refresh: Feature = {
  name: 'refresh',
  install(app: App) {
    app.ext.refresh = { watch: (l) => watch(l, app) };
  },
};

export default refresh;
