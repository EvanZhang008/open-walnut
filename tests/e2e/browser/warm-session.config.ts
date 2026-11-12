/**
 * Its own fixture (tests/e2e/browser/warm-session-server.ts): the BUILT server and SPA
 * (dist/web), a mock CLI that keeps its turn open, its own data home.
 *
 * Run: bun run build && (cd web && bun x vite build), then
 *      bun x playwright test -c tests/e2e/browser/warm-session.config.ts --project=chromium
 */
import os from 'node:os'
import path from 'node:path'
import { defineConfig, devices } from '@playwright/test'
import { engageGate } from './pw-gate.js'
// Every test browser is silent: an init script in every frame, and Chromium's own mute.
import { CHROMIUM_SILENT } from './pw-silence.js'
// Linux WebKit paints on the CPU: its GL painting threads crash the page on software GL.
import './pw-webkit-paint.js'
// Proof videos: recorded at the page's own size, with a pointer, encoded to MP4.
import { VIDEO_USE, withVideoReporter } from './pw-video.js'
// The fixture server runs on bun; only the Playwright runner stays on Node.
import { bunCommand } from '../../helpers/bun-runtime.js'

// Its own port, off the shared fixture's :3457; the spec reads it back from the env.
process.env.PW_TEST_PORT ??= '3517'
const port = Number(process.env.PW_TEST_PORT)
if (port === 3456) throw new Error('Production port is forbidden')
engageGate(port)
process.env.WARM_FIXTURE_MANIFEST ??= path.join(os.tmpdir(), `walnut-warm-fixture-${port}.json`)
export default defineConfig({
  testDir: '.',
  testMatch: 'warm-session.spec.ts',
  workers: 1,
  retries: 0,
  timeout: 120_000,
  reporter: withVideoReporter('list'),
  use: {
    baseURL: `http://localhost:${port}`,
    viewport: { width: 1200, height: 800 },
    video: VIDEO_USE,
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'], launchOptions: { args: CHROMIUM_SILENT }, viewport: { width: 1200, height: 800 }, deviceScaleFactor: 1 } },
    { name: 'webkit', use: { ...devices['Desktop Safari'], viewport: { width: 1200, height: 800 }, deviceScaleFactor: 1 } },
  ],
  webServer: {
    command: `${bunCommand()} tests/e2e/browser/warm-session-server.ts`,
    cwd: path.resolve(import.meta.dirname, '../../..'),
    url: `http://localhost:${port}/api/config`,
    reuseExistingServer: false,
    timeout: 120_000,
    gracefulShutdown: { signal: 'SIGTERM', timeout: 15_000 },
  },
})
