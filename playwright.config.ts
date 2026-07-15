import { defineConfig, devices } from '@playwright/test'

export default defineConfig({
  testDir: 'tests/e2e/browser',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 4 : undefined,
  reporter: 'list',
  timeout: 30_000,

  use: {
    baseURL: 'http://localhost:3457',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    // Managed/sandboxed environments ship a pre-installed Chromium whose build
    // number may not match this Playwright version — let them point at it
    // instead of downloading (e.g. PW_EXECUTABLE_PATH=/opt/pw-browsers/chromium).
    ...(process.env.PW_EXECUTABLE_PATH
      ? { launchOptions: { executablePath: process.env.PW_EXECUTABLE_PATH } }
      : {}),
  },

  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],

  webServer: {
    command: 'npx tsx tests/e2e/browser/test-server.ts',
    url: 'http://localhost:3457/api/dashboard',
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
    stdout: 'pipe',
    stderr: 'pipe',
  },
})
