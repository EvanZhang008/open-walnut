/**
 * Cut-off rows show their full text in place (web/src/utils/truncation-peek.ts; 2026-11-12,
 * the user, on a Home row's dark native tooltip: "I want it to actually make the full line
 * expanded like what we did for side bar"). Two guards:
 * - no element keeps a native `title` that only repeats its own text: that title was how a
 *   truncated row showed its full text, and it would now open a dark box over the pill (or
 *   repeat text in full view). A new row written that way fails here; drop the title, the peek
 *   needs nothing, or mark the element `data-peek="off"` if it must keep it;
 * - the pill's placement never leaves the window and grows out from the text's own spot.
 */
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { findRepeatedTitles, findTaskTitleSites } from './truncation-peek-scan';
import { PEEK_EDGE, PEEK_PAD_X, PEEK_PAD_Y, placePeek, placeVertically } from '../../web/src/utils/truncation-peek-place';

const WEB_SRC = path.resolve(__dirname, '../../web/src');

describe('truncated rows rely on the in-place peek, not a native title', () => {
  it('no element carries a title that only repeats its own text', () => {
    const found = findRepeatedTitles(WEB_SRC).map((r) => `${r.file}:${r.line} <${r.tag} title=${r.title}>`);
    expect(found, 'A title that repeats the element\'s text is the native tooltip a cut-off row used. Remove it: utils/truncation-peek.ts shows the full text in place').toEqual([]);
  });

  it('the scan finds the shapes it is meant to find', async () => {
    const fs = await import('node:fs');
    const os = await import('node:os');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'peek-scan-'));
    fs.writeFileSync(path.join(dir, 'Row.tsx'), [
      'export const A = ({ t }: { t: string }) => <span className="x" title={t}>{t}</span>;',
      'export const B = () => <button title="Dismiss">Dismiss</button>;',
      'export const C = ({ t }: { t: string }) => <span title={`Go to ${t}`}>{t}</span>;',
      'export const D = ({ t }: { t: string }) => <span data-peek="off" title={t}>{t}</span>;',
      'export const E = ({ t }: { t: string }) => (',
      '  <span title={t}>',
      '    {t}',
      '  </span>',
      ');',
    ].join('\n'));
    try {
      expect(findRepeatedTitles(dir).map((r) => r.line)).toEqual([1, 2, 6]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

/**
 * A task row expands as a whole (2026-11-12, the user: "只要是我要放在这个 task 上面，它就会整体
 * expand"): the pointer anywhere on a row marked `data-peek-row` shows every cut-off text in it.
 * Each element that cuts off a task's title sits in such a row, or is listed here with why not.
 * Keyed by file and class, so a moved line does not fail; a stale entry does.
 */
const NOT_A_ROW: Record<string, string> = {
  'components/board/kanban/KanbanCard.tsx kanban-card-title': 'a Board card has its own hover card (useHoverAnchor); its title still peeks when hovered itself',
  'components/calendar/CalendarItemPopover.tsx cal-item-title-static': 'the heading of an open popover, not a row; it peeks when hovered itself',
  'components/sessions/SessionBrowserCard.tsx session-browser-tab': 'a web page tab of the agent browser, not a task',
  'components/tasks/TodoPanel.tsx todo-item-title': 'TaskItemOverlay: the copy that follows the pointer in a drag, never hovered (the other todo-item-title is in the marked list row)',
  'components/tasks/TodoPanel.tsx todo-pinned-title': 'the pinned card drag overlay, never hovered (the pinned card itself is marked)',
  'components/tasks/AdoptWorkerFlyout.tsx adopt-worker-title': 'the heading of the Adopt dialog, not a row; it peeks when hovered itself',
  'components/tasks/ReleaseWorkerFlyout.tsx adopt-worker-title': 'the heading of the Release dialog, not a row; it peeks when hovered itself',
  'components/tasks/LeaderPill.tsx leader-subtasks-title': 'the heading of the Leader flyout, not a row; its subtask rows are marked',
  'components/tasks/SubtaskPill.tsx task-worker-parent': 'a pill drawn inside a task row, which is marked where the row is built',
  'components/common/NotificationToaster.tsx notification-toast-title': 'a toast that comes and goes, not a list row; it peeks when hovered itself',
};

describe('a task row whose text is cut off expands as a whole', () => {
  it('every element that cuts off a task title is in a data-peek-row row, or listed with why', () => {
    const sites = findTaskTitleSites(WEB_SRC);
    const keyOf = (s: { file: string; classes: string[] }) => `${s.file} ${s.classes[0]}`;
    const outside = sites.filter((s) => !s.inRow).filter((s) => !NOT_A_ROW[keyOf(s)]).map((s) => `${s.file}:${s.line} .${s.classes.join('.')}`);
    expect(outside, 'Mark the row this title sits in with data-peek-row="" (utils/truncation-peek.ts expands it on hover anywhere), or list it in NOT_A_ROW with why').toEqual([]);
    const listed = new Set(sites.filter((s) => !s.inRow).map(keyOf));
    // TodoPanel holds marked rows too: an entry is stale only when no unmarked site of it is left.
    expect(Object.keys(NOT_A_ROW).filter((k) => !listed.has(k)), 'stale NOT_A_ROW entries').toEqual([]);
    // The rows of the report are found, so the scan is reading what it should.
    const rows = new Set(sites.filter((s) => s.inRow).map((s) => s.file));
    for (const f of ['components/tasks/StatusSections.tsx', 'components/tasks/TodoPanel.tsx', 'components/tasks/FocusSatelliteCards.tsx', 'components/tasks/WorkerFoldTree.tsx', 'components/org/OrgChannelList.tsx', 'components/org/OrgTaskRail.tsx']) expect(rows.has(f), f).toBe(true);
  });
});

describe('placePeek', () => {
  const vp = { width: 1280, height: 800 };

  it('keeps the text on its own spot and grows to the right on one line', () => {
    const box = placePeek({ left: 100, top: 50 }, 400, 200, vp);
    expect(box.left).toBe(100 - PEEK_PAD_X);
    expect(box.top).toBe(50 - PEEK_PAD_Y);
    expect(box.width).toBe(400 + PEEK_PAD_X * 2);
  });

  it('stays one line as far as the window allows, and wraps only past its width', () => {
    expect(placePeek({ left: 100, top: 50 }, 900, 200, vp).width).toBe(900 + PEEK_PAD_X * 2);
    const wide = placePeek({ left: 100, top: 50 }, 3000, 200, vp);
    expect(wide.width).toBe(vp.width - PEEK_EDGE * 2);
    expect(wide.left).toBe(PEEK_EDGE);
  });

  it('moves left, never past the window, when the room on the right is too narrow', () => {
    const box = placePeek({ left: 1100, top: 50 }, 600, 120, vp);
    expect(box.left + box.width).toBeLessThanOrEqual(vp.width - PEEK_EDGE);
    expect(box.width).toBe(600 + PEEK_PAD_X * 2);
  });

  it('fits a window narrower than the widest pill', () => {
    const narrow = { width: 400, height: 800 };
    const box = placePeek({ left: 30, top: 50 }, 2000, 100, narrow);
    expect(box.left).toBeGreaterThanOrEqual(PEEK_EDGE);
    expect(box.left + box.width).toBeLessThanOrEqual(narrow.width - PEEK_EDGE);
  });

  it('never narrower than what the row showed', () => {
    expect(placePeek({ left: 100, top: 50 }, 150, 300, vp).width).toBe(300 + PEEK_PAD_X * 2);
  });

  it('moves up when a wrapped pill would pass the bottom, never above the top edge', () => {
    const box = placePeek({ left: 100, top: 760 }, 3000, 200, vp);
    const placed = placeVertically(box, 120, vp.height);
    expect(placed.top + placed.height).toBeLessThanOrEqual(vp.height - PEEK_EDGE);
    expect(placeVertically(box, 2000, vp.height).top).toBe(PEEK_EDGE);
    expect(placeVertically(placePeek({ left: 100, top: 50 }, 300, 200, vp), 24, vp.height).top).toBe(50 - PEEK_PAD_Y);
  });
});
