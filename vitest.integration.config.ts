import { defineConfig, mergeConfig } from 'vitest/config';
import path from 'path';
import baseConfig from './vitest.config.js';

/**
 * INTEGRATION tier — Express routes via supertest, plugin sync, session-server.
 *
 * NOTE ON `include`: assigned by OVERWRITING the merged value below, never via
 * mergeConfig — mergeConfig concatenates arrays, so passing `include` through it
 * appended to the base's `['tests/**\/*.test.ts']` and made this tier collect all
 * 336 files (the whole suite) instead of its own ~110. See vitest.unit.config.ts
 * for the full incident note.
 */
const config = mergeConfig(
  baseConfig,
  defineConfig({
    resolve: {
      alias: {
        '@': path.resolve(import.meta.dirname, 'web/src'),
        '@open-walnut/core': path.resolve(import.meta.dirname, 'src/core/types.ts'),
      },
    },
    test: {
      testTimeout: 60_000,
    },
  }),
);

// Overwritten, not merged, for the same reason as `include`: the base config
// excludes 'tests/commands/**', and a merged exclude would CONCATENATE — so this
// tier's `include` of tests/commands was silently dead (2 files ran nowhere).
//
// notes-roundtrip drives the FRONTEND editor serializer; diff-view drives the
// FRONTEND diff pipeline (react-diff-view/diff). Both have deps in
// web/node_modules, so they run under their own web-rooted configs
// (vitest.notes-roundtrip.config.ts / vitest.diff-view.config.ts) — never the
// node-env integration tier where those deps don't resolve.
config.test!.exclude = ['**/*.live.test.ts', 'tests/web/notes-roundtrip/**', 'tests/web/diff-view/**'];

config.test!.include = [
  'tests/commands/**/*.test.ts',
  'tests/integrations/**/*.test.ts',
  'tests/web/**/*.test.ts',
  'tests/session-server/**/*.test.ts',
];

export default config;
