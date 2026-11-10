// Page harness, the same classic script first in every variant's <head>. It watches #seq, which every
// variant renders last in a tick, and records for each tick it sees:
//   dom   = from when the server's tick was due to the MutationObserver callback that sees its seq
//   frame = the same, to the end of the next frame after it (rAF, then a message: after the paint's
//           main-thread part)
// plus every frame (rAF count) and every long task. The variants do not know about it.
// The runner reads window.__live: mark() starts a step, take() ends it and returns the raw numbers.
(() => {
  const clock = () => performance.timeOrigin + performance.now();
  let samples = [], frames = 0, longTasks = 0, longMs = 0, pending = [], seen = 0, last = 0;
  const mc = new MessageChannel();
  mc.port1.onmessage = () => {
    const t = clock();
    for (const s of pending) s.frame = t;
    pending = [];
  };
  const onFrame = () => { frames++; if (pending.length) mc.port2.postMessage(0); requestAnimationFrame(onFrame); };
  requestAnimationFrame(onFrame);
  try {
    new PerformanceObserver((l) => { for (const e of l.getEntries()) { longTasks++; longMs += e.duration; } }).observe({ type: 'longtask' });
  } catch {}

  // only seq and the local times are kept: the runner knows when the server had each tick due
  // (its schedule, from /control), so nothing in the page parses or compares
  const observe = (el) => {
    new MutationObserver(() => {
      const seq = Number(document.getElementById('seq')?.textContent);
      if (!(seq > last)) return;
      seen += seq - last; last = seq;
      const s = { seq, at: clock(), frame: 0 };
      samples.push(s); pending.push(s);
    }).observe(el, { childList: true, subtree: true, characterData: true });
  };
  // #seq may be replaced (morphs, outerHTML swaps): watch its parent
  const start = () => { const el = document.getElementById('seq'); el ? observe(el.parentNode) : setTimeout(start, 5); };
  document.readyState === 'loading' ? document.addEventListener('DOMContentLoaded', start) : start();

  window.__live = {
    get last() { return last; },
    mark() { samples = []; pending = []; frames = 0; longTasks = 0; longMs = 0; seen = 0; },
    /** this step's samples as [seq, domAt, frameAt] (frameAt 0: its frame had not ended yet) and counters */
    take() {
      return { samples: samples.map((s) => [s.seq, s.at, s.frame]), frames, longTasks, longMs, seen, last };
    },
  };
})();
