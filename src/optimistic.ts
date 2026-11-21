// Optimistic layers for actions: the `data-sn-optimistic` expression runs
// against recording resources; its changes become one layer per resource,
// committed into the base when the request succeeds, dropped when it fails.
import type { App, Feature } from './runtime/app.js';

const optimistic: Feature = {
  name: 'optimistic',
  install(app: App) {
    app.ext.optimistic = {
      begin(fn, scope) {
        // (`$f`, the page's, through the scope: an action's scope is its element's, under the page)
        return app.record(() => app.fns[fn]!(Object.create(scope)));
      },
    };
  },
};

export default optimistic;
