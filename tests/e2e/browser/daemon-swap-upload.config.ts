/**
 * Own fixture for an upload through a daemon swap (daemon-swap-upload-server.ts): a real
 * local daemon compiled twice from this checkout, replaced mid-upload the way a deploy
 * replaces it.
 *
 *   PW_TEST_PORT=3541 ./node_modules/.bin/playwright test -c tests/e2e/browser/daemon-swap-upload.config.ts --project=webkit
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

const port = Number(process.env.PW_TEST_PORT ?? 3541)
if (port === 3456) throw new Error('Production port is forbidden')
engageGate(port)
process.env.DAEMON_SWAP_MANIFEST ??= path.join(os.tmpdir(), `walnut-daemon-swap-fixture-${port}.json`)

export default defineConfig({
  testDir: '.',
  testMatch: 'daemon-swap-upload.spec.ts',
  // Out of the shared test-results/, which other agents' runs wipe mid-run.
  outputDir: path.join(os.tmpdir(), `walnut-daemon-swap-upload-results-${port}`),
  workers: 1,
  retries: 0,
  timeout: 300_000,
  reporter: withVideoReporter('list'),
  use: {
    baseURL: `http://localhost:${port}`,
    viewport: { width: 1280, height: 860 },
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    video: VIDEO_USE,
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'], launchOptions: { args: CHROMIUM_SILENT }, viewport: { width: 1280, height: 860 }, deviceScaleFactor: 1 } },
    { name: 'webkit', use: { ...devices['Desktop Safari'], viewport: { width: 1280, height: 860 }, deviceScaleFactor: 1 } },
  ],
  webServer: {
    command: `${bunCommand()} tests/e2e/browser/daemon-swap-upload-server.ts`,
    cwd: path.resolve(import.meta.dirname, '../../..'),
    url: `http://localhost:${port}/api/config`,
    reuseExistingServer: false,
    timeout: 300_000,
    stdout: 'pipe',
    gracefulShutdown: { signal: 'SIGTERM', timeout: 20_000 },
  },
})
