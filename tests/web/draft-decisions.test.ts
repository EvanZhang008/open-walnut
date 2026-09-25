/**
 * The draft column's decision chips as data (draft-decisions.ts): every row of
 * the copy table (spec 5.2), the tooltip template (5.3), the 7-days-ahead date
 * exception (C64), the legend rule (C34) and the "Use Walnut's pick" inputs.
 *
 * The clock is frozen on Thursday 2026-09-24 10:00 local time, because the
 * shared formatDateTimeDisplay reads the clock itself.
 */

import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';

vi.mock('@/api/sessions', () => ({ peekWorkingDirs: () => null }));

const dec = await import('@/components/sessions/draft-decisions');
const { formatDateTimeDisplay } = await import('@/components/common/DatePicker');
const { DEFAULT_META } = await import('@/components/sessions/task-meta-constants');
type DraftColumn = import('@/components/sessions/draft-column').DraftColumn;
type DraftAiField = import('@/components/sessions/draft-column').DraftAiField;
type Meta = DraftColumn['meta'];

const NOW = new Date(2026, 8, 24, 10, 0, 0);

beforeAll(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(NOW); });
afterAll(() => { vi.useRealTimers(); });

function draft(
  meta: Partial<Meta>,
  opts: { ai?: DraftAiField[]; owner?: DraftColumn['fieldOwner']; suggested?: DraftColumn['aiSuggested'] } = {},
): DraftColumn {
  return {
    id: 'draft:test-1', cwd: '', host: null,
    meta: { ...DEFAULT_META, ...meta },
    ...(opts.ai ? { aiFields: new Set(opts.ai) } : {}),
    ...(opts.owner ? { fieldOwner: opts.owner } : {}),
    ...(opts.suggested ? { aiSuggested: opts.suggested } : {}),
  };
}

const CUSTOM = dec.customTierLabelLookup([{ id: 'ct_deep', label: 'Deep work' }]);
function ctx(over: Partial<import('@/components/sessions/draft-decisions').DraftDecisionCtx> = {}) {
  return { tierLabel: CUSTOM, customTiersLoaded: true, priorityVisible: true as boolean | 'unknown', now: NOW, ...over };
}
const chip = (d: DraftColumn, field: string, c = ctx()) => dec.draftDecisionChips(d, c).find((x) => x.field === field);

describe('tier chip', () => {
  it('an AI tier shows its TIER_OPTIONS label, icon id, tier color and the AI tooltip', () => {
    const c = chip(draft({ pinTier: 'satellite' }, { ai: ['pinTier'] }), 'pinTier')!;
    expect(c.label).toBe('Satellite');
    expect(c.ai).toBe(true);
    expect(c.source).toBe('ai');
    expect(c.glyph).toEqual({ kind: 'tier', tier: 'satellite', color: 'var(--tier-satellite, #5856d6)' });
    expect(c.title).toBe('Pinned tier: Satellite. Set by Walnut from your text. Click to change.');
    expect(c.ariaLabel).toBe(c.title);
  });

  it('each built-in tier reads its own label', () => {
    for (const [tier, label] of [['focus', 'Focus'], ['satellite', 'Satellite'], ['backlog', 'Backlog'], ['wait', 'Wait']]) {
      expect(chip(draft({ pinTier: tier }, { ai: ['pinTier'] }), 'pinTier')!.label).toBe(label);
    }
  });

  it('a seed tier has no sparkle and names the section its + came from', () => {
    const c = chip(draft({ pinTier: 'backlog' }, { owner: { pinTier: 'seed' } }), 'pinTier')!;
    expect(c.ai).toBe(false);
    expect(c.source).toBe('seed');
    expect(c.title).toBe('Pinned tier: Backlog. From the + on the Backlog section. Click to change.');
  });

  it('a user tier says "Set by you."', () => {
    const c = chip(draft({ pinTier: 'focus' }, { owner: { pinTier: 'user' } }), 'pinTier')!;
    expect(c.label).toBe('Focus');
    expect(c.title).toBe('Pinned tier: Focus. Set by you. Click to change.');
  });

  it('nobody owns the tier: no chip, even though the launch meta holds Focus', () => {
    expect(chip(draft({ pinTier: 'focus' }), 'pinTier')).toBeUndefined();
    // An owner of ANOTHER field does not make the tier a decision.
    expect(chip(draft({ pinTier: 'focus' }, { owner: { dueDate: 'user' } }), 'pinTier')).toBeUndefined();
  });

  it('a user-owned undefined tier is "Not pinned" with the muted unpinned glyph', () => {
    const c = chip(draft({ pinTier: undefined }, { owner: { pinTier: 'user' } }), 'pinTier')!;
    expect(c.label).toBe('Not pinned');
    expect(c.glyph).toEqual({ kind: 'tier', tier: null, color: 'var(--fg-muted)' });
    expect(c.title).toBe('Pinned tier: Not pinned. Set by you. Click to change.');
  });
});

describe('custom tier chip', () => {
  it('a resolved custom tier shows its label, the custom color and the 18ch cap flag', () => {
    const c = chip(draft({ pinTier: 'ct_deep' }, { ai: ['pinTier'] }), 'pinTier')!;
    expect(c.label).toBe('Deep work');
    expect(c.customTier).toBe(true);
    expect(c.glyph).toEqual({ kind: 'tier', tier: 'ct_deep', color: 'var(--tier-custom)' });
    expect(c.title).toBe('Pinned tier: Deep work. Set by Walnut from your text. Click to change.');
  });

  it('a long custom label keeps its full name in the tooltip (C60)', () => {
    const long = 'Quarterly planning and roadmap review';
    const lookup = dec.customTierLabelLookup([{ id: 'ct_long', label: long }]);
    const c = chip(draft({ pinTier: 'ct_long' }, { owner: { pinTier: 'user' } }), 'pinTier', ctx({ tierLabel: lookup }))!;
    expect(c.label).toBe(long);
    expect(c.customTier).toBe(true);
    expect(c.title).toContain(long);
  });

  it('custom tiers not loaded yet: a neutral "Custom tier", never "Removed tier"', () => {
    const c = chip(draft({ pinTier: 'ct_gone' }, { owner: { pinTier: 'user' } }), 'pinTier', ctx({ customTiersLoaded: false }))!;
    expect(c.label).toBe('Custom tier');
    expect(c.removedTier).toBeUndefined();
    expect(c.glyph).toEqual({ kind: 'tier', tier: 'ct_gone', color: 'var(--fg-muted)' });
  });

  it('loaded but unresolved: "Removed tier" in the danger color, tooltip says it lands in Focus', () => {
    const c = chip(draft({ pinTier: 'ct_gone' }, { owner: { pinTier: 'user' } }), 'pinTier')!;
    expect(c.label).toBe('Removed tier');
    expect(c.removedTier).toBe(true);
    expect(c.glyph).toEqual({ kind: 'tier', tier: 'ct_gone', color: 'var(--danger, var(--error))' });
    expect(c.title).toBe('This tier no longer exists, so the task will land in Focus. Click to change.');
  });
});

describe('priority chip', () => {
  const rows = [['immediate', 'Immediate', '!!'], ['important', 'Important', '!'], ['backlog', 'Backlog', '~']] as const;
  it.each(rows)('%s reads "%s" with the %s icon in its badge color', (value, label, icon) => {
    const c = chip(draft({ priority: value }, { ai: ['priority'] }), 'priority')!;
    expect(c.label).toBe(label);
    expect(c.glyph).toEqual({ kind: 'priority', value, icon, color: `var(--priority-${value})` });
    expect(c.title).toBe(`Priority: ${label}. Set by Walnut from your text. Click to change.`);
    expect(dec.draftPriorityText(value)).toBe(`${icon} ${label}`);
  });

  it('hidden, unknown, none, or unowned: no chip', () => {
    const d = draft({ priority: 'immediate' }, { ai: ['priority'] });
    expect(chip(d, 'priority', ctx({ priorityVisible: false }))).toBeUndefined();
    expect(chip(d, 'priority', ctx({ priorityVisible: 'unknown' }))).toBeUndefined();
    expect(chip(draft({ priority: 'none' }, { owner: { priority: 'user' } }), 'priority')).toBeUndefined();
    expect(chip(draft({ priority: 'important' }), 'priority')).toBeUndefined();
  });

  it('a user priority says "Set by you."', () => {
    expect(chip(draft({ priority: 'important' }, { owner: { priority: 'user' } }), 'priority')!.title)
      .toBe('Priority: Important. Set by you. Click to change.');
  });
});

describe('start and due chips', () => {
  it('start: today, tomorrow, a weekday, M/D, with a time', () => {
    const label = (iso: string) => chip(draft({ startDate: iso }, { ai: ['startDate'] }), 'startDate')!.label;
    expect(label('2026-09-24')).toBe('Start Today');
    expect(label('2026-09-25')).toBe('Start Tomorrow');
    expect(label('2026-09-26')).toBe('Start Sat');
    expect(label('2026-10-03')).toBe('Start 10/3');
    expect(label('2026-09-26T15:00')).toBe('Start Sat 15:00');
  });

  it('a same-day range shows the end time only, a cross-day range the end day', () => {
    const c = chip(draft({ startDate: '2026-09-26T15:00', endDate: '2026-09-26T17:00' }, { ai: ['startDate'] }), 'startDate')!;
    expect(c.label).toBe('Start Sat 15:00 to 17:00');
    expect(c.title).toBe('Start: Sat 15:00, ends 17:00. Set by Walnut from your text. Click to change.');
    expect(chip(draft({ startDate: '2026-09-26', endDate: '2026-09-27' }, { ai: ['startDate'] }), 'startDate')!.label)
      .toBe('Start Sat to Sun');
    expect(chip(draft({ startDate: '2026-09-26T15:00', endDate: '2026-09-27T10:00' }, { owner: { startDate: 'user' } }), 'startDate')!.label)
      .toBe('Start Sat 15:00 to Sun 10:00');
  });

  it('due: today, tomorrow with a time, a weekday, M/D', () => {
    const label = (iso: string) => chip(draft({ dueDate: iso }, { ai: ['dueDate'] }), 'dueDate')!.label;
    expect(label('2026-09-24')).toBe('Due Today');
    expect(label('2026-09-25T17:00')).toBe('Due Tomorrow 17:00');
    expect(label('2026-09-26')).toBe('Due Sat');
    expect(label('2026-10-03')).toBe('Due 10/3');
  });

  it('a past due is flagged overdue; today (date only) and a later hour today are not', () => {
    const overdue = (iso: string) => chip(draft({ dueDate: iso }, { owner: { dueDate: 'user' } }), 'dueDate')!.overdue;
    expect(overdue('2026-09-22')).toBe(true);
    expect(overdue('2026-09-24T08:00')).toBe(true);
    expect(overdue('2026-09-24')).toBeUndefined();
    expect(overdue('2026-09-24T18:00')).toBeUndefined();
    expect(chip(draft({ dueDate: '2026-09-22' }, { owner: { dueDate: 'user' } }), 'dueDate')!.label).toBe('Due 9/22');
  });

  it('no date, no chip', () => {
    expect(chip(draft({}), 'startDate')).toBeUndefined();
    expect(chip(draft({}), 'dueDate')).toBeUndefined();
  });
});

describe('unread chip and order', () => {
  it('unread reads "Starts unread" with the dot and its own tooltip', () => {
    const c = chip(draft({ unread: true }, { owner: { unread: 'user' } }), 'unread')!;
    expect(c.label).toBe('Starts unread');
    expect(c.glyph).toEqual({ kind: 'unread' });
    expect(c.ai).toBe(false);
    expect(c.title).toBe('Start state: unread. Click to change.');
    expect(chip(draft({ unread: false }), 'unread')).toBeUndefined();
  });

  it('the chips come in the fixed order tier, priority, start, due, unread', () => {
    const d = draft(
      { pinTier: 'satellite', priority: 'immediate', startDate: '2026-09-25', dueDate: '2026-09-26', unread: true },
      { ai: ['pinTier', 'priority', 'startDate', 'dueDate'], owner: { unread: 'user' } },
    );
    expect(dec.draftDecisionChips(d, ctx()).map((c) => c.field))
      .toEqual(['pinTier', 'priority', 'startDate', 'dueDate', 'unread']);
    expect(dec.draftDecisionChips(draft({}), ctx())).toEqual([]);
  });
});

describe('formatDraftDate (C64)', () => {
  it('exactly 7 days ahead reads M/D, so a Thursday never says "Thu" for next Thursday', () => {
    expect(dec.formatDraftDate('2026-10-01', NOW)).toBe('10/1');
    expect(dec.formatDraftDate('2026-10-01T09:30', NOW)).toBe('10/1 9:30');
    expect(chip(draft({ dueDate: '2026-10-01' }, { ai: ['dueDate'] }), 'dueDate')!.label).toBe('Due 10/1');
  });

  it('the shared formatDateTimeDisplay is unchanged, and every other day matches it', () => {
    expect(formatDateTimeDisplay('2026-10-01')).toBe('Thu');
    for (const iso of ['2026-09-20', '2026-09-24', '2026-09-25', '2026-09-27T08:05', '2026-09-30', '2026-10-02', '2026-11-15']) {
      expect(dec.formatDraftDate(iso, NOW)).toBe(formatDateTimeDisplay(iso));
    }
  });
});

describe('legend and Walnut picks', () => {
  it('the legend shows only over text and only while something carries a sparkle (C34)', () => {
    const ai = draft({ pinTier: 'satellite' }, { ai: ['pinTier'] });
    const chips = dec.draftDecisionChips(ai, ctx());
    expect(dec.draftDecisionsKeyVisible(ai, 'fix the login test', chips)).toBe(true);
    expect(dec.draftDecisionsKeyVisible(ai, '   ', chips)).toBe(false);
    const user = draft({ pinTier: 'wait' }, { owner: { pinTier: 'user' } });
    expect(dec.draftDecisionsKeyVisible(user, 'text', dec.draftDecisionChips(user, ctx()))).toBe(false);
    // A bound or repair draft draws no chips, yet an AI folder or project still earns it.
    expect(dec.draftDecisionsKeyVisible(draft({}, { ai: ['project'] }), 'text', [])).toBe(true);
    expect(dec.draftDecisionsKeyVisible(draft({}, { ai: ['cwd'] }), 'text', [])).toBe(true);
  });

  it('"Use Walnut\'s pick" is offered for an owned field whose proposal differs (C61)', () => {
    const d = draft(
      { pinTier: 'focus', priority: 'important', dueDate: '2026-09-26' },
      {
        owner: { pinTier: 'user', priority: 'user', dueDate: 'user' },
        suggested: { pinTier: 'satellite', priority: 'important', dueDate: '2026-09-25' },
      },
    );
    expect(dec.draftWalnutPicks(d, { priorityVisible: true })).toEqual({ pinTier: 'satellite', dueDate: '2026-09-25' });
    // Not owned: the AI still holds it, nothing to hand back.
    expect(dec.draftWalnutPicks(draft({ pinTier: 'focus' }, { suggested: { pinTier: 'wait' } }), { priorityVisible: true })).toEqual({});
    // Priority hidden: never offered.
    const p = draft({ priority: 'none' }, { owner: { priority: 'user' }, suggested: { priority: 'immediate' } });
    expect(dec.draftWalnutPicks(p, { priorityVisible: true })).toEqual({ priority: 'immediate' });
    expect(dec.draftWalnutPicks(p, { priorityVisible: false })).toEqual({});
    expect(dec.draftWalnutPicks(p, { priorityVisible: 'unknown' })).toEqual({});
  });

  it('the pick label follows the chip rule for each field', () => {
    const c = { tierLabel: CUSTOM, now: NOW };
    expect(dec.draftSuggestionLabel('pinTier', 'satellite', c)).toBe('Satellite');
    expect(dec.draftSuggestionLabel('pinTier', 'ct_deep', c)).toBe('Deep work');
    expect(dec.draftSuggestionLabel('priority', 'immediate', c)).toBe('!! Immediate');
    expect(dec.draftSuggestionLabel('dueDate', '2026-09-26', c)).toBe('Sat');
  });
});

describe('folder picker footer badge (C65)', () => {
  it('counts a non-default field only when the user owns it, or edited it in this open', async () => {
    const { metaFooterEditCount, withFooterEdits } = await import('@/components/sessions/path-selector/MetaFooter');
    const aiDates = { ...DEFAULT_META, dueDate: '2026-09-26', startDate: '2026-09-25', priority: 'important' as const };
    // No ownership map (a plain session launcher): every non-default field counts.
    expect(metaFooterEditCount(aiDates, true)).toBe(3);
    // A draft whose dates and priority the AI wrote: nothing is the user's.
    expect(metaFooterEditCount(aiDates, true, {})).toBe(0);
    expect(metaFooterEditCount(aiDates, true, { dueDate: 'user' })).toBe(1);
    // Priority hidden: never counted, owned or not.
    expect(metaFooterEditCount(aiDates, false, { priority: 'user' })).toBe(0);
    // A toggle made in the footer during this open is the user's.
    const edited = { ...aiDates, unread: true };
    const owned = withFooterEdits({}, aiDates, edited);
    expect(owned).toEqual({ unread: 'user' });
    expect(metaFooterEditCount(edited, true, owned)).toBe(1);
    // A footer date edit counts; start and end share the startDate owner.
    const moved = { ...aiDates, startDate: '2026-09-28', endDate: '2026-09-29' };
    expect(withFooterEdits({ dueDate: 'user' }, aiDates, moved)).toEqual({ dueDate: 'user', startDate: 'user' });
    // Without a map or an open snapshot the map passes through unchanged.
    expect(withFooterEdits(undefined, aiDates, edited)).toBeUndefined();
    const seed = { pinTier: 'seed' as const };
    expect(withFooterEdits(seed, null, edited)).toBe(seed);
  });
});
