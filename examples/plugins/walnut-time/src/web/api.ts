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

  async function postJson<T>(path: string, body: unknown): Promise<T> {
    const response = await walnut.http.fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      timeoutMs: TIMEOUT_MS,
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

    async tasks() {
      // `fields=list` is the lightest list the console offers: no notes, no
      // conversation log, no description. Titles and projects are all this app wants.
      const body = await getJson<{ tasks?: TaskRef[] }>('/api/tasks?fields=list')
      return Array.isArray(body.tasks) ? body.tasks : []
    },
  }
}
