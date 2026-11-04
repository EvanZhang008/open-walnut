import { defineConfig } from 'tsup';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { writeBuildInfo } from './scripts/build-info.mjs';
import { BUNDLE_EXTERNAL, WS_ON_BUN } from './scripts/build-cli-fast.mjs';

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

// dist/cli-fast.js is bun's build, not tsup's (scripts/build-cli-fast.mjs says
// why): run here so every tsup build writes it, and before the stamp, so a
// failure fails the build. tsup itself may be running on node.
function buildCliFast(): void {
  const bun = process.versions.bun ? process.execPath : 'bun';
  try {
    execFileSync(bun, ['scripts/build-cli-fast.mjs', path.resolve(outDir)], { stdio: 'inherit' });
  } catch (err) {
    const missing = (err as NodeJS.ErrnoException).code === 'ENOENT';
    throw new Error(missing
      ? 'dist/cli-fast.js is built with bun, and there is no bun on PATH (curl -fsSL https://bun.sh/install | bash)'
      : 'dist/cli-fast.js: scripts/build-cli-fast.mjs failed (its output is above)');
  }
}

async function afterBuild(): Promise<void> {
  try {
    buildCliFast();
  } catch (err) {
    // tsup has written its bundles already: the old stamp would credit them to
    // the old commit. Without one, the build reads as the version alone.
    fs.rmSync(path.resolve(outDir, 'build-info.json'), { force: true });
    throw err;
  }
  await stampBuildInfo();
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
    // src/cli-fast.ts is not here: afterBuild() builds it with bun.
    'src/hooks/on-stop.ts',
    'src/hooks/on-compact.ts',
    'src/web/server.ts',
    'src/session-server/index.ts',
    'src/workers/git-compaction-worker.ts',
    'src/lib/hybrid-search/embed-worker.ts',
    // dist/lib/sqlite.js: what a worker thread loads to open SQLite on bun
    // (sqliteModuleFile in src/lib/sqlite.ts; the plugin database worker).
    'src/lib/sqlite.ts',
    ...pluginEntries,
  ],
  format: ['esm'],
  target: 'node22',
  outDir,
  onSuccess: afterBuild,
  define: { __WALNUT_VERSION__: JSON.stringify(pkgVersion) },
  clean: false,
  // splitting stays OFF: tried `splitting: true` (2026-08-20) hoping to make
  // the CLI boot lazily — it produced 205 chunks and made `tools call` SLOWER
  // (0.62s → 1.3s, ESM loader overhead dominates). The CLI fast path is the
  // dedicated cli-fast.ts entry instead (built by bun, see afterBuild).
  splitting: false,
  sourcemap: true,
  dts: false,
  // `#ws` (package.json "imports"): the npm `ws` package, never bun's own
  // WebSocket, which bun hands out for a bare `ws` import (src/lib/ws-npm.ts says
  // why that breaks the link checks). dist runs on bun, so each bundle carries
  // WS_ON_BUN, which loads the package by its path. Bundled, ws's CommonJS
  // `require`s of Node built-ins throw in an ES module; left as `#ws`, every
  // package.json a build ships with (a host server's) would need the alias too.
  esbuildPlugins: [{
    name: 'ws-on-bun',
    setup(build) {
      build.onResolve({ filter: /^#ws$/ }, () => ({ path: 'ws', namespace: 'walnut-ws' }));
      build.onLoad({ filter: /.*/, namespace: 'walnut-ws' }, () => ({ contents: WS_ON_BUN, loader: 'js', resolveDir: process.cwd() }));
    },
  }],
  // Shared with dist/cli-fast.js's build (scripts/build-cli-fast.mjs says why each is external).
  external: BUNDLE_EXTERNAL,
});
