/**
 * Send-path canary — self-monitoring for the phone→session send pipeline.
 *
 * Born from the 2026-08-21 incident: the cloud box's disk crossed the 90%
 * watermark (30GB of git push debris), the disk-guard middleware started
 * answering 507 on every mutating route, and the USER was the monitoring —
 * they discovered it by watching their own messages fail. Each earlier send
 * incident (bridge flap, sleeping Mac, DNS outage) was likewise diagnosed
 * after the fact from logs that had the answer all along.
 *
 * The canary evaluates, on a timer, the exact gates a real send passes
 * through — no synthetic messages injected into real sessions:
 *
 *   1. disk-guard: isDiskWriteBlocked() — the literal 507 condition.
 *   2. bridges: which hosts have a live socket (a send to a session on a
 *      bridgeless host banks instead of delivering).
 *   3. send-queue: banked sends waiting. A non-empty queue with the primary
 *      bridge absent for a sustained window means messages are piling up.
 *
 * On a degradation TRANSITION it notifies once (dedup-scoped), naming the
 * failing hop precisely — the repeated lesson of this incident family is
 * that a wrong blame ("clouddev unreachable" when the Mac was the gap)
 * costs more debugging time than the outage itself. Recovery notifies too,
 * so a silent self-heal doesn't leave a stale scare.
 *
 * The current state is exposed via getSendPathCanaryState() for the
 * GET /api/v1/canary endpoint, so a human (or an external monitor) can ask
 * "would a phone send work right now, and if not, why?" with one call.
 */

import { CLOUD_MODE } from '../constants.js';
import { log } from '../logging/index.js';

export interface CanaryAlert {
  key: string;
  title: string;
  body: string;
}

export interface SendPathCanaryState {
  healthy: boolean;
  checkedAt: string;
  diskBlocked: boolean;
  diskUsedPct: number | null;
  connectedHosts: string[];
  bankedSends: number;
  /** Ticks in a row the primary ('__local__') bridge has been absent. */
  primaryAbsentTicks: number;
  problems: string[];
}

const DEFAULT_INTERVAL_MS = 5 * 60_000;
/** Primary absent for this many consecutive ticks with sends banked → alert. */
const PRIMARY_ABSENT_ALERT_TICKS = 3;

let state: SendPathCanaryState = {
  healthy: true,
  checkedAt: '',
  diskBlocked: false,
  diskUsedPct: null,
  connectedHosts: [],
  bankedSends: 0,
  primaryAbsentTicks: 0,
  problems: [],
};

export function getSendPathCanaryState(): Readonly<SendPathCanaryState> {
  return { ...state };
}

export interface CanaryInputs {
  diskBlocked: boolean;
  diskUsedPct: number | null;
  connectedHosts: string[];
  bankedSends: number;
  prevPrimaryAbsentTicks: number;
}

/**
 * Pure transition logic: inputs → new state + alerts to raise vs the previous
 * state. Alerts fire only on EDGES (healthy→problem, problem→healthy), so a
 * stuck condition notifies exactly once. Exported for tests.
 */
export function evaluateCanary(
  inputs: CanaryInputs,
  prevProblems: string[],
): { next: SendPathCanaryState; alerts: CanaryAlert[] } {
  const problems: string[] = [];
  const alerts: CanaryAlert[] = [];

  if (inputs.diskBlocked) {
    problems.push('disk_blocked');
  }

  const primaryConnected = inputs.connectedHosts.includes('__local__');
  const primaryAbsentTicks = primaryConnected ? 0 : inputs.prevPrimaryAbsentTicks + 1;
  // A sleeping Mac with nothing queued is normal life, not an incident. It
  // becomes a problem when messages are actually waiting on it.
  if (!primaryConnected && inputs.bankedSends > 0 && primaryAbsentTicks >= PRIMARY_ABSENT_ALERT_TICKS) {
    problems.push('sends_waiting_on_primary');
  }

  const next: SendPathCanaryState = {
    healthy: problems.length === 0,
    checkedAt: new Date().toISOString(),
    diskBlocked: inputs.diskBlocked,
    diskUsedPct: inputs.diskUsedPct,
    connectedHosts: inputs.connectedHosts,
    bankedSends: inputs.bankedSends,
    primaryAbsentTicks,
    problems,
  };

  for (const p of problems) {
    if (prevProblems.includes(p)) continue; // already alerted — edge-triggered
    if (p === 'disk_blocked') {
      alerts.push({
        key: 'canary:disk_blocked',
        title: 'Phone sends are FAILING (disk full)',
        body: `The cloud box's disk is at ${inputs.diskUsedPct ?? '?'}% — every send answers 507 right now. `
          + 'Free space (git debris is the usual culprit) to restore sends.',
      });
    } else if (p === 'sends_waiting_on_primary') {
      alerts.push({
        key: 'canary:sends_waiting_on_primary',
        title: `${inputs.bankedSends} message(s) waiting on your Mac`,
        body: 'Your Mac (primary) has been offline for a while and phone sends are queued. '
          + 'They deliver automatically when it reconnects; wake the Mac to flush them now.',
      });
    }
  }
  // Recovery edge: everything cleared after at least one problem.
  if (problems.length === 0 && prevProblems.length > 0) {
    alerts.push({
      key: 'canary:recovered',
      title: 'Phone send path recovered',
      body: 'All send-path checks are green again (disk, bridges, queue).',
    });
  }

  return { next, alerts };
}

export type CanaryNotify = (title: string, body: string, dedupScope: string) => void;

export interface SendPathCanaryHandle {
  stop: () => void;
  /** Force one evaluation now (tests / the /canary endpoint's refresh). */
  poll: () => Promise<SendPathCanaryState>;
}

/** Gather live inputs from the real modules. Isolated for the poll below. */
async function collectInputs(): Promise<CanaryInputs> {
  const { isDiskWriteBlocked, getDiskWatermarkState } = await import('./disk-watermark.js');
  const { bridgeHosts } = await import('../web/ws/bridge-registry.js');
  const { queuedSessionSendCount } = await import('./send-queue.js');
  return {
    diskBlocked: isDiskWriteBlocked(),
    diskUsedPct: getDiskWatermarkState().usedPct ?? null,
    connectedHosts: bridgeHosts().map((h) => h.hostAlias),
    bankedSends: await queuedSessionSendCount(),
    prevPrimaryAbsentTicks: state.primaryAbsentTicks,
  };
}

/**
 * CLOUD box only (the send routes live there; a primary box send is local).
 * Cheap: one statfs read (cached by the watermark), one Map scan, one readdir.
 */
export function startSendPathCanary(opts: {
  notify?: CanaryNotify;
  intervalMs?: number;
} = {}): SendPathCanaryHandle | null {
  if (!CLOUD_MODE) return null;
  const intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const poll = async (): Promise<SendPathCanaryState> => {
    try {
      const inputs = await collectInputs();
      const { next, alerts } = evaluateCanary(inputs, state.problems);
      state = next;
      for (const a of alerts) {
        log.web.warn('send-path canary alert', { key: a.key, title: a.title });
        opts.notify?.(a.title, a.body, a.key);
      }
      if (!next.healthy) {
        log.web.warn('send-path canary unhealthy', { problems: next.problems, bankedSends: next.bankedSends });
      }
    } catch (err) {
      // The canary must never become its own incident — log and keep ticking.
      log.web.warn('send-path canary poll failed', { err: err instanceof Error ? err.message : String(err) });
    }
    return { ...state };
  };

  const tick = async (): Promise<void> => {
    try {
      await poll();
    } finally {
      if (!stopped) {
        timer = setTimeout(() => { void tick(); }, intervalMs);
        timer.unref?.();
      }
    }
  };
  timer = setTimeout(() => { void tick(); }, 30_000);
  timer.unref?.();
  log.web.info('send-path canary started', { intervalMs });

  return {
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
    poll,
  };
}
