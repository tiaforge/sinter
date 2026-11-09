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
import { doubled, jittered, MAX_BACKOFF } from './backoff.js';

function watch(l: ResourceLoader, app: App) {
  if (l.def.refresh == null) return;
  const env = app.env, every = l.def.refresh;
  /** the wait before the next refresh: `refresh`, doubled after each failure up to 30 s (or `refresh`, if longer) */
  let timer: unknown = null, wait = every, due = false;

  const stop = () => { if (timer != null) { env.clearTimeout(timer); timer = null; } };
  /** the next refresh in about `wait` (±10 %, so pages opened together do not reload together) */
  const arm = () => {
    stop();
    timer = env.setTimeout(fire, jittered(wait, env.random, 0.1), 'clock');
  };
  const fire = () => {
    timer = null;
    if (env.hidden?.()) { due = true; return; }
    // a running load settles and starts the clock again; with `when` falsy there is nothing to load
    if (l.inflight() || (!l.def.each && l.url() == null)) return;
    void l.refetch(undefined, true);
  };

  l.settled.push((ok) => {
    wait = ok ? every : doubled(wait, Math.max(every, MAX_BACKOFF));
    arm();
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
