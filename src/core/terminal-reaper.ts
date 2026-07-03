/**
 * Terminal Reaper — periodic cleanup of leaked dtach terminal sessions.
 *
 * WHY THIS EXISTS: a dtach master process is deliberately built to OUTLIVE
 * ssh/server/network death (that's the persistence guarantee). The flip side is
 * it never dies on its own — something must explicitly kill it. The event-driven
 * cleanups (explicit "end terminal", session delete, conditionalReap on task
 * completion) cover the common cases, but two leaks remain:
 *
 *   (A) On task completion `conditionalReap` KEEPS a terminal that is running a
 *       foreground build/test. If that process later finishes, the terminal
 *       falls back to an idle shell — and nothing comes back to reap it.
 *   (B) `reapOrphanDtach` (the orphan sweep) only ran once at server startup, so
 *       orphans accumulated during a long-lived server were never collected.
 *
 * This reaper runs both checks on a periodic timer (same pattern as
 * SessionReaper):
 *
 *   ① Active-terminal recheck — for each terminal THIS process holds, look up
 *      its backing session. Reap ONLY when the session record is GONE (deleted).
 *      Policy A: as long as the session record EXISTS, keep its terminal — the
 *      user can still come back to it. In this codebase 'stopped' is the NORMAL
 *      resting state of a returnable session (paused / between turns), so we do
 *      NOT reap on process_status alone. Task-completion already conditionally
 *      reaps at the actual completion moment (completeTaskSessions →
 *      conditionalReap, in session-tracker.ts), and the orphan sweep ② catches
 *      truly-deleted sessions; so ① only needs to handle the narrow case where a
 *      terminal exists in THIS process but its session record has been deleted.
 *
 *   ② Orphan sweep — reapOrphanDtach() compares every walnut-*.dsock across all
 *      hosts against the session registry and kills any whose session no longer
 *      exists. Cross-process / cross-restart safety net.
 *
 * IMPORTANT (architecture): the in-memory active-terminal list is only the ENTRY
 * POINT for ① ("which terminals should I check"). Kill/keep decisions come from
 * GROUND TRUTH — the session registry + the live dtach process tree — never from
 * a cached local table. A stale snapshot is harmless.
 */

import { log } from '../logging/index.js'

const REAP_INTERVAL_MS = 30 * 60_000   // every 30 min
const INITIAL_DELAY_MS = 90 * 1000     // 90s after server start (after startup sweep)

export class TerminalReaper {
  private timer: ReturnType<typeof setInterval> | null = null
  private initialTimer: ReturnType<typeof setTimeout> | null = null
  private running = false

  start(): void {
    if (this.timer) return
    this.initialTimer = setTimeout(() => {
      this.reap().catch((err) => log.web.warn('terminal reaper: unexpected error', { error: String(err) }))
      this.initialTimer = null
    }, INITIAL_DELAY_MS)
    this.timer = setInterval(() => {
      this.reap().catch((err) => log.web.warn('terminal reaper: unexpected error', { error: String(err) }))
    }, REAP_INTERVAL_MS)
    log.web.info('terminal reaper started', { intervalMs: REAP_INTERVAL_MS })
  }

  stop(): void {
    if (this.initialTimer) { clearTimeout(this.initialTimer); this.initialTimer = null }
    if (this.timer) { clearInterval(this.timer); this.timer = null; log.web.info('terminal reaper stopped') }
  }

  /**
   * One reap pass: ① recheck active terminals, then ② orphan sweep.
   * Returns counts for tests/diagnostics. Best-effort — terminal feature may be
   * disabled (node-pty missing), in which case the imports still resolve but
   * there are simply no active terminals and the orphan sweep finds nothing.
   */
  async reap(): Promise<{ rechecked: number; reapedActive: number }> {
    // Overlap guard: reap() does several serial ssh round-trips and can outlast
    // the 30-min interval (and the 90s initial timer can overlap the interval).
    // Never let two passes run concurrently — skip if one is already in flight.
    if (this.running) {
      log.web.debug('terminal reaper: pass already running, skipping')
      return { rechecked: 0, reapedActive: 0 }
    }
    this.running = true
    try {
      const { terminalManager } = await import('../web/terminal/terminal-manager.js')
      const { conditionalReap, reapOrphanDtach } = await import('../web/terminal/dtach-lifecycle.js')
      const { getSessionByClaudeId } = await import('./session-tracker.js')

      const active = terminalManager.listActive()
      let reapedActive = 0

      // ① Active-terminal recheck.
      for (const { sessionId, host } of active) {
        let record
        try {
          record = await getSessionByClaudeId(sessionId)
        } catch (err) {
          log.web.warn('terminal reaper: session lookup failed', { sessionId, error: String(err) })
          continue
        }

        // Policy A: as long as the session record EXISTS, keep its terminal so
        // the user can return to it — regardless of process_status ('stopped' is
        // the normal resting state of a returnable session, not a reap signal).
        // Only reap when the record is GONE (deleted). Note: since ① now only
        // runs for deleted sessions, `record` is always null here, so host comes
        // from the in-memory snapshot (there's no record.host to prefer).
        if (record) continue

        try {
          // conditionalReap keeps a terminal running a foreground build/test; only
          // an idle shell is actually killed.
          const result = await conditionalReap({ claudeSessionId: sessionId, host })
          if (result === 'killed') {
            reapedActive++
            log.web.info('terminal reaper: reaped idle terminal', { sessionId, host, reason: 'session-deleted' })
          }
        } catch (err) {
          log.web.warn('terminal reaper: conditionalReap failed', { sessionId, host, error: String(err) })
        }
      }

      // ② Orphan sweep (ground-truth: socket sessionId not in registry → kill).
      try {
        await reapOrphanDtach()
      } catch (err) {
        log.web.warn('terminal reaper: orphan sweep failed', { error: String(err) })
      }

      // Always log a pass summary: the orphan sweep ② (the more destructive
      // action) has no per-kill pass summary, so log unconditionally.
      log.web.info('terminal reaper: pass complete', { rechecked: active.length, reapedActive })
      return { rechecked: active.length, reapedActive }
    } finally {
      this.running = false
    }
  }
}

export const terminalReaper = new TerminalReaper()
