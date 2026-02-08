import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/cli.ts', 'src/hooks/on-stop.ts', 'src/hooks/on-compact.ts', 'src/web/server.ts', 'src/session-server/index.ts'],
  format: ['esm'],
  target: 'node22',
  outDir: 'dist',
  clean: false,
  splitting: false,
  sourcemap: true,
  dts: false,
  external: ['better-sqlite3', '@anthropic-ai/claude-agent-sdk'],
});
