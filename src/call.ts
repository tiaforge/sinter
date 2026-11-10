// Action functions (`data-sn-call`, `<sn-resource call>`): runs one with its context (`signal`,
// `request`, `el`), counted as busy while it runs (the testing module's settle), and turns what it
// throws into an `$error`. Loaded only by pages with such an action or resource.
import type { App, CallContext, Feature } from './runtime/app.js';
import { SinterError } from './runtime/config.js';

const feature: Feature = {
  name: 'call',
  install(app: App) {
    // an action's signal aborts when the page is hidden (pagehide); a resource passes its own
    let hide = new AbortController();
    app.addCleanup(app.env.listen('pagehide', () => { hide.abort(); hide = new AbortController(); }));
    app.ext.call = {
      async run(f, args, el, signal) {
        app.busy++;
        const ctx: CallContext = { signal: signal ?? hide.signal, request: (u, i) => app.req.send(u, i), el };
        try { return await app.fns[f]!(args, ctx); } finally { app.busy--; }
      },
      // SinterErrors as they are, anything else with status null
      error(e) {
        if (e instanceof SinterError) return e;
        const detail = (e instanceof Error ? e.message : typeof e == 'string' ? e : '') || null;
        return new SinterError(null, e, detail ?? String(e), detail);
      },
    };
  },
};
export default feature;
