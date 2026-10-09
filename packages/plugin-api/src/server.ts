export type * from './shared.js'
export { WalnutPluginError } from './shared.js'

import type {
  Disposable,
  PluginLogger,
  TaskPhase,
  TaskPriority,
  WalnutTask,
  WalnutTaskSummary,
} from './shared.js'

export interface TaskListFilter {
  status?: 'todo' | 'in_progress' | 'done'
  phase?: TaskPhase | TaskPhase[]
  project?: string
  source?: string
  parentTaskId?: string
  limit?: number
}

export interface TaskQueryInput {
  completion?: Array<'todo' | 'in_progress' | 'complete'>
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
    basis: 'created' | 'updated' | 'created_or_updated'
    last?: { value: number; unit: 'hours' | 'days' }
    from?: string
    until?: string
  }
  sort?: 'updated_desc' | 'created_desc' | 'completed_desc' | 'priority' | 'title_asc'
  limit?: number
}

export interface TaskCreateInput {
  title: string
  description?: string
  priority?: TaskPriority
  phase?: TaskPhase
  project?: string
  parentTaskId?: string
  dependsOn?: string[]
  tags?: string[]
  dueDate?: string
  startDate?: string
  endDate?: string
}

export interface TaskPatch {
  title?: string
  description?: string
  note?: string
  priority?: TaskPriority
  phase?: TaskPhase
  project?: string
  dependsOn?: string[]
  /** Replaces every tag. To change one tag, use `addTags` / `removeTags`. */
  tags?: string[]
  /** Added to the tags the task has AT WRITE TIME, so a tag someone else changes in
   *  the meantime survives. Idempotent. Ignored when `tags` is also given. */
  addTags?: string[]
  /** Removed from the tags the task has at write time. Ignored when `tags` is given. */
  removeTags?: string[]
  dueDate?: string | null
  startDate?: string | null
  endDate?: string | null
  sprint?: string | null
}

/** A folder inside a project. Folders nest; `parentId` names the enclosing one. */
export interface TaskFolder {
  id: string
  label: string
  /** The project the folder belongs to; '' is the Inbox. */
  project: string
  parentId?: string
  /** Tasks filed directly in this folder. */
  memberCount: number
}

export interface TaskFolderCreateInput {
  label: string
  /** '' is the Inbox. */
  project: string
  /** Nest inside this folder, which must belong to the same project. */
  parentId?: string
}

export interface TaskService {
  get(id: string): Promise<WalnutTask | null>
  list(filter?: TaskListFilter): Promise<WalnutTaskSummary[]>
  query(query: TaskQueryInput): Promise<WalnutTaskSummary[]>
  children(id: string): Promise<WalnutTaskSummary[]>
  create(input: TaskCreateInput): Promise<WalnutTask>
  /** Moving a task to another project drops its folder: a folder never follows a task
   *  across projects. File it again with `fileIntoFolder`. */
  update(id: string, patch: TaskPatch): Promise<WalnutTask>
  appendNote(id: string, markdown: string): Promise<void>
  appendLog(id: string, entry: string): Promise<void>
  complete(id: string): Promise<WalnutTask>
  delete(id: string): Promise<void>
  /** Every folder, empty ones included. */
  folders(): Promise<TaskFolder[]>
  /** Creates the project too (a local one) when the board has none by that name, and
   *  refuses a project the user deleted. Not available on a replica. */
  createFolder(input: TaskFolderCreateInput): Promise<TaskFolder>
  /** File tasks into a folder: each one moves into the folder's project when it is
   *  elsewhere, joins the folder, and takes the given tags and title. The batch is
   *  written as a few row updates, where `update` rewrites the task store once per
   *  task, so this is the call for dozens or thousands of tasks.
   *
   *  A task another service syncs is only filed, and only when it already sits in the
   *  folder's project: moving, retagging or renaming it would have to reach that
   *  service, which is `update`'s job. It is skipped otherwise, as is a missing task, a
   *  task whose new title the owning plugin rejects, and one that no longer matches
   *  `expectProject` / `expectTitle`. A task already filed as asked is in neither list.
   *  Not available on a replica. */
  fileIntoFolder(folderId: string, items: TaskFilingInput[]): Promise<TaskFilingResult>
  /** `fileIntoFolder` for a project with no folder: each task moves into the project when
   *  it is elsewhere and lands at its top level, then takes the given tags and title. A
   *  task already in the project keeps the folder it sits in there, unless its item says
   *  `topLevel`. The project is created
   *  (local) when the board has none by that name; a deleted one is refused. Same skips,
   *  same batch cost. Not available on a replica. */
  fileIntoProject(project: string, items: TaskFilingInput[]): Promise<TaskFilingResult>
  /** Delete an EMPTY folder (no tasks, no folders inside), such as one this plugin made and
   *  has since moved everything out of. Refuses a folder that still holds anything: the
   *  user may have filed their own work there. Not available on a replica. */
  deleteFolder(folderId: string): Promise<void>
  /** The board's pin groups (the user's custom tiers beside Focus, Satellite and Parked),
   *  in board order. A group's `id` is what `pinTier` takes. */
  pinGroups(): Promise<PinGroup[]>
  /** The pin group with this name, created when the board has none (names are compared
   *  case-insensitively, so a group the user made by that name is reused). The group is the
   *  user's from then on: renaming or deleting it is theirs, and this call never does
   *  either. A name a built-in tier uses, or a reserved one, refuses. Not available on a
   *  replica. */
  ensurePinGroup(label: string): Promise<PinGroup>
}

/** A custom tier on the pinned board. */
export interface PinGroup {
  /** `ct_` + 8 characters, stable across renames. */
  id: string
  label: string
}

export interface TaskFilingInput {
  id: string
  /** Plain tags, added to the ones the task has at write time. */
  addTags?: string[]
  /** Tags to take off; one the task does not carry is ignored. Removals apply before
   *  additions, so one item can swap a tag for another. */
  removeTags?: string[]
  title?: string
  /** File only if the task is still in this project (what you planned from). */
  expectProject?: string
  /** Rename only if the title is still this one; the rest of the item still applies. */
  expectTitle?: string
  /** `fileIntoProject` only: a task already in the project leaves its folder too. */
  topLevel?: boolean
  /** Where the task is pinned. A tier (`focus`, `satellite`, `wait` (Parked), or a pin
   *  group id) pins an open task there: one not pinned yet joins the pinned order at the
   *  bottom (or the top, see `pinAt`), one pinned elsewhere moves tier and keeps its place
   *  in the order. `null` unpins. Omitted, pins are left alone. A completed task is never
   *  pinned; an unknown tier refuses the call. Decide for yourself when a pin is yours to
   *  move: Walnut does not know whether the user placed it. */
  pinTier?: string | null
  /** The pin's place in the pinned order, with `pinTier`. `bottom` follows the user's own
   *  pins, `top` leads them; item order is kept either way, so a batch filed newest-first
   *  ends with its newest item on top. A new pin goes to the bottom when this is omitted,
   *  and a pin that already exists keeps its place unless this is given (so a plugin can
   *  re-sort pins it owns). */
  pinAt?: 'top' | 'bottom'
  /** Set when the work really began (ISO 8601, not in the future), for a task whose
   *  `createdAt` is only when Walnut first saw it: an imported run of a ticket opened a
   *  week earlier sorts and filters by the ticket's date once this is set. Ignored when it
   *  is not a valid time. */
  createdAt?: string
}

export interface TaskFilingResult {
  /** Tasks this call changed. */
  filed: string[]
  skipped: Array<{ id: string; reason: 'missing' | 'synced' | 'rejected' | 'changed' }>
}

/** A host from Settings, Hosts, or this machine. */
export interface HostInfo {
  /** The host's name in Settings, Hosts. This machine is `__local__`. */
  alias: string
  label?: string
  local: boolean
  /** False when the user hid the host from the session path picker. */
  enabled: boolean
  hostname?: string
  user?: string
  port?: number
}

export interface HostRunInput {
  /** A POSIX sh script, fed to `sh -s` on stdin. At most 1 MB. */
  script: string
  /** Positional arguments ($1, $2, …), passed as literal strings: no quoting needed. */
  args?: string[]
  /** Default 60 s, at most 10 minutes. */
  timeoutMs?: number
  /** Stdout past this ends the run with `truncated`. Default 8 MB, at most 64 MB. */
  maxOutputBytes?: number
}

export interface HostRunResult {
  /** The script's exit code; null when it never ran to an exit (timeout, cap, spawn failure). */
  code: number | null
  stdout: string
  /** The last 4,000 characters. */
  stderr: string
  timedOut: boolean
  truncated: boolean
}

export interface HostService {
  /** This machine first, then every host in Settings, Hosts. */
  list(): Promise<HostInfo[]>
  get(alias: string): Promise<HostInfo | null>
  /** Run a short script on a host: over ssh for a remote one (key auth only, it never
   *  prompts), directly for this machine. The only output is what comes back; a failure to
   *  connect is a nonzero `code` with ssh's words in `stderr`. Throws for a host Walnut does
   *  not know. Not available on a replica. */
  run(alias: string, input: HostRunInput): Promise<HostRunResult>
}

/** Walnut's importer, which files every outside session (one started in a terminal, or by
 *  another tool) as one task under a project per host. */
export interface SessionImportsService {
  /** The tag on every task the importer made and still owns. The first message a person
   *  sends into the session removes it: from then on the task is theirs. */
  readonly tag: string
  /** The project the importer files a host's sessions under ("Imported from <host>"). */
  projectFor(host: string): string
  /** Called after each importer run that changed the board (once per run, not per task). */
  onRun(handler: () => void | Promise<void>): Disposable
  /** Days an imported session may sit idle before the importer completes its task; 0 never. */
  autoCompleteAfterDays(): Promise<number>
  /** Keep the importer's lifecycle on imported tasks you file into `project`: one still
   *  carrying `tag` (nobody has written to it) is completed once its session has been idle
   *  `autoCompleteAfterDays()`, exactly as in the importer's own project. Without it, moving
   *  an import out takes it out of that sweep. Released when your plugin stops. */
  extendTo(project: string): Disposable
}

/** shown: the pill reads the whole tag; value: only the text after its key (a ticket id without
 *  `ticket:`), the whole tag in its tooltip; hidden: no pill. */
export type TagDisplay = 'shown' | 'value' | 'hidden'

export interface TagDisplayRule {
  /** One tag, or `<key>:*` for every tag starting `<key>:`. */
  pattern: string
  display: TagDisplay
  source: 'builtin' | 'default' | 'user' | 'plugin'
  pluginId?: string
  pluginName?: string
}

/** How a task's tags show as pills. Every tag is key:value (Walnut stores a plain word as
 *  `label:<word>`) and stays an ordinary tag (searched, filtered, editable); showing is display
 *  only. */
export interface TagService {
  /** How your own tags show by default, for one tag or `<key>:*`. The user's rule for the same
   *  tags wins; `walnut:*` is Walnut's own. An older Walnut knows only shown and hidden and throws
   *  on value: catch it and set shown instead. Released when your plugin stops. */
  setDefaultDisplay(pattern: string, display: TagDisplay): Disposable
  /** Every rule in force: Walnut's, the user's, and plugin defaults. */
  displayRules(): Promise<TagDisplayRule[]>
  /** What a pill of your own tags opens, for one tag or `<key>:*`: an http(s) URL with `{value}`
   *  where the tag's value goes (URL-encoded), like `https://tracker.example.com/{value}` for
   *  `ticket:*`. The user's link for the same tags wins (their empty link means none). Absent on
   *  a Walnut older than 2026-10: check it exists before calling. Released when your plugin stops. */
  setDefaultLink?(pattern: string, link: string): Disposable
  /** Every link in force: the user's, then plugin defaults. */
  linkRules?(): Promise<TagLinkRule[]>
}

export interface TagLinkRule {
  /** One tag, or `<key>:*`. */
  pattern: string
  /** A URL with `{value}`; the user's `''` means no link. */
  link: string
  source: 'user' | 'plugin'
  pluginId?: string
  pluginName?: string
}

export interface ConfigService {
  get<T extends Record<string, unknown> = Record<string, unknown>>(): Promise<T>
  patch(partial: Record<string, unknown>): Promise<void>
  onChange(handler: (config: Record<string, unknown>) => void | Promise<void>): Disposable
}

export interface PluginNotice {
  title: string
  body?: string
  severity?: 'info' | 'success' | 'warning' | 'error'
  dedupKey: string
  taskId?: string
  sessionId?: string
}

/**
 * One button on a notice. `op` is the LOCAL name of one of YOUR ops ('snooze'); the host
 * prefixes it with your plugin id, so a notice can only ever run your own ops. A click
 * POSTs `args` to that op, then closes the toast and marks the notice read.
 */
export interface PluginNoticeAction {
  label: string
  op: string
  args?: Record<string, unknown>
}

/**
 * `kind: 'reminder'` is a timed prompt for the human (a stand-up nudge, a focus block
 * ending): it toasts for two minutes, plays a soft chime, and raises a browser
 * notification when the tab is hidden, none of which happens in quiet mode. Re-firing a
 * reminder under the same dedupKey REPLACES the previous one (it alerts again). The
 * default kind, 'skill', keeps first-write-wins: a key still in the feed is a no-op.
 */
export interface PluginNotifyInput extends PluginNotice {
  kind?: 'skill' | 'reminder'
  /** At most three, primary first. */
  actions?: PluginNoticeAction[]
}

/** One reason Walnut is quiet. `until` and `since` are epoch milliseconds. */
export interface QuietHold {
  /** `user` (the human's toggle) or `plugin:<pluginId>`. */
  source: string
  until?: number
  reason?: string
  since: number
}

/**
 * Walnut-level do not disturb. `active` while any hold is live. `allowPermissions` is true
 * unless a live hold turned it off: a permission prompt blocks an agent, so it still
 * toasts during quiet by default. The same shape arrives as the `quiet:changed` event.
 */
export interface QuietState {
  active: boolean
  allowPermissions: boolean
  holds: QuietHold[]
}

export interface QuietInput {
  /** Epoch ms. Absent = until you clear it, or until your plugin is disabled or reloaded. */
  until?: number
  reason?: string
  /** Default true. */
  allowPermissions?: boolean
}

/** Your plugin's ONE quiet hold (source `plugin:<pluginId>`). `set` replaces it. */
export interface QuietService {
  get(): Promise<QuietState>
  set(input?: QuietInput): Promise<void>
  clear(): Promise<void>
}

export interface NotificationService {
  notify(notice: PluginNotifyInput): Promise<void>
  error(notice: PluginNotice): Promise<void>
  recover(): Promise<void>
  /** Remove your notice by the dedupKey you gave `notify`. Resolves even when it is already gone. */
  dismiss(dedupKey: string): Promise<void>
  readonly quiet: QuietService
}

// ── Sidebar status items ──
//
// A small live item at the bottom of the console's left rail, above Voice: a ring that
// counts down (or fills up) on its own, a short label, and a popover with a few buttons.
// It is DATA, not a component: the host draws it, ticks the ring from `timer` without any
// message from the plugin, and removes it when the plugin is disabled, reloaded or
// uninstalled. Publish what is true now; call `set` again when it changes.

/** `neutral` is the quiet default; `warning` is for "this needs you now". */
export type StatusItemTone = 'neutral' | 'accent' | 'success' | 'warning'

/** Drawn in the ring's centre instead of the minutes left. */
export type StatusItemGlyph = 'check' | 'alert' | 'stand' | 'pause'

export interface StatusItemTimer {
  /** Epoch ms. */
  startedAt: number
  /** Epoch ms, after `startedAt`. */
  endsAt: number
  /** `drain` (default) empties the ring as time runs out; `fill` fills it up. */
  mode?: 'fill' | 'drain'
}

/** A popover button. `op` is one of YOUR ops by its local name; the host prefixes it. */
export interface StatusItemAction {
  label: string
  op: string
  args?: Record<string, unknown>
  /** The one filled button. At most one action may set it. */
  primary?: boolean
}

export interface StatusItemState {
  /**
   * The rail label and the popover title, at most 80 characters. `{remaining}` is
   * replaced with the live time left on `timer` ("12 min", "1 h 5 min"), so
   * `'Stand up in {remaining}'` stays current without another `set`.
   */
  title: string
  /** One line under the title in the popover, at most 200 characters. */
  detail?: string
  tone?: StatusItemTone
  /** Without one, the ring is drawn full. */
  timer?: StatusItemTimer
  glyph?: StatusItemGlyph
  /** At most three, primary first. */
  actions?: StatusItemAction[]
  /** Local id of your App that the popover's footer link opens. Default: your first App. */
  app?: string
}

export interface StatusItemHandle extends Disposable {
  /** Show the item, or replace what it shows. Throws on an invalid state. */
  set(state: StatusItemState): void
  /** Hide it until the next `set`. */
  clear(): void
}

export interface UiService {
  /**
   * One status item per `id` (1-40 of `a-z 0-9 - _`), at most two per plugin. `order`
   * sorts items from different plugins, lower first (default 500).
   */
  statusItem(options: { id: string; order?: number }): StatusItemHandle
}

// ── Presence and quiet events ──
//
// `walnut.events.on(name, handler)` delivers these to a server entry. They are what a
// timer plugin (a stand-up reminder, a pomodoro) reads instead of polling the time
// routes: the human's attention arrives as it is banked, and Walnut's quiet state
// arrives as it changes. Names are stable; `event.data` has the shape named here.

/**
 * `'time:banked'`: attention the console (or the phone app) just recorded. Each record is a
 * window the person was interacting, `ts` its ISO start. `kind` is `session`, `chat` or
 * `triage`; `source` is absent for the browser and `ios` for the phone. Agent time never
 * arrives here. Fired per heartbeat batch, roughly once a minute while someone is present.
 */
export interface TimeBankedEvent {
  records: Array<{
    ts: string
    durationMs: number
    kind: string
    source?: string
    taskId?: string
    sessionId?: string
  }>
}

/**
 * `'time:outside'`: attention in another Mac app, from the optional frontmost-app sampler
 * (off until the user turns it on in the Time App). Aggregated to at most one event per
 * 30 seconds; a locked screen or an idle stretch never arrives.
 */
export interface TimeOutsideEvent {
  ts: string
  durationMs: number
  bundleId?: string
  idleSecs?: number
}

/** `'quiet:changed'`: the full QuietState, whenever any hold starts, changes or ends. */
export type QuietChangedEvent = QuietState

// ── Session hook contexts ──
//
// The shape `registry.hook` handlers receive for the turn points. Typed here so a plugin
// that waits for a natural pause (a turn ending) does not have to sniff fields. Every
// context carries the session; a turn end carries `result`, a failure carries `error`.

export interface PluginSessionHookContext {
  sessionId: string
  taskId?: string
  /** ISO time the hook fired. */
  timestamp: string
}

/** `onTurnStart`: the first response after a send. */
export interface PluginTurnStartContext extends PluginSessionHookContext {
  turnIndex: number
}

/** `onTurnComplete`: the turn ended cleanly. `result` may be empty when the text is unknown. */
export interface PluginTurnCompleteContext extends PluginSessionHookContext {
  result: string
  turnIndex: number
  totalCost?: number
  duration?: number
}

/** `onTurnError`: the turn failed. */
export interface PluginTurnErrorContext extends PluginSessionHookContext {
  error: string
}

/** One tappable decision on a letter. Buttons are what make a letter a question. */
export interface LetterActionInput {
  id: string
  label: string
  description?: string
}

export interface LetterSendInput {
  subject: string
  /** The document. Exactly one of `markdown` or `html`. */
  markdown?: string
  html?: string
  /** A short plain preview for the envelope row and the phone push. Derived when absent. */
  text?: string
  /** Present makes this a decision the human must answer; absent makes it a document. */
  actions?: LetterActionInput[]
  taskRefs?: string[]
  pin?: boolean
}

export interface LetterAnswerRecord {
  actionId: string
  label: string
  freeText?: string
  at: number
}

export interface LetterState {
  letterId: string
  subject: string
  actions: LetterActionInput[]
  /** Present once the letter has been answered, which can happen exactly once. */
  answered?: LetterAnswerRecord
}

export interface LetterAnsweredEvent {
  letterId: string
  actionId: string
  label: string
  freeText?: string
  answeredAt: number
  /** Which edge recorded it. `'plugin'` is your own `withdraw`. */
  source: 'web' | 'phone' | 'relay' | 'plugin'
  pluginId?: string
}

/**
 * Letters: ask the one human a question, wherever they are, and hear the answer back.
 *
 * A letter is a document in the human inbox with optional one-tap actions, rendered by the
 * console and by the phone. It is the host's approval object: a plugin that must not act
 * without a human decision sends a letter with actions and does nothing until `onAnswered`
 * fires. There is no origin session behind a plugin letter, so that event is the return path.
 *
 * At most 30 letters per plugin per minute; over that, `send` rejects with a plain-words
 * error. A letter badges the bell and pushes to the phone, so roll a batch into one letter.
 */
export interface LettersService {
  send(input: LetterSendInput): Promise<{ letterId: string }>
  /** Add a turn to the letter's thread, so the human sees what happened after they answered. */
  reply(letterId: string, input: { markdown?: string; html?: string; text?: string }): Promise<void>
  /**
   * Take the question back: the letter is answered server-side with the action id
   * `withdrawn` and your note, and nothing is delivered. Use it the moment the thing the
   * letter asked about changes, so a stale approval can never be tapped. Idempotent on a
   * letter the human already answered.
   */
  withdraw(letterId: string, input: { note: string }): Promise<void>
  /** The letter's current state, with no document read. `null` when the id is unknown. */
  get(letterId: string): Promise<LetterState | null>
  /** Answers to letters THIS plugin sent, and nothing else. */
  onAnswered(handler: (event: LetterAnsweredEvent) => void | Promise<void>): Disposable
}

export type OpResult<T = unknown> =
  | { ok: true; result: T }
  | { ok: false; message: string }

export interface OpSummary {
  name: string
  title: string
  readonly: boolean
  /**
   * `'core'` for a built-in op, otherwise the id of the plugin that declared it.
   * Always present from a server-side `walnut.ops.list()`; absent only when a web
   * App's list came through the cloud relay from a primary too old to send it.
   */
  owner?: string
}

export interface OpsService {
  call<T = unknown>(name: string, args?: Record<string, unknown>): Promise<OpResult<T>>
  unwrap<T>(result: OpResult<T>): T
  list(): Promise<OpSummary[]>
}

/**
 * A capability another plugin can call: a plain object whose own properties are all
 * functions. Not a class instance, an EventEmitter or a Promise — a consumer's handle is
 * resolved per key, per access, so anything carrying identity or internal state would go
 * stale the moment you republished it. Close over your state in the functions instead.
 */
export type ServiceApi = Record<string, (...args: any[]) => unknown>

export interface ServiceChange {
  /** `<publisherPluginId>:<name>`, or `core:<name>` for a host capability. */
  key: string
  pluginId: string
  action: 'published' | 'replaced' | 'removed'
}

/**
 * Services are how a plugin builds on another plugin. The publisher exports the api's TYPE
 * from its own `api.ts` and the consumer takes it as an `import type`, so the shape travels
 * at build time only and never through this package: Walnut's kernel does not know what a
 * mail or a calendar looks like, and it must stay that way.
 *
 * Everything here is SYNCHRONOUS, deliberately. A plugin that declared `dependencies` in
 * its manifest is loaded after those plugins activated, so a declared service is already
 * there when your `activate` runs; an awaitable `get` could only ever wait for something
 * that is never coming.
 *
 * `get` returns a live handle, not a snapshot: hold it for the plugin's lifetime, and it
 * follows the publisher through a republish or a reload. Once the publisher is gone, every
 * property access throws instead of answering `undefined`.
 */
export interface ServicesService {
  /**
   * Publish `api` as `<yourPluginId>:<name>`. `name` matches `/^[a-z0-9][a-z0-9_-]*$/` and
   * may not contain `:`; the host owns the prefix, so two plugins can never collide.
   * Publishing the same name twice replaces the earlier value. Publish synchronously inside
   * `activate`, so a plugin that depends on you can call the service during its own.
   *
   * The constraint says "every property of `api` is a function", which an `interface` and a
   * `type` alias both satisfy. The class-instance and thenable cases it cannot express are
   * refused at runtime.
   */
  publish<T extends Record<keyof T, (...args: any[]) => unknown>>(name: string, api: T): Disposable
  /**
   * A LAZY live handle to `key`: nothing is resolved until you call a method, so you may
   * take one for a key a peer publishes later in its own `activate`. Throws when your
   * manifest does not declare the publishing plugin in `dependencies`, because a declared
   * dependency is what makes the load order a guarantee. `core:` keys are exempt: those are
   * gated by `engines.walnut`.
   */
  get<T = ServiceApi>(key: string): T
  /**
   * Like `get`, and it additionally asserts that a publisher exists right now, so a typo'd
   * key throws inside your `activate` instead of at the first call. The name to use when the
   * point is "I declared this dependency, hand it over".
   */
  require<T = ServiceApi>(key: string): T
  /**
   * The plugin id of whoever is calling the service method you are running RIGHT NOW, or
   * `undefined` when the host called you or when nobody is inside a service call.
   *
   * Only meaningful inside the SYNCHRONOUS body of one of your own published methods. The
   * host sets it for the duration of `method.apply` and restores the previous value straight
   * after, so a nested service call sees its own caller and an `await` inside your method
   * loses it: read it on the first line and keep the value.
   *
   * What it is for: a capability plugin that hands out registrations (a provider, a source, a
   * transport) can record WHO registered each one, so it can drop them when that plugin goes
   * away instead of keeping a row it cannot attribute to anybody.
   */
  caller(): string | undefined
  /** Told when any service is published, replaced or removed, including your own. */
  onChange(handler: (change: ServiceChange) => void | Promise<void>): Disposable
}

export interface PluginEvent<T = unknown> {
  name: string
  data: T
  timestamp: number
  traceId?: string
  source?: string
}

export interface EventApi {
  on(
    names: string | string[],
    handler: (event: PluginEvent) => void | Promise<void>,
  ): Disposable
  emit(name: string, data: unknown): void
}

export interface PluginRequest {
  method: string
  path: string
  query: Record<string, string | string[]>
  headers: Record<string, string>
  json<T = unknown>(): Promise<T>
  text(): Promise<string>
}

export interface PluginReply {
  status?: number
  headers?: Record<string, string>
  json?: unknown
  text?: string
}

export type PluginRouteHandler = (request: PluginRequest) => PluginReply | Promise<PluginReply>

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

export interface HttpService {
  route(method: string, path: string, handler: PluginRouteHandler): Disposable
  fetch(url: string, init?: PluginFetchInit): Promise<PluginFetchResponse>
}

export type SqlValue = string | number | bigint | Uint8Array | null
export type SqlParams = Record<string, SqlValue> | SqlValue[]

export interface SqlRunResult {
  changes: number
  lastInsertRowid: number | bigint
}

export interface PluginDatabase {
  exec(sql: string): Promise<void>
  run(sql: string, params?: SqlParams): Promise<SqlRunResult>
  get<T extends Record<string, unknown> = Record<string, unknown>>(sql: string, params?: SqlParams): Promise<T | undefined>
  all<T extends Record<string, unknown> = Record<string, unknown>>(sql: string, params?: SqlParams): Promise<T[]>
  migrate(migrations: Array<{ version: number; sql: string }>): Promise<number>
}

export interface StorageService {
  readonly dataDir: string
  readJson<T>(name: string, fallback: T): Promise<T>
  writeJson(name: string, value: unknown): Promise<void>
  updateJson<T>(name: string, fallback: T, update: (current: T) => T | Promise<T>): Promise<T>
  readText(name: string): Promise<string | null>
  writeText(name: string, value: string): Promise<void>
  delete(name: string): Promise<void>
  list(prefix?: string): Promise<string[]>
  readonly database: PluginDatabase
}

export interface SecretService {
  get(name: string): Promise<string | undefined>
  set(name: string, value: string): Promise<void>
  delete(name: string): Promise<void>
  keys(): Promise<string[]>
}

export interface TimerService {
  timeout(handler: () => void | Promise<void>, delayMs: number): Disposable
  interval(handler: () => void | Promise<void>, intervalMs: number): Disposable
}

export interface PluginSyncTask extends Record<string, unknown> {
  id: string
  title: string
  description: string
  summary: string
  priority: TaskPriority
  phase: TaskPhase
  project?: string
  note?: string
  conversation_log?: string
  due_date?: string
  depends_on?: string[]
  parent_task_id?: string
  ext?: Record<string, unknown>
}

export interface PluginSyncPollContext {
  getTasks(): PluginSyncTask[]
  updateTask(id: string, updates: Partial<PluginSyncTask>): Promise<PluginSyncTask>
  addTask(data: Omit<PluginSyncTask, 'id'>): Promise<PluginSyncTask>
  deleteTask(id: string): Promise<void>
  emit(event: string, data: unknown): void
}

export interface PluginSyncPushResult {
  serverTimestamp: string
  ext?: Record<string, unknown>
}

export interface PluginRemoteSyncItem {
  remoteId: string
  title: string
  remoteUpdatedAt: string
  deleted?: boolean
  fields: Partial<PluginSyncTask>
}

export interface PluginIntegrationSync {
  createTask(task: PluginSyncTask): Promise<Record<string, unknown> | null>
  deleteTask(task: PluginSyncTask): Promise<void>
  updateTitle(task: PluginSyncTask, title: string): Promise<void>
  updateDescription(task: PluginSyncTask, description: string): Promise<void>
  updateSummary(task: PluginSyncTask, summary: string): Promise<void>
  updateNote(task: PluginSyncTask, note: string): Promise<void>
  updateConversationLog(task: PluginSyncTask, log: string): Promise<void>
  updatePriority(task: PluginSyncTask, priority: TaskPriority): Promise<void>
  updatePhase(task: PluginSyncTask, phase: TaskPhase): Promise<void>
  updateDueDate(task: PluginSyncTask, date: string | null): Promise<void>
  updateProject(task: PluginSyncTask, project: string): Promise<void>
  updateDependencies(task: PluginSyncTask, dependsOn: string[]): Promise<void>
  associateSubtask(parentTask: PluginSyncTask, childTask: PluginSyncTask): Promise<void>
  disassociateSubtask(parentTask: PluginSyncTask, childTask: PluginSyncTask): Promise<void>
  validateContent?(task: PluginSyncTask, field: string, value: string): string | null
  contentRequirement?(field: string): string | null
  pushTask(task: PluginSyncTask): Promise<PluginSyncPushResult>
  /**
   * Called once when a task enters this plugin's domain: created in, or moved into, a
   * project the plugin claims (never for tasks the plugin imported from the remote).
   * Runs after the row is written and before its first push, outside the store lock, so
   * it may do I/O but should be quick: the push waits for it. Returns the fields the
   * plugin wants as defaults. The core applies only fields the task has no value for
   * yet, and only from the defaultable set (sprint, priority, due_date, start_date,
   * end_date, tags); anything else is dropped with a warning. A tracker uses this to
   * put a new task in the current sprint; a plugin that has no defaults omits it.
   *
   * A throwing hook is logged at warn and ignored: it can never fail a task create.
   */
  prepareNewTask?(task: PluginSyncTask, context: { reason: 'created' | 'moved' }): Promise<Partial<PluginSyncTask> | undefined> | Partial<PluginSyncTask> | undefined
  syncPoll(context: PluginSyncPollContext): Promise<void>
  renameProjectRemote?(args: { oldRemoteName: string; newName: string }): Promise<void>
  deleteProjectRemote?(args: { project: string; remoteList?: string; tasks: PluginSyncTask[] }): Promise<
    | { outcome: 'container-deleted' }
    | { outcome: 'grouping-removed'; fallbackProject: string }
  >
  fullPull?(context: PluginSyncPollContext): Promise<PluginRemoteSyncItem[] | undefined | null>
  extractRemoteId?(task: PluginSyncTask): string | undefined
  extractRemoteIdAliases?(task: PluginSyncTask): string[]
  confirmRemoteDeleted?(remoteId: string, remoteList?: string | null): Promise<boolean>
}

/**
 * Where a plugin's link to its account stands. A sync plugin renews its own
 * credentials without a human; the ONE step it cannot do alone is the sign-in,
 * and this is how it hands that step to the console (Settings shows the state
 * and a Sign in button) and to the notification feed (a card with that button
 * when the account must sign in again).
 */
export type PluginConnectionState =
  | 'connected'
  | 'signing-in'
  | 'sign-in-required'
  | 'unreachable'
  | 'not-configured'

export interface PluginSignInPrompt {
  userCode: string
  verificationUri: string
  message?: string
  /** ISO time after which the code is dead and a new sign-in must start. */
  expiresAt: string
  startedAt: string
}

export interface PluginConnectionStatus {
  state: PluginConnectionState
  account?: string
  detail?: string
  /** ISO expiry of the short-lived credential in hand; renewal is automatic. */
  credentialExpiresAt?: string
  /** Present while `state` is 'signing-in'. */
  signIn?: PluginSignInPrompt
  lastFailureAt?: string
}

export interface PluginConnection {
  /** Answer from what you already know; never hit the network here. */
  status(): Promise<PluginConnectionStatus>
  /**
   * Start an interactive sign-in and resolve as soon as the prompt exists; the human
   * finishing it is observed through `status()`. Return the SAME prompt while one is
   * still valid. Omit when the credential is config-only (an API key).
   */
  signIn?(): Promise<PluginSignInPrompt>
}

/**
 * Put `authKind` on an error you throw from a sync method and Walnut reacts to the
 * class, not the text: 'sign-in-required' tells the human once, with a Sign in button;
 * 'unreachable' is retried quietly; 'not-configured' points at Settings.
 */
export type PluginAuthFailureKind = 'sign-in-required' | 'unreachable' | 'not-configured'

export interface PluginAuthFailure {
  authKind: PluginAuthFailureKind
  /** The provider's own error code, for the log line. */
  authCode?: string
}

export interface PluginDisplayMeta {
  badge: string
  badgeColor: string
  externalLinkLabel: string
  getExternalUrl(task: PluginSyncTask): string | null
  isSynced(task: PluginSyncTask): boolean
  syncTooltip?(task: PluginSyncTask): string
  languageHint?: string
}

export interface PluginExtIndexSpec {
  source: string
  paths: Array<{ key: string; json: string }>
}

export type PluginMigration = (
  tasks: PluginSyncTask[],
) => PluginSyncTask[] | Promise<PluginSyncTask[]>

export interface PluginToolSpec {
  name: string
  description: string
  inputSchema?: Record<string, unknown>
  execute(input: Record<string, unknown>): unknown | Promise<unknown>
}

/**
 * An operation ("op") this plugin adds to the host's op catalogue, so anything that calls
 * ops by name can call this one: another plugin's `walnut.ops.call`, this plugin's own web
 * App, and `POST /api/plugin-runtime/<pluginId>/ops/<opName>`. Use it for a stable named
 * capability other code should be able to invoke; use `tool` when the audience is the
 * Personal AI's tool list.
 *
 * `name` is local and lowercase; the host names the op `<normalized_plugin_id>_<name>`, so
 * a plugin called `mail` declaring `search` becomes `mail_search`. A final name that
 * collides with a built-in op is refused rather than allowed to shadow it. `inputSchema` is
 * a JSON Schema object: `type`, `enum`, `array`, nested `object`, `required`, and
 * `description` are honoured, `default` is ignored. There is no HTTP binding, because a
 * plugin op runs in the host process; `ctx.call` reaches a Walnut API route when you need one.
 *
 * Know the reach before you declare one. As soon as the plugin activates, the op is callable
 * from `walnut.ops.call`, the plugin runtime HTTP routes, an action card, and, when `remote`
 * is `'allow'`, from `walnut tools call` inside EVERY Walnut-managed session on every host
 * (those run through the gateway, which resolves against this process's catalogue). Only two
 * surfaces are blind to plugin ops: a standalone `walnut …` command that talks HTTP from its
 * own process, and the stdio MCP server. So a read-only op, which defaults to
 * `remote: 'allow'`, is reachable by any agent in any session — pass `remote: 'deny'` when
 * that is not what you want.
 */
export interface PluginOpDefinition {
  name: string
  title: string
  description: string
  /** JSON Schema object. Default `{ type: 'object', properties: {} }`. */
  inputSchema?: Record<string, unknown>
  readonly: boolean
  /**
   * `'allow'` lets `walnut tools call <op>` inside any Walnut-managed session, local or
   * remote, reach this op through the gateway. `'deny'` keeps it to in-process callers:
   * `walnut.ops.call`, the plugin runtime routes, and action cards. Default:
   * `readonly ? 'allow' : 'deny'`.
   */
  remote?: 'allow' | 'deny'
  destructive?: boolean
  /** Deadline for EACH `ctx.call` request, not for the handler as a whole. */
  timeoutMs?: number
  handler(
    args: Record<string, unknown>,
    ctx: {
      call(
        method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
        path: string,
        body?: unknown,
      ): Promise<unknown>
    },
  ): Promise<unknown>
}

export interface CronActionResult {
  status: 'ok' | 'error'
  summary?: string
  error?: string
  data?: unknown
}

export type PluginHookPoint =
  | 'onSessionStart' | 'onMessageSend' | 'onTurnStart' | 'onToolUse'
  | 'onToolResult' | 'onPlanComplete' | 'onModeChange' | 'onTurnComplete'
  | 'onTurnError' | 'onSessionWillReap' | 'onTaskCreated' | 'onTaskUpdated'
  | 'onTaskPhaseChanged' | 'onTaskCompleted' | 'onCronFired'

export type PluginSessionMode = 'bypass' | 'accept' | 'default' | 'plan' | 'auto' | 'dontAsk'

export interface PluginHookFilter {
  modes?: PluginSessionMode[]
  projects?: string[]
  phases?: TaskPhase[]
  fromPhases?: TaskPhase[]
  sources?: string[]
  requiresSession?: boolean
  predicate?: (context: unknown) => boolean
}

export interface PluginHookDefinition {
  id: string
  point?: PluginHookPoint
  points?: PluginHookPoint[]
  priority?: number
  enabled?: boolean
  timeoutMs?: number
  filter?: PluginHookFilter
  handler(context: unknown): unknown | Promise<unknown>
}

export type PluginContextSourceId =
  | 'task_details' | 'project_memory' | 'project_task_list'
  | 'global_memory' | 'daily_log' | 'session_history' | 'conversation_log'
  | 'main_global_memory' | 'main_daily_log' | 'journal_recent' | 'working_memory'

export interface PluginAgentDefinition {
  id: string
  name: string
  description?: string
  runner: 'embedded' | 'cli'
  model?: string
  provider?: string
  region?: string
  max_tokens?: number
  max_tool_rounds?: number
  system_prompt?: string
  denied_tools?: string[]
  allowed_tools?: string[]
  working_directory?: string
  context_sources?: Array<{ id: PluginContextSourceId; enabled: boolean; token_budget?: number }>
  stateful?: { memory_project: string; memory_budget_tokens?: number; memory_source?: string }
  skills?: string[]
  console?: boolean
}

export interface PluginProviderCallOptions {
  providerConfig: Record<string, unknown>
  model: string
  maxTokens: number
  system: unknown
  messages: unknown[]
  tools?: unknown[]
  signal?: AbortSignal
  compat?: Record<string, unknown>
  betas?: string[]
  thinking?: unknown
}

export interface PluginProviderResult {
  content: unknown[]
  stopReason: string | null
  usage?: {
    input_tokens?: number
    output_tokens?: number
    cache_creation_input_tokens?: number
    cache_read_input_tokens?: number
    model?: string
  }
  aborted?: boolean
}

export interface PluginProviderAdapter {
  sendMessage(options: PluginProviderCallOptions): Promise<PluginProviderResult>
  sendMessageStream(
    options: PluginProviderCallOptions & { onTextDelta?: (delta: string) => void },
  ): Promise<PluginProviderResult>
  resetClient?(): void
}

/**
 * A slash command contributed by a plugin. The host names it `<pluginId>:<id>`, so it
 * can never collide with a user or built-in command; `content` is the instruction text
 * sent to the agent when the command runs. Read-only from the API and UI: editing it
 * means editing the plugin.
 */
export interface PluginCommandDefinition {
  id: string
  description: string
  content: string
}

/**
 * A directory of skills contributed by a plugin. `directory` is an ABSOLUTE path
 * holding one or more skills in the standard layout (`<directory>/<name>/SKILL.md`, or
 * `<directory>/<category>/<name>/SKILL.md`). It joins skill discovery as the
 * lowest-priority search root, so a workspace or user skill of the same name still
 * wins, and it disappears again when the plugin is disabled or reloaded.
 */
export interface PluginSkillDefinition {
  id: string
  directory: string
}

export interface RegistryService {
  sync(adapter: PluginIntegrationSync): Disposable
  sourceClaim(
    claim: (project: string) => boolean | Promise<boolean>,
    options?: { priority?: number },
  ): Disposable
  display(meta: PluginDisplayMeta): Disposable
  /** Show the account link in Settings and let the human sign in from there. At most one. */
  connection(link: PluginConnection): Disposable
  migration(migrate: PluginMigration): Disposable
  extIndex(spec: PluginExtIndexSpec): Disposable
  tool(spec: PluginToolSpec): Disposable
  op(definition: PluginOpDefinition): Disposable
  wsMethod(id: string, handler: (payload: unknown) => unknown | Promise<unknown>): Disposable
  agent(definition: PluginAgentDefinition): Disposable
  provider(id: string, adapter: PluginProviderAdapter): Disposable
  cronAction(
    id: string,
    description: string,
    handler: (params: Record<string, unknown>) => Promise<CronActionResult>,
  ): Disposable
  hook(definition: PluginHookDefinition): Disposable
  /**
   * @deprecated No consumer: a session reads skills, so this text reaches no
   * model. Ship a `skill` instead. Still accepted (and still collected) so a
   * plugin that calls it keeps loading.
   */
  agentContext(text: string): Disposable
  command(definition: PluginCommandDefinition): Disposable
  skill(definition: PluginSkillDefinition): Disposable
}

/**
 * One short text answer from the host's own configured model, on its fast tier.
 *
 * The host picks the provider (always the user's configured main one) and the model; a plugin
 * cannot name either, so whatever it sends never leaves the provider the user chose.
 */
export interface ModelService {
  fastText(request: {
    system: string
    messages: Array<{ role: 'user' | 'assistant'; content: string }>
    maxTokens: number
    signal?: AbortSignal
  }): Promise<string>
}

export interface UnsafeServerHost {
  readonly database: unknown
  readonly bus: unknown
  readonly walnutHome: string
  readonly host: unknown
}

export interface FullDiskAccessUse {
  /** Completes "Lets Walnut …" in Settings, e.g. "mirror your Mac's Focus into quiet mode". */
  reason: string
  /** One absolute path the plugin reads, which lets that row check the grant. */
  probe?: string
}

/**
 * The Mac's privacy walls, through Walnut's own grants. Mac only: on another platform, on a
 * replica, or on a test server with a temporary data dir, reads reject with `ENOTSUP`.
 */
export interface MacosService {
  /**
   * Say why this plugin reads files macOS keeps behind Full Disk Access, for as long as it
   * does. Settings, macOS Access, Full Disk Access names every reason Walnut's one grant is
   * used for, and `readProtectedFile` refuses a plugin that has not said. Released on dispose
   * or when the plugin stops.
   */
  useFullDiskAccess(use: FullDiskAccessUse): Disposable
  /**
   * Read a file macOS keeps behind Full Disk Access (for example `~/Library/DoNotDisturb/DB/`),
   * through Walnut's one grant for it, so the person grants Walnut once instead of whichever
   * program runs the server. Like `fs.readFile(path, 'utf8')`: a refused read rejects with
   * code `EPERM`, a missing file (or one that is not a regular file) with `ENOENT`, a file
   * over `maxBytes` (default 1 MB, at most 16 MB) with `EFBIG`, and a plugin with no live
   * `useFullDiskAccess` with `EACCES`. Absolute paths only; read-only by construction.
   */
  readProtectedFile(path: string, options?: { maxBytes?: number }): Promise<string>
  /** What the person adds in System Settings, Full Disk Access, for those reads (usually
   *  `/Applications/Walnut.app`), or null when there is nothing to add on this host. */
  fullDiskAccessTarget(): Promise<string | null>
}

/** What a session, the CLI or the Personal AI may call on a server (see `McpServerDefinition`). */
export type McpSessionAccess = 'read-only' | 'all' | 'none'

/** A stdio MCP server Walnut runs for a plugin. */
export interface McpServerDefinition {
  /** Unique across Walnut: lowercase letters, digits, `.`, `_`, `-`. */
  name: string
  command: string
  args?: string[]
  /**
   * Added to the environment the server starts with. That environment is an allowlist (HOME,
   * PATH, USER, SHELL, TMPDIR, locale, proxies), never the Walnut server's own: pass anything
   * else the server needs here.
   */
  env?: Record<string, string>
  cwd?: string
  /** Shown in Settings; defaults to the name. */
  title?: string
  /**
   * What callers other than plugins may call (`walnut mcp <name> tools call`, the `mcp_read` and
   * `mcp_call` ops). `read-only` (default): only tools the server marks `readOnlyHint`. `all`:
   * every tool, from this Mac only. `none`: plugins alone.
   */
  sessions?: McpSessionAccess
  /** Spawn + initialize budget. Default 60 s. */
  startupTimeoutMs?: number
  /** Default per-call deadline. Default 60 s. */
  callTimeoutMs?: number
  /** Close the process after this long without a call. Default 15 min; 0 keeps it open. */
  idleCloseMs?: number
}

export interface McpServerStatus {
  name: string
  title: string
  /** The plugin that registered it. */
  owner: string
  /** `idle`: no process (it starts on the next call). `failed`: the last start failed or it crashed. */
  state: 'idle' | 'starting' | 'ready' | 'failed'
  since: number
  sessions: McpSessionAccess
  toolCount?: number
  serverInfo?: { name: string; version: string }
  /** One plain sentence: why the last start failed, or why the process went away. */
  lastError?: string
}

export interface McpToolInfo {
  name: string
  title?: string
  description?: string
  readOnly: boolean
  destructive: boolean
  inputSchema: Record<string, unknown>
}

/** A tools/call answer as the server sent it. Structured content is passed through unvalidated. */
export interface McpCallResult {
  content: Array<Record<string, unknown>>
  structuredContent?: Record<string, unknown>
  isError?: boolean
}

/**
 * What `call` rejects with (`error.name === 'McpCallError'`). `stage: 'before-call'` means the
 * request never reached the server, so it did not run; `after-call` (a timeout, the process died,
 * cancelled) means it may have run, and a write must not be retried blindly.
 */
export interface McpCallFailure extends Error {
  readonly failure: 'unavailable' | 'timeout' | 'closed' | 'aborted' | 'refused'
  readonly stage: 'before-call' | 'after-call'
}

export interface McpClient {
  readonly name: string
  /** `meta` rides the request as `_meta` (a trace id, a tag your own test server reads). */
  call(
    tool: string,
    args?: Record<string, unknown>,
    options?: { timeoutMs?: number; signal?: AbortSignal; meta?: Record<string, unknown> },
  ): Promise<McpCallResult>
  tools(options?: { refresh?: boolean }): Promise<McpToolInfo[]>
  /** Null while no server by this name is registered. */
  status(): McpServerStatus | null
}

/**
 * MCP servers Walnut runs as a client. Walnut starts a registered server on its first call, keeps
 * the one process for every later call, starts it again after a crash, and closes it when idle.
 * On a replica nothing starts: every call rejects `before-call`.
 */
export interface McpService {
  /** Registered until disposed or the plugin stops. A name another plugin holds throws. */
  register(definition: McpServerDefinition): Disposable
  /** A handle by name; it resolves the server on every call, so it may be taken before one registers. */
  client(name: string): McpClient
  list(): McpServerStatus[]
  onStatus(handler: (change: { name: string; status: McpServerStatus | null }) => void | Promise<void>): Disposable
}

/** One value the person sets for a tunnel provider (a tunnel name, say). Filled into `args` as `{key}`. */
export interface ExposeProviderOption {
  key: string
  label: string
  default?: string
  help?: string
  /** A regular expression (source text) the value must match in full. */
  pattern?: string
}

/**
 * A tunnel or reverse proxy that makes this Walnut reachable from a browser anywhere. It is data,
 * not code: Walnut runs the command with the tunnel port filled in, reads its output for the public
 * URL, restarts it after an exit and stops it on shutdown. Everything that arrives through it needs
 * a device token.
 */
export interface ExposeProviderDefinition {
  /** Unique across Walnut: lowercase letters, digits, `.`, `_`, `-`. `command` is taken. */
  id: string
  title: string
  description?: string
  /** Absolute, `~/`-relative, or a name on PATH. */
  command: string
  /** `{port}` is the tunnel port; `{<option key>}` an option's value. */
  args?: string[]
  /** Added to the allowlisted environment the command starts with (never the server's own). */
  env?: Record<string, string>
  options?: ExposeProviderOption[]
  /** A regular expression (source text); its first match in the output is the public URL. */
  urlPattern: string
  /**
   * A line that says the tunnel is ready (a regular expression, case-insensitive). When set, the
   * provider is connected once it printed both the URL and this; when not, the URL line is enough.
   */
  readyPattern?: string
  /** Lines that mean the sign-in expired (regular expressions, case-insensitive). */
  signInPatterns?: string[]
  /** One sentence for the person when a sign-in line shows up. */
  signInHint?: string
  /** One sentence for the person when the command is not installed. */
  installHint?: string
  /** Check the URL answers every minute while connected and restart a silent tunnel. Default true. */
  probe?: boolean
}

export interface ExposeStatus {
  enabled: boolean
  provider: string | null
  providerTitle?: string
  state: 'off' | 'starting' | 'connected' | 'retrying' | 'needs-sign-in' | 'missing' | 'unavailable'
  since: number
  url?: string
  port?: number
  lastError?: string
  hint?: string
  nextRetryAt?: number
}

export interface ExposeService {
  /** Registered until disposed or the plugin stops. An id another plugin holds throws. */
  register(definition: ExposeProviderDefinition): Disposable
  /** This server's tunnel right now. */
  status(): ExposeStatus
}

export interface WalnutServerApi {
  readonly pluginId: string
  readonly pluginName: string
  readonly walnutVersion: string
  /**
   * True on a cloud replica, false on the primary box.
   *
   * A plugin that owns an outside account (a mailbox, a chat workspace, any polled service)
   * must not poll from two boxes: the second one double-fetches, double-writes and doubles
   * the load the other end sees. Read this and step aside, rather than assuming there is only
   * ever one Walnut.
   */
  readonly replica: boolean
  readonly signal: AbortSignal
  readonly log: PluginLogger
  readonly tasks: TaskService
  readonly hosts: HostService
  readonly macos: MacosService
  readonly mcp: McpService
  readonly expose: ExposeService
  readonly sessionImports: SessionImportsService
  readonly tags: TagService
  readonly config: ConfigService
  readonly notifications: NotificationService
  readonly ui: UiService
  readonly letters: LettersService
  readonly ops: OpsService
  readonly services: ServicesService
  readonly events: EventApi
  readonly http: HttpService
  readonly storage: StorageService
  readonly secrets: SecretService
  readonly timers: TimerService
  readonly registry: RegistryService
  readonly model: ModelService
  readonly unsafe: UnsafeServerHost
}

export interface WalnutServerPlugin {
  activate(walnut: WalnutServerApi): void | Disposable | Promise<void | Disposable>
  deactivate?(): void | Promise<void>
}

export function defineServerPlugin<T extends WalnutServerPlugin>(plugin: T): T {
  return plugin
}
