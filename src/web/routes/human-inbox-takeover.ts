/**
 * The replica takeover of a letter turn (core/replica-takeover.ts): with the user's switch on and
 * the Mac silent for TAKEOVER_AFTER_MS, the companion hands a reply, or the option picked, straight
 * to the letter's session on its host (sessions/direct-host-send.ts, the path a phone's chat message
 * already takes there), then journals it as `inbox-reply-direct`: the Mac records it on the letter
 * when it drains and delivers nothing (offline-merge/apply-inbox-reply.ts).
 *
 * Taken over only when nothing can make it arrive twice or out of order:
 *  - the relay to the Mac provably did not go (the caller's word), no record of this turn is in the
 *    journal (a turn once held for the Mac stays the Mac's), and the Mac does not have it already
 *    (on the letter in this box's copy, or taken by a relay: noteRelayedTurn);
 *  - the Mac drains `inbox-reply-direct` (an older one would deliver it again);
 *  - no picture rides it (pictures go with the Mac, which saves them first);
 *  - the session runs on a host whose daemon is on this box's bridge, not on the Mac;
 *  - nothing earlier of that session waits: no letter turn held for the Mac, no chat message held
 *    here, no relayed message unseen on the host, no stop asked here unanswered (send-direct-gate.ts);
 *  - the session does not wait on a permission prompt (a letter's answer never answers one).
 * Every turn of a letter's session goes through one lock per session, in arrival order, and is
 * held (journaled for the Mac) inside it: a later turn never passes an earlier one, and a letter
 * is never answered twice in its session.
 *
 * A delivery whose answer was lost (it may have reached the CLI) is journaled as delivered but
 * unconfirmed: never sent again from this box, and the Mac records it as not confirmed. A delivery
 * the send ledger shows from before a restart, or whose record could not be written, is recorded,
 * never sent again, whatever the switch says (earlierDirectTurn).
 */
import fsp from 'node:fs/promises'
import path from 'node:path'
import type { LetterRecord } from '../../core/human-inbox/types.js'
import type { InboxReplyInput } from '../../core/companion-journal.js'
import type { AppendResult } from '../../providers/offline-journal-core.js'
import { log } from '../../logging/index.js'

const DIRECT_KIND = 'inbox-reply-direct'
/** Held letter turns of the Mac's, which a later one of the same session must not pass. */
const HELD_KINDS = new Set(['inbox-reply', 'inbox-reply-pictures'])
/** Left for the gate's questions (the Mac, the host's markers) out of the route's budget; the rest is the delivery's. */
const GATE_BUDGET_MS = 3_000
/** Below this much of the route's budget, the turn is held for the Mac instead (as before). */
const MIN_BUDGET_MS = 3_000
/** Left for the answer itself (the letter's reads) after the race against the route's deadline. */
const ANSWER_MARGIN_MS = 500
/** How long a turn the Mac took by relay is remembered here (the send ledger's horizon). */
const RELAYED_TTL_MS = 24 * 60 * 60_000

/** The answer a taken-over turn reads: in its session, or sent with its answer lost (or still going). */
export type DirectDelivery = { status: 'queued'; sessionId: string } | { status: 'pending' }
export type TakenTurn = { saved: AppendResult | null; delivery: DirectDelivery; inFlight?: true }
/** `answerInFlight`: another answer of the same letter is being handed to its session now (one answer per letter). */
export type LetterTurnOutcome = { taken: TakenTurn } | { held: AppendResult | null } | { answerInFlight: true }

const sessionLocks = new Map<string, Promise<unknown>>()
type Phase = 'queued' | 'taking' | 'started' | 'holding' | 'cancelled'
/** The settles of letter turns running now (waiting for their session's lock, or in it), in arrival order (`seq`). */
type Settle = { opId: string; letterId: string; op: 'reply' | 'answer'; seq: number; phase: () => Phase }
const inFlight = new Set<Settle>()
let settleSeq = 0
/** Settles that came before `seq` (every one, without it). */
const settlesBefore = (seq = Infinity): Settle[] => [...inFlight].filter((t) => t.seq < seq)
/**
 * Another answer of `letterId` (not `opId`) may reach its session now (deciding inside the lock, or
 * handed over): it is the one that counts. One still waiting for the lock never does: held behind
 * this one, it finds this one's record and is held too, and the Mac keeps the first.
 */
const answerAhead = (letterId: string, opId: string): boolean =>
  [...inFlight].some((t) => t.letterId === letterId && t.op === 'answer' && t.opId !== opId && (t.phase() === 'taking' || t.phase() === 'started'))
/** The same turn is being settled by a request that came first, which keeps it (unless another answer counts). */
const keptAhead = (input: InboxReplyInput, opId: string, seq?: number): boolean =>
  settlesBefore(seq).some((t) => t.opId === opId) && !(input.op === 'answer' && answerAhead(input.letterId, opId))

/** Tests: every letter turn running now has ended (a late delivery included), so the next test starts clean. */
export async function _letterTurnsSettledForTesting(): Promise<void> {
  while (sessionLocks.size > 0) await Promise.allSettled([...sessionLocks.values()])
}

async function underSessionLock<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
  const before = sessionLocks.get(sessionId) ?? Promise.resolve()
  const run = before.then(fn, fn)
  const tail = run.catch(() => {})
  sessionLocks.set(sessionId, tail)
  try {
    return await run
  } finally {
    if (sessionLocks.get(sessionId) === tail) sessionLocks.delete(sessionId)
  }
}

const messageIdOf = (opId: string): string => `ltr-${opId}`
/** The session a letter's turns go to (its sender), or null for one no session sent. */
export const originOf = (record: LetterRecord): string | null => {
  const sid = record.sender?.sessionId
  return sid && sid !== 'external' ? sid : null
}

// ── Turns the Mac took by relay ──

const relayedFile = async (): Promise<string> => path.join((await import('../../constants.js')).HUMAN_INBOX_QUEUE_DIR, 'relayed-turns.json')
let relayedWrite: Promise<void> = Promise.resolve()

/**
 * The Mac took this turn by relay (its answer came back ok): a retry is never taken over (it would
 * arrive twice), nor, for an answer, any other answer of that letter (the Mac keeps one per letter).
 */
export function noteRelayedTurn(opId: string, answerOf?: string): Promise<void> {
  relayedWrite = relayedWrite.then(async () => {
    const file = await relayedFile()
    const now = Date.now()
    const kept = Object.fromEntries(Object.entries(await readRelayed()).filter(([, at]) => now - at < RELAYED_TTL_MS))
    kept[opId] = now
    if (answerOf) kept[`answered:${answerOf}`] = now
    const { writeJsonFile } = await import('../../utils/fs.js')
    await fsp.mkdir(path.dirname(file), { recursive: true })
    await writeJsonFile(file, kept)
  }).catch((err: unknown) => {
    log.notif.warn('human-inbox replica: could not note a turn the Mac took', { opId, error: err instanceof Error ? err.message : String(err) })
  })
  return relayedWrite
}

async function readRelayed(): Promise<Record<string, number>> {
  try {
    const raw = JSON.parse(await fsp.readFile(await relayedFile(), 'utf8')) as Record<string, unknown>
    return Object.fromEntries(Object.entries(raw).filter((e): e is [string, number] => typeof e[1] === 'number'))
  } catch {
    return {}
  }
}

/** Whether the Mac already has this turn: on the letter in this box's copy, or taken by a relay. */
async function macHasTurn(letterId: string, input: InboxReplyInput, opId: string): Promise<boolean> {
  const relayed = await readRelayed()
  const fresh = (key: string): boolean => relayed[key] !== undefined && Date.now() - relayed[key] < RELAYED_TTL_MS
  if (fresh(opId) || (input.op === 'answer' && fresh(`answered:${letterId}`))) return true
  const { mirrorRecord } = await import('../../core/human-inbox/replica-state.js')
  const now = await mirrorRecord(letterId).catch(() => null)
  if (!now) return true
  if (input.op === 'reply') return now.thread.some((t) => t.from === 'human' && t.clientId === input.clientId)
  // One answer per letter: one the person gave (here or on the Mac) stands.
  return !!now.answered && !now.answered.by
}

// ── What this box already delivered ──

/** The delivery a journal record of this box's own delivery says, or null. */
function directRecordDelivery(r: Record<string, unknown>): DirectDelivery {
  const direct = r.direct as { sessionId?: unknown; unconfirmed?: unknown } | undefined
  if (direct?.unconfirmed === true || typeof direct?.sessionId !== 'string' || !direct.sessionId) return { status: 'pending' }
  return { status: 'queued', sessionId: direct.sessionId }
}

/**
 * A turn this box delivered (or is delivering) to its session: its journal record; a delivery in
 * flight; else the send ledger (a restart, or a journal write that failed, came between the
 * delivery and its record), then journaled now. Null: never delivered from here, or provably never
 * reached the CLI. Asked before any relay or hold, whatever the switch says: a turn in its session
 * is never relayed to the Mac or held for it.
 */
export async function earlierDirectTurn(record: LetterRecord, input: InboxReplyInput): Promise<TakenTurn | null> {
  const journal = await import('../../core/companion-journal.js')
  const opId = journal.inboxReplyOpId(input)
  const r = journal.companionJournalRecords().find((x) => x.opId === opId)
  if (r) return r.kind === DIRECT_KIND ? { saved: null, delivery: directRecordDelivery(r) } : null
  if (keptAhead(input, opId)) return { saved: null, delivery: { status: 'pending' }, inFlight: true }
  const sessionId = originOf(record)
  if (!sessionId) return null
  const messageId = messageIdOf(opId)
  const { readSendOutcome } = await import('../../core/send-outcomes.js')
  if (!(await readSendOutcome(sessionId, messageId))) return null
  const { takeoverHost } = await import('../../core/replica-takeover.js')
  const earlier = await earlierDelivery(sessionId, messageId, (await takeoverHost(sessionId, { lead: false }))?.host ?? null)
  if (earlier === 'none') return null
  log.notif.info('human-inbox replica: this letter turn went to its session before; recorded, not sent again', { letterId: record.id, sessionId, messageId, earlier })
  return recordDirect(record, input, { sessionId, messageId, unconfirmed: earlier === 'unconfirmed' })
}

/**
 * What the send ledger (send-outcomes.ts) says this box already did with the turn's delivery:
 * nothing (or provably nothing reached the CLI), delivered, or sent with its fate unknown. An
 * intent a restart interrupted is asked of the host (send-direct-gate.ts resolveDirectIntent).
 */
async function earlierDelivery(sessionId: string, messageId: string, host: string | null): Promise<'none' | 'delivered' | 'unconfirmed'> {
  const outcomes = await import('../../core/send-outcomes.js')
  const prior = await outcomes.readSendOutcome(sessionId, messageId)
  if (!prior || prior.state === 'withdrawn' || prior.state === 'not-sent') return 'none'
  if (prior.state === 'delivered-direct') return 'delivered'
  if (prior.state === 'direct-intent' && host) {
    const { resolveDirectIntent } = await import('../../core/send-direct-gate.js')
    const fate = await resolveDirectIntent({ host, sessionId, messageId }, prior)
    if (fate === 'delivered') return 'delivered'
    if (fate === 'not-delivered') { await outcomes.clearDirectIntent(sessionId, messageId); return 'none' }
  }
  // maybe-direct, an intent nobody could resolve, or any other state a delivery of it left: it may have run.
  return 'unconfirmed'
}

/** The turn journaled as delivered here (`inbox-reply-direct`): the Mac records it and sends nothing. */
async function recordDirect(
  record: LetterRecord, input: InboxReplyInput, d: { sessionId: string; messageId: string; unconfirmed: boolean },
): Promise<TakenTurn> {
  const journal = await import('../../core/companion-journal.js')
  const saved = journal.journalInboxReply({ ...input, direct: { sessionId: d.sessionId, messageId: d.messageId, at: Date.now(), ...(d.unconfirmed ? { unconfirmed: true as const } : {}) } })
  if (!saved?.ok) {
    // In the session (or maybe), and the Mac will not see it on the letter: said loudly; the
    // send ledger keeps a retry from sending it again (earlierDirectTurn).
    log.notif.error('human-inbox replica: a turn went to its session but could not be journaled for the Mac', { letterId: record.id, sessionId: d.sessionId, messageId: d.messageId, op: input.op })
  }
  return { saved, delivery: d.unconfirmed ? { status: 'pending' } : { status: 'queued', sessionId: d.sessionId } }
}

// ── The takeover ──

/** A letter turn of `sessionId` the journal still holds for the Mac: a later one must wait behind it. */
async function heldTurnOfSession(sessionId: string): Promise<boolean> {
  const { companionJournalRecords, macDrains } = await import('../../core/companion-journal.js')
  // One of a kind the Mac no longer drains (an older release) is no turn it will deliver first.
  const held = companionJournalRecords().filter((r) => HELD_KINDS.has(r.kind) && macDrains(r.kind))
  if (held.length === 0) return false
  const { mirrorRecord } = await import('../../core/human-inbox/replica-state.js')
  const letters = new Map<string, string | undefined>()
  for (const r of held) {
    const letterId = typeof r.letterId === 'string' ? r.letterId : ''
    if (!letters.has(letterId)) letters.set(letterId, (await mirrorRecord(letterId).catch(() => null))?.sender?.sessionId)
    const origin = letters.get(letterId)
    // A letter the copy no longer shows: its session cannot be told, so it may be this one.
    if (origin === undefined || origin === sessionId) return true
  }
  return false
}

/**
 * A turn this box still holds for the Mac that a new turn of `record` must follow: any turn of
 * the same letter (the Mac writes a letter's turns in the order it gets them, one delivered here
 * included), or one of the same session not delivered yet. Relayed instead, the new turn would
 * reach the Mac, and the session, ahead of it: it is held behind it (human-inbox-replica.ts).
 */
export async function heldAheadOf(record: LetterRecord): Promise<boolean> {
  const { companionJournalRecords, INBOX_TURN_KINDS, macDrains } = await import('../../core/companion-journal.js')
  // A record of a kind the Mac no longer drains (an older release) is no turn the Mac will see first.
  if (companionJournalRecords().some((r) => INBOX_TURN_KINDS.includes(r.kind) && r.letterId === record.id && macDrains(r.kind))) return true
  const sessionId = originOf(record)
  return sessionId ? heldTurnOfSession(sessionId) : false
}

/** The words the session gets: the Mac's own wrapper for this turn (letter-ops.ts buildLetterDeliveryText). */
async function deliveryText(record: LetterRecord, input: InboxReplyInput): Promise<string> {
  const { buildLetterDeliveryText } = await import('../../core/human-inbox/letter-ops.js')
  const { boundThreadText } = await import('../../core/human-inbox/store.js')
  if (input.op === 'reply') {
    const { leaderExperimentOn } = await import('../../core/replica-takeover.js')
    return buildLetterDeliveryText(record, { text: boundThreadText(input.text), wordsLine: await leaderExperimentOn('threads_one_card') })
  }
  const action = record.actions?.find((a) => a.id === input.actionId)
  const note = boundThreadText(input.freeText ?? '')
  // The user's answer over one a task gave for them: the session is told this one stands.
  const replaces = record.answered?.by
  return buildLetterDeliveryText(record, {
    choice: action?.label ?? input.actionId, ...(note ? { text: note } : {}), ...(replaces ? { replaces } : {}),
  })
}

/**
 * Settle one person's turn on a letter here while the Mac is away: hand it to its session
 * (`taken`), or hold it for the Mac (`held`: `hold` journals it, the route's own way, pictures
 * included), inside the session's lock. `mayTakeOver`: the relay provably did not go and no
 * picture rides it. `waiting`: the journal already holds a record of this turn. `budgetMs`: what
 * is left of the route's deadline for this (the route keeps its own margin for pictures).
 *
 * At the deadline: a delivery that started answers `pending` and keeps going (its end journals it,
 * handed over or held). A turn that has not started is held at once, so a `pending` answer always
 * has its turn on disk; unless a request that came first settles the same turn (answered `pending`,
 * that one keeps it), or another answer of the same letter may reach the session now (`answerInFlight`:
 * one answer per letter, the first stands, as on the Mac).
 */
export async function settleLetterTurn(
  record: LetterRecord,
  input: InboxReplyInput,
  opts: { budgetMs: number; mayTakeOver: boolean; waiting: () => boolean; hold: () => Promise<AppendResult | null> },
): Promise<LetterTurnOutcome> {
  const sessionId = originOf(record)
  if (!sessionId) return { held: await opts.hold() }
  const journal = await import('../../core/companion-journal.js')
  const opId = journal.inboxReplyOpId(input)
  const deadline = Date.now() + opts.budgetMs - ANSWER_MARGIN_MS
  // queued: waiting for the lock; taking: deciding; started: a delivery may be out; holding: in hold().
  const state = {
    phase: 'queued' as Phase,
    late: false,
    /** A cancelled turn's hold, written outside the lock: its run keeps the lock until it is on disk. */
    outerHold: null as Promise<unknown> | null,
  }
  // Read through a call: the phase moves in other callbacks while this one awaits.
  const phase = (): typeof state.phase => state.phase
  const mayStart = (): boolean => { if (state.phase === 'cancelled') return false; state.phase = 'started'; return true }
  const me: Settle = { opId, letterId: record.id, op: input.op, seq: ++settleSeq, phase }
  inFlight.add(me)
  /** Nothing more of a cancelled turn: once its hold is on disk, the session's next turn may go. */
  const cancelledEnd = async (): Promise<null> => { await state.outerHold; return null }
  const hold = async (): Promise<LetterTurnOutcome | null> => {
    if (state.phase === 'cancelled') return cancelledEnd()
    state.phase = 'holding'
    return { held: await opts.hold() }
  }
  const run = underSessionLock(sessionId, async (): Promise<LetterTurnOutcome | null> => {
    try {
      if (state.phase === 'cancelled') return await cancelledEnd()
      if (!opts.mayTakeOver || opts.budgetMs < MIN_BUDGET_MS) return await hold()
      state.phase = 'taking'
      let taken: TakenTurn | null = null
      try {
        taken = await handOver(record, input, { sessionId, opId, deadline, waiting: opts.waiting, mayStart })
      } catch (err) {
        log.notif.error('human-inbox replica: a direct letter turn failed', { letterId: record.id, opId, error: err instanceof Error ? err.message : String(err) })
        // A delivery that may be out is never sent again, nor held for the Mac to send.
        if (phase() === 'started') taken = await recordDirect(record, input, { sessionId, messageId: messageIdOf(opId), unconfirmed: true })
      }
      if (taken) return { taken }
      if (state.late) {
        // It did not go after all, and the phone was told pending: held for the Mac now.
        const saved = journal.journalInboxReply(input)
        if (!saved?.ok) log.notif.error('human-inbox replica: a letter turn that did not go could not be kept for the Mac', { letterId: record.id, opId, op: input.op })
        return { held: saved }
      }
      return await hold()
    } finally {
      inFlight.delete(me)
    }
  })
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<'deadline'>((resolve) => { timer = setTimeout(() => resolve('deadline'), Math.max(0, deadline - Date.now())) })
  const raced = await Promise.race([run, late]).finally(() => clearTimeout(timer))
  if (raced !== 'deadline' && raced !== null) return raced
  // Its hold is being written: that is the answer.
  if (phase() === 'holding') return (await run) ?? { held: null }
  if (phase() === 'started') {
    state.late = true
    log.notif.info('human-inbox replica: a direct letter turn is still out at the answer deadline; it keeps going', { letterId: record.id, sessionId, opId })
    void run.catch((err: unknown) => {
      log.notif.error('human-inbox replica: a late direct letter turn failed', { letterId: record.id, opId, error: err instanceof Error ? err.message : String(err) })
    })
    return { taken: { saved: null, delivery: { status: 'pending' }, inFlight: true } }
  }
  // Nothing went out (still waiting behind an earlier turn of the session, or deciding): from here
  // the run sends and holds nothing.
  state.phase = 'cancelled'
  inFlight.delete(me)
  // An answer that may reach the session wins over this one (one answer per letter); a request
  // that came first for this same turn keeps it.
  if (input.op === 'answer' && answerAhead(record.id, opId)) return { answerInFlight: true }
  if (keptAhead(input, opId, me.seq)) return { taken: { saved: null, delivery: { status: 'pending' }, inFlight: true } }
  log.notif.info('human-inbox replica: a letter turn was not settled in time behind its session; held for the Mac', { letterId: record.id, sessionId, opId })
  const outer = opts.hold()
  state.outerHold = outer.catch(() => null)
  return { held: await outer }
}

/** The takeover itself, inside the session's lock (settleLetterTurn); null: hold it for the Mac. */
async function handOver(
  record: LetterRecord,
  input: InboxReplyInput,
  ctx: { sessionId: string; opId: string; deadline: number; waiting: () => boolean; mayStart: () => boolean },
): Promise<TakenTurn | null> {
  const { sessionId, opId } = ctx
  const journal = await import('../../core/companion-journal.js')
  if (input.pictures?.length || !journal.macDrains(DIRECT_KIND) || ctx.waiting()) return null
  const { takeoverState, takeoverHost } = await import('../../core/replica-takeover.js')
  if (!(await takeoverState()).on) return null
  // Read again inside the lock: an earlier turn of the session may have answered the letter.
  if (await macHasTurn(record.id, input, opId)) return null
  const messageId = messageIdOf(opId)
  const target = await takeoverHost(sessionId)
  const earlier = await earlierDelivery(sessionId, messageId, target?.host ?? null)
  if (earlier !== 'none') {
    // Claimed like a delivery: at the deadline it reads as in flight, never held beside it.
    if (!ctx.mayStart()) return null
    return recordDirect(record, input, { sessionId, messageId, unconfirmed: earlier === 'unconfirmed' })
  }
  if (!target) return null
  if (await heldTurnOfSession(sessionId)) {
    log.notif.info('human-inbox replica: an earlier letter turn of the session waits for the Mac; this one waits too', { letterId: record.id, sessionId })
    return null
  }
  const { sessionHasBankedSend } = await import('../../core/send-queue.js')
  if (await sessionHasBankedSend(sessionId)) return null
  const { directDeliveryGate } = await import('../../core/send-direct-gate.js')
  const gate = await directDeliveryGate({ opId, host: target.host, sessionId, messageId }, { mayBeOnMac: false, budgetMs: Math.min(GATE_BUDGET_MS, Math.max(0, ctx.deadline - Date.now())) })
  if (gate !== 'go') {
    log.notif.info('human-inbox replica: the session is not free for a direct turn; held for the Mac', { letterId: record.id, sessionId, gate })
    return null
  }
  const { latestKnownStop } = await import('../../core/sessions/cloud-stop-fence.js')
  const stop = await latestKnownStop(sessionId, target.stopRequest)
  if (stop?.state === 'pending') return null
  const { deliverDirectToHost } = await import('../../core/sessions/direct-host-send.js')
  const sent = await deliverDirectToHost({
    host: target.host, sessionId, messageId, text: await deliveryText(record, input), stopFence: stop?.id ?? null,
    acceptedAt: input.madeAt, holdOnPrompt: true, mayStart: ctx.mayStart,
    ...(target.cwd ? { cwd: target.cwd } : {}), ...(target.model ? { model: target.model } : {}),
  })
  const ambiguous = !sent.ok && sent.kind === 'transport' && sent.ambiguous
  if (!sent.ok && !ambiguous) {
    log.notif.info('human-inbox replica: a direct turn did not go; held for the Mac', { letterId: record.id, sessionId, host: target.host, why: sent.message })
    return null
  }
  const { markSendOutcome } = await import('../../core/send-outcomes.js')
  await markSendOutcome(sessionId, messageId, sent.ok ? 'delivered-direct' : 'maybe-direct', sent.ok ? {} : { code: 'delivery_unknown', message: sent.message })
    .catch((err: unknown) => log.notif.warn('human-inbox replica: the send ledger could not record a direct letter turn', { sessionId, messageId, error: err instanceof Error ? err.message : String(err) }))
  log.notif.info('human-inbox replica: a letter turn handed to its session (Mac away, replica takeover)', {
    letterId: record.id, op: input.op, sessionId, host: target.host, messageId, ...(ambiguous ? { unconfirmed: true } : {}), ...(sent.ok ? { path: sent.path } : {}),
  })
  return recordDirect(record, input, { sessionId, messageId, unconfirmed: ambiguous })
}
