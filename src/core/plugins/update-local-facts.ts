/**
 * The three no-network facts of a linked checkout, read fresh on every status snapshot:
 * is the tree dirty, where is HEAD, and how far is it from the upstream commit the last
 * fetch saw. Every command is bounded and none touches the network, so a snapshot stays
 * a local read even when the remote is gone.
 */

import { execGitArgsGroup } from '../../integrations/git-sync.js'
import { LOCAL_FACTS_DEADLINE_MS } from './update-status.js'

export interface LocalFacts {
  dirty: boolean
  head: string
  behind: number | null
  ahead: number | null
  /** HEAD differs from the one at fetch time AND the cached upstream commit is no longer under any local branch. */
  moved: boolean
}

export interface LocalFactsOptions {
  headAtFetch?: string | null
  deadlineMs?: number
}

async function gitOrNull(args: string[], cwd: string, timeout: number): Promise<string | null> {
  try {
    return await execGitArgsGroup(args, { cwd, timeout })
  } catch {
    return null
  }
}

/**
 * `git status --porcelain`, `git rev-parse HEAD`, `git rev-list --left-right --count
 * <remoteRef>...HEAD`, each bounded, none touching the network. `moved` is true when HEAD
 * is not the one the fetch saw AND `remoteRef` sits under no local branch (a reset, a
 * branch switch, anything that is not a commit on top or a pull): the cached counts then
 * describe a checkout that no longer exists and the row must say "not checked".
 * `git branch --contains` answers "any local ref" in ONE call, where `merge-base
 * --is-ancestor` would need one call per branch.
 */
export async function readLocalFacts(
  checkout: string,
  remoteRef: string,
  opts: LocalFactsOptions = {},
): Promise<LocalFacts> {
  const timeout = opts.deadlineMs ?? LOCAL_FACTS_DEADLINE_MS
  const [status, head, counts] = await Promise.all([
    gitOrNull(['status', '--porcelain'], checkout, timeout),
    gitOrNull(['rev-parse', 'HEAD'], checkout, timeout),
    gitOrNull(['rev-list', '--left-right', '--count', `${remoteRef}...HEAD`], checkout, timeout),
  ])
  // An unanswerable status counts as dirty: the one direction where a wrong answer loses work.
  const dirty = status === null ? true : status.length > 0
  let behind: number | null = null
  let ahead: number | null = null
  if (counts !== null) {
    const [left, right] = counts.split(/\s+/)
    behind = Number.parseInt(left ?? '', 10) || 0
    ahead = Number.parseInt(right ?? '', 10) || 0
  }
  let moved = false
  const headNow = head ?? ''
  if (counts === null) {
    moved = true // the cached upstream commit is not even known here any more
  } else if (opts.headAtFetch && headNow && headNow !== opts.headAtFetch) {
    const holders = await gitOrNull(['branch', '--contains', remoteRef, '--format=%(refname)'], checkout, timeout)
    moved = holders === null || holders.trim().length === 0
  }
  return { dirty, head: headNow, behind, ahead, moved }
}
