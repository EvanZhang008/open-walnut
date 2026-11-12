/**
 * cloud-host-link-down.spec.ts: the real-replica fixture (tests/e2e/browser/cloud-host-server.ts)
 * with a switchable link between the Mac and the companion (CLOUD_HOST_LINK_CONTROL=1), cut on
 * purpose while a person writes to a session on it.
 *
 * One fixture per run: run one project at a time (`--project webkit` or `--project chromium`).
 * PW_VIDEO=1 records each test (one clip per scenario).
 *
 * Run: PW_WORKERS=1 PW_TEST_PORT=3473 ./node_modules/.bin/playwright test -c tests/e2e/browser/cloud-host-link-down.config.ts --project webkit
 */
import path from 'node:path'
import { defineConfig, devices } from '@playwright/test'
import { engageGate } from './pw-gate.js'
import { CHROMIUM_SILENT } from './pw-silence.js'
// Linux WebKit paints on the CPU: its GL painting threads crash the page on software GL.
import './pw-webkit-paint.js'
// Proof videos: recorded at the page's own size, with a pointer, encoded to MP4.
import { VIDEO_USE, withVideoReporter } from './pw-video.js'
// The fixture server runs on bun; only the Playwright runner stays on Node.
import { bunCommand } from '../../helpers/bun-runtime.js'

const port = Number(process.env.PW_TEST_PORT ?? 3473)
if (port === 3456) throw new Error('Production port is forbidden')
engageGate(port)
const repoRoot = path.resolve(import.meta.dirname, '../../..')
const view = { viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 }
export default defineConfig({
  testDir: '.',
  testMatch: ['cloud-host-link-down.spec.ts', 'cloud-host-flapping.spec.ts'],
  workers: 1,
  retries: 0,
  timeout: 300_000,
  reporter: withVideoReporter('list'),
  use: {
    baseURL: `http://localhost:${port}`,
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    video: VIDEO_USE,
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'], launchOptions: { args: CHROMIUM_SILENT }, ...view } },
    { name: 'webkit', use: { ...devices['Desktop Safari'], ...view } },
  ],
  webServer: {
    command: `${bunCommand()} tests/e2e/browser/cloud-host-server.ts`,
    cwd: repoRoot,
    url: `http://localhost:${port}/api/config`,
    env: { CLOUD_HOST_LINK_CONTROL: '1', PW_TEST_PORT: String(port) },
    reuseExistingServer: false,
    timeout: 300_000,
    stdout: 'pipe',
    stderr: 'pipe',
    gracefulShutdown: { signal: 'SIGTERM', timeout: 45_000 },
  },
})
