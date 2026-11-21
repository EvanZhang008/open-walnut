/**
 * Run a short-lived engine CLI (a `--version` probe, an `export`) with a temp
 * directory of its own, removed when the call ends.
 *
 * Why: a CLI compiled with `bun build --compile` that embeds a native library
 * extracts it into $TMPDIR on every start and never removes it. OpenCode does:
 * each `opencode --version` leaves an 860 KB `.<hex>-00000000.dylib` behind.
 * The engine probe runs it about once a minute while a catalog is read, so the
 * Mac's temp dir held 807 of them (0.7 GB, ~250 a day) on 2026-11-21 while its
 * disk sat under the "Disk space low" line. Pointing TMPDIR at a private dir
 * and removing that dir afterwards ends the leak for every such CLI, whoever
 * built it, without knowing its file names.
 *
 * Every short CLI run of an engine binary goes through here; the ratchet
 * tests/lib/cli-private-tmp.test.ts finds the call sites from the source.
 */
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

export const CLI_TMP_PREFIX = 'walnut-cli-tmp-'

/** A private dir older than this was left by a process that died mid-call. */
const STALE_MS = 24 * 3600_000

let staleSwept = false

/** Once a process, in the background: remove private dirs a dead process left (a crash between run and cleanup). */
async function sweepStale(root: string, now: number): Promise<void> {
  let names: string[]
  try { names = await fsp.readdir(root) } catch { return }
  for (const name of names) {
    if (!name.startsWith(CLI_TMP_PREFIX)) continue
    const dir = path.join(root, name)
    try {
      const st = await fsp.lstat(dir)
      if (!st.isDirectory() || now - st.mtimeMs < STALE_MS) continue
      await fsp.rm(dir, { recursive: true, force: true })
    } catch { /* raced or pinned: the next process tries again */ }
  }
}

/**
 * Call `run` with `env` whose TMPDIR/TMP/TEMP name a fresh private dir under
 * the real temp root, then remove that dir. Never fails because of the dir: if
 * it cannot be made, `run` gets `env` unchanged.
 */
export async function withPrivateTmp<T>(env: NodeJS.ProcessEnv, run: (env: NodeJS.ProcessEnv) => Promise<T>): Promise<T> {
  const root = os.tmpdir()
  if (!staleSwept) { staleSwept = true; void sweepStale(root, Date.now()) }
  let dir: string | null = null
  try { dir = await fsp.mkdtemp(path.join(root, CLI_TMP_PREFIX)) } catch { dir = null }
  if (!dir) return run(env)
  try {
    return await run({ ...env, TMPDIR: dir, TMP: dir, TEMP: dir })
  } finally {
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}

/** Test seam: sweep stale private dirs under `root` now. */
export function sweepStalePrivateTmpForTest(root: string, now: number): Promise<void> {
  return sweepStale(root, now)
}
