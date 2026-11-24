/**
 * A session whose folder was in its task's isolated workspace keeps working after a cleanup
 * removed that workspace (2026-11-16: two tasks on a dev host, each completed and cleaned up,
 * were sent a message later; every resume stopped at "Working directory no longer exists" and
 * the message stayed in the queue).
 *
 * A completed task's workspace is removed once nothing in it would be lost (cleanup.ts), but the
 * task can always be woken again: a peer's message, a trigger, a forced reopen. Keeping every
 * workspace for that would keep them all forever, so the workspace is made again instead, the
 * way a start of the task already makes a removed one again (decisions.ts needsCreation): same
 * provider, inputs and name, so the same folder, and its setup script runs again.
 *
 *  - The spawn's folder check (providers/claude-code-session.ts) waits for it (remakeForGoneFolder),
 *    so the common case goes on with no error and no parked message.
 *  - Every gone-folder refusal records the folder through noteFolderGone (sessions/folder-gone.ts),
 *    which hands a folder inside a workspace here instead (kickRemake): the remake goes on in the
 *    background and its end sends what waited (resumeAfterRemake, also from the workspace driver
 *    and the boot pass through `remade.resume`, so a restart in between loses nothing).
 *  - The session hears once per removal that its folder was made again (workspaceRemakeNotice,
 *    riding its next message as the other place notices do).
 *
 * A folder that is not a workspace Walnut made (a notes folder, a temp dir) is never recreated:
 * folder-gone.ts offers to continue in the task's own directory.
 */

import type { Task } from '../types.js'
import type { TaskWorkspace } from './types.js'
import { insideRoot, isLaunchReady, setupHoldsLaunch } from './decisions.js'
import { WorkspaceError } from './daemon-client.js'
import { madeHere, managerDeps, requestWorkspace, stamp, errText } from './manager.js'
import { createEnvelopeKit } from '../peers/envelope-kit.js'
import { log } from '../../logging/index.js'

/** How long a spawn waits for the workspace (a git worktree and its setup take seconds). */
export const SPAWN_WAIT_MS = 3 * 60_000
/** How long the "Continue" button's request waits before it answers that the remake goes on. */
export const BUTTON_WAIT_MS = 10_000
/** How long a remake kicked by a refusal is followed before the folder-gone way on is offered. */
const KICK_WAIT_MS = 20 * 60_000
/** After it is ready, the completion cleanup holds off this long: the waiting session starts in it. */
const CLEANUP_HOLD_MS = 2 * 60_000
const POLL_MS = 1_000

export type RemakeOutcome = 'present' | 'pending' | 'no'

const kit = createEnvelopeKit()
const strip = (p: string) => p.replace(/\/+$/, '')
const normHost = (h: string | null | undefined) => (!h || h === 'local' ? '__local__' : h)

/** The task's workspace holds `cwd` on `host` (by its folder, or the folder it is being made at again). */
function covers(ws: TaskWorkspace | undefined, cwd: string | null | undefined, host: string | null | undefined): ws is TaskWorkspace {
  if (!ws || !cwd || normHost(host) !== normHost(ws.host)) return false
  return insideRoot(ws.root ?? ws.remade?.root, cwd)
}

async function folderState(p: string, host: string | null | undefined) {
  const { folderState: probe } = await import('../sessions/folder-gone.js')
  return probe(p, host)
}

/**
 * `cwd` is gone and inside task `taskId`'s workspace: make the workspace again (or follow the
 * remake on its way) and wait up to `waitMs` for the folder. 'present': it is there now.
 * 'pending': still on its way (with `resume`, its end sends what waits). 'no': not this task's
 * workspace, not this Walnut's, or the remake failed: the gone-folder way on applies.
 */
export async function remakeForGoneFolder(taskId: string, cwd: string, host: string | null | undefined,
  opts: { waitMs?: number; resume?: boolean } = {}): Promise<RemakeOutcome> {
  const deps = managerDeps()
  if (deps.cloudMode() || !taskId || !cwd) return 'no'
  const deadline = deps.now() + (opts.waitMs ?? 0)
  let asked = false
  let marked = false
  for (;;) {
    const task = await deps.getTask(taskId)
    const ws = task?.workspace
    if (!task || !covers(ws, cwd, host) || !(await madeHere(ws))) return 'no'
    if (isLaunchReady(ws) && !setupHoldsLaunch(ws)) {
      const here = await folderState(cwd, host)
      if (here === 'present') return 'present'
      // Made, and the folder is still not there (another path), or the host cannot be asked.
      if (here === 'unknown' || asked) return 'no'
      const root = ws.root!
      if (strip(root) !== strip(cwd) && await folderState(root, host) !== 'gone') return 'no'
      // Its folder went behind Walnut's back (a disk cleanup, a person): forgotten, then made again.
      await deps.write(taskId, (cur) => (cur && isLaunchReady(cur) && cur.root === root ? stamp(cur, { state: 'removed', removal: undefined }) : null))
      log.web.info('workspace folder gone behind Walnut: making it again', { taskId, root, host: ws.host })
      continue
    }
    if (ws.state === 'removed' || ws.state === 'failed' || ws.state === 'requested') {
      // Our own request failed: the folder-gone way on stays.
      if (asked) return 'no'
      asked = true
      marked = !!opts.resume
      try {
        await requestWorkspace(taskId, {
          provider: ws.provider, host: ws.host, anchor: ws.anchor, inputs: ws.inputs,
          ...(ws.by_default ? { byDefault: true } : {}), ...(opts.resume ? { resume: true } : {}),
        })
        log.web.info('workspace removed under a session: making it again', { taskId, cwd, host: ws.host, provider: ws.provider })
      } catch (err) {
        if (!(err instanceof WorkspaceError && (err.code === 'busy' || err.code === 'conflict' || err.code === 'exists'))) {
          log.web.warn('workspace could not be made again', { taskId, cwd, error: errText(err) })
          return 'no'
        }
      }
      continue
    }
    // Being made (or its setup holds it), or being removed: wait. A remake followed for
    // waiting messages says so on its row, so its end sends them even after a restart.
    // Only while it is still on its way: one already ready is 'present' above, never marked.
    if (opts.resume && !marked && ws.remade && !ws.remade.resume && ws.state !== 'removing') {
      await deps.write(taskId, (cur) => (cur?.remade && (cur.state === 'creating' || (isLaunchReady(cur) && setupHoldsLaunch(cur)))
        ? stamp(cur, { remade: { ...cur.remade, resume: true } }) : null))
      marked = true
    }
    if (deps.now() >= deadline) return 'pending'
    await deps.sleep(POLL_MS)
  }
}

/**
 * The task's workspace was made again and is ready, and holds `cwd` on `host`: a refusal that
 * finds that folder present raced the remake's end (noteFolderGone sends what it parked).
 */
export async function remadeHolds(taskId: string, cwd: string, host: string | null | undefined): Promise<boolean> {
  const ws = (await managerDeps().getTask(taskId))?.workspace
  return !!ws?.remade && isLaunchReady(ws) && covers(ws, cwd, host)
}

/** Remakes followed after a refusal, one per task and folder, with every session that waits on it. */
const kicked = new Map<string, Set<string>>()

/**
 * A refusal found `cwd` gone (noteFolderGone): when it is inside the task's workspace, the
 * remake goes on in the background and true is returned (no "continue in a new folder" offer).
 */
export async function kickRemake(taskId: string, sessionId: string, cwd: string, host: string | null | undefined): Promise<boolean> {
  const deps = managerDeps()
  if (deps.cloudMode()) return false
  const ws = (await deps.getTask(taskId))?.workspace
  if (!covers(ws, cwd, host) || !(await madeHere(ws))) return false
  // A ready workspace counts only when its whole folder is gone, not one sub-folder of it.
  if (isLaunchReady(ws) && !setupHoldsLaunch(ws) && strip(ws.root!) !== strip(cwd) && await folderState(ws.root!, host) !== 'gone') return false
  const key = `${taskId}\0${cwd}`
  const waiting = kicked.get(key)
  if (waiting) {
    waiting.add(sessionId)
    return true
  }
  const sessions = new Set([sessionId])
  kicked.set(key, sessions)
  void (async () => {
    const outcome = await remakeForGoneFolder(taskId, cwd, host, { waitMs: KICK_WAIT_MS, resume: true })
    if (outcome === 'present') return resumeAfterRemake(taskId)
    // Not made (or not in time): each waiting session gets the folder-gone way on (its banner and button).
    kicked.delete(key)
    const { noteFolderGone } = await import('../sessions/folder-gone.js')
    for (const sid of sessions) await noteFolderGone(sid, { cwd, host: host ?? null, remake: false })
  })().catch((err) => log.web.warn('workspace remake failed', { taskId, cwd, error: errText(err) }))
    .finally(() => kicked.delete(key))
  return true
}

/** The workspace is there again: every session of the task whose folder is in it sends what waited. */
export async function resumeAfterRemake(taskId: string): Promise<void> {
  const deps = managerDeps()
  const ws = (await deps.getTask(taskId))?.workspace
  if (!ws || !isLaunchReady(ws)) return
  const { getSessionsForTask } = await import('../session-tracker.js')
  const { continueInNewFolder } = await import('../sessions/folder-gone.js')
  let sent = 0
  for (const s of await getSessionsForTask(taskId)) {
    if (s.archived || !covers(ws, s.cwd, s.host) || await folderState(s.cwd!, s.host) !== 'present') continue
    // The folder is there: this clears its banner and sends the messages that waited on it.
    const r = await continueInNewFolder(s.claudeSessionId, { by: 'walnut:workspace-remade' }).catch(() => null)
    if (r?.status === 'continued') sent += r.sent
  }
  await settleRemakeResume(taskId)
  log.web.info('workspace made again: waiting messages sent', { taskId, root: ws.root, sent })
}

/**
 * What waited was sent: the row stops asking for it, the cleanup hold restarts now (the sessions
 * just sent start in it), and a completed task's cleanup checks again (held, it re-arms itself).
 */
export async function settleRemakeResume(taskId: string): Promise<void> {
  const deps = managerDeps()
  const now = new Date(deps.now()).toISOString()
  const task = await deps.write(taskId, (cur) => {
    if (!cur?.remade?.resume) return null
    const { resume: _done, ...rest } = cur.remade
    return stamp(cur, { remade: { ...rest, ready_at: now } })
  }) ?? await deps.getTask(taskId)
  if (task?.phase === 'COMPLETE') {
    const { onTaskCompleted } = await import('./cleanup.js')
    void onTaskCompleted(taskId, { grace: false })
  }
}

const rechecks = new Map<string, ReturnType<typeof setTimeout>>()

/** A workspace made again for a waiting session is not cleaned up until that session started in it. */
export function remakeHoldsCleanup(taskId: string, ws: TaskWorkspace): boolean {
  const r = ws.remade
  if (!r) return false
  const deps = managerDeps()
  const from = Math.max(Date.parse(r.ready_at ?? '') || 0, Date.parse(ws.setup?.ended_at ?? '') || 0)
  const until = r.resume ? deps.now() + CLEANUP_HOLD_MS : from + CLEANUP_HOLD_MS
  if (deps.now() >= until) return false
  // Checked again when the hold ends; a session alive by then holds it the usual way.
  if (!rechecks.has(taskId)) {
    const t = setTimeout(() => {
      rechecks.delete(taskId)
      void import('./cleanup.js').then((m) => m.onTaskCompleted(taskId, { grace: false })).catch(() => {})
    }, until - deps.now() + 1_000)
    t.unref?.()
    rechecks.set(taskId, t)
  }
  return true
}

/** Which removal a session is told about: the removed workspace's, or the one this remake replaced. */
function removalKey(task: Task, startedAt: string | undefined): string | undefined {
  const ws = task.workspace!
  if (ws.state === 'removed') return ws.created_at
  // A session started in the new one has nothing to hear.
  if (ws.remade && ws.state !== 'removing' && ws.state !== 'failed' && Date.parse(startedAt ?? '') < Date.parse(ws.created_at ?? '')) return ws.remade.from
  return undefined
}

export function workspaceRemadeText(ws: Pick<TaskWorkspace, 'root' | 'anchor' | 'remade'>, cwd: string): string {
  const root = ws.root ?? ws.remade?.root ?? cwd
  return kit.buildWalnutMessage({
    kind: 'notification',
    attrs: { from: 'Walnut', outcome: 'workspace-remade', note: 'automated Walnut status notice' },
    body: `Your working folder ${cwd} is in this task's isolated workspace ${root}, which was removed (Walnut removes a completed task's workspace once nothing uncommitted is in it). `
      + `Walnut makes it again at the same path from ${ws.anchor} before this conversation goes on, and runs its setup script again. `
      + `Commits are kept on their branch; files that were never committed (installed packages, build output, anything git ignores) are not there until the setup script or you make them again.`,
  })
}

/** The notice a session whose workspace was removed hears once, on its next message (session-message-queue.ts). */
export async function workspaceRemakeNotice(sessionId: string): Promise<{ text: string; markTold: () => Promise<void> } | null> {
  const deps = managerDeps()
  if (deps.cloudMode()) return null
  const { getSessionByClaudeId, updateSessionRecordConditionally } = await import('../session-tracker.js')
  const record = await getSessionByClaudeId(sessionId)
  if (!record?.taskId || record.archived || !record.cwd) return null
  const task = await deps.getTask(record.taskId)
  if (!task || !covers(task.workspace, record.cwd, record.host) || !(await madeHere(task.workspace))) return null
  const key = removalKey(task, record.startedAt)
  if (!key || record.workspaceTold === key) return null
  return {
    text: workspaceRemadeText(task.workspace, record.cwd),
    markTold: async () => {
      await updateSessionRecordConditionally(sessionId, { workspaceTold: key }, () => true, { preserveLastActiveAt: true }).catch(() => {})
    },
  }
}
