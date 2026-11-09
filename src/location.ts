// `$url` written by a handler (`$url.page = 2`): the query string follows, with `replaceState`
// (no history entry). Loaded only by pages whose handlers write `$url`.
import type { App, Feature } from './runtime/app.js';

const feature: Feature = {
  name: 'location',
  install(app: App) {
    // the parameters the path pattern carries (`:slug`) stay in the path
    const fromPath = new Set((app.ir.path ?? []).flatMap((p) => p.split('/').filter((s) => s[0] == ':').map((s) => s.slice(1))));
    app.ext.location = () => {
      const u = new URL(app.env.href()), q = new URLSearchParams();
      for (const [k, v] of Object.entries(app.page.$url as Record<string, unknown>)) if (v != null && v !== '' && !fromPath.has(k)) q.set(k, '' + v);
      u.search = '' + q;
      app.env.replaceState(u.pathname + u.search + u.hash);
    };
  },
};
export default feature;
