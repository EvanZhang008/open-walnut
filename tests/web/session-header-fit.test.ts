/**
 * The session header's fit rules (web/src/components/sessions/session-header-fit.ts).
 *
 * A narrow column used to wrap the tool row one chip per line and run the title
 * row's pills over the phase circle (2026-10-02). Both rows now keep one line;
 * what leaves, and in what order, is decided here. The properties that matter:
 * the same width always gives the same answer (no flicker on resize), the view
 * chips leave in priority order and never come back as the row narrows, the
 * window buttons fill whatever room the chips leave (no button-sized hole beside
 * the "..." menu), Lock, Expand and Close never leave, and the title row steps
 * down full → dot → letters before it hides anything.
 */
import { describe, it, expect } from 'vitest';
import { TOOL_ITEMS } from '../../web/src/components/sessions/useSessionHeaderFit';
import {
  fitToolRow, toolRowWidth, fitTitleMeta, classifyTitleMetaChild,
  ASSUMED_TOOL_WIDTH, ASSUMED_WINDOW_WIDTH, ASSUMED_LETTER_WIDTH, ASSUMED_DOT_WIDTH,
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
  { id: 'popout', kind: 'window', priority: 10, width: 22 },
  { id: 'lock', kind: 'fixed', priority: 0, width: 22 },
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
    expect(fitToolRow(ROW, 0, OPTS).visible).toEqual(['fork', 'lock', 'expand', 'close']);
    expect(fitToolRow(ROW, -50, OPTS).visible).toEqual(['fork', 'lock', 'expand', 'close']);
  });

  it('never hides Lock, Expand or Close, whatever the width', () => {
    for (const w of [427, 380, 300, 200, 152, 60, 1]) {
      const r = fitToolRow(ROW, w, OPTS);
      for (const id of ['lock', 'expand', 'close']) expect(r.visible, `${id} at ${w}px`).toContain(id);
      expect(r.inMore, `${w}px`).not.toContain('lock');
    }
  });

  it('drops the time first, and the time goes nowhere', () => {
    // 427: 1px short of everything. Chips 248 + 5 gaps 30 + time... the time (22 + a gap) is the one
    // thing that does not fit: chips without it 248 + 4 gaps 24 = 272, five buttons 110 + 4 gaps 12 = 122,
    // group gap 6 → 400. No "..." button is needed, so none is paid for.
    const r = fitToolRow(ROW, ROW_WIDTH - 1, OPTS);
    expect(r.dropped).toEqual(['time']);
    expect(r.inMore).toEqual([]);
    expect(r.visible).toEqual(['fork', 'changed', 'files', 'board', 'terminal', 'locate', 'popout', 'lock', 'expand', 'close']);
    expect(fitToolRow(ROW, 400, OPTS).inMore).toEqual([]);
  });

  it('sends the two movable window buttons to the "..." menu before any chip leaves', () => {
    // 399: the "..." button (22 + a gap) comes with the first hidden button, and then there is
    // room for neither: chips 248 + "..." 22 + 5 gaps 30 = 300; Lock, Expand, Close 66 + 2 gaps 6 = 72;
    // group gap 6 → 378. One more button (97 + 300 + 6 = 403) does not fit.
    const r = fitToolRow(ROW, 399, OPTS);
    expect(r.inMore).toEqual(['locate', 'popout']);
    expect(r.visible).toEqual(['fork', 'changed', 'files', 'board', 'terminal', 'lock', 'expand', 'close']);
    expect(r.dropped).toEqual(['time']);
    expect(fitToolRow(ROW, 378, OPTS).inMore).toEqual(['locate', 'popout']);
  });

  it('moves chips into the "..." menu lowest priority first, listed before the window buttons', () => {
    // 377: Terminal goes (chips with it need 378). The room it frees takes both window buttons back:
    // Fork..Board 190 + "..." 22 + 4 gaps 24 = 236; five buttons 122; group gap 6 → 364.
    const r = fitToolRow(ROW, 377, OPTS);
    expect(r.inMore).toEqual(['terminal']);
    expect(r.visible).toEqual(['fork', 'changed', 'files', 'board', 'locate', 'popout', 'lock', 'expand', 'close']);
    // 363 lets go of Open in new tab first (Locate alone: 236 + 97 + 6 = 339), then of Locate below that.
    expect(fitToolRow(ROW, 363, OPTS).inMore).toEqual(['terminal', 'popout']);
    expect(fitToolRow(ROW, 339, OPTS).inMore).toEqual(['terminal', 'popout']);
    expect(fitToolRow(ROW, 338, OPTS).inMore).toEqual(['terminal', 'locate', 'popout']);
    // 313: Board goes; Files stays down to 262 (144 + 22 + 3 gaps 18 + 72 + 6).
    const r2 = fitToolRow(ROW, 285, OPTS);
    expect(r2.visible).toEqual(['fork', 'changed', 'files', 'lock', 'expand', 'close']);
    expect(r2.inMore).toEqual(['board', 'terminal', 'locate', 'popout']);
    expect(fitToolRow(ROW, 262, OPTS).visible).toContain('files');
    // 152 (a 180px column): Fork + "..." + Lock, Expand, Close = 42 + 28 + 72 + 6 = 148; Changed (58 + 6) would need 212.
    const r3 = fitToolRow(ROW, 152, OPTS);
    expect(r3.visible).toEqual(['fork', 'lock', 'expand', 'close']);
    expect(r3.inMore).toEqual(['changed', 'files', 'board', 'terminal', 'locate', 'popout']);
  });

  it('stops the chips at the first that does not fit: the order is the contract', () => {
    // 150: Fork + "..." + Lock, Expand, Close = 42 + 28 + 72 + 6 = 148; Changed (58 + 6) does not fit.
    // The two window buttons do not fit either (one more button is 148 + 25 = 173).
    const r = fitToolRow(ROW, 150, OPTS);
    expect(r.visible).toEqual(['fork', 'lock', 'expand', 'close']);
    expect(r.inMore).toEqual(['changed', 'files', 'board', 'terminal', 'locate', 'popout']);
    expect(r.dropped).toEqual(['time']);
    // 200: Fork + "..." 70 + five buttons 122 + group gap 6 = 198: the buttons fill, the chips still stop at
    // Changed (Files, 44 wide, would need 198 + 64 + 50 and could not fit by skipping either).
    const r2 = fitToolRow(ROW, 200, OPTS);
    expect(r2.visible).toEqual(['fork', 'locate', 'popout', 'lock', 'expand', 'close']);
    expect(r2.inMore).toEqual(['changed', 'files', 'board', 'terminal']);
  });

  it('never leaves room for a window button that is in the menu', () => {
    // The 2026-10-04 report: a gap beside the "..." menu big enough for the buttons it held. Whatever
    // the width, the room left after the visible items is smaller than one more button and its gap.
    let checked = 0;
    for (let w = 150; w <= ROW_WIDTH; w++) {
      const r = fitToolRow(ROW, w, OPTS);
      if (!r.inMore.some((id) => id === 'locate' || id === 'popout')) continue;
      const spare = w - toolRowWidth(ROW.filter((i) => r.visible.includes(i.id)), true, OPTS);
      expect(spare, `${w}px: ${spare}px spare while a window button sits in the menu`).toBeLessThan(22 + OPTS.windowGap);
      checked++;
    }
    expect(checked).toBeGreaterThan(100);
  });

  it('fills the room a wide hidden chip leaves with the window buttons (the 2026-10-04 report)', () => {
    // A heavy session wears a 90px pill (priority 8, after Terminal). With all five chips on the row it is
    // the first item that does not fit; the old strict prefix stopped there and left Locate, Open in new
    // tab and Lock in the menu beside 60px of empty row.
    const heavy: ToolRowItem = { id: 'resources', kind: 'chip', priority: 8, width: 90 };
    const row = ROW.filter((i) => i.id !== 'time');
    const withHeavy = [...row.slice(0, 5), heavy, ...row.slice(5)];
    // Five chips 248 + "..." 22 + 5 gaps 30 = 300; Lock, Expand, Close 72; group gap 6 → 378, plus Locate 25 → 403.
    const r = fitToolRow(withHeavy, 403, OPTS);
    expect(r.inMore).toEqual(['resources', 'popout']);
    expect(r.visible).toEqual(['fork', 'changed', 'files', 'board', 'terminal', 'locate', 'lock', 'expand', 'close']);
    expect(fitToolRow(withHeavy, 428, OPTS).visible).toContain('popout');
    // The chips stay in order: Heavy never jumps the queue, and Terminal is not evicted for it.
    for (let w = 150; w <= 540; w++) {
      const v = fitToolRow(withHeavy, w, OPTS).visible;
      if (v.includes('resources')) expect(v, `${w}px`).toContain('terminal');
    }
  });

  it('never brings the time back as the row narrows', () => {
    const withHeavy = [...ROW.slice(0, 6), { id: 'resources', kind: 'chip', priority: 8, width: 90 } as ToolRowItem, ...ROW.slice(6)];
    let seenGone = false;
    for (let w = 700; w >= 100; w--) {
      const has = fitToolRow(withHeavy, w, OPTS).visible.includes('time');
      if (!has) seenGone = true;
      else expect(seenGone, `the time came back at ${w}px`).toBe(false);
    }
  });

  it('keeps Lock out of the window group: it is a fixed item, like Expand and Close', () => {
    expect(TOOL_ITEMS.lock!.kind).toBe('fixed');
    expect(TOOL_ITEMS.expand!.kind).toBe('fixed');
    expect(TOOL_ITEMS.close!.kind).toBe('fixed');
    expect(Object.entries(TOOL_ITEMS).filter(([, v]) => v.kind === 'window').map(([k]) => k).sort()).toEqual(['locate', 'popout']);
  });

  it('keeps the top chip even where it does not fit', () => {
    const r = fitToolRow(ROW, 30, OPTS);
    expect(r.visible).toEqual(['fork', 'lock', 'expand', 'close']);
  });

  it('lets Plan lead when the session has one', () => {
    const withPlan: ToolRowItem[] = [{ id: 'plan', kind: 'chip', priority: 1, width: 40 }, ...ROW];
    const r = fitToolRow(withPlan, 30, OPTS);
    expect(r.visible).toEqual(['plan', 'lock', 'expand', 'close']);
    expect(r.inMore[0]).toBe('fork');
  });

  it('assumes a 24px button, not a chip, for a window button that has never been on screen', () => {
    // A panel drawn narrow from its first frame never shows Locate, Open in new tab, Lock, Expand or
    // Close to be measured. 2026-10-04 they were priced like chips (44 each), so a 70px gap sat beside
    // a "..." menu that held three of them. Fork..Board 190 + 3 gaps 18 = 208; 5 buttons 120 + 4 gaps
    // 12 = 132; group gap 6 → 346 (446 at 44px each).
    const unmeasured = ROW
      .filter((i) => i.id !== 'terminal' && i.id !== 'time')
      .map((i) => (i.kind === 'window' || i.kind === 'fixed' ? { ...i, width: undefined } : i));
    expect(ASSUMED_WINDOW_WIDTH).toBe(24);
    expect(fitToolRow(unmeasured, 346, OPTS).inMore).toEqual([]);
    expect(fitToolRow(unmeasured, 345, OPTS).visible).toContain('lock');
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

  it('never gains a chip as the row narrows; a window button returns only where a chip left', () => {
    const chipIds = ROW.filter((i) => i.kind === 'chip' || i.kind === 'info').map((i) => i.id);
    const shownChips = (visible: string[]) => visible.filter((id) => chipIds.includes(id));
    let previous = fitToolRow(ROW, 500, OPTS).visible;
    for (let w = 499; w >= 60; w--) {
      const now = fitToolRow(ROW, w, OPTS).visible;
      for (const id of shownChips(now)) expect(previous.includes(id), `${id} came back at ${w}px`).toBe(true);
      for (const id of ['locate', 'popout']) {
        if (now.includes(id) && !previous.includes(id)) {
          expect(shownChips(now).length, `${id} came back at ${w}px with no chip gone`).toBeLessThan(shownChips(previous).length);
        }
      }
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
