// Debounced handlers and actions (`data-sn-debounce`, `data-sn-debounce-<event>`): one run, `ms`
// after the last trigger, counted as busy while it waits (the testing module's settle). Loaded
// only by pages with one.
import type { App, Feature } from './runtime/app.js';

const feature: Feature = {
  name: 'debounce',
  install(app: App) {
    const timers = new WeakMap<object, unknown>();
    app.ext.debounce = (key, ms, run) => {
      const t = timers.get(key);
      if (t) { app.env.clearTimeout(t); app.busy--; }
      app.busy++;
      timers.set(key, app.env.setTimeout(() => { timers.delete(key); app.busy--; run(); }, ms, 'debounce'));
    };
  },
};
export default feature;
