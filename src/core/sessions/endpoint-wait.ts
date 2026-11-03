/**
 * A turn that ended because its machine could not reach the model endpoint waits for that endpoint
 * and continues by itself once it answers (2026-11-03, the user's lead: the Mac's local model proxy
 * stopped with its login session, eight sessions ended on "Connection refused", and every task read
 * Needs you for the user to press Retry). Which errors count: sessions/endpoint-unreachable.ts.
 *
 *   turn ends unreachable ──► record.endpointWait {waiting}       the task reads Waiting on its machine
 *        │                      │                                  (user-status.ts), no error card, its
 *        │                      ▼                                  lead is not told it failed
 *        │                  probe the host's daemon ('model-endpoint-v1', host.endpoint)
 *        │                  every 30 s for 10 minutes, then every 2 minutes
 *        │                      │ reached
 *        │                      ▼
 *        │                  one "continue" (state resumed) ──► a clean turn clears the wait
 *        │                                                   └► unreachable again: waiting, resumes+1
 *        └► 6 hours without an answer, or 3 continues that ended unreachable again:
 *           gave_up: Needs you, naming the machine and the endpoint (the session's error card too)
 *
 * A refused connection never reached the model, so nothing here spends tokens while the endpoint is
 * down, and no failed "continue" piles up in the chat. A daemon without 'model-endpoint-v1' gets a
 * continue on a timer instead (3, 15, 60 and 180 minutes after the first failure). Anyone else's
 * message to the session ends the wait: whoever sent it drives the session now, and a turn it starts
 * that fails the same way opens a new one.
 *
 * The wait lives on the session record (`endpointWait`, a field no status write touches), so a
 * server restart (the reboot that usually brings the endpoint back) picks it up again. Primary only.
 */
import os from 'node:os'
import { bus, EventNames } from '../event-bus.js'
import type { BusEvent } from '../event-bus.js'
import type { SessionRecord, SessionEndpointWait } from '../types.js'
import { log } from '../../logging/index.js'
import { classifyTurnError } from '../../providers/daemon-core.js'
import { matchesEndpointUnreachable, endpointWaitEnabled, endpointGaveUpWords } from './endpoint-unreachable.js'

export { endpointWaitEnabled, endpointGaveUpWords }
import { AUTO_CONTINUE_SOURCE } from '../session-auto-continue.js'

export type { SessionEndpointWait }

/** How long a session waits for its endpoint before the user is asked. */
export const ENDPOINT_WAIT_MAX_MS = 6 * 60 * 60_000
/** First look after the failed turn: the CLI may still be settling its own retries. */
export const ENDPOINT_FIRST_PROBE_MS = 15_000
/** Continues that ended unreachable again before the wait gives up (the probe and the CLI disagree). */
export const ENDPOINT_WAIT_MAX_RESUMES = 3
/** Probe cadence: often while a blip is likely, then calmly. */
export const ENDPOINT_PROBE_FAST_MS = 30_000
export const ENDPOINT_PROBE_FAST_FOR_MS = 10 * 60_000
export const ENDPOINT_PROBE_SLOW_MS = 2 * 60_000
/** A daemon that cannot probe: continue at these offsets from the first failure. */
export const ENDPOINT_BLIND_TRIES_MS: readonly number[] = [3, 15, 60, 180].map((m) => m * 60_000)
/** A continue that started no turn by then (it was parked, the session would not start) goes back to waiting. */
export const ENDPOINT_RESUME_CHECK_MS = 5 * 60_000


/** The fields of a session:result this module reads. */
export interface EndpointResultFacts {
  isError?: boolean
  result?: string | null
  teamActive?: boolean
  backgroundActive?: boolean
  detachedBgActive?: boolean
  wakeupPending?: boolean
}

/** The error text says the endpoint was never reached (and it is no terminal error). */
export function isEndpointUnreachableError(text: string | null | undefined): boolean {
  return !!text && classifyTurnError(text) === 'retryable' && matchesEndpointUnreachable(text)
}

/**
 * This result is a turn the endpoint wait takes over: an error that never reached the model, at a
 * real turn end (no team, background work or wakeup carries the session on). Pure and synchronous,
 * so the result handler (web/server.ts) and the hooks decide the same thing as the waiter.
 */
export function endpointWaitTakes(r: EndpointResultFacts): boolean {
  if (!endpointWaitEnabled() || !r.isError) return false
  if (r.teamActive || r.backgroundActive || r.detachedBgActive || r.wakeupPending) return false
  return isEndpointUnreachableError(r.result)
}

/** A record whose last turn the wait holds: its error is unreachable, or its wait is open. */
export function recordInEndpointWait(rec: Pick<SessionRecord, 'process_status' | 'errorMessage' | 'endpointWait'> | null | undefined): boolean {
  if (!rec || !endpointWaitEnabled()) return false
  if (rec.endpointWait) return rec.endpointWait.state !== 'gave_up'
  return rec.process_status === 'error' && isEndpointUnreachableError(rec.errorMessage)
}

/** The machine a session runs on, in the words a person reads. */
export function machineWords(host: string | undefined): string {
  if (!host || host === '__local__') return os.platform() === 'darwin' ? 'this Mac' : 'this machine'
  return host
}

export type EndpointProbeAnswer =
  | { kind: 'probed'; url: string; probed: string; reachable: boolean; error?: string }
  | { kind: 'unsupported' }
  | { kind: 'offline' }

export interface EndpointWaitDeps {
  now: () => number
  setTimer: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>
  clearTimer: (h: ReturnType<typeof setTimeout>) => void
  getSession: (sid: string) => Promise<SessionRecord | null>
  listSessions: () => Promise<SessionRecord[]>
  /** Write the record's wait (null removes it); returns the record after. */
  patchWait: (sid: string, fn: (cur: SessionEndpointWait | undefined) => SessionEndpointWait | null) => Promise<void>
  probe: (host: string, cwd: string | undefined) => Promise<EndpointProbeAnswer>
  send: (sid: string, text: string, opts: { source: string; taskId?: string }) => Promise<unknown>
  note: (sid: string, taskId: string | undefined, text: string) => void
  /** The wait gave up: the session's failure is the user's now (phase, error card). */
  gaveUp: (rec: SessionRecord, wait: SessionEndpointWait, words: string) => Promise<void>
}

const CONTINUE_TEXT = 'continue'

/** The clock the waiter runs on (a test shortens it). */
export interface EndpointWaitTiming {
  maxWaitMs: number; firstMs: number; fastMs: number; fastForMs: number; slowMs: number; blindTriesMs: readonly number[]; resumeCheckMs: number
}
const DEFAULT_TIMING: EndpointWaitTiming = {
  maxWaitMs: ENDPOINT_WAIT_MAX_MS, firstMs: ENDPOINT_FIRST_PROBE_MS, fastMs: ENDPOINT_PROBE_FAST_MS,
  fastForMs: ENDPOINT_PROBE_FAST_FOR_MS, slowMs: ENDPOINT_PROBE_SLOW_MS, blindTriesMs: ENDPOINT_BLIND_TRIES_MS,
  resumeCheckMs: ENDPOINT_RESUME_CHECK_MS,
}

export class EndpointWaiter {
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>()
  /** Sessions with a continue of ours on its way: its own send events are not someone else's. */
  private readonly sending = new Set<string>()

  private readonly t: EndpointWaitTiming

  constructor(private readonly deps: EndpointWaitDeps, timing: Partial<EndpointWaitTiming> = {}) {
    this.t = { ...DEFAULT_TIMING, ...timing }
  }

  handleEvent = (event: BusEvent): void => {
    switch (event.name) {
      case EventNames.SESSION_RESULT: {
        const d = event.data as EndpointResultFacts & { sessionId?: string; taskId?: string; interrupted?: boolean }
        if (!d.sessionId || d.interrupted) return
        if (endpointWaitTakes(d)) { void this.onUnreachable(d.sessionId, d.result ?? ''); return }
        // Any other real turn end closes the wait: it ran, or it failed for a reason of its own.
        if (!d.teamActive && !d.backgroundActive) void this.end(d.sessionId, d.isError ? 'other-error' : 'turn-ran')
        return
      }
      case EventNames.SESSION_SEND:
      case EventNames.SESSION_MESSAGE_QUEUED: {
        const sid = (event.data as { sessionId?: string }).sessionId
        if (!sid || event.source === AUTO_CONTINUE_SOURCE || this.sending.has(sid)) return
        void this.end(sid, 'someone-else-sent')
        return
      }
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
      const w = rec.endpointWait
      if (!w || w.state === 'gave_up' || rec.archived) continue
      this.schedule(rec.claudeSessionId, Math.min(5_000, this.t.firstMs))
      n++
    }
    if (n) log.session.info('endpoint wait: picked up open waits after boot', { count: n })
    return n
  }

  stop(): void {
    for (const h of this.timers.values()) this.deps.clearTimer(h)
    this.timers.clear()
  }

  private stopTimer(sid: string): void {
    const h = this.timers.get(sid)
    if (h) this.deps.clearTimer(h)
    this.timers.delete(sid)
  }

  private schedule(sid: string, ms: number): void {
    this.stopTimer(sid)
    this.timers.set(sid, this.deps.setTimer(() => { this.timers.delete(sid); void this.tick(sid) }, ms))
  }

  private async onUnreachable(sid: string, text: string): Promise<void> {
    try {
      const rec = await this.deps.getSession(sid)
      if (!rec || rec.archived) return
      const nowIso = new Date(this.deps.now()).toISOString()
      const prior = rec.endpointWait
      const open = prior && prior.state !== 'gave_up' ? prior : undefined
      const next: SessionEndpointWait = {
        state: 'waiting',
        since: open?.since ?? nowIso,
        host: rec.host || '__local__',
        where: machineWords(rec.host),
        resumes: open?.resumes ?? 0,
        ...(open?.blindTries ? { blindTries: open.blindTries } : {}),
        ...(open?.url ? { url: open.url } : {}),
        error: text.slice(0, 200),
      }
      if (next.resumes >= ENDPOINT_WAIT_MAX_RESUMES) {
        await this.giveUp(rec, next, 'resumes')
        return
      }
      await this.deps.patchWait(sid, () => next)
      log.session.info('endpoint wait: turn ended unreachable, waiting for the endpoint', {
        sessionId: sid, taskId: rec.taskId, host: next.host, since: next.since, resumes: next.resumes,
      })
      this.schedule(sid, prior?.state === 'resumed' ? this.t.fastMs : this.t.firstMs)
    } catch (err) {
      log.session.warn('endpoint wait: could not open the wait', { sessionId: sid, error: err instanceof Error ? err.message : String(err) })
    }
  }

  private async end(sid: string, why: string): Promise<void> {
    this.stopTimer(sid)
    try {
      const rec = await this.deps.getSession(sid)
      if (!rec?.endpointWait) return
      // A gave-up wait stays until someone else's message (its words are the user's ask).
      if (rec.endpointWait.state === 'gave_up' && why === 'other-error') return
      await this.deps.patchWait(sid, () => null)
      log.session.info('endpoint wait: closed', { sessionId: sid, taskId: rec.taskId, why })
    } catch { /* the next result or send tries again */ }
  }

  private async tick(sid: string): Promise<void> {
    try {
      const rec = await this.deps.getSession(sid)
      let w = rec?.endpointWait
      if (!rec || rec.archived || !w || w.state === 'gave_up') return
      if (w.state === 'resumed') {
        // The continued turn runs: its own end closes or reopens the wait; look again later.
        if (rec.process_status === 'running') { this.schedule(sid, this.t.resumeCheckMs); return }
        // The continue started no turn: wait and probe again, counts kept.
        if (this.deps.now() - Date.parse(w.resumedAt ?? w.since) < this.t.resumeCheckMs) { this.schedule(sid, this.t.resumeCheckMs); return }
        w = { ...w, state: 'waiting' }
        await this.deps.patchWait(sid, (cur) => cur && cur.state === 'resumed' ? { ...cur, state: 'waiting' } : cur ?? null)
      }
      // A turn runs: someone else resumed it, and its own end decides.
      if (rec.process_status === 'running') return
      const now = this.deps.now()
      const elapsed = now - Date.parse(w.since)
      if (!(elapsed < this.t.maxWaitMs)) { await this.giveUp(rec, w, 'time'); return }

      const answer = await this.deps.probe(w.host, rec.cwd || undefined)
      const checkedAt = new Date(this.deps.now()).toISOString()
      if (answer.kind === 'probed') {
        if (answer.reachable) { await this.resume(rec, { ...w, url: answer.url, checkedAt }, false); return }
        await this.deps.patchWait(sid, (cur) => cur && cur.state === 'waiting'
          ? { ...cur, url: answer.url, probed: answer.probed, checkedAt, ...(answer.error ? { probeError: answer.error } : {}) }
          : cur ?? null)
        this.schedule(sid, elapsed < this.t.fastForMs ? this.t.fastMs : this.t.slowMs)
        return
      }
      if (answer.kind === 'offline') {
        // Its host is away: that is a machine stop of its own; look again calmly.
        this.schedule(sid, this.t.slowMs)
        return
      }
      // An older daemon cannot probe: continue on a timer.
      const tries = w.blindTries ?? 0
      const due = this.t.blindTriesMs[tries]
      if (due === undefined) { this.schedule(sid, Math.max(1_000, this.t.maxWaitMs - elapsed)); return }
      if (elapsed >= due) { await this.resume(rec, { ...w, blindTries: tries + 1, checkedAt }, true); return }
      this.schedule(sid, due - elapsed)
    } catch (err) {
      log.session.warn('endpoint wait: check failed, trying again', { sessionId: sid, error: err instanceof Error ? err.message : String(err) })
      this.schedule(sid, this.t.slowMs)
    }
  }

  private async resume(rec: SessionRecord, w: SessionEndpointWait, blind: boolean): Promise<void> {
    const sid = rec.claudeSessionId
    const next: SessionEndpointWait = {
      ...w, state: 'resumed', resumedAt: new Date(this.deps.now()).toISOString(),
      resumes: blind ? w.resumes : w.resumes + 1,
    }
    await this.deps.patchWait(sid, () => next)
    log.session.info('endpoint wait: endpoint answers, continuing the turn', {
      sessionId: sid, taskId: rec.taskId, host: w.host, url: w.url, blind, resumes: next.resumes,
    })
    this.deps.note(sid, rec.taskId, blind
      ? `Trying the model endpoint again on ${w.where}: continuing the turn it cut off.`
      : `The model endpoint${w.url ? ` ${w.url}` : ''} on ${w.where} answers again: continuing the turn it cut off.`)
    this.sending.add(sid)
    try {
      await this.deps.send(sid, CONTINUE_TEXT, { source: AUTO_CONTINUE_SOURCE, ...(rec.taskId ? { taskId: rec.taskId } : {}) })
    } finally {
      this.sending.delete(sid)
    }
    this.schedule(sid, this.t.resumeCheckMs)
  }

  private async giveUp(rec: SessionRecord, w: SessionEndpointWait, why: 'time' | 'resumes'): Promise<void> {
    const sid = rec.claudeSessionId
    const gave: SessionEndpointWait = { ...w, state: 'gave_up', gaveUpAt: new Date(this.deps.now()).toISOString(), gaveUpWhy: why }
    await this.deps.patchWait(sid, () => gave)
    const words = endpointGaveUpWords(gave)
    log.session.warn('endpoint wait: gave up', { sessionId: sid, taskId: rec.taskId, host: w.host, url: w.url, why })
    await this.deps.gaveUp(rec, gave, words).catch((err) => {
      log.session.warn('endpoint wait: give-up hand-back failed', { sessionId: sid, error: err instanceof Error ? err.message : String(err) })
    })
  }
}

// ── Wiring ──

let instance: EndpointWaiter | null = null
let testProbe: EndpointWaitDeps['probe'] | null = null
let testTiming: Partial<EndpointWaitTiming> | null = null

/** Test-only: answer probes without a daemon, and run on a shorter clock (set before the server starts). */
export function __setEndpointWaitForTesting(opts: { probe?: EndpointWaitDeps['probe'] | null; timing?: Partial<EndpointWaitTiming> | null }): void {
  if ('probe' in opts) testProbe = opts.probe ?? null
  if ('timing' in opts) testTiming = opts.timing ?? null
}

export function getEndpointWaiter(): EndpointWaiter | null { return instance }

function defaultDeps(gaveUp: EndpointWaitDeps['gaveUp']): EndpointWaitDeps {
  return {
    now: () => Date.now(),
    setTimer: (fn, ms) => { const h = setTimeout(fn, ms); h.unref?.(); return h },
    clearTimer: (h) => clearTimeout(h),
    getSession: async (sid) => (await import('../session-tracker.js')).getSessionByClaudeId(sid),
    listSessions: async () => (await import('../session-tracker.js')).listSessions(),
    patchWait: async (sid, fn) => {
      // A compare-and-set on the wait alone, as restartLoss is written (sessions/auto-recover-env.ts).
      const { getSessionByClaudeId, updateSessionRecordConditionally } = await import('../session-tracker.js')
      for (let i = 0; i < 4; i++) {
        const cur = await getSessionByClaudeId(sid)
        if (!cur) return
        const seen = JSON.stringify(cur.endpointWait ?? null)
        const next = fn(cur.endpointWait) ?? undefined
        if (JSON.stringify(next ?? null) === seen) return
        const written = await updateSessionRecordConditionally(sid, { endpointWait: next } as Partial<SessionRecord>,
          (current) => JSON.stringify(current.endpointWait ?? null) === seen, { preserveLastActiveAt: true })
        if (written) return
      }
      throw new Error('endpointWait write kept racing')
    },
    probe: async (host, cwd) => {
      if (testProbe) return testProbe(host, cwd)
      const { probeModelEndpoint, TransferHostOfflineError } = await import('../transfer/daemon-transfer-client.js')
      const { DaemonNeedsUpgradeError } = await import('../daemon-file-reader.js')
      try {
        const r = await probeModelEndpoint(host, { cwd })
        return { kind: 'probed', url: r.url, probed: r.probed, reachable: r.reachable, ...(r.error ? { error: r.error } : {}) }
      } catch (err) {
        if (err instanceof DaemonNeedsUpgradeError) return { kind: 'unsupported' }
        if (err instanceof TransferHostOfflineError) return { kind: 'offline' }
        throw err
      }
    },
    send: async (sid, text, opts) => (await import('../session-message-queue.js')).sendMessageToSession(sid, text, opts),
    note: (sid, taskId, message) => {
      bus.emit(EventNames.SESSION_SYSTEM_EVENT, { sessionId: sid, taskId, variant: 'info' as const, message },
        ['main-ai'], { source: AUTO_CONTINUE_SOURCE, urgency: 'urgent' })
    },
    gaveUp,
  }
}

/** Start the waiter (primary only). `gaveUp` raises the session's error card the server owns. */
export function startEndpointWait(opts: {
  gaveUp?: (rec: SessionRecord, words: string) => Promise<void>
  deps?: Partial<EndpointWaitDeps>
} = {}): { stop: () => void; instance: EndpointWaiter } {
  const gaveUp: EndpointWaitDeps['gaveUp'] = async (rec, _wait, words) => {
    if (rec.taskId) {
      const { applySessionPhase } = await import('../phase.js')
      await applySessionPhase(rec.taskId, 'session:error', 'endpoint-wait:gave-up', { sessionId: rec.claudeSessionId })
    }
    await opts.gaveUp?.(rec, words)
  }
  const waiter = new EndpointWaiter({ ...defaultDeps(gaveUp), ...opts.deps }, testTiming ?? {})
  instance = waiter
  bus.subscribe('session-endpoint-wait', waiter.handleEvent, {
    global: true,
    interest: ['session:result', 'session:send', 'session:message-queued', 'session:deleted'],
  })
  void waiter.resumeOpen().catch(() => 0)
  return {
    stop: () => {
      bus.unsubscribe('session-endpoint-wait')
      waiter.stop()
      if (instance === waiter) instance = null
    },
    instance: waiter,
  }
}
