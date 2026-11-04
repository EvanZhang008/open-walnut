/**
 * Guard: a task row that shows its project's name draws it through RowProjectName, whose click
 * filters the panel to that project (2026-11-03, the user, pointing at the project name above a
 * row: "if user click the project I thik it shoud do a filter on the project show all in this
 * project").
 *
 * The class: JSX in the task surfaces (web/src/components/tasks, web/src/components/org,
 * web/src/pages) that renders a task's project name as text, `{task.project}`,
 * `{row.project || 'Inbox'}` or a `{projectName}` copy of it. Each one is read by the
 * TypeScript parser (a JSX child, never an attribute or a string) and must be listed below
 * with why it is not a row link; a new one fails until it uses RowProjectName or is listed.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';
import {
  allSectionsOpen, isProjectJump, projectJumpHolds, projectJumpSection, startProjectJump,
} from '../../web/src/components/tasks/project-jump';

const WEB_SRC = join(__dirname, '../../web/src');
const SCANNED = ['components/tasks', 'components/org', 'pages'];

/** Every place a project name is drawn as text that is not a row link, keyed `file: expression`. */
const NOT_A_ROW_LINK: Record<string, string> = {
  'components/tasks/AgentSearchResultRows.tsx: row.project || \'Inbox\'':
    'An AI search answer row is one <button> (a link inside it would be a button in a button), and the same rows are drawn in chat transcripts, where there is no task panel to filter.',
  'components/tasks/TaskCard.tsx: task.project':
    'TaskCard is drawn only by TaskList, which nothing mounts.',
  'components/tasks/AdoptWorkerFlyout.tsx: t.project || \'Inbox\'':
    'A picker flyout listing tasks to adopt: a click picks the task, it is no task list.',
  'components/tasks/TaskDetailPane.tsx: task.project || \'Inbox\'':
    'The open task\'s own detail header, not a row in a list.',
  'components/tasks/PhoneNeedsYouStrip.tsx: t.project':
    'A phone chip that is one tap target; a 15 px name inside it is no target (phone-fixes-r4.css R3-04).',
  'components/tasks/TodoPanel.tsx: task.project || \'Inbox\'':
    'Recent\'s "group by project" heading over a run of rows (its first row\'s project), not a row.',
  'components/org/OrgChannelList.tsx: m.project':
    'A project that moved to another VP on the Org page: a project row, not a task row.',
};

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...sourceFiles(p));
    else if (name.endsWith('.tsx')) out.push(p);
  }
  return out;
}

/** `x.project`, `x?.y.project`, `x.project || 'Inbox'`, `projectName`. */
function namesProject(e: ts.Expression): boolean {
  if (ts.isParenthesizedExpression(e)) return namesProject(e.expression);
  if (ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.BarBarToken) {
    return namesProject(e.left) && ts.isStringLiteral(e.right);
  }
  if (ts.isPropertyAccessExpression(e)) return e.name.text === 'project';
  return ts.isIdentifier(e) && e.text === 'projectName';
}

function members(): string[] {
  const out: string[] = [];
  for (const dir of SCANNED) {
    for (const file of sourceFiles(join(WEB_SRC, dir))) {
      const text = readFileSync(file, 'utf8');
      const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
      const rel = relative(WEB_SRC, file);
      const visit = (node: ts.Node) => {
        // A JSX child (text the page shows), never an attribute value.
        if (ts.isJsxExpression(node) && node.expression && !ts.isJsxAttribute(node.parent) && namesProject(node.expression)) {
          out.push(`${rel}: ${node.expression.getText(source)}`);
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
    }
  }
  return [...new Set(out)];
}

describe('a task row\'s project name filters to the project', () => {
  it('every project name drawn as text is a RowProjectName or listed with why it is not a row link', () => {
    const unlisted = members().filter((m) => !(m in NOT_A_ROW_LINK));
    expect(unlisted, 'draw it with <RowProjectName onFilter=…> (components/tasks/RowProjectName.tsx), or list it here with why').toEqual([]);
  });

  it('the list has no entry that is gone', () => {
    const found = new Set(members());
    expect(Object.keys(NOT_A_ROW_LINK).filter((k) => !found.has(k))).toEqual([]);
  });

  it('the status section rows pass the panel\'s filter to the name', () => {
    const text = readFileSync(join(WEB_SRC, 'components/tasks/StatusSections.tsx'), 'utf8');
    expect(text).toMatch(/<RowProjectName[^>]*onFilter=\{handlers\.onFilterProject\}/);
    const panel = readFileSync(join(WEB_SRC, 'components/tasks/TodoPanel.tsx'), 'utf8');
    expect(panel).toMatch(/onFilterProject: jumpToProject/);
  });
});

describe('project-jump model', () => {
  it('stays on the tab the click came from, with every section open', () => {
    const j = startProjectJump('Garden', null);
    expect(j).toEqual({ project: 'Garden', open: allSectionsOpen(), section: null });
    expect(Object.values(j.open).every(Boolean)).toBe(true);
    // A pin group's project click filters that group; it never goes to All by itself.
    expect(projectJumpSection(j, 'focus')).toBe('focus');
    expect(projectJumpSection(j, 'ct_reading')).toBe('ct_reading');
    expect(projectJumpSection(j, 'all')).toBe('all');
    expect(projectJumpSection({ ...j, section: 'all' }, 'focus')).toBe('all');
  });

  it('keeps a tab picked inside the jump when another project name is clicked', () => {
    const prev = { ...startProjectJump('Garden', null), section: 'focus' };
    const next = startProjectJump('Kitchen', prev);
    expect(next.section).toBe('focus');
    expect(next.open.done).toBe(true);
  });

  it('holds only while the Project filter is exactly its project', () => {
    const j = startProjectJump('Garden', null);
    expect(projectJumpHolds(j, ['Garden'])).toBe(true);
    expect(projectJumpHolds(j, [])).toBe(false);
    expect(projectJumpHolds(j, ['Garden', 'Kitchen'])).toBe(false);
    expect(projectJumpHolds(j, ['Kitchen'])).toBe(false);
    expect(projectJumpHolds(null, ['Garden'])).toBe(false);
    // Inbox is the empty project name.
    expect(projectJumpHolds(startProjectJump('', null), [''])).toBe(true);
  });

  it('reads back only a well-formed stored jump', () => {
    expect(isProjectJump(null)).toBe(true);
    expect(isProjectJump(startProjectJump('Garden', null))).toBe(true);
    expect(isProjectJump({ project: 'Garden', section: null })).toBe(false);
    expect(isProjectJump({ project: 3, open: allSectionsOpen(), section: null })).toBe(false);
    expect(isProjectJump('Garden')).toBe(false);
  });
});
