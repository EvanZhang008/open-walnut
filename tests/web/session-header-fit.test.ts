/**
 * The session header's fit rules (web/src/components/sessions/session-header-fit.ts).
 *
 * A narrow column used to wrap the tool row one chip per line and run the title
 * row's pills over the phase circle (2026-10-02). Both rows now keep one line;
 * what leaves, and in what order, is decided here. The properties that matter:
 * the same width always gives the same answer (no flicker on resize), window
 * buttons leave before view chips, the "..." button never evicts a chip that fit
 * without it, and the title row steps down full → dot → letters before it hides
 * anything.
 */
import { describe, it, expect } from 'vitest';
import {
  fitToolRow, fitTitleMeta, classifyTitleMetaChild,
  ASSUMED_TOOL_WIDTH, ASSUMED_LETTER_WIDTH, ASSUMED_DOT_WIDTH,
  type ToolRowItem, type TitleMetaItem,
} from '../../web/src/components/sessions/session-header-fit';

const OPTS = { chipGap: 6, windowGap: 3, groupGap: 6, moreWidth: 22 };

/** The real row, widths as Chromium lays them out at 10px / 22px buttons. */
const ROW: ToolRowItem[] = [
  { id: 'fork', kind: 'chip', priority: 2, width: 42 },
  { id: 'changed', kind: 'chip', priority: 3, width: 58 },
  { id: 'files', kind: 'chip', priority: 4, width: 44 },
  { id: 'board', kind: 'chip', priority: 5, width: 46 },
  { id: 'terminal', kind: 'chip', priority: 6, width: 58 },
  { id: 'time', kind: 'info', priority: 7, width: 22 },
  { id: 'locate', kind: 'window', priority: 9, width: 22 },
  { id: 'lock', kind: 'window', priority: 10, width: 22 },
  { id: 'popout', kind: 'window', priority: 11, width: 22 },
  { id: 'expand', kind: 'fixed', priority: 0, width: 22 },
  { id: 'close', kind: 'fixed', priority: 0, width: 22 },
];
// Chips 248 + time 22 + 5 gaps 30 = 300; buttons 110 + 4 gaps 12 = 122; group gap 6.
const ROW_WIDTH = 428;

describe('fitToolRow', () => {
  it('shows everything when the row fits', () => {
    const full = fitToolRow(ROW, ROW_WIDTH, OPTS);
    expect(full.visible).toEqual(ROW.map((i) => i.id));
    expect(full.inMore).toEqual([]);
    expect(full.dropped).toEqual([]);
  });

  it('treats no room as no room, not as unknown (the hooks skip rows with no width)', () => {
    expect(fitToolRow(ROW, 0, OPTS).visible).toEqual(['fork', 'expand', 'close']);
    expect(fitToolRow(ROW, -50, OPTS).visible).toEqual(['fork', 'expand', 'close']);
  });

  it('never hides Expand or Close, whatever the width', () => {
    for (const w of [427, 380, 300, 200, 152, 60, 1]) {
      const r = fitToolRow(ROW, w, OPTS);
      expect(r.visible, `${w}px`).toContain('expand');
      expect(r.visible, `${w}px`).toContain('close');
    }
  });

  it('sends window buttons to the "..." menu before any chip leaves, in priority order', () => {
    // One pixel short: popout (11) goes, and the "..." button (22 + a gap) comes
    // with it, so lock (10) has to go too: 300 + 28 + (locate + expand + close
    // 66 + 2 gaps 6) + 6 = 406.
    const r1 = fitToolRow(ROW, ROW_WIDTH - 1, OPTS);
    expect(r1.inMore).toEqual(['lock', 'popout']);
    expect(r1.visible).toEqual(['fork', 'changed', 'files', 'board', 'terminal', 'time', 'locate', 'expand', 'close']);
    // 405: locate (9) is the last window button to go: 328 + 47 + 6 = 381.
    const r2 = fitToolRow(ROW, 405, OPTS);
    expect(r2.inMore).toEqual(['locate', 'lock', 'popout']);
    expect(r2.visible).toEqual(['fork', 'changed', 'files', 'board', 'terminal', 'time', 'expand', 'close']);
    expect(r2.dropped).toEqual([]);
  });

  it('hides the time before a view chip, and the time goes nowhere', () => {
    // 380: 1px short of the chips + time + "..." + the two fixed buttons. Time (7) leaves first:
    // 248 + 28 + 4 gaps 24 + 47 + 6 = 353.
    const r = fitToolRow(ROW, 380, OPTS);
    expect(r.dropped).toEqual(['time']);
    expect(r.inMore).toEqual(['locate', 'lock', 'popout']);
    expect(r.visible).toEqual(['fork', 'changed', 'files', 'board', 'terminal', 'expand', 'close']);
  });

  it('moves chips into the "..." menu lowest priority first, listed before the window buttons', () => {
    // 352: Terminal goes: 190 + 28 + 3 gaps 18 + 47 + 6 = 289.
    const r = fitToolRow(ROW, 352, OPTS);
    expect(r.inMore).toEqual(['terminal', 'locate', 'lock', 'popout']);
    expect(r.visible).toEqual(['fork', 'changed', 'files', 'board', 'expand', 'close']);
    // 237: Fork Changed Files + "..." + expand + close = 144 + 28 + 2 gaps 12 + 47 + 6 = 237 exactly.
    const r2 = fitToolRow(ROW, 237, OPTS);
    expect(r2.visible).toEqual(['fork', 'changed', 'files', 'expand', 'close']);
    expect(r2.inMore).toEqual(['board', 'terminal', 'locate', 'lock', 'popout']);
    // 152 (a 180px column): Fork + "..." + expand + close = 42 + 28 + 47 + 6 = 123; Changed (58 + 6) would need 187.
    const r3 = fitToolRow(ROW, 152, OPTS);
    expect(r3.visible).toEqual(['fork', 'expand', 'close']);
    expect(r3.inMore).toEqual(['changed', 'files', 'board', 'terminal', 'locate', 'lock', 'popout']);
  });

  it('stops at the first item that does not fit: the order is the contract', () => {
    // 200: Fork + Changed + "..." + expand + close = 100 + 28 + 6 + 47 + 6 = 187; Files (44 + 6)
    // does not fit, and neither does anything after it, even the 22px time that would have had room.
    const r = fitToolRow(ROW, 200, OPTS);
    expect(r.visible).toEqual(['fork', 'changed', 'expand', 'close']);
    expect(r.inMore).toEqual(['files', 'board', 'terminal', 'locate', 'lock', 'popout']);
    expect(r.dropped).toEqual(['time']);
  });

  it('keeps the top chip even where it does not fit', () => {
    const r = fitToolRow(ROW, 30, OPTS);
    expect(r.visible).toEqual(['fork', 'expand', 'close']);
  });

  it('lets Plan lead when the session has one', () => {
    const withPlan: ToolRowItem[] = [{ id: 'plan', kind: 'chip', priority: 1, width: 40 }, ...ROW];
    const r = fitToolRow(withPlan, 30, OPTS);
    expect(r.visible).toEqual(['plan', 'expand', 'close']);
    expect(r.inMore[0]).toBe('fork');
  });

  it('assumes a short chip for a width it has not measured', () => {
    const unmeasured = ROW.map((i) => (i.id === 'board' ? { ...i, width: undefined } : i));
    // Board priced at ASSUMED_TOOL_WIDTH (44) instead of 46: the full row is 2px narrower.
    expect(fitToolRow(unmeasured, ROW_WIDTH - 2, OPTS).inMore).toEqual([]);
    expect(ASSUMED_TOOL_WIDTH).toBe(44);
  });

  it('answers the same for the same width, however often it is asked', () => {
    for (const w of [430, 400, 350, 300, 250, 212, 180, 150, 100]) {
      const a = fitToolRow(ROW, w, OPTS);
      const b = fitToolRow(ROW, w, OPTS);
      expect(b).toEqual(a);
      // Every id is accounted for exactly once.
      const all = [...a.visible, ...a.inMore, ...a.dropped].sort();
      expect(all).toEqual(ROW.map((i) => i.id).sort());
    }
  });

  it('never gains an item as the row narrows', () => {
    let previous = new Set(fitToolRow(ROW, 500, OPTS).visible);
    for (let w = 499; w >= 60; w--) {
      const now = new Set(fitToolRow(ROW, w, OPTS).visible);
      for (const id of now) expect(previous.has(id), `${id} came back at ${w}px`).toBe(true);
      previous = now;
    }
  });
});

/** A busy task's title row: Trigger ×2, Worker, Leader · 13, Running, kebab. */
const META: TitleMetaItem[] = [
  { id: 'trigger', kind: 'trigger', fullWidth: 62, shortWidth: 16 },
  { id: 'worker', kind: 'worker', fullWidth: 52, shortWidth: 18 },
  { id: 'leader', kind: 'leader', fullWidth: 66, shortWidth: 16 },
  { id: 'status', kind: 'status', fullWidth: 62, shortWidth: 16 },
  { id: 'kebab', kind: 'kebab', fullWidth: 22 },
];
const GAP = 3;
// Full: 264 + 4 gaps 12 = 276. Dot: 230. Letters: 16+18+16+16+22 = 88 + 12 = 100.

describe('fitTitleMeta', () => {
  it('keeps the full words while they fit', () => {
    expect(fitTitleMeta(META, 276, GAP)).toEqual({ level: 'full', hidden: [] });
    expect(fitTitleMeta([], 0, GAP)).toEqual({ level: 'full', hidden: [] });
  });

  it('a row whose title companions already overflow it hides pills rather than fall back to words', () => {
    // 2026-10-02 review: a negative room used to read as "unknown" and return
    // 'full', which is exactly the overflow the change exists to end.
    const r = fitTitleMeta(META, -20, GAP);
    expect(r.level).toBe('letters');
    expect(r.hidden).toEqual(['trigger', 'worker', 'leader']);
  });

  it('shrinks the status badge to its dot first, then every pill to one letter', () => {
    expect(fitTitleMeta(META, 275, GAP).level).toBe('dot');
    expect(fitTitleMeta(META, 230, GAP).level).toBe('dot');
    expect(fitTitleMeta(META, 229, GAP).level).toBe('letters');
    expect(fitTitleMeta(META, 100, GAP)).toEqual({ level: 'letters', hidden: [] });
  });

  it('goes straight to letters when there is no status badge to shrink', () => {
    const noStatus = META.filter((i) => i.kind !== 'status');
    // Full 202 + 3 gaps 9 = 211.
    expect(fitTitleMeta(noStatus, 211, GAP).level).toBe('full');
    expect(fitTitleMeta(noStatus, 210, GAP).level).toBe('letters');
  });

  it('hides pills only when even the letters overflow, least important first', () => {
    // 99: one short of the letter row. Trigger (first in drop order) goes: 100 - 16 - 3 = 81.
    expect(fitTitleMeta(META, 99, GAP)).toEqual({ level: 'letters', hidden: ['trigger'] });
    // 60: trigger and worker go (81 - 21 = 60).
    expect(fitTitleMeta(META, 60, GAP)).toEqual({ level: 'letters', hidden: ['trigger', 'worker'] });
    // The status dot and the kebab are never hidden.
    const r = fitTitleMeta(META, 10, GAP);
    expect(r.hidden).toEqual(['trigger', 'worker', 'leader']);
  });

  it('keeps a pinned pill on the row and drops the next one instead', () => {
    // 99 hides trigger alone; pinned, trigger stays and worker (next in order) goes: 100 - 21 = 79.
    expect(fitTitleMeta(META, 99, GAP, { pinned: 'trigger' })).toEqual({ level: 'letters', hidden: ['worker'] });
    // A pin changes nothing while everything fits.
    expect(fitTitleMeta(META, 100, GAP, { pinned: 'trigger' })).toEqual({ level: 'letters', hidden: [] });
    expect(fitTitleMeta(META, 276, GAP, { pinned: 'leader' })).toEqual({ level: 'full', hidden: [] });
  });

  it('lets the letters squeeze the title to its floor before removing a pill', () => {
    // 99 is one short of the letter row; with 24px of slack the letters stay and the title gives.
    expect(fitTitleMeta(META, 99, GAP, { dropSlack: 24 })).toEqual({ level: 'letters', hidden: [] });
    expect(fitTitleMeta(META, 76, GAP, { dropSlack: 24 })).toEqual({ level: 'letters', hidden: [] });
    // Past the floor the drop order applies against the slackened room: 75 + 24 = 99 → trigger goes.
    expect(fitTitleMeta(META, 75, GAP, { dropSlack: 24 })).toEqual({ level: 'letters', hidden: ['trigger'] });
    // The slack is for letters only: the dot and full levels do not borrow from the title.
    expect(fitTitleMeta(META, 229, GAP, { dropSlack: 24 }).level).toBe('letters');
  });

  it('uses an assumed letter and dot width before those forms have been measured', () => {
    const unmeasured = META.map(({ shortWidth: _short, ...rest }) => rest);
    // Letters: 3 × 18 + 16 + 22 = 92 + 12 = 104.
    expect(fitTitleMeta(unmeasured, 104, GAP)).toEqual({ level: 'letters', hidden: [] });
    expect(fitTitleMeta(unmeasured, 103, GAP).hidden).toEqual(['trigger']);
    expect(ASSUMED_LETTER_WIDTH).toBe(18);
    expect(ASSUMED_DOT_WIDTH).toBe(16);
  });

  it('answers the same for the same width, and never steps back up as the row narrows', () => {
    const rank = { full: 0, dot: 1, letters: 2 };
    let last = -1;
    for (let w = 300; w >= 5; w--) {
      const a = fitTitleMeta(META, w, GAP);
      expect(fitTitleMeta(META, w, GAP)).toEqual(a);
      expect(rank[a.level]).toBeGreaterThanOrEqual(last);
      last = rank[a.level];
    }
  });
});

describe('classifyTitleMetaChild', () => {
  const cl = (...names: string[]) => ({ contains: (n: string) => names.includes(n) });
  it('names each child by its component class, the embedded badge by its data attribute', () => {
    expect(classifyTitleMetaChild(cl('session-panel-badge'), { headerPill: 'embedded' })).toBe('embedded');
    expect(classifyTitleMetaChild(cl('session-panel-badge'), {})).toBe('status');
    expect(classifyTitleMetaChild(cl('session-cron-pill'), {})).toBe('cron');
    expect(classifyTitleMetaChild(cl('task-trigger-pill'), {})).toBe('trigger');
    expect(classifyTitleMetaChild(cl('task-team-pill', 'todo-item-subtask-pill'), {})).toBe('worker');
    expect(classifyTitleMetaChild(cl('task-team-pill', 'todo-item-leader-pill'), {})).toBe('leader');
    expect(classifyTitleMetaChild(cl('task-quick-actions'), {})).toBe('kebab');
    expect(classifyTitleMetaChild(cl('thread-stack-more'), {})).toBe('other');
  });
});
