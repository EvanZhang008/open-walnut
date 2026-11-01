/**
 * Turn speed meter: Walnut's own clock over the CLI's partial-message stream.
 *
 * Fed by ClaudeCodeSession from four stream_event kinds and the turn's
 * result; produces the SessionTurnSpeed snapshot the session panel shows as
 * its readout row. Pure and clock-injected so the arithmetic is unit-testable
 * without a CLI.
 *
 * What is measured, and why these edges:
 *
 *   ttft         turn start (the FIFO write of the user's line) → the first
 *                content_block_delta of the turn. message_start is deliberately
 *                NOT the edge: on some backends it arrives with a handful of
 *                output tokens already buffered, so the first delta is the
 *                first moment the user can see anything.
 *   generation   per API message, message_start → message_stop, summed over
 *                the turn. A turn with tool calls is several messages with tool
 *                execution in between; that gap is the tool's time, not the
 *                model's, so it is excluded. The window opens at message_start
 *                rather than at the first visible delta on purpose: a model with
 *                thinking that is not streamed (Opus 5.5 and Sonnet 5.5 over
 *                Bedrock) decodes hundreds of thinking tokens before its first
 *                visible delta, and those tokens are in output_tokens. Measured
 *                on 2026-09-30: 1,066 tokens over a 4.2s visible window read as
 *                253 tok/s; over the 12s from message_start it is 89 tok/s, the
 *                real decode rate. message_start arrives with the first output
 *                tokens already counted in its usage, so it is the start of
 *                decoding, not of the request. When message_start was not
 *                observed (attach mid-message) the window opens at the first
 *                delta seen.
 *   tokens       message_delta.usage.output_tokens, the CLI's count for that
 *                message. Never characters ÷ 4: the client may show a "~"
 *                estimate from `inFlightChars` while a message streams, and it
 *                is replaced by the real count at the message boundary.
 *
 * Replays are the caller's problem: ClaudeCodeSession already knows which
 * events are positional replays and must not feed them here.
 */

import type { SessionTurnSpeed, SessionTurnSpeedLane } from '../types.js';
import { computeCost } from '../usage/pricing.js';

/** Same heuristic as the client's interim estimate and the streaming block's count. */
const CHARS_PER_TOKEN = 4;

interface MessageUsage {
  input_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  output_tokens?: number;
  /** The cache write split by lifetime: pricing needs it (a 1h write costs more), and prices
   *  nothing without it once a write happened. */
  cache_creation?: { ephemeral_5m_input_tokens?: number; ephemeral_1h_input_tokens?: number };
}

interface OpenMessage {
  model?: string;
  /** message_start time, or the first delta seen when the start was missed. */
  startedAt: number;
  /** First visible delta of this message; the client's interim rate divides its
   *  character estimate by the time since here, not since message_start, because
   *  the characters seen so far say nothing about tokens decoded before them. */
  firstDeltaAt?: number;
  chars: number;
  usage: MessageUsage;
  /** Filled by message_delta (arrives right before message_stop). */
  outputTokens?: number;
}

/** A lane's bookkeeping beyond its public snapshot: message ids seen (one
 *  `assistant` line per content block, all carrying the same id) and the
 *  message the latest line belonged to. */
interface LaneState extends SessionTurnSpeedLane {
  seenMessageIds: Set<string>;
  lastMessageId?: string;
  /** The final answer (Agent result) was counted; a second result line adds nothing. */
  answerCounted?: boolean;
}

/** What the Agent call's own result says about the agent (main-lane tool_result). */
export interface LaneEnd {
  status: 'done' | 'failed' | 'stopped';
  /** Characters of the agent's final answer (the tool_result content): its last
   *  message, which never appears as a lane line. */
  answerChars?: number;
  durationMs?: number;
  model?: string;
}

export interface TurnSpeedFinal {
  /** result.usage.output_tokens for the whole turn. */
  turnOutputTokens?: number;
  /** result.duration_ms. */
  durationMs?: number;
  /** The CLI's billable increment for this turn; undefined keeps the estimate. */
  costUsd?: number;
  interrupted?: boolean;
}

export class TurnSpeedMeter {
  private startedAt: number | undefined;
  private firstDeltaAt: number | undefined;
  private generationMs = 0;
  private outputTokens = 0;
  /** Characters ÷ 4 of messages that closed without a usage count. */
  private estimatedTokens = 0;
  private messages = 0;
  private model: string | undefined;
  private open: OpenMessage | undefined;
  private costUsd = 0;
  /** Set when the turn began before this meter saw it (attach mid-turn), a
   *  message closed without a usage count, or a message opened while another
   *  was still open (a stream we did not see from its start). */
  private partial = false;
  private finalSnapshot: SessionTurnSpeed | undefined;
  /** Subagent lanes of this turn, keyed by the Agent tool_use id, in start order. */
  private lanes = new Map<string, LaneState>();

  /** The turn-start edge. Resets every counter. */
  startTurn(now: number): void {
    this.reset();
    this.startedAt = now;
  }

  /** Forget everything (spawn of a fresh process, session id change). */
  reset(): void {
    this.startedAt = undefined;
    this.firstDeltaAt = undefined;
    this.generationMs = 0;
    this.outputTokens = 0;
    this.estimatedTokens = 0;
    this.messages = 0;
    this.model = undefined;
    this.open = undefined;
    this.costUsd = 0;
    this.partial = false;
    this.finalSnapshot = undefined;
    this.lanes.clear();
  }

  /** Put a previous turn's final back after a startTurn that has to be undone
   *  (the send it anchored never reached the CLI). Anything else resets. */
  restore(previous: SessionTurnSpeed): void {
    this.reset();
    if (previous.final) this.finalSnapshot = previous;
  }

  /** True between startTurn/first message and finish. */
  get active(): boolean {
    return this.finalSnapshot === undefined
      && (this.startedAt !== undefined || this.open !== undefined || this.messages > 0 || this.lanes.size > 0);
  }

  messageStart(now: number, model: string | undefined, usage: MessageUsage | undefined): void {
    if (this.finalSnapshot) {
      // A message after the result belongs to the next turn (or is a stray
      // replay); the next startTurn resets us, so ignore it here.
      return;
    }
    if (this.startedAt === undefined && this.messages === 0 && !this.open) {
      // No turn-start edge was seen: we attached to a running turn.
      this.partial = true;
    }
    if (this.open) {
      // Two message_starts without a message_stop between them: we missed the
      // stop (or the stream skipped it); close what we have and mark partial.
      this.closeOpen(now);
      this.partial = true;
    }
    // Only a string can name a model: the estimate prices by name, and a stray
    // shape here must not throw inside the stream handler.
    const name = typeof model === 'string' && model ? model : undefined;
    this.open = { model: name, startedAt: now, chars: 0, usage: usage && typeof usage === 'object' ? usage : {} };
    if (!this.model && name) this.model = name;
  }

  /** Any content_block_delta (text, thinking, tool input). `chars` feeds the
   *  client's interim estimate only. */
  delta(now: number, chars: number): void {
    if (this.finalSnapshot || !(chars > 0)) return;
    if (this.firstDeltaAt === undefined) this.firstDeltaAt = now;
    if (!this.open) {
      // A delta with no open message: the message_start was not observed
      // (attach mid-message). Open a window from here so the rest still counts.
      this.open = { startedAt: now, chars: 0, usage: {} };
      this.partial = true;
    }
    if (this.open.firstDeltaAt === undefined) this.open.firstDeltaAt = now;
    this.open.chars += chars;
  }

  /** message_delta: the message's final usage (output_tokens is per message). */
  messageUsage(usage: MessageUsage | undefined): void {
    if (this.finalSnapshot || !this.open || !usage || typeof usage !== 'object') return;
    if (typeof usage.output_tokens === 'number' && Number.isFinite(usage.output_tokens)) this.open.outputTokens = usage.output_tokens;
    // message_delta repeats the input-side counts; prefer them when the
    // message_start copy was missing.
    this.open.usage = { ...usage, ...this.open.usage, output_tokens: usage.output_tokens };
  }

  messageStop(now: number): void {
    if (this.finalSnapshot || !this.open) return;
    this.closeOpen(now);
  }

  private closeOpen(now: number): void {
    const open = this.open;
    if (!open) return;
    this.open = undefined;
    this.messages += 1;
    this.generationMs += Math.max(0, now - open.startedAt);
    if (typeof open.outputTokens === 'number') {
      this.outputTokens += open.outputTokens;
    } else {
      // No usage for this message (a Stop mid-stream ends it before its
      // message_delta): its tokens are unknown, so the turn's tokens/generation
      // ratio no longer describes every message. Keep the character estimate
      // so the row can still say "~N tok" instead of a false zero.
      this.partial = true;
      this.estimatedTokens += Math.round(open.chars / CHARS_PER_TOKEN);
    }
    if (open.model) {
      this.costUsd += computeCost({
        model: open.model,
        input_tokens: open.usage.input_tokens ?? 0,
        output_tokens: open.outputTokens ?? Math.round(open.chars / CHARS_PER_TOKEN),
        cache_creation_input_tokens: open.usage.cache_creation_input_tokens ?? 0,
        cache_read_input_tokens: open.usage.cache_read_input_tokens ?? 0,
        ...(open.usage.cache_creation && typeof open.usage.cache_creation === 'object' ? { cache_creation: open.usage.cache_creation } : {}),
      });
    }
  }

  /** Live snapshot while the turn runs. */
  snapshot(now: number): SessionTurnSpeed {
    if (this.finalSnapshot) return this.finalSnapshot;
    const open = this.open;
    return {
      ...(this.startedAt !== undefined ? { startedAt: this.startedAt } : {}),
      ttftMs: this.startedAt !== undefined && this.firstDeltaAt !== undefined
        ? Math.max(0, this.firstDeltaAt - this.startedAt)
        : null,
      generationMs: this.generationMs,
      outputTokens: this.outputTokens,
      ...(this.estimatedTokens > 0 ? { estimatedTokens: this.estimatedTokens } : {}),
      messages: this.messages,
      ...(this.model ? { model: this.model } : {}),
      inFlight: !!open,
      inFlightChars: open?.chars ?? 0,
      inFlightMs: open ? Math.max(0, now - open.startedAt) : 0,
      inFlightVisibleMs: open?.firstDeltaAt !== undefined ? Math.max(0, now - open.firstDeltaAt) : 0,
      ...(this.messages > 0 && Number.isFinite(this.costUsd) ? { costUsd: this.costUsd, costEstimated: true } : {}),
      final: false,
      ...(this.partial ? { partial: true } : {}),
      ...this.lanesField(),
    };
  }

  /** `{ lanes }` when the turn ran a subagent, else nothing (older readers see no field). */
  private lanesField(): { lanes?: SessionTurnSpeedLane[] } {
    if (this.lanes.size === 0) return {};
    return { lanes: [...this.lanes.values()].map(({ seenMessageIds: _ids, lastMessageId: _last, answerCounted: _a, ...lane }) => ({ ...lane })) };
  }

  // ── Subagent lanes ─────────────────────────────────────────────────────────
  // The CLI emits no partial events for a subagent; its lane is whole messages,
  // so these edges are message arrivals, not deltas (see SessionTurnSpeedLane).
  // Every lane method returns true when it changed something worth a frame.
  // After the turn's result a backgrounded agent may still be working: its
  // lane keeps updating inside the frozen final snapshot, which the caller
  // re-emits, so the row never shows a running agent frozen at the result.

  /** An Agent call began (its tool_use in the main lane, or task_started). */
  laneStart(now: number, id: string, meta: { label?: string } = {}): boolean {
    if (!id) return false;
    const existing = this.lanes.get(id);
    if (existing) {
      if (meta.label && !existing.label) { existing.label = meta.label; this.syncFinalLanes(); return true; }
      return false;
    }
    this.lanes.set(id, {
      id, ...(meta.label ? { label: meta.label } : {}),
      startedAt: now, firstReplyMs: null, generationMs: 0, messages: 0, estimatedTokens: 0,
      callStartedAt: now, status: 'running', seenMessageIds: new Set(),
    });
    this.syncFinalLanes();
    return true;
  }

  /** One `assistant` line of the lane: a content block of message `messageId`
   *  (the CLI writes one line per block). The first line of a new message
   *  closes the model-call window that opened at the lane's last input. */
  laneAssistant(now: number, id: string, messageId: string | undefined, model: string | undefined, chars: number): boolean {
    if (!id) return false;
    let lane = this.lanes.get(id);
    if (!lane) {
      // A lane whose start was not observed (attach mid-turn): it begins here.
      this.laneStart(now, id);
      lane = this.lanes.get(id)!;
      lane.callStartedAt = undefined;
      this.partial = true;
    }
    const name = typeof model === 'string' && model ? model : undefined;
    if (!lane.model && name) lane.model = name;
    const mid = messageId || `anon-${lane.messages + 1}`;
    if (!lane.seenMessageIds.has(mid)) {
      lane.seenMessageIds.add(mid);
      lane.messages += 1;
      lane.lastMessageId = mid;
      if (lane.firstReplyMs === null) lane.firstReplyMs = Math.max(0, now - lane.startedAt);
      if (lane.callStartedAt !== undefined) {
        lane.generationMs += Math.max(0, now - lane.callStartedAt);
        lane.callStartedAt = undefined;
      }
    }
    if (chars > 0) lane.estimatedTokens += Math.round(chars / CHARS_PER_TOKEN);
    this.syncFinalLanes();
    return true;
  }

  /** A `user` line of the lane (a tool result handed to the agent): the next
   *  model call starts now. A second one before any message moves the mark. */
  laneInput(now: number, id: string): boolean {
    const lane = this.lanes.get(id);
    if (!lane || lane.status !== 'running') return false;
    lane.callStartedAt = now;
    this.syncFinalLanes();
    return true;
  }

  /** The Agent call ended: its main-lane tool_result (carrying the agent's
   *  final answer, which closes the call window its last input opened) or a
   *  terminal task_notification (no answer). */
  laneEnd(now: number, id: string, end: LaneEnd): boolean {
    const lane = this.lanes.get(id);
    if (!lane) return false;
    if (lane.status !== 'running' && end.answerChars === undefined) return false;
    lane.status = end.status;
    lane.endedAt = lane.endedAt ?? now;
    if (end.answerChars !== undefined && end.answerChars > 0 && !lane.answerCounted) {
      // The answer is the lane's last model call: it opened at the last input.
      lane.answerCounted = true;
      lane.messages += 1;
      if (lane.firstReplyMs === null) lane.firstReplyMs = Math.max(0, now - lane.startedAt);
      if (lane.callStartedAt !== undefined) lane.generationMs += Math.max(0, now - lane.callStartedAt);
      lane.estimatedTokens += Math.round(end.answerChars / CHARS_PER_TOKEN);
      lane.callStartedAt = undefined;
    }
    // A terminal notification arrives BEFORE the Agent's tool_result (verified
    // on real streams), so an open call window stays until that result closes it.
    if (typeof end.durationMs === 'number' && Number.isFinite(end.durationMs) && end.durationMs >= 0) lane.durationMs = end.durationMs;
    if (!lane.model && typeof end.model === 'string' && end.model) lane.model = end.model;
    this.syncFinalLanes();
    return true;
  }

  /** The process is gone after the turn's result: an agent still marked running
   *  in the frozen final will never report. Returns true when one was closed. */
  stopRunningLanes(now: number): boolean {
    let changed = false;
    for (const lane of this.lanes.values()) {
      if (lane.status !== 'running') continue;
      lane.status = 'stopped'; lane.endedAt = now; lane.callStartedAt = undefined; changed = true;
    }
    if (changed) this.syncFinalLanes();
    return changed;
  }

  /** The lane's known ids (the caller tells a lane's tool_result from any other). */
  hasLane(id: string): boolean {
    return this.lanes.has(id);
  }

  /** A frozen final keeps its lanes current (a backgrounded agent outlives the result). */
  private syncFinalLanes(): void {
    if (this.finalSnapshot) this.finalSnapshot = { ...this.finalSnapshot, ...this.lanesField() };
  }

  /**
   * The turn's result landed. An open message (interrupted mid-stream, or a
   * backend that never sent message_stop) is closed at this instant so the
   * tokens it did produce still count.
   */
  finish(now: number, result: TurnSpeedFinal): SessionTurnSpeed {
    if (this.finalSnapshot) return this.finalSnapshot;
    if (this.open) {
      // Its token count only arrives with message_delta; an interrupted message
      // never gets one, so the window closes token-less and marks partial.
      this.closeOpen(now);
    }
    if (result.interrupted) {
      // The turn died or was stopped: an agent still mid-call went with it.
      for (const lane of this.lanes.values()) {
        if (lane.status === 'running') { lane.status = 'stopped'; lane.endedAt = now; lane.callStartedAt = undefined; }
      }
    }
    // Strip the live cost pair: the CLI's own increment below is not an estimate,
    // and spreading `live` first would carry its costEstimated flag along.
    const { costUsd: liveCost, costEstimated: _liveEstimated, ...live } = this.snapshot(now);
    const turnOutputTokens = result.turnOutputTokens;
    // The CLI's per-turn total is the ground truth; if we counted less, some
    // message escaped us (attach, replay gap) and the ratio is over what we saw.
    const partial = this.partial
      || (typeof turnOutputTokens === 'number' && this.messages > 0 && turnOutputTokens !== this.outputTokens);
    const cost = typeof result.costUsd === 'number' && Number.isFinite(result.costUsd) && result.costUsd > 0
      ? { costUsd: result.costUsd }
      : (liveCost !== undefined ? { costUsd: liveCost, costEstimated: true } : {});
    this.finalSnapshot = {
      ...live,
      inFlight: false,
      inFlightChars: 0,
      inFlightMs: 0,
      inFlightVisibleMs: 0,
      ...cost,
      ...(typeof result.durationMs === 'number' ? { durationMs: result.durationMs } : {}),
      ...(typeof turnOutputTokens === 'number' ? { turnOutputTokens } : {}),
      final: true,
      ...(result.interrupted ? { interrupted: true } : {}),
      ...(partial ? { partial: true } : {}),
      endedAt: now,
    };
    return this.finalSnapshot;
  }
}

/** Output tokens per second over the observed generation windows; null when
 *  there is no window or no counted token yet. Shared by server logging and
 *  the readout so both quote the same number. */
export function tokensPerSecond(speed: Pick<SessionTurnSpeed, 'outputTokens' | 'generationMs'>): number | null {
  if (speed.generationMs <= 0 || speed.outputTokens <= 0) return null;
  return speed.outputTokens / (speed.generationMs / 1000);
}
