/**
 * Stateful agent memory helpers.
 *
 * - buildStatefulMemorySection(): reads project MEMORY.md, truncates to budget,
 *   wraps in a prompt section for injection into the agent's system prompt.
 * - extractMemoryUpdate(): finds <memory_update>...</memory_update> in agent
 *   response and returns inner content.
 * - persistMemoryUpdate(): writes that content back to the project summary.
 *
 * WHY the <memory_update> tag protocol and not a tool: a stateful agent's
 * carry-forward state lives in `memory/projects/<path>/MEMORY.md`'s YAML
 * `description` field, and NO tool can write there. `memory_manage` is hardwired
 * to the two global stores (`getBoundedMemory(undefined, target)`); `file_write`
 * on `memory/project/...` either reroutes appends to skill history or demands a
 * content_hash round-trip over the whole file. So this tag — which
 * buildStatefulMemorySection has always advertised in the prompt — is the only
 * mechanism, and it must stay wired at every dispatch site.
 */

import { log } from '../logging/index.js';
import type { AgentStatefulConfig } from '../core/types.js';

const DEFAULT_BUDGET_TOKENS = 4000;
// Rough chars-per-token ratio (lower = more aggressive truncation to leave headroom)
const CHARS_PER_TOKEN = 3.5;

/**
 * Build the stateful memory section for injection into the system prompt.
 *
 * @param rawMemory - Full content of the project MEMORY.md (or null if not found)
 * @param config - Agent stateful config
 * @returns System prompt section string
 */
export function buildStatefulMemorySection(
  rawMemory: string | null,
  config: AgentStatefulConfig,
): string {
  const budgetTokens = config.memory_budget_tokens ?? DEFAULT_BUDGET_TOKENS;
  const budgetChars = Math.floor(budgetTokens * CHARS_PER_TOKEN);

  let memoryContent = rawMemory ?? '(no memory yet — this is your first invocation)';

  // Truncate if needed
  if (memoryContent.length > budgetChars) {
    memoryContent = memoryContent.slice(0, budgetChars) + '\n\n[...truncated]';
  }

  return [
    '## Stateful Memory Protocol',
    `You have persistent memory at project "${config.memory_project}".`,
    'Your current accumulated state is shown below.',
    'To update your memory for the next invocation, wrap your update in <memory_update> tags.',
    'The content inside the tags will REPLACE your memory summary (YAML description field).',
    'Always include your full updated summary — it is your only carry-forward state.',
    'This tag is the ONLY way to persist state: no tool can write to your memory project.',
    'Emit the update as plain markdown — do NOT re-wrap it in `---` frontmatter or a code fence.',
    'Omitting the tag leaves your memory unchanged (the previous state carries forward).',
    '',
    '## Current Memory State',
    memoryContent,
  ].join('\n');
}

/**
 * Extract the content between <memory_update> and </memory_update> tags
 * from the agent's response text.
 *
 * @returns The inner content, or null if no tags found
 */
export function extractMemoryUpdate(response: string): string | null {
  const match = response.match(/<memory_update>([\s\S]*?)<\/memory_update>/);
  if (!match) return null;
  return match[1].trim();
}

/**
 * Persist a stateful agent's `<memory_update>` block to its project summary.
 *
 * Deliberately summary-ONLY (rewrites the YAML `description`, preserving the log
 * body): the pre-2026-02 version also appended a 500-char slice of every
 * response to the same file, which is how this store reached 706 KB / 1,276
 * append blocks. Episodic detail belongs in skill history, not here.
 *
 * Best-effort: a persistence failure is logged, never thrown — a stateful agent
 * losing one carry-forward write must not fail the whole cron tick.
 *
 * @returns true when an update was found AND written.
 */
export async function persistMemoryUpdate(
  response: string | undefined,
  config: AgentStatefulConfig,
  agentName: string,
  logContext: Record<string, unknown> = {},
): Promise<boolean> {
  if (!response) return false;
  const update = extractMemoryUpdate(response);
  if (!update) return false;

  try {
    const { updateProjectSummary } = await import('../core/project-memory.js');
    await updateProjectSummary(config.memory_project, agentName, update);
    log.subagent.info('stateful memory summary updated', {
      ...logContext,
      memoryProject: config.memory_project,
      updateChars: update.length,
    });
    return true;
  } catch (err) {
    log.subagent.warn('stateful memory summary update failed', {
      ...logContext,
      memoryProject: config.memory_project,
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}
