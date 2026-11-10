// Live dashboard benchmark: each variant in a fresh headless Chrome, fed at rising tick rates.
// Per step: set the rate, WARM ms unmeasured, STEP ms measured, then pause the stream and wait until
// the page shows the last tick sent (so each step starts with no backlog). A variant that cannot
// drain within 10 s, or whose frame latency p95 passes 2 s, is not fed faster rates.
//
//   node build.mjs && CHROME=/path/to/chrome node run.mjs
//   ONLY also takes datastar-elements (Datastar's HTML morph mode, before signals mode replaced it here)
//   RATES=50,100,200,500,1000,2000,5000 STEP=3000 WARM=1000 CPU=1 ONLY=sinter,solid CHROME_ARGS=--no-sandbox
//   QUICK=1: for iterating, ~20 s a variant: both CPU settings, 3 rates each, 1 s steps after 300 ms
//   (CPU=1,4 also runs several settings in one invocation)
//
// Measured per step (the page's harness, shared/harness.js, and the DevTools protocol):
//   shown/s   ticks the page showed per second (a framework that coalesces shows fewer than were sent)
//   dom       due time of a shown tick → its #seq in the DOM (p50 / p95)
//   frame     due time → the end of the next frame (p50 / p95): event-to-paint
//   fps       frames per second
//   busy      renderer main thread busy, % of wall time (TaskDuration), of which script, style + layout
//   long      long tasks (≥ 50 ms) and their total ms
//   heap      JS heap used at the end of the step, MB (after the run: after a forced GC)
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { evaluate, launch, withPage } from '../swap/cdp.mjs';

const env = (k, d) => process.env[k] ?? d;
const RATES = env('RATES', '50,100,200,500,1000,2000,5000').split(',').map(Number);
const QUICK = !!process.env.QUICK;
const STEP = +env('STEP', QUICK ? 1000 : 3000), WARM = +env('WARM', QUICK ? 300 : 1000);
const CPUS = env('CPU', QUICK ? '1,4' : '1').split(',').map(Number);
const ratesFor = (cpu) => (process.env.RATES ? RATES : QUICK ? (cpu > 1 ? [200, 500, 1000] : [1000, 2000, 5000]) : RATES);
const VARIANTS = env('ONLY', 'sinter,solid,svelte,vue,datastar,htmx').split(',');
const idle = (ms) => new Promise((r) => setTimeout(r, ms));

// the server in its own process: its event loop must not share the runner's
const server = spawn(process.execPath, ['server.mjs', '0'], { cwd: import.meta.dirname, stdio: ['ignore', 'pipe', 'inherit'] });
const base = await new Promise((ok) => server.stdout.on('data', (d) => { const m = String(d).match(/http:\/\/[\d.:]+/); if (m) ok(m[0]); }));
const control = async (rate) => (await fetch(`${base}/control${rate == null ? '' : `?rate=${rate}`}`)).json();

const q = (xs, p) => { if (!xs.length) return NaN; const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
const metricsOf = async (send) => Object.fromEntries((await send('Performance.getMetrics')).metrics.map((m) => [m.name, m.value]));

const results = {}, heaps = {}, names = [];
const chrome = await launch();
try {
  for (const CPU of CPUS) for (const variant of VARIANTS) {
    const v = CPUS.length > 1 ? `${variant} @${CPU}x` : variant;
    names.push(v);
    await control(0);
    const rows = (results[v] = []);
    await withPage(chrome, `${base}/${variant}/`, async (send) => {
      await send('Performance.enable', { timeDomain: 'timeTicks' });
      await idle(QUICK ? 200 : 500);
      await send('HeapProfiler.collectGarbage');
      const heap0 = (await metricsOf(send)).JSHeapUsedSize;
      for (const rate of ratesFor(CPU)) {
        await control(rate);
        await idle(WARM);
        await evaluate(send, '__live.mark()');
        const m0 = await metricsOf(send), t0 = performance.now();
        await idle(STEP);
        const got = await evaluate(send, '__live.take()');
        const m1 = await metricsOf(send), wall = (performance.now() - t0) / 1000;
        const sched = (await control(0)).streams.find((s) => s.fmt === (['datastar', 'datastar-elements', 'htmx'].includes(variant) ? variant : 'json'));
        // when the server had each tick due
        const due = (seq) => { const g = sched.segments.findLast(([first]) => first <= seq); return g[1] + (seq - g[0]) * g[2]; };
        const dom = got.samples.map(([seq, at]) => at - due(seq));
        const frame = got.samples.filter((s) => s[2]).map(([seq, , at]) => at - due(seq));
        const d = (k) => (m1[k] - m0[k]) / wall * 100;
        const row = {
          rate, shown: got.samples.length / (STEP / 1000), fps: got.frames / (STEP / 1000),
          dom50: q(dom, 0.5), dom95: q(dom, 0.95), frame50: q(frame, 0.5), frame95: q(frame, 0.95),
          busy: d('TaskDuration'), script: d('ScriptDuration'), layout: d('LayoutDuration') + d('RecalcStyleDuration'),
          long: got.longTasks, longMs: got.longMs, heap: m1.JSHeapUsedSize / 2 ** 20,
        };
        // drain: wait until the page shows the last tick sent
        const t1 = performance.now();
        let drained = false;
        while (performance.now() - t1 < 10_000) { if ((await evaluate(send, '__live.last')) >= sched.seq) { drained = true; break; } await idle(50); }
        row.drainMs = drained ? performance.now() - t1 : null;
        rows.push(row);
        const f = (x, n = 0) => (Number.isFinite(x) ? x.toFixed(n) : '–');
        console.error(`${v} ${rate}/s: shown ${f(row.shown)}/s, fps ${f(row.fps)}, frame p50/p95 ${f(row.frame50)}/${f(row.frame95)} ms, busy ${f(row.busy)}%, long ${row.long}, ${drained ? `drained in ${f(row.drainMs)} ms` : 'did not drain'}`);
        if (!drained || row.frame95 > 2000) break;
      }
      await send('HeapProfiler.collectGarbage');
      heaps[v] = { start: heap0 / 2 ** 20, end: (await metricsOf(send)).JSHeapUsedSize / 2 ** 20 };
    }, { cpu: CPU });
  }
} finally {
  await control(0).catch(() => {});
  server.kill();
  // Chrome can still be writing its profile while it exits: the temporary directory may stay behind
  await chrome.close().catch(() => {});
}

const f = (x, n = 0) => (Number.isFinite(x) ? x.toFixed(n) : '–');
console.log(`\nCPU ${CPUS.map((c) => c + 'x').join(', ')}, ${STEP} ms per step after ${WARM} ms warm-up. Latencies in ms from when the server had the tick due.\n`);
// the highest rate each variant kept up with: drained, and the frame p95 under 100 ms
console.log('| variant | keeps up to (ticks/s) | heap after GC, start → end (MB) |\n| --- | ---: | ---: |');
for (const v of names) {
  const ok = results[v].filter((r) => r.drainMs != null && r.frame95 < 100);
  console.log(`| ${v} | ${ok.length ? ok.at(-1).rate : '< ' + results[v][0]?.rate} | ${f(heaps[v]?.start, 1)} → ${f(heaps[v]?.end, 1)} |`);
}
console.log('\n| variant | rate/s | shown/s | fps | dom p50 / p95 | frame p50 / p95 | busy % | script % | style+layout % | long tasks (ms) | heap MB | drain ms |');
console.log('| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |');
for (const v of names) for (const r of results[v]) {
  console.log(`| ${v} | ${r.rate} | ${f(r.shown)} | ${f(r.fps)} | ${f(r.dom50, 1)} / ${f(r.dom95, 1)} | ${f(r.frame50, 1)} / ${f(r.frame95, 1)} | ${f(r.busy)} | ${f(r.script)} | ${f(r.layout)} | ${r.long} (${f(r.longMs)}) | ${f(r.heap, 1)} | ${r.drainMs == null ? 'no' : f(r.drainMs)} |`);
}
// quick runs are for iterating: not kept unless asked (OUT=dir)
const dir = env('OUT', QUICK ? '' : 'results');
if (dir) {
  mkdirSync(dir, { recursive: true });
  const out = `${dir}/${new Date().toISOString().replace(/[:.]/g, '-')}-cpu${CPUS.join('-')}.json`;
  writeFileSync(out, JSON.stringify({ CPUS, STEP, WARM, rates: Object.fromEntries(CPUS.map((c) => [c, ratesFor(c)])), results, heaps }, null, 1));
  console.log(`\nRaw: ${out}`);
}
