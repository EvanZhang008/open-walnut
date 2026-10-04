/**
 * Filter bar model (web/src/components/tasks/filter-bar-model.ts): the adapters
 * that project the legacy home filters and TaskQueryFilterState onto one chip
 * set, the chip text, the popover values and the click semantics.
 */
import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from '../../web/node_modules/react-dom/server.node.js';
import type { TaskPhase } from '../../src/core/types';
import { PHASE_LABELS } from '../../web/src/utils/session-status';
import { INBOX_TAB } from '../../web/src/components/tasks/task-tabs';
import { DEFAULT_TASK_QUERY_FILTER_STATE as Q0 } from '../../web/src/components/tasks/view-filter-model';
import { DEFAULT_FILTER_STATE, type FilterLists, type FilterState, type LegacyFilterFields } from '../../web/src/components/tasks/filter-bar-types';
import {
  DATE_FILTER_OPTIONS, OPEN_PHASES, STATUS_FILTER_ORDER, buildFilterChips, chipSummary, dimValues,
  foldQueryStatus, isDefaultStatus, isDimVisible, migrateLegacy, moreSetCount, pickValue, readFilterState,
  readStatusSet, statusChipLabel, timeChipText, writeFilterState, writeProjectSet, writeStatusSet,
} from '../../web/src/components/tasks/filter-bar-model';
import { ICON_CHECK, ICON_PHASE_COMPLETE, ICON_SLIDERS, ICON_CHEVRON_DOWN, ICON_CHEVRON_RIGHT } from '../../web/src/components/common/Icons';

const L0: LegacyFilterFields = { dateFilter: 'now', phaseFilter: '', activeProject: '', showCompleted: false, showWaiting: false };
const S0: FilterState = DEFAULT_FILTER_STATE;
const lists: FilterLists = {
  loading: false,
  projects: ['', 'Home', 'Garden'],
  sources: [{ id: 'local', label: 'Local' }, { id: 'ms-todo', label: 'Microsoft To Do' }],
  tags: ['label:urgent', 'area:yard'],
  sprints: ['S1'],
  showPriority: true,
  tagLabel: (t) => (t.startsWith('label:') ? t.slice(6) : t),
};
const st = (...p: TaskPhase[]): FilterState => ({ ...S0, status: p });

describe('writeStatusSet (4.2 write table)', () => {
  it('OPEN clears everything', () => {
    expect(writeStatusSet([...OPEN_PHASES])).toEqual({
      legacy: { phaseFilter: '', showWaiting: false, showCompleted: false },
      query: { phases: [], completion: [] },
    });
  });
  it('OPEN + WAITING rides on showWaiting', () => {
    expect(writeStatusSet([...OPEN_PHASES, 'WAITING'])).toEqual({
      legacy: { phaseFilter: '', showWaiting: true, showCompleted: false },
      query: { phases: [], completion: [] },
    });
  });
  it('OPEN + COMPLETE rides on showCompleted', () => {
    expect(writeStatusSet(['COMPLETE', ...OPEN_PHASES])).toEqual({
      legacy: { phaseFilter: '', showWaiting: false, showCompleted: true },
      query: { phases: [], completion: [] },
    });
  });
  it('all five sets both toggles and nothing else', () => {
    expect(writeStatusSet([...STATUS_FILTER_ORDER])).toEqual({
      legacy: { phaseFilter: '', showWaiting: true, showCompleted: true },
      query: { phases: [], completion: [] },
    });
  });
  it('the empty set is refused', () => {
    expect(writeStatusSet([])).toBeNull();
  });
  it('any other set is exact phases with the toggles following it', () => {
    expect(writeStatusSet(['COMPLETE'])).toEqual({
      legacy: { phaseFilter: '', showWaiting: false, showCompleted: true },
      query: { phases: ['COMPLETE'], completion: [] },
    });
    expect(writeStatusSet(['WAITING', 'TODO'])).toEqual({
      legacy: { phaseFilter: '', showWaiting: true, showCompleted: false },
      query: { phases: ['TODO', 'WAITING'], completion: [] },
    });
    expect(writeStatusSet(['NEED_ACTION'])!.query.phases).toEqual(['NEED_ACTION']);
  });
});

describe('readStatusSet (4.2 read steps)', () => {
  const q = (over: Partial<typeof Q0>) => ({ ...Q0, ...over });
  it('step 2: query.phases wins', () => {
    expect(readStatusSet({ ...L0, showCompleted: true }, q({ phases: ['COMPLETE'] }))).toEqual(['COMPLETE']);
  });
  it('step 3: completion folds through COMPLETION_TO_PHASES (todo includes WAITING)', () => {
    expect(readStatusSet(L0, q({ completion: ['todo'] }))).toEqual(['TODO', 'WAITING']);
    expect(readStatusSet(L0, q({ completion: ['in_progress', 'complete'] }))).toEqual(['IN_PROGRESS', 'NEED_ACTION', 'COMPLETE']);
  });
  it('step 4: legacy phaseFilter', () => {
    expect(readStatusSet({ ...L0, phaseFilter: 'TODO' }, Q0)).toEqual(['TODO', 'IN_PROGRESS', 'NEED_ACTION', 'WAITING']);
    expect(readStatusSet({ ...L0, phaseFilter: 'WAITING' }, Q0)).toEqual(['WAITING']);
    expect(readStatusSet({ ...L0, phaseFilter: 'COMPLETE', showCompleted: true }, Q0)).toEqual(['COMPLETE']);
  });
  it('steps 5-6: OPEN plus the legacy toggles', () => {
    expect(readStatusSet(L0, Q0)).toEqual([...OPEN_PHASES]);
    expect(readStatusSet({ ...L0, showWaiting: true, showCompleted: true }, Q0)).toEqual([...STATUS_FILTER_ORDER]);
  });
  it('every non-empty subset round-trips through write then read', () => {
    for (let mask = 1; mask < 32; mask++) {
      const set = STATUS_FILTER_ORDER.filter((_, i) => mask & (1 << i));
      const w = writeStatusSet(set)!;
      expect(readStatusSet(w.legacy, { ...Q0, ...w.query })).toEqual(set);
    }
  });
  it('foldQueryStatus only reads the query side', () => {
    expect(foldQueryStatus(Q0)).toBeNull();
    expect(foldQueryStatus({ ...Q0, completion: ['complete'] })).toEqual(['COMPLETE']);
  });
});

describe('Project adapter (4.3)', () => {
  it('writes query.projects for 0, 1 and 2 projects, never activeProject', () => {
    expect(writeProjectSet([])).toEqual({ query: { projects: [] }, legacy: { activeProject: '' }, bookmark: '' });
    expect(writeProjectSet(['Garden'])).toEqual({ query: { projects: ['Garden'] }, legacy: { activeProject: '' }, bookmark: 'Garden' });
    expect(writeProjectSet(['Garden', 'Home'])).toEqual({ query: { projects: ['Garden', 'Home'] }, legacy: { activeProject: '' }, bookmark: '' });
    expect(writeProjectSet(['']).bookmark).toBe(INBOX_TAB);
  });
  it('migrates activeProject into query.projects once and drops query.pinned', () => {
    const m = migrateLegacy({ ...L0, activeProject: 'Garden' }, { ...Q0, pinned: true });
    expect(m.legacy.activeProject).toBe('');
    expect(m.query.projects).toEqual(['Garden']);
    expect(m.query.pinned).toBeUndefined();
    expect(migrateLegacy(m.legacy, m.query).query.projects).toEqual(['Garden']);
    expect(migrateLegacy({ ...L0, activeProject: 'garden' }, { ...Q0, projects: ['Garden'] }).query.projects).toEqual(['Garden']);
    expect(migrateLegacy({ ...L0, activeProject: INBOX_TAB }, Q0).query.projects).toEqual(['']);
  });
  it('readFilterState folds activeProject; writeFilterState keeps sort and clears pinned', () => {
    const s = readFilterState({ ...L0, activeProject: 'Home', dateFilter: 'overdue' }, { ...Q0, sources: ['local'], pinned: false });
    expect(s.projects).toEqual(['Home']);
    expect(s.date).toBe('overdue');
    expect(s.sources).toEqual(['local']);
    const w = writeFilterState({ ...s, status: ['COMPLETE'] }, { ...Q0, sort: 'title_asc', pinned: true });
    expect(w.query.sort).toBe('title_asc');
    expect(w.query.pinned).toBeUndefined();
    expect(w.query.projects).toEqual(['Home']);
    expect(w.legacy).toEqual({ dateFilter: 'overdue', phaseFilter: '', activeProject: '', showCompleted: true, showWaiting: false });
    expect(w.bookmark).toBe('Home');
    expect(readFilterState(w.legacy, w.query)).toEqual({ ...s, status: ['COMPLETE'] });
  });
});

describe('chip text (4.2, 4.4, 4.5)', () => {
  it('statusChipLabel covers every branch', () => {
    expect(statusChipLabel([...OPEN_PHASES])).toBe('Open');
    expect(statusChipLabel([...OPEN_PHASES, 'WAITING'])).toBe('Open, Waiting');
    expect(statusChipLabel([...OPEN_PHASES, 'COMPLETE'])).toBe('Open, Complete');
    expect(statusChipLabel(['TODO', 'IN_PROGRESS', 'NEED_ACTION', 'WAITING', 'COMPLETE'])).toBe('Any');
    expect(statusChipLabel(['COMPLETE'])).toBe('Complete');
    expect(statusChipLabel(['WAITING', 'TODO'])).toBe('To Do, Waiting');
    expect(statusChipLabel(['TODO', 'WAITING', 'COMPLETE'])).toBe('To Do, Waiting, Complete');
    expect(statusChipLabel(['TODO', 'IN_PROGRESS', 'WAITING', 'COMPLETE'])).toBe('4 statuses');
  });
  it('timeChipText uses words, never a comparison sign', () => {
    const t = S0.time;
    expect(timeChipText({ ...t, basis: 'updated', preset: '24h' })).toBe('Updated in 24h');
    expect(timeChipText({ ...t, basis: 'created', preset: '7d' })).toBe('Created in 7d');
    expect(timeChipText({ ...t, basis: 'created_or_updated', preset: '30d' })).toBe('Active in 30d');
    expect(timeChipText({ ...t, preset: 'custom', customValue: 3, customUnit: 'days' })).toBe('Updated in 3d');
    expect(timeChipText({ ...t, preset: null })).toBeNull();
  });
  it('default state has no chips', () => {
    expect(buildFilterChips(S0, lists)).toEqual([]);
  });
  it('one chip per dimension in registry order, not add order', () => {
    const s: FilterState = {
      ...S0, time: { ...S0.time, preset: '24h' }, blocked: false, tagsAny: ['label:urgent'],
      projects: ['Garden', 'Home', ''], status: ['COMPLETE'], date: 'this-week', sources: ['ms-todo'],
    };
    const chips = buildFilterChips(s, lists);
    expect(chips.map((c) => c.dim)).toEqual(['status', 'project', 'date', 'source', 'blocked', 'tags', 'time']);
    expect(chips.map((c) => c.value)).toEqual(['Complete', '3 projects', 'Starting within 7 days', 'Microsoft To Do', 'Not blocked', 'urgent', 'Updated in 24h']);
    expect(chips[1].title).toBe('Garden, Home, Inbox');
    expect(chipSummary(chips.slice(0, 2))).toBe('Status: Complete, Project: 3 projects');
    expect(chipSummary([chips[4]])).toBe('Not blocked');
    expect(chips[1].reset(s).projects).toEqual([]);
    expect(chips[0].reset(s).status).toEqual([...OPEN_PHASES]);
  });
  it('a value no task has now is a muted chip with the 5.8 title', () => {
    const [chip] = buildFilterChips({ ...S0, projects: ['Gone'] }, lists);
    expect(chip.missing).toBe(true);
    expect(chip.title).toBe('No task has this value now');
    expect(buildFilterChips({ ...S0, projects: ['Gone'] }, { ...lists, loading: true })[0].missing).toBe(false);
    expect(buildFilterChips({ ...S0, projects: ['Garden', 'Home'] }, lists)[0].value).toBe('Garden, Home');
  });
  it('every Status word is a PHASE_LABELS label (C50)', () => {
    const labels = new Set(Object.values(PHASE_LABELS));
    for (const o of dimValues('status', S0, lists)) expect(labels.has(o.label)).toBe(true);
    expect(dimValues('status', S0, lists).map((o) => o.label)).toEqual(['To Do', 'In Progress', 'Need Action', 'Waiting', 'Complete']);
  });
});

describe('popover values (4.1, G9)', () => {
  it('the last selected Status cannot be turned off', () => {
    const vals = dimValues('status', st('COMPLETE'), lists);
    const c = vals.find((o) => o.value === 'COMPLETE')!;
    expect(c.disabled).toBe(true);
    expect(c.disabledTitle).toBe('At least one status stays on');
    expect(vals.filter((o) => o.disabled)).toHaveLength(1);
    expect(pickValue(st('COMPLETE'), 'status', 'COMPLETE', 'replace').status).toEqual(['COMPLETE']);
  });
  it('first-layer titles are exact', () => {
    const status = Object.fromEntries(dimValues('status', S0, lists).map((o) => [o.value, o.title]));
    expect(status.TODO).toBe('To Do: not started yet');
    expect(status.WAITING).toBe('Waiting: on hold until a date or an event, hidden by default');
    const proj = dimValues('project', S0, lists);
    expect(proj.map((o) => o.label)).toEqual(['Inbox', 'Home', 'Garden']);
    expect(proj[0].title).toBe('Tasks with no project');
    expect(proj[2].title).toBe('Tasks in Garden');
    const src = dimValues('source', S0, lists);
    expect(src.map((o) => o.title)).toEqual(['Tasks that live only in Walnut', 'Tasks synced from Microsoft To Do']);
    for (const o of [...dimValues('status', S0, lists), ...proj, ...src]) {
      expect(o.title).not.toMatch(/tier|focus|satellite|backlog|parked/i);
    }
  });
  it('Date values and titles match 4.1 exactly', () => {
    expect(DATE_FILTER_OPTIONS.map((o) => [o.value, o.label, o.firstLayer])).toEqual([
      ['now', 'Available now', true], ['', 'Any date', true], ['overdue', 'Overdue', false],
      ['this-week', 'Starting within 7 days', false],
    ]);
    expect(DATE_FILTER_OPTIONS[0].title).toBe('Hide tasks that start later. Tasks with no start date stay.');
    expect(DATE_FILTER_OPTIONS[3].title).toBe('Hide only tasks that start more than 7 days from now.');
  });
  it('selected-but-missing values come first and stay selectable', () => {
    const vals = dimValues('project', { ...S0, projects: ['Gone'] }, lists);
    expect(vals[0]).toMatchObject({ value: 'Gone', selected: true, missing: true, title: 'No task has this value now' });
    expect(vals.slice(1).map((o) => o.value)).toEqual(['', 'Home', 'Garden']);
  });
  it('isDimVisible follows the 4.1 "when shown" column', () => {
    const empty: FilterLists = { ...lists, projects: [], sources: [{ id: 'local', label: 'Local' }], tags: [], sprints: [], showPriority: false };
    expect(['status', 'project', 'date', 'source', 'priority', 'blocked', 'tags', 'sprint', 'time']
      .filter((d) => isDimVisible(d as never, S0, empty))).toEqual(['status', 'date', 'blocked', 'time']);
    expect(isDimVisible('project', S0, { ...empty, loading: true })).toBe(true);
    expect(isDimVisible('source', { ...S0, sources: ['local'] }, empty)).toBe(true);
    expect(isDimVisible('source', S0, lists)).toBe(true);
    expect(isDimVisible('priority', { ...S0, priorities: ['important'] }, empty)).toBe(false);
  });
  it('moreSetCount counts only the More dimensions', () => {
    expect(moreSetCount({ ...S0, projects: ['Home'], blocked: true, tagsAny: ['x'] })).toBe(2);
  });
});

describe('pickValue (6.2, G13)', () => {
  it('Project and Source: click replaces, re-click on the sole value removes, toggle adds', () => {
    let s = pickValue(S0, 'project', 'Home', 'replace');
    expect(s.projects).toEqual(['Home']);
    s = pickValue(s, 'project', 'Garden', 'replace');
    expect(s.projects).toEqual(['Garden']);
    s = pickValue(s, 'project', 'Home', 'toggle');
    expect(s.projects).toEqual(['Garden', 'Home']);
    expect(pickValue(s, 'project', 'Home', 'replace').projects).toEqual(['Home']);
    expect(pickValue({ ...S0, projects: ['Home'] }, 'project', 'Home', 'replace').projects).toEqual([]);
    expect(pickValue(s, 'project', 'Garden', 'only').projects).toEqual(['Garden']);
    expect(pickValue(S0, 'source', 'local', 'replace').sources).toEqual(['local']);
  });
  it('Status, Tags, Sprint, Priority toggle on a plain click; add never removes', () => {
    expect(pickValue(S0, 'status', 'COMPLETE', 'replace').status).toEqual([...OPEN_PHASES, 'COMPLETE']);
    expect(pickValue(S0, 'status', 'TODO', 'replace').status).toEqual(['IN_PROGRESS', 'NEED_ACTION']);
    expect(pickValue(S0, 'status', 'TODO', 'add').status).toEqual([...OPEN_PHASES]);
    expect(pickValue({ ...S0, tagsAny: ['a'] }, 'tags', 'b', 'replace').tagsAny).toEqual(['a', 'b']);
    expect(pickValue({ ...S0, tagsAny: ['a', 'b'] }, 'tags', 'b', 'only').tagsAny).toEqual(['b']);
  });
  it('single-select: Date replaces, Blocked and Time window cancel on re-click', () => {
    expect(pickValue(S0, 'date', 'overdue', 'replace').date).toBe('overdue');
    expect(pickValue({ ...S0, date: 'overdue' }, 'date', 'now', 'replace').date).toBe('now');
    expect(isDefaultStatus(pickValue(S0, 'date', '', 'replace').status)).toBe(true);
    const b = pickValue(S0, 'blocked', 'false', 'replace');
    expect(b.blocked).toBe(false);
    expect(pickValue(b, 'blocked', 'false', 'replace').blocked).toBeUndefined();
    expect(pickValue(b, 'blocked', 'true', 'replace').blocked).toBe(true);
    const t = pickValue(S0, 'time', '24h', 'replace');
    expect(t.time.preset).toBe('24h');
    expect(pickValue(t, 'time', '24h', 'replace').time.preset).toBeNull();
  });
});

describe('icons (C61)', () => {
  const html = (n: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(n);
  it('ICON_CHECK is a plain tick whose markup differs from ICON_PHASE_COMPLETE', () => {
    expect(html(ICON_CHECK)).not.toBe(html(ICON_PHASE_COMPLETE));
    expect((html(ICON_CHECK).match(/<(path|polyline)/g) ?? []).length).toBe(1);
    expect(html(ICON_CHECK)).not.toContain('<circle');
  });
  it('the Display button icon shares the viewBox and stroke of its siblings, no hard-coded color', () => {
    expect(html(ICON_SLIDERS)).toContain('viewBox="0 0 16 16"');
    expect(html(ICON_SLIDERS)).toContain('stroke-width="1.5"');
    expect(html(ICON_SLIDERS)).toMatch(/width="15" height="15"/);
    expect(html(ICON_SLIDERS)).toContain('stroke="currentColor"');
    expect(html(ICON_CHEVRON_DOWN)).toContain('stroke-width="1.6"');
    expect(html(ICON_CHEVRON_RIGHT)).toContain('stroke-width="1.6"');
  });
});
