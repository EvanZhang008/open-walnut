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
import { calendarEventNeedsApproval } from './types.js';
import type {
  CalendarWriteOptions,
  CalendarEvent,
  CalendarEventCreateInput,
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
  /** Single events hidden in Walnut by exact id (an occurrence id hides one occurrence). Plugin-only. */
  hidden_event_ids?: string[];
  /**
   * Where a create with no calendar id goes. `''` means CLEARED (written by Settings), which
   * wins over a legacy top-level value the same way a `null` allowlist does. See
   * {@link CalendarService.defaultCalendar} for what makes a configured id usable.
   */
  default_calendar_id?: string | null;
  refresh_minutes?: number;
  read_ttl_seconds?: number;
}

/**
 * The configured default calendar, checked against the calendars macOS has right now.
 *
 * `id` is the calendar a create with no calendar id goes to, or null when there is none.
 * A configured id that is gone or read-only is NOT replaced by some other calendar: the
 * create is refused with `warning` instead, because guessing is how agent-made blocks kept
 * landing on a work calendar.
 */
export interface CalendarDefaultState {
  id: string | null;
  /** What config.yaml says, or null when nothing is set. */
  configuredId: string | null;
  title?: string;
  account?: string;
  /** Set when a configured id cannot be used; says why and what to do. */
  warning?: string;
}

/** The legacy top-level `config.calendar`, read for one release. */
interface LegacyCalendarConfig extends Omit<CalendarPluginConfig, 'source_enabled' | 'hidden_event_ids'> {
  enabled?: boolean;
}

/** The HOST's `walnut.config.patch`: this bundle's own config-manager copy would hold a second write lock. */
export type CalendarConfigPatcher = (patch: Record<string, unknown>) => Promise<void>;

export interface CalendarEventVisibility {
  id: string;
  hidden: boolean;
  changed: boolean;
}

function idList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((v): v is string => typeof v === 'string' && v.length > 0);
}

const MAX_EVENT_ID_LENGTH = 1024;

function assertEventId(id: unknown): string {
  if (typeof id !== 'string' || id.trim() === '') throw new CalendarHelperError('event id is required', 'usage');
  if (id.length > MAX_EVENT_ID_LENGTH) throw new CalendarHelperError('event id is too long', 'usage');
  return id;
}

/** Local start day of an occurrence id "<ekid>#<epochSeconds>" (walnut-calendar.swift `eventJson`); null for one-off ids. */
function occurrenceDay(id: string): string | null {
  const match = /^.+#(\d{1,10})$/.exec(id);
  if (!match) return null;
  const date = new Date(Number(match[1]) * 1000);
  if (Number.isNaN(date.getTime())) return null;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
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
    hidden_event_ids: idList(plugin.hidden_event_ids),
    // By presence, like the allowlist: Settings clears it by writing '' into the plugin
    // section, and that has to win over an id still sitting in the legacy section.
    default_calendar_id:
      plugin.default_calendar_id !== undefined ? plugin.default_calendar_id : old.default_calendar_id,
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
      JSON.stringify([e.id, e.title, e.start, e.end, e.calendarId, e.status, e.selfStatus,
        e.readonly, e.walnutCreated, e.hasAttendees, e.organizerIsCurrentUser, e.organizerName,
        e.recurring, e.writeSafetyVersion])
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
  private hiddenEventIds = new Set<string>();
  /** `default_calendar_id` from config, trimmed; null when unset or cleared. */
  private defaultCalendarId: string | null = null;
  /** Last unusable-default warning logged, so a poll does not log it on every read. */
  private loggedDefaultWarning: string | null = null;
  /** Serializes hide/show read-patch-reload so two writers never drop each other's id; never rejects. */
  private visibilityTail: Promise<void> = Promise.resolve();
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
    const prevHiddenEvents = this.hiddenEventIds;
    this.enabled = cal.source_enabled !== false;
    this.hiddenIds = new Set(cal.hidden_calendar_ids ?? []);
    this.visibleIds = cal.visible_calendar_ids ? new Set(cal.visible_calendar_ids) : null;
    this.hiddenEventIds = new Set(cal.hidden_event_ids ?? []);
    const configuredDefault = typeof cal.default_calendar_id === 'string' ? cal.default_calendar_id.trim() : '';
    this.defaultCalendarId = configuredDefault || null;
    this.refreshMinutes = Math.max(1, cal.refresh_minutes ?? DEFAULT_REFRESH_MINUTES);
    // 0 is legal and means "never serve from cache" (every read re-fetches).
    this.readTtlMs = Math.max(0, cal.read_ttl_seconds ?? DEFAULT_READ_TTL_SECONDS) * 1000;
    // Visibility is applied at read time (cache keeps everything), so a toggle
    // never changes the cache hash — announce it explicitly or the UI would
    // only notice on its next unrelated refetch.
    const setChanged = (a: Set<string> | null, b: Set<string> | null) =>
      (a === null) !== (b === null) || (a && b && (a.size !== b.size || [...b].some((id) => !a.has(id))));
    if (
      prevEnabled !== this.enabled ||
      setChanged(prevHidden, this.hiddenIds) ||
      setChanged(prevVisible, this.visibleIds) ||
      setChanged(prevHiddenEvents, this.hiddenEventIds)
    )
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
    return cals.map((c) => ({
      ...c,
      hidden: this.isHidden(c.id),
      ...(c.id === this.defaultCalendarId && !c.readonly ? { default: true } : {}),
    }));
  }

  /**
   * The configured default checked against `calendars` (a list the caller already holds, so
   * GET /sources adds no helper call). Never picks a replacement: an unusable configured id
   * comes back as `id: null` plus a warning, and a create without a calendar id is refused.
   * A hidden calendar is still a valid default; the user chose it on purpose.
   */
  describeDefault(calendars: CalendarInfo[]): CalendarDefaultState {
    const configuredId = this.defaultCalendarId;
    if (!configuredId) return { id: null, configuredId: null };
    const cal = calendars.find((c) => c.id === configuredId);
    const problem = !cal
      ? 'The default calendar is not on this Mac any more (it was deleted, or its account was removed).'
      : cal.readonly
        ? `The default calendar "${cal.title}" (${cal.account}) is read-only.`
        : null;
    if (!problem) {
      this.loggedDefaultWarning = null;
      return { id: configuredId, configuredId, title: cal!.title, account: cal!.account };
    }
    if (this.loggedDefaultWarning !== problem) {
      this.loggedDefaultWarning = problem;
      log.calendar.warn('default calendar unusable, creates without a calendar id are refused', { configuredId, problem });
    }
    return {
      id: null,
      configuredId,
      ...(cal ? { title: cal.title, account: cal.account } : {}),
      warning: `${problem} Pick another in Settings → Calendar Accounts → Default calendar.`,
    };
  }

  /** What config says, unchecked (null when unset). */
  configuredDefaultId(): string | null {
    return this.defaultCalendarId;
  }

  /** {@link describeDefault} over a fresh calendar list; no helper call when nothing is set. */
  async defaultCalendar(): Promise<CalendarDefaultState> {
    if (!this.defaultCalendarId) return { id: null, configuredId: null };
    return this.describeDefault(await this.listCalendars());
  }

  /** Events within [from, to] (inclusive day strings), served from cache when it
   *  is younger than READ_TTL. `force` skips the cache entirely — for callers
   *  that would rather wait ~0.25s than report a cancelled meeting as live.
   *  Hidden-calendar filtering happens HERE, not in the source: the cache
   *  keeps everything, so toggling visibility applies on the next read with
   *  no refetch. `includeHidden` marks single hidden events instead of dropping them. */
  async getEvents(from: string, to: string, opts?: { force?: boolean; includeHidden?: boolean }): Promise<CalendarEvent[]> {
    if (!this.enabled || !this.source.available().ok) return [];
    const includeHidden = opts?.includeHidden === true;
    const key = windowKey(from, to);
    const cached = this.cache.get(key);
    if (!opts?.force && cached && Date.now() - cached.fetchedAt < this.readTtlMs) {
      return this.visible(filterRange(cached.events, from, to), includeHidden);
    }
    const events = await this.fetchWindow(key, from, to);
    return this.visible(filterRange(events, from, to), includeHidden);
  }

  /** Hide/show one event in Walnut only (config, never the source). Idempotent; showing accepts any id. */
  async setEventHidden(id: string, hidden: boolean, patchConfig: CalendarConfigPatcher): Promise<CalendarEventVisibility> {
    const eventId = assertEventId(id);
    if (typeof hidden !== 'boolean') throw new CalendarHelperError('hidden must be true or false', 'usage');
    const run = this.visibilityTail.then(() => this.applyEventHidden(eventId, hidden, patchConfig));
    this.visibilityTail = run.then(() => undefined, () => undefined);
    return run;
  }

  private async applyEventHidden(id: string, hidden: boolean, patchConfig: CalendarConfigPatcher): Promise<CalendarEventVisibility> {
    const current = (await readCalendarConfig()).hidden_event_ids ?? [];
    if (current.includes(id) === hidden) {
      await this.reloadConfig(); // the file is the truth even when nothing is written
      return { id, hidden, changed: false };
    }
    if (hidden) await this.assertEventExists(id);
    const next = hidden ? [...current, id] : current.filter((existing) => existing !== id);
    await patchConfig({ hidden_event_ids: next });
    await this.reloadConfig();
    return { id, hidden, changed: true };
  }

  /** Bounded: any cached window, else the one month an occurrence id names; an uncached one-off id is a usage error (no read-by-id, never scan). */
  private async assertEventExists(id: string): Promise<void> {
    for (const entry of this.cache.values()) {
      if (entry.events.some((e) => e.id === id)) return;
    }
    if (this.source.getEvent) {
      await this.source.getEvent(id);
      return;
    }
    const day = occurrenceDay(id);
    if (!day) {
      throw new CalendarHelperError(
        `event ${id} is not in any date range Walnut has loaded; query the range that holds it first (calendar_query or GET /events), then hide it`,
        'usage',
      );
    }
    this.assertUsable();
    const events = await this.fetchWindow(windowKey(day, day), day, day);
    if (!events.some((e) => e.id === id)) throw new CalendarHelperError(`event not found: ${id}`, 'not-found');
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

  /** Hidden calendars always filter; hidden events are dropped, or marked on a copy when `includeHidden`. */
  private visible(events: CalendarEvent[], includeHidden = false): CalendarEvent[] {
    const shown =
      this.hiddenIds.size === 0 && !this.visibleIds ? events : events.filter((e) => !this.isHidden(e.calendarId));
    if (this.hiddenEventIds.size === 0) return shown;
    if (!includeHidden) return shown.filter((e) => !this.hiddenEventIds.has(e.id));
    return shown.map((e) => (this.hiddenEventIds.has(e.id) ? { ...e, hidden: true } : e));
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

  private async guardWrite(id: string, opts?: CalendarWriteOptions): Promise<void> {
    if (!this.source.getEvent) throw new CalendarHelperError('Calendar write safety is unavailable. Use Hide event instead.', 'human-approval-required');
    const event = await this.source.getEvent(assertEventId(id));
    if (event.readonly) throw new CalendarHelperError('calendar is read-only', 'readonly');
    if (calendarEventNeedsApproval(event) && opts?.humanConfirm !== true) {
      throw new CalendarHelperError(`\"${event.title}\"${event.recurring ? ' belongs to a recurring series' : ' is not a private Walnut-created block'}. This change may affect the whole series and notify the organizer. Use Hide event instead, or ask the user to confirm in Calendar.`, 'human-approval-required');
    }
  }

  // Writes are NOT wrapped in trackErrors: a write can go to a different program than the
  // reads (the current helper while an older Walnut.app serves reads, see eventkit.ts
  // runSafeWrite), so a write refused for want of a grant says nothing about whether reads
  // work. Latching it flipped the source to unavailable and took the calendar view down.

  /** Moves or renames in place: an event never changes calendar here, whatever the default is. */
  async updateEvent(id: string, patch: CalendarEventPatch, opts?: CalendarWriteOptions): Promise<CalendarEvent> {
    this.assertUsable();
    await this.guardWrite(id, opts);
    // Only the fields an update may carry: nothing a caller adds can move it to another calendar.
    const event = await this.source.updateEvent(id, {
      start: patch.start,
      end: patch.end,
      ...(patch.title !== undefined ? { title: patch.title } : {}),
    }, opts);
    await this.writeThrough();
    return event;
  }

  /** No `calendarId` (absent or blank) creates on the configured default calendar. */
  async createEvent(input: CalendarEventCreateInput): Promise<CalendarEvent> {
    this.assertUsable();
    const calendarId = await this.createTarget(input.calendarId);
    const event = await this.source.createEvent({ ...input, calendarId });
    await this.writeThrough();
    return event;
  }

  private async createTarget(explicit: string | undefined): Promise<string> {
    if (typeof explicit === 'string' && explicit.trim()) return explicit;
    const state = await this.defaultCalendar();
    if (state.id) return state.id;
    throw new CalendarHelperError(
      state.warning
        ? `${state.warning} Or pass a calendar id.`
        : 'No default calendar is set. Pass a calendar id (calendar_query with list_calendars:true lists them), or ask the user to pick a default in Settings → Calendar Accounts → Default calendar.',
      'usage',
    );
  }

  async deleteEvent(id: string, opts?: CalendarWriteOptions): Promise<void> {
    this.assertUsable();
    await this.guardWrite(id, opts);
    await this.source.deleteEvent(id, opts);
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
        // A read that worked: the one place a write path may clear a stale read failure.
        this.lastError = null;
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
        if (code === 'not-found' || code === 'readonly' || code === 'human-approval-required' || code === 'approval-canceled') throw err;
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
