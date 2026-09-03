import { defineConfig } from 'tsup';
import fs from 'node:fs';
import path from 'node:path';

// Discover all integration plugin entry points (each dir with index.ts)
const integrationsDir = 'src/integrations';
const pluginEntries = fs.readdirSync(integrationsDir, { withFileTypes: true })
  .filter(d => d.isDirectory() && fs.existsSync(path.join(integrationsDir, d.name, 'index.ts')))
  .map(d => path.join(integrationsDir, d.name, 'index.ts'));

// Built-in action modules: src/actions/registry.ts dynamic-imports them from
// dist/actions/*.js at runtime, so they must be emitted as real files. Nothing
// emitted them after an older build config was retired — the server ran for
// weeks off stale dist/actions/ debris that `clean: false` happened to preserve,
// and the first clean rebuild deleted it (2026-08-22: registry's fallback then
// scanned dist/ itself, dynamic-imported every stale code-split chunk, and boot
// hung before listen()). Excludes the registry's own infrastructure files.
const actionsDir = 'src/actions';
const actionEntries = fs.readdirSync(actionsDir)
  .filter(f => f.endsWith('.ts') && !['types.ts', 'registry.ts', 'index.ts'].includes(f))
  .map(f => path.join(actionsDir, f));

export default defineConfig({
  entry: [
    'src/cli.ts',
    'src/cli-fast.ts',
    'src/hooks/on-stop.ts',
    'src/hooks/on-compact.ts',
    'src/web/server.ts',
    'src/session-server/index.ts',
    'src/workers/git-compaction-worker.ts',
    'src/lib/hybrid-search/embed-worker.ts',
    ...actionEntries,
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
  external: ['better-sqlite3', 'sharp', '@anthropic-ai/claude-agent-sdk', 'esbuild', 'screencapturekit-audio-capture', '@homebridge/node-pty-prebuilt-multiarch', '@huggingface/transformers'],
});
