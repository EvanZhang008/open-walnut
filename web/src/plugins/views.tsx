import { CalendarPage } from '@/pages/CalendarPage'
import { NotesPage } from '@/pages/NotesPage'
import { SessionFileExplorer } from '@/components/sessions/SessionFileExplorer'
import { SessionPanel } from '@/components/sessions/SessionPanel'
import { SessionTerminal } from '@/components/sessions/SessionTerminal'
import { TaskViewSurface } from '@/components/tasks/TaskViewSurface'
import { PluginChatView } from '@/components/chat/PluginChatView'
import type {
  ChatViewProps,
  FileViewProps,
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

function TerminalView({ sessionId, label, host }: TerminalViewProps) {
  return (
    <div className="plugin-terminal-view">
      <SessionTerminal
        sessionId={sessionId}
        label={label}
        host={host}
        embedded
        onClose={() => undefined}
      />
    </div>
  )
}

function SessionView({ sessionId, onClose, locked, onToggleLock }: SessionViewProps) {
  return (
    <div className="plugin-session-view">
      <SessionPanel
        sessionId={sessionId}
        onClose={() => onClose()}
        locked={locked}
        onToggleLock={onToggleLock ? () => onToggleLock() : undefined}
      />
    </div>
  )
}

function scopedStorageKey(pluginId: string, kind: 'task-view' | 'chat', localKey: string): string {
  const trimmed = localKey.trim()
  if (!trimmed || trimmed.length > 128) throw new Error(`Plugin ${kind} key must be 1-128 characters`)
  return `open-walnut-plugin:${encodeURIComponent(pluginId)}:${kind}:${encodeURIComponent(trimmed)}`
}

export function createPluginViews(pluginId: string): PluginViews {
  function TaskView({ storageKey, ...props }: TaskViewProps) {
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

  return {
    CalendarView,
    FileView,
    NoteView,
    TerminalView,
    SessionView,
    TaskView,
    ChatView,
  }
}

export const pluginViews = createPluginViews('plugin')
