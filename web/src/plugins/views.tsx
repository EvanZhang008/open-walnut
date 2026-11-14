import { CalendarPage } from '@/pages/CalendarPage'
import { NotesPage } from '@/pages/NotesPage'
import { SessionFileExplorer } from '@/components/sessions/SessionFileExplorer'
import { SessionPanel } from '@/components/sessions/SessionPanel'
import { SessionTerminal } from '@/components/sessions/SessionTerminal'
import { TaskViewSurface } from '@/components/tasks/TaskViewSurface'
import { PluginChatView } from '@/components/chat/PluginChatView'
import { AskObjectDrawer } from '@/components/chat/AskObjectDrawer'
import { PluginSettingsForm } from '@/components/settings/PluginSettingsForm'
import { BoxMic, type BoxMicHandle } from '@/components/common/BoxMic'
import { ContentActionButtons } from '@/components/content/ContentActionButtons'
import type { ContentItem } from '@/utils/content-actions'
import { useCallback, useRef, type RefObject } from 'react'
import type {
  AskObjectViewProps,
  ChatViewProps,
  FileViewProps,
  MicButtonProps,
  PluginViews,
  SessionViewProps,
  TaskViewProps,
  TerminalViewProps,
} from './types'

function CalendarView() {
  return <CalendarPage />
}

function FileView(props: FileViewProps) {
  return (
    <div className="plugin-file-view">
      <SessionFileExplorer {...props} />
    </div>
  )
}

function NoteView() {
  return <NotesPage />
}

/** One function for every render: the terminal's close callback stays the same object across a plugin page's re-renders. */
const noop = () => undefined

function TerminalView({ sessionId, label, host }: TerminalViewProps) {
  return (
    <div className="plugin-terminal-view">
      <SessionTerminal
        sessionId={sessionId}
        label={label}
        host={host}
        embedded
        onClose={noop}
      />
    </div>
  )
}

function scopedStorageKey(pluginId: string, kind: 'task-view' | 'chat', localKey: string): string {
  const trimmed = localKey.trim()
  if (!trimmed || trimmed.length > 128) throw new Error(`Plugin ${kind} key must be 1-128 characters`)
  return `open-walnut-plugin:${encodeURIComponent(pluginId)}:${kind}:${encodeURIComponent(trimmed)}`
}

/**
 * The composer's mic for a box the plugin draws: BoxMic as it is, so the user's Voice settings and
 * engine, the live drafts, the retry menu and the Voice panel's Insert all come with it.
 */
function MicButton({ boxRef, value, onChange, disabled, size, handleRef }: MicButtonProps) {
  return <BoxMic boxRef={boxRef} text={value} setText={onChange} disabled={disabled} size={size} handleRef={handleRef as RefObject<BoxMicHandle | null> | undefined} className="plugin-mic-button" />
}

export function createPluginViews(pluginId: string): PluginViews {
  // Walnut keeps the panel's view and full screen for the plugin's page, by itself: the
  // plugin passes nothing for it (panel-view.ts).
  function SessionView({ sessionId, onClose, locked, onToggleLock }: SessionViewProps) {
    // The panel is memo'd and a plugin re-renders its page often (an editor on every keystroke, a
    // clock every second), passing fresh callbacks each time. Hand the panel callbacks that never
    // change and call the plugin's latest ones, so those renders stop at the panel: a new closure
    // per render re-rendered the whole session panel, about 0.3 MB of garbage a keystroke
    // (2026-11-08, the Interview Practice page's memory growth).
    const latest = useRef({ onClose, onToggleLock })
    latest.current = { onClose, onToggleLock }
    const close = useCallback(() => latest.current.onClose(), [])
    const toggleLock = useCallback(() => latest.current.onToggleLock?.(), [])
    return (
      <div className="plugin-session-view">
        {/* A plugin App hosts this panel inside its own screen, never as a home column. Without
            `embedded`, the crash fallback's Close also wiped the user's saved column layout. */}
        <SessionPanel
          sessionId={sessionId}
          viewPlace={`plugin:${pluginId}`}
          embedded
          onClose={close}
          locked={locked}
          onToggleLock={onToggleLock ? toggleLock : undefined}
        />
      </div>
    )
  }

  // A plugin's own onOpenTask is no longer called (TaskViewProps): its task clicks open on Home.
  function TaskView({ storageKey, onOpenTask: _notCalled, ...props }: TaskViewProps) {
    return (
      <TaskViewSurface
        {...props}
        persistenceKey={storageKey ? scopedStorageKey(pluginId, 'task-view', storageKey) : undefined}
      />
    )
  }

  function ChatView({ draftKey, ...props }: ChatViewProps) {
    return (
      <PluginChatView
        {...props}
        draftStorageKey={scopedStorageKey(pluginId, 'chat', draftKey)}
      />
    )
  }

  function AskObjectView({ objectKey, agentId, ...props }: AskObjectViewProps) {
    // Scoped to the plugin, so two plugins naming their objects alike never share a session.
    const key = `plugin:${pluginId}:${objectKey}`
    const agent = agentId || 'general'
    return (
      <div className="plugin-ask-object-view">
        <AskObjectDrawer
          {...props}
          // A new object is a new drawer: nothing of the previous object's view survives the switch.
          key={`${agent}\u0000${key}`}
          objectKey={key}
          agentId={agent}
        />
      </div>
    )
  }

  /** Only ever this plugin's form: the id is bound here, not taken from the caller. */
  function PluginSettingsView() {
    return <PluginSettingsForm pluginId={pluginId} />
  }

  function ContentActions({ item, size }: { item: ContentItem; size?: 'buttons' | 'compact' }) {
    return <ContentActionButtons item={item} size={size} />
  }

  return {
    CalendarView,
    FileView,
    NoteView,
    TerminalView,
    SessionView,
    TaskView,
    ChatView,
    AskObjectView,
    MicButton,
    PluginSettingsView,
    ContentActions,
  }
}

export const pluginViews = createPluginViews('plugin')
