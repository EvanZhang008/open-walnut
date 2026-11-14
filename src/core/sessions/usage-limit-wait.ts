/**
 * A turn the subscription's usage limit stopped (Claude Code's 5-hour or weekly window, Codex's
 * usage limit) continues by itself once the window resets (2026-11-04: every session of one
 * account stops at the same minute, and each one needed a person to type "continue" after the
 * reset).
 *
 *   turn ends limited ──► record.usageLimit {waiting, resetsAt, dueAt}   the task reads Waiting,
 *        │                    │                                           "Limited · resets 3:00 PM";
 *        │                    │ dueAt = the reset + 1 min + a spread      no error card, its lead is
 *        │                    ▼   per session (no reset known: 30 min,    not told it failed
 *        │                one continue (LIMIT_CONTINUE_TEXT)   1 h, 2 h, 4 h ...)
 *        │                (state resumed) ──► a clean turn closes the wait
 *        │                                └► limited again: waiting, with the new reset; the same
 *        │                                   reset again counts a try, and after 6 the user is asked
 *        ├► the user's "Don't auto-continue" (state off): Needs you, Continue now stays offered
 *        └► anyone else's message ends it: whoever sent it drives the session now
 *
 * Which turn ends it takes: an engine stamps `usageLimit` facts on session:result (Claude Code,
 * claude-code-session.ts) or session:error (an ACP engine, acp-session.ts); the words it reads are
 * providers/usage-limit-text.ts. The daemon's turn retry and auto-continue leave these turns alone
 * (daemon-core.ts classifyTurnError lists them as terminal).
 *
 * The wait lives on the session record (`usageLimit`, a field no status write touches), so a server
 * restart picks it up again. Primary only.
 */
import { bus, EventNames } from '../event-bus.js'
import type { BusEvent } from '../event-bus.js'
import type { SessionRecord, SessionUsageLimit, SessionUsageLimitContinued } from '../types.js'
import { log } from '../../logging/index.js'
import { AUTO_CONTINUE_SOURCE } from '../session-auto-continue.js'
import { frameAsWalnut } from './send-frame.js'
import { isQuietTurn } from './quiet-turn.js'
import { noteTurnAttempt, type TurnRetrier } from './turn-run.js'
import { isPersonSource } from './send-sent-by.js'
import { engineCaps, resolveEngine } from '../agents/engine-registry.js'
import { matchesUsageLimitText, parseUsageLimitReset } from '../../providers/usage-limit-text.js'
import {
  limitDueAt, limitName, limitSpreadMs, limitTimeWords, usageLimitTakes, usageLimitWaitEnabled,
  DEFAULT_LIMIT_TIMING, LIMIT_MAX_TRIES, LIMIT_MAX_WAIT_MS, type LimitTiming, type UsageLimitFacts,
} from './usage-limit-model.js'

/** The two events one message raises arrive within this of each other. */
const NOTE_SAME_MESSAGE_MS = 10_000
/** The bus source of the wait's own record events (never a send's: those are AUTO_CONTINUE_SOURCE). */
const LIMIT_EVENT_SOURCE = 'usage-limit-wait'

export { usageLimitTakes, usageLimitWaitEnabled, type UsageLimitFacts }

/** What the wait sends at the reset (the model reads it after its last turn). */
export const LIMIT_CONTINUE_TEXT = 'Your usage limit has reset. Continue the task from where you stopped.'

/** What the user's Continue now sends: the limit may not have reset yet, so it says no such thing. */
export const LIMIT_CONTINUE_NOW_TEXT = 'The user asked to continue now. Continue the task from where you stopped.'

/** A stop or a task change is looked at this soon after it (a burst of them is one look). */
const RECHECK_DELAY_MS = 1_500

/** Before the waiter writes its wait, a limited error is taken for one only this long. */
export const LIMIT_WAIT_OPENING_MS = 60_000

export interface UsageLimitWaitDeps {
  now: () => number
  setTimer: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>
  clearTimer: (h: ReturnType<typeof setTimeout>) => void
  getSession: (sid: string) => Promise<SessionRecord | null>
  listSessions: () => Promise<SessionRecord[]>
  /** Write the record's wait (null removes it). */
  patchWait: (sid: string, fn: (cur: SessionUsageLimit | undefined) => SessionUsageLimit | null) => Promise<void>
  send: (sid: string, text: string, opts: { source: string; taskId?: string }) => Promise<unknown>
  note: (sid: string, taskId: string | undefined, text: string) => void
  /** The host's last Claude limit reading: the reset of a window it reports rejected (epoch ms), if
   *  any (`host` undefined is this machine). */
  hostReset: (host: string | undefined) => Promise<{ resetsAt: number; window?: string } | null>
  /** The wait is the user's now (turned off, or gave up): its phase and error card. */
  handBack: (rec: SessionRecord, wait: SessionUsageLimit) => Promise<void>
  /** Why this session must not be continued now (a person stopped it, its task closed, its team was
   *  stopped), or null. */
  holdsOff: (rec: SessionRecord) => Promise<string | null>
  /** A person stopped the session while it waited: the turn end the wait held back (its phase, and
   *  so its lead's and askers' notices) happens now. */
  release: (rec: SessionRecord, why: string) => Promise<void>
  /** Write the record's continued note (null removes it). */
  setContinued: (sid: string, note: SessionUsageLimitContinued | null) => Promise<void>
}

export type UsageLimitAction = 'continue' | 'off' | 'auto' | 'dismiss'

export class UsageLimitWaiter {
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>()
  /** Sessions with a continue of ours on its way: its own send events are not someone else's. */
  private readonly sending = new Set<string>()
  private readonly rechecks = new Set<string>()

  private readonly t: LimitTiming

  constructor(private readonly deps: UsageLimitWaitDeps, timing: Partial<LimitTiming> = {}) {
    this.t = { ...DEFAULT_LIMIT_TIMING, ...timing }
  }

  private dueAt(w: SessionUsageLimit, sid: string, now: number): string {
    return new Date(limitDueAt(w, sid, now, now, this.t)).toISOString()
  }

  handleEvent = (event: BusEvent): void => {
    switch (event.name) {
      case EventNames.SESSION_RESULT:
      case EventNames.SESSION_ERROR: {
        const d = event.data as { sessionId?: string; usageLimit?: UsageLimitFacts; interrupted?: boolean; isError?: boolean; errorKind?: string; turnGen?: number }
        if (!d.sessionId) return
        // Walnut's own idle compaction (a quiet turn) is no work of the task's: the limit stopping
        // it opens no wait (there is nothing to continue), and its end closes none.
        if (isQuietTurn(d.sessionId, d.turnGen)) return
        if (usageLimitTakes(d)) { void this.onLimited(d.sessionId, d.usageLimit!); return }
        // A delivery failure is no turn end: the message is still queued, the wait stays.
        if (event.name === EventNames.SESSION_ERROR && d.errorKind === 'delivery_failed') return
        // Any other turn end closes the wait: a clean one ran, an interrupted one was stopped by
        // someone, another error is not this wait's.
        void this.end(d.sessionId, d.interrupted ? 'interrupted' : (d.isError || event.name === EventNames.SESSION_ERROR) ? 'other-error' : 'turn-ran')
        return
      }
      case EventNames.SESSION_SEND:
      case EventNames.SESSION_MESSAGE_QUEUED: {
        const sid = (event.data as { sessionId?: string }).sessionId
        if (!sid || event.source === AUTO_CONTINUE_SOURCE || this.sending.has(sid)) return
        void this.end(sid, 'someone-else-sent', 0, event.source)
        return
      }
      case EventNames.SESSION_STATUS_CHANGED: {
        // A stop of a waiting session: decide now, not at the reset (which may be days away).
        const sid = (event.data as { sessionId?: string }).sessionId
        if (sid && this.timers.has(sid)) this.recheck(sid)
        return
      }
      case EventNames.TASK_UPDATED:
      case EventNames.TASK_COMPLETED:
      case EventNames.TASK_DELETED:
        // A closed task, or a team stop or resume on it or above it: look at every open wait (few).
        for (const sid of this.timers.keys()) this.recheck(sid)
        return
      case EventNames.SESSION_DELETED: {
        const d = event.data as { sessionId?: string; sessionIds?: string[] }
        for (const sid of d.sessionIds ?? (d.sessionId ? [d.sessionId] : [])) this.stopTimer(sid)
        return
      }
      default:
        return
    }
  }

  /** After boot: pick up every wait a previous run left open. */
  async resumeOpen(): Promise<number> {
    let n = 0
    for (const rec of await this.deps.listSessions()) {
      const w = rec.usageLimit
      if (!w || rec.archived || (w.state !== 'waiting' && w.state !== 'resumed')) continue
      this.scheduleFor(rec.claudeSessionId, w, true)
      n++
    }
    if (n) log.session.info('usage-limit wait: picked up open waits after boot', { count: n })
    return n
  }

  stop(): void {
    for (const h of this.timers.values()) this.deps.clearTimer(h)
    this.timers.clear()
  }

  /** A person's (or an agent's) choice from the session: continue now, turn the auto-continue off, or on again. */
  async act(sid: string, action: UsageLimitAction): Promise<{ ok: true; usageLimit: SessionUsageLimit | null } | { ok: false; error: string }> {
    const rec = await this.deps.getSession(sid)
    if (!rec) return { ok: false, error: 'session not found' }
    if (action === 'dismiss') {
      if (rec.usageLimitContinued) await this.deps.setContinued(sid, null)
      return { ok: true, usageLimit: rec.usageLimit ?? null }
    }
    const w = rec.usageLimit
    if (!w) return { ok: false, error: 'this session is not stopped by a usage limit' }
    if (action === 'continue') {
      // Its continue went in already: its turn decides (a second continue would queue behind it).
      if (w.state === 'resumed') return { ok: false, error: 'it is already continuing' }
      await this.resume(rec, w, true)
      return { ok: true, usageLimit: (await this.deps.getSession(sid))?.usageLimit ?? null }
    }
    if (action === 'off') {
      if (w.state === 'off') return { ok: true, usageLimit: w }
      this.stopTimer(sid)
      const off: SessionUsageLimit = { ...w, state: 'off', offAt: new Date(this.deps.now()).toISOString() }
      delete off.dueAt
      if (!(await this.swap(sid, w, off))) return { ok: false, error: 'the wait changed meanwhile; look again' }
      log.session.info('usage-limit wait: auto-continue turned off', { sessionId: sid, taskId: rec.taskId })
      await this.deps.handBack(rec, off).catch((err) => {
        log.session.warn('usage-limit wait: hand-back failed', { sessionId: sid, error: err instanceof Error ? err.message : String(err) })
      })
      return { ok: true, usageLimit: off }
    }
    // 'auto': back on, from the time the reset names (or the backoff from now).
    if (w.state === 'waiting') return { ok: true, usageLimit: w }
    const now = this.deps.now()
    const base: SessionUsageLimit = { ...w, state: 'waiting', tries: 0 }
    delete base.offAt
    delete base.gaveUpAt
    const on: SessionUsageLimit = { ...base, dueAt: this.dueAt(base, sid, now) }
    if (!(await this.swap(sid, w, on))) return { ok: false, error: 'the wait changed meanwhile; look again' }
    log.session.info('usage-limit wait: auto-continue turned on', { sessionId: sid, taskId: rec.taskId, dueAt: on.dueAt })
    this.scheduleFor(sid, on)
    return { ok: true, usageLimit: on }
  }

  /** Look at a wait again soon (coalesced: a burst of task events is one look). */
  private recheck(sid: string): void {
    if (this.rechecks.has(sid)) return
    this.rechecks.add(sid)
    this.deps.setTimer(() => { this.rechecks.delete(sid); if (this.timers.has(sid)) void this.tick(sid) }, RECHECK_DELAY_MS)
  }

  private stopTimer(sid: string): void {
    const h = this.timers.get(sid)
    if (h) this.deps.clearTimer(h)
    this.timers.delete(sid)
  }

  private schedule(sid: string, ms: number): void {
    this.stopTimer(sid)
    // setTimeout holds at most ~24.8 days; a wait is never that long, but a bad clock must not wrap.
    const delay = Math.max(1_000, Math.min(ms, 2 ** 31 - 1))
    this.timers.set(sid, this.deps.setTimer(() => { this.timers.delete(sid); void this.tick(sid) }, delay))
  }

  /** `boot`: a wait a previous run left; one already due waits for the hosts to reconnect, spread
   *  per session as at the reset, instead of every overdue session continuing in the same second. */
  private scheduleFor(sid: string, w: SessionUsageLimit, boot = false): void {
    const floor = boot ? this.t.bootDelayMs + limitSpreadMs(sid, this.t) : 0
    if (w.state === 'resumed') { this.schedule(sid, Math.max(5_000, floor)); return }
    const due = w.dueAt ? Date.parse(w.dueAt) : NaN
    this.schedule(sid, Math.max(Number.isFinite(due) ? due - this.deps.now() : 5_000, floor))
  }

  private async onLimited(sid: string, facts: UsageLimitFacts): Promise<void> {
    try {
      const rec = await this.deps.getSession(sid)
      if (!rec || rec.archived) return
      const now = this.deps.now()
      const nowIso = new Date(now).toISOString()
      let resetsAt = facts.resetsAt
      let resetsFrom = facts.resetsFrom
      let window = facts.window
      if (!resetsAt || resetsAt <= now) {
        // The host's limit frame is the native CLI's own rate-limit event; an ACP engine has none.
        const host = engineCaps(facts.engine).runtimeKind === 'native' ? await this.deps.hostReset(rec.host).catch(() => null) : null
        if (host && host.resetsAt > now) { resetsAt = host.resetsAt; resetsFrom = 'host'; window = window ?? host.window }
      }
      const prior = rec.usageLimit
      // A wait the user turned off stays theirs until someone sends (which closes it first).
      if (prior?.state === 'off') return
      const open = prior && prior.state !== 'gave_up' ? prior : undefined
      const priorReset = open?.resetsAt ? Date.parse(open.resetsAt) : NaN
      // A continue that hit the limit again: a later reset is a new window to wait for (the 5-hour
      // window reset, then the weekly one stopped it); the same or none counts a try.
      const later = !!resetsAt && resetsAt > now && !(Number.isFinite(priorReset) && resetsAt <= priorReset + 60_000)
      const tries = open?.state === 'resumed' && !later ? (open.tries ?? 0) + 1 : (later ? 0 : open?.tries ?? 0)
      const base: SessionUsageLimit = {
        state: 'waiting',
        engine: facts.engine,
        ...(window ? { window } : {}),
        since: open?.since ?? nowIso,
        ...(resetsAt ? { resetsAt: new Date(resetsAt).toISOString(), resetsFrom } : {}),
        ...(facts.text ? { text: facts.text.slice(0, 300) } : {}),
        resumes: open?.resumes ?? 0,
        tries,
      }
      if (tries >= LIMIT_MAX_TRIES || now - Date.parse(base.since) > LIMIT_MAX_WAIT_MS) {
        await this.giveUp(rec, base)
        return
      }
      const next: SessionUsageLimit = { ...base, dueAt: this.dueAt(base, sid, now) }
      await this.deps.patchWait(sid, () => next)
      log.session.info('usage-limit wait: turn ended on the usage limit, waiting for the reset', {
        sessionId: sid, taskId: rec.taskId, engine: next.engine, window: next.window,
        resetsAt: next.resetsAt, resetsFrom: next.resetsFrom, dueAt: next.dueAt, tries: next.tries, resumes: next.resumes,
      })
      this.scheduleFor(sid, next)
    } catch (err) {
      log.session.warn('usage-limit wait: could not open the wait', { sessionId: sid, error: err instanceof Error ? err.message : String(err) })
    }
  }

  private async end(sid: string, why: string, attempt = 0, source?: string): Promise<void> {
    this.stopTimer(sid)
    try {
      const rec = await this.deps.getSession(sid)
      // Someone talked to it after the note was written: the note has said what it had to. One
      // message raises SESSION_SEND and SESSION_MESSAGE_QUEUED both, so the note a message just
      // wrote stays.
      const note = rec?.usageLimitContinued
      const fresh = note && (note.by === 'your-message' || note.by === 'message') && this.deps.now() - Date.parse(note.at) < NOTE_SAME_MESSAGE_MS
      if (why === 'someone-else-sent' && note && !fresh) await this.deps.setContinued(sid, null)
      if (!rec?.usageLimit) return
      // A wait that is the user's stays until someone sends (its words are their ask).
      if ((rec.usageLimit.state === 'off' || rec.usageLimit.state === 'gave_up') && why === 'other-error') return
      const held = rec.usageLimit.state === 'waiting' || rec.usageLimit.state === 'resumed'
      // Its continue (Walnut's, or the user's Continue now) ran its turn: the panel says it went
      // on, by whom and when, so a person coming back later reads why.
      const w = rec.usageLimit
      if (why === 'turn-ran' && w.state === 'resumed') {
        await this.deps.setContinued(sid, {
          at: w.resumedAt ?? new Date(this.deps.now()).toISOString(), by: w.resumedBy === 'user' ? 'user' : 'walnut', engine: w.engine,
          ...(w.window ? { window: w.window } : {}), ...(w.resetsAt ? { resetsAt: w.resetsAt } : {}),
          // Its Continue now came before the reset Walnut would have continued it at.
          ...(w.resumedEarly ? { autoCancelled: true } : {}),
        })
      }
      // A new message took it on before Walnut's continue: the panel says so, and that Walnut
      // will not continue it at the reset (without this the banner only vanished).
      if (why === 'someone-else-sent' && w.state !== 'resumed') {
        await this.deps.setContinued(sid, {
          at: new Date(this.deps.now()).toISOString(), by: isPersonSource(source) ? 'your-message' : 'message', engine: w.engine,
          ...(w.window ? { window: w.window } : {}), ...(w.resetsAt ? { resetsAt: w.resetsAt } : {}),
          ...(w.state === 'waiting' ? { autoCancelled: true } : {}),
        })
      }
      await this.deps.patchWait(sid, () => null)
      log.session.info('usage-limit wait: closed', { sessionId: sid, taskId: rec.taskId, why })
      if (why === 'person-stopped' && held && rec.process_status !== 'running') {
        await this.deps.release(rec, why).catch((err) => {
          log.session.warn('usage-limit wait: release failed', { sessionId: sid, error: err instanceof Error ? err.message : String(err) })
        })
      }
    } catch (err) {
      log.session.warn('usage-limit wait: close failed, trying again', { sessionId: sid, why, error: err instanceof Error ? err.message : String(err) })
      if (attempt < 5) this.timers.set(sid, this.deps.setTimer(() => { this.timers.delete(sid); void this.end(sid, why, attempt + 1) }, 30_000))
    }
  }

  private async tick(sid: string): Promise<void> {
    try {
      const rec = await this.deps.getSession(sid)
      const w = rec?.usageLimit
      if (!rec || rec.archived || !w) return
      if (w.state === 'off' || w.state === 'gave_up') return
      const off = await this.deps.holdsOff(rec)
      // A team stop holds the wait (team_resume lets it go on); anything else ends it.
      if (off === 'team-stopped') { this.schedule(sid, this.t.resumeCheckMs); return }
      if (off) { await this.end(sid, off); return }
      const now = this.deps.now()
      if (w.state === 'resumed') {
        // The continued turn runs: its own end closes or reopens the wait; look again later.
        if (rec.process_status === 'running') { this.schedule(sid, this.t.resumeCheckMs); return }
        // Its turn ended while this server was away (a restart missed the result): a clean end
        // closes the wait, an error that is not the limit is not this wait's, and the limit again
        // waits again below. Never a second continue for a turn that ran.
        const resumedAt = Date.parse(w.resumedAt ?? w.since)
        const movedAt = Date.parse(rec.last_status_change || rec.statusUpdatedAt || '')
        if (Number.isFinite(movedAt) && movedAt > resumedAt) {
          if (rec.process_status !== 'error') { await this.end(sid, 'turn-ran'); return }
          if (!matchesUsageLimitText(rec.errorMessage)) { await this.end(sid, 'other-error'); return }
        }
        // The continue started no turn by now (parked, or the session would not start): wait again.
        if (now - resumedAt < this.t.resumeCheckMs) { this.schedule(sid, this.t.resumeCheckMs); return }
        const again: SessionUsageLimit = { ...w, state: 'waiting', tries: (w.tries ?? 0) + 1 }
        delete again.resumedAt
        const next = { ...again, dueAt: this.dueAt(again, sid, now) }
        if (await this.swap(sid, w, next)) this.scheduleFor(sid, next)
        return
      }
      // A turn runs: someone else continued it, and its own end decides; look again in case it never ends.
      if (rec.process_status === 'running') { this.schedule(sid, this.t.resumeCheckMs); return }
      const due = w.dueAt ? Date.parse(w.dueAt) : NaN
      if (Number.isFinite(due) && due > now + 1_000) { this.schedule(sid, due - now); return }
      await this.resume(rec, w, false)
    } catch (err) {
      log.session.warn('usage-limit wait: check failed, trying again', { sessionId: sid, error: err instanceof Error ? err.message : String(err) })
      this.schedule(sid, this.t.resumeCheckMs)
    }
  }

  /** `manual`: the user's Continue now (any state); otherwise the clock's (waiting only). */
  private async resume(rec: SessionRecord, w: SessionUsageLimit, manual: boolean): Promise<void> {
    const sid = rec.claudeSessionId
    const next: SessionUsageLimit = {
      ...w, state: 'resumed', resumedAt: new Date(this.deps.now()).toISOString(), resumedBy: manual ? 'user' : 'walnut', resumes: (w.resumes ?? 0) + 1,
      ...(manual && w.state === 'waiting' && !!w.resetsAt && Date.parse(w.resetsAt) > this.deps.now() ? { resumedEarly: true } : {}),
    }
    delete next.dueAt
    delete next.offAt
    delete next.gaveUpAt
    // Only over the wait this tick read: a message that came in meanwhile closed it, and a closed
    // wait is never brought back with a continue behind that message.
    if (!(await this.swap(sid, w, next))) {
      log.session.info('usage-limit wait: changed meanwhile, no continue', { sessionId: sid, taskId: rec.taskId })
      return
    }
    this.sending.add(sid)
    try {
      if (!manual) {
        // A person may have stopped it, or closed its task, meanwhile.
        const off = await this.deps.holdsOff((await this.deps.getSession(sid)) ?? rec)
        if (off === 'team-stopped') { await this.swap(sid, next, w); this.schedule(sid, this.t.resumeCheckMs); return }
        if (off) { await this.end(sid, off); return }
      }
      // A message that came in while we looked closed the wait: no continue behind it.
      const cur = (await this.deps.getSession(sid))?.usageLimit
      if (cur?.state !== 'resumed' || cur.resumedAt !== next.resumedAt) {
        log.session.info('usage-limit wait: changed meanwhile, no continue', { sessionId: sid, taskId: rec.taskId })
        return
      }
      await this.sendContinue(rec, w, next, manual)
    } finally {
      this.sending.delete(sid)
    }
    this.schedule(sid, this.t.resumeCheckMs)
  }

  private async sendContinue(rec: SessionRecord, w: SessionUsageLimit, next: SessionUsageLimit, manual: boolean): Promise<void> {
    const sid = rec.claudeSessionId
    log.session.info('usage-limit wait: continuing the turn', {
      sessionId: sid, taskId: rec.taskId, engine: w.engine, resetsAt: w.resetsAt, manual, resumes: next.resumes, tries: w.tries,
    })
    const name = limitName(w)
    this.deps.note(sid, rec.taskId, manual
      ? `Continuing now, as you asked (the ${name} stopped it).`
      : w.resetsAt
        ? `The ${name} reset at ${limitTimeWords(w.resetsAt, this.deps.now())}: continuing where it left off.`
        : `Trying again after the ${name}: continuing where it left off.`)
    // The user's Continue now goes out on the same source (every automated-send rule knows it), but
    // its envelope names it as theirs, never "auto continue".
    const text = manual ? frameAsWalnut(LIMIT_CONTINUE_NOW_TEXT, AUTO_CONTINUE_SOURCE, 'your Continue now') : LIMIT_CONTINUE_TEXT
    await this.deps.send(sid, text, { source: AUTO_CONTINUE_SOURCE, ...(rec.taskId ? { taskId: rec.taskId } : {}) })
  }

  /** Write `next` only while the record still holds the wait `seen` (same state, same start). */
  private async swap(sid: string, seen: SessionUsageLimit, next: SessionUsageLimit): Promise<boolean> {
    let wrote = false
    await this.deps.patchWait(sid, (cur) => {
      if (!cur || cur.since !== seen.since || cur.state !== seen.state) return cur ?? null
      wrote = true
      return next
    })
    return wrote
  }

  private async giveUp(rec: SessionRecord, w: SessionUsageLimit): Promise<void> {
    const sid = rec.claudeSessionId
    const gave: SessionUsageLimit = { ...w, state: 'gave_up', gaveUpAt: new Date(this.deps.now()).toISOString() }
    delete gave.dueAt
    await this.deps.patchWait(sid, () => gave)
    log.session.warn('usage-limit wait: gave up', { sessionId: sid, taskId: rec.taskId, engine: w.engine, tries: w.tries, since: w.since })
    await this.deps.handBack(rec, gave).catch((err) => {
      log.session.warn('usage-limit wait: give-up hand-back failed', { sessionId: sid, error: err instanceof Error ? err.message : String(err) })
    })
  }
}

// ── What the status and the turn-end notices read ──

let instance: UsageLimitWaiter | null = null
let testTiming: Partial<LimitTiming> | null = null

/** Test-only: run the wait on a shorter clock (set before the server starts). */
export function __setUsageLimitWaitForTesting(opts: { timing?: Partial<LimitTiming> | null }): void {
  if ('timing' in opts) testTiming = opts.timing ?? null
}

export function getUsageLimitWaiter(): UsageLimitWaiter | null { return instance }

type LimitRecord = Pick<SessionRecord, 'process_status' | 'errorMessage' | 'usageLimit' | 'statusUpdatedAt' | 'last_status_change'>

/** A limited error the waiter has not written yet, inside the opening window (the result and the
 *  status sync race at a turn end). */
function openingLimit(rec: LimitRecord, now: number): boolean {
  if (!instance || rec.process_status !== 'error' || !matchesUsageLimitText(rec.errorMessage)) return false
  const at = Date.parse(rec.statusUpdatedAt || rec.last_status_change || '')
  return Number.isFinite(at) && now - at < LIMIT_WAIT_OPENING_MS
}

/**
 * A record whose last turn the wait holds: waiting, or its continue failed the same way (the waiter
 * reopens it), or a limited error the waiter is about to take. A continue whose turn ended cleanly
 * is no longer held, even before the waiter closes the wait (its notices are due).
 */
export function recordInUsageLimit(rec: LimitRecord | null | undefined, now: number = Date.now()): boolean {
  if (!rec || !usageLimitWaitEnabled()) return false
  const w = rec.usageLimit
  if (w?.state === 'off' || w?.state === 'gave_up') return false
  if (w?.state === 'waiting') return true
  // Its continue hit the limit again (the waiter reopens it). Another error is not this wait's: the
  // waiter closes it, and the turn end hands back (a held hand-back would have no one to let it go).
  if (w?.state === 'resumed') return rec.process_status === 'error' && matchesUsageLimitText(rec.errorMessage)
  return openingLimit(rec, now)
}

/** The record's wait as the status reads it (user-status-sync.ts). */
export function usageLimitOfRecord(rec: SessionRecord, now: number = Date.now()): SessionUsageLimit | undefined {
  if (!usageLimitWaitEnabled()) return undefined
  const w = rec.usageLimit
  if (w) return w.state === 'resumed' && rec.process_status !== 'error' ? undefined : w
  if (!openingLimit(rec, now)) return undefined
  const reset = parseUsageLimitReset(rec.errorMessage, now)
  return {
    state: 'waiting', engine: resolveEngine(rec.engine),
    since: rec.statusUpdatedAt || rec.last_status_change || new Date(now).toISOString(),
    ...(reset ? { resetsAt: new Date(reset).toISOString(), dueAt: new Date(reset).toISOString(), resetsFrom: 'text' as const } : {}),
    resumes: 0, tries: 0,
  }
}

/** The usage-limit wait's row of the session's turn (sessions/turn-run.ts). */
export const turnRetrier: TurnRetrier<'usage_limit'> = {
  reason: 'usage_limit',
  sources: [AUTO_CONTINUE_SOURCE],
  // Only while the waiter runs here: no one else would continue it.
  takes: (end) => !!instance && usageLimitTakes(end),
  wait: (rec) => {
    if (!recordInUsageLimit(rec)) return null
    const usageLimit = usageLimitOfRecord(rec)
    return usageLimit ? { reason: 'usage_limit', usageLimit } : null
  },
  stop: (rec) => usageLimitWaitEnabled() && (rec.usageLimit?.state === 'off' || rec.usageLimit?.state === 'gave_up')
    ? { reason: 'usage_limit', usageLimit: rec.usageLimit } : null,
}

// ── Wiring ──

function defaultDeps(handBack: UsageLimitWaitDeps['handBack']): UsageLimitWaitDeps {
  return {
    now: () => Date.now(),
    setTimer: (fn, ms) => { const h = setTimeout(fn, ms); h.unref?.(); return h },
    clearTimer: (h) => clearTimeout(h),
    getSession: async (sid) => (await import('../session-tracker.js')).getSessionByClaudeId(sid),
    listSessions: async () => (await import('../session-tracker.js')).listSessions(),
    patchWait: async (sid, fn) => {
      // A compare-and-set on the wait alone, as endpointWait is written (sessions/endpoint-wait.ts).
      const { getSessionByClaudeId, updateSessionRecordConditionally } = await import('../session-tracker.js')
      for (let i = 0; i < 4; i++) {
        const cur = await getSessionByClaudeId(sid)
        if (!cur) return
        const seen = JSON.stringify(cur.usageLimit ?? null)
        const next = fn(cur.usageLimit) ?? undefined
        if (JSON.stringify(next ?? null) === seen) return
        const written = await updateSessionRecordConditionally(sid, { usageLimit: next } as Partial<SessionRecord>,
          (current) => JSON.stringify(current.usageLimit ?? null) === seen, { preserveLastActiveAt: true })
        if (written) {
          // The session panel and the status sync read it live.
          bus.emit(EventNames.SESSION_USAGE_LIMIT, { sessionId: sid, taskId: written.taskId, usageLimit: written.usageLimit ?? null },
            ['web-ui', 'main-ai'], { source: LIMIT_EVENT_SOURCE })
          return
        }
      }
      throw new Error('usageLimit write kept racing')
    },
    send: async (sid, text, opts) => {
      await noteTurnAttempt(sid, 'usage_limit')
      return (await import('../session-message-queue.js')).sendMessageToSession(sid, text, opts)
    },
    setContinued: async (sid, note) => {
      const { updateSessionRecordConditionally } = await import('../session-tracker.js')
      const written = await updateSessionRecordConditionally(sid, { usageLimitContinued: note ?? undefined } as Partial<SessionRecord>,
        () => true, { preserveLastActiveAt: true })
      if (written) {
        bus.emit(EventNames.SESSION_USAGE_LIMIT, { sessionId: sid, taskId: written.taskId, usageLimit: written.usageLimit ?? null, continued: note },
          ['web-ui', 'main-ai'], { source: LIMIT_EVENT_SOURCE })
      }
    },
    note: (sid, taskId, message) => {
      bus.emit(EventNames.SESSION_SYSTEM_EVENT, { sessionId: sid, taskId, variant: 'info' as const, message },
        ['main-ai'], { source: AUTO_CONTINUE_SOURCE, urgency: 'urgent' })
    },
    hostReset: async (host) => {
      const { readSubscriptionLimits, limitHostKey } = await import('./subscription-limits.js')
      const [frame] = await readSubscriptionLimits(limitHostKey(host))
      const cur = frame?.current
      if (cur?.status !== 'rejected' || !cur.resetsAt) return null
      return { resetsAt: cur.resetsAt, ...(cur.type ? { window: cur.type } : {}) }
    },
    handBack,
    holdsOff: async (rec) => (await import('./endpoint-wait.js')).sessionWaitHoldsOff(rec),
    release: async (rec, why) => {
      if (!rec.taskId) return
      const { applySessionPhase } = await import('../phase.js')
      await applySessionPhase(rec.taskId, 'session:error', `usage-limit-wait:${why}`, { sessionId: rec.claudeSessionId, retryOver: true })
    },
  }
}

/** Start the waiter (primary only). `handBack` raises the session's error card the server owns. */
export function startUsageLimitWait(opts: {
  handBack?: (rec: SessionRecord, words: string) => Promise<void>
  /** Pick up the waits the records hold (false on an ephemeral server: its copied records are the
   *  real Walnut's sessions, and a continue there would drive them). */
  pickUp?: boolean
  deps?: Partial<UsageLimitWaitDeps>
} = {}): { stop: () => void; instance: UsageLimitWaiter } {
  const handBack: UsageLimitWaitDeps['handBack'] = async (rec, wait) => {
    if (rec.taskId) {
      const { applySessionPhase } = await import('../phase.js')
      await applySessionPhase(rec.taskId, 'session:error', `usage-limit-wait:${wait.state}`, { sessionId: rec.claudeSessionId, retryOver: true })
    }
    if (wait.state === 'gave_up') {
      const { limitAskWords } = await import('./usage-limit-model.js')
      await opts.handBack?.(rec, limitAskWords(wait, Date.now()))
    }
  }
  const waiter = new UsageLimitWaiter({ ...defaultDeps(handBack), ...opts.deps }, testTiming ?? {})
  instance = waiter
  bus.subscribe('session-usage-limit-wait', waiter.handleEvent, {
    global: true,
    interest: [
      'session:result', 'session:error', 'session:send', 'session:message-queued', 'session:deleted',
      'session:status-changed', 'task:updated', 'task:completed', 'task:deleted',
    ],
  })
  if (opts.pickUp !== false) void waiter.resumeOpen().catch(() => 0)
  return {
    stop: () => {
      bus.unsubscribe('session-usage-limit-wait')
      waiter.stop()
      if (instance === waiter) instance = null
    },
    instance: waiter,
  }
}
