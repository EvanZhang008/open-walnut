import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.live.test.ts'],
    exclude: ['dist/**', 'node_modules/**'],
    testTimeout: 300_000,
    hookTimeout: 90_000,
    pool: 'forks',
    poolOptions: {
      forks: {
        maxForks: 1,
      },
    },
  },
});
