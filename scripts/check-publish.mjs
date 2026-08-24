#!/usr/bin/env node
/**
 * Pre-publish gate (runs from prepublishOnly, after the full build).
 *
 * `dist/` is gitignored, so nothing in git guarantees the tarball actually
 * contains runnable artifacts — a publish from a stale or partial build would
 * ship a package whose bin exits with MODULE_NOT_FOUND. Verify every artifact
 * the published package needs, then verify the tarball's file list via
 * `npm pack --dry-run` (catches `files` allowlist regressions).
 */
import { execFileSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const required = [
  'bin/open-walnut.js',
  'dist/cli.js',                    // bin entry target
  'dist/web/server.js',             // web server bundle
  'dist/web/static/index.html',     // built SPA
  'dist/data',                      // shipped skills/templates
  // Builtin first-party plugin Apps. A missing bundle is INVISIBLE at runtime — the
  // plugin loads with no App and the Settings row is simply absent — so the tarball
  // is where it has to be caught (scripts/ship-builtin-plugins.mjs writes these).
  'dist/integrations/walnut-time/manifest.json',
  'dist/integrations/walnut-time/dist/web.mjs',
  'dist/workers/qmd-index-worker.js',
  'dist/daemon-binaries/acp-worker.js', // plain JS bundle (kept; daemon-* binaries excluded)
  'patches',
  'scripts/postinstall.mjs',
  'scripts/patch-qmd.mjs',
];

const missing = required.filter((rel) => !existsSync(join(root, rel)));
if (missing.length) {
  console.error('check-publish: missing build artifacts:\n' + missing.map((m) => `  - ${m}`).join('\n'));
  console.error('Run `npm run build && cd web && npx vite build` first.');
  process.exit(1);
}

// SPA freshness: a server bundle newer than the SPA build usually means someone
// rebuilt the server and forgot vite build. Warn-only — timestamps lie in CI.
const serverMtime = statSync(join(root, 'dist/web/server.js')).mtimeMs;
const spaMtime = statSync(join(root, 'dist/web/static/index.html')).mtimeMs;
if (serverMtime - spaMtime > 60 * 60 * 1000) {
  console.warn('check-publish: WARNING — dist/web/static is >1h older than the server bundle; SPA may be stale.');
}

// Tarball audit: the daemon mach-o binaries (~280MB) must never ship; the
// runnable artifacts must. npm pack --dry-run --json gives the exact list.
const packJson = execFileSync('npm', ['pack', '--dry-run', '--json'], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
const [pack] = JSON.parse(packJson);
const files = pack.files.map((f) => f.path);

const mustInclude = ['dist/cli.js', 'dist/web/static/index.html', 'scripts/postinstall.mjs'];
const notPacked = mustInclude.filter((f) => !files.includes(f));
if (notPacked.length) {
  console.error('check-publish: files allowlist excludes required artifacts:\n' + notPacked.map((m) => `  - ${m}`).join('\n'));
  process.exit(1);
}
const leaked = files.filter((f) => /^dist\/daemon-binaries\/daemon-/.test(f) || f.endsWith('.map') || f.endsWith('.gz'));
if (leaked.length) {
  console.error('check-publish: tarball leaks excluded artifacts:\n' + leaked.slice(0, 10).map((m) => `  - ${m}`).join('\n'));
  process.exit(1);
}

const totalMB = (pack.unpackedSize / 1024 / 1024).toFixed(1);
console.log(`check-publish: OK — ${pack.entryCount} files, ${totalMB} MB unpacked.`);
if (pack.unpackedSize > 200 * 1024 * 1024) {
  console.error('check-publish: unpacked size exceeds 200MB — something large slipped into the tarball.');
  process.exit(1);
}
