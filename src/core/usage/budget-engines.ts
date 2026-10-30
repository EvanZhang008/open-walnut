/**
 * The engines whose sessions can carry a budget: those that record per-request usage.
 * Pure, no imports: the web client uses this same file (`@open-walnut/budget-engines`),
 * so it never asks for the budget of a session that cannot have one. 2026-10-30: every
 * Gemini, Goose, Pi and DeepSeek session panel asked, got a 400 and logged an error.
 * The daemon's copy (src/providers/usage-budget-runtime.ts) is checked against this one
 * in tests/core/usage/budget-engines.test.ts.
 */
export const BUDGET_ENGINES = ['claude', 'codex', 'opencode'] as const;

/** A session with no engine recorded is a Claude Code session. */
export function engineHasBudget(engine: string | null | undefined): boolean {
  return (BUDGET_ENGINES as readonly string[]).includes(engine || 'claude');
}
