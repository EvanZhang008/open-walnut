import { defineConfig } from 'vitest/config';
import { E2E_MAX_WORKERS, maxWorkers, workerExecArgv } from './tests/setup/worker-budget';
import { runtimeAliases, runtimeDeps } from './tests/setup/runtime-deps';
import baseConfig from './vitest.config';

export default defineConfig({
  // `#ws` on bun: see tests/setup/runtime-deps.ts. The web aliases too, so a scenario that
  // checks what a web surface shows (tests/e2e/task-status-scenarios.test.ts) reads web/src.
  resolve: { alias: { ...(baseConfig.resolve?.alias as Record<string, string>), ...runtimeAliases(import.meta.dirname) } },
  test: {
    globals: true,
    environment: 'node',
    globalSetup: ['tests/setup/global-setup.ts'],
    // The related-open-tasks check (src/core/sessions/related-open-tasks.ts) refuses a
    // session's create that looks like an open task, and other features' fixtures make
    // look-alike tasks from sessions on purpose (for one, api-v1-task-title-brake posts
    // the same long title from several sessions into one server). Off here. Its own tests
    // (related-open-rank, api-v1-task-create-related*) turn it on, including a normal
    // lead-and-workers flow that must never be refused (api-v1-task-create-related).
    env: { WALNUT_RELATED_CHECK: '0' },
    // Same harness as vitest.config.ts: the exec guard, then runtime-dir-isolation
    // (it loads prod-server-guard). Without it every e2e server ran the real semantic
    // search lane: a fresh WALNUT_HOME downloads the ~600MB embedding model
    // and loads it, and on CI one such load outlived the embed worker's stop
    // grace and took the test process down with no report (2026-10-02).
    setupFiles: ['tests/setup/exec-guard.ts', 'tests/setup/bun-compat.ts', 'tests/setup/runtime-dir-isolation.ts', 'tests/setup/git-env-isolation.ts', 'tests/setup/tmp-reaper.ts', 'tests/setup/temp-tree-rm.ts', 'tests/setup/worker-watchdog.ts'],
    include: ['tests/e2e/**/*.test.ts'],
    exclude: ['**/*.live.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    // Module interop on bun: see tests/setup/runtime-deps.ts.
    deps: runtimeDeps(),
    pool: 'forks',
    // One worker: the files share one test home and its instance lock
    // (E2E_MAX_WORKERS in tests/setup/worker-budget.ts). Deliberately maxWorkers
    // (not poolOptions.forks.maxForks): maxForks would override the --maxWorkers
    // CLI flag and silently defeat any external throttle.
    maxWorkers: Math.min(maxWorkers(), E2E_MAX_WORKERS),
    poolOptions: {
      forks: {
        execArgv: workerExecArgv(),
      },
    },
  },
});
