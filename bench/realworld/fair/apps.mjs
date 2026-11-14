// How each implementation is served: a static build by serveStatic (world.mjs), one with a server (SvelteKit) by
// its own Node process, whose server-side fetches go to the world's plain-HTTP API with no proxy.
import { spawn } from 'node:child_process';
import { join, resolve } from 'node:path';
import { IMPLEMENTATIONS } from './implementations.mjs';
import { serveStatic } from './world.mjs';

// sinter's page for each path, as in examples/realworld's vite.config.js (bench/realworld/serve.mjs does the same)
const SINTER_ROUTES = [[/^\/(tag\/[^/]+)?$/, 'index'], [/^\/login$/, 'login'], [/^\/register$/, 'register'], [/^\/settings$/, 'settings'], [/^\/editor(\/[^/]+)?$/, 'editor'], [/^\/article\/[^/]+$/, 'article'], [/^\/profile\/[^/]+(\/favorites)?$/, 'profile']];
export const SINTER_DIST = resolve(import.meta.dirname, '../../../examples/realworld/dist');

function node(script, w) {
  return async () => {
    const port = 30000 + Math.floor(Math.random() * 20000);
    const env = { ...process.env, PORT: String(port), HOST: '127.0.0.1', ORIGIN: `http://127.0.0.1:${port}`, REALWORLD_API: w.apiHttp };
    for (const k of Object.keys(env)) if (/proxy/i.test(k)) delete env[k];
    const child = spawn(process.execPath, [script], { env, stdio: ['ignore', 'ignore', 'inherit'] });
    for (let i = 0; i < 100; i++) { try { await fetch(`http://127.0.0.1:${port}/`); break; } catch { await new Promise((ok) => setTimeout(ok, 100)); } }
    return { url: `http://127.0.0.1:${port}/`, close: async () => child.kill() };
  };
}

/** name → () => Promise<{ url, close }> */
export function apps(work, w, sinterDist = SINTER_DIST) {
  const out = { sinter: () => serveStatic({ dist: sinterDist, routes: SINTER_ROUTES }) };
  for (const impl of IMPLEMENTATIONS) {
    out[impl.name] = impl.server ? node(join(work, impl.dir, impl.server), w) : () => serveStatic({ dist: join(work, impl.dir, impl.dist) });
  }
  return out;
}
