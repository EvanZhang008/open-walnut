/**
 * Cut-off rows show their full text in place (web/src/utils/truncation-peek.ts; 2026-11-12,
 * the user, on a Home row's dark native tooltip: "I want it to actually make the full line
 * expanded like what we did for side bar"). Two guards:
 * - no element keeps a native `title` that only repeats its own text: that title was how a
 *   truncated row showed its full text, and it would now open a dark box over the component (or
 *   repeat text in full view). A new row written that way fails here; drop the title, the peek
 *   needs nothing, or mark the element `data-peek="off"` if it must keep it;
 * - every shared peek widens the real row sideways in the top layer (2026-11-15, the user: the
 *   whole card gets wider, not taller), never a floating clone of its text. The one exception is
 *   a card a person types into: it opens downward in its own column, capped at 1.5 times its
 *   height (2026-11-20; tests/web/peek-card-grows-down-guard.test.ts).
 */
import path from 'node:path';
import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { findRepeatedTitles, findTaskTitleSites, walk } from './truncation-peek-scan';

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
  // Task titles that wrap (`.wn-title`, 2026-11-21) cut nothing and need no entry: the list row's
  // drag copy, the Adopt and Release headings, the Leader flyout's heading.
  'components/board/kanban/KanbanCard.tsx kanban-card-title': 'a loading skeleton, or the drag overlay whose row marker is disabled at runtime; real Board cards carry data-peek-row',
  'components/calendar/CalendarItemPopover.tsx cal-item-title-static': 'the heading of an open popover, not a row; it peeks when hovered itself',
  'components/sessions/SessionBrowserCard.tsx session-browser-tab-label': 'a web page tab of the agent browser, not a task',
  'components/tasks/TodoPanel.tsx todo-pinned-title': 'the pinned card drag overlay, never hovered (the pinned card itself is marked)',
  // The Worker pill's leader name is metadata (`.wn-meta`, text-fit.css), cut only when the row has no room.
  'components/tasks/SubtaskPill.tsx wn-meta': 'a pill drawn inside a task row, which is marked where the row is built',
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
    for (const f of ['components/tasks/StatusSections.tsx', 'components/tasks/TodoPanel.tsx', 'components/tasks/FocusSatelliteCards.tsx']) expect(rows.has(f), f).toBe(true);
    // These rows' titles wrap now (`.wn-title`, 9b60109d6c: titles never cut, only metadata), so the scan
    // finds no cut title in them; their rows stay marked, since their metadata can still be cut.
    for (const f of ['components/tasks/WorkerFoldTree.tsx', 'components/org/OrgChannelList.tsx', 'components/org/OrgTaskRail.tsx']) {
      expect(fs.readFileSync(path.join(WEB_SRC, f), 'utf8'), f).toContain('data-peek-row=""');
    }
  });
});

describe('all truncation peeks widen the real row, never taller, never cloned text', () => {
  const read = (p: string) => fs.readFileSync(path.join(WEB_SRC, p), 'utf8');

  it('one expandRow path opens the real row in the top layer over an empty placeholder', () => {
    const source = read('utils/truncation-peek.ts');
    // What the pointer peeks is read in truncation-peek-find.ts; the controller opens it.
    const find = read('utils/truncation-peek-find.ts');
    expect(source).toContain('state.marked = expandRow(state.key, state.hosts)');
    // The container is one that draws its own box: an inline span around the text is passed over
    // (2026-11-16, session-panel-narrow R5: its placeholder held one line of a sentence).
    expect(find).toContain('const key = boxOf(host.closest(CONTROL) ?? host.parentElement ?? host)');
    expect(find).toMatch(/function boxOf\(el: Element\): Element \{[\s\S]*?\^\(inline\|contents\)\$/);
    // No text clone, pill or second renderer beside the row path.
    for (const src of [source, find]) expect(src).not.toMatch(/createElement|cloneNode|appendChild|renderPill|placePeek|MAX_ROW_HOSTS/);
    // The row module is the only one that opens a row.
    const users = walk(WEB_SRC, [], /\.tsx?$/).filter((f) => /\bexpandRow\(/.test(fs.readFileSync(f, 'utf8'))).map((f) => path.relative(WEB_SRC, f)).sort();
    expect(users).toEqual(['utils/truncation-peek-row.ts', 'utils/truncation-peek.ts']);
    const row = read('utils/truncation-peek-row.ts');
    expect(row).toContain("row.setAttribute('popover', 'manual')");
    expect(row).toContain('row.showPopover()');
    // The placeholder is a bare element of the row's tag: nothing copied from the row, so no row
    // selector finds it (2026-11-16, mail-context-independent V-C42: `.mail-row` matched it first).
    expect(row).toContain('document.createElement(row.localName)');
    expect(row).not.toMatch(/cloneNode/);
    expect(row).toContain("'data-peek-placeholder'");
    expect(row).toContain("'--peek-height', `${rect.height}px`");
    // Nothing scrolls the list to make up for a height that no longer changes.
    expect(row).not.toMatch(/scrollTop|inListBelow|GROW_ATTR|FLOW_ATTR|LINE_ATTR/);
  });

  it('the styles hold the exact height and keep every open text on one line', () => {
    const css = read('styles/truncation-peek.css');
    expect(css).toMatch(/\[data-peek-expanded\][^{]*\{[^}]*height:\s*var\(--peek-height, 0\)\s*!important/);
    expect(css).toMatch(/\[data-peek-open\]\s*\{[^}]*white-space:\s*nowrap\s*!important/);
    expect(css).toContain('[data-peek-placeholder]');
    const split = read('styles/inbox-split.css');
    // Hover-only actions reserve their row: visibility changes, display never inserts a line.
    expect(split).not.toMatch(/\.hib-(?:index-row|inbox-pane)[^{]*\.hib-row-actions\s*\{[^}]*display:\s*none/);
    expect(split).toContain('visibility: hidden');
    expect(split).toContain('visibility: visible');
    const row = read('utils/truncation-peek-row.ts');
    expect(row).toContain('duration: 160');
    expect(read('utils/truncation-peek.ts')).toContain('const ROW_OPEN_MS = 140');
    expect(row).toContain('rect.right - width');
    // The old vertical peek: wrapping text and rows that take the height of what they hold. A card
    // that grows downward has its own stylesheet (truncation-peek-down.css), scoped to its texts.
    expect(css).not.toMatch(/height:\s*auto|flex-wrap:\s*wrap|white-space:\s*normal|overflow-wrap:\s*anywhere/);
    expect(css).not.toMatch(/\.truncation-peek\b/);
    const calendar = read('components/calendar/CalendarChip.tsx');
    expect(calendar).toContain("data-peek={style?.top !== undefined ? 'off' : undefined}");
    expect(calendar).not.toMatch(/\btitle=\{/);
  });

  it('a letter subject is a title that wraps, and any still cut belongs to a whole expandable card', () => {
    // 2026-11-21 (standard.md "Text that does not fit"): the inbox card's subject is .wn-title, so it
    // no longer cuts and the peek has nothing to open on it.
    expect(read('components/inbox/LetterEnvelopeRow.tsx')).toContain('className="hib-subject hib-subject-open wn-title"');
    const sites = findTaskTitleSites(WEB_SRC, /\bletter\.subject\b/);
    expect(sites.filter((s) => !s.inRow).map((s) => `${s.file}:${s.line}`)).toEqual([]);
    const worker = read('components/tasks/SubtaskPill.tsx');
    expect(worker).toContain('className="task-worker-parent wn-meta"');
    // The acceptance of both: the shared flows in truncation-peek-helpers.ts.
    const browser = path.resolve(__dirname, '../e2e/browser');
    const helpers = fs.readFileSync(path.join(browser, 'truncation-peek-helpers.ts'), 'utf8');
    expect(helpers).toContain("openInRow(row.locator('.task-worker-parent'))");
    expect(helpers).toContain('the metadata stays above the title');
    const acceptance = fs.readFileSync(path.join(browser, 'inbox-card-peek.spec.ts'), 'utf8');
    expect(acceptance).toContain('expectWorkerRowWidens(');
    expect(acceptance).toContain('expectInboxCardWhole(');
  });
});
