import { defineConfig } from 'vitest/config';
import { maxWorkers, workerExecArgv } from './tests/setup/worker-budget';
import path from 'path';

/**
 * Dedicated config for the WorkflowGraph layout logic test.
 *
 * Drives FRONTEND pure logic (`@/components/sessions/workflow-layout.ts`). That module
 * only `import type`s from the hook (erased at compile), so no React/DOM is needed —
 * we test buildLayout()/phaseCounts() as plain data transforms. Stays repo-root-rooted
 * (like vitest.diff-view.config.ts) so it runs under scripts/test-parallel.mjs; we just
 * bridge the `@` alias into web/src.
 */
export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, 'web/src'),
    },
  },
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/web/workflow-graph/**/*.test.ts'],
    globalSetup: ['tests/setup/global-setup.ts'],
    setupFiles: ['tests/setup/worker-watchdog.ts'],
    testTimeout: 30_000,
    pool: 'forks',
    // Machine-memory caps — see vitest.config.ts (2026-07-25 swap incident).
    maxWorkers: maxWorkers(),
    poolOptions: { forks: { execArgv: workerExecArgv() } },
  },
});
