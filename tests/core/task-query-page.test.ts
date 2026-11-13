import { describe, expect, it } from 'vitest';
import { taskMatchPage } from '../../src/core/task-query-page.js';

describe('the final visible task match page', () => {
  it('counts the final match set before slicing, for every page size', () => {
    const rows = Array.from({ length: 73 }, (_, i) => ({ id: `row-${i}`, phase: 'TODO' }));
    for (const limit of [undefined, 1, 5, 50, 73, 100]) {
      const page = taskMatchPage(rows, limit);
      expect(page.total).toBe(73);
      expect(page.tasks).toEqual(rows.slice(0, limit));
      expect(page.truncated).toBe(limit !== undefined && limit < 73);
    }
    expect(taskMatchPage([], 5)).toEqual({ tasks: [], total: 0, truncated: false });
  });

  it('an archive filter cannot create a phantom total or consume the page', () => {
    const rows = [
      { id: 'old-first', phase: 'COMPLETE', completed_at: '2000-01-01T00:00:00Z' },
      { id: 'visible-one', phase: 'TODO' },
      { id: 'visible-two', phase: 'NEED_ACTION' },
    ];
    const snapshot = structuredClone(rows);
    expect(taskMatchPage(rows, 2, 7)).toEqual({ tasks: rows.slice(1), total: 2, truncated: false, completedHidden: 1 });
    expect(taskMatchPage(rows.slice(0, 1), 5, 7)).toEqual({ tasks: [], total: 0, truncated: false, completedHidden: 1 });
    expect(rows).toEqual(snapshot);
  });
});
