import { defineConfig } from 'tsup';
import fs from 'node:fs';
import path from 'node:path';

// Discover all integration plugin entry points (each dir with index.ts)
const integrationsDir = 'src/integrations';
const pluginEntries = fs.readdirSync(integrationsDir, { withFileTypes: true })
  .filter(d => d.isDirectory() && fs.existsSync(path.join(integrationsDir, d.name, 'index.ts')))
  .map(d => path.join(integrationsDir, d.name, 'index.ts'));

export default defineConfig({
  entry: [
    'src/cli.ts',
    'src/cli-fast.ts',
    'src/hooks/on-stop.ts',
    'src/hooks/on-compact.ts',
    'src/web/server.ts',
    'src/session-server/index.ts',
    'src/workers/qmd-index-worker.ts',
    'src/workers/git-compaction-worker.ts',
    ...pluginEntries,
  ],
  format: ['esm'],
  target: 'node22',
  outDir: 'dist',
  clean: false,
  // splitting stays OFF: tried `splitting: true` (2026-08-20) hoping to make
  // the CLI boot lazily — it produced 205 chunks and made `tools call` SLOWER
  // (0.62s → 1.3s, ESM loader overhead dominates). The CLI fast path is the
  // dedicated cli-fast.ts entry below instead.
  splitting: false,
  sourcemap: true,
  dts: false,
  external: ['better-sqlite3', '@anthropic-ai/claude-agent-sdk', 'esbuild', 'screencapturekit-audio-capture', '@homebridge/node-pty-prebuilt-multiarch', '@tobilu/qmd'],
});
