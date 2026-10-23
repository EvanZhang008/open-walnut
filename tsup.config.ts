import { defineConfig } from 'tsup';
import fs from 'node:fs';
import path from 'node:path';
import { writeBuildInfo } from './scripts/build-info.mjs';

// Bake the version in. Walking up for package.json at runtime returns '0.0.0'
// whenever the bundle lands somewhere that walk can't reach, and a host that
// reports '0.0.0' fails every plugin's engines.walnut range.
const pkgVersion = (JSON.parse(fs.readFileSync('package.json', 'utf-8')) as { version: string }).version;

const outDir = 'dist';

// What `#ws` is in a bundle: the ws package found from the bundle's own place
// (dist/ beside node_modules, or a host build's linked node_modules) and loaded
// by its file path, which bun does not swap for its built-in WebSocket. Its
// package.json is the one subpath the package exports.
const WS_ON_BUN = `
import { createRequire as __wsRequire } from 'node:module';
import __wsPath from 'node:path';
const __wsReq = __wsRequire(import.meta.url);
const ws = __wsReq(__wsPath.join(__wsPath.dirname(__wsReq.resolve('ws/package.json')), 'index.js'));
export default ws;
export const WebSocket = ws.WebSocket;
export const WebSocketServer = ws.WebSocketServer;
export const createWebSocketStream = ws.createWebSocketStream;
export const Receiver = ws.Receiver;
export const Sender = ws.Sender;
`;

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
    // dist/lib/sqlite.js: what a worker thread loads to open SQLite on bun
    // (sqliteModuleFile in src/lib/sqlite.ts; the plugin database worker).
    'src/lib/sqlite.ts',
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
  // 'bun:sqlite' exists only at runtime (src/lib/sqlite.ts loads it); the rest
  // are optional or downloaded components, loaded where they are installed.
  external: ['bun:sqlite', 'sharp', '@anthropic-ai/claude-agent-sdk', 'screencapturekit-audio-capture', '@huggingface/transformers'],
});
