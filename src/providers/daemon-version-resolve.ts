/**
 * The session daemon's version as this server's own build describes it: the
 * .version sidecar of a bundled build, else the hash of the daemon's sources
 * (daemon-version-check.ts), else the package version.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { computeExpectedDaemonVersion } from './daemon-version-check.js'

/**
 * The daemon version this server's build carries (what it expects a daemon it
 * starts or deploys to report).
 *
 * INVARIANT: the version must describe the DAEMON BYTES THIS BUILD CARRIES,
 * never the worktree. A long-running server whose bundle predates a source
 * edit still holds the OLD daemon; hashing the worktree would label those
 * stale bytes with the NEW version, and every later server then sees "version
 * match" and skips the upgrade forever (clouddev ran a mislabeled stale daemon
 * exactly this way, 2026-08-22). So:
 *   1. Bundled run (this module lives under dist/): the .version sidecar
 *      written by the SAME build as this bundle: build-daemon.sh and the server
 *      build run back to back, so sidecar and bundle share one tree.
 *   2. Source run (bun/vitest: the daemon IS the worktree): sha256 of the
 *      daemon source tree, same algorithm the binaries bake in.
 *   3. DAEMON_VERSION env (compile-time define passthrough)
 *   4. `walnut-daemon-pkg-<version>` from the installed package.json — the
 *      published-npm-package case, where src/ doesn't ship so (2) is null.
 *      Package version identifies the shipped code exactly, and a package
 *      upgrade changes the version, so the daemon restarts with the new code.
 *   5. 'dev-source': nothing else resolvable (should not happen in practice).
 */
export function resolveDaemonSourceVersion(): string {
  const here = fileURLToPath(import.meta.url)
  const bundled = here.split(path.sep).includes('dist')
  if (bundled) {
    const sidecar = bundledSidecarVersion(here)
    if (sidecar) return sidecar
  }
  const computed = computeExpectedDaemonVersion()
  if (computed) return computed
  if (process.env.DAEMON_VERSION) return process.env.DAEMON_VERSION
  // Walk up from this bundle (dist/cli.js or dist/providers/...) to the
  // open-walnut package.json.
  let dir = path.dirname(fileURLToPath(import.meta.url))
  for (let i = 0; i < 10; i++) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf-8')) as {
        name?: string
        version?: string
      }
      if (pkg.name === 'open-walnut' && pkg.version) return `walnut-daemon-pkg-${pkg.version}`
    } catch { /* keep walking */ }
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return 'dev-source'
}

/** The sidecar answer per bundle path, read once a process. */
const sidecarByBundle = new Map<string, string | null>()

/**
 * The .version sidecar of the bundle at `here`, read once a process: a bundle's sidecar is
 * written by its own build before the server starts and never changes under it, and the read is
 * synchronous on the loop thread (a 2.3 s hold in readdirSync on the Mac under load, stall profile
 * 2026-11-16T16:20:48Z), asked again on every daemon handshake and host file build.
 */
export function bundledSidecarVersion(here: string): string | null {
  if (!sidecarByBundle.has(here)) sidecarByBundle.set(here, readSidecarDaemonVersion(here))
  return sidecarByBundle.get(here)!
}

/**
 * Read the daemon .version sidecar that sits next to this bundle
 * (dist/daemon-binaries/*.version). Pure path-walk from the module location so
 * a unit test can pin it; returns null when no sidecar is readable (e.g. the
 * binaries were never built) — callers fall back to the worktree hash.
 */
export function readSidecarDaemonVersion(fromPath: string): string | null {
  let dir = path.dirname(fromPath)
  for (let i = 0; i < 5; i++) {
    // Any *.version sidecar works — build-daemon.sh writes the same version
    // string for every platform in one build, so no platform-specific name.
    const binDir = path.join(dir, 'daemon-binaries')
    try {
      for (const name of fs.readdirSync(binDir)) {
        if (!name.endsWith('.version')) continue
        const v = fs.readFileSync(path.join(binDir, name), 'utf-8').trim()
        if (v) return v
      }
    } catch { /* keep walking */ }
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return null
}
