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

import type { SessionTurnSpeed } from '../types.js';
import { computeCost } from '../usage/pricing.js';

/** Same heuristic as the client's interim estimate and the streaming block's count. */
const CHARS_PER_TOKEN = 4;

interface MessageUsage {
  input_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  output_tokens?: number;
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
  }

  /** Put a previous turn's final back after a startTurn that has to be undone
   *  (the send it anchored never reached the CLI). Anything else resets. */
  restore(previous: SessionTurnSpeed): void {
    this.reset();
    if (previous.final) this.finalSnapshot = previous;
  }

  /** True between startTurn/first message and finish. */
  get active(): boolean {
    return this.finalSnapshot === undefined && (this.startedAt !== undefined || this.open !== undefined || this.messages > 0);
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
      ...(this.messages > 0 ? { costUsd: this.costUsd, costEstimated: true } : {}),
      final: false,
      ...(this.partial ? { partial: true } : {}),
    };
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
    // Strip the live cost pair: the CLI's own increment below is not an estimate,
    // and spreading `live` first would carry its costEstimated flag along.
    const { costUsd: liveCost, costEstimated: _liveEstimated, ...live } = this.snapshot(now);
    const turnOutputTokens = result.turnOutputTokens;
    // The CLI's per-turn total is the ground truth; if we counted less, some
    // message escaped us (attach, replay gap) and the ratio is over what we saw.
    const partial = this.partial
      || (typeof turnOutputTokens === 'number' && this.messages > 0 && turnOutputTokens !== this.outputTokens);
    const cost = typeof result.costUsd === 'number' && result.costUsd > 0
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
