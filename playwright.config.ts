import { defineConfig } from '@playwright/test';

/**
 * Browser smoke tests.
 *
 * These run against the *production build* (`vite preview`), which is the thing players get, and use
 * the Chrome already installed on the machine rather than downloading a browser — CI installs
 * Chromium explicitly instead (see `.github/workflows/ci.yml`).
 *
 * The tests drive the game deterministically through `window.__optimus` (installed by `?test=1`), so
 * they assert on real state rather than sleeping and hoping.
 */

const chromeExecutable = process.env.CHROME_PATH ?? '/usr/local/bin/google-chrome';
const useSystemChrome = process.env.PLAYWRIGHT_USE_SYSTEM_CHROME !== '0';

export default defineConfig({
  testDir: 'tests/e2e',
  outputDir: 'test-results',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI === undefined ? 0 : 1,
  reporter: process.env.CI === undefined ? [['list']] : [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: 'http://127.0.0.1:4173',
    viewport: { width: 1280, height: 760 },
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    ...(useSystemChrome
      ? { launchOptions: { executablePath: chromeExecutable, args: ['--no-sandbox', '--disable-dbus'] } }
      : { launchOptions: { args: ['--no-sandbox'] } }),
  },
  webServer: {
    command: 'npm run preview',
    url: 'http://127.0.0.1:4173',
    reuseExistingServer: process.env.CI === undefined,
    timeout: 60_000,
  },
});
