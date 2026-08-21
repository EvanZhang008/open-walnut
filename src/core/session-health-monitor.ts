/**
 * Session Health Monitor — periodic liveness checks for non-terminal sessions.
 *
 * Runs every 30 seconds inside the server process. For each non-terminal session:
 *   1. Check isProcessAlive (routes through session manager or daemon connection)
 *   2. If process dead: set process_status='error' (with errorMessage) or 'stopped'
 *   3. Clear task session slot on error (agent_complete keeps slot for resume)
 *   4. Emit session:status-changed
 *   5. Check idle timeout: kill sessions whose outputFile mtime exceeds the threshold.
 *      Uses file mtime — persistent on disk, survives server restarts, no state machine dependency.
 */

import fsp from 'node:fs/promises'
import { log } from '../logging/index.js'
import { isProcessAliveAsync } from '../utils/process.js'
import { safeKillProcessGroup } from './process-group-kill.js'
import { isSessionProcessAlive, isLocalJsonlFresh } from '../utils/session-liveness.js'
import { bus, EventNames } from './event-bus.js'
import { runPeriodic, type PeriodicHandle, type TickContext } from './periodic-task.js'
import type { SessionRecord, Task, TaskPhase } from './types.js'
import { emitSessionStatusChanged } from './session-tracker.js'
const HEALTH_CHECK_INTERVAL_MS = 30_000
/** Adaptive slow-down: with an empty active set there is nothing to watch. */
const HEALTH_CHECK_IDLE_INTERVAL_MS = 5 * 60_000
/** Per-tick budget — must stay below the interval so ticks can never overlap-stack. */
const HEALTH_CHECK_BUDGET_MS = 20_000
/** Orphan sweep runs on its own slow cadence — a leaked process doesn't need 30s precision. */
const ORPHAN_SWEEP_EVERY_TICKS = 120
/** Rollback switch: WALNUT_HEALTH_V2=0 restores the legacy whole-table scan. */
const HEALTH_V2 = process.env.WALNUT_HEALTH_V2 !== '0'
/**
 * Default idle timeouts — local vs remote.
 *
 * Remote sessions run on a dev host and cost the user nothing local; premature
 * reaping forces a slow `--resume` spawn (~10s) and leaves a misleading
 * `[Request interrupted by user]` marker in the transcript (CLI SIGINT handler
 * writes it — there's no "silent shutdown" path in print mode). Users leaving
 * handed-back (AGENT_COMPLETE) sessions overnight for review hit this constantly.
 *
 * Local sessions share the laptop's RAM/CPU, so we're stricter — but 30 min
 * was too aggressive for turns with long think time.
 */
const DEFAULT_LOCAL_IDLE_TIMEOUT_MS = 60 * 60 * 1000
const DEFAULT_REMOTE_IDLE_TIMEOUT_MS = 2 * 60 * 60 * 1000
/** Cron-armed (/loop) sessions: matches the CLI's 7-day recurring-cron auto-expiry. */
const CRON_ARMED_IDLE_TIMEOUT_MS = 7 * 24 * 60 * 60 * 1000
/**
 * Ceiling on ONE session's daemon probe inside a per-session loop.
 *
 * The tick budget (HEALTH_CHECK_BUDGET_MS) is only consulted *between* phases, so
 * it cannot cut off a single slow session: `await runner.isBackgroundWorkActive()`
 * reaches a daemon RPC whose own timeout is COMMAND_TIMEOUT_MS = 30_000, and a
 * host stuck in the "connected but no pong yet" window pays that in full — per
 * session, serially. Two such sessions already blow the 20 s budget before the
 * budget is ever checked again, which is how a tick reached 11 s (and worse).
 *
 * 5 s is generous for a healthy daemon (observed p99 well under 1 s) and turns a
 * dead host into a bounded cost instead of an unbounded one.
 */
const DEFAULT_SESSION_PROBE_TIMEOUT_MS = 5_000
/** Override for genuinely high-latency deployments (and for tests). */
function sessionProbeTimeoutMs(): number {
  const raw = process.env.WALNUT_HEALTH_PROBE_TIMEOUT_MS
  if (raw) {
    const parsed = Number(raw)
    if (Number.isFinite(parsed) && parsed > 0) return parsed
  }
  return DEFAULT_SESSION_PROBE_TIMEOUT_MS
}
/** Unique sentinel so a probe legitimately resolving to undefined/null/false isn't mistaken for a timeout. */
const TIMED_OUT = Symbol('probe-timeout')

/**
 * Race a per-session probe against SESSION_PROBE_TIMEOUT_MS.
 *
 * `fallback` is what we assume on timeout, and it must always be the SAFE answer,
 * not the likely one: for isBackgroundWorkActive that is `true` ("assume busy"),
 * because the false branch leads to killing the session. An unknown-state session
 * must never be reaped on a probe that merely timed out.
 */
export async function probeWithTimeout<T>(
  probe: Promise<T> | T,
  fallback: T,
  label: string,
  sessionId: string,
): Promise<T> {
  if (!(probe instanceof Promise)) return probe
  const timeoutMs = sessionProbeTimeoutMs()
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const timeout = new Promise<typeof TIMED_OUT>((resolve) => {
      timer = setTimeout(() => resolve(TIMED_OUT), timeoutMs)
      if (timer && typeof timer === 'object' && 'unref' in timer) timer.unref()
    })
    const winner = await Promise.race([probe, timeout])
    if (winner === TIMED_OUT) {
      log.session.warn('health monitor: per-session probe timed out — assuming safe default', {
        sessionId, probe: label, timeoutMs, assumed: String(fallback),
      })
      // Abandon the loser rather than awaiting it — that is the whole point of the
      // ceiling. Safe: Promise.race has already subscribed to it, so a rejection
      // arriving later is handled and cannot become an unhandledRejection.
      return fallback
    }
    return winner as T
  } catch (err) {
    log.session.debug('health monitor: per-session probe failed', {
      sessionId, probe: label, error: err instanceof Error ? err.message : String(err),
    })
    return fallback
  } finally {
    if (timer) clearTimeout(timer)
  }
}

export class SessionHealthMonitor {
  private handle: PeriodicHandle | null = null
  private tickCount = 0
  private emptyTicks = 0

  start(): void {
    if (this.handle) return
    this.handle = runPeriodic(
      'health-monitor.check',
      HEALTH_CHECK_INTERVAL_MS,
      HEALTH_CHECK_BUDGET_MS,
      (ctx) => this.checkInner(ctx),
    )
    // Adaptive interval: any session activity snaps the cadence back to 30s.
    // (Slow-down to 5min happens in checkInner when the active set stays empty.)
    // Global subscriber gated by an interest prefix — the interest set keeps
    // high-frequency streaming events from waking this handler (event-bus hot path).
    bus.subscribe('health-monitor-adaptive', () => {
      this.emptyTicks = 0
      this.handle?.setIntervalMs(HEALTH_CHECK_INTERVAL_MS)
    }, { global: true, interest: ['session:started', 'session:status-changed', 'session:start'] })
    log.session.info('session health monitor started', {
      intervalMs: HEALTH_CHECK_INTERVAL_MS, budgetMs: HEALTH_CHECK_BUDGET_MS, v2: HEALTH_V2,
    })
  }

  stop(): void {
    if (this.handle) {
      this.handle.stop()
      this.handle = null
      bus.unsubscribe('health-monitor-adaptive')
      log.session.info('session health monitor stopped')
    }
  }

  /**
   * Manual/test entry point — one tick without the periodic scheduler.
   * `ctx` defaults to an unlimited budget; pass one to exercise budget abandonment.
   */
  async check(ctx?: TickContext): Promise<void> {
    const noBudget: TickContext = { overBudget: () => false, elapsedMs: () => 0 }
    await this.checkInner(ctx ?? noBudget)
  }

  private async checkInner(ctx: TickContext): Promise<void> {
    const checkT0 = Date.now()
    this.tickCount++
    const { listSessions, listSessionsForHealthScan, isTerminalSession, updateSessionRecord } = await import('./session-tracker.js')

    // Process fd tripwire — a leaked fd table (~16k) once made every ssh spawn
    // fail EBADF, wedging all remote reconnects/reads (inc-1783406628291).
    // Self-throttled inside; failure must never affect the session checks.
    try {
      const { checkProcessFdHealth } = await import('./observability/process-health.js')
      checkProcessFdHealth()
    } catch { /* observability is best-effort */ }

    // ── Active-set snapshot per cycle (I1) ───────────────────────────────────
    // The tick's working set is the handful of sessions that can still change
    // state: running/idle (always) + stopped/error within the 24h recency window
    // (for connection-lost recovery and orphan sweeps). The whole-table scan that
    // used to live here (1385 "non-terminal" rows because 'stopped' never counted
    // as terminal) was the confirmed cause of the multi-hour event-loop stalls.
    let allSessions: SessionRecord[]
    try {
      allSessions = HEALTH_V2 ? await listSessionsForHealthScan() : await listSessions()
    } catch (err) {
      log.session.warn('health monitor: failed to list sessions', {
        error: err instanceof Error ? err.message : String(err),
      })
      return
    }

    // Adaptive cadence: nothing active for 3 consecutive ticks → slow to 5 min.
    // Any session:* bus event (see start()) snaps it back to 30s instantly.
    const hasActive = allSessions.some(s => s.process_status === 'running' || s.process_status === 'idle')
    if (!hasActive) {
      if (++this.emptyTicks >= 3) this.handle?.setIntervalMs(HEALTH_CHECK_IDLE_INTERVAL_MS)
    } else {
      this.emptyTicks = 0
      this.handle?.setIntervalMs(HEALTH_CHECK_INTERVAL_MS)
    }

    // Per-cycle liveness memo — isSessionProcessAlive is called up to 3× per session
    // (checkIdleTimeout, main loop, reconcileTaskPhases). Cache for the cycle.
    //
    // Promise-valued, not bool-valued: this coalesces racing callers within the same
    // tick who all call isSessionProcessAlive on the same session before the first
    // resolves — they share one in-flight probe instead of starting N of them.
    //
    // Key includes discriminators beyond claudeSessionId because killOrphanedProcesses
    // iterates ALL sessions (including archived). Per commit 1a93276, an archived
    // record can share its claudeSessionId with a new live record — but they have
    // different pid/host/process_status and must not share a cached liveness result.
    const livenessCache = new Map<string, Promise<boolean>>()
    const cachedIsAlive = (s: SessionRecord): Promise<boolean> => {
      const key = `${s.claudeSessionId}|${s.archived ? 'a' : 'l'}|${s.pid ?? 'n'}|${s.host ?? 'local'}`
      let p = livenessCache.get(key)
      if (!p) {
        p = isSessionProcessAlive(s)
        livenessCache.set(key, p)
      }
      return p
    }

    // Kill orphaned processes from terminal/stopped sessions (leaked processes).
    // Slow cadence: a leaked process doesn't need 30s precision, and the sweep's
    // input is its own SQL predicate (recent terminal rows with a pid), not the
    // active set. First tick also runs it so a restart cleans up promptly.
    if (this.tickCount === 1 || this.tickCount % ORPHAN_SWEEP_EVERY_TICKS === 0) {
      let orphanScan = allSessions
      if (HEALTH_V2) {
        try {
          const { listOrphanCandidates } = await import('./session-tracker.js')
          // activePids collision guard needs the active set too — concat both views.
          orphanScan = [...allSessions, ...await listOrphanCandidates()]
        } catch { /* fall back to active set only */ }
      }
      await this.killOrphanedProcesses(orphanScan, cachedIsAlive)
    }
    const tOrphan = Date.now()

    // Auto-recover remote sessions stuck in 'error' due to connection loss
    if (!ctx.overBudget()) {
      await this.recoverConnectionLostSessions(allSessions, updateSessionRecord)
    }
    const tRecover = Date.now()

    let sessions = allSessions.filter(s => !isTerminalSession(s) && !s.archived)

    // ── Drain the orphan dead-pool in ONE batch write (event-loop fix) ───────
    // A local session (host==null) with pid==null can never be alive:
    // isSessionProcessAlive() returns false for it (no PID to probe, no daemon).
    // Yet such records accumulate (server restarts, daemon resets) and each tick
    // the per-session loop below would do a SEPARATE synchronous updateSessionRecord
    // for every one of them — ~293 serial transactions/tick, the confirmed source
    // of the 15s HTTP stalls. Collapse them into a single batch transition, then
    // exclude them from the serial loop. Once 'stopped' they drop out of the
    // non-terminal filter above on the next tick, so the pool drains for good.
    //
    // 2-min grace on last_status_change protects a record mid-spawn whose PID
    // hasn't been persisted yet (mirrors killOrphanedProcesses' grace).
    const ORPHAN_GRACE_MS = 2 * 60 * 1000
    const nowMs = Date.now()
    const orphanIds: string[] = []
    sessions = sessions.filter((s) => {
      const isOrphan =
        s.host == null && s.pid == null &&
        // ACP-backed sessions (engine='codex') NEVER carry a PID — the worker is
        // a daemon child keyed by acpRuntimeId, and even a reaped worker stays
        // resumable via session/load. pid==null is their normal state, not orphanhood.
        s.engine !== 'codex' &&
        s.process_status !== 'stopped' && s.process_status !== 'error' &&
        (nowMs - new Date(s.last_status_change ?? s.startedAt ?? 0).getTime()) > ORPHAN_GRACE_MS
      if (isOrphan) { orphanIds.push(s.claudeSessionId); return false }
      return true
    })
    if (orphanIds.length > 0) {
      const { batchUpdateSessionRecords } = await import('./session-tracker.js')
      const written = await batchUpdateSessionRecords(orphanIds, {
        process_status: 'stopped',
        activity: undefined,
        last_status_change: new Date().toISOString(),
        status_reason: 'orphan_no_pid',
        status_changed_by: 'health-monitor',
      })
      log.session.info('health monitor: drained orphan dead-pool', { orphanCount: orphanIds.length, written: written.length })
    }

    if (sessions.length === 0) {
      const total = Date.now() - checkT0
      if (total > 500) log.session.warn('health monitor: check() slow (no active sessions)', { totalMs: total, orphanMs: tOrphan - checkT0, recoverMs: tRecover - tOrphan })
      return
    }

    // Batch-load only the tasks referenced by the scan set (avoids the previous
    // full listTasks() materialization — 3493 rows/tick for a handful of lookups).
    // Includes primary-session back-links: reconcileTaskPhases needs task.session_id(s)
    // which we can only know from the tasks themselves, so this is scan-set tasks only —
    // that is exactly its contract (it derives phase from THESE sessions' facts).
    // ── Per-phase timing ─────────────────────────────────────────────────────
    // Only orphanMs (t0→tOrphan) and recoverMs (tOrphan→tRecover) used to be
    // measured, and the slow-tick log emitted nothing else. So a tick reported as
    // `totalMs: 11224, orphanMs: 130, recoverMs: 0` said only "11 seconds went
    // somewhere in the seven phases below" — which is why a chronically slow phase
    // sat unnoticed. Time each one; the slow-tick log now names the culprit.
    const phaseMs: Record<string, number> = {}
    let phaseMark = Date.now()
    const endPhase = (name: string): void => {
      const now = Date.now()
      // Only record phases worth looking at, so the log line stays readable.
      if (now - phaseMark >= 1) phaseMs[name] = now - phaseMark
      phaseMark = now
    }

    let taskMap = new Map<string, Task>()
    try {
      const taskIds = [...new Set(sessions.map(s => s.taskId).filter((id): id is string => !!id))]
      const { listTasksByIds, listTasks } = await import('./task-manager.js')
      const tasks = HEALTH_V2 ? await listTasksByIds(taskIds) : await listTasks()
      for (const t of tasks) taskMap.set(t.id, t)
    } catch (err) {
      log.session.warn('health monitor: failed to load tasks for phase lookup', {
        error: err instanceof Error ? err.message : String(err),
      })
    }
    endPhase('loadTasks')

    // Detect stale handed-back sessions (stuck sub-agents)
    if (ctx.overBudget()) return
    // (checkStaleAwaitingSessions was deleted with the WAIT phase, 2026-08-18.
    // It stamped `activity: "Possibly stuck — no output for N min"` on WAIT
    // sessions; with handed-back work now living on AGENT_COMPLETE — the
    // normal state of every finished session — the warning would fire on
    // everything. Genuine wedges are covered by reconcileStuckRunningSessions.)
    endPhase('staleAwaiting')

    // Self-heal background-task panels for sessions that are NOT turn-over gating
    // candidates (idle / WAIT) — checkHungSessions only runs for
    // process_status==='running', and checkIdleTimeout's own reconcile call is
    // skipped entirely for WAIT and is a no-op once a `isBackgrounded`
    // task has already zeroed the turn-over count. Without this, a backgrounded
    // task's terminal event lost in a transport gap (SSH flap / daemon restart) has
    // NO tick that will ever PULL the daemon's authoritative state for it — the UI
    // panel shows the pre-restart snapshot forever (inc-1784012867247).
    if (ctx.overBudget()) return
    await this.reconcilePendingBackgroundTasks(sessions)
    endPhase('pendingBgTasks')

    // C2 snapshot pull channel — 30s PULL of the daemon-authoritative
    // SessionSnapshot for active sessions (contract §5). Complements the push
    // path: a dropped push degrades to "self-heals within one pull cycle".
    if (ctx.overBudget()) return
    await this.checkSnapshotPull(sessions, ctx)
    endPhase('snapshotPull')

    // Authoritative reconcile for stuck sessions — the periodic safety net behind
    // the event-driven paths. Any lost/swallowed result event (tailer freeze,
    // restart window, WS drop, replay-guard swallow) previously wedged
    // process_status at 'running' — or the task at IN_PROGRESS — forever because
    // NOTHING re-checked them against the daemon stream file. This does.
    if (ctx.overBudget()) return
    const reconciledIds = await this.reconcileStuckRunningSessions(sessions, taskMap)
    endPhase('reconcileStuck')

    // Detect hung Claude Code processes: message delivered but no Claude output for 5 minutes.
    // Root cause: Claude Code can hang internally (e.g. between autocompact and API call)
    // while the process stays alive. Idle timeout misses this because Walnut's own user
    // message writes refresh the file mtime.
    if (ctx.overBudget()) return
    const hungKilledIds = await this.checkHungSessions(sessions, updateSessionRecord, ctx)
    endPhase('hungSessions')

    // Idle timeout — kill sessions with stale outputFile mtime past the configured threshold.
    // Returns IDs of sessions it killed — the main loop must skip those to avoid
    // a race where the stale in-memory process_status ('idle') causes the main loop
    // to overwrite the correct 'stopped' with 'error' + "Process exited without result".
    if (ctx.overBudget()) return
    const idleTimedOutIds = await this.checkIdleTimeout(sessions, updateSessionRecord, taskMap, cachedIsAlive, ctx)
    endPhase('idleTimeout')

    if (ctx.overBudget()) return
    let livenessChecked = 0
    for (const session of sessions) {
      // In-loop budget: each iteration can await a liveness probe AND up to three
      // sequential writes, so the between-phase check alone let this loop run
      // arbitrarily past the budget. Abandoning is safe — every state transition
      // here is idempotent and re-derived from scratch next tick.
      if (ctx.overBudget()) {
        log.session.warn('health monitor: liveness loop abandoned mid-loop (over budget)', {
          checked: livenessChecked, sessionCount: sessions.length,
        })
        break
      }
      livenessChecked++
      // Skip sessions already handled by reconcile, idle timeout, or hung detection (prevents stale-state race)
      if (reconciledIds.has(session.claudeSessionId)) continue
      if (idleTimedOutIds.has(session.claudeSessionId)) continue
      if (hungKilledIds.has(session.claudeSessionId)) continue

      const alive = await cachedIsAlive(session)

      // alive=true: could be 'running' or 'idle' (don't override idle→running)
      // alive=false: process is dead or unreachable past grace period
      if (!alive && session.process_status !== 'stopped' && session.process_status !== 'error') {
        const now = new Date().toISOString()
        const taskPhase = session.taskId ? taskMap.get(session.taskId)?.phase : undefined
        const isWorkInProgress = taskPhase === 'IN_PROGRESS'

        // Remote session: daemon disconnection ≠ process death.
        // The remote process may still be alive — we just can't verify it right now.
        // Always use recoverable 'error' + "Connection lost" path regardless of
        // process_status or task phase, so recoverConnectionLostSessions() can
        // probe and restore the session after the daemon reconnects.
        if (session.host) {
          const updated = await updateSessionRecord(session.claudeSessionId, {
            process_status: 'error',
            errorMessage: 'Connection lost — unable to reach remote host',
            activity: undefined,
            last_status_change: now,
            status_reason: 'remote_unreachable',
            status_changed_by: 'health-monitor',
          } as any)
          log.session.warn('health monitor: remote session unreachable', {
            sessionId: session.claudeSessionId,
            taskId: session.taskId,
            previousProcessStatus: session.process_status,
            taskPhase,
          })
          emitSessionStatusChanged(
            updated,
            {},
            ['*'],
            { source: 'health-monitor', urgency: 'urgent' },
          )
          continue
        }

        // --- Local sessions only from here ---

        if (session.process_status === 'running' && isWorkInProgress) {
          // Process died while work was in progress — determine outcome.

          // Local sessions: read the last 8KB of the JSONL file to check for a result event.
          const hasResult = session.outputFile ? await this.outputFileHasResult(session.outputFile) : false

          let updated: SessionRecord
          if (hasResult) {
            // Normal completion — process_status 'stopped'
            updated = await updateSessionRecord(session.claudeSessionId, {
              process_status: 'stopped',
              activity: undefined,
              last_status_change: now,
              status_reason: 'normal_completion',
              status_changed_by: 'health-monitor',
            } as any)
          } else {
            // Error — process_status 'error' with detail
            updated = await updateSessionRecord(session.claudeSessionId, {
              process_status: 'error',
              errorMessage: 'Process exited without result',
              activity: undefined,
              last_status_change: now,
              status_reason: 'process_exited_no_result',
              status_changed_by: 'health-monitor',
            } as any)
          }

          // Clear session slot for both normal completion and error —
          // frees the task's 1-session slot so a new session can start.
          if (session.taskId) {
            try {
              const { clearSessionSlot } = await import('./task-manager.js')
              const { task } = await clearSessionSlot(session.taskId, session.claudeSessionId)
              bus.emit(EventNames.TASK_UPDATED, { task }, ['web-ui'], { source: hasResult ? 'session-complete' : 'session-error' })
            } catch (err) {
              log.session.warn('health monitor: failed to clear session slot', {
                sessionId: session.claudeSessionId,
                taskId: session.taskId,
                error: err instanceof Error ? err.message : String(err),
              })
            }
            // Phase sync: process death → AGENT_COMPLETE either way (session:result
            // with a result, session:error without — both land there since the
            // WAIT phase removal 2026-08-18; the error detail lives on the record)
            try {
              const { applySessionPhase } = await import('./phase.js')
              await applySessionPhase(
                session.taskId,
                hasResult ? 'session:result' : 'session:error',
                'health-monitor:process-death',
                { sessionId: session.claudeSessionId, processAlive: false },
              )
            } catch (err) {
              log.session.warn('health monitor: phase sync failed on process death', {
                sessionId: session.claudeSessionId, taskId: session.taskId,
                error: err instanceof Error ? err.message : String(err),
              })
            }
          }

          const newProcessStatus = hasResult ? 'stopped' : 'error'
          log.session.info('health monitor: session process died', {
            sessionId: session.claudeSessionId,
            taskId: session.taskId,
            newProcessStatus,
          })

          emitSessionStatusChanged(
            updated,
            {},
            ['*'],
            { source: 'health-monitor', urgency: 'urgent' },
          )
        } else {
          // Process died while idle or in non-in_progress state (local only).
          const updates: Record<string, unknown> = {
            last_status_change: now,
          }

          if (isWorkInProgress) {
            const hasResult = session.outputFile
              ? await this.outputFileHasResult(session.outputFile) : false
            if (hasResult) {
              updates.process_status = 'stopped'
              updates.status_reason = 'normal_completion'
            } else {
              updates.process_status = 'error'
              updates.errorMessage = 'Process exited without result'
              updates.status_reason = 'process_exited_no_result'
            }
            updates.activity = undefined
            updates.status_changed_by = 'health-monitor'
          } else {
            updates.process_status = 'stopped'
            updates.status_reason = 'liveness_check_failed'
            updates.status_changed_by = 'health-monitor'
          }

          const updated = await updateSessionRecord(session.claudeSessionId, updates)

          log.session.info('health monitor: process status updated', {
            sessionId: session.claudeSessionId,
            taskId: session.taskId,
            pid: session.pid,
            previousProcessStatus: session.process_status,
            taskPhase,
            ...(isWorkInProgress ? { newProcessStatus: updates.process_status } : {}),
          })

          if (isWorkInProgress) {
            emitSessionStatusChanged(
              updated,
              {},
              ['*'],
              { source: 'health-monitor', urgency: 'urgent' },
            )
            // Phase sync for idle process death with work in progress
            if (session.taskId) {
              const hasResult = updates.status_reason === 'normal_completion'
              try {
                const { applySessionPhase } = await import('./phase.js')
                await applySessionPhase(
                  session.taskId,
                  hasResult ? 'session:result' : 'session:error',
                  'health-monitor:process-death-idle',
                  { sessionId: session.claudeSessionId, processAlive: false },
                )
              } catch (err) {
                log.session.warn('health monitor: phase sync failed on idle process death', {
                  sessionId: session.claudeSessionId, taskId: session.taskId,
                  error: err instanceof Error ? err.message : String(err),
                })
              }
            }
          }
        }
      }
    }

    endPhase('livenessLoop')

    // Layer 2: Reconcile task phases from session facts (30s cycle)
    if (ctx.overBudget()) return
    await this.reconcileTaskPhases(sessions, taskMap, cachedIsAlive)
    endPhase('taskPhases')

    // Log total check duration (> 500ms = worth investigating)
    const checkTotal = Date.now() - checkT0
    if (checkTotal > 500) {
      // `phases` names the actual cost centre. `slowestPhase` is what to read first.
      const slowest = Object.entries(phaseMs).sort((a, b) => b[1] - a[1])[0]
      log.session.warn('health monitor: check() slow', {
        totalMs: checkTotal, orphanMs: tOrphan - checkT0, recoverMs: tRecover - tOrphan,
        sessionCount: sessions.length, taskCount: taskMap.size,
        phases: phaseMs,
        slowestPhase: slowest ? `${slowest[0]}=${slowest[1]}ms` : 'none',
      })
    }
  }

  /**
   * PULL daemon-authoritative background-task state for every non-terminal session
   * still holding a non-terminal `_bgTasks` entry, REGARDLESS of process_status or
   * task phase. This is the ONLY tick that reaches idle sessions
   * — checkHungSessions gates on process_status==='running', and checkIdleTimeout's
   * isBackgroundWorkActive call would be a
   * no-op anyway once a `isBackgrounded` task alone has zeroed the turn-over count
   * (see ClaudeCodeSession.hasPendingBackgroundTasks doc). Cheap: the session-side
   * check short-circuits before the daemon RPC when the task set has nothing
   * non-terminal left, so idle sessions with no pending work cost nothing here.
   */
  private async reconcilePendingBackgroundTasks(sessions: SessionRecord[]): Promise<void> {
    let runner: { reconcilePendingBackgroundTasks(id: string): Promise<void> } | undefined
    try {
      const { sessionRunner } = await import('../providers/claude-code-session.js')
      runner = sessionRunner
    } catch { return }

    // PARALLEL, not sequential: each call can wait out a full 30s daemon-command
    // timeout when a host's tunnel is in the "connected but no pong yet" stale
    // window (DaemonConnection.PING_INTERVAL_MS * 3 grace before it's declared
    // dead). A `for...of` + await here would serialize those 30s waits across
    // every session on that host — exactly the 30s/60s/90s-multiple check() stalls
    // this tick must not reproduce.
    const results = await Promise.allSettled(
      sessions.map((session) => runner!.reconcilePendingBackgroundTasks(session.claudeSessionId)),
    )
    for (let i = 0; i < results.length; i++) {
      const r = results[i]
      if (r.status === 'rejected') {
        log.session.debug('health monitor: reconcilePendingBackgroundTasks failed', {
          sessionId: sessions[i].claudeSessionId,
          error: r.reason instanceof Error ? r.reason.message : String(r.reason),
        })
      }
    }
  }

  /**
   * Detect sessions where a message was delivered but Claude produced no output.
   * Does NOT kill — just logs a warning and updates the activity field so the UI
   * shows a yellow banner. The user or idle timeout handles the actual recovery.
   *
   * Logs at 5 min (warn, once) so next time we have server-side evidence without
   * needing to dig through Claude Code's internal debug log.
   */
  private async checkHungSessions(
    sessions: SessionRecord[],
    updateSessionRecord: (id: string, update: Record<string, unknown>) => Promise<SessionRecord>,
    ctx?: TickContext,
  ): Promise<Set<string>> {
    const WARN_THRESHOLD_MS = 5 * 60 * 1000  // log warning after 5 min with no Claude output
    const flaggedIds = new Set<string>()

    let runner: { getSessionTimestamps(id: string): { lastClaudeOutputAt: number; lastMessageDeliveryAt: number } | undefined; isTeamActive(id: string): boolean; isBackgroundWorkActive(id: string): boolean | Promise<boolean> } | undefined
    try {
      const { sessionRunner } = await import('../providers/claude-code-session.js')
      runner = sessionRunner
    } catch { return flaggedIds }

    for (const session of sessions) {
      // Budget is enforced INSIDE the loop, not only between phases: this loop
      // makes one bounded daemon probe per session, so a large scan set can still
      // exceed the tick budget while the old between-phase check sat unreached.
      // Remaining sessions get the next tick — this phase is a detector, not a
      // correctness-critical write path.
      if (ctx?.overBudget()) {
        log.session.warn('health monitor: checkHungSessions abandoned mid-loop (over budget)', {
          checked: flaggedIds.size, sessionCount: sessions.length,
        })
        break
      }
      if (session.process_status !== 'running') continue

      // Skip team-active sessions — poll loop produces no Claude output, but is not hung
      if (runner.isTeamActive(session.claudeSessionId)) continue
      // Skip sessions running a dynamic workflow / background subagents — the main turn
      // produces no output for minutes, but the session is busy, not hung. L2: this PULLs the
      // daemon-authoritative task state and reconciles any lost-terminal event before deciding,
      // so a wedged session self-heals on this tick (see claude-code-session reconcileFromDaemon).
      // Bounded: this reaches a daemon RPC whose own timeout is 30s. On timeout we
      // assume busy (true) — the flagged path only writes a UI banner, so a false
      // "busy" costs one tick of visibility, while an unbounded wait costs the tick.
      if (await probeWithTimeout(
        runner.isBackgroundWorkActive(session.claudeSessionId), true,
        'isBackgroundWorkActive', session.claudeSessionId,
      )) continue

      const ts = runner.getSessionTimestamps(session.claudeSessionId)
      if (!ts) continue
      if (ts.lastMessageDeliveryAt === 0) continue  // no message delivered yet

      // Only flag if a message was delivered AFTER the last Claude output
      if (ts.lastClaudeOutputAt >= ts.lastMessageDeliveryAt) continue

      const waitingMs = Date.now() - ts.lastMessageDeliveryAt
      if (waitingMs < WARN_THRESHOLD_MS) continue

      const waitingMin = Math.round(waitingMs / 60_000)

      // Log warning (every 30s health check will re-log, but that's fine for diagnostics)
      log.session.warn('health monitor: possible hung session — no Claude output after message delivery', {
        sessionId: session.claudeSessionId,
        taskId: session.taskId,
        pid: session.pid,
        waitingMinutes: waitingMin,
        lastMessageDeliveryAt: new Date(ts.lastMessageDeliveryAt).toISOString(),
        lastClaudeOutputAt: ts.lastClaudeOutputAt ? new Date(ts.lastClaudeOutputAt).toISOString() : 'never',
      })

      // Update activity so UI shows a yellow warning banner
      const updated = await updateSessionRecord(session.claudeSessionId, {
        activity: `Waiting for response (${waitingMin} min)...`,
      })

      emitSessionStatusChanged(updated, {}, ['*'], { source: 'health-monitor' })

      flaggedIds.add(session.claudeSessionId)
    }

    return flaggedIds
  }

  /**
   * Idle timeout based on SessionManager.lastEventAt (preferred) or file mtime (fallback).
   *
   * Checks ALL non-terminal sessions with a live process. Defaults: 1h for
   * local, 2h for remote (remote sessions are cheap for the laptop and
   * premature reap produces a bogus "[Request interrupted by user]" marker in
   * the transcript — see CLI print.ts SIGINT handler). Override via
   * config.session.idle_timeout_minutes (applies to both unless 0 = disabled).
   *
   * (The old skip for WAIT-phase tasks went away with the WAIT phase, 2026-08-18.)
   */
  private async checkIdleTimeout(
    sessions: SessionRecord[],
    updateSessionRecord: (id: string, update: Record<string, unknown>) => Promise<SessionRecord>,
    taskMap: Map<string, Task>,
    cachedIsAlive: (s: SessionRecord) => Promise<boolean>,
    ctx?: TickContext,
  ): Promise<Set<string>> {
    const killedIds = new Set<string>()
    // Config override applies uniformly to local + remote when set. 0 = disabled.
    let configOverrideMs: number | null = null
    try {
      const { getConfig } = await import('./config-manager.js')
      const config = await getConfig()
      const mins = config.session?.idle_timeout_minutes
      if (mins != null) {
        configOverrideMs = mins === 0 ? 0 : mins * 60 * 1000
      }
    } catch (err) {
      log.session.debug('health monitor: config not available, using default idle timeout', {
        error: err instanceof Error ? err.message : String(err),
      })
    }

    // Explicit 0 override = disabled
    if (configOverrideMs === 0) return killedIds

    const now = Date.now()

    const { getRegisteredSessionManager } = await import('../providers/session-manager.js')

    // Import sessionRunner for team-active + cron-armed + background-work + permission checks (lazy, cached by Node module system)
    let runner: { isTeamActive(id: string): boolean; isCronArmed?(id: string): boolean; isBackgroundWorkActive?(id: string): boolean | Promise<boolean>; hasPendingPermission?(id: string): boolean } | undefined
    try {
      const { sessionRunner } = await import('../providers/claude-code-session.js')
      runner = sessionRunner
    } catch { /* fallback: no team check */ }

    for (const session of sessions) {
      // Budget enforced inside the loop (see checkHungSessions). Safe to abandon:
      // an idle session that misses this tick is reaped on the next one, and the
      // thresholds are 1–2 HOURS, so 30 s of extra life is immaterial.
      if (ctx?.overBudget()) {
        log.session.warn('health monitor: checkIdleTimeout abandoned mid-loop (over budget)', {
          killed: killedIds.size, sessionCount: sessions.length,
        })
        break
      }
      // Per-session threshold: config override wins; otherwise remote gets 2h, local gets 1h.
      const isRemote = !!session.host
      let idleTimeoutMs = configOverrideMs
        ?? (isRemote ? DEFAULT_REMOTE_IDLE_TIMEOUT_MS : DEFAULT_LOCAL_IDLE_TIMEOUT_MS)
      // Cron-armed sessions (/loop): the CLI's scheduler only looks idle
      // between fires, and killing the process kills a non-durable loop
      // (incident 2026-08-07: a 5-min /loop died at the 2h idle kill with no
      // error anywhere). A durable job would instead survive and be adopted by
      // a stranger sharing the cwd — which is why Walnut denies durable creates
      // (daemon-core.ts INVARIANT), leaving kill-loses-the-loop as the only
      // case to protect against here. Extended, not
      // disabled: the CLI auto-expires recurring crons after 7 days, so a
      // session idle beyond that has a dead scheduler and is safe to reclaim.
      if (runner?.isCronArmed?.(session.claudeSessionId)) {
        idleTimeoutMs = Math.max(idleTimeoutMs, CRON_ARMED_IDLE_TIMEOUT_MS)
      }

      // (The old WAIT-task exemption was deleted with the WAIT phase,
      // 2026-08-18. It must NOT be re-pointed at AGENT_COMPLETE: that is now
      // the normal post-turn state of every finished session, so exempting it
      // would make nearly every idle CLI immortal. A reaped session resumes
      // via --resume on the next send; nothing is lost.)

      // Skip team-active sessions — lead session is polling for in-process teammate
      // results (Claude Code team mode). No JSONL output during poll loop sleep, but
      // the session is NOT idle — teammates are working on the remote/local host.
      if (runner?.isTeamActive(session.claudeSessionId)) {
        log.session.debug('health monitor: skipping idle check — team active', {
          sessionId: session.claudeSessionId, taskId: session.taskId,
        })
        continue
      }

      // Skip sessions running a dynamic workflow / background subagents — they can run
      // for many minutes (up to the CLI's 10-min bg-wait ceiling) with no main-turn
      // output, but the session is busy, not idle. Killing it would abort the workflow.
      // L2: PULLs the daemon-authoritative task state and reconciles any lost-terminal event
      // first, so a wedged session self-heals on this tick (see reconcileFromDaemon).
      // Bounded (see probeWithTimeout): on timeout assume ACTIVE. The false branch
      // of this check leads to killing the session, so an unknown answer must never
      // be read as "idle" — that would reap a live workflow because a host was slow.
      if (await probeWithTimeout(
        runner?.isBackgroundWorkActive?.(session.claudeSessionId) ?? false, true,
        'isBackgroundWorkActive', session.claudeSessionId,
      )) {
        log.session.debug('health monitor: skipping idle check — background work active', {
          sessionId: session.claudeSessionId, taskId: session.taskId,
        })
        continue
      }

      // Skip sessions waiting for permission — they re-emit every 60s for visibility.
      // No auto-resolve: session waits indefinitely for human decision.
      // Don't kill the process: Claude Code is alive but blocked on control_response.
      if (runner?.hasPendingPermission?.(session.claudeSessionId)) {
        log.session.debug('health monitor: skipping idle check — pending permission', {
          sessionId: session.claudeSessionId, taskId: session.taskId,
        })
        continue
      }

      // Check if process is actually alive before spending time on idle check
      if (!await cachedIsAlive(session)) continue

      // Determine last activity time:
      // 1. Prefer SessionManager.lastEventAt (works for both local and remote)
      // 2. Fallback to file mtime for local sessions without an active manager
      const mgr = getRegisteredSessionManager(session.claudeSessionId)
      let lastActiveMs: number
      if (mgr) {
        lastActiveMs = mgr.lastEventAt
        if (lastActiveMs === 0) continue  // No events received yet — skip
      } else if (session.outputFile && !session.outputFile.startsWith('remote://')) {
        try {
          const stat = await fsp.stat(session.outputFile)
          lastActiveMs = stat.mtimeMs
        } catch {
          continue  // Can't stat file — skip
        }
      } else {
        continue  // No manager and no output file (or remote sentinel) — skip
      }

      const idleDurationMs = now - lastActiveMs
      if (idleDurationMs < idleTimeoutMs) continue

      // Second-line defense: if the session record shows a recent status
      // transition (e.g. AGENT_COMPLETE → IN_PROGRESS triggered by a
      // fresh user message), treat that as activity even if lastEventAt is
      // stale. Otherwise a remote session that just received a new message
      // — but whose first JSONL response hasn't arrived yet — would be
      // killed mid-turn. The primary fix bumps lastEventAt on writeMessage
      // (remote-session-manager.ts); this guard catches any other code path
      // that moves the session record forward without touching the manager.
      if (session.last_status_change) {
        const statusChangeMs = Date.parse(session.last_status_change)
        if (!Number.isNaN(statusChangeMs) && now - statusChangeMs < idleTimeoutMs) {
          log.session.debug('health monitor: skipping idle check — recent status change', {
            sessionId: session.claudeSessionId,
            lastStatusChange: session.last_status_change,
            ageMs: now - statusChangeMs,
          })
          continue
        }
      }

      const idleMinutes = Math.round(idleDurationMs / 60_000)
      log.session.info('health monitor: idle timeout — killing session', {
        sessionId: session.claudeSessionId,
        taskId: session.taskId,
        pid: session.pid,
        host: session.host,
        idleMinutes,
        thresholdMinutes: Math.round(idleTimeoutMs / 60_000),
        source: mgr ? 'lastEventAt' : 'file-mtime',
      })

      // Mark BEFORE any signal: an unmarked kill reaches the session's liveness
      // monitor as an unexplained death and used to be reported as "session init
      // failed" (red toast quoting stale spawn-time stderr, 2026-08-10).
      try {
        const { sessionRunner: r } = await import('../providers/claude-code-session.js')
        r.markExpectedTeardown(session.claudeSessionId, 'idle_timeout')
      } catch { /* runner unavailable — the kill is still correct */ }

      // Graceful kill via session manager if available (handles both local + remote),
      // otherwise fall back to local PID signals.
      if (mgr) {
        mgr.kill()
      } else {
        const pid = session.pid
        if (pid == null) continue  // No PID — can't signal; skip to next session
        // Kill entire process group (-pid) to also clean up MCP child processes.
        // safeKillProcessGroup refuses pid ≤ 1 — a corrupted pid here would
        // otherwise broadcast the kill to the whole user session (2026-08-09).
        safeKillProcessGroup(pid, 'SIGINT')
        // Deferred SIGTERM/SIGKILL fallback — fire-and-forget, doesn't block health check loop
        setTimeout(() => {
          isProcessAliveAsync(pid, 'claude').then((alive) => {
            if (alive) {
              safeKillProcessGroup(pid, 'SIGTERM')
              setTimeout(() => {
                safeKillProcessGroup(pid, 'SIGKILL')
              }, 2_000)
            }
          }).catch(() => {})
        }, 5_000)
      }

      killedIds.add(session.claudeSessionId)

      const updateNow = new Date().toISOString()
      const updated = await updateSessionRecord(session.claudeSessionId, {
        process_status: 'stopped',
        errorMessage: `No output for ${idleMinutes} min`,
        activity: undefined,
        last_status_change: updateNow,
        status_reason: 'idle_timeout',
        status_changed_by: 'health-monitor',
      } as any)

      emitSessionStatusChanged(updated, {}, ['*'], { source: 'health-monitor' })

      // Phase sync: idle timeout → WAIT (we killed the session, not a normal completion)
      if (session.taskId) {
        try {
          const { applySessionPhase } = await import('./phase.js')
          await applySessionPhase(
            session.taskId, 'session:error', 'health-monitor:idle-timeout',
            { sessionId: session.claudeSessionId, processAlive: false },
          )
        } catch (err) {
          log.session.warn('health monitor: phase sync failed on idle timeout', {
            sessionId: session.claudeSessionId, taskId: session.taskId,
            error: err instanceof Error ? err.message : String(err),
          })
        }
      }
    }

    return killedIds
  }



  /**
   * C2 snapshot pull channel (contract §5): every 30s tick, for records in
   * {running, idle} on a native (non-codex, non-embedded/sdk) engine whose
   * host has a POOLED CONNECTED DaemonConnection advertising 'snapshot-v1',
   * PULL getState and feed the snapshot to applySnapshot. NEVER dials a new
   * connection. Sequential, capped at 10 sids/tick, per-sid 25s spacing.
   *
   * TWO fairness/budget properties this loop must keep (C8/C9/C12/C29):
   *
   *  - It honors the TickContext budget INSIDE the loop (same discipline as
   *    checkHungSessions). Each iteration is a real daemon RPC with a
   *    probe-timeout ceiling, so 10 slow hosts could burn 10 × the probe
   *    timeout sequentially BEFORE the authoritative reconcile phases that run
   *    after it. Abandoning mid-loop is safe: this is a self-healing safety
   *    net, every pull is idempotent, and the remaining sids come first on the
   *    next tick (see the rotation below).
   *
   *  - Candidates are ordered by lastPullAt ASCENDING (never-pulled first),
   *    which turns the 10/tick cap into a round-robin. In list order the SAME
   *    first ten sids were pulled every tick and — because the 25s spacing is
   *    shorter than the 30s cadence — sids 11+ were never pulled at all: the
   *    pull channel silently did not exist for them.
   */
  private snapshotPullAt = new Map<string, number>()

  private async checkSnapshotPull(sessions: SessionRecord[], ctx?: TickContext): Promise<void> {
    const PULL_MIN_GAP_MS = 25_000
    const MAX_PULLS_PER_TICK = 10
    try {
      const { getSnapshotStatusMode } = await import('./session-snapshot-gate.js')
      if (getSnapshotStatusMode() === 'off') return
      const { getPooledSnapshotConnection } = await import('../providers/daemon-connection.js')
      const { applySnapshot } = await import('./session-snapshot-apply.js')

      const now = Date.now()
      // Eligibility first, then oldest-pull-first ordering. Stable within equal
      // timestamps (Array.sort is stable), so a never-pulled batch keeps list
      // order and the rotation is deterministic.
      const candidates = sessions
        .filter((s) => {
          if (s.process_status !== 'running' && s.process_status !== 'idle') return false
          if (s.engine === 'codex') return false
          if (s.provider === 'embedded' || s.provider === 'sdk') return false
          if (s.status_reason === 'awaiting_spawn') return false
          const lastPull = this.snapshotPullAt.get(s.claudeSessionId) ?? 0
          return now - lastPull >= PULL_MIN_GAP_MS
        })
        .sort((a, b) =>
          (this.snapshotPullAt.get(a.claudeSessionId) ?? 0) - (this.snapshotPullAt.get(b.claudeSessionId) ?? 0))

      let pulled = 0
      let capped = false
      for (const s of candidates) {
        if (ctx?.overBudget()) {
          log.session.warn('health monitor: checkSnapshotPull abandoned mid-loop (over budget)', {
            pulled, candidateCount: candidates.length,
          })
          break
        }
        const conn = getPooledSnapshotConnection(s.host)
        if (!conn) continue // no pooled snapshot-capable connection — skip (never dial)
        if (pulled >= MAX_PULLS_PER_TICK) { capped = true; break }
        pulled++
        this.snapshotPullAt.set(s.claudeSessionId, now)
        try {
          // Sequential on purpose: this is a background safety net; parallel
          // fan-out to a slow host would stack daemon RPCs on the tick budget.
          const resp = await probeWithTimeout(
            conn.send('getState', { sid: s.claudeSessionId }),
            null as Record<string, unknown> | null,
            'snapshot-pull-getState', s.claudeSessionId,
          )
          const snapshot = resp?.ok ? (resp as { snapshot?: import('../providers/daemon-fold.js').SessionSnapshot }).snapshot : undefined
          if (snapshot) await applySnapshot(s.claudeSessionId, snapshot, 'pull-30s')
        } catch (err) {
          log.session.debug('health monitor: snapshot pull failed', {
            sessionId: s.claudeSessionId, host: s.host ?? '__local__',
            error: err instanceof Error ? err.message : String(err),
          })
        }
      }
      if (capped) {
        log.session.info('health monitor: snapshot pull capped this tick', {
          cap: MAX_PULLS_PER_TICK, sessionCount: sessions.length,
          candidateCount: candidates.length,
        })
      }
      // Bounded memory: drop timestamps for sids no longer in the scan set.
      if (this.snapshotPullAt.size > 200) {
        const liveIds = new Set(sessions.map((s) => s.claudeSessionId))
        for (const sid of this.snapshotPullAt.keys()) {
          if (!liveIds.has(sid)) this.snapshotPullAt.delete(sid)
        }
      }
    } catch (err) {
      log.session.warn('health monitor: checkSnapshotPull failed', {
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  /**
   * Periodic authoritative reconcile for sessions with status debt.
   *
   * The event-driven status paths can all be defeated by ONE lost result event
   * (remote: daemon tailer freeze; local: server restart landing in the result
   * window) or a swallowed one (replay guard fed by a wrong resultEmitted seed —
   * incident 10e7df54). This check re-derives the truth from the daemon STREAM
   * file tail via reconcileProcessStatus() and converges the record AND the
   * task phase when the turn provably ended. It is deliberately conservative:
   *   - only debt shapes: process_status==='running', OR a settled record whose
   *     task is still IN_PROGRESS (the incident-C wedge)
   *   - skipped while events are visibly flowing (genuinely-streaming turns never
   *     pay the tail read)
   *   - per-session retry backoff bounds the I/O for a session that stays
   *     wedged-but-active (frozen tailer, turn still running) — one tail read
   *     per RECONCILE_RETRY_MS, not per 30s tick
   */
  private reconcileAttemptAt = new Map<string, number>()

  private async reconcileStuckRunningSessions(sessions: SessionRecord[], taskMap?: Map<string, Task>): Promise<Set<string>> {
    const ACTIVITY_FRESH_MS = 3 * 60 * 1000   // events this recent = genuinely streaming
    const RECONCILE_RETRY_MS = 5 * 60 * 1000  // min gap between tail reads per session
    const MAX_PER_TICK = 5                    // bound worst-case I/O per 30s tick
    const convergedIds = new Set<string>()

    const { getRegisteredSessionManager } = await import('../providers/session-manager.js')
    const now = Date.now()
    let attempted = 0

    for (const session of sessions) {
      if (attempted >= MAX_PER_TICK) break
      const recordDebt = session.process_status === 'running'
      // Phase debt (incident 10e7df54): record settled but the linked task never
      // saw the (swallowed) result — stuck IN_PROGRESS with nothing to advance it.
      const settled = session.process_status === 'idle' || session.process_status === 'stopped'
        || session.process_status === 'error'
      const phaseDebt = !recordDebt && settled && !!session.taskId
        && taskMap?.get(session.taskId)?.phase === 'IN_PROGRESS'
      if (!recordDebt && !phaseDebt) continue
      // Embedded/SDK sessions have no CLI JSONL lifecycle — nothing to reconcile.
      if (session.provider === 'embedded' || session.provider === 'sdk') continue

      // Activity gate: events flowing (or local stream file fresh) = the turn is
      // genuinely live; don't burn a JSONL read on it.
      const mgr = getRegisteredSessionManager(session.claudeSessionId)
      if (mgr && mgr.lastEventAt > 0 && now - mgr.lastEventAt < ACTIVITY_FRESH_MS) continue
      if (isLocalJsonlFresh(session, ACTIVITY_FRESH_MS) === true) continue

      // Per-session backoff — a wedged-but-still-running session (frozen tailer
      // with a live CLI) would otherwise trigger a full JSONL read every tick.
      const lastAttempt = this.reconcileAttemptAt.get(session.claudeSessionId) ?? 0
      if (now - lastAttempt < RECONCILE_RETRY_MS) continue

      try {
        attempted++
        this.reconcileAttemptAt.set(session.claudeSessionId, now)
        const { reconcileProcessStatus } = await import('./session-reconcile.js')
        const outcome = await reconcileProcessStatus(session, { minAgeMs: ACTIVITY_FRESH_MS })
        if (outcome.converged) {
          this.reconcileAttemptAt.delete(session.claudeSessionId)
          convergedIds.add(session.claudeSessionId)
          log.session.info('health monitor: reconciled stuck session', {
            sessionId: session.claudeSessionId,
            taskId: session.taskId,
            to: outcome.to,
            phaseSynced: outcome.phaseSynced ?? false,
            debt: recordDebt ? 'record' : 'phase',
          })
          // Sync live CCS instance so in-memory state and DB agree.
          try {
            const { sessionRunner } = await import('../providers/claude-code-session.js')
            const liveSession = sessionRunner.findSessionByClaudeId(session.claudeSessionId)
            if (liveSession) liveSession.setProcessStatusFromReconciler(outcome.to)
          } catch { /* runner not loaded — session is attach-only */ }
        }
      } catch (err) {
        log.session.warn('health monitor: reconcile attempt failed', {
          sessionId: session.claudeSessionId,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }

    // Drop map entries for sessions no longer in the running set (bounded memory).
    if (this.reconcileAttemptAt.size > 200) {
      const runningIds = new Set(sessions.filter(s => s.process_status === 'running').map(s => s.claudeSessionId))
      for (const sid of this.reconcileAttemptAt.keys()) {
        if (!runningIds.has(sid)) this.reconcileAttemptAt.delete(sid)
      }
    }
    return convergedIds
  }

  /**
   * Kill orphaned OS processes from sessions that are in terminal state
   * (completed/error) or marked stopped but whose process is still alive.
   * These are invisible to the normal health checks (which only scan non-terminal sessions)
   * and accumulate over time, eventually exhausting OS resources.
   *
   * NOTE: This function is the PID-reuse defense for Walnut. isSessionProcessAlive()
   * no longer does `ps`-based binary verification (too expensive on the hot path) —
   * see the header comment in src/utils/session-liveness.ts for the full rationale.
   * The 2-minute grace period + activePids collision check below are what prevent us
   * from killing a recycled PID that now belongs to a different, still-active session.
   */
  private async killOrphanedProcesses(
    sessions: SessionRecord[],
    cachedIsAlive: (s: SessionRecord) => Promise<boolean>,
  ): Promise<void> {
    // Grace period: don't kill processes whose session record changed very recently.
    // The reconciler or other subsystems may have just updated the record, and the
    // current state may be transient. Real orphans are always older than 2 minutes.
    // 2 min = worst-case reconciler duration + a few HEALTH_CHECK_INTERVAL_MS (30s each)
    // cycles to handle transient states created during server startup.
    const ORPHAN_GRACE_MS = 2 * 60 * 1000

    try {
      const { isTerminalSession } = await import('./session-tracker.js')

      // Build set of PIDs actively used by non-terminal, non-stopped sessions.
      // This prevents PID-reuse collisions: OS can recycle a PID from a completed
      // session and assign it to a new active session.
      const activePids = new Set<number>()
      for (const s of sessions) {
        if (s.pid == null) continue
        const isStopped = s.process_status === 'stopped' || s.process_status === 'error'
        if (!isTerminalSession(s) && !isStopped) {
          activePids.add(s.pid)
        }
      }

      const now = Date.now()
      let killed = 0
      for (const s of sessions) {
        if (s.pid == null) continue
        if (s.provider === 'embedded' || s.provider === 'sdk') continue

        // Only target sessions that SHOULD have no running process
        const isStopped = s.process_status === 'stopped' || s.process_status === 'error'
        if (!isTerminalSession(s) && !isStopped) continue

        // Grace period: skip sessions whose record was recently changed.
        // Prevents killing processes during transient reconciler/startup race windows.
        const lastChange = s.last_status_change ?? s.lastActiveAt
        if (lastChange && (now - new Date(lastChange).getTime()) < ORPHAN_GRACE_MS) continue

        // PID reuse protection: skip if this PID is used by an active session
        if (activePids.has(s.pid)) {
          log.session.warn('health monitor: skipping orphan kill — PID reuse collision detected', {
            staleSessionId: s.claudeSessionId, pid: s.pid,
            staleProcessStatus: s.process_status,
          })
          continue
        }

        if (!await cachedIsAlive(s)) continue

        // GROUND-TRUTH RECHECK before a destructive kill — veto on POSITIVE proof of life.
        // We only reach here because the session is terminal/stopped AND the pid is still
        // alive — exactly the state a WRONG 'stopped' flag produces (e.g. the server-restart
        // reconciler mis-marking a live local session). Trusting that stale flag is what
        // SIGTERM'd a healthy CLI in the false-zombie incident. The DB status flag is not
        // authoritative; the JSONL mtime is (same signal the daemon's reapSession uses).
        // Veto ONLY on `=== true` (a fresh JSONL = positive proof the CLI is still working).
        // 'unknown' (remote session, or local file already cleaned/archived) is NOT evidence
        // of life and must fall through — vetoing on it would leak orphans. PID-reuse here is
        // already guarded by the activePids check above; remote cleanup is the daemon's job.
        if (isLocalJsonlFresh(s, ORPHAN_GRACE_MS) === true) {
          log.session.warn('health monitor: skipping orphan kill — JSONL recently written (process alive despite stopped flag)', {
            sessionId: s.claudeSessionId, pid: s.pid, process_status: s.process_status,
          })
          continue
        }

        log.session.warn('health monitor: killing orphaned process', {
          sessionId: s.claudeSessionId,
          taskId: s.taskId,
          pid: s.pid,
          process_status: s.process_status,
        })

        // Mark first so the death reads as expected, not as an init failure.
        try {
          const { sessionRunner: r } = await import('../providers/claude-code-session.js')
          r.markExpectedTeardown(s.claudeSessionId, 'orphan_cleanup')
        } catch { /* runner unavailable — the kill is still correct */ }

        // Kill entire process group (-pid) to also clean up MCP child processes
        safeKillProcessGroup(s.pid, 'SIGTERM')

        // Remote process cleanup is handled by daemon transport when the local tunnel dies.

        killed++
      }

      if (killed > 0) {
        log.session.info('health monitor: killed orphaned processes', { count: killed })
      }
    } catch (err) {
      log.session.debug('health monitor: orphan process cleanup failed, will retry', {
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  /**
   * Auto-recover remote sessions stuck in 'error' with "Connection lost" message.
   *
   * This is the persistent recovery loop that runs every 30s. It complements
   * DaemonConnection.recoverDisconnectedSessions() (which is one-shot on reconnect)
   * by continuously retrying recovery for sessions that were missed due to
   * timing races (e.g. daemon reconnected before health monitor marked error).
   *
   * For each matching session:
   *   - Daemon connected + process alive → restore to 'running'
   *   - Daemon connected + process dead → set 'stopped' (resumable)
   *   - Daemon not connected → update activity to "Reconnecting..." (UI shows yellow banner)
   */
  private async recoverConnectionLostSessions(
    sessions: SessionRecord[],
    updateSessionRecord: (id: string, update: Record<string, unknown>) => Promise<SessionRecord>,
  ): Promise<void> {
    try {
      const { isDaemonConnected, probeDaemonSession } = await import('../providers/daemon-connection.js')

      // Per-tick cap: each probe can serially wait out a 30s daemon-command
      // timeout on a bad host; unbounded, one flaky host eats the whole tick
      // budget. Remaining candidates get the next tick.
      const MAX_RECOVER_PER_TICK = 10
      let probed = 0

      for (const s of sessions) {
        if (probed >= MAX_RECOVER_PER_TICK) break
        // Only target remote sessions in error state with "Connection lost" message
        if (!s.host) continue
        if (s.process_status !== 'error') continue
        if (!s.errorMessage?.includes('Connection lost')) continue
        if (s.archived) continue
        probed++

        try {
          if (isDaemonConnected(s.host)) {
            // Daemon is connected — probe the remote process
            const probe = await probeDaemonSession(s.host, s.claudeSessionId)

            if (probe === null) {
              // Probe failed (daemon disconnected mid-probe) — retry next cycle
              continue
            }

            const now = new Date().toISOString()
            if (probe.alive) {
              // Process still running — restore session
              const updated = await updateSessionRecord(s.claudeSessionId, {
                process_status: 'running',
                errorMessage: undefined,
                activity: undefined,
                last_status_change: now,
                status_reason: 'auto_recovered',
                status_changed_by: 'health-monitor',
              } as any)
              emitSessionStatusChanged(
                updated,
                {},
                ['*'],
                { source: 'health-monitor', urgency: 'urgent' },
              )
              log.session.info('health monitor: auto-recovered connection-lost session', {
                sessionId: s.claudeSessionId, host: s.host, alive: true,
              })
            } else {
              // Process dead — mark stopped (user's next message will --resume)
              const updated = await updateSessionRecord(s.claudeSessionId, {
                process_status: 'stopped',
                errorMessage: undefined,
                activity: undefined,
                last_status_change: now,
                status_reason: 'auto_recovered_dead',
                status_changed_by: 'health-monitor',
              } as any)
              emitSessionStatusChanged(
                updated,
                {},
                ['*'],
                { source: 'health-monitor', urgency: 'urgent' },
              )
              log.session.info('health monitor: auto-recovered connection-lost session (process dead)', {
                sessionId: s.claudeSessionId, host: s.host, alive: false,
              })

              // Phase sync: remote process died during connection loss — result may
              // have been lost. Advance task phase so it doesn't stay stuck at IN_PROGRESS.
              if (s.taskId) {
                try {
                  const { applySessionPhase } = await import('./phase.js')
                  await applySessionPhase(
                    s.taskId, 'session:result', 'health-monitor:remote-dead-recovery',
                    { sessionId: s.claudeSessionId, processAlive: false },
                  )
                } catch (err) {
                  log.session.warn('health monitor: phase sync failed on remote dead recovery', {
                    sessionId: s.claudeSessionId, taskId: s.taskId,
                    error: err instanceof Error ? err.message : String(err),
                  })
                }
              }
            }
          } else {
            // Daemon not connected — update activity so UI shows "Reconnecting..." banner
            // Only update if not already showing reconnecting message (avoid churn)
            if (s.activity !== 'Reconnecting to remote host...') {
              const updated = await updateSessionRecord(s.claudeSessionId, {
                activity: 'Reconnecting to remote host...',
              })
              emitSessionStatusChanged(updated, {}, ['*'], { source: 'health-monitor' })
            }
          }
        } catch (err) {
          log.session.debug('health monitor: connection-lost recovery failed for session', {
            sessionId: s.claudeSessionId, host: s.host,
            error: err instanceof Error ? err.message : String(err),
          })
        }
      }
    } catch (err) {
      log.session.warn('health monitor: recoverConnectionLostSessions failed', {
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  /**
   * Layer 2 Reconciler: derive expected task phase from session facts.
   * Called every 30s. Only fixes drift — if phase is already correct, does nothing.
   *
   * IMPORTANT: Only considers the task's PRIMARY sessions (listed in task.session_ids
   * or task.session_id). Subagents (triage, etc.) also carry taskId but are NOT
   * primary sessions — their liveness must not affect task phase.
   */
  private async reconcileTaskPhases(
    sessions: SessionRecord[],
    taskMap: Map<string, Task>,
    cachedIsAlive: (s: SessionRecord) => Promise<boolean>,
  ): Promise<void> {
    const { TERMINAL_PHASES } = await import('./phase.js')

    // Build set of primary session IDs per task (from task records, not session records)
    const primarySessionIds = new Set<string>()
    for (const task of taskMap.values()) {
      if (task.session_id) primarySessionIds.add(task.session_id)
      if (task.session_ids) for (const sid of task.session_ids) primarySessionIds.add(sid)
    }

    // Deduplicate: process each task at most once.
    // Collect primary sessions per task, then decide phase per task.
    const taskSessions = new Map<string, { alive: SessionRecord[]; dead: SessionRecord[] }>()

    // Freshness grace: the reconciler exists for tasks STUCK at IN_PROGRESS,
    // not tasks that just started a turn. A send flips the phase IN_PROGRESS and
    // then cold-resumes the CLI, which for a whale session takes minutes before
    // any liveness signal (manager registration / snapshot) is visible — the
    // 30s tick landing inside that window flipped a 19-second-old IN_PROGRESS
    // back to AGENT_COMPLETE while the CLI was booting (incident 0dc8352f,
    // 2026-08-18: "Running 但 Agent Complete"). Anything written within the
    // grace window is in flight, not stuck; a genuinely stuck task ages past
    // this in one tick cycle.
    const RECONCILE_GRACE_MS = 10 * 60 * 1000
    const graceNow = Date.now()

    for (const session of sessions) {
      if (session.archived || !session.taskId) continue
      // Only consider primary sessions — skip subagents/triage
      if (!primarySessionIds.has(session.claudeSessionId)) continue
      const task = taskMap.get(session.taskId)
      if (!task || TERMINAL_PHASES.has(task.phase)) continue
      const updatedMs = Date.parse(task.updated_at ?? '')
      if (Number.isFinite(updatedMs) && graceNow - updatedMs < RECONCILE_GRACE_MS) continue

      if (!taskSessions.has(session.taskId)) {
        taskSessions.set(session.taskId, { alive: [], dead: [] })
      }
      const bucket = taskSessions.get(session.taskId)!
      let processAlive = await cachedIsAlive(session)
      // See-through for a STALE stopped/error flag: isSessionProcessAlive
      // short-circuits on the record's process_status BEFORE consulting the
      // manager registry (that order is load-bearing for the orphan-kill
      // sweep — do not change it there). But during a cold --resume the record
      // still says 'stopped' (enforce mode suppresses the legacy running write
      // until the daemon snapshot lands) while a live manager is already
      // registered and its CLI is booting/streaming. For the reconciler that
      // stale flag must not count as a death (incident 0dc8352f, 2026-08-18).
      if (!processAlive) {
        try {
          const { getRegisteredSessionManager } = await import('../providers/session-manager.js')
          const mgr = getRegisteredSessionManager(session.claudeSessionId)
          if (mgr && await mgr.isAlive()) processAlive = true
        } catch { /* registry unavailable — keep the probe's verdict */ }
      }
      ;(processAlive ? bucket.alive : bucket.dead).push(session)
    }

    for (const [taskId, { alive, dead }] of taskSessions) {
      const task = taskMap.get(taskId)!

      // Only Rule A: all primary sessions dead + task stuck at IN_PROGRESS → needs attention.
      // isProcessAlive() is a hard OS fact for local sessions — safe to act on.
      //
      // GUARD: if ALL dead sessions are remote and the daemon is currently disconnected
      // (status_reason === 'remote_unreachable'), liveness is UNKNOWN — a tunnel flap
      // causes isAlive→false but the CLI is likely still running on the remote host.
      // Do NOT force WAIT from connectivity loss alone (inc-311a517d).
      //
      // NO Rule B (alive → force IN_PROGRESS): if process_status is accurate, Layer 1
      // already set IN_PROGRESS on session:input. If process_status is wrong (e.g. stuck
      // at 'running' when should be 'idle'), propagating it to task phase makes two things
      // wrong. Fix session status accuracy instead.
      let expectedPhase: TaskPhase | null = null
      if (alive.length === 0 && task.phase === 'IN_PROGRESS') {
        // All dead sessions are remote + unreachable? → connectivity unknown, skip.
        //
        // TWO signals, either one means "the isAlive probe is connectivity noise,
        // not a death" (inc-1786691991988, 2026-08-14): the status_reason
        // breadcrumb is stamped by the unreachable write path — but under the
        // snapshot gate's enforce mode that whole legacy write is SUPPRESSED
        // when the daemon-authoritative record still says 'running', so the
        // breadcrumb never lands. In that shape the record's process_status IS
        // the daemon's truth: a remote record still marked running while the
        // probe says dead = an SSH flap, and flipping the task to
        // WAIT paints a live session red (reported verbatim as "Running 又是
        // Await Human Action 这不对吧" — WAIT was named AWAIT_HUMAN_ACTION then).
        const allRemoteUnreachable = dead.length > 0 && dead.every(
          s => s.host && (s.status_reason === 'remote_unreachable' || s.process_status === 'running'),
        )
        if (!allRemoteUnreachable) {
          // All primary sessions dead + stuck at IN_PROGRESS → the work was
          // handed back whether or not a result event survived. AGENT_COMPLETE
          // (was WAIT until that phase's removal 2026-08-18): red+unread, the
          // human decides whether it actually finished.
          expectedPhase = 'AGENT_COMPLETE'
        }
      }

      if (expectedPhase) {
        const representativeSession = alive[0] ?? dead[0]
        log.session.warn('reconciler: fixing phase drift', {
          taskId, actual: task.phase, expected: expectedPhase,
          sessionId: representativeSession?.claudeSessionId,
          aliveSessions: alive.length, deadSessions: dead.length,
        })
        try {
          const { applySessionPhase } = await import('./phase.js')
          await applySessionPhase(
            taskId, 'reconciler', 'health-monitor:reconciler',
            { sessionId: representativeSession?.claudeSessionId, newPhase: expectedPhase },
          )
        } catch (err) {
          log.session.warn('reconciler: phase fix failed', {
            taskId, expected: expectedPhase,
            error: err instanceof Error ? err.message : String(err),
          })
        }
      }
    }
  }

  private async outputFileHasResult(filePath: string): Promise<boolean> {
    // Only read last ~8KB — result event is always the final JSONL line.
    // Avoids reading 100MB+ files for long sessions.
    let fh: fsp.FileHandle | undefined
    try {
      fh = await fsp.open(filePath, 'r')
      const stat = await fh.stat()
      const TAIL_BYTES = 8192
      const start = Math.max(0, stat.size - TAIL_BYTES)
      const buf = Buffer.alloc(Math.min(TAIL_BYTES, stat.size))
      await fh.read(buf, 0, buf.length, start)
      const tail = buf.toString('utf-8')
      for (const line of tail.split('\n')) {
        if (!line.trim()) continue
        try {
          const event = JSON.parse(line)
          // A result with is_error:true (e.g. --resume "No conversation found")
          // is NOT a successful completion — treat it as no result.
          if (event.type === 'result') return !event.is_error
        } catch { continue }  // expected: partial JSON lines in tail buffer
      }
    } catch (err) {
      log.session.debug('health monitor: cannot read output file for result check', {
        filePath,
        error: err instanceof Error ? err.message : String(err),
      })
    } finally {
      try { await fh?.close() } catch { /* ignore close errors */ }
    }
    return false
  }
}
