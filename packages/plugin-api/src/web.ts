export type * from './shared.js'

import type { ComponentType } from 'react'
import type { Disposable, PluginLogger, TaskPhase, TaskPriority } from './shared.js'
import type { EventApi, OpsService, PluginFetchInit, PluginFetchResponse } from './server.js'

export type PluginComponent<Props = Record<string, never>> = ComponentType<Props>

export interface NavContribution {
  id: string
  label: string
  icon?: PluginComponent<{ size?: number }>
  path: string
  order?: number
}

export interface PageContribution {
  id: string
  path: string
  component: PluginComponent
  title?: string
}

export interface PanelProps {
  panelKey: string
}

export interface PanelContribution {
  id: string
  title: string
  component: PluginComponent<PanelProps>
  defaultSpan?: 1 | 2 | 3
  order?: number
}

export interface SettingsContribution {
  id: string
  label: string
  component: PluginComponent
}

export interface FileViewProps {
  cwd?: string
  host?: string
  sessionId?: string
  initialLine?: number
  initialTerm?: string
  memoryScope?: string
}

export interface TerminalViewProps {
  sessionId: string
  label?: string
  host?: string
}

export interface SessionViewProps {
  sessionId: string
  onClose(): void
  locked?: boolean
  onToggleLock?(): void
}

export type TaskViewCompletion = 'todo' | 'in_progress' | 'complete'
export type TaskViewTimeBasis = 'created' | 'updated' | 'created_or_updated'

export interface TaskViewQuery {
  completion?: TaskViewCompletion[]
  phases?: TaskPhase[]
  projects?: string[]
  priorities?: TaskPriority[]
  sources?: string[]
  sprints?: string[]
  tagsAny?: string[]
  tagsAll?: string[]
  pinned?: boolean
  unread?: boolean
  blocked?: boolean
  parentTaskId?: string
  groupId?: string
  time?: {
    basis: TaskViewTimeBasis
    last?: { value: number; unit: 'hours' | 'days' }
    from?: string
    until?: string
  }
}

export type TaskViewSortKey = 'title' | 'priority' | 'due' | 'session' | 'project'
export interface TaskViewSort { key: TaskViewSortKey; dir: 'asc' | 'desc' }

export interface TaskViewProps {
  project?: string | null
  query?: TaskViewQuery
  search?: string
  sort?: TaskViewSort | null
  grouped?: boolean
  toolbar?: boolean
  storageKey?: string
  onOpenTask?(taskId: string): void
}

export interface ChatViewProps {
  agentId: string
  conversationId: string | null
  draftKey: string
  title?: string
  placeholder?: string
  emptyText?: string
  transformMessage?(text: string): string
}

export interface WebUiService {
  nav(contribution: NavContribution): Disposable
  page(contribution: PageContribution): Disposable
  panel(contribution: PanelContribution): Disposable
  settings(contribution: SettingsContribution): Disposable
  injectCss(css: string): Disposable
  readonly views: {
    CalendarView: PluginComponent
    FileView: PluginComponent<FileViewProps>
    NoteView: PluginComponent
    TerminalView: PluginComponent<TerminalViewProps>
    SessionView: PluginComponent<SessionViewProps>
    TaskView: PluginComponent<TaskViewProps>
    ChatView: PluginComponent<ChatViewProps>
  }
}

export interface WalnutWebApi {
  readonly pluginId: string
  readonly pluginName: string
  readonly walnutVersion: string
  readonly signal: AbortSignal
  readonly log: PluginLogger
  readonly events: EventApi
  readonly ops: OpsService
  readonly ws: {
    call<T = unknown>(id: string, payload?: unknown): Promise<T>
  }
  readonly http: {
    fetch(url: string, init?: PluginFetchInit): Promise<PluginFetchResponse>
  }
  readonly ui: WebUiService
  readonly unsafe: {
    readonly react: unknown
    readonly host: unknown
    readonly dom: unknown
  }
}

export interface WalnutWebPlugin {
  activate(walnut: WalnutWebApi): void | Disposable | Promise<void | Disposable>
  deactivate?(): void | Promise<void>
}

export function defineWebPlugin<T extends WalnutWebPlugin>(plugin: T): T {
  return plugin
}
