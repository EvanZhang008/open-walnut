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
 *    unless a person picked a folder for that start (`cwdChosen` from the draft's folder picker),
 *    which is kept (`cwdByPerson` on the record);
 *  - a session already running elsewhere moves at its next spawn (`moveToOwnFolderBeforeSpawn`,
 *    called by the spawn itself in claude-code-session.ts, so a cold resume, Restart and the
 *    prompt respawn all move it): its transcript and `<sid>/` sidecar go to the new folder's
 *    project dir, the record points there, and the session's next message says so once; a start
 *    that is then refused puts it back. It keeps its conversation. It moves only when the host's
 *    daemon says no CLI of the session runs there (`cli.holder`, the start's own claim rules)
 *    and no other Walnut started it, never on a test server, and never a session someone had open
 *    in a terminal lately. A lasting failure is recorded and tried again a day later. The task's
 *    own `cwd` is left as it is: its subtasks inherit it (task-start.ts recordedPlace), and a
 *    worker the node files inherits the folder it was moved from (caller-placement.ts).
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

/**
 * A folder a person picked for this start: the client says so (`cwdChosen`, the draft's folder
 * picker), never just a cwd on a person's request. The board's ▶, Snooze until and the Org page's
 * chat send the task's folder or the last launch's on every start (2026-11-12 review): those are
 * no choice, and an older client that sends no flag chose nothing.
 */
export function personNamedCwd(params: { cwd?: string; callerSid?: string; source?: string; cwdChosen?: boolean }): boolean {
  return params.cwd !== undefined && params.cwdChosen === true && !params.callerSid && isPersonSource(params.source)
}

/** How long one failed ask for a host's task-directory root is reused (a start plans several times). */
const ROOT_ASK_REUSE_MS = 30_000
const rootAsks = new Map<string, { at: number; done: Promise<void> }>()

/**
 * The task directory on a host. A remote host that has not said its root yet is linked once
 * (bounded), and that one attempt is shared by every plan of the same start; a preview (the Org
 * page's draft, the inbox's plan of an action) never waits on a link.
 */
async function ownDirOn(taskId: string, host: string, ask: boolean): Promise<string | null> {
  const { taskDirForHost } = await import('./task-dir-place.js')
  const known = await taskDirForHost(taskId, isLocal(host) ? '__local__' : host).catch(() => null)
  if (known || isLocal(host) || !ask) return known
  let attempt = rootAsks.get(host)
  if (!attempt || Date.now() - attempt.at > ROOT_ASK_REUSE_MS) {
    const done = (async () => {
      try {
        const { link } = await import('../hosts/link.js')
        await Promise.race([link(host), new Promise((_, reject) => setTimeout(() => reject(new Error('timed out')), ROOT_ASK_MS).unref?.())])
      } catch { /* the answer below says it is unknown */ }
    })()
    attempt = { at: Date.now(), done }
    rootAsks.set(host, attempt)
  }
  await attempt.done
  return taskDirForHost(taskId, host).catch(() => null)
}

export type OwnFolderStart =
  /** The start runs in the node's own folder (made by the start). Null only in a preview whose
   *  remote host has not said where task directories live yet: the start learns it. */
  | { kind: 'own'; cwd: string | null }
  /** A person picked the folder for this start: kept, and kept by later spawns. */
  | { kind: 'person' }

/**
 * The folder rule of a start, for every start path. Null: not a VP/lead/router node, the plan's
 * own folder stands. Throws when the node's folder on a remote host cannot be learnt: starting it
 * in a repository instead is the thing this rule exists to stop. `preview`: a plan shown before
 * anything starts, which never waits on a host link and answers with no folder when the host has
 * not said its root.
 */
export async function ownFolderStartCwd(
  task: Pick<Task, 'id' | 'org_role'>,
  host: string | null | undefined,
  params: { cwd?: string; cwdChosen?: boolean; callerSid?: string; source?: string },
  opts: { preview?: boolean } = {},
): Promise<OwnFolderStart | null> {
  if (!runsInOwnFolder(task)) return null
  const named = params.cwd !== undefined
  if (named && personNamedCwd(params)) return { kind: 'person' }
  const cwd = await ownDirOn(task.id, host || '__local__', !opts.preview)
  if (!cwd && opts.preview) return { kind: 'own', cwd: null }
  if (!cwd) {
    const { QuickStartError } = await import('./quick-start.js')
    throw new QuickStartError(`Task ${task.id} is a VP or lead, which runs in its own task directory, and ${host} has not said where task directories live yet; try again once the host is connected.`, 503)
  }
  if (named && trimSlash(params.cwd ?? '') !== trimSlash(cwd)) {
    log.session.info('org node start: its own folder instead of the one named', { taskId: task.id, named: params.cwd, cwd, source: params.source })
  }
  return { kind: 'own', cwd }
}

/**
 * The folder a session hands to the work it files (caller-placement.ts): its own, except that a
 * VP or lead Walnut moved out of a folder into its own directory hands on the folder it was moved
 * from, so its workers land where they did while it ran there. A node that always ran in its own
 * directory hands on that, which gives a worker its project's default or its own directory.
 */
export function handedDownCwd(record: Pick<SessionRecord, 'cwd' | 'folderMoved'>): string | undefined {
  const moved = record.folderMoved
  if (moved?.why === 'own-folder' && record.cwd && trimSlash(record.cwd) === trimSlash(moved.to)) return moved.from
  return record.cwd ?? undefined
}

/** A move that failed for a lasting reason is tried again for the same folder at most once a day. */
export const MOVE_RETRY_MS = 24 * 3_600_000
/** One that failed for a passing reason (a CLI still running, no answer from the host) once an hour. */
export const TRANSIENT_RETRY_MS = 3_600_000
/** A session someone had open in a terminal this recently is not moved (its CLI may be back). */
export const HELD_ELSEWHERE_MS = 24 * 3_600_000

/** Reasons a move fails for good: never tried again for that folder (two copies of one history). */
const TERMINAL: ReadonlySet<string> = new Set(['history-conflict'])
/** Reasons it will not succeed on the next spawn either: tried again a day later. */
const LASTING: ReadonlySet<string> = new Set(['daemon-too-old', 'other-walnut', 'transcript-missing', 'move-failed', 'task-dir'])

export type MoveDecision = { move: true } | { move: false; why: string }

type DecisionRecord = Pick<SessionRecord, 'cwd' | 'cwdByPerson' | 'engine' | 'provider' | 'archived' | 'lane' | 'heldElsewhere' | 'ownFolderMove'>

/** How long a recorded failure keeps the move from being tried again for its folder. */
function backoffOf(why: string): number {
  if (TERMINAL.has(why)) return Infinity
  return LASTING.has(why) ? MOVE_RETRY_MS : TRANSIENT_RETRY_MS
}

/** Inside the workspace's own isolated folder (its root), not the repository it was made from (its anchor). */
function inWorkspaceRoot(ws: Pick<NonNullable<Task['workspace']>, 'root'> | undefined, cwd: string): boolean {
  const root = ws?.root ? trimSlash(ws.root) : ''
  const at = trimSlash(cwd)
  return !!root && (at === root || at.startsWith(root + '/'))
}

/** Whether a spawn of this session moves it to its node's own folder first. Pure; exported for tests. */
export function ownFolderMoveDecision(input: {
  task: Pick<Task, 'org_role' | 'phase' | 'workspace'> | null
  record: DecisionRecord | null
  ownDir: string | null
  /** The spawn forks the conversation (a side question): the source transcript stays. */
  fork?: boolean
  /** A test server on a copy of the real data: never touches the user's transcripts. */
  ephemeral?: boolean
  now?: number
}): MoveDecision {
  const { task, record, ownDir } = input
  const now = input.now ?? Date.now()
  if (!runsInOwnFolder(task)) return { move: false, why: 'not-org-node' }
  if (input.ephemeral) return { move: false, why: 'ephemeral' }
  if (!record || record.archived) return { move: false, why: 'no-record' }
  if (input.fork || record.lane) return { move: false, why: 'fork' }
  if ((record.provider && record.provider !== 'cli') || (record.engine && record.engine !== DEFAULT_ENGINE)) return { move: false, why: 'not-claude-code' }
  if (!ownDir) return { move: false, why: 'own-folder-unknown' }
  if (!record.cwd) return { move: false, why: 'no-cwd' }
  if (trimSlash(record.cwd) === trimSlash(ownDir)) return { move: false, why: 'already-own' }
  if (record.cwdByPerson && trimSlash(record.cwdByPerson) === trimSlash(record.cwd)) return { move: false, why: 'person-chose' }
  // A start in the task's isolated workspace keeps that folder (task-launch-plan.ts, quick-start.ts), so its resumes do too.
  if (inWorkspaceRoot(task?.workspace, record.cwd)) return { move: false, why: 'workspace' }
  const held = record.heldElsewhere ? Date.parse(record.heldElsewhere.at) : NaN
  if (now - held < HELD_ELSEWHERE_MS) return { move: false, why: 'held-elsewhere' }
  const failed = record.ownFolderMove
  if (failed && trimSlash(failed.from) === trimSlash(record.cwd) && now - Date.parse(failed.at) < backoffOf(failed.why)) {
    return { move: false, why: TERMINAL.has(failed.why) ? 'failed-for-good' : 'failed-recently' }
  }
  return { move: true }
}

async function isEphemeral(): Promise<boolean> {
  const { IS_EPHEMERAL } = await import('../../constants.js')
  return IS_EPHEMERAL
}

/** The daemon capability that answers who holds a session's transcript (remote-session-manager.ts askCliHolder). */
const CLI_HOLDER_CAPABILITY = 'cli-holder-v1'

/**
 * True when this session's next spawn would move it (the prompt respawn counts it as paying). A
 * host whose daemon is linked and too old to say who holds the transcript moves nothing: not due.
 */
export async function ownFolderMoveDue(record: SessionRecord, task: Task): Promise<boolean> {
  if (!runsInOwnFolder(task)) return false
  const { taskDirForHost } = await import('./task-dir-place.js')
  const ownDir = await taskDirForHost(task.id, record.host || '__local__').catch(() => null)
  if (!ownFolderMoveDecision({ task, record, ownDir, ephemeral: await isEphemeral() }).move) return false
  const { getConnectedDaemonConnection } = await import('../../providers/daemon-connection.js')
  const conn = getConnectedDaemonConnection(record.host || '__local__')
  return !conn || conn.hasCapability(CLI_HOLDER_CAPABILITY)
}

const HOLDER_TRIES = 3
const HOLDER_GAP_MS = 500

type HolderAnswer = import('../../providers/remote-session-manager.js').CliHolderAnswer
type AskHolder = (sid: string) => Promise<HolderAnswer>

/** cli.holder on the host's pooled link: for a caller with no transport of its own. */
async function pooledHolder(host: string | null, sid: string): Promise<HolderAnswer> {
  const { getConnectedDaemonConnection } = await import('../../providers/daemon-connection.js')
  const conn = getConnectedDaemonConnection(host || '__local__')
  if (!conn) return { state: 'unknown', detail: 'no daemon connection' }
  const { askCliHolder } = await import('../../providers/remote-session-manager.js')
  return askCliHolder(conn, sid)
}

/**
 * Whether any CLI of `sid` runs on the host, asked the way the start's claim judges it
 * (cli-owner-core.ts: the owner record against the process table, then a scan of the process
 * table for a CLI no record names, a terminal's `claude -r` included), and which Walnut the spawn
 * journal says started it. A CLI just stopped may take a moment to leave the table: asked again.
 */
async function hostHolder(ask: AskHolder, sid: string, tries = HOLDER_TRIES): Promise<HolderAnswer> {
  let answer: HolderAnswer = { state: 'unknown' }
  for (let i = 0; i < tries; i++) {
    answer = await ask(sid)
    if (answer.state !== 'held') return answer
    if (i < tries - 1) await new Promise((r) => setTimeout(r, HOLDER_GAP_MS))
  }
  return answer
}

/** The two copies of one conversation a move found (history_conflict), for the node's one notice. */
function conflictFiles(err: unknown): string[] | undefined {
  const extra = (err as { extra?: { code?: unknown; files?: unknown } } | null)?.extra
  if (extra?.code !== 'history_conflict') return undefined
  return Array.isArray(extra.files) ? extra.files.filter((f): f is string => typeof f === 'string') : []
}

export interface OwnFolderMove {
  /** The folder to spawn in. */
  cwd: string
  /** The start that followed did not happen: put the conversation back. Returns the folder it is in now. */
  undo?: () => Promise<string>
}

/**
 * Right before a spawn of `sessionId` that resumes its conversation: move a VP/lead's session to
 * its own folder. Returns the folder to spawn in (with an undo for a start that is then refused),
 * or null to spawn where it was. Never throws. Moves only when the host says no CLI of the session
 * runs there and the spawn journal names no other Walnut; never on a test server. A failure is
 * recorded on the session (`ownFolderMove`) and holds the move back for that folder: an hour for a
 * passing reason, a day for a lasting one, for good when the history is in two places (then the
 * node is told once, naming both files; Walnut never merges them).
 */
export async function moveToOwnFolderBeforeSpawn(input: {
  sessionId: string; taskId: string | null | undefined; cwd: string; host?: string | null; fork?: boolean
  /** cli.holder on the link the start goes through (RemoteSessionManager.cliHolder); else the pooled link. */
  cliHolder?: AskHolder
}): Promise<OwnFolderMove | null> {
  const { sessionId, taskId } = input
  if (!taskId || !sessionId) return null
  try {
    const { getTask } = await import('../task-manager.js')
    const task = await getTask(taskId).catch(() => null)
    if (!runsInOwnFolder(task)) return null
    const { getSessionByClaudeId, updateSessionRecordConditionally } = await import('../session-tracker.js')
    const record = await getSessionByClaudeId(sessionId)
    const host = record?.host ?? input.host ?? null
    const ask: AskHolder = input.cliHolder ?? ((sid) => pooledHolder(host, sid))
    const { taskDirForHost, ensureTaskDirOnHost } = await import('./task-dir-place.js')
    const ownDir = await taskDirForHost(task!.id, host || '__local__').catch(() => null)
    // The folder the spawn names is the one the record holds (a runner's in-memory copy may lag).
    const decision = ownFolderMoveDecision({ task, record: record ? { ...record, cwd: record.cwd ?? input.cwd } : null, ownDir, fork: input.fork, ephemeral: await isEphemeral() })
    if (!decision.move) {
      // Moved already while this runner still held the old folder: spawn where the record says.
      if (decision.why === 'already-own' && record?.cwd && trimSlash(record.cwd) !== trimSlash(input.cwd)) return { cwd: record.cwd }
      if (decision.why !== 'not-org-node' && decision.why !== 'already-own') log.session.debug('org node folder: not moved', { sessionId, taskId, why: decision.why })
      return null
    }
    const from = record!.cwd ?? input.cwd
    const leave = async (why: string, extra: Record<string, unknown> = {}, files?: string[]) => {
      const terminal = TERMINAL.has(why)
      // Said once per folder and reason; the record holds the next spawns back (backoffOf).
      const known = record!.ownFolderMove?.from === from && record!.ownFolderMove?.why === why
      if (!known) {
        const line = terminal ? log.session.error : log.session.warn
        line('org node folder: left where it is', { sessionId, taskId, host: host ?? '__local__', from, why, retryMs: backoffOf(why), ...extra })
      }
      await updateSessionRecordConditionally(sessionId, {
        ownFolderMove: { from, why, at: new Date().toISOString(), ...(files ? { files } : {}), ...(known && record!.ownFolderMove?.told ? { told: true } : {}) },
      } as Partial<SessionRecord>, () => true, { preserveLastActiveAt: true }).catch(() => {})
      return null
    }
    // Only between processes: a CLI still writing the transcript would split it.
    const holder = await hostHolder(ask, sessionId)
    if (holder.state === 'too-old') return leave('daemon-too-old')
    if (holder.state !== 'free') return leave(holder.state === 'held' ? 'process-running' : 'host-unasked', { detail: holder.detail })
    const { WALNUT_HOME } = await import('../../constants.js')
    if (holder.journaledHome && trimSlash(holder.journaledHome) !== trimSlash(WALNUT_HOME)) return leave('other-walnut', { journaledHome: holder.journaledHome })
    const made = await ensureTaskDirOnHost(task!.id, host)
    if ('error' in made) return leave('task-dir', { error: made.error })
    const to = made.path
    const { moveConversation } = await import('./folder-gone.js')
    let failure: unknown
    const moved = await moveConversation({ ...record!, cwd: from }, to).catch((err: unknown) => { failure = err; return 'failed' as const })
    if (moved === 'failed') {
      const files = conflictFiles(failure)
      const error = failure instanceof Error ? failure.message : String(failure)
      return files ? leave('history-conflict', { error }, files) : leave('move-failed', { error })
    }
    if (moved === 'missing') return leave('transcript-missing')
    if (moved === 'unknown') return leave('transcript-unknown')
    const at = new Date().toISOString()
    const before = { cwd: record!.cwd, folderMoved: record!.folderMoved }
    const written = await updateSessionRecordConditionally(sessionId, {
      cwd: to, folderMoved: { from, to, at, by: 'walnut', why: 'own-folder' }, ownFolderMove: undefined,
    } as Partial<SessionRecord>, (current) => (current.cwd ?? input.cwd) === from, { preserveLastActiveAt: true })
    if (!written) {
      // Its folder changed meanwhile: the conversation is in `to` now, so the record follows it.
      log.session.warn('org node folder: the record moved meanwhile; pointing it at the moved conversation', { sessionId, taskId, from, to })
      await updateSessionRecordConditionally(sessionId, { cwd: to }, () => true, { preserveLastActiveAt: true }).catch(() => {})
    }
    // The task's own `cwd` stays: its subtasks with no folder inherit it (task-start.ts
    // recordedPlace), and they work in the repository, not in this node's directory. The
    // node itself ignores it (ownFolderStartCwd).
    if (moved === 'in-place') {
      // Another spawn of the session moved it a moment ago: nothing of this one's to put back.
      log.session.info('org node folder: already in its own folder', { sessionId, taskId, from, to })
      return { cwd: to }
    }
    log.session.info('org node folder: moved to its own folder', { sessionId, taskId, host: host ?? '__local__', from, to })
    const undo = async (): Promise<string> => {
      // Back only while no CLI of the session runs (a start that failed late may have one
      // writing in `to`); moveTranscript never writes over a file, so a copy a CLI started at
      // the old path meanwhile stops it too, and the conversation stays where it is.
      const now = await hostHolder(ask, sessionId, 1)
      if (now.state !== 'free') {
        log.session.warn('org node folder: the start failed, but the host does not say no CLI of it runs; the conversation stays in its own folder', {
          sessionId, taskId, from, to, holder: now.state, detail: 'detail' in now ? now.detail : undefined,
        })
        return to
      }
      const back = await moveConversation({ ...record!, cwd: to }, from).catch((err: unknown) => {
        log.session.error('org node folder: the refused start\'s move could not be undone; the conversation stays in the new folder', {
          sessionId, taskId, from, to, error: err instanceof Error ? err.message : String(err),
        })
        return 'failed' as const
      })
      if (back !== 'moved') return to
      await updateSessionRecordConditionally(sessionId, { cwd: before.cwd ?? from, folderMoved: before.folderMoved } as Partial<SessionRecord>,
        (current) => current.cwd === to, { preserveLastActiveAt: true }).catch(() => {})
      log.session.info('org node folder: the start was refused; the conversation is back where it was', { sessionId, taskId, from, to })
      return from
    }
    return { cwd: to, undo }
  } catch (err) {
    log.session.warn('org node folder: the move check failed; spawning where it was', { sessionId, taskId, error: err instanceof Error ? err.message : String(err) })
    return null
  }
}

/**
 * The one notice a node gets when its conversation is in two places and Walnut moved neither
 * (history_conflict): it names both files; nothing is merged, and Walnut does not try again.
 */
export function ownFolderConflictNotice(failed: { from: string; files?: string[] }): string {
  const files = failed.files?.length ? failed.files.join(' and ') : 'two project folders'
  return `Walnut tried to move this conversation into this task's own directory, but its history exists in two places (${files}). `
    + `Walnut moved neither and merged nothing, and will not try again; this session keeps running in ${failed.from}. `
    + `Tell the user once, so they can keep the copy they want and delete the other.`
}
