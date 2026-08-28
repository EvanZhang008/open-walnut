/**
 * Auto-recover: bring back sessions whose EXECUTION SUBSTRATE died under them.
 *
 * Distinct from its two siblings, and the difference is the whole point:
 *   - daemon turn-retry (providers/daemon-core) retries a turn that died to a
 *     transient upstream error. It runs INSIDE the daemon, so it cannot help
 *     when the daemon is the thing that died.
 *   - session-auto-continue nudges a turn that ended with a retry-exhaustion
 *     result. It needs a `session:result` event — a host that reboots mid-turn
 *     never emits one.
 *   - this module handles "the process is simply GONE": host rebooted, daemon
 *     restarted, tunnel died. Only the Mac survives that, so only the Mac can
 *     own the recovery.
 *
 * 2026-08-22 (inc-1787439819342): a remote dev host took its weekly patch reboot
 * at 19:29 UTC, five minutes before the reboot itself, killing the CLI, the
 * daemon and a 30-minute build. The daemon was back and healthy by 22:11. The
 * session sat in 'error' until the user manually forked it at 23:04 — 3.5 hours
 * of nothing, on work that was fully resumable the whole time (the CLI transcript
 * survives in ~/.claude/projects, which is why `--resume` works).
 *
 * HOW THE RESUME HAPPENS. This module does not spawn anything. It sends ONE
 * message through the normal queue (`sendMessageToSession`), and the existing
 * send path does the rest: a dead session's write fails and falls back to a
 * `--resume` spawn. So auto-recover inherits every delivery invariant, is
 * chat-visible, and adds no new process-management code.
 *
 * GUARDS (each one is a real failure mode, not defensive padding):
 *   - infra ONLY (session-error-kind). An unknown cause does not qualify: this
 *     spends tokens and runs an agent with no human watching.
 *   - task must still be IN_PROGRESS. AGENT_COMPLETE means the work was already
 *     handed back to the human; resuming would talk over them.
 *   - persisted attempt budget on the session record. An in-memory counter
 *     resets with the server, so a host in a reboot loop would respawn forever.
 *   - per-host stagger + per-host cap. One reboot can strand a dozen sessions;
 *     resuming them simultaneously would hammer a host that just finished
 *     booting (and blow through its ssh MaxStartups).
 *   - any non-auto send cancels a pending recovery — the human took over.
 *   - re-validated after every await (epoch check), because the delay is long
 *     enough for all of the above to change underneath us.
 */

import { bus, EventNames } from './event-bus.js'
import type { BusEvent } from './event-bus.js'
import type { SessionRecord, StatusReason, TaskPhase } from './types.js'
import { isInfraSessionError } from './session-error-kind.js'
import { log } from '../logging/index.js'

/** Message source tag — also how we recognise our own sends so they don't look
 *  like a human taking over. */
export const AUTO_RECOVER_SOURCE = 'auto-recover'

/** What we tell the resumed agent. Honest about the cause (so it doesn't waste a
 *  turn diagnosing its own "failure") and explicit that it must re-check state:
 *  the killed turn may have half-finished a write, a build or a git operation. */
export function buildRecoveryPrompt(host: string | undefined, cause: StatusReason | undefined): string {
  const where = host && host !== '__local__' ? `on ${host}` : 'on this machine'
  const why = cause === 'remote_unreachable'
    ? 'the host became unreachable'
    : cause === 'server_restart'
      ? 'the Walnut server restarted'
      : 'the host or its session daemon restarted'
  return [
    `[Walnut auto-recover] Your process ${where} was killed mid-turn because ${why}.`,
    'Nothing you did caused it, and no output from that turn was saved.',
    'Before continuing: re-check the real state on disk (files you were editing, whether a build/command actually finished, git status) instead of assuming your last action completed.',
    'Then carry on with the task.',
  ].join(' ')
}

// ── Config ───────────────────────────────────────────────────────────────────

export interface AutoRecoverConfig {
  enabled: boolean
  /** Wait after the loss is observed before resuming. Long enough for a host
   *  that is still finishing its boot to settle. */
  delayMs: number
  /** Extra spacing between resumes on the SAME host. */
  staggerMs: number
  /** Max resumes per session inside `windowMs`. */
  maxAttempts: number
  /** Max resumes per host inside `windowMs`. */
  maxPerHost: number
  /** Rolling window for both budgets. */
  windowMs: number
}

function clampInt(raw: string | undefined, def: number, min: number, max: number): number {
  const n = raw != null && raw !== '' ? Number(raw) : def
  if (!Number.isFinite(n)) return def
  return Math.max(min, Math.min(max, Math.trunc(n)))
}

export function resolveAutoRecoverConfig(): AutoRecoverConfig {
  return {
    // ON by default, unlike turn-retry: turn-retry re-asks a question that may be
    // failing for a reason, while this only restores a process the infrastructure
    // took away. Opt out with WALNUT_AUTO_RECOVER_ENABLED=0.
    enabled: process.env.WALNUT_AUTO_RECOVER_ENABLED !== '0',
    delayMs: clampInt(process.env.WALNUT_AUTO_RECOVER_DELAY_MS, 20_000, 0, 3_600_000),
    staggerMs: clampInt(process.env.WALNUT_AUTO_RECOVER_STAGGER_MS, 15_000, 0, 600_000),
    maxAttempts: clampInt(process.env.WALNUT_AUTO_RECOVER_MAX_ATTEMPTS, 3, 0, 50),
    maxPerHost: clampInt(process.env.WALNUT_AUTO_RECOVER_MAX_PER_HOST, 10, 0, 500),
    windowMs: clampInt(process.env.WALNUT_AUTO_RECOVER_WINDOW_MS, 6 * 3_600_000, 60_000, 7 * 86_400_000),
  }
}

// ── Injectable deps (real by default; overridden in unit tests) ───────────────

export interface AutoRecoverDeps {
  now: () => number
  setTimer: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>
  clearTimer: (handle: ReturnType<typeof setTimeout>) => void
  send: (sessionId: string, message: string, opts: { source: string; taskId?: string }) => Promise<unknown>
  getSession: (sessionId: string) => Promise<SessionRecord | null>
  getTaskPhase: (taskId: string) => Promise<TaskPhase | null>
  /** Persist the attempt budget on the record (survives a server restart). */
  noteAttempt: (sessionId: string, attempts: number, cause: StatusReason | undefined) => Promise<void>
  emitNote: (sessionId: string, taskId: string | undefined, message: string) => void
}

function defaultDeps(): AutoRecoverDeps {
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
    getTaskPhase: async (taskId) => {
      // getTask THROWS on an unknown id — a deleted task must read as "no phase"
      // (fire() then aborts), never as an exception that skips the budget write.
      try {
        const { getTask } = await import('./task-manager.js')
        const task = await getTask(taskId)
        return task?.phase ?? null
      } catch {
        return null
      }
    },
    noteAttempt: async (sessionId, attempts, cause) => {
      const { updateSessionRecord } = await import('./session-tracker.js')
      // Deliberately NOT a status write — no process_status/status_reason here, so
      // this never trips the snapshot gate's category-① drop.
      await updateSessionRecord(sessionId, {
        autoRecover: { attempts, lastAt: new Date().toISOString(), cause },
      } as Partial<SessionRecord>)
    },
    emitNote: (sessionId, taskId, message) => {
      bus.emit(EventNames.SESSION_SYSTEM_EVENT, {
        sessionId, taskId, variant: 'info' as const, message,
      }, ['main-ai'], { source: AUTO_RECOVER_SOURCE, urgency: 'urgent' })
    },
  }
}

/** Why a schedule() call did not arm a recovery — surfaced so callers can decide
 *  whether to fall back to advancing the task phase instead. */
export type SkipReason =
  | 'disabled'
  | 'already-pending'
  | 'archived'
  | 'not-infra'
  | 'no-task'
  | 'not-interactive'
  | 'session-budget'
  | 'host-budget'

// ── Scheduler ────────────────────────────────────────────────────────────────

export class SessionAutoRecover {
  private readonly cfg: AutoRecoverConfig
  private readonly deps: AutoRecoverDeps
  /** One entry per armed recovery. The entry lives until fire() COMPLETES (not
   *  until the timer pops) so wouldAttempt's already-pending check covers the
   *  whole fire window — a slow cold --resume used to leave a gap where the
   *  health monitor could arm a second recovery for the same session.
   *  hostKey/reservedAt let cancel() and fire()'s abort paths refund the host
   *  budget slot that schedule() reserved. */
  private readonly pending = new Map<string, {
    handle: ReturnType<typeof setTimeout>
    hostKey: string
    reservedAt: number
    epoch: number
    fired: boolean
  }>()
  /** hostKey → fired timestamps (ms), pruned to the rolling window. */
  private readonly hostFires = new Map<string, number[]>()
  /** hostKey → ms epoch the next resume on that host may fire at (stagger). */
  private readonly hostNextSlot = new Map<string, number>()
  /** sessionId → supersession epoch, bumped by any non-auto send. fire() captures
   *  it and re-checks after every await (clearing a timer cannot stop a callback
   *  that already started). */
  private readonly epochs = new Map<string, number>()

  constructor(cfg: AutoRecoverConfig, deps: Partial<AutoRecoverDeps> = {}) {
    this.cfg = cfg
    this.deps = { ...defaultDeps(), ...deps }
  }

  handleEvent = (event: BusEvent): void => {
    switch (event.name) {
      case EventNames.SESSION_SEND:
      case EventNames.SESSION_MESSAGE_QUEUED: {
        if (event.source === AUTO_RECOVER_SOURCE) return
        const d = event.data as { sessionId?: string }
        if (d.sessionId) this.cancel(d.sessionId, 'superseded-by-send')
        break
      }
      case EventNames.SESSION_DELETED: {
        const d = event.data as { sessionId?: string; sessionIds?: string[] }
        const ids = d.sessionIds ?? (d.sessionId ? [d.sessionId] : [])
        for (const id of ids) {
          this.cancel(id, 'session-deleted')
          this.epochs.delete(id)
        }
        break
      }
      default:
        break
    }
  }

  private hostKeyOf(record: Pick<SessionRecord, 'host'>): string {
    return record.host ?? '__local__'
  }

  private firesInWindow(hostKey: string): number {
    const arr = this.hostFires.get(hostKey)
    if (!arr) return 0
    const cutoff = this.deps.now() - this.cfg.windowMs
    const live = arr.filter((t) => t >= cutoff)
    if (live.length !== arr.length) this.hostFires.set(hostKey, live)
    return live.length
  }

  /** Attempts already spent by this session inside the window, read from the
   *  PERSISTED budget so a server restart doesn't hand out a fresh allowance. */
  private attemptsSpent(record: Pick<SessionRecord, 'autoRecover'>): number {
    const st = record.autoRecover
    if (!st) return 0
    const last = Date.parse(st.lastAt)
    if (Number.isNaN(last)) return 0
    if (this.deps.now() - last > this.cfg.windowMs) return 0  // window rolled over
    return st.attempts
  }

  /**
   * Cheap SYNC verdict: would this record be resumed if we scheduled it?
   *
   * Callers use this to decide whether to advance the task phase instead
   * (advancing to AGENT_COMPLETE and then resuming would contradict each other,
   * and fire() checks the phase, so the order has to be settled up front).
   * The task-phase check itself is async and happens in fire().
   */
  wouldAttempt(record: SessionRecord): { ok: true } | { ok: false; reason: SkipReason } {
    if (!this.cfg.enabled) return { ok: false, reason: 'disabled' }
    if (this.pending.has(record.claudeSessionId)) return { ok: false, reason: 'already-pending' }
    if (record.archived) return { ok: false, reason: 'archived' }
    // Embedded/derived sessions (triage, hook, cron, subagent) have no standalone
    // work to continue and no human waiting on them.
    if (record.type && record.type !== 'interactive') return { ok: false, reason: 'not-interactive' }
    if (!record.taskId) return { ok: false, reason: 'no-task' }
    if (!isInfraSessionError(record)) return { ok: false, reason: 'not-infra' }
    if (this.attemptsSpent(record) >= this.cfg.maxAttempts) return { ok: false, reason: 'session-budget' }
    if (this.firesInWindow(this.hostKeyOf(record)) >= this.cfg.maxPerHost) {
      return { ok: false, reason: 'host-budget' }
    }
    return { ok: true }
  }

  /**
   * Arm a recovery for a session whose process is gone. Returns true when armed.
   * Idempotent per session (at most one pending recovery).
   */
  schedule(record: SessionRecord, cause?: StatusReason): boolean {
    const verdict = this.wouldAttempt(record)
    if (!verdict.ok) {
      log.session.debug('auto-recover not scheduled', {
        sessionId: record.claudeSessionId, reason: verdict.reason,
      })
      return false
    }

    const sessionId = record.claudeSessionId
    const hostKey = this.hostKeyOf(record)
    const now = this.deps.now()
    // Stagger per host: a reboot strands many sessions at once, and resuming them
    // together means N simultaneous ssh spawns at a host that just booted.
    const earliest = Math.max(now + this.cfg.delayMs, this.hostNextSlot.get(hostKey) ?? 0)
    this.hostNextSlot.set(hostKey, earliest + this.cfg.staggerMs)
    const waitMs = Math.max(0, earliest - now)

    // Reserve the host slot NOW (not at fire time) so a burst of schedule() calls
    // in the same tick can't all pass the per-host cap. cancel() and fire()'s
    // abort paths refund it — an aborted recovery must not eat the host budget
    // for the whole windowMs.
    const fires = this.hostFires.get(hostKey) ?? []
    fires.push(now)
    this.hostFires.set(hostKey, fires)

    const epoch = this.epochs.get(sessionId) ?? 0
    const handle = this.deps.setTimer(() => {
      const entry = this.pending.get(sessionId)
      if (entry) entry.fired = true  // entry is removed by fire()'s finally
      void this.fire(sessionId, record.taskId, cause, epoch, hostKey, now)
    }, waitMs)
    this.pending.set(sessionId, { handle, hostKey, reservedAt: now, epoch, fired: false })

    log.session.info('auto-recover scheduled', {
      sessionId, taskId: record.taskId, host: hostKey, cause: cause ?? null,
      waitMs, attemptsSpent: this.attemptsSpent(record), maxAttempts: this.cfg.maxAttempts,
    })
    return true
  }

  /** Remove ONE reservation stamped `reservedAt` from a host's fire window.
   *  Refunds the slot schedule() took when the recovery never actually resumed
   *  anything (canceled, or any fire() abort path). */
  private releaseHostSlot(hostKey: string, reservedAt: number): void {
    const arr = this.hostFires.get(hostKey)
    if (!arr) return
    const i = arr.indexOf(reservedAt)
    if (i === -1) return
    arr.splice(i, 1)
    if (arr.length === 0) this.hostFires.delete(hostKey)
  }

  private async fire(
    sessionId: string,
    taskId: string | undefined,
    cause: StatusReason | undefined,
    epoch: number,
    hostKey: string,
    reservedAt: number,
  ): Promise<void> {
    const superseded = () => (this.epochs.get(sessionId) ?? 0) !== epoch
    // Flipped only after the resume send actually went out — every other exit
    // refunds the host budget slot reserved at schedule() time.
    let sent = false
    try {
      if (superseded()) {
        log.session.info('auto-recover aborted — superseded before fire', { sessionId, taskId })
        return
      }

      const rec = await this.deps.getSession(sessionId)
      if (superseded()) {
        log.session.info('auto-recover aborted — superseded during lookup', { sessionId, taskId })
        return
      }
      if (!rec) {
        log.session.info('auto-recover aborted — session gone', { sessionId, taskId })
        return
      }
      // Re-run the full verdict: the delay is long enough for the session to have
      // been archived, revived by the daemon, or resumed by a human.
      if (rec.archived) {
        log.session.info('auto-recover aborted — session archived', { sessionId, taskId })
        return
      }
      if (rec.process_status === 'running' || rec.process_status === 'idle') {
        log.session.info('auto-recover aborted — session already back', {
          sessionId, taskId, processStatus: rec.process_status,
        })
        return
      }
      if (!isInfraSessionError(rec)) {
        log.session.info('auto-recover aborted — cause is no longer infra', {
          sessionId, taskId, statusReason: rec.status_reason ?? null, errorKind: rec.errorKind ?? null,
        })
        return
      }

      const effectiveTaskId = taskId ?? rec.taskId
      if (!effectiveTaskId) {
        log.session.info('auto-recover aborted — no task', { sessionId })
        return
      }
      // The work must still be in flight. AGENT_COMPLETE / COMPLETE / TODO all mean
      // nobody is waiting on this session to keep going.
      const phase = await this.deps.getTaskPhase(effectiveTaskId)
      if (superseded()) {
        log.session.info('auto-recover aborted — superseded during phase check', { sessionId, taskId })
        return
      }
      if (phase !== 'IN_PROGRESS') {
        log.session.info('auto-recover aborted — task no longer in progress', {
          sessionId, taskId: effectiveTaskId, phase,
        })
        return
      }

      const attempts = this.attemptsSpent(rec) + 1
      if (attempts > this.cfg.maxAttempts) {
        log.session.warn('auto-recover give-up — session budget exhausted', {
          sessionId, taskId: effectiveTaskId, attempts, maxAttempts: this.cfg.maxAttempts,
        })
        return
      }
      // Persist BEFORE sending: if the send wedges or the server dies mid-resume,
      // the attempt must still count, or a crash loop gets unlimited retries.
      await this.deps.noteAttempt(sessionId, attempts, cause ?? rec.status_reason)
      if (superseded()) {
        log.session.info('auto-recover aborted — superseded during budget write', { sessionId, taskId })
        return
      }

      log.session.info('auto-recover firing — resuming session after infrastructure loss', {
        sessionId, taskId: effectiveTaskId, host: rec.host ?? '__local__',
        cause: (cause ?? rec.status_reason) ?? null, attempt: attempts,
      })
      this.deps.emitNote(sessionId, effectiveTaskId,
        `Auto-recovering: the host or daemon restarted and killed this session's process. Resuming (attempt ${attempts}/${this.cfg.maxAttempts}).`)
      await this.deps.send(sessionId, buildRecoveryPrompt(rec.host, cause ?? rec.status_reason), {
        source: AUTO_RECOVER_SOURCE,
        taskId: effectiveTaskId,
      })
      sent = true
    } catch (err) {
      log.session.warn('auto-recover fire failed', {
        sessionId, taskId, error: err instanceof Error ? err.message : String(err),
      })
    } finally {
      if (!sent) this.releaseHostSlot(hostKey, reservedAt)
      // Remove only OUR entry: cancel() may already have removed it and a new
      // schedule() (later epoch) may have replaced it in the meantime.
      const entry = this.pending.get(sessionId)
      if (entry && entry.epoch === epoch && entry.fired) this.pending.delete(sessionId)
    }
  }

  cancel(sessionId: string, reason: string): void {
    // Bump the epoch unconditionally: an in-flight fire() past its timer must
    // also observe the supersession.
    this.epochs.set(sessionId, (this.epochs.get(sessionId) ?? 0) + 1)
    const entry = this.pending.get(sessionId)
    if (!entry) return
    this.deps.clearTimer(entry.handle)
    this.pending.delete(sessionId)
    // Timer never popped → fire() will never run for this entry, so the refund
    // is ours. A fired entry's refund belongs to fire()'s finally instead (it
    // aborts on the epoch bump and refunds there).
    if (!entry.fired) this.releaseHostSlot(entry.hostKey, entry.reservedAt)
    log.session.info('auto-recover canceled', { sessionId, reason })
  }

  stop(): void {
    for (const entry of this.pending.values()) this.deps.clearTimer(entry.handle)
    this.pending.clear()
    this.hostFires.clear()
    this.hostNextSlot.clear()
    this.epochs.clear()
  }

  // ── Test-only introspection ──
  hasPending(sessionId: string): boolean { return this.pending.has(sessionId) }
  hostFiredCount(hostKey: string): number { return this.firesInWindow(hostKey) }
}

// ── Module wiring ────────────────────────────────────────────────────────────

let instance: SessionAutoRecover | null = null

export function startSessionAutoRecover(
  cfg: AutoRecoverConfig = resolveAutoRecoverConfig(),
  deps: Partial<AutoRecoverDeps> = {},
): { stop: () => void; instance: SessionAutoRecover } {
  const sar = new SessionAutoRecover(cfg, deps)
  instance = sar
  bus.subscribe('session-auto-recover', sar.handleEvent, {
    global: true,
    interest: ['session:send', 'session:message-queued', 'session:deleted'],
  })
  log.session.info('auto-recover watcher started', {
    enabled: cfg.enabled, delayMs: cfg.delayMs, staggerMs: cfg.staggerMs,
    maxAttempts: cfg.maxAttempts, maxPerHost: cfg.maxPerHost,
  })
  return {
    stop: () => {
      bus.unsubscribe('session-auto-recover')
      sar.stop()
      if (instance === sar) instance = null
    },
    instance: sar,
  }
}

export function getSessionAutoRecover(): SessionAutoRecover | null {
  return instance
}

/**
 * Convenience for the discovery sites (daemon reconnect, health monitor): arm a
 * recovery if the watcher is running. Returns true when armed, so the caller
 * knows not to advance the task phase to AGENT_COMPLETE behind it.
 */
export function scheduleSessionAutoRecover(record: SessionRecord, cause?: StatusReason): boolean {
  return instance?.schedule(record, cause) ?? false
}
