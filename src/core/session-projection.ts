/**
 * Session projection — a slim JSON snapshot of the session list, kept in the
 * NON-git projection cache (`cache/projections/sessions.json`) and PUSHED to
 * the cloud companion over the daemon bridge (see core/projection-cache.ts).
 * The session registry itself is machine-local and never leaves the box;
 * stream files are gitignored.
 *
 * Mirror of task-projection.ts:
 * Primary box: exportSessionProjection() rewrites the cache + pushes a
 * `projection-upsert` bridge frame when sessions change (debounced off
 * session:* bus events) and once at startup. While the config knob
 * `sync.legacy_projection_files` is true (default), it ALSO writes the
 * legacy git-tracked `sessions/projection.json` so a cloud box running
 * pre-cache code keeps working off git-sync.
 * Cloud box: the pushed frames land in the same cache paths (events-v1 →
 * projection-cache); readSessionProjection() serves GET /api/v1/sessions
 * from the cache (legacy git file as transition fallback) — the pushed
 * projection IS the replica.
 *
 * "Open a session" from the companion: alongside the list, the primary
 * exports a TRANSCRIPT TAIL per alive session to `cache/transcripts/<sid>.json`
 * (+ a `transcript-upsert` push; legacy `sessions/transcripts/` behind the
 * same knob). The primary is the machine that can reach every session's
 * JSONL — local ones on disk, remote ones over its SSH channel — so the
 * export IS the "proxy through the primary", materialized as cache files
 * instead of a live connection.
 *
 * STEERING a session (live): each host's daemon dials OUT to the cloud
 * companion (`/bridge`, see src/web/ws/bridge-registry.ts), so sends/streams
 * flow phone → cloud → daemon directly and keep working while the primary
 * sleeps. The primary remains the sole owner of session LIFECYCLE (spawn /
 * resume / reap / daemon deploys, and it pushes the bridge config) — the
 * bridge is a data plane, not a second controller. These cache exports stay
 * the fallback for hosts without a live bridge.
 *
 * Scope: all live sessions (running/idle/error) + sessions stopped within
 * STOPPED_RETENTION_DAYS. Environment sessions (triage/cron/hook/embedded
 * subagents), lane-bound sessions (records with `lane` set — they back a UI
 * conversation surface, not a listed session), and archived sessions are
 * excluded — same visibility rule as the web session tree.
 *
 * ⚠️ LATENCY CONTRACT — this projection is EVENTUALLY consistent, and every
 * consumer must design for the gap. With the bridge up, cloud freshness is
 * the export debounce/throttle (3s list / up to 60s transcripts) + one WS
 * frame — seconds, not minutes. With the bridge DOWN, the cloud keeps
 * serving its last-pushed cache (stale-but-usable, survives restarts) until
 * the link returns; the primary's 5-minute self-heal sweep re-pushes both
 * projections + alive-session transcripts after any outage, and while
 * `sync.legacy_projection_files` is on the git-synced copy (1–3 min) is the
 * fallback of last resort. 2026-08-07 incident (predates the push lane): the
 * cloud replica resolved JUST-LAUNCHED sessions exclusively from this
 * projection — the phone got 201 then a 404 storm on stream/transcript/send
 * for the whole gap. Rule of thumb still stands: if the replica ITSELF
 * performed the action, it must not wait for this projection to learn the
 * result — that's what src/core/sessions/launch-seed.ts is for (TTL'd
 * write-through cache of the replica's own launches; projection wins the
 * moment it lands). Do NOT "fix" staleness by cranking any sync/poll
 * frequency: the 2026-08-06 CPU storm on the 2-vCPU hub box came from
 * exactly that pressure — push, don't poll.
 */

import fsp from 'node:fs/promises'
import path from 'node:path'
import { WALNUT_HOME } from '../constants.js'
import { writeJsonFile } from '../utils/fs.js'
import { bus } from './event-bus.js'
import { log } from '../logging/index.js'
import {
  legacyProjectionFilesEnabled,
  pickFresherEnvelope,
  PROJECTION_PUSH_MAX_BYTES,
  pushProjectionToCloud,
  readProjectionCache,
  readTranscriptCache,
  writeProjectionCache,
  writeTranscriptCache,
} from './projection-cache.js'
import type { SessionRecord, Task } from './types.js'
import { engineCaps } from './agents/engine-registry.js'

/** LEGACY git-synced paths — dual-written while `sync.legacy_projection_files`
 *  is on (see projection-cache.ts); the cache/ paths are the live copies. */
export const SESSION_PROJECTION_FILE = path.join(WALNUT_HOME, 'sessions', 'projection.json')
export const SESSION_TRANSCRIPTS_DIR = path.join(WALNUT_HOME, 'sessions', 'transcripts')

/**
 * Retention window for TERMINAL sessions. Applies to `error` as well as
 * `stopped`: an errored session is just as dead, but it used to fall through the
 * `stopped`-only gate into the eligible set forever — a slow unbounded leak that
 * would eventually eat the budget with rows from years ago (25 error rows in the
 * store today, 2 of them listable, all currently inside the window, so closing
 * this changes nothing now and cannot grow later).
 */
const STOPPED_RETENTION_DAYS = 14
/** Terminal statuses the retention window applies to. */
const TERMINAL_STATUSES = new Set(['stopped', 'error'])
const DEBOUNCE_MS = 3_000
const DESCRIPTION_MAX = 300
/**
 * Row budget — a payload-safety backstop, NOT the visibility rule. The
 * visibility rule is STOPPED_RETENTION_DAYS, and the budget must be big enough
 * that the documented window actually fits, otherwise the budget silently
 * BECOMES the rule. At 500 it did: 962 retention-eligible sessions on a real
 * box meant 462 in-window rows were dropped and the effective window shrank to
 * 8.1 days. 88 of those dropped rows were SESSIONS owned by a pinned task, and
 * they were the only session row for 86 distinct pinned board tasks — the phone
 * (GET /api/v1/sessions, no paging) then re-routed those 86 task rows into a New
 * Session draft. 1500 is measured headroom over today's 962, not a
 * guess, and it is the budget that normally binds: at the measured ~645B/row it
 * is ~967KB, comfortably inside the byte ceiling below.
 */
const MAX_SESSIONS = 1_500
/**
 * Byte ceiling — the backstop the row cap cannot provide, because titles/cwd
 * have no clip and one fat row is unbounded. This list rides ONE bridge frame
 * and pushProjectionToCloud SKIPS an oversized payload rather than erroring, so
 * the cloud replica would freeze on its last copy forever (which is exactly what
 * the task projection did at 1.15MB). 80% of the LIST-lane frame budget, so the
 * builder always discovers the ceiling before the wire does, and so this never
 * sits below MAX_SESSIONS' own worst case (~967KB) — two budgets that contradict
 * each other make the documented row cap unreachable.
 * Measured on real data: 962 rows = 620KB, ~645B/row.
 */
const PROJECTION_BYTE_BUDGET = Math.floor(PROJECTION_PUSH_MAX_BYTES * 0.8)
/** Transcript tail shipped per session (slim rows, not full JSONL). */
const TRANSCRIPT_TAIL = 100
/** Min gap between transcript export sweeps (remote reads go over SSH). */
const TRANSCRIPT_THROTTLE_MS = 60_000

/** Slim session shape shipped to the companion — frozen v1 contract (additive-only). */
export interface ProjectedSession {
  id: string
  title?: string
  /** Owning task (sessions are normally spawned from a task). */
  task_id?: string
  task_title?: string
  project?: string
  /** '' = the primary box itself; otherwise the remote host alias. */
  host: string
  process_status: string
  model?: string
  mode?: string
  started_at: string
  last_active_at: string
  message_count: number
  cwd?: string
  /** Derived from the owning task's pin state at export time. */
  pinned?: boolean
  focus_tier?: string
  /** First 300 chars — enough for a list preview. */
  description?: string
}

export interface SessionProjection {
  version: 1
  exportedAt: string
  sessions: ProjectedSession[]
  /**
   * Set (additive, omitted when false) when a budget dropped eligible rows.
   * No consumer infers deletion from absence here TODAY — unlike the task
   * projection, whose replica importer does exactly that and would have deleted
   * the dropped rows (see TaskProjection.truncated). This is deliberate
   * headroom: the ONLY thing standing between this list and that same class of
   * bug is that nobody has written the reconcile pass yet, and the ceiling is
   * just 1.56x above today's payload. A consumer that starts treating absence
   * as meaningful must check this flag first.
   */
  truncated?: true
}

/** Exported: the mobile events feed (events-v1) maps single rows with it. */
export function projectSession(s: SessionRecord, task: Task | undefined): ProjectedSession {
  const description = (s.description || '').trim()
  return {
    id: s.claudeSessionId,
    ...(s.title ? { title: s.title } : {}),
    ...(s.taskId ? { task_id: s.taskId } : {}),
    ...(task?.title ? { task_title: task.title } : {}),
    ...(s.project || task?.project ? { project: s.project || task?.project } : {}),
    host: s.host ?? '',
    process_status: s.process_status,
    ...(s.model ? { model: s.model } : {}),
    ...(s.mode ? { mode: s.mode } : {}),
    started_at: s.startedAt,
    last_active_at: s.lastActiveAt,
    message_count: s.messageCount ?? 0,
    ...(s.cwd ? { cwd: s.cwd } : {}),
    ...(task?.pinned ? { pinned: true } : {}),
    ...(task?.pinned && task?.focus_tier ? { focus_tier: task.focus_tier } : {}),
    ...(description
      ? { description: description.length > DESCRIPTION_MAX ? description.slice(0, DESCRIPTION_MAX) + '…' : description }
      : {}),
  }
}

/**
 * Build the projection in memory (primary box). Shared by the file export
 * below and the mobile events feed's snapshot frame (events-v1), which needs
 * the same rows without paying a disk round trip. This function is the ONLY
 * writer of the session projection's contents — see the single-writer note at
 * GET /api/v1/sessions (src/web/routes/api-v1.ts) before adding a second one.
 *
 * Selection is an ORDER, not a slice. It used to be `sort by recency → take
 * 500`, which quietly made the budget the visibility rule and evicted pinned
 * board tasks' only session row (see MAX_SESSIONS). Now the eligible set is
 * filled in priority order: sessions owned by a PINNED task first (those rows
 * are what the phone's board needs to route a tap into the existing session
 * rather than a New Session draft), then everything else newest-first. Output
 * order stays recency-descending, as before.
 *
 * That ordered fill is only paid when a budget can ACTUALLY bite. This runs
 * inline per request on routes the phone polls (GET /api/v1/sessions,
 * session-extras-v1, and the events-v1 SSE snapshot on every connect), so the
 * common answer — "everything fits" — takes one row count check and ONE
 * whole-array measurement, not a per-row serialize plus two extra sorts.
 */
export async function buildSessionProjection(): Promise<SessionProjection> {
  // Lazy imports keep cloud boxes (which never export) from touching the
  // session registry / task store at module load.
  const { listSessions, isListableSession } = await import('./session-tracker.js')
  const { listTasks } = await import('./task-manager.js')

  const [allSessions, allTasks] = await Promise.all([listSessions(), listTasks()])
  const taskById = new Map(allTasks.map((t) => [t.id, t]))
  const cutoff = Date.now() - STOPPED_RETENTION_DAYS * 24 * 60 * 60 * 1000

  // ISO-8601 timestamps are byte-ordered, so relational compare is the same
  // order localeCompare gives at a fraction of the cost (no ICU collation).
  const newestFirst = (a: string | undefined, b: string | undefined) => {
    const x = a ?? '', y = b ?? ''
    return x < y ? 1 : x > y ? -1 : 0
  }

  const eligible = allSessions
    .filter((s) => {
      // isListableSession excludes BOTH environment sessions and lane-bound ones
      // (a lane session backs a UI conversation surface, not a listed session).
      if (!isListableSession(s) || s.archived) return false
      if (TERMINAL_STATUSES.has(s.process_status)) {
        const at = Date.parse(s.lastActiveAt ?? s.startedAt)
        return Number.isFinite(at) && at >= cutoff
      }
      return true
    })
    .sort((a, b) => newestFirst(a.lastActiveAt, b.lastActiveAt))

  // projectSession stamps `pinned` from the owning task, so the rows carry
  // everything the priority order below needs — no second task lookup, and the
  // priority can never disagree with the stamped flag.
  const rows = eligible.map((s) => projectSession(s, s.taskId ? taskById.get(s.taskId) : undefined))
  const exportedAt = () => new Date().toISOString()

  // FAST PATH — prove no budget can bite, then skip the ordered fill entirely.
  // `rows` is already in the output order (eligible was sorted newest-first), so
  // this IS the answer. What this saves is the ORDERING work, which measurement
  // showed dominates: a wrapper object per row, a priority sort and a re-sort
  // (0.31ms of a 2.11ms session selection, 0.54ms of a 3.14ms task one). The
  // accounting uses the same per-row formula as the fill below, so both paths
  // agree exactly on the budget boundary.
  if (rows.length <= MAX_SESSIONS) {
    let fastBytes = 0
    for (const row of rows) fastBytes += Buffer.byteLength(JSON.stringify(row), 'utf8') + 1
    if (fastBytes <= PROJECTION_BYTE_BUDGET) {
      return { version: 1, exportedAt: exportedAt(), sessions: rows }
    }
  }

  // SLOW PATH — a budget bites, so order matters. filter() is stable, so both
  // groups stay newest-first inside themselves.
  const ordered = [...rows.filter((r) => r.pinned), ...rows.filter((r) => !r.pinned)]

  const sessions: ProjectedSession[] = []
  let bytes = 0
  let dropped = 0
  let droppedPinned = 0
  let bytesBound = false
  for (const row of ordered) {
    // +1 for the comma this row costs inside the serialized array.
    const rowBytes = Buffer.byteLength(JSON.stringify(row), 'utf8') + 1
    const overRows = sessions.length >= MAX_SESSIONS
    const overBytes = bytes + rowBytes > PROJECTION_BYTE_BUDGET
    if (overRows || overBytes) {
      // Keep counting rather than breaking: the warn below is only useful if it
      // reports how much of the documented window was actually lost.
      if (overBytes) bytesBound = true
      dropped++
      if (row.pinned) droppedPinned++
      continue
    }
    sessions.push(row)
    bytes += rowBytes
  }
  sessions.sort((a, b) => newestFirst(a.last_active_at, b.last_active_at))

  if (dropped > 0) {
    // ONE warn per export (not per row). The 500-row cap shrank the window from
    // 14 days to 8 in total silence for months; whichever budget binds, that
    // now shows up in the log with the numbers needed to raise it. Both binders
    // are reported — reporting only 'rows' hid a payload that was ALSO at its
    // byte ceiling, which is the one that can silently kill the push.
    const rowsBound = sessions.length >= MAX_SESSIONS
    log.session.warn('session projection truncated by budget', {
      eligible: eligible.length,
      shipped: sessions.length,
      dropped,
      droppedPinned,
      boundBy: rowsBound && bytesBound ? 'rows+bytes' : rowsBound ? 'rows' : 'bytes',
      rowBudget: MAX_SESSIONS,
      byteBudget: PROJECTION_BYTE_BUDGET,
      bytes,
      retentionDays: STOPPED_RETENTION_DAYS,
      oldestShipped: sessions[sessions.length - 1]?.last_active_at,
    })
  }

  return {
    version: 1,
    exportedAt: exportedAt(),
    sessions,
    // Symmetry with TaskProjection: absence is not evidence of deletion here.
    ...(dropped > 0 ? { truncated: true as const } : {}),
  }
}

/**
 * Export the current session list: write the projection cache (always), push
 * it to the cloud over the bridge (fire-and-forget), and — while the
 * `sync.legacy_projection_files` knob is on — also rewrite the legacy
 * git-synced file (atomic writes throughout).
 */
export async function exportSessionProjection(): Promise<number> {
  const projection = await buildSessionProjection()
  await writeProjectionCache('sessions', projection)
  if (await legacyProjectionFilesEnabled()) {
    await writeJsonFile(SESSION_PROJECTION_FILE, projection)
  }
  pushProjectionToCloud('projection-upsert', { which: 'sessions', data: projection })
  return projection.sessions.length
}

// ── Transcript tails (the "open session" payload) ──────────────────────────

/** Slim transcript row — mirrors the mobile chat message shape. */
export interface ProjectedTranscriptMessage {
  role: string
  text: string
  timestamp: string
  /** "tool" rows carry the tool name in text; "thinking" a short excerpt. */
  kind?: 'tool' | 'thinking'
  /** kind:'tool' only (additive) — one-line input summary, e.g. "ls docs/". */
  detail?: string
  /** kind:'tool' only (additive) — clipped tool output for the expanded card. */
  resultPreview?: string
  /** Task/Agent tool rows only (additive) — the subagent's name/label
   *  (team agent name, `name` input, or `subagent_type`), so mobile can show
   *  which agent a delegated run belongs to. The subagent's own transcript
   *  lives in a separate subagents/*.jsonl and is not inlined here. */
  agent?: string
}

export interface SessionTranscript {
  version: 1
  sessionId: string
  exportedAt: string
  /** True when the tail was truncated to TRANSCRIPT_TAIL rows. */
  truncated: boolean
  messages: ProjectedTranscriptMessage[]
}

const TEXT_MAX = 4_000

let lastTranscriptSweep = 0
let transcriptSweepRunning = false

/**
 * Build the slim transcript tail for one session by reading its history NOW
 * (local disk or SSH). Throws when the session is unreachable. Used by the
 * sweep below and by the api-v1 live view (?fresh=1), which needs sub-sweep
 * freshness for a single session without paying for a full sweep.
 */
export async function buildSessionTranscript(sessionId: string): Promise<SessionTranscript> {
  const { readSessionHistoryTail } = await import('./session-history.js')
  const { getSessionByClaudeId } = await import('./session-tracker.js')
  const { toolDetail, toolResultPreview } = await import('./tool-summary.js')
  const record = await getSessionByClaudeId(sessionId)
  // ACP/codex sessions have no claude JSONL — their history lives in the ACP
  // journal (acpJournalPath / <runtimeId>.acp.jsonl). The claude-only read
  // below silently returned [] for them, so every export/fresh=1/cloud tail
  // was an empty transcript on a session with a full visible conversation
  // (2026-08-16: cache/transcripts/<sid>.json stuck at messages:[] while the
  // web console showed the whole thread). Same branch the /history route takes.
  let history: import('./session-history.js').SessionHistoryMessage[]
  if (record && engineCaps(record.engine).historySource === 'acp-journal') {
    const { readAcpSessionHistory } = await import('../providers/acp-session-history.js')
    history = await readAcpSessionHistory(record)
  } else {
    // Tail-bounded: this export keeps only the last TRANSCRIPT_TAIL messages, so
    // whales must not be fully transferred per sweep (pre-fix: the 60s sweep
    // full-read every alive session — dominant share of 167 GB/day of reads).
    history = await readSessionHistoryTail(sessionId, record?.cwd, record?.host, record?.outputFile) ?? []
  }
  const tail = history.slice(-TRANSCRIPT_TAIL)
  const messages: ProjectedTranscriptMessage[] = []
  for (const m of tail) {
    if (m.role === 'system') continue
    // CLI-injected user lines (skill content dumps, compaction summaries) are
    // not something the human typed — Claude Code hides them entirely; the
    // slim phone tail drops them too (a 4K skill dump would eat the preview).
    if (m.role === 'user' && m.injected) continue
    for (const t of m.tools ?? []) {
      const detail = toolDetail(t.name, t.input)
      const resultPreview = toolResultPreview(t.result)
      // Subagent attribution (additive): Task/Agent rows carry the subagent's
      // label. Sources, most→least specific: team agent name (Agent tool,
      // parsed from tool input by session-history), the tool input's `name`,
      // then `subagent_type` (Task tool). Full nested lane transcripts stay in
      // subagents/*.jsonl — this only labels the delegation row itself.
      let agent: string | undefined
      if (t.name === 'Task' || t.name === 'Agent') {
        const input = t.input as Record<string, unknown>
        agent = t.teamAgentName
          ?? (typeof input.name === 'string' && input.name ? input.name : undefined)
          ?? (typeof input.subagent_type === 'string' && input.subagent_type ? input.subagent_type : undefined)
      }
      messages.push({
        role: 'assistant', text: t.name, timestamp: m.timestamp, kind: 'tool',
        ...(detail ? { detail } : {}),
        ...(resultPreview ? { resultPreview } : {}),
        ...(agent ? { agent } : {}),
      })
    }
    const text = (m.text || '').trim()
    if (text) {
      messages.push({
        role: m.role,
        text: text.length > TEXT_MAX ? text.slice(0, TEXT_MAX) + '…' : text,
        timestamp: m.timestamp,
      })
    }
  }
  return {
    version: 1,
    sessionId,
    exportedAt: new Date().toISOString(),
    truncated: history.length > TRANSCRIPT_TAIL,
    messages,
  }
}

/**
 * Export transcript tails for alive sessions (+ recently-stopped ones whose
 * CACHE copy is missing — the cache is the archive now). Each written tail is
 * also pushed to the cloud (`transcript-upsert`); legacy git files ride along
 * while the `sync.legacy_projection_files` knob is on. Throttled: remote
 * session reads ride SSH, so sweeps are at most one per
 * TRANSCRIPT_THROTTLE_MS and never concurrent.
 */
export async function exportSessionTranscripts(): Promise<number> {
  if (transcriptSweepRunning) return 0
  if (Date.now() - lastTranscriptSweep < TRANSCRIPT_THROTTLE_MS) return 0
  transcriptSweepRunning = true
  lastTranscriptSweep = Date.now()
  try {
    const projection = await readSessionProjection()
    if (!projection) return 0
    const legacy = await legacyProjectionFilesEnabled()
    if (legacy) await fsp.mkdir(SESSION_TRANSCRIPTS_DIR, { recursive: true })

    let exported = 0
    for (const s of projection.sessions) {
      const alive = s.process_status === 'running' || s.process_status === 'idle'
      if (!alive) {
        // Stopped sessions keep their last exported tail (their frozen
        // archive); export once if the cache copy is absent. Upgrade path:
        // seed the cache from the legacy git-synced file instead of re-reading
        // history (old sessions' JSONLs may be purged/unreachable) — and push
        // the seeded tail so the cloud archive matches.
        if (parseTranscript(await readTranscriptCache(s.id))) continue
        const fromLegacy = await readLegacyTranscriptFile(s.id)
        if (fromLegacy) {
          try {
            await writeTranscriptCache(s.id, fromLegacy)
            pushProjectionToCloud('transcript-upsert', { sid: s.id, data: fromLegacy })
            exported++
          } catch (err) {
            log.session.debug('transcript cache seed failed', { sessionId: s.id, error: String(err) })
          }
          continue
        }
        /* absent everywhere — freeze the final tail below (once) */
      }
      try {
        const transcript = await buildSessionTranscript(s.id)
        await writeTranscriptCache(s.id, transcript)
        if (legacy) await writeJsonFile(path.join(SESSION_TRANSCRIPTS_DIR, `${s.id}.json`), transcript)
        pushProjectionToCloud('transcript-upsert', { sid: s.id, data: transcript })
        exported++
      } catch (err) {
        // One unreachable session (SSH down, purged JSONL) must not kill the sweep.
        log.session.debug('transcript export skipped', { sessionId: s.id, error: String(err) })
      }
    }
    return exported
  } finally {
    transcriptSweepRunning = false
  }
}

/** Envelope gate shared by the cache and legacy transcript sources. */
function parseTranscript(raw: unknown): SessionTranscript | null {
  const parsed = raw as SessionTranscript | null
  if (parsed?.version !== 1 || !Array.isArray(parsed.messages)) return null
  return parsed
}

/** LEGACY git-synced transcript file. Null when absent/corrupt. */
async function readLegacyTranscriptFile(sessionId: string): Promise<SessionTranscript | null> {
  try {
    const raw = await fsp.readFile(path.join(SESSION_TRANSCRIPTS_DIR, `${sessionId}.json`), 'utf-8')
    return parseTranscript(JSON.parse(raw))
  } catch {
    return null
  }
}

/**
 * Read a transcript tail (both boxes): the projection cache (written locally
 * on the primary, bridge-pushed on the cloud) vs the legacy git-synced file
 * (transition fallback — first boot after upgrade on the primary, pre-push
 * history on the cloud), fresher exportedAt wins. Null when absent/corrupt.
 */
export async function readSessionTranscript(sessionId: string): Promise<SessionTranscript | null> {
  // The id lands in a filename — refuse anything but the safe id alphabet.
  if (!/^[A-Za-z0-9_-]+$/.test(sessionId)) return null
  return pickFresherEnvelope(
    parseTranscript(await readTranscriptCache(sessionId)),
    await readLegacyTranscriptFile(sessionId),
  )
}

/** Envelope gate shared by the cache and legacy projection sources. */
function parseSessionProjection(raw: unknown): SessionProjection | null {
  const parsed = raw as SessionProjection | null
  if (parsed?.version !== 1 || !Array.isArray(parsed.sessions)) return null
  return parsed
}

/**
 * Read the session projection (both boxes): projection cache vs the legacy
 * git-synced transition fallback, fresher exportedAt wins. Null when
 * absent/corrupt.
 */
export async function readSessionProjection(): Promise<SessionProjection | null> {
  const cached = parseSessionProjection(await readProjectionCache('sessions'))
  let legacy: SessionProjection | null = null
  try {
    legacy = parseSessionProjection(JSON.parse(await fsp.readFile(SESSION_PROJECTION_FILE, 'utf-8')))
  } catch { /* absent/corrupt legacy file */ }
  return pickFresherEnvelope(cached, legacy)
}

let debounceTimer: NodeJS.Timeout | null = null
let exporting = false
let dirtyWhileExporting = false

function scheduleExport(): void {
  if (debounceTimer) clearTimeout(debounceTimer)
  debounceTimer = setTimeout(() => {
    debounceTimer = null
    if (exporting) { dirtyWhileExporting = true; return }
    exporting = true
    exportSessionProjection()
      .then((count) => log.session.debug('session projection exported', { count }))
      .then(() => exportSessionTranscripts())
      .then((count) => { if (count > 0) log.session.debug('session transcripts exported', { count }) })
      .catch((err) => log.session.warn('session projection export failed', { error: String(err) }))
      .finally(() => {
        exporting = false
        if (dirtyWhileExporting) { dirtyWhileExporting = false; scheduleExport() }
      })
  }, DEBOUNCE_MS)
}

/**
 * Primary-box wiring: export at startup, then re-export (debounced) whenever
 * any session event fires. Returns a stop function for clean shutdown.
 */
export function startSessionProjectionExport(): { stop: () => void } {
  scheduleExport() // initial export shortly after boot (debounce absorbs the startup storm)
  bus.subscribe('session-projection', () => scheduleExport(), {
    global: true,
    // Lifecycle + status only — NOT the high-frequency stream deltas
    // (text-delta/thinking-delta fire per token and would thrash the timer).
    interest: ['session:started', 'session:ended', 'session:status-changed', 'session:result', 'session:error'],
  })
  return {
    stop: () => {
      bus.unsubscribe('session-projection')
      if (debounceTimer) { clearTimeout(debounceTimer); debounceTimer = null }
    },
  }
}
