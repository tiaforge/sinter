// The dashboard's data, the same for every variant: three time series (a sliding window of W points
// each), B bars and H table rows ("hosts"). Every value is a pure function of the tick number, so the
// server, the JSON clients and the HTML renderer agree without sharing state.
//
// One tick (one SSE message to the JSON clients):
//   { seq, ts, p: [a, b, c], bars: [B numbers], hosts: [{ id, v, d }, …K] }
// `ts` is the server's clock when the tick was due (ms since the epoch, fractional): the harness
// takes latency against `performance.timeOrigin + performance.now()`, the same clock on one machine.

export const W = 120, B = 16, H = 50, K = 5;
export const SERIES = ['cpu %', 'req/s', 'p99 ms'];
const CHART_W = 240, CHART_H = 60;

// integer hash → [0, 1): cheap, stateless, the same everywhere
function rnd(a, b = 0) {
  let h = Math.imul(a ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(b + 0x632be5ab, 0xc2b2ae35);
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39);
  return ((h ^ (h >>> 15)) >>> 0) / 4294967296;
}

/** Value of series `k` at tick `seq`: a slow wave plus noise, 0–100. */
export const point = (k, seq) => Math.round((50 + 30 * Math.sin(seq / (20 + 13 * k) + k) + 18 * (rnd(seq, k) - 0.5)) * 10) / 10;
export const barsAt = (seq) => Array.from({ length: B }, (_, i) => Math.round(10 + 85 * rnd(seq >> 2, 100 + i)));
/** The K hosts a tick changes, and their new value and change. */
export function hostsAt(seq) {
  const out = [];
  for (let j = 0; j < K; j++) {
    const id = (seq * 7 + j * 11) % H;
    out.push({ id, v: Math.round(1000 * rnd(seq, 200 + j)) / 10, d: Math.round(200 * (rnd(seq, 300 + j) - 0.5)) / 100 });
  }
  return out;
}

export const tick = (seq, ts) => ({ seq, ts, p: SERIES.map((_, k) => point(k, seq)), bars: barsAt(seq), hosts: hostsAt(seq) });

/** The state at tick 0, before the stream starts: full windows, every host. */
export function initial() {
  return {
    seq: 0,
    series: SERIES.map((_, k) => Array.from({ length: W }, (_, i) => point(k, i - W + 1))),
    bars: barsAt(0),
    hosts: Array.from({ length: H }, (_, id) => ({ id, name: `host-${String(id).padStart(2, '0')}`, v: Math.round(1000 * rnd(id, 999)) / 10, d: 0 })),
  };
}

/** The window with `v` added at the end and the oldest point dropped: a new array. */
export function slide(arr, v) {
  const out = arr.slice(1);
  out.push(v);
  return out;
}

/** An SVG path through the window, scaled to the chart (values 0–100). */
export function linePath(arr) {
  const dx = CHART_W / (W - 1);
  let d = '';
  for (let i = 0; i < arr.length; i++) d += (i ? 'L' : 'M') + (i * dx).toFixed(1) + ' ' + (CHART_H - (arr[i] * CHART_H) / 100).toFixed(1);
  return d;
}

export const fmt1 = (v) => v.toFixed(1);
export const fmt2 = (d) => (d > 0 ? '+' : '') + d.toFixed(2);
export const trend = (d) => (d > 0 ? 'up' : d < 0 ? 'down' : '');

// ---- Datastar signals: the server sends the view's values, formatted; the page's bindings show them ----

const hostSignal = (h) => ({ v: fmt1(h.v), d: fmt2(h.d), c: trend(h.d) });
/** Every signal for a state (the page's initial `data-signals`). */
export function signalsOf(s) {
  return {
    seq: s.seq,
    c: Object.fromEntries(s.series.map((sr, k) => [`c${k}`, { d: linePath(sr), l: fmt1(sr[sr.length - 1]) }])),
    b: Object.fromEntries(s.bars.map((v, i) => [`b${i}`, v])),
    h: Object.fromEntries(s.hosts.map((h) => [`h${h.id}`, hostSignal(h)])),
  };
}
/** The signals one tick changes (a JSON merge patch): the charts, the bars, the changed hosts, seq. */
export const signalPatch = (s, t) => ({
  c: Object.fromEntries(s.series.map((sr, k) => [`c${k}`, { d: linePath(sr), l: fmt1(sr[sr.length - 1]) }])),
  b: Object.fromEntries(t.bars.map((v, i) => [`b${i}`, v])),
  h: Object.fromEntries(t.hosts.map((h) => [`h${h.id}`, hostSignal(h)])),
  seq: t.seq,
});
/** The page body with Datastar bindings in place of values. */
export const signalBody = (s) => `<header>seq <span id="seq" data-text="$seq">${s.seq}</span></header>
<section class="charts">${s.series.map((_, k) => `<figure class="chart"><figcaption>${esc(SERIES[k])} <b data-text="$c.c${k}.l"></b></figcaption>` +
  `<svg viewBox="0 0 ${CHART_W} ${CHART_H}" preserveAspectRatio="none"><path data-attr:d="$c.c${k}.d"></path></svg></figure>`).join('')}</section>
<section class="bars">${s.bars.map((_, i) => `<div class="bar" data-style:height="$b.b${i} + '%'"><span data-text="$b.b${i}"></span></div>`).join('')}</section>
<table><tbody>${s.hosts.map((h) => `<tr><td>${esc(h.name)}</td><td data-text="$h.h${h.id}.v"></td><td data-attr:class="$h.h${h.id}.c" data-text="$h.h${h.id}.d"></td></tr>`).join('')}</tbody></table>`;

// ---- HTML, for the hypermedia variants (the server renders, the browser swaps) and the page shell ----

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
export const chartHtml = (k, arr) =>
  `<figure class="chart" id="chart-${k}"><figcaption>${esc(SERIES[k])} <b>${fmt1(arr[arr.length - 1])}</b></figcaption>` +
  `<svg viewBox="0 0 ${CHART_W} ${CHART_H}" preserveAspectRatio="none"><path d="${linePath(arr)}"></path></svg></figure>`;
export const barsHtml = (bars) => `<section class="bars" id="bars">${bars.map((v) => `<div class="bar" style="height: ${v}%"><span>${v}</span></div>`).join('')}</section>`;
export const rowHtml = (h) => `<tr id="h-${h.id}"><td>${esc(h.name)}</td><td>${fmt1(h.v)}</td><td class="${trend(h.d)}">${fmt2(h.d)}</td></tr>`;
export const seqHtml = (seq) => `<span id="seq">${seq}</span>`;
