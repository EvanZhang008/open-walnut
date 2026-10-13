/**
 * Turn speed meter for ACP engines (Codex): the same SessionTurnSpeed readout a
 * Claude session gets, built from what ACP actually carries.
 *
 * ACP has no message_start / message_stop, and Codex reports token usage only
 * for its LAST model call (PromptResponse.usage, and one usage_update per
 * call with that call's total). So:
 *
 *   ttft         turn start → the first agent_message_chunk / thought chunk.
 *   model call   opens at the turn start, and again when every tool the
 *                previous call asked for has finished; closes at the next
 *                tool_call (the model's output ended there) or at turn end.
 *                One usage_update arrives per call, so their count is the
 *                call count.
 *   tokens       PromptResponse.usage, which is the last call. A turn of one
 *                call reports the whole turn; a turn of several marks
 *                `tokenScope: 'last-call'`.
 *   tok/s        that call's output over its decode window. ACP shows no
 *                decode start (Claude's message_start), so the window opens at
 *                the call's first streamed chunk when it reported no reasoning
 *                tokens (nothing was decoded unseen before it), and at the
 *                call's start when it did: hidden reasoning is decoded before
 *                the first chunk, and that window also holds the prompt
 *                processing, so the rate errs low rather than high.
 *
 * Times are the journal records' timestamps, so a replayed journal measures the
 * same turn the same way. Pure: the caller feeds records, emits and persists.
 */

import type { SessionTurnSpeed } from '../types.js';
import { computeCost, findPricing } from '../usage/pricing.js';

export interface AcpUsageCounts {
  inputTokens?: number;
  cachedReadTokens?: number;
  outputTokens?: number;
  thoughtTokens?: number;
}

interface OpenCall {
  startedAt: number;
  firstChunkAt?: number;
  chars: number;
}

export class AcpTurnSpeedMeter {
  private startedAt: number | undefined;
  private firstChunkAt: number | undefined;
  private model: string | undefined;
  private open: OpenCall | undefined;
  /** Start of the call that was open last (the counted one at turn end). */
  private lastCallStartedAt: number | undefined;
  private lastCallFirstChunkAt: number | undefined;
  private lastCallEndedAt: number | undefined;
  private pendingTools = new Set<string>();
  private calls = 0;
  private usageUpdates = 0;
  private partial = false;
  private seenAnything = false;
  private finalSnapshot: SessionTurnSpeed | undefined;

  get active(): boolean {
    return this.finalSnapshot === undefined && (this.startedAt !== undefined || this.seenAnything);
  }

  start(ts: number, model: string | undefined): void {
    this.startedAt = ts;
    this.firstChunkAt = undefined;
    this.model = model;
    this.openCall(ts);
    this.pendingTools.clear();
    this.calls = 0;
    this.usageUpdates = 0;
    this.partial = false;
    this.seenAnything = true;
    this.finalSnapshot = undefined;
  }

  /** Text or thought characters streamed by the model. */
  chunk(ts: number, chars: number): void {
    if (this.finalSnapshot || !(chars > 0)) return;
    this.attachIfNeeded(ts);
    if (this.firstChunkAt === undefined) this.firstChunkAt = ts;
    if (!this.open) this.openCall(ts);
    const open = this.open!;
    if (open.firstChunkAt === undefined) open.firstChunkAt = ts;
    open.chars += chars;
  }

  /** The model asked for a tool: its call ended here. */
  toolCall(ts: number, toolCallId: string): void {
    if (this.finalSnapshot) return;
    this.attachIfNeeded(ts);
    if (this.firstChunkAt === undefined) this.firstChunkAt = ts;
    this.closeCall(ts);
    this.pendingTools.add(toolCallId);
  }

  /** A tool finished; the next model call starts once none is pending. */
  toolDone(ts: number, toolCallId: string): void {
    if (this.finalSnapshot) return;
    if (!this.pendingTools.delete(toolCallId)) return;
    if (this.pendingTools.size === 0 && !this.open) this.openCall(ts);
  }

  /** One usage_update per finished model call. */
  usage(): void {
    if (this.finalSnapshot) return;
    this.usageUpdates += 1;
  }

  snapshot(now: number): SessionTurnSpeed {
    if (this.finalSnapshot) return this.finalSnapshot;
    const open = this.open;
    const streaming = !!open && open.chars > 0;
    return {
      ...(this.startedAt !== undefined ? { startedAt: this.startedAt } : {}),
      ttftMs: this.startedAt !== undefined && this.firstChunkAt !== undefined
        ? Math.max(0, this.firstChunkAt - this.startedAt)
        : null,
      generationMs: 0,
      outputTokens: 0,
      messages: this.calls,
      ...(this.model ? { model: this.model } : {}),
      inFlight: streaming,
      inFlightChars: streaming ? open!.chars : 0,
      inFlightMs: streaming ? Math.max(0, now - open!.startedAt) : 0,
      inFlightVisibleMs: streaming && open!.firstChunkAt !== undefined ? Math.max(0, now - open!.firstChunkAt) : 0,
      final: false,
      ...(this.partial ? { partial: true } : {}),
    };
  }

  finish(ts: number, usage: AcpUsageCounts | undefined, interrupted: boolean): SessionTurnSpeed {
    if (this.finalSnapshot) return this.finalSnapshot;
    if (this.open) this.closeCall(ts);
    const live = this.snapshot(ts);
    const calls = Math.max(this.calls, this.usageUpdates);
    const output = usage?.outputTokens;
    const hiddenReasoning = (usage?.thoughtTokens ?? 0) > 0;
    const windowStart = hiddenReasoning ? this.lastCallStartedAt : (this.lastCallFirstChunkAt ?? this.lastCallStartedAt);
    const lastCallMs = windowStart !== undefined && this.lastCallEndedAt !== undefined
      ? Math.max(0, this.lastCallEndedAt - windowStart)
      : 0;
    const counted = typeof output === 'number';
    // computeCost prices an unknown model as Opus; an unpriced model shows no cost.
    const cost = counted && this.model && findPricing(this.model)
      ? computeCost({
          model: this.model,
          input_tokens: usage?.inputTokens ?? 0,
          output_tokens: output,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: usage?.cachedReadTokens ?? 0,
        })
      : 0;
    this.finalSnapshot = {
      ...live,
      messages: calls,
      generationMs: counted ? lastCallMs : 0,
      outputTokens: counted ? output : 0,
      ...(counted ? { turnOutputTokens: output } : {}),
      ...(counted && calls > 1 ? { tokenScope: 'last-call' as const } : {}),
      ...(typeof usage?.inputTokens === 'number' ? { inputTokens: usage.inputTokens } : {}),
      ...(typeof usage?.cachedReadTokens === 'number' ? { cachedInputTokens: usage.cachedReadTokens } : {}),
      ...(typeof usage?.thoughtTokens === 'number' && usage.thoughtTokens > 0 ? { reasoningTokens: usage.thoughtTokens } : {}),
      // One call's price is not the turn's: a several-call turn shows no cost.
      ...(cost > 0 && calls <= 1 ? { costUsd: cost, costEstimated: true } : {}),
      ...(this.startedAt !== undefined ? { durationMs: Math.max(0, ts - this.startedAt) } : {}),
      inFlight: false,
      inFlightChars: 0,
      inFlightMs: 0,
      inFlightVisibleMs: 0,
      final: true,
      ...(interrupted ? { interrupted: true } : {}),
      endedAt: ts,
    };
    return this.finalSnapshot;
  }

  private attachIfNeeded(ts: number): void {
    if (this.startedAt !== undefined || this.seenAnything) return;
    // A turn already running when this meter started reading: count what is
    // left of it, and say so.
    this.seenAnything = true;
    this.partial = true;
    this.openCall(ts);
  }

  private openCall(ts: number): void {
    this.open = { startedAt: ts, chars: 0 };
    this.lastCallStartedAt = ts;
    this.lastCallFirstChunkAt = undefined;
    this.lastCallEndedAt = undefined;
  }

  private closeCall(ts: number): void {
    if (!this.open) return;
    this.calls += 1;
    this.lastCallStartedAt = this.open.startedAt;
    this.lastCallFirstChunkAt = this.open.firstChunkAt;
    this.lastCallEndedAt = ts;
    this.open = undefined;
  }
}
