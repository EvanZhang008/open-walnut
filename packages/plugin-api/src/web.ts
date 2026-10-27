export type * from './shared.js'

import type { ComponentType, RefObject } from 'react'
import type { AiService, Disposable, PluginLogger, TaskPhase, TaskPriority } from './shared.js'
import type { AppStatePublishOptions, EventApi, OpsService, PluginFetchInit, PluginFetchResponse } from './server.js'

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
 * daily surface: it gets no Sidebar entry and is opened from the Apps page (and the
 * Command Palette). The name is historic: such Apps once had a row in Settings. The
 * Sidebar is a small, expensive space, and an App that does not need to be one click
 * away should not spend it.
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
  /** Default `'settings'` (off the Sidebar, on the Apps page). Ask for `'sidebar'` only for a surface someone lives in all day. */
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
 *   menu closes when your value navigates. The user may pin the fact from that row to
 *   the session's header (off by default); there it renders with `placement: 'header'`.
 *
 * There is no slot a plugin puts on a session's header row by itself: its width belongs
 * to the host's own tools, and only the user decides to spend it.
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
  /**
   * Where the value is drawn. `'menu'` (and absent, on an older host): beside its label
   * in the ⋮ menu. `'header'`: the user pinned it to the session's header row, where the
   * host prints NO label, so render the shortest form that still says what it is (an
   * icon and a number) and name it in the hover text.
   */
  placement?: 'menu' | 'header'
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

/**
 * A session's full panel (history, composer, model and mode), drawn inside your App. It is
 * an embedded panel, not a home column: closing it, or closing it after a crash, only calls
 * `onClose` and never touches the person's session columns. Column lock does not apply here,
 * so `locked` and `onToggleLock` are accepted for compatibility and draw no lock control.
 */
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

/** What a `MicButton` puts in `handleRef`. */
export interface MicButtonHandle {
  /** Stop and throw away a live recording, and forget what dictation wrote, so no late words land. */
  clear(): void
}

/**
 * Walnut's dictation for a text box you draw (a textarea or a one-line input): the mic of Walnut's own
 * composer, with the user's Voice settings and engine, words appearing while they speak when the engine
 * can, and the same retry menu on a right-click. Words go in through `onChange`, the way typing does: at
 * the caret, each live draft replacing the last, the final text taking the focus. It never sends
 * anything. While voice is not set up or not working, a click opens Settings → Voice instead.
 *
 * Call `handleRef.current.clear()` when you send the text or point the box at another draft, so words
 * still being transcribed never land twice or in the wrong draft. Optional on the views object: a host
 * older than this view does not have it, so feature-detect and draw no mic.
 */
export interface MicButtonProps {
  boxRef: RefObject<HTMLTextAreaElement | HTMLInputElement | null>
  value: string
  onChange(text: string): void
  disabled?: boolean
  size?: 'sm' | 'md'
  handleRef?: RefObject<MicButtonHandle | null>
}

export interface LinkOpenContext {
  /** Navigate within the console (an App path, `/tasks/<id>`, ...). */
  navigate(path: string): void
  /** `'click'` for a plain click, `'menu'` for the row in the link's right-click menu. */
  via: 'click' | 'menu'
}

/**
 * Links your plugin opens. A plain click on a matching link anywhere in the console (a
 * chat or session message, a note, a task, a Board) opens it with `open` instead of
 * leaving for the browser; a modifier click (Cmd, Ctrl, Shift, Alt) still goes to the
 * browser, and a right-click shows "Open in <title>", "Open in default browser" and
 * "Copy link".
 *
 * `patterns` use the browser-extension match pattern syntax, `<scheme>://<host><path>`:
 * scheme `http`, `https` or `*` (either); host `*`, `*.example.com` (the host and every
 * subdomain) or an exact host, compared case-insensitively with the port ignored; path
 * starting with `/` where `*` is any run of characters, matched against the path plus the
 * query, never the fragment. Example: `https://*.example.com/archives/*`.
 *
 * When several plugins take the same link, the first one registered wins.
 */
export interface LinkHandlerContribution {
  /** Local id, unique within the plugin. */
  id: string
  /** At least one, at most 32. A pattern that does not parse throws. */
  patterns: string[]
  /** What the right-click row says after "Open in". Defaults to your plugin's name. */
  title?: string
  /**
   * A finer test, run synchronously at click time after a pattern matched (a host you are
   * signed into, say). Return false to leave the link to the browser.
   */
  accepts?(url: URL): boolean
  /**
   * Open the link, usually by navigating to your App (`navigate(app.path + '?link=...')`).
   * Return `false` (or throw) when you cannot, and the host opens it in the default
   * browser instead. Decide quickly: a browser may refuse a window opened long after the
   * click, so an asynchronous `false` falls back only on a best-effort basis.
   */
  open(url: URL, context: LinkOpenContext): boolean | void | Promise<boolean | void>
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
  /**
   * Open matching links in your plugin (see LinkHandlerContribution). Optional: a host
   * older than link handlers does not have it, so call it as `walnut.ui.link?.(...)`.
   */
  link?(contribution: LinkHandlerContribution): Disposable
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
    /** Dictation into your own text box (see MicButtonProps). Optional on the views object: feature-detect. */
    MicButton?: PluginComponent<MicButtonProps>
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
  /**
   * Share what this App shows with the AI working on a task (see the server
   * `AppStateService`): the latest JSON object wins, and the next message into the
   * task's session carries what changed. Calls within 300 ms are folded into one
   * request, so publishing on every keystroke is fine.
   */
  readonly appState: {
    publish(taskId: string, state: Record<string, unknown>, options?: AppStatePublishOptions): Promise<{ version: number; kept: boolean }>
    clear(taskId: string): Promise<void>
  }
  /**
   * The user's AI from the browser, the same call as the server's `walnut.ai` (no key, Walnut
   * picks the route). Calls count as interactive, `onText` streams, and aborting `signal` (pass
   * your App's unmount signal) cancels the run. Spend counts against your plugin's budget.
   */
  readonly ai: AiService
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
