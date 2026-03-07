/**
 * Token Budget Guard — prevents API calls from exceeding context window limits.
 *
 * Estimates the full payload (system prompt + tools + messages) before each
 * model call and takes corrective action when the budget is exceeded:
 * Emergency trim — drops oldest messages from the in-memory array.
 */

import type { MessageParam } from './model.js';
import { getContextWindowSize } from './model.js';
import { estimateFullPayload, estimateMessagesTokens } from '../core/daily-log.js';

export type ToolSchema = { name: string; description: string; input_schema: unknown };
import { log } from '../logging/index.js';

/**
 * Default context window budget for 200K models.
 * We leave 32K headroom for the response and token-counting inaccuracies.
 * For 1M models, computed dynamically via getContextBudget().
 */
const DEFAULT_BUDGET = 168_000;

/** Response headroom: ~16% of context window reserved for output + estimation slack. */
const BUDGET_PERCENT = 0.84;

/**
 * Compute token budget for a model: 84% of context window (16% headroom for response).
 * For 200K models: 168K. For 1M models: 840K.
 */
export function getContextBudget(model?: string): number {
  return Math.round(getContextWindowSize(model) * BUDGET_PERCENT);
}

/** Minimum messages to keep even in emergency trim */
const MIN_MESSAGES_TO_KEEP = 4;

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
 * Emergency trim: remove oldest messages to fit within a token budget.
 * Keeps at minimum the last MIN_MESSAGES_TO_KEEP messages.
 * Preserves turn boundaries: never starts on an assistant message or orphan tool_result.
 */
export function emergencyTrim(
  messages: MessageParam[],
  targetTokens: number,
): MessageParam[] {
  if (messages.length <= MIN_MESSAGES_TO_KEEP) return messages;

  // Try progressively removing more messages from the front, starting with the least aggressive trim.
  for (let keep = messages.length - 1; keep >= MIN_MESSAGES_TO_KEEP; keep--) {
    const candidate = messages.slice(messages.length - keep);
    const first = candidate[0] as { role: string; content: unknown };

    // Must start on a valid user message (not assistant, not tool_result)
    if (!isValidStart(first)) continue;

    const tokens = estimateMessagesTokens(candidate);
    if (tokens <= targetTokens) {
      return candidate;
    }
  }

  // Last resort: keep only the minimum, but find a valid start point
  for (let i = messages.length - MIN_MESSAGES_TO_KEEP; i < messages.length; i++) {
    const first = messages[i] as { role: string; content: unknown };
    if (isValidStart(first)) {
      return messages.slice(i);
    }
  }

  // Absolute fallback (should not happen in practice)
  log.agent.warn('emergencyTrim: could not find valid start, keeping last messages');
  return messages.slice(-MIN_MESSAGES_TO_KEEP);
}
