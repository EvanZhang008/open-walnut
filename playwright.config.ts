import fs from 'node:fs'
import path from 'node:path'
import { defineConfig, devices } from '@playwright/test'
import { perRunWorkers } from './tests/e2e/browser/pw-concurrency.js'
import { engageGate } from './tests/e2e/browser/pw-gate.js'
import { bunCommand } from './tests/helpers/bun-runtime.js'

const testPort = Number(process.env.PW_TEST_PORT ?? 3457)

// Machine-wide admission control. MUST run here, at config load: Playwright boots
// the webServer plugin before globalSetup, so this is the only hook early enough
// to queue behind a concurrent run and to reap an orphaned fixture server before
// `reuseExistingServer` silently attaches to it. See tests/e2e/browser/pw-gate.ts.
engageGate(testPort)

// Specs that swap the fixture server's one host fixture (POST /api/test/host-fixture)
// race each other when two workers run them at once: one loads its hosts while the
// other's test reads them (2026-10-29: banner-placement-round4 N3-2 failed 2 of 3 runs
// beside system-attention :267). They run in their own project, one at a time, while
// every other spec stays parallel. Found by what they call, so a new one joins itself.
const HOST_FIXTURE_CALL = /\b(?:loadFixture|hostFixture|resetServerHostFixture)\(/
const browserDir = path.join(import.meta.dirname, 'tests/e2e/browser')
const hostFixtureSpecs = fs.readdirSync(browserDir)
  .filter((f) => f.endsWith('.spec.ts') && HOST_FIXTURE_CALL.test(fs.readFileSync(path.join(browserDir, f), 'utf8')))
  .map((f) => `**/${f}`)

export default defineConfig({
  testDir: 'tests/e2e/browser',
  // Its own fixture and config (tests/e2e/browser/replica.config.ts); the main
  // config runs replica-smoke.spec.ts for that path instead.
  testIgnore: ['**/replica-away-read.spec.ts', '**/replica-away-write.spec.ts', '**/replica-away-notes.spec.ts', '**/replica-away-ask.spec.ts'],
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
    // PW_VIDEO=1 records every test (demo/verification clips); pair with
    // `--output <dir>` outside test-results/, which peer runs wipe.
    video: process.env.PW_VIDEO ? 'on' : 'off',
    // The task panel opens Flat (web/src/components/tasks/panel-design.ts), its status
    // sections and no list. The specs written against the list remember By project, in
    // every page's storage, so a spec that serves its own ui-prefs keeps it too; a spec
    // about Flat presets it (status-section-helpers.ts presetPanelDesign).
    storageState: {
      cookies: [],
      origins: [{ origin: `http://localhost:${testPort}`, localStorage: [{ name: 'walnut-todo-panel-design', value: 'project' }] }],
    },
  },

  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
      testIgnore: hostFixtureSpecs,
    },
    {
      name: 'chromium-host-fixture',
      use: { ...devices['Desktop Chrome'] },
      testMatch: hostFixtureSpecs,
      workers: 1,
    },
    // The desktop app is a WKWebView, so a desktop-only scroll/paint bug needs a
    // WebKit run to count as verified. Opt in: PW_WEBKIT=1 … --project webkit
    // The replica smoke is one chromium spec (its WebKit runs are replica.config.ts's).
    ...(process.env.PW_WEBKIT ? [{ name: 'webkit', use: { ...devices['Desktop Safari'] }, testIgnore: ['**/replica-away-read.spec.ts', '**/replica-away-write.spec.ts', '**/replica-away-notes.spec.ts', '**/replica-away-ask.spec.ts', '**/replica-smoke.spec.ts'] }] : []),
  ],

  webServer: {
    // The fixture server runs on bun (tests/helpers/bun-runtime.ts), which runs
    // its TypeScript as it is; only this runner stays on Node. Never `npx`: its
    // registry resolution alone once took 88s here, past the whole boot budget.
    command: `${bunCommand()} tests/e2e/browser/test-server.ts`,
    url: `http://localhost:${testPort}/api/dashboard`,
    reuseExistingServer: !process.env.CI,
    // Cold boot of the fixture (real server + vite + isolated daemon) measured at
    // ~20s on an idle Mac; under load it blew past the old 30s ceiling and the run
    // died with "Timed out waiting 30000ms from config.webServer" — which reads
    // like an app bug but is just a starved machine. 120s absorbs that.
    timeout: 120_000,
    stdout: 'pipe',
    stderr: 'pipe',
    // Without this Playwright ends EVERY run with SIGKILL on the fixture's process
    // group (playwright-core processLauncher), so test-server.ts's SIGTERM handler
    // — the only thing that stops its isolated daemon and removes its tmpdir —
    // never ran, and each run left a `walnut-pw-<ts>` dir behind (401 of them on
    // 2026-09-13). SIGTERM first; SIGKILL still follows if the handler hangs.
    gracefulShutdown: { signal: 'SIGTERM', timeout: 15_000 },
  },
})
