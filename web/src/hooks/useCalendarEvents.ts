/**
 * useCalendarEvents — external calendar events for a [from, to] day range.
 *
 * Thin view onto the shared calendar store (`@/stores/calendar-events-store`):
 * the homepage day agenda and /calendar are mounted at the same time, so the
 * range list, its single fetch, and every optimistic write live in ONE module
 * instead of one private copy per mount. Reconciles on the `calendar:updated`
 * WS push and after a socket gap.
 */
import { useCallback, useEffect, useSyncExternalStore } from 'react';
import type { CalendarEvent, CalendarInfo, CalendarSourceStatus } from '@/api/calendar';
import { useEvent } from '@/hooks/useWebSocket';
import { runWhenVisible } from '@/utils/page-visibility';
import {
  calendarRangeKey,
  createCalendarEventOptimistic,
  ensureCalendarRange,
  ensureCalendarsLoaded,
  getCalendarRange,
  getCalendarSourcesEntry,
  loadCalendarRange,
  moveCalendarEvent,
  onCalendarUpdated,
  refetchLiveCalendarRanges,
  removeCalendarEvent,
  setCalendarHidden,
  subscribeCalendarRange,
  subscribeCalendarSources,
} from '@/stores/calendar-events-store';

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

function hideCalendar(calendarId: string): void {
  void setCalendarHidden(calendarId, true);
}

export function useCalendarEvents(from: string, to: string): UseCalendarEvents {
  const key = calendarRangeKey(from, to);
  const subscribe = useCallback((fn: () => void) => subscribeCalendarRange(key, fn), [key]);
  const readRange = useCallback(() => getCalendarRange(key), [key]);
  const range = useSyncExternalStore(subscribe, readRange, readRange);
  const shared = useSyncExternalStore(subscribeCalendarSources, getCalendarSourcesEntry, getCalendarSourcesEntry);

  useEffect(() => { ensureCalendarRange(from, to); }, [from, to]);

  useEvent('calendar:updated', () => { onCalendarUpdated(); });

  // A WS gap loses every push in it and this list is not polled, so an event
  // moved while the socket was down would stay wrong until a reload. Hidden tabs
  // defer — every open tab reconnects at once and the store shares one request.
  useEvent('_ws:reconnected', () => {
    runWhenVisible('calendar-events:reconnect', () => { void refetchLiveCalendarRanges(); });
  });

  const refetch = useCallback(() => { void loadCalendarRange(key, true); }, [key]);

  return {
    events: range.events,
    sources: shared.sources,
    loading: range.loading,
    moveEvent: moveCalendarEvent,
    createEvent: createCalendarEventOptimistic,
    removeEvent: removeCalendarEvent,
    hideCalendar,
    refetch,
  };
}

export interface UseCalendarVisibility {
  /** `null` until the list has resolved once — the popover shows "Loading…". */
  calendars: CalendarInfo[] | null;
  unavailable: boolean;
  setHidden: (calendarId: string, hidden: boolean) => void;
}

/** Calendar visibility, shared so the toolbar popover and the grid always agree. */
export function useCalendarVisibility(): UseCalendarVisibility {
  const shared = useSyncExternalStore(subscribeCalendarSources, getCalendarSourcesEntry, getCalendarSourcesEntry);

  // Force a refresh on open (Settings or another client may have moved it) while
  // the cached list keeps rendering — no "Loading…" flash on a re-open.
  useEffect(() => { void ensureCalendarsLoaded(true); }, []);

  const setHidden = useCallback((calendarId: string, hidden: boolean) => {
    void setCalendarHidden(calendarId, hidden);
  }, []);

  return {
    calendars: shared.calendarsLoaded ? shared.calendars : null,
    unavailable: shared.unavailable,
    setHidden,
  };
}
