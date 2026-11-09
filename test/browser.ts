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
