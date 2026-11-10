// `data-sn-confirm`: a question before the action runs; it runs only when the user agrees
// (`configure({ confirm })`, else the browser's `confirm()`; a promise is awaited). Loaded only by
// pages with such an action.
import type { App, Feature } from './runtime/app.js';
import { config } from './runtime/config.js';

const feature: Feature = {
  name: 'confirm',
  install(app: App) {
    app.ext.confirm = (question, go) => {
      if (!question) return go();
      const yes = (config.confirm ?? ((q: string) => globalThis.confirm(q)))(String(question));
      if (yes instanceof Promise) void yes.then((y) => y && go());
      else if (yes) go();
    };
  },
};
export default feature;
