/**
 * Filter sentence + cross-dimension search index
 * (web/src/components/tasks/view-filter-model.ts).
 *
 * The sentence IS the "what is selected" answer in the redesigned View panel,
 * so its invariants matter beyond cosmetics:
 *   - every chip's `removed` state drops EXACTLY that one condition (a chip ×
 *     that also clears its siblings would silently widen/narrow the query);
 *   - an empty query still reads as a sentence ("Showing every task.") so the
 *     strip never renders as a dangling "Showing ";
 *   - sort never appears: it's presentation, not a filter, and a removable
 *     sort chip would leave the query with no comparator.
 */
import { describe, it, expect } from 'vitest';
import {
  DEFAULT_TASK_QUERY_FILTER_STATE,
  QUERY_STATUS_OPTIONS,
  QUERY_STATUS_ORDER,
  TAG_CHIP_CAP,
  buildFilterSentence,
  queryStatusSet,
  searchFilterOptions,
  tagChipOptions,
  withQueryStatus,
  type TaskQueryFilterState,
} from '../../web/src/components/tasks/view-filter-model';
import { STATUS_FILTER_ORDER, foldQueryStatus } from '../../web/src/components/tasks/filter-bar-model';
import { PHASE_LABELS } from '../../web/src/utils/session-status';

const base = DEFAULT_TASK_QUERY_FILTER_STATE;

function text(tokens: ReturnType<typeof buildFilterSentence>): string {
  return tokens.map((t) => (t.kind === 'word' ? t.text : `[${t.label}]`)).join('');
}

describe('buildFilterSentence', () => {
  it('renders the neutral line for an empty query', () => {
    expect(text(buildFilterSentence(base))).toBe('Showing every task.');
  });

  it('writes a full multi-dimension query as one sentence in reading order', () => {
    const state: TaskQueryFilterState = {
      ...base,
      completion: ['in_progress'],
      priorities: ['immediate'],
      projects: ['Walnut', 'iOS App'],
      timePreset: '24h',
    };
    expect(text(buildFilterSentence(state))).toBe(
      'Showing [In Progress] or [Need Action], priority [Immediate], in [Walnut] or [iOS App], updated in [24h].',
    );
  });

  it('labels the Inbox project ("" value) instead of an empty chip', () => {
    const tokens = buildFilterSentence({ ...base, projects: [''] });
    const chip = tokens.find((t) => t.kind === 'chip');
    expect(chip).toMatchObject({ label: 'Inbox', value: '' });
  });

  it('each chip removes only its own value', () => {
    const state: TaskQueryFilterState = { ...base, projects: ['Walnut', 'iOS App'], completion: ['todo'] };
    const chips = buildFilterSentence(state).filter((t) => t.kind === 'chip');
    const walnut = chips.find((c) => c.kind === 'chip' && c.label === 'Walnut')!;
    expect(walnut.kind === 'chip' && walnut.removed.projects).toEqual(['iOS App']);
    expect(walnut.kind === 'chip' && walnut.removed.completion).toEqual(['todo']);
  });

  it('tri-states read as words and remove back to "any"', () => {
    const tokens = buildFilterSentence({ ...base, pinned: true, blocked: false });
    const labels = tokens.filter((t) => t.kind === 'chip').map((t) => t.kind === 'chip' && t.label);
    expect(labels).toEqual(['pinned', 'not blocked']);
    const pinned = tokens.find((t) => t.kind === 'chip' && t.dim === 'pinned')!;
    expect(pinned.kind === 'chip' && pinned.removed.pinned).toBeUndefined();
  });

  it('time chip respects basis wording and preset units; custom windows work', () => {
    expect(text(buildFilterSentence({ ...base, timeBasis: 'created', timePreset: '7d' })))
      .toBe('Showing created in [7d].');
    expect(text(buildFilterSentence({
      ...base, timeBasis: 'created_or_updated', timePreset: 'custom', timeCustomValue: 3, timeCustomUnit: 'days',
    }))).toBe('Showing active in [3d].');
    // Half-typed custom value = no window yet, not an error.
    expect(text(buildFilterSentence({
      ...base, timePreset: 'custom', timeCustomValue: NaN,
    }))).toBe('Showing every task.');
  });

  it('never mentions sort', () => {
    // Empty query: a non-default sort alone still reads as the neutral line.
    expect(text(buildFilterSentence({ ...base, sort: 'priority' })))
      .toBe('Showing every task.');
    // Non-empty query: sort stays out of the sentence (distinguishes "sort
    // excluded" from "empty query short-circuits").
    expect(text(buildFilterSentence({ ...base, sort: 'priority', phases: ['TODO'] })))
      .toBe('Showing [To Do].');
  });
});

describe('searchFilterOptions', () => {
  const lists = {
    projectOptions: ['', 'Walnut', 'iOS App'],
    sourceOptions: ['local', 'ms-todo'],
    sprintOptions: ['Nov 10 \u2013 Nov 21'],
  };

  it('empty query returns nothing (detail pane shows the section instead)', () => {
    expect(searchFilterOptions(base, lists, '')).toEqual([]);
    expect(searchFilterOptions(base, lists, '   ')).toEqual([]);
  });

  it('matches option labels across dimensions, case-insensitive', () => {
    const groups = searchFilterOptions(base, lists, 'wal');
    expect(groups).toHaveLength(1);
    expect(groups[0].dimension).toBe('Project');
    expect(groups[0].options.map((o) => o.label)).toEqual(['Walnut']);
  });

  it('matches dimension names too ("pri" finds all priority levels)', () => {
    const groups = searchFilterOptions(base, lists, 'pri');
    const prio = groups.find((g) => g.dimension === 'Priority')!;
    expect(prio.options).toHaveLength(4);
  });

  it('toggled state flips membership without touching other dimensions', () => {
    const state: TaskQueryFilterState = { ...base, projects: ['Walnut'], completion: ['todo'] };
    const groups = searchFilterOptions(state, lists, 'walnut');
    const opt = groups[0].options[0];
    expect(opt.selected).toBe(true);
    expect(opt.toggled.projects).toEqual([]);
    expect(opt.toggled.completion).toEqual(['todo']);
  });

  it('inbox is findable by its label, not its empty value', () => {
    const groups = searchFilterOptions(base, lists, 'inbox');
    expect(groups[0].options[0]).toMatchObject({ label: 'Inbox', selected: false });
    expect(groups[0].options[0].toggled.projects).toEqual(['']);
  });

  it('time presets toggle off when already active', () => {
    const state: TaskQueryFilterState = { ...base, timePreset: '24h' };
    const groups = searchFilterOptions(state, lists, '24h');
    const opt = groups.find((g) => g.dimension === 'Time')!.options[0];
    expect(opt.selected).toBe(true);
    expect(opt.toggled.timePreset).toBeNull();
  });

  describe('tags', () => {
    const tagLists = { ...lists, tagOptions: ['severity:2', 'urgent', 'ticket:P123'] };

    it('finds a tag by its text, in the Tag group of the q-tags section', () => {
      const groups = searchFilterOptions(base, tagLists, 'sever');
      expect(groups).toHaveLength(1);
      expect(groups[0].dimension).toBe('Tag');
      expect(groups[0].options).toEqual([
        expect.objectContaining({ section: 'q-tags', label: 'severity:2', selected: false }),
      ]);
    });

    it('the dimension word "tag" lists every tag', () => {
      const tag = searchFilterOptions(base, tagLists, 'tag').find((g) => g.dimension === 'Tag')!;
      expect(tag.options.map((o) => o.label)).toEqual(['severity:2', 'urgent', 'ticket:P123']);
    });

    it('toggling adds the tag to tagsAny, and toggling again removes it', () => {
      const add = searchFilterOptions(base, tagLists, 'urgent')[0].options[0];
      expect(add.toggled.tagsAny).toEqual(['urgent']);
      const remove = searchFilterOptions(add.toggled, tagLists, 'urgent')[0].options[0];
      expect(remove.selected).toBe(true);
      expect(remove.toggled.tagsAny).toEqual([]);
      // Only the tag dimension moves.
      expect(remove.toggled).toEqual(base);
    });

    it('offers a selected tag that no loaded task carries, once', () => {
      const state: TaskQueryFilterState = { ...base, tagsAny: ['gone:7', 'urgent'] };
      const tag = searchFilterOptions(state, tagLists, 'tag').find((g) => g.dimension === 'Tag')!;
      expect(tag.options.map((o) => o.label)).toEqual(['gone:7', 'urgent', 'severity:2', 'ticket:P123']);
      const gone = searchFilterOptions(state, tagLists, 'gone')[0].options[0];
      expect(gone).toMatchObject({ label: 'gone:7', selected: true });
      expect(gone.toggled.tagsAny).toEqual(['urgent']);
    });

    it('a surface without tagOptions still compiles and offers only selected tags', () => {
      expect(searchFilterOptions(base, lists, 'tag').find((g) => g.dimension === 'Tag')).toBeUndefined();
      const state: TaskQueryFilterState = { ...base, tagsAny: ['urgent'] };
      const tag = searchFilterOptions(state, lists, 'urgent')[0];
      expect(tag.options.map((o) => o.label)).toEqual(['urgent']);
    });
  });
});

describe('tagChipOptions', () => {
  const many = Array.from({ length: TAG_CHIP_CAP + 5 }, (_, i) => `t${i}`);

  it('puts selected tags first, drops duplicates, and keeps a selected tag absent from the list', () => {
    expect(tagChipOptions(['urgent', 'gone:7'], ['severity:2', 'urgent'])).toEqual({
      options: ['urgent', 'gone:7', 'severity:2'],
      hidden: 0,
    });
  });

  it('caps the chips and counts the rest for the search hint', () => {
    const { options, hidden } = tagChipOptions([], many);
    expect(options).toHaveLength(TAG_CHIP_CAP);
    expect(options[0]).toBe('t0');
    expect(hidden).toBe(5);
  });

  it('never cuts a selected tag, even one from the long tail', () => {
    const { options, hidden } = tagChipOptions(['t64'], many);
    expect(options[0]).toBe('t64');
    expect(options).toHaveLength(TAG_CHIP_CAP);
    expect(hidden).toBe(5);
    // More selected tags than the cap: all of them stay.
    const all = tagChipOptions(many, many);
    expect(all.options).toHaveLength(many.length);
    expect(all.hidden).toBe(0);
  });
});

/**
 * The merged Status (spec D7): /tasks shows ONE Status section, not Status +
 * Phase. Its five values are the status words (no "Doing", no "Done"), it reads a
 * legacy completion list folded into phases (so a stored /tasks query keeps its
 * meaning), and it writes exact phases with completion cleared.
 */
describe('merged Status', () => {
  const STATUS_WORDS = ['To Do', 'In Progress', 'Need Action', 'Waiting', 'Complete'];

  it('has the filter bar order and the status words', () => {
    expect([...QUERY_STATUS_ORDER]).toEqual([...STATUS_FILTER_ORDER]);
    expect(QUERY_STATUS_OPTIONS.map((o) => o.label)).toEqual(STATUS_WORDS);
    for (const o of QUERY_STATUS_OPTIONS) expect(o.label).toBe(PHASE_LABELS[o.value]);
  });

  it('agrees with foldQueryStatus for every shape a stored query can have', () => {
    const shapes: Pick<TaskQueryFilterState, 'completion' | 'phases'>[] = [
      { completion: [], phases: [] },
      { completion: ['todo', 'in_progress'], phases: [] },
      { completion: ['complete'], phases: [] },
      { completion: ['todo'], phases: [] },
      { completion: [], phases: ['COMPLETE', 'TODO'] },
      { completion: ['todo'], phases: ['WAITING'] },
    ];
    for (const shape of shapes) expect(queryStatusSet(shape)).toEqual(foldQueryStatus(shape) ?? []);
  });

  it('reads the /tasks default (completion todo + in_progress) as the four not-complete statuses', () => {
    expect(queryStatusSet({ completion: ['todo', 'in_progress'], phases: [] }))
      .toEqual(['TODO', 'IN_PROGRESS', 'NEED_ACTION', 'WAITING']);
  });

  it('writes exact phases in order and clears completion; an empty set is no condition', () => {
    const from = { ...base, completion: ['todo', 'in_progress'] as TaskQueryFilterState['completion'] };
    expect(withQueryStatus(from, ['COMPLETE', 'TODO'])).toMatchObject({ phases: ['TODO', 'COMPLETE'], completion: [] });
    const none = withQueryStatus(from, []);
    expect(none.phases).toEqual([]);
    expect(none.completion).toEqual([]);
    expect(text(buildFilterSentence(none))).toBe('Showing every task.');
  });

  it('puts one Status group in the sentence whose chips remove one status each', () => {
    const state: TaskQueryFilterState = { ...base, completion: ['complete'] };
    expect(text(buildFilterSentence(state))).toBe('Showing [Complete].');
    const tokens = buildFilterSentence({ ...base, phases: ['TODO', 'WAITING'] });
    const chips = tokens.filter((t) => t.kind === 'chip');
    expect(chips.map((c) => c.kind === 'chip' && c.dim)).toEqual(['status', 'status']);
    const waiting = chips.find((c) => c.kind === 'chip' && c.value === 'WAITING')!;
    expect(waiting.kind === 'chip' && waiting.removed.phases).toEqual(['TODO']);
    expect(waiting.kind === 'chip' && waiting.removed.completion).toEqual([]);
  });

  it('search lists one Status group (no Phase group), found by "phase" too, with no Doing or Done', () => {
    const lists = { projectOptions: [], sourceOptions: [], sprintOptions: [] };
    for (const q of ['status', 'phase']) {
      const groups = searchFilterOptions(base, lists, q);
      expect(groups.map((g) => g.dimension)).toEqual(['Status']);
      expect(groups[0].options.map((o) => o.label)).toEqual(STATUS_WORDS);
      expect(groups[0].options.every((o) => o.section === 'q-status')).toBe(true);
    }
    const labels = searchFilterOptions(base, lists, 'o').flatMap((g) => g.options.map((o) => o.label));
    expect(labels).not.toContain('Done');
    expect(labels).not.toContain('Doing');
  });

  it('a search pick on a folded completion set writes phases and keeps the rest', () => {
    const state: TaskQueryFilterState = { ...base, completion: ['todo', 'in_progress'], projects: ['Walnut'] };
    const lists = { projectOptions: ['Walnut'], sourceOptions: [], sprintOptions: [] };
    const complete = searchFilterOptions(state, lists, 'complete')[0].options[0];
    expect(complete.selected).toBe(false);
    expect(complete.toggled).toMatchObject({
      phases: ['TODO', 'IN_PROGRESS', 'NEED_ACTION', 'WAITING', 'COMPLETE'], completion: [], projects: ['Walnut'],
    });
  });
});

/**
 * C50 on /tasks: every status word a /tasks chip shows is a Status value word.
 * A legacy completion value read back from an older saved query and a phase
 * value both read "Status: <word>", never Phase, Doing or Done.
 */
describe('/tasks chips use the Status words (C50)', () => {
  const WORDS = ['To Do', 'In Progress', 'Need Action', 'Waiting', 'Complete'];
  it('legacy completion and phase values label as Status with a Status word', async () => {
    const { buildTaskFilterChips } = await import('../../web/src/components/tasks/TaskFilterChips');
    const query: TaskQueryFilterState = {
      ...DEFAULT_TASK_QUERY_FILTER_STATE,
      completion: ['todo', 'in_progress', 'complete'],
      phases: ['TODO', 'COMPLETE'],
    };
    const chips = buildTaskFilterChips(query, () => {});
    const status = chips.filter((c) => c.key.startsWith('completion:') || c.key.startsWith('phase:'));
    expect(status).toHaveLength(5);
    for (const c of status) {
      expect(c.label).toBe('Status');
      expect(WORDS).toContain(c.value);
    }
  });
});
