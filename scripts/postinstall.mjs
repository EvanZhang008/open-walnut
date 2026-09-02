#!/usr/bin/env node
/**
 * Unified postinstall — routes between two very different install shapes:
 *
 * DEV CHECKOUT (git clone; web/ + src/ present):
 *   patch-package && (cd web && npm install)
 *   Strict: any failure fails the install, same as the historical inline chain.
 *
 * PUBLISHED PACKAGE (npm install open-walnut / npx open-walnut):
 *   - patch-package is a devDependency and, even if present, resolves targets
 *     via ./node_modules/<name> — with npm hoisting the SDK lives in the
 *     PARENT node_modules, so it can never find it. Instead we parse our own
 *     patch file (single-hunk, single-line change) and apply it directly to
 *     the resolved install location.
 *   Fail-open: a cosmetic patch failure must never break `npm install` for a
 *   consumer — warn loudly and continue.
 */
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const isDevCheckout =
  existsSync(join(root, 'web', 'package.json')) && existsSync(join(root, 'src'));

function run(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, { stdio: 'inherit', cwd: root, ...opts });
  return res.status === 0;
}

if (isDevCheckout) {
  // ── Dev chain (strict) ──
  if (!run('npx', ['patch-package'])) process.exit(1);
  if (!run('npm', ['install'], { cwd: join(root, 'web') })) process.exit(1);
  process.exit(0);
}

// ── Published-package chain (fail-open) ──

function warn(msg) {
  console.warn(`open-walnut postinstall: ${msg}`);
}

/**
 * Apply the claude-agent-sdk reminder patch by parsing the shipped
 * patch-package diff. The patch is one hunk changing one line of the minified
 * cli.js bundle, which makes direct find-and-replace both exact and safe.
 * The .patch file stays the single source of truth — no duplicated strings.
 */
function applySdkPatch() {
  const patchesDir = join(root, 'patches');
  let patchFile = null;
  try {
    patchFile = readdirSync(patchesDir).find(
      (f) => f.startsWith('@anthropic-ai+claude-agent-sdk+') && f.endsWith('.patch'),
    );
  } catch { /* no patches dir shipped */ }
  if (!patchFile) return warn('SDK patch file not found, skipping');

  const patchVersion = patchFile.slice('@anthropic-ai+claude-agent-sdk+'.length, -'.patch'.length);

  // Resolve the installed SDK (may be hoisted to a parent node_modules).
  let sdkDir;
  try {
    const require_ = createRequire(import.meta.url);
    let dir = dirname(require_.resolve('@anthropic-ai/claude-agent-sdk'));
    while (dir !== dirname(dir) && !existsSync(join(dir, 'package.json'))) dir = dirname(dir);
    sdkDir = dir;
  } catch {
    return warn('claude-agent-sdk not resolvable, skipping SDK patch');
  }

  const installedVersion = JSON.parse(readFileSync(join(sdkDir, 'package.json'), 'utf8')).version;
  if (installedVersion !== patchVersion) {
    return warn(
      `SDK ${installedVersion} != patch target ${patchVersion} — skipping (file reads will carry the SDK's cyber reminder, costing context)`,
    );
  }

  // Extract the one removed and one added line from the diff.
  const lines = readFileSync(join(patchesDir, patchFile), 'utf8').split('\n');
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
  if (content.includes(added[0])) return; // already patched (reinstall/idempotent)
  if (!content.includes(removed[0])) {
    return warn('SDK cli.js does not match the patch context, skipping');
  }
  writeFileSync(cliPath, content.replace(removed[0], added[0]), 'utf8');
  console.log(`open-walnut postinstall: patched claude-agent-sdk@${installedVersion} (reminder disabled)`);
}

try {
  applySdkPatch();
} catch (err) {
  warn(`SDK patch failed (continuing): ${err instanceof Error ? err.message : err}`);
}

process.exit(0);
