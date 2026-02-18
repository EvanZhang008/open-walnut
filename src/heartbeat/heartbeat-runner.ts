/**
 * Heartbeat Runner — periodic AI self-check mechanism.
 *
 * Uses setTimeout (not setInterval) for recursive scheduling:
 * each heartbeat completes before the next one is scheduled,
 * preventing overlap if a heartbeat turn takes longer than the interval.
 */

import fs from 'node:fs/promises';
import { log } from '../logging/index.js';
import { HEARTBEAT_FILE } from '../constants.js';
import {
  type HeartbeatConfig,
  type HeartbeatState,
  type HeartbeatTriggerReason,
  DEFAULT_HEARTBEAT_EVERY,
  DEFAULT_HEARTBEAT_PROMPT,
  isHeartbeatOk,
} from './types.js';

const heartbeatLog = log.heartbeat;

// ── Duration parsing ──

/** Parse a duration string like "30m", "1h", "2h30m" into milliseconds. */
export function parseDuration(s: string): number {
  if (!s || s === '0' || s === '0m' || s === '0s') return 0;

  let totalMs = 0;
  const hourMatch = s.match(/(\d+)\s*h/i);
  const minMatch = s.match(/(\d+)\s*m/i);
  const secMatch = s.match(/(\d+)\s*s/i);

  if (hourMatch) totalMs += parseInt(hourMatch[1], 10) * 3_600_000;
  if (minMatch) totalMs += parseInt(minMatch[1], 10) * 60_000;
  if (secMatch) totalMs += parseInt(secMatch[1], 10) * 1_000;

  // If none matched, try as plain number (assume minutes)
  if (!hourMatch && !minMatch && !secMatch) {
    const n = parseInt(s, 10);
    if (!isNaN(n)) totalMs = n * 60_000;
  }

  return totalMs;
}

// ── Active hours check ──

/**
 * Check whether the current time is within the active hours window.
 * Format: "HH:MM-HH:MM" (24-hour local time).
 * Returns true if no activeHours is configured (always active).
 */
export function isWithinActiveHours(activeHours?: string): boolean {
  if (!activeHours) return true;

  const match = activeHours.match(/^(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})$/);
  if (!match) {
    heartbeatLog.warn('invalid activeHours format, ignoring', { activeHours });
    return true;
  }

  const [, startH, startM, endH, endM] = match;
  const now = new Date();
  const currentMinutes = now.getHours() * 60 + now.getMinutes();
  const startMinutes = parseInt(startH, 10) * 60 + parseInt(startM, 10);
  const endMinutes = parseInt(endH, 10) * 60 + parseInt(endM, 10);

  if (startMinutes <= endMinutes) {
    // Normal range: e.g. 08:00-22:00
    return currentMinutes >= startMinutes && currentMinutes < endMinutes;
  } else {
    // Overnight range: e.g. 22:00-06:00
    return currentMinutes >= startMinutes || currentMinutes < endMinutes;
  }
}

// ── HEARTBEAT.md reader ──

/** Read the HEARTBEAT.md file. Returns empty string if it doesn't exist. */
async function readHeartbeatFile(): Promise<string> {
  try {
    return await fs.readFile(HEARTBEAT_FILE, 'utf-8');
  } catch {
    return '';
  }
}

// ── Heartbeat Runner ──

export interface HeartbeatRunnerDeps {
  /** Run a main-agent turn with the given prompt. Uses the agent turn queue. */
  runAgentTurn: (prompt: string) => Promise<string>;

  /** Check if the agent turn queue has an active turn. */
  isQueueBusy: () => boolean;

  /** Broadcast an event to UI clients. */
  broadcastEvent: (name: string, data: unknown) => void;
}

export interface HeartbeatRunnerHandle {
  /** Stop the heartbeat runner and clear any pending timer. */
  stop: () => void;

  /** Get the current state for diagnostics (serializable, no timer reference). */
  getState: () => Readonly<Omit<HeartbeatState, 'timer'>>;

  /**
   * Request an immediate heartbeat (debounced).
   * Used by event-driven triggers (session end, cron completion).
   */
  requestNow: (reason: HeartbeatTriggerReason, context?: string) => void;
}

/**
 * Start the heartbeat runner with the given config and dependencies.
 * Returns a handle for stopping and requesting immediate heartbeats.
 */
export function startHeartbeatRunner(
  config: HeartbeatConfig,
  deps: HeartbeatRunnerDeps,
): HeartbeatRunnerHandle {
  const intervalMs = parseDuration(config.every ?? DEFAULT_HEARTBEAT_EVERY);

  const state: HeartbeatState = {
    timer: null,
    running: false,
    lastRunAt: null,
    nextDueAt: null,
    stopped: false,
  };

  // Coalesce timer for requestNow() debouncing (250ms window)
  let coalesceTimer: ReturnType<typeof setTimeout> | null = null;
  let pendingReason: HeartbeatTriggerReason | null = null;
  let pendingContext: string | undefined;

  // ── Core: execute one heartbeat turn ──

  async function executeHeartbeat(reason: HeartbeatTriggerReason, context?: string): Promise<void> {
    if (state.stopped || state.running) return;

    // Check active hours
    if (!isWithinActiveHours(config.activeHours)) {
      heartbeatLog.debug('skipping heartbeat: outside active hours', {
        activeHours: config.activeHours,
        reason,
      });
      return;
    }

    // Check if the agent is busy with a user request
    if (deps.isQueueBusy()) {
      heartbeatLog.debug('skipping heartbeat: agent queue busy', { reason });
      return;
    }

    // Read HEARTBEAT.md
    const checklist = await readHeartbeatFile();
    if (!checklist.trim()) {
      heartbeatLog.debug('skipping heartbeat: HEARTBEAT.md is empty or missing', { reason });
      return;
    }

    state.running = true;
    const startTime = Date.now();
    heartbeatLog.info('heartbeat starting', { reason, context });

    // Broadcast heartbeat start
    deps.broadcastEvent('heartbeat:start', { reason, context, timestamp: startTime });

    try {
      // Build prompt: default prompt + checklist content + optional context
      let prompt = DEFAULT_HEARTBEAT_PROMPT;
      prompt += `\n\n## HEARTBEAT.md contents:\n\n${checklist}`;
      if (context) {
        prompt += `\n\n## Trigger context:\n\n${context}`;
      }

      const response = await deps.runAgentTurn(prompt);
      state.lastRunAt = Date.now();

      const isOk = isHeartbeatOk(response);

      heartbeatLog.info('heartbeat completed', {
        reason,
        durationMs: Date.now() - startTime,
        silent: isOk,
        responseLength: response.length,
      });

      deps.broadcastEvent('heartbeat:complete', {
        reason,
        silent: isOk,
        durationMs: Date.now() - startTime,
        timestamp: Date.now(),
      });
    } catch (err) {
      heartbeatLog.error('heartbeat failed', {
        reason,
        durationMs: Date.now() - startTime,
        error: err instanceof Error ? err.message : String(err),
      });

      deps.broadcastEvent('heartbeat:error', {
        reason,
        error: err instanceof Error ? err.message : String(err),
        timestamp: Date.now(),
      });
    } finally {
      state.running = false;
    }
  }

  // ── Scheduling ──

  function scheduleNext(): void {
    if (state.stopped || intervalMs <= 0) return;

    // Clear any existing timer
    if (state.timer) {
      clearTimeout(state.timer);
      state.timer = null;
    }

    const now = Date.now();
    const nextDue = state.lastRunAt
      ? state.lastRunAt + intervalMs
      : now + intervalMs;

    const delay = Math.max(0, nextDue - now);
    state.nextDueAt = now + delay;

    state.timer = setTimeout(async () => {
      state.timer = null;
      await executeHeartbeat('interval');
      scheduleNext(); // Recursive: schedule next after completion
    }, delay);

    // Don't prevent process from exiting
    state.timer.unref?.();

    heartbeatLog.debug('next heartbeat scheduled', {
      delayMs: delay,
      nextDueAt: new Date(state.nextDueAt).toISOString(),
    });
  }

  // ── Immediate request (debounced) ──

  function requestNow(reason: HeartbeatTriggerReason, context?: string): void {
    if (state.stopped) return;

    // Store the most recent reason/context
    pendingReason = reason;
    pendingContext = context;

    // Debounce: 250ms coalesce window
    if (coalesceTimer) {
      clearTimeout(coalesceTimer);
    }

    coalesceTimer = setTimeout(async () => {
      coalesceTimer = null;
      if (!pendingReason) return; // Guard: should always be set, but be safe
      const r = pendingReason;
      const c = pendingContext;
      pendingReason = null;
      pendingContext = undefined;

      await executeHeartbeat(r, c);
      scheduleNext(); // Reset the periodic timer after an ad-hoc run
    }, 250);
    coalesceTimer.unref?.(); // Don't prevent process exit
  }

  // ── Stop ──

  function stop(): void {
    state.stopped = true;

    if (state.timer) {
      clearTimeout(state.timer);
      state.timer = null;
    }

    if (coalesceTimer) {
      clearTimeout(coalesceTimer);
      coalesceTimer = null;
    }

    state.nextDueAt = null;
    heartbeatLog.info('heartbeat runner stopped');
  }

  // ── Start ──

  if (intervalMs > 0) {
    heartbeatLog.info('heartbeat runner started', {
      intervalMs,
      every: config.every ?? DEFAULT_HEARTBEAT_EVERY,
      activeHours: config.activeHours ?? 'always',
    });
    scheduleNext();
  } else {
    heartbeatLog.info('heartbeat runner disabled (interval is 0)');
  }

  return {
    stop,
    getState: () => ({
      running: state.running,
      lastRunAt: state.lastRunAt,
      nextDueAt: state.nextDueAt,
      stopped: state.stopped,
    }),
    requestNow,
  };
}
