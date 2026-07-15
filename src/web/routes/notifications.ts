/**
 * Notification center routes — the durable feed behind the bell icon.
 *
 * Backs the persistent feed + unread badge in NotificationPanel. Realtime toasts
 * still arrive over WebSocket (cron:notification, session:permission-request);
 * this endpoint is the on-load snapshot + the read/dismiss mutators so the feed
 * and unread count survive a refresh. Store lives in core/notifications/store.ts.
 */

import { Router, type Request, type Response, type NextFunction } from 'express'
import { listNotifications, markRead, dismissNotifications } from '../../core/notifications/store.js'
import { stripEntityRefs } from '../../utils/entity-refs.js'

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
    res.json({ feed: feed.map(n => ({ ...n, body: sanitizeBody(n.body) })), unreadCount })
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
