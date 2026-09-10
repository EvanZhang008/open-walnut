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
import { quickStartSession, QuickStartError } from '../../core/sessions/quick-start.js'
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

// POST /api/notifications/mark-read { ids? } — mark some (or, with no ids, all)
// notifications read. Returns the resulting unread count.
notificationsRouter.post('/mark-read', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const ids = parseStringArray(res, (req.body as { ids?: unknown }).ids, 'ids')
    if (!ids.ok) return
    const { unreadCount } = await markRead(ids.value)
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

// POST /api/notifications/fix { dedupKey, restart? } — "Ask AI to fix": start a
// coding session in Walnut's own source with this error as the brief. The task
// files under the real 'Walnut' project (where the user's Walnut work lives),
// never a parallel repair project. Addressed by dedupKey like dismiss: the id
// a live WS card carries is frontend-local.
//
// Idempotent by default: a record that already has a repair returns it, so a
// second click (or a second device) reopens the same session instead of
// minting a duplicate; `restart: true` starts a fresh one. May take minutes
// the FIRST time on an npm install (it clones upstream); the client sends a
// matching timeout and the record still gains its `fix` if the browser gives
// up, because the store write + WS update happen server-side.
notificationsRouter.post('/fix', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { dedupKey, restart } = req.body as { dedupKey?: unknown; restart?: unknown }
    if (typeof dedupKey !== 'string' || !dedupKey) {
      res.status(400).json({ error: 'dedupKey is required' })
      return
    }
    if (CLOUD_MODE) {
      res.status(409).json({ error: 'Repairs start on the primary console, not on a cloud replica.' })
      return
    }
    const record = await findNotification(dedupKey)
    if (!record) {
      res.status(404).json({ error: 'Notification not found' })
      return
    }
    if (record.kind !== 'operation-error') {
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
    if (err instanceof WalnutSourceError || err instanceof QuickStartError) {
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

async function startRepair(dedupKey: string, record: NotificationRecord): Promise<RepairLaunch> {
  const { source, cloned } = await ensureWalnutSource()
  const message = buildNotificationFixMessage(record, {
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
    // Same headless baseline as a fix-walnut launch with no client pick.
    taskMeta: { pinTier: 'satellite' },
    source: 'notification-fix',
    requestTs: Date.now(),
    preassignedSessionId: sessionId,
  })
  const fix = { taskId: task.id, sessionId, startedAt: Date.now() }
  const updated = await attachNotificationFix(dedupKey, fix)
  if (updated) broadcastEvent('notification:updated', updated)
  log.notif.info('notification repair session started', {
    dedupKey, taskId: task.id, sessionId, sourceDir: source.dir, sourceKind: source.kind, cloned,
  })
  return { ...fix, source, cloned }
}
