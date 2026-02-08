import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    exclude: ['tests/e2e/**/*.test.ts', 'tests/commands/**/*.test.ts', '**/*.live.test.ts'],
    pool: 'forks',
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
