/**
 * CalendarService — the single owner of external calendar data.
 *
 * All consumers (the plugin's REST routes, the Personal AI calendar_* tools) go through
 * this service: a month-window TTL cache over a CalendarSource, a periodic refresh, and
 * write-through edits that refresh the touched window and announce the change so the web
 * UI reflects agent/API edits live.
 *
 * The SOURCE is not ours. It arrives from `core:calendar-source`, because the signed
 * EventKit helper carries the macOS calendar grant and a TCC identity cannot move into a
 * plugin. This file owns the cache, the clocks, the visibility rules and the config; the
 * host owns the door to the platform.
 *
 * Two separate clocks, deliberately:
 *   - READ_TTL (`read_ttl_seconds`, default 60s) bounds how stale a served read may be. It
 *     used to be the same knob as the poll interval, which meant a read could be a full 15
 *     minutes behind reality — a meeting cancelled or moved in Exchange kept showing up
 *     long after macOS knew better. Re-fetching a month window costs ~0.25s, so a short
 *     TTL is cheap.
 *   - refresh_minutes (default 15) is the BACKGROUND poll: it exists to notice changes
 *     nobody asked about and push an update to open views.
 * Callers that must not be fooled at all pass `{ force: true }`.
 */
import { createHash } from 'node:crypto';
import { bus, EventNames } from '../../core/event-bus.js';
import { getConfig } from '../../core/config-manager.js';
import { log } from '../../logging/index.js';
// The error CLASS only, from its own leaf module: importing it from sources/eventkit.js
// dragged the helper client and helper-build.js (Swift compile + codesign) into this
// bundle. The source itself arrives through `core:calendar-source`, and classification goes
// through `calendarErrorCode` (name-based), because a builtin plugin is its own bundle and
// `instanceof` does not cross that seam.
import { CalendarHelperError } from '../../core/calendar/helper-error.js';
import { calendarErrorCode } from './api.js';
import type {
  CalendarEvent,
  CalendarEventCreate,
  CalendarEventPatch,
  CalendarInfo,
  CalendarSource,
  CalendarSourceStatus,
} from './types.js';

const DEFAULT_REFRESH_MINUTES = 15;
const DEFAULT_READ_TTL_SECONDS = 60;

interface CacheEntry {
  events: CalendarEvent[];
  fetchedAt: number;
  hash: string;
}

/**
 * `plugins.calendar` in config.yaml.
 *
 * `source_enabled`, not `enabled`: `plugins.<id>.enabled` is the plugin LIFECYCLE switch
 * the store writes, so putting the calendar's own on/off flag there would mean a user
 * turning the calendar off in Settings also unregisters its routes, and the toggle that
 * would turn it back on goes with them.
 */
export interface CalendarPluginConfig {
  source_enabled?: boolean;
  hidden_calendar_ids?: string[];
  /**
   * Allowlist. `null` means CLEARED and is not the same as absent: absent falls back to the
   * legacy top-level `calendar.visible_calendar_ids` (which the migration deliberately keeps),
   * so a cleared allowlist written as `undefined` would be dropped by `yaml.dump` and the old
   * one would come back on the next read. See {@link mergeCalendarConfig}.
   */
  visible_calendar_ids?: string[] | null;
  refresh_minutes?: number;
  read_ttl_seconds?: number;
}

/** The legacy top-level `config.calendar`, read for one release. */
interface LegacyCalendarConfig extends Omit<CalendarPluginConfig, 'source_enabled'> {
  enabled?: boolean;
}

/**
 * Plugin config wins; the legacy top-level section fills the gaps.
 *
 * Both halves are read because `migrateConfigToPlugins` COPIES rather than moves: a config
 * that already had `plugins.calendar` (the store wrote `enabled` there when the user
 * toggled the plugin) never receives the copy, so the visibility lists can still only
 * exist at the top level. Delete this function, the legacy branch and the top-level
 * `calendar` key (`Config.calendar`, src/core/types.ts) and the copy block in
 * src/core/integration-loader.ts together once 0.4.6 has shipped.
 *
 * `visible_calendar_ids` is merged by PRESENCE, not by nullishness: every hide/unhide the web
 * UI performs sends `visible_calendar_ids: null` to mean "no allowlist", and a `??` here read
 * that as "nothing to say" and resurrected the legacy allowlist, so clearing it silently did
 * nothing. A present `null` therefore wins over the legacy value. `hidden_calendar_ids: []`
 * and `source_enabled: false` need no such care: neither is nullish.
 */
export function mergeCalendarConfig(
  pluginConfig: CalendarPluginConfig | undefined,
  legacy: LegacyCalendarConfig | undefined,
): CalendarPluginConfig {
  const plugin = pluginConfig ?? {};
  const old = legacy ?? {};
  return {
    source_enabled: plugin.source_enabled ?? old.enabled,
    hidden_calendar_ids: plugin.hidden_calendar_ids ?? old.hidden_calendar_ids,
    visible_calendar_ids:
      plugin.visible_calendar_ids !== undefined ? plugin.visible_calendar_ids : old.visible_calendar_ids,
    refresh_minutes: plugin.refresh_minutes ?? old.refresh_minutes,
    read_ttl_seconds: plugin.read_ttl_seconds ?? old.read_ttl_seconds,
  };
}

/**
 * Read this plugin's config straight off `getConfig()` rather than through
 * `walnut.config.get()`, which can only see `plugins.calendar`: the legacy fallback above
 * needs the top-level section too. This is a read of a file with no cache in front of it,
 * so a builtin plugin's own copy of config-manager answers the same bytes as the host's.
 * WRITES still go through `walnut.config.patch`, so there stays exactly one writer.
 */
async function readCalendarConfig(): Promise<CalendarPluginConfig> {
  const config = (await getConfig()) as {
    plugins?: Record<string, Record<string, unknown>>;
    calendar?: LegacyCalendarConfig;
  };
  return mergeCalendarConfig(
    config.plugins?.calendar as CalendarPluginConfig | undefined,
    config.calendar,
  );
}

/** What the service announces after a change. See {@link setCalendarAnnouncer}. */
export interface CalendarUpdatePayload {
  status: CalendarSourceStatus;
}

/**
 * How the service tells the world a window changed.
 *
 * Installed by the plugin's `activate` so the event rides the HOST's bus as
 * `plugin:calendar:updated` (which core forwards to the legacy `calendar:updated`). That
 * indirection is not ceremony: a builtin plugin is its own bundle, so a `bus` imported
 * here is a DIFFERENT EventBus instance from the server's in a built install, and an event
 * emitted on it would reach nobody. The direct fallback below keeps a service built
 * outside the plugin lifecycle (a unit test) observable.
 */
let announcer: ((payload: CalendarUpdatePayload) => void) | null = null;

export function setCalendarAnnouncer(fn: ((payload: CalendarUpdatePayload) => void) | null): void {
  announcer = fn;
}

function announce(payload: CalendarUpdatePayload): void {
  if (announcer) {
    announcer(payload);
    return;
  }
  bus.emit(EventNames.CALENDAR_UPDATED, payload, ['web-ui'], { source: 'calendar' });
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

  constructor(source: CalendarSource) {
    this.source = source;
  }

  /** Load config + start the periodic refresh loop. Called by activate. */
  async init(): Promise<void> {
    // A second init on the same instance would otherwise overwrite the handle and orphan
    // the first interval, which is the exact shape of the leak this slice exists to fix.
    this.stop();
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

  /**
   * Is the background poll armed?
   *
   * Exists because nothing could observe the timer, which is how it went unstopped for as
   * long as it did: `stopServer` tore the process down and left this interval polling.
   */
  refreshLoopActive(): boolean {
    return this.refreshTimer !== null;
  }

  async reloadConfig(): Promise<void> {
    const cal = await readCalendarConfig();
    const prevEnabled = this.enabled;
    const prevHidden = this.hiddenIds;
    const prevVisible = this.visibleIds;
    this.enabled = cal.source_enabled !== false;
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
   *  helper invocation. Announces an update when the window really changed. */
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
    announce({ status: this.status() });
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
      const code = calendarErrorCode(err);
      if (code) {
        // Per-EVENT failures (deleting an already-deleted event, editing a
        // readonly one) say nothing about the SOURCE's health — latching them
        // into lastError flipped available:false and silently removed the
        // Event tab + "New event…" everywhere until a manual refresh.
        if (code === 'not-found' || code === 'readonly') throw err;
        this.lastError = {
          reason: code === 'permission-denied' ? 'permission-denied' : code === 'not-configured' ? 'not-configured' : 'fetch-error',
          message: err instanceof Error ? err.message : String(err),
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

// ── the plugin's one instance ────────────────────────────────────────────────
//
// A module-level slot, not a field on the activation closure, for two reasons: the routes
// and tools resolve it PER CALL (a test may swap the instance between requests while the
// server stays up), and the fixture seam below has to be able to put an instance in place
// before the plugin activates so activate never builds one over the real EventKit helper.

let service: CalendarService | null = null;

/**
 * activate's entry: adopt whatever is already in the slot, else build one over the host's
 * source. `createSource` is a factory, not a value, so the EventKit helper is never
 * constructed when a fixture already supplied a mock.
 */
export function adoptCalendarService(createSource: () => CalendarSource): CalendarService {
  if (!service) service = new CalendarService(createSource());
  return service;
}

/**
 * The live instance, resolved per request and per tool call.
 *
 * A helper error rather than a plain throw: a request already in flight when the plugin is
 * torn down (the Disposable runs before the route registrations are withdrawn) then answers
 * 503 "not configured" like any other unavailable source, instead of a bare 500.
 */
export function getCalendarService(): CalendarService {
  if (!service) throw new CalendarHelperError('the calendar plugin is not active', 'not-configured');
  return service;
}

/**
 * deactivate's exit: stop the loop and clear the slot, so a reload builds a fresh service
 * and re-runs init() instead of adopting one whose timer is already stopped.
 *
 * Consequence worth knowing before you test a reload: the fresh service is built over the
 * HOST's real EventKit source, so a fixture that injected a mock before boot has to inject
 * again after a reload or the next read compiles the Swift helper and reads real calendars.
 */
export function releaseCalendarService(instance: CalendarService): void {
  instance.stop();
  if (service === instance) service = null;
}

/** Test hook: swap in a service over a mock source, before or after activate. */
export function _setCalendarServiceForTest(s: CalendarService | null): void {
  if (service !== s) service?.stop();
  service = s;
}
