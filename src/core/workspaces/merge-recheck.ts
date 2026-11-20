/**
 * Task workspaces: the re-check of one a completion cleanup kept ONLY because its
 * commits were not merged or pushed anywhere yet (clean, nothing stashed or unlisted).
 *
 * A code review usually merges such commits a few days later, often rebased to new
 * hashes. So every 6 hours, for 14 days after it was kept, the host fetches the
 * remotes and probes again, counting a commit whose exact patch is already on the
 * upstream (`git cherry` marks it '-', then `git patch-id --verbatim` confirms it) as
 * merged ('workspace-recheck-v1', workspace-core.ts). Once nothing in it would be lost
 * it goes through the normal removal (beginRemoval from `kept`), and the daemon's own
 * probe before it deletes judges the same way. `workspaces.merge_recheck: false` in the
 * config turns it all off (no background fetch, nothing looks again).
 *
 * Fail closed: a host that cannot be reached, a daemon without the capability, a fetch
 * that fails, a session or script still at work, or a task reopened meanwhile leaves
 * it kept, and so does a check that did not finish (a provider listing that failed, a
 * repository git could not read): both are tried again at the next turn. After 14 days
 * the kept reason says Walnut stopped checking and why. The
 * bookkeeping lives on the task row (`kept_at`, `merge_recheck`), so a restart picks
 * it up. Only the Walnut that made a workspace checks it (madeHere).
 */

import type { Task } from '../types.js'
import type { TaskWorkspace, WorkspaceProbeSummary } from './types.js'
import { cleanupDecision, isLaunchReady } from './decisions.js'
import { WorkspaceError } from './daemon-client.js'
import { beginRemoval, errText, madeHere, managerDeps, probeWorkspace, stamp } from './manager.js'
import { scriptRunning } from './scripts.js'
import { log } from '../../logging/index.js'

export const MERGE_RECHECK_EVERY_MS = 6 * 60 * 60_000
export const MERGE_RECHECK_FOR_MS = 14 * 24 * 60 * 60_000
/** How often the sweep looks for workspaces whose check is due (it acts only on those). */
export const MERGE_RECHECK_TICK_MS = 15 * 60_000
/** A re-check fetches every repository first: a plugin workspace of many takes a while. */
const RECHECK_RPC_MS = 10 * 60_000

/** Added to the kept reason while Walnut still checks (the web splits the reason on '; '). */
const CHECKING_NOTE = 'Walnut checks again every 6 hours, for 14 days, and removes it once they are merged'

const iso = (ms: number) => new Date(ms).toISOString()

function baseReason(reason: string | undefined): string {
  const r = (reason ?? '').trim()
  return r.endsWith(`; ${CHECKING_NOTE}`) ? r.slice(0, -(CHECKING_NOTE.length + 2)) : r
}

/**
 * The row patch of a cleanup that keeps it. `unmergedOnly`: kept only for commits not
 * merged yet, so it is checked again. `fromRecheck`: this keep follows a re-check, so
 * its 14 days keep counting from the first keep; any other keep starts them anew.
 */
export function keptPatch(cur: TaskWorkspace, reason: string, unmergedOnly: boolean, fromRecheck = false): Partial<TaskWorkspace> {
  const now = managerDeps().now()
  const keptAt = fromRecheck && cur.kept_at ? cur.kept_at : iso(now)
  if (!unmergedOnly) return { state: 'kept', kept_reason: reason, kept_at: keptAt, merge_recheck: undefined }
  const prior = fromRecheck ? cur.merge_recheck : undefined
  return {
    state: 'kept', kept_reason: `${baseReason(reason)}; ${CHECKING_NOTE}`, kept_at: keptAt,
    merge_recheck: { ...prior, next_at: iso(now + MERGE_RECHECK_EVERY_MS) },
  }
}

/** Kept for commits not merged yet, and nothing else: the probe shape the re-check is for. */
export function keptOnlyUnmerged(probe: WorkspaceProbeSummary): boolean {
  return probe.rootExists && probe.clean && !probe.merged
}

/**
 * Not clean only for what may pass by itself: the provider's listing failed or a folder scan
 * was cut short, or a repository could not be read. Work of its own (an uncommitted change, a
 * stash, a lost HEAD, a repository nobody listed) is not that.
 */
function unfinishedOnly(probe: WorkspaceProbeSummary): boolean {
  if (!probe.rootExists || probe.clean || probe.unlisted?.length) return false
  if (probe.repos.some((r) => r.dirty || r.stashed || r.lostHead)) return false
  return probe.blocked === true || probe.repos.some((r) => r.unreadable)
}

function dueAt(ws: TaskWorkspace): number {
  const at = Date.parse(ws.merge_recheck?.next_at ?? '')
  // An unreadable time is due now: the check then gives up or runs, never stalls forever.
  return Number.isFinite(at) ? at : 0
}

/** One pass: re-check, oldest due first, every kept workspace whose check is due. */
export async function sweepMergeRechecks(ctx?: { overBudget(): boolean }): Promise<number> {
  const deps = managerDeps()
  if (deps.cloudMode() || !(await deps.mergeRecheckOn())) return 0
  const now = deps.now()
  const due = (await deps.listTasks())
    .filter((t) => t.phase === 'COMPLETE' && t.workspace?.state === 'kept' && !!t.workspace.merge_recheck && dueAt(t.workspace) <= now)
    .sort((a, b) => dueAt(a.workspace!) - dueAt(b.workspace!))
  let checked = 0
  for (const t of due) {
    if (ctx?.overBudget()) break
    try {
      await recheckKeptWorkspace(t.id)
      checked++
    } catch (err) {
      log.web.warn('workspace merge re-check failed', { taskId: t.id, error: errText(err) })
    }
  }
  return checked
}

function stillKept(cur: TaskWorkspace | undefined, row: Readonly<Task>, root: string | undefined): cur is TaskWorkspace {
  return !!cur && cur.state === 'kept' && cur.root === root && !!cur.merge_recheck && row.phase === 'COMPLETE'
}

/** Why a check could not run, as the clause the kept reason ends with after 14 days. */
function unreachable(err: unknown): string {
  if (err instanceof WorkspaceError && err.code === 'daemon-upgrade') return "the host's Walnut daemon needs an update"
  return `the host could not be checked (${errText(err).slice(0, 200)})`
}

/** Check one kept workspace again; remove it when its commits are merged now. */
export async function recheckKeptWorkspace(taskId: string): Promise<'removing' | 'kept' | 'skipped' | 'stopped'> {
  const deps = managerDeps()
  const task = await deps.getTask(taskId)
  const ws = task?.workspace
  if (!task || task.phase !== 'COMPLETE' || !ws || ws.state !== 'kept' || !ws.merge_recheck || !isLaunchReady(ws)) return 'skipped'
  if (!(await deps.mergeRecheckOn()) || !(await madeHere(ws))) return 'skipped'
  const root = ws.root
  const now = deps.now()
  const note = (last: string, patch: Partial<TaskWorkspace> = {}) => deps.write(taskId, (cur, row) => (stillKept(cur, row, root)
    ? stamp(cur, { ...patch, merge_recheck: { ...cur.merge_recheck, next_at: iso(now + MERGE_RECHECK_EVERY_MS), last_at: iso(now), last } })
    : null))

  const keptAt = Date.parse(ws.kept_at ?? '')
  if (!Number.isFinite(keptAt) || now - keptAt >= MERGE_RECHECK_FOR_MS) {
    await deps.write(taskId, (cur, row) => (stillKept(cur, row, root)
      ? stamp(cur, {
        merge_recheck: undefined,
        kept_reason: `${baseReason(cur.kept_reason) || 'its commits are not merged'}; Walnut stopped checking it again 14 days after it was kept (last check: ${cur.merge_recheck?.last ?? 'none'})`,
      })
      : null))
    log.web.info('workspace merge re-check stopped after 14 days', { taskId, root, last: ws.merge_recheck.last })
    return 'stopped'
  }

  // Never while its work goes on: a session or a script in it, or a request it owes.
  const still = await deps.stillWorking(task, ws)
  if (still) {
    await note(`its work still went on (${still.why})`)
    return 'kept'
  }
  if (scriptRunning(ws)) {
    await note('a script ran in it')
    return 'kept'
  }
  // The clock moves before the probe: a check that hangs or crashes is not repeated at once.
  await note('the check did not finish')

  let probe: WorkspaceProbeSummary
  try {
    probe = await probeWorkspace(ws, RECHECK_RPC_MS, { recheck: true })
  } catch (err) {
    log.web.info('workspace merge re-check could not run', { taskId, root, error: errText(err) })
    await note(unreachable(err))
    return 'kept'
  }
  // An answer that did not fetch first is never judged here (an older daemon ignores the option).
  if (!probe.rechecked) {
    await note("the host's Walnut daemon needs an update")
    return 'kept'
  }
  const decision = cleanupDecision(ws, probe, 'complete')
  if (decision.action !== 'remove') {
    const reason = decision.reason ?? 'it could not be checked'
    if (unfinishedOnly(probe)) {
      // A listing that failed or a repository git could not read now: try again next time.
      await note(`the check did not finish (${probe.problems.slice(0, 2).join('; ').slice(0, 200) || 'it could not be read'})`)
      log.web.info('workspace merge re-check did not finish', { taskId, root, reason })
      return 'kept'
    }
    if (!keptOnlyUnmerged(probe)) {
      // New work in it (an uncommitted change, a stash, a repository nobody listed): kept as
      // any other, and nothing looks again; completing the task again starts over.
      await deps.write(taskId, (cur, row) => (stillKept(cur, row, root) ? stamp(cur, keptPatch(cur, reason, false, true)) : null))
      log.web.info('workspace merge re-check: it holds other work now, no more checks', { taskId, root, reason })
      return 'stopped'
    }
    await note(probe.fetchFailed?.length ? 'a fetch failed' : 'its commits were still not merged', { kept_reason: `${baseReason(reason)}; ${CHECKING_NOTE}` })
    log.web.info('workspace merge re-check: still kept', { taskId, root, reason })
    return 'kept'
  }
  if (await deps.stillWorking(task, ws)) {
    await note('its work still went on')
    return 'kept'
  }
  // The normal removal: a reopen or a removal by hand meanwhile wins inside its locked write.
  const started = await beginRemoval(task, ws, 'complete', (row) => stillKept(row.workspace, row, root), { recheck: true })
  if (!started) {
    log.web.info('workspace merge re-check: the task changed meanwhile', { taskId, root })
    return 'skipped'
  }
  log.web.info('workspace merged since it was kept: removing it', { taskId, root, provider: ws.provider })
  return 'removing'
}
