/**
 * The /tasks table stays aligned when priority is hidden (`ui.show_priority` off,
 * the default).
 *
 * `.tp-thead`, `.tp-row` and `.tp-ghost` are three separate grids that share ONE
 * `grid-template-columns` class, so dropping the priority CELL without dropping its
 * TRACK does not leave a gap — it shifts Due, Session and Project one column to the
 * left in the rows while the header keeps its own tracks, i.e. every value ends up
 * under the wrong heading. A cell/track mismatch is exactly the kind of break that
 * looks fine in a screenshot of the header row alone, so it is pinned here rather
 * than left to the eye.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const WEB = path.resolve(import.meta.dirname, '../../web/src');
const CSS_SRC = fs.readFileSync(path.join(WEB, 'styles/tasks-page.css'), 'utf8');
const TABLE_SRC = fs.readFileSync(path.join(WEB, 'components/tasks/TasksPageTable.tsx'), 'utf8');

/** The column tracks a `.tp-cols-*` rule declares, `minmax(a, b)` folded to one token. */
function tracks(selector: string): string[] {
  const idx = CSS_SRC.indexOf(selector);
  expect(idx, `missing CSS rule: ${selector}`).toBeGreaterThan(-1);
  const body = CSS_SRC.slice(idx, CSS_SRC.indexOf('}', idx) + 1);
  const match = /grid-template-columns:\s*([^;}]+)/.exec(body);
  expect(match, `${selector} declares no grid-template-columns`).toBeTruthy();
  return match![1].replace(/minmax\([^)]*\)/g, 'TITLE').trim().split(/\s+/);
}

describe('tasks table priority column', () => {
  it('the no-priority template is the full one minus exactly the priority track', () => {
    for (const base of ['.tp-cols-5', '.tp-cols-4']) {
      const full = tracks(`${base} {`);
      const withoutPriority = tracks(`${base}.tp-nopri {`);
      // Priority is the SECOND track (title first), so removing it must leave the
      // remaining widths untouched — not re-flow them.
      expect(withoutPriority, base).toEqual([full[0], ...full.slice(2)]);
    }
  });

  it('the header cell, the row cell and the track are gated on the same flag', () => {
    expect(TABLE_SRC).toMatch(/\{showPriority && <Th label="Priority"/);
    expect(TABLE_SRC).toMatch(/\{showPriority && <span><PriorityCell/);
    // The modifier is applied when the flag is OFF; inverting this is the
    // misalignment bug with the cells and the tracks swapped.
    expect(TABLE_SRC).toMatch(/showPriority \? '' : ' tp-nopri'/);
  });
});
