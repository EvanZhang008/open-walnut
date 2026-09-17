import path from 'node:path'
import { defineConfig, devices } from '@playwright/test'
import { engageGate } from './pw-gate.js'

const port = Number(process.env.PW_TEST_PORT ?? 3457)
if (port === 3456) throw new Error('Production port is forbidden')
engageGate(port)
export default defineConfig({
  testDir: '.',
  testMatch: 'warm-session.spec.ts',
  workers: 1,
  retries: 0,
  timeout: 120_000,
  reporter: 'list',
  use: {
    baseURL: `http://localhost:${port}`,
    viewport: { width: 1200, height: 800 },
    video: 'on',
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1200, height: 800 }, deviceScaleFactor: 1 } },
    { name: 'webkit', use: { ...devices['Desktop Safari'], viewport: { width: 1200, height: 800 }, deviceScaleFactor: 1 } },
  ],
  webServer: {
    command: './node_modules/.bin/tsx tests/e2e/browser/warm-session-server.ts',
    cwd: path.resolve(import.meta.dirname, '../../..'),
    url: `http://localhost:${port}/api/config`,
    reuseExistingServer: false,
    timeout: 120_000,
    gracefulShutdown: { signal: 'SIGTERM', timeout: 15_000 },
  },
})
