import { defineConfig, devices } from '@playwright/test'
import { perRunWorkers } from './tests/e2e/browser/pw-concurrency.js'
import { engageGate } from './tests/e2e/browser/pw-gate.js'

const testPort = Number(process.env.PW_TEST_PORT ?? 3457)

// Machine-wide admission control. MUST run here, at config load: Playwright boots
// the webServer plugin before globalSetup, so this is the only hook early enough
// to queue behind a concurrent run and to reap an orphaned fixture server before
// `reuseExistingServer` silently attaches to it. See tests/e2e/browser/pw-gate.ts.
engageGate(testPort)

export default defineConfig({
  testDir: 'tests/e2e/browser',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  // `undefined` here used to mean "half the cores" (7 on this Mac) — 28 chromium
  // processes and ~2.7 GB per run, with nothing coordinating concurrent runs.
  // Overrides: PW_WORKERS (per run), PW_NO_GATE=1 (skip the port lease).
  workers: perRunWorkers(),
  reporter: 'list',
  timeout: 30_000,

  use: {
    baseURL: `http://localhost:${testPort}`,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },

  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
    // The desktop app is a WKWebView, so a desktop-only scroll/paint bug needs a
    // WebKit run to count as verified. Opt in: PW_WEBKIT=1 … --project webkit
    ...(process.env.PW_WEBKIT ? [{ name: 'webkit', use: { ...devices['Desktop Safari'] } }] : []),
  ],

  webServer: {
    // Local binary, NOT `npx tsx`: tsx was never a declared dependency, so every
    // run paid npx's registry-resolution path — measured at 88s for a bare
    // `npx tsx --version` on this machine, which alone blew the old 30s budget.
    command: './node_modules/.bin/tsx tests/e2e/browser/test-server.ts',
    url: `http://localhost:${testPort}/api/dashboard`,
    reuseExistingServer: !process.env.CI,
    // Cold boot of the fixture (real server + vite + isolated daemon) measured at
    // ~20s on an idle Mac; under load it blew past the old 30s ceiling and the run
    // died with "Timed out waiting 30000ms from config.webServer" — which reads
    // like an app bug but is just a starved machine. 120s absorbs that.
    timeout: 120_000,
    stdout: 'pipe',
    stderr: 'pipe',
  },
})
