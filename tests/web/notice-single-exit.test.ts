/**
 * Every notice the web app shows goes out one door, and only what the person needs comes
 * through it (src/core/notifications/audience.ts). 2026-11-17, the user: one rule for the
 * whole system; only the errors he needs to see are shown, the rest goes to Walnut Health.
 *
 * The door is notify() (contexts/notifications/NotificationProvider.tsx): it toasts an error
 * only when audienceOf() says it is the person's, and an error a page raises there answers the
 * person's own action. Read from the source, so a new member of the class fails here:
 *  - a place that raises an error card (kind 'operation-error') or the task store's
 *    operation error, and the action of the person it answers;
 *  - an app dialog (useAlert) and the action it answers;
 *  - a native alert() outside the known places;
 *  - a notice outside the window (a web Notification, the Mac app's) anywhere but its one exit
 *    (contexts/notifications/system-notice.ts), which quiet holds whole;
 *  - a kind of notice no one decided the audience of, and a host problem surface that skips the rule.
 * Corner placement of every notice is tests/web/corner-stack-guard.test.ts; the server's
 * writers and reasons are tests/core/notifications/notice-audience.test.ts.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { SHOULD_TOAST, TOAST_DURATION_MS } from '../../web/src/contexts/notifications/types'
import { audienceOf, hostProblemNeedsYou } from '../../src/core/notifications/audience'
import { groupHealthErrors } from '../../web/src/components/settings/sections/health-error-log-model'
import type { Notification } from '../../web/src/contexts/notifications/types'

const WEB = path.resolve(import.meta.dirname, '../../web/src')

function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...sourceFiles(full))
    else if (/\.(ts|tsx)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) out.push(full)
  }
  return out
}
const FILES = sourceFiles(WEB).map((file) => ({ rel: path.relative(WEB, file), text: fs.readFileSync(file, 'utf8') }))
const filesMatching = (re: RegExp) => FILES.filter(({ text }) => re.test(text)).map(({ rel }) => rel).sort()

/** Every place that raises an error card, and the person's own action it answers. */
const ERROR_CARD_SITES: Record<string, string> = {
  'components/common/OperationErrorBridge.tsx': 'a task change the person made (the task store\'s operation error, sites below)',
  'components/common/NotificationActionButtons.tsx': 'a button the person pressed on a card',
  'components/layout/SidebarStatusItems.tsx': 'a status item action the person clicked',
  'components/layout/useAppUpdateActions.ts': 'the update button the person pressed',
  'components/sessions/ComposerModelPill.tsx': 'a model the person picked',
  'components/sessions/SessionPanel.tsx': 'Open in VS Code, clicked',
  'components/tasks/NavigationSections.tsx': 'a sidebar section the person dragged',
  'components/tasks/TaskSyncMenuRows.tsx': 'a sync setting the person changed',
  'components/tasks/useHomeFilters.ts': 'a filter the person archived',
  'contexts/notifications/NotificationProvider.tsx': 'the agent\'s credentials stopped working (needsYou sign-in); any other turn failure shows in its chat only',
  'hooks/useCalendarEvents.ts': 'a calendar event the person showed, hid or edited',
  'hooks/useChat.ts': 'a chat message the person sent',
  'hooks/useNavigationPreference.ts': 'a navigation preference the person set',
  'hooks/useSessionControls.ts': 'a session setting the person changed',
  'pages/MainPage.tsx': 'Quick Start, clicked',
  'popout/PopoutSession.tsx': 'Fork, clicked in a popout',
  'undo/TaskUndoContext.tsx': 'a pin or an undo the person pressed',
  'components/calendar/calendar-item-actions.ts': 'an event the person copied (Alt-drag) or redid could not be created',
}

/** Every place that reports through the task store's operation error (OperationErrorBridge). */
const OPERATION_ERROR_SITES: Record<string, string> = {
  'hooks/useTasks.ts': 'a task create, update, move or bulk change the person made',
  'hooks/useFocusBar.ts': 'a reorder or regroup the person dragged',
  'contexts/TasksContext.tsx': 'the store\'s own declaration',
  'components/sessions/TaskQuickActions.tsx': 'a quick action the person clicked',
  'components/tasks/TaskDetailPane.tsx': 'an edit in the task pane',
  'components/tasks/WatchToggle.tsx': 'a watch toggled by the person',
  'pages/OrgPage.tsx': 'a start the person clicked on the org page',
  'pages/MainPage.tsx': 'a panel the person opened or pinned, a search hit they picked',
  'popout/ExtHomeTasks.tsx': 'a task change in a popout',
}

/** Every app dialog (useAlert) and the action it answers. Its message goes through operationErrorWords. */
const ALERT_SITES: Record<string, string> = {
  'hooks/useConfirm.tsx': 'the dialog itself',
  'hooks/useProjectActions.ts': 'a project the person renamed, archived or deleted',
  'components/sessions/useFileTreeMutations.ts': 'a file the person duplicated or deleted',
  'components/notes/NotesTreePanel.tsx': 'a note the person moved, deleted or copied',
  'components/notes/useLockNote.ts': 'a note the person asked to encrypt, hide or open for good, and why it did not',
  'components/notes/AttachmentPreview.tsx': 'an attachment the person asked to open',
  'components/workspaces/WorkspaceMenuSection.tsx': 'a workspace action the person picked',
  'components/calendar/calendar-event-actions.ts': 'a calendar change the person confirmed',
  'pages/CommandsPage.tsx': 'a command the person deleted',
  'pages/NotesPage.tsx': 'a note the person created',
}

/** The one exit for a notice outside the window: it alone posts one, and quiet holds them all. */
const SYSTEM_NOTICE_EXIT = 'contexts/notifications/system-notice.ts'

/** Every caller of that exit: only asks and reminders, which wait on the person. */
const SYSTEM_NOTICE_CALLERS: Record<string, string> = {
  'contexts/notifications/NotificationProvider.tsx': 'notify() itself, for a permission ask or a reminder while the tab is hidden',
  'hooks/useChat.ts': 'the agent asks the person a question',
  'components/approvals/approval-notify.ts': 'a script waits on the person\'s approval',
}

describe('every notice the web app raises answers the person', () => {
  it('lists every place that raises an error card', () => {
    expect(filesMatching(/kind:\s*'operation-error'/)).toEqual(Object.keys(ERROR_CARD_SITES).sort())
  })

  it('lists every place that reports a task store operation error', () => {
    expect(filesMatching(/showOperationError/)).toEqual(Object.keys(OPERATION_ERROR_SITES).sort())
  })

  it('lists every app dialog', () => {
    expect(filesMatching(/\buseAlert\b/)).toEqual(Object.keys(ALERT_SITES).sort())
  })

  it('posts a system notification only through the one exit (a web Notification or the Mac app\'s)', () => {
    expect(filesMatching(/new Notification\(/)).toEqual([SYSTEM_NOTICE_EXIT])
    expect(filesMatching(/op:\s*'post'/)).toEqual([SYSTEM_NOTICE_EXIT])
  })

  it('lists every caller of that exit', () => {
    const callers = FILES.filter(({ rel, text }) => rel !== SYSTEM_NOTICE_EXIT && /\bpostSystemNotice\(/.test(text)).map(({ rel }) => rel).sort()
    expect(callers).toEqual(Object.keys(SYSTEM_NOTICE_CALLERS).sort())
  })

  it('never opens a native alert (only the dialog\'s own fallback outside its provider)', () => {
    expect(filesMatching(/(^|[^.\w$])alert\(\s*['`"]|window\.alert\(/)).toEqual(['hooks/useConfirm.tsx'])
  })
})

/** The provider's own lanes into notify(). A server record arrives marked `fromServer`, so the
 *  page's "own action" stamp never makes a background error the person's. */
const PROVIDER_LANES: Record<string, string> = {
  'cron:notification': 'a routine receipt (feed only)',
  'agent:error': 'the agent\'s credentials failed (sign-in); nothing else',
  'skill:notification': 'a new skill receipt (feed only)',
  'notification:new': 'every record the server wrote, marked fromServer',
}

describe('the provider\'s lanes into notify()', () => {
  const provider = FILES.find(f => f.rel === 'contexts/notifications/NotificationProvider.tsx')!.text
  // Each handler's text runs from its useEvent( to the next one.
  const lanes = provider.split("useEvent('").slice(1)
    .map(chunk => ({ name: chunk.slice(0, chunk.indexOf("'")), body: chunk }))
    .filter(l => /\bnotify\(\{/.test(l.body))

  it('lists every event that raises a notice', () => {
    expect(lanes.map(l => l.name).sort()).toEqual(Object.keys(PROVIDER_LANES).sort())
  })

  it('marks a server record as the server\'s, and gives the agent lane its reason', () => {
    expect(lanes.find(l => l.name === 'notification:new')!.body).toMatch(/fromServer: true/)
    expect(lanes.find(l => l.name === 'agent:error')!.body).toMatch(/needsYou: 'sign-in'/)
  })
})

/**
 * Every kind of notice and who it is for. A new kind fails here until it is listed: either it
 * is judged by its reason (Walnut Health's unless it names why it needs the person), or it is
 * the person's by nature (an ask, a letter, a receipt, the answer to their own action).
 */
const KIND_AUDIENCE: Record<string, 'by-reason' | 'person'> = {
  'operation-error': 'by-reason',
  host: 'by-reason',
  permission: 'person',
  cron: 'person',
  sort: 'person',
  'audio-error': 'person',
  skill: 'person',
  hook: 'person',
  letter: 'person',
  reminder: 'person',
  hint: 'person',
}

describe('every kind of notice goes through the one rule', () => {
  it('lists every kind (a new one is a decision, made here and in audience.ts)', () => {
    expect(Object.keys(TOAST_DURATION_MS).sort()).toEqual(Object.keys(KIND_AUDIENCE).sort())
  })

  it('a kind judged by its reason is Walnut Health\'s without one, the person\'s with one', () => {
    for (const [kind, how] of Object.entries(KIND_AUDIENCE)) {
      expect(audienceOf({ kind }), kind).toBe(how === 'by-reason' ? 'health' : 'user')
      if (how === 'by-reason') expect(audienceOf({ kind, needsYou: 'sign-in' }), kind).toBe('user')
    }
  })

  it('a host problem toasts only when the person must clear it or it answers their own Retry', () => {
    expect(SHOULD_TOAST({ kind: 'host', severity: 'error' })).toBe(false)
    expect(SHOULD_TOAST({ kind: 'host', severity: 'error', needsYou: 'sign-in' })).toBe(true)
    const none = new Set<string>()
    // 2026-11-17: a Mac on the host network that is off asked the person to run `walnut net status`.
    expect(hostProblemNeedsYou({ kind: 'daemon', hosts: ['other-mac'] }, none)).toBeUndefined()
    expect(hostProblemNeedsYou({ kind: 'unreachable', hosts: ['devbox'] }, none)).toBeUndefined()
    expect(hostProblemNeedsYou({ kind: 'cert_expired', hosts: ['devbox'] }, none)).toBe('sign-in')
    expect(hostProblemNeedsYou({ kind: 'claude_not_logged_in', hosts: ['devbox'] }, none)).toBe('sign-in')
    expect(hostProblemNeedsYou({ kind: 'unreachable', hosts: ['devbox'] }, new Set(['devbox']))).toBe('own-action')
  })

  it('every surface of a host problem reads the same rule (toast, bell, bell dot, Walnut Health)', () => {
    const readers = FILES.filter(({ text }) => /\bhostProblemNeedsYou\(/.test(text)).map(({ rel }) => rel).sort()
    expect(readers).toEqual([
      'components/common/HostProblemNotices.tsx',
      'components/common/NotificationProblems.tsx',
      'utils/host-attention.ts',
    ])
    const health = FILES.find(f => f.rel === 'components/settings/sections/HealthHostProblems.tsx')!.text
    expect(health).toMatch(/filter\(\(p\) => !p\.needsYou\)/)
    const panel = FILES.find(f => f.rel === 'components/common/NotificationPanel.tsx')!.text
    expect(panel).toMatch(/allProblemHosts\.filter\(p => p\.needsYou\)/)
  })
})

describe('notify() toasts an error only when it is the person\'s', () => {
  it('holds back an error that is Walnut Health\'s', () => {
    expect(SHOULD_TOAST({ kind: 'operation-error', severity: 'error' })).toBe(false)
    expect(SHOULD_TOAST({ kind: 'operation-error', severity: 'error', needsYou: 'made-up' })).toBe(false)
  })

  it('toasts one that needs the person, and still only at error severity', () => {
    expect(SHOULD_TOAST({ kind: 'operation-error', severity: 'error', needsYou: 'sign-in' })).toBe(true)
    expect(SHOULD_TOAST({ kind: 'operation-error', severity: 'error', needsYou: 'own-action' })).toBe(true)
    expect(SHOULD_TOAST({ kind: 'operation-error', severity: 'warning', needsYou: 'own-action' })).toBe(false)
  })

  it('stamps the page\'s own error as the person\'s action, so the rule lets it through', () => {
    const provider = FILES.find(f => f.rel === 'contexts/notifications/NotificationProvider.tsx')!.text
    expect(provider).toMatch(/needsYou: raw\.needsYou \?\? 'own-action'/)
  })
})

describe('Walnut Health groups its errors for whoever investigates', () => {
  const at = Date.UTC(2026, 10, 17, 1, 0, 0)
  const err = (over: Partial<Notification>): Notification => ({
    id: over.dedupKey ?? 'x', kind: 'operation-error', severity: 'error', title: 't', timestamp: at,
    persistent: true, dedupKey: 'x', ...over,
  })

  it('one group per category, still-happening first, with counts and first and last seen', () => {
    const groups = groupHealthErrors([
      err({ dedupKey: 'a', category: 'Sessions', title: 'A session hit an error', occurrences: 3, lastTimestamp: at + 60_000 }),
      err({ dedupKey: 'b', category: 'Sessions', title: 'Delivery failed', count: 2, timestamp: at - 3_600_000, resolved: 'recovered' }),
      err({ dedupKey: 'c', category: 'Data & Sync', title: 'Data Backup Failing', timestamp: at - 7_200_000, resolved: 'recovered' }),
      err({ dedupKey: 'p', kind: 'permission', title: 'not an error' }),
    ])
    expect(groups.map(g => g.category)).toEqual(['Sessions', 'Data & Sync'])
    const sessions = groups[0]!
    expect(sessions.open).toBe(1)
    expect(sessions.times).toBe(5)
    expect(sessions.firstSeen).toBe(at - 3_600_000)
    expect(sessions.lastSeen).toBe(at + 60_000)
    expect(sessions.rows.map(r => [r.dedupKey, r.state, r.times])).toEqual([['a', 'open', 3], ['b', 'recovered', 2]])
  })

  it('keeps the raw line behind Details, never as the sentence', () => {
    const [g] = groupHealthErrors([err({ dedupKey: 'r', body: '[web] {"reqId":"1","stack":"Error at x"}' })])
    expect(g!.rows[0]!.body).toBe('')
    expect(g!.rows[0]!.detail).toContain('reqId')
  })
})
