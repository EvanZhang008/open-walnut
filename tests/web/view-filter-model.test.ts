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
 *   - sort never appears — it's presentation, not a filter, and a removable
 *     sort chip would leave the query with no comparator.
 */
import { describe, it, expect } from 'vitest';
import {
  DEFAULT_TASK_QUERY_FILTER_STATE,
  TAG_CHIP_CAP,
  buildFilterSentence,
  searchFilterOptions,
  tagChipOptions,
  type TaskQueryFilterState,
} from '../../web/src/components/tasks/view-filter-model';

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
      'Showing [Doing], priority [Immediate], in [Walnut] or [iOS App], updated in [24h].',
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
    expect(text(buildFilterSentence({ ...base, sort: 'priority', completion: ['todo'] })))
      .toBe('Showing [To Do].');
  });
});

describe('searchFilterOptions', () => {
  const lists = {
    projectOptions: ['', 'Walnut', 'iOS App'],
    sourceOptions: ['local', 'ms-todo'],
    sprintOptions: ['Nov 10 – Nov 21'],
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
