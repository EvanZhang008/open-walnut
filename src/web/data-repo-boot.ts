/**
 * The data repo's boot order (server.ts): compaction crash recovery first (it moves main, so no
 * git step runs before it settles), then ensureRepo once, then every boot pull. ensureRepo drops
 * machine-local files that are still tracked before anything merges: a pull before it lets a
 * remote deletion of such a file reach the disk (the 2026-07-25 incident). It is async since
 * 2026-11-22 (about a second of git children), so a pull that waited only for the recovery could
 * now run first.
 */
import { ensureRepo, gitPullWalnut } from '../integrations/git-sync.js'

export interface RepoState { available: boolean; error?: string }

/** The data repo checked once, after the recovery: what startGitAutoCommit and the boot pull both wait for. */
export function dataRepoReady(
  recovered: Promise<unknown>,
  ensure: () => Promise<RepoState> = ensureRepo,
): Promise<RepoState> {
  return recovered
    .then(() => ensure())
    .catch((err): RepoState => ({ available: false, error: err instanceof Error ? err.message : String(err) }))
}

/**
 * The boot pull, started once `ready` says the repo is there (false: none to pull into, nothing
 * runs), then `after` (the reconcile the server does after a pull). Resolves with whether it ran;
 * a failure rejects, for the caller to log.
 */
export async function bootPull(
  ready: Promise<boolean>,
  after: () => Promise<void>,
  pull: () => Promise<void> = gitPullWalnut,
): Promise<boolean> {
  if (!(await ready)) return false
  await pull()
  await after()
  return true
}
