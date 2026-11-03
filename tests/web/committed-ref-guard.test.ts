/**
 * Guard: a value that arrives in a React transition is never mirrored into a ref during render.
 *
 * React renders a transition, leaves it for a tap or a keystroke, commits the tap on the state
 * before the transition, and draws the transition again afterwards. A ref written in the render
 * body (`fooRef.current = tasks`) keeps the value of that unfinished render, so an event handler
 * reads a value the page does not show yet. 2026-11-03 (C24 in
 * tests/e2e/browser/phone-session.spec.ts, about 1 CI run in 4 on a 4-core runner): Home adopts
 * the task list in `startTransition` (web/src/hooks/useTasks.ts); a session menu's Details read
 * the task from `taskMapRef`, written by the unfinished render, and opened its detail; the tap
 * committed on the old, empty list, and MainPage's "the focused task left the list" effect closed
 * the detail at once.
 *
 * The class: a render-time `<x>.current = ...` (two-space indent, the body of a component or a
 * hook) whose value names state set in a transition. Members, enumerated from the source:
 *   . the task list, which reaches components by context and by props (TASK_LIST_NAMES);
 *   . every `useState` value a file sets inside `startTransition(...)`, mirrored in that file.
 * Mirror such a value with `useCommittedRef` (web/src/hooks/useCommittedRef.ts), which writes it
 * in a layout effect of the commit that shows it.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = join(__dirname, '../..');
const WEB_SRC = join(ROOT, 'web/src');

/** Names the task list (and its loading flag) goes by, from useTasks through every consumer. */
const TASK_LIST_NAMES = ['tasks', 'taskMap', 'allTasks', 'loading'];

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...sourceFiles(p));
    else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

/** State a file sets inside a transition: `startTransition(() => setX(...))` with `const [x, setX] = useState`. */
export function transitionStateNames(src: string): string[] {
  const setters = new Set<string>();
  // The 400 characters after the call, not up to its first `)`: `startTransition(() => { a(); setX(v) })`
  // sets X too. A setter just past a short transition is taken as well, which only asks more of a mirror.
  for (const m of src.matchAll(/startTransition\(([\s\S]{0,400})/g)) {
    for (const s of m[1].matchAll(/\b(set[A-Z]\w*)\s*\(/g)) setters.add(s[1]);
  }
  const names: string[] = [];
  for (const m of src.matchAll(/const\s*\[\s*(\w+)\s*,\s*(set\w+)\s*\]\s*=\s*useState\b/g)) {
    if (setters.has(m[2])) names.push(m[1]);
  }
  return names;
}

/** Render-time ref writes whose value names one of `names`. */
export function renderTimeMirrors(src: string, names: readonly string[]): string[] {
  if (names.length === 0) return [];
  const word = new RegExp(`(^|[^\\w$.])(${names.join('|')})(?![\\w$])`);
  const hits: string[] = [];
  for (const line of src.split('\n')) {
    const m = /^ {2}[A-Za-z_$][\w$]*\.current\s*=\s*(.+?);?\s*$/.exec(line);
    if (m && word.test(m[1])) hits.push(line.trim());
  }
  return hits;
}

describe('a transition value is never mirrored into a ref during render', () => {
  it('the matcher finds the forms that shipped the C24 bug, and only render-time ones', () => {
    expect(renderTimeMirrors('  const taskMapRef = useRef(taskMap);\n  taskMapRef.current = taskMap;', TASK_LIST_NAMES))
      .toEqual(['taskMapRef.current = taskMap;']);
    expect(renderTimeMirrors('  tasksNow.current = allTasks;\n  loadingRef.current = loading;', TASK_LIST_NAMES)).toHaveLength(2);
    // Inside an effect or a handler (deeper indent) is not render time; a field read is another name.
    expect(renderTimeMirrors('    tasksRef.current = tasks;\n  x.current = props.tasksCount;', TASK_LIST_NAMES)).toEqual([]);
    expect(transitionStateNames('const [activeSection, setActiveSection] = useState(1);\nstartTransition(() => setActiveSection(s));'))
      .toEqual(['activeSection']);
  });

  it('no file in web/src mirrors one at render time', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(WEB_SRC)) {
      const src = readFileSync(file, 'utf8');
      const names = [...TASK_LIST_NAMES, ...transitionStateNames(src)];
      for (const hit of renderTimeMirrors(src, names)) offenders.push(`${relative(WEB_SRC, file)}: ${hit}`);
    }
    expect(offenders, 'use useCommittedRef (web/src/hooks/useCommittedRef.ts) instead').toEqual([]);
  });

  it('the members found before keep their committed mirror', () => {
    const uses: Record<string, string[]> = {
      'pages/MainPage.tsx': ['useCommittedRef(taskMap)', 'useCommittedRef(loading)'],
      'pages/OrgPage.tsx': ['useCommittedRef(allTasks)'],
      'components/tasks/TodoPanel.tsx': ['useCommittedRef<Task[]>(tasks)', 'useCommittedRef(tasks)'],
      'components/chat/AskWalnutSlot.tsx': ['useCommittedRef(tasks)', 'useCommittedRef(askTasks)', 'useCommittedRef(rows)'],
      'hooks/useFocusBar.ts': ['useCommittedRef<Task[]>(tasks)', 'useCommittedRef<string[]>(pinnedIds)'],
      'hooks/useTasks.ts': ['useCommittedRef(tasks)'],
    };
    for (const [file, calls] of Object.entries(uses)) {
      const src = readFileSync(join(WEB_SRC, file), 'utf8');
      for (const call of calls) expect(src, `${file} mirrors with ${call}`).toContain(call);
    }
    // A value read DURING render (a memo calling it) stays a closure, never a committed ref, which
    // holds the last commit's value there: the Org strip's sameSession merges a task's panel with
    // its session's once the tasks of this render are known.
    const org = readFileSync(join(WEB_SRC, 'pages/OrgPage.tsx'), 'utf8');
    expect(org).toMatch(/const sameSession = useCallback<SameSession>\([\s\S]*?tasks\.find\([\s\S]*?\}, \[tasks\]\)/);
    const hook = readFileSync(join(WEB_SRC, 'hooks/useCommittedRef.ts'), 'utf8');
    expect(hook).toMatch(/useLayoutEffect\(\(\) => \{ ref\.current = value; \}, \[value\]\)/);
  });
});
