/**
 * The row source of a host's Walnut service that keeps no copy of the leader's data
 * (WALNUT_COPIES=none, core/replication/kinds/gate.ts keepsNoCopy): the slice the leader pushed
 * for this host's sessions, read from the runtime over the follower link (`follower.slice`,
 * 'copyless-service-v1'), with the live state of those sessions (`follower.sessions`).
 *
 * The slice is installed beneath the stores (core/unstored-rows.ts): the task store, the Board
 * store, the session registry and the request readers show its rows as stored, so every read and
 * every write's base comes from them through the same code a copy feeds (row-source.ts copy), and
 * the overlay folds this host's journal over them as over a copy. A task the slice does not hold
 * answers `needs_leader {why:'no_copy'}` for a write (`missing`), and the dispatcher answers a read
 * of anything else the same (copyless-reads.ts).
 *
 * Read again at most once a second, by a timer and before a write reads its row; a new slice (its
 * `asOf` moved) or a session that changed state rebuilds the rows once.
 */
import { NO_COPY_MESSAGE } from '../core/replication/needs-leader.js'
import { installUnstoredRows, unstoredRowsChanged } from '../core/unstored-rows.js'
import { deriveStatusFromPhase } from '../core/phase.js'
import type { ProcessStatus, SessionRecord, Task, TaskPhase } from '../core/types.js'
import type { SessionRequest } from '../core/session-requests.js'
import type { BoardFile } from '../core/boards/board-store.js'
import type { OfflineSliceRequest, OfflineSliceSession, OfflineSliceTask } from '../providers/offline-host-core.js'
import type { OfflineSliceBoard } from '../providers/offline-board-core.js'
import { copyRowSource, type RowSource } from './row-source.js'
import { needsLeaderAnswer } from './write-port.js'

type Request = (cmd: string, params: Record<string, unknown>, timeoutMs: number) => Promise<Record<string, unknown>>

/** The slice as the runtime answers `follower.slice`. */
export interface SliceAnswer {
  host?: unknown; asOf?: unknown; tasks?: unknown; sessions?: unknown; requests?: unknown; boards?: unknown; boardOf?: unknown
}

export interface SliceRows {
  tasks: Task[]
  sessions: SessionRecord[]
  requests: SessionRequest[]
  boards: Map<string, BoardFile>
  boardOf: Record<string, string>
  host: string
  asOf: number | null
}

const READ_TIMEOUT_MS = 3_000
const MIN_GAP_MS = 1_000

const arr = <T>(v: unknown): T[] => (Array.isArray(v) ? v as T[] : [])

/**
 * The fields a write can name that the slice may leave out (host-slice.ts keeps summary and note
 * out on purpose; an older leader ships fewer). One the slice lacks stays unset, never a made-up
 * empty value: an away write's base for it is then 'unknown' (write-port.ts fieldBases), as the
 * daemon's slice reader did, and the row names it in `slice_omits` so a reader knows it is not known here.
 */
const QUEUEABLE = ['description', 'summary', 'note', 'priority', 'status', 'due_date', 'start_date', 'end_date', 'sprint', 'focus_tier', 'wait_until', 'tags', 'depends_on', 'pinned', 'unread'] as const

/** A slice task as a stored task: the fields the slice carries, the rest unset (QUEUEABLE). */
export function taskOfSlice(t: OfflineSliceTask, asOfIso: string): Task {
  const phase = (t.phase || 'TODO') as TaskPhase
  const omits = QUEUEABLE.filter((f) => f !== 'status' && (t as unknown as Record<string, unknown>)[f] === undefined)
  return {
    session_ids: [], project: '',
    created_at: t.updated_at ?? asOfIso,
    ...t,
    phase,
    // A status follows from the phase (phase.ts), so a missing one is known.
    status: (t.status ?? deriveStatusFromPhase(phase)) as Task['status'],
    updated_at: t.updated_at ?? asOfIso,
    ...(omits.length ? { slice_omits: omits } : {}),
  } as unknown as Task
}

/**
 * A slice session as a stored session row: its task, this host, its state now when known.
 * `state` null: the runtime's list could not be read, so the state is unknown (left unset), never 'stopped'.
 */
export function sessionOfSlice(s: OfflineSliceSession, hostKey: string, state: string | undefined | null, asOfIso: string, tasks: ReadonlyMap<string, Task>): SessionRecord {
  const process: ProcessStatus | undefined = state === null ? undefined : state === 'working' ? 'running' : state === 'idle' ? 'idle' : 'stopped'
  const task = s.taskId ? tasks.get(s.taskId) : undefined
  return {
    claudeSessionId: s.sid, taskId: s.taskId ?? '', project: task?.project ?? '',
    ...(process ? { process_status: process } : {}), mode: 'default', startedAt: asOfIso, lastActiveAt: asOfIso, messageCount: 0,
    host: hostKey, ...(s.title ? { title: s.title } : {}),
    ...(s.acp ? { provider: 'acp' } : {}),
  } as unknown as SessionRecord
}

/** A slice request as a stored request row. */
export function requestOfSlice(r: OfflineSliceRequest): SessionRequest {
  const { carries: _carries, fromHost: _from, toHost: _to, ...rest } = r
  return { ...rest } as unknown as SessionRequest
}

/** A slice Board as a stored Board file (the page and its parts; its owner is the task it is for). */
export function boardOfSlice(b: OfflineSliceBoard): BoardFile {
  const { taskId, ...rest } = b
  return { task_id: taskId, ...rest } as unknown as BoardFile
}

/** `live`: each session's state from the runtime (`follower.sessions`), or null when that list could not be read. */
export function rowsOfSlice(a: SliceAnswer, live: ReadonlyMap<string, string> | null, hostKey: string): SliceRows {
  const asOf = typeof a.asOf === 'number' ? a.asOf : null
  const asOfIso = new Date(asOf ?? 0).toISOString()
  const tasks = arr<OfflineSliceTask>(a.tasks).filter((t) => t && typeof t.id === 'string').map((t) => taskOfSlice(t, asOfIso))
  const byId = new Map(tasks.map((t) => [t.id, t]))
  const sessions = arr<OfflineSliceSession>(a.sessions).filter((s) => s && typeof s.sid === 'string')
    .map((s) => sessionOfSlice(s, hostKey, live ? live.get(s.sid) : null, asOfIso, byId))
  const boards = new Map(arr<OfflineSliceBoard>(a.boards).filter((b) => b && typeof b.taskId === 'string').map((b) => [b.taskId, boardOfSlice(b)]))
  const boardOf = a.boardOf && typeof a.boardOf === 'object' && !Array.isArray(a.boardOf) ? a.boardOf as Record<string, string> : {}
  return {
    tasks, sessions, boards, boardOf, asOf,
    requests: arr<OfflineSliceRequest>(a.requests).filter((r) => r && typeof r.id === 'string').map(requestOfSlice),
    host: typeof a.host === 'string' ? a.host : '',
  }
}

export interface SliceSource extends RowSource {
  /** The rows as last read (null before the first answer). */
  rows(): SliceRows | null
  stop(): void
}

export interface SliceSourceOptions {
  request: Request
  /** The leader's name for this host: the `host` of its sessions. */
  hostKey: string | null
  now?(): number
  log?(level: 'info' | 'warn', msg: string, data?: Record<string, unknown>): void
  /** How often the timer reads it (tests: 0 for no timer). */
  everyMs?: number
}

/** Reads the slice, installs it beneath the stores, and keeps it current. */
export function createSliceSource(opts: SliceSourceOptions): SliceSource {
  const now = opts.now ?? Date.now
  const log = opts.log ?? (() => {})
  let rows: SliceRows | null = null
  let lastStates: Map<string, string> | null = null
  let key = ''
  let readAt = 0
  let inFlight: Promise<void> | null = null

  async function read(): Promise<void> {
    const [slice, live] = await Promise.all([
      opts.request('follower.slice', {}, READ_TIMEOUT_MS),
      opts.request('follower.sessions', {}, READ_TIMEOUT_MS).catch(() => null),
    ])
    if (slice.ok === false) throw new Error(String(slice.error ?? 'follower.slice refused'))
    // A list that could not be read keeps the states last read; with none, they are unknown.
    let states: Map<string, string> | null = lastStates
    if (live && live.ok !== false) {
      states = new Map<string, string>()
      for (const s of arr<{ sid?: unknown; state?: unknown }>(live.sessions)) if (typeof s?.sid === 'string' && typeof s.state === 'string') states.set(s.sid, s.state)
      lastStates = states
    }
    const next = `${String(slice.asOf)}|${states ? [...states].map(([k, v]) => `${k}=${v}`).join(',') : '?'}`
    readAt = now()
    if (next === key && rows) return
    key = next
    rows = rowsOfSlice(slice, states, opts.hostKey ?? (typeof slice.host === 'string' ? slice.host : ''))
    unstoredRowsChanged()
  }

  async function refresh(maxAgeMs = MIN_GAP_MS): Promise<void> {
    if (rows && now() - readAt < maxAgeMs) return
    inFlight ??= read().catch((err: Error) => { log('warn', 'replica: the slice could not be read', { error: err.message }) }).finally(() => { inFlight = null })
    await inFlight
  }

  installUnstoredRows({
    tasks: () => rows?.tasks ?? [],
    board: (taskId) => rows?.boards.get(taskId) ?? null,
    boardOwner: (taskId) => (rows && Object.hasOwn(rows.boardOf, taskId) && typeof rows.boardOf[taskId] === 'string' ? rows.boardOf[taskId] : null),
    sessions: () => rows?.sessions ?? [],
    requests: () => rows?.requests ?? [],
  })
  const every = opts.everyMs ?? MIN_GAP_MS
  const timer = every > 0 ? setInterval(() => { void refresh(every) }, every) : null
  timer?.unref?.()
  void refresh(0)

  const copy = copyRowSource()
  return {
    ...copy,
    kind: 'slice',
    refresh,
    missing: () => needsLeaderAnswer('no_copy', NO_COPY_MESSAGE),
    rows: () => rows,
    stop() {
      if (timer) clearInterval(timer)
      installUnstoredRows(null)
    },
  }
}
