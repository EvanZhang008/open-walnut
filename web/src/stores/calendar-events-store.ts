/**
 * Calendar events store — ONE in-browser truth for external calendar events,
 * held per [from, to] day range.
 *
 * Two surfaces are live at the same time: the homepage day agenda
 * (CalendarSidePanel, rendered from MainPage which never unmounts) and
 * /calendar. When each mount kept its own `useState` list, the SAME range was
 * fetched twice and a drag on one surface only reached the other through the
 * `calendar:updated` echo plus a full refetch — the home agenda showed the old
 * time for as long as that took. Writes now patch the shared record by event id,
 * so every mounted range that carries the event moves in the same frame and the
 * REST round-trip only confirms.
 *
 * Calendar visibility lives here too. It used to be written from two places (the
 * toolbar popover's own optimistic copy and the context menu's `hideCalendar`),
 * so the same action felt instant through one path and laggy through the other.
 */
import {
  createCalendarEvent,
  deleteCalendarEvent,
  listCalendarEvents,
  listCalendarSources,
  updateCalendarEvent,
  updateCalendarSource,
  type CalendarEvent,
  type CalendarInfo,
  type CalendarSourceStatus,
} from '@/api/calendar';
import { log } from '@/utils/log';

/** A newly mounted surface reuses a range list this fresh instead of re-fetching. */
const STALE_MS = 15_000;
/** Coalesce a burst of `calendar:updated` pushes (two mounts hear each one). */
const REFRESH_DEBOUNCE_MS = 150;
/** Cached ranges nobody watches any more; keeps week-stepping snappy. */
const MAX_CACHED_RANGES = 12;

export interface CalendarRangeEntry {
  events: CalendarEvent[];
  loading: boolean;
}

export interface CalendarSourcesEntry {
  sources: CalendarSourceStatus[];
  calendars: CalendarInfo[];
  /** The calendars list has resolved at least once (`[]` is a real answer). */
  calendarsLoaded: boolean;
  /** The source is off or unreachable — the popover says so instead of listing. */
  unavailable: boolean;
}

const NO_EVENTS: CalendarEvent[] = [];
const EMPTY_ENTRY: CalendarRangeEntry = Object.freeze({ events: NO_EVENTS, loading: true });

const entries = new Map<string, CalendarRangeEntry>();
const loadedAt = new Map<string, number>();
const inflight = new Map<string, Promise<void>>();
const wantsRefetch = new Set<string>();
const rangeSubs = new Map<string, Set<() => void>>();

let sourcesEntry: CalendarSourcesEntry = { sources: [], calendars: [], calendarsLoaded: false, unavailable: false };
const sourcesSubs = new Set<() => void>();
let calendarsInflight: Promise<CalendarInfo[]> | null = null;

// A write's own echo must not clobber the optimistic state it just applied, so
// `calendar:updated` refetches wait until every in-flight write has settled.
let writesInFlight = 0;
let pendingRefetch = false;
let refreshTimer: ReturnType<typeof setTimeout> | null = null;
let provisionalSeq = 0;

export function calendarRangeKey(from: string, to: string): string {
  return `${from}..${to}`;
}

function splitKey(key: string): { from: string; to: string } {
  const idx = key.indexOf('..');
  return { from: key.slice(0, idx), to: key.slice(idx + 2) };
}

function emitRange(key: string): void {
  const subs = rangeSubs.get(key);
  if (!subs) return;
  for (const fn of [...subs]) fn();
}

function emitSources(): void {
  for (const fn of [...sourcesSubs]) fn();
}

export function subscribeCalendarRange(key: string, fn: () => void): () => void {
  let subs = rangeSubs.get(key);
  if (!subs) { subs = new Set(); rangeSubs.set(key, subs); }
  subs.add(fn);
  return () => {
    const live = rangeSubs.get(key);
    if (!live) return;
    live.delete(fn);
    if (live.size === 0) { rangeSubs.delete(key); evictCold(); }
  };
}

export function getCalendarRange(key: string): CalendarRangeEntry {
  return entries.get(key) ?? EMPTY_ENTRY;
}

export function subscribeCalendarSources(fn: () => void): () => void {
  sourcesSubs.add(fn);
  return () => { sourcesSubs.delete(fn); };
}

export function getCalendarSourcesEntry(): CalendarSourcesEntry {
  return sourcesEntry;
}

/** Drop cached ranges nobody watches, oldest first, once the map grows past the cap. */
function evictCold(): void {
  if (entries.size <= MAX_CACHED_RANGES) return;
  const cold = [...entries.keys()]
    .filter((key) => !rangeSubs.has(key) && !inflight.has(key))
    .sort((a, b) => (loadedAt.get(a) ?? 0) - (loadedAt.get(b) ?? 0));
  for (const key of cold) {
    if (entries.size <= MAX_CACHED_RANGES) return;
    entries.delete(key);
    loadedAt.delete(key);
  }
}

function setEntry(key: string, next: CalendarRangeEntry): void {
  entries.set(key, next);
  emitRange(key);
}

function setSources(sources: CalendarSourceStatus[]): void {
  sourcesEntry = { ...sourcesEntry, sources };
  emitSources();
}

function setCalendars(calendars: CalendarInfo[], unavailable = sourcesEntry.unavailable): void {
  sourcesEntry = { ...sourcesEntry, calendars, calendarsLoaded: true, unavailable };
  emitSources();
}

/**
 * Fetch one range. Concurrent callers share the request; a force that lands
 * mid-flight queues exactly one fresh response behind it instead of racing.
 */
export function loadCalendarRange(key: string, force = false): Promise<void> {
  const running = inflight.get(key);
  if (running) {
    if (force) wantsRefetch.add(key);
    return running;
  }
  if (!force && loadedAt.has(key) && Date.now() - (loadedAt.get(key) ?? 0) < STALE_MS) {
    return Promise.resolve();
  }
  const { from, to } = splitKey(key);
  const run = (async () => {
    try {
      do {
        wantsRefetch.delete(key);
        const res = await listCalendarEvents(from, to);
        loadedAt.set(key, Date.now());
        setEntry(key, { events: res.events, loading: false });
        setSources(res.sources);
      } while (wantsRefetch.has(key));
    } catch (err) {
      wantsRefetch.delete(key);
      setEntry(key, { events: entries.get(key)?.events ?? [], loading: false });
      log.warn('calendar', 'events fetch failed', { range: key, error: String(err).slice(0, 200) });
    } finally {
      inflight.delete(key);
    }
  })();
  inflight.set(key, run);
  return run;
}

/** Register interest in a range and start its first fetch. */
export function ensureCalendarRange(from: string, to: string): void {
  const key = calendarRangeKey(from, to);
  if (!entries.has(key)) setEntry(key, { events: [], loading: true });
  void loadCalendarRange(key);
}

/** Refetch every range a mounted surface is watching. */
export function refetchLiveCalendarRanges(): Promise<void> {
  const keys = [...rangeSubs.keys()];
  return Promise.all(keys.map((key) => loadCalendarRange(key, true))).then(() => undefined);
}

function settleWrite(): void {
  writesInFlight -= 1;
  if (writesInFlight <= 0) {
    writesInFlight = 0;
    if (pendingRefetch) {
      pendingRefetch = false;
      void refetchLiveCalendarRanges();
    }
  }
}

/** A `calendar:updated` push (server cache refresh, agent edit, another client). */
export function onCalendarUpdated(): void {
  if (writesInFlight > 0) { pendingRefetch = true; return; }
  if (refreshTimer) clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => {
    refreshTimer = null;
    void refetchLiveCalendarRanges();
  }, REFRESH_DEBOUNCE_MS);
}

// ── event-level mutation helpers (applied to every range that carries the id) ──

function mapEntries(fn: (events: CalendarEvent[]) => CalendarEvent[]): void {
  for (const [key, entry] of entries) {
    const next = fn(entry.events);
    if (next !== entry.events) setEntry(key, { ...entry, events: next });
  }
}

function patchEvent(id: string, patch: Partial<CalendarEvent>): void {
  mapEntries((events) =>
    events.some((e) => e.id === id)
      ? events.map((e) => (e.id === id ? { ...e, ...patch } : e))
      : events
  );
}

/** Swap in the server's canonical record (a recurring edit can change the id). */
function replaceEvent(id: string, next: CalendarEvent): void {
  mapEntries((events) => (events.some((e) => e.id === id) ? events.map((e) => (e.id === id ? next : e)) : events));
}

function dropEvent(id: string): void {
  mapEntries((events) => (events.some((e) => e.id === id) ? events.filter((e) => e.id !== id) : events));
}

/** The pre-write record per range, so a failure can restore exactly what was there. */
function captureEvent(id: string): Map<string, CalendarEvent> {
  const before = new Map<string, CalendarEvent>();
  for (const [key, entry] of entries) {
    const found = entry.events.find((e) => e.id === id);
    if (found) before.set(key, found);
  }
  return before;
}

function restoreEvent(before: Map<string, CalendarEvent>): void {
  for (const [key, event] of before) {
    const entry = entries.get(key);
    if (!entry) continue;
    const events = entry.events.some((e) => e.id === event.id)
      ? entry.events.map((e) => (e.id === event.id ? event : e))
      : [...entry.events, event];
    setEntry(key, { ...entry, events });
  }
}

function rangeCoversDay(key: string, day: string): boolean {
  const { from, to } = splitKey(key);
  return day >= from && day <= to;
}

function insertEvent(event: CalendarEvent): void {
  const day = event.start.slice(0, 10);
  for (const [key, entry] of entries) {
    if (!rangeCoversDay(key, day)) continue;
    setEntry(key, { ...entry, events: [...entry.events, event] });
  }
}

// ── write API (same call signatures the hook has always exposed) ──

/** Optimistic move/resize/retitle; rolls back to the exact previous record on failure. */
export function moveCalendarEvent(id: string, patch: { start: string; end: string; title?: string }): void {
  const before = captureEvent(id);
  patchEvent(id, { start: patch.start, end: patch.end, ...(patch.title ? { title: patch.title } : {}) });
  writesInFlight += 1;
  updateCalendarEvent(id, patch)
    .then((res) => { replaceEvent(id, res.event); })
    .catch((err) => {
      log.warn('calendar', 'event move failed, rolling back', { id, error: String(err).slice(0, 200) });
      restoreEvent(before);
    })
    .finally(settleWrite);
}

/** A chip the user can see while the POST is still in flight. */
function provisionalEvent(input: { calendarId: string; title: string; start: string; end: string; allDay?: boolean }): CalendarEvent {
  provisionalSeq += 1;
  const sibling = [...entries.values()]
    .flatMap((entry) => entry.events)
    .find((e) => e.calendarId === input.calendarId);
  const info = sourcesEntry.calendars.find((c) => c.id === input.calendarId);
  return {
    id: `pending-${provisionalSeq}`,
    source: 'eventkit',
    calendarId: input.calendarId,
    calendarName: sibling?.calendarName ?? info?.title ?? '',
    accountName: sibling?.accountName ?? info?.account ?? '',
    title: input.title,
    start: input.start,
    end: input.end,
    allDay: input.allDay ?? false,
    ...(sibling?.color ?? info?.color ? { color: sibling?.color ?? info?.color } : {}),
  };
}

export async function createCalendarEventOptimistic(
  input: { calendarId: string; title: string; start: string; end: string; allDay?: boolean },
): Promise<CalendarEvent> {
  const pending = provisionalEvent(input);
  insertEvent(pending);
  writesInFlight += 1;
  try {
    const res = await createCalendarEvent(input);
    replaceEvent(pending.id, res.event);
    return res.event;
  } catch (err) {
    dropEvent(pending.id);
    throw err;
  } finally {
    settleWrite();
  }
}

export function removeCalendarEvent(id: string): void {
  const before = captureEvent(id);
  dropEvent(id);
  writesInFlight += 1;
  deleteCalendarEvent(id)
    .catch((err) => {
      log.warn('calendar', 'event delete failed, rolling back', { id, error: String(err).slice(0, 200) });
      restoreEvent(before);
    })
    .finally(settleWrite);
}

// ── calendar visibility ──

/** Load the calendars list once; concurrent callers share the request. */
export function ensureCalendarsLoaded(force = false): Promise<CalendarInfo[]> {
  if (!force && sourcesEntry.calendarsLoaded) return Promise.resolve(sourcesEntry.calendars);
  if (calendarsInflight) return calendarsInflight;
  calendarsInflight = listCalendarSources()
    .then((res) => {
      const first = res.sources[0];
      setSources(res.sources);
      setCalendars(res.calendars, !first?.available || !first?.enabled);
      return res.calendars;
    })
    .catch((err) => {
      log.warn('calendar', 'calendars fetch failed', { error: String(err).slice(0, 200) });
      setCalendars(sourcesEntry.calendars, true);
      return sourcesEntry.calendars;
    })
    .finally(() => { calendarsInflight = null; });
  return calendarsInflight;
}

/**
 * Show or hide one external calendar. Hiding drops its chips immediately;
 * un-hiding has to ask the server for the events it never sent.
 */
export async function setCalendarHidden(calendarId: string, hidden: boolean): Promise<void> {
  const beforeEvents = hidden ? snapshotByCalendar(calendarId) : new Map<string, CalendarEvent[]>();
  const beforeCalendars = sourcesEntry.calendars;
  if (hidden) dropCalendarEvents(calendarId);
  if (beforeCalendars.length) {
    setCalendars(beforeCalendars.map((c) => (c.id === calendarId ? { ...c, hidden } : c)));
  }

  writesInFlight += 1;
  try {
    // The authoritative hidden set needs the whole list; a context-menu hide can
    // be the first thing that ever asks for it.
    const list = beforeCalendars.length ? sourcesEntry.calendars : await ensureCalendarsLoaded();
    const next = list.map((c) => (c.id === calendarId ? { ...c, hidden } : c));
    setCalendars(next);
    const hiddenIds = next.filter((c) => c.hidden).map((c) => c.id);
    if (!next.some((c) => c.id === calendarId) && hidden) hiddenIds.push(calendarId);
    await updateCalendarSource({ hidden_calendar_ids: hiddenIds, visible_calendar_ids: null });
    if (!hidden) await refetchLiveCalendarRanges();
  } catch (err) {
    log.warn('calendar', 'calendar visibility write failed, refetching', {
      calendarId, hidden, error: String(err).slice(0, 200),
    });
    if (beforeCalendars.length) setCalendars(beforeCalendars);
    restoreByCalendar(beforeEvents);
    await refetchLiveCalendarRanges();
  } finally {
    settleWrite();
  }
}

function snapshotByCalendar(calendarId: string): Map<string, CalendarEvent[]> {
  const before = new Map<string, CalendarEvent[]>();
  for (const [key, entry] of entries) {
    const mine = entry.events.filter((e) => e.calendarId === calendarId);
    if (mine.length) before.set(key, mine);
  }
  return before;
}

function dropCalendarEvents(calendarId: string): void {
  mapEntries((events) =>
    events.some((e) => e.calendarId === calendarId) ? events.filter((e) => e.calendarId !== calendarId) : events
  );
}

function restoreByCalendar(before: Map<string, CalendarEvent[]>): void {
  for (const [key, list] of before) {
    const entry = entries.get(key);
    if (!entry) continue;
    const known = new Set(entry.events.map((e) => e.id));
    const missing = list.filter((e) => !known.has(e.id));
    if (missing.length) setEntry(key, { ...entry, events: [...entry.events, ...missing] });
  }
}

/** Tests only: forget everything the store learned. */
export function __resetCalendarEventsStore(): void {
  entries.clear();
  loadedAt.clear();
  inflight.clear();
  wantsRefetch.clear();
  rangeSubs.clear();
  sourcesSubs.clear();
  sourcesEntry = { sources: [], calendars: [], calendarsLoaded: false, unavailable: false };
  calendarsInflight = null;
  writesInFlight = 0;
  pendingRefetch = false;
  provisionalSeq = 0;
  if (refreshTimer) { clearTimeout(refreshTimer); refreshTimer = null; }
}
