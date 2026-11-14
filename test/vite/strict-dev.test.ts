// Strict mode in the dev server: a page's warnings fail it like errors, and the runtime's warnings
// are printed in the terminal and shown in Vite's overlay.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'vite';
import { afterAll, expect, test } from 'vitest';
import sinter from '../../src/vite.js';
import { chromium } from '../browser.js';

const src = resolve(__dirname, '../../src');
const alias = [{ find: /^@tiaforge-ui\/sinter\/(.+)$/, replacement: `${src}/$1.ts` }, { find: /^@tiaforge-ui\/sinter$/, replacement: `${src}/index.ts` }];
const root = mkdtempSync(join(tmpdir(), 'sinter-strict-dev-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const page = (body: string) => `<!doctype html><html lang="en"><head><title>t</title></head><body>${body}</body></html>`;
// duplicate keys: a runtime warning (the list is state a handler writes, so it is not unrolled at build time)
writeFileSync(join(root, 'index.html'), page('<ul data-sn-state="{ xs: [1, 1] }"><template data-sn-for="x in xs" data-sn-key="x"><li data-sn-text="x"></li></template><button data-sn-on-click="xs = []">clear</button></ul>'));
writeFileSync(join(root, 'stale.html'), page('<p data-sn-text="Date.now()"></p>'));

const logs: string[] = [];
const logger = { info: () => {}, warn: (m: string) => { logs.push(`warn ${m}`); }, warnOnce: () => {}, error: (m: string) => { logs.push(`error ${m}`); }, clearScreen: () => {}, hasErrorLogged: () => false, hasWarned: false } as never;

test('strict dev server: a page warning fails the page', async () => {
  const server = await createServer({ root, customLogger: logger, resolve: { alias }, server: { port: 0, hmr: false, ws: false }, plugins: [sinter({ strict: true, images: false })] });
  try {
    await expect(server.transformIndexHtml('/stale.html', page('<p data-sn-text="Date.now()"></p>'))).rejects.toThrow(/error SN502 non-reactive-value[\s\S]*--allow SN502/);
  } finally { await server.close(); }
  const relaxed = await createServer({ root, customLogger: logger, resolve: { alias }, server: { port: 0, hmr: false, ws: false }, plugins: [sinter({ images: false })] });
  try {
    expect(await relaxed.transformIndexHtml('/stale.html', page('<p data-sn-text="Date.now()"></p>'))).not.toContain('warn-relay');
  } finally { await relaxed.close(); }
});

test.skipIf(!chromium)('strict dev server: a runtime warning is printed in the terminal and shown in the overlay', { timeout: 60_000 }, async () => {
  const server = await createServer({ root, customLogger: logger, resolve: { alias }, server: { port: 0 }, plugins: [sinter({ strict: true, images: false })] });
  await server.listen();
  const browser = await chromium!.launch();
  try {
    const tab = await browser.newPage();
    await tab.goto(`http://localhost:${(server.httpServer!.address() as { port: number }).port}/`);
    await expect.poll(() => logs.find((l) => l.includes('sinter (browser, /)')), { timeout: 20_000 }).toMatch(/^error sinter \(browser, \/\): duplicate key in `data-sn-for`/);
    await tab.waitForSelector('vite-error-overlay', { state: 'attached', timeout: 10_000 });
    expect(await tab.evaluate(() => document.querySelector('vite-error-overlay')!.shadowRoot!.textContent)).toContain('duplicate key in `data-sn-for`');
  } finally {
    await browser.close();
    await server.close();
  }
});
