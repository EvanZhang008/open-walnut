import type { SessionUsage } from '@/api/session-usage';

export function formatUsageCost(cost: number | null): string {
  if (cost === null || !Number.isFinite(cost) || cost < 0) return 'not checked yet';
  if (cost > 0 && cost < 0.01) return '<$0.01';
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(cost);
}

export function remainingAllowance(usage: SessionUsage): number | null {
  const { spentUsd, limitUsd } = usage.budget;
  return spentUsd === null || limitUsd === null || !Number.isFinite(spentUsd) ? null : Math.max(0, limitUsd - spentUsd);
}

/** The one line a paused budget puts by the composer; nothing for a session that is not paused. */
export function budgetPauseLabel(usage: SessionUsage | null): string | null {
  if (!usage || usage.budget.state !== 'paused') return null;
  if (usage.budget.reason === 'unreadable') return 'Paused: its usage could not be read';
  if (usage.budget.limitUsd === null) return null;
  if (usage.budget.reason === 'unpriced') return `Paused: a request on ${usage.budget.unpricedModel || 'a model'} has no price`;
  return `Paused at budget: ${formatUsageCost(usage.budget.spentUsd)} of ${formatUsageCost(usage.budget.limitUsd)}`;
}

/** The budget in a few words, for the picker's cost block. */
export function budgetSummary(usage: SessionUsage): string {
  const b = usage.budget;
  const label = budgetPauseLabel(usage);
  if (label) return label;
  if (b.limitUsd === null) return 'No budget';
  if (b.checkError) return `${formatUsageCost(b.limitUsd)} · usage could not be read`;
  if (b.state === 'checking' || b.spentUsd === null) return `${formatUsageCost(b.limitUsd)} · checking`;
  return `${formatUsageCost(b.spentUsd)} of ${formatUsageCost(b.limitUsd)}`;
}

/** How soon an over-limit session stops, in words. */
export function checkCadence(usage: SessionUsage): string {
  const every = usage.checkEverySec;
  if (usage.engine === 'claude') return `Checked after each response and every ${every} s, subagents included.`;
  const tail = every >= 30 ? ', so a long turn can pass the limit before it stops' : '';
  return `Checked at the end of each turn and every ${every} s${tail}.`;
}

export type ParsedBudgetLimit = { valid: true; limitUsd: number | null } | { valid: false; error: string };
export function parseBudgetLimit(text: string): ParsedBudgetLimit {
  const value = text.trim();
  if (!value) return { valid: true, limitUsd: null };
  if (!/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(value) || !Number.isFinite(Number(value)) || Number(value) < 0.01 || Number(value) > 1_000_000) {
    return { valid: false, error: 'Enter a USD amount from $0.01 to $1,000,000, or leave blank for no limit.' };
  }
  return { valid: true, limitUsd: Number(value) };
}

export interface BudgetDraft { text: string; revision: number; dirty: boolean }
export function draftFromUsage(usage: SessionUsage): BudgetDraft {
  return { text: usage.budget.limitUsd === null ? '' : String(usage.budget.limitUsd), revision: usage.budget.revision, dirty: false };
}
/** A poll cannot adopt another writer's revision on behalf of an unsaved edit. */
export function reconcileBudgetDraft(draft: BudgetDraft | null, usage: SessionUsage, conflictRefresh = false): BudgetDraft {
  if (!draft?.dirty) return draftFromUsage(usage);
  return conflictRefresh ? { ...draft, revision: usage.budget.revision } : draft;
}
