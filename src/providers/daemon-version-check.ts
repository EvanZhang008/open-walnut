/**
 * Startup sanity check: is dist/daemon-binaries/*.version consistent with
 * the current daemon source code?
 *
 * Why this exists: the build pipeline is now wired so `npm run build` (and
 * `web:build`, `dev:prod`) automatically rebuilds daemon binaries. But a
 * developer can still:
 *   - Edit daemon source, then run the already-built `dist/cli.js` directly
 *     without rebuilding
 *   - Have a stale cached build from a different branch
 *
 * In either case the remote host will get a binary whose protocol doesn't
 * match the server code — silent permission hangs (the exact bug that
 * prompted this whole safeguard stack).
 *
 * We recompute the *expected* version at boot using the same algorithm as
 * scripts/build-daemon.sh (sha256 of daemon source files, truncated to 12
 * chars) and compare it against the .version sidecar. On mismatch we log
 * loudly and auto-rebuild; if rebuild fails we refuse to start.
 */

import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { log } from '../logging/index.js'
import { DAEMON_BINARIES_DIR } from '../constants.js'

const DAEMON_SOURCE_FILES = [
  'src/providers/daemon-standalone.ts',
  'src/providers/daemon-core.ts',
  'src/providers/daemon-fold.ts',
  'src/providers/daemon-source.ts',
  // ACP worker stack — compiled into the daemon deploy unit (worker artifact
  // ships with the daemon; version skew impossible by construction).
  'src/providers/acp-daemon.ts',
  'src/providers/acp-worker/worker.ts',
  'src/providers/acp-worker/worker-main.ts',
  'src/providers/acp-worker/journal.ts',
  'src/providers/acp-worker/protocol.ts',
] as const

/**
 * Compute the expected daemon version from source files.
 * Returns null if sources can't be located (e.g. running from a published
 * npm package where src/ wasn't shipped — in that case the binary is
 * whatever was baked in, and we have to trust it).
 */
export function computeExpectedDaemonVersion(): string | null {
  const repoRoot = findRepoRoot()
  if (!repoRoot) return null

  // Per-file: path + NUL + content + NUL. The separator prevents boundary
  // collisions (e.g. shifting bytes between file A and file B shouldn't
  // produce the same hash). MUST stay in lockstep with scripts/build-daemon.sh
  // — if you change the algorithm here, change it there too.
  const hash = createHash('sha256')
  const NUL = Buffer.from([0])
  for (const rel of DAEMON_SOURCE_FILES) {
    const abs = path.join(repoRoot, rel)
    try {
      hash.update(Buffer.from(rel))
      hash.update(NUL)
      hash.update(fs.readFileSync(abs))
      hash.update(NUL)
    } catch {
      return null  // Source tree not available — skip the check
    }
  }
  return 'walnut-daemon-' + hash.digest('hex').slice(0, 12)
}

function findRepoRoot(): string | null {
  // dist/providers/daemon-version-check.js → ../../
  // Dual marker: package.json alone matches installed npm packages which MUST
  // be skipped (no sources → trust binary). Presence of the daemon source file
  // distinguishes a dev checkout from an npm-installed copy.
  let dir = path.dirname(fileURLToPath(import.meta.url))
  // Belt-and-suspenders: 10 levels covers pnpm/nested/monorepo layouts.
  for (let i = 0; i < 10; i++) {
    if (fs.existsSync(path.join(dir, 'package.json'))
      && fs.existsSync(path.join(dir, 'src', 'providers', 'daemon-standalone.ts'))) {
      return dir
    }
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return null
}

function readBuiltVersions(): Map<string, string> {
  const out = new Map<string, string>()
  try {
    for (const f of fs.readdirSync(DAEMON_BINARIES_DIR)) {
      if (!f.endsWith('.version')) continue
      const arch = f.slice(0, -'.version'.length)
      const v = fs.readFileSync(path.join(DAEMON_BINARIES_DIR, f), 'utf-8').trim()
      if (v) out.set(arch, v)
    }
  } catch { /* no binaries dir — nothing built yet */ }
  return out
}

/**
 * Verify dist/daemon-binaries/*.version matches current daemon source.
 *
 * On mismatch, runs `bash scripts/build-daemon.sh` synchronously to rebuild.
 *
 * @returns `true` if versions are consistent (or rebuild succeeded),
 *          `false` if out of sync and rebuild failed.
 */
export function verifyDaemonBinaryVersion(): boolean {
  const expected = computeExpectedDaemonVersion()
  if (!expected) {
    // Can't locate daemon sources (e.g. installed npm package). Trust the
    // baked-in binary — nothing we can do.
    return true
  }

  const built = readBuiltVersions()

  if (built.size === 0) {
    // No binaries yet. dev:prod always builds them, so this is only hit if
    // someone runs a bare `node dist/cli.js web` after a fresh checkout.
    return handleMismatch({
      reason: 'no daemon binaries built',
      expected,
      got: '(none)',
    })
  }

  const mismatched: Array<{ arch: string, got: string }> = []
  for (const [arch, version] of built) {
    if (version !== expected) mismatched.push({ arch, got: version })
  }

  if (mismatched.length === 0) {
    log.session.info('daemon binary version check OK', { expected })
    return true
  }

  return handleMismatch({
    reason: 'daemon source has drifted from built binaries',
    expected,
    got: mismatched.map(m => `${m.arch}=${m.got}`).join(', '),
  })
}

function handleMismatch(ctx: {
  reason: string
  expected: string
  got: string
}): boolean {
  log.session.error('DAEMON VERSION DRIFT DETECTED', ctx)
  // eslint-disable-next-line no-console
  console.error(
    `\n⚠️  DAEMON VERSION DRIFT: ${ctx.reason}`
    + `\n    expected: ${ctx.expected}`
    + `\n    built:    ${ctx.got}`
    + `\n    Remote hosts would receive a daemon whose protocol doesn't match this server.`
    + `\n    This is the bug that silently hangs permission approvals.`
    + `\n`,
  )

  const repoRoot = findRepoRoot()
  if (!repoRoot) {
    // eslint-disable-next-line no-console
    console.error('    Cannot auto-rebuild (no repo root). Refusing to start.\n')
    return false
  }

  // Always attempt to auto-rebuild. Rebuild takes 1-2s with bun compile and
  // the cost of shipping a drifted binary (silent permission hangs) vastly
  // outweighs the inconvenience of an unexpected rebuild at startup.
  // eslint-disable-next-line no-console
  console.error(`    Running: bash scripts/build-daemon.sh ...\n`)
  const res = spawnSync('bash', ['scripts/build-daemon.sh'], {
    cwd: repoRoot,
    stdio: 'inherit',
    timeout: 120_000,
  })
  if (res.status === null) {
    // eslint-disable-next-line no-console
    console.error('\n⚠️  Daemon rebuild timed out after 120s — is bun installed and on PATH?\n')
    return false
  }
  if (res.status !== 0) {
    // eslint-disable-next-line no-console
    console.error('\n⚠️  Daemon rebuild FAILED. Refusing to start — remote sessions would be broken.\n')
    return false
  }

  // Re-verify after rebuild
  const builtAfter = readBuiltVersions()
  for (const [arch, v] of builtAfter) {
    if (v !== ctx.expected) {
      // eslint-disable-next-line no-console
      console.error(
        `\n⚠️  Rebuild completed but ${arch} version is still ${v}, expected ${ctx.expected}.`
        + `\n    This almost certainly means the shell hash algorithm in`
        + `\n    scripts/build-daemon.sh has drifted from computeExpectedDaemonVersion()`
        + `\n    in daemon-version-check.ts. They must compute the SAME hash over:`
        + `\n      files: ${DAEMON_SOURCE_FILES.join(', ')}`
        + `\n      algorithm: sha256, per-file path + NUL + content + NUL, truncate to 12 hex chars`
        + `\n`,
      )
      return false
    }
  }
  log.session.info('daemon binaries rebuilt after version drift', { expected: ctx.expected })
  // eslint-disable-next-line no-console
  console.error(`    ✓ Daemon binaries rebuilt to ${ctx.expected}. Continuing startup.\n`)
  return true
}
