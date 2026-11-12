// Moves a legacy watcher's work to its area router: prepare (receipts, then area items), activate (CAS pause, frozen capture, router), rollback (router, then CAS re-enable).
import { WALNUT_HOME } from '../../constants.js'
import { withFileLock } from '../../utils/file-lock.js'
import { readJsonFile, writeJsonFile } from '../../utils/fs.js'
import { cronJobRevision } from '../cron/job-revision.js'
import { activeRouter, readRouterAreas, updateRouterAreas } from './areas.js'
import {
  HOST_ADAPTER_NEEDED, LEGACY_MIGRATION_READ_DEADLINE_MS, RouterMigrationError, assertItemsAssigned, assertNoAreaConflict,
  dateReplacementGap, legacyMigrationPath, normalizeLegacyMigration, routerPausedArea, sameSource, sha, stable, validResolved, watcherConfigSha,
  type ActivateOptions, type LegacyMigrationDeps, type LegacyMigrationRecord, type LegacyMigrationResult, type LegacyMonitorMigration,
  type LegacyReceiptStore, type ResolvedItem, type WatcherConfig, type WatcherSnapshot,
} from './migration-model.js'
import { RouteLockBusyError, withAreaRouteLock } from './route-lock.js'
import { routerKey } from './store.js'
import type { RouterItem } from './types.js'

export * from './migration-model.js'

const LOCK_WAIT_MS = 10_000

async function within<T>(deps: LegacyMigrationDeps, label: string, work: () => Promise<T>): Promise<T> {
  const ms = deps.deadlineMs ?? LEGACY_MIGRATION_READ_DEADLINE_MS
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      work(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new RouterMigrationError('deadline', `${label} did not answer within ${ms} ms. Nothing further was changed.`, 504)), ms)
      }),
    ])
  } finally { if (timer) clearTimeout(timer) }
}

async function checkRouterTask(deps: LegacyMigrationDeps, spec: LegacyMonitorMigration): Promise<void> {
  const task = await within(deps, 'The router task', () => deps.getTask(spec.routerTaskId))
  if (!task) throw new RouterMigrationError('router_task_missing', `Router task ${spec.routerTaskId} does not exist.`)
  if (task.org_role !== 'router' || task.router_area_id !== spec.areaId || task.source !== 'local' || task.phase === 'COMPLETE') {
    throw new RouterMigrationError('router_task_mismatch', `Task ${spec.routerTaskId} is not an open local router of area ${spec.areaId}.`)
  }
  if (task.router_paused === false) throw new RouterMigrationError('router_active', `Router ${spec.routerTaskId} is running; pause it first.`)
}

async function proveReceipts(deps: LegacyMigrationDeps, store: LegacyReceiptStore, resolved: readonly ResolvedItem[]): Promise<void> {
  const rows = await within(deps, 'The router ledger', () => store.getSources(resolved.map((one) => ({ ...one.source }))))
  const missing = resolved.filter((one) => rows.get(routerKey(one.source))?.key !== one.key)
  if (missing.length) throw new RouterMigrationError('receipt_missing', `${missing.length} migrated items have no ledger receipt.`)
}

async function readWatcherOrFail(deps: LegacyMigrationDeps, watcherId: string): Promise<WatcherConfig> {
  const config = await within(deps, 'The watcher routine', () => deps.readWatcher(watcherId))
  if (!config) throw new RouterMigrationError('watcher_missing', `Watcher ${watcherId} does not exist; it is never recreated.`)
  return config
}

function assertSameConfig(config: WatcherConfig, record: LegacyMigrationRecord): void {
  if (watcherConfigSha(config) !== record.initial.configSha) {
    throw new RouterMigrationError('watcher_changed', `Watcher ${record.initial.watcherId} was changed since it was captured; it is left as it is.`)
  }
}

async function dateGap(deps: LegacyMigrationDeps, record: LegacyMigrationRecord, opts: ActivateOptions): Promise<void> {
  const dates = record.input.dateItems
  const ids = opts.dateReplacement?.reminderIds ?? []
  if (!Array.isArray(ids) || ids.some((id) => typeof id !== 'string' || !id)) throw new RouterMigrationError('invalid', 'reminderIds must name routines', 400)
  const reminders = []
  for (const id of ids) reminders.push({ id, config: await within(deps, 'A replacement reminder', () => deps.readWatcher(id)) })
  const gap = dateReplacementGap(dates, record.initial.watcherId, reminders)
  if (gap) throw new RouterMigrationError(dates === 'unknown' ? 'date_items_unknown' : 'date_reminder_required', `${gap} The watcher is not paused for it.`)
}

interface Session { load(): Promise<LegacyMigrationRecord | null>; save(record: LegacyMigrationRecord): Promise<void> }

async function underLock<T>(deps: LegacyMigrationDeps, id: string, work: (session: Session) => Promise<T>): Promise<T> {
  const file = legacyMigrationPath(deps.home, id)
  return withFileLock(file, () => work({
    async load() {
      const raw = await readJsonFile<LegacyMigrationRecord | null>(file, null, { readErrors: 'throw' })
      if (raw === null) return null
      if (raw.version !== 1 || raw.id !== id) throw new RouterMigrationError('migration_conflict', `Migration file ${id} is not a record this Walnut reads.`)
      return raw
    },
    async save(record) {
      record.updatedAt = deps.now()
      await writeJsonFile(file, record, { durable: true, mode: 0o600 })
    },
  }), { timeoutMs: LOCK_WAIT_MS })
}

async function noting<T>(session: Session, record: LegacyMigrationRecord, deps: LegacyMigrationDeps, work: () => Promise<T>): Promise<T> {
  try {
    return await work()
  } catch (error) {
    record.lastError = { at: deps.now(), code: (error as { code?: string })?.code ?? 'error', message: error instanceof Error ? error.message : String(error) }
    await session.save(record).catch(() => undefined)
    throw error
  }
}

async function loadMatching(session: Session, spec: LegacyMonitorMigration, inputSha: string): Promise<LegacyMigrationRecord> {
  const record = await session.load()
  if (!record) throw new RouterMigrationError('not_found', `Migration ${spec.id} was not prepared.`, 404)
  if (record.inputSha !== inputSha) throw new RouterMigrationError('migration_conflict', `Migration ${spec.id} was prepared with other input.`)
  return record
}

function initialRecord(spec: LegacyMonitorMigration, inputSha: string, config: WatcherConfig, now: number): LegacyMigrationRecord {
  if (typeof config.enabled !== 'boolean') throw new RouterMigrationError('watcher_changed', `Watcher ${spec.watcherId} has no on or off state to restore.`)
  return {
    version: 1, id: spec.id, inputSha, input: spec, phase: 'preparing', createdAt: now, updatedAt: now,
    initial: {
      watcherId: spec.watcherId, config: structuredClone(config), revision: cronJobRevision(config),
      configSha: watcherConfigSha(config), enabled: config.enabled, at: now,
    },
    capture: 'pending',
  }
}

async function prepare(spec: LegacyMonitorMigration, inputSha: string, deps: LegacyMigrationDeps): Promise<LegacyMigrationResult> {
  return underLock(deps, spec.id, async (session) => {
    let record = await session.load()
    if (record && record.inputSha !== inputSha) throw new RouterMigrationError('migration_conflict', `Migration ${spec.id} was prepared with other input.`)
    if (record && record.phase !== 'preparing') return { changed: false, record }
    const areas = await within(deps, 'The router areas', () => deps.readAreas())
    const area = routerPausedArea(areas, spec)
    await checkRouterTask(deps, spec)
    for (const taskId of new Set(spec.items.map((item) => item.taskId))) {
      if (!await within(deps, 'A legacy owner task', () => deps.getTask(taskId))) {
        throw new RouterMigrationError('owner_missing', `Task ${taskId}, a legacy owner, does not exist.`)
      }
    }
    const config = await readWatcherOrFail(deps, spec.watcherId)
    // The host state is not read here: it is captured frozen only after activation pauses the watcher.
    if (!record) {
      record = initialRecord(spec, inputSha, config, deps.now())
    } else {
      assertSameConfig(config, record)
    }
    const held = record
    return noting(session, held, deps, async () => {
      const items: RouterItem[] = []
      for (const input of spec.items) {
        const item = await within(deps, 'The source cache', () => deps.resolve({ ...input.source }))
        if (!item || !sameSource(item.source, input.source) || typeof item.key !== 'string' || !item.key) {
          throw new RouterMigrationError('source_mismatch', `The cache answered for another ${input.source.kind} item than the one asked.`)
        }
        items.push(item)
      }
      const resolved = items.map((item): ResolvedItem => ({ source: { ...item.source }, key: item.key, canonicalKey: item.scopeKey ?? item.key }))
      if (!validResolved(resolved)) throw new RouterMigrationError('source_mismatch', 'The cache gave an unusable canonical identity.')
      if (held.resolved && stable(held.resolved) !== stable(resolved)) {
        throw new RouterMigrationError('source_changed', 'An item resolves differently than when this migration started; start a new migration.')
      }
      const current = await within(deps, 'The source current check', () => deps.current(resolved.map((one) => ({ ...one.source }))))
      const stale = resolved.filter((one) => !current.some((source) => sameSource(source, one.source)))
      if (stale.length) throw new RouterMigrationError('item_not_current', `${stale.length} items are no longer the current delivery in the cache.`)
      assertNoAreaConflict(areas, area, resolved)
      held.resolved = resolved
      await session.save(held)

      // Receipts before area items: an item in the area with no ledger row wakes the router and replays.
      const store = await deps.store(spec.areaId)
      const receipts: NonNullable<LegacyMigrationRecord['receipts']> = []
      for (const [index, input] of spec.items.entries()) {
        const result = await store.recordLegacy(items[index]!, {
          taskId: input.taskId, reason: input.reason, evidence: input.evidence, at: input.at, ...(spec.byTaskId ? { byTaskId: spec.byTaskId } : {}),
        })
        const route = result?.route
        if (!route || route.key !== resolved[index]!.key || !sameSource(route.source, input.source) || (result.fresh && route.taskId !== input.taskId)) {
          throw new RouterMigrationError('receipt_mismatch', 'The ledger answered with another row than the receipt asked for.')
        }
        receipts.push({ key: route.key, fresh: result.fresh, status: route.status, ...(route.taskId ? { taskId: route.taskId } : {}), matches: route.taskId === input.taskId })
      }
      await proveReceipts(deps, store, resolved)
      held.receipts = receipts
      await session.save(held)

      await deps.updateAreas((file) => {
        const live = routerPausedArea(file, spec)
        assertNoAreaConflict(file, live, resolved)
        for (const one of resolved) {
          // A bound mailbox's open arrival the migration claims becomes a confirmed (restricted) item.
          if (file.openItems?.some((item) => sameSource(item.source, one.source) && item.areaId === spec.areaId)) {
            file.openItems = file.openItems.filter((item) => !sameSource(item.source, one.source))
            if (file.openItems.length === 0) delete file.openItems
          }
          if (!file.items.some((item) => sameSource(item.source, one.source))) {
            file.items.push({ source: { ...one.source }, areaId: spec.areaId, canonicalKey: one.canonicalKey })
          }
        }
        return file
      })
      assertItemsAssigned(await within(deps, 'The router areas', () => deps.readAreas()), spec, resolved)
      held.areasAppliedAt = deps.now()
      held.phase = 'prepared'
      delete held.lastError
      await session.save(held)
      return { changed: true, record: held }
    })
  })
}

async function pauseAndCapture(spec: LegacyMonitorMigration, record: LegacyMigrationRecord, session: Session, deps: LegacyMigrationDeps): Promise<void> {
  const before = await readWatcherOrFail(deps, spec.watcherId)
  assertSameConfig(before, record)
  if (record.watcherPausedAt === undefined) {
    // A pause asked for but never proven may be anyone's: it is never taken as this migration's.
    if (before.enabled === false && record.watcherPauseRequestedAt !== undefined) {
      throw new RouterMigrationError('watcher_pause_unproven', `Watcher ${spec.watcherId} is off, but this migration never proved it paused it; it is left as it is.`)
    }
    if (before.enabled === false && record.initial.enabled) {
      throw new RouterMigrationError('watcher_changed', `Watcher ${spec.watcherId} was paused by someone else since it was captured; it is left as it is.`)
    }
    if (before.enabled !== false) {
      if (cronJobRevision(before) !== record.initial.revision) {
        throw new RouterMigrationError('watcher_changed', `Watcher ${spec.watcherId} is not the routine that was captured; it is left as it is.`)
      }
      record.watcherPauseRequestedAt ??= deps.now()
      await session.save(record)
    }
    // The proof is the config the successful compare-and-set returned, so a read failing afterwards cannot strand the pause.
    const after = before.enabled !== false ? await deps.pauseWatcher(spec.watcherId, record.initial.revision) : before
    if (!after || after.enabled !== false || watcherConfigSha(after) !== record.initial.configSha) {
      throw new RouterMigrationError('watcher_pause_unproven', `Watcher ${spec.watcherId} does not read back paused; the router was not started.`)
    }
    record.watcherPausedAt = deps.now()
    record.pausedRevision = cronJobRevision(after)
    await session.save(record)
  } else if (cronJobRevision(before) !== record.pausedRevision) {
    throw new RouterMigrationError('watcher_changed', `Watcher ${spec.watcherId} was turned back on or edited after this migration paused it; it is left as it is.`)
  }
  if (record.capture === 'final') return
  record.capture = 'pending'
  await session.save(record)
  const snapshot = await within(deps, 'The watcher host state', () => deps.snapshotWatcher(spec.watcherId))
  if (!snapshot.supported || snapshot.complete !== true || snapshot.frozen !== true || snapshot.config.enabled !== false
    || cronJobRevision(snapshot.config) !== record.pausedRevision || snapshot.state === undefined || snapshot.state === null
    || !Number.isFinite(snapshot.seenReliableUntil)) {
    throw new RouterMigrationError('watcher_capture_pending', `Watcher ${spec.watcherId} is paused but its complete frozen state could not be captured; the router was not started. Retry the activation.`, 503)
  }
  record.final = { state: structuredClone(snapshot.state), stateSha: sha(snapshot.state), seenReliableUntil: snapshot.seenReliableUntil, at: deps.now() }
  record.capture = 'final'
  await session.save(record)
}

async function activate(spec: LegacyMonitorMigration, inputSha: string, opts: ActivateOptions, deps: LegacyMigrationDeps): Promise<LegacyMigrationResult> {
  return underLock(deps, spec.id, async (session) => {
    const record = await loadMatching(session, spec, inputSha)
    if (record.phase === 'active') return { changed: false, record }
    if (record.phase !== 'prepared' && record.phase !== 'activating') {
      throw new RouterMigrationError('wrong_phase', `Migration ${spec.id} is ${record.phase}; only a prepared one is activated.`)
    }
    return noting(session, record, deps, async () => {
      // The resume was proven by its compare-and-set; only its read-back is left.
      if (record.routerResumedAt !== undefined) return await confirmResumed(spec, record, session, deps)
      const resolved = record.resolved ?? []
      const areas = await within(deps, 'The router areas', () => deps.readAreas())
      if (record.routerResumeRequestedAt !== undefined && activeRouter(areas, spec.areaId)) {
        throw new RouterMigrationError('router_active_not_ours', `Router ${spec.routerTaskId} is running, but this migration never proved it started it; it is left as it is.`)
      }
      routerPausedArea(areas, spec)
      await checkRouterTask(deps, spec)
      assertItemsAssigned(areas, spec, resolved)
      for (const binding of spec.ruleBindings ?? []) {
        const saved = (areas.ruleBindings ?? []).find((one) => one.ruleId === binding.ruleId)
        const live = await within(deps, 'The routing rules', () => deps.ruleRevision(binding.ruleId))
        if (!saved || saved.areaId !== spec.areaId || saved.revision !== binding.revision || live !== binding.revision) {
          throw new RouterMigrationError('rule_binding_unverified', `Rule ${binding.ruleId} is not confirmed for area ${spec.areaId} at its current revision.`)
        }
      }
      await dateGap(deps, record, opts)
      await proveReceipts(deps, await deps.store(spec.areaId), resolved)
      record.phase = 'activating'
      await session.save(record)

      await pauseAndCapture(spec, record, session, deps)
      record.routerResumeRequestedAt ??= deps.now()
      await session.save(record)
      await deps.resumeRouter(spec.routerTaskId)
      // Saved before any read: from here a rollback treats the router as this migration's to pause.
      record.routerResumedAt = deps.now()
      await session.save(record)
      return await confirmResumed(spec, record, session, deps)
    })
  })
}

async function confirmResumed(spec: LegacyMonitorMigration, record: LegacyMigrationRecord, session: Session, deps: LegacyMigrationDeps): Promise<LegacyMigrationResult> {
  if (activeRouter(await within(deps, 'The router areas', () => deps.readAreas()), spec.areaId)?.taskId !== spec.routerTaskId) {
    throw new RouterMigrationError('router_resume_unproven', `Router ${spec.routerTaskId} was started but does not read back active; it is not started again. Retry the activation or roll back.`)
  }
  const task = await within(deps, 'The router task', () => deps.getTask(spec.routerTaskId))
  if (!task || task.org_role !== 'router' || task.router_area_id !== spec.areaId || task.source !== 'local' || task.phase === 'COMPLETE' || task.router_paused !== false) {
    throw new RouterMigrationError('router_task_mismatch', `Task ${spec.routerTaskId} is not an active open local router of area ${spec.areaId}.`)
  }
  // Active only while the watcher is still the one this migration paused and captured.
  const watcher = await readWatcherOrFail(deps, spec.watcherId)
  assertSameConfig(watcher, record)
  if (watcher.enabled !== false || record.capture !== 'final' || !record.final || cronJobRevision(watcher) !== record.pausedRevision) {
    throw new RouterMigrationError('watcher_changed', `Watcher ${spec.watcherId} is no longer paused as this migration captured it; the activation is not finished.`)
  }
  record.phase = 'active'
  delete record.lastError
  await session.save(record)
  return { changed: true, record }
}

async function refuseRouterWork(deps: LegacyMigrationDeps, ledger: LegacyReceiptStore, spec: LegacyMonitorMigration, routerPaused: boolean): Promise<void> {
  if (!await within(deps, 'The router ledger', () => ledger.hasRouterDecisions())) return
  throw new RouterMigrationError('router_work_not_replay_safe', `Area ${spec.areaId}'s ledger holds routing decisions the router made (rows that are not legacy receipts, in any status); `
    + `turned back on, watcher ${spec.watcherId} would handle those items again. The watcher stays paused${routerPaused ? ', and so does the router' : ' and the router is left as it is'}. `
    + 'Before the watcher can be turned back on, that new handling must be moved into the watcher\'s own dedup state; Walnut does not import it.')
}

async function rollback(spec: LegacyMonitorMigration, inputSha: string, deps: LegacyMigrationDeps): Promise<LegacyMigrationResult> {
  return underLock(deps, spec.id, async (session) => {
    const record = await loadMatching(session, spec, inputSha)
    if (record.phase === 'rolled_back') return { changed: false, record }
    return noting(session, record, deps, async () => {
      try {
        // Held from the first ledger check to the restore: a route already in its claim finishes first, and a later one reads the router paused.
        return await withAreaRouteLock(deps.home, spec.areaId, () => rollbackLocked(spec, record, session, deps), { timeoutMs: deps.routeLockWaitMs })
      } catch (error) {
        if (error instanceof RouteLockBusyError) throw new RouterMigrationError('area_route_busy', `${error.message} The router and the watcher are left as they are.`, 503)
        throw error
      }
    })
  })
}

async function rollbackLocked(spec: LegacyMonitorMigration, record: LegacyMigrationRecord, session: Session, deps: LegacyMigrationDeps): Promise<LegacyMigrationResult> {
  // Refused before any change: an unproven pause is not ours to undo, and a pause with no frozen capture can still retry it.
  const touched = record.watcherPausedAt !== undefined || record.watcherPauseRequestedAt !== undefined
  const watcherOff = touched && (await readWatcherOrFail(deps, spec.watcherId)).enabled === false
  if (record.watcherPausedAt === undefined && record.watcherPauseRequestedAt !== undefined && watcherOff) {
    throw new RouterMigrationError('watcher_pause_unproven', `Watcher ${spec.watcherId} is off, but this migration never proved it paused it; it is left as it is.`)
  }
  if (record.watcherPausedAt !== undefined && !record.final && watcherOff) {
    throw new RouterMigrationError('watcher_final_state_missing', `Watcher ${spec.watcherId} was paused before its frozen state was captured; it stays paused rather than run on an older state. Retry the activation.`)
  }
  const active = activeRouter(await within(deps, 'The router areas', () => deps.readAreas()), spec.areaId)
  if (active && active.taskId !== spec.routerTaskId) {
    throw new RouterMigrationError('router_changed', `Area ${spec.areaId} now runs router ${active.taskId}; it is left as it is.`)
  }
  // Only a resume this migration saved as proven is its own to pause.
  if (active && record.routerResumedAt === undefined) {
    throw new RouterMigrationError('router_active_not_ours', `Router ${spec.routerTaskId} was not proven started by this migration; it and the watcher are left as they are.`)
  }
  // A router that may have run (its resume asked for, proven or not) may have handled items the watcher never saw.
  const ledger = record.routerResumeRequestedAt !== undefined || record.routerResumedAt !== undefined ? await deps.store(spec.areaId) : undefined
  if (ledger) await refuseRouterWork(deps, ledger, spec, !active)
  record.phase = 'rolling_back'
  await session.save(record)
  if (active) {
    await deps.pauseRouter(spec.routerTaskId)
    if (activeRouter(await within(deps, 'The router areas', () => deps.readAreas()), spec.areaId)) {
      throw new RouterMigrationError('router_pause_unproven', `Router ${spec.routerTaskId} does not read back paused; the watcher was not turned back on.`)
    }
    record.routerPausedAt = deps.now()
    await session.save(record)
  }
  // Again with the router paused: a decision that landed after the first look keeps both paused.
  if (ledger) await refuseRouterWork(deps, ledger, spec, true)
  await restoreWatcher(record, deps)
  record.phase = 'rolled_back'
  delete record.lastError
  await session.save(record)
  return { changed: true, record }
}

async function restoreWatcher(record: LegacyMigrationRecord, deps: LegacyMigrationDeps): Promise<void> {
  const { watcherId } = record.initial
  const now = await readWatcherOrFail(deps, watcherId)
  if (record.watcherPausedAt === undefined) {
    record.watcherRestore = { at: deps.now(), outcome: 'never_paused' }
    return
  }
  assertSameConfig(now, record)
  if (now.enabled !== false) {
    record.watcherRestore = { at: deps.now(), outcome: 'left_as_person_set' }
    return
  }
  if (!record.final || record.pausedRevision === undefined) {
    throw new RouterMigrationError('watcher_final_state_missing', `Watcher ${watcherId} was paused before its frozen state was captured; it stays paused rather than run on an older state.`)
  }
  if (cronJobRevision(now) !== record.pausedRevision) {
    throw new RouterMigrationError('watcher_changed', `Watcher ${watcherId} was edited while paused; it is left as it is.`)
  }
  if (deps.now() > record.final.seenReliableUntil) {
    throw new RouterMigrationError('watcher_seen_expired', `Watcher ${watcherId}'s seen set has aged past what its host keeps; turned on, it would act on old items again. It stays paused.`)
  }
  await deps.restoreWatcher(watcherId, { revision: record.pausedRevision, stateSha: record.final.stateSha },
    { config: structuredClone(record.initial.config), state: structuredClone(record.final.state) })
  if (cronJobRevision(await readWatcherOrFail(deps, watcherId)) !== record.initial.revision) {
    throw new RouterMigrationError('watcher_restore_unproven', `Watcher ${watcherId} does not read back as captured.`)
  }
  record.watcherRestore = { at: deps.now(), outcome: 'restored' }
}

export interface LegacyMonitorMigrationHandle {
  readonly id: string
  prepare(): Promise<LegacyMigrationResult>
  activate(opts?: ActivateOptions): Promise<LegacyMigrationResult>
  rollback(): Promise<LegacyMigrationResult>
  read(): Promise<LegacyMigrationRecord | null>
}

export function migrateLegacyMonitor(input: unknown, deps: LegacyMigrationDeps = defaultLegacyMigrationDeps()): LegacyMonitorMigrationHandle {
  const spec = normalizeLegacyMigration(input)
  const inputSha = sha(spec)
  return {
    id: spec.id,
    prepare: () => prepare(spec, inputSha, deps),
    activate: (opts = {}) => activate(spec, inputSha, opts, deps),
    rollback: () => rollback(spec, inputSha, deps),
    read: () => underLock(deps, spec.id, (session) => session.load()),
  }
}

// Restore only re-enables by CAS after the complete paused host state still matches.
export function defaultLegacyMigrationDeps(home: string = WALNUT_HOME, host: { snapshotWatcher?: LegacyMigrationDeps['snapshotWatcher'] } = {}): LegacyMigrationDeps {
  const ownHome = () => {
    if (home !== WALNUT_HOME) throw new RouterMigrationError('invalid', 'The migration must use this server\'s own data home.', 400)
  }
  const snapshotWatcher = host.snapshotWatcher ?? (async (id): Promise<WatcherSnapshot> => (await import('./migration-host.js')).snapshotLegacyWatcher(id, home))
  // Resolves with the routine as the successful compare-and-set wrote it, without its runtime state.
  const patch = async (id: string, enabled: boolean, expectedRevision: string): Promise<WatcherConfig> => {
    ownHome()
    const { patchRoutine } = await import('../routines/routines-core.js')
    const { job } = await patchRoutine(id, { enabled }, undefined, { expectedRevision })
    if (!job || typeof job !== 'object') throw new RouterMigrationError('watcher_pause_unproven', `Watcher ${id} answered its change with no routine.`)
    const { state: _state, ...config } = job as Record<string, unknown>
    return structuredClone(config) as WatcherConfig
  }
  return {
    home,
    now: () => Date.now(),
    readAreas: () => readRouterAreas(home),
    updateAreas: (change) => updateRouterAreas(home, change),
    async store(areaId) { return (await import('./runtime.js')).routerStore(areaId, home) },
    async resolve(source) { return (await import('./source-registry.js')).resolveRouterItem(source) },
    async current(sources) { return (await import('./source-registry.js')).currentRouterSources(sources) },
    async getTask(taskId) {
      ownHome()
      const { getTask } = await import('../task-manager.js')
      return await getTask(taskId).catch(() => null)
    },
    async readWatcher(watcherId) {
      ownHome()
      const { getCronService } = await import('../../web/routes/cron.js')
      const service = getCronService()
      if (!service) throw new RouterMigrationError('routines_unavailable', 'The routines engine is not running here.', 503)
      const job = (await service.list({ includeDisabled: true, recompute: false })).find((one) => one.id === watcherId)
      if (!job) return null
      const { state: _state, ...config } = job
      return structuredClone(config) as WatcherConfig
    },
    snapshotWatcher,
    async pauseWatcher(watcherId, expectedRevision) {
      ownHome()
      if (!host.snapshotWatcher) await (await import('./migration-host.js')).ensureLegacySnapshotHost(watcherId, home)
      return await patch(watcherId, false, expectedRevision)
    },
    async restoreWatcher(watcherId, expected, backup) {
      const snapshot = await snapshotWatcher(watcherId)
      if (!snapshot.supported) throw new RouterMigrationError('watcher_state_unsupported', snapshot.reason || HOST_ADAPTER_NEEDED, 501)
      if (snapshot.complete !== true || snapshot.frozen !== true
        || cronJobRevision(snapshot.config) !== expected.revision || sha(snapshot.state) !== expected.stateSha) {
        throw new RouterMigrationError('watcher_restore_unproven', 'The watcher host state moved since it was captured; it stays paused.')
      }
      await patch(watcherId, backup.config.enabled === true, expected.revision)
    },
    async resumeRouter(taskId) { ownHome(); await (await import('./nodes.js')).updateRouterNode(taskId, { paused: false }, { expectedPaused: true }) },
    async pauseRouter(taskId) { ownHome(); await (await import('./nodes.js')).updateRouterNode(taskId, { paused: true }, { expectedPaused: false }) },
    async ruleRevision(ruleId) {
      const [{ readRoutingRules }, { routerRuleRevision }] = await Promise.all([import('../triage/routing-rules.js'), import('./rules.js')])
      const rule = (await readRoutingRules(home)).find((one) => one.id === ruleId)
      return rule ? routerRuleRevision(rule) : undefined
    },
  }
}
