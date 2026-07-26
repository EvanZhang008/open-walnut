import { defineConfig, mergeConfig } from 'vitest/config';
import path from 'path';
import baseConfig from './vitest.config.js';

/**
 * L2 — `npm run test:focus <path>`: run whatever the developer names, full stop.
 *
 * Deliberately has the WIDEST include of any config and excludes only `.live`
 * tests (which cost real money and need credentials). The whole point of a focus
 * run is "I am debugging this one file" — so a tier-shaped exclude list is
 * actively harmful here. Pointing test:focus at the quick config meant naming any
 * of the 26 slow files, or anything under tests/e2e/, printed `No test files
 * found, exiting with code 1` — a hard failure that looks like a broken test,
 * for exactly the heavy files someone debugging would reach for first.
 *
 * The frontend-rooted suites (tests/web/{markdown,diff-view,workflow-graph,
 * notes-roundtrip}) still cannot run here — their deps live in web/node_modules
 * and they need a DOM shim, so they only work under their own configs. Focus on
 * one of those with `npm run test:frontend:ci` instead; the message below says so.
 *
 * Timeouts are generous because this config can host a daemon-spawning test.
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
      hookTimeout: 60_000,
    },
  }),
);

// Overwritten, not merged — mergeConfig concatenates arrays (see vitest.unit.config.ts).
config.test!.include = ['tests/**/*.test.ts'];
config.test!.exclude = [
  '**/*.live.test.ts',
  // Cannot resolve under a repo-root config; run `npm run test:frontend:ci`.
  'tests/web/notes-roundtrip/**',
  'tests/web/diff-view/**',
  'tests/web/markdown/**',
  'tests/web/workflow-graph/**',
];

export default config;
