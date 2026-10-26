import { defineConfig } from 'tsup';
import fs from 'node:fs';
import path from 'node:path';
import { writeBuildInfo } from './scripts/build-info.mjs';

// Bake the version in. Walking up for package.json at runtime returns '0.0.0'
// whenever the bundle lands somewhere that walk can't reach, and a host that
// reports '0.0.0' fails every plugin's engines.walnut range.
const pkgVersion = (JSON.parse(fs.readFileSync('package.json', 'utf-8')) as { version: string }).version;

const outDir = 'dist';

// dist/build-info.json: which commit this dist was built from (src/lib/build-info.ts
// reads it). Stamped from onSuccess, never at config load: a FAILED build must leave
// the old bundles with the old stamp, not credit them to the new commit. tsup calls
// onSuccess once per build after every entry and format is written (again on each
// watch rebuild). Git or disk trouble only warns; it never fails the build.
async function stampBuildInfo(): Promise<void> {
  try {
    writeBuildInfo(process.cwd(), path.resolve(outDir));
  } catch (err) {
    console.warn(`build-info: not written (${err instanceof Error ? err.message : String(err)})`);
  }
}

// Discover all integration plugin entry points (each dir with index.ts)
const integrationsDir = 'src/integrations';
const pluginEntries = fs.readdirSync(integrationsDir, { withFileTypes: true })
  .filter(d => d.isDirectory() && fs.existsSync(path.join(integrationsDir, d.name, 'index.ts')))
  .map(d => path.join(integrationsDir, d.name, 'index.ts'));

// Built-in actions are NOT separate entries: they load through the host bundle
// (src/actions/builtin-modules.ts), so they share its module instances. As their
// own entries each was a full copy of core, imported at every boot.

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
    ...pluginEntries,
  ],
  format: ['esm'],
  target: 'node22',
  outDir,
  onSuccess: stampBuildInfo,
  define: { __WALNUT_VERSION__: JSON.stringify(pkgVersion) },
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
