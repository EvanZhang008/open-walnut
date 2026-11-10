/**
 * Rebuildable tool caches on a host that grow without a bound, pruned while its
 * disk is below the floor (`taskdir.pruneCaches`, capability host-cache-prune-v1;
 * the server asks only for its own machine, src/core/task-dir-sweep.ts).
 *
 * Today one cache: bun's runtime transpiler cache (`@t@`), one file per module
 * version it ever compiled, never evicted. 2026-11-10: 3.1 GB on a Mac whose
 * agents run many checkouts, 2.5 GB of it untouched for 6 hours. Only regular
 * files directly in that folder and older than the cutoff go; bun compiles a
 * missing one again on its next run, and a file a running bun has open stays
 * readable through its descriptor.
 *
 * Bundled into the binary daemon and the task-dir-core.cjs sidecar.
 */
import fsp from 'node:fs/promises'
import path from 'node:path'

/** Where bun keeps its transpiler cache on this host (the folders that exist are pruned). */
export function bunTranspilerCacheDirs(env: NodeJS.ProcessEnv, home: string, platform: string = process.platform): string[] {
  // Only bun's default places, each ending in its own `@t@` folder: a path named in
  // BUN_RUNTIME_TRANSPILER_CACHE_PATH could be anything, and is left alone.
  const dirs = new Set<string>()
  if (env.XDG_CACHE_HOME) dirs.add(path.join(env.XDG_CACHE_HOME, 'bun', '@t@'))
  dirs.add(path.join(home, '.cache', 'bun', '@t@'))
  if (platform === 'darwin') dirs.add(path.join(home, 'Library', 'Caches', 'bun', '@t@'))
  return [...dirs]
}

export interface CachePruneResult { removedFiles: number; removedBytes: number; dirs: string[] }

export async function pruneHostCaches(dirs: readonly string[], olderThanMs: number, now = Date.now()): Promise<CachePruneResult> {
  const out: CachePruneResult = { removedFiles: 0, removedBytes: 0, dirs: [] }
  const cutoff = now - olderThanMs
  for (const dir of dirs) {
    let names: string[]
    try {
      if (!(await fsp.lstat(dir)).isDirectory()) continue
      names = await fsp.readdir(dir)
    } catch { continue }
    out.dirs.push(dir)
    let n = 0
    for (const name of names) {
      const p = path.join(dir, name)
      try {
        const st = await fsp.lstat(p)
        if (!st.isFile() || st.mtimeMs >= cutoff) continue
        await fsp.unlink(p)
        out.removedFiles++
        out.removedBytes += st.size
      } catch { /* gone or busy: next time */ }
      // Give the daemon's loop back now and then.
      if (++n % 200 === 0) await new Promise((r) => setImmediate(r))
    }
  }
  return out
}
