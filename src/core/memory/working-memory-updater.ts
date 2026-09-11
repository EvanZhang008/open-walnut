/**
 * Working Memory Updater — post-turn hook that maintains working-memory.md.
 *
 * Trigger cadence: 10K tokens initial + 5K token growth + 3 tool calls.
 *
 * The update is a ONE-SHOT model call, not a tool-using turn: the prompt already
 * inlines the current file, so the model has everything it needs to hand back the
 * whole file, and the code — not the model — decides whether that answer may
 * replace what is on disk. A half-applied edit is worse than no update at all,
 * which is why a malformed answer is refused whole (see validateWorkingMemoryAnswer).
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  getWorkingMemory,
  getWorkingMemoryPath,
  ensureWorkingMemory,
  getWorkingMemorySectionSizes,
  MAX_SECTION_TOKENS,
  MAX_TOTAL_WORKING_MEMORY_TOKENS,
  WORKING_MEMORY_TEMPLATE,
} from '../working-memory.js';
import { estimateTokens } from '../daily-log.js';
import { log } from '../../logging/index.js';

// Thresholds borrowed from Claude Code's sessionMemory.ts. 10K initial ensures enough
// conversation context before first extraction. 5K growth + 3 tool calls ensures
// meaningful new content (prevents updating on idle/chat-only turns).
const INITIALIZATION_THRESHOLD = 10_000; // tokens before first update
const UPDATE_THRESHOLD = 5_000;          // token growth between updates
const TOOL_CALL_THRESHOLD = 3;           // min tool calls since last update

/** Output ceiling for the one-shot. The answer is a WHOLE file capped at
 *  MAX_TOTAL_WORKING_MEMORY_TOKENS, so this only needs headroom above it — high
 *  enough that a slightly-too-long answer is still readable (and refused by the
 *  validator) rather than silently cut off mid-section. */
const UPDATE_MAX_TOKENS = 16_000;

/** A stalled provider must not hold the extraction slot for the whole window
 *  shouldUpdateWorkingMemory treats as "still running". */
const UPDATE_TIMEOUT_MS = 60_000;

// ── State tracking (per conversation) ──
// Each conversation tracks its own update cadence. A single global object would
// let one busy conversation's tool-call/token counters suppress or wrongly trigger
// another conversation's working-memory update (cross-talk).
interface UpdaterState {
  lastMessageUuid: string | null;
  tokensAtLastExtraction: number;
  toolCallsSinceLastExtraction: number;
  extractionStartedAt: number | null;
  isCompacting: boolean;
}

function freshUpdaterState(): UpdaterState {
  return {
    lastMessageUuid: null,
    tokensAtLastExtraction: 0,
    toolCallsSinceLastExtraction: 0,
    extractionStartedAt: null,
    isCompacting: false,
  };
}

const stateByConversation = new Map<string, UpdaterState>();

function stateKey(agentId?: string, conversationId?: string): string {
  return `${agentId || 'general'}:${conversationId || '_'}`;
}

function getState(agentId?: string, conversationId?: string): UpdaterState {
  const key = stateKey(agentId, conversationId);
  let s = stateByConversation.get(key);
  if (!s) { s = freshUpdaterState(); stateByConversation.set(key, s); }
  return s;
}

/**
 * Reset updater state. With no args (server startup) clears ALL conversations'
 * state; with a conversation pair resets just that one.
 */
export function resetUpdaterState(agentId?: string, conversationId?: string): void {
  if (agentId === undefined && conversationId === undefined) {
    stateByConversation.clear();
    return;
  }
  stateByConversation.set(stateKey(agentId, conversationId), freshUpdaterState());
}

/** Mark compaction in progress (skip updates during compaction) for a conversation. */
export function setCompacting(value: boolean, agentId?: string, conversationId?: string): void {
  getState(agentId, conversationId).isCompacting = value;
}

/** Track tool call count for trigger threshold for a conversation. */
export function trackToolCall(agentId?: string, conversationId?: string): void {
  getState(agentId, conversationId).toolCallsSinceLastExtraction++;
}

/**
 * Check if working memory update should trigger for a conversation.
 * Called after each AI response in the agent loop.
 */
export function shouldUpdateWorkingMemory(currentTokens: number, agentId?: string, conversationId?: string): boolean {
  const state = getState(agentId, conversationId);
  if (state.isCompacting) return false;

  // 15s: normal update should complete within this window (single LLM call + file write).
  // 60s: if extraction is stuck (LLM timeout, hung provider), treat as stale and allow retry.
  if (state.extractionStartedAt) {
    const elapsed = Date.now() - state.extractionStartedAt;
    if (elapsed < 15_000) return false; // still running
    if (elapsed > 60_000) {
      log.agent.warn('Working memory extraction stale, resetting');
      state.extractionStartedAt = null;
    } else {
      return false;
    }
  }

  const tokenGrowth = currentTokens - state.tokensAtLastExtraction;
  const hasEnoughToolCalls = state.toolCallsSinceLastExtraction >= TOOL_CALL_THRESHOLD;

  // First update: needs initialization threshold
  if (state.tokensAtLastExtraction === 0) {
    return currentTokens >= INITIALIZATION_THRESHOLD && hasEnoughToolCalls;
  }

  // Subsequent updates: needs token growth + tool calls
  const hasEnoughTokenGrowth = tokenGrowth >= UPDATE_THRESHOLD;
  return hasEnoughTokenGrowth && hasEnoughToolCalls;
}

/** The section headers a valid answer must still carry, taken from the template
 *  itself so the two can never drift. */
const TEMPLATE_HEADERS: string[] = WORKING_MEMORY_TEMPLATE
  .split('\n')
  .filter((line) => line.startsWith('# '))
  .map((line) => line.trim());

/**
 * Build the update prompt. The current file is inlined, so the model needs no
 * tools and no conversation history to answer.
 */
export function buildWorkingMemoryUpdatePrompt(agentId?: string, conversationId?: string): string {
  ensureWorkingMemory(agentId, conversationId);
  const current = getWorkingMemory(agentId, conversationId) ?? WORKING_MEMORY_TEMPLATE;
  const workingMemoryPath = getWorkingMemoryPath(agentId, conversationId);
  const sectionSizes = getWorkingMemorySectionSizes(current);
  const totalTokens = estimateTokens(current);

  // Build size warnings
  const warnings: string[] = [];
  for (const [section, tokens] of sectionSizes) {
    if (tokens > MAX_SECTION_TOKENS) {
      warnings.push(`WARNING: "${section}" is ${tokens} tokens (limit: ${MAX_SECTION_TOKENS}). Condense aggressively.`);
    }
  }
  if (totalTokens > MAX_TOTAL_WORKING_MEMORY_TOKENS) {
    warnings.push(`WARNING: Total working memory is ${totalTokens} tokens (limit: ${MAX_TOTAL_WORKING_MEMORY_TOKENS}). Condense all sections.`);
  }

  const warningBlock = warnings.length > 0 ? `\n\n${warnings.join('\n')}` : '';

  return `You are updating the working memory notes file at: ${workingMemoryPath}

<current_working_memory>
${current}
</current_working_memory>
${warningBlock}

## Instructions

Reply with the COMPLETE updated file and nothing else: no preamble, no closing
remark, no code fence. Your whole reply replaces the file verbatim, so anything
you leave out is lost.

Rules:
1. Keep EVERY section header exactly as it appears above, in the same order:
${TEMPLATE_HEADERS.map((h) => `   ${h}`).join('\n')}
2. Replace the italic placeholder text with actual content under each section.
   A section with nothing to say keeps its header and its italic placeholder.
3. Keep each section under ~${MAX_SECTION_TOKENS} tokens, and the whole file under
   ~${MAX_TOTAL_WORKING_MEMORY_TOKENS} tokens. Be concise: bullet points, not prose.
4. ALWAYS update "Active Focus" — it must reflect the current state.
5. Include task IDs, session IDs, and specific names — not vague descriptions.
6. Remove information that is no longer relevant (old completed tasks, resolved issues).
7. Do NOT duplicate information across sections.

Think about what happened since the last update:
- What is the user currently focused on?
- What did they ask for?
- What decisions were made and why?
- What went wrong or was surprising?
- What sessions are running?
- What's still open/unresolved?
- What patterns or lessons emerged?`;
}

/** A model answer that may replace the file, or the reason it may not. */
export type WorkingMemoryValidation =
  | { ok: true; content: string }
  | { ok: false; reason: string };

/**
 * Strip one wrapping code fence. The prompt forbids fences, but a fenced answer
 * is otherwise perfectly good content and refusing it would throw away a whole
 * update over punctuation.
 */
function stripCodeFence(text: string): string {
  const trimmed = text.trim();
  if (!trimmed.startsWith('```')) return trimmed;
  const lines = trimmed.split('\n');
  if (lines.length < 2) return trimmed;
  const closing = lines[lines.length - 1].trim();
  if (closing !== '```' && !closing.startsWith('```')) return trimmed;
  return lines.slice(1, -1).join('\n').trim();
}

/**
 * Decide whether a model answer may be written as the whole working-memory file.
 *
 * Every rule here exists because the answer REPLACES the file: a reply that
 * dropped a header would silently delete that section for good, and one over
 * budget would grow the thing this file exists to bound. Refusal is cheap — the
 * next turn that crosses the threshold asks again.
 */
export function validateWorkingMemoryAnswer(answer: string | null | undefined): WorkingMemoryValidation {
  const content = stripCodeFence(answer ?? '');
  if (!content) return { ok: false, reason: 'empty answer' };

  const lines = new Set(content.split('\n').map((l) => l.trim()));
  const missing = TEMPLATE_HEADERS.filter((h) => !lines.has(h));
  if (missing.length > 0) {
    return { ok: false, reason: `missing section header(s): ${missing.join(', ')}` };
  }

  const totalTokens = estimateTokens(content);
  if (totalTokens > MAX_TOTAL_WORKING_MEMORY_TOKENS) {
    return { ok: false, reason: `total ${totalTokens} tokens over the ${MAX_TOTAL_WORKING_MEMORY_TOKENS} limit` };
  }

  for (const [section, tokens] of getWorkingMemorySectionSizes(content)) {
    if (tokens > MAX_SECTION_TOKENS) {
      return { ok: false, reason: `section "${section}" is ${tokens} tokens, over the ${MAX_SECTION_TOKENS} limit` };
    }
  }

  return { ok: true, content: content.endsWith('\n') ? content : `${content}\n` };
}

/** Runs the update prompt and returns the model's raw answer. */
export type WorkingMemoryRunner = (prompt: string) => Promise<string>;

/**
 * The default runner: one non-streaming model call, no tools, no history.
 *
 * History is deliberately absent — the prompt carries the current file inline,
 * and feeding the conversation would multiply the cost of what is meant to be a
 * cheap extraction.
 */
export const runWorkingMemoryUpdate: WorkingMemoryRunner = async (prompt) => {
  const { sendMessage } = await import('../../agent/model.js');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPDATE_TIMEOUT_MS);
  try {
    const result = await sendMessage({
      system: 'You maintain a working-memory notes file. You reply with the complete updated file and nothing else.',
      messages: [{ role: 'user', content: prompt }],
      config: { maxTokens: UPDATE_MAX_TOKENS },
      signal: controller.signal,
    });
    return (result.content ?? [])
      .map((b) => (b.type === 'text' && 'text' in b ? (b as { text: string }).text : ''))
      .join('');
  } finally {
    clearTimeout(timer);
  }
};

/**
 * Execute the working memory update. Fire-and-forget from the turn that
 * triggered it.
 *
 * `runner` is a parameter rather than a direct call so a test can answer without
 * a provider; the validation and the write live HERE, on the code side of the
 * seam, so a stubbed runner still exercises them.
 */
export async function executeWorkingMemoryUpdate(
  runner: WorkingMemoryRunner,
  currentTokens: number,
  agentId?: string,
  conversationId?: string,
): Promise<void> {
  const state = getState(agentId, conversationId);
  state.extractionStartedAt = Date.now();

  try {
    const prompt = buildWorkingMemoryUpdatePrompt(agentId, conversationId);
    const answer = await runner(prompt);
    const verdict = validateWorkingMemoryAnswer(answer);
    if (!verdict.ok) {
      // Not an error the user can act on, but it means working memory silently
      // stopped advancing — the one signal that says so.
      log.agent.warn('Working memory update refused', {
        reason: verdict.reason,
        answerLength: (answer ?? '').length,
        agentId: agentId || 'general',
        conversationId,
      });
      return;
    }

    const file = getWorkingMemoryPath(agentId, conversationId);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, verdict.content, 'utf-8');

    // Update state after successful extraction
    state.tokensAtLastExtraction = currentTokens;
    state.toolCallsSinceLastExtraction = 0;
    state.lastMessageUuid = null;

    log.agent.info('Working memory updated', {
      tokens: currentTokens,
      bytes: verdict.content.length,
      agentId: agentId || 'general',
      conversationId,
    });
  } catch (err) {
    log.agent.warn('Working memory update failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  } finally {
    state.extractionStartedAt = null;
  }
}
