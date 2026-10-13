/**
 * What the task page does when its task goes away under it (web/src/pages/task-gone.ts).
 *
 * The fork r6 gate (MED-1): the page navigated home on a merge too, and a pop-out window
 * ("Open in new tab") that navigates to an app path crashed. Pinned here: a merge names the task
 * it went into and the page shows a notice with a link; a delete shows a notice in a pop-out and
 * goes home in the app; an event about another task is ignored (L-33: a page that ignored every
 * delete had no test that could fail). tests/e2e/browser/task-page-gone.spec.ts drives the pages.
 */
import { describe, expect, it } from 'vitest';
import { pageTaskId, taskGoneAction, taskHref } from '../../web/src/pages/task-gone';
import { taskLinkTarget } from '../../web/src/hooks/useTaskLinkClickFallback';

const merged = { id: 'victim-1', task: { id: 'victim-1' }, mergedInto: { id: 'survivor-1', title: 'The survivor' } };
const deleted = { id: 'victim-1', task: { id: 'victim-1' } };

describe('taskGoneAction', () => {
  it('a merge shows a notice naming the task it went into, in the app and in a pop-out', () => {
    for (const isPopout of [false, true]) {
      expect(taskGoneAction(merged, 'victim-1', 'victim-1', isPopout)).toEqual({
        kind: 'notice',
        gone: { forId: 'victim-1', mergedInto: { id: 'survivor-1', title: 'The survivor' } },
      });
    }
  });

  it('a delete shows a notice in a pop-out and goes home in the app', () => {
    expect(taskGoneAction(deleted, 'victim-1', 'victim-1', true)).toEqual({ kind: 'notice', gone: { forId: 'victim-1' } });
    expect(taskGoneAction(deleted, 'victim-1', 'victim-1', false)).toEqual({ kind: 'navigate', to: '/' });
  });

  it('keys the notice to the id the page was opened with (a prefix), matching on the resolved id', () => {
    expect(taskGoneAction(merged, 'victim-1', 'vic', true)).toMatchObject({ kind: 'notice', gone: { forId: 'vic' } });
  });

  it('reads a delete that names only its task, as the plugin sync and the reconciler send it', () => {
    expect(taskGoneAction({ task: { id: 'victim-1' } }, 'victim-1', 'victim-1', true)).toEqual({ kind: 'notice', gone: { forId: 'victim-1' } });
  });

  it('ignores another task, an unnamed delete and a page with no task yet', () => {
    for (const isPopout of [false, true]) {
      expect(taskGoneAction(merged, 'other-task', 'other-task', isPopout)).toEqual({ kind: 'ignore' });
      expect(taskGoneAction({}, 'victim-1', 'victim-1', isPopout)).toEqual({ kind: 'ignore' });
      expect(taskGoneAction(undefined, 'victim-1', 'victim-1', isPopout)).toEqual({ kind: 'ignore' });
      expect(taskGoneAction(merged, undefined, undefined, isPopout)).toEqual({ kind: 'ignore' });
    }
  });

  it('a merge that names the page task itself as the survivor is a delete', () => {
    const self = { id: 'victim-1', mergedInto: { id: 'victim-1', title: 'Self' } };
    expect(taskGoneAction(self, 'victim-1', 'victim-1', true)).toEqual({ kind: 'notice', gone: { forId: 'victim-1' } });
    expect(taskGoneAction(self, 'victim-1', 'victim-1', false)).toEqual({ kind: 'navigate', to: '/' });
  });
});

describe('pageTaskId', () => {
  it("matches on the loaded task's full id, but only while it is this page's task", () => {
    expect(pageTaskId('victim-1-full', 'victim-1')).toBe('victim-1-full');
    expect(pageTaskId('victim-1', 'victim-1')).toBe('victim-1');
    expect(pageTaskId(undefined, 'victim-1')).toBe('victim-1');
    // A link to another task in the same window: the last task's detail is still loaded.
    expect(pageTaskId('victim-1', 'survivor-1')).toBe('survivor-1');
    expect(pageTaskId('victim-1', undefined)).toBeUndefined();
  });

  it('so a delete of the last task, landing while the next one loads, is not shown on it', () => {
    expect(taskGoneAction(merged, pageTaskId('victim-1', 'survivor-1'), 'survivor-1', true)).toEqual({ kind: 'ignore' });
  });
});

describe('taskHref', () => {
  it('stays in the pop-out when the page is one, else goes to the app task page', () => {
    expect(taskHref('survivor-1', true)).toBe('/popout?view=task&id=survivor-1');
    expect(taskHref('survivor-1', false)).toBe('/tasks/survivor-1');
  });

  it('a task pill with no handler of its own does the same (the app-wide click fallback)', () => {
    expect(taskLinkTarget('survivor-1', true)).toBe('/popout?view=task&id=survivor-1');
    expect(taskLinkTarget('survivor-1', false)).toBe('/tasks/survivor-1');
    expect(taskLinkTarget('a b', false)).toBe('/tasks/a%20b');
  });
});
