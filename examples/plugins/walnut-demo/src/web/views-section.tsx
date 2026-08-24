import { useState } from 'react'
import { Card, Chip } from './ui-kit'
import type { DemoContext } from './types'

const VIEW_TABS = [
  { id: 'task', label: 'Task', needsSession: false },
  { id: 'calendar', label: 'Calendar', needsSession: false },
  { id: 'note', label: 'Note', needsSession: false },
  { id: 'file', label: 'File', needsSession: false },
  { id: 'chat', label: 'Chat', needsSession: false },
  { id: 'session', label: 'Session', needsSession: true },
  { id: 'terminal', label: 'Terminal', needsSession: true },
] as const

type ViewId = typeof VIEW_TABS[number]['id']

const VIEW_NOTES: Record<ViewId, string> = {
  task: 'TaskView with a query, the toolbar on, and a namespaced storage key for its saved state.',
  calendar: 'CalendarView takes no props: the whole console calendar, inside a plugin app.',
  note: 'NoteView is the notes surface, mounted read-write exactly as the host renders it.',
  file: 'FileView with no props browses the default tree. Pass cwd, host or sessionId to scope it.',
  chat: 'ChatView bound to this plugin\'s own agent. conversationId is null, so the host shows its waiting state until a conversation is bound.',
  session: 'SessionView is a live session panel. It needs a session id, and closing it unmounts the view.',
  terminal: 'TerminalView attaches to a session\'s terminal. It needs the same session id.',
}

// Only the selected view is mounted: these are the console's real surfaces, so mounting all of them would open every subscription at once.
export function ViewsSection(props: { demo: DemoContext }) {
  const { views } = props.demo
  const [active, setActive] = useState<ViewId>('task')
  const [sessionDraft, setSessionDraft] = useState('')
  const [sessionId, setSessionId] = useState<string | null>(null)

  const tab = VIEW_TABS.find((entry) => entry.id === active) ?? VIEW_TABS[0]
  const needsSession = tab.needsSession && !sessionId

  return (
    <div className="wd-stack">
      <Card
        title="Host views"
        hint="Only the selected view is mounted. Switching tabs unmounts the previous one."
      >
        <div className="wd-tabs wd-tabs-inner" role="tablist">
          {VIEW_TABS.map((entry) => (
            <button
              key={entry.id}
              type="button"
              role="tab"
              aria-selected={entry.id === active}
              className={`wd-tab ${entry.id === active ? 'wd-tab-active' : ''}`}
              data-testid={`plugin-demo-view-${entry.id}`}
              onClick={() => setActive(entry.id)}
            >
              {entry.label}
            </button>
          ))}
        </div>
        <p className="wd-muted">{VIEW_NOTES[active]}</p>
        <div className="wd-row">
          <input
            className="wd-input"
            aria-label="Session id"
            placeholder="Session id for Session and Terminal"
            data-testid="plugin-demo-session-id"
            value={sessionDraft}
            onChange={(event) => setSessionDraft(event.target.value)}
          />
          <button
            type="button"
            className="wd-button wd-button-primary"
            data-testid="plugin-demo-action-mount-session"
            disabled={!sessionDraft.trim()}
            onClick={() => setSessionId(sessionDraft.trim())}
          >
            Mount session id
          </button>
          {sessionId && (
            <button
              type="button"
              className="wd-button"
              data-testid="plugin-demo-action-unmount-session"
              onClick={() => setSessionId(null)}
            >
              Unmount
            </button>
          )}
          {sessionId ? <Chip tone="ok">bound</Chip> : <Chip tone="warn">no session id</Chip>}
        </div>
      </Card>

      <div className="wd-view-host" data-testid="plugin-demo-active-view" data-view={active}>
        {needsSession ? (
          <p className="wd-empty">
            {tab.label}View needs a session id. Paste one above and press Mount session id.
          </p>
        ) : (
          <MountedView views={views} active={active} sessionId={sessionId} onClose={() => setSessionId(null)} />
        )}
      </div>
    </div>
  )
}

function MountedView(props: {
  views: DemoContext['views']
  active: ViewId
  sessionId: string | null
  onClose(): void
}) {
  const { views, active, sessionId } = props
  switch (active) {
    case 'task':
      return (
        <views.TaskView
          query={{ projects: ['Plugin Demo'], completion: ['todo', 'in_progress'] }}
          toolbar
          storageKey="walnut-demo-task-view"
        />
      )
    case 'calendar':
      return <views.CalendarView />
    case 'note':
      return <views.NoteView />
    case 'file':
      return <views.FileView />
    case 'chat':
      return (
        <views.ChatView
          agentId="walnut-demo:observer"
          conversationId={null}
          draftKey="demo-observer-draft"
          title="Plugin Demo Observer"
          placeholder="Ask the demo's own agent…"
          emptyText="This chat is bound to the plugin's own agent."
        />
      )
    case 'session':
      return sessionId ? <views.SessionView sessionId={sessionId} onClose={props.onClose} /> : null
    case 'terminal':
      return sessionId ? <views.TerminalView sessionId={sessionId} label="Plugin Demo" /> : null
    default:
      return null
  }
}
