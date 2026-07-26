import { defineConfig } from 'vitest/config';
import { maxWorkers, workerExecArgv } from './tests/setup/worker-budget';

// LIVE tests — real credentials / real binaries / real remote hosts.
// Gated per-file by env vars (WALNUT_LIVE_TEST / WALNUT_LIVE_CODEX / …);
// referenced by `npm run test:live` and run explicitly per file, e.g.:
//   WALNUT_LIVE_CODEX=1 npx vitest run --config vitest.live.config.ts tests/e2e/acp-codex.live.test.ts
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    globalSetup: ['tests/setup/global-setup.ts'],
    // Per-worker parent-liveness watchdog — see vitest.config.ts.
    setupFiles: ['tests/setup/worker-watchdog.ts'],
    include: ['tests/**/*.live.test.ts'],
    testTimeout: 300_000,
    hookTimeout: 120_000,
    pool: 'forks',
    poolOptions: {
      forks: {
        maxForks: 1, // live tests share real resources — never parallel
        // Per-worker heap cap — see vitest.config.ts (2026-07-25 swap incident).
        execArgv: workerExecArgv(),
      },
    },
  },
});
