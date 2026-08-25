import type { WalnutWebApi } from '@open-walnut/plugin-api/web'

/**
 * The host endpoints this app reads, and nothing else.
 *
 * Collection and storage stay entirely in Walnut: the plugin never writes a time
 * record, it only asks the same three read endpoints the console asks. Requests go
 * through `walnut.http.fetch`, which is same-origin and carries the device
 * credential, so the plugin never handles a token itself.
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
  tasks: TaskDayTime[]
}

export interface TimeSummary {
  days: DayTime[]
  today: string
  focusTaskIds: string[]
  focusShare: number
  totalHumanMs: number
  totalAgentMs: number
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

/** Only the three fields the reports need out of the console's task list. */
export interface TaskRef {
  id: string
  title: string
  project?: string
}

export interface TimeApi {
  summary(days: number): Promise<TimeSummary>
  blocks(date: string, opts?: { kinds?: readonly TimeKind[]; raw?: boolean }): Promise<DayBlocks>
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

    async tasks() {
      // `fields=list` is the lightest list the console offers: no notes, no
      // conversation log, no description. Titles and projects are all this app wants.
      const body = await getJson<{ tasks?: TaskRef[] }>('/api/tasks?fields=list')
      return Array.isArray(body.tasks) ? body.tasks : []
    },
  }
}
