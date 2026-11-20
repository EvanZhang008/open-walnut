/**
 * Ratchet: who reads the WHOLE task store context.
 *
 * `useTasksContext` / `useTasksContextSafe` hand a component the rows and the writes in one value,
 * which changes on every task write: every reader draws again for a status write of a task it does
 * not show. A component that shows one row reads it with `useStoreTask` (drawn only when that row
 * changes); a hook or panel that only WRITES reads `useTaskStoreActions` (never redrawn by the
 * rows). 2026-11-20: the Org threads hook took the full context for `predictStatus`, and the open
 * chat it is mounted in (SessionPanelBody) drew once per agent status write
 * (tests/e2e/browser/app-responsiveness-budget.spec.ts:215 caught it on main).
 *
 * The list below is every reader today. A new one fails until it is listed here with why it
 * needs the rows themselves; one that stops reading the context is removed. The count only falls.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const WEB_SRC = join(__dirname, '../../web/src')

const READERS = new Set([
  'apps/mail/MailRouterRows.tsx', 'apps/mail/MailRouterSettings.tsx',
  'components/board/kanban/BoardKanban.tsx', 'components/board/kanban/KanbanCardEditor.tsx', 'components/board/kanban/KanbanDetailTask.tsx',
  'components/board/kanban/useKanbanBoard.ts', 'components/board/TaskBoardPane.tsx', 'components/board/useTeamOverview.ts',
  'components/calendar/CalendarSidePanel.tsx', 'components/calendar/QuickCreatePopover.tsx', 'components/chat/MentionPalette.tsx',
  'components/common/OperationErrorBridge.tsx', 'components/dock/FocusDock.tsx', 'components/layout/PageSideBar.tsx',
  'components/layout/ScratchpadHost.tsx', 'components/notes/slash-commands/SlashCommandPortal.tsx',
  'components/org/OrgAlertSnooze.tsx', 'components/org/OrgTaskRail.tsx',
  'components/sessions/AppTaskbar.tsx', 'components/sessions/DraftSessionPanel.tsx', 'components/sessions/EditableSessionTitle.tsx',
  'components/sessions/SessionThreadsPane.tsx', 'components/sessions/TaskQuickActions.tsx',
  'components/settings/sections/TriageRoutingRules.tsx',
  'components/tasks/AdoptWorkerFlyout.tsx', 'components/tasks/AgentSearchResultRows.tsx', 'components/tasks/BulkTaskSettings.tsx',
  'components/tasks/HomeBoardSheet.tsx', 'components/tasks/LeaderPill.tsx', 'components/tasks/PhoneTaskDetailHead.tsx',
  'components/tasks/PluginFieldPicker.tsx', 'components/tasks/ProjectDetailPane.tsx', 'components/tasks/PrPill.tsx',
  'components/tasks/QuickSortFilter.tsx', 'components/tasks/QuickSortView.tsx', 'components/tasks/ReleaseWorkerFlyout.tsx',
  'components/tasks/SubtaskPill.tsx', 'components/tasks/TaskDetailEdits.tsx', 'components/tasks/TaskDetailPane.tsx',
  'components/tasks/TaskStatusControl.tsx', 'components/tasks/TaskViewSurface.tsx', 'components/tasks/TeamMenuItems.tsx',
  'components/tasks/TodoPanel.tsx', 'components/tasks/WatchToggle.tsx',
  'contexts/TasksContext.tsx', 'hooks/useFocusBar.ts', 'hooks/useProjectActions.ts',
  'pages/CalendarPage.tsx', 'pages/DashboardPage.tsx', 'pages/MainPage.tsx', 'pages/OrgPage.tsx',
  'popout/ExtHomeTasks.tsx', 'popout/ExtTaskDetail.tsx', 'popout/PopoutExtPanel.tsx', 'popout/PopoutExtTasks.tsx', 'popout/useExtAsks.ts',
  'undo/TaskUndoContext.tsx',
])

/** Hooks an open chat keeps mounted: they never take the full context (the incident). */
const NEVER = ['components/org/useOrgThreads.ts', 'components/board/kanban/useKanbanWrites.ts', 'components/sessions/SessionPanel.tsx']

function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) out.push(...sourceFiles(p))
    else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) && !/\.d\.ts$/.test(name)) out.push(p)
  }
  return out
}

const CALL = /\buseTasksContext(?:Safe)?\(/

function readers(): string[] {
  return sourceFiles(WEB_SRC)
    .filter((f) => CALL.test(readFileSync(f, 'utf8')))
    .map((f) => relative(WEB_SRC, f).split('\\').join('/'))
    .sort()
}

describe('who reads the whole task store context', () => {
  const found = readers()

  it('the scan sees the readers it pins', () => {
    expect(found).toContain('components/tasks/TodoPanel.tsx')
    expect(found.length).toBeGreaterThan(20)
  })

  it('no new file reads the whole context', () => {
    const added = found.filter((f) => !READERS.has(f))
    expect(added, `${added.join(', ')} read the whole task store context, which changes on every task write. Show one row with useStoreTask, write with useTaskStoreActions, or list it in READERS with why it needs the rows.`).toEqual([])
  })

  it('the list names only files that still read it', () => {
    const gone = [...READERS].filter((f) => !found.includes(f)).sort()
    expect(gone, `no longer read the context; remove from READERS:\n${gone.join('\n')}`).toEqual([])
  })

  it('the hooks an open chat keeps mounted take the writes only', () => {
    for (const rel of NEVER) {
      const src = readFileSync(join(WEB_SRC, rel), 'utf8')
      expect(CALL.test(src), `${rel} must use useStoreTask or useTaskStoreActions, never the whole context`).toBe(false)
    }
  })
})
