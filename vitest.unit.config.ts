import { defineConfig, mergeConfig } from 'vitest/config';
import baseConfig from './vitest.config.js';

export default mergeConfig(
  baseConfig,
  defineConfig({
    test: {
      include: [
        'tests/agent/**/*.test.ts',
        'tests/core/**/*.test.ts',
        'tests/providers/**/*.test.ts',
        'tests/utils/**/*.test.ts',
      ],
      exclude: ['tests/e2e/**/*.test.ts', 'tests/commands/**/*.test.ts', 'tests/integrations/**/*.test.ts', '**/*.live.test.ts'],
    },
  }),
);
