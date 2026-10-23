#!/usr/bin/env node
/**
 * Unified postinstall: routes between two very different install shapes.
 *
 * DEV CHECKOUT (git clone; web/ + src/ present), installed with Bun:
 *   Bun applies patches/ itself (package.json `patchedDependencies`), so this
 *   only installs web/, which has its own package.json and bun.lock.
 *   Strict: any failure fails the install.
 *   Installed with npm instead (the Mac app's "Set Up Now" clones and runs npm),
 *   it still works, with a warning: npm reads no bun.lock and applies no patch,
 *   so this applies the SDK patch the way the published chain does and installs
 *   web/ with npm too. The versions are then npm's own picks, not bun.lock's.
 *
 * PUBLISHED PACKAGE (npm install open-walnut / npx open-walnut):
 *   No package manager applies a dependency's own patches, and with npm hoisting
 *   the SDK lives in the PARENT node_modules. So we read the SDK patch named in
 *   our package.json `patchedDependencies` (single hunk, single-line change) and
 *   apply it directly to the resolved install location.
 *   Fail-open: a cosmetic patch failure must never break `npm install` for a
 *   consumer; warn loudly and continue.
 */
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SDK = '@anthropic-ai/claude-agent-sdk';

/** True when `root` is a git checkout of this repo rather than an installed package. */
export function isDevCheckout(root) {
  return existsSync(join(root, 'web', 'package.json')) && existsSync(join(root, 'src'));
}

/** The installing tool from npm_config_user_agent (`bun/1.4.4 npm/? node/...`). */
export function installerOf(env = process.env) {
  return /^([a-z]+)\//.exec(env.npm_config_user_agent ?? '')?.[1] ?? 'unknown';
}

/** npm 12 refuses web/'s tarball-URL dependency (xlsx) unless allowed. */
export function npmWebInstallArgs(env = process.env) {
  const npmMajor = Number(/\bnpm\/(\d+)\./.exec(env.npm_config_user_agent ?? '')?.[1] ?? 0);
  return npmMajor >= 12 ? ['install', '--allow-remote=root'] : ['install'];
}

/**
 * The command that installs web/ under Bun. The root install leaves no trace of
 * --frozen-lockfile for its scripts, so CI (which always installs frozen) is
 * the signal: there a web/bun.lock that lags web/package.json must fail the
 * job, never be rewritten mid-release (the build would be stamped dirty).
 */
export function webInstallCommand(env = process.env) {
  const bun = env.npm_execpath && /bun(\.exe)?$/.test(env.npm_execpath) ? env.npm_execpath : 'bun';
  const frozen = Boolean(env.CI) && env.CI !== 'false' && env.CI !== '0';
  return { cmd: bun, args: frozen ? ['install', '--frozen-lockfile'] : ['install'] };
}

/** The SDK patch our package.json names: { version, file } or null. */
export function sdkPatchOf(pkg) {
  for (const [key, file] of Object.entries(pkg.patchedDependencies ?? {})) {
    if (key.startsWith(`${SDK}@`)) return { version: key.slice(SDK.length + 1), file };
  }
  return null;
}

/**
 * Apply the claude-agent-sdk reminder patch by parsing the shipped diff. The
 * patch is one hunk changing one line of the minified cli.js bundle, which
 * makes direct find-and-replace both exact and safe. The .patch file stays the
 * single source of truth: no duplicated strings.
 */
export function applySdkPatch(root, { warn = (m) => console.warn(`open-walnut postinstall: ${m}`), resolveSdk } = {}) {
  let pkg;
  try {
    pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  } catch {
    return warn('package.json not readable, skipping SDK patch');
  }
  const patch = sdkPatchOf(pkg);
  if (!patch) return warn('no SDK patch named in package.json, skipping');
  const patchPath = join(root, patch.file);
  if (!existsSync(patchPath)) return warn(`SDK patch file ${patch.file} not found, skipping`);

  // Resolve the installed SDK (may be hoisted to a parent node_modules).
  let sdkDir;
  try {
    let dir = dirname((resolveSdk ?? ((name) => createRequire(join(root, 'package.json')).resolve(name)))(SDK));
    while (dir !== dirname(dir) && !existsSync(join(dir, 'package.json'))) dir = dirname(dir);
    sdkDir = dir;
  } catch {
    return warn('claude-agent-sdk not resolvable, skipping SDK patch');
  }

  const installedVersion = JSON.parse(readFileSync(join(sdkDir, 'package.json'), 'utf8')).version;
  if (installedVersion !== patch.version) {
    return warn(
      `SDK ${installedVersion} != patch target ${patch.version}, skipping (file reads will carry the SDK's cyber reminder, costing context)`,
    );
  }

  // Extract the one removed and one added line from the diff.
  const lines = readFileSync(patchPath, 'utf8').split('\n');
  const removed = lines.filter((l) => l.startsWith('-') && !l.startsWith('---')).map((l) => l.slice(1));
  const added = lines.filter((l) => l.startsWith('+') && !l.startsWith('+++')).map((l) => l.slice(1));
  if (removed.length !== 1 || added.length !== 1) {
    return warn(`SDK patch shape changed (${removed.length}-/${added.length}+ lines), skipping`);
  }

  const cliPath = join(sdkDir, 'cli.js');
  let content;
  try {
    content = readFileSync(cliPath, 'utf8');
  } catch {
    return warn(`SDK cli.js not readable at ${cliPath}, skipping`);
  }
  if (content.includes(added[0])) return 'already'; // already patched (reinstall/idempotent)
  if (!content.includes(removed[0])) {
    return warn('SDK cli.js does not match the patch context, skipping');
  }
  writeFileSync(cliPath, content.replace(removed[0], added[0]), 'utf8');
  console.log(`open-walnut postinstall: patched claude-agent-sdk@${installedVersion} (reminder disabled)`);
  return 'patched';
}

function main() {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

  if (isDevCheckout(root)) {
    // ── Dev chain (strict) ──
    const installer = installerOf();
    if (installer === 'bun') {
      const { cmd, args } = webInstallCommand();
      const res = spawnSync(cmd, args, { stdio: 'inherit', cwd: join(root, 'web') });
      process.exit(res.status === 0 ? 0 : 1);
    }
    console.warn(
      `open-walnut postinstall: this checkout installs with Bun (https://bun.sh): \`bun install\` gets the versions bun.lock pins.\n`
      + `  ${installer} reads no bun.lock and applies no patch, so its versions are its own picks.`,
    );
    let patched;
    try {
      patched = applySdkPatch(root);
    } catch (err) {
      console.error(`open-walnut postinstall: SDK patch failed: ${err instanceof Error ? err.message : err}`);
    }
    if (patched !== 'patched' && patched !== 'already') process.exit(1);
    const res = spawnSync('npm', npmWebInstallArgs(), { stdio: 'inherit', cwd: join(root, 'web') });
    process.exit(res.status === 0 ? 0 : 1);
  }

  // ── Published-package chain (fail-open) ──
  try {
    applySdkPatch(root);
  } catch (err) {
    console.warn(`open-walnut postinstall: SDK patch failed (continuing): ${err instanceof Error ? err.message : err}`);
  }
  process.exit(0);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
