// Types, input normalization and pure checks of the legacy watcher migration (migration.ts).
import { createHash } from 'node:crypto'
import path from 'node:path'
import type { Task } from '../types.js'
import {
  ROUTER_CANONICAL_KEY_MAX, ROUTER_RULE_ID_PATTERN, ROUTER_RULE_REVISION_PATTERN, activeRouter, allAreaItems,
  type RouterArea, type RouterAreasFile,
} from './areas.js'
import { ROUTER_AREA_ID_PATTERN, ROUTER_EVIDENCE_MAX, routerKey } from './store.js'
import { ROUTER_SOURCE_KINDS, type RouterClaimResult, type RouterItem, type RouterLegacyReceipt, type RouterRoute, type RouterSource } from './types.js'

export const LEGACY_MIGRATION_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,79}$/
export const LEGACY_MIGRATION_ITEMS_MAX = 500
export const LEGACY_MIGRATION_READ_DEADLINE_MS = 5000
const ID_MAX = 200
const REASON_MAX = 500
export const CONTROL = /[\u0000-\u001f\u007f]/
const CONTROL_BUT_LINES = /[\u0000-\u0008\u000b-\u001f\u007f]/
// A pause or a restore changes these; every other field of the routine must stay as captured.
const WATCHER_VOLATILE = new Set(['state', 'enabled', 'updatedAtMs'])

export const HOST_ADAPTER_NEEDED = 'No host adapter reads or restores this watcher\'s trigger state (cursor, seen set, pending fires) yet. Nothing was changed.'

export type RouterMigrationErrorCode =
  | 'invalid' | 'deadline' | 'not_found' | 'migration_conflict' | 'wrong_phase'
  | 'area_missing' | 'router_unassigned' | 'router_active' | 'router_active_not_ours' | 'router_changed'
  | 'router_task_missing' | 'router_task_mismatch' | 'owner_missing'
  | 'watcher_missing' | 'watcher_changed' | 'watcher_state_unsupported' | 'watcher_pause_unproven' | 'watcher_capture_pending'
  | 'watcher_final_state_missing' | 'watcher_restore_unproven' | 'watcher_seen_expired'
  | 'source_mismatch' | 'source_changed' | 'item_not_current' | 'area_source_missing' | 'item_other_area' | 'item_canonical_differs'
  | 'receipt_mismatch' | 'receipt_missing' | 'items_missing' | 'rule_binding_unverified'
  | 'date_items_unknown' | 'date_reminder_required' | 'router_resume_unproven' | 'router_pause_unproven' | 'routines_unavailable'
  | 'router_work_not_replay_safe' | 'area_route_busy'

export class RouterMigrationError extends Error {
  constructor(readonly code: RouterMigrationErrorCode, message: string, readonly status = 409) {
    super(message)
    this.name = 'RouterMigrationError'
  }
}

export interface LegacyMigrationItem { source: RouterSource; taskId: string; reason: string; evidence: string; at: number }
export interface LegacyRuleBinding { ruleId: string; revision: string }

export interface LegacyMonitorMigration {
  id: string
  areaId: string
  routerTaskId: string
  watcherId: string
  items: LegacyMigrationItem[]
  ruleBindings?: LegacyRuleBinding[]
  // The watcher's date reminders as the person's migration states them; absent reads 'unknown' and is refused at activation.
  dateItems: WatcherDateItems
  byTaskId?: string
}

export type WatcherDateItems = 'none' | 'unknown' | Array<{ id: string; dueAt: number }>
export type WatcherConfig = Record<string, unknown>

// Only for a paused watcher: `complete` = the whole host trigger state, `frozen` = nothing in flight. `lastCheck` is never a cursor.
export type WatcherSnapshot =
  | { supported: true; complete: boolean; frozen: boolean; config: WatcherConfig; state: unknown; seenReliableUntil: number }
  | { supported: false; reason: string }

export interface LegacyReceiptStore {
  recordLegacy(item: RouterItem, receipt: RouterLegacyReceipt): Promise<RouterClaimResult>
  getSources(sources: readonly RouterSource[]): Promise<Map<string, RouterRoute>>
  // Any row that is not a legacy receipt, in any status: work the old watcher's seen set does not know.
  hasRouterDecisions(): Promise<boolean>
}

export type MigrationTask = Pick<Task, 'id' | 'phase' | 'source' | 'org_role' | 'router_area_id' | 'router_paused'>

export interface LegacyMigrationDeps {
  home: string
  now(): number
  deadlineMs?: number
  // How long a rollback waits for the area's route lock (route-lock.ts); default ROUTE_LOCK_WAIT_MS.
  routeLockWaitMs?: number
  readAreas(): Promise<RouterAreasFile>
  updateAreas(change: (file: RouterAreasFile) => RouterAreasFile | Promise<RouterAreasFile>): Promise<RouterAreasFile>
  store(areaId: string): Promise<LegacyReceiptStore>
  resolve(source: RouterSource): Promise<RouterItem>
  current(sources: readonly RouterSource[]): Promise<RouterSource[]>
  getTask(taskId: string): Promise<MigrationTask | null>
  // The routine's definition without its runtime state or audit history; null when it is gone.
  readWatcher(watcherId: string): Promise<WatcherConfig | null>
  snapshotWatcher(watcherId: string): Promise<WatcherSnapshot>
  // Compare-and-set on `cronJobRevision`: pause only while the routine is still exactly that revision.
  // Resolves with the routine's config as that successful write left it (no runtime state); throws when the CAS did not apply.
  pauseWatcher(watcherId: string, expectedRevision: string): Promise<WatcherConfig>
  // Compare-and-set: turn the paused routine back to `backup.config.enabled` only while it is `revision` and its frozen host state still hashes to `stateSha`; never writes old state.
  restoreWatcher(watcherId: string, expected: { revision: string; stateSha: string }, backup: { config: WatcherConfig; state: unknown }): Promise<void>
  // Compare-and-set from paused: resolving means the resume was applied; throwing means it is not known to have been.
  resumeRouter(taskId: string): Promise<void>
  pauseRouter(taskId: string): Promise<void>
  ruleRevision(ruleId: string): Promise<string | undefined>
}

export type LegacyMigrationPhase = 'preparing' | 'prepared' | 'activating' | 'active' | 'rolling_back' | 'rolled_back'
export type ResolvedItem = { source: RouterSource; key: string; canonicalKey: string }

export interface LegacyMigrationRecord {
  version: 1
  id: string
  inputSha: string
  input: LegacyMonitorMigration
  phase: LegacyMigrationPhase
  createdAt: number
  updatedAt: number
  // The routine's exact config at prepare; its host state is captured only once activation has paused it.
  initial: { watcherId: string; config: WatcherConfig; revision: string; configSha: string; enabled: boolean; at: number }
  capture: 'pending' | 'final'
  final?: { state: unknown; stateSha: string; seenReliableUntil: number; at: number }
  resolved?: ResolvedItem[]
  receipts?: Array<{ key: string; fresh: boolean; status: string; taskId?: string; matches: boolean }>
  areasAppliedAt?: number
  watcherPauseRequestedAt?: number
  watcherPausedAt?: number
  pausedRevision?: string
  routerResumeRequestedAt?: number
  routerResumedAt?: number
  routerPausedAt?: number
  watcherRestore?: { at: number; outcome: 'restored' | 'left_as_person_set' | 'never_paused' }
  lastError?: { at: number; code: string; message: string }
}

export interface LegacyMigrationResult { changed: boolean; record: LegacyMigrationRecord }
// Each date item is carried by one of these routines: enabled, a one-shot clock at its exact time, no check or wake.
export interface ActivateOptions { dateReplacement?: { reminderIds: string[] } }

export function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>
    return `{${Object.keys(record).sort().filter((key) => record[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${stable(record[key])}`).join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

export const sha = (value: unknown) => createHash('sha256').update(stable(value)).digest('hex')

export function watcherConfigSha(config: WatcherConfig): string {
  return sha(Object.fromEntries(Object.entries(config).filter(([key]) => !WATCHER_VOLATILE.has(key))))
}

export const sameSource = (a: RouterSource, b: RouterSource) => a.kind === b.kind && a.account === b.account && a.message === b.message
  && (a.version ?? '') === (b.version ?? '')

const invalid = (message: string) => new RouterMigrationError('invalid', message, 400)

function plain(value: unknown, field: string, max: number, pattern = CONTROL): string {
  if (typeof value !== 'string' || value.trim().length === 0) throw invalid(`${field} must be a non-empty string`)
  if (value.length > max) throw invalid(`${field} must be at most ${max} characters`)
  if (pattern.test(value)) throw invalid(`${field} must not contain control characters`)
  return value
}

function normalizeSource(raw: unknown, field: string): RouterSource {
  const value = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  if (!(ROUTER_SOURCE_KINDS as readonly unknown[]).includes(value.kind)) throw invalid(`${field}.kind is not a routing source kind`)
  const source: RouterSource = {
    kind: value.kind as RouterSource['kind'],
    account: plain(value.account, `${field}.account`, 320),
    message: plain(value.message, `${field}.message`, 1000),
    ...(value.version !== undefined ? { version: plain(value.version, `${field}.version`, 200) } : {}),
  }
  if (source.kind === 'mail' && source.version === undefined) throw invalid(`${field} is a mail item without its delivery version`)
  try { routerKey(source) } catch (error) { throw invalid(`${field}: ${(error as Error).message}`) }
  return source
}

export function normalizeLegacyMigration(raw: unknown): LegacyMonitorMigration {
  const value = (raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : null) as Record<string, unknown> | null
  if (!value) throw invalid('A migration is an object')
  const id = plain(value.id, 'id', 80)
  if (!LEGACY_MIGRATION_ID_PATTERN.test(id)) throw invalid('id must be a lowercase slug')
  const areaId = plain(value.areaId, 'areaId', 80)
  if (!ROUTER_AREA_ID_PATTERN.test(areaId)) throw invalid('areaId must be a router area id')
  if (!Array.isArray(value.items) || value.items.length === 0 || value.items.length > LEGACY_MIGRATION_ITEMS_MAX) {
    throw invalid(`items must list 1 to ${LEGACY_MIGRATION_ITEMS_MAX} historical items`)
  }
  const items = value.items.map((one, index): LegacyMigrationItem => {
    const item = (one && typeof one === 'object' ? one : {}) as Record<string, unknown>
    const field = `items[${index}]`
    if (typeof item.at !== 'number' || !Number.isFinite(item.at) || item.at < 0) throw invalid(`${field}.at must be a time`)
    return {
      source: normalizeSource(item.source, `${field}.source`),
      taskId: plain(item.taskId, `${field}.taskId`, ID_MAX),
      reason: plain(item.reason, `${field}.reason`, REASON_MAX),
      evidence: plain(item.evidence, `${field}.evidence`, ROUTER_EVIDENCE_MAX, CONTROL_BUT_LINES),
      at: Math.trunc(item.at),
    }
  })
  items.forEach((item, index) => {
    if (items.findIndex((other) => sameSource(other.source, item.source)) !== index) throw invalid(`items[${index}] repeats an item`)
  })
  let ruleBindings: LegacyRuleBinding[] | undefined
  if (value.ruleBindings !== undefined) {
    if (!Array.isArray(value.ruleBindings)) throw invalid('ruleBindings must be a list')
    ruleBindings = value.ruleBindings.map((one, index) => {
      const binding = (one && typeof one === 'object' ? one : {}) as Record<string, unknown>
      if (typeof binding.ruleId !== 'string' || !ROUTER_RULE_ID_PATTERN.test(binding.ruleId)
        || typeof binding.revision !== 'string' || !ROUTER_RULE_REVISION_PATTERN.test(binding.revision)) {
        throw invalid(`ruleBindings[${index}] names a rule id and its revision`)
      }
      return { ruleId: binding.ruleId, revision: binding.revision }
    })
    if (new Set(ruleBindings.map((one) => one.ruleId)).size !== ruleBindings.length) throw invalid('ruleBindings repeats a rule')
  }
  const dateItems = normalizeDateItems(value.dateItems)
  return {
    id, areaId, dateItems,
    routerTaskId: plain(value.routerTaskId, 'routerTaskId', ID_MAX),
    watcherId: plain(value.watcherId, 'watcherId', ID_MAX),
    items,
    ...(ruleBindings ? { ruleBindings } : {}),
    ...(value.byTaskId !== undefined ? { byTaskId: plain(value.byTaskId, 'byTaskId', ID_MAX) } : {}),
  }
}

export function legacyMigrationPath(home: string, id: string): string {
  if (typeof home !== 'string' || !path.isAbsolute(home)) throw invalid('The Walnut home must be an absolute path')
  if (!LEGACY_MIGRATION_ID_PATTERN.test(id)) throw invalid('id must be a lowercase slug')
  return path.join(path.resolve(home), 'router', 'migrations', `${id}.json`)
}

export function routerPausedArea(file: RouterAreasFile, spec: LegacyMonitorMigration): RouterArea {
  const area = file.areas.find((one) => one.id === spec.areaId)
  if (!area) throw new RouterMigrationError('area_missing', `Area ${spec.areaId} does not exist.`)
  const assignment = file.routers.find((one) => one.taskId === spec.routerTaskId)
  if (!assignment || assignment.areaId !== spec.areaId || !area.taskIds.includes(spec.routerTaskId)) {
    throw new RouterMigrationError('router_unassigned', `Task ${spec.routerTaskId} is not the router of area ${spec.areaId}.`)
  }
  const active = activeRouter(file, spec.areaId)
  if (!assignment.paused || active) {
    throw new RouterMigrationError('router_active', `Area ${spec.areaId} has an active router (${active?.taskId ?? spec.routerTaskId}); pause it first.`)
  }
  return area
}

export function assertNoAreaConflict(file: RouterAreasFile, area: RouterArea, resolved: readonly ResolvedItem[]): void {
  for (const one of resolved) {
    if (!area.sources.some((source) => source.kind === one.source.kind && source.account === one.source.account)) {
      throw new RouterMigrationError('area_source_missing', `Area ${area.id} has no ${one.source.kind} source for this item's account; a migration never widens an area.`)
    }
    for (const item of allAreaItems(file)) {
      if (sameSource(item.source, one.source)) {
        if (item.areaId !== area.id) throw new RouterMigrationError('item_other_area', `A ${one.source.kind} item already belongs to area ${item.areaId}.`)
        if (item.canonicalKey !== one.canonicalKey) {
          throw new RouterMigrationError('item_canonical_differs', `A ${one.source.kind} item is already in area ${area.id} under another canonical identity.`)
        }
      } else if (item.areaId !== area.id && item.source.kind === one.source.kind && item.source.account === one.source.account
        && (item.canonicalKey === one.canonicalKey || item.source.message === one.source.message)) {
        throw new RouterMigrationError('item_other_area', `A copy of a ${one.source.kind} item already belongs to area ${item.areaId}.`)
      }
    }
  }
}

export function assertItemsAssigned(file: RouterAreasFile, spec: LegacyMonitorMigration, resolved: readonly ResolvedItem[]): void {
  const missing = resolved.filter((one) => !file.items.some((item) => sameSource(item.source, one.source)
    && item.areaId === spec.areaId && item.canonicalKey === one.canonicalKey))
  if (missing.length) throw new RouterMigrationError('items_missing', `${missing.length} migrated items are no longer in area ${spec.areaId} as prepared.`)
}

export function validResolved(resolved: readonly ResolvedItem[]): boolean {
  return resolved.every((one) => one.canonicalKey.length > 0 && one.canonicalKey.length <= ROUTER_CANONICAL_KEY_MAX && !CONTROL.test(one.canonicalKey))
}

function normalizeDateItems(value: unknown): WatcherDateItems {
  if (value === undefined || value === 'unknown') return 'unknown'
  if (value === 'none') return 'none'
  if (!Array.isArray(value) || value.length > LEGACY_MIGRATION_ITEMS_MAX) throw invalid('dateItems must be none, unknown or a list of dated items')
  return value.map((one, index) => {
    const item = (one && typeof one === 'object' ? one : {}) as Record<string, unknown>
    if (typeof item.dueAt !== 'number' || !Number.isFinite(item.dueAt)) throw invalid(`dateItems[${index}].dueAt must be a time`)
    return { id: plain(item.id, `dateItems[${index}].id`, ID_MAX), dueAt: item.dueAt }
  })
}

/** Null when every date item has exactly one replacement reminder at its exact time, else why not. */
export function dateReplacementGap(dates: WatcherDateItems, watcherId: string, reminders: ReadonlyArray<{ id: string; config: WatcherConfig | null }>): string | null {
  if (dates === 'unknown') return 'It is not known whether this watcher also keeps date reminders.'
  if (dates === 'none' || dates.length === 0) return null
  if (reminders.length === 0) return `This watcher keeps ${dates.length} date reminders; name the date-only reminders that carry them.`
  if (new Set(reminders.map((one) => one.id)).size !== reminders.length) return 'A replacement reminder is named twice.'
  const times: number[] = []
  for (const { id, config } of reminders) {
    if (id === watcherId) return 'The watcher being paused cannot be its own replacement.'
    if (!config || config.enabled !== true) return `Replacement reminder ${id} does not exist or is off.`
    if (config.check !== undefined || config.wake !== undefined) return `Replacement reminder ${id} polls or counts events; it must be a date-only reminder.`
    const schedule = config.schedule as { kind?: unknown; at?: unknown } | undefined
    const at = schedule?.kind === 'at' && typeof schedule.at === 'string' ? Date.parse(schedule.at) : NaN
    if (!Number.isFinite(at)) return `Replacement reminder ${id} is not a one-shot reminder at a set time.`
    times.push(at)
  }
  const want = dates.map((one) => one.dueAt).sort((a, b) => a - b)
  times.sort((a, b) => a - b)
  if (stable(want) !== stable(times)) return 'The replacement reminders do not fire at exactly the watcher\'s date items.'
  return null
}
