/**
 * Auto-continue: recover a session turn that died to upstream retry exhaustion.
 *
 * Context (b12 retry hardening): during a region-wide Bedrock degradation window
 * the Claude Code CLI can exhaust its finite API retries and end a turn with
 * `is_error:true` + a "Request timed out" result. The session is otherwise
 * healthy and fully resumable — the turn just never finished. Unattended runs
 * (cron, background tasks, overnight work) then sit dead until a human notices.
 *
 * This module watches turn results and, when a turn ends with the retry-exhaustion
 * signature, schedules ONE automatic `continue` nudge after a short delay (default
 * 3 min — long enough for the degradation window to clear, since Component 2's
 * proxy failover + the CLI's own backoff have usually recovered by then).
 *
 * Guards (all mandatory — this must be a strict no-op in the normal case):
 *   - only fires on `is_error` + a retry-exhaustion signature, never a clean turn;
 *   - a user (or any non-auto) send to the session cancels the pending nudge — the
 *     human took over, don't inject behind them;
 *   - at most ONE nudge pending per session (a repeat error doesn't stack);
 *   - capped at `maxPerHour` fired nudges per session in a rolling window, so a
 *     genuinely wedged session can't loop forever;
 *   - skipped if the session record is gone or archived by fire time.
 *
 * The nudge rides the NORMAL enqueue path (sendMessageToSession) so it resumes the
 * session exactly like a user "continue", is chat-visible, and cannot bypass any
 * delivery/queue invariant. A system note + structured log make every fire greppable.
 *
 * Server-side only; wired in web/server.ts under `!CLOUD_MODE` (the primary box owns
 * session lifecycle — the cloud replica proxies and must not double-fire).
 */

import { bus, EventNames } from './event-bus.js'
import type { BusEvent } from './event-bus.js'
import type { SessionRecord } from './types.js'
import { log } from '../logging/index.js'

// ── Retry-exhaustion signature ──
// The CLI surfaces retry exhaustion as an error result whose text contains
// "Request timed out"; the `--debug` trace marks the same event `api_timeout`.
// Both are the SAME underlying failure, so matching either on the result text is
// sufficient and needs no remote debug-file read.
// "The operation timed out." is the undici/fetch AbortSignal timeout text the CLI
// passes through verbatim ("API Error: The operation timed out.") — observed
// 2026-07-31 on clouddev sessions; same terminal retry-exhaustion failure, so it
// must trigger auto-continue too.
const RETRY_EXHAUSTION_PATTERNS: RegExp[] = [
  /request timed out/i,
  /operation timed out/i,
  /\bapi_timeout\b/i,
]

export function matchesRetryExhaustion(text: string | null | undefined): boolean {
  if (!text) return false
  return RETRY_EXHAUSTION_PATTERNS.some((re) => re.test(text))
}

// ── Config ──

export interface AutoContinueConfig {
  enabled: boolean
  /** Delay before firing the nudge (default 3 min). */
  delayMs: number
  /** Max fired nudges per session inside `windowMs` (default 2). */
  maxPerHour: number
  /** Rolling window for the cap (default 1 h). */
  windowMs: number
}

function clampInt(raw: string | undefined, def: number, min: number, max: number): number {
  const n = raw != null && raw !== '' ? Number(raw) : def
  if (!Number.isFinite(n)) return def
  return Math.max(min, Math.min(max, Math.trunc(n)))
}

export function resolveAutoContinueConfig(): AutoContinueConfig {
  return {
    enabled: process.env.WALNUT_AUTO_CONTINUE_ENABLED !== '0',
    delayMs: clampInt(process.env.WALNUT_AUTO_CONTINUE_DELAY_MS, 180_000, 0, 3_600_000),
    maxPerHour: clampInt(process.env.WALNUT_AUTO_CONTINUE_MAX_PER_HOUR, 2, 0, 100),
    windowMs: clampInt(process.env.WALNUT_AUTO_CONTINUE_WINDOW_MS, 3_600_000, 60_000, 86_400_000),
  }
}

// ── Injectable deps (real by default; overridden in unit tests) ──

export interface AutoContinueDeps {
  now: () => number
  /** Set a timer; returns an opaque handle. */
  setTimer: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>
  clearTimer: (handle: ReturnType<typeof setTimeout>) => void
  /** Send `continue` through the normal enqueue path. */
  send: (sessionId: string, message: string, opts: { source: string; taskId?: string }) => Promise<unknown>
  /** Look up the session record (archived / gone check). */
  getSession: (sessionId: string) => Promise<SessionRecord | null>
  /** Emit a chat-visible system note. */
  emitNote: (sessionId: string, taskId: string | undefined, message: string) => void
}

function defaultDeps(): AutoContinueDeps {
  return {
    now: () => Date.now(),
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (handle) => clearTimeout(handle),
    send: async (sessionId, message, opts) => {
      const { sendMessageToSession } = await import('./session-message-queue.js')
      return sendMessageToSession(sessionId, message, opts)
    },
    getSession: async (sessionId) => {
      const { getSessionByClaudeId } = await import('./session-tracker.js')
      return getSessionByClaudeId(sessionId)
    },
    emitNote: (sessionId, taskId, message) => {
      bus.emit(EventNames.SESSION_SYSTEM_EVENT, {
        sessionId, taskId, variant: 'info' as const, message,
      }, ['main-ai'], { source: AUTO_CONTINUE_SOURCE, urgency: 'urgent' })
    },
  }
}

/** Message source tag on the nudge — also used to ignore our own sends when
 *  deciding whether a user superseded a pending nudge. */
export const AUTO_CONTINUE_SOURCE = 'auto-continue'
const NUDGE_MESSAGE = 'continue'

// ── Scheduler ──

export class SessionAutoContinue {
  private readonly cfg: AutoContinueConfig
  private readonly deps: AutoContinueDeps
  private readonly pending = new Map<string, ReturnType<typeof setTimeout>>()
  /** sessionId → fired-nudge timestamps (ms), pruned to the rolling window. */
  private readonly fires = new Map<string, number[]>()
  /** sessionId → supersession epoch. Bumped on every non-auto send (and delete);
   *  fire() captures the epoch at schedule time and re-checks it after every
   *  await so a user message landing mid-fire aborts the nudge (TOCTOU guard —
   *  clearing the timer handle alone can't stop an already-running callback). */
  private readonly epochs = new Map<string, number>()

  constructor(cfg: AutoContinueConfig, deps: Partial<AutoContinueDeps> = {}) {
    this.cfg = cfg
    this.deps = { ...defaultDeps(), ...deps }
  }

  /** Bus event handler — route result/send/lifecycle events. */
  handleEvent = (event: BusEvent): void => {
    if (!this.cfg.enabled) return
    switch (event.name) {
      case EventNames.SESSION_RESULT: {
        const d = event.data as { sessionId?: string; taskId?: string; result?: string; isError?: boolean; retryExhausted?: boolean; teamActive?: boolean; backgroundActive?: boolean }
        if (!d.sessionId || !d.isError) return
        // Intermediate results (team / background still running) are not turn-over.
        if (d.teamActive || d.backgroundActive) return
        // Prefer the emitter's structured signal (covers the CLI api_timeout debug
        // marker even when the result text is generic); fall back to text matching
        // for emitters that don't stamp it.
        if (!d.retryExhausted && !matchesRetryExhaustion(d.result)) return
        this.schedule(d.sessionId, d.taskId)
        break
      }
      case EventNames.SESSION_SEND:
      case EventNames.SESSION_MESSAGE_QUEUED: {
        // Any send that isn't our own nudge means someone (a user, a phase hook)
        // is now driving this session — cancel a pending auto-continue.
        if (event.source === AUTO_CONTINUE_SOURCE) return
        const d = event.data as { sessionId?: string }
        if (d.sessionId) this.cancel(d.sessionId, 'superseded-by-send')
        break
      }
      case EventNames.SESSION_DELETED: {
        // ONLY a real user deletion cancels a pending nudge. We deliberately do
        // NOT listen for SESSION_ENDED: that fires as part of the normal turn-end
        // flow (server.ts emits it with source 'session-result'/'session-error'
        // right after every result, including the retry-exhaustion error result
        // that just scheduled this nudge). Cancelling on SESSION_ENDED would undo
        // the nudge the instant it was scheduled, so auto-continue could never
        // fire. A session that is genuinely gone/archived by fire time is still
        // caught by the getSession null/archived guard in fire().
        const d = event.data as { sessionId?: string; sessionIds?: string[] }
        const ids = d.sessionIds ?? (d.sessionId ? [d.sessionId] : [])
        for (const id of ids) {
          this.cancel(id, 'session-deleted')
          // Full state cleanup — deleting the epoch entry makes any in-flight
          // fire() see a mismatched epoch (0 ≠ captured) and abort, and keeps
          // the maps from accumulating one entry per session ever seen.
          this.epochs.delete(id)
          this.fires.delete(id)
        }
        break
      }
      default:
        break
    }
  }

  private firesInWindow(sessionId: string): number {
    const arr = this.fires.get(sessionId)
    if (!arr) return 0
    const cutoff = this.deps.now() - this.cfg.windowMs
    const live = arr.filter((t) => t >= cutoff)
    if (live.length !== arr.length) this.fires.set(sessionId, live)
    return live.length
  }

  private schedule(sessionId: string, taskId: string | undefined): void {
    if (this.pending.has(sessionId)) return // at most one pending nudge per session
    if (this.cfg.maxPerHour <= 0) return
    if (this.firesInWindow(sessionId) >= this.cfg.maxPerHour) {
      log.session.info('auto-continue skipped — hourly cap reached', {
        sessionId, taskId, maxPerHour: this.cfg.maxPerHour, windowMs: this.cfg.windowMs,
      })
      return
    }
    log.session.info('auto-continue scheduled after retry-exhaustion result', {
      sessionId, taskId, delayMs: this.cfg.delayMs,
    })
    const epoch = this.epochs.get(sessionId) ?? 0
    const handle = this.deps.setTimer(() => {
      this.pending.delete(sessionId)
      void this.fire(sessionId, taskId, epoch)
    }, this.cfg.delayMs)
    this.pending.set(sessionId, handle)
  }

  private async fire(sessionId: string, taskId: string | undefined, epoch: number): Promise<void> {
    try {
      const superseded = () => (this.epochs.get(sessionId) ?? 0) !== epoch
      if (superseded()) {
        log.session.info('auto-continue aborted — superseded before fire', { sessionId, taskId })
        return
      }
      // Reserve the cap slot SYNCHRONOUSLY, before any await: check + record in one
      // step so two near-simultaneous fires can't both observe a free slot (the
      // check-then-push gap was the cap-overrun race). Released on abort below.
      if (this.firesInWindow(sessionId) >= this.cfg.maxPerHour) {
        log.session.info('auto-continue aborted at fire — hourly cap reached', { sessionId, taskId })
        return
      }
      const reservedAt = this.deps.now()
      const arr = this.fires.get(sessionId) ?? []
      arr.push(reservedAt)
      this.fires.set(sessionId, arr)
      const releaseSlot = () => {
        const cur = this.fires.get(sessionId)
        if (!cur) return
        const idx = cur.indexOf(reservedAt)
        if (idx >= 0) cur.splice(idx, 1)
      }

      // Skip if the session vanished or was archived while we waited.
      const rec = await this.deps.getSession(sessionId)
      if (superseded()) {
        // User (or any non-auto sender) took over during the async lookup —
        // do NOT inject behind them (TOCTOU guard).
        releaseSlot()
        log.session.info('auto-continue aborted — superseded during lookup', { sessionId, taskId })
        return
      }
      if (!rec) {
        releaseSlot()
        log.session.info('auto-continue aborted — session gone', { sessionId, taskId })
        return
      }
      if (rec.archived) {
        releaseSlot()
        log.session.info('auto-continue aborted — session archived', { sessionId, taskId })
        return
      }

      log.session.info('auto-continue firing — nudging session to resume after timeout', {
        sessionId, taskId: taskId ?? rec.taskId, firesInWindow: this.firesInWindow(sessionId),
      })
      this.deps.emitNote(sessionId, taskId ?? rec.taskId,
        'Auto-continuing after an upstream timeout — resuming the interrupted turn.')
      await this.deps.send(sessionId, NUDGE_MESSAGE, {
        source: AUTO_CONTINUE_SOURCE,
        taskId: taskId ?? rec.taskId,
      })
    } catch (err) {
      log.session.warn('auto-continue fire failed', {
        sessionId, taskId, error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  cancel(sessionId: string, reason: string): void {
    // Always bump the epoch: an in-flight fire() past its timer must also see
    // the supersession, not just a still-pending timer.
    this.epochs.set(sessionId, (this.epochs.get(sessionId) ?? 0) + 1)
    const handle = this.pending.get(sessionId)
    if (!handle) return
    this.deps.clearTimer(handle)
    this.pending.delete(sessionId)
    log.session.info('auto-continue canceled', { sessionId, reason })
  }

  stop(): void {
    for (const handle of this.pending.values()) this.deps.clearTimer(handle)
    this.pending.clear()
    this.fires.clear()
    this.epochs.clear()
  }

  // ── Test-only introspection ──
  hasPending(sessionId: string): boolean { return this.pending.has(sessionId) }
  firedCount(sessionId: string): number { return this.firesInWindow(sessionId) }
}

// ── Module wiring ──

let instance: SessionAutoContinue | null = null

/**
 * Start the auto-continue watcher. Subscribes globally (interest-scoped to
 * session events). Returns a stop handle for clean shutdown.
 */
export function startSessionAutoContinue(
  cfg: AutoContinueConfig = resolveAutoContinueConfig(),
  deps: Partial<AutoContinueDeps> = {},
): { stop: () => void; instance: SessionAutoContinue } {
  const sac = new SessionAutoContinue(cfg, deps)
  instance = sac
  bus.subscribe('session-auto-continue', sac.handleEvent, {
    global: true,
    interest: [
      'session:result', 'session:send', 'session:message-queued',
      'session:deleted',
    ],
  })
  log.session.info('auto-continue watcher started', {
    enabled: cfg.enabled, delayMs: cfg.delayMs, maxPerHour: cfg.maxPerHour,
  })
  return {
    stop: () => {
      bus.unsubscribe('session-auto-continue')
      sac.stop()
      if (instance === sac) instance = null
    },
    instance: sac,
  }
}

/** Test/debug accessor for the live singleton. */
export function getSessionAutoContinue(): SessionAutoContinue | null {
  return instance
}
