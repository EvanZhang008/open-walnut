import { defineConfig, mergeConfig } from 'vitest/config';
import path from 'path';
import baseConfig from './vitest.config.js';
import { SLOW_TEST_FILES } from './tests/setup/slow-tests.js';

/**
 * The exact COMPLEMENT of the quick tier: only the files measured >2s
 * (tests/setup/slow-tests.ts). These spawn real `claude` CLIs, local daemons, git
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
    resolve: {
      alias: {
        '@': path.resolve(import.meta.dirname, 'web/src'),
        '@open-walnut/core': path.resolve(import.meta.dirname, 'src/core/types.ts'),
        '@open-walnut/task-query': path.resolve(import.meta.dirname, 'src/core/task-query.ts'),
      },
    },
    test: {
      // These spawn real processes and legitimately need room.
      testTimeout: 60_000,
      hookTimeout: 60_000,
    },
  }),
);

config.test!.include = [...SLOW_TEST_FILES];
config.test!.exclude = ['**/*.live.test.ts'];

export default config;
