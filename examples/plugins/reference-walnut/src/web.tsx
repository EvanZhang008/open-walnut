import { useEffect, useState } from 'react'
import type { WalnutWebApi } from '@open-walnut/plugin-api/web'

export async function activate(walnut: WalnutWebApi) {
  const CalendarView = walnut.ui.views.CalendarView
  const SessionView = walnut.ui.views.SessionView
  const TaskView = walnut.ui.views.TaskView
  const ChatView = walnut.ui.views.ChatView

  function ReferenceIcon({ size = 18 }: { size?: number }) {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
        <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeWidth="2" />
        <path d="M8 12h8M12 8v8" stroke="currentColor" strokeWidth="2" />
      </svg>
    )
  }

  function ReferencePage() {
    const [count, setCount] = useState(0)
    const [calendarVisible, setCalendarVisible] = useState(false)
    return (
      <main className="reference-plugin-page" data-testid="reference-plugin-page">
        <header>
          <div>
            <span className="reference-plugin-kicker">Native Web Plugin</span>
            <h1>Reference Plugin</h1>
            <p>This page runs in Walnut's React tree with owner-scoped cleanup.</p>
          </div>
          <ReferenceIcon size={42} />
        </header>
        <div className="reference-plugin-actions">
          <button type="button" onClick={() => setCount((value) => value + 1)}>
            Shared React count: {count}
          </button>
          <button type="button" onClick={() => setCalendarVisible((value) => !value)}>
            {calendarVisible ? 'Hide' : 'Show'} CalendarView
          </button>
        </div>
        {calendarVisible && (
          <section className="reference-plugin-calendar" data-testid="reference-plugin-calendar">
            <CalendarView />
          </section>
        )}
      </main>
    )
  }

  function ReferencePanel({ panelKey }: { panelKey: string }) {
    const [activations, setActivations] = useState<number | null>(null)
    const [sessionDraft, setSessionDraft] = useState('')
    const [sessionId, setSessionId] = useState<string | null>(null)
    const [tasksVisible, setTasksVisible] = useState(false)
    const [chatDraftA, setChatDraftA] = useState('')
    const [chatDraftB, setChatDraftB] = useState('')
    const [chatIds, setChatIds] = useState<[string, string] | null>(null)

    const refresh = async () => {
      const status = await walnut.ws.call<{
        counters: { activations: number }
      }>('status')
      setActivations(status.counters.activations)
    }

    useEffect(() => {
      void refresh()
    }, [])

    return (
      <section className="reference-plugin-panel" data-testid="reference-plugin-panel" data-panel-key={panelKey}>
        <p data-testid="reference-plugin-server-status">
          Server activations: {activations ?? 'loading'}
        </p>
        <button type="button" onClick={() => { void refresh() }}>Refresh server status</button>
        <div className="reference-plugin-session-picker">
          <input
            aria-label="Session ID"
            placeholder="Session ID"
            value={sessionDraft}
            onChange={(event) => setSessionDraft(event.target.value)}
          />
          <button
            type="button"
            disabled={!sessionDraft.trim()}
            onClick={() => setSessionId(sessionDraft.trim())}
          >
            Open SessionView
          </button>
        </div>
        {sessionId && (
          <div className="reference-plugin-session" data-testid="reference-plugin-session-view">
            <SessionView sessionId={sessionId} onClose={() => setSessionId(null)} />
          </div>
        )}
        <button type="button" onClick={() => setTasksVisible((visible) => !visible)}>
          {tasksVisible ? 'Hide' : 'Show'} TaskView
        </button>
        {tasksVisible && (
          <div className="reference-plugin-tasks" data-testid="reference-plugin-task-view">
            <TaskView
              query={{ completion: ['todo', 'in_progress'] }}
              toolbar
              storageKey="overview-tasks"
            />
          </div>
        )}
        <div className="reference-plugin-chat-picker">
          <input
            aria-label="Conversation ID A"
            placeholder="Conversation ID A"
            value={chatDraftA}
            onChange={(event) => setChatDraftA(event.target.value)}
          />
          <input
            aria-label="Conversation ID B"
            placeholder="Conversation ID B"
            value={chatDraftB}
            onChange={(event) => setChatDraftB(event.target.value)}
          />
          <button
            type="button"
            disabled={!chatDraftA.trim() || !chatDraftB.trim()}
            onClick={() => setChatIds([chatDraftA.trim(), chatDraftB.trim()])}
          >
            Open ChatViews
          </button>
        </div>
        {chatIds && (
          <div className="reference-plugin-chats" data-testid="reference-plugin-chat-views">
            <div data-testid="reference-plugin-chat-a">
              <ChatView
                agentId="reference-walnut:observer"
                conversationId={chatIds[0]}
                draftKey="overview-chat-a"
                title="Reference Chat A"
              />
            </div>
            <div data-testid="reference-plugin-chat-b">
              <ChatView
                agentId="reference-walnut:observer"
                conversationId={chatIds[1]}
                draftKey="overview-chat-b"
                title="Reference Chat B"
              />
            </div>
          </div>
        )}
      </section>
    )
  }

  function ReferenceActivityPanel({ panelKey }: { panelKey: string }) {
    return (
      <section className="reference-plugin-activity" data-testid="reference-plugin-activity" data-panel-key={panelKey}>
        <strong>Plugin composition is active</strong>
        <span>Move and resize this panel without losing its saved place.</span>
      </section>
    )
  }

  function ReferenceSettings() {
    const [enabled, setEnabled] = useState(true)
    return (
      <label className="reference-plugin-setting">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(event) => setEnabled(event.target.checked)}
        />
        Native Plugin setting ({enabled ? 'on' : 'off'})
      </label>
    )
  }

  walnut.ui.nav({
    id: 'reference',
    label: 'Reference',
    path: '/plugins/reference-walnut',
    icon: ReferenceIcon,
  })
  walnut.ui.page({
    id: 'reference',
    path: '/plugins/reference-walnut',
    title: 'Reference Plugin',
    component: ReferencePage,
  })
  walnut.ui.panel({
    id: 'overview',
    title: 'Reference Overview',
    component: ReferencePanel,
    defaultSpan: 2,
    order: 10,
  })
  walnut.ui.panel({
    id: 'activity',
    title: 'Reference Activity',
    component: ReferenceActivityPanel,
    defaultSpan: 1,
    order: 20,
  })
  walnut.ui.settings({
    id: 'reference',
    label: 'Reference Plugin',
    component: ReferenceSettings,
  })
  walnut.ui.injectCss(`
    .reference-plugin-page { display: grid; gap: 18px; padding: 24px; }
    .reference-plugin-page header { display: flex; align-items: center; justify-content: space-between; }
    .reference-plugin-page h1 { margin: 4px 0; }
    .reference-plugin-page p { margin: 0; color: var(--fg-muted); }
    .reference-plugin-kicker { color: var(--accent); font-size: 12px; font-weight: 700; text-transform: uppercase; }
    .reference-plugin-actions { display: flex; gap: 10px; }
    .reference-plugin-actions button { padding: 8px 12px; border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--card-bg); color: var(--fg); }
    .reference-plugin-calendar { min-height: 600px; border: 1px solid var(--border); border-radius: var(--radius-md); overflow: hidden; }
    .reference-plugin-setting { display: flex; align-items: center; gap: 8px; }
    .reference-plugin-panel { display: grid; gap: 12px; }
    .reference-plugin-panel p { margin: 0; }
    .reference-plugin-panel button, .reference-plugin-panel input { padding: 7px 10px; border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--card-bg); color: var(--fg); }
    .reference-plugin-session-picker { display: flex; gap: 8px; }
    .reference-plugin-session-picker input { flex: 1; min-width: 0; }
    .reference-plugin-session { min-height: 420px; overflow: hidden; border: 1px solid var(--border); border-radius: var(--radius-md); }
    .reference-plugin-tasks { height: 520px; overflow: hidden; border: 1px solid var(--border); border-radius: var(--radius-md); }
    .reference-plugin-chat-picker { display: grid; grid-template-columns: 1fr 1fr auto; gap: 8px; }
    .reference-plugin-chats { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
    .reference-plugin-chats > div { height: 460px; min-width: 0; overflow: hidden; border: 1px solid var(--border); border-radius: var(--radius-md); }
    .reference-plugin-activity { display: grid; gap: 8px; }
    .reference-plugin-activity span { color: var(--fg-muted); }
  `)
}
