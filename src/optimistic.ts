// Optimistic layers for actions: the `data-sn-optimistic` expression runs
// against recording resources; its changes become one layer per resource,
// dropped when the request settles (success or rollback alike).
import type { App, Feature } from './runtime/app.js';

const optimistic: Feature = {
  name: 'optimistic',
  install(app: App) {
    app.ext.optimistic = {
      begin(fn, scope) {
        return app.record(() => {
          const s = Object.create(scope);
          s.$f = app.storeFns(null);
          app.fns[fn]!(s);
        });
      },
    };
  },
};

export default optimistic;
