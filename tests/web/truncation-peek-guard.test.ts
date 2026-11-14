/**
 * Cut-off rows show their full text in place (web/src/utils/truncation-peek.ts; 2026-11-12,
 * the user, on a Home row's dark native tooltip: "I want it to actually make the full line
 * expanded like what we did for side bar"). Two guards:
 * - no element keeps a native `title` that only repeats its own text: that title was how a
 *   truncated row showed its full text, and it would now open a dark box over the component (or
 *   repeat text in full view). A new row written that way fails here; drop the title, the peek
 *   needs nothing, or mark the element `data-peek="off"` if it must keep it;
 * - every shared peek grows its container in flow, never a floating clone of its text.
 */
import path from 'node:path';
import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { findRepeatedTitles, findTaskTitleSites } from './truncation-peek-scan';

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
  'components/board/kanban/KanbanCard.tsx kanban-card-title': 'a loading skeleton, or the drag overlay whose row marker is disabled at runtime; real Board cards carry data-peek-row',
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

describe('all truncation peeks grow their container, never cloned text', () => {
  it('the shared renderer has only the in-flow path, including new unmarked components', () => {
    const source = fs.readFileSync(path.join(WEB_SRC, 'utils/truncation-peek.ts'), 'utf8');
    expect(source).toContain('state.marked = expandRow(state.key, state.hosts)');
    expect(source).toContain('const key = host.closest(CONTROL) ?? host.parentElement ?? host');
    expect(source).not.toMatch(/createElement|cloneNode|appendChild|renderPill|placePeek|MAX_ROW_HOSTS/);
    const css = fs.readFileSync(path.join(WEB_SRC, 'styles/truncation-peek.css'), 'utf8');
    expect(css).not.toMatch(/position:\s*(fixed|absolute)|z-index|\.truncation-peek/);
    expect(css).toContain('[data-peek-open]');
    expect(css).toMatch(/\[data-peek-flow\]\s*\{[^}]*flex-wrap:\s*wrap\s*!important/);
    const row = fs.readFileSync(path.join(WEB_SRC, 'utils/truncation-peek-row.ts'), 'utf8');
    expect(row).toContain('mark(el, el === h.parentElement ? LINE_ATTR : FLOW_ATTR)');
    expect(row).toContain("if (cs.maxWidth !== 'none') mark(el, FIT_ATTR)");
    const calendar = fs.readFileSync(path.join(WEB_SRC, 'components/calendar/CalendarChip.tsx'), 'utf8');
    expect(calendar).toContain("data-peek={style?.top !== undefined ? 'off' : undefined}");
    expect(calendar).not.toMatch(/\btitle=\{/);
  });

  it('every truncated letter subject belongs to a whole expandable card', () => {
    const sites = findTaskTitleSites(WEB_SRC, /\bletter\.subject\b/);
    expect(sites.length).toBeGreaterThan(0);
    expect(sites.filter((s) => !s.inRow).map((s) => `${s.file}:${s.line}`)).toEqual([]);
    const worker = fs.readFileSync(path.join(WEB_SRC, 'components/tasks/SubtaskPill.tsx'), 'utf8');
    expect(worker).toContain('className="task-worker-parent"');
    const acceptance = fs.readFileSync(path.resolve(__dirname, '../e2e/browser/inbox-card-peek.spec.ts'), 'utf8');
    expect(acceptance).toContain("openInRow(row.locator('.task-worker-parent'))");
    expect(acceptance).toContain('expect(meta.y + meta.height).toBeLessThanOrEqual(title.y + 1)');
  });
});
