/**
 * Task rows show a task by its display name, never its raw stored title (2026-11-07, the user:
 * "Ask walnut should be rename as quick question, also main task should be name as CEO").
 * orgDisplayTitle (src/core/org/org-tree.ts) already named an ask filed under its agent's project
 * "Quick question" and Main "CEO", but the Home pinned card, the list row, the detail pane and the
 * other task surfaces each drew `task.title` themselves, so the Mac app still read "Ask Walnut".
 *
 * The stored title stays what it is: the rename editor's buffer, the PATCH, keys, sorting and
 * search matching read `task.title`. Only what is put on screen goes through orgDisplayTitle.
 *
 * Guards, over the TypeScript AST:
 *  - ROW_FILES (the task row surfaces) render no `<x>.title`: not as a JSX child, not in a JSX
 *    attribute other than key/value, not in a template literal (confirm dialogs name the task too);
 *  - across web/src, an element carrying a task title class renders no `<x>.title` child, so a new
 *    file drawing a task row title with that class is caught as well;
 *  - the inline rename shows the display name and edits the stored title (title-edit-text.ts,
 *    pure: this file imports no React, only typescript, fs and the two pure modules);
 *  - useInlineTitleEdit ends an edit through one ref, so the blur after Enter or Escape (the span
 *    then holds the display name) never commits a rename to it. Source check, not UI proof.
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import ts from 'typescript'
import { orgDisplayTitle } from '../../src/core/org/org-tree'
import { titleEditRename, titleSpanText } from '../../web/src/components/tasks/title-edit-text'
import { sessionDisplayName, taskReferenceLabel } from '../../web/src/utils/project-display'

const repoRoot = path.resolve(__dirname, '../..')
const webSrc = path.join(repoRoot, 'web', 'src')

/** The task row surfaces: every visible task title in them is a display name. */
const ROW_FILES = [
  'components/tasks/TaskCard.tsx',
  'components/tasks/TaskList.tsx',
  'components/tasks/TodoPanel.tsx',
  'components/tasks/TasksPageTable.tsx',
  'components/tasks/PanelDesignParts.tsx',
  'components/tasks/PhoneNeedsYouStrip.tsx',
  'components/tasks/FocusSatelliteCards.tsx',
  'components/tasks/TaskDetailPane.tsx',
  'components/tasks/StatusSections.tsx',
  'components/tasks/HomeBoardSheet.tsx',
  'components/tasks/TaskDetailEdits.tsx',
  'components/tasks/LeaderPill.tsx',
  'components/tasks/SubtaskPill.tsx',
  'components/tasks/AdoptWorkerFlyout.tsx',
  'components/tasks/ReleaseWorkerFlyout.tsx',
  'components/notes/slash-commands/TaskSearchPanel.tsx',
  'components/notes/slash-commands/SlashCommandPortal.tsx',
]

/** Classes that mark an element as a task's title on a row, card or pane. */
const TASK_TITLE_CLASS = /(?:^|[\s`'"])(todo-item-title|todo-pinned-title|todo-detail-title|tp-row-title|task-card-title|phone-needs-you-title|status-card-title|home-board-title|home-board-drag-preview|home-board-parent|tdp-dep-title|tdp-dep-result|leader-sub-title|adopt-worker-title|adopt-worker-row-title)(?![-\w])/

/** `file|expression` → why that raw `.title` render is not a task title. A stale entry fails. */
const ALLOWED: Record<string, string> = {}

/** Attributes that carry data, not text on screen. */
const DATA_ATTRS = new Set(['key', 'value', 'defaultValue', 'className', 'id', 'ref'])

function tsxFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...tsxFiles(full))
    else if (entry.name.endsWith('.tsx') && !/\.(test|spec)\.tsx$/.test(entry.name)) out.push(full)
  }
  return out
}

function parse(file: string): ts.SourceFile {
  return ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
}

/** The values a rendered expression can put on screen. */
function renderedLeaves(node: ts.Expression, out: ts.Expression[] = []): ts.Expression[] {
  if (ts.isParenthesizedExpression(node)) return renderedLeaves(node.expression, out)
  if (ts.isConditionalExpression(node)) { renderedLeaves(node.whenTrue, out); renderedLeaves(node.whenFalse, out); return out }
  if (ts.isBinaryExpression(node)) {
    const op = node.operatorToken.kind
    if (op === ts.SyntaxKind.AmpersandAmpersandToken) return renderedLeaves(node.right, out)
    if (op === ts.SyntaxKind.BarBarToken || op === ts.SyntaxKind.QuestionQuestionToken) {
      renderedLeaves(node.left, out); renderedLeaves(node.right, out); return out
    }
  }
  if (ts.isTemplateExpression(node)) {
    for (const span of node.templateSpans) renderedLeaves(span.expression, out)
    return out
  }
  out.push(node)
  return out
}

/** `<anything>.title`, optional chaining included. */
function isRawTitle(node: ts.Node): boolean {
  return ts.isPropertyAccessExpression(node) && node.name.text === 'title'
}

function where(sf: ts.SourceFile, node: ts.Node): string {
  const rel = path.relative(repoRoot, sf.fileName)
  return `${rel}:${sf.getLineAndCharacterOfPosition(node.getStart()).line + 1}|${node.getText()}`
}

/** Raw `.title` renders in one row file: JSX children, text attributes, template literals. */
function rowFileRenders(file: string): string[] {
  const sf = parse(file)
  const hits: string[] = []
  const check = (expr: ts.Expression) => {
    for (const leaf of renderedLeaves(expr)) if (isRawTitle(leaf)) hits.push(where(sf, leaf))
  }
  const visit = (node: ts.Node) => {
    if (ts.isJsxExpression(node) && node.expression) {
      const parent = node.parent
      if (ts.isJsxAttribute(parent)) {
        const name = parent.name.getText()
        if (!DATA_ATTRS.has(name) && !name.startsWith('data-') && !name.startsWith('on')) check(node.expression)
      } else if (ts.isJsxElement(parent) || ts.isJsxFragment(parent)) {
        check(node.expression)
      }
    }
    if (ts.isTemplateExpression(node)) {
      for (const span of node.templateSpans) if (isRawTitle(span.expression)) hits.push(where(sf, span.expression))
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return [...new Set(hits)]
}

/** Elements anywhere in web/src carrying a task title class, and the raw `.title` children they render. */
function titleClassElements(): { found: string[]; raw: string[] } {
  const found: string[] = []
  const raw: string[] = []
  for (const file of tsxFiles(webSrc)) {
    const sf = parse(file)
    const visit = (node: ts.Node) => {
      if (ts.isJsxElement(node)) {
        const cls = node.openingElement.attributes.properties.find(
          (a): a is ts.JsxAttribute => ts.isJsxAttribute(a) && a.name.getText() === 'className',
        )
        if (cls?.initializer && TASK_TITLE_CLASS.test(cls.initializer.getText())) {
          found.push(where(sf, node.openingElement))
          for (const child of node.children) {
            if (!ts.isJsxExpression(child) || !child.expression) continue
            for (const leaf of renderedLeaves(child.expression)) if (isRawTitle(leaf)) raw.push(where(sf, leaf))
          }
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(sf)
  }
  return { found, raw }
}

const allowed = (hit: string) => Object.keys(ALLOWED).some((k) => hit.startsWith(k.split('|')[0]) && hit.endsWith(`|${k.split('|')[1]}`))

describe('task display names: orgDisplayTitle', () => {
  it('names an ask filed under its agent, Main and a lead; a title the user wrote stays', () => {
    expect(orgDisplayTitle({ title: 'Ask Walnut', project: 'Ask Walnut' })).toBe('Quick question')
    expect(orgDisplayTitle({ title: 'Ask Mentor', project: 'Ask Mentor' })).toBe('Quick question · Mentor')
    expect(orgDisplayTitle({ title: 'Ask Bob about lease', project: 'Ask Walnut' })).toBe('Ask Bob about lease')
    expect(orgDisplayTitle({ title: 'Ask Bob about lease', project: '' })).toBe('Ask Bob about lease')
    expect(orgDisplayTitle({ title: 'Main', project: 'Main', org_role: 'main' })).toBe('CEO')
    expect(orgDisplayTitle({ title: 'Alpha lead', project: 'Alpha', org_role: 'lead' })).toBe('Alpha VP')
    expect(orgDisplayTitle({ title: 'Fix the login bug', project: 'Alpha' })).toBe('Fix the login bug')
  })
})

describe('the inline rename shows the display name and edits the stored title', () => {
  const ask = { id: 't1', title: 'Ask Walnut', project: 'Ask Walnut' }

  it('the span shows the display name, the edit buffer is the stored title', () => {
    expect(titleSpanText(ask, false)).toBe('Quick question')
    expect(titleSpanText(ask, true)).toBe('Ask Walnut')
    const plain = { id: 't2', title: 'Write the report', project: 'Alpha' }
    expect(titleSpanText(plain, false)).toBe('Write the report')
    expect(titleSpanText(plain, true)).toBe('Write the report')
  })

  it('an edit left as it opened never renames, even where the display name differs', () => {
    expect(titleEditRename(ask.title, titleSpanText(ask, true))).toBeNull()
    expect(titleEditRename(ask.title, '  Ask Walnut  ')).toBeNull()
    expect(titleEditRename(ask.title, '   ')).toBeNull()
    expect(titleEditRename(ask.title, 'Lease question ')).toBe('Lease question')
  })
})

describe('task row surfaces render the display name (ratchet)', () => {
  it('finds the row files, and each draws titles through orgDisplayTitle', () => {
    for (const rel of ROW_FILES) {
      const file = path.join(webSrc, rel)
      expect(fs.existsSync(file), rel).toBe(true)
      // PanelDesignParts draws no title of its own (its rows come from the panel's handlers).
      if (rel.endsWith('PanelDesignParts.tsx')) continue
      expect(fs.readFileSync(file, 'utf8'), rel).toMatch(/orgDisplayTitle\(|taskReferenceLabel\(/)
    }
  })

  it('no row file renders a raw `.title`', () => {
    const hits = ROW_FILES.flatMap((rel) => rowFileRenders(path.join(webSrc, rel))).filter((h) => !allowed(h))
    expect(hits).toEqual([])
  })

  it('no element with a task title class renders a raw `.title`, in any file', () => {
    const { found, raw } = titleClassElements()
    // The list row, its drag ghost, the pinned card, its drag ghost, the Focus card, the section
    // card, the dashboard card, the /tasks table row, the detail pane, the phone strip, the Home
    // board card, its parent line and drag preview, dependency rows, team flyout rows.
    expect(found.length).toBeGreaterThanOrEqual(18)
    expect(raw.filter((h) => !allowed(h))).toEqual([])
  })

  it('every allowed entry still matches a render (the list only shrinks)', () => {
    const all = [
      ...ROW_FILES.flatMap((rel) => rowFileRenders(path.join(webSrc, rel))),
      ...titleClassElements().raw,
    ]
    for (const key of Object.keys(ALLOWED)) {
      const [file, expr] = key.split('|')
      expect(all.some((h) => h.startsWith(file) && h.endsWith(`|${expr}`)), key).toBe(true)
    }
  })

  it('local task pickers search their shown names and retain raw-name matching', () => {
    for (const file of ['components/tasks/adopt-candidates.ts', 'components/tasks/team-menu-model.ts', 'components/notes/slash-commands/TaskSearchPanel.tsx']) {
      const source = fs.readFileSync(path.join(webSrc, file), 'utf8');
      expect(source, file).toContain('orgDisplayTitle(t)');
      expect(source, file).toContain('projectDisplayName(t.project)');
      expect(source, file).toContain('t.title');
    }
  });

  it('every hosted note editor can find tasks without a caller-specific task feed', () => {
    const source = fs.readFileSync(path.join(webSrc, 'components/notes/NotesEditor.tsx'), 'utf8');
    expect(source).toContain('tasks={tasks}');
    expect(source).not.toContain('useTasksContextSafe()');
    const portal = fs.readFileSync(path.join(webSrc, 'components/notes/slash-commands/SlashCommandPortal.tsx'), 'utf8');
    expect(portal).toContain('useTasksContextSafe()');
    expect(portal).toContain('tasks={tasks ?? sharedTasks?.tasks ?? []}');
    expect(portal).toContain('!e.composedPath().includes(panelRef.current)');
    expect(portal).not.toContain('panelRef.current.contains(e.target');
  });

  it('resolves dependency display names without changing the frozen task reference', () => {
    const source = fs.readFileSync(path.join(webSrc, 'components/tasks/TaskDetailEdits.tsx'), 'utf8')
    expect(source).toMatch(/useEntityLabelsVersion\(\)/)
    expect(source).toMatch(/lookupTaskLabel\(reference\.id\)/)
    expect(source).toMatch(/resolveTaskToken\(reference\.id\)\?\.label\.project/)
    expect(source).not.toMatch(/resolveTaskToken\(reference\.id\)\?\.label\.title/)
    // The two dependency chips' text (their titles went: a cut-off chip peeks in place, utils/truncation-peek.ts).
    expect(source.match(/displayTitle\(dep\)/g)).toHaveLength(2)
    expect(source).toContain('orgDisplayTitle(t).toLowerCase().includes(needle)')
  })
})

/**
 * Session titles follow the same rule (2026-11-08, round 2 review: the task details popup read
 * "Quick question" in its title and project and "Ask Walnut" on its Session row, because the row
 * drew `record.title` itself). The class: a surface that shows a session record's own title. Its
 * members are listed here; an element anywhere carrying a session title class is checked too, one
 * local variable deep, so a new session row drawing `record.title` fails.
 */
const SESSION_TITLE_FILES = [
  'components/tasks/TaskDetailRows.tsx',
  'components/sessions/SessionSearchPanel.tsx',
  'components/sessions/SearchAnswerCard.tsx',
  'popout/PopoutSession.tsx',
]

const SESSION_TITLE_CLASS = /(?:^|[\s`'"])(tdp-row-title|session-search-title|agent-search-row-title)(?![-\w])/

/** `file|expression` → why a raw `.title` read in a session title file is already a display name. */
const SESSION_ALLOWED: Record<string, string> = {
  'web/src/components/tasks/AgentSearchResultRows.tsx|row.title': 'SearchAnswerCard builds its rows from the label store and orgDisplayTitle',
}

const DISPLAY_RULES = new Set(['orgDisplayTitle', 'sessionDisplayName', 'sessionRecordTitle', 'projectDisplayName'])

/** The local `const x = ...` initializers of a file, by name, for one hop from `{x}` to what it holds. */
function localInits(sf: ts.SourceFile): Map<string, ts.Expression[]> {
  const inits = new Map<string, ts.Expression[]>()
  const visit = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      inits.set(node.name.text, [...(inits.get(node.name.text) ?? []), node.initializer])
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return inits
}

/** Raw `.title` leaves an expression shows, following a bare identifier to its local initializers. */
function shownRawTitles(expr: ts.Expression, inits: Map<string, ts.Expression[]>, sf: ts.SourceFile, out: string[]): void {
  for (const leaf of renderedLeaves(expr)) {
    if (isRawTitle(leaf)) out.push(where(sf, leaf))
    else if (ts.isIdentifier(leaf)) for (const init of inits.get(leaf.text) ?? []) for (const l of renderedLeaves(init)) if (isRawTitle(l)) out.push(where(sf, l))
  }
}

/** In a session title file: what JSX shows, text attributes, template literals, `title:` fields and document.title. */
function sessionFileRenders(file: string): string[] {
  const sf = parse(file)
  const inits = localInits(sf)
  const hits: string[] = []
  const visit = (node: ts.Node) => {
    // What a display rule is handed is the stored value it names, not a render.
    if (ts.isCallExpression(node) && DISPLAY_RULES.has(node.expression.getText())) return
    if (ts.isJsxExpression(node) && node.expression) {
      const parent = node.parent
      if (ts.isJsxAttribute(parent)) {
        const name = parent.name.getText()
        if (!DATA_ATTRS.has(name) && !name.startsWith('data-') && !name.startsWith('on')) shownRawTitles(node.expression, inits, sf, hits)
      } else if (ts.isJsxElement(parent) || ts.isJsxFragment(parent)) {
        shownRawTitles(node.expression, inits, sf, hits)
      }
    }
    if (ts.isTemplateExpression(node)) for (const span of node.templateSpans) shownRawTitles(span.expression, inits, sf, hits)
    if (ts.isPropertyAssignment(node) && node.name.getText() === 'title') shownRawTitles(node.initializer, inits, sf, hits)
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken && node.left.getText() === 'document.title') {
      shownRawTitles(node.right, inits, sf, hits)
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return [...new Set(hits)]
}

/** Elements anywhere in web/src carrying a session title class, and the raw titles they show. */
function sessionTitleClassElements(): { found: string[]; raw: string[] } {
  const found: string[] = []
  const raw: string[] = []
  for (const file of tsxFiles(webSrc)) {
    const sf = parse(file)
    const inits = localInits(sf)
    const visit = (node: ts.Node) => {
      if (ts.isJsxElement(node)) {
        const cls = node.openingElement.attributes.properties.find(
          (a): a is ts.JsxAttribute => ts.isJsxAttribute(a) && a.name.getText() === 'className',
        )
        if (cls?.initializer && SESSION_TITLE_CLASS.test(cls.initializer.getText())) {
          found.push(where(sf, node.openingElement))
          for (const child of node.children) if (ts.isJsxExpression(child) && child.expression) shownRawTitles(child.expression, inits, sf, raw)
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(sf)
  }
  return { found, raw }
}

const sessionAllowed = (hit: string) => Object.keys(SESSION_ALLOWED).some((k) => hit.startsWith(k.split('|')[0]) && hit.endsWith(`|${k.split('|')[1]}`))

describe('session display names: sessionDisplayName', () => {
  it('names the CEO\'s and a VP\'s session as their node and an ask placeholder as Quick question; other titles stay', () => {
    expect(sessionDisplayName('Ask Walnut', { project: 'Ask Walnut' })).toBe('Quick question')
    expect(sessionDisplayName('ask walnut ', { project: 'Ask Walnut' })).toBe('Quick question')
    expect(sessionDisplayName('Ask Mentor', { project: 'Ask Mentor' })).toBe('Quick question · Mentor')
    expect(sessionDisplayName('Main', { title: 'Main', project: 'Main', org_role: 'main' })).toBe('CEO')
    expect(sessionDisplayName('Alpha lead', { title: 'Alpha lead', project: 'Alpha', org_role: 'lead' })).toBe('Alpha VP')
    expect(sessionDisplayName('Ask Walnut greeting', { project: 'Ask Walnut' })).toBe('Ask Walnut greeting')
    expect(sessionDisplayName('Ask Walnut', { project: 'Garden' })).toBe('Ask Walnut')
    expect(sessionDisplayName('Fix the build')).toBe('Fix the build')
  })
})

describe('a note names a task once where its project reads the same', () => {
  it('writes project / task, and an ask placeholder once', () => {
    expect(taskReferenceLabel({ title: 'Fix the build', project: 'Alpha' })).toBe('Alpha / Fix the build')
    expect(taskReferenceLabel({ title: 'Ask Mentor', project: 'Ask Mentor' })).toBe('Quick question \u00b7 Mentor')
    expect(taskReferenceLabel({ title: 'Ask Walnut', project: 'Ask Walnut' })).toBe('Quick question')
    expect(taskReferenceLabel({ title: 'Ask Bob about lease', project: 'Ask Walnut' })).toBe('Quick question / Ask Bob about lease')
    expect(taskReferenceLabel({ title: 'Loose task', project: '' })).toBe('Loose task')
  })
})

describe('session title surfaces show the display name (ratchet)', () => {
  it('finds the session title files, and each names sessions through the display rule', () => {
    for (const rel of SESSION_TITLE_FILES) {
      const file = path.join(webSrc, rel)
      expect(fs.existsSync(file), rel).toBe(true)
      expect(fs.readFileSync(file, 'utf8'), rel).toMatch(/sessionDisplayName\(|sessionRecordTitle\(|orgDisplayTitle\(/)
    }
  })

  it('no session title file shows a raw `.title`', () => {
    const hits = SESSION_TITLE_FILES.flatMap((rel) => sessionFileRenders(path.join(webSrc, rel))).filter((h) => !sessionAllowed(h))
    expect(hits).toEqual([])
  })

  it('no element with a session title class shows a raw `.title`, in any file', () => {
    const { found, raw } = sessionTitleClassElements()
    // The task details Session and Earlier sessions row, the session finder, the search answer rows.
    expect(found.length).toBeGreaterThanOrEqual(3)
    expect(raw.filter((h) => !sessionAllowed(h))).toEqual([])
  })

  it('every allowed entry still matches a read (the list only shrinks)', () => {
    const all = [...SESSION_TITLE_FILES.flatMap((rel) => sessionFileRenders(path.join(webSrc, rel))), ...sessionTitleClassElements().raw]
    for (const key of Object.keys(SESSION_ALLOWED)) {
      const [file, expr] = key.split('|')
      expect(all.some((h) => h.startsWith(file) && h.endsWith(`|${expr}`)), key).toBe(true)
    }
  })

  it('the details popup hands its task to every session row', () => {
    const pane = fs.readFileSync(path.join(webSrc, 'components/tasks/TaskDetailPane.tsx'), 'utf8')
    expect(pane.match(/owner=\{task\}/g)).toHaveLength(2)
    const history = fs.readFileSync(path.join(webSrc, 'components/tasks/TaskSessionHistory.tsx'), 'utf8')
    expect(history).toContain('owner={owner}')
  })
})

describe('a late blur never renames a task to its display name (source check)', () => {
  const hook = fs.readFileSync(path.join(webSrc, 'components/tasks/useInlineTitleEdit.ts'), 'utf8')
  const sf = ts.createSourceFile('useInlineTitleEdit.ts', hook, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)

  /** The body text of `const <name> = useCallback(...)`. */
  function callbackBody(name: string): string {
    let body = ''
    const visit = (node: ts.Node) => {
      if (ts.isVariableDeclaration(node) && node.name.getText() === name && node.initializer && ts.isCallExpression(node.initializer)) {
        const fn = node.initializer.arguments[0]
        if (fn && (ts.isArrowFunction(fn) || ts.isFunctionExpression(fn))) body = fn.body.getText()
      }
      ts.forEachChild(node, visit)
    }
    visit(sf)
    return body
  }

  it('commit runs only while the edit ref is open, and closes it before anything else', () => {
    const body = callbackBody('commitEdit').replace(/\s+/g, ' ')
    expect(body).toMatch(/^\{ if \(!editingRef\.current\) return; editingRef\.current = false;/)
  })

  it('cancel closes the ref, and only startEdit opens it', () => {
    expect(callbackBody('cancelEdit')).toMatch(/editingRef\.current = false/)
    expect(callbackBody('startEdit')).toMatch(/editingRef\.current = true/)
    const opens = hook.match(/editingRef\.current = true/g) ?? []
    expect(opens.length).toBe(1)
    // One guard, not two: the old re-entry flag could not stop a blur after the commit.
    expect(hook).not.toMatch(/isCommittingRef/)
  })

  it('the commit compares the span text against the stored title', () => {
    expect(callbackBody('commitEdit')).toMatch(/titleEditRename\(task\.title,/)
  })
})
