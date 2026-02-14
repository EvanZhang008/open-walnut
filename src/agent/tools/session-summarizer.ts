/**
 * Session Summarizer — pure function, zero side effects.
 *
 * Our code reads all context (task + session history), sends it to the model
 * in a single API call with no tools, and returns the summary text.
 * The caller decides what to do with the result.
 */

import { getConfig } from '../../core/config-manager.js';
import { getAgent } from '../../core/agent-registry.js';
import { readSessionHistory, type SessionHistoryMessage } from '../../core/session-history.js';
import { sendMessageStream } from '../model.js';
import { usageTracker } from '../../core/usage/index.js';
import { log } from '../../logging/index.js';
import type { SessionRecord } from '../../core/types.js';

const HISTORY_BUDGET_CHARS = 200_000;

const SYSTEM_PROMPT = `You are a session summarizer. Analyze the session history and linked task context below, then produce a structured summary.

## Output Format

### Summary
1-3 sentence TL;DR of what was accomplished.

### Key Decisions
Bullet list of important decisions made during the session.

### What Was Done
Bullet list of concrete actions/changes.

### Next Steps
Bullet list of remaining work (if any). Write "None" if the work is complete.

## Rules
- Be concise. No filler.
- Focus on outcomes, not process.
- If the session was a plan, summarize the plan.
- If the session made code changes, list the files and what changed.`;

/**
 * Summarize a session. Pure function — reads context, calls LLM, returns text.
 * No tools, no writes, no side effects.
 */
export async function summarizeSession(
  sessionId: string,
  record: SessionRecord | null,
): Promise<string> {
  // 1. Resolve model from config
  const config = await getConfig();
  const agentId = config.agent?.session_summarizer_agent;
  let model: string | undefined;

  if (agentId) {
    const agentDef = await getAgent(agentId);
    model = agentDef?.model;
  }
  model = model ?? config.agent?.model;

  // 2. Read session history
  const messages = await readSessionHistory(sessionId, record?.cwd, record?.host, record?.outputFile);
  if (messages.length === 0) {
    return 'No history found for this session — nothing to summarize.';
  }

  // 3. Read full task context — our code does the I/O, not the model
  let taskContext = '';
  if (record?.taskId) {
    try {
      const { getTask } = await import('../../core/task-manager.js');
      const task = await getTask(record.taskId);
      taskContext = [
        `## Linked Task`,
        `- ID: ${task.id}`,
        `- Title: ${task.title}`,
        `- Category: ${task.category}`,
        `- Project: ${task.project}`,
        `- Phase: ${task.phase}`,
        task.description ? `- Description: ${task.description}` : '',
        task.summary ? `- Current Summary: ${task.summary}` : '',
        task.note ? `- Notes:\n${task.note}` : '',
        '',
      ].filter(Boolean).join('\n');
    } catch {
      taskContext = `Task ID: ${record.taskId} (could not load details)`;
    }
  }

  // 4. Build user message with all context pre-assembled
  const historyText = formatHistoryForSummarizer(messages, HISTORY_BUDGET_CHARS);

  const userMessage = [
    `Session ID: ${sessionId}`,
    record?.title ? `Session Title: ${record.title}` : '',
    record?.project ? `Project: ${record.project}` : '',
    '',
    taskContext,
    '',
    `## Session History (${messages.length} messages)`,
    '',
    historyText,
  ].filter((line) => line !== undefined).join('\n');

  // 5. Single LLM call — no tools
  try {
    const result = await sendMessageStream({
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user' as const, content: userMessage }],
      config: { model },
    });

    // Track usage
    if (result.usage) {
      try {
        usageTracker.record({
          source: 'subagent',
          model: model ?? 'unknown',
          input_tokens: result.usage.input_tokens,
          output_tokens: result.usage.output_tokens,
          cache_creation_input_tokens: result.usage.cache_creation_input_tokens,
          cache_read_input_tokens: result.usage.cache_read_input_tokens,
        });
      } catch { /* non-critical */ }
    }

    const text = result.content
      .filter((b) => b.type === 'text')
      .map((b) => (b as { type: 'text'; text: string }).text)
      .join('');

    log.subagent.info('session summarizer completed', {
      sessionId,
      model,
      inputTokens: result.usage?.input_tokens,
      outputTokens: result.usage?.output_tokens,
      responseLength: text.length,
    });

    return text;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.subagent.error('session summarizer failed', { sessionId, model, error: msg });
    return `Error running session summarizer: ${msg}`;
  }
}

/**
 * Format session messages into a readable text block within a character budget.
 */
function formatHistoryForSummarizer(
  messages: SessionHistoryMessage[],
  budget: number,
): string {
  const parts: string[] = [];
  let totalChars = 0;

  for (const m of messages) {
    const toolList = m.tools?.map((t) => t.name).join(', ') ?? '';
    const header = `### [${m.timestamp}] ${m.role.toUpperCase()}${toolList ? ` (tools: ${toolList})` : ''}`;
    const entry = `${header}\n${m.text}`;

    if (totalChars + entry.length > budget) {
      const remaining = budget - totalChars;
      if (remaining > 200) {
        parts.push(`${header}\n${m.text.slice(0, remaining - header.length - 50)}\n... [truncated]`);
      }
      parts.push(`\n... [${messages.length - parts.length} more messages truncated due to budget]`);
      break;
    }

    parts.push(entry);
    totalChars += entry.length;
  }

  return parts.join('\n\n');
}
