// @vitest-environment node
// Lazy packages in a minified build (Vite's default): the build writes each loader's chunk URL over a
// mark, and a minifier must not turn the runtime's own code into something that patch matches. Every
// chunk parses, and in Chromium the package loads through each path: an app module's stub, a
// component script that loads with it, and a helper module a let waits for.
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parse } from 'acorn';
import { build, preview, type PreviewServer } from 'vite';
import { afterAll, beforeAll, expect, test } from 'vitest';
import sinter from '../../src/vite.js';
import { chromium } from '../browser.js';

const src = resolve(__dirname, '../../src');
const alias = [{ find: /^@tiaforge-ui\/sinter\/(.+)$/, replacement: `${src}/$1.ts` }, { find: /^@tiaforge-ui\/sinter$/, replacement: `${src}/index.ts` }];
const root = mkdtempSync(join(tmpdir(), 'sinter-lazy-min-'));
const out = join(root, 'dist');
afterAll(() => rmSync(root, { recursive: true, force: true }));
const put = (f: string, s: string) => { mkdirSync(join(root, f, '..'), { recursive: true }); writeFileSync(join(root, f), s); };

beforeAll(async () => {
  put('node_modules/slowpkg/package.json', JSON.stringify({ name: 'slowpkg', version: '1.0.0', type: 'module', main: 'index.js' }));
  put('node_modules/slowpkg/index.js', `globalThis.__slowpkg = 'SLOWPKG_BODY';
export async function shout(t) { return t.toUpperCase() + '!'; }
export function parse(t) { return '<' + t + '>'; }
export class Thing { say(n) { return 'thing ' + n; } }
`);
  // an app module (an action) calling the package through its stubs
  put('src/sinter.actions.ts', `import { shout } from 'slowpkg';\nexport async function loud(t: string) { return await shout(t); }\n`);
  // a component script that loads with the package
  put('src/components/x-ring.html', '<template data-sn-props="{ n: number }"><p data-sn-state="{ said: \'\' }"><span class="said" data-sn-text="said"></span></p></template>\n');
  put('src/components/x-ring.ts', `import { XRingComponent } from './x-ring.html';
import { Thing } from 'slowpkg';
export class XRing extends XRingComponent { connected() { this.state.said = new Thing().say(this.props.n); } }
`);
  // a helper module a let waits for (it reaches the package)
  put('src/sinter.helpers.ts', `export * as crunch from './lib/crunch.ts';\n`);
  put('src/lib/crunch.ts', `import { parse } from 'slowpkg';\nexport function render(s: string) { return parse(s); }\n`);
  put('index.html', `<!doctype html><html><head><title>lazy</title></head><body>
<div data-sn-state="{ out: '', src: 'hi' }">
  <button id="go" data-sn-call="loud('hi')" data-sn-then="out = $result">go</button>
  <output id="out" data-sn-text="out"></output>
  <x-ring data-sn-with="{ n: 3 }"></x-ring>
  <p id="crunched" data-sn-let="{ c: crunch.render(src) }" data-sn-text="c ?? 'waiting'"></p>
</div>
</body></html>`);
  // the default: minified
  await build({ root, logLevel: 'silent', plugins: [sinter({ lazy: ['slowpkg'] })], resolve: { alias }, build: { outDir: out, emptyOutDir: true } });
}, 120_000);

const chunks = () => readdirSync(join(out, 'assets')).filter((f) => f.endsWith('.js'));
const read = (f: string) => readFileSync(join(out, 'assets', f), 'utf8');

test('every chunk of a minified build parses, and no mark is left in it', () => {
  expect(chunks().length).toBeGreaterThan(1);
  for (const f of chunks()) {
    const code = read(f);
    expect(() => parse(code, { ecmaVersion: 'latest', sourceType: 'module' }), f).not.toThrow();
    expect(code, f).not.toContain('__SN_CHUNK__');
  }
  // the loader knows its chunk's URL (for the stale check), and the package is a chunk of its own
  expect(chunks().filter((f) => read(f).includes('SLOWPKG_BODY'))).toHaveLength(1);
  expect(chunks().map(read).join('\n')).toMatch(/"\.\/[\w.-]+\.js",import\.meta\.url\)/);
});

test.skipIf(!chromium)('in Chromium the package loads through an app module, a component script and a waiting let', async () => {
  let server: PreviewServer | null = null;
  const browser = await chromium!.launch();
  try {
    server = await preview({ root, logLevel: 'silent', build: { outDir: out }, preview: { port: 0 } });
    const tab = await browser.newPage();
    const errors: string[] = [];
    tab.on('pageerror', (e) => errors.push(e.message));
    await tab.goto(server.resolvedUrls!.local[0]!);
    await tab.waitForFunction(() => document.querySelector('.said')?.textContent === 'thing 3');
    await tab.waitForFunction(() => document.querySelector('#crunched')?.textContent === '<hi>');
    await tab.click('#go');
    await tab.waitForFunction(() => document.querySelector('#out')?.textContent === 'HI!');
    expect(errors).toEqual([]);
  } finally {
    await browser.close();
    await new Promise<void>((r) => (server ? server.httpServer.close(() => r()) : r()));
  }
}, 120_000);
