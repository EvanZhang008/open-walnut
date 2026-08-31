import path from 'node:path';
import { defineConfig } from 'vitest/config';
import { maxWorkers, workerExecArgv } from './tests/setup/worker-budget';

export default defineConfig({
  // Same aliases as vitest.quick.config.ts: '@open-walnut/*' are alias-only
  // (no real packages), so any tests/web/** file reaching web/src code dies at
  // COLLECTION under a config without them — zero assertions, invisible to the
  // baseline gate (this bit view-filter-model.test.ts and session-columns.test.ts).
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, 'web/src'),
      '@open-walnut/core': path.resolve(import.meta.dirname, 'src/core/types.ts'),
      '@open-walnut/task-query': path.resolve(import.meta.dirname, 'src/core/task-query.ts'),
      '@open-walnut/letter-frame': path.resolve(import.meta.dirname, 'src/core/human-inbox/letter-frame.ts'),
      '@open-walnut/pending-markup': path.resolve(import.meta.dirname, 'src/core/stream/pending-markup.ts'),
    },
  },
  test: {
    globals: true,
    environment: 'node',
    globalSetup: ['tests/setup/global-setup.ts'],
    // runtime-dir-isolation MUST be first: it redirects WALNUT_DAEMON_DIR (and
    // hence LOG_DIR / streams / images) away from the production /tmp/open-walnut
    // before any test module imports constants.ts and freezes those paths.
    // Per-worker parent-liveness watchdog — exits workers whose runner died
    // (they otherwise leak forever with ppid=1). See the file for the incident.
    setupFiles: ['tests/setup/runtime-dir-isolation.ts', 'tests/setup/worker-watchdog.ts'],
    include: ['tests/**/*.test.ts'],
    // notes-roundtrip runs under its own DOM-shimmed config (its deps live in
    // web/node_modules); exclude it from the node-env base/coverage runs so it
    // can't fail to resolve @tiptap/* here.
    exclude: ['tests/e2e/**/*.test.ts', 'tests/commands/**/*.test.ts', 'tests/web/notes-roundtrip/**', '**/*.live.test.ts'],
    pool: 'forks',
    // Machine-wide budget — see tests/setup/worker-budget.ts for the crash
    // rationale. Inherited by unit/integration via mergeConfig.
    // NOTE: must be maxWorkers, NOT poolOptions.forks.maxForks — maxForks takes
    // precedence over the --maxWorkers CLI flag and would silently void any
    // per-tier throttle (verified: with maxForks:4, `--maxWorkers 1` ran 4).
    maxWorkers: maxWorkers(),
    poolOptions: {
      forks: {
        execArgv: workerExecArgv(),
      },
    },
    testTimeout: 30_000,
    hookTimeout: 30_000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['src/**/*.ts'],
      exclude: [
        'src/**/*.test.ts',
        'src/cli.ts',
        'src/cli/**',
        'src/commands/**',
        'src/index.ts',
        'src/hooks/**',
        'src/utils/terminal.ts',
        'src/utils/display.ts',
        'src/utils/json-output.ts',
        'src/providers/claude-code-session.ts',
        'src/agent/model.ts',
        'src/core/types.ts',
      ],
      thresholds: {
        lines: 70,
        functions: 70,
        branches: 55,
        statements: 70,
      },
    },
  },
});
