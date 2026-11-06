import type { ContentAction, ContentItem } from '../../../packages/plugin-api/src/content-actions'
import type { ComponentType, RefObject } from 'react'

export interface Disposable {
  dispose(): void | Promise<void>
}

export type PluginAppBadge = number | 'dot' | null | { text: string }

export interface PluginAppProps {
  basePath: string
  subpath: string
  search: string
  navigate(path: string, options?: { replace?: boolean }): void
}

/** Which surface carries the App's entry row. See packages/plugin-api web.ts. */
export type PluginAppPlacement = 'sidebar' | 'settings'

export interface PluginAppContribution {
  id: string
  title: string
  icon?: ComponentType<{ size?: number }>
  component: ComponentType<PluginAppProps>
  badge?: PluginAppBadge
  order?: number
  fullBleed?: boolean
  placement?: PluginAppPlacement
}

export interface PluginAppHandle extends Disposable {
  readonly path: string
  setBadge(value: PluginAppBadge): void
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
  /** The server is still walking its plugins at boot: a plugin missing from `plugins` may just not be reached yet. */
  loading?: boolean
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

export interface PluginPageContribution {
  id: string
  path: string
  component: ComponentType<Record<string, never>>
  title?: string
}

export interface PluginSettingsContribution {
  id: string
  label: string
  component: ComponentType<Record<string, never>>
}

/** Mirrors `@open-walnut/plugin-api`'s SlotTarget: the host surfaces a plugin can draw inside. */
export type PluginSlotTarget = 'task.meta' | 'session.meta' | 'status-item.panel' | 'dialog'
export const PLUGIN_SLOT_TARGETS: readonly PluginSlotTarget[] = ['task.meta', 'session.meta', 'status-item.panel', 'dialog']

export interface PluginTaskMetaSlotProps {
  taskId: string
  navigate(path: string): void
}

export interface PluginSessionMetaSlotProps {
  sessionId: string
  taskId?: string
  /** 'header' when the user pinned the fact to the session header (no label there). */
  placement?: 'menu' | 'header'
  navigate(path: string): void
}

/** A panel a plugin draws in its own status item's popover; while it renders, the item's buttons step aside. */
export interface PluginStatusItemPanelSlotProps {
  itemId: string
  close(): void
  navigate(path: string): void
}

export interface PluginDialogSlotProps {
  args?: Record<string, unknown>
  close(): void
  navigate(path: string): void
}

export interface PluginSlotPropsByTarget {
  'dialog': PluginDialogSlotProps
  'task.meta': PluginTaskMetaSlotProps
  'session.meta': PluginSessionMetaSlotProps
  'status-item.panel': PluginStatusItemPanelSlotProps
}

/** Mirrors `@open-walnut/plugin-api`'s SlotContribution (see ChatViewProps for why it must). */
export interface PluginSlotContribution<T extends PluginSlotTarget = PluginSlotTarget> {
  id: string
  target: T
  title: string
  component: ComponentType<PluginSlotPropsByTarget[T]>
  order?: number
}

/** A plugin's link handler (`walnut.ui.link`); matching and opening live in link-handlers.ts. */
export interface LinkOpenContext {
  /** Navigate within the console (an App path, `/tasks/<id>`, ...). */
  navigate(path: string): void
  /** `'click'` for a plain click, `'menu'` for the right-click menu's row. */
  via: 'click' | 'menu'
}

export interface LinkHandlerContribution {
  /** Local id, unique within the plugin. */
  id: string
  /** Match patterns (see the module comment). At least one. */
  patterns: string[]
  /** What the right-click row says after "Open in". Defaults to the plugin's name. */
  title?: string
  /**
   * A finer test, run synchronously at click time after a pattern matched (a host
   * the plugin is signed into, an id it can read). False leaves the link to the browser.
   */
  accepts?(url: URL): boolean
  /**
   * Open it. Return `false` (or throw) when it cannot, and the host opens it in the
   * default browser. Decide quickly: a browser may refuse a window opened long after
   * the click, so an asynchronous `false` falls back only on a best-effort basis.
   */
  open(url: URL, context: LinkOpenContext): boolean | void | Promise<boolean | void>
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
  pages: Array<RegisteredUiContribution<PluginPageContribution>>
  settings: Array<RegisteredUiContribution<PluginSettingsContribution>>
  slots: Array<RegisteredUiContribution<PluginSlotContribution>>
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
export type TaskViewPhase = 'TODO' | 'WAITING' | 'IN_PROGRESS' | 'NEED_ACTION' | 'COMPLETE'
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
  /**
   * Sent once as the first user turn when the conversation is ready, through `transformMessage`.
   *
   * This mirrors `@open-walnut/plugin-api`'s `ChatViewProps`, and it must: the plugin declares the prop
   * against that package while the bridge renders THIS type, so a field missing here is a field the
   * adapter silently drops. That is how a plugin's preset reached a chat that then sat empty.
   */
  autoSend?: string
  /** Called with the text after `autoSend` went out, so the opener can latch it and never send it twice. */
  onAutoSent?(text: string): void
}

/** Mirrors `@open-walnut/plugin-api`'s `AskObjectViewProps` (see ChatViewProps for why it must). */
export interface AskObjectViewProps {
  objectKey: string
  title: string
  quote: { who: string; when: string; where: string; preview: string }
  contextBlock: string
  contextName: string
  agentId?: string
  preset?: string
  autoSend?: boolean
  onClose(): void
  onBack?(): void
  restoreFocusTo?: string
}

/** Mirrors `@open-walnut/plugin-api`'s `MicButtonHandle`. */
export interface MicButtonHandle {
  clear(): void
  /**
   * Recording, or its words still on their way. Optional: a host older than this API has none.
   * A send while it is true should call `finish()` first, the way the host's own composers do.
   */
  busy?(): boolean
  /**
   * Stop the recording (if any) and resolve once its words are in the box (the box's next
   * render holds them). `error` set: the dictation failed, so leave the text unsent.
   */
  finish?(): Promise<{ error: string | null }>
}

/** Mirrors `@open-walnut/plugin-api`'s `MicButtonProps` (see ChatViewProps for why it must). */
export interface MicButtonProps {
  boxRef: RefObject<HTMLTextAreaElement | HTMLInputElement | null>
  value: string
  onChange(text: string): void
  disabled?: boolean
  size?: 'sm' | 'md'
  handleRef?: RefObject<MicButtonHandle | null>
}

export interface PluginViews {
  CalendarView: ComponentType<Record<string, never>>
  FileView: ComponentType<FileViewProps>
  NoteView: ComponentType<Record<string, never>>
  TerminalView: ComponentType<TerminalViewProps>
  SessionView: ComponentType<SessionViewProps>
  TaskView: ComponentType<TaskViewProps>
  ChatView: ComponentType<ChatViewProps>
  AskObjectView: ComponentType<AskObjectViewProps>
  /** Dictation into the plugin's own text box: the composer's mic (BoxMic). */
  MicButton: ComponentType<MicButtonProps>
  /** The plugin's own generated Settings form (manifest configSchema + uiHints), as rows. */
  PluginSettingsView: ComponentType<Record<string, never>>
  /** The two content actions (Talk to CEO, New task) as buttons, for one piece of content. */
  ContentActions: ComponentType<{ item: ContentItem; size?: 'buttons' | 'compact' }>
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
    // `owner` is optional: the cloud relay omits it when an older primary answered.
    list(): Promise<Array<{ name: string; title: string; readonly: boolean; owner?: string }>>
  }
  readonly ws: {
    call<T = unknown>(id: string, payload?: unknown): Promise<T>
  }
  readonly http: {
    fetch(url: string, init?: PluginFetchInit): Promise<PluginFetchResponse>
  }
  /** Talk to CEO and New task for one piece of content (utils/content-actions.ts). */
  readonly content: {
    actions(item: ContentItem): ContentAction[]
    talkToCeo(item: ContentItem): Promise<boolean>
    newTask(item: ContentItem): Promise<void>
  }
  readonly ui: {
    app(contribution: PluginAppContribution): PluginAppHandle
    page(contribution: PluginPageContribution): Disposable
    settings(contribution: PluginSettingsContribution): Disposable
    slot<T extends PluginSlotTarget>(contribution: PluginSlotContribution<T>): Disposable
    openDialog(id: string, args?: Record<string, unknown>): boolean
    link(contribution: LinkHandlerContribution): Disposable
    injectCss(css: string): Disposable
    readonly views: PluginViews
    readonly useView: PluginUseView
    readonly useDraft: PluginUseDraft
  }
  /**
   * Share what this App shows with the AI working on a task (see the server
   * `AppStateService`): the latest JSON object wins, and the next message into the
   * task's session carries what changed. Calls within 300 ms are folded into one
   * request, so publishing on every keystroke is fine.
   */
  readonly appState: {
    publish(
      taskId: string,
      state: Record<string, unknown>,
      options?: { mode?: 'passive' | 'proactive'; label?: string; note?: string },
    ): Promise<{ version: number; kept: boolean }>
    clear(taskId: string): Promise<void>
  }
  /** The user's AI (plugin-ai.ts): one call, Walnut picks the route, interactive by default. */
  readonly ai: import('./plugin-ai').WebAiService
  readonly unsafe: {
    readonly react: unknown
    readonly host: unknown
    readonly dom: Document
  }
}

/** `useState` for a view choice of the plugin's own, kept by Walnut (plugins/use-view.ts). */
export type PluginUseView = <T>(name: string, initial: T | (() => T), options?: { id?: string; accept?: (value: unknown) => boolean }) => [T, (next: T | ((prev: T) => T)) => void]

/** The words a user is typing in a plugin's box, kept in Walnut's draft store (plugins/use-draft.ts). */
export type PluginUseDraft = (name: string, options?: { id?: string }) => [string, (next: string | ((prev: string) => string)) => void, () => void]
