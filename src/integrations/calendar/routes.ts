/**
 * The calendar's HTTP surface, registered by the plugin.
 *
 * Canonical path is `/api/plugins/calendar/*`; `/api/calendar/*` is a core alias kept for
 * the existing web clients (src/web/routes/calendar-alias.ts says when it can go).
 *
 * GET    /events?from=YYYY-MM-DD&to=YYYY-MM-DD[&fresh=1][&include_hidden=1] → { events, sources }
 *          `fresh=1` skips the read cache (~0.25s slower) — use it when a stale
 *          answer is worse than a slow one. `sources[0].lastRefresh` always says
 *          how old the served data actually is. `include_hidden=1` also returns
 *          single hidden events, marked `hidden: true`.
 *          Events may carry `status` ('confirmed' | 'tentative' | 'canceled')
 *          and `selfStatus` ('pending' | 'accepted' | 'declined' | 'tentative' |
 *          'delegated'). Cancelled and declined events are MARKED, not dropped:
 *          the calendar shows what macOS holds and callers decide how to render.
 * GET    /sources                              → { sources, calendars }
 * PUT    /sources/eventkit                     → { enabled?, hidden_calendar_ids?, visible_calendar_ids? }
 *          `visible_calendar_ids: null` CLEARS the allowlist (an omitted key changes nothing).
 * POST   /refresh                              → force re-fetch all cached windows
 * PATCH  /events/:id/visibility                → { hidden: boolean } → { id, hidden, changed, sources }
 *          Walnut-only hide/show by exact id; 400 bad body/id or uncached one-off id, 404 missing.
 * PATCH  /events/:id                           → { start, end, title? }
 * POST   /events                               → { calendarId, title, start, end, allDay? }
 * DELETE /events/:id
 *
 * Date contract: tz-less local ISO (same as task dates).
 */
import type { WalnutServerPluginApi } from '../../core/plugins/server-api.js'
import type { PluginRouteReply, PluginRouteRequest } from '../../core/plugins/plugin-route-adapter.js'
import { calendarErrorCode } from './api.js'
import { ORIGIN_HEADER, LOCAL_ORIGIN } from '../../lib/caller-origin.js'
import type { CalendarService } from './service.js'

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/
const LOCAL_ISO_RE = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}):(\d{2}))?$/
const QUERY_BOOLEANS = new Set(['1', 'true', '0', 'false'])
const VISIBILITY_SUFFIX = '/visibility'

/** Map helper error codes to HTTP statuses. */
function errorReply(walnut: WalnutServerPluginApi, err: unknown): PluginRouteReply {
  const code = calendarErrorCode(err)
  if (code) {
    const status =
      code === 'not-found' ? 404
      : code === 'usage' ? 400
      : code === 'human-approval-required' || code === 'approval-canceled' ? 403
      : code === 'readonly' ? 409
      : code === 'permission-denied' ? 403
      : code === 'disabled' || code === 'not-configured' || code === 'cloud' ? 503
      : 502
    return { status, json: { error: err instanceof Error ? err.message : String(err), code } }
  }
  walnut.log.error('calendar route failed', { error: String(err).slice(0, 300) })
  return { status: 500, json: { error: 'internal calendar error' } }
}

function firstQuery(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value
}

/**
 * The event id out of the request path.
 *
 * A plugin route handler is handed the path, not Express's `req.params`, so the id is
 * parsed here. Two things this has to keep true, both covered by the route tests: a
 * recurring occurrence id contains `#` and therefore arrives percent-encoded (`%23`), and
 * the same handler serves both the canonical `/api/plugins/calendar/events/<id>` and the
 * legacy `/api/calendar/events/<id>`, so the prefix is found rather than assumed.
 * `suffix` (`/visibility`) is cut off first, or it would be read as part of the id.
 */
function eventIdFrom(request: PluginRouteRequest, suffix = ''): string {
  let pathname = request.path.split('?')[0]
  if (suffix) {
    pathname = pathname.replace(/\/+$/, '')
    if (pathname.endsWith(suffix)) pathname = pathname.slice(0, -suffix.length)
  }
  const marker = '/events/'
  const at = pathname.lastIndexOf(marker)
  const raw = at < 0 ? '' : pathname.slice(at + marker.length)
  try {
    return decodeURIComponent(raw)
  } catch {
    return raw // a malformed escape is not an id we can fix; let the source 404 it
  }
}

/** Parsed JSON body, or `{}` — a malformed body is the caller's 400, not a 500. */
async function readBody(request: PluginRouteRequest): Promise<Record<string, unknown> | null> {
  try {
    const body = await request.json<Record<string, unknown> | null>()
    return body && typeof body === 'object' ? body : {}
  } catch {
    return null
  }
}

export function registerCalendarRoutes(
  walnut: WalnutServerPluginApi,
  resolve: () => CalendarService,
): void {
  walnut.http.route('get', '/events', async (request) => {
    const from = firstQuery(request.query.from)
    const to = firstQuery(request.query.to)
    const fresh = firstQuery(request.query.fresh)
    const includeHiddenRaw = firstQuery(request.query.include_hidden)
    if (!from || !to || !DAY_RE.test(from) || !DAY_RE.test(to) || from > to) {
      return { status: 400, json: { error: 'from/to must be YYYY-MM-DD with from <= to' } }
    }
    if (includeHiddenRaw !== undefined && !QUERY_BOOLEANS.has(includeHiddenRaw)) {
      return { status: 400, json: { error: 'include_hidden must be 1, true, 0 or false' } }
    }
    const force = fresh === '1' || fresh === 'true'
    const includeHidden = includeHiddenRaw === '1' || includeHiddenRaw === 'true'
    // Resolving is itself guarded, in every handler: between `deactivate` and the dispose
    // that follows it there is no service, and `resolve()` throws `not-configured` then.
    // Unguarded that surfaced as a 500 rather than the documented 503.
    let service: CalendarService
    try {
      service = resolve()
    } catch (err) {
      return errorReply(walnut, err)
    }
    try {
      const events = await service.getEvents(from, to, { force, includeHidden })
      return { json: { events, sources: [service.status()] } }
    } catch (err) {
      // Reads degrade gracefully: the calendar view still renders tasks.
      if (calendarErrorCode(err)) return { json: { events: [], sources: [service.status()] } }
      return errorReply(walnut, err)
    }
  })

  walnut.http.route('get', '/sources', async () => {
    try {
      const service = resolve()
      const status = service.status()
      let calendars: unknown[] = []
      if (status.available && status.enabled) {
        try {
          calendars = await service.listCalendars()
        } catch {
          calendars = [] // status() will carry the failure reason on next call
        }
      }
      return { json: { sources: [service.status()], calendars } }
    } catch (err) {
      return errorReply(walnut, err)
    }
  })

  walnut.http.route('put', '/sources/eventkit', async (request) => {
    const body = await readBody(request)
    if (!body) return { status: 400, json: { error: 'body must be JSON' } }
    const { enabled, hidden_calendar_ids, visible_calendar_ids } = body as {
      enabled?: boolean
      hidden_calendar_ids?: string[]
      /** Allowlist: when set, ONLY these calendars show. null clears it. */
      visible_calendar_ids?: string[] | null
    }
    const badIdArray = (v: unknown) => !Array.isArray(v) || v.some((x) => typeof x !== 'string')
    if (hidden_calendar_ids !== undefined && badIdArray(hidden_calendar_ids)) {
      return { status: 400, json: { error: 'hidden_calendar_ids must be a string array' } }
    }
    if (visible_calendar_ids !== undefined && visible_calendar_ids !== null && badIdArray(visible_calendar_ids)) {
      return { status: 400, json: { error: 'visible_calendar_ids must be a string array or null' } }
    }
    // Resolved BEFORE the write: a torn-down plugin must answer 503 without having changed
    // the user's config first.
    let service: CalendarService
    try {
      service = resolve()
    } catch (err) {
      return errorReply(walnut, err)
    }
    // Patch only what was sent: the host merges into `plugins.calendar` under its config
    // write lock, so there is no read-modify-write race with any other writer.
    const patch: Record<string, unknown> = {}
    // `source_enabled`, not `enabled` — see the CalendarPluginConfig comment in service.ts.
    if (enabled !== undefined) patch.source_enabled = !!enabled
    if (hidden_calendar_ids !== undefined) patch.hidden_calendar_ids = hidden_calendar_ids
    // `null` is written THROUGH, not turned into `undefined`: yaml.dump drops an undefined
    // key, and an absent key means "fall back to the legacy top-level allowlist", so every
    // hide/unhide (both web callers send null) silently kept the old allowlist alive.
    if (visible_calendar_ids !== undefined) patch.visible_calendar_ids = visible_calendar_ids
    if (Object.keys(patch).length > 0) await walnut.config.patch(patch)
    await service.reloadConfig()
    service.refreshAll().catch(() => {})
    return { json: { sources: [service.status()] } }
  })

  walnut.http.route('post', '/refresh', async () => {
    try {
      const service = resolve()
      await service.refreshAll()
      return { json: { sources: [service.status()] } }
    } catch (err) {
      return errorReply(walnut, err)
    }
  })

  // Before `PATCH /events/:id`: plugin routes mount with `router.use`, a prefix match.
  walnut.http.route('patch', `/events/:id${VISIBILITY_SUFFIX}`, async (request) => {
    const body = await readBody(request)
    if (!body) return { status: 400, json: { error: 'body must be JSON' } }
    const { hidden } = body as { hidden?: unknown }
    if (typeof hidden !== 'boolean') {
      return { status: 400, json: { error: 'hidden must be true or false', code: 'usage' } }
    }
    const id = eventIdFrom(request, VISIBILITY_SUFFIX)
    if (!id.trim()) return { status: 400, json: { error: 'event id is required', code: 'usage' } }
    let service: CalendarService
    try {
      service = resolve()
    } catch (err) {
      return errorReply(walnut, err)
    }
    try {
      const result = await service.setEventHidden(id, hidden, (patch) => walnut.config.patch(patch))
      return { json: { ...result, sources: [service.status()] } }
    } catch (err) {
      return errorReply(walnut, err)
    }
  })

  walnut.http.route('patch', '/events/:id', async (request) => {
    const body = await readBody(request)
    if (!body) return { status: 400, json: { error: 'body must be JSON' } }
    const { start, end, title, human_confirm } = body as { start?: string; end?: string; title?: string; human_confirm?: boolean }
    if (human_confirm !== undefined && typeof human_confirm !== 'boolean') return { status: 400, json: { error: 'human_confirm must be a boolean' } }
    if (human_confirm && (request.headers['x-walnut-caller-sid'] || (request.headers[ORIGIN_HEADER] && request.headers[ORIGIN_HEADER] !== LOCAL_ORIGIN))) return { status: 403, json: { error: 'Protected calendar writes must be confirmed in Walnut on the Mac. Use Hide event instead.', code: 'human-approval-required' } }
    if (!start || !end || !LOCAL_ISO_RE.test(start) || !LOCAL_ISO_RE.test(end)) {
      return { status: 400, json: { error: 'start and end are required, tz-less local ISO' } }
    }
    try {
      const event = await resolve().updateEvent(eventIdFrom(request), { start, end, title }, human_confirm ? { humanConfirm: true } : undefined)
      return { json: { event } }
    } catch (err) {
      return errorReply(walnut, err)
    }
  })

  walnut.http.route('post', '/events', async (request) => {
    const body = await readBody(request)
    if (!body) return { status: 400, json: { error: 'body must be JSON' } }
    const { calendarId, title, start, end, allDay } = body as {
      calendarId?: string
      title?: string
      start?: string
      end?: string
      allDay?: boolean
    }
    if (!calendarId || !title?.trim() || !start || !end || !LOCAL_ISO_RE.test(start) || !LOCAL_ISO_RE.test(end)) {
      return { status: 400, json: { error: 'calendarId, title, start, end are required (tz-less local ISO dates)' } }
    }
    try {
      const event = await resolve().createEvent({ calendarId, title: title.trim(), start, end, allDay })
      return { status: 201, json: { event } }
    } catch (err) {
      return errorReply(walnut, err)
    }
  })

  walnut.http.route('delete', '/events/:id', async (request) => {
    const confirmation = firstQuery(request.query.human_confirm)
    if (confirmation !== undefined && confirmation !== '1') return { status: 400, json: { error: 'human_confirm must be 1' } }
    if (confirmation && (request.headers['x-walnut-caller-sid'] || (request.headers[ORIGIN_HEADER] && request.headers[ORIGIN_HEADER] !== LOCAL_ORIGIN))) return { status: 403, json: { error: 'Protected calendar writes must be confirmed in Walnut on the Mac. Use Hide event instead.', code: 'human-approval-required' } }
    try {
      await resolve().deleteEvent(eventIdFrom(request), confirmation ? { humanConfirm: true } : undefined)
      return { json: { ok: true } }
    } catch (err) {
      return errorReply(walnut, err)
    }
  })
}
