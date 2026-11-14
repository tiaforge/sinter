// Shared helpers for the graders: build and serve a workspace the way the prompt says, run named checks.
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { setTimeout as sleep } from 'node:timers/promises';

export const { chromium } = createRequire(import.meta.url)('playwright');

/** Runs a command to completion; resolves { code, out } (stdout+stderr, last 8 KB). */
export function run(cmd, args, { cwd, env, timeout = 600_000 } = {}) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { cwd, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    const add = (d) => { out = (out + d).slice(-8192); };
    p.stdout.on('data', add); p.stderr.on('data', add);
    const t = setTimeout(() => p.kill('SIGKILL'), timeout);
    p.on('close', (code) => { clearTimeout(t); resolve({ code, out }); });
  });
}

/** Starts a long-running process; returns { proc, output(), stop() }. */
export function start(cmd, args, { cwd, env } = {}) {
  const proc = spawn(cmd, args, { cwd, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  let out = '';
  const add = (d) => { out = (out + d).slice(-8192); };
  proc.stdout.on('data', add); proc.stderr.on('data', add);
  return { proc, output: () => out, stop: () => { try { process.kill(-proc.pid, 'SIGKILL'); } catch {} } };
}

export async function waitForUrl(url, ms = 60_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try { const r = await fetch(url); if (r.status < 500) return true; } catch {}
    await sleep(300);
  }
  return false;
}

/** install → build → preview on `port`. Returns { install, build, server, ok } with logs. */
export async function buildAndServe(dir, port, env = {}) {
  const install = await run('npm', ['install', '--no-audit', '--no-fund'], { cwd: dir, env });
  const build = install.code === 0 ? await run('npm', ['run', 'build'], { cwd: dir, env }) : { code: null, out: 'skipped' };
  let server = null, up = false;
  if (build.code === 0) {
    server = start('npm', ['run', 'preview', '--', '--port', String(port), '--host', '127.0.0.1'], { cwd: dir, env });
    up = await waitForUrl(`http://127.0.0.1:${port}/`);
  }
  return { install, build, server, ok: up };
}

/** Runs each check in its own browser context; a check throws to fail. Returns [{ name, pass, error }]. */
export async function runChecks(checks, { before, baseURL, javaScriptEnabled = true } = {}) {
  const browser = await chromium.launch();
  const results = [];
  for (const [name, fn] of Object.entries(checks)) {
    // a reset between checks; retried, since a reused keep-alive socket can be closed under it
    if (before) for (let i = 0; i < 3; i++) { try { await before(); break; } catch (e) { if (i === 2) throw e; await sleep(300); } }
    const context = await browser.newContext({ baseURL, javaScriptEnabled });
    const page = await context.newPage();
    page.setDefaultTimeout(5000);
    const consoleErrors = [];
    page.on('pageerror', (e) => consoleErrors.push(String(e)));
    let pass = false, error = null;
    try { await fn(page, { consoleErrors }); pass = true; } catch (e) { error = String(e.message ?? e).split('\n').slice(0, 3).join(' '); }
    results.push({ name, pass, error, pageErrors: consoleErrors.slice(0, 3) });
    await context.close();
  }
  await browser.close();
  return results;
}

export const assert = (cond, msg) => { if (!cond) throw new Error(msg); };
