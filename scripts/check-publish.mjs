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
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const required = [
  'bin/open-walnut.js',
  'dist/cli.js',                    // bin entry target
  'dist/web/server.js',             // web server bundle
  'dist/web/static/index.html',     // built SPA
  'dist/data',                      // shipped skills/templates
  'dist/build-info.json',           // which commit this build came from (tsup writes it)
  // Builtin first-party plugin Apps. A missing bundle is INVISIBLE at runtime — the
  // plugin loads with no App and the Settings row is simply absent — so the tarball
  // is where it has to be caught (scripts/ship-builtin-plugins.mjs writes these).
  'dist/integrations/walnut-time/manifest.json',
  'dist/integrations/walnut-time/dist/web.mjs',
  'dist/daemon-binaries/acp-worker.js',
  // The npm install's local daemon is the source twin; this sidecar is what lets
  // it run Codex, Gemini, OpenCode, Goose and Pi (see daemon-source.ts).
  'dist/daemon-binaries/acp-daemon-core.cjs',
  'dist/daemon-binaries/pi-acp.js',
  'dist/daemon-binaries/pi-acp.LICENSE',
  'dist/daemon-binaries/daemon-cron-runtime.cjs',
  'dist/daemon-binaries/daemon-instance-lock.cjs',
  'dist/daemon-binaries/daemon-service-cli.cjs',
  'patches',
  'scripts/postinstall.mjs',
];

// Prebuilt dtach (scripts/build-dtach.sh): a Mac without the Command Line Tools has
// no compiler, so the tarball is its only way to a persistent terminal. The build
// skips the step quietly on a machine without a compiler, which is right for a
// dev build and wrong for a release, so a machine that CAN build it must have.
const hostDtach = hostPrebuiltDtachName();
if (hostDtach && compilerWorks()) {
  required.push(`dist/daemon-binaries/${hostDtach}`, `dist/daemon-binaries/${hostDtach}.source-hash`);
}

const missing = required.filter((rel) => !existsSync(join(root, rel)));
if (missing.length) {
  console.error('check-publish: missing build artifacts:\n' + missing.map((m) => `  - ${m}`).join('\n'));
  console.error('Run `npm run build && cd web && npx vite build` first.');
  process.exit(1);
}

// Every shipped dtach must be built from the vendored source as it is now (dist/ is
// never cleaned, so an old build can linger) and must run here when it is ours.
const dtachFiles = readdirSync(join(root, 'dist/daemon-binaries')).filter((f) => /^dtach-[a-z]+-[a-z0-9]+$/.test(f));
if (dtachFiles.length) {
  const expectedHash = execFileSync('bash', [join(root, 'scripts/build-dtach.sh'), '--print-hash'], { cwd: root, encoding: 'utf8' }).trim();
  for (const f of dtachFiles) {
    const sidecar = join(root, 'dist/daemon-binaries', `${f}.source-hash`);
    const got = existsSync(sidecar) ? readFileSync(sidecar, 'utf8').trim() : '(missing)';
    if (got !== expectedHash) {
      console.error(`check-publish: dist/daemon-binaries/${f} was built from other dtach sources (${got}, want ${expectedHash}); run \`bash scripts/build-dtach.sh\`.`);
      process.exit(1);
    }
  }
  if (hostDtach && dtachFiles.includes(hostDtach)) {
    let help = '';
    try {
      help = execFileSync(join(root, 'dist/daemon-binaries', hostDtach), ['--help'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      help = `${err.stdout ?? ''}${err.stderr ?? ''}`;
    }
    if (!help.includes('dtach - version')) {
      console.error(`check-publish: dist/daemon-binaries/${hostDtach} does not run here (--help printed: ${help.slice(0, 200) || 'nothing'}).`);
      process.exit(1);
    }
  }
}

// Build info: tsup rewrites it after every successful build but never fails the build over it,
// so a leftover file from an older build would ship a wrong commit. The version
// must match the package being published.
const pkgVersion = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
const buildInfo = JSON.parse(readFileSync(join(root, 'dist/build-info.json'), 'utf8'));
if (buildInfo.version !== pkgVersion) {
  console.error(`check-publish: dist/build-info.json is for ${buildInfo.version}, package.json is ${pkgVersion}; rebuild.`);
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

const mustInclude = [
  'dist/cli.js', 'dist/web/static/index.html', 'scripts/postinstall.mjs', 'dist/build-info.json',
  'dist/daemon-binaries/pi-acp.js', 'dist/daemon-binaries/pi-acp.LICENSE',
  'dist/daemon-binaries/acp-worker.js', 'dist/daemon-binaries/acp-daemon-core.cjs',
  'dist/daemon-binaries/daemon-cron-runtime.cjs',
  'dist/daemon-binaries/daemon-instance-lock.cjs',
  'dist/daemon-binaries/daemon-service-cli.cjs',
  ...dtachFiles.flatMap((f) => [`dist/daemon-binaries/${f}`, `dist/daemon-binaries/${f}.source-hash`]),
];
const notPacked = mustInclude.filter((f) => !files.includes(f));
if (notPacked.length) {
  console.error('check-publish: files allowlist excludes required artifacts:\n' + notPacked.map((m) => `  - ${m}`).join('\n'));
  process.exit(1);
}
const leaked = files.filter((f) => /^dist\/daemon-binaries\/daemon-(linux|darwin)-/.test(f) || f.endsWith('.map') || f.endsWith('.gz'));
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

/** dtach-<platform>-<arch> for this machine, in Node's words; null when none is built. */
function hostPrebuiltDtachName() {
  const platform = { darwin: 'darwin', linux: 'linux' }[process.platform];
  const arch = { arm64: 'arm64', x64: 'x64' }[process.arch];
  return platform && arch ? `dtach-${platform}-${arch}` : null;
}

/** Same test as build-dtach.sh: a compiler that answers --version (a Mac's cc stub does not). */
function compilerWorks() {
  for (const cc of ['cc', 'clang', 'gcc']) {
    try {
      execFileSync(cc, ['--version'], { stdio: 'ignore', timeout: 20_000 });
      return true;
    } catch { /* try the next one */ }
  }
  return false;
}
