import type { ComponentType } from 'react'

export interface Disposable {
  dispose(): void | Promise<void>
}

export interface PluginWebModuleDescriptor {
  id: string
  name: string
  version?: string
  hash: string
  size: number
  url: string
}

export interface PluginRuntimeResponse {
  plugins: Array<{ id: string; state: string }>
  tombstones: Array<{ id: string; reason: string }>
  modules: PluginWebModuleDescriptor[]
  moduleErrors: Array<{ id: string; error: string }>
}

export interface PluginEvent<T = unknown> {
  name: string
  data: T
  timestamp: number
  traceId?: string
  source?: string
}

export interface PluginLogger {
  trace(message: string, data?: Record<string, unknown>): void
  debug(message: string, data?: Record<string, unknown>): void
  info(message: string, data?: Record<string, unknown>): void
  warn(message: string, data?: Record<string, unknown>): void
  error(message: string, data?: Record<string, unknown>): void
  fatal(message: string, data?: Record<string, unknown>): void
  child(name: string): PluginLogger
}

export interface PluginFetchInit {
  method?: string
  headers?: Record<string, string>
  body?: string | Uint8Array
  timeoutMs?: number
}

export interface PluginFetchResponse {
  ok: boolean
  status: number
  headers: Record<string, string>
  text(): Promise<string>
  json<T = unknown>(): Promise<T>
}

export type PluginOpResult<T = unknown> =
  | { ok: true; result: T }
  | { ok: false; message: string }

export interface PluginNavContribution {
  id: string
  label: string
  icon?: ComponentType<{ size?: number }>
  path: string
  order?: number
}

export interface PluginPageContribution {
  id: string
  path: string
  component: ComponentType<Record<string, never>>
  title?: string
}

export interface PluginPanelProps {
  panelKey: string
}

export interface PluginPanelContribution {
  id: string
  title: string
  component: ComponentType<PluginPanelProps>
  defaultSpan?: 1 | 2 | 3
  order?: number
}

export interface PluginSettingsContribution {
  id: string
  label: string
  component: ComponentType<Record<string, never>>
}

export interface RegisteredUiContribution<T> {
  key: string
  pluginId: string
  pluginName: string
  generation: number
  value: T
}

export interface PluginUiSnapshot {
  version: number
  nav: Array<RegisteredUiContribution<PluginNavContribution>>
  pages: Array<RegisteredUiContribution<PluginPageContribution>>
  panels: Array<RegisteredUiContribution<PluginPanelContribution>>
  settings: Array<RegisteredUiContribution<PluginSettingsContribution>>
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
export type TaskViewPhase = 'TODO' | 'IN_PROGRESS' | 'AGENT_COMPLETE' | 'COMPLETE'
export type TaskViewPriority = 'immediate' | 'important' | 'backlog' | 'none'
export type TaskViewTimeBasis = 'created' | 'updated' | 'created_or_updated'

export interface TaskViewQuery {
  completion?: TaskViewCompletion[]
  phases?: TaskViewPhase[]
  projects?: string[]
  priorities?: TaskViewPriority[]
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

export interface PluginViews {
  CalendarView: ComponentType<Record<string, never>>
  FileView: ComponentType<FileViewProps>
  NoteView: ComponentType<Record<string, never>>
  TerminalView: ComponentType<TerminalViewProps>
  SessionView: ComponentType<SessionViewProps>
  TaskView: ComponentType<TaskViewProps>
  ChatView: ComponentType<ChatViewProps>
}

export interface WalnutWebApiHost {
  readonly pluginId: string
  readonly pluginName: string
  readonly walnutVersion: string
  readonly signal: AbortSignal
  readonly log: PluginLogger
  readonly events: {
    on(prefixes: string | string[], handler: (event: PluginEvent) => void | Promise<void>): Disposable
    emit(name: string, data: unknown): void
  }
  readonly ops: {
    call<T = unknown>(name: string, args?: Record<string, unknown>): Promise<PluginOpResult<T>>
    unwrap<T>(result: PluginOpResult<T>): T
    list(): Promise<Array<{ name: string; title: string; readonly: boolean }>>
  }
  readonly ws: {
    call<T = unknown>(id: string, payload?: unknown): Promise<T>
  }
  readonly http: {
    fetch(url: string, init?: PluginFetchInit): Promise<PluginFetchResponse>
  }
  readonly ui: {
    nav(contribution: PluginNavContribution): Disposable
    page(contribution: PluginPageContribution): Disposable
    panel(contribution: PluginPanelContribution): Disposable
    settings(contribution: PluginSettingsContribution): Disposable
    injectCss(css: string): Disposable
    readonly views: PluginViews
  }
  readonly unsafe: {
    readonly react: unknown
    readonly host: unknown
    readonly dom: Document
  }
}
