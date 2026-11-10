// examples/realworld served by sinter-axum's example server (packages/sinter-axum/examples/realworld.rs),
// which writes each page's API data into the page. The build (SINTER_EMBED=1) names the public API
// (https://api.realworld.show); the server fetches it from `api` instead, over plain HTTP, as a server
// reaches its API on an internal address: a copy of the build whose sinter-embed.json names `api`.
// The browser's own requests still go to the public origin.
//   cargo build --release --features upstream --example realworld   (in packages/sinter-axum)
//   const s = await serveAxum({ dist: 'dist-embed', api: 'http://127.0.0.1:4400' }); … s.url … await s.close();
import { spawn } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const app = resolve(import.meta.dirname, '../../examples/realworld');
const bin = resolve(import.meta.dirname, '../../packages/sinter-axum/target/release/examples/realworld');
const PUBLIC_API = 'https://api.realworld.show';

const freePort = () => new Promise((ok) => { const s = createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => ok(port)); }); });

/** `dist`: relative to examples/realworld; `api`: the origin the server fetches the data from */
export async function serveAxum({ dist, api }) {
  const dir = mkdtempSync(join(tmpdir(), 'rw-axum-'));
  cpSync(resolve(app, dist), dir, { recursive: true });
  const manifest = join(dir, 'sinter-embed.json');
  writeFileSync(manifest, readFileSync(manifest, 'utf8').replaceAll(PUBLIC_API, api));
  const port = await freePort();
  const child = spawn(bin, [dir, String(port), api], { stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise((ok, fail) => {
    child.once('error', fail);
    child.once('exit', (code) => fail(new Error(`sinter-axum exited (${code})`)));
    child.stdout.once('data', ok);
  });
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise((ok) => { child.removeAllListeners('exit'); child.once('exit', () => { rmSync(dir, { recursive: true, force: true }); ok(); }); child.kill(); }),
  };
}
