/**
 * Own fixture for the Changed tab's commit view: a real local daemon compiled
 * from this checkout, a real git repo with a bare remote, two mock-CLI sessions.
 *
 *   PW_TEST_PORT=3514 ./node_modules/.bin/playwright test -c tests/e2e/browser/session-commit.config.ts --project=chromium
 *   PW_TEST_PORT=3514 PW_WEBKIT=1 ./node_modules/.bin/playwright test -c tests/e2e/browser/session-commit.config.ts --project=webkit
 */
import os from 'node:os'
import path from 'node:path'
import { defineConfig, devices } from '@playwright/test'
import { engageGate } from './pw-gate.js'

const port = Number(process.env.PW_TEST_PORT ?? 3514)
if (port === 3456) throw new Error('Production port is forbidden')
engageGate(port)
process.env.SESSION_COMMIT_MANIFEST ??= path.join(os.tmpdir(), `walnut-session-commit-fixture-${port}.json`)

export default defineConfig({
  testDir: '.',
  testMatch: 'session-commit.spec.ts',
  // Out of the shared test-results/, which other agents' runs wipe mid-run.
  outputDir: path.join(os.tmpdir(), `walnut-session-commit-results-${port}`),
  workers: 1,
  retries: 0,
  timeout: 300_000,
  reporter: 'list',
  use: {
    baseURL: `http://localhost:${port}`,
    viewport: { width: 1280, height: 860 },
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 860 }, deviceScaleFactor: 1 } },
    { name: 'webkit', use: { ...devices['Desktop Safari'], viewport: { width: 1280, height: 860 }, deviceScaleFactor: 1 } },
  ],
  webServer: {
    command: './node_modules/.bin/tsx tests/e2e/browser/session-commit-server.ts',
    cwd: path.resolve(import.meta.dirname, '../../..'),
    url: `http://localhost:${port}/api/config`,
    reuseExistingServer: false,
    timeout: 300_000,
    stdout: 'pipe',
    gracefulShutdown: { signal: 'SIGTERM', timeout: 20_000 },
  },
})
