/**
 * Per-field ownership of a draft's task fields (tier, priority, start/end, due):
 * the parse's revert rules in applyDraftParse and every other writer in
 * draft-ownership.ts (More, the picker footer, the tier "+" seed, the Ask Walnut
 * tab, re-derivation). The rule under test: every decision Walnut made is
 * visible, so an AI value always carries its ✦, a newer parse that drops it takes
 * it back, and a human edit owns that one field only.
 *
 * `peekWorkingDirs` is mocked because draft-column.ts reads the launch memory
 * cache; a cold cache (null) means "no memory", which keeps model/engine inert.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { WorkingDirsResult } from '@/api/sessions';
import type { SuggestField } from '@/api/tasks';

const { peek } = vi.hoisted(() => ({ peek: vi.fn<() => WorkingDirsResult | null>() }));
vi.mock('@/api/sessions', () => ({ peekWorkingDirs: peek }));

// useShowPriorityState runs without a DOM: React's two hooks are stood in (the
// same trick as use-show-priority.test.ts; web/src resolves web/node_modules/react).
const hookState = vi.hoisted(() => ({ setter: null as null | ((v: unknown) => void), fetch: vi.fn() }));
vi.mock('../../web/node_modules/react', () => ({
  useState: <T,>(initial: T) => {
    const set = vi.fn();
    hookState.setter = set;
    return [initial, set] as const;
  },
  useEffect: (fn: () => void | (() => void)) => { fn(); },
}));
vi.mock('@/api/config', () => ({ fetchConfig: hookState.fetch, updateConfig: vi.fn() }));
vi.mock('@/api/ws', () => ({ wsClient: { onEvent: () => () => {} } }));

const { applyDraftParse, suggestDiff, DRAFT_AI_FIELDS_ARE_SUGGEST_FIELDS } = await import('@/components/sessions/draft-column');
const own = await import('@/components/sessions/draft-ownership');
type DraftColumn = import('@/components/sessions/draft-column').DraftColumn;
type DraftAiField = import('@/components/sessions/draft-column').DraftAiField;

const OK = { classify: 'ok', dates: 'ok' } as const;
const noDefaults = () => undefined;

function draft(over: Partial<DraftColumn> = {}): DraftColumn {
  return {
    id: 'draft:1',
    cwd: '',
    host: null,
    meta: { unread: false, priority: 'none', pinTier: 'focus', model: undefined, engine: undefined },
    ...over,
  };
}

const aiOf = (d: DraftColumn) => [...(d.aiFields ?? [])].sort();

beforeEach(() => {
  peek.mockReset();
  peek.mockReturnValue(null);
});

describe('C45: the draft ledger fields are server ledger fields', () => {
  it('DraftAiField is a compile-time subset of SuggestField', () => {
    type Sub<A, B> = [A] extends [B] ? true : never;
    const ok: Sub<DraftAiField, SuggestField> = true;
    // @ts-expect-error a field name the server ledger does not accept must fail the typecheck
    const bad: Sub<DraftAiField | 'openedCwd', SuggestField> = true;
    expect([ok, bad, DRAFT_AI_FIELDS_ARE_SUGGEST_FIELDS]).toEqual([true, true, true]);
  });
});

describe('applyDraftParse: an AI field a newer parse drops goes back to its default', () => {
  it('C14: tier Wait, then a trailing parse (classify ok) without a tier: back to Focus, no ✦', () => {
    const first = applyDraftParse(draft(), { pinTier: 'wait', legs: OK }, noDefaults);
    expect(first.meta.pinTier).toBe('wait');
    const out = applyDraftParse(first, { legs: OK }, noDefaults);
    expect(out.meta.pinTier).toBe('focus');
    expect(out.aiFields?.has('pinTier')).toBe(false);
    expect(out.aiSuggested?.pinTier).toBeUndefined();
  });

  it('C13: a due, then a trailing parse (both legs ok) without one: the due is gone', () => {
    const first = applyDraftParse(draft(), { due_date: '2026-08-14', legs: OK }, noDefaults);
    const out = applyDraftParse(first, { legs: OK }, noDefaults);
    expect(out.meta.dueDate).toBeUndefined();
    expect(aiOf(out)).toEqual([]);
  });

  it('priority goes back to none; a start takes its end with it', () => {
    const first = applyDraftParse(draft(), {
      priority: 'immediate', start_date: '2026-08-14T15:00', end_date: '2026-08-14T17:00', legs: OK,
    }, noDefaults);
    expect(aiOf(first)).toEqual(['priority', 'startDate']);
    const out = applyDraftParse(first, { legs: OK }, noDefaults);
    expect(out.meta.priority).toBe('none');
    expect(out.meta.startDate).toBeUndefined();
    expect(out.meta.endDate).toBeUndefined();
    expect(aiOf(out)).toEqual([]);
  });

  it('a start that stays but loses its end drops the end; one that keeps it keeps it', () => {
    const first = applyDraftParse(draft(), {
      start_date: '2026-08-14T15:00', end_date: '2026-08-14T17:00', legs: OK,
    }, noDefaults);
    const kept = applyDraftParse(first, { start_date: '2026-08-14T15:00', end_date: '2026-08-14T17:00', legs: OK }, noDefaults);
    expect(kept).toBe(first);
    const out = applyDraftParse(first, { start_date: '2026-08-14T15:00', legs: OK }, noDefaults);
    expect(out.meta.startDate).toBe('2026-08-14T15:00');
    expect(out.meta.endDate).toBeUndefined();
  });

  it('never writes metaTouched, userTouched, fieldOwner or cwdPinned, even on a revert', () => {
    const first = applyDraftParse(draft(), { pinTier: 'wait', priority: 'important', legs: OK }, noDefaults);
    const out = applyDraftParse(first, { legs: OK }, noDefaults);
    for (const d of [first, out]) {
      expect(d.metaTouched).toBeUndefined();
      expect(d.userTouched).toBeUndefined();
      expect(d.fieldOwner).toBeUndefined();
      expect(d.cwdPinned).toBeUndefined();
    }
  });
});

describe('applyDraftParse: only an answering leg may take a decision back (C50)', () => {
  const dated = () => applyDraftParse(draft(), {
    pinTier: 'satellite', priority: 'important', due_date: '2026-08-14', legs: OK,
  }, noDefaults);

  it('dates leg failed and no dates: the AI due and its ✦ stay', () => {
    const out = applyDraftParse(dated(), { pinTier: 'satellite', priority: 'important', legs: { classify: 'ok', dates: 'failed' } }, noDefaults);
    expect(out.meta.dueDate).toBe('2026-08-14');
    expect(out.aiFields?.has('dueDate')).toBe(true);
    expect(out.aiSuggested?.dueDate).toBe('2026-08-14');
  });

  it('classify leg failed: the AI tier and priority stay', () => {
    const out = applyDraftParse(dated(), { due_date: '2026-08-14', legs: { classify: 'failed', dates: 'ok' } }, noDefaults);
    expect(out.meta.pinTier).toBe('satellite');
    expect(out.meta.priority).toBe('important');
    expect(aiOf(out)).toEqual(['dueDate', 'pinTier', 'priority']);
  });

  it('no legs at all (an older server): nothing is ever reverted for being absent', () => {
    const out = applyDraftParse(dated(), {}, noDefaults);
    expect(out.meta).toEqual(dated().meta);
    expect(aiOf(out)).toEqual(['dueDate', 'pinTier', 'priority']);
  });

  it('classifier not configured: tier and priority answer to the LLM leg', () => {
    const skipped = { classify: 'skipped', dates: 'failed' } as const;
    expect(applyDraftParse(dated(), { legs: skipped }, noDefaults).meta.pinTier).toBe('satellite');
    const out = applyDraftParse(dated(), { legs: { classify: 'skipped', dates: 'ok' } }, noDefaults);
    expect(out.meta.pinTier).toBe('focus');
    expect(out.meta.priority).toBe('none');
  });
});

describe('applyDraftParse: typing parses only add, the settled text may remove (C51)', () => {
  it('eager {pinTier: satellite}, then eager {}: still Satellite with ✦; trailing {} (ok) reverts', () => {
    const eager = applyDraftParse(draft(), { pinTier: 'satellite', legs: OK }, noDefaults, { kind: 'eager' });
    const still = applyDraftParse(eager, { legs: OK }, noDefaults, { kind: 'eager' });
    expect(still.meta.pinTier).toBe('satellite');
    expect(still.aiFields?.has('pinTier')).toBe(true);
    const settled = applyDraftParse(still, { legs: OK }, noDefaults, { kind: 'trailing' });
    expect(settled.meta.pinTier).toBe('focus');
    expect(settled.aiFields?.has('pinTier')).toBe(false);
  });

  it('an eager parse may still CHANGE an AI value', () => {
    const eager = applyDraftParse(draft(), { pinTier: 'satellite' }, noDefaults, { kind: 'eager' });
    expect(applyDraftParse(eager, { pinTier: 'wait' }, noDefaults, { kind: 'eager' }).meta.pinTier).toBe('wait');
  });
});

describe('applyDraftParse: owners, visibility and unknown tiers', () => {
  it('a user or seed owner is never written, yet the proposal is recorded', () => {
    for (const owner of ['user', 'seed'] as const) {
      const d = draft({ fieldOwner: { pinTier: owner }, meta: { ...draft().meta, pinTier: 'backlog' } });
      const out = applyDraftParse(d, { pinTier: 'wait', legs: OK }, noDefaults);
      expect(out.meta.pinTier).toBe('backlog');
      expect(out.aiFields?.has('pinTier')).toBe(false);
      expect(out.aiSuggested?.pinTier).toBe('wait');
      // Nor reverted by a parse that stops proposing.
      expect(applyDraftParse(out, { legs: OK }, noDefaults).meta.pinTier).toBe('backlog');
    }
  });

  it('priority hidden (false): not written, not recorded, an AI one reverts on a settled parse', () => {
    const d = applyDraftParse(draft(), { priority: 'immediate' }, noDefaults, { priorityVisible: false });
    expect(d.meta.priority).toBe('none');
    expect(d.aiSuggested?.priority).toBeUndefined();
    const ai = applyDraftParse(draft(), { priority: 'immediate', legs: OK }, noDefaults);
    const hidden = applyDraftParse(ai, { priority: 'immediate', legs: OK }, noDefaults, { priorityVisible: false });
    expect(hidden.meta.priority).toBe('none');
    expect(hidden.aiFields?.has('priority')).toBe(false);
    expect(hidden.aiSuggested?.priority).toBeUndefined();
  });

  it("priority 'unknown' (config not read yet): not written, recorded or reverted", () => {
    const d = applyDraftParse(draft(), { priority: 'immediate' }, noDefaults, { priorityVisible: 'unknown' });
    expect(d.meta.priority).toBe('none');
    expect(d.aiSuggested?.priority).toBeUndefined();
    expect(d.lastParse?.priority).toBe('immediate');
    const ai = applyDraftParse(draft(), { priority: 'immediate', legs: OK }, noDefaults);
    const out = applyDraftParse(ai, { legs: OK }, noDefaults, { priorityVisible: 'unknown' });
    expect(out.meta.priority).toBe('immediate');
    expect(out.aiFields?.has('priority')).toBe(true);
    expect(out.aiSuggested?.priority).toBe('immediate');
  });

  it('an unknown ct_* tier is ignored by default (only the built-ins are known)', () => {
    const d = draft();
    const out = applyDraftParse(d, { pinTier: 'ct_abc12345' }, noDefaults);
    expect(out.meta.pinTier).toBe('focus');
    expect(out.aiFields?.has('pinTier')).toBeFalsy();
    expect(out.aiSuggested?.pinTier).toBeUndefined();
  });

  it("custom tiers not loaded ('unknown'): kept in lastParse, applied once they load", () => {
    const loading = own.makeTierKnown([], false);
    const d = applyDraftParse(draft(), { pinTier: 'ct_abc12345', legs: OK }, noDefaults, { tierKnown: loading });
    expect(d.meta.pinTier).toBe('focus');
    expect(d.aiSuggested?.pinTier).toBeUndefined();
    expect(d.lastParse?.pinTier).toBe('ct_abc12345');
    const loaded = own.makeTierKnown([{ id: 'ct_abc12345' }], true);
    const out = own.rederiveDraftParse(d, noDefaults, { tierKnown: loaded });
    expect(out.meta.pinTier).toBe('ct_abc12345');
    expect(out.aiFields?.has('pinTier')).toBe(true);
  });
});

describe('applyDraftParse: drafts whose task fields the AI never decides (C23)', () => {
  const parse = { pinTier: 'wait', priority: 'immediate' as const, due_date: '2026-08-14', legs: OK };
  const kinds: [string, Partial<DraftColumn>][] = [
    ['bound', { taskId: 'task-1' }],
    ['fork', { forkOf: { sessionId: 'sess-1' } }],
    ['fix-walnut', { intent: 'fix-walnut' }],
    ['walnut', { walnut: true }],
  ];
  for (const [name, over] of kinds) {
    it(`${name}: meta untouched, no task-field ✦, nothing recorded`, () => {
      const d = draft(over);
      const out = applyDraftParse(d, parse, noDefaults);
      expect(out.meta).toBe(d.meta);
      expect(aiOf(out)).toEqual([]);
      expect(out.aiSuggested ?? {}).toEqual({});
    });
  }
});

describe("applyDraftParse kind 'clear': the text is gone, so are its decisions", () => {
  const home = (name: string) => (name === 'Marina' ? { cwd: '/work/marina', host: 'devbox' } : undefined);

  it('reverts AI task fields ignoring legs, AI project to Inbox, AI folder to the opened one', () => {
    let d = draft({ openedCwd: '/start', openedHost: null, cwd: '/start', metaTouched: false });
    d = { ...d, meta: { ...d.meta, model: 'opus', engine: undefined } };
    d = applyDraftParse(d, { project: 'Marina', pinTier: 'wait', due_date: '2026-08-14', legs: OK }, home);
    expect(d.cwd).toBe('/work/marina');
    const out = applyDraftParse(d, {}, home, { kind: 'clear' });
    expect(out.project).toBeUndefined();
    expect(out.projectSource).toBeUndefined();
    expect(out.cwd).toBe('/start');
    expect(out.host).toBeNull();
    expect(out.meta.pinTier).toBe('focus');
    expect(out.meta.dueDate).toBeUndefined();
    expect(out.meta.model).toBe('opus');
    expect(out.metaTouched).toBe(false);
    expect(aiOf(out)).toEqual([]);
    expect(out.lastParse).toBeUndefined();
  });

  it('a folder-less open returns the AI folder to none; user picks survive', () => {
    const d = applyDraftParse(draft(), { project: 'Marina', legs: OK }, home);
    expect(applyDraftParse(d, {}, home, { kind: 'clear' }).cwd).toBe('');
    const picked = { ...d, project: 'Mine', projectSource: 'user' as const, cwdPinned: true };
    const out = applyDraftParse(picked, {}, home, { kind: 'clear' });
    expect(out.project).toBe('Mine');
    expect(out.cwd).toBe('/work/marina');
  });

  it('owned task fields survive a clear', () => {
    const d = own.applyDraftTaskFieldEdit(draft(), { pinTier: 'backlog' });
    const out = applyDraftParse(d, {}, noDefaults, { kind: 'clear' });
    expect(out).toBe(d);
  });
});

describe('More: an edit owns that field only', () => {
  it('owns the edited field, drops its ✦, leaves metaTouched alone; the AI still writes the rest', () => {
    const ai = applyDraftParse(draft(), { pinTier: 'satellite', due_date: '2026-08-14', legs: OK }, noDefaults);
    const edited = own.applyDraftTaskFieldEdit(ai, { pinTier: 'wait' });
    expect(edited.meta.pinTier).toBe('wait');
    expect(edited.fieldOwner).toEqual({ pinTier: 'user' });
    expect(aiOf(edited)).toEqual(['dueDate']);
    expect(edited.userTouched).toBe(true);
    expect(edited.metaTouched).toBeUndefined();
    const next = applyDraftParse(edited, { pinTier: 'backlog', due_date: '2026-08-15', legs: OK }, noDefaults);
    expect(next.meta.pinTier).toBe('wait');
    expect(next.meta.dueDate).toBe('2026-08-15');
    expect(next.aiSuggested?.pinTier).toBe('backlog');
  });

  it('clearing is an edit too (owned, empty, no chip value); a start edit drops the end', () => {
    const ai = applyDraftParse(draft(), { start_date: '2026-08-14T15:00', end_date: '2026-08-14T17:00', legs: OK }, noDefaults);
    const cleared = own.applyDraftTaskFieldEdit(ai, { startDate: undefined, priority: undefined, pinTier: undefined });
    expect(cleared.meta.startDate).toBeUndefined();
    expect(cleared.meta.endDate).toBeUndefined();
    expect(cleared.meta.priority).toBe('none');
    expect(cleared.meta.pinTier).toBeUndefined();
    expect(cleared.fieldOwner).toEqual({ startDate: 'user', priority: 'user', pinTier: 'user' });
    const again = applyDraftParse(cleared, { start_date: '2026-08-16T09:00', priority: 'immediate', legs: OK }, noDefaults);
    expect(again.meta.startDate).toBeUndefined();
    expect(again.meta.priority).toBe('none');
  });

  it('an empty patch, and a repeat of the same edit, return the same object', () => {
    const d = draft();
    expect(own.applyDraftTaskFieldEdit(d, {})).toBe(d);
    const once = own.applyDraftTaskFieldEdit(d, { unread: true });
    expect(once.meta.unread).toBe(true);
    expect(own.applyDraftTaskFieldEdit(once, { unread: true })).toBe(once);
  });
});

describe("returnFieldToWalnut: \"Use Walnut's pick\"", () => {
  it('brings the suggestion back with its ✦ and drops the owner', () => {
    const ai = applyDraftParse(draft(), { pinTier: 'satellite', legs: OK }, noDefaults);
    const mine = own.applyDraftTaskFieldEdit(ai, { pinTier: 'wait' });
    const back = own.returnFieldToWalnut(mine, 'pinTier');
    expect(back.meta.pinTier).toBe('satellite');
    expect(back.fieldOwner).toBeUndefined();
    expect(back.aiFields?.has('pinTier')).toBe(true);
    expect(own.isAiOwned(back, 'pinTier')).toBe(true);
  });

  it('the start brings back the end of the same parse', () => {
    const ai = applyDraftParse(draft(), { start_date: '2026-08-14T15:00', end_date: '2026-08-14T17:00' }, noDefaults);
    const mine = own.applyDraftTaskFieldEdit(ai, { startDate: '2026-08-20T09:00' });
    const back = own.returnFieldToWalnut(mine, 'startDate');
    expect(back.meta.startDate).toBe('2026-08-14T15:00');
    expect(back.meta.endDate).toBe('2026-08-14T17:00');
  });

  it('is a no-op without a suggestion', () => {
    const d = own.applyDraftTaskFieldEdit(draft(), { priority: 'important' });
    expect(own.returnFieldToWalnut(d, 'priority')).toBe(d);
  });
});

describe('applyDraftPathPick: the picker footer rebases per field', () => {
  const path = { cwd: '/work/acme', host: null };
  const none = () => '';

  it('a field changed in the footer becomes the user\'s; an unchanged one keeps the CURRENT row value', () => {
    const opened = draft().meta;
    // A parse landed while the picker was open: the row now has an AI due.
    const row = applyDraftParse(draft(), { due_date: '2026-08-14', legs: OK }, noDefaults);
    const returned = { ...opened, pinTier: 'backlog' };
    const out = own.applyDraftPathPick(row, path, returned, opened, none);
    expect(out.meta.pinTier).toBe('backlog');
    expect(out.fieldOwner).toEqual({ pinTier: 'user' });
    expect(out.meta.dueDate).toBe('2026-08-14');
    expect(out.aiFields?.has('dueDate')).toBe(true);
    expect(out.cwd).toBe('/work/acme');
    expect(out.cwdPinned).toBe(true);
    expect(out.createCwd).toBe(false);
  });

  it('a changed End takes over start and end together', () => {
    const row = applyDraftParse(draft(), { start_date: '2026-08-14T15:00', end_date: '2026-08-14T17:00' }, noDefaults);
    const opened = row.meta;
    const out = own.applyDraftPathPick(row, path, { ...opened, endDate: '2026-08-14T18:00' }, opened, none);
    expect(out.meta.startDate).toBe('2026-08-14T15:00');
    expect(out.meta.endDate).toBe('2026-08-14T18:00');
    expect(out.fieldOwner).toEqual({ startDate: 'user' });
    expect(out.aiFields?.has('startDate')).toBe(false);
    const later = applyDraftParse(out, { start_date: '2026-08-15T09:00', end_date: '2026-08-15T10:00', legs: OK }, noDefaults);
    expect(later.meta.startDate).toBe('2026-08-14T15:00');
    expect(later.meta.endDate).toBe('2026-08-14T18:00');
  });

  it('C57: a quick folder chip (no openedMeta) takes only model/engine; the AI tier and ✦ survive', () => {
    const stale = draft().meta;   // render-time snapshot, from before the parse landed
    const row = applyDraftParse(draft(), { pinTier: 'satellite', due_date: '2026-08-14', legs: OK }, noDefaults);
    const out = own.applyDraftPathPick(row, path, { ...stale, model: 'sonnet' }, undefined, none);
    expect(out.meta.pinTier).toBe('satellite');
    expect(out.meta.model).toBe('sonnet');
    expect(aiOf(out)).toEqual(['dueDate', 'pinTier']);
    expect(out.fieldOwner).toBeUndefined();
    const next = applyDraftParse(out, { pinTier: 'satellite', due_date: '2026-08-21', legs: OK }, noDefaults);
    expect(next.meta.dueDate).toBe('2026-08-21');
  });

  it('the folder derives the project and drops the AI folder/project ✦', () => {
    const row = applyDraftParse(draft(), { project: 'Marina' }, () => ({ cwd: '/work/marina', host: null }));
    const out = own.applyDraftPathPick(row, path, row.meta, undefined, none);
    expect(out.project).toBe('acme');
    expect(out.projectSource).toBe('folder');
    expect(aiOf(out)).toEqual([]);
  });
});

describe('applyTierSeed: a tier "+" owns the tier', () => {
  it('writes the tier as a seed (no ✦) and a later parse does not move it', () => {
    const ai = applyDraftParse(draft(), { pinTier: 'satellite' }, noDefaults);
    const seeded = own.applyTierSeed(ai, 'backlog');
    expect(seeded.meta.pinTier).toBe('backlog');
    expect(seeded.fieldOwner).toEqual({ pinTier: 'seed' });
    expect(seeded.aiFields?.has('pinTier')).toBe(false);
    expect(seeded.metaTouched).toBeUndefined();
    expect(applyDraftParse(seeded, { pinTier: 'wait', legs: OK }, noDefaults).meta.pinTier).toBe('backlog');
    expect(own.applyTierSeed(seeded, 'backlog')).toBe(seeded);
  });

  it('never overrides a tier the user picked', () => {
    const mine = own.applyDraftTaskFieldEdit(draft(), { pinTier: 'wait' });
    expect(own.applyTierSeed(mine, 'backlog')).toBe(mine);
  });
});

describe('Ask Walnut tab: no AI task value rides an Ask unseen (C58)', () => {
  it('AI Satellite, enter, leave, then parse {}: Focus with no tier ✦', () => {
    const ai = applyDraftParse(draft(), { pinTier: 'satellite', legs: OK }, noDefaults);
    const inside = own.enterWalnutDraft(ai);
    expect(inside.walnut).toBe(true);
    expect(inside.meta.pinTier).toBe('focus');
    expect(inside.aiFields?.has('pinTier')).toBe(false);
    expect(inside.walnutPrev && 'pinTier' in inside.walnutPrev).toBe(false);
    const back = own.leaveWalnutDraft(inside);
    expect(back.walnut).toBe(false);
    expect(back.meta.pinTier).toBe('focus');
    const out = applyDraftParse(back, { legs: OK }, noDefaults);
    expect(out.meta.pinTier).toBe('focus');
    expect(own.isAiOwned(out, 'pinTier')).toBe(false);
  });

  it('a Backlog "+" seed stays inside walnut mode, owner still seed, and after leaving', () => {
    const seeded = own.applyTierSeed(draft(), 'backlog');
    const inside = own.enterWalnutDraft(seeded);
    expect(inside.meta.pinTier).toBe('backlog');
    expect(inside.fieldOwner?.pinTier).toBe('seed');
    const back = own.leaveWalnutDraft(inside);
    expect(back.meta.pinTier).toBe('backlog');
    expect(back.fieldOwner?.pinTier).toBe('seed');
  });

  it('AI priority and dates revert on entry; user values stay; the project and model are stashed', () => {
    let d = draft({ project: 'Mine', projectSource: 'user' });
    d = { ...d, meta: { ...d.meta, model: 'opus' } };
    d = applyDraftParse(d, { priority: 'important', start_date: '2026-08-14T15:00', end_date: '2026-08-14T17:00', legs: OK }, noDefaults);
    d = own.applyDraftTaskFieldEdit(d, { dueDate: '2026-08-20', unread: true });
    const inside = own.enterWalnutDraft(d);
    expect(inside.meta.priority).toBe('none');
    expect(inside.meta.startDate).toBeUndefined();
    expect(inside.meta.endDate).toBeUndefined();
    expect(inside.meta.dueDate).toBe('2026-08-20');
    expect(inside.meta.unread).toBe(true);
    expect(inside.meta.model).toBeUndefined();
    expect(inside.project).toBe('Ask Walnut');
    expect(own.enterWalnutDraft(inside)).toBe(inside);
    const back = own.leaveWalnutDraft(inside);
    expect(back.project).toBe('Mine');
    expect(back.projectSource).toBe('user');
    expect(back.meta.model).toBe('opus');
    expect(back.fieldOwner).toEqual({ dueDate: 'user', unread: 'user' });
  });

  it('a tier picked by hand inside walnut mode is kept on leave', () => {
    const seeded = own.applyTierSeed(draft(), 'backlog');
    const inside = own.applyDraftTaskFieldEdit(own.enterWalnutDraft(seeded), { pinTier: 'focus' });
    const back = own.leaveWalnutDraft(inside);
    expect(back.meta.pinTier).toBe('focus');
    expect(back.fieldOwner?.pinTier).toBe('user');
  });
});

describe('rederiveDraftParse: settings that become known only ADD chips (C59)', () => {
  it('priority read as unknown, then shown: the chip appears without a keystroke', () => {
    const d = applyDraftParse(draft(), { priority: 'immediate', legs: OK }, noDefaults, { priorityVisible: 'unknown' });
    expect(d.meta.priority).toBe('none');
    const out = own.rederiveDraftParse(d, noDefaults, { priorityVisible: true });
    expect(out.meta.priority).toBe('immediate');
    expect(out.aiFields?.has('priority')).toBe(true);
    expect(own.rederiveDraftParse(out, noDefaults, { priorityVisible: true })).toBe(out);
  });

  it('re-derivation never removes: an AI tier the stored parse lacks stays', () => {
    let d = applyDraftParse(draft(), { pinTier: 'wait', legs: OK }, noDefaults, { kind: 'eager' });
    d = applyDraftParse(d, { priority: 'important', legs: OK }, noDefaults, { kind: 'eager' });
    const out = own.rederiveDraftParse(d, noDefaults);
    expect(out.meta.pinTier).toBe('wait');
    expect(own.rederiveDraftParse(draft(), noDefaults)).toEqual(draft());
  });

  it('priority turned off: revertAiTaskFields takes the AI one back, a user one stays', () => {
    const ai = applyDraftParse(draft(), { priority: 'immediate' }, noDefaults);
    const off = own.revertAiTaskFields(ai, ['priority']);
    expect(off.meta.priority).toBe('none');
    expect(off.aiFields?.has('priority')).toBe(false);
    const mine = own.applyDraftTaskFieldEdit(draft(), { priority: 'important' });
    expect(own.revertAiTaskFields(mine, ['priority'])).toBe(mine);
  });
});

describe('tier resolution for chips, the ledger and the launch', () => {
  it('makeTierKnown: built-ins always, ct_* unknown until loaded, then membership', () => {
    const loading = own.makeTierKnown([{ id: 'ct_aaaa0001' }], false);
    expect([loading('focus'), loading('ct_aaaa0001'), loading('bogus')]).toEqual([true, 'unknown', false]);
    const loaded = own.makeTierKnown([{ id: 'ct_aaaa0001' }], true);
    expect([loaded('wait'), loaded('ct_aaaa0001'), loaded('ct_gone0002')]).toEqual([true, true, false]);
  });

  it('launchMetaFor: a tier known to be gone launches as Focus; others as-is (same object)', () => {
    const known = own.makeTierKnown([], true);
    const gone = draft({ meta: { ...draft().meta, pinTier: 'ct_gone0002' } });
    expect(own.launchMetaFor(gone, known).pinTier).toBe('focus');
    const kept = draft({ meta: { ...draft().meta, pinTier: 'wait' } });
    expect(own.launchMetaFor(kept, known)).toBe(kept.meta);
    const loading = own.makeTierKnown([], false);
    expect(own.launchMetaFor(gone, loading)).toBe(gone.meta);
    expect(suggestDiff(gone, { tierKnown: known })).toEqual([]);
  });
});

describe("useShowPriorityState: 'unknown' until the config is read (C59)", () => {
  it("reads 'unknown' before the first config read, then publishes the real value", async () => {
    const mod = await import('@/hooks/useShowPriority');
    mod._resetShowPriorityForTests();
    let resolve: (c: unknown) => void = () => {};
    hookState.fetch.mockReturnValueOnce(new Promise((r) => { resolve = r; }));
    expect(mod.useShowPriorityState()).toBe('unknown');
    const set = hookState.setter;
    resolve({ ui: { show_priority: true } });
    await new Promise((r) => setTimeout(r, 0));
    expect(set).toHaveBeenCalledWith(true);
    // A later mount starts from the cached value, never 'unknown' again.
    expect(mod.useShowPriorityState()).toBe(true);
    // The boolean hook is unchanged: hidden until known.
    mod._resetShowPriorityForTests();
    hookState.fetch.mockReturnValueOnce(new Promise(() => {}));
    expect(mod.useShowPriority()).toBe(false);
  });
});
