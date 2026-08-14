import { defineConfig, mergeConfig } from 'vitest/config';
import path from 'path';
import baseConfig from './vitest.config.js';
import { SLOW_TEST_FILES, SLOW_TEST_DIRS } from './tests/setup/slow-tests.js';

/**
 * L1 — the FAST feedback tier (`npm run test:quick`). Target: under 60 seconds.
 *
 * Everything in the suite EXCEPT the 26 files measured >2s (tests/setup/slow-tests.ts)
 * and the two end-to-end-heavy directories. That leaves ~300 files of pure logic
 * — no `claude` CLI spawns, no local daemon, no git subprocesses, no real ports —
 * which is the layer worth running on every code change.
 *
 * It is deliberately BROAD rather than a hand-picked "unit" subset: excluding by
 * measured slowness means a newly-added fast test is included automatically, and
 * only a test that actually becomes slow needs a list entry. The complement
 * (`npm run test:slow`) runs exactly the excluded files, so nothing is orphaned —
 * tests/setup/quick-tier.test.ts asserts that partition holds.
 *
 * `include`/`exclude` are OVERWRITTEN rather than merged: mergeConfig concatenates
 * arrays. See vitest.unit.config.ts for the incident this caused.
 */
const config = mergeConfig(
  baseConfig,
  defineConfig({
    resolve: {
      alias: {
        '@': path.resolve(import.meta.dirname, 'web/src'),
        '@open-walnut/core': path.resolve(import.meta.dirname, 'src/core/types.ts'),
        '@open-walnut/task-query': path.resolve(import.meta.dirname, 'src/core/task-query.ts'),
      },
    },
    test: {
      // Fast tests have no excuse to hang; a low ceiling keeps a regression from
      // quietly turning L1 into a 5-minute tier.
      testTimeout: 15_000,
      hookTimeout: 15_000,
    },
  }),
);

config.test!.include = ['tests/**/*.test.ts'];

config.test!.exclude = [
  ...SLOW_TEST_DIRS,
  ...SLOW_TEST_FILES,
  '**/*.live.test.ts',
  // Frontend-rooted suites — their deps live in web/node_modules and they need a
  // DOM shim, so they run ONLY under their own configs (`npm run test:frontend:ci`).
  //
  // All four must be listed. Missing tests/web/markdown/** made 3 files
  // permanently red in the quick tier for a reason unrelated to the code under
  // test: `dompurify` is not installed at the repo root, so without
  // vitest.markdown.config.ts's alias into web/node_modules they die at import
  // with `notePurify.addHook is not a function`. Worse, an import-time death
  // produces ZERO assertionResults, so they were invisible to the baseline gate
  // too (see scripts/test-baseline.mjs). tests/web/workflow-graph/** does pass
  // here, but is excluded for the same reason: one owner per test file, so it
  // can't run twice and can't drift between two configs.
  'tests/web/notes-roundtrip/**',
  'tests/web/diff-view/**',
  'tests/web/markdown/**',
  'tests/web/workflow-graph/**',
];

export default config;
