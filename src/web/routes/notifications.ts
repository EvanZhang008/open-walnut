/**
 * Notification center routes — the durable feed behind the bell icon.
 *
 * Backs the persistent feed + unread badge in NotificationPanel. Realtime toasts
 * still arrive over WebSocket (`cron:notification`, and `notification:new` /
 * `notification:updated` — a permission toast now rides the notification frame
 * carrying the durable record, not the raw `session:permission-request`);
 * this endpoint is the on-load snapshot + the read/dismiss mutators so the feed
 * and unread count survive a refresh. Store lives in core/notifications/store.ts.
 */

import { randomUUID } from 'node:crypto'
import { Router, type Request, type Response, type NextFunction } from 'express'
import {
  listNotifications, markRead, dismissNotifications, findNotification, attachNotificationFix,
  type NotificationRecord,
} from '../../core/notifications/store.js'
import { stripEntityRefs } from '../../utils/entity-refs.js'
import { CLOUD_MODE, LOG_DIR, WALNUT_HOME, WALNUT_PACKAGE_ROOT, WALNUT_REPO_URL } from '../../constants.js'
import { ensureWalnutSource, WalnutSourceError } from '../../core/self-repair/walnut-source.js'
import { buildNotificationFixMessage, fixTaskTitle } from '../../core/self-repair/fix-briefing.js'
import {
  currentHostFailures, hostFixRecord, HostFixError, HOST_FIX_INSTRUCTIONS,
  currentSystemFailure, systemFixRecord, SYSTEM_FIX_INSTRUCTIONS,
} from '../../core/self-repair/host-fix-record.js'
import { quickStartSession, QuickStartError } from '../../core/sessions/quick-start.js'
import { listTasksByIds } from '../../core/task-manager.js'
import { getVersion } from '../../core/version.js'
import { broadcastEvent } from '../ws/handler.js'
import { log } from '../../logging/index.js'

export const notificationsRouter = Router()

/**
 * Read-time bound on feed bodies. Keep in sync with MAX_FEED_BODY_CHARS in
 * web/src/contexts/notifications/types.ts (applied to live WS entries) so an
 * entry doesn't change length after a refresh.
 */
const MAX_BODY_CHARS = 600

/**
 * Strip + truncate on the way out. Producers now strip refs before persisting;
 * the strip here is a backstop for records written before that existed.
 */
function sanitizeBody(body?: string): string | undefined {
  if (!body) return body
  const clean = stripEntityRefs(body)
  if (clean.length <= MAX_BODY_CHARS) return clean
  let cut = clean.slice(0, MAX_BODY_CHARS)
  // Don't split a surrogate pair (an emoji on the boundary would render as �).
  const last = cut.charCodeAt(cut.length - 1)
  if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1)
  return `${cut}…`
}

// GET /api/notifications — feed (newest-last) + unread count.
notificationsRouter.get('/', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const { feed, unreadCount } = await listNotifications()
    // `detail` (the raw technical line behind an error card's Details toggle)
    // gets the SAME treatment as body — it is written by the same producers and
    // read by the same UI, so an uncapped one would be the hole the cap exists
    // to close. Mirrored in the /api/v1 twin.
    res.json({
      feed: feed.map(n => ({ ...n, body: sanitizeBody(n.body), detail: sanitizeBody(n.detail) })),
      unreadCount,
    })
  } catch (err) {
    next(err)
  }
})

function parseStringArray(res: Response, value: unknown, field: string): { ok: boolean; value?: string[] } {
  if (value !== undefined && (!Array.isArray(value) || value.some(v => typeof v !== 'string'))) {
    res.status(400).json({ error: `${field} must be an array of strings` })
    return { ok: false }
  }
  return { ok: true, value: value as string[] | undefined }
}

// POST /api/notifications/mark-read { ids?, dedupKeys? } — mark some (or, with
// neither, all) notifications read. Returns the resulting unread count.
notificationsRouter.post('/mark-read', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = req.body as { ids?: unknown; dedupKeys?: unknown }
    const ids = parseStringArray(res, body.ids, 'ids')
    if (!ids.ok) return
    // dedupKeys: a live entry's id is frontend-local, its key is the shared identity.
    const dedupKeys = parseStringArray(res, body.dedupKeys, 'dedupKeys')
    if (!dedupKeys.ok) return
    // An explicitly EMPTY dedupKeys list names nothing; it must not become mark-ALL.
    if (dedupKeys.value && dedupKeys.value.length === 0 && !ids.value?.length) {
      res.json({ unreadCount: (await listNotifications()).unreadCount })
      return
    }
    const { unreadCount } = await markRead(ids.value, dedupKeys.value)
    res.json({ unreadCount })
  } catch (err) {
    next(err)
  }
})

// POST /api/notifications/dismiss { ids?, dedupKeys? } — remove some (or, with
// no filter, ALL) notifications from the feed. dedupKeys exists because live WS
// entries carry frontend-local ids; dedupKey is the only cross-layer identity.
notificationsRouter.post('/dismiss', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = req.body as { ids?: unknown; dedupKeys?: unknown }
    const ids = parseStringArray(res, body.ids, 'ids')
    if (!ids.ok) return
    const dedupKeys = parseStringArray(res, body.dedupKeys, 'dedupKeys')
    if (!dedupKeys.ok) return
    const { unreadCount, removed } = await dismissNotifications({ ids: ids.value, dedupKeys: dedupKeys.value })
    res.json({ unreadCount, removed })
  } catch (err) {
    next(err)
  }
})

// POST /api/notifications/fix { dedupKey | host | hosts | system, restart? } — start a
// coding session in Walnut's own source with this error as the brief. The task
// files under the real 'Walnut' project (where the user's Walnut work lives),
// never a parallel repair project. Notification keys behave like dismiss; host
// aliases and system selectors read authoritative current failures instead.
// Current failures stay in memory and never write a notification or inbox item.
//
// Idempotent by default: a record that already has a repair returns it, so a
// second click (or a second device) reopens the same session instead of
// minting a duplicate; `restart: true` starts a fresh one. May take minutes
// the FIRST time on an npm install (it clones upstream); the client sends a
// matching timeout and the record still gains its `fix` if the browser gives
// up, because the store write + WS update happen server-side.
notificationsRouter.post('/fix', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { dedupKey, host, hosts, system, restart } = req.body ?? {}
    const selectors = [dedupKey, host, hosts, system].filter(value => value !== undefined)
    if (selectors.length !== 1) {
      res.status(400).json({ error: 'Provide exactly one of dedupKey, host, hosts or system' })
      return
    }
    if (dedupKey !== undefined && (typeof dedupKey !== 'string' || !dedupKey)) {
      res.status(400).json({ error: 'dedupKey must be a nonempty string' })
      return
    }
    if (host !== undefined && (typeof host !== 'string' || !host.trim())) {
      res.status(400).json({ error: 'host must be a nonempty alias' })
      return
    }
    if (hosts !== undefined && (!Array.isArray(hosts) || !hosts.length
      || hosts.some((value: unknown) => typeof value !== 'string' || !value.trim()))) {
      res.status(400).json({ error: 'hosts must be a nonempty array of host aliases' })
      return
    }
    if (system !== undefined && system !== 'backup' && system !== 'search') {
      res.status(400).json({ error: 'system must be backup or search' })
      return
    }
    if (CLOUD_MODE) {
      res.status(409).json({ error: 'Repairs start on the primary console, not on a cloud replica.' })
      return
    }
    if (system !== undefined) {
      const current = await currentSystemFailure(system)
      const target = `system:${system}`
      const cached = currentRepairs.get(target)
      if (!current || cached?.fingerprint !== current.fingerprint) currentRepairs.delete(target)
      if (!current) throw new HostFixError(`${system} has no current failure to repair`, 409)
      const record = systemFixRecord(system, current)
      const done = await launchCurrentRepair(target, current.fingerprint, record, SYSTEM_FIX_INSTRUCTIONS, restart === true)
      res.json(done)
      return
    }
    if (dedupKey === undefined) {
      const selected = [...new Set<string>(hosts ?? [host])].sort()
      const snapshot = await currentHostFailures()
      pruneHostRepairs(snapshot.failures)
      if (selected.length > snapshot.known.size + snapshot.disabled.size) {
        throw new HostFixError('hosts exceeds the current configured host set', 400)
      }
      for (const alias of selected) {
        if (snapshot.disabled.has(alias)) throw new HostFixError(`Host ${alias} is disabled; enable it first`, 409)
        if (!snapshot.known.has(alias)) throw new HostFixError(`Unknown host: ${alias}`, 404)
        if (snapshot.off.has(alias)) throw new HostFixError(`Host ${alias} is off on this server`, 409)
        if (!snapshot.failures.has(alias)) throw new HostFixError(`Host ${alias} has no current failure to repair; recheck its status`, 409)
      }
      const record = hostFixRecord(selected, snapshot.failures)
      const target = `hosts:${JSON.stringify(selected)}`
      const keys = selected.map(alias => [alias, snapshot.failures.get(alias)!.fingerprint] as const)
      const done = await launchCurrentRepair(target, JSON.stringify(keys), record, HOST_FIX_INSTRUCTIONS, restart === true, keys)
      res.json(done)
      return
    }
    const record = await findNotification(dedupKey)
    if (!record) {
      res.status(404).json({ error: 'Notification not found' })
      return
    }
    if (record.kind !== 'operation-error'
      && !(record.severity === 'error' && ['cron', 'skill', 'hook'].includes(record.kind))) {
      res.status(400).json({ error: 'Only error notifications can be handed to a repair session' })
      return
    }
    if (record.fix && restart !== true) {
      res.json({ taskId: record.fix.taskId, sessionId: record.fix.sessionId, reused: true })
      return
    }

    // `fix` is only written once the launch is done, and a first launch can sit
    // in a clone for minutes: a second click, tab or device in that window would
    // otherwise mint a second task and session for the same error. One launch
    // per dedupKey at a time; later callers ride it and get `reused: true`.
    const inFlight = fixInFlight.get(dedupKey)
    if (inFlight && restart !== true) {
      const done = await inFlight
      res.json({ taskId: done.taskId, sessionId: done.sessionId, reused: true })
      return
    }
    const launch = startRepair(dedupKey, record).finally(() => {
      if (fixInFlight.get(dedupKey) === launch) fixInFlight.delete(dedupKey)
    })
    fixInFlight.set(dedupKey, launch)
    const done = await launch
    res.json({ ...done, reused: false })
  } catch (err) {
    if (err instanceof WalnutSourceError || err instanceof QuickStartError || err instanceof HostFixError) {
      res.status(err.statusCode).json({ error: err.message })
      return
    }
    next(err)
  }
})

interface RepairLaunch {
  taskId: string
  sessionId: string
  startedAt: number
  source: Awaited<ReturnType<typeof ensureWalnutSource>>['source']
  cloned: boolean
}

const fixInFlight = new Map<string, Promise<RepairLaunch>>()
interface CurrentRepair {
  fingerprint: string
  hostKeys?: ReadonlyArray<readonly [string, string]>
  launch: Promise<RepairLaunch>
  completed: boolean
}
// One latest fingerprint per exact target set, with an additional bound on completed group combinations.
const currentRepairs = new Map<string, CurrentRepair>()
const MAX_CURRENT_REPAIRS = 64

function pruneHostRepairs(current: Map<string, { fingerprint: string }>): void {
  for (const [target, repair] of currentRepairs) {
    if (repair.hostKeys?.some(([alias, key]) => current.get(alias)?.fingerprint !== key)) currentRepairs.delete(target)
  }
}

async function launchCurrentRepair(
  target: string, fingerprint: string, record: NotificationRecord, instructions: string, restart: boolean,
  hostKeys?: CurrentRepair['hostKeys'],
): Promise<RepairLaunch & { reused: boolean }> {
  while (!restart) {
    const cached = currentRepairs.get(target)
    if (cached?.fingerprint !== fingerprint) break
    const done = await cached.launch
    if (!cached.completed) return { ...done, reused: true }
    const [task] = await listTasksByIds([done.taskId])
    if (currentRepairs.get(target) !== cached) continue
    if (task && task.phase !== 'COMPLETE') return { ...done, reused: true }
    break
  }
  const launch = startRepair(record.dedupKey, record, false, instructions)
  currentRepairs.delete(target)
  const entry: CurrentRepair = { fingerprint, hostKeys, launch, completed: false }
  currentRepairs.set(target, entry)
  try {
    const done = await launch
    entry.completed = true
    // Never evict a still-pending launch: a slow clone must keep absorbing clicks.
    const completed = [...currentRepairs].filter(([, repair]) => repair.completed)
    for (const [key] of completed.slice(0, Math.max(0, completed.length - MAX_CURRENT_REPAIRS))) currentRepairs.delete(key)
    return { ...done, reused: false }
  } catch (err) {
    if (currentRepairs.get(target)?.launch === launch) currentRepairs.delete(target)
    throw err
  }
}

async function startRepair(
  dedupKey: string, record: NotificationRecord, persist: boolean = true, instructions: string = '',
): Promise<RepairLaunch> {
  const { source, cloned } = await ensureWalnutSource()
  const message = instructions + buildNotificationFixMessage(record, {
    source, cloned,
    version: getVersion(),
    packageRoot: WALNUT_PACKAGE_ROOT,
    dataDir: WALNUT_HOME,
    logDir: LOG_DIR,
    repoUrl: WALNUT_REPO_URL,
  })
  // Minted here so it rides the response and the client opens the column at
  // once (same contract as quick-start's preassignedSessionId).
  const sessionId = randomUUID()
  const task = await quickStartSession({
    message,
    cwd: source.dir,
    taskTitle: fixTaskTitle(record),
    project: 'Walnut',
    projectFromFolder: false,
    // Same headless baseline as a fix-walnut launch with no client pick (the
    // launcher default, DEFAULT_META.pinTier — see routes/sessions.ts).
    taskMeta: { pinTier: 'focus' },
    source: 'notification-fix',
    requestTs: Date.now(),
    preassignedSessionId: sessionId,
  })
  const fix = { taskId: task.id, sessionId, startedAt: Date.now() }
  if (persist) {
    const updated = await attachNotificationFix(dedupKey, fix)
    if (updated) broadcastEvent('notification:updated', updated)
  }
  log.notif.info('notification repair session started', {
    dedupKey, taskId: task.id, sessionId, sourceDir: source.dir, sourceKind: source.kind, cloned,
  })
  return { ...fix, source, cloned }
}
