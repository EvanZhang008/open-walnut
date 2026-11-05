/**
 * By project never draws completed tasks inside a project (2026-11-05, the user: "the
 * completed don't show in general, show a drop down below to open all completed ... not
 * each project"). A project folds only its waiting tasks, a project whose only tasks are
 * completed draws no group, and every view keeps ONE Completed row at its bottom.
 */
import { describe, expect, it } from 'vitest';
import type { Task } from '../../src/core/types';
import { PANEL_DESIGNS, bottomStatusSections, foldTasksByProject, leftoverFoldProjects } from '../../web/src/components/tasks/panel-design';

let n = 0;
const task = (patch: Partial<Task> = {}): Task => ({
  id: `t${++n}`,
  title: `Task ${n}`,
  status: 'todo',
  phase: 'TODO',
  priority: 'none',
  project: 'Garden',
  created_at: '2026-10-01T00:00:00.000Z',
  updated_at: '2026-10-01T00:00:00.000Z',
  ...patch,
} as Task);
const done = (patch: Partial<Task> = {}) => task({ phase: 'COMPLETE', status: 'done', completed_at: '2026-11-05T00:00:00.000Z', ...patch });
const all = () => true;

// Every tab of the home panel: the stacked view, the built-in tiers, Projects, Recent, a custom tier.
const VIEWS = ['all', 'focus', 'satellite', 'wait', 'tasks', 'recent', 'custom-1'];

describe('By project: completed tasks fold once, at the bottom', () => {
  it('a project folds only its waiting tasks, never a completed one', () => {
    const waiting = task({ project: 'Walnut', phase: 'WAITING' });
    const folds = foldTasksByProject([waiting, done({ project: 'Walnut' }), done({ project: 'Walnut' })], all);
    expect(folds.get('Walnut')?.waiting.map((t) => t.id)).toEqual([waiting.id]);
    expect(Object.keys(folds.get('Walnut') ?? {})).toEqual(['waiting']);
  });

  it('a project with only completed tasks draws no group, in a tier or in the list', () => {
    const folds = foldTasksByProject([done({ project: 'Walnut' }), done({ project: 'Orchard' }), done({ project: '' })], all);
    expect(folds.size).toBe(0);
    expect(leftoverFoldProjects(folds, new Set())).toEqual([]);
  });

  it('a project with a waiting task still draws its fold beside the completed ones', () => {
    const waiting = task({ project: 'Orchard', phase: 'WAITING' });
    const folds = foldTasksByProject([done({ project: 'Walnut' }), waiting, done({ project: 'Orchard' })], all);
    expect(leftoverFoldProjects(folds, new Set())).toEqual(['Orchard']);
  });

  it('every view of every layout keeps exactly one Completed row at its bottom', () => {
    for (const { id: design } of PANEL_DESIGNS) {
      for (const view of VIEWS) {
        const keys = bottomStatusSections(design, view);
        expect(keys.filter((k) => k === 'done'), `${design} / ${view}`).toEqual(['done']);
      }
    }
  });

  it('By project folds Waiting inside its projects, except Recent, which has no projects', () => {
    for (const view of VIEWS) {
      expect(bottomStatusSections('project', view).includes('waiting'), view).toBe(view === 'recent');
      expect(bottomStatusSections('status', view)).toEqual(['waiting', 'done']);
    }
  });
});
