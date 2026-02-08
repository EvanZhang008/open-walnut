import { defineConfig, mergeConfig } from 'vitest/config';
import baseConfig from './vitest.config.js';

export default mergeConfig(
  baseConfig,
  defineConfig({
    test: {
      include: [
        'tests/commands/**/*.test.ts',
        'tests/integrations/**/*.test.ts',
        'tests/web/**/*.test.ts',
        'tests/session-server/**/*.test.ts',
      ],
      exclude: ['**/*.live.test.ts'],
      testTimeout: 60_000,
    },
  }),
);
