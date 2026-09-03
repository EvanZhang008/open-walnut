/**
 * The calendar rail fills in after the page paints, not before it.
 *
 * Measured 2026-09-03 against the live server on a real dataset: the rail renders one row
 * per unscheduled task, which is 2,890 rows and 11,614 elements, and building that costs
 * 194-214ms of DOM and layout on its own — proven by cloning the finished markup into a
 * detached container, so no React and no dnd-kit are involved in that number. Paid inside
 * the blocking render it was the whole 266ms hitch on opening Calendar, because the grid
 * and the rail commit together and one commit means one paint.
 *
 * Deferring the rail's list took the calendar grid to 22-31ms visible (worst stall before
 * it appears: 21-30ms), with the rail landing at 264-305ms and all 2,891 rows present.
 *
 * Two things here are load-bearing and easy to "simplify" away, which is why they are
 * pinned:
 *
 *  1. `useDeferredValue` must keep its SECOND argument. The one-argument form defers only
 *     updates, and the expensive render here is the FIRST one, so dropping the initial
 *     value silently restores the blocking paint while looking like a tidy-up.
 *  2. The empty state must stay gated on the settling flag. Without it, someone with
 *     2,890 unscheduled tasks gets told "No unscheduled tasks" for a frame on every open.
 *
 * Alternatives are recorded in the component comment, both rejected on measurement:
 * `content-visibility: auto` (open 266 -> 237ms, but scroll 87-100 -> 28-40 fps and the
 * rail's own height changed) and windowing (row heights depend on whether the title wraps
 * under `-webkit-line-clamp: 2`, and every row is a dnd-kit draggable).
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const SRC = fs.readFileSync(
  path.resolve(import.meta.dirname, '../../web/src/components/calendar/CalendarTaskList.tsx'),
  'utf8',
);

describe('calendar rail deferred render', () => {
  it('defers the task list with an initial value, so the FIRST render is cheap', () => {
    expect(
      SRC,
      'useDeferredValue needs its second argument here: the one-argument form defers only '
      + 'updates, and the expensive render is the first one',
    ).toMatch(/useDeferredValue\(\s*tasks\s*,\s*NO_TASKS\s*\)/);
  });

  it('the deferred value is the one the sections are built from', () => {
    // Building sections from `tasks` while deferring into an unused variable would be a
    // no-op that still typechecks and still renders correctly.
    expect(SRC).toMatch(/const unscheduled = deferredTasks\.filter\(/);
    const memoDeps = SRC.match(/\}, \[(deferredTasks|tasks)[^\]]*\]\);/);
    expect(memoDeps?.[1], 'the sections memo must depend on the deferred list').toBe('deferredTasks');
  });

  it('the initial value has a stable identity', () => {
    // An inline `[]` is a new array every render, so the deferred pass would see a
    // changed value and could keep re-deferring itself.
    expect(SRC).toMatch(/const NO_TASKS: Task\[\] = \[\];/);
    expect(SRC).not.toMatch(/useDeferredValue\(\s*tasks\s*,\s*\[\]\s*\)/);
  });

  it('never claims the rail is empty before the list has rendered', () => {
    expect(SRC).toMatch(/const settling = deferredTasks !== tasks;/);
    const emptyBranch = SRC.slice(SRC.indexOf('cal-rail-empty') - 400, SRC.indexOf('cal-rail-empty') + 80);
    expect(
      emptyBranch,
      'the "No unscheduled tasks" message must be gated on !settling, or it flashes on '
      + 'every open for anyone with a non-empty rail',
    ).toMatch(/sections\.length === 0 && !settling/);
  });

  it('does not reach for content-visibility on the rail rows', () => {
    // Measured and rejected: it barely moved the open and roughly halved scroll fps at
    // every speed, while changing the rail's reported height.
    const css = fs.readFileSync(
      path.resolve(import.meta.dirname, '../../web/src/styles/globals.css'),
      'utf8',
    );
    const idx = css.indexOf('.cal-rail-row {');
    expect(idx).toBeGreaterThan(-1);
    expect(css.slice(idx, css.indexOf('}', idx))).not.toMatch(/content-visibility/);
  });
});
