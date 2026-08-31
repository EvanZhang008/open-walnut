/**
 * CalendarService — the single owner of external calendar data.
 *
 * All consumers (REST routes, Personal AI calendar_* tools) go through this
 * service: a month-window TTL cache over the EventKit source, a periodic
 * refresh, and write-through edits that refresh the touched window and emit
 * `calendar:updated` so the web UI reflects agent/API edits live.
 *
 * Two separate clocks, deliberately:
 *   - READ_TTL (`calendar.read_ttl_seconds`, default 60s) bounds how stale a
 *     served read may be. It used to be the same knob as the poll interval,
 *     which meant a read could be a full 15 minutes behind reality — a meeting
 *     cancelled or moved in Exchange kept showing up long after macOS knew
 *     better. Re-fetching a month window costs ~0.25s, so a short TTL is cheap.
 *   - refresh_minutes (default 15) is the BACKGROUND poll: it exists to notice
 *     changes nobody asked about and push `calendar:updated` to open views.
 * Callers that must not be fooled at all pass `{ force: true }`.
 */
import { createHash } from 'node:crypto';
import { bus, EventNames } from '../event-bus.js';
import { getConfig } from '../config-manager.js';
import { log } from '../../logging/index.js';
import { createEventKitSource, CalendarHelperError } from './sources/eventkit.js';
import type {
  CalendarEvent,
  CalendarEventCreate,
  CalendarEventPatch,
  CalendarInfo,
  CalendarSource,
  CalendarSourceStatus,
} from './types.js';

export { CalendarHelperError } from './sources/eventkit.js';
export type * from './types.js';

const DEFAULT_REFRESH_MINUTES = 15;
const DEFAULT_READ_TTL_SECONDS = 60;

interface CacheEntry {
  events: CalendarEvent[];
  fetchedAt: number;
  hash: string;
}

interface CalendarConfigShape {
  enabled?: boolean;
  hidden_calendar_ids?: string[];
  visible_calendar_ids?: string[];
  refresh_minutes?: number;
  read_ttl_seconds?: number;
}

function eventsHash(events: CalendarEvent[]): string {
  const h = createHash('sha1');
  // status/selfStatus are part of the identity: a meeting being cancelled often
  // changes nothing else, and leaving them out meant open views never heard.
  for (const e of events)
    h.update(
      `${e.id}|${e.title}|${e.start}|${e.end}|${e.calendarId}|${e.status ?? ''}|${e.selfStatus ?? ''};`
    );
  return h.digest('hex');
}

/** Month-aligned cache window containing [from, to] (day strings). */
function windowKey(from: string, to: string): string {
  return `${from.slice(0, 7)}..${to.slice(0, 7)}`;
}

function windowRange(from: string, to: string): { from: string; to: string } {
  const [fy, fm] = [Number(from.slice(0, 4)), Number(from.slice(5, 7))];
  const [ty, tm] = [Number(to.slice(0, 4)), Number(to.slice(5, 7))];
  const pad = (n: number) => String(n).padStart(2, '0');
  const lastDay = new Date(ty, tm, 0).getDate(); // day 0 of next month = last of `tm`
  return { from: `${fy}-${pad(fm)}-01`, to: `${ty}-${pad(tm)}-${pad(lastDay)}` };
}

export class CalendarService {
  private source: CalendarSource;
  private cache = new Map<string, CacheEntry>();
  private refreshTimer: NodeJS.Timeout | null = null;
  private hiddenIds = new Set<string>();
  /** When non-null, ONLY these ids are visible (allowlist); hiddenIds still applies on top. */
  private visibleIds: Set<string> | null = null;
  private enabled = true;
  private refreshMinutes = DEFAULT_REFRESH_MINUTES;
  private readTtlMs = DEFAULT_READ_TTL_SECONDS * 1000;
  /** In-flight fetch per window, so N concurrent readers (web + iOS + agent)
   *  hitting an expired window spawn ONE helper process, not N. */
  private inFlight = new Map<string, Promise<CalendarEvent[]>>();
  private lastRefresh: string | undefined;
  private lastError: { reason: CalendarSourceStatus['reason']; message: string } | null = null;

  constructor(source?: CalendarSource) {
    this.source = source ?? createEventKitSource();
  }

  /** Load config + start the periodic refresh loop. Call once at boot. */
  async init(): Promise<void> {
    await this.reloadConfig();
    if (!this.source.available().ok) return; // nothing to poll
    this.refreshTimer = setInterval(
      () => {
        this.refreshAll().catch((err) =>
          log.calendar.warn('periodic refresh failed', { error: String(err).slice(0, 200) })
        );
      },
      this.refreshMinutes * 60_000
    );
    this.refreshTimer.unref?.();
  }

  stop(): void {
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    this.refreshTimer = null;
  }

  async reloadConfig(): Promise<void> {
    const config = (await getConfig()) as { calendar?: CalendarConfigShape };
    const cal = config.calendar ?? {};
    const prevEnabled = this.enabled;
    const prevHidden = this.hiddenIds;
    const prevVisible = this.visibleIds;
    this.enabled = cal.enabled !== false;
    this.hiddenIds = new Set(cal.hidden_calendar_ids ?? []);
    this.visibleIds = cal.visible_calendar_ids ? new Set(cal.visible_calendar_ids) : null;
    this.refreshMinutes = Math.max(1, cal.refresh_minutes ?? DEFAULT_REFRESH_MINUTES);
    // 0 is legal and means "never serve from cache" (every read re-fetches).
    this.readTtlMs = Math.max(0, cal.read_ttl_seconds ?? DEFAULT_READ_TTL_SECONDS) * 1000;
    // Visibility is applied at read time (cache keeps everything), so a toggle
    // never changes the cache hash — announce it explicitly or the UI would
    // only notice on its next unrelated refetch.
    const setChanged = (a: Set<string> | null, b: Set<string> | null) =>
      (a === null) !== (b === null) || (a && b && (a.size !== b.size || [...b].some((id) => !a.has(id))));
    if (prevEnabled !== this.enabled || setChanged(prevHidden, this.hiddenIds) || setChanged(prevVisible, this.visibleIds))
      this.emitUpdated();
  }

  status(): CalendarSourceStatus {
    const avail = this.source.available();
    if (!this.enabled) {
      return { id: this.source.id, available: avail.ok, enabled: false, reason: 'disabled' };
    }
    if (!avail.ok) {
      return { id: this.source.id, available: false, enabled: true, reason: avail.reason, message: avail.message };
    }
    if (this.lastError) {
      return {
        id: this.source.id,
        available: false,
        enabled: true,
        reason: this.lastError.reason,
        message: this.lastError.message,
        lastRefresh: this.lastRefresh,
      };
    }
    let count = 0;
    for (const entry of this.cache.values()) count += entry.events.length;
    // Available but degraded is its own state: reads work, yet something the user
    // has to fix is silently propping them up. Reporting only available:true would
    // hide it forever (nothing else ever mentions it again).
    const degraded = this.source.degraded?.();
    return {
      id: this.source.id,
      available: true,
      enabled: true,
      ...(degraded ? { degraded } : {}),
      lastRefresh: this.lastRefresh,
      eventCount: count,
    };
  }

  async listCalendars(): Promise<CalendarInfo[]> {
    this.assertUsable();
    // The service owns the hidden/visible sets (config) — overlay them here so
    // every source (incl. test mocks) reports visibility consistently.
    const cals = await this.trackErrors(() => this.source.listCalendars());
    return cals.map((c) => ({ ...c, hidden: this.isHidden(c.id) }));
  }

  /** Events within [from, to] (inclusive day strings), served from cache when it
   *  is younger than READ_TTL. `force` skips the cache entirely — for callers
   *  that would rather wait ~0.25s than report a cancelled meeting as live.
   *  Hidden-calendar filtering happens HERE, not in the source: the cache
   *  keeps everything, so toggling visibility applies on the next read with
   *  no refetch. */
  async getEvents(from: string, to: string, opts?: { force?: boolean }): Promise<CalendarEvent[]> {
    if (!this.enabled || !this.source.available().ok) return [];
    const key = windowKey(from, to);
    const cached = this.cache.get(key);
    if (!opts?.force && cached && Date.now() - cached.fetchedAt < this.readTtlMs) {
      return this.visible(filterRange(cached.events, from, to));
    }
    const events = await this.fetchWindow(key, from, to);
    return this.visible(filterRange(events, from, to));
  }

  /** Fetch + cache one month window, collapsing concurrent callers onto a single
   *  helper invocation. Emits `calendar:updated` when the window really changed. */
  private async fetchWindow(key: string, from: string, to: string): Promise<CalendarEvent[]> {
    const pending = this.inFlight.get(key);
    if (pending) return pending;
    const window = windowRange(from, to);
    const task = (async () => {
      const before = this.cache.get(key);
      const events = await this.trackErrors(() => this.source.listEvents(window.from, window.to));
      const hash = eventsHash(events);
      const changed = before?.hash !== hash;
      this.cache.set(key, { events, fetchedAt: Date.now(), hash });
      this.lastRefresh = new Date().toISOString();
      if (changed && before) this.emitUpdated();
      return events;
    })();
    this.inFlight.set(key, task);
    try {
      return await task;
    } finally {
      this.inFlight.delete(key);
    }
  }

  /** Allowlist (when set) wins first, then the denylist applies on top. */
  private isHidden(calendarId: string): boolean {
    if (this.visibleIds && !this.visibleIds.has(calendarId)) return true;
    return this.hiddenIds.has(calendarId);
  }

  private visible(events: CalendarEvent[]): CalendarEvent[] {
    if (this.hiddenIds.size === 0 && !this.visibleIds) return events;
    return events.filter((e) => !this.isHidden(e.calendarId));
  }

  /** Re-fetch every cached window (periodic refresh / manual refresh). Asks the
   *  source to pull from the remote accounts first — that pull is asynchronous
   *  inside macOS, so it freshens the poll after this one, not this one. */
  async refreshAll(): Promise<void> {
    if (!this.enabled || !this.source.available().ok) return;
    let anyChanged = false;
    for (const [key, entry] of this.cache) {
      const [fromMonth, toMonth] = key.split('..');
      const window = windowRange(`${fromMonth}-01`, `${toMonth}-01`);
      try {
        const events = await this.trackErrors(() =>
          this.source.listEvents(window.from, window.to, { refresh: true })
        );
        const hash = eventsHash(events);
        if (hash !== entry.hash) anyChanged = true;
        this.cache.set(key, { events, fetchedAt: Date.now(), hash });
      } catch (err) {
        log.calendar.warn('window refresh failed', { key, error: String(err).slice(0, 200) });
      }
    }
    this.lastRefresh = new Date().toISOString();
    if (anyChanged) this.emitUpdated();
  }

  async updateEvent(id: string, patch: CalendarEventPatch): Promise<CalendarEvent> {
    this.assertUsable();
    const event = await this.trackErrors(() => this.source.updateEvent(id, patch));
    await this.writeThrough();
    return event;
  }

  async createEvent(input: CalendarEventCreate): Promise<CalendarEvent> {
    this.assertUsable();
    const event = await this.trackErrors(() => this.source.createEvent(input));
    await this.writeThrough();
    return event;
  }

  async deleteEvent(id: string): Promise<void> {
    this.assertUsable();
    await this.trackErrors(() => this.source.deleteEvent(id));
    await this.writeThrough();
  }

  /** After a write: refresh cached windows so reads see it, then notify UIs. */
  private async writeThrough(): Promise<void> {
    for (const [key] of this.cache) {
      const [fromMonth, toMonth] = key.split('..');
      const window = windowRange(`${fromMonth}-01`, `${toMonth}-01`);
      try {
        const events = await this.source.listEvents(window.from, window.to);
        this.cache.set(key, { events, fetchedAt: Date.now(), hash: eventsHash(events) });
      } catch {
        this.cache.delete(key); // stale after a write — better a miss than a lie
      }
    }
    this.emitUpdated();
  }

  private emitUpdated(): void {
    bus.emit(EventNames.CALENDAR_UPDATED, { status: this.status() }, ['web-ui'], { source: 'calendar' });
  }

  private assertUsable(): void {
    if (!this.enabled) throw new CalendarHelperError('calendar source is disabled', 'disabled');
    const avail = this.source.available();
    if (!avail.ok) throw new CalendarHelperError(avail.message ?? 'calendar unavailable', avail.reason ?? 'not-configured');
  }

  /** Record permission/fetch failures so status() explains what's wrong. */
  private async trackErrors<T>(fn: () => Promise<T>): Promise<T> {
    try {
      const result = await fn();
      this.lastError = null;
      return result;
    } catch (err) {
      if (err instanceof CalendarHelperError) {
        // Per-EVENT failures (deleting an already-deleted event, editing a
        // readonly one) say nothing about the SOURCE's health — latching them
        // into lastError flipped available:false and silently removed the
        // Event tab + "New event…" everywhere until a manual refresh.
        if (err.code === 'not-found' || err.code === 'readonly') throw err;
        this.lastError = {
          reason: err.code === 'permission-denied' ? 'permission-denied' : err.code === 'not-configured' ? 'not-configured' : 'fetch-error',
          message: err.message,
        };
      }
      throw err;
    }
  }
}

function filterRange(events: CalendarEvent[], from: string, to: string): CalendarEvent[] {
  return events.filter((e) => {
    const startDay = e.start.slice(0, 10);
    const endDay = e.end ? e.end.slice(0, 10) : startDay;
    return startDay <= to && endDay >= from;
  });
}

// ── singleton ────────────────────────────────────────────────────────────────

let service: CalendarService | null = null;

export function getCalendarService(): CalendarService {
  if (!service) service = new CalendarService();
  return service;
}

/** Test hook: swap in a mock source. */
export function _setCalendarServiceForTest(s: CalendarService | null): void {
  service?.stop();
  service = s;
}
