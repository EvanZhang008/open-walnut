/**
 * Offline host: the daemon answers a session's `walnut` calls while its Walnut
 * server is not connected (docs/plan/daemon-first-hosts.md).
 *
 * The server pushes a read copy per Walnut (`host.slice`: its sessions on this
 * host, their tasks, the pending reply requests between them). While that
 * Walnut is away, the gateway hands calls here instead of answering
 * hub_unreachable:
 *   - task_get / task_list / session_list read the copy;
 *   - task_send to a session of the same Walnut running on this host is written
 *     into the target's FIFO with the envelope the server would build (the
 *     shared envelope kit), and a reply request it opens is OWNED here: a reply
 *     settles it, the target's turn end without one sends the usual notice;
 *   - task_update / task_complete are journaled and replayed by the server;
 *   - a trigger fire no server claimed reaches the target task's live session
 *     here (deliverTrigger; the trigger's own fire queue reports it).
 * Everything the server must learn goes into a per-Walnut journal it drains on
 * reconnect (`offline.drain` / `offline.ack`); until the journal is empty the
 * gateway keeps answering here, so no id the server has not seen yet reaches it.
 *
 * How the daemon twins get it: daemon-standalone.ts imports createOfflineHost;
 * daemon-source.ts inlines `createOfflineHost.toString()` through
 * `__CREATE_OFFLINE_HOST__`. So the factory body references NOTHING at module
 * scope; the envelope kit and every side effect arrive through deps.
 */

import type { EnvelopeKit, EnvelopeOutcome } from '../core/peers/envelope-kit.js'
import type { BoardOffline, OfflineSliceBoard } from './offline-board-core.js'
import type { HostReplica } from './host-replica-core.js'
import type { OpenAsk, OpenItemsInput, OpenItemsText, OpenWait } from '../core/sessions/open-items-text.js'

/** `aside`: an environment or lane session, which the server never picks as a message's address by name. */
export interface OfflineSliceSession { sid: string; taskId?: string; title?: string; aside?: boolean }

export interface OfflineSliceTask {
  id: string
  title: string
  phase?: string
  project?: string
  group_id?: string
  parent_task_id?: string
  description?: string
  updated_at?: string
  session_id?: string
}

/**
 * A pending request the SERVER owns, copied because one party (or both) runs on
 * this host. `fromHost` / `toHost` name the other party's host when it runs
 * elsewhere: an answer to it then travels through the leader.
 */
export interface OfflineSliceRequest {
  id: string
  fromSessionId: string
  toSessionId?: string
  toTaskId?: string
  preview: string
  status: 'pending'
  createdAt: string
  deadlineAt: number
  fromHost?: string
  toHost?: string
}

export interface HostSlice {
  v: 1
  /** The Walnut's data dir: the tenant key (the spawn journal records it per session). */
  home: string
  hash: string
  asOf: number
  /** How this Walnut names this host in envelopes (displayHost). */
  host: string
  sessions: OfflineSliceSession[]
  tasks: OfflineSliceTask[]
  requests: OfflineSliceRequest[]
  /** The Boards of the teams whose sessions run here (offline-board-core.ts). */
  boards?: OfflineSliceBoard[]
  /** A session task's team board: task id → the board's task id. */
  boardOf?: Record<string, string>
}

export type OfflineRequestStatus = 'pending' | 'replied' | 'notified' | 'expired' | 'withdrawn'

/** A request row (same fields as the server's SessionRequest) plus daemon bookkeeping. */
export interface OfflineRequestRow {
  id: string
  fromSessionId: string
  toSessionId: string
  toTaskId?: string
  preview: string
  status: OfflineRequestStatus
  createdAt: string
  deadlineAt: number
  settledAt?: string
  outcome?: EnvelopeOutcome
  /** Turn ends to ignore before "finished without replying" counts (target was mid-turn at delivery). */
  skipTurnEnds?: number
  /** Stream size just before the delivery: only result lines past it can end this message's turn. */
  afterV?: number
  /** Offset of the last result line counted, so a re-read of the stream never counts one twice. */
  lastResultV?: number
  /** The asker runs on another host (named as this Walnut names it): its answer goes through the leader. */
  fromHost?: string
  /**
   * Opened while the server answered (handleLocal): the server speaks for it
   * ("finished without replying", the deadline) while it still answers this
   * host, whether or not it has taken the row yet; this host only when it does not.
   */
  online?: true
}

/**
 * `online`: written while the server answered (a same-host message this host
 * delivered itself, handleLocal). The server takes it within moments, and a
 * relayed call never has to wait for it: the server drains before it answers.
 */
export type OfflineRecord =
  | { seq: number; at: number; online?: true; kind: 'row'; row: OfflineRequestRow }
  | { seq: number; at: number; online?: true; kind: 'settle'; requestId: string; status: 'replied' }
  | { seq: number; at: number; online?: true; kind: 'delivery'; fromSessionId: string; toSessionId: string; toTaskId?: string; messageId: string; requestId?: string; reply?: boolean }
  /** `base`: the copy's updated_at for that task when the write was queued (the server's clock). */
  | { seq: number; at: number; online?: true; kind: 'op'; op: string; args: Record<string, unknown>; callerSid: string; base?: string }

interface Journal { nextSeq: number; records: OfflineRecord[]; rows: Record<string, OfflineRequestRow>; settledCopies: string[] }

type GatewayResult = { ok: true; result: Record<string, unknown> } | { ok: false; error: { code: string; message: string; retryAfterMs?: number; detail?: unknown } }

export type DeliverResult = { ok: true } | { ok: false; reason: string }

export interface OfflineHostDeps {
  fs: typeof import('node:fs')
  path: typeof import('node:path')
  /** Directory for slice-<key>.json / journal-<key>.json. */
  dir: string
  now: () => number
  randomHex: (bytes: number) => string
  /** Short stable file key for a home (a hash; homes are paths). */
  keyOf: (home: string) => string
  kit: EnvelopeKit
  log: (level: 'info' | 'warn' | 'error', msg: string, data?: Record<string, unknown>) => void
  /** The daemon runs a live CLI for this sid. */
  isLive: (sid: string) => boolean
  /** The sid is mid-turn right now (its fold says a turn is open). */
  turnActive: (sid: string) => boolean
  /**
   * The tool the session's CLI waits on the human for (a permission prompt), or
   * null. A message to it is the server's to park until the prompt is answered.
   * Absent: this host never delivers a message itself while the server answers.
   */
  pendingPrompt?: (sid: string) => string | null
  /** The session's stream size now (the byte offset result lines carry as `v`). */
  streamOffset: (sid: string) => number | undefined
  /** Write one user message into the session's FIFO, with a turn-opening marker (send-markers-v1). */
  deliver: (sid: string, text: string, messageId: string) => Promise<DeliverResult>
  /** A journal grew while a server of that home is connected: ask it to drain. */
  onJournal?: (home: string) => void
  /** A server of that home is connected and answering (not silent, not replaced by the companion). */
  serverAnswers?: (home: string) => boolean
  /**
   * Hand text for a session on ANOTHER host to the server leading this Walnut
   * while its primary is away (the cloud companion, docs/plan/walnut-control-plane.md).
   * Absent, or answering not ok, when nobody leads: the caller is told the
   * primary is needed, as before.
   */
  relay?: (home: string, req: { toHost: string; toSid: string; text: string; messageId: string; requestId?: string; reply?: boolean; fromSessionId?: string }) => Promise<DeliverResult>
  /** Board checks and the copy's overlay; absent: board ops need the server. */
  boards?: BoardOffline
  /** This host's copy of the notes, memory and skills (host-replica-core.ts); absent: those reads need the server. */
  replica?: HostReplica
  /** The post-compaction block's wording (open-items-text.ts); absent: open_items needs the server. */
  openItems?: OpenItemsText
}

/** A message the leader routes to a session of this host (`leader.deliver`). */
export type LeaderDelivery =
  | {
    kind: 'peer'
    /** The sender, on another host. */
    from: { sid: string; taskId?: string; title?: string; host: string }
    /** A task id (or unique prefix) or a session id on this host. */
    to: string
    text: string
    title?: string
    expect_reply?: boolean
    reply_timeout?: number
    messageId?: string
  }
  | {
    kind: 'text'
    /** A session of this Walnut on this host. */
    toSid: string
    /** Already built (a reply envelope, a Walnut notice) by the host it came from. */
    text: string
    messageId?: string
    requestId?: string
    reply?: boolean
    fromSessionId?: string
  }

export function createOfflineHost(deps: OfflineHostDeps) {
  const { fs, path, kit } = deps
  const MAX_RECORDS = 1000
  const MAX_ARGS_BYTES = 256 * 1024
  const WRITE_BUDGET = 30
  const WRITE_WINDOW_MS = 60_000
  const DEFAULT_REPLY_SECS = 3_600
  const IMPLICIT_REPLY_SECS = 6 * 3_600
  const DRAIN_BATCH = 200
  const QUEUED_OPS = ['task_update', 'task_complete']
  const OFFLINE_OPS: Array<{ name: string; title: string; description: string; readonly: boolean; signature: string }> = [
    { name: 'task_get', title: 'Get one task (offline copy)', description: 'A task of a session on this host, from the copy the Walnut server last pushed.', readonly: true, signature: 'id' },
    { name: 'task_list', title: 'List tasks on this host (offline copy)', description: 'Tasks of the sessions on this host, their parents and children.', readonly: true, signature: '[q] [limit]' },
    { name: 'session_list', title: 'List sessions on this host', description: 'This Walnut\'s sessions on this host and whether each is running.', readonly: true, signature: '' },
    { name: 'task_send', title: 'Message a task on this host', description: 'Delivered by this host directly; the target must be running here. Replies and notices work as usual.', readonly: false, signature: 'to text [expect_reply] [reply_timeout] [in_reply_to] [messageId]' },
    { name: 'request_get', title: 'Read a reply-request status', description: 'Requests this host holds.', readonly: true, signature: 'id' },
    { name: 'task_update', title: 'Update a task (queued)', description: 'Saved here and applied when the Walnut server reconnects.', readonly: false, signature: 'id ...fields' },
    { name: 'task_complete', title: 'Complete a task (queued)', description: 'Saved here and applied when the Walnut server reconnects.', readonly: false, signature: 'id' },
  ]
  if (deps.boards) {
    OFFLINE_OPS.push(
      { name: 'board_get', title: 'Read your team\'s Board (copy on this host)', description: 'The Board this host keeps for its teams, with the writes made here since.', readonly: true, signature: '[task]' },
      { name: 'board_set', title: 'Write the whole Board (applied here, sent later)', description: 'Applied to this host\'s copy now and to Walnut when the server reconnects.', readonly: false, signature: '[task] html [version]' },
      { name: 'board_edit', title: 'Edit the Board in place (applied here, sent later)', description: 'Exact-string edits, as online; applied to this host\'s copy now and to Walnut when the server reconnects.', readonly: false, signature: '[task] edits [version]' },
      { name: 'board_post', title: 'Post in a Board thread (applied here, sent later)', description: 'Applied to this host\'s copy now and to Walnut when the server reconnects.', readonly: false, signature: '[task] thread text' },
      { name: 'board_project_set', title: 'Set a Board project (applied here, sent later)', description: 'Applied to this host\'s copy now and to Walnut when the server reconnects.', readonly: false, signature: '[task] id ...fields' },
    )
  }
  if (deps.openItems) {
    OFFLINE_OPS.push({ name: 'open_items', title: 'What is still open for your task (copy on this host)', description: 'Unfinished subtasks and pending reply requests, as this host\'s copy has them; also what Walnut puts into your context after a compaction.', readonly: true, signature: '[hook]' })
  }
  const OFFLINE_NAMES = OFFLINE_OPS.map((o) => o.name).join(', ')
  /** Reads this host answers from its slice: safe to answer here when the server does not (nothing to apply twice). */
  const READ_OPS = OFFLINE_OPS.filter((o) => o.readonly).map((o) => o.name)

  /** How long a drained-but-unacked row is left to the server before this host acts on it again. */
  const HANDOVER_GRACE_MS = 60_000

  const slices = new Map<string, HostSlice>()
  const journals = new Map<string, Journal>()
  const writes = new Map<string, number[]>()
  /** Rows the server is taking right now (drained, not yet acked): no notice from here. */
  const handingOver = new Map<string, number>()

  function fail(code: string, message: string, extra?: { retryAfterMs?: number; detail?: unknown }): GatewayResult {
    return { ok: false, error: { code, message, ...(extra ?? {}) } }
  }

  function ok(result: Record<string, unknown>): GatewayResult {
    return { ok: true, result }
  }

  function file(kind: 'slice' | 'journal', home: string): string {
    return path.join(deps.dir, `${kind}-${deps.keyOf(home)}.json`)
  }

  function writeAtomic(target: string, value: unknown): void {
    try {
      fs.mkdirSync(deps.dir, { recursive: true, mode: 0o700 })
      const tmp = `${target}.${process.pid}.tmp`
      fs.writeFileSync(tmp, JSON.stringify(value), { mode: 0o600 })
      fs.renameSync(tmp, target)
    } catch (err) {
      deps.log('warn', 'offline host: persist failed', { file: target, error: (err as Error).message })
    }
  }

  function readJson<T>(target: string): T | null {
    try { return JSON.parse(fs.readFileSync(target, 'utf8')) as T } catch { return null }
  }

  /** Load every persisted slice and journal (a daemon restart while the server is away keeps both). */
  function load(): void {
    let names: string[] = []
    try { names = fs.readdirSync(deps.dir) } catch { return }
    for (const name of names) {
      if (!name.startsWith('slice-') || !name.endsWith('.json')) continue
      const slice = readJson<HostSlice>(path.join(deps.dir, name))
      if (!slice || slice.v !== 1 || typeof slice.home !== 'string') continue
      slices.set(slice.home, slice)
      const journal = readJson<Journal>(file('journal', slice.home))
      if (journal && Array.isArray(journal.records)) {
        journals.set(slice.home, {
          nextSeq: journal.nextSeq || 1,
          records: journal.records,
          rows: journal.rows ?? {},
          settledCopies: journal.settledCopies ?? [],
        })
      }
    }
  }

  function journalOf(home: string): Journal {
    let j = journals.get(home)
    if (!j) { j = { nextSeq: 1, records: [], rows: {}, settledCopies: [] }; journals.set(home, j) }
    return j
  }

  function persistJournal(home: string): void {
    writeAtomic(file('journal', home), journalOf(home))
  }

  // Distributive over the union: an `Omit` of the whole union would collapse it.
  type NewRecord = OfflineRecord extends infer R ? R extends OfflineRecord ? Omit<R, 'seq' | 'at' | 'online'> : never : never

  function append(home: string, record: NewRecord, online = false): void {
    const j = journalOf(home)
    j.records.push({ ...record, seq: j.nextSeq++, at: deps.now(), ...(online ? { online: true } : {}) } as OfflineRecord)
    persistJournal(home)
    try { deps.onJournal?.(home) } catch { /* a notify failure never loses the record */ }
  }

  function configure(slice: HostSlice): { changed: boolean } {
    if (!slice || slice.v !== 1 || typeof slice.home !== 'string' || !slice.home) throw new Error('host.slice: bad slice')
    const prev = slices.get(slice.home)
    const changed = !prev || prev.hash !== slice.hash
    slices.set(slice.home, slice)
    if (changed) writeAtomic(file('slice', slice.home), slice)
    // A settle made offline for a server-owned copy is spoken for once the server
    // stops listing that request as pending: drop the local marker with it.
    const j = journals.get(slice.home)
    if (j && j.settledCopies.length) {
      const pending = new Set(slice.requests.map((r) => r.id))
      const kept = j.settledCopies.filter((id) => pending.has(id))
      if (kept.length !== j.settledCopies.length) { j.settledCopies = kept; persistJournal(slice.home) }
    }
    return { changed }
  }

  function hasHome(home: string | undefined): boolean {
    return !!home && slices.has(home)
  }

  /** The Walnut whose copy lists this session (at most one: session ids are UUIDs). */
  function ownerOf(sid: string): string | undefined {
    for (const [home, slice] of slices) if (slice.sessions.some((s) => s.sid === sid)) return home
    return undefined
  }

  /**
   * Records made while the server was away that it has not taken yet: while any
   * exist the gateway answers here. A record made while it answered (`online`)
   * holds nothing back: the server drains it before it answers a relayed call.
   */
  function pendingHandover(home: string | undefined): boolean {
    return !!home && (journals.get(home)?.records ?? []).some((r) => !r.online)
  }

  function drain(home: string): { records: OfflineRecord[]; more: boolean } {
    const records = journals.get(home)?.records ?? []
    const batch = records.slice(0, DRAIN_BATCH)
    // The server may notice a row it just imported; this host stays quiet on it
    // meanwhile, or the asker could hear twice.
    for (const r of batch) if (r.kind === 'row') handingOver.set(r.row.id, deps.now())
    return { records: batch, more: records.length > DRAIN_BATCH }
  }

  function isHandingOver(id: string): boolean {
    const at = handingOver.get(id)
    if (at === undefined) return false
    if (deps.now() - at < HANDOVER_GRACE_MS) return true
    handingOver.delete(id)
    return false
  }

  /** The server applied every record up to `upTo`: drop them, and the rows it now owns. */
  function ack(home: string, upTo: number): { remaining: number } {
    const j = journals.get(home)
    if (!j || typeof upTo !== 'number') return { remaining: j?.records.length ?? 0 }
    const handed = new Set<string>()
    for (const r of j.records) if (r.seq <= upTo && r.kind === 'row') handed.add(r.row.id)
    j.records = j.records.filter((r) => r.seq > upTo)
    // A row whose latest state the server took is the server's now; a later
    // record for it (written during the handover) keeps it here one more round.
    const stillOwed = new Set(j.records.filter((r) => r.kind === 'row').map((r) => (r as { row: OfflineRequestRow }).row.id))
    for (const id of handed) {
      handingOver.delete(id)
      if (!stillOwed.has(id)) delete j.rows[id]
    }
    persistJournal(home)
    return { remaining: j.records.length }
  }

  // ── lookups over the copy ──

  function tasksWithOverlay(home: string): OfflineSliceTask[] {
    const slice = slices.get(home)
    if (!slice) return []
    const overlay = new Map<string, Record<string, unknown>>()
    for (const r of journals.get(home)?.records ?? []) {
      if (r.kind !== 'op' || QUEUED_OPS.indexOf(r.op) === -1) continue
      const id = String(r.args.id ?? '')
      const cur = overlay.get(id) ?? {}
      if (r.op === 'task_complete') cur.phase = 'COMPLETE'
      else for (const k of ['title', 'description', 'phase', 'note', 'summary']) {
        if (typeof r.args[k] === 'string') cur[k] = r.args[k]
      }
      overlay.set(id, cur)
    }
    return slice.tasks.map((t) => (overlay.has(t.id) ? { ...t, ...overlay.get(t.id), queued_offline: true } as OfflineSliceTask : t))
  }

  function resolveTask(home: string, ref: string): { task?: OfflineSliceTask; error?: GatewayResult } {
    const id = ref.trim()
    const tasks = tasksWithOverlay(home)
    const exact = tasks.find((t) => t.id === id)
    if (exact) return { task: exact }
    const hits = id.length >= 4 ? tasks.filter((t) => t.id.startsWith(id)) : []
    if (hits.length === 1) return { task: hits[0] }
    if (hits.length > 1) {
      return { error: fail('ambiguous_peer', `"${id}" matches ${hits.length} tasks on this host`, { detail: { candidates: hits.map((t) => ({ id: t.id, shortId: t.id, title: t.title })) } }) }
    }
    return {}
  }

  function sessionOf(home: string, sid: string): OfflineSliceSession | undefined {
    return slices.get(home)?.sessions.find((s) => s.sid === sid)
  }

  function callerIdentity(home: string, sid: string): { title: string; taskId?: string } {
    const row = sessionOf(home, sid)
    const taskId = row?.taskId
    const title = row?.title ?? (taskId ? slices.get(home)?.tasks.find((t) => t.id === taskId)?.title : undefined) ?? ''
    return { title, taskId }
  }

  function asOf(home: string): string {
    const at = slices.get(home)?.asOf
    return typeof at === 'number' ? new Date(at).toISOString() : 'unknown'
  }

  function offlineNote(home: string): string {
    return `The Walnut server is not reachable from this host right now; this host answered from its copy as of ${asOf(home)}.`
  }

  function needsServer(what: string): GatewayResult {
    return fail('hub_unreachable', `${what} needs the Walnut server, which is not answering this host right now. Meanwhile this host still answers: ${OFFLINE_NAMES}.`)
  }

  function admitWrite(callerSid: string): GatewayResult | null {
    const now = deps.now()
    const recent = (writes.get(callerSid) ?? []).filter((t) => now - t < WRITE_WINDOW_MS)
    if (recent.length >= WRITE_BUDGET) {
      return fail('throttled', 'too many offline writes, slow down', { retryAfterMs: WRITE_WINDOW_MS - (now - recent[0]) })
    }
    recent.push(now)
    writes.set(callerSid, recent)
    return null
  }

  function roomFor(home: string): GatewayResult | null {
    return (journals.get(home)?.records.length ?? 0) >= MAX_RECORDS
      ? fail('queue_full', `this host already holds ${MAX_RECORDS} records for the Walnut server; wait for it to reconnect`)
      : null
  }

  function messageId(given: unknown): string {
    return typeof given === 'string' && /^qm-[A-Za-z0-9-]{1,64}$/.test(given) ? given : `qm-offline-${deps.randomHex(8)}`
  }

  function clampSecs(secs: unknown, implicit: boolean): number {
    if (typeof secs !== 'number' || !Number.isFinite(secs)) return implicit ? IMPLICIT_REPLY_SECS : DEFAULT_REPLY_SECS
    return Math.min(86_400, Math.max(60, Math.floor(secs)))
  }

  // ── ops ──

  function opTaskGet(home: string, args: Record<string, unknown>): GatewayResult {
    const ref = typeof args.id === 'string' ? args.id : ''
    if (!ref) return fail('bad_request', 'task_get needs "id"')
    const { task, error } = resolveTask(home, ref)
    if (error) return error
    if (!task) return needsServer(`Task ${ref} is not in this host's offline copy; reading it`)
    const running = (slices.get(home)?.sessions ?? []).some((s) => s.taskId === task.id && deps.isLive(s.sid))
    return ok({
      task: { ...task, execution: { state: running ? 'running' : 'unknown' } },
      offline: true, as_of: asOf(home),
      outcome: `Task phase: ${task.phase ?? 'unknown'} (offline copy). ${offlineNote(home)}`,
      next: 'Nothing else is required.',
    })
  }

  function opTaskList(home: string, args: Record<string, unknown>): GatewayResult {
    const q = typeof args.q === 'string' ? args.q.trim().toLowerCase() : ''
    const limit = typeof args.limit === 'number' && args.limit > 0 ? Math.min(500, Math.floor(args.limit)) : 50
    const all = tasksWithOverlay(home).filter((t) => !q || t.title.toLowerCase().includes(q) || t.id.startsWith(q))
    return ok({
      scope: 'this-host', offline: true, as_of: asOf(home),
      count: Math.min(limit, all.length), total: all.length, truncated: all.length > limit,
      tasks: all.slice(0, limit),
      hint: `${offlineNote(home)} Only tasks of this host's sessions (and their parents and children) are listed.`,
    })
  }

  function opSessionList(home: string): GatewayResult {
    const slice = slices.get(home)
    const sessions = (slice?.sessions ?? []).map((s) => ({
      id: s.sid, shortId: s.sid.slice(0, 8), title: s.title ?? null, taskId: s.taskId ?? null,
      host: slice?.host ?? null, status: deps.isLive(s.sid) ? 'running' : 'stopped',
    }))
    return ok({ sessions, offline: true, as_of: asOf(home), hint: offlineNote(home) })
  }

  function findRequest(home: string, id: string): { own?: OfflineRequestRow; copy?: OfflineSliceRequest } {
    const own = journals.get(home)?.rows[id]
    if (own) return { own }
    const copy = slices.get(home)?.requests.find((r) => r.id === id)
    return copy ? { copy } : {}
  }

  function opRequestGet(home: string, args: Record<string, unknown>): GatewayResult {
    const id = typeof args.id === 'string' ? args.id : ''
    if (!/^rq-[a-f0-9]{6,}$/.test(id)) return fail('bad_request', 'request_get needs an rq-… id')
    const { own, copy } = findRequest(home, id)
    if (!own && !copy) return needsServer(`Request ${id} is not held by this host; reading it`)
    const settled = !own && journalOf(home).settledCopies.includes(id)
    const request = own ?? { ...copy!, ...(settled ? { status: 'replied' } : {}) }
    const pending = request.status === 'pending'
    return ok({
      request, offline: true,
      outcome: pending ? 'Still pending: the other session has not answered yet.' : `This request is ${request.status}.`,
      next: pending ? 'Do not poll this; the answer arrives in your session on its own.' : 'Nothing else is required.',
    })
  }

  /**
   * What is still open for the caller's task (core/sessions/open-items.ts), from
   * the copy: its unfinished subtasks, the requests it waits on and the ones it
   * owes, its Board. The compact hook (`hook: 'compact'`) gets the SessionStart
   * hook's JSON, as from the server, so a compaction while the server is away
   * still puts the list back into the session's context.
   */
  function opOpenItems(home: string, callerSid: string, args: Record<string, unknown>): GatewayResult {
    const MAX_SUBTASKS = 20
    const MAX_REQUESTS = 10
    const now = deps.now()
    const ownId = callerIdentity(home, callerSid).taskId
    const tasks = tasksWithOverlay(home)
    const task = ownId ? tasks.find((t) => t.id === ownId) : undefined
    const items: OpenItemsInput = { subtasks: [], moreSubtasks: 0, waitingOn: [], askedOfYou: [] }
    if (task) {
      items.task = { id: task.id, title: task.title }
      // A stored parent id may be a legacy short prefix of the parent's id.
      const children = tasks
        .filter((t) => t.id !== task.id && !!t.parent_task_id && task.id.startsWith(t.parent_task_id) && t.phase !== 'COMPLETE')
        .sort((a, b) => (b.updated_at ?? '').localeCompare(a.updated_at ?? ''))
      items.subtasks = children.slice(0, MAX_SUBTASKS).map((t) => ({ id: t.id, title: t.title, phase: t.phase ?? 'TODO' }))
      items.moreSubtasks = children.length - items.subtasks.length
      const j = journalOf(home)
      const pending: Array<{ id: string; fromSessionId: string; toSessionId?: string; toTaskId?: string; preview: string; createdAt: string }> = [
        ...Object.values(j.rows).filter((r) => r.status === 'pending'),
        ...(slices.get(home)?.requests ?? []).filter((r) => !j.rows[r.id] && j.settledCopies.indexOf(r.id) === -1),
      ]
      const newest = (a: { createdAt: string }, b: { createdAt: string }) => b.createdAt.localeCompare(a.createdAt)
      items.waitingOn = pending.filter((r) => r.fromSessionId === callerSid).sort(newest).slice(0, MAX_REQUESTS)
        .map((r): OpenWait => ({ id: r.id, to: r.toTaskId ?? (r.toSessionId ? `session ${r.toSessionId.slice(0, 8)}` : 'unknown'), preview: r.preview, createdAt: r.createdAt }))
      items.askedOfYou = pending.filter((r) => r.toSessionId === callerSid || (!!r.toTaskId && r.toTaskId === task.id)).sort(newest).slice(0, MAX_REQUESTS)
        .map((r): OpenAsk => ({ id: r.id, from: sessionOf(home, r.fromSessionId)?.taskId ?? `session ${r.fromSessionId.slice(0, 8)}`, preview: r.preview, createdAt: r.createdAt }))
      const board = deps.boards ? boardWithOverlay(home, task.id) : undefined
      if (board) {
        const msgs = Object.values(board.threads ?? {}).reduce<Array<{ author: string }>>((all, list) => all.concat(list), [])
        items.board = {
          version: board.version, updatedAt: board.updated_at ?? '', threads: Object.keys(board.threads ?? {}).length,
          userMessages: msgs.filter((m) => m.author === 'user').length, marks: Object.keys(board.marks ?? {}).length,
        }
      }
    }
    const text = deps.openItems!.format(items, now)
    if (args.hook === 'compact') {
      return ok(text ? { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: text } } : {})
    }
    return ok({
      ...items, text, offline: true, as_of: asOf(home),
      outcome: `${text ? 'These are still open for your task' : 'Nothing is open for your task'} (this host's copy). ${offlineNote(home)}`,
      next: 'Read one with task_get; answer a request with task_send in_reply_to.',
    })
  }

  /**
   * The server's rule (session-send-core.ts), said here too: a subtask never
   * messages its COMPLETE parent, as this copy (with queued completions) sees it.
   */
  function parentCompleteRefusal(home: string, callerSid: string, targetTaskId: string | undefined): GatewayResult | undefined {
    return parentCompleteRefusalOf(home, callerIdentity(home, callerSid).taskId, targetTaskId)
  }

  function parentCompleteRefusalOf(home: string, ownId: string | undefined, targetTaskId: string | undefined): GatewayResult | undefined {
    if (!ownId || !targetTaskId) return undefined
    const tasks = tasksWithOverlay(home)
    const parentRef = tasks.find((t) => t.id === ownId)?.parent_task_id
    if (!parentRef || !targetTaskId.startsWith(parentRef)) return undefined
    const parent = tasks.find((t) => t.id === targetTaskId)
    if (parent?.phase !== 'COMPLETE') return undefined
    return fail('parent_complete', `"${parent.title}" (${parent.id}) is your task's parent and it is complete: it no longer takes messages `
      + 'from its subtasks. Keep your result in your own task, where the user reads it; if that task should hear from you again, the user reopens it.',
    { detail: { parentTaskId: parent.id } })
  }

  async function opReply(home: string, callerSid: string, args: Record<string, unknown>, text: string): Promise<GatewayResult> {
    const id = String(args.in_reply_to)
    const { own, copy } = findRequest(home, id)
    const row = own ?? copy
    if (!row) return needsServer(`Request ${id} is not held by this host; answering it`)
    const me = callerIdentity(home, callerSid)
    const isTarget = row.toSessionId === callerSid || (!!row.toTaskId && row.toTaskId === me.taskId)
    if (!isTarget) return fail('bad_request', `request ${id} was not addressed to this session`)
    const closed = parentCompleteRefusal(home, callerSid, sessionOf(home, row.fromSessionId)?.taskId)
    if (closed) return closed
    // The asker runs elsewhere: only a leader can carry the answer there.
    const remoteHost = deps.isLive(row.fromSessionId) ? undefined : row.fromHost
    if (!deps.isLive(row.fromSessionId) && !(remoteHost && deps.relay)) {
      return needsServer(`The asking session (${row.fromSessionId.slice(0, 8)}) is not running on this host; routing the answer`)
    }
    const denied = admitWrite(callerSid) ?? roomFor(home)
    if (denied) return denied
    const slice = slices.get(home)!
    const wrapped = kit.buildReplyDeliveryText(row, {
      title: me.title, shortId: callerSid.slice(0, 8), host: slice.host, sessionId: callerSid, taskId: me.taskId,
    }, text, { title: typeof args.title === 'string' ? args.title : undefined })
    const mid = messageId(args.messageId)
    const delivered = remoteHost
      ? await deps.relay!(home, { toHost: remoteHost, toSid: row.fromSessionId, text: wrapped, messageId: mid, requestId: id, reply: true, fromSessionId: callerSid })
      : await deps.deliver(row.fromSessionId, wrapped, mid)
    if (!delivered.ok) {
      if (remoteHost) return needsServer(`The asking session runs on ${remoteHost} and the answer could not be routed there (${delivered.reason}); answering it`)
      return fail('internal', `delivery to the asking session failed: ${delivered.reason}`)
    }
    if (own) {
      if (own.status === 'pending') {
        own.status = 'replied'
        own.settledAt = new Date(deps.now()).toISOString()
        append(home, { kind: 'row', row: { ...own } })
      }
    } else if (!journalOf(home).settledCopies.includes(id)) {
      journalOf(home).settledCopies.push(id)
      append(home, { kind: 'settle', requestId: id, status: 'replied' })
    }
    // The host that wrote the text into the asker's session journals the delivery.
    if (!remoteHost) append(home, { kind: 'delivery', fromSessionId: callerSid, toSessionId: row.fromSessionId, messageId: mid, requestId: id, reply: true })
    deps.log('info', 'offline host: reply delivered', { home, requestId: id, from: callerSid, to: row.fromSessionId, viaLeader: !!remoteHost })
    return ok({
      delivery: 'queued', offline: true, targetSessionId: row.fromSessionId, repliedTo: id, messageId: mid,
      outcome: remoteHost
        ? `Reply delivered to the asking session on ${remoteHost} through the cloud companion, which leads while the Walnut server is away.`
        : `Reply delivered on this host to the asking session. ${offlineNote(home)}`,
      next: 'Nothing else is required.',
    })
  }

  function resolveSendTarget(home: string, to: string): { sid?: string; taskId?: string; title?: string; error?: GatewayResult } {
    const slice = slices.get(home)!
    const { task, error } = resolveTask(home, to)
    if (error) return { error }
    if (task) {
      const live = slice.sessions.filter((s) => s.taskId === task.id && deps.isLive(s.sid))
      if (live.length === 0) {
        return { error: needsServer(`Task ${task.id} has no session running on this host; starting one`) }
      }
      return { sid: live[0].sid, taskId: task.id, title: live[0].title ?? task.title }
    }
    const ref = to.trim()
    const byId = slice.sessions.filter((s) => s.sid === ref || (ref.length >= 8 && s.sid.startsWith(ref)))
    if (byId.length === 1) {
      if (!deps.isLive(byId[0].sid)) return { error: needsServer(`Session ${ref} is not running on this host; resuming it`) }
      return { sid: byId[0].sid, taskId: byId[0].taskId, title: byId[0].title }
    }
    return { error: needsServer(`"${ref}" is not a session of this Walnut on this host; messages to other hosts`) }
  }

  async function opTaskSend(home: string, callerSid: string, args: Record<string, unknown>): Promise<GatewayResult> {
    const text = typeof args.text === 'string' ? args.text.trim() : ''
    if (!text) return fail('bad_request', 'text must be a non-empty string')
    if (args.in_reply_to !== undefined) {
      if (typeof args.in_reply_to !== 'string' || !/^rq-[a-f0-9]{6,}$/.test(args.in_reply_to)) return fail('bad_request', 'in_reply_to must be an rq-… id')
      return opReply(home, callerSid, args, text)
    }
    if (typeof args.to !== 'string' || !args.to.trim()) return fail('bad_request', '`to` is required (or pass in_reply_to)')
    // Before the session lookup: a completed parent usually has nothing running.
    const closed = parentCompleteRefusal(home, callerSid, resolveTask(home, args.to).task?.id)
    if (closed) return closed
    const target = resolveSendTarget(home, args.to)
    if (target.error) return target.error
    const closedTarget = parentCompleteRefusal(home, callerSid, target.taskId)
    if (closedTarget) return closedTarget
    const targetSid = target.sid!
    if (targetSid === callerSid) return fail('self_send', 'target resolves to the calling session itself')
    const denied = admitWrite(callerSid) ?? roomFor(home)
    if (denied) return denied
    const slice = slices.get(home)!
    const me = callerIdentity(home, callerSid)
    // Same default as the server: a session asking another session wants the answer.
    let row: OfflineRequestRow | undefined
    if (args.expect_reply !== false) {
      const implicit = args.expect_reply === undefined
      row = {
        id: `rq-${deps.randomHex(6)}`,
        fromSessionId: callerSid,
        toSessionId: targetSid,
        ...(target.taskId ? { toTaskId: target.taskId } : {}),
        preview: kit.requestPreview(text),
        status: 'pending',
        createdAt: new Date(deps.now()).toISOString(),
        deadlineAt: deps.now() + clampSecs(args.reply_timeout, implicit) * 1000,
        // Written mid-turn, the CLI may take the message into the running turn or
        // queue it for the next: only the NEXT turn end proves it went unanswered.
        ...(deps.turnActive(targetSid) ? { skipTurnEnds: 1 } : {}),
      }
      // Taken BEFORE the write: the tailer may still be catching up on older
      // lines (a startup result, a finished turn) while the delivery is in
      // flight, and none of those answers this message.
      const offset = deps.streamOffset(targetSid)
      if (typeof offset === 'number') row.afterV = offset
    }
    let envelope = kit.buildPeerWrapper(text, {
      title: me.title, shortId: callerSid.slice(0, 8), sessionId: callerSid, taskId: me.taskId,
      host: slice.host, ...(row ? { requestId: row.id } : {}),
    }, { title: typeof args.title === 'string' ? args.title : undefined })
    if (row) envelope = `${envelope}\n${kit.buildReplyTrailer(row)}`
    const mid = messageId(args.messageId)
    // The row exists before the envelope that names it can be read.
    if (row) journalOf(home).rows[row.id] = row
    const delivered = await deps.deliver(targetSid, envelope, mid)
    if (!delivered.ok) {
      if (row) { delete journalOf(home).rows[row.id]; persistJournal(home) }
      return fail('internal', `delivery failed: ${delivered.reason}`)
    }
    if (row) append(home, { kind: 'row', row: { ...row } })
    append(home, { kind: 'delivery', fromSessionId: callerSid, toSessionId: targetSid, ...(target.taskId ? { toTaskId: target.taskId } : {}), messageId: mid, ...(row ? { requestId: row.id } : {}) })
    deps.log('info', 'offline host: message delivered', { home, from: callerSid, to: targetSid, requestId: row?.id, messageId: mid })
    return ok({
      delivery: 'queued', offline: true, targetSessionId: targetSid, targetTitle: target.title ?? null,
      ...(target.taskId ? { targetTaskId: target.taskId } : {}),
      ...(row ? { requestId: row.id } : {}), messageId: mid,
      outcome: `Message delivered on this host to ${target.taskId ?? targetSid}. ${offlineNote(home)} Do NOT resend.`,
      next: row
        ? `You asked for a reply (${row.id}). Its reply arrives in your session on its own; do not poll.`
        : 'Its reply arrives in your session on its own; do not poll.',
    })
  }

  // ── same-host messages while the server answers (handleLocal) ──
  //
  // A message between two sessions of this Walnut on this host is this host's
  // to deliver, whether or not the server answers: the server's send ends in
  // this daemon's FIFO write anyway, after a round trip to wherever the server
  // runs. Delivered here, journaled (`online`), and the server is nudged; it
  // drains within moments and owns the request row from then on, as it does
  // after any handover. Only the plain case is taken here, judged on facts this
  // host has: anything it cannot be sure of (a name it resolves differently from
  // the server, a target or asker that is not running here, a target waiting on
  // a permission prompt, a completed parent) is left to the server, unchanged.

  const LOCAL_SEND_OPS = ['task_send', 'session_send']
  const PEER_SEND_WINDOW_MS = 60_000
  const PEER_SEND_MAX = 10
  const PEER_DUP_WINDOW_MS = 300_000
  /** Per-sender send times, and (sender, target, text) → last send: the server's own peer throttle rules. */
  const peerSends = new Map<string, number[]>()
  const peerDups = new Map<string, number>()

  function admitPeerSend(sender: string, target: string, text: string): GatewayResult | null {
    const now = deps.now()
    const recent = (peerSends.get(sender) ?? []).filter((t) => now - t < PEER_SEND_WINDOW_MS)
    if (recent.length >= PEER_SEND_MAX) {
      peerSends.set(sender, recent)
      return fail('throttled', 'peer send throttled: do not retry in a loop', { retryAfterMs: Math.max(1, recent[0] + PEER_SEND_WINDOW_MS - now) })
    }
    const dupKey = `${sender}|${target}|${deps.keyOf(text)}`
    const last = peerDups.get(dupKey)
    if (last !== undefined && now - last < PEER_DUP_WINDOW_MS) {
      return fail('throttled', 'the same message was just sent to this session: do not resend', { retryAfterMs: Math.max(1, last + PEER_DUP_WINDOW_MS - now) })
    }
    recent.push(now)
    peerSends.set(sender, recent)
    peerDups.set(dupKey, now)
    for (const [k, at] of peerDups) if (now - at >= PEER_DUP_WINDOW_MS) peerDups.delete(k)
    return null
  }

  /**
   * `to` as this host can name it without doubt: an exact task id, an exact
   * session id, a session id prefix of 8 or more, or a printed `Title [8hex]`
   * handle. A task prefix or a title is the server's to resolve: it sees every
   * task, this copy only some, and a prefix unique here may not be unique there.
   */
  function localTarget(home: string, to: string): { sid: string; taskId?: string; title?: string } | null {
    const slice = slices.get(home)!
    const ref = to.trim()
    const task = tasksWithOverlay(home).find((t) => t.id === ref)
    if (task) {
      const live = slice.sessions.filter((s) => s.taskId === task.id && deps.isLive(s.sid))
      // The server picks the task's current session; with two live, leave it the choice.
      if (live.length !== 1 || live[0].aside) return null
      return { sid: live[0].sid, taskId: task.id, title: live[0].title ?? task.title }
    }
    const printed = /\[([0-9a-f][0-9a-f-]{7,})\]\s*$/i.exec(ref)?.[1]
    const key = (printed ?? ref).toLowerCase()
    if (key.length < 8 || !/^[0-9a-f-]+$/.test(key)) return null
    const hits = slice.sessions.filter((s) => s.sid.toLowerCase() === key || s.sid.toLowerCase().startsWith(key))
    if (hits.length !== 1 || hits[0].aside || !deps.isLive(hits[0].sid)) return null
    // An older session of a task that runs another one here too: the server
    // knows which one the task continues in.
    const taskId = hits[0].taskId
    if (taskId && slice.sessions.filter((s) => s.taskId === taskId && deps.isLive(s.sid)).length !== 1) return null
    return { sid: hits[0].sid, taskId, title: hits[0].title }
  }

  /** The server's answer shape (session-send-core.ts SessionSendResult), with the op's outcome lines. */
  function sentResult(
    home: string,
    to: { sid: string; taskId?: string; title?: string },
    extra: { requestId?: string; repliedTo?: string; messageId: string },
  ): GatewayResult {
    const replyHint = 'Its reply arrives in your session on its own; do not poll. '
      + 'Only if you cannot continue without it: walnut wait <task-id | rq-id>.'
    return ok({
      delivery: 'queued', via: 'host', host: slices.get(home)?.host ?? null,
      targetSessionId: to.sid, targetTitle: to.title ?? null,
      ...(to.taskId ? { targetTaskId: to.taskId } : {}),
      target: { handle: kit.sessionHandle(to.title, to.sid), sessionId: to.sid, ...(to.taskId ? { taskId: to.taskId } : {}) },
      ...(extra.requestId ? { requestId: extra.requestId } : {}),
      ...(extra.repliedTo ? { repliedTo: extra.repliedTo } : {}),
      messageId: extra.messageId,
      outcome: extra.repliedTo
        ? `Reply delivered on this host to the asking session (${to.taskId ?? to.sid}). Do NOT resend.`
        : `Message delivered on this host to ${to.taskId ?? to.sid}. Accepted for delivery, not a completed reply. Do NOT resend.`,
      next: extra.repliedTo ? 'Nothing else is required.'
        : extra.requestId ? `You asked for a reply (${extra.requestId}). ${replyHint}` : replyHint,
    })
  }

  async function localSend(home: string, callerSid: string, args: Record<string, unknown>, text: string, mid: string): Promise<GatewayResult | null> {
    if (typeof args.to !== 'string' || !args.to.trim()) return null
    const target = localTarget(home, args.to)
    if (!target || target.sid === callerSid) return null
    if (deps.pendingPrompt!(target.sid)) return null
    if (parentCompleteRefusal(home, callerSid, target.taskId)) return null
    const denied = admitPeerSend(callerSid, target.sid, text) ?? roomFor(home)
    if (denied) return denied
    const slice = slices.get(home)!
    const me = callerIdentity(home, callerSid)
    let row: OfflineRequestRow | undefined
    if (args.expect_reply !== false) {
      const implicit = args.expect_reply === undefined
      row = {
        id: `rq-${deps.randomHex(6)}`,
        fromSessionId: callerSid,
        toSessionId: target.sid,
        ...(target.taskId ? { toTaskId: target.taskId } : {}),
        preview: kit.requestPreview(text),
        status: 'pending',
        createdAt: new Date(deps.now()).toISOString(),
        deadlineAt: deps.now() + clampSecs(args.reply_timeout, implicit) * 1000,
        ...(deps.turnActive(target.sid) ? { skipTurnEnds: 1 } : {}),
        online: true,
      }
      const offset = deps.streamOffset(target.sid)
      if (typeof offset === 'number') row.afterV = offset
    }
    let envelope = kit.buildPeerWrapper(text, {
      title: me.title, shortId: callerSid.slice(0, 8), sessionId: callerSid, taskId: me.taskId,
      host: slice.host, ...(row ? { requestId: row.id } : {}),
    }, { title: typeof args.title === 'string' ? args.title : undefined })
    if (row) envelope = `${envelope}\n${kit.buildReplyTrailer(row)}`
    if (row) journalOf(home).rows[row.id] = row
    const delivered = await deps.deliver(target.sid, envelope, mid)
    if (!delivered.ok) {
      // Nothing was written: the server may still reach it (it resumes a stopped CLI).
      if (row) { delete journalOf(home).rows[row.id]; persistJournal(home) }
      return null
    }
    if (row) append(home, { kind: 'row', row: { ...row } }, true)
    append(home, { kind: 'delivery', fromSessionId: callerSid, toSessionId: target.sid, ...(target.taskId ? { toTaskId: target.taskId } : {}), messageId: mid, ...(row ? { requestId: row.id } : {}) }, true)
    deps.log('info', 'host: message delivered on this host', { home, from: callerSid, to: target.sid, requestId: row?.id, messageId: mid })
    return sentResult(home, target, { requestId: row?.id, messageId: mid })
  }

  async function localReply(home: string, callerSid: string, args: Record<string, unknown>, text: string, mid: string): Promise<GatewayResult | null> {
    const id = typeof args.in_reply_to === 'string' ? args.in_reply_to : ''
    if (!/^rq-[a-f0-9]{6,}$/.test(id)) return null
    const { own, copy } = findRequest(home, id)
    const row = own ?? copy
    // A copy this host already answered once: a second answer is the server's (it says "late").
    if (!row || (!own && journalOf(home).settledCopies.includes(id))) return null
    const me = callerIdentity(home, callerSid)
    const isTarget = row.toSessionId === callerSid || (!!row.toTaskId && row.toTaskId === me.taskId)
    if (!isTarget) return null
    const asker = row.fromSessionId
    // The server's first rung (reply-routing.ts): a live asker is its own address.
    if (asker === callerSid || !deps.isLive(asker) || deps.pendingPrompt!(asker)) return null
    const askerRow = sessionOf(home, asker)
    if (!askerRow || askerRow.aside) return null
    if (parentCompleteRefusal(home, callerSid, askerRow?.taskId)) return null
    const denied = roomFor(home)
    if (denied) return denied
    const slice = slices.get(home)!
    const wrapped = kit.buildReplyDeliveryText(row, {
      title: me.title, shortId: callerSid.slice(0, 8), host: slice.host, sessionId: callerSid, taskId: me.taskId,
    }, text, { title: typeof args.title === 'string' ? args.title : undefined })
    const delivered = await deps.deliver(asker, wrapped, mid)
    if (!delivered.ok) return null
    if (own) {
      if (own.status === 'pending') {
        own.status = 'replied'
        own.settledAt = new Date(deps.now()).toISOString()
        append(home, { kind: 'row', row: { ...own } }, true)
      }
    } else {
      journalOf(home).settledCopies.push(id)
      append(home, { kind: 'settle', requestId: id, status: 'replied' }, true)
    }
    append(home, { kind: 'delivery', fromSessionId: callerSid, toSessionId: asker, messageId: mid, requestId: id, reply: true }, true)
    deps.log('info', 'host: reply delivered on this host', { home, requestId: id, from: callerSid, to: asker, messageId: mid })
    return sentResult(home, { sid: asker, taskId: askerRow?.taskId, title: askerRow?.title }, { repliedTo: id, messageId: mid })
  }

  /**
   * A call the server would answer, that this host answers itself: a message
   * between two of this Walnut's sessions running here. Null = not this host's
   * to take; the caller relays the payload, which then carries the message id
   * this host picked, so a delivery the server makes again is written once.
   */
  async function handleLocal(home: string, callerSid: string, capability: string, payload: Record<string, unknown>): Promise<GatewayResult | null> {
    if (!deps.pendingPrompt || capability !== 'tools.call') return null
    const name = typeof payload.name === 'string' ? payload.name : ''
    if (LOCAL_SEND_OPS.indexOf(name) === -1 || typeof payload.argsFile === 'string') return null
    if (!slices.has(home) || !sessionOf(home, callerSid)) return null
    const args = (payload.args && typeof payload.args === 'object' && !Array.isArray(payload.args) ? payload.args : {}) as Record<string, unknown>
    const text = typeof args.text === 'string' ? args.text.trim() : ''
    if (!text) return null
    if (typeof args.messageId !== 'string' || !/^qm-[A-Za-z0-9-]{1,64}$/.test(args.messageId)) {
      payload.args = { ...args, messageId: `qm-host-${deps.randomHex(8)}` }
    }
    const mid = String((payload.args as Record<string, unknown>).messageId)
    try {
      return args.in_reply_to !== undefined
        ? await localReply(home, callerSid, args, text, mid)
        : await localSend(home, callerSid, args, text, mid)
    } catch (err) {
      deps.log('warn', 'host: same-host delivery failed, leaving it to the server', { home, error: (err as Error).message })
      return null
    }
  }

  function opQueued(home: string, callerSid: string, name: string, args: Record<string, unknown>): GatewayResult {
    const ref = typeof args.id === 'string' ? args.id : ''
    if (!ref) return fail('bad_request', `${name} needs "id"`)
    const { task, error } = resolveTask(home, ref)
    if (error) return error
    if (!task) return needsServer(`Task ${ref} is not in this host's offline copy; changing it`)
    let size = 0
    try { size = JSON.stringify(args).length } catch { return fail('bad_request', 'arguments are not JSON') }
    if (size > MAX_ARGS_BYTES) return fail('bad_request', `arguments are too large to queue offline (${size} bytes, limit ${MAX_ARGS_BYTES})`)
    const denied = admitWrite(callerSid) ?? roomFor(home)
    if (denied) return denied
    const base = slices.get(home)?.tasks.find((t) => t.id === task.id)?.updated_at
    append(home, { kind: 'op', op: name, args: { ...args, id: task.id }, callerSid, ...(base ? { base } : {}) })
    deps.log('info', 'offline host: write queued', { home, op: name, taskId: task.id, callerSid })
    return ok({
      queued: true, offline: true, id: task.id,
      outcome: `Saved on this host; Walnut applies this ${name} when the server reconnects (a newer change made elsewhere wins).`,
      next: 'Nothing else is required. Do not repeat the call.',
    })
  }

  // ── the Board copy (offline-board-core.ts) ──

  /** The board a call is about: the task it names, else the caller's team board. */
  function boardIdFor(home: string, callerSid: string, given: unknown): string | undefined {
    const slice = slices.get(home)
    if (!slice) return undefined
    const boards = slice.boards ?? []
    if (typeof given === 'string' && given.trim()) {
      const ref = given.trim()
      const exact = boards.find((b) => b.taskId === ref)
      if (exact) return exact.taskId
      const task = resolveTask(home, ref).task
      return task && (boards.some((b) => b.taskId === task.id) || slice.boardOf?.[task.id] === task.id) ? task.id : undefined
    }
    const own = callerIdentity(home, callerSid).taskId
    return own ? slice.boardOf?.[own] : undefined
  }

  /** The board as this host sees it: the copy, then every write made here since. */
  function boardWithOverlay(home: string, boardId: string): OfflineSliceBoard | undefined {
    const kit = deps.boards!
    let board = (slices.get(home)?.boards ?? []).find((b) => b.taskId === boardId)
    for (const r of journals.get(home)?.records ?? []) {
      if (r.kind !== 'op' || kit.WRITE_OPS.indexOf(r.op) === -1 || r.args.task !== boardId) continue
      const by = `task:${callerIdentity(home, r.callerSid).taskId ?? ''}`
      board = kit.apply(board, r.op, r.args, by, new Date(r.at).toISOString(), boardId, () => `bm-offline-${r.seq}`)
    }
    return board
  }

  /** The board's task itself or a task below it, as the copy knows the tree. */
  function inTeam(home: string, boardId: string, taskId: string | undefined): boolean {
    const tasks = slices.get(home)?.tasks ?? []
    let cur = taskId
    for (let i = 0; cur && i < 12; i++) {
      if (cur === boardId) return true
      const at: string = cur
      cur = tasks.find((t) => t.id === at)?.parent_task_id
    }
    return false
  }

  function opBoard(home: string, callerSid: string, name: string, args: Record<string, unknown>): GatewayResult {
    const kit = deps.boards!
    const boardId = boardIdFor(home, callerSid, args.task)
    if (!boardId) return needsServer(`The Board of that task is not kept on this host; ${name === 'board_get' ? 'reading' : 'writing'} it`)
    const board = boardWithOverlay(home, boardId)
    if (name === 'board_get') {
      if (!board) {
        return ok({
          task_id: boardId, board: null, offline: true, as_of: asOf(home),
          outcome: `Task ${boardId} has no board yet (this host's copy). ${offlineNote(home)}`,
          next: 'Make one with board_set; it is applied here now and reaches Walnut when the server reconnects.',
        })
      }
      return ok({
        task_id: boardId,
        board: { html: board.html, version: board.version, updated_at: board.updated_at, updated_by: board.updated_by },
        threads: board.threads ?? {}, marks: board.marks ?? {}, projects: board.projects ?? {}, choices: board.choices ?? {},
        offline: true, as_of: asOf(home),
        outcome: `Board of ${boardId} (this host's copy, with the writes made here): version ${board.version}, ${board.html.length} chars of html. ${offlineNote(home)}`,
        next: 'Keep it current with board_edit; a write is applied here now and reaches Walnut when the server reconnects.',
      })
    }
    const me = callerIdentity(home, callerSid)
    if (!inTeam(home, boardId, me.taskId)) {
      return fail('not_in_team', 'Only the board task\'s own session or its subtasks\' sessions may write this board')
    }
    const prepared = kit.prepare(board, name, args, `task:${me.taskId}`)
    if (!prepared.ok) return fail(prepared.code, prepared.message, prepared.detail !== undefined ? { detail: prepared.detail } : undefined)
    const denied = admitWrite(callerSid) ?? roomFor(home)
    if (denied) return denied
    append(home, { kind: 'op', op: name, args: { ...prepared.args, task: boardId }, callerSid })
    const after = boardWithOverlay(home, boardId)
    deps.log('info', 'offline host: board write queued', { home, op: name, boardId, callerSid })
    return ok({
      queued: true, offline: true, task_id: boardId, ...(after ? { version: after.version } : {}),
      outcome: `Applied to this host's copy of the Board of ${boardId}${after ? ` (now version ${after.version})` : ''}; Walnut applies it when the server reconnects, and its own checks decide again.`,
      next: 'Nothing else is required. Do not repeat the call.',
    })
  }

  /** One gateway request for a Walnut that is away. Never throws. */
  async function handle(home: string, callerSid: string, capability: string, payload: Record<string, unknown>): Promise<GatewayResult> {
    try {
      if (capability === 'tools.list') {
        const wanted = typeof payload.name === 'string' ? payload.name : ''
        const ops = OFFLINE_OPS.concat(deps.replica ? deps.replica.ops(home) : []).filter((o) => !wanted || o.name === wanted)
        return ok({ ops: ops.map((o) => ({ ...o, remote: 'allow' })), offline: true, hint: offlineNote(home) })
      }
      if (capability !== 'tools.call') return needsServer(`"${capability}"`)
      const name = typeof payload.name === 'string' ? payload.name : ''
      const args = (payload.args && typeof payload.args === 'object' && !Array.isArray(payload.args) ? payload.args : {}) as Record<string, unknown>
      if (typeof payload.argsFile === 'string') return needsServer('A call whose arguments ride in a file')
      switch (name) {
        case 'task_get': return opTaskGet(home, args)
        case 'task_list': return opTaskList(home, args)
        case 'session_list': return opSessionList(home)
        case 'request_get': return opRequestGet(home, args)
        case 'task_send': case 'session_send': return await opTaskSend(home, callerSid, args)
        case 'open_items': if (deps.openItems) return opOpenItems(home, callerSid, args); return needsServer('"open_items"')
        default: {
          const fromCopy = deps.replica ? deps.replica.answer(home, name, args, offlineNote(home)) : null
          if (fromCopy) return fromCopy
          if (deps.boards && deps.boards.BOARD_OPS.indexOf(name) !== -1) return opBoard(home, callerSid, name, args)
          if (QUEUED_OPS.includes(name)) return opQueued(home, callerSid, name, args)
          return needsServer(name ? `"${name}"` : 'That call')
        }
      }
    } catch (err) {
      deps.log('error', 'offline host: request failed', { home, capability, error: (err as Error).message })
      return fail('internal', `offline host error: ${(err as Error).message}`)
    }
  }

  // ── turn ends and deadlines: the fallback notice for rows this host owns ──

  async function notify(home: string, row: OfflineRequestRow, outcome: EnvelopeOutcome, lastText?: string): Promise<void> {
    // As on the server: no Walnut notice into a COMPLETE asker's session. Withdrawn
    // (nobody was told), so the server restores it if that task is reopened.
    const askerTask = sessionOf(home, row.fromSessionId)?.taskId
    if (askerTask && tasksWithOverlay(home).find((t) => t.id === askerTask)?.phase === 'COMPLETE') {
      row.status = 'withdrawn'
      row.settledAt = new Date(deps.now()).toISOString()
      append(home, { kind: 'row', row: { ...row } })
      deps.log('info', 'offline host: asker task is complete, request withdrawn', { home, requestId: row.id })
      return
    }
    row.status = outcome === 'timeout' ? 'expired' : 'notified'
    row.outcome = outcome
    row.settledAt = new Date(deps.now()).toISOString()
    append(home, { kind: 'row', row: { ...row } })
    const remoteHost = deps.isLive(row.fromSessionId) ? undefined : row.fromHost
    if (!deps.isLive(row.fromSessionId) && !(remoteHost && deps.relay)) {
      deps.log('info', 'offline host: asker not running, notice skipped', { home, requestId: row.id })
      return
    }
    const target = sessionOf(home, row.toSessionId)
    const task = row.toTaskId ? tasksWithOverlay(home).find((t) => t.id === row.toTaskId) : undefined
    const text = kit.buildRequestNotification(row, outcome, {
      title: target?.title ?? task?.title,
      sessionId: row.toSessionId,
      taskId: row.toTaskId,
      phase: task?.phase,
      lastMessage: lastText ? kit.clipNoticeMessage(lastText) : undefined,
    })
    const mid = `qm-offline-${deps.randomHex(8)}`
    const delivered = remoteHost
      ? await deps.relay!(home, { toHost: remoteHost, toSid: row.fromSessionId, text, messageId: mid, requestId: row.id, fromSessionId: row.toSessionId })
      : await deps.deliver(row.fromSessionId, text, mid)
    if (delivered.ok && !remoteHost) append(home, { kind: 'delivery', fromSessionId: row.toSessionId, toSessionId: row.fromSessionId, messageId: mid, requestId: row.id })
    deps.log(delivered.ok ? 'info' : 'warn', 'offline host: notice', { home, requestId: row.id, outcome, delivered: delivered.ok, viaLeader: !!remoteHost })
  }

  /**
   * A `result` line on `sid`'s stream at offset `v`: the rows it owed an answer
   * settle as "finished without replying". Lines at or before the delivery (a
   * stream re-read after a daemon restart replays old turns) never count.
   */
  async function onResult(sid: string, line: string, v?: number): Promise<void> {
    for (const [home, j] of journals) {
      for (const row of Object.values(j.rows)) {
        if (row.status !== 'pending' || row.toSessionId !== sid || isHandingOver(row.id)) continue
        if (typeof v === 'number') {
          if (typeof row.afterV === 'number' && v <= row.afterV) continue
          if (typeof row.lastResultV === 'number' && v <= row.lastResultV) continue
          row.lastResultV = v
        }
        if (row.skipTurnEnds && row.skipTurnEnds > 0) {
          row.skipTurnEnds -= 1
          persistJournal(home)
          continue
        }
        // One voice: the server that answers says it, from its own copy of the row.
        if (row.online && deps.serverAnswers?.(home)) continue
        let parsed: { result?: unknown; is_error?: unknown } = {}
        try { parsed = JSON.parse(line) } catch { /* the outcome still stands */ }
        await notify(home, row, parsed.is_error === true ? 'error' : 'completed', typeof parsed.result === 'string' ? parsed.result : undefined)
      }
    }
  }

  /**
   * A trigger fire no server claimed, written into the target task's live
   * session on this host (the walnut-trigger daemon builds the envelope). The
   * same session pick the server makes for a live one: the newest live session
   * of the task, as this copy lists them. A COMPLETE task is the server's call
   * (it refuses and tells the user), so it is left to the server, as is a task
   * with no live session here (the server resumes or starts one). Nothing is
   * journaled: the fire's own queue tells the server, on its replay.
   */
  async function deliverTrigger(
    home: string,
    taskId: string,
    text: string,
    messageId: string,
  ): Promise<{ ok: true; sid: string } | { ok: false; reason: string }> {
    const slice = slices.get(home)
    if (!slice) return { ok: false, reason: 'no host copy for this Walnut' }
    const task = tasksWithOverlay(home).find((t) => t.id === taskId)
    if (task?.phase === 'COMPLETE') return { ok: false, reason: 'target task is complete' }
    const live = slice.sessions.filter((s) => s.taskId === taskId && deps.isLive(s.sid))
    if (live.length === 0) return { ok: false, reason: 'no live session of the target task on this host' }
    const sid = live[0].sid
    try {
      const delivered = await deps.deliver(sid, text, messageId)
      return delivered.ok ? { ok: true, sid } : { ok: false, reason: delivered.reason }
    } catch (err) {
      return { ok: false, reason: (err as Error).message }
    }
  }

  /**
   * A message the leader routes here while the primary is away
   * (`leader.deliver`, docs/plan/walnut-control-plane.md). A peer message from
   * a session on another host is delivered as task_send delivers it on one
   * host, and a reply request it opens is owned HERE, beside the session that
   * answers it: the answer and the "finished without replying" notice go back
   * through the leader. Text (a reply or a notice another host built) is
   * written as it is. Either way the delivery is journaled for the primary.
   */
  async function deliverFromLeader(home: string, d: LeaderDelivery): Promise<GatewayResult> {
    try {
      const slice = slices.get(home)
      if (!slice) return fail('not_found', 'this host holds no copy for that Walnut')
      if (d.kind === 'text') {
        if (typeof d.toSid !== 'string' || !sessionOf(home, d.toSid)) return fail('not_found', 'no session of that Walnut with that id on this host')
        if (typeof d.text !== 'string' || !d.text) return fail('bad_request', 'text must be a non-empty string')
        if (!deps.isLive(d.toSid)) return fail('not_running', `session ${d.toSid.slice(0, 8)} is not running on this host`)
        const denied = roomFor(home)
        if (denied) return denied
        const mid = messageId(d.messageId)
        const delivered = await deps.deliver(d.toSid, d.text, mid)
        if (!delivered.ok) return fail('internal', `delivery failed: ${delivered.reason}`)
        append(home, {
          kind: 'delivery', fromSessionId: typeof d.fromSessionId === 'string' ? d.fromSessionId : '', toSessionId: d.toSid,
          messageId: mid, ...(typeof d.requestId === 'string' ? { requestId: d.requestId } : {}), ...(d.reply === true ? { reply: true } : {}),
        })
        deps.log('info', 'offline host: leader delivered text', { home, to: d.toSid, requestId: d.requestId, messageId: mid })
        return ok({ delivered: true, targetSessionId: d.toSid, messageId: mid })
      }
      if (d.kind !== 'peer') return fail('bad_request', 'unknown delivery kind')
      const from = d.from
      if (!from || typeof from.sid !== 'string' || !from.sid || typeof from.host !== 'string' || !from.host) return fail('bad_request', 'from.sid and from.host are required')
      const text = typeof d.text === 'string' ? d.text.trim() : ''
      if (!text) return fail('bad_request', 'text must be a non-empty string')
      if (typeof d.to !== 'string' || !d.to.trim()) return fail('bad_request', '`to` is required')
      const fromTaskId = typeof from.taskId === 'string' ? from.taskId : undefined
      const closed = parentCompleteRefusalOf(home, fromTaskId, resolveTask(home, d.to).task?.id)
      if (closed) return closed
      const target = resolveSendTarget(home, d.to)
      if (target.error) return target.error
      const targetSid = target.sid!
      if (targetSid === from.sid) return fail('self_send', 'target resolves to the calling session itself')
      const denied = admitWrite(from.sid) ?? roomFor(home)
      if (denied) return denied
      let row: OfflineRequestRow | undefined
      if (d.expect_reply !== false) {
        const implicit = d.expect_reply === undefined
        row = {
          id: `rq-${deps.randomHex(6)}`,
          fromSessionId: from.sid,
          toSessionId: targetSid,
          ...(target.taskId ? { toTaskId: target.taskId } : {}),
          preview: kit.requestPreview(text),
          status: 'pending',
          createdAt: new Date(deps.now()).toISOString(),
          deadlineAt: deps.now() + clampSecs(d.reply_timeout, implicit) * 1000,
          fromHost: from.host,
          ...(deps.turnActive(targetSid) ? { skipTurnEnds: 1 } : {}),
        }
        const offset = deps.streamOffset(targetSid)
        if (typeof offset === 'number') row.afterV = offset
      }
      let envelope = kit.buildPeerWrapper(text, {
        title: typeof from.title === 'string' ? from.title : '', shortId: from.sid.slice(0, 8), sessionId: from.sid,
        taskId: fromTaskId, host: from.host, ...(row ? { requestId: row.id } : {}),
      }, { title: typeof d.title === 'string' ? d.title : undefined })
      if (row) envelope = `${envelope}\n${kit.buildReplyTrailer(row)}`
      const mid = messageId(d.messageId)
      if (row) journalOf(home).rows[row.id] = row
      const delivered = await deps.deliver(targetSid, envelope, mid)
      if (!delivered.ok) {
        if (row) { delete journalOf(home).rows[row.id]; persistJournal(home) }
        return fail('internal', `delivery failed: ${delivered.reason}`)
      }
      if (row) append(home, { kind: 'row', row: { ...row } })
      append(home, { kind: 'delivery', fromSessionId: from.sid, toSessionId: targetSid, ...(target.taskId ? { toTaskId: target.taskId } : {}), messageId: mid, ...(row ? { requestId: row.id } : {}) })
      deps.log('info', 'offline host: leader delivered a peer message', { home, from: from.sid, fromHost: from.host, to: targetSid, requestId: row?.id, messageId: mid })
      return ok({
        delivery: 'queued', targetSessionId: targetSid, targetTitle: target.title ?? null,
        ...(target.taskId ? { targetTaskId: target.taskId } : {}),
        ...(row ? { requestId: row.id } : {}), messageId: mid, targetHost: slice.host,
      })
    } catch (err) {
      deps.log('error', 'offline host: leader delivery failed', { home, error: (err as Error).message })
      return fail('internal', `offline host error: ${(err as Error).message}`)
    }
  }

  async function sweep(): Promise<number> {
    let n = 0
    const now = deps.now()
    for (const [home, j] of journals) {
      for (const row of Object.values(j.rows)) {
        if (row.status !== 'pending' || row.deadlineAt > now || isHandingOver(row.id)) continue
        if (row.online && deps.serverAnswers?.(home)) continue
        await notify(home, row, 'timeout'); n++
      }
    }
    return n
  }

  load()

  /** Who a caller is, as the copy names it, for a call the leader answers. */
  function callerOf(home: string, sid: string): { taskId?: string; title: string; host: string } {
    const me = callerIdentity(home, sid)
    return { ...(me.taskId ? { taskId: me.taskId } : {}), title: me.title, host: slices.get(home)?.host ?? '' }
  }

  /**
   * A read this host can answer for `home` from what it keeps, so a server that
   * does not answer can be skipped for it: a slice read, or a copy read of a kind
   * kept here (a note read on a host that keeps no notes still needs the server).
   */
  function answersRead(name: unknown, home: string): boolean {
    if (typeof name !== 'string') return false
    if (READ_OPS.indexOf(name) !== -1) return true
    return !!deps.replica && deps.replica.keeps(home, name)
  }

  /** Any record the server has not taken yet, made while it was away or not. */
  function hasRecords(home: string | undefined): boolean {
    return !!home && (journals.get(home)?.records.length ?? 0) > 0
  }

  return { configure, hasHome, ownerOf, pendingHandover, hasRecords, drain, ack, handle, handleLocal, onResult, sweep, deliverTrigger, deliverFromLeader, callerOf, answersRead, homes: () => [...slices.keys()] }
}

export type OfflineHost = ReturnType<typeof createOfflineHost>
