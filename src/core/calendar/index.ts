/**
 * CalendarService — the single owner of external calendar data.
 *
 * All consumers (REST routes, butler calendar_* tools) go through this
 * service: a month-window TTL cache over the EventKit source, a periodic
 * refresh, and write-through edits that refresh the touched window and emit
 * `calendar:updated` so the web UI reflects agent/API edits live.
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

interface CacheEntry {
  events: CalendarEvent[];
  fetchedAt: number;
  hash: string;
}

interface CalendarConfigShape {
  enabled?: boolean;
  hidden_calendar_ids?: string[];
  refresh_minutes?: number;
}

function eventsHash(events: CalendarEvent[]): string {
  const h = createHash('sha1');
  for (const e of events) h.update(`${e.id}|${e.title}|${e.start}|${e.end}|${e.calendarId};`);
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
  private enabled = true;
  private refreshMinutes = DEFAULT_REFRESH_MINUTES;
  private lastRefresh: string | undefined;
  private lastError: { reason: CalendarSourceStatus['reason']; message: string } | null = null;

  constructor(source?: CalendarSource) {
    this.source = source ?? createEventKitSource({ hiddenCalendarIds: () => this.hiddenIds });
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
    this.enabled = cal.enabled !== false;
    this.hiddenIds = new Set(cal.hidden_calendar_ids ?? []);
    this.refreshMinutes = Math.max(1, cal.refresh_minutes ?? DEFAULT_REFRESH_MINUTES);
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
    return {
      id: this.source.id,
      available: true,
      enabled: true,
      lastRefresh: this.lastRefresh,
      eventCount: count,
    };
  }

  async listCalendars(): Promise<CalendarInfo[]> {
    this.assertUsable();
    return this.trackErrors(() => this.source.listCalendars());
  }

  /** Events within [from, to] (inclusive day strings), served from cache. */
  async getEvents(from: string, to: string, opts?: { force?: boolean }): Promise<CalendarEvent[]> {
    if (!this.enabled || !this.source.available().ok) return [];
    const key = windowKey(from, to);
    const cached = this.cache.get(key);
    const ttlMs = this.refreshMinutes * 60_000;
    if (!opts?.force && cached && Date.now() - cached.fetchedAt < ttlMs) {
      return filterRange(cached.events, from, to);
    }
    const window = windowRange(from, to);
    const events = await this.trackErrors(() => this.source.listEvents(window.from, window.to));
    const hash = eventsHash(events);
    const changed = cached?.hash !== hash;
    this.cache.set(key, { events, fetchedAt: Date.now(), hash });
    this.lastRefresh = new Date().toISOString();
    if (changed && cached) this.emitUpdated();
    return filterRange(events, from, to);
  }

  /** Re-fetch every cached window (periodic refresh / manual refresh). */
  async refreshAll(): Promise<void> {
    if (!this.enabled || !this.source.available().ok) return;
    let anyChanged = false;
    for (const [key, entry] of this.cache) {
      const [fromMonth, toMonth] = key.split('..');
      const window = windowRange(`${fromMonth}-01`, `${toMonth}-01`);
      try {
        const events = await this.trackErrors(() => this.source.listEvents(window.from, window.to));
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
