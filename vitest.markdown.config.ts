import { defineConfig } from 'vitest/config';
import { maxWorkers, workerExecArgv } from './tests/setup/worker-budget';
import path from 'path';

/**
 * Dedicated config for the frontend markdown utils (`@/utils/markdown.ts`), which
 * back the per-message "copy as Markdown / rich text" buttons and all on-screen
 * message rendering. Its deps (`marked`, `dompurify`) live in web/node_modules,
 * not the repo root, so we alias @ → web/src and bridge the two libs explicitly.
 *
 * DOMPurify needs a `window`; the repo's node-env tiers have none. We install a
 * linkedom-backed window in a setup file (same approach as tests/web/notes-roundtrip)
 * so the production sanitize path runs, not a passthrough stub.
 */
const web = (p: string) => path.resolve(import.meta.dirname, 'web/node_modules', p);

export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, 'web/src'),
      marked: web('marked/lib/marked.esm.js'),
      dompurify: web('dompurify/dist/purify.es.mjs'),
    },
  },
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/web/markdown/**/*.test.ts'],
    globalSetup: ['tests/setup/global-setup.ts'],
    setupFiles: ['tests/setup/worker-watchdog.ts', 'tests/web/markdown/dom-setup.ts'],
    testTimeout: 30_000,
    pool: 'forks',
    // Machine-memory caps — see vitest.config.ts (2026-07-25 swap incident).
    maxWorkers: maxWorkers(),
    poolOptions: { forks: { execArgv: workerExecArgv() } },
    server: {
      // Inline so vitest transforms (not externalizes) the aliased ESM bundles.
      deps: { inline: ['marked', 'dompurify'] },
    },
  },
});
