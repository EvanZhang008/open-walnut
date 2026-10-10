/**
 * Its own config and fixture (tests/e2e/browser/host-alone-server.ts): the page
 * a host server serves while it answers alone needs a real daemon, a real host
 * server and a session, none of which the shared :3457 fixture has.
 *
 * Run: PW_WORKERS=1 ./node_modules/.bin/playwright test -c tests/e2e/browser/host-alone.config.ts --project=chromium
 *      PW_WORKERS=1 ./node_modules/.bin/playwright test -c tests/e2e/browser/host-alone.config.ts --project=webkit
 */
import path from 'node:path'
import { defineConfig, devices } from '@playwright/test'
import { engageGate } from './pw-gate.js'

const port = Number(process.env.PW_TEST_PORT ?? 3468)
if (port === 3456) throw new Error('Production port is forbidden')
engageGate(port)
export default defineConfig({
  testDir: '.',
  testMatch: 'host-alone.spec.ts',
  workers: 1,
  retries: 0,
  timeout: 120_000,
  reporter: 'list',
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  // A phone-sized window: the page is for a phone first.
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 390, height: 844 }, deviceScaleFactor: 1 } },
    { name: 'webkit', use: { ...devices['Desktop Safari'], viewport: { width: 390, height: 844 }, deviceScaleFactor: 1 } },
  ],
  webServer: {
    command: './node_modules/.bin/tsx tests/e2e/browser/host-alone-server.ts',
    cwd: path.resolve(import.meta.dirname, '../../..'),
    // The control port opens last, once the Mac's device list is in and the Mac is gone.
    url: `http://127.0.0.1:${port + 1}/control/ready`,
    reuseExistingServer: false,
    timeout: 180_000,
    stdout: 'pipe',
    stderr: 'pipe',
    gracefulShutdown: { signal: 'SIGTERM', timeout: 30_000 },
  },
})
