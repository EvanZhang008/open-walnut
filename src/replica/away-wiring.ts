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
import { awayReads, overlayBoard, overlayTiers, SYNC_FIELD } from './away-reads.js'
import { wsWrites } from './ws-writes.js'

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

  const overlay: Overlay = createOverlay({
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
        const row = overlay.task(k.id, await copyTask(k.id))
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

  const shownTask = async (id: string): Promise<TaskRow | null> => {
    await overlay.refresh(500)
    return overlay.task(id, await copyTask(id)) as TaskRow | null
  }
  const shownBoard = async (taskId: string): Promise<BoardBase | null> => {
    await overlay.refresh(500)
    const b = await copyBoard(taskId)
    const body = overlayBoard(taskId, {
      board: b ? { html: b.html, version: b.version } : null,
      threads: b?.threads ?? {}, marks: b?.marks ?? {}, projects: b?.projects ?? {}, choices: b?.choices ?? {},
    }, overlay)
    const pub = body.board as { html?: unknown; version?: unknown } | null
    if (!pub || typeof pub.html !== 'string') return null
    return {
      html: pub.html, version: Number(pub.version) || 0,
      threads: body.threads as Record<string, unknown>, marks: body.marks as Record<string, unknown>,
      projects: body.projects as Record<string, unknown>, choices: body.choices as Record<string, unknown>,
    }
  }
  const port = createWritePort({
    task: shownTask,
    board: shownBoard,
    noteWritten: (e) => {
      // A create's first word to browsers is task:created with the page's correlation
      // id (tasks.ts does the same), so the creating page swaps its optimistic row.
      if (e.clientRequestId && typeof e.record.taskId === 'string') created.set(e.record.taskId, e.clientRequestId)
      overlay.noteWritten(e)
    },
    log: (level, msg, data) => log.web[level](msg, data),
  })

  const sessionHere = async (sid: string): Promise<boolean> => {
    if (!opts.hostKey) return false
    const { getSessionByClaudeId } = await import('../core/session-tracker.js')
    const r = await getSessionByClaudeId(sid).catch(() => null)
    return !!r && (r.host ?? null) === opts.hostKey
  }
  const actorOf = (req: Request): WriteActor | null => {
    const h = req.headers.authorization
    const d = typeof h === 'string' && h.startsWith('Bearer ') ? opts.devices.verifyDevice(h.slice(7)) : null
    return d && d.id ? { kind: 'device', deviceId: d.id, name: d.name } : null
  }
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
  const reads = awayReads({ overlay, answeredAway: (res: Response) => res.getHeader(ANSWERED_VIA_HEADER) === 'replica' })
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
    overlay, port, reads, writes,
    stop() {
      clearInterval(watch)
      setCopyWatcher(null)
      installJournalOverlay(null)
      opts.setRpcAnswer(null)
      overlay.close()
    },
  }
}
