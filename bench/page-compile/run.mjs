// One large page compiled N times in this process: per-compile time, and (with --cpu-prof) where it goes.
// node bench/page-compile/run.mjs [sections=200] [runs=10]   (npm run build first: it uses dist/)
// docs/proposals/parallel-page-compile.md
import { compile } from '../../dist/compiler/index.js';

const [sections = 200, runs = 10] = process.argv.slice(2).map(Number);
const card = `<template data-sn-props="{ title: string; body: string }"><article class="card"><h3 data-sn-text="title"></h3><p data-sn-text="body"></p><slot></slot></article></template>`;
const files = { '/p/src/components/x-card.html': card };

function page(n) {
  const top = `<sn-resource name="items" src="/api/items" select="items" key="id" order="name"></sn-resource>`;
  const sec = (i) => `
<section id="s${i}" data-sn-state="{ q${i}: '', open${i}: false, n${i}: ${i} }">
  <h2 data-sn-text="'Section ' + n${i} + ' of ' + ${n}"></h2>
  <input type="search" data-sn-model="q${i}">
  <button data-sn-on-click="open${i} = !open${i}" data-sn-attr="{ 'aria-expanded': String(open${i}) }">Toggle</button>
  <p data-sn-show="open${i}" data-sn-class="{ active: open${i}, big: n${i} > 10 }">Details for <span data-sn-text="q${i}.toUpperCase()"></span></p>
  <x-card data-sn-with="{ title: 'Card ${i}', body: q${i} }"><em data-sn-text="q${i}.length + ' chars'"></em></x-card>
  <ul>
    <template data-sn-for="it in items.filter(x => x.name.includes(q${i})).slice(0, 5)">
      <li data-sn-class="{ cheap: it.price < 10 }"><span data-sn-text="it.name"></span> — <b data-sn-text="'$' + it.price.toFixed(2)"></b></li>
    </template>
  </ul>
  <template data-sn-if="n${i} % 2 === 0"><p>even</p></template>
</section>`;
  return `<!doctype html><html><head><title>big</title></head><body>${top}${Array.from({ length: n }, (_, i) => sec(i)).join('')}</body></html>`;
}

const html = page(sections);
const opts = {
  file: '/p/index.html', root: '/p', dev: false, prerender: true,
  helpers: { module: null, names: [], namespaces: {} },
  readFile: (f) => { if (f in files) return files[f]; throw new Error('missing ' + f); },
};
const times = [];
let out;
for (let r = 0; r < runs; r++) { const t = performance.now(); out = compile(html, opts); times.push(performance.now() - t); }
times.sort((a, b) => a - b);
console.log(JSON.stringify({ sections, htmlKb: Math.round(html.length / 1e3), outKb: Math.round(out.html.length / 1e3), moduleKb: Math.round(out.module.length / 1e3), diagnostics: out.diagnostics.slice(0, 3).map((d) => d.code + ' ' + d.message.slice(0, 120)), first: Math.round(times.at(-1)), median: Math.round(times[runs >> 1]), min: Math.round(times[0]) }));
