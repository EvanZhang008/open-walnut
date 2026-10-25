import {
  budgetPauseLabel, budgetSummary, checkCadence, draftFromUsage, formatUsageCost, parseBudgetLimit,
  reconcileBudgetDraft, remainingAllowance,
} from '../../web/src/components/sessions/session-usage-model';

const usage = (patch: Partial<SessionUsage> = {}): SessionUsage => ({
  sessionId: 'session-a', title: 'Budget review', engine: 'claude', checkEverySec: 2, checkedAt: null,
  budget: { limitUsd: 10, spentUsd: 4, state: 'active', revision: 2, reason: null, updatedAt: null, responses: 20, unpricedResponses: 0, unpricedModel: null, pausedAt: null, pauseId: null, stopError: null, engine: 'claude' }, ...patch,
});
const withBudget = (patch: Partial<SessionUsage['budget']>) => usage({ budget: { ...usage().budget, ...patch } });

describe('session budget display', () => {
  it('shows remaining from the priced spend, capped at zero, and nothing before the first check', () => {
    expect(remainingAllowance(usage())).toBe(6);
    expect(remainingAllowance(withBudget({ spentUsd: 11 }))).toBe(0);
    expect(remainingAllowance(withBudget({ spentUsd: null }))).toBeNull();
    expect(remainingAllowance(withBudget({ limitUsd: null }))).toBeNull();
  });
  it('never turns missing, invalid or negative dollars into a zero', () => {
    for (const cost of [null, Number.NaN, Number.POSITIVE_INFINITY, -1]) expect(formatUsageCost(cost)).toBe('not checked yet');
    expect(formatUsageCost(0)).toBe('$0.00');
    expect(formatUsageCost(0.003)).toBe('<$0.01');
  });
  it('labels only a configured pause by the composer, naming why', () => {
    expect(budgetPauseLabel(null)).toBeNull();
    expect(budgetPauseLabel(usage())).toBeNull();
    expect(budgetPauseLabel(withBudget({ state: 'checking' }))).toBeNull();
    expect(budgetPauseLabel(withBudget({ state: 'paused', reason: 'limit', spentUsd: 10.4 }))).toBe('Paused at budget: $10.40 of $10.00');
    expect(budgetPauseLabel(withBudget({ state: 'paused', reason: 'unpriced', unpricedModel: 'new-model' }))).toBe('Paused: a request on new-model has no price');
  });
  it('sums the budget up in a few words for the picker', () => {
    expect(budgetSummary(withBudget({ limitUsd: null, state: 'unlimited' }))).toBe('No budget');
    expect(budgetSummary(usage())).toBe('$4.00 of $10.00');
    expect(budgetSummary(withBudget({ state: 'checking', spentUsd: null }))).toBe('$10.00 · checking');
  });
  it('says how often each engine is checked, and warns where a turn can pass the limit', () => {
    expect(checkCadence(usage())).toBe('Checked after each response and every 2 s, subagents included.');
    expect(checkCadence(usage({ engine: 'codex', checkEverySec: 5 }))).toBe('Checked at the end of each turn and every 5 s.');
    expect(checkCadence(usage({ engine: 'opencode', checkEverySec: 30 }))).toContain('a long turn can pass the limit');
  });
});

describe('lifetime budget editor', () => {
  it('accepts decimal USD at least one cent and blank as unlimited', () => {
    for (const [text, limit] of [['', null], ['  ', null], ['10', 10], ['001.25', 1.25], ['.01', 0.01], ['10.', 10]] as const) {
      expect(parseBudgetLimit(text)).toEqual({ valid: true, limitUsd: limit });
    }
  });
  it('rejects sub-cent, zero, negative, scientific, nonfinite and malformed amounts', () => {
    for (const text of ['0', '0.009', '-2', '1e3', 'Infinity', 'NaN', '$4', '1,000', '1.2.3', '9'.repeat(400), '1000001']) {
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
