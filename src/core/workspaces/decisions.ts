/**
 * Task workspace decisions, as pure functions (unit-tested without a host).
 *
 * The rule every cleanup follows: a workspace is removed only when nothing in it
 * would be lost. Uncommitted or unreadable work always keeps it. Committed work
 * that exists nowhere else keeps it too, except for a git worktree the user
 * removes by hand: its commits live on the branch, which then stays.
 */

import type { TaskWorkspace, WorkspaceProbeSummary, WorkspaceState } from './types.js'
import { GIT_WORKTREE_ID } from './registry.js'

export type CleanupTrigger = 'manual' | 'complete' | 'delete'

export interface CleanupDecision {
  /** remove: go ahead. keep: leave it, `reason` says why. confirm: remove after the user agrees to what `plan` says. */
  action: 'remove' | 'keep' | 'confirm'
  /** What the daemon must re-check before it removes (its second, independent layer). */
  requireMerged: boolean
  reason?: string
  /** Sentences for a confirm dialog: exactly what goes and what stays. */
  plan: string[]
}

/** Sessions of the task run in it. */
export function isLaunchReady(ws: TaskWorkspace | undefined): ws is TaskWorkspace & { cwd: string } {
  return !!ws && (ws.state === 'ready' || ws.state === 'kept') && typeof ws.cwd === 'string' && ws.cwd.length > 0
}

/**
 * A start must create it first. A removed one too: the task asked for isolation,
 * so its next start makes a new workspace (same provider and inputs) rather than
 * running in the folder it was made from.
 */
export function needsCreation(ws: TaskWorkspace | undefined): boolean {
  return !!ws && (ws.state === 'requested' || ws.state === 'failed' || ws.state === 'removed')
}

export function isBusy(state: WorkspaceState | undefined): boolean {
  return state === 'creating' || state === 'removing'
}

function repositories(n: number): string {
  return `${n} ${n === 1 ? 'repository' : 'repositories'}`
}

/** What a removal would delete and keep, in words. */
export function removalPlan(ws: TaskWorkspace, probe: WorkspaceProbeSummary): string[] {
  const lines: string[] = []
  const root = ws.root ?? '(unknown folder)'
  if (!probe.rootExists) lines.push(`The folder ${root} is already gone; Walnut only forgets it.`)
  else if (ws.provider === GIT_WORKTREE_ID) lines.push(`Deletes the worktree folder ${root}.`)
  else {
    const names = probe.repos.filter((r) => r.exists).map((r) => r.name ?? r.path.split('/').pop() ?? r.path)
    lines.push(`Asks ${ws.provider_name ?? ws.provider} to delete ${root}${names.length ? `, with ${repositories(names.length)} (${names.join(', ')})` : ''}.`)
  }
  if (ws.provider === GIT_WORKTREE_ID && ws.branch) {
    lines.push(probe.branchMerged === true
      ? `Deletes branch ${ws.branch}: its commits are already in another branch.`
      : `Keeps branch ${ws.branch}: it has commits that are not merged or pushed anywhere.`)
  }
  const ignoredLine = ignoredEntriesLine(probe)
  if (probe.rootExists && ignoredLine) lines.push(ignoredLine)
  return lines
}

/** Files git ignores (an .env, a build folder) are in no commit; a removal deletes them with the folder. */
function ignoredEntriesLine(probe: WorkspaceProbeSummary): string | null {
  const repos = probe.repos.filter((r) => r.exists && (r.ignoredCount ?? 0) > 0)
  const total = repos.reduce((n, r) => n + (r.ignoredCount ?? 0), 0)
  if (total === 0) return null
  // In a workspace of several repositories, each name says which one it is in.
  const several = probe.repos.filter((r) => r.exists).length > 1
  const names = repos.flatMap((r) => (r.ignored ?? []).map((e) => (several ? `${r.name ?? r.path.split('/').pop()}/${e}` : e))).slice(0, 5)
  const more = total > names.length ? `, and ${total - names.length} more` : ''
  return `Also deletes ${total} ${total === 1 ? 'entry' : 'entries'} git ignores, which no commit holds: ${names.join(', ')}${more}.`
}

export function cleanupDecision(ws: TaskWorkspace, probe: WorkspaceProbeSummary, trigger: CleanupTrigger): CleanupDecision {
  const plan = removalPlan(ws, probe)
  const problems = probe.problems.length ? probe.problems.join('; ') : 'it could not be checked'
  if (!probe.rootExists) return { action: 'remove', requireMerged: false, plan }
  if (!probe.clean) return { action: 'keep', requireMerged: true, reason: problems, plan }
  if (!probe.merged) {
    // A plugin workspace's unpushed commits live only in that folder: removing it loses them.
    if (trigger !== 'manual' || ws.provider !== GIT_WORKTREE_ID) return { action: 'keep', requireMerged: true, reason: problems, plan }
    return { action: 'confirm', requireMerged: false, plan }
  }
  return { action: trigger === 'manual' ? 'confirm' : 'remove', requireMerged: trigger !== 'manual', plan }
}

/** Kept-reason text without the daemon's own "kept:" prefix. */
export function keptReason(error: string | undefined): string {
  return (error ?? '').replace(/^kept: /, '').trim() || 'it could not be checked'
}

/** The folder and branch name for a task's workspace: a few words of what it is about, plus its id. */
export function workspaceName(task: { id: string; title?: string }, message?: string): string {
  const title = (task.title ?? '').trim()
  // A quick-start task still wears its placeholder ("Session: repo") when the
  // workspace is requested; the launch message says what the work is about.
  const base = /^Session: /.test(title) && message?.trim() ? message : title
  const words = base.replace(/<[^>]*>/g, ' ').split(/\s+/).filter(Boolean).slice(0, 6).join(' ')
  const head = words.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '')
  const id = task.id.toLowerCase().replace(/[^a-z0-9]+/g, '-')
  return head ? `${head}-${id}` : id
}

/** Is `p` the anchor, or inside the workspace? (A start naming one of these runs in the workspace.) */
export function belongsToWorkspace(ws: TaskWorkspace, p: string | undefined): boolean {
  if (!p) return true
  const strip = (s: string) => s.replace(/\/+$/, '') || '/'
  const target = strip(p)
  if (target === strip(ws.anchor)) return true
  const root = ws.root ? strip(ws.root) : ''
  return !!root && (target === root || target.startsWith(root + '/'))
}
