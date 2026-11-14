/**
 * A session's current turn as one record: the attempts Walnut made at it and, while Walnut itself
 * continues it, why (the wait reason). Every place that asks "is Walnut retrying this turn, so its
 * end is not the end of the work" reads it here, never the retriers one by one.
 *
 * Before (2026-11-03 to 11-11) each retry kind added its own branch to every reader: the endpoint
 * wait, the usage-limit wait, restart and start recovery, the auto-continue retry, the safeguard
 * model switch and the context-full recovery each held the turn-end notices, the error card, the
 * phase or the task's status in some readers and not in others, and a sixth kind meant finding all
 * of them (the turn-end hook asked five, the phase two, the status four, the switch two). Modelled on
 * T3 Code's orchestration v2 (a run with attempts, each attempt with a reason; only the final attempt
 * completes the run).
 *
 *   a turn ends ──► turnEndTakenBy(the end's facts)    at the end event, before its record is written:
 *        │            the first retrier that takes it   the error card is held; a retrier that keeps
 *        │                                              the phase keeps the task's phase and session
 *        ▼
 *   turnRunOf(record) ──► { attempts, wait, stop }       on the record, any time after:
 *        wait: Walnut continues it (reason + the retrier's own state, for the words)
 *        stop: Walnut stopped continuing it and the failure is the user's (gave up, turned off)
 *
 * The rows: one per TurnRetryReason, each in the module that owns that retry's state (its `turnRetrier`
 * export), loaded here by name, so this module imports none of them and every reader can import it.
 * The wait is read from each retrier's own state on every read (their records are already durable,
 * and two copies of a wait would drift); the attempts are written here, by noteTurnAttempt, when a
 * retrier sends its continue, and a send by anyone else starts a new turn.
 *
 * A new retry kind is a new TurnRetryReason and a row: the reason's traits (TURN_RETRY_TRAITS), its
 * loader (ROW_LOADERS) and the status words (user-status-sync.ts turnWaitFacts) are total over the
 * reason type, so tsc refuses a reason without them, and tests/core/sessions/turn-run-guard.test.ts
 * fails while a reader asks a retrier directly or a row sends without noting its attempt.
 */
import { log } from '../../logging/index.js'
import { bus, EventNames } from '../event-bus.js'
import type { BusEvent } from '../event-bus.js'
import type { SessionRecord, SessionEndpointWait, SessionUsageLimit, SessionTurn, TurnAttempt, TurnRetryReason } from '../types.js'

export type { SessionTurn, TurnAttempt, TurnRetryReason }

/** Every reason Walnut continues a turn by itself, in the order a reader is answered (the first that holds). */
export const TURN_RETRY_REASONS = [
  'usage_limit', 'endpoint_wait', 'restart_recovery', 'auto_continue', 'safeguard_switch', 'context_recovery',
] as const satisfies readonly TurnRetryReason[]

/** What a reason means for the task, the same for every reader. */
export interface TurnRetryTraits {
  /** The task keeps its phase (and its session) while Walnut retries. False: it is handed back now,
   *  its status names the retry, and a turn-end notice waits only if the row keeps it (`keep`). */
  keepsPhase: boolean
  /** The session is mid-work between turns: a switch or a move of it waits (turn-end-wait.ts turnHold). */
  midWork: boolean
}

export const TURN_RETRY_TRAITS: { readonly [R in TurnRetryReason]: TurnRetryTraits } = {
  // Waits on the clock or the machine; the session can be switched or moved meanwhile.
  usage_limit: { keepsPhase: true, midWork: false },
  endpoint_wait: { keepsPhase: true, midWork: false },
  restart_recovery: { keepsPhase: true, midWork: false },
  // A retry in a few minutes: the task reads Waiting on Walnut in NEED_ACTION (user-status.ts), and
  // the held notices replay if the retry never starts (session-auto-continue.ts holdUntilRetried).
  auto_continue: { keepsPhase: false, midWork: false },
  // Working on the session itself (a model change and a resend, a compaction and a resend).
  safeguard_switch: { keepsPhase: true, midWork: true },
  context_recovery: { keepsPhase: true, midWork: true },
}

/** The retrier's own state a reader gets with the reason (for its words). */
export interface TurnRetryDetail {
  usage_limit: { usageLimit: SessionUsageLimit }
  endpoint_wait: { endpointWait: SessionEndpointWait }
  restart_recovery: { loss?: { state: string; cause?: string } }
  auto_continue: { retryAt: string }
  safeguard_switch: Record<never, never>
  context_recovery: Record<never, never>
}
export type TurnWait = { [R in TurnRetryReason]: { reason: R } & TurnRetryDetail[R] }[TurnRetryReason]

/** What a reader asks about. */
export interface TurnQuestion {
  /** The end judged is a failure or a death, not a clean answer: restart recovery holds only those. */
  failed?: boolean
  /** It is the session's own turn end (a result or an error edge), not a look at a dead record: a
   *  resume restart recovery already sent is that session's own, and its errors hand back. */
  ownEnd?: boolean
  /** The ended turn's generation, when the reader knows it (the safeguard switch answers for that turn). */
  turnGen?: number
}

/** The facts of a turn end event (session:result, session:error) a row decides from. */
export interface TurnEndFacts {
  /** session:result (a turn's end) or session:error (a failure the runner reports outside a result). */
  event: 'result' | 'error'
  sessionId: string
  isError: boolean
  result?: string | null
  turnGen?: number
  retryExhausted?: boolean
  interrupted?: boolean
  teamActive?: boolean
  backgroundActive?: boolean
  detachedBgActive?: boolean
  wakeupPending?: boolean
  usageLimit?: import('./usage-limit-model.js').UsageLimitFacts | null
  /** A session:error of a process that ended before it read its first line (sessions/start-recovery.ts). */
  startRecovery?: boolean
  /** The session's record, when the reader has it. */
  record?: SessionRecord | null
}

/** One retry kind's answers. Lives in the module that owns its state, as `turnRetrier`. */
export interface TurnRetrier<R extends TurnRetryReason = TurnRetryReason> {
  reason: R
  /** The send sources its continues go out under: a send from one of them is an attempt, not a new turn. */
  sources: readonly string[]
  /** At the turn end event, before the record is written: this retrier takes this ended turn. */
  takes(end: TurnEndFacts): boolean
  /** On the record: Walnut continues this session's current turn (with its state), or null. */
  wait(rec: SessionRecord, q: TurnQuestion): ({ reason: R } & TurnRetryDetail[R]) | null
  /** On the record: Walnut stopped continuing it, and the failure is the user's (gave up, turned off). */
  stop?(rec: SessionRecord): ({ reason: R } & TurnRetryDetail[R]) | null
  /** Keep a turn-end notice until the retry settles: run it if the retry never starts a turn.
   *  Required of a reason that does not keep the phase (its phase edge already happened). */
  keep?(sessionId: string, replay: () => void): boolean
}

type Rows = { [R in TurnRetryReason]?: TurnRetrier<R> }

/** Where each reason's row lives. */
const ROW_LOADERS: { readonly [R in TurnRetryReason]: () => Promise<TurnRetrier<R>> } = {
  usage_limit: async () => (await import('./usage-limit-wait.js')).turnRetrier,
  endpoint_wait: async () => (await import('./endpoint-wait.js')).turnRetrier,
  restart_recovery: async () => (await import('../session-auto-recover.js')).turnRetrier,
  auto_continue: async () => (await import('../session-auto-continue.js')).turnRetrier,
  safeguard_switch: async () => (await import('./safeguard-switch.js')).turnRetrier,
  context_recovery: async () => (await import('./context-full-recovery.js')).turnRetrier,
}

const rows: Rows = {}
let loading: Promise<void> | null = null
/** The record cache's sync read, loaded with the rows (turnMidWorkNow). */
let recordNow: ((sid: string) => SessionRecord | null) | null = null

/** Load every row (once). Async readers call it themselves; a sync reader runs after the server's start loaded them. */
export function loadTurnRetriers(): Promise<void> {
  return (loading ??= (async () => {
    try { recordNow = (await import('../session-tracker.js')).getSessionByClaudeIdSync } catch { /* no cache: ids only */ }
    for (const reason of TURN_RETRY_REASONS) {
      try {
        const row = await ROW_LOADERS[reason]()
        if (row.reason !== reason) throw new Error(`row of ${reason} says ${row.reason}`)
        ;(rows as Record<string, TurnRetrier>)[reason] = row as TurnRetrier
      } catch (err) {
        // A row that cannot load holds nothing (as a retrier that did not start holds nothing); the next load tries again.
        loading = null
        log.session.warn('turn run: a retry kind could not be loaded', { reason, error: err instanceof Error ? err.message : String(err) })
      }
    }
  })())
}

function each(): TurnRetrier[] {
  const out: TurnRetrier[] = []
  for (const reason of TURN_RETRY_REASONS) {
    const row = rows[reason] as TurnRetrier | undefined
    if (row) out.push(row)
  }
  return out
}

function safe<T>(reason: TurnRetryReason, fn: () => T, fallback: T): T {
  try { return fn() } catch (err) {
    log.session.warn('turn run: a retry kind failed to answer', { reason, error: err instanceof Error ? err.message : String(err) })
    return fallback
  }
}

export interface TurnRun {
  /** Walnut's continues of this turn, after the one that started it (a person's or a peer's message). */
  attempts: TurnAttempt[]
  /** Walnut continues it now, and why: the first of `waits`. */
  wait: TurnWait | null
  /** Walnut stopped continuing it: the failure is the user's (or the lead's) now. The first of `stops`. */
  stop: TurnWait | null
  /** Every retrier that holds it, in TURN_RETRY_REASONS order (two can at once: a restart during a usage-limit wait). */
  waits: TurnWait[]
  stops: TurnWait[]
}

/** The session's current turn, from the rows already loaded (sync). */
export function turnRunNow(rec: SessionRecord, q: TurnQuestion = {}): TurnRun {
  const waits: TurnWait[] = []
  const stops: TurnWait[] = []
  for (const row of each()) {
    const w = safe(row.reason, () => row.wait(rec, q), null) as TurnWait | null
    if (w) waits.push(w)
    const s = row.stop ? safe(row.reason, () => row.stop!(rec), null) as TurnWait | null : null
    if (s) stops.push(s)
  }
  return { attempts: rec.turn?.attempts ?? [], wait: waits[0] ?? null, stop: stops[0] ?? null, waits, stops }
}

/** The session's current turn (loads the rows first). */
export async function turnRunOf(rec: SessionRecord, q: TurnQuestion = {}): Promise<TurnRun> {
  await loadTurnRetriers()
  return turnRunNow(rec, q)
}

/** Why Walnut continues this record's turn, or null (sync, rows already loaded). */
export function turnWaitNow(rec: SessionRecord | null | undefined, q: TurnQuestion = {}): TurnWait | null {
  return rec ? turnRunNow(rec, q).wait : null
}

/** Why Walnut continues this record's turn, or null. */
export async function turnWaitOf(rec: SessionRecord | null | undefined, q: TurnQuestion = {}): Promise<TurnWait | null> {
  if (!rec) return null
  await loadTurnRetriers()
  return turnWaitNow(rec, q)
}

/** The retrier that takes this turn end event, or null: its error card is held, and when the reason
 *  keeps the phase the task keeps its phase and its session (web/server.ts, the runner). */
export async function turnEndTakenBy(end: TurnEndFacts): Promise<TurnRetryReason | null> {
  await loadTurnRetriers()
  // A row may need the session's record (the context recovery: is it recoverable?): read it when the caller has none.
  if (end.record === undefined) {
    const { getSessionByClaudeId } = await import('../session-tracker.js')
    end = { ...end, record: await getSessionByClaudeId(end.sessionId).catch(() => null) }
  }
  for (const row of each()) {
    if (safe(row.reason, () => row.takes(end), false)) return row.reason
  }
  return null
}

/** The turn end event is one Walnut continues and the task keeps its phase for. */
export async function turnEndKeepsPhase(end: TurnEndFacts): Promise<TurnRetryReason | null> {
  const reason = await turnEndTakenBy(end)
  return reason && TURN_RETRY_TRAITS[reason].keepsPhase ? reason : null
}

/**
 * Hold this turn end's notices to its askers and its lead (session-hooks/builtins.ts)? A reason that
 * keeps the phase holds them outright: its own turn end, or its give-up's phase edge, speaks later. One
 * that does not keep the phase holds them only if its row keeps the replay for a retry that never starts.
 */
export async function holdTurnEndNotices(rec: SessionRecord, q: TurnQuestion, replay: () => void): Promise<TurnRetryReason | null> {
  const wait = await turnWaitOf(rec, q)
  if (!wait) return null
  if (TURN_RETRY_TRAITS[wait.reason].keepsPhase) return wait.reason
  const row = rows[wait.reason] as TurnRetrier | undefined
  return row?.keep && safe(wait.reason, () => row.keep!(rec.claudeSessionId, replay), false) ? wait.reason : null
}

/** A retrier that works on the session itself holds it (a switch or a move waits), or null. */
export async function turnMidWork(rec: Pick<SessionRecord, 'claudeSessionId'> & Partial<SessionRecord>): Promise<TurnRetryReason | null> {
  await loadTurnRetriers()
  // A caller may hold only part of the record (turn-end-wait.ts): read the whole one when it is there.
  if (!('process_status' in rec)) {
    const { getSessionByClaudeIdSync } = await import('../session-tracker.js')
    rec = getSessionByClaudeIdSync(rec.claudeSessionId) ?? rec
  }
  for (const row of each()) {
    if (!TURN_RETRY_TRAITS[row.reason].midWork) continue
    if (safe(row.reason, () => row.wait(rec as SessionRecord, {}), null)) return row.reason
  }
  return null
}

/** turnMidWork from the rows already loaded and the record cache (sync): for a reader that must
 *  answer at the event, before anything awaits (a triage run). */
export function turnMidWorkNow(sessionId: string | undefined): TurnRetryReason | null {
  if (!sessionId) return null
  let found: SessionRecord | null = null
  try { found = recordNow?.(sessionId) ?? null } catch { /* the cache unreadable: the rows read the id */ }
  const rec = found ?? ({ claudeSessionId: sessionId } as SessionRecord)
  for (const row of each()) {
    if (TURN_RETRY_TRAITS[row.reason].midWork && safe(row.reason, () => row.wait(rec, {}), null)) return row.reason
  }
  return null
}

/**
 * Did this turn end answer nothing, because a retrier working on the session itself holds it (a
 * reader that settles on a turn's end: a triage run)? A midWork row's wait on the record, or one that
 * takes the end event. A retrier that waits on the clock or the machine leaves the end to settle as
 * what it is (its give-up raises no second turn end).
 */
export async function turnEndAnsweredNothing(sessionId: string | undefined, end?: Omit<TurnEndFacts, 'sessionId'>): Promise<TurnRetryReason | null> {
  if (!sessionId) return null
  const { getSessionByClaudeId } = await import('../session-tracker.js')
  const rec = await getSessionByClaudeId(sessionId).catch(() => null)
  await loadTurnRetriers()
  for (const row of each()) {
    if (!TURN_RETRY_TRAITS[row.reason].midWork) continue
    if (rec && safe(row.reason, () => row.wait(rec, {}), null)) return row.reason
    if (end && safe(row.reason, () => row.takes({ ...end, sessionId, record: rec }), false)) return row.reason
  }
  return null
}

// ── Held hand-backs ─────────────────────────────────────────────────────────────

/**
 * A hand-back the phase held because Walnut continues the turn (phase.ts) must go ahead once the
 * retrier lets go without a new turn taking over: a person stopped the session during a wait, the
 * wait closed on another error, an opening wait was never written. Each held hand-back is kept here
 * with the session's status when it was held; the retrier that closes its wait says so
 * (turnRetryEnded), and a recheck runs on a clock for any that does not. Replayed only while the
 * session still reads that same stopped or failed status: a new turn hands back for itself.
 */
interface HeldHandBack {
  reason: TurnRetryReason
  stamp: string
  /** `stillSame`: the session still reads the status it was held at; the replay asks it again inside its task write. */
  replay: (over: TurnRetryReason | undefined, stillSame: () => boolean) => Promise<unknown>
  tries: number
  since: number
  timer?: ReturnType<typeof setTimeout>
}
const heldHandBacks = new Map<string, HeldHandBack>()
/** Rechecks of a held hand-back, from when it was held (the last repeats), and when to stop. */
export const HELD_HANDBACK_RECHECK_MS: readonly number[] = [90_000, 5 * 60_000, 15 * 60_000]
let recheckMs: readonly number[] = HELD_HANDBACK_RECHECK_MS
export const HELD_HANDBACK_MAX_MS = 24 * 60 * 60_000

function statusStamp(rec: SessionRecord | null | undefined): string | null {
  // Any status write (a new turn, a resume, a stop) moves the revision or the time.
  if (!rec) return null
  return `${rec.process_status}|${rec.statusRevision ?? ''}|${rec.statusUpdatedAt ?? rec.last_status_change ?? ''}`
}

/** The phase held this session's hand-back for `reason` (phase.ts); `replay` applies it again. */
export function noteHeldHandBack(sessionId: string, reason: TurnRetryReason, replay: HeldHandBack['replay']): void {
  let rec: SessionRecord | null = null
  try { rec = recordNow?.(sessionId) ?? null } catch { /* unreadable: no stamp */ }
  const stamp = statusStamp(rec)
  if (!stamp) return
  const prior = heldHandBacks.get(sessionId)
  if (prior?.timer) clearTimeout(prior.timer)
  if (prior) heldHandBacks.delete(sessionId)
  const same = prior && prior.stamp === stamp
  const h: HeldHandBack = { reason, stamp, replay, tries: same ? prior.tries : 0, since: same ? prior.since : Date.now() }
  if (Date.now() - h.since >= HELD_HANDBACK_MAX_MS) { heldHandBacks.delete(sessionId); return }
  const wait = recheckMs[Math.min(h.tries, recheckMs.length - 1)]
  h.timer = setTimeout(() => { h.tries++; void releaseHeldHandBack(sessionId, undefined, h) }, wait)
  h.timer.unref?.()
  heldHandBacks.set(sessionId, h)
}

/** A retrier closed its wait on this session (no continue of its own follows): a hand-back it held goes ahead. */
export function turnRetryEnded(sessionId: string, reason: TurnRetryReason): void {
  void releaseHeldHandBack(sessionId, reason)
}

async function releaseHeldHandBack(sessionId: string, over: TurnRetryReason | undefined, only?: HeldHandBack): Promise<void> {
  const h = heldHandBacks.get(sessionId)
  if (!h || (only && h !== only)) return
  if (h.timer) clearTimeout(h.timer)
  h.timer = undefined
  // Kept while it replays: held again, the phase notes it once more and its tries and age carry on.
  const drop = () => { if (heldHandBacks.get(sessionId) === h) heldHandBacks.delete(sessionId) }
  try {
    const { getSessionByClaudeId } = await import('../session-tracker.js')
    // A session that moved on (a new turn ran, a person resumed it) hands back for itself.
    if (statusStamp(await getSessionByClaudeId(sessionId).catch(() => null)) !== h.stamp) { drop(); return }
    if (heldHandBacks.get(sessionId) !== h) return // a new send cancelled it meanwhile
    const stillSame = () => {
      if (heldHandBacks.get(sessionId) !== h) return false
      let rec: SessionRecord | null = null
      try { rec = recordNow?.(sessionId) ?? null } catch { return false }
      return statusStamp(rec) === h.stamp
    }
    // The retrier that ended passes its own reason, so its own opening window cannot hold it again;
    // another one still holding holds it again (and the phase keeps it here once more).
    log.session.info('turn run: a held hand-back goes ahead', { sessionId, reason: h.reason, ended: over ?? null, tries: h.tries })
    await h.replay(over === h.reason ? over : undefined, stillSame)
  } catch (err) {
    log.session.warn('turn run: a held hand-back failed', { sessionId, error: err instanceof Error ? err.message : String(err) })
  } finally {
    drop()
  }
}

/** A send by anyone but a retrier: a new turn drives the session, and hands back for itself. */
function cancelHeldHandBack(sessionId: string): void {
  const h = heldHandBacks.get(sessionId)
  if (!h) return
  if (h.timer) clearTimeout(h.timer)
  heldHandBacks.delete(sessionId)
  log.session.info('turn run: a held hand-back dropped: a new message drives the session', { sessionId, reason: h.reason })
}

// ── Attempts ────────────────────────────────────────────────────────────────────

/** At most this many attempts are kept on a record (a turn retried more is already a give-up). */
export const TURN_ATTEMPTS_KEPT = 20

/** Each session's turn writes, in the order they were asked for (an attempt and a new turn race otherwise). */
const turnWrites = new Map<string, Promise<void>>()
function inOrder(sessionId: string, fn: () => Promise<void>): Promise<void> {
  const next = (turnWrites.get(sessionId) ?? Promise.resolve()).then(fn, fn)
  turnWrites.set(sessionId, next)
  void next.finally(() => { if (turnWrites.get(sessionId) === next) turnWrites.delete(sessionId) })
  return next
}

/** Write the record's turn as `fn` makes it from the current one (a compare-and-set; null removes it). */
async function patchTurn(sessionId: string, fn: (cur: SessionTurn | undefined) => SessionTurn | null): Promise<void> {
  const { getSessionByClaudeId, updateSessionRecordConditionally } = await import('../session-tracker.js')
  for (let i = 0; i < 4; i++) {
    const cur = await getSessionByClaudeId(sessionId)
    if (!cur) return
    const seen = JSON.stringify(cur.turn ?? null)
    const next = fn(cur.turn) ?? undefined
    if (JSON.stringify(next ?? null) === seen) return
    const written = await updateSessionRecordConditionally(sessionId, { turn: next } as Partial<SessionRecord>,
      (current) => JSON.stringify(current.turn ?? null) === seen, { preserveLastActiveAt: true })
    if (written) return
  }
  throw new Error('the turn write kept racing')
}

/**
 * A retrier is about to send its continue of this session's turn: append the attempt. Never throws
 * (an attempt that could not be written is still sent: the record is for reading, not a gate).
 */
export function noteTurnAttempt(sessionId: string, reason: TurnRetryReason, at: string = new Date().toISOString()): Promise<void> {
  return inOrder(sessionId, () => patchTurn(sessionId, (cur) => ({
    since: cur?.since ?? at, attempts: [...(cur?.attempts ?? []), { reason, at }].slice(-TURN_ATTEMPTS_KEPT),
  })).catch((err) => {
    log.session.warn('turn run: an attempt could not be noted', { sessionId, reason, error: err instanceof Error ? err.message : String(err) })
  }))
}

/**
 * A send from anyone but a retrier, at `atMs`, starts a new turn: the attempts made before it go. Only
 * those: an attempt noted after the send (a late second event of the same send) stays.
 */
function newTurn(sessionId: string, atMs: number): Promise<void> {
  return inOrder(sessionId, async () => {
    const { getSessionByClaudeIdSync } = await import('../session-tracker.js')
    if (!getSessionByClaudeIdSync(sessionId)?.turn) return
    await patchTurn(sessionId, (cur) => {
      const kept = (cur?.attempts ?? []).filter((a) => !(Date.parse(a.at) <= atMs))
      return kept.length ? { since: kept[0].at, attempts: kept } : null
    })
  }).catch((err) => {
    log.session.warn('turn run: a new turn could not be noted', { sessionId, error: err instanceof Error ? err.message : String(err) })
  })
}

/** The send sources of every row (a send from one of them is an attempt). */
export function turnAttemptSources(): ReadonlySet<string> {
  const out = new Set<string>()
  for (const row of each()) for (const s of row.sources) out.add(s)
  return out
}

let stopListening: (() => void) | null = null

/** On the primary: load the rows and start a new turn at every send that is not a retrier's. */
export async function startTurnRun(): Promise<{ stop: () => void }> {
  await loadTurnRetriers()
  stopListening?.()
  const name = 'turn-run'
  const handler = (event: BusEvent) => {
    if (event.name !== EventNames.SESSION_SEND && event.name !== EventNames.SESSION_MESSAGE_QUEUED) return
    const sid = (event.data as { sessionId?: string }).sessionId
    if (!sid || (event.source && turnAttemptSources().has(event.source))) return
    // At the event, before anything awaits: a held hand-back must not replay over the new turn.
    cancelHeldHandBack(sid)
    void newTurn(sid, Date.now())
  }
  bus.subscribe(name, handler, { global: true, interest: ['session:send', 'session:message-queued'] })
  const stop = () => { bus.unsubscribe(name); if (stopListening === stop) stopListening = null }
  stopListening = stop
  return { stop }
}

/** Tests: put a row in place of a reason's own (null: the reason's own row again, at the next load). */
export async function __setTurnRetrierForTesting<R extends TurnRetryReason>(reason: R, row: TurnRetrier<R> | null): Promise<void> {
  await loadTurnRetriers()
  if (row) (rows as Record<string, TurnRetrier>)[reason] = row as unknown as TurnRetrier
  else { delete (rows as Record<string, unknown>)[reason]; loading = null; await loadTurnRetriers() }
}

/** Tests: a shorter recheck clock for held hand-backs (null: the real one). */
export function __setHeldHandBackRecheckForTesting(ms: readonly number[] | null): void { recheckMs = ms ?? HELD_HANDBACK_RECHECK_MS }

/** Tests: forget the loaded rows. */
export function __resetTurnRunForTesting(): void {
  for (const h of heldHandBacks.values()) if (h.timer) clearTimeout(h.timer)
  heldHandBacks.clear()
  for (const k of Object.keys(rows)) delete (rows as Record<string, unknown>)[k]
  loading = null
  stopListening?.()
}
