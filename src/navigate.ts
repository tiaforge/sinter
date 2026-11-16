// `data-sn-on-navigate`: a handler for every navigation while its element is on the page (a link,
// `navigate()`, `location.assign`, Back and Forward), run before anything acts. Its `$event` has `to`,
// `from`, `kind` and `trigger`; `$event.preventDefault()` refuses the navigation (unsaved changes). It does
// not run for what can no longer be refused: Back without the Navigation API, or the browser's own Back
// without activation, a reload, a closed tab (`beforeunload` stays for those). Loaded by pages with such a
// handler; the compiler marks their elements (`data-sn-navigate`).
import { chain, links } from './links.js';
import type { App, Feature } from './runtime/app.js';

const feature: Feature = {
  name: 'navigate',
  install(app: App) {
    chain(app).guards.push((i) => {
      let no = false;
      // one event to each marked element, not bubbling: its own handler runs (the core's capture listener
      // at the root hears it), each element once however they nest
      for (const el of app.root.querySelectorAll('[data-sn-navigate]')) {
        const e = Object.assign(new Event('navigate', { cancelable: true }), { to: i.to, from: i.from!, kind: i.kind, trigger: i.trigger ?? null });
        el.dispatchEvent(e);
        no ||= e.defaultPrevented;
      }
      return no;
    });
    // links are intents too where there is no `navigate` event
    links(app);
  },
};
export default feature;
