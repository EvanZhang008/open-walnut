import { defineConfig, mergeConfig } from 'vitest/config';
import baseConfig from './vitest.config.js';
import { SLOW_TEST_FILES, SLOW_TEST_DIRS } from './tests/setup/slow-tests.js';
import { QUARANTINED_TEST_FILES } from './tests/setup/quarantine.js';
import quickConfig from './vitest.quick.config.js';

/**
 * The exact COMPLEMENT of the quick tier: the files measured >2s
 * (tests/setup/slow-tests.ts) and the heavy directories quick skips, except
 * tests/e2e, which has its own tier. These spawn real `claude` CLIs, local daemons, git
 * subprocesses and HTTP servers, so they are the slowest AND the most valuable
 * integration coverage — they just don't belong in the every-change loop.
 *
 * Run before a larger commit (`npm run test:pre-commit` includes it) or on CI.
 * tests/e2e/** is NOT here — it has its own tier (vitest.e2e.config.ts).
 *
 * `include`/`exclude` are overwritten, not merged — mergeConfig concatenates
 * arrays (see vitest.unit.config.ts).
 */
const config = mergeConfig(
  baseConfig,
  defineConfig({
    // The quick tier's aliases: a quarantined quick file runs here and imports what it imported there.
    resolve: { alias: quickConfig.resolve!.alias },
    test: {
      // These spawn real processes and legitimately need room.
      testTimeout: 60_000,
      hookTimeout: 60_000,
    },
  }),
);

// tests/commands and tests/mcp: quick skips them as SLOW_TEST_DIRS, and until
// 2026-10-24 this include named only the file list, so their 18 files ran in no
// CI job and in neither test:changed nor test:pre-commit.
export const SLOW_DIR_GLOBS = SLOW_TEST_DIRS.filter((d) => d !== 'tests/e2e/**').map((d) => `${d}/*.test.ts`);
config.test!.include = [...SLOW_TEST_FILES, ...QUARANTINED_TEST_FILES, ...SLOW_DIR_GLOBS];
config.test!.exclude = ['**/*.live.test.ts'];

export default config;
