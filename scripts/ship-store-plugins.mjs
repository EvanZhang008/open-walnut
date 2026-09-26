#!/usr/bin/env node
/**
 * Ships the bundled plugin store: every `plugin-store/<id>/` plugin is built and copied
 * into `dist/plugin-store/<id>/`, so it travels INSIDE the Walnut build.
 *
 * Unlike scripts/ship-builtin-plugins.mjs, nothing shipped here is loaded by default.
 * The loader only discovers a bundled folder whose id the user installed from Settings,
 * Plugins (`plugins.<id>.enabled: true`), and Remove deletes that key again. See
 * src/core/plugins/bundled-store.ts for the runtime half.
 *
 * Per plugin:
 *   1. its runtime `dependencies` are installed into the plugin folder only when they
 *      cannot already be resolved from it (the repo's own node_modules usually covers
 *      them, and a plugin with no dependencies skips this step entirely);
 *   2. `walnut-plugin build --root plugin-store/<id>` builds it, so a folder with no
 *      `dist/` yet is fine;
 *   3. every declared `server`/`web` artifact must exist and be over 1KB (anything
 *      smaller is a stub or a truncated write, and a missing bundle is invisible at
 *      runtime: the row installs and then sits in `failed`), so the build fails HERE;
 *   4. manifest.json, README.md, dist/, skills/ and the manifest's `icon` are copied to
 *      dist/plugin-store/<id>/.
 *
 * `dist/plugin-store` is rebuilt from scratch every run, so a plugin removed from the
 * folder does not linger in the next build. An empty or absent folder is a no-op that
 * still leaves an empty `dist/plugin-store`, exit 0.
 */
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const storeRel = 'plugin-store';
const storeDir = join(root, storeRel);
const targetRoot = join(root, 'dist', storeRel);
const cli = join(root, 'packages/plugin-cli/dist/cli.js');

/** A bundle smaller than this is a stub or a truncated write, not a plugin. */
const MIN_BUNDLE_BYTES = 1024;

function fail(message) {
  console.error(`ship-store-plugins: ${message}`);
  process.exit(1);
}

function run(command, args, cwd = root) {
  execFileSync(command, args, { cwd, stdio: 'inherit' });
}

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf-8'));
  } catch (error) {
    fail(`${file.slice(root.length + 1)} is not valid JSON (${error instanceof Error ? error.message : String(error)})`);
  }
}

/** Runtime dependencies this plugin folder cannot resolve yet. */
function unresolvedDependencies(pluginDir) {
  const pkgFile = join(pluginDir, 'package.json');
  if (!existsSync(pkgFile)) return [];
  const deps = Object.keys(readJson(pkgFile).dependencies ?? {});
  if (deps.length === 0) return [];
  const requireFrom = createRequire(pkgFile);
  return deps.filter((name) => {
    try {
      requireFrom.resolve(`${name}/package.json`);
      return false;
    } catch {
      return true;
    }
  });
}

const plugins = existsSync(storeDir)
  ? readdirSync(storeDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
    .filter((entry) => existsSync(join(storeDir, entry.name, 'manifest.json')))
    .map((entry) => entry.name)
    .sort()
  : [];

rmSync(targetRoot, { recursive: true, force: true });
mkdirSync(targetRoot, { recursive: true });

if (plugins.length === 0) {
  console.log('ship-store-plugins: no plugins in plugin-store/, nothing to ship');
  process.exit(0);
}

// `npm run build` builds the plugin workspaces first, but `web:build` (what dev-prod.sh
// runs) does not, so the dependency is made explicit here.
if (!existsSync(cli)) run('npm', ['run', 'build:plugins']);

for (const name of plugins) {
  const rel = `${storeRel}/${name}`;
  const source = join(storeDir, name);
  const manifestPath = join(source, 'manifest.json');
  const manifest = readJson(manifestPath);
  if (manifest.id !== name) {
    fail(`${rel}/manifest.json says id ${JSON.stringify(manifest.id)}; the folder must be named after the plugin id`);
  }

  const missing = unresolvedDependencies(source);
  if (missing.length > 0) {
    console.log(`ship-store-plugins: ${name}: installing ${missing.join(', ')}`);
    run('npm', ['install', '--omit=dev', '--no-audit', '--no-fund', '--ignore-scripts'], source);
  }

  run('node', [cli, 'build', '--root', rel]);

  for (const key of ['server', 'web']) {
    if (manifest[key] === undefined) continue;
    const artifact = join(source, manifest[key]);
    if (!existsSync(artifact)) fail(`${rel} built without producing its ${key} entry ${manifest[key]}`);
    const bytes = statSync(artifact).size;
    if (bytes < MIN_BUNDLE_BYTES) fail(`${rel} ${key} entry ${manifest[key]} is only ${bytes} bytes, which looks like a stub`);
  }

  const target = join(targetRoot, name);
  mkdirSync(target, { recursive: true });
  cpSync(manifestPath, join(target, 'manifest.json'));
  for (const extra of ['README.md', 'dist', 'skills']) {
    const from = join(source, extra);
    if (existsSync(from)) cpSync(from, join(target, extra), { recursive: true });
  }
  // The Settings tile (manifest `icon`): declared means it must ship, like a bundle.
  if (manifest.icon !== undefined) {
    const icon = typeof manifest.icon === 'string' ? manifest.icon.replace(/\\/g, '/') : '';
    if (!icon.toLowerCase().endsWith('.svg') || icon.startsWith('/') || icon.split('/').includes('..')) {
      fail(`${rel}/manifest.json icon must be a relative .svg path inside the plugin`);
    }
    if (!existsSync(join(source, icon))) fail(`${rel} declares icon ${icon}, which does not exist`);
    mkdirSync(dirname(join(target, icon)), { recursive: true });
    cpSync(join(source, icon), join(target, icon));
  }
  for (const key of ['server', 'web']) {
    if (manifest[key] !== undefined && !existsSync(join(target, manifest[key]))) {
      fail(`${name} ${key} entry did not land at dist/${rel}/${manifest[key]}`);
    }
  }
  console.log(`ship-store-plugins: ${name} -> dist/${rel}`);
}
