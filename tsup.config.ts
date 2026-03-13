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
    'src/hooks/on-stop.ts',
    'src/hooks/on-compact.ts',
    'src/web/server.ts',
    'src/session-server/index.ts',
    ...pluginEntries,
  ],
  format: ['esm'],
  target: 'node22',
  outDir: 'dist',
  clean: false,
  splitting: false,
  sourcemap: true,
  dts: false,
  external: ['better-sqlite3', '@anthropic-ai/claude-agent-sdk', 'esbuild'],
});
