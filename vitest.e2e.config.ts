import { defineConfig } from 'vitest/config';
import { maxWorkers, workerExecArgv } from './tests/setup/worker-budget';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    globalSetup: ['tests/setup/global-setup.ts'],
    // Same harness as vitest.config.ts, runtime-dir-isolation first (it loads
    // prod-server-guard). Without it every e2e server ran the real semantic
    // search lane: a fresh WALNUT_HOME downloads the ~600MB embedding model
    // and loads it, and on CI one such load outlived the embed worker's stop
    // grace and took the test process down with no report (2026-10-02).
    setupFiles: ['tests/setup/runtime-dir-isolation.ts', 'tests/setup/git-env-isolation.ts', 'tests/setup/tmp-reaper.ts', 'tests/setup/worker-watchdog.ts'],
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
