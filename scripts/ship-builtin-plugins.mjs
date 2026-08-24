#!/usr/bin/env node
/**
 * Ships first-party web plugins as BUILTINS, so a stock install has their Apps
 * without anyone running an install command.
 *
 * Why this exists: time tracking CAPTURES for every install (the heartbeat lease
 * runs in the console shell, the rollup writes to disk), and its only UI is the
 * walnut-time plugin App. Without this step, a stock install banks time it can
 * never show you — data collected with no window onto it, which reads as a broken
 * feature rather than a missing plugin.
 *
 * It needs no new runtime machinery. Builtin discovery already resolves
 * `dist/integrations/` and the web-module route already serves any active plugin
 * with a `web` entry, regardless of where it was discovered
 * (src/core/integration-loader.ts, src/core/plugins/plugin-web-module.ts). All that
 * was missing is the artifact: `tsup` only picks up `src/integrations/<id>/index.ts`,
 * and the manifest copy loop in package.json copies manifest.json and nothing else.
 *
 * Two traps this file encodes:
 *
 *  - A web-only plugin has no `index.ts`, so tsup creates no output directory for
 *    it. The copy MUST mkdir -p; the existing loop does not, and only works
 *    because tsup made the directory first.
 *  - Failing loudly matters more than shipping. A missing bundle is invisible at
 *    runtime — the plugin loads with no App and the Settings row simply is not
 *    there — so every step is verified here, where the build can still fail.
 *
 * The SOURCE stays in examples/: it is the worked example plugin authors read, and
 * having the shipped App be that same code is the point. Only build artifacts are
 * copied into dist/.
 *
 * That choice also keeps the test fixtures honest. Builtin discovery resolves
 * `src/integrations` when the server runs from source and `dist/integrations` only
 * for a built one (resolveBuiltinDir in src/core/integration-loader.ts), and every
 * fixture here boots from source via tsx — so a shipped App appears to a real
 * install without appearing to the specs that assert a plugin-free install
 * (tests/e2e/browser/plugin-apps.spec.ts). Moving these sources INTO
 * src/integrations would silently break that.
 */
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Add a line to ship another first-party web plugin. */
const SHIPPED = ['examples/plugins/walnut-time'];

/** A bundle smaller than this is a stub or a truncated write, not an App. */
const MIN_BUNDLE_BYTES = 1024;

const cli = join(root, 'packages/plugin-cli/dist/cli.js');

function run(command, args) {
  execFileSync(command, args, { cwd: root, stdio: 'inherit' });
}

// `npm run build` builds the plugin workspaces first, but `web:build` (what
// dev-prod.sh runs) does not — so make the dependency explicit instead of
// inheriting whichever chain called us.
if (!existsSync(cli)) run('npm', ['run', 'build:plugins']);

for (const rel of SHIPPED) {
  const source = join(root, rel);
  const manifestPath = join(source, 'manifest.json');
  if (!existsSync(manifestPath)) {
    console.error(`ship-builtin-plugins: no manifest at ${rel}/manifest.json`);
    process.exit(1);
  }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
  const { id, web } = manifest;
  if (!id || !web) {
    console.error(`ship-builtin-plugins: ${rel}/manifest.json needs both "id" and "web"`);
    process.exit(1);
  }

  run('node', [cli, 'build', '--root', rel]);

  const bundle = join(source, web);
  if (!existsSync(bundle)) {
    console.error(`ship-builtin-plugins: ${rel} built without producing ${web}`);
    process.exit(1);
  }

  // Rebuild the destination from scratch: a stale bundle left by a previous
  // version's different entry name would ship alongside the new one.
  const target = join(root, 'dist/integrations', id);
  rmSync(target, { recursive: true, force: true });
  mkdirSync(dirname(join(target, web)), { recursive: true });
  cpSync(manifestPath, join(target, 'manifest.json'));
  cpSync(bundle, join(target, web));

  const shipped = join(target, web);
  if (!existsSync(shipped) || statSync(shipped).size < MIN_BUNDLE_BYTES) {
    console.error(`ship-builtin-plugins: ${id} bundle did not land at dist/integrations/${id}/${web}`);
    process.exit(1);
  }
  console.log(`ship-builtin-plugins: ${id} → dist/integrations/${id} (${statSync(shipped).size} bytes)`);
}
