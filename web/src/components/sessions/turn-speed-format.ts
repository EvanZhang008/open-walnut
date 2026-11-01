/**
 * Formatting for the turn speed readout row. Pure, so the row's numbers are
 * unit-tested without React.
 *
 * Honesty rules (the row compares two models side by side, so every number
 * must mean the same thing on both panels):
 *   - token counts are the CLI's. While a message is still streaming the row
 *     shows the finished messages' real count plus a "~" estimate for the open
 *     message (characters ÷ 4), and the "~" disappears at the message boundary.
 *   - tok/s divides real tokens by Walnut's summed generation windows. Only
 *     while the FIRST message of a turn is still open, when there is no real
 *     count yet, is the rate an estimate, and it carries the same "~": the
 *     characters seen so far over the time since the first of them appeared
 *     (the model may have decoded unstreamed thinking before that, which the
 *     final number includes and this one cannot see).
 *   - the total is the CLI's turn wall time once final; before that it is the
 *     time since the turn's start on this browser's clock.
 */
import type { SessionTurnSpeed, SessionTurnSpeedLane } from '@open-walnut/core';

/** Same heuristic the streaming block's progress number uses. */
const CHARS_PER_TOKEN = 4;

export interface SpeedReadout {
  /** Real or estimated output tokens, e.g. "840 tok" / "~1,210 tok". */
  tokens: string;
  tokensEstimated: boolean;
  /** "1.2s" once the first content delta arrived; while waiting, the time spent
   *  waiting so far with an ellipsis; null when never observed (final). */
  ttft: string | null;
  ttftPending: boolean;
  /** "38 tok/s" / "~41 tok/s"; null when there is nothing to divide yet. */
  tps: string | null;
  tpsEstimated: boolean;
  /** Turn wall time: "24.3s", "1m 05s"; null when the start was never seen. */
  duration: string | null;
  /** "$1.71" / "~$0.03" / "" when unknown. */
  cost: string;
  costEstimated: boolean;
  live: boolean;
  interrupted: boolean;
  partial: boolean;
}

export function formatTokens(n: number): string {
  return n.toLocaleString('en-US', { maximumFractionDigits: 0 });
}

export function formatSeconds(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) ms = 0;
  const s = ms / 1000;
  if (s < 60) return `${s < 10 ? s.toFixed(1) : Math.round(s)}s`;
  const m = Math.floor(s / 60);
  const rest = Math.round(s - m * 60);
  return `${m}m ${rest.toString().padStart(2, '0')}s`;
}

export function formatCost(usd: number): string {
  if (usd >= 0.01) return `$${usd.toFixed(2)}`;
  if (usd >= 0.001) return `$${usd.toFixed(3)}`;
  return '<$0.001';
}

/** A rate over a shorter window than this is noise (a four-token reply that
 *  arrives in one delta reads as thousands of tok/s), so the slot stays empty. */
export const MIN_RATE_WINDOW_MS = 500;
/** An interim rate from fewer characters than this rounds to noise ("~0 tok/s"). */
export const MIN_ESTIMATE_TOKENS = 20;

export function computeReadout(speed: SessionTurnSpeed, now: number): SpeedReadout {
  const live = !speed.final;
  const realTokens = speed.final ? (speed.turnOutputTokens ?? speed.outputTokens) : speed.outputTokens;
  // Messages that closed without a CLI count (a Stop mid-stream) keep their
  // character estimate. The CLI's whole-turn total never includes such a
  // message (it adds a message's usage at its message_stop, which a stopped
  // message never reaches), so the estimate is added on top of whatever the
  // CLI did count, and the row keeps its "~".
  const closedEstimate = speed.estimatedTokens ?? 0;
  const openEstimate = live && speed.inFlight ? Math.round(speed.inFlightChars / CHARS_PER_TOKEN) : 0;
  const estimateTokens = openEstimate + closedEstimate;
  const tokensEstimated = estimateTokens > 0;
  const tokens = `${tokensEstimated ? '~' : ''}${formatTokens(realTokens + estimateTokens)} tok`;

  let ttft: string | null = null;
  let ttftPending = false;
  if (speed.ttftMs !== null) {
    ttft = formatSeconds(speed.ttftMs);
  } else if (live && speed.startedAt !== undefined) {
    ttft = `${formatSeconds(now - speed.startedAt)}…`;
    ttftPending = true;
  }

  // A stopped turn whose only tokens are estimated gets no rate here: its
  // window includes thinking that was never streamed, so characters over it
  // would understate the model, and there is no real count to divide.
  let tps: string | null = null;
  let tpsEstimated = false;
  if (speed.outputTokens > 0 && speed.generationMs >= MIN_RATE_WINDOW_MS) {
    tps = `${Math.round(speed.outputTokens / (speed.generationMs / 1000))} tok/s`;
  } else if (live && speed.inFlight && openEstimate >= MIN_ESTIMATE_TOKENS && speed.inFlightVisibleMs >= 1000) {
    tps = `~${Math.round(openEstimate / (speed.inFlightVisibleMs / 1000))} tok/s`;
    tpsEstimated = true;
  }

  let duration: string | null = null;
  if (speed.final) {
    const wall = speed.durationMs
      ?? (speed.endedAt !== undefined && speed.startedAt !== undefined ? speed.endedAt - speed.startedAt : undefined);
    if (wall !== undefined) duration = formatSeconds(wall);
  } else if (speed.startedAt !== undefined) {
    duration = formatSeconds(now - speed.startedAt);
  }

  const costEstimated = !!speed.costEstimated;
  const cost = typeof speed.costUsd === 'number' && speed.costUsd > 0
    ? `${costEstimated ? '~' : ''}${formatCost(speed.costUsd)}`
    : '';

  return {
    tokens, tokensEstimated,
    ttft, ttftPending,
    tps, tpsEstimated,
    duration,
    cost, costEstimated,
    live,
    interrupted: !!speed.interrupted,
    partial: !!speed.partial,
  };
}

/**
 * One row of the readout for the subagents of a turn that ran on one model
 * (the user compares models, so agents on the same model share a row). The
 * slots mirror the main row's, and mean the same thing where they can:
 *   - tokens: always an estimate ("~"), characters ÷ 4 of the agent's
 *     messages and its final answer: the CLI reports no output count for an
 *     agent (its lane lines and its result carry placeholders);
 *   - first: the Agent call to its first message (not its first token: a
 *     subagent does not stream), the earliest of the row's agents;
 *   - tok/s: tokens over the summed model-call windows (the lane's last input
 *     to its message's arrival; thinking included, the agent's tool runs
 *     excluded), "~" while the tokens are;
 *   - time: the first start to the last end (or now while one runs).
 */
export interface LaneReadout {
  /** Row key: the model id, or the lane id when the model is not known yet. */
  key: string;
  model: string | undefined;
  /** Agent subagent_type / description of a row whose model is not known yet. */
  label: string | undefined;
  /** Agents on this row. */
  count: number;
  tokens: string;
  tokensEstimated: boolean;
  first: string | null;
  firstPending: boolean;
  tps: string | null;
  tpsEstimated: boolean;
  duration: string | null;
  /** 'running' while any agent of the row still works. */
  status: 'running' | 'done' | 'failed' | 'stopped';
}

export function computeLaneRows(lanes: SessionTurnSpeedLane[] | undefined, now: number): LaneReadout[] {
  if (!lanes || lanes.length === 0) return [];
  const groups = new Map<string, SessionTurnSpeedLane[]>();
  for (const lane of lanes) {
    const key = lane.model ?? `lane:${lane.id}`;
    const g = groups.get(key);
    if (g) g.push(lane); else groups.set(key, [lane]);
  }
  const rows: LaneReadout[] = [];
  for (const [key, group] of groups) {
    const running = group.some((l) => l.status === 'running');
    const total = group.reduce((n, l) => n + l.estimatedTokens, 0);
    const tokensEstimated = true;
    const tokens = `~${formatTokens(total)} tok`;

    const firsts = group.map((l) => l.firstReplyMs).filter((v): v is number => v !== null);
    let first: string | null = null;
    let firstPending = false;
    if (firsts.length > 0) first = formatSeconds(Math.min(...firsts));
    else if (running) {
      const earliest = Math.min(...group.map((l) => l.startedAt));
      first = `${formatSeconds(now - earliest)}…`;
      firstPending = true;
    }

    const generationMs = group.reduce((n, l) => n + l.generationMs, 0);
    let tps: string | null = null;
    let tpsEstimated = false;
    if (total >= MIN_ESTIMATE_TOKENS && generationMs >= MIN_RATE_WINDOW_MS) {
      tps = `${tokensEstimated ? '~' : ''}${Math.round(total / (generationMs / 1000))} tok/s`;
      tpsEstimated = tokensEstimated;
    }

    const start = Math.min(...group.map((l) => l.startedAt));
    const end = running ? now : Math.max(...group.map((l) => l.endedAt ?? l.startedAt));
    const duration = end > start ? formatSeconds(end - start) : null;

    const status: LaneReadout['status'] = running ? 'running'
      : group.some((l) => l.status === 'failed') ? 'failed'
      : group.some((l) => l.status === 'stopped') ? 'stopped'
      : 'done';
    rows.push({
      key, model: group[0]!.model, label: group.find((l) => l.label)?.label, count: group.length,
      tokens, tokensEstimated, first, firstPending, tps, tpsEstimated, duration, status,
    });
  }
  return rows;
}
