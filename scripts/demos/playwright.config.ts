/**
 * Run: bun x playwright test -c scripts/demos/playwright.config.ts [<demo name>]
 *
 * Demo recordings (*.demo.ts here), not tests: each drives the real UI against the
 * browser suite's fixture server and records a video. No test config or CI job runs
 * them (tests/setup/test-file-coverage-guard.test.ts). The fixture server, the
 * machine-wide gate and the silent browser are the browser suite's own
 * (playwright.config.ts).
 */
import path from 'node:path'
import { defineConfig, devices } from '@playwright/test'
import base from '../../playwright.config'
import { CHROMIUM_SILENT } from '../../tests/e2e/browser/pw-silence.js'

const repoRoot = path.resolve(import.meta.dirname, '../..')

export default defineConfig({
  ...base,
  testDir: '.',
  testMatch: '*.demo.ts',
  testIgnore: [],
  outputDir: path.join(repoRoot, 'test-results/demos'),
  // Two demos share one fixture session: one at a time.
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 120_000,
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], launchOptions: { args: CHROMIUM_SILENT } } }],
  webServer: { ...(base.webServer as object), cwd: repoRoot } as typeof base.webServer,
})
