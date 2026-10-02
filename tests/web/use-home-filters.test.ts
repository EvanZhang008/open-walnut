/**
 * Pure helpers behind the home panel's filter integration (useHomeFilters,
 * TodoFilterFooter, TodoFilterEmpty): the synchronous first-render state (4.8,
 * C46), Project value order (4.1), tag pill text, the toast-dismiss rule (C54),
 * footer counts and toggles (5.6, C9, C39, C49), the footer's view scope, the
 * just-created rule (5.11) and the F shortcut's typing guard (6.8).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

// The hook module also wires React contexts and stores; only its pure helpers
// are under test here, so the browser-only imports are stubbed.
vi.mock('@/contexts/notifications', () => ({ useNotifications: () => ({}) }));
vi.mock('@/hooks/useShowPriority', () => ({ useShowPriority: () => false }));
vi.mock('@/hooks/useIntegrations', () => ({ useIntegrations: () => [], getIntegrationMeta: () => undefined }));
vi.mock('@/stores/tag-display-store', () => ({ useTagDisplay: () => ({ compiled: {} }) }));
vi.mock('../../web/src/components/tasks/ViewDropdown', () => ({ logTaskQueryChange: () => {} }));
import type { Task } from '../../src/core/types';
import { DEFAULT_FILTER_STATE as S0, type FilterState } from '../../web/src/components/tasks/filter-bar-types';
import { buildFilterEvalContext } from '../../web/src/components/tasks/filter-predicate';
import {
  addsChip, initialFilterModels, isTypingTarget, orderFilterProjects, tagPillText,
} from '../../web/src/components/tasks/useHomeFilters';
import {
  footerCounts, footerItems, footerScope, toggleStatusPhase,
} from '../../web/src/components/tasks/TodoFilterFooter';
import { isJustCreated } from '../../web/src/components/tasks/TodoFilterEmpty';

const store = new Map<string, string>();
beforeEach(() => {
  store.clear();
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => { store.set(k, String(v)); },
    removeItem: (k: string) => { store.delete(k); },
  };
});

let seq = 0;
function mk(over: Partial<Task> = {}): Task {
  seq += 1;
  const phase = over.phase ?? 'TODO';
  return {
    id: `t${seq}`,
    title: `Task ${seq}`,
    status: phase === 'COMPLETE' ? 'done' : phase === 'TODO' || phase === 'WAITING' ? 'todo' : 'in_progress',
    phase,
    priority: 'none',
    project: 'Home',
    source: 'local',
    created_at: '2026-09-01T00:00:00Z',
    updated_at: '2026-09-01T00:00:00Z',
    ...over,
  } as Task;
}
const st = (over: Partial<FilterState>): FilterState => ({ ...S0, ...over });

describe('initialFilterModels (4.8, C46)', () => {
  it('starts at the defaults with nothing stored', () => {
    const m = initialFilterModels(undefined);
    expect(m.legacy).toMatchObject({ dateFilter: 'now', phaseFilter: '', activeProject: '', showCompleted: false, showWaiting: false });
    expect(m.query.projects).toEqual([]);
    expect(m.query.phases).toEqual([]);
  });

  it('reads the persisted chips synchronously, both models written', () => {
    store.set('walnut-todo-filters', JSON.stringify({
      v: 1, status: ['COMPLETE'], projects: ['Garden'], date: 'now', sources: ['ms-todo'],
      priorities: [], tagsAny: ['label:urgent'], sprints: [], time: { basis: 'updated', preset: null, customValue: 24, customUnit: 'hours' },
    }));
    const m = initialFilterModels(undefined);
    expect(m.query.projects).toEqual(['Garden']);
    expect(m.query.sources).toEqual(['ms-todo']);
    expect(m.query.tagsAny).toEqual(['label:urgent']);
    expect(m.query.phases).toEqual(['COMPLETE']);
    expect(m.legacy.showCompleted).toBe(true);
    expect(m.legacy.activeProject).toBe('');
  });

  it('folds a URL project into the Project set (migration), activeProject stays empty', () => {
    store.set('walnut-todo-filters', JSON.stringify({ v: 1, status: ['TODO', 'IN_PROGRESS', 'NEED_ACTION'], projects: ['Home'], date: 'now' }));
    const m = initialFilterModels('Garden');
    expect(m.query.projects).toEqual(['Home', 'Garden']);
    expect(m.legacy.activeProject).toBe('');
    expect(initialFilterModels('Home').query.projects).toEqual(['Home']);
  });

  it('drops a record with an unknown version', () => {
    store.set('walnut-todo-filters', JSON.stringify({ v: 9, projects: ['Garden'] }));
    expect(initialFilterModels(undefined).query.projects).toEqual([]);
  });
});

describe('orderFilterProjects (4.1)', () => {
  it('Inbox first, then board order, then the rest by name; only projects with tasks', () => {
    const tasks = [mk({ project: 'Zoo' }), mk({ project: 'Garden' }), mk({ project: '' }), mk({ project: 'Home' }), mk({ project: 'garden' })];
    expect(orderFilterProjects(tasks, ['Home', 'Garden'])).toEqual(['', 'Home', 'Garden', 'Zoo']);
    expect(orderFilterProjects([mk({ project: 'B' }), mk({ project: 'A' })], undefined)).toEqual(['A', 'B']);
  });
});

describe('tagPillText', () => {
  it('reads like the board pill', () => {
    const valueOnly = (t: string) => t.startsWith('label:');
    expect(tagPillText('label:urgent', valueOnly)).toBe('urgent');
    expect(tagPillText('sev:2', valueOnly)).toBe('sev:2');
    expect(tagPillText('plain', valueOnly)).toBe('plain');
  });
});

describe('addsChip (C54: a new chip dismisses the Undo toast)', () => {
  it('is true only when a dimension leaves its default', () => {
    expect(addsChip(S0, st({ projects: ['Home'] }))).toBe(true);
    expect(addsChip(st({ projects: ['Home'] }), st({ projects: ['Home', 'Garden'] }))).toBe(false);
    expect(addsChip(st({ projects: ['Home'] }), S0)).toBe(false);
    expect(addsChip(S0, st({ date: '' }))).toBe(true);
  });
});

describe('footerCounts / footerItems (5.6, C9, C39, C49)', () => {
  const garden = st({ projects: ['Garden'] });
  const tasks = [
    mk({ project: 'Garden' }),
    mk({ project: 'Garden', phase: 'WAITING' }),
    mk({ project: 'Home', phase: 'WAITING' }),
    mk({ project: 'Garden', phase: 'COMPLETE' }),
    mk({ project: 'Home', phase: 'COMPLETE' }),
    mk({ project: 'Garden', start_date: '2099-01-01' }),
    mk({ project: 'Home', start_date: '2099-01-01' }),
  ];

  it('counts only tasks that pass every other chip', () => {
    const c = footerCounts(tasks, buildFilterEvalContext(tasks, garden), 50);
    // The archive cannot be checked against Project: Garden, so it does not count.
    expect(c).toEqual({ waiting: 1, complete: 1, notAvailable: 1 });
    const all = footerCounts(tasks, buildFilterEvalContext(tasks, S0), 50);
    expect(all).toEqual({ waiting: 2, complete: 52, notAvailable: 2 });
  });

  it('words hidden vs shown from the Status set and toggles through it', () => {
    const items = footerItems(S0, { waiting: 2, complete: 3, notAvailable: 4 });
    expect(items.map((i) => i.text)).toEqual(['2 Waiting hidden', '3 Complete hidden', '4 not available yet: show']);
    expect(items[0].next.status).toEqual(['TODO', 'IN_PROGRESS', 'NEED_ACTION', 'WAITING']);
    expect(items[1].next.status).toEqual(['TODO', 'IN_PROGRESS', 'NEED_ACTION', 'COMPLETE']);
    expect(items[2].next.date).toBe('');
    const shown = footerItems(st({ status: ['TODO', 'IN_PROGRESS', 'NEED_ACTION', 'WAITING', 'COMPLETE'] }), { waiting: 2, complete: 3, notAvailable: 0 });
    expect(shown.map((i) => i.text)).toEqual(['2 Waiting shown', '3 Complete shown']);
  });

  it('has no not-available item unless Date is the default, and no old words', () => {
    const items = footerItems(st({ date: 'overdue' }), { waiting: 0, complete: 0, notAvailable: 5 });
    expect(items).toEqual([]);
    const text = footerItems(S0, { waiting: 1, complete: 1, notAvailable: 1 }).map((i) => `${i.text} ${i.title}`).join(' ');
    expect(text).not.toMatch(/deferred|parked|\u00D7|\u00B7/i);
  });

  it('toggleStatusPhase never empties the set', () => {
    expect(toggleStatusPhase(st({ status: ['COMPLETE'] }), 'COMPLETE').status).toEqual(['COMPLETE']);
    expect(toggleStatusPhase(st({ status: ['WAITING', 'COMPLETE'] }), 'WAITING').status).toEqual(['COMPLETE']);
  });
});

describe('footerScope', () => {
  const a = mk(); const b = mk(); const c = mk(); const d = mk();
  const tasks = [a, b, c, d];
  const sets = {
    pinned: new Set([a.id, b.id, c.id]), focus: new Set([a.id]), wait: new Set<string>(),
    custom: { ct_x: new Set([c.id]) },
  };
  it('scopes tiers and Pinned to their members, leaves All alone', () => {
    expect(footerScope(tasks, 'all', sets)).toBe(tasks);
    expect(footerScope(tasks, 'pinned', sets).map((t) => t.id)).toEqual([a.id, b.id, c.id]);
    expect(footerScope(tasks, 'focus', sets).map((t) => t.id)).toEqual([a.id]);
    expect(footerScope(tasks, 'satellite', sets).map((t) => t.id)).toEqual([b.id]);
    expect(footerScope(tasks, 'ct_x', sets).map((t) => t.id)).toEqual([c.id]);
  });
});

describe('isJustCreated (5.11) and isTypingTarget (6.8)', () => {
  it('a task created in the last two minutes counts as just created', () => {
    const now = Date.parse('2026-10-01T12:00:00Z');
    expect(isJustCreated('2026-10-01T11:59:30Z', now)).toBe(true);
    expect(isJustCreated('2026-10-01T11:50:00Z', now)).toBe(false);
    expect(isJustCreated(undefined, now)).toBe(false);
  });
  it('treats inputs, text areas and editable nodes as typing targets', () => {
    expect(isTypingTarget(null)).toBe(false);
    expect(isTypingTarget({ tagName: 'INPUT' } as unknown as Element)).toBe(true);
    expect(isTypingTarget({ tagName: 'TEXTAREA' } as unknown as Element)).toBe(true);
    expect(isTypingTarget({ tagName: 'DIV', isContentEditable: true } as unknown as Element)).toBe(true);
    expect(isTypingTarget({ tagName: 'BUTTON', isContentEditable: false } as unknown as Element)).toBe(false);
  });
});
