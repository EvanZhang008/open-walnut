/**
 * Its own config and fixture (tests/e2e/browser/cloud-host-server.ts): the shared
 * :3457 fixture has no companion, and this one needs a real replica beside it.
 *
 * Run: PW_WORKERS=1 ./node_modules/.bin/playwright test -c tests/e2e/browser/cloud-host.config.ts --project=chromium
 *      PW_WORKERS=1 ./node_modules/.bin/playwright test -c tests/e2e/browser/cloud-host.config.ts --project=webkit
 */
import path from 'node:path'
import { defineConfig, devices } from '@playwright/test'
import { engageGate } from './pw-gate.js'

const port = Number(process.env.PW_TEST_PORT ?? 3466)
if (port === 3456) throw new Error('Production port is forbidden')
engageGate(port)
export default defineConfig({
  testDir: '.',
  testMatch: 'cloud-host.spec.ts',
  workers: 1,
  retries: 0,
  timeout: 240_000,
  reporter: 'list',
  use: {
    baseURL: `http://localhost:${port}`,
    viewport: { width: 1280, height: 800 },
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 } },
    { name: 'webkit', use: { ...devices['Desktop Safari'], viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 } },
  ],
  webServer: {
    command: './node_modules/.bin/tsx tests/e2e/browser/cloud-host-server.ts',
    cwd: path.resolve(import.meta.dirname, '../../..'),
    url: `http://localhost:${port}/api/config`,
    reuseExistingServer: false,
    timeout: 300_000,
    stdout: 'pipe',
    stderr: 'pipe',
    gracefulShutdown: { signal: 'SIGTERM', timeout: 45_000 },
  },
})
