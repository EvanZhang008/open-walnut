import { defineConfig } from 'vitest/config';
import { maxWorkers, workerExecArgv } from './tests/setup/worker-budget';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    globalSetup: ['tests/setup/global-setup.ts'],
    // Per-worker parent-liveness watchdog — see vitest.config.ts.
    setupFiles: ['tests/setup/worker-watchdog.ts'],
    include: ['tests/e2e/**/*.test.ts'],
    exclude: ['**/*.live.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    pool: 'forks',
    // Machine-wide budget — see tests/setup/worker-budget.ts. Deliberately
    // maxWorkers (not poolOptions.forks.maxForks): maxForks would override the
    // --maxWorkers CLI flag and silently defeat any external throttle.
    maxWorkers: maxWorkers(),
    poolOptions: {
      forks: {
        execArgv: workerExecArgv(),
      },
    },
  },
});
