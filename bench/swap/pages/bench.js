// Page harness (a module; it is set up before the load event on every variant page). It clicks #a / #b alternately
// and times each swap the same way for every library:
//   dom   = click() → the MutationObserver callback that first sees the expected rows in #target
//   layout = the same, plus a forced style and layout of the result (offsetHeight), so the cost of
//            the DOM each variant builds counts. The next frame is not used: when it comes depends
//            on the frame clock (headless Chrome too spaces frames ~17 ms apart, and a variant that
//            touches the DOM at click time, e.g. htmx adding htmx-request, starts that clock early).
// Variants only provide the two buttons and #target; how they fetch and render is their own.
import { rows } from './rows.mjs';

const q = new URLSearchParams(location.search);
const n = +q.get('n'), scenario = q.get('s');
const idle = (ms) => new Promise((r) => setTimeout(r, ms));

/** What #target must show once set `v` is rendered: row count, first label, last changed label. */
function expected(v) {
  const rs = rows(n, scenario, v);
  const changed = scenario === 'replace' ? n - 1 : Math.floor((n - 1) / 10) * 10;
  return { first: rs[0].label, at: changed, label: rs[changed].label };
}
const label = (tr) => tr?.querySelector('.label')?.textContent;

function swap(v) {
  const want = expected(v), parent = document.getElementById('target').parentNode;
  const ok = () => {
    // looked up each time: datastar-replace replaces it; .rows skips a <template> kept in the tbody
    const rs = document.getElementById('target').rows;
    return rs.length === n && label(rs[0]) === want.first && label(rs[want.at]) === want.label;
  };
  return new Promise((resolve, reject) => {
    let t0;
    const mo = new MutationObserver(() => {
      if (!ok()) return;
      const dom = performance.now() - t0;
      document.body.offsetHeight; // eslint-disable-line no-unused-expressions
      const layout = performance.now() - t0;
      mo.disconnect(); clearTimeout(timer);
      resolve({ dom, layout });
    });
    mo.observe(parent, { childList: true, subtree: true, characterData: true });
    const timer = setTimeout(() => { mo.disconnect(); reject(new Error(`no swap to ${v} within 10 s`)); }, 10_000);
    t0 = performance.now();
    document.getElementById(v).click();
  });
}

window.__bench = {
  ready: new Promise((r) => addEventListener('load', () => idle(100).then(r))),
  /** Loads set a once (not timed), then alternates b, a, … ; returns the timed samples after warm-up. */
  shown: null,
  async run({ warmup = 10, iterations = 50 } = {}) {
    await this.ready;
    let shown = this.shown; // a second run() continues from the set on screen (a variant may skip a no-op)
    const next = () => (this.shown = shown = shown === 'a' ? 'b' : 'a');
    if (!shown) await swap(next());
    const dom = [], layout = [];
    for (let i = 0; i < warmup + iterations; i++) {
      await idle(30); // let deferred work (htmx settle, morph cleanup) finish outside the timed window
      const t = await swap(next());
      if (i >= warmup) { dom.push(t.dom); layout.push(t.layout); }
    }
    return { dom, layout };
  },
};
