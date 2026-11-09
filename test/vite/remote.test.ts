// @vitest-environment node
// Images from the API through the Vite plugin (docs/images.md, step 2): the dev server's resizing
// service, its origin checks, and a build's page module with the production template.
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer as http, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import sharp from 'sharp';
import { build, createLogger, createServer } from 'vite';
import { afterAll, beforeAll, expect, test } from 'vitest';
import sinter from '../../src/vite.js';

const src = resolve(__dirname, '../../src');
const alias = [{ find: /^@tiaforge-ui\/sinter\/(.+)$/, replacement: `${src}/$1.ts` }, { find: /^@tiaforge-ui\/sinter$/, replacement: `${src}/index.ts` }];
const root = mkdtempSync(join(tmpdir(), 'sinter-remote-'));
let uploads: Server, origin = '';
let photo: Buffer;

beforeAll(async () => {
  const w = 800, h = 600, raw = Buffer.alloc(w * h * 3);
  for (let i = 0; i < raw.length; i++) raw[i] = (i * 2654435761) % 251;
  photo = await sharp(raw, { raw: { width: w, height: h, channels: 3 } }).jpeg().toBuffer();
  // the API's image origin
  uploads = http((req, res) => { if (req.url === '/a.jpg') { res.setHeader('Content-Type', 'image/jpeg'); res.end(photo); } else { res.statusCode = 404; res.end(); } });
  await new Promise<void>((r) => uploads.listen(0, '127.0.0.1', () => r()));
  origin = `http://127.0.0.1:${(uploads.address() as { port: number }).port}`;
  mkdirSync(join(root, 'public/media'), { recursive: true });
  writeFileSync(join(root, 'public/media/b.jpg'), photo);
  writeFileSync(join(root, 'index.html'), `<!doctype html><html><head><style>.av img { width: 40px; height: 40px; object-fit: cover }</style></head><body>
<sn-resource name="contacts" src="/api/contacts" key="id"></sn-resource>
<ul><template data-sn-for="c in contacts"><li class="av"><img alt="" data-sn-attr="{src: c.avatar}"></li></template></ul>
</body></html>`);
});
afterAll(() => { uploads?.close(); rmSync(root, { recursive: true, force: true }); });

test('dev: the page uses the dev server\'s service; it resizes allowed origins and its own paths, and refuses others', async () => {
  const server = await createServer({ root, logLevel: 'silent', resolve: { alias }, server: { port: 0, hmr: false, ws: false }, plugins: [sinter({ images: { remote: { url: 'cloudflare', origins: ['self', origin] } } })] });
  try {
    await server.listen();
    const port = (server.httpServer!.address() as { port: number }).port;
    await server.transformIndexHtml('/index.html', readFileSync(join(root, 'index.html'), 'utf8'));
    const mod = await server.transformRequest('/@sinter/index.html.js');
    expect(mod?.code).toContain('"url":"/@sinter/remote?url={url}&w={w}&q={q}","cover":"/@sinter/remote?url={url}&w={w}&h={h}&q={q}"');
    expect(mod?.code).toContain('$ri.set(($.c.avatar), [40,80,120], 1)');
    const get = (q: string, accept = 'image/avif,image/webp,*/*') => fetch(`http://localhost:${port}/@sinter/remote?${q}`, { headers: { accept } });

    const a = await get(`url=${encodeURIComponent(`${origin}/a.jpg`)}&w=80&h=80&q=75`);
    expect([a.status, a.headers.get('content-type'), a.headers.get('vary')]).toEqual([200, 'image/avif', 'Accept']);
    const m = await sharp(Buffer.from(await a.arrayBuffer())).metadata();
    expect([m.width, m.height]).toEqual([80, 80]);
    // no AVIF in Accept: JPEG; width only: the ratio kept
    const j = await get(`url=${encodeURIComponent(`${origin}/a.jpg`)}&w=200&q=75`, 'image/jpeg,*/*');
    expect(j.headers.get('content-type')).toBe('image/jpeg');
    expect((await sharp(Buffer.from(await j.arrayBuffer())).metadata()).height).toBe(150);
    // a same-origin path: from the dev server itself
    const b = await get(`url=${encodeURIComponent('/media/b.jpg')}&w=100&q=75`, 'image/webp');
    expect([b.status, b.headers.get('content-type')]).toEqual([200, 'image/webp']);
    // not allowed, not valid
    expect((await get(`url=${encodeURIComponent('https://elsewhere.example.org/x.jpg')}&w=80`)).status).toBe(403);
    expect((await get(`url=${encodeURIComponent(`${origin}/a.jpg`)}&w=99999`)).status).toBe(400);
    expect((await get(`url=${encodeURIComponent(`${origin}/missing.jpg`)}&w=80`)).status).toBe(502);
  } finally {
    await server.close();
  }
}, 30_000);

test('build: the production template in the page bundle; Vercel is told the widths', async () => {
  const out = join(root, 'dist');
  const logs: string[] = [];
  const logger = createLogger('info', { allowClearScreen: false });
  logger.info = (m) => { logs.push(m); };
  await build({ root, customLogger: logger, resolve: { alias }, build: { outDir: out, emptyOutDir: true, minify: false }, plugins: [sinter({ images: { remote: { url: 'vercel', origins: ['self', origin] } } })] });
  const js = readdirSync(join(out, 'assets')).filter((f) => f.endsWith('.js')).map((f) => readFileSync(join(out, 'assets', f), 'utf8')).join('\n');
  expect(js).toContain('/_vercel/image?url={url}&w={w}&q={q}');
  expect(js).not.toContain('@sinter/remote');
  const html = readFileSync(join(out, 'index.html'), 'utf8');
  expect(html).toMatch(/<img alt="" width="40" height="40" sizes="\(max-width: 40px\) 100vw, 40px" loading="lazy" decoding="async">/);
  expect(logs.join('\n')).toContain('"images": { "sizes": [40, 80, 120]');
}, 30_000);

test('a config that cannot work fails at once', () => {
  expect(() => sinter({ images: { remote: { url: 'https://img.example.com/{url}', origins: ['self'] } } })).toThrow(/needs \{url\} \(or \{url:raw\}\) and \{w\}/);
});

let chromium: { launch(): Promise<{ newPage(o: object): Promise<{ goto(u: string): Promise<unknown>; waitForFunction(f: () => unknown): Promise<unknown>; evaluate<T>(f: () => T): Promise<T> }>; close(): Promise<void> }> } | null = null;
try { chromium = (await import('node:module')).createRequire(import.meta.url)('playwright').chromium; } catch { /* skipped */ }

test.skipIf(!chromium)('in Chromium at 2x: the rows load the 80 px file of the dev service', async () => {
  const api = { name: 'api', configureServer(s: { middlewares: { use(f: (req: { url?: string }, res: { setHeader(k: string, v: string): void; end(b: string): void }, next: () => void) => void): void } }) {
    s.middlewares.use((req, res, next) => {
      if (req.url !== '/api/contacts') return next();
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify([{ id: 1, avatar: `${origin}/a.jpg` }, { id: 2, avatar: '/media/b.jpg' }]));
    });
  } };
  const server = await createServer({ root, logLevel: 'silent', resolve: { alias }, server: { port: 0, hmr: false, ws: false }, plugins: [api, sinter({ images: { remote: { url: 'cloudflare', origins: ['self', origin] } } })] });
  await server.listen();
  const browser = await chromium!.launch();
  try {
    const tab = await browser.newPage({ viewport: { width: 800, height: 600 }, deviceScaleFactor: 2 });
    await tab.goto(`http://localhost:${(server.httpServer!.address() as { port: number }).port}/`);
    await tab.waitForFunction(() => { const i = [...document.querySelectorAll('li img')] as HTMLImageElement[]; return i.length === 2 && i.every((x) => x.complete && x.naturalWidth > 0); });
    const r = await tab.evaluate(() => ([...document.querySelectorAll('li img')] as HTMLImageElement[]).map((i) => [new URL(i.currentSrc).searchParams.get('w'), new URL(i.currentSrc).searchParams.get('h'), i.getBoundingClientRect().width]));
    expect(r).toEqual([['80', '80', 40], ['80', '80', 40]]);
  } finally {
    await browser.close();
    await server.close();
  }
}, 60_000);
