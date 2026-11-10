/** Every client and server writer goes through the human-source gate. */
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
const read = (p: string) => readFileSync(join(__dirname, '../..', p), 'utf8')
describe('Recent human touches', () => {
  it('focus renders never record; every open recorder requires trusted input', () => {
    const home = read('web/src/pages/MainPage.tsx')
    expect(home).not.toContain('if (focusNonce > 0) recordTaskOpened')
    const recorder = read('web/src/utils/recent-opened.ts')
    expect(recorder).toContain('if (!event.isTrusted) return;')
    expect(recorder).toContain('if (!personOpening) return;')
    expect(recorder).toContain('const permitted = personOpening;')
    expect(home).toContain('recordOpen: recentOpenRecorder()')
  })
  it('server creates and all queue writers gate on the person source', () => {
    for (const p of ['src/web/routes/tasks.ts', 'src/web/routes/api-v1.ts', 'src/core/sessions/quick-start.ts', 'src/core/sessions/task-start.ts', 'src/core/sessions/side-thread-promote.ts', 'src/core/sessions/session-extras.ts', 'src/web/routes/search-agent.ts', 'src/core/boards/board-kanban.ts', 'src/core/offline-merge/apply-v2.ts', 'src/core/org/org-node-edit.ts']) {
      expect(read(p), p).toContain('recordRecentTaskTouch(')
    }
    expect(read('src/core/session-message-queue.ts')).toContain("msg.sentBy === 'person' && !inherited")
    expect(read('src/core/session-message-queue.ts')).toContain('noteRecentHumanMessage(sessionId, opts?.recentText ?? message, msg.enqueuedAt)')
    expect(read('src/core/recent-task-touch.ts')).toContain('!isPersonSource(source)')
    expect(read('src/web/routes/ui-prefs.ts')).toContain('delete patch[RECENT_OPENED_KEY]')
  })
  it('a new task creation path must declare whether a person or automation owns it', () => {
    const paths: string[] = []
    const walk = (dir: string) => {
      for (const entry of readdirSync(join(__dirname, '../..', dir), { withFileTypes: true })) {
        const file = `${dir}/${entry.name}`
        if (entry.isDirectory()) walk(file)
        else if (entry.name.endsWith('.ts') && /\b(?:addTask|addTaskIdempotently|addTasksBulk|addTaskFull)\(/.test(read(file))) paths.push(file)
      }
    }
    walk('src')
    const human = [
      'src/commands/direct-commands.ts', 'src/core/org/org-node-edit.ts', 'src/web/routes/tasks.ts',
      'src/core/offline-merge/apply-v2.ts', 'src/core/boards/board-kanban.ts', 'src/core/sessions/side-thread-promote.ts',
      'src/core/sessions/session-extras.ts', 'src/core/sessions/quick-start.ts', 'src/core/sessions/session-controls.ts',
    ]
    // Attribution belongs to their caller, not the generic storage function.
    const storage = ['src/core/task-manager.ts', 'src/core/integration-types.ts', 'src/core/task-create-idempotency.ts']
    // Automatic imports, routing, system nodes and scheduled repairs never count as a person.
    const automatic = [
      'src/integrations/jira/index.ts', 'src/integrations/ms-todo/index.ts', 'src/core/router/service.ts',
      'src/core/router/nodes.ts', 'src/core/org/org-store.ts', 'src/core/sessions/lane-ask-link.ts',
      'src/core/routines/executors/watcher.ts', 'src/core/sessions/external-session-import.ts',
      'src/core/sessions/personal-ai-lane.ts', 'src/web/routes/content-v1.ts', 'src/core/health-monitor/fix-task.ts',
      'src/core/sync-reconciler.ts', 'src/core/plugins/server-api.ts', 'src/web/server.ts',
    ]
    // AI search and conversation promotion record at their HTTP caller, which identifies the person.
    const caller = ['src/core/sessions/adopt-search-session.ts', 'src/web/routes/api-v1.ts', 'src/core/task-outbox.ts']
    expect(paths.sort()).toEqual([...human, ...storage, ...automatic, ...caller].sort())
    for (const file of human) expect(read(file), file).toContain('recordRecentTaskTouch(')
    expect(read('src/core/task-outbox.ts')).toContain('op.humanTouchAt')
    expect(read('src/core/task-queue.ts')).toContain('humanTouchAt: op.humanTouchAt')
    expect(read('src/core/companion-journal.ts')).toContain('humanTouchAt: input.humanTouchAt')
    expect(read('src/core/offline-merge/apply-v2.ts')).toContain('record.humanTouchAt')
    expect(read('src/web/routes/conversations.ts')).toContain('recordRecentTaskTouch(')
    expect(read('src/web/routes/search-agent.ts')).toContain("routeSource('ui', req.headers)")
  })
  it('cross-window, native links and board clicks preserve person input; replay preserves time', () => {
    expect(read('web/src/popout/openPopout.ts')).toContain('human: hasRecentHumanInput()')
    expect(read('web/src/App.tsx')).toContain('human === true) withRecentHumanInput')
    // The extension side panel's own opens (2026-11-10: none were recorded, so its tasks were missing from Recent).
    const panel = read('web/src/popout/PopoutExtPanel.tsx')
    for (const fn of ['pickAsk', 'openTask', 'openDetail']) {
      const body = panel.slice(panel.indexOf(`const ${fn} = useCallback(`)).split('\n  }, [')[0]
      expect(body, fn).toContain('recordTaskOpened(')
    }
    expect(read('web/src/App.tsx')).toContain('withRecentHumanInput(() => navigateToTarget')
    const elements = read('web/src/components/board/board-elements.frame.js')
    expect(elements).toContain('openTaskFromInput(self, e)')
    expect(elements).not.toMatch(/\bwnOpen\s*\(/)
    expect(read('web/src/components/board/TaskBoardPane.tsx')).toContain('document.activeElement === frameRef.current')
    expect(read('src/core/workspaces/manager.ts')).toContain('requestedAt: pending.at')
    expect(read('src/core/workspaces/manager.ts')).toContain('requestTs: Date.parse(pending.at)')
  })
  it('the phone reads the same list and restoration is not an open', () => {
    expect(read('ios-native/Walnut/API/WalnutAPIRecentOpened.swift')).toContain('walnut-todo-recent-opened')
    expect(read('ios-native/Walnut/Views/Tasks/TasksTabView.swift')).toContain(String.raw`.environment(\.recordsSessionOpen, false)`)
    expect(read('ios-native/Walnut/Views/Chat/ChatView.swift')).toContain('session.id != restoredAtLaunch')
  })
})
