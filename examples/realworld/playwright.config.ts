import { defineConfig } from '@playwright/test';
import { baseConfig } from './e2e/playwright.base';

// The official RealWorld e2e suite (e2e/, unchanged) against `vite preview` of the built app.
// CHROME=<path> uses a local Chrome instead of a Playwright-downloaded browser.
export default defineConfig({
  ...baseConfig,
  reporter: [['list'], ['json', { outputFile: 'test-results/results.json' }]],
  retries: 0,
  use: {
    ...baseConfig.use,
    baseURL: 'http://localhost:4173',
    ...(process.env.CHROME ? { launchOptions: { executablePath: process.env.CHROME } } : {}),
  },
  webServer: {
    command: 'npm run build && npm run preview',
    url: 'http://localhost:4173',
    reuseExistingServer: true,
    timeout: 120_000,
  },
});
