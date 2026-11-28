// @vitest-environment node
// A `<dialog popover>` opened as a popover (`showPopover()`, a `popovertarget` button) has no `open` attribute: its
// bindings, which wait while a dialog is closed, render when it opens that way too, and follow state while it is
// open. The test DOMs have no popovers, so this runs in Chromium on a real build.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { build, preview, type PreviewServer } from 'vite';
import { afterAll, expect, test } from 'vitest';
import sinter from '../../src/vite.js';
import { chromium } from '../browser.js';

const src = resolve(__dirname, '../../src');
const alias = [{ find: /^@tiaforge-ui\/sinter\/runtime$/, replacement: `${src}/runtime-entry.ts` }, { find: /^@tiaforge-ui\/sinter\/(?:runtime\/)?(.+)$/, replacement: `${src}/$1.ts` }, { find: /^@tiaforge-ui\/sinter$/, replacement: `${src}/index.ts` }];
const root = mkdtempSync(join(tmpdir(), 'sinter-dialog-popover-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

test.skipIf(!chromium)('a `<dialog popover>` renders when it opens as a popover, as a modal, and follows state while open', async () => {
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, 'index.html'), `<!doctype html><html><head><title>t</title></head><body>
<div data-sn-state="{ n: 1, pick: 'b', xs: ['a', 'b'] }">
<p id="n" data-sn-text="n"></p><button id="inc" data-sn-on-click="n++; xs = [...xs, 'x' + n]">+</button>
<button id="open" popovertarget="dp">open</button>
<dialog popover id="dp"><b data-sn-text="'n ' + n"></b>
<select data-sn-model="pick"><template data-sn-for="x in xs" data-sn-key="x"><option data-sn-attr="{ value: x }" data-sn-text="x"></option></template></select>
<dialog id="inner"><i data-sn-text="'inner ' + n"></i></dialog></dialog>
<dialog id="plain"><u data-sn-text="'plain ' + n"></u></dialog>
</div></body></html>`);
  const out = join(root, 'dist');
  await build({ root, logLevel: 'silent', plugins: [sinter()], resolve: { alias }, build: { outDir: out, emptyOutDir: true } });
  let server: PreviewServer | null = null;
  const browser = await chromium!.launch();
  try {
    server = await preview({ root, logLevel: 'silent', build: { outDir: out }, preview: { port: 0 } });
    const tab = await browser.newPage();
    const errors: string[] = [];
    tab.on('pageerror', (e) => errors.push(e.message));
    await tab.goto(server.resolvedUrls!.local[0]!);
    await tab.waitForFunction(() => document.querySelector('#n')?.textContent === '1');
    const text = (sel: string) => tab.evaluate((s) => document.querySelector(s)?.textContent ?? null, sel);
    const has = (sel: string, want: string) => tab.waitForFunction(([s, w]) => document.querySelector(s!)?.textContent === w, [sel, want], { timeout: 3000 });
    const script = (code: string) => tab.evaluate(code);
    await tab.click('#inc');
    await has('#n', '2');
    // closed: it waits (the build wrote the first value)
    expect(await text('#dp b')).toBe('n 1');
    expect(await script(`document.querySelectorAll('#dp option').length`)).toBe(0);
    // its button opens it as a popover: no \`open\` attribute, and it renders (on its \`toggle\`)
    await tab.click('#open');
    await has('#dp b', 'n 2');
    expect(await script(`[document.querySelector('#dp').hasAttribute('open'), document.querySelector('#dp').matches(':popover-open')]`)).toEqual([false, true]);
    // a select in it takes its model's value once its options are there
    expect(await script(`[document.querySelectorAll('#dp option').length, document.querySelector('#dp select').value]`)).toEqual([3, 'b']);
    // open: it follows state
    await script(`document.querySelector('#inc').click()`);
    await has('#dp b', 'n 3');
    // a dialog in it waits for its own opening
    expect(await text('#inner i')).toBe('inner 1');
    await script(`document.querySelector('#inner').show()`);
    await has('#inner i', 'inner 3');
    await script(`document.querySelector('#inner').close()`);
    // closed again: it waits again; opened by a script: it renders
    await script(`document.querySelector('#dp').hidePopover()`);
    await script(`document.querySelector('#inc').click()`);
    await has('#n', '4');
    expect(await text('#dp b')).toBe('n 3');
    await script(`document.querySelector('#dp').showPopover()`);
    await has('#dp b', 'n 4');
    await script(`document.querySelector('#dp').hidePopover()`);
    // the same dialog opened as a modal, and a dialog without \`popover\`, as before
    await script(`document.querySelector('#inc').click()`);
    await has('#n', '5');
    await script(`document.querySelector('#dp').showModal()`);
    await has('#dp b', 'n 5');
    await script(`document.querySelector('#dp').close()`);
    expect(await text('#plain u')).toBe('plain 1');
    await script(`document.querySelector('#plain').showModal()`);
    await has('#plain u', 'plain 5');
    expect(errors).toEqual([]);
  } finally {
    await browser.close();
    await new Promise<void>((r) => (server ? server.httpServer.close(() => r()) : r()));
  }
}, 120_000);
