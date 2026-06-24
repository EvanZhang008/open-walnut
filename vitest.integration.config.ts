import { defineConfig, mergeConfig } from 'vitest/config';
import path from 'path';
import baseConfig from './vitest.config.js';

export default mergeConfig(
  baseConfig,
  defineConfig({
    resolve: {
      alias: {
        '@': path.resolve(import.meta.dirname, 'web/src'),
        '@open-walnut/core': path.resolve(import.meta.dirname, 'src/core/types.ts'),
      },
    },
    test: {
      include: [
        'tests/commands/**/*.test.ts',
        'tests/integrations/**/*.test.ts',
        'tests/web/**/*.test.ts',
        'tests/session-server/**/*.test.ts',
      ],
      // notes-roundtrip drives the FRONTEND editor serializer; diff-view drives
      // the FRONTEND diff pipeline (react-diff-view/diff). Both have deps in
      // web/node_modules, so they run under their own web-rooted configs
      // (vitest.notes-roundtrip.config.ts / vitest.diff-view.config.ts) — never
      // the node-env integration tier where those deps don't resolve.
      exclude: ['**/*.live.test.ts', 'tests/web/notes-roundtrip/**', 'tests/web/diff-view/**'],
      testTimeout: 60_000,
    },
  }),
);
