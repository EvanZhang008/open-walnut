/**
 * Every task ⋮ menu draws its task rows from ONE definition, TaskMenuRows (2026-11-02, the
 * user: "make the drop down consistent for both on the side bar or in session"; the board's
 * row menu and the session panel's menu each listed the rows themselves, in two orders, and
 * a change to one never reached the other).
 *
 * The scan finds every file under web/src that renders a task-menu row component. Only
 * TaskMenuRows may, plus the few listed below, each with why. A new menu that lists the rows
 * itself fails here: render <TaskMenuRows> instead.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '../../web/src');
const ROWS_FILE = 'components/tasks/TaskMenuRows.tsx';

/** The rows of a task's menu: every component TaskMenuRows imports and renders (so a row added
 *  there is guarded at once), less KebabGroup, the group shell the session half uses too. */
const ROWS_SRC = fs.readFileSync(path.join(ROOT, ROWS_FILE), 'utf8');
const ROW_COMPONENTS = [...ROWS_SRC.matchAll(/^import \{([^}]+)\} from '[^']+';$/gm)]
  .flatMap((m) => m[1].split(',').map((n) => n.trim()))
  .filter((n) => /^[A-Z]/.test(n) && n !== 'KebabGroup' && new RegExp(`<${n}[\\s/>]`).test(ROWS_SRC));

/** Files that may render a row component outside TaskMenuRows, and why. */
const ALLOWED: Record<string, { components: string[]; why: string }> = {
  'components/tasks/TaskBatchMenu.tsx': {
    components: ['TaskActionMenuItems', 'MoveToProjectSection'],
    why: 'the multi-select menu acts on many tasks at once: no single task to read a row from',
  },
  'components/sessions/DraftTaskMenu.tsx': {
    components: ['TaskActionMenuItems'],
    why: 'a draft column\'s menu sets the launch meta of a task that does not exist yet',
  },
};

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.(tsx|ts)$/.test(entry.name)) out.push(full);
  }
  return out;
}

const files = walk(ROOT).map((f) => ({ rel: path.relative(ROOT, f).split(path.sep).join('/'), src: fs.readFileSync(f, 'utf8') }));

describe('task menus share one row definition', () => {
  it('the row list is read from TaskMenuRows itself', () => {
    for (const n of ['TaskSnoozeRow', 'WatchMenuItem', 'TaskStatusMenuSection', 'TaskActionMenuItems', 'MoveToProjectSection',
      'MoveHostMenuItems', 'TransferMenuItem', 'TeamMenuItems', 'TaskSyncMenuRows', 'PluginFieldsSection', 'WorkspaceMenuSection', 'QuoteInSessionItem']) {
      expect(ROW_COMPONENTS).toContain(n);
    }
  });

  it('only TaskMenuRows (and the listed exceptions) render task-menu rows', () => {
    const offenders: string[] = [];
    for (const { rel, src } of files) {
      if (rel === ROWS_FILE) continue;
      for (const name of ROW_COMPONENTS) {
        if (!new RegExp(`<${name}[\\s/>]`).test(src)) continue;
        if (ALLOWED[rel]?.components.includes(name)) continue;
        offenders.push(`${rel} renders <${name}>`);
      }
    }
    expect(offenders, 'render <TaskMenuRows> instead of listing task rows yourself').toEqual([]);
  });

  it('both task menus render TaskMenuRows', () => {
    const src = (rel: string) => files.find((f) => f.rel === rel)!.src;
    expect(src('components/tasks/TaskKebabMenu.tsx')).toMatch(/<TaskMenuRows[\s>]/);
    expect(src('components/sessions/TaskQuickActions.tsx')).toMatch(/<TaskMenuRows[\s>]/);
  });

  it('Snooze until is the first row and Watch the second', () => {
    const rows = files.find((f) => f.rel === ROWS_FILE)!.src;
    const body = rows.slice(rows.indexOf('export function TaskMenuRows'));
    const order = ROW_COMPONENTS.map((n) => [n, body.indexOf(`<${n}`)] as const).filter(([, i]) => i >= 0).sort((a, b) => a[1] - b[1]);
    expect(order.slice(0, 2).map(([n]) => n)).toEqual(['TaskSnoozeRow', 'WatchMenuItem']);
  });

  it('every move of the task sits under the one Move & transfer row', () => {
    const rows = files.find((f) => f.rel === ROWS_FILE)!.src;
    const group = rows.slice(rows.indexOf('label="Move & transfer"'), rows.indexOf('</KebabGroup>', rows.indexOf('label="Move & transfer"')));
    for (const name of ['MoveToProjectSection', 'MoveHostMenuItems', 'TransferMenuItem', 'ListMoves', 'TaskSyncMenuRows']) {
      expect(group, `${name} belongs in Move & transfer`).toContain(`<${name}`);
    }
  });

  it('each kind of setting is its own group: Pin to, Dates, a plugin\'s fields (the user: "pin is pin, not mix with date")', () => {
    const rows = files.find((f) => f.rel === ROWS_FILE)!.src;
    const groupOf = (label: string) => {
      const at = rows.indexOf(`label="${label}"`);
      expect(at, `${label} group`).toBeGreaterThan(0);
      return rows.slice(at, rows.indexOf('</KebabGroup>', at));
    };
    expect(rows).not.toMatch(/<KebabGroup[^>]*label="Pin to"/);
    expect(rows).toMatch(/part="pin"\s+firstLevelPin/);
    // The shared pin block is outside the phone's reduced-menu gate too.
    expect(rows.indexOf('firstLevelPin')).toBeLessThan(rows.indexOf('{!p.phoneMenu && (<>'));
    expect(groupOf('Dates')).toContain('part="dates"');
    expect(groupOf('More fields')).toContain('<PluginFieldsSection');
    // No plugin field row on the first level.
    expect(rows.split('<PluginFieldsSection').length - 1).toBe(1);
  });

  it('a session menu opens with Open, Window and Panels, and Open holds what Views held', () => {
    const open = files.find((f) => f.rel === 'components/sessions/SessionMenuOpen.tsx')!.src;
    const group = open.slice(open.indexOf('label="Open"'), open.indexOf('</KebabGroup>', open.indexOf('label="Open"')));
    for (const row of ['Changed', 'Files', 'Terminal', 'Board', '<SessionViewItems']) expect(group).toContain(row);
    expect(open).toContain('label="Window"');
    expect(open).toContain('<PanelCountRow');
    expect(files.find((f) => f.rel === 'components/sessions/SessionPanel.tsx')!.src).toContain('renderMenuOpen(close)');
    // The old separate Views group is gone everywhere.
    const views = files.filter((f) => /<KebabGroup[^>]*label="Views"/.test(f.src)).map((f) => f.rel);
    expect(views).toEqual([]);
  });

  it('every listed exception still exists and still needs its entry', () => {
    for (const [rel, { components }] of Object.entries(ALLOWED)) {
      const src = files.find((f) => f.rel === rel)?.src;
      expect(src, `${rel} is gone: drop its entry`).toBeTruthy();
      for (const name of components) expect(src, `${rel} no longer renders <${name}>: drop it`).toMatch(new RegExp(`<${name}[\\s/>]`));
    }
  });
});
