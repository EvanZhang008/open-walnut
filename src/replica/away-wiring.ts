/**
 * The wiring of a host replica's away writes (docs/plan/walnut-replica-servers-impl.md,
 * WP10), called once at boot by server.ts on a host replica only:
 *
 *   overlay     (overlay.ts) over `follower.pending` on the front's follower link;
 *               the copy stores hold its pending keys (journal-overlay.ts) and tell
 *               it which awaiting keys a manifest stored (kind-follower.ts
 *               setCopyWatcher); a change of a mark tells browsers (task:updated,
 *               board:changed on this replica's own /ws)
 *   write port  (write-port.ts) over the task and Board reads of this replica
 *   routes      away-writes.ts and away-reads.ts, mounted on /api after the auth
 *   /ws         ws-writes.ts as the handler's RPC answer
 *
 * While nothing is pending the overlay asks the daemon only when a read or a
 * write needs it; while a mark shows it asks every second when the Mac answers or
 * an acked write awaits its copy (every 20 s while the Mac sleeps), so a mark goes as soon
 * as the Mac's row is back (a device that removed itself here: once the Mac's
 * device list no longer names it, device-copy.ts namedByMac).
 */

import path from 'node:path'
import type { Request, RequestHandler, Response } from 'express'
import { WALNUT_HOME } from '../constants.js'
import { log } from '../logging/index.js'
import type { FollowerLink } from '../core/link/follower-link.js'
import type { DeviceCopy } from '../host-server/device-copy.js'
import { ANSWERED_VIA_HEADER } from './dispatch.js'
import { createOverlay, watchMaxAgeMs, type Overlay, type OverlayKind } from './overlay.js'
import { createWritePort, type BoardBase, type TaskRow, type WriteActor, type WritePort } from './write-port.js'
import { awayWrites } from './away-writes.js'
import { awayNotes } from './away-notes.js'
import { awayReads, overlayBoard, overlayTiers, SYNC_FIELD } from './away-reads.js'
import { wsWrites } from './ws-writes.js'
import { writeActorOf } from './write-actor.js'
import type { SessionRecord } from '../core/types.js'
import type { AwayStart } from '../core/offline-merge/task-row-fold.js'
import type { CallerTaskRow } from '../core/sessions/caller-placement.js'
import type { AskLaunch } from './ask-launch.js'

/** The daemon capability note writes away ride on (WP11). */
const NOTE_JOURNAL_CAP = 'note-journal-v1'
/** The daemon capability `follower.pending` rides on. */
export const JOURNAL_V2_CAP = 'journal-v2'
const PENDING_TIMEOUT_MS = 3_000
/**
 * While a mark shows: how often the overlay asks the daemon again. Short, so the time it
 * takes for an ack (ackAt) is well before the manifest the Mac sends after its drain
 * (resendTaskReplicaSoon, its 3 s debounce): that manifest is what lets the mark go.
 */
const WATCH_MS = 1_000

export interface AwayWiring {
  overlay: Overlay
  port: WritePort
  reads: RequestHandler
  writes: RequestHandler
  /** WP11: the note writes while away (away-notes.ts), mounted before `writes`. */
  notes: RequestHandler
  /** Who an away write acts for (write-actor.ts), for every away route. */
  actorOf(req: Request): WriteActor | null
  /** A task as this replica shows it (copy plus overlay). */
  task(id: string): Promise<TaskRow | null>
  /** Whether a session runs on this host. */
  sessionHere(sid: string): Promise<boolean>
  /** The one reader of this host's live sessions (ask-launch.ts look): task and session reads, the session list. */
  setSessionLooks(looks: Pick<AskLaunch, 'fresh' | 'hostSessions'> | null): void
  stop(): void
}

export interface AwayWiringOptions {
  link: FollowerLink
  devices: DeviceCopy
  broadcast(name: string, data: unknown): void
  /** The Mac's name for this host: the `host` of the sessions that run here. */
  hostKey: string | null
  setRpcAnswer(fn: ((method: string, payload: unknown, opId: string | undefined) => Promise<unknown> | null) | null): void
  /** Whether the Mac answers now (the front's presence): the watch asks each second only then, or while a write awaits its copy. */
  macAnswers?(): boolean
  /** Whether this replica answers its host's own `walnut` calls (the `host-local-calls` capability). */
  localCalls?(): boolean
}

/** A session row this host started alone, as the reader fold takes it (task-row-fold.ts AwayStart). */
export function awayStartOf(r: SessionRecord): AwayStart {
  const at = typeof r.startedAt === 'string' ? Date.parse(r.startedAt) : NaN
  return { sid: r.claudeSessionId, at: Number.isFinite(at) ? at : 0, mode: r.mode, status: r.process_status }
}

async function copyTask(id: string): Promise<TaskRow | null> {
  try {
    const { getTask } = await import('../core/task-manager.js')
    const t = await getTask(id)
    return t && t.id === id ? (t as unknown as TaskRow) : null
  } catch {
    return null
  }
}

async function copyBoard(taskId: string): Promise<Record<string, unknown> | null> {
  try {
    const { getBoard } = await import('../core/boards/board-store.js')
    return (await getBoard(taskId)) as unknown as Record<string, unknown> | null
  } catch {
    return null
  }
}

export async function wireAwayWrites(opts: AwayWiringOptions): Promise<AwayWiring> {
  const { link } = opts
  const linked = () => link.linkState() === 'following'
  /** Tasks made here whose task:created has not gone out yet: id to the page's client_request_id. */
  const created = new Map<string, string>()

  // The sessions this host started alone, as the overlay folds them into their tasks' rows.
  const { awaySessionsOfTask, isAwaySession } = await import('../core/session-tracker.js')
  let looks: Pick<AskLaunch, 'fresh' | 'hostSessions'> | null = null
  const overlay: Overlay = createOverlay({
    awayStarts: (taskId) => awaySessionsOfTask(taskId).map(awayStartOf),
    fetchPending: async () => {
      if (!link.capabilities()?.includes(JOURNAL_V2_CAP)) return { records: [] }
      const r = await link.request('follower.pending', { sinceSeq: 0 }, PENDING_TIMEOUT_MS)
      if (r.ok === false) throw new Error(String(r.error ?? 'follower.pending refused'))
      return r
    },
    file: path.join(WALNUT_HOME, 'cache', 'replica-overlay.json'),
    changed: (keys) => { void tell(keys) },
    log: (level, msg, data) => log.web[level](msg, data),
  })

  /** Browsers see a mark come and go (and the row it is on). */
  async function tell(keys: Array<{ kind: OverlayKind; id: string }>): Promise<void> {
    for (const k of keys) {
      if (k.kind === 'tasks') {
        const crid = created.get(k.id)
        created.delete(k.id)
        const row = overlay.taskForReaders(k.id, await copyTask(k.id))
        if (row && crid) opts.broadcast('task:created', { task: row, clientRequestId: crid })
        else if (row) opts.broadcast('task:updated', { task: { ...row, [SYNC_FIELD]: (row as Record<string, unknown>)[SYNC_FIELD] ?? null } })
      } else if (k.kind === 'boards') {
        opts.broadcast('board:changed', { taskId: k.id, task_id: k.id })
      }
    }
  }

  const { setCopyWatcher } = await import('../core/replication/kind-follower.js')
  setCopyWatcher({ watching: (kind) => overlay.watching(kind), stored: (kind, keys, asOf) => overlay.stored(kind, keys, asOf) })
  const { installJournalOverlay } = await import('./journal-overlay.js')
  installJournalOverlay(overlay)
  // The reply requests this host opened or answered alone, over the requests copy (away-requests.ts).
  const [{ installAwayRequests }, { awayRequestReader }] = await Promise.all([import('../core/session-requests.js'), import('./away-requests.js')])
  installAwayRequests(awayRequestReader({ macAnswers: () => opts.macAnswers?.() === true, overlay }))

  // The row every write reads (the write port's bases, the away routes' checks): the journal's
  // values only, never the session a reader is shown (overlay.ts taskForReaders).
  const shownTask = async (id: string): Promise<TaskRow | null> => {
    await overlay.refresh(500)
    return overlay.task(id, await copyTask(id)) as TaskRow | null
  }
  const shownBoard = async (taskId: string): Promise<BoardBase | null> => {
    await overlay.refresh(500)
    const b = await copyBoard(taskId)
    const body = overlayBoard(taskId, {
      board: b ? { html: b.html, version: b.version, updated_by: b.updated_by, updated_session_id: b.updated_session_id, html_sources: b.html_sources } : null,
      threads: b?.threads ?? {}, marks: b?.marks ?? {}, projects: b?.projects ?? {}, choices: b?.choices ?? {},
    }, overlay)
    const pub = body.board as (BoardBase | null)
    if (!pub || typeof pub.html !== 'string') return null
    return {
      html: pub.html, version: Number(pub.version) || 0,
      updated_by: pub.updated_by, updated_session_id: pub.updated_session_id, html_sources: pub.html_sources,
      threads: body.threads as Record<string, unknown>, marks: body.marks as Record<string, unknown>,
      projects: body.projects as Record<string, unknown>, choices: body.choices as Record<string, unknown>,
    }
  }
  const port = createWritePort({
    task: shownTask,
    // The leader's drain's caller (journal-actor.ts), its task read as this replica shows it.
    createCaller: async (actor) => (await (await import('../core/offline-merge/journal-actor.js'))
      .createCaller(actor, { readTask: async (id) => (await shownTask(id)) as CallerTaskRow | null })).caller,
    createdHere: (id) => overlay.createPending(id),
    board: shownBoard,
    noteWritten: (e) => {
      // A create's first word to browsers is task:created with the page's correlation
      // id (tasks.ts does the same), so the creating page swaps its optimistic row.
      const taskId = typeof e.record.taskId === 'string' ? e.record.taskId : ''
      if (e.clientRequestId && taskId) created.set(taskId, e.clientRequestId)
      overlay.noteWritten(e)
      // A retry whose first answer was lost, and whose record the overlay already held
      // (an ask in between): the overlay told nobody now, and the page still waits for
      // its id. `tell` takes the id from `created` before its first await.
      if (e.clientRequestId && taskId && created.get(taskId) === e.clientRequestId) void tell([{ kind: 'tasks', id: taskId }])
    },
    // What task_get reads right after: the session this host started for it, with its live state.
    forReaders: async (row) => {
      await Promise.race([looks?.fresh().catch(() => {}), new Promise<void>((r) => { const t = setTimeout(r, 1_000); t.unref?.() })])
      const folded = (overlay.taskForReaders(row.id, row) ?? row) as TaskRow
      const { enrichTasksWithSessionStatus } = await import('../web/routes/tasks.js')
      const [enriched] = await enrichTasksWithSessionStatus([folded] as never) as unknown as TaskRow[]
      return enriched ?? folded
    },
    log: (level, msg, data) => log.web[level](msg, data),
  })

  const sessionHere = async (sid: string): Promise<boolean> => {
    if (!opts.hostKey) return false
    const { getSessionByClaudeId } = await import('../core/session-tracker.js')
    const r = await getSessionByClaudeId(sid).catch(() => null)
    return !!r && (r.host ?? null) === opts.hostKey
  }
  const actorOf: (req: Request) => WriteActor | null = writeActorOf({
    verifyDevice: (token) => opts.devices.verifyDevice(token),
    localCalls: () => opts.localCalls?.() === true,
  })
  const writes = awayWrites({
    port, actorOf, task: shownTask, sessionHere,
    tiers: async () => {
      const { getTierSplit } = await import('../core/task-manager.js')
      await overlay.refresh(500)
      // The Focus bar a person sees: the copy's, with the pins, tiers and moves still on their way.
      return overlayTiers((await getTierSplit()) as unknown as Record<string, unknown>, overlay)
    },
    revokeLocally: (deviceId) => { opts.devices.revoke(deviceId) },
    log: (level, msg, data) => log.web[level](msg, data),
  })
  // WP11: note writes while away, journaled by this host's daemon (mounted before `writes`).
  const notes = awayNotes({
    actorOf, log: (level, msg, data) => log.web[level](msg, data),
    capable: () => { const caps = link.capabilities(); return caps === null ? null : caps.includes(NOTE_JOURNAL_CAP) },
  })
  // This host's sessions as the daemon sees them now (the session list's live state): ask-launch's
  // look, shared with every other reader (one follower.sessions at a time, at most once a second).
  const hostSessions = async () => (linked() && looks ? looks.hostSessions() : null)
  const reads = awayReads({
    overlay, answeredAway: (res: Response) => res.getHeader(ANSWERED_VIA_HEADER) === 'replica', hostKey: opts.hostKey, hostSessions,
    fresh: () => looks?.fresh() ?? Promise.resolve(),
    awayHere: (kind, id) => (kind === 'session' ? isAwaySession(id) : awaySessionsOfTask(id).length > 0),
    enrich: async (rows) => {
      const { enrichTasksWithSessionStatus } = await import('../web/routes/tasks.js')
      return await enrichTasksWithSessionStatus(rows as never) as unknown as typeof rows
    },
    taskSessions: async (task) => (await import('../web/routes/engine-switch-v1.js')).taskSessionsAnswer(task as never),
  })
  opts.setRpcAnswer(wsWrites({
    port, sessionHere, linked,
    request: (cmd, params, timeoutMs) => link.request(cmd, params, timeoutMs),
    log: (level, msg, data) => log.web[level](msg, data),
  }))

  // A device that removed itself here: done once the Mac's device list no longer names it.
  const releaseDevices = () => {
    const gone = overlay.watching('devices').filter((id) => !opts.devices.namedByMac(id))
    if (gone.length) overlay.stored('devices', gone, Number.MAX_SAFE_INTEGER)
  }
  // A mark shows: ask the daemon again until the Mac's row is back (each second while the
  // Mac answers or an acked write waits for its copy, slowly while the Mac sleeps).
  const watch = setInterval(() => {
    const age = watchMaxAgeMs(overlay.entries(), opts.macAnswers?.() === true)
    if (age === null) return
    releaseDevices()
    void overlay.refresh(age)
  }, WATCH_MS)
  watch.unref?.()
  log.web.info('replica: away writes wired', { hostKey: opts.hostKey, home: WALNUT_HOME })
  return {
    overlay, port, reads, writes, notes, actorOf, task: shownTask, sessionHere,
    setSessionLooks(l) { looks = l },
    stop() {
      clearInterval(watch)
      setCopyWatcher(null)
      installJournalOverlay(null)
      installAwayRequests(null)
      opts.setRpcAnswer(null)
      overlay.close()
    },
  }
}
