/**
 * Walnut's health monitor: metrics with alarms, the way CloudWatch has them.
 *
 * Every minute the server writes ONE row of numbers (a gauge's value, a counter's
 * sum for that minute). An alarm reads the rows of its metric, folds them into
 * periods, and is in ALARM when M of its last N periods cross its threshold.
 * On the move into ALARM it runs its auto-fix (a safe, reversible step) and,
 * when that is not enough, opens one "fix Walnut" task for the alarm.
 */

export type AlarmState = 'OK' | 'ALARM' | 'INSUFFICIENT_DATA'

/** One minute of numbers: `t` is the minute's start (epoch ms), `v` maps a series key to its value. */
export interface MinuteRow {
  t: number
  v: Record<string, number>
}

export type Comparison = '>' | '>=' | '<' | '<='

/** How a period folds its minutes. */
export type Statistic = 'sum' | 'max' | 'avg' | 'last' | 'min'

/**
 * `counter`: a minute row without the key counts 0 (nothing happened that minute).
 * `gauge`: a minute row without the key is no data.
 */
export type SeriesKind = 'counter' | 'gauge'

/** What a period with no data counts as. `missing` keeps it out; all missing reads INSUFFICIENT_DATA. */
export type MissingData = 'missing' | 'notBreaching' | 'breaching'

/** What happens when the alarm goes into ALARM. */
export interface AlarmAction {
  /** An id in auto-fix.ts: tried first, once per episode. */
  autoFix?: string
  /**
   * After the auto-fix (or at once with none):
   *  - `fix-task`: one "fix Walnut" task for this alarm (fix-task.ts);
   *  - `notify`: a card in the notification center (only the user can act on it);
   *  - `none`: shown on the Health page only (another part of Walnut already tells the user).
   */
  then: 'fix-task' | 'notify' | 'none'
  /** Minutes the alarm must stay in ALARM after its auto-fix before `then` runs (default 30). */
  graceMin?: number
}

export interface AlarmDef {
  /** Stable id, also the id of the alarm's instances without labels. */
  id: string
  title: string
  /** One line: what it watches and why it matters. */
  description: string
  /**
   * Series key. A `*` label value (`host.link.lost{host=*}`) makes one alarm
   * instance per value seen.
   */
  metric: string
  kind: SeriesKind
  stat: Statistic
  periodMin: number
  comparison: Comparison
  threshold: number
  /** N: how many of the latest periods are read. */
  evaluationPeriods: number
  /** M: how many of them must cross. */
  datapointsToAlarm: number
  missing: MissingData
  /** A second condition on the same minutes, both must hold (disk: little free AND a high used %). */
  also?: { metric: string; stat: Statistic; comparison: Comparison; threshold: number }
  unit: string
  action: AlarmAction
}

export interface AlarmHistoryEntry {
  at: number
  from: AlarmState
  to: AlarmState
  /** The value that decided it (the latest period's). */
  value: number | null
  reason: string
}

/** What was done for an alarm in its current episode. */
export interface AlarmActionRecord {
  at: number
  kind: 'auto-fix' | 'fix-task' | 'notify'
  ok: boolean
  detail: string
  taskId?: string
}

export interface AlarmInstanceState {
  /** `<def id>` or `<def id>{label=value}`; for log alarms `log.spike:<signature>`. */
  id: string
  defId: string
  labels?: Record<string, string>
  state: AlarmState
  /** When the current state began. */
  since: number
  value: number | null
  evaluatedAt: number
  history: AlarmHistoryEntry[]
  /** Actions of the current ALARM episode (cleared on the next episode). */
  actions: AlarmActionRecord[]
  /** The fix task opened for it, kept across episodes while it stays open. */
  fixTaskId?: string
  /** The signature a log alarm watches, for display. */
  signature?: string
}

/** A person's or an agent's change to a built-in alarm. */
export interface AlarmOverride {
  threshold?: number
  enabled?: boolean
  /** Epoch ms until which actions are held (the alarm still evaluates). */
  mutedUntil?: number
  /** `human` or `task:<id>`. */
  by: string
  at: number
}
