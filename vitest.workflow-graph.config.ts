import { defineConfig } from 'vitest/config';
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
    testTimeout: 30_000,
    pool: 'forks',
  },
});
