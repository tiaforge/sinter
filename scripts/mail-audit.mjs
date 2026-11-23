// sinter-mail against this checkout (docs/proposals/compile-units.md, "Component libraries: sinter-mail";
// redesign-notes/sinter-mail.md): builds a fixed set of @tiavision/sinter-mail pages over its three rendering routes
// twice, once with SN_RENDER=0 (the redesign's stage 1 off) and once without, each build in a fresh child process,
// and compares the two output trees byte for byte. With --bench it also measures the run-time routes in Chromium and
// prints the numbers as JSON, so two checkouts can be compared.
//
//   node scripts/mail-audit.mjs <sinter-mail checkout> [--bench] [--runs N] [--suite] [--keep <dir>]
//
//   --bench      run-time numbers (Chromium) of the build without the switch, printed as JSON at the end
//   --runs N     page loads per bench case (default 9)
//   --suite      also run the checkout's own `npm test`, `npm run check` and `npm run typecheck`
//   --keep dir   keep both output trees in <dir>/off and <dir>/on
//   --only a,b   build only these pages (e.g. `--only file-gen` to time one file email)
//   --gen N      the generated newsletter (`file-gen`) of about N elements (default 200)
//   --switch X   the switch the two builds differ in (default SN_RENDER; SN_ONE_PASS for stage 3), `X=0` in the first
//   --canon      both builds in the canonical numbering (`SN_CANON=1`): the same up to numbering (B1's `SN_FROM_WALK`)
//
// The checkout must be installed (`npm install`) with its `@tiaforge-ui/sinter` resolving to this repository (its
// devDependency is `file:../sinter`: a link `../sinter` -> this repo does it), and this repository built (`npm run
// build`): the pages are built with this repo's dist/. Only node built-ins and what the checkout has installed (Vite,
// Playwright) are used. Exits 1 on any difference between the two builds, 2 on a setup or build error.
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';

const REPO = resolve(import.meta.dirname, '..');
const argv = process.argv.slice(2);

// ── The pages ─────────────────────────────────────────────────────────────────────────────────────────────────────
// route (i) an email from a file, folded at build time; (ii) from an API, rendered by <mail-view>'s script builder;
// (iii) from an API, rendered through the components (templates: a slot fill or `templates: true`).
const RES = '<sn-resource name="message" src="/api/message" type="Body"></sn-resource>\n';
const AGAIN = '<button id="again" data-sn-on-click="refresh(message)">again</button>';
// a bench page: state the use reads (`n`), so a click on #tick evaluates the use again with the same body (new props
// objects, the same values: what `sameProps` keeps), and #again, the same message fetched again (a new tree)
const BENCHED = (use, fill = '') => `${RES}<main data-sn-state="{ n: 0 }"><mail-body id="message" data-sn-with="{ ${use} }">${fill}</mail-body>${AGAIN}<button id="tick" data-sn-on-click="n++" data-sn-text="n"></button></main>`;
const FILLS = `<a slot="link" class="out" target="_blank" rel="noopener noreferrer nofollow" data-sn-attr="{ href: $slot.node.attrs.href }"><slot></slot></a>
  <template slot="image" data-sn-if="$slot.node.attrs.src"><img loading="lazy" data-sn-attr="{ src: $slot.node.attrs.src, alt: $slot.node.attrs.alt, srcset: null }"></template>
  <template data-sn-else><span class="blocked" data-sn-text="$slot.node.attrs.alt ?? 'image'"></span></template>`;
const fileHtml = (f, opts = "{ images: 'allow' }") => `<sn-resource name="html" src="file:./emails/${f}" type="string"></sn-resource>
<main data-sn-let="{ body: mail.parse(html, ${opts}) }"><mail-body id="message" data-sn-with="{ body }"></mail-body></main>`;
const fileTree = (f, fill = '') => `<sn-resource name="mail" src="file:./emails/${f}" type="Body"></sn-resource>
<main><mail-body id="message" data-sn-with="{ body: mail }">${fill}</mail-body></main>`;
/** page name -> [route, body] */
const PAGES = {
  'file-newsletter': ['i', fileHtml('newsletter.txt')],
  'file-narrow': ['i', fileHtml('newsletter.txt', "{ images: 'allow', media: 'narrow' }")],
  'file-outlook': ['i', fileHtml('outlook.txt')],
  'file-legacy': ['i', fileHtml('legacy.txt', "{ images: 'proxy', proxy: '/img?url={url}' }")],
  'file-reply': ['i', fileHtml('reply.txt', '{}')],
  'file-plain': ['i', `<sn-resource name="text" src="file:./emails/plain-reply.txt" type="string"></sn-resource>
<main data-sn-let="{ body: mail.plain(text) }"><mail-body id="message" data-sn-with="{ body }"></mail-body></main>`],
  'file-static': ['i', fileTree('static.json')],
  'file-all': ['i', fileTree('all.json')],
  'file-fills': ['i', fileTree('static.json', FILLS)],
  'file-gen': ['i', fileTree('gen.json')],
  'api': ['ii', BENCHED('body: n >= 0 ? message : null')],
  'api-html': ['ii', `<sn-resource name="html" src="/api/html" type="string"></sn-resource>
<main><mail-body id="message" data-sn-with="{ body: html ? mail.parse(html, { images: 'allow' }) : null }"></mail-body></main>`],
  'api-width': ['ii', `<sn-resource name="html" src="/api/html" type="string"></sn-resource>
<main data-sn-state="{ media: /** @type {'wide' | 'narrow' | null} */ (null) }"><mail-width data-sn-on-media="media = $event.detail"></mail-width><mail-warm></mail-warm><mail-body id="message" data-sn-with="{ body: html && media ? mail.parse(html, { media }) : null }"></mail-body></main>`],
  'api-templates': ['iii', BENCHED('body: n >= 0 ? message : null, templates: true')],
  'api-fills': ['iii', BENCHED('body: n >= 0 ? message : null', FILLS)],
  'api-both': ['ii+iii', `${RES}<main><mail-body id="a" data-sn-with="{ body: message, templates: true }"></mail-body><mail-body id="b" data-sn-with="{ body: message }"></mail-body>${AGAIN}</main>`],
};
const page = (body) => `<!doctype html>\n<html lang="en">\n<head><meta charset="utf-8"><title>t</title></head>\n<body>\n${body}\n</body>\n</html>\n`;

// ── Helpers ───────────────────────────────────────────────────────────────────────────────────────────────────────
const die = (msg, code = 2) => { console.error(`mail-audit: ${msg}`); process.exit(code); };
const files = (dir) => existsSync(dir) ? readdirSync(dir, { recursive: true }).map(String).filter((f) => statSync(join(dir, f)).isFile()).sort() : [];
const med = (xs) => { const v = [...xs].sort((a, b) => a - b); return v.length ? v[v.length >> 1] : NaN; };
const r1 = (x) => Math.round(x * 10) / 10;
const stats = (xs) => ({ median: r1(med(xs)), min: r1(Math.min(...xs)), max: r1(Math.max(...xs)), n: xs.length });
const git = (dir, ...a) => spawnSync('git', ['-C', dir, ...a], { encoding: 'utf8' }).stdout?.trim() || '?';

/** a newsletter of about `n` elements (the checkout's test/app.ts, so the benches see the tree its own benches see) */
async function newsletter(pkg, n) {
  const A = await import(join(pkg, 'test/app.ts'));
  return A.newsletter(n);
}

// ── Child: one build ──────────────────────────────────────────────────────────────────────────────────────────────
if (argv[0] === '--child') {
  const [, pkg, root, out] = argv;
  const { build } = await import(join(pkg, 'node_modules/vite/dist/node/index.js'));
  const sinter = (await import(join(REPO, 'dist/vite.js'))).default;
  const t = performance.now();
  try {
    await build({ root, logLevel: 'silent', plugins: [sinter({ libraries: ['@tiavision/sinter-mail'] })], build: { outDir: out, emptyOutDir: true } });
  } catch (e) { console.error(e?.stack ?? e); process.exit(2); }
  console.log(JSON.stringify({ ms: Math.round(performance.now() - t) }));
  process.exit(0);
}

// ── Parent ────────────────────────────────────────────────────────────────────────────────────────────────────────
const flag = (f) => { const i = argv.indexOf(f); if (i < 0) return undefined; const v = argv[i + 1]; argv.splice(i, 2); return v; };
const bool = (f) => { const i = argv.indexOf(f); if (i < 0) return false; argv.splice(i, 1); return true; };
const SWITCH_ARG = flag('--switch');
const CANON = bool('--canon');
const BENCH = bool('--bench'), SUITE = bool('--suite'), RUNS = +(flag('--runs') ?? 9), KEEP = flag('--keep');
const ONLY = flag('--only')?.split(','), GEN = +(flag('--gen') ?? 200);
if (ONLY) for (const k of Object.keys(PAGES)) if (!ONLY.includes(k)) delete PAGES[k];
if (!argv[0]) die('usage: node scripts/mail-audit.mjs <sinter-mail checkout> [--bench] [--runs N] [--suite] [--keep <dir>]');
const PKG = realpathSync(resolve(argv[0]));
if (!existsSync(join(PKG, 'sinter/components/mail-body.html'))) die(`${PKG} is not a sinter-mail checkout`);
if (!existsSync(join(PKG, 'node_modules/vite'))) die(`${PKG} is not installed: npm install there first`);
if (!existsSync(join(REPO, 'dist/vite.js'))) die(`${REPO}/dist is missing: npm run build first`);
const linked = existsSync(join(PKG, 'node_modules/@tiaforge-ui/sinter')) ? realpathSync(join(PKG, 'node_modules/@tiaforge-ui/sinter')) : null;
if (linked !== realpathSync(REPO)) die(`${PKG}/node_modules/@tiaforge-ui/sinter resolves to ${linked}, not this repo (${REPO}): the library's own imports of sinter would come from there. Link it (e.g. ln -sfn ${REPO} ${PKG}/node_modules/@tiaforge-ui/sinter) and run again`);

const work = mkdtempSync(join(tmpdir(), 'sinter-mail-audit-'));
const root = join(work, 'app');
// the app: the pages, the emails, the helpers and types modules, node_modules links (as test/app.ts makes them)
{
  const emails = join(root, 'emails');
  mkdirSync(emails, { recursive: true });
  for (const f of readdirSync(join(PKG, 'test/corpus'))) writeFileSync(join(emails, f.replace(/\.html$/, '.txt')), readFileSync(join(PKG, 'test/corpus', f)));
  for (const f of ['static.json', 'all.json']) cpSync(join(PKG, 'fixtures/trees', f), join(emails, f));
  writeFileSync(join(emails, 'gen.json'), JSON.stringify(await newsletter(PKG, GEN)));
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'src/sinter.helpers.ts'), "export * as mail from '@tiavision/sinter-mail';\n");
  writeFileSync(join(root, 'src/sinter.types.ts'), "export type { Body, Element } from '@tiavision/sinter-mail';\n");
  for (const [name, [, body]] of Object.entries(PAGES)) writeFileSync(join(root, `${name}.html`), page(body));
  mkdirSync(join(root, 'node_modules/@tiaforge-ui'), { recursive: true });
  mkdirSync(join(root, 'node_modules/@tiavision'), { recursive: true });
  symlinkSync(PKG, join(root, 'node_modules/@tiavision/sinter-mail'), 'dir');
  symlinkSync(realpathSync(REPO), join(root, 'node_modules/@tiaforge-ui/sinter'), 'dir');
}
const outs = { off: join(work, 'off'), on: join(work, 'on') };
console.log(`mail-audit: sinter ${git(REPO, 'rev-parse', '--short', 'HEAD')}${git(REPO, 'status', '--porcelain', '--untracked-files=no') ? ' (modified)' : ''}, sinter-mail ${git(PKG, 'rev-parse', '--short', 'HEAD')}; ${Object.keys(PAGES).length} pages; app in ${root}`);

const times = {};
const SWITCH = SWITCH_ARG ?? 'SN_RENDER';
// off first: SN_RENDER=0; then the default. Each a fresh process, the same root (so paths in the output agree)
for (const v of ['off', 'on']) {
  const env = { ...process.env, SN_FROM_WALK_LOG: '1', ...(CANON ? { SN_CANON: '1' } : {}) };
  if (v === 'off') env[SWITCH] = '0'; else delete env[SWITCH];
  const r = spawnSync(process.execPath, [import.meta.filename, '--child', PKG, root, outs[v]], { env, encoding: 'utf8', maxBuffer: 1 << 26 });
  if (r.status !== 0) { console.error(r.stdout, r.stderr); die(`the build with ${v === 'off' ? `${SWITCH}=0` : `no ${SWITCH}`} failed`); }
  times[v] = JSON.parse(r.stdout.trim().split('\n').at(-1)).ms;
  // with SN_RENDER_LOG=1: what the build rendered and what it left to the second pass, by reason
  for (const l of r.stderr.split('\n')) if (l.startsWith('sinter render:') || l.startsWith('sinter passes:') || l.startsWith('sinter from walk:')) console.log(`${v === 'off' ? `${SWITCH}=0` : 'default'}: ${l}`);
}
console.log(`builds: ${SWITCH}=0 ${times.off} ms, default ${times.on} ms`);

// ── The diff ──────────────────────────────────────────────────────────────────────────────────────────────────────
let differs = 0;
{
  const a = files(outs.off), b = files(outs.on);
  const onlyA = a.filter((f) => !b.includes(f)), onlyB = b.filter((f) => !a.includes(f));
  if (onlyA.length || onlyB.length) {
    differs++;
    console.log(`DIFFERENT file sets: only with SN_RENDER=0: ${onlyA.join(', ') || '-'}; only without: ${onlyB.join(', ') || '-'}`);
  }
  for (const f of a.filter((x) => b.includes(x))) {
    const x = readFileSync(join(outs.off, f)), y = readFileSync(join(outs.on, f));
    if (x.equals(y)) continue;
    if (!differs++) {
      let i = 0; while (i < x.length && i < y.length && x[i] === y[i]) i++;
      const ctx = (buf) => JSON.stringify(buf.subarray(Math.max(0, i - 120), i + 120).toString('utf8'));
      console.log(`DIFFERENT ${f} at byte ${i} (${x.length} vs ${y.length} bytes)\n  SN_RENDER=0: ${ctx(x)}\n  default:     ${ctx(y)}`);
    } else console.log(`DIFFERENT ${f}`);
  }
  console.log(differs ? `${differs} difference(s)` : `identical: ${a.length} files, byte for byte`);
}

// ── What each page is (from the default build) ──────────────────────────────────────────────────────────────────
const dist = outs.on;
const summary = {};
{
  const jsFiles = files(dist).filter((f) => f.endsWith('.js'));
  for (const [name, [route]] of Object.entries(PAGES)) {
    // (with clean URLs the page is <name>/index.html, and <name>.html a copy or a redirect)
    const p = existsSync(join(dist, `${name}/index.html`)) ? `${name}/index.html` : `${name}.html`;
    const html = readFileSync(join(dist, p), 'utf8');
    // the page's scripts and what they import, transitively (Vite's chunks import by relative path)
    const seen = new Set(), queue = [...html.matchAll(/<script type="module"[^>]*src="\/?([^"]+)"/g)].map((m) => m[1]);
    for (const m of html.matchAll(/<link rel="modulepreload"[^>]*href="\/?([^"]+)"/g)) queue.push(m[1]);
    while (queue.length) {
      const f = queue.pop();
      if (seen.has(f) || !jsFiles.includes(f)) continue;
      seen.add(f);
      for (const m of readFileSync(join(dist, f), 'utf8').matchAll(/from\s*["']\.\/([^"']+)["']|import\(\s*["']\.\/([^"']+)["']\)|import\s*["']\.\/([^"']+)["']/g)) queue.push(join(dirname(f), m[1] ?? m[2] ?? m[3]));
    }
    const js = [...seen].map((f) => readFileSync(join(dist, f)));
    const body = /<div class="mail[^>]*>([\s\S]*)<\/div><\/main>/.exec(html)?.[1] ?? '';
    summary[name] = {
      route, html: html.length, js: js.reduce((n, b) => n + b.length, 0), jsGzip: js.reduce((n, b) => n + gzipSync(b, { level: 9 }).length, 0),
      templates: (html.match(/<template id="sn-t-/g) ?? []).length, elements: (body.match(/<[a-z][a-z0-9]*[\s>]/g) ?? []).length,
    };
  }
  console.log('\npage              route   html B  templates  folded elements  JS B (gzip)');
  for (const [n, s] of Object.entries(summary)) console.log(`${n.padEnd(17)} ${s.route.padEnd(6)} ${String(s.html).padStart(7)} ${String(s.templates).padStart(10)} ${String(s.elements).padStart(16)}  ${s.js} (${s.jsGzip})`);
  // sanity: a file email ships no script; an API page does
  for (const [n, s] of Object.entries(summary)) {
    if (s.route === 'i' && s.js) { differs++; console.log(`UNEXPECTED: ${n} (an email from a file) ships ${s.js} B of JavaScript`); }
    if (s.route !== 'i' && !s.js) { differs++; console.log(`UNEXPECTED: ${n} (an email from an API) ships no JavaScript`); }
  }
}
if (KEEP) { mkdirSync(KEEP, { recursive: true }); for (const v of ['off', 'on']) cpSync(outs[v], join(KEEP, v), { recursive: true }); }

// ── The library's own suite ───────────────────────────────────────────────────────────────────────────────────────
const suite = {};
if (SUITE) {
  for (const s of ['typecheck', 'check', 'test']) {
    const t = performance.now();
    const r = spawnSync('npm', ['run', s], { cwd: PKG, encoding: 'utf8', maxBuffer: 1 << 26 });
    suite[s] = { ok: r.status === 0, ms: Math.round(performance.now() - t) };
    const tail = (r.stdout + r.stderr).trim().split('\n').filter((l) => /Tests|Test Files|error|fail|page\(s\)/i.test(l)).slice(-4).join(' | ');
    console.log(`suite: npm run ${s}: ${r.status === 0 ? 'ok' : 'FAILED'} (${suite[s].ms} ms) ${tail}`);
    if (r.status !== 0) differs++;
  }
}

// ── Run time ──────────────────────────────────────────────────────────────────────────────────────────────────────
if (BENCH) {
  const { chromium } = await import(join(PKG, 'node_modules/playwright/index.mjs'));
  let browser;
  try { browser = await chromium.launch(); } catch { browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? '/opt/pw-browsers/chromium' }); }
  const big = await newsletter(PKG, 2000);
  const TREES = { 'newsletter-2000': JSON.stringify(big), 'corpus-static': readFileSync(join(PKG, 'fixtures/trees/static.json'), 'utf8') };
  const count = (t) => { let n = 0; const w = (x) => { if (x.type === 'element') n++; if (x.type !== 'text') for (const c of x.children) w(c); }; w(t); return n; };
  let message = 'null';
  const server = createServer((req, res) => {
    const u = new URL(req.url ?? '/', 'http://x');
    if (u.pathname === '/api/message') { res.setHeader('Content-Type', 'application/json'); return res.end(message); }
    if (u.pathname === '/api/html') { res.setHeader('Content-Type', 'application/json'); return res.end('null'); }
    for (const p of u.pathname.endsWith('/') ? [u.pathname + 'index.html', u.pathname.slice(0, -1) + '.html'] : [u.pathname, u.pathname + '.html']) {
      try { const b = readFileSync(join(dist, p)); res.setHeader('Content-Type', p.endsWith('.js') ? 'text/javascript' : 'text/html'); return res.end(b); } catch {}
    }
    res.statusCode = 404; res.end();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}/`;
  const INIT = () => {
    window.__last = 0; window.__calls = 0;
    // the time of the last change inside the email's root (#message); changes elsewhere on the page do not count
    const inMail = (n) => { const e = n.nodeType === 1 ? n : n.parentElement; return !!e && (e.id === 'message' || !!e.closest('#message')); };
    new MutationObserver((rs) => { if (rs.some((r) => inMail(r.target))) window.__last = performance.now(); }).observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
    const P = CSSStyleDeclaration.prototype, o = P.setProperty;
    P.setProperty = function (...x) { window.__calls++; return o.apply(this, x); };
  };
  const result = {};
  for (const name of ['api', 'api-templates', 'api-fills']) {
    for (const [tname, tree] of Object.entries(TREES)) {
      message = tree;
      const n = count(JSON.parse(tree)), first = [], again = [], script = [];
      let calls = 0, comments = 0, rendered = 0, changedOnTick = false;
      const tick = [];
      for (let r = 0; r <= RUNS; r++) {
        const p = await browser.newPage();
        await p.addInitScript(INIT);
        const cdp = await p.context().newCDPSession(p);
        await cdp.send('Performance.enable');
        await p.goto(base + name + '/');
        // rendered: the body has elements and nothing has changed for 300 ms
        await p.waitForFunction(() => document.querySelectorAll('#message *').length > 0 && performance.now() - window.__last > 300, null, { polling: 20, timeout: 60000 });
        const t = await p.evaluate(() => {
          const api = performance.getEntriesByType('resource').find((e) => e.name.endsWith('/api/message'));
          return window.__last - api.responseEnd;
        });
        if (r === 0) calls = await p.evaluate(() => window.__calls);
        // #tick: the use evaluated again over the same body, five times; nothing in the email changes
        await p.evaluate(() => { window.__last = 0; });
        const k0 = Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map((x) => [x.name, x.value]));
        for (let i = 0; i < 5; i++) { await p.click('#tick'); await p.waitForFunction((j) => document.getElementById('tick').textContent === String(j), i + 1, { polling: 10 }); }
        const k1 = Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map((x) => [x.name, x.value]));
        const touched = await p.evaluate(() => window.__last > 0);
        // the same message again (`refresh`): a new tree of the same content, rendered over the one in place
        const before = await p.evaluate(() => { window.__last = 0; return performance.now(); });
        const m0 = Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map((x) => [x.name, x.value]));
        await p.click('#again');
        await p.waitForFunction(() => window.__last > 0 && performance.now() - window.__last > 300, null, { polling: 20, timeout: 60000 });
        const m1 = Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map((x) => [x.name, x.value]));
        const t2 = await p.evaluate((b) => { const api = performance.getEntriesByType('resource').filter((e) => e.name.endsWith('/api/message')).at(-1); return window.__last - Math.max(b, api.responseEnd); }, before);
        if (r === 0) {
          // the first load warms the HTTP and code caches; not counted
          [comments, rendered] = await p.evaluate(() => { let c = 0; const w = document.createTreeWalker(document.getElementById('message'), NodeFilter.SHOW_COMMENT); while (w.nextNode()) c++; return [c, document.querySelectorAll('#message *').length]; });
        } else { first.push(t); again.push(t2); script.push((m1.ScriptDuration - m0.ScriptDuration) * 1000); tick.push((k1.ScriptDuration - k0.ScriptDuration) * 1000 / 5); }
        changedOnTick ||= touched;
        await p.close();
      }
      result[`${name} ${tname}`] = { elements: n, firstRender: stats(first), sameAgain: stats(again), sameAgainScript: stats(script), tickScript: stats(tick), changedOnTick, rendered, setPropertyCalls: calls, comments };
      console.log(`bench ${name.padEnd(14)} ${tname.padEnd(16)} ${n} elements (${rendered} rendered): first render ${result[`${name} ${tname}`].firstRender.median} ms [${r1(Math.min(...first))}–${r1(Math.max(...first))}], same body again ${result[`${name} ${tname}`].sameAgain.median} ms (script ${result[`${name} ${tname}`].sameAgainScript.median} ms), same body re-evaluated: script ${result[`${name} ${tname}`].tickScript.median} ms${changedOnTick ? ' (THE EMAIL CHANGED)' : ''}; setProperty ${calls}, comments ${comments}`);
    }
  }
  await browser.close(); server.close();
  const weight = Object.fromEntries(Object.entries(summary).filter(([, s]) => s.route !== 'i').map(([n, s]) => [n, { js: s.js, jsGzip: s.jsGzip }]));
  console.log('\nJSON ' + JSON.stringify({ sinter: git(REPO, 'rev-parse', '--short', 'HEAD'), sinterMail: git(PKG, 'rev-parse', '--short', 'HEAD'), runs: RUNS, build: times, identical: !differs, weight, bench: result, suite }));
}

rmSync(work, { recursive: true, force: true });
process.exit(differs ? 1 : 0);
