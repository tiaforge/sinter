// Chromium for the tests that check against a real browser (layout, the dev image check, built
// pages). Playwright is a dev dependency; without its browser (`npx playwright install chromium`)
// those tests are skipped locally, and fail in CI, so the checks cannot stop running unnoticed.
import { existsSync } from 'node:fs';
import { chromium as pw, type BrowserType } from 'playwright';

function load(): BrowserType | null {
  let ok = false;
  try { ok = existsSync(pw.executablePath()); } catch { /* no browser */ }
  if (ok) return pw;
  if (process.env.CI) throw new Error('Chromium for Playwright is missing: run `npx playwright install --with-deps chromium`');
  return null;
}

export const chromium = load();

/**
 * Every engine installed for Playwright, for the tests that should hold in each: Chromium (required in
 * CI, as above), and Firefox and WebKit when they are installed (`npx playwright install firefox webkit`).
 * `SINTER_FIREFOX` / `SINTER_WEBKIT`: an executable elsewhere.
 */
export async function engines(): Promise<Array<{ name: string; type: BrowserType; executablePath?: string }>> {
  const { firefox, webkit } = await import('playwright');
  const out: Array<{ name: string; type: BrowserType; executablePath?: string }> = chromium ? [{ name: 'chromium', type: chromium }] : [];
  for (const [name, type, env] of [['firefox', firefox, process.env.SINTER_FIREFOX], ['webkit', webkit, process.env.SINTER_WEBKIT]] as const) {
    let path = env;
    if (!path) { try { path = type.executablePath(); } catch { path = undefined; } }
    if (path && existsSync(path)) out.push({ name, type, ...(env ? { executablePath: env } : {}) });
  }
  return out;
}
