/**
 * useCalendarEvents — external calendar events for a [from, to] day range.
 *
 * Fetches on range change, refetches on the `calendar:updated` WS push
 * (server cache refresh / any write — including agent edits), and exposes
 * optimistic move/resize with rollback so event chips track the pointer.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  listCalendarEvents,
  listCalendarSources,
  updateCalendarEvent,
  updateCalendarSource,
  createCalendarEvent,
  deleteCalendarEvent,
  type CalendarEvent,
  type CalendarSourceStatus,
} from '@/api/calendar';
import { useEvent } from '@/hooks/useWebSocket';
import { log } from '@/utils/log';

export interface UseCalendarEvents {
  events: CalendarEvent[];
  sources: CalendarSourceStatus[];
  loading: boolean;
  /** Optimistic move/resize; rolls back and refetches on failure. */
  moveEvent: (id: string, patch: { start: string; end: string; title?: string }) => void;
  createEvent: (input: { calendarId: string; title: string; start: string; end: string; allDay?: boolean }) => Promise<CalendarEvent>;
  removeEvent: (id: string) => void;
  /** Hide one external calendar and persist it in the shared visibility config. */
  hideCalendar: (calendarId: string) => void;
  refetch: () => void;
}

export function useCalendarEvents(from: string, to: string): UseCalendarEvents {
  const [events, setEvents] = useState<CalendarEvent[]>([]);
  const [sources, setSources] = useState<CalendarSourceStatus[]>([]);
  const [loading, setLoading] = useState(true);
  const rangeRef = useRef({ from, to });
  rangeRef.current = { from, to };
  // Guard against own-write echoes racing the optimistic state: while a write
  // is in flight, WS-triggered refetches are deferred until it settles.
  const writesInFlight = useRef(0);
  const pendingRefetch = useRef(false);

  const fetchNow = useCallback(async () => {
    const range = rangeRef.current;
    try {
      const res = await listCalendarEvents(range.from, range.to);
      // A slow response for a stale range must not clobber the current one.
      if (rangeRef.current.from !== range.from || rangeRef.current.to !== range.to) return;
      setEvents(res.events);
      setSources(res.sources);
    } catch (err) {
      log.warn('calendar', 'events fetch failed', { error: String(err).slice(0, 200) });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    setLoading(true);
    fetchNow();
  }, [from, to, fetchNow]);

  useEvent('calendar:updated', () => {
    if (writesInFlight.current > 0) {
      pendingRefetch.current = true;
      return;
    }
    fetchNow();
  });

  const settleWrite = useCallback(() => {
    writesInFlight.current -= 1;
    if (writesInFlight.current === 0 && pendingRefetch.current) {
      pendingRefetch.current = false;
      fetchNow();
    }
  }, [fetchNow]);

  const moveEvent = useCallback(
    (id: string, patch: { start: string; end: string; title?: string }) => {
      const prev = events;
      setEvents((current) =>
        current.map((e) => (e.id === id ? { ...e, start: patch.start, end: patch.end, ...(patch.title ? { title: patch.title } : {}) } : e))
      );
      writesInFlight.current += 1;
      updateCalendarEvent(id, patch)
        .then((res) => {
          // A recurring-occurrence id can change after an edit (detached
          // occurrence) — swap in the server's canonical event.
          setEvents((current) => current.map((e) => (e.id === id ? res.event : e)));
        })
        .catch((err) => {
          log.warn('calendar', 'event move failed, rolling back', { id, error: String(err).slice(0, 200) });
          setEvents(prev);
        })
        .finally(settleWrite);
    },
    [events, settleWrite]
  );

  const createEvent = useCallback(
    async (input: { calendarId: string; title: string; start: string; end: string; allDay?: boolean }) => {
      writesInFlight.current += 1;
      try {
        const res = await createCalendarEvent(input);
        setEvents((current) => [...current, res.event]);
        return res.event;
      } finally {
        settleWrite();
      }
    },
    [settleWrite]
  );

  const removeEvent = useCallback(
    (id: string) => {
      const prev = events;
      setEvents((current) => current.filter((e) => e.id !== id));
      writesInFlight.current += 1;
      deleteCalendarEvent(id)
        .catch((err) => {
          log.warn('calendar', 'event delete failed, rolling back', { id, error: String(err).slice(0, 200) });
          setEvents(prev);
        })
        .finally(settleWrite);
    },
    [events, settleWrite]
  );

  const hideCalendar = useCallback(
    (calendarId: string) => {
      // The context-menu action should feel immediate. The canonical refetch
      // below restores the events if either visibility request fails.
      setEvents((current) => current.filter((event) => event.calendarId !== calendarId));
      void listCalendarSources()
        .then((res) => {
          const hiddenIds = new Set(
            res.calendars.filter((calendar) => calendar.hidden).map((calendar) => calendar.id)
          );
          hiddenIds.add(calendarId);
          return updateCalendarSource({
            hidden_calendar_ids: [...hiddenIds],
            visible_calendar_ids: null,
          });
        })
        .then(fetchNow)
        .catch((err) => {
          log.warn('calendar', 'calendar hide failed, refetching', {
            calendarId,
            error: String(err).slice(0, 200),
          });
          fetchNow();
        });
    },
    [fetchNow]
  );

  return {
    events,
    sources,
    loading,
    moveEvent,
    createEvent,
    removeEvent,
    hideCalendar,
    refetch: fetchNow,
  };
}
