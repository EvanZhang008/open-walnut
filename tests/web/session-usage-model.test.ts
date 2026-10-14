import { describe, expect, it } from 'vitest';
import type { SessionUsage } from '../../web/src/api/session-usage';
import {
  breakdownCost, budgetPauseLabel, draftFromUsage, formatUsageCost, parseBudgetLimit,
  reconcileBudgetDraft, remainingAllowance, verifiedLifetimeCost,
} from '../../web/src/components/sessions/session-usage-model';

const usage = (patch: Partial<SessionUsage> = {}): SessionUsage => ({
  sessionId: 'session-a', title: 'Budget review', verifiedCostUsd: 4, verifiedCalls: 20, unverifiedCalls: 0,
  byModel: [], byAgent: [], checkedAt: null,
  budget: { limitUsd: 10, spentUsd: 4, state: 'active', revision: 2, reason: null, updatedAt: null }, ...patch,
});

describe('session usage display', () => {
  it('shows a total and remaining only when the entire lifetime is verified', () => {
    const complete = usage();
    expect(verifiedLifetimeCost(complete)).toBe(4);
    expect(remainingAllowance(complete)).toBe(6);
    const partial = usage({ verifiedCostUsd: 4, unverifiedCalls: 1 });
    expect(verifiedLifetimeCost(partial)).toBeNull();
    expect(remainingAllowance(partial)).toBeNull();
    expect(formatUsageCost(verifiedLifetimeCost(partial))).toBe('Unverified');
  });
  it('never turns missing, invalid or negative dollars into a zero total', () => {
    for (const cost of [null, Number.NaN, Number.POSITIVE_INFINITY, -1]) {
      expect(verifiedLifetimeCost(usage({ verifiedCostUsd: cost }))).toBeNull();
      expect(formatUsageCost(cost)).toBe('Unverified');
    }
    expect(formatUsageCost(0)).toBe('$0.00');
    expect(formatUsageCost(0.003)).toBe('<$0.01');
  });
  it('caps remaining at zero after an in-flight overshoot and hides it without a limit', () => {
    expect(remainingAllowance(usage({ verifiedCostUsd: 11 }))).toBe(0);
    expect(remainingAllowance(usage({ budget: { ...usage().budget, limitUsd: null } }))).toBeNull();
  });
  it('does not present incomplete agent or model subtotals as complete costs', () => {
    expect(breakdownCost({ costUsd: 3, calls: 9, unverifiedCalls: 1 })).toBeNull();
    expect(breakdownCost({ costUsd: 3, calls: 9, unverifiedCalls: 0 })).toBe(3);
  });
  it('only puts configured paused budgets by the composer, never ordinary unknown usage', () => {
    expect(budgetPauseLabel(null)).toBeNull();
    expect(budgetPauseLabel(usage({ unverifiedCalls: 3 }))).toBeNull();
    expect(budgetPauseLabel(usage({ budget: { ...usage().budget, limitUsd: null, state: 'unverified' } }))).toBeNull();
    expect(budgetPauseLabel(usage({ budget: { ...usage().budget, state: 'paused' } }))).toBe('Paused at budget');
    expect(budgetPauseLabel(usage({ budget: { ...usage().budget, state: 'unverified' } }))).toBe('Paused: cost unverified');
  });
});

describe('lifetime budget editor', () => {
  it('accepts decimal USD at least one cent and blank as unlimited', () => {
    for (const [text, limit] of [['', null], ['  ', null], ['10', 10], ['001.25', 1.25], ['.01', 0.01], ['10.', 10]] as const) {
      expect(parseBudgetLimit(text)).toEqual({ valid: true, limitUsd: limit });
    }
  });
  it('rejects sub-cent, zero, negative, scientific, nonfinite and malformed amounts', () => {
    for (const text of ['0', '0.009', '-2', '1e3', 'Infinity', 'NaN', '$4', '1,000', '1.2.3', '9'.repeat(400)]) {
      expect(parseBudgetLimit(text).valid, text).toBe(false);
    }
  });
  it('updates a clean draft on poll but preserves dirty text AND its original write revision', () => {
    const initial = usage();
    const newer = usage({ budget: { ...initial.budget, limitUsd: 20, revision: 3 } });
    expect(reconcileBudgetDraft(draftFromUsage(initial), newer)).toEqual({ text: '20', revision: 3, dirty: false });
    const dirty = { text: '17.35', revision: 2, dirty: true };
    expect(reconcileBudgetDraft(dirty, newer)).toBe(dirty);
    expect(reconcileBudgetDraft(dirty, newer, true)).toEqual({ text: '17.35', revision: 3, dirty: true });
  });
  it('refreshes a conflict without removing an intended remove-limit edit', () => {
    expect(reconcileBudgetDraft({ text: '', revision: 1, dirty: true }, usage(), true)).toEqual({ text: '', revision: 2, dirty: true });
  });
});
