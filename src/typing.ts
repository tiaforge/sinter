// Typing into a field bound to `$url`, and a number field's steps: they wait for a pause. Typing
// commits at each pause, the first commit of a run pushing a history entry and later ones replacing
// it; `change` on the field (Enter, or leaving it) commits at once and ends the run. A number or
// range field's burst of steps (spinner clicks, arrow keys) pushes once, at its pause. Loaded only by
// pages with a text, number or range model on `$url`; the writes themselves are location.ts's.
import { MODEL, type App, type Feature, type Tagged } from './runtime/app.js';
import { wait } from './runtime/wait.js';

const REPLACE = 1, TYPED = 2, BURST = 3, PUSH = 4;

const feature: Feature = {
  name: 'typing',
  install(app: App) {
    const ps = app.ir.ps!, pause = wait(app);
    /** whether a typing run pushed its entry; whether `change` ended it before its pass */
    let run = false, fin = false;
    const loc = () => app.ext.location!;
    const commit = () => { if (loc().commit(run ? REPLACE : PUSH)) run = true; };
    const stop = () => { pause.stop(); run = fin = false; };
    /** what typing waits to commit is committed now, and the run ends */
    const finish = () => { if (pause.on()) { pause.stop(); commit(); } run = false; };
    app.ext.typing = {
      stop,
      finish,
      waits: () => pause.on(),
      flush(k) {
        // a number field's steps: one entry once they pause (it takes what typing waited to commit too)
        if (k == BURST) { run = false; pause.start(() => loc().commit(PUSH)); }
        else if (fin) { fin = false; commit(); run = false; }
        else pause.start(commit);
      },
    };
    // `change` on a text field bound to the URL (Enter, or leaving it): what typing waits to commit is
    // committed, the run ends. A model on state does not end it. In the capture phase, before the
    // page's own `change` handlers (as the core's models).
    const change = (e: Event) => {
      const m = (e.target as Tagged | null)?.[MODEL];
      if (m?.b.n != 'text' || !(m.b.w ?? []).some((p) => { let n = p as number; while (ps.p[n]! >= 0) n = ps.p[n]!; return n == ps.x.$url; })) return;
      if (loc().kind == TYPED) return void (fin = true);
      finish();
    };
    const ET = EventTarget.prototype;
    ET.addEventListener.call(app.root, 'change', change, true);
    app.addCleanup(() => ET.removeEventListener.call(app.root, 'change', change, true));
  },
};
export default feature;
