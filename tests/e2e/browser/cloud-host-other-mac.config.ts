/**
 * cloud-host-other-mac.spec.ts: the same real-replica fixture as
 * cloud-host.config.ts (tests/e2e/browser/cloud-host-server.ts), started as the
 * SECOND Mac of a companion that already serves another one.
 *
 * The takeover the spec walks is one way (the other Mac's pairing is gone after
 * it), so each engine gets a companion of its own: chromium on PW_TEST_PORT,
 * webkit on PW_TEST_PORT + 1. Running both engines in one invocation then sees
 * a fresh companion each time.
 *
 * Run: PW_WORKERS=1 PW_TEST_PORT=3467 ./node_modules/.bin/playwright test -c tests/e2e/browser/cloud-host-other-mac.config.ts
 *      (add --project=chromium or --project=webkit for one engine)
 */
import path from 'node:path'
import { defineConfig, devices } from '@playwright/test'
import { engageGate } from './pw-gate.js'

const port = Number(process.env.PW_TEST_PORT ?? 3467)
const ports = { chromium: port, webkit: port + 1 }
if (Object.values(ports).includes(3456)) throw new Error('Production port is forbidden')
engageGate(port)
const repoRoot = path.resolve(import.meta.dirname, '../../..')
const fixtureServer = (p: number) => ({
  command: './node_modules/.bin/tsx tests/e2e/browser/cloud-host-server.ts',
  cwd: repoRoot,
  url: `http://localhost:${p}/api/config`,
  env: { CLOUD_HOST_SECOND_MAC: '1', PW_TEST_PORT: String(p) },
  reuseExistingServer: false,
  timeout: 300_000,
  stdout: 'pipe' as const,
  stderr: 'pipe' as const,
  gracefulShutdown: { signal: 'SIGTERM' as const, timeout: 45_000 },
})
const view = { viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 }
export default defineConfig({
  testDir: '.',
  testMatch: 'cloud-host-other-mac.spec.ts',
  workers: 1,
  retries: 0,
  timeout: 300_000,
  reporter: 'list',
  use: {
    viewport: { width: 1280, height: 800 },
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'], ...view, baseURL: `http://localhost:${ports.chromium}` } },
    { name: 'webkit', use: { ...devices['Desktop Safari'], ...view, baseURL: `http://localhost:${ports.webkit}` } },
  ],
  webServer: [fixtureServer(ports.chromium), fixtureServer(ports.webkit)],
})
