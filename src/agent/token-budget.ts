/**
 * Token Budget Guard — prevents API calls from exceeding context window limits.
 *
 * Estimates the full payload (system prompt + tools + messages) before each
 * model call and takes corrective action when the budget is exceeded:
 * Emergency trim — drops oldest messages from the in-memory array.
 */

import type { MessageParam } from './model.js';
import { getContextThreshold } from './model.js';
import { estimateFullPayload, estimateMessagesTokens } from '../core/daily-log.js';

export type ToolSchema = { name: string; description: string; input_schema: unknown };
import { log } from '../logging/index.js';

/** ~16% headroom for output + estimation slack. 200K→168K, 1M→840K. */
const BUDGET_PERCENT = 0.84;

/** Compute token budget for a model: 84% of context window. */
export function getContextBudget(model?: string): number {
  return getContextThreshold(model, BUDGET_PERCENT);
}

/** Minimum messages to keep even in emergency trim */
const MIN_MESSAGES_TO_KEEP = 4;

/** How many recent turns (user messages) to protect from tool-result soft-trim.
 *  Keeps the last 3 user interactions at full fidelity — enough for the model to
 *  still reason about what it's actively working on, while older bulky tool output
 *  (which has already served its purpose) becomes shrink-eligible. */
const TRIM_PROTECT_TURNS = 3;
/** A tool_result longer than this many chars is a candidate for soft-trim (~750
 *  tokens). Below this the payload isn't worth the lossy shrink — let Stage 2
 *  whole-message deletion handle it if needed. MUST stay > TRIM_TOOL_RESULT_KEEP*2
 *  so head+tail never overlap (see shrinkText). */
const TRIM_TOOL_RESULT_THRESHOLD = 3_000;
/** When soft-trimming, keep this many chars from the head AND the tail (so a 50K
 *  result collapses to ~2K + marker — a constant-factor cut, not a percentage). */
const TRIM_TOOL_RESULT_KEEP = 1_000;

export interface BudgetGuardOptions {
  system: string;
  tools: ToolSchema[];
  messages: MessageParam[];
  /** Token budget. Default: computed from model context window (168K for 200K, 840K for 1M). */
  budget?: number;
  /** Model string — used to compute default budget when `budget` is not provided. */
  model?: string;
  /** Caller label for logging */
  source?: string;
  /**
   * Pre-computed token estimate from the caller (e.g. exact baseline + delta).
   * When provided and within budget, skips the internal estimateFullPayload call.
   * When provided and over budget, falls through to full estimation for accurate trimming.
   */
  tokenEstimate?: number;
}

export interface BudgetGuardResult {
  /** The messages array (possibly trimmed) */
  messages: MessageParam[];
  /** Whether any action was taken */
  trimmed: boolean;
  /** Estimated total tokens after any trimming */
  estimatedTokens: number;
}

/**
 * Check if the full context exceeds the budget and take corrective action.
 *
 * Returns the (possibly trimmed) messages array and whether trimming occurred.
 * When trimming is needed, a new array is returned; the original is not mutated.
 */
export async function guardBudget(opts: BudgetGuardOptions): Promise<BudgetGuardResult> {
  const budget = opts.budget ?? getContextBudget(opts.model);
  const source = opts.source ?? 'agent';

  // Fast path: caller provided a reliable estimate (exact baseline + delta) that's within budget.
  // Skip the full estimateFullPayload call to reduce overhead on every-round guards.
  if (opts.tokenEstimate !== undefined && opts.tokenEstimate <= budget) {
    return { messages: opts.messages, trimmed: false, estimatedTokens: opts.tokenEstimate };
  }

  // Full estimation needed: either no estimate provided, or estimate exceeds budget.
  const breakdown = estimateFullPayload({
    system: opts.system,
    tools: opts.tools,
    messages: opts.messages,
  });

  if (breakdown.total <= budget) {
    return { messages: opts.messages, trimmed: false, estimatedTokens: breakdown.total };
  }

  log.agent.warn(`${source} token budget exceeded`, {
    total: `~${Math.round(breakdown.total / 1000)}K`,
    budget: `~${Math.round(budget / 1000)}K`,
    messages: opts.messages.length,
    system: `~${Math.round(breakdown.system / 1000)}K`,
    tools: `~${Math.round(breakdown.tools / 1000)}K`,
    msgTokens: `~${Math.round(breakdown.messages / 1000)}K`,
  });

  // Emergency trim — remove oldest messages until within budget
  // The overhead (system + tools) is fixed, so we need messages to fit in the remaining budget
  const fixedOverhead = breakdown.system + breakdown.tools;
  const messageBudget = budget - fixedOverhead;

  if (messageBudget <= 0) {
    // System + tools alone exceed the budget — nothing we can do with messages
    log.agent.error(`${source} system+tools alone exceed budget`, {
      fixedOverhead: `~${Math.round(fixedOverhead / 1000)}K`,
      budget: `~${Math.round(budget / 1000)}K`,
    });
    return { messages: opts.messages, trimmed: false, estimatedTokens: breakdown.total };
  }

  const trimmedMessages = emergencyTrim(opts.messages, messageBudget);
  const newMsgTokens = estimateMessagesTokens(trimmedMessages);
  const newTotal = fixedOverhead + newMsgTokens;

  log.agent.info(`${source} emergency trim complete`, {
    before: opts.messages.length,
    after: trimmedMessages.length,
    removed: opts.messages.length - trimmedMessages.length,
    newTotal: `~${Math.round(newTotal / 1000)}K`,
  });

  return { messages: trimmedMessages, trimmed: true, estimatedTokens: newTotal };
}

/**
 * Check if a message is a valid conversation start (user text, not tool_result).
 */
function isValidStart(msg: { role: string; content: unknown }): boolean {
  if (msg.role !== 'user') return false;
  if (Array.isArray(msg.content)) {
    return !(msg.content as Array<{ type: string }>).some(b => b.type === 'tool_result');
  }
  return true; // string content is always valid
}

/**
 * Soft-trim large tool_result blocks in OLD messages, keeping head + tail.
 *
 * This is the cheap, information-preserving first stage of emergency trimming:
 * a giant `exec`/`web_fetch`/`grep` result that has already served its purpose
 * still occupies its full token cost forever in history. We shrink the middle of
 * such results (keeping head + tail so the model still sees what the call did)
 * instead of deleting whole user/assistant turns — which would destroy the
 * intent/decision trail and break tool_use↔tool_result pairing.
 *
 * Recent turns (last TRIM_PROTECT_TURNS user messages) are never touched, so the
 * model retains full fidelity on what it's actively working on.
 *
 * Returns a new array; never mutates the input. Pairing is preserved (we only
 * shrink the text payload of a tool_result, never remove the block).
 *
 * INVARIANT — do NOT "optimize" this to mutate in place: callers run this on the
 * in-memory `messages` array, but runAgentLoop's `newMessages` accumulator holds the
 * SAME block object references and is what gets persisted to disk. Building new
 * objects here is what lets the API see a shrunk copy while the on-disk history keeps
 * full fidelity. In-place mutation would reach through the shared refs and corrupt
 * what lands on disk.
 */
export function shrinkOldToolResults(messages: MessageParam[]): MessageParam[] {
  // Find the index from which messages are "recent" and must not be shrunk.
  let turnCount = 0;
  let protectedFromIdx = messages.length;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') {
      turnCount++;
      if (turnCount >= TRIM_PROTECT_TURNS) {
        protectedFromIdx = i;
        break;
      }
    }
  }

  let shrankAny = false;
  const result = messages.map((msg, idx) => {
    if (idx >= protectedFromIdx) return msg;
    const content = msg.content;
    if (!Array.isArray(content)) return msg;

    let changed = false;
    const trimmed = content.map((block) => {
      if (
        typeof block === 'object' && block !== null && 'type' in block &&
        (block as { type: string }).type === 'tool_result' && 'content' in block
      ) {
        const inner = (block as { content?: unknown }).content;
        // tool_result content can be a string OR an array of text/image blocks.
        if (typeof inner === 'string' && inner.length > TRIM_TOOL_RESULT_THRESHOLD) {
          changed = true;
          return { ...block, content: shrinkText(inner) };
        }
        if (Array.isArray(inner)) {
          let innerChanged = false;
          const newInner = inner.map((b) => {
            if (
              typeof b === 'object' && b !== null && (b as { type?: string }).type === 'text' &&
              typeof (b as { text?: string }).text === 'string' &&
              (b as { text: string }).text.length > TRIM_TOOL_RESULT_THRESHOLD
            ) {
              innerChanged = true;
              return { ...b, text: shrinkText((b as { text: string }).text) };
            }
            return b;
          });
          if (innerChanged) {
            changed = true;
            return { ...block, content: newInner };
          }
        }
      }
      return block;
    });
    if (changed) {
      shrankAny = true;
      return { ...msg, content: trimmed };
    }
    return msg;
  }) as MessageParam[];

  return shrankAny ? result : messages;
}

/** Shrink a long string to head + "[trimmed N chars]" + tail.
 *  Guard: if the text isn't longer than head+tail combined, shrinking would make
 *  head/tail overlap and report a negative trimmed-count, so return it unchanged.
 *  (Callers only invoke this for text > TRIM_TOOL_RESULT_THRESHOLD, which is already
 *  > KEEP*2, so this guard is belt-and-suspenders for any future direct caller.) */
function shrinkText(text: string): string {
  if (text.length <= TRIM_TOOL_RESULT_KEEP * 2) return text;
  const head = text.slice(0, TRIM_TOOL_RESULT_KEEP);
  const tail = text.slice(-TRIM_TOOL_RESULT_KEEP);
  const removed = text.length - TRIM_TOOL_RESULT_KEEP * 2;
  return `${head}\n\n...[trimmed ${removed} chars from a stale tool result]...\n\n${tail}`;
}

/**
 * Emergency trim: bring messages within a token budget with the LEAST destructive
 * action that works.
 *
 * Stage 1 (information-preserving): soft-trim large tool_result blocks in old
 *   messages (keep head + tail). This is your-intent-preserving — it shrinks bulky
 *   tool output, NOT the conversation. If that alone fits the budget, done.
 * Stage 2 (last resort): only if Stage 1 still overflows, drop oldest WHOLE
 *   messages from the front. Preserves turn boundaries: never starts on an
 *   assistant message or orphan tool_result.
 *
 * Returns a new array; never mutates the input.
 */
export function emergencyTrim(
  messages: MessageParam[],
  targetTokens: number,
): MessageParam[] {
  if (messages.length <= MIN_MESSAGES_TO_KEEP) return messages;

  const beforeTokens = estimateMessagesTokens(messages);
  if (beforeTokens <= targetTokens) return messages;

  // Stage 1: shrink stale tool results before deleting any conversation.
  let working = messages;
  const shrunk = shrinkOldToolResults(working);
  if (shrunk !== working) {
    const after = estimateMessagesTokens(shrunk);
    log.agent.info('emergencyTrim: shrank stale tool results', {
      before: `~${Math.round(beforeTokens / 1000)}K`,
      after: `~${Math.round(after / 1000)}K`,
      target: `~${Math.round(targetTokens / 1000)}K`,
    });
    working = shrunk;
    if (after <= targetTokens) return working;
  }

  // Stage 2: still over budget — remove oldest whole messages from the front.
  // Precompute each message's token cost ONCE (single pass), then walk a running
  // suffix-sum. The naive form (re-estimate the whole slice for every candidate)
  // is O(n²) over the tokenizer and times out on 1M-token histories.
  const perMsg = working.map((m) => estimateMessagesTokens([m]));

  // suffixTokens[i] = total tokens of working[i..end]
  const suffixTokens = new Array<number>(working.length + 1);
  suffixTokens[working.length] = 0;
  for (let i = working.length - 1; i >= 0; i--) {
    suffixTokens[i] = suffixTokens[i + 1] + perMsg[i];
  }

  const maxStart = working.length - MIN_MESSAGES_TO_KEEP; // keep at least the last MIN
  for (let start = 1; start <= maxStart; start++) {
    const first = working[start] as { role: string; content: unknown };
    // Must start on a valid user message (not assistant, not orphan tool_result)
    if (!isValidStart(first)) continue;
    if (suffixTokens[start] <= targetTokens) {
      return working.slice(start);
    }
  }

  // Last resort: keep only the minimum, but find a valid start point
  for (let i = working.length - MIN_MESSAGES_TO_KEEP; i < working.length; i++) {
    const first = working[i] as { role: string; content: unknown };
    if (isValidStart(first)) {
      return working.slice(i);
    }
  }

  // Absolute fallback: no valid (user, non-tool_result) start in the last
  // MIN_MESSAGES_TO_KEEP messages. This means the tail is all assistant/orphan
  // tool_result — a sign of upstream message-shape corruption, not normal trimming.
  // Return the tail anyway so we don't hang, but log at error level for forensics.
  log.agent.error('emergencyTrim: no valid start in tail, returning orphaned tail (upstream shape bug?)', {
    total: working.length,
    keeping: MIN_MESSAGES_TO_KEEP,
  });
  return working.slice(-MIN_MESSAGES_TO_KEEP);
}
