/**
 * The toast rule (.claude/skills/walnut-ui-requirements/standard.md, "Toasts"): a toast only for a
 * failure the person cannot see, news from out of sight, or the Undo of a change that takes its
 * object out of view. Never for what the person just did and can see.
 *
 * 2026-11-21: creating a calendar event popped "Event created" with an Undo in the far corner while
 * the new block sat on the grid under the pointer, and every pin, move, resize and copy did the
 * same; the user complained. No rule said when a toast was allowed, so 140-odd calls each decided.
 *
 * This enumerates every toast from the source (the notice stack's inputs, the thread panel's and
 * the board's toasts, and the undo stack's entries) and fails when one has no reason, when a failure
 * reads as a success, or when a toast that is not a failure is not on the lists below. A new one is
 * added to a list only with the reason the person cannot see what it says.
 */
import fs from 'node:fs'
import path from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { walk } from './css-scan'

const WEB_SRC = path.resolve(import.meta.dirname, '../../web/src')

/** Notices that are not failures, as `file :: title :: reason`. Each says why it is out of sight. */
const NOTICES_OUT_OF_SIGHT = [
  // A task saved from a chat drawer lands on Home, which is not on screen.
  'components/chat/AskObjectDrawer.tsx :: `Task created: ${task.title}` :: out-of-sight',
  // An update downloaded in the background.
  "components/layout/useAppUpdateActions.ts :: 'Update downloaded' :: out-of-sight",
  // A drag switched the list's sort mode to Manual: the mode itself is not on screen.
  "components/tasks/TodoPanel.tsx :: 'Sort' :: out-of-sight",
  // The bar is gone; the line says where it comes back, and its Undo brings it now.
  "components/tasks/TodoSectionTabs.tsx :: 'Tab bar hidden. Turn it back on in Display' :: undo-of-hidden",
  // The chips are gone with what they filtered.
  "components/tasks/useHomeFilters.ts :: 'Filters cleared' :: undo-of-hidden",
  // A task just created that the filters hide: it leaves the list once the person moves on.
  'components/tasks/useHomeFilters.ts :: `Saved to ${projectLabel(projectGroupKey(task.project))}. ${hiddenByText(reasons… :: out-of-sight',
  // A card a Sort decision took leaves the queue.
  'components/tasks/QuickSortView.tsx :: decision.label :: undo-of-hidden',
  // A workspace set up or cleaned up in the background.
  'components/workspaces/useCleanupNotices.ts :: n.title :: out-of-sight',
  // The app opened a panel on its own because every panel was pinned.
  'pages/MainPage.tsx :: `Panels auto-increased from ${before} to ${newCount}` :: out-of-sight',
  // Background news: a cron run, a new skill, and every record the server pushes (asks, reminders).
  "contexts/notifications/NotificationProvider.tsx :: jobName :: out-of-sight",
  'contexts/notifications/NotificationProvider.tsx :: title ?? `New skill: ${name}` :: out-of-sight',
  "contexts/notifications/NotificationProvider.tsx :: r.title :: kind === 'operation-error' ? 'failure' : 'out-of-sight'",
  // A host the person must sign in to, or that answers their Retry.
  'components/common/HostProblemNotices.tsx :: (spread) :: out-of-sight',
  // An item sent to a chat that is not on screen; the content actions' toasts pass their own
  // reason through (each is listed here as the content-actions.ts line).
  'utils/content-actions.ts :: answer.testRun ? `Sent to the stand-in for ${who} (test run)` : `Sent to ${who}` :: out-of-sight',
  'components/content/ContentActionsHost.tsx :: t.title :: t.toastReason',
  // The undo stack's toast, shown only for an entry whose result is hidden (UNDO_HIDDEN below).
  'undo/TaskUndoContext.tsx :: entry.title :: undo-of-hidden',
].sort()

/** Failures at info severity: a key or click that did nothing, with nothing on screen to say so. */
const QUIET_FAILURES = [
  "components/transfer/TransferDialogHost.tsx :: 'A transfer is still running' :: failure",
  "pages/MainPage.tsx :: message :: failure",
  "undo/TaskUndoContext.tsx :: 'Nothing to redo' :: failure",
  "undo/TaskUndoContext.tsx :: 'Nothing to undo' :: failure",
  "undo/TaskUndoContext.tsx :: 'Not undone: it changed since' :: failure",
].sort()

/** Thread panel and board toasts that are not failures, as `file :: text :: reason`. */
const PANEL_UNDOS = [
  // An archived question leaves the list; so do older ones archived together.
  'hooks/useThreadActions.ts :: text :: undo-of-hidden',
  'hooks/useThreadActions.ts :: olderDoneToastText(p.keys.length) :: undo-of-hidden',
  // A removed question and a removed pin leave the drawer.
  'hooks/useThreadActions.ts :: removeToastText(title, p.descendants) :: undo-of-hidden',
  "components/sessions/ThreadTreeRows.tsx :: 'Removed pin' :: undo-of-hidden",
  // A completed card leaves its lane.
  'components/board/kanban/useKanbanWrites.ts :: `Completed ${quote(title)}` :: undo-of-hidden',
  // A card dropped in a done lane whose task did not complete (or the reverse): the task is out of sight.
  'components/board/kanban/useKanbanWrites.ts :: `Moved to ${m.laneName}. The task is still open.` :: out-of-sight',
  'components/board/kanban/useKanbanWrites.ts :: `Moved to ${m.laneName}. The task stays complete.` :: out-of-sight',
  // A move from a menu or the keys: the card may land in a lane out of sight (Show finds it).
  "components/board/kanban/useKanbanWrites.ts :: `Moved ${quote(m.title)} to ${m.laneName}` :: m.reason === 'drag' ? 'out-of-sight' : 'undo-of-hidden'",
].sort()

/** Undo stack entries whose result is hidden (they toast), as `file :: title :: result`. Every
 *  other entry is `result: 'visible'`: no toast, mod+z takes it back. */
const UNDO_HIDDEN = [
  "undo/TaskUndoContext.tsx :: nowDone ? 'Task completed' : 'Task reopened' :: nowDone ? 'hidden' : 'visible'",
  "undo/TaskUndoContext.tsx :: next ? `Snoozed until ${formatSnoozeDate(next)}` : 'Snooze cleared' :: next ? 'hidden' : 'visible'",
  "undo/TaskUndoContext.tsx :: 'Task deleted' :: hidden",
  // An unpinned task leaves the pinned list and the Focus views it sat in.
  "undo/TaskUndoContext.tsx :: 'Unpinned' :: hidden",
  // A reload brings an entry back as it was saved.
  "undo/TaskUndoContext.tsx :: saved.title :: saved.result ?? 'hidden'",
  "undo/TaskUndoContext.tsx :: v.entry.title :: v.entry.result",
  "pages/MainPage.tsx :: 'Task completed' :: hidden",
  "pages/useColumnCompleteClose.ts :: 'Task completed' :: hidden",
  // Unscheduled or its deadline cleared: the item leaves the calendar grid.
  "components/calendar/calendar-item-actions.ts :: 'Deadline cleared' :: hidden",
  "components/calendar/calendar-item-actions.ts :: 'Task unscheduled' :: hidden",
  // The calendar's own writers pass their caller's result through.
  'components/calendar/calendar-item-actions.ts :: title :: result',
].sort()

interface Found { file: string; line: number; title: string; reason?: string; severity?: string }

const text = (n: ts.Node | undefined) => (n ? n.getText().replace(/\s+/g, ' ').replace(/ as const$/, '') : '')
const short = (s: string) => (s.length > 80 ? `${s.slice(0, 80)}…` : s)
const strip = (s: string) => s.replace(/^'(.*)'$/, '$1')

function props(o: ts.ObjectLiteralExpression): Map<string, string> {
  const out = new Map<string, string>()
  for (const p of o.properties) {
    if (!p.name) continue
    const k = p.name.getText()
    if (ts.isPropertyAssignment(p)) out.set(k, text(p.initializer))
    else if (ts.isShorthandPropertyAssignment(p)) out.set(k, k)
    else out.set(k, '')
  }
  return out
}

function scan() {
  const notices: Found[] = []
  const panel: Found[] = []
  const undos: Found[] = []
  for (const file of walk(WEB_SRC, ['.ts', '.tsx']).sort()) {
    if (/\.test\.|\.d\.ts$/.test(file)) continue
    const src = fs.readFileSync(file, 'utf8')
    if (!/notify|toast|undo/i.test(src)) continue
    const rel = path.relative(WEB_SRC, file)
    const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
    const pushesUndo = /useTaskUndo|UndoablePush/.test(src)
    const at = (n: ts.Node) => sf.getLineAndCharacterOfPosition(n.getStart()).line + 1
    const visit = (n: ts.Node) => {
      if (ts.isObjectLiteralExpression(n)) {
        const p = props(n)
        // A notice for the stack (NotificationInput): kind and severity, handed to notify() or built
        // with its reason (a feed record the page loads is not a toast). A content action's toast
        // (ContentToast) is one too: severity, title and dedupKey.
        const toNotify = ts.isCallExpression(n.parent) && /notify$/i.test(text(n.parent.expression).split('.').pop() ?? '')
        const notice = p.has('kind') && p.has('severity') && (toNotify || p.has('toastReason'))
        const content = !p.has('kind') && p.has('severity') && p.has('title') && p.has('dedupKey')
        if (notice || content) {
          notices.push({ file: rel, line: at(n), title: short(p.get('title') ?? '(spread)'), reason: p.get('toastReason'), severity: strip(p.get('severity')!) })
        }
        // An undo stack entry (UndoablePush): key, title and its undo (or a revived one's result).
        if (p.has('key') && p.has('title') && (p.has('undo') || p.has('result'))) undos.push({ file: rel, line: at(n), title: short(p.get('title')!), reason: p.get('result') })
      }
      if (ts.isCallExpression(n)) {
        const callee = text(n.expression).split('.').pop() ?? ''
        // The thread panel's toast (`toast.show`) and the board's (`toasts.push`, emitKanbanToast):
        // a text with its time, buttons, tone or reason.
        if (callee === 'show' || callee === 'push' || callee === 'emitKanbanToast') {
          for (const arg of n.arguments) {
            if (!ts.isObjectLiteralExpression(arg)) continue
            const p = props(arg)
            if (p.has('text') && ['ms', 'action', 'actions', 'tone', 'toastReason'].some((k) => p.has(k))) {
              panel.push({ file: rel, line: at(n), title: short(p.get('text') ?? ''), reason: p.get('toastReason') })
            }
          }
        }
      }
      // A writer that pushes an undo entry for its caller (calendar): the call names 'hidden'.
      if (pushesUndo && ts.isCallExpression(n) && n.arguments.some((a) => ts.isStringLiteral(a) && a.text === 'hidden')) {
        const title = n.arguments.find((a) => ts.isStringLiteral(a) && a.text !== 'hidden')
        undos.push({ file: rel, line: at(n), title: text(title), reason: 'hidden' })
      }
      ts.forEachChild(n, visit)
    }
    visit(sf)
  }
  return { notices, panel, undos }
}

const REASONS = /^(?:'failure'|'out-of-sight'|'undo-of-hidden'|t\.toastReason|.*\? '(?:failure|out-of-sight|undo-of-hidden)' : '(?:failure|out-of-sight|undo-of-hidden)')$/
const where = (f: Found) => `${f.file}:${f.line} ${f.title}`
const key = (f: Found) => `${f.file} :: ${f.title} :: ${strip(f.reason ?? '')}`

describe('toast reasons (standard.md "Toasts")', () => {
  const { notices, panel, undos } = scan()

  it('finds the toasts it guards (the scan still sees them)', () => {
    expect(notices.length).toBeGreaterThan(40)
    expect(panel.length).toBeGreaterThan(8)
    expect(undos.length).toBeGreaterThan(10)
  })

  it('every notice, panel toast and board toast names its reason', () => {
    const bad = [...notices, ...panel].filter((f) => !f.reason || !REASONS.test(f.reason)).map(where)
    expect(bad, 'Add toastReason: failure | out-of-sight | undo-of-hidden (standard.md "Toasts"); a visible change gets no toast').toEqual([])
  })

  it('a failure reads as a warning or an error; the few quiet ones (a key that did nothing) are listed', () => {
    const bad = notices.filter((f) => f.severity === 'success' && f.reason === "'failure'").map(where)
    expect(bad).toEqual([])
    const quiet = notices.filter((f) => f.reason === "'failure'" && f.severity === 'info').map(key).sort()
    expect(quiet, 'A failure at info severity is how a visible action would sneak a toast in: list it only if it is a key or click that did nothing').toEqual(QUIET_FAILURES)
  })

  it('every notice that is not a failure is one the person cannot see otherwise (listed by name)', () => {
    const found = notices.filter((f) => f.reason !== "'failure'").map(key).sort()
    expect(found, 'A new toast for something the person just did and can see is not allowed. If it is out of sight, list it with why.').toEqual(NOTICES_OUT_OF_SIGHT)
  })

  it('every panel and board toast that is not a failure is the Undo of a change that hides its object', () => {
    const found = panel.filter((f) => f.reason !== "'failure'").map(key).sort()
    expect(found).toEqual(PANEL_UNDOS)
  })

  it('every undo entry says whether its result is hidden, and only the listed ones toast', () => {
    const missing = undos.filter((f) => !f.reason).map(where)
    expect(missing, "Add result: 'visible' (no toast, mod+z) or 'hidden' (an Undo toast, listed here)").toEqual([])
    const toasting = undos.filter((f) => f.reason !== "'visible'").map(key).sort()
    expect(toasting).toEqual(UNDO_HIDDEN)
  })

  it('no view draws a toast of its own: every toast class is one of the shared ones', () => {
    const SHARED = new Set(['notification-toast', 'nfc-perm-toast', 'thread-toast', 'kanban-toast'])
    const own: string[] = []
    for (const file of walk(WEB_SRC, ['.css'])) {
      for (const m of fs.readFileSync(file, 'utf8').matchAll(/\.([a-z][a-z0-9-]*-toast)\b/g)) {
        if (!SHARED.has(m[1])) own.push(`${path.relative(WEB_SRC, file)}: .${m[1]}`)
      }
    }
    expect([...new Set(own)]).toEqual([])
  })
})
