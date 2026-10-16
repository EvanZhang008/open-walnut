/**
 * The host replica's browser specs (docs/plan/walnut-replica-servers-impl.md, WP7):
 * their own fixture (replica-server.ts: a real Mac, a host daemon twin, the
 * replica it supervises, a fake tunnel), because the shared :3457 fixture has
 * no host and no replica.
 *
 * Port 3472 (the tunnel the browser opens), control port 3473. The same
 * machine-wide gate as playwright.config.ts (pw-gate.ts), on this port.
 * One worker: the specs share one Mac, and putting it to sleep is the test.
 *
 * Run: ./node_modules/.bin/playwright test -c tests/e2e/browser/replica.config.ts --project=webkit-phone
 *      (projects: webkit-phone, webkit-desktop, chromium-phone, chromium-desktop; WebKit
 *      first, the Mac app's engine). REPLICA_TWIN=standalone runs the host daemon's
 *      bun twin; REPLICA_APP=built serves the page and its assets from the replica
 *      itself (a real build of this tree: npm run build, then the web build).
 */
import path from 'node:path'
import { defineConfig, devices } from '@playwright/test'
import { engageGate } from './pw-gate.js'

const port = Number(process.env.PW_TEST_PORT ?? 3472)
if (port === 3456 || port === 3457) throw new Error(`port ${port} is not this config's`)
engageGate(port)

const phone = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 1 }
const desktop = { viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 }

export default defineConfig({
  testDir: '.',
  testMatch: 'replica-away-read.spec.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 300_000,
  reporter: 'list',
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'webkit-phone', use: { ...devices['Desktop Safari'], ...phone } },
    { name: 'webkit-desktop', use: { ...devices['Desktop Safari'], ...desktop } },
    { name: 'chromium-phone', use: { ...devices['Desktop Chrome'], ...phone } },
    { name: 'chromium-desktop', use: { ...devices['Desktop Chrome'], ...desktop } },
  ],
  webServer: {
    // node itself, not the tsx CLI: on SIGTERM the CLI waits 30 ms for its child to
    // report the signal, then SIGKILLs it, so a fixture busy at that moment died
    // before it stopped the cluster and its replica ran on. One process, one handler.
    command: `${JSON.stringify(process.execPath)} --import tsx tests/e2e/browser/replica-server.ts`,
    cwd: path.resolve(import.meta.dirname, '../../..'),
    // The control port opens last, once the replica holds its first copies.
    url: `http://127.0.0.1:${port + 1}/control/ready`,
    reuseExistingServer: false,
    // A cold Mac, a cold replica and the first copy rounds; minutes on a loaded machine.
    timeout: 900_000,
    stdout: 'pipe',
    stderr: 'pipe',
    gracefulShutdown: { signal: 'SIGTERM', timeout: 60_000 },
  },
})
