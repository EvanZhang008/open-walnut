/**
 * useCalendarEvents — external calendar events for a [from, to] day range.
 *
 * Thin view onto the shared calendar store (`@/stores/calendar-events-store`):
 * the homepage day agenda and /calendar are mounted at the same time, so the
 * range list, its single fetch, and every optimistic write live in ONE module
 * instead of one private copy per mount. Reconciles on the `calendar:updated`
 * WS push and after a socket gap.
 */
import { useCallback, useEffect, useMemo, useSyncExternalStore } from 'react';
import type { CalendarEvent, CalendarInfo, CalendarSourceStatus } from '@/api/calendar';
import { useNotifications } from '@/contexts/notifications';
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
  setCalendarEventHidden,
  setCalendarHidden,
  subscribeCalendarRange,
  subscribeCalendarSources,
  subscribeCalendarVisibilityFailures,
  subscribeCalendarWriteFailures,
} from '@/stores/calendar-events-store';

const NO_EVENTS: CalendarEvent[] = [];

export interface UseCalendarEvents {
  /** Visible events only; individually hidden ones are in `hiddenEvents`. */
  events: CalendarEvent[];
  hiddenEvents: CalendarEvent[];
  sources: CalendarSourceStatus[];
  loading: boolean;
  /** Optimistic move/resize; rolls back and refetches on failure. */
  moveEvent: (id: string, patch: { start: string; end: string; title?: string; human_confirm?: boolean }) => void;
  createEvent: (input: { calendarId: string; title: string; start: string; end: string; allDay?: boolean }) => Promise<CalendarEvent>;
  removeEvent: (id: string, humanConfirm?: boolean) => void;
  /** Hide one external calendar and persist it in the shared visibility config. */
  hideCalendar: (calendarId: string) => void;
  /** Hide one event in Walnut only; the source calendar keeps it. */
  hideEvent: (eventId: string) => void;
  showEvent: (eventId: string) => void;
  refetch: () => void;
}

function hideCalendar(calendarId: string): void {
  void setCalendarHidden(calendarId, true);
}

function hideEvent(eventId: string): void {
  void setCalendarEventHidden(eventId, true);
}

function showEvent(eventId: string): void {
  void setCalendarEventHidden(eventId, false);
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

  // Every mounted surface hears a failure; the shared dedupKey leaves one toast.
  const { notify } = useNotifications();
  useEffect(() => subscribeCalendarVisibilityFailures((failure) => {
    const name = failure.title ? `"${failure.title}"` : 'The event';
    notify({
      kind: 'operation-error',
      severity: 'error',
      title: failure.hidden ? 'Could not hide event' : 'Could not show event',
      body: `${name} is ${failure.hidden ? 'visible' : 'hidden'} again: ${failure.message}`,
      persistent: false,
      dedupKey: `calendar-event-visibility:${failure.id}`,
    });
  }), [notify]);

  useEffect(() => subscribeCalendarWriteFailures((failure) => {
    notify({ kind: 'operation-error', severity: 'error', title: `Could not ${failure.action} event`,
      body: failure.message, persistent: false, dedupKey: `calendar-write:${failure.id}` });
  }), [notify]);

  const refetch = useCallback(() => { void loadCalendarRange(key, true); }, [key]);

  const events = useMemo(
    () => (range.events.some((e) => e.hidden) ? range.events.filter((e) => !e.hidden) : range.events),
    [range.events],
  );
  const hiddenEvents = useMemo(() => {
    const hidden = range.events.filter((e) => e.hidden);
    return hidden.length ? hidden : NO_EVENTS;
  }, [range.events]);

  return {
    events,
    hiddenEvents,
    sources: shared.sources,
    loading: range.loading,
    moveEvent: moveCalendarEvent,
    createEvent: createCalendarEventOptimistic,
    removeEvent: removeCalendarEvent,
    hideCalendar,
    hideEvent,
    showEvent,
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
