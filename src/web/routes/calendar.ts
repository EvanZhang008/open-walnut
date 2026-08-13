/**
 * /api/calendar — external calendar events (EventKit; all macOS
 * system-account calendars including Google/iCloud, using the Mac's logins).
 *
 * GET    /events?from=YYYY-MM-DD&to=YYYY-MM-DD → { events, sources }
 * GET    /sources                              → { sources, calendars }
 * PUT    /sources/eventkit                     → { enabled?, hidden_calendar_ids?, visible_calendar_ids? }
 * POST   /refresh                              → force re-fetch all cached windows
 * PATCH  /events/:id                           → { start, end, title? }
 * POST   /events                               → { calendarId, title, start, end, allDay? }
 * DELETE /events/:id
 *
 * Date contract: tz-less local ISO (same as task dates).
 */
import { Router } from 'express';
import { getCalendarService, CalendarHelperError } from '../../core/calendar/index.js';
import { getConfig, updateConfig } from '../../core/config-manager.js';
import { log } from '../../logging/index.js';

export const calendarRouter = Router();

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const LOCAL_ISO_RE = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}):(\d{2}))?$/;

/** Map helper error codes to HTTP statuses. */
function sendError(res: import('express').Response, err: unknown): void {
  if (err instanceof CalendarHelperError) {
    const status =
      err.code === 'not-found' ? 404
      : err.code === 'usage' ? 400
      : err.code === 'readonly' ? 409
      : err.code === 'permission-denied' ? 403
      : err.code === 'disabled' || err.code === 'not-configured' || err.code === 'cloud' ? 503
      : 502;
    res.status(status).json({ error: err.message, code: err.code });
    return;
  }
  log.calendar.error('calendar route failed', { error: String(err).slice(0, 300) });
  res.status(500).json({ error: 'internal calendar error' });
}

calendarRouter.get('/events', async (req, res) => {
  const { from, to } = req.query as { from?: string; to?: string };
  if (!from || !to || !DAY_RE.test(from) || !DAY_RE.test(to) || from > to) {
    res.status(400).json({ error: 'from/to must be YYYY-MM-DD with from <= to' });
    return;
  }
  const service = getCalendarService();
  try {
    const events = await service.getEvents(from, to);
    res.json({ events, sources: [service.status()] });
  } catch (err) {
    // Reads degrade gracefully: the calendar view still renders tasks.
    if (err instanceof CalendarHelperError) {
      res.json({ events: [], sources: [service.status()] });
      return;
    }
    sendError(res, err);
  }
});

calendarRouter.get('/sources', async (_req, res) => {
  const service = getCalendarService();
  const status = service.status();
  let calendars: unknown[] = [];
  if (status.available && status.enabled) {
    try {
      calendars = await service.listCalendars();
    } catch {
      calendars = []; // status() will carry the failure reason on next call
    }
  }
  res.json({ sources: [service.status()], calendars });
});

calendarRouter.put('/sources/eventkit', async (req, res) => {
  const { enabled, hidden_calendar_ids, visible_calendar_ids } = req.body as {
    enabled?: boolean;
    hidden_calendar_ids?: string[];
    /** Allowlist: when set, ONLY these calendars show. null clears it. */
    visible_calendar_ids?: string[] | null;
  };
  const badIdArray = (v: unknown) => !Array.isArray(v) || v.some((x) => typeof x !== 'string');
  if (hidden_calendar_ids !== undefined && badIdArray(hidden_calendar_ids)) {
    res.status(400).json({ error: 'hidden_calendar_ids must be a string array' });
    return;
  }
  if (visible_calendar_ids !== undefined && visible_calendar_ids !== null && badIdArray(visible_calendar_ids)) {
    res.status(400).json({ error: 'visible_calendar_ids must be a string array or null' });
    return;
  }
  const config = await getConfig();
  await updateConfig({
    calendar: {
      ...config.calendar,
      ...(enabled !== undefined ? { enabled: !!enabled } : {}),
      ...(hidden_calendar_ids !== undefined ? { hidden_calendar_ids } : {}),
      // null clears the allowlist (key removed on next write via undefined)
      ...(visible_calendar_ids !== undefined
        ? { visible_calendar_ids: visible_calendar_ids === null ? undefined : visible_calendar_ids }
        : {}),
    },
  });
  const service = getCalendarService();
  await service.reloadConfig();
  service.refreshAll().catch(() => {});
  res.json({ sources: [service.status()] });
});

calendarRouter.post('/refresh', async (_req, res) => {
  const service = getCalendarService();
  try {
    await service.refreshAll();
    res.json({ sources: [service.status()] });
  } catch (err) {
    sendError(res, err);
  }
});

calendarRouter.patch('/events/:id', async (req, res) => {
  const { start, end, title } = req.body as { start?: string; end?: string; title?: string };
  if (!start || !end || !LOCAL_ISO_RE.test(start) || !LOCAL_ISO_RE.test(end)) {
    res.status(400).json({ error: 'start and end are required, tz-less local ISO' });
    return;
  }
  try {
    const event = await getCalendarService().updateEvent(req.params.id, { start, end, title });
    res.json({ event });
  } catch (err) {
    sendError(res, err);
  }
});

calendarRouter.post('/events', async (req, res) => {
  const { calendarId, title, start, end, allDay } = req.body as {
    calendarId?: string;
    title?: string;
    start?: string;
    end?: string;
    allDay?: boolean;
  };
  if (!calendarId || !title?.trim() || !start || !end || !LOCAL_ISO_RE.test(start) || !LOCAL_ISO_RE.test(end)) {
    res.status(400).json({ error: 'calendarId, title, start, end are required (tz-less local ISO dates)' });
    return;
  }
  try {
    const event = await getCalendarService().createEvent({ calendarId, title: title.trim(), start, end, allDay });
    res.status(201).json({ event });
  } catch (err) {
    sendError(res, err);
  }
});

calendarRouter.delete('/events/:id', async (req, res) => {
  try {
    await getCalendarService().deleteEvent(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    sendError(res, err);
  }
});
