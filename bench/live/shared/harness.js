// Page harness, the same classic script first in every variant's <head>. It watches #seq, which every
// variant renders last in a tick, and records for each tick it sees:
//   dom   = from when the server's tick was due to the MutationObserver callback that sees its seq
//   frame = the same, to the end of the frame that paints it: the ResizeObserver callback of each
//           frame (after every rAF callback and layout, before paint) takes the ticks shown so far,
//           and a message posted there marks the end of that frame's main-thread work. A variant that
//           renders in a rAF callback is counted in the frame it renders in.
// plus every frame (rAF count) and every long task. The variants do not know about it.
// The runner reads window.__live: mark() starts a step, take() ends it and returns the raw numbers.
(() => {
  const clock = () => performance.timeOrigin + performance.now();
  let samples = [], frames = 0, longTasks = 0, longMs = 0, pending = [], seen = 0, last = 0;
  let painting = [];
  const mc = new MessageChannel();
  mc.port1.onmessage = () => {
    const t = clock();
    for (const s of painting) s.frame = t;
    painting = [];
  };
  // a 1px box whose width changes in each frame that has a tick to time, so its ResizeObserver runs
  // in that frame; contained, so the change costs nothing outside it (an uncontained probe changed
  // every frame cost a full frame of main thread on a page of 10,000 table rows)
  const probe = document.createElement('div');
  probe.style.cssText = 'position:fixed;left:0;top:0;height:1px;width:1px;opacity:0;pointer-events:none;contain:strict';
  let wide = false;
  new ResizeObserver(() => {
    if (pending.length) { painting.push(...pending); pending = []; mc.port2.postMessage(0); }
  }).observe(probe);
  const onFrame = () => { frames++; requestAnimationFrame(onFrame); };
  // a tick seen: the probe changes now, so the frame that paints this tick runs its ResizeObserver
  // (the current frame when the tick rendered in a rAF callback, else the next one)
  const arm = () => { probe.style.width = (wide = !wide) ? '2px' : '1px'; };
  requestAnimationFrame(onFrame);
  const addProbe = () => (document.body ? document.body.appendChild(probe) : setTimeout(addProbe, 5));
  addProbe();
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
      samples.push(s); pending.push(s); arm();
    }).observe(el, { childList: true, subtree: true, characterData: true });
  };
  // #seq may be replaced (morphs, outerHTML swaps): watch its parent
  const start = () => { const el = document.getElementById('seq'); el ? observe(el.parentNode) : setTimeout(start, 5); };
  document.readyState === 'loading' ? document.addEventListener('DOMContentLoaded', start) : start();

  window.__live = {
    get last() { return last; },
    mark() { samples = []; pending = []; painting = []; frames = 0; longTasks = 0; longMs = 0; seen = 0; },
    /** this step's samples as [seq, domAt, frameAt] (frameAt 0: its frame had not ended yet) and counters */
    take() {
      return { samples: samples.map((s) => [s.seq, s.at, s.frame]), frames, longTasks, longMs, seen, last };
    },
  };
})();
