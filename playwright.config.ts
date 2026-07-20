import { defineConfig, devices } from '@playwright/test'

const testPort = Number(process.env.PW_TEST_PORT ?? 3457)

export default defineConfig({
  testDir: 'tests/e2e/browser',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 4 : undefined,
  reporter: 'list',
  timeout: 30_000,

  use: {
    baseURL: `http://localhost:${testPort}`,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },

  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],

  webServer: {
    command: 'npx tsx tests/e2e/browser/test-server.ts',
    url: `http://localhost:${testPort}/api/dashboard`,
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
    stdout: 'pipe',
    stderr: 'pipe',
  },
})
