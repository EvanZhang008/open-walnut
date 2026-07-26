import { defineConfig, mergeConfig } from 'vitest/config';
import baseConfig from './vitest.config.js';

/**
 * UNIT tier — logic-level tests for src/core, src/agent, src/providers, src/utils.
 *
 * NOTE ON `include`: it is assigned by OVERWRITING the merged value, not passed
 * through mergeConfig's second argument. mergeConfig CONCATENATES arrays, so
 * `include: [...]` here would have appended to the base config's
 * `['tests/**\/*.test.ts']` rather than replacing it — which is exactly the bug
 * that made this tier collect all 332 test files instead of its own ~220, and
 * made `npm test` run nearly every test TWICE (once here, once in the
 * integration tier). Measured 2026-07-25: unit 349s + integration 397s for
 * largely the same files. Keep the explicit overwrite below.
 */
const config = mergeConfig(
  baseConfig,
  defineConfig({
    test: {
      exclude: ['tests/e2e/**/*.test.ts', 'tests/commands/**/*.test.ts', 'tests/integrations/**/*.test.ts', '**/*.live.test.ts'],
    },
  }),
);

config.test!.include = [
  'tests/agent/**/*.test.ts',
  'tests/core/**/*.test.ts',
  'tests/providers/**/*.test.ts',
  'tests/utils/**/*.test.ts',
  'tests/logging/**/*.test.ts',
  'tests/hooks/**/*.test.ts',
  'tests/unit/**/*.test.ts',
];

export default config;
