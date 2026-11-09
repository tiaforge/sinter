// End-to-end test of sinter across page loads, in headless Chrome: next-page data, Speculation
// Rules and data-sn-transition morphs. Builds the pages, starts server.mjs, runs the scenarios
// and exits non-zero on any failure.
//   CHROME=/path/to/chrome node run.mjs
// Prerendering (`speculation: 'prerender'`) is not covered: Chrome does not prerender while
// DevTools drives it (PrerenderingDisabledByDevTools); test/behaviour/speculation.test.ts covers
// what sinter does on activation.
import { spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { evaluate, launch } from '../../bench/swap/cdp.mjs';
import { start } from './server.mjs';

const here = fileURLToPath(new URL('.', import.meta.url));
if (spawnSync('npx', ['vite', 'build', '--logLevel', 'warn'], { cwd: here, stdio: 'inherit' }).status) process.exit(1);

/** Polls `fn` until it returns {ok: true}; fails with the last value seen. */
async function until(what, fn, ms = 10_000) {
  const t0 = Date.now();
  let last;
  while (Date.now() - t0 < ms) {
    last = await fn();
    if (last.ok) return last.value;
    await delay(25);
  }
  throw new Error(`${what}; last seen: ${JSON.stringify(last?.value)}`);
}

// recorded on every page before its own scripts: when the page is first shown, whether it was
// prefetched, and the view-transition groups once the transition is ready
const PROBE = `addEventListener('securitypolicyviolation', (e) => {
  const v = JSON.parse(sessionStorage.getItem('csp') ?? '[]');
  v.push(location.pathname + ': ' + e.violatedDirective + ' ' + (e.blockedURI || 'inline'));
  sessionStorage.setItem('csp', JSON.stringify(v));
});
addEventListener('pagereveal', (e) => {
  const nav = performance.getEntriesByType('navigation')[0];
  const out = { title: document.getElementById('title')?.textContent ?? null, delivery: nav?.deliveryType ?? null, transition: !!e.viewTransition, groups: [] };
  sessionStorage.setItem('probe:' + location.pathname, JSON.stringify(out));
  e.viewTransition?.ready.then(() => {
    out.groups = [...new Set(document.getAnimations().map((a) => a.effect?.pseudoElement).filter((x) => x?.startsWith('::view-transition-group')))];
    sessionStorage.setItem('probe:' + location.pathname, JSON.stringify(out));
  }, () => {});
});`;

const server = await start();
const chrome = await launch();
const results = [];
const ctl = async (path) => (await fetch(`${server.url}/control/${path}`, { method: path.startsWith('log') ? 'GET' : 'POST' })).json();

async function tab(fn) {
  const { send, once } = chrome;
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  const s = (method, params) => send(method, params, sessionId);
  try {
    await s('Page.enable');
    await s('Page.addScriptToEvaluateOnNewDocument', { source: PROBE });
    const loaded = once('Page.loadEventFired', sessionId);
    await s('Page.navigate', { url: server.url + '/' });
    await loaded;
    return await fn(s);
  } finally {
    await send('Target.closeTarget', { targetId });
  }
}
const js = (s, expr) => evaluate(s, expr);
/** the center of the element `selector` matches, in CSS pixels */
const center = (s, selector) => until(`no ${selector}`, async () => {
  const r = await js(s, `(() => { const r = document.querySelector(${JSON.stringify(selector)})?.getBoundingClientRect(); return r && r.width ? { x: r.x + r.width / 2, y: r.y + r.height / 2 } : null; })()`);
  return { ok: !!r, value: r };
});
const hover = async (s, selector) => { const { x, y } = await center(s, selector); await s('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y }); };
const click = async (s, selector) => {
  const { x, y } = await center(s, selector);
  await s('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  await s('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
  await s('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
};
const at = (s, path) => until(`should be at ${path}`, async () => {
  const value = await js(s, 'location.pathname').catch(() => null);
  return { ok: value === path && (await js(s, `document.readyState`).catch(() => '')) === 'complete', value };
});
const probe = (s, path) => js(s, `JSON.parse(sessionStorage.getItem('probe:${path}') ?? 'null')`);

async function step(name, fn) {
  try { await fn(); results.push([name, 'ok']); } catch (e) { results.push([name, `FAILED: ${e.message}`]); } finally { await ctl('delay?ms=0'); }
}

try {
  await tab(async (s) => {
    await ctl('reset');
    await step('the list loads', () => until('three items', async () => ({ ok: (await js(s, `document.querySelectorAll('#items li').length`)) === 3 })));

    await step('resting on a link requests that page\'s data and its HTML (Speculation Rules)', async () => {
      await hover(s, 'a[href="/item/2"]');
      await until('GET /api/items/2 and a speculative /item/2', async () => {
        const log = await ctl('log');
        const data = log.some((l) => l.path === '/api/items/2' && !l.purpose), doc = log.some((l) => l.path === '/item/2' && /prefetch/.test(l.purpose ?? ''));
        return { ok: data && doc, value: log.map((l) => `${l.path} ${l.purpose ?? ''}`.trim()) };
      }, 5000);
    });

    await step('following it: the item shows the prefetched data at its first paint, then the server\'s', async () => {
      await ctl('delay?ms=1500');
      await click(s, 'a[href="/item/2"]');
      await at(s, '/item/2');
      const p = await until('a probe', async () => { const v = await probe(s, '/item/2'); return { ok: !!v, value: v }; });
      if (p.title !== 'Item 2 (answer 1)') throw new Error(`first paint showed ${JSON.stringify(p.title)}, not the prefetched title`);
      if (p.delivery !== 'navigational-prefetch') throw new Error(`the navigation did not use the prefetched HTML (${p.delivery})`);
      await until('the revalidated title', async () => { const v = await js(s, `document.getElementById('title').textContent`); return { ok: v === 'Item 2 (answer 2)', value: v }; }, 5000);
    });

    await step('the item\'s title morphed from the list row', async () => {
      const p = await until('the transition', async () => { const v = await probe(s, '/item/2'); return { ok: v?.groups?.length > 0, value: v }; });
      if (!p.groups.some((g) => /\(sn-\w+\)/.test(g))) throw new Error(`no morph, groups: ${p.groups.join(', ')}`);
      // the names go once the transition has finished
      await until('no element still named after the transition', async () => {
        const named = await js(s, `[...document.querySelectorAll('[data-sn-vt]')].filter((el) => el.style.viewTransitionName).length`);
        return { ok: named === 0, value: named };
      }, 3000);
    });

    await step('going back morphs the title into its row again (the list is reloaded; with `cache`, its rows are there at its first paint, however slow the API)', async () => {
      await ctl('delay?ms=1500');
      await js(s, `sessionStorage.removeItem('probe:/')`);
      await js(s, `history.back()`);
      await at(s, '/');
      const p = await until('the transition', async () => { const v = await probe(s, '/'); return { ok: v?.groups?.length > 0, value: v }; });
      if (!p.groups.some((g) => /\(sn-\w+\)/.test(g))) throw new Error(`no morph, groups: ${p.groups.join(', ')}`);
    });

    await step('under script-src \'self\', nothing was blocked on either page (no inline script, rules from the header)', async () => {
      const v = await js(s, `JSON.parse(sessionStorage.getItem('csp') ?? '[]')`);
      if (v.length) throw new Error(v.join('; '));
    });
  });
} finally {
  // the profile directory can outlive a killed Chrome by a moment: not a test failure
  await chrome.close().catch(() => {});
  await server.close();
}

for (const [name, r] of results) console.log(`${r === 'ok' ? 'ok  ' : 'FAIL'} ${name}${r === 'ok' ? '' : `\n     ${r}`}`);
process.exit(results.every(([, r]) => r === 'ok') ? 0 : 1);
