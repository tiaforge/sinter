// `data-sn-on-sn-navigate` (docs/proposals/swap-navigation.md): a handler for every navigation while its
// element is on the page, run before anything acts; `$event.preventDefault()` refuses it. Here without the
// Navigation API (the test environment has none): links by the click listener, calls by the chain;
// e2e/links runs the same with the `navigate` event in three browsers.
import { expect, test } from 'vitest';
import { compile } from '../../src/compiler/index.js';
import { render } from '../../src/testing/index.js';

const PAGE = `
  <form data-sn-state="{ dirty: false, seen: '' }" data-sn-on-input="dirty = true"
        data-sn-on-sn-navigate="seen = $event.kind + ' ' + $event.to + ' ' + ($event.trigger?.id ?? '-'); dirty && $event.preventDefault()">
    <input id="field"><b id="seen" data-sn-text="seen"></b>
    <button id="clean" type="button" data-sn-on-click="dirty = false"></button>
  </form>
  <button id="go" data-sn-on-click="navigate('/next')"></button>
  <a id="away" href="/elsewhere">away</a>`;

async function setup() {
  const r = await render(PAGE, { url: 'http://localhost/' });
  await r.settle();
  const click = async (id: string) => {
    const ev = new MouseEvent('click', { bubbles: true, cancelable: true });
    r.root.querySelector(`#${id}`)!.dispatchEvent(ev);
    await r.settle();
    return ev.defaultPrevented;
  };
  const type = async () => { r.root.querySelector('#field')!.dispatchEvent(new Event('input', { bubbles: true })); await r.settle(); };
  return { ...r, click, type, seen: () => r.root.querySelector('#seen')!.textContent };
}

test('the handler sees every navigation: its kind, where to, and what started it', async () => {
  const p = await setup();
  await p.click('go');
  expect(p.seen()).toBe('push http://localhost/next go');
  expect(p.navigations).toEqual(['http://localhost/next']);
});

test('$event.preventDefault() refuses a navigate() call and a link; once allowed, they go', async () => {
  const p = await setup();
  await p.type();
  await p.click('go');
  expect(p.navigations).toEqual([]);
  // a link: the click's default is prevented, so the browser does not follow it
  expect(await p.click('away')).toBe(true);
  expect(p.seen()).toBe('push http://localhost/elsewhere away');
  await p.click('clean');
  await p.click('go');
  expect(p.navigations).toEqual(['http://localhost/next']);
  expect(await p.click('away')).toBe(false);
});

test('the build marks the element and loads the feature; the mark is all that stays', () => {
  const out = compile(`<!doctype html><html><head><title>x</title></head><body>${PAGE}</body></html>`, {
    file: '/p/index.html', root: '/p', dev: false, helpers: { module: null, names: [], namespaces: {} }, readFile: () => { throw new Error('none'); },
  });
  expect(out.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
  expect(out.html).toMatch(/<form data-sn="\d+" data-sn-navigate="">|<form data-sn-navigate=""[^>]*>/);
  expect(out.html).not.toContain('data-sn-on-sn-navigate');
  expect(out.module).toContain("from '@tiaforge-ui/sinter/runtime/navigate'");
});
