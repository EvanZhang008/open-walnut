import type { SessionUsage, SessionUsageBreakdown } from '@/api/session-usage';

export function formatUsageCost(cost: number | null): string {
  if (cost === null || !Number.isFinite(cost) || cost < 0) return 'Unverified';
  if (cost > 0 && cost < 0.01) return '<$0.01';
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(cost);
}

export function verifiedLifetimeCost(usage: SessionUsage): number | null {
  return usage.unverifiedCalls === 0 && usage.verifiedCostUsd !== null && Number.isFinite(usage.verifiedCostUsd) && usage.verifiedCostUsd >= 0
    ? usage.verifiedCostUsd : null;
}

export function breakdownCost(row: SessionUsageBreakdown): number | null {
  return row.unverifiedCalls === 0 ? row.costUsd : null;
}

export function remainingAllowance(usage: SessionUsage): number | null {
  const cost = verifiedLifetimeCost(usage);
  return cost === null || usage.budget.limitUsd === null ? null : Math.max(0, usage.budget.limitUsd - cost);
}

export function budgetPauseLabel(usage: SessionUsage | null): string | null {
  if (!usage || usage.budget.limitUsd === null) return null;
  if (usage.budget.state === 'paused') return 'Paused at budget';
  if (usage.budget.state === 'unverified') return 'Paused: cost unverified';
  return null;
}

export type ParsedBudgetLimit = { valid: true; limitUsd: number | null } | { valid: false; error: string };
export function parseBudgetLimit(text: string): ParsedBudgetLimit {
  const value = text.trim();
  if (!value) return { valid: true, limitUsd: null };
  if (!/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(value) || !Number.isFinite(Number(value)) || Number(value) < 0.01) {
    return { valid: false, error: 'Enter a USD amount of at least $0.01, or leave blank for no limit.' };
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
