import type { WalnutWebApi } from '@open-walnut/plugin-api/web'

/**
 * The host endpoints this app reads, and nothing else.
 *
 * Collection and storage stay entirely in Walnut: the plugin never writes a time
 * record, it only reads the host's own endpoints. Requests go through
 * `walnut.http.fetch`, which is same-origin and carries the device credential, so
 * the plugin never handles a token itself.
 *
 * ONE call here is not a read: the outside-activity toggle. It writes a SETTING
 * (config.time.outside.enabled), never a record, and the host owns everything that
 * setting starts or stops.
 *
 * The types are this app's own reading of the `/api/time/*` responses (served by
 * src/web/routes/time.ts). A plugin bundles standalone, so it cannot import the
 * host's types; if an endpoint grows a field, add it here too.
 */

export type TimeHumanKind = 'session' | 'triage' | 'chat'
export type TimeKind = TimeHumanKind | 'agent'

export interface TaskDayTime {
  /** '' = no task (Inbox / taskless session / main-agent chat). */
  taskId: string
  humanMs: number
  byKind: Record<TimeHumanKind, number>
  agentMs: number
  focus: boolean
}

export interface DayTime {
  date: string
  humanMs: number
  agentMs: number
  /** The slice of humanMs banked from the iOS app. Day-level only: a task's
   *  number never splits by device. Present only when > 0. */
  iosMs?: number
  tasks: TaskDayTime[]
}

export interface TimeSummary {
  days: DayTime[]
  today: string
  focusTaskIds: string[]
  focusShare: number
  totalHumanMs: number
  totalAgentMs: number
  /** Window-wide iOS slice of totalHumanMs. Present only when > 0. */
  totalIosMs?: number
  degraded?: boolean
}

/**
 * One drawn interval. `ms` is the wall span (what a block's length means);
 * `trackedMs` is the recorded time inside it, which is smaller whenever the server
 * merged over a short gap. Totals always cite `trackedMs`.
 */
export interface TimeBlock {
  taskId: string
  kind: TimeKind
  startTs: string
  endTs: string
  ms: number
  trackedMs: number
}

export interface TaskTotal {
  taskId: string
  ms: number
}

export interface DayBlocks {
  date: string
  /** Merged mode: one entry per (task, run of work), so entries may overlap.
   *  Raw mode: ONE serial ribbon, non-overlapping by construction. */
  blocks: TimeBlock[]
  shortMs: number
  foldedMs: number
  overlapMs?: number
  totals: TaskTotal[]
  agentTotalMs: number
  titles: Record<string, string>
  degraded?: boolean
  raw?: boolean
}

/** One site inside a browser's row. Host only, never a full URL. */
export interface OutsideSite {
  host: string
  ms: number
}

export interface OutsideApp {
  app: string
  bundleId?: string
  ms: number
  /** Present only when the WHOLE row is Walnut time — never a partial flag. */
  walnut?: true
  /** Browser rows only, and only for samples that carried a host. */
  sites?: OutsideSite[]
}

/** One day of activity OUTSIDE Walnut: which Mac app, and for a browser, which site. */
export interface DayApps {
  date: string
  /** Sampling is opt-in and off by default. */
  enabled: boolean
  /** A helper process is attached and streaming right now. */
  running: boolean
  totalMs: number
  /** Of totalMs, the Walnut desktop app plus any Walnut-hosted page. Bucket-accurate,
   *  so `totalMs - walnutMs` is right even for a browser row that mixes the two. */
  walnutMs: number
  /** False only when a browser WAS used and no sample carried a host: the
   *  Automation grant is missing. True when no browser was used at all. */
  browserHostsSeen: boolean
  /** Descending by ms; a browser's `sites` are descending too. */
  apps: OutsideApp[]
  degraded?: boolean
}

export interface AppsToggle {
  enabled: boolean
  running: boolean
}

/** One interval of one outside app being in front. `ms` is tracked time inside
 *  the interval (≤ its wall span when short gaps were merged server-side). */
export interface OutsideTimelineBlock {
  startTs: string
  endTs: string
  ms: number
}

export interface OutsideTimelineApp {
  app: string
  bundleId?: string
  /** This app's NON-Walnut time that day. A browser that also visited Walnut
   *  pages shows less here than on the Apps tab — by design, not drift. */
  ms: number
  blocks: OutsideTimelineBlock[]
  truncated?: true
}

/** WHEN each outside app was used, for the timeline. Walnut's own time is
 *  excluded server-side: the attention lanes already draw it. */
export interface DayAppsBlocks {
  date: string
  enabled: boolean
  /** A helper process is attached and streaming right now. */
  running: boolean
  totalMs: number
  /** Counted but not placeable on the axis (older folded records). */
  unplacedMs: number
  apps: OutsideTimelineApp[]
  /** Apps beyond the server's row cap: in totalMs, but without a row. */
  droppedApps: number
  droppedMs: number
  degraded?: boolean
}

// ── Apple Screen Time (the iPhone, and this Mac when asked for) ──
// A whole separate measurement from everything above: Apple counted it, at HOUR
// resolution, on devices Walnut cannot sample. Kept in its own types so nothing
// can accidentally add a phone's minutes to a Mac sample's minutes.

export type ScreenTimeAccess =
  | 'ok' | 'needs_grant' | 'stale_grant' | 'no_store' | 'unavailable' | 'off' | 'unknown'

export interface ScreenTimeAppRow {
  bundleId: string
  ms: number
  pickups?: number
  notifications?: number
  category?: string
}

/** A website row. A DIFFERENT type from an app row on purpose: Apple counts a
 *  browser's app time and the domains inside it separately, so they never sum. */
export interface ScreenTimeSiteRow {
  domain: string
  ms: number
  category?: string
}

export interface ScreenTimeTimelineBlock {
  startTs: string
  ms: number
}

export interface ScreenTimeDropped {
  apps: number
  appMs: number
  sites: number
  siteMs: number
  blocks: number
  blockMs: number
}

export interface ScreenTimeDevice {
  deviceId: string
  deviceName: string
  platform: number
  /** APPLE's total for the device's day. Never a sum of the rows below. */
  totalMs: number
  appMs: number
  siteMs: number
  pickups: number
  notifications: number
  apps: ScreenTimeAppRow[]
  sites: ScreenTimeSiteRow[]
  blocks: ScreenTimeTimelineBlock[]
  blockGranularity: 'hour'
  dropped: ScreenTimeDropped
  headerMissing?: true
  local?: true
}

export interface DayScreenTime {
  date: string
  enabled: boolean
  includeThisMac: boolean
  access: ScreenTimeAccess
  /** The exact path to add in System Settings, when a grant is the fix. */
  helperPath?: string
  devices: ScreenTimeDevice[]
  /** This Mac's Apple rows. Sent only when includeThisMac. */
  localDevices?: ScreenTimeDevice[]
  totalMs: number
  pickups: number
  notifications: number
  localTotalMs: number
  blockGranularity: 'hour'
  lastSnapshotAt?: number
  lastSnapshotOk?: boolean
  /** Days our permanent copy holds, newest first. */
  storedDates?: string[]
  degraded?: boolean
}

export interface ScreenTimeToggle {
  enabled: boolean
  includeThisMac: boolean
  access: ScreenTimeAccess
  helperPath?: string
}

export interface ScreenTimeRefresh {
  ok: boolean
  /** True when the snapshot is still running: NOT a failure. */
  running: boolean
  days: number
  devices: number
}

/** Only the three fields the reports need out of the console's task list. */
export interface TaskRef {
  id: string
  title: string
  project?: string
}

export interface TimeApi {
  summary(days: number): Promise<TimeSummary>
  blocks(date: string, opts?: { kinds?: readonly TimeKind[]; raw?: boolean }): Promise<DayBlocks>
  /** ONE day of outside activity. */
  appsDay(date: string): Promise<DayApps>
  /** ONE day of outside activity as per-app intervals, for the timeline. */
  appsBlocks(date: string): Promise<DayAppsBlocks>
  /** Turn outside sampling on or off. Always explicit, never a blind flip: the UI
   *  knows the current state, and a double-click must not toggle twice. */
  setAppsEnabled(enabled: boolean): Promise<AppsToggle>
  /** ONE day of Apple Screen Time, per device, from Walnut's permanent copy. */
  screenTime(date: string, opts?: { refresh?: boolean }): Promise<DayScreenTime>
  /** Either switch; both are opt-in and off by default. */
  setScreenTime(next: { enabled?: boolean; includeThisMac?: boolean }): Promise<ScreenTimeToggle>
  /** Re-read Apple's store now. For the "I just granted the permission" moment. */
  refreshScreenTime(): Promise<ScreenTimeRefresh>
  /**
   * Open the Full Disk Access pane ON THE MAC and put the helper's path on the Mac's
   * clipboard, in one click. Server-side on purpose: the pane and the clipboard that
   * matter are the Mac's, even when this UI is a phone.
   */
  openScreenTimeSettings(): Promise<{ ok: boolean; copiedPath?: string }>
  /** The task list, for titles and the project filter. */
  tasks(): Promise<TaskRef[]>
}

const TIMEOUT_MS = 10_000

export function createTimeApi(walnut: WalnutWebApi): TimeApi {
  async function getJson<T>(path: string): Promise<T> {
    const response = await walnut.http.fetch(path, { timeoutMs: TIMEOUT_MS })
    if (!response.ok) throw new Error(`HTTP ${response.status} from ${path}`)
    return response.json<T>()
  }

  async function postJson<T>(path: string, body: unknown, timeoutMs = TIMEOUT_MS): Promise<T> {
    const response = await walnut.http.fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      timeoutMs,
    })
    if (!response.ok) throw new Error(`HTTP ${response.status} from ${path}`)
    return response.json<T>()
  }

  return {
    summary(days) {
      return getJson<TimeSummary>(`/api/time/summary?days=${encodeURIComponent(String(days))}`)
    },

    blocks(date, opts = {}) {
      const params = new URLSearchParams({ date })
      if (opts.kinds && opts.kinds.length > 0) params.set('kinds', opts.kinds.join(','))
      if (opts.raw) params.set('raw', '1')
      return getJson<DayBlocks>(`/api/time/blocks?${params.toString()}`)
    },

    appsDay(date) {
      return getJson<DayApps>(`/api/time/apps?date=${encodeURIComponent(date)}`)
    },

    appsBlocks(date) {
      return getJson<DayAppsBlocks>(`/api/time/apps/blocks?date=${encodeURIComponent(date)}`)
    },

    setAppsEnabled(enabled) {
      return postJson<AppsToggle>('/api/time/apps/toggle', { enabled })
    },

    screenTime(date, opts = {}) {
      const params = new URLSearchParams({ date })
      if (opts.refresh) params.set('refresh', '1')
      return getJson<DayScreenTime>(`/api/time/screentime?${params.toString()}`)
    },

    setScreenTime(next) {
      return postJson<ScreenTimeToggle>('/api/time/screentime/toggle', next)
    },

    openScreenTimeSettings() {
      // The console's own Permission Doctor endpoint, reused rather than reimplemented:
      // it owns the deep link and the pbcopy, so the plugin cannot drift from it.
      return postJson<{ ok: boolean; copiedPath?: string }>('/api/permissions/screen-time/open-settings', {})
    },

    refreshScreenTime() {
      // A real snapshot: three file copies plus a handful of queries, so it needs
      // more than the shared 10s budget before the server itself gives up.
      return postJson<ScreenTimeRefresh>('/api/time/screentime/refresh', {}, 25_000)
    },

    async tasks() {
      // `fields=list` is the lightest list the console offers: no notes, no
      // conversation log, no description. Titles and projects are all this app wants.
      const body = await getJson<{ tasks?: TaskRef[] }>('/api/tasks?fields=list')
      return Array.isArray(body.tasks) ? body.tasks : []
    },
  }
}
