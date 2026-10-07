export type * from './shared.js'

import type { ComponentType } from 'react'
import type { Disposable, PluginLogger, TaskPhase, TaskPriority } from './shared.js'
import type { EventApi, OpsService, PluginFetchInit, PluginFetchResponse } from './server.js'

export type PluginComponent<Props = Record<string, never>> = ComponentType<Props>
/**
 * What the App's row shows beside its title. A number is a COUNT and draws red, like
 * unread mail. `{ text }` is a short status that is not a count (a countdown, a mode)
 * and draws muted, so a "25" for minutes left never reads as 25 things to deal with.
 * Text is 1 to 6 characters.
 */
export type AppBadge = number | 'dot' | null | { text: string }

export interface AppProps {
  basePath: string
  subpath: string
  search: string
  navigate(path: string, options?: { replace?: boolean }): void
}

/**
 * Where the App's entry point lives. The route, the deep links and the Command
 * Palette entry are identical either way; only the row a human clicks moves.
 *
 * `'settings'` is for an App that is a place you visit occasionally rather than a
 * daily surface: it gets a row in the Settings Plugins group, beside the Plugins
 * section itself, and no Sidebar entry at all. The Sidebar is a small, expensive space, and an App
 * that does not need to be one click away should not spend it.
 */
export type AppPlacement = 'sidebar' | 'settings'

export interface AppContribution {
  id: string
  title: string
  icon?: PluginComponent<{ size?: number }>
  component: PluginComponent<AppProps>
  badge?: AppBadge
  order?: number
  fullBleed?: boolean
  /** Default `'settings'`. Ask for `'sidebar'` only for a surface someone lives in all day. */
  placement?: AppPlacement
}

export interface AppHandle extends Disposable {
  readonly path: string
  setBadge(value: AppBadge): void
}

export interface PageContribution {
  id: string
  path: string
  component: PluginComponent
  title?: string
}

export interface SettingsContribution {
  id: string
  label: string
  component: PluginComponent
}

/**
 * Where a slot renders. A slot is ONE labelled fact the host prints with its own facts
 * about an object (a task, a session): the host writes the slot's `title` as the label
 * and your component renders the value, short enough for one line ("2h 10m", a link).
 *
 * - `'task.meta'`: with a task's id, created and updated time, in the task details popup
 *   and on the `/tasks/:id` page.
 * - `'session.meta'`: at the top of a session's ⋮ menu, under the Panels row. The
 *   menu closes when your value navigates.
 *
 * There is deliberately no slot on a session's header row: its width belongs to the
 * host's own tools.
 */
export type SlotTarget = 'task.meta' | 'session.meta'

export interface TaskMetaSlotProps {
  taskId: string
  /** Navigate within the console (an App path, `/tasks/<id>`, ...). */
  navigate(path: string): void
}

export interface SessionMetaSlotProps {
  sessionId: string
  /** The session's task, when it has one. */
  taskId?: string
  navigate(path: string): void
}

export interface SlotPropsByTarget {
  'task.meta': TaskMetaSlotProps
  'session.meta': SessionMetaSlotProps
}

export interface SlotContribution<T extends SlotTarget = SlotTarget> {
  /** Local id, unique within the plugin. */
  id: string
  target: T
  /** The fact's label, a word or two ("Time"). */
  title: string
  /**
   * The value, rendered once per object inside its own error boundary. Render nothing
   * (`null`) when there is nothing worth showing: the host then drops the label too.
   */
  component: PluginComponent<SlotPropsByTarget[T]>
  /** Sort weight among the plugins in the same slot. Default 500. */
  order?: number
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
  /** Sent once as the first user turn when the conversation is ready (through transformMessage). */
  autoSend?: string
  /** Called with the text after autoSend went out, so the opener can latch it and never re-send. */
  onAutoSent?(text: string): void
}

/**
 * Ask Walnut about one object the plugin shows (a message, a record), as an ordinary Ask Walnut session.
 *
 * The host draws its own draft panel (with `quote` above the composer) until the first question, then
 * the regular session panel. `contextBlock` rides the first question only, folded in the session under
 * a row named `contextName`. `objectKey` is scoped to the plugin by the host; reopening the same key
 * lands in the same session, and a `preset` with `autoSend` is sent once per session. Optional on the
 * views object: a host older than this view does not have it, so feature-detect and fall back.
 */
export interface AskObjectViewProps {
  objectKey: string
  title: string
  quote: { who: string; when: string; where: string; preview: string }
  contextBlock: string
  contextName: string
  /** Console agent that answers. Defaults to Walnut (`general`). */
  agentId?: string
  preset?: string
  autoSend?: boolean
  onClose(): void
  onBack?(): void
  /** CSS selector of what the keyboard returns to on close. */
  restoreFocusTo?: string
}

export interface WebUiService {
  app(contribution: AppContribution): AppHandle
  page(contribution: PageContribution): Disposable
  settings(contribution: SettingsContribution): Disposable
  /**
   * Draw a small piece of UI inside a host surface (see SlotTarget). Optional: a host
   * older than slots does not have it, so call it as `walnut.ui.slot?.(...)`.
   */
  slot?<T extends SlotTarget>(contribution: SlotContribution<T>): Disposable
  injectCss(css: string): Disposable
  readonly views: {
    CalendarView: PluginComponent
    FileView: PluginComponent<FileViewProps>
    NoteView: PluginComponent
    TerminalView: PluginComponent<TerminalViewProps>
    SessionView: PluginComponent<SessionViewProps>
    TaskView: PluginComponent<TaskViewProps>
    ChatView: PluginComponent<ChatViewProps>
    AskObjectView?: PluginComponent<AskObjectViewProps>
    /**
     * Your plugin's generated Settings form (manifest `configSchema` + `uiHints`), the same rows
     * the Configure card in Settings → Plugins draws, with their Save. Render it inside your own
     * App when the page IS the settings, and declare `settingsIn: 'app'` in the manifest so the
     * Plugins row's Configure goes to your App instead of a second copy. Optional on the views
     * object: feature-detect.
     */
    PluginSettingsView?: PluginComponent<Record<string, never>>
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
