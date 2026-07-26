import { defineConfig } from 'vitest/config';
import { maxWorkers, workerExecArgv } from './tests/setup/worker-budget';
import path from 'path';

/**
 * Dedicated config for the session "Changed" view diff pipeline tests.
 *
 * These tests drive FRONTEND code (`@/components/sessions/diffPatch.ts`) whose
 * deps (`diff`, `react-diff-view`, and transitively `react`) live in
 * `web/node_modules`, not the repo root. Unlike vitest.notes-roundtrip.config.ts
 * (which uses `root: web/` and therefore can only be launched from inside web/),
 * this config stays repo-root-rooted so it runs uniformly under
 * scripts/test-parallel.mjs alongside the other tiers. We bridge resolution with
 * explicit aliases into web/node_modules:
 *   - `react-diff-view`'s package `main` is CJS; under node resolution its bare
 *     `require('react/jsx-runtime')` resolves from the wrong base and throws. We
 *     point at its ESM bundle (the `module` field Vite uses) and alias react +
 *     react/jsx-runtime so all imports resolve against web/node_modules.
 * No DOM needed — the pipeline under test (createPatch → parseDiff → tokenize) is
 * pure string→data; we never mount a component.
 */
const web = (p: string) => path.resolve(import.meta.dirname, 'web/node_modules', p);

export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, 'web/src'),
      'react-diff-view': web('react-diff-view/es/index.js'),
      'react/jsx-runtime': web('react/jsx-runtime.js'),
      react: web('react/index.js'),
      diff: web('diff/libesm/index.js'),
      // refractor (Prism grammars) for the syntax-highlighting tests. Alias the
      // per-language subpaths first (longest match wins), then the bare package,
      // so this repo-root-rooted config resolves them from web/node_modules the
      // same way the live app does.
      'refractor/lang/tsx.js': web('refractor/lang/tsx.js'),
      'refractor/lang/jsx.js': web('refractor/lang/jsx.js'),
      refractor: web('refractor/index.js'),
    },
  },
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/web/diff-view/**/*.test.ts'],
    globalSetup: ['tests/setup/global-setup.ts'],
    setupFiles: ['tests/setup/worker-watchdog.ts'],
    testTimeout: 30_000,
    pool: 'forks',
    // Machine-memory caps — see vitest.config.ts (2026-07-25 swap incident).
    maxWorkers: maxWorkers(),
    poolOptions: { forks: { execArgv: workerExecArgv() } },
    server: {
      // Inline so vitest transforms (not externalizes) the aliased ESM bundles.
      deps: { inline: ['react-diff-view', 'diff', 'refractor'] },
    },
  },
});
