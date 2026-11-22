/**
 * Big menus have one shape (standard.md, "Big menus"; web/src/utils/menu-shape.ts).
 *
 * 2026-11-22, the UI audit on a copy of the user's data: the session ⋮ menu mixed layout, task state,
 * dates, moves, team, Delete and session tools in one list cut by seven rules, Delete above the
 * session's own group; the task row menu had five rules and no order of importance; the composer +
 * menu cut five kinds of row apart with four rules; the file tree and the notes tree put Delete in
 * the middle of their menus.
 *
 * Guarded three ways:
 *   1. the shape check itself (each rule fires on the shape it forbids);
 *   2. ContextMenu has the shape by construction: `normalizeContextMenuItems` puts the danger rows
 *      last under one rule and drops a rule above a heading, whatever order a caller lists;
 *   3. every menu surface is found from the source and must be classified here, so a NEW menu
 *      is seen: a ContextMenu caller (ordered by construction; the long ones also run the check over
 *      their item builder), or a hand-built `wn-menu` box (the big ones are measured as drawn by
 *      tests/e2e/browser/big-menu-shape.spec.ts, or, for the file and notes trees, read from the
 *      source; the rest are short lists or pickers of one kind).
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { normalizeContextMenuItems, type ContextMenuItem } from '../../web/src/utils/context-menu';
import { contextMenuShape, menuShapeProblems, MAX_BARE_RULES, MAX_MENU_ROWS, type MenuShapeRow } from '../../web/src/utils/menu-shape';

const ROOT = path.resolve(__dirname, '../..');
const WEB_SRC = path.join(ROOT, 'web/src');

const item = (label: string, danger = false): MenuShapeRow => ({ kind: 'item', label, danger });
const rule: MenuShapeRow = { kind: 'divider' };
const heading = (label: string): MenuShapeRow => ({ kind: 'heading', label });
const eight = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].map((l) => item(l));

describe('the big-menu shape check', () => {
  it('leaves a short menu alone', () => {
    expect(menuShapeProblems([item('Delete', true), item('a'), rule, rule, rule, rule, rule])).toEqual([]);
  });

  it('passes the shape: everyday rows, a heading, the groups, Delete last under its rule', () => {
    expect(menuShapeProblems([...eight.slice(0, 4), heading('Task'), ...eight.slice(4), rule, item('Delete task', true)])).toEqual([]);
  });

  it('fails a danger row before other rows', () => {
    expect(menuShapeProblems([...eight.slice(0, 4), rule, item('Delete', true), rule, ...eight.slice(4)]).join('\n')).toMatch(/danger rows go last/);
  });

  it('fails a danger row with no rule of its own', () => {
    expect(menuShapeProblems([...eight, item('Delete', true)]).join('\n')).toMatch(/no rule above it/);
  });

  it('fails a rule above a heading, and a heading with nothing under it', () => {
    const p = menuShapeProblems([...eight.slice(0, 4), rule, heading('Kind'), ...eight.slice(4), heading('Empty')]).join('\n');
    expect(p).toMatch(/rule above the heading "Kind"/);
    expect(p).toMatch(/heading "Empty" has no row/);
  });

  it(`fails more than ${MAX_BARE_RULES} bare rules, and more than ${MAX_MENU_ROWS} rows`, () => {
    const cut = eight.flatMap((r, i) => (i % 2 ? [r, rule] : [r]));
    expect(menuShapeProblems(cut).join('\n')).toMatch(/bare rules/);
    expect(menuShapeProblems([...eight, ...eight, item('x')]).join('\n')).toMatch(/17 first-level rows/);
  });

  it('reads a run of pills as one row, a setting row as a group, an info line as a name', () => {
    const items: ContextMenuItem[] = [
      { key: 'p1', label: 'Focus', pill: { group: 'pin', label: 'Pinned' } },
      { key: 'p2', label: 'Satellite', pill: { group: 'pin', label: 'Pinned' } },
      { key: 'project', label: 'Project', value: 'Inbox', onSelect: () => {} },
      { divider: true },
      { key: 'walnut', info: true, label: 'Walnut' },
    ];
    expect(contextMenuShape(items).map((r) => r.kind)).toEqual(['item', 'group', 'divider', 'info']);
  });
});

describe('ContextMenu has the shape by construction', () => {
  const run = () => {};
  it('puts the danger rows last, alone under one rule, whatever order the caller listed', () => {
    const rows = normalizeContextMenuItems([
      { key: 'rename', label: 'Rename', onSelect: run },
      { key: 'delete', label: 'Delete', danger: true, onSelect: run },
      { divider: true },
      { key: 'copy', label: 'Copy path', onSelect: run },
    ]);
    expect(rows.map((r) => (r.divider ? '-' : r.key))).toEqual(['rename', '-', 'copy', '-', 'delete']);
  });

  it('drops a rule right above a heading, and a heading left with no row', () => {
    const rows = normalizeContextMenuItems([
      { key: 'a', label: 'A', onSelect: run },
      { divider: true },
      { key: 'kind', section: true, label: 'Kind' },
      { key: 'b', label: 'B', onSelect: run },
      { key: 'gone', section: true, label: 'Gone' },
      { key: 'x', label: 'X', danger: true, onSelect: run },
    ]);
    expect(rows.map((r) => (r.divider ? '-' : r.key))).toEqual(['a', 'kind', 'b', '-', 'x']);
  });

  it('leaves no leading rule when a first heading has no visible row', () => {
    const rows = normalizeContextMenuItems([
      { key: 'h', section: true, label: 'Hidden' },
      { key: 'a', label: 'A', when: false, onSelect: run },
      { divider: true },
      { key: 'b', label: 'B', onSelect: run },
    ]);
    expect(rows.map((r) => (r.divider ? '-' : r.key))).toEqual(['b']);
  });

  it('keeps a menu of danger rows only as it is', () => {
    const rows = normalizeContextMenuItems([{ key: 'x', label: 'Delete', danger: true, onSelect: run }]);
    expect(rows.map((r) => r.key)).toEqual(['x']);
  });
});

// ── Every menu surface, found from the source ────────────────────────────────────────────

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(p, out);
    else if (entry.name.endsWith('.tsx')) out.push(p);
  }
  return out;
}
const files = walk(WEB_SRC).map((f) => ({ rel: path.relative(WEB_SRC, f), src: fs.readFileSync(f, 'utf8') }));

/** ContextMenu callers whose items run the shape check in their builder's own test. */
const CONTEXT_MENU_CHECKED: Record<string, string> = {
  'components/tasks/ProjectContextMenu.tsx': 'tests/web/project-context-menu-items.test.ts',
  'components/tasks/FolderContextMenu.tsx': 'tests/web/folder-context-menu-items.test.ts',
  'apps/mail/MailRowContextMenu.tsx': 'tests/web/mail-context-items.test.ts',
};

/** Hand-built menu boxes measured as drawn by tests/e2e/browser/big-menu-shape.spec.ts. */
const MEASURED = new Set([
  'components/sessions/TaskQuickActions.tsx', // the session ⋮ menu (Session, Task)
  'components/tasks/TaskKebabMenu.tsx', // the task row ⋮ and right-click
  'components/chat/ChatInput.tsx', // the composer + menu
]);

/**
 * Hand-built big menus whose order the source shows: each check reads the file and returns what is
 * out of place (the danger rows last under their rule). Measured from the source, not the browser:
 * both build their rows in one place, with no data-dependent order.
 */
const DANGER_LAST_BY_SOURCE: Record<string, (src: string) => string[]> = {
  // The file tree: rows are built in groups; the danger rows live only in deleteGroup, pushed last.
  'components/sessions/FileTreeContextMenu.tsx': (src) => {
    const out: string[] = [];
    const pushes = [...src.matchAll(/\bgroups\.push\(([^)\n]*)/g)].map((m) => m[1].trim());
    if (pushes.at(-1) !== 'deleteGroup') out.push(`the last group pushed is "${pushes.at(-1)}", not deleteGroup`);
    for (const m of src.matchAll(/(\w+)\.push\(\s*<button[^>]*className="danger"/g)) if (m[1] !== 'deleteGroup') out.push(`a danger row in ${m[1]}`);
    return out;
  },
  // The notes tree: one JSX list; after its first danger button only danger buttons follow.
  'components/notes/NotesTreePanel.tsx': (src) => {
    const start = src.indexOf('notes-context-menu wn-overlay wn-menu');
    const body = src.slice(start, src.indexOf('Inline SVG Icons', start));
    const buttons = [...body.matchAll(/<button\b[^>]*>/g)].map((m) => /className="danger"/.test(m[0]));
    const first = buttons.indexOf(true);
    if (first < 0) return ['no danger row found'];
    return buttons.slice(first).some((d) => !d) ? ['a row after the danger section'] : [];
  },
};

/**
 * Hand-built menu boxes that are not big menus of mixed kinds: a list of one kind (a picker, a
 * flyout of choices, a format list), or fewer than eight rows. A box listed here that grows into a
 * big menu of several kinds moves to MEASURED.
 */
const SHORT_OR_ONE_KIND = new Set([
  'components/board/kanban/KanbanCardMenu.tsx', 'components/board/kanban/KanbanChanges.tsx',
  'components/board/kanban/KanbanLaneMenu.tsx', 'components/calendar/CalendarContextMenu.tsx',
  'components/calendar/CalendarsPopover.tsx', 'components/calendar/EventCreateForm.tsx',
  'components/calendar/MonthView.tsx', 'components/chat/ComposerControlsBar.tsx',
  'components/chat/ComposerMoreMenu.tsx', 'components/common/CodeContextMenu.tsx',
  'components/notes/NotesFormatToolbar.tsx',
  'components/notes/slash-commands/SlashCommandMenu.tsx', 'components/notes/TagAutocomplete.tsx',
  'components/notes/wiki-link/WikiLinkAutocomplete.tsx', 'components/passwords/ItemEditor.tsx',
  'components/sessions/DiffComparePicker.tsx', 'components/sessions/DraftTaskMenu.tsx',
  'components/sessions/PermissionModeMenu.tsx',
  'components/sessions/SessionControlPills.tsx', 'components/sessions/SessionFileExplorer.tsx',
  'components/sessions/SessionHeaderMore.tsx', 'components/sessions/SessionTaskbar.tsx',
  'components/sessions/ThreadPathBar.tsx', 'components/sessions/ThreadStackCrumbs.tsx',
  'components/sessions/ThreadStackMenu.tsx', 'components/sessions/TriggerPickerPopover.tsx',
  'components/settings/sections/MailRuleEditor.tsx', 'components/tasks/AdoptWorkerFlyout.tsx',
  'components/tasks/CursorFlyout.tsx', 'components/tasks/LeaderPill.tsx',
  'components/tasks/PinShortcutChoices.tsx', 'components/tasks/PluginFieldPicker.tsx',
  'components/tasks/ProjectHeaderMenus.tsx', 'components/tasks/ReleaseWorkerFlyout.tsx',
  'components/tasks/SnoozeChoices.tsx', 'components/tasks/SubtaskPill.tsx',
  'components/tasks/TagEditor.tsx', 'components/tasks/TaskBatchMenu.tsx',
  'components/tasks/TasksColumnsMenu.tsx', 'components/tasks/TasksPageTable.tsx',
  'components/tasks/TaskTagPills.tsx', 'components/topics/TopicComposer.tsx',
]);

describe('every menu surface is classified', () => {
  const contextCallers = files.filter((f) => f.rel !== 'components/common/ContextMenu.tsx' && /<ContextMenu[\s>]/.test(f.src)).map((f) => f.rel);
  const boxes = files.filter((f) => f.rel !== 'components/common/ContextMenu.tsx' && /\bwn-menu(?=[\s'"`}])/.test(f.src)).map((f) => f.rel);

  it('finds the menus it guards', () => {
    for (const known of ['components/tasks/ProjectContextMenu.tsx', 'apps/mail/MailRowContextMenu.tsx']) expect(contextCallers).toContain(known);
    for (const known of MEASURED) expect(boxes).toContain(known);
  });

  it('a hand-built menu box is either measured as drawn or a short list of one kind', () => {
    const unclassified = boxes.filter((f) => !MEASURED.has(f) && !(f in DANGER_LAST_BY_SOURCE) && !SHORT_OR_ONE_KIND.has(f));
    expect(unclassified, `A new menu box. If it holds 8+ rows of different kinds, give it the big-menu shape (standard.md, "Big menus": everyday rows first, named sections, Delete last) and add it to MEASURED and tests/e2e/browser/big-menu-shape.spec.ts; else add it to SHORT_OR_ONE_KIND here:\n${unclassified.join('\n')}`).toEqual([]);
    const stale = [...MEASURED, ...Object.keys(DANGER_LAST_BY_SOURCE), ...SHORT_OR_ONE_KIND].filter((f) => !boxes.includes(f));
    expect(stale, 'Listed but no longer a menu box: remove it from the list').toEqual([]);
  });

  it('the long ContextMenus run the shape check in their builder tests', () => {
    for (const [caller, test] of Object.entries(CONTEXT_MENU_CHECKED)) {
      expect(contextCallers, caller).toContain(caller);
      expect(fs.readFileSync(path.join(ROOT, test), 'utf8'), test).toMatch(/menuShapeProblems\(/);
    }
  });

  it('the hand-built big menus read from the source keep their danger rows last', () => {
    for (const [file, check] of Object.entries(DANGER_LAST_BY_SOURCE)) {
      expect(check(fs.readFileSync(path.join(WEB_SRC, file), 'utf8')), file).toEqual([]);
    }
  });

  it('the hand-built big menus are measured by the browser spec', () => {
    const spec = fs.readFileSync(path.join(ROOT, 'tests/e2e/browser/big-menu-shape.spec.ts'), 'utf8');
    for (const id of ['session-kebab', 'row-kebab', 'row-context', 'composer-plus']) expect(spec, id).toContain(`'${id}'`);
  });
});
