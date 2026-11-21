// Builds every variant into dist/<variant>/: the JSON clients with Vite (Avenx with its own CLI), the two hypermedia pages
// from the shared model (their initial HTML is what the server's view state starts from).
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { barsHtml, chartHtml, initial, rowHtml, seqHtml, signalBody, signalsOf } from './shared/model.js';

const only = process.env.ONLY?.split(',');
const want = (v) => !only || only.includes(v);
const GRID = ['grid-sinter', 'grid-solid', 'grid-svelte', 'grid-vue', 'grid-ivi', 'grid-vanilla'];
for (const v of ['sinter', 'solid', 'svelte', 'vue', ...GRID].filter(want)) {
  execFileSync('npx', ['vite', 'build', '--logLevel', 'warn'], { stdio: 'inherit', env: { ...process.env, VARIANT: v } });
}

mkdirSync('vendor', { recursive: true });
copyFileSync('node_modules/htmx.org/dist/htmx.min.js', 'vendor/htmx-2.0.11.min.js');
copyFileSync('node_modules/htmx-ext-sse/dist/sse.min.js', 'vendor/htmx-ext-sse-2.2.4.min.js');

const s = initial();
const body = (seq) => `<header>seq ${seq}</header>
<section class="charts">${s.series.map((sr, k) => chartHtml(k, sr)).join('')}</section>
${barsHtml(s.bars)}
<table><tbody>${s.hosts.map(rowHtml).join('')}</tbody></table>`;
const page = (title, head, main) => `<!DOCTYPE html>
<html lang="en">
<head>
<script src="/shared/harness.js"></script>
<meta charset="utf-8"><title>${title}</title><link rel="icon" href="data:,">
<link rel="stylesheet" href="/shared/style.css">
${head}
</head>
<body>
${main}
</body>
</html>
`;
const pages = {
  // signals mode: the server patches signals, data-text / data-attr / data-style show them
  datastar: page('Datastar', '<script type="module" src="/vendor/datastar-1.0.4.js"></script>',
    `<main id="app" data-signals='${JSON.stringify(signalsOf(s))}' data-init="@get('/events?fmt=datastar', {openWhenHidden: true})">\n${signalBody(s)}\n</main>`),
  // elements mode: patch-elements morphs each element by id (Datastar's default mode, outer)
  'datastar-elements': page('Datastar (elements)', '<script type="module" src="/vendor/datastar-1.0.4.js"></script>',
    `<main id="app" data-init="@get('/events?fmt=datastar-elements', {openWhenHidden: true})">\n${body(seqHtml(s.seq))}\n</main>`),
  // one `tick` event per tick: #seq's new content, the rest out of band (hx-swap-oob, outerHTML by id)
  htmx: page('htmx', '<script src="/vendor/htmx-2.0.11.min.js"></script>\n<script src="/vendor/htmx-ext-sse-2.2.4.min.js"></script>',
    `<main id="app" hx-ext="sse" sse-connect="/events?fmt=htmx">\n${body(`<span id="seq" sse-swap="tick">${s.seq}</span>`)}\n</main>`),
};
for (const [v, html] of Object.entries(pages).filter(([v]) => want(v))) {
  mkdirSync(`dist/${v}`, { recursive: true });
  writeFileSync(`dist/${v}/index.html`, html);
}

// Avenx builds with its own CLI (apps/avenx, apps/grid-avenx, each with its own node_modules: npm
// install there first) into one classic script; the page around it is written here
for (const [v, title] of [['avenx', 'Avenx'], ['grid-avenx', 'Avenx grid']].filter(([v]) => want(v))) {
  execFileSync('npx', ['avenx', 'build'], { cwd: `apps/${v}`, stdio: ['ignore', 'ignore', 'inherit'] });
  mkdirSync(`dist/${v}`, { recursive: true });
  copyFileSync(`apps/${v}/dist/bundle.js`, `dist/${v}/bundle.js`);
  writeFileSync(`dist/${v}/index.html`, page(title, '', `<main id="app"></main>\n<script src="/${v}/bundle.js"></script>`));
}
