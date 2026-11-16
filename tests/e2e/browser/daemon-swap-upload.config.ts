/**
 * Own fixtures for uploads through a restart, each a real server on its own port:
 *   - daemon-swap-upload-server.ts: a local daemon compiled twice from this checkout,
 *     replaced mid-upload the way a deploy replaces it (PW_TEST_PORT, 3541);
 *   - server-restart-upload-server.ts: a production-mode server stopped and started
 *     again mid-paste the way a deploy restarts it (RESTART_FIXTURE_PORT, the next port).
 *
 *   PW_TEST_PORT=3541 ./node_modules/.bin/playwright test -c tests/e2e/browser/daemon-swap-upload.config.ts --project=chromium
 * (it needs the built web app: bun run build && (cd web && bun x vite build)).
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
// The other upload-through-a-restart fixture: a real server stopped and started mid-paste
// (server-restart-upload-server.ts), on its own port beside this one.
const restartPort = Number(process.env.RESTART_FIXTURE_PORT ?? port + 1)
if (restartPort === 3456) throw new Error('Production port is forbidden')
process.env.RESTART_FIXTURE_PORT = String(restartPort)
process.env.RESTART_FIXTURE_MANIFEST ??= path.join(os.tmpdir(), `walnut-restart-upload-fixture-${restartPort}.json`)

export default defineConfig({
  testDir: '.',
  testMatch: ['daemon-swap-upload.spec.ts', 'server-restart-upload.spec.ts'],
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
  webServer: [{
    command: `${bunCommand()} tests/e2e/browser/daemon-swap-upload-server.ts`,
    cwd: path.resolve(import.meta.dirname, '../../..'),
    url: `http://localhost:${port}/api/config`,
    reuseExistingServer: false,
    timeout: 300_000,
    stdout: 'pipe',
    gracefulShutdown: { signal: 'SIGTERM', timeout: 20_000 },
  }, {
    // It serves the built web app (dist/web/static), as the Mac's server does.
    command: `${bunCommand()} tests/e2e/browser/server-restart-upload-server.ts`,
    cwd: path.resolve(import.meta.dirname, '../../..'),
    url: `http://localhost:${restartPort}/api/config`,
    reuseExistingServer: false,
    timeout: 300_000,
    stdout: 'pipe',
    gracefulShutdown: { signal: 'SIGTERM', timeout: 30_000 },
  }],
})
