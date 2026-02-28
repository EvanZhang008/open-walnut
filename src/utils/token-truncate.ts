/**
 * Token-aware text truncation utility.
 *
 * Shared by context-sources (subagent) and chat route (main agent enriched context).
 */

import { estimateTokens } from '../core/daily-log.js';

/**
 * Truncate text to fit within a token budget.
 * Uses ~3.5 chars/token heuristic and snaps to a word boundary.
 */
export function truncateToTokenBudget(text: string, budget: number): string {
  const tokens = estimateTokens(text);
  if (tokens <= budget) return text;

  // Approximate character budget (conservative: ~3.5 chars per token)
  const charBudget = Math.floor(budget * 3.5);
  let truncated = text.slice(0, charBudget);

  // Find last word boundary to avoid cutting mid-word
  const lastSpace = truncated.lastIndexOf(' ');
  if (lastSpace > charBudget * 0.8) {
    truncated = truncated.slice(0, lastSpace);
  }

  return truncated + '\n\n[...truncated]';
}
