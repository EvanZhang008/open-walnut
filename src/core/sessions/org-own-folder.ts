/**
 * A VP, lead or router node runs in a folder of its own: its task directory on its host
 * (src/lib/task-dir.ts), never a code repository (2026-11-12, the user: "u create the CEO in this
 * path, this is not right ... nonono i mean the VP itself why put there").
 *
 * Claude Code loads the instruction files of the folder it runs in on every request: in this
 * repository that was AGENTS.md (215 KB, about 54K tokens), CLAUDE.local.md and the project's
 * auto memory, all of it for a session whose work is to hand work to teams. A lead used to start
 * where any task starts (its own recorded folder, else its project's default folder), so the
 * Walnut VP ran in the repository. Main starts as a Personal AI ask in Walnut's data folder
 * (ask-launch-plan.ts) and keeps it.
 *
 * Two places, one rule (`runsInOwnFolder`):
 *  - every start decides the folder through `ownFolderStartCwd` (task-launch-plan.ts for
 *    task_start, the org contact draft and the inbox's start actions; quick-start.ts for a launch
 *    on an existing task), so the task directory wins over the task's and the project's folders
 *    unless a person named a folder for that start, which is kept (`cwdByPerson` on the record);
 *  - a session already running elsewhere moves at its next spawn (`moveToOwnFolderBeforeSpawn`,
 *    called by the spawn itself in claude-code-session.ts, so a cold resume, Restart and the
 *    prompt respawn all move it): its transcript and `<sid>/` sidecar go to the new folder's
 *    project dir, the record points there, and the session's next message says so once. The
 *    task's own `cwd` is left as it is: its subtasks inherit it (task-start.ts recordedPlace). It keeps its conversation; whatever cannot be checked (the host does not answer, the
 *    transcript is not found, a process still runs) leaves it where it is.
 *
 * Ratchet: tests/core/sessions/org-own-folder-guard.test.ts.
 */
import { log } from '../../logging/index.js'
import type { SessionRecord, Task } from '../types.js'
import { isOrgNode } from '../org/org-enabled.js'
import { isPersonSource } from './send-sent-by.js'
import { DEFAULT_ENGINE } from '../agents/engine-registry.js'

const isLocal = (host?: string | null) => !host || host === '__local__' || host === 'local'
const trimSlash = (p: string) => p.replace(/\/+$/, '') || '/'
const ROOT_ASK_MS = 8_000

/** A VP, lead or router node: its own folder. Main keeps Walnut's data folder. */
export function runsInOwnFolder(task: Pick<Task, 'org_role'> | null | undefined): boolean {
  return isOrgNode(task) && task?.org_role !== 'main'
}

/** A folder a person named for this start (not an agent's, not Walnut's own replay). */
export function personNamedCwd(params: { cwd?: string; callerSid?: string; source?: string }): boolean {
  return params.cwd !== undefined && !params.callerSid && isPersonSource(params.source)
}

/** A start's preview (the Org page's draft) waits on no host link. */
const PREVIEW_SOURCES: ReadonlySet<string> = new Set(['org-contact'])

/** The task directory on a host, asking a host that has not said its root yet (bounded). */
async function ownDirOn(taskId: string, host: string, ask: boolean): Promise<string | null> {
  const { taskDirForHost } = await import('./task-dir-place.js')
  const known = await taskDirForHost(taskId, isLocal(host) ? '__local__' : host).catch(() => null)
  if (known || isLocal(host) || !ask) return known
  try {
    const { link } = await import('../hosts/link.js')
    await Promise.race([link(host), new Promise((_, reject) => setTimeout(() => reject(new Error('timed out')), ROOT_ASK_MS).unref?.())])
  } catch { /* the answer below says it is unknown */ }
  return taskDirForHost(taskId, host).catch(() => null)
}

export type OwnFolderStart =
  /** The start runs in the node's own folder (made by the start). */
  | { kind: 'own'; cwd: string }
  /** A person named the folder for this start: kept, and kept by later spawns. */
  | { kind: 'person' }

/**
 * The folder rule of a start, for every start path. Null: not a VP/lead/router node, the plan's
 * own folder stands. Throws when the node's folder on a remote host cannot be learnt: starting it
 * in a repository instead is the thing this rule exists to stop.
 */
export async function ownFolderStartCwd(
  task: Pick<Task, 'id' | 'org_role'>,
  host: string | null | undefined,
  params: { cwd?: string; callerSid?: string; source?: string; workspace?: unknown },
): Promise<OwnFolderStart | null> {
  if (!runsInOwnFolder(task)) return null
  const named = params.cwd !== undefined || !!params.workspace
  if (named && personNamedCwd({ ...params, cwd: params.cwd ?? '' })) return { kind: 'person' }
  const cwd = await ownDirOn(task.id, host || '__local__', !PREVIEW_SOURCES.has(params.source ?? ''))
  if (!cwd) {
    const { QuickStartError } = await import('./quick-start.js')
    throw new QuickStartError(`Task ${task.id} is a VP or lead, which runs in its own task directory, and ${host} has not said where task directories live yet; try again once the host is connected.`, 503)
  }
  if (named && trimSlash(params.cwd ?? '') !== trimSlash(cwd)) {
    log.session.info('org node start: its own folder instead of the one named', { taskId: task.id, named: params.cwd, cwd, source: params.source })
  }
  return { kind: 'own', cwd }
}

export type MoveDecision = { move: true } | { move: false; why: string }

/** Whether a spawn of this session moves it to its node's own folder first. Pure; exported for tests. */
export function ownFolderMoveDecision(input: {
  task: Pick<Task, 'org_role' | 'phase'> | null
  record: Pick<SessionRecord, 'cwd' | 'cwdByPerson' | 'engine' | 'provider' | 'archived' | 'lane'> | null
  ownDir: string | null
  /** The spawn forks the conversation (a side question): the source transcript stays. */
  fork?: boolean
}): MoveDecision {
  const { task, record, ownDir } = input
  if (!runsInOwnFolder(task)) return { move: false, why: 'not-org-node' }
  if (!record || record.archived) return { move: false, why: 'no-record' }
  if (input.fork || record.lane) return { move: false, why: 'fork' }
  if ((record.provider && record.provider !== 'cli') || (record.engine && record.engine !== DEFAULT_ENGINE)) return { move: false, why: 'not-claude-code' }
  if (!ownDir) return { move: false, why: 'own-folder-unknown' }
  if (!record.cwd) return { move: false, why: 'no-cwd' }
  if (trimSlash(record.cwd) === trimSlash(ownDir)) return { move: false, why: 'already-own' }
  if (record.cwdByPerson && trimSlash(record.cwdByPerson) === trimSlash(record.cwd)) return { move: false, why: 'person-chose' }
  return { move: true }
}

/** True when this session's next spawn would move it (the prompt respawn counts it as paying). */
export async function ownFolderMoveDue(record: SessionRecord, task: Task): Promise<boolean> {
  if (!runsInOwnFolder(task)) return false
  const { taskDirForHost } = await import('./task-dir-place.js')
  const ownDir = await taskDirForHost(task.id, record.host || '__local__').catch(() => null)
  return ownFolderMoveDecision({ task, record, ownDir }).move
}

/**
 * Right before a spawn of `sessionId` that resumes its conversation: move a VP/lead's session to
 * its own folder. Returns the folder to spawn in, or null to spawn where it was. Never throws.
 * Called only between processes (a spawn), and asks the host's daemon that none runs.
 */
export async function moveToOwnFolderBeforeSpawn(input: {
  sessionId: string; taskId: string | null | undefined; cwd: string; host?: string | null; fork?: boolean
}): Promise<string | null> {
  const { sessionId, taskId } = input
  if (!taskId || !sessionId) return null
  try {
    const { getTask } = await import('../task-manager.js')
    const task = await getTask(taskId).catch(() => null)
    if (!runsInOwnFolder(task)) return null
    const { getSessionByClaudeId, updateSessionRecordConditionally } = await import('../session-tracker.js')
    const record = await getSessionByClaudeId(sessionId)
    const host = record?.host ?? input.host ?? null
    const { taskDirForHost, ensureTaskDirOnHost } = await import('./task-dir-place.js')
    const ownDir = await taskDirForHost(task!.id, host || '__local__').catch(() => null)
    // The folder the spawn names is the one the record holds (a runner's in-memory copy may lag).
    const decision = ownFolderMoveDecision({ task, record: record ? { ...record, cwd: record.cwd ?? input.cwd } : null, ownDir, fork: input.fork })
    if (!decision.move) {
      if (decision.why !== 'not-org-node' && decision.why !== 'already-own') log.session.debug('org node folder: not moved', { sessionId, taskId, why: decision.why })
      return null
    }
    const from = record!.cwd ?? input.cwd
    const leave = (why: string, extra: Record<string, unknown> = {}) => {
      log.session.warn('org node folder: left where it is', { sessionId, taskId, host: host ?? '__local__', from, why, ...extra })
      return null
    }
    // Only between processes: a CLI still writing the transcript would split it.
    const { probeDaemonSession } = await import('../../providers/daemon-connection.js')
    const probe = await probeDaemonSession(host || '__local__', sessionId).catch(() => null)
    if (!probe) return leave('host-unasked')
    if (probe.alive) return leave('process-running', { pid: probe.pid })
    const made = await ensureTaskDirOnHost(task!.id, host)
    if ('error' in made) return leave('task-dir', { error: made.error })
    const to = made.path
    const { moveConversation } = await import('./folder-gone.js')
    const moved = await moveConversation({ ...record!, cwd: from }, to).catch((err: unknown) => {
      leave('move-failed', { error: err instanceof Error ? err.message : String(err) })
      return 'failed' as const
    })
    if (moved === 'failed') return null
    if (moved !== 'moved') return leave(moved === 'missing' ? 'transcript-missing' : 'transcript-unknown')
    const at = new Date().toISOString()
    const written = await updateSessionRecordConditionally(sessionId, {
      cwd: to, folderMoved: { from, to, at, by: 'walnut', why: 'own-folder' },
    } as Partial<SessionRecord>, (current) => (current.cwd ?? input.cwd) === from, { preserveLastActiveAt: true })
    if (!written) {
      // Its folder changed meanwhile: the conversation is in `to` now, so the record follows it.
      log.session.warn('org node folder: the record moved meanwhile; pointing it at the moved conversation', { sessionId, taskId, from, to })
      await updateSessionRecordConditionally(sessionId, { cwd: to }, () => true, { preserveLastActiveAt: true }).catch(() => {})
    }
    // The task's own `cwd` stays: its subtasks with no folder inherit it (task-start.ts
    // recordedPlace), and they work in the repository, not in this node's directory. The
    // node itself ignores it (ownFolderStartCwd).
    log.session.info('org node folder: moved to its own folder', { sessionId, taskId, host: host ?? '__local__', from, to })
    return to
  } catch (err) {
    log.session.warn('org node folder: the move check failed; spawning where it was', { sessionId, taskId, error: err instanceof Error ? err.message : String(err) })
    return null
  }
}

