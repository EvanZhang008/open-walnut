/**
 * Stateful agent memory helpers.
 *
 * - buildStatefulMemorySection(): reads project MEMORY.md, truncates to budget,
 *   wraps in a prompt section for injection into the agent's system prompt.
 * - extractMemoryUpdate(): finds <memory_update>...</memory_update> in agent
 *   response and returns inner content.
 */

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
