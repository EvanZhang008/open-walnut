/**
 * CalendarService — the single owner of external calendar data.
 *
 * All consumers (the plugin's REST routes, the Personal AI calendar_* tools) go through
 * this service: a month-window TTL cache over the calendar's sources (source-set.ts), a
 * periodic refresh, and write-through edits that refresh the cached windows and announce the
 * change so the web UI reflects agent/API edits live.
 *
 * The Mac's SOURCE arrives from `core:calendar-source`, because the signed EventKit helper
 * carries the macOS calendar grant and a TCC identity cannot move into a plugin.
 *
 * Two separate clocks, deliberately:
 *   - READ_TTL (`read_ttl_seconds`, default 60s) bounds how stale a served read may be (it
 *     once shared the poll's 15 minutes, and a moved meeting kept showing long after macOS
 *     knew better). Re-fetching a month window costs ~0.25s, so a short TTL is cheap.
 *   - refresh_minutes (default 15) is the BACKGROUND poll, to notice changes nobody asked
 *     about and push an update to open views.
 * Callers that must not be fooled at all pass `{ force: true }`.
 */
import { log } from '../../logging/index.js';
import { accountDoorsGuarded, assertOutwardDoor } from '../../core/leader/switch/doors.js';
// The error CLASS only, from its own leaf module: importing it from sources/eventkit.js
// dragged the helper client and helper-build.js (Swift compile + codesign) into this
// bundle. The source itself arrives through `core:calendar-source`, and classification goes
// through `calendarErrorCode` (name-based), because a builtin plugin is its own bundle and
// `instanceof` does not cross that seam.
import { CalendarHelperError } from '../../core/calendar/helper-error.js';
import {
  activeMailCalendarAccounts,
  mailCalendarsOn,
  readCalendarConfig,
  readExperimentalFlags,
  type CalendarConfigPatcher,
} from './config.js';
import { CalendarSourceSet, type SourceMember } from './source-set.js';
import { announce } from './announce.js';
import { describeDefaultCalendar, type CalendarDefaultState } from './default-calendar.js';
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
import { assertEventId, eventsHash, filterRange, occurrenceDay, windowKey, windowOfKey, windowRange } from './windows.js';

// Moved to their own modules; their importers keep this path.
export { mergeCalendarConfig, type CalendarPluginConfig, type CalendarConfigPatcher } from './config.js';
export { setCalendarAnnouncer, type CalendarUpdatePayload } from './announce.js';
export type { CalendarDefaultState } from './default-calendar.js';

const DEFAULT_REFRESH_MINUTES = 15;
/** A cache window's read key (for a mail account's late answer), and back. */
const lateKey = (key: string) => { const w = windowOfKey(key); return `${w.from}|${w.to}`; };
const windowOf = (late: string) => late.split('|') as [string, string];
const DEFAULT_READ_TTL_SECONDS = 60;

interface CacheEntry {
  events: CalendarEvent[];
  fetchedAt: number;
  hash: string;
}

export interface CalendarEventVisibility {
  id: string;
  hidden: boolean;
  changed: boolean;
}

/** Builds the source for one mail account's calendar (`imap:<id>`). Installed by activate. */
export type MailCalendarSourceFactory = (mailAccountId: string) => CalendarSource;

export class CalendarService {
  /** The Mac's source (first) and one per mail account whose calendar is read (source-set.ts). */
  private sources: CalendarSourceSet;
  private mailFactory: MailCalendarSourceFactory | null = null;
  /** Built once per mail account and kept, so its discovery and calendar list survive reloads. */
  private mailSources = new Map<string, CalendarSource>();
  private cache = new Map<string, CacheEntry>();
  private refreshTimer: NodeJS.Timeout | null = null;
  private initialised = false;
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
  /** In-flight fetch per window: N concurrent readers of an expired window spawn ONE helper run. */
  private inFlight = new Map<string, Promise<CalendarEvent[]>>();
  private lastRefresh: string | undefined;
  /** Moves when a write starts and when its write-through starts. A list that began before a move
   *  may predate the write, so it never goes into the cache (2026-11-21: a load in flight across
   *  a create cached the list without it, and the new event vanished from the grid for a minute). */
  private writeGen = 0;
  /** The `mail_calendars` experiment as the last reload read it. */
  private mailOn = false;

  constructor(source: CalendarSource, options: { extraReadDeadlineMs?: number } = {}) {
    this.sources = new CalendarSourceSet(source, {
      ...options,
      // A mail account's late answer is kept by the set: let every view read again.
      onLateResult: () => {
        for (const entry of this.cache.values()) entry.fetchedAt = 0;
        this.emitUpdated();
      },
    });
  }

  /** How a mail account's calendar source is built; null (the default) reads only the Mac's. */
  setMailCalendarSourceFactory(factory: MailCalendarSourceFactory | null): void {
    this.mailFactory = factory;
    this.mailSources.clear();
  }

  /** A source for a mail account not read yet ("Add its calendar" tries it); `adopt` keeps it for the next reload. */
  mailCalendarCandidate(mailAccountId: string): { source: CalendarSource; adopt: () => void } | null {
    if (!this.mailFactory) return null;
    const source = this.mailSources.get(mailAccountId) ?? this.mailFactory(mailAccountId);
    return { source, adopt: () => { this.mailSources.set(mailAccountId, source); } };
  }

  /** Load config + start the periodic refresh loop. Called by activate. */
  async init(): Promise<void> {
    this.stop(); // a second init must not orphan the first interval
    this.initialised = true;
    await this.reloadConfig();
    this.armLoop();
  }

  /** Arms the poll when some source can be read and none is armed (a mail calendar added later). */
  private armLoop(): void {
    if (!this.initialised || this.refreshTimer) return;
    if (this.sources.usable().length === 0) return; // nothing to poll
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
    this.initialised = false;
  }

  /** Is the background poll armed? (Nothing could observe the timer, so it once outlived stopServer.) */
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
    const sourcesChanged = await this.reloadMailSources(cal.mail_calendar_accounts);
    // Visibility applies at read time, so a toggle never changes the cache hash: announce it.
    const setChanged = (a: Set<string> | null, b: Set<string> | null) =>
      (a === null) !== (b === null) || (a && b && (a.size !== b.size || [...b].some((id) => !a.has(id))));
    if (
      sourcesChanged ||
      prevEnabled !== this.enabled ||
      setChanged(prevHidden, this.hiddenIds) ||
      setChanged(prevVisible, this.visibleIds) ||
      setChanged(prevHiddenEvents, this.hiddenEventIds)
    )
      this.emitUpdated();
  }

  /** A config change: reloads only when it turned the `mail_calendars` experiment on or off. */
  async experimentsChanged(): Promise<void> {
    if (mailCalendarsOn(await readExperimentalFlags()) !== this.mailOn) await this.reloadConfig();
  }

  /** Mail accounts' sources from config, only while the experiment is on. True when the set changed. */
  private async reloadMailSources(accounts: string[] | undefined): Promise<boolean> {
    const flags = await readExperimentalFlags();
    this.mailOn = mailCalendarsOn(flags);
    if (!this.mailFactory) return this.sources.setExtras([]);
    const wanted = activeMailCalendarAccounts({ mail_calendar_accounts: accounts }, flags);
    const next = wanted.map((account) => this.mailSources.get(account) ?? this.mailSources.set(account, this.mailFactory!(account)).get(account)!);
    for (const account of [...this.mailSources.keys()]) if (!wanted.includes(account)) this.mailSources.delete(account);
    const changed = this.sources.setExtras(next);
    // The cache holds merged windows: one built before a source came or went is wrong now.
    if (changed) this.cache.clear();
    this.armLoop();
    return changed;
  }

  /** The Mac's source status, as it always was (`sources[0]` of every answer). */
  status(): CalendarSourceStatus {
    return this.statusOf(this.sources.primary);
  }

  /** Every source's status, the Mac's first. With only the Mac's this is `[status()]`. */
  statuses(): CalendarSourceStatus[] {
    return this.sources.members().map((m) => this.statusOf(m));
  }

  private statusOf(member: SourceMember): CalendarSourceStatus {
    const own = member.source.id;
    const alone = !this.sources.hasExtras();
    let count = 0;
    for (const entry of this.cache.values()) {
      count += alone ? entry.events.length : entry.events.filter((e) => e.source === own).length;
    }
    return this.sources.statusOf(member, this.enabled, count, this.lastRefresh);
  }

  async listCalendars(): Promise<CalendarInfo[]> {
    return (await this.listCalendarsDetailed()).calendars;
  }

  /** Every usable source's calendars; `complete` is false when one of them failed to answer. */
  async listCalendarsDetailed(): Promise<{ calendars: CalendarInfo[]; complete: boolean }> {
    const members = this.readableMembers();
    // The service owns the hidden/visible sets (config): overlaid here for every source.
    const { items, complete } = await this.sources.readAll(members, (m) => m.source.listCalendars());
    const calendars = items.map((c) => ({
      ...c,
      hidden: this.isHidden(c.id),
      ...(c.id === this.defaultCalendarId && !c.readonly ? { default: true } : {}),
    }));
    return { calendars, complete };
  }

  /** The sources a read asks: refused as before when the calendar is off or nothing can be read. */
  private readableMembers(): SourceMember[] {
    if (!this.enabled) throw new CalendarHelperError('calendar source is disabled', 'disabled');
    const usable = this.sources.usable();
    if (usable.length === 0) this.assertUsable(this.sources.primary);
    return usable;
  }

  /**
   * The configured default checked against `calendars` (a list the caller already holds, so
   * GET /sources adds no helper call). See default-calendar.ts.
   */
  describeDefault(calendars: CalendarInfo[]): CalendarDefaultState {
    const { state, problem } = describeDefaultCalendar(this.defaultCalendarId, calendars);
    if (!problem) this.loggedDefaultWarning = null;
    else if (this.loggedDefaultWarning !== problem) {
      this.loggedDefaultWarning = problem;
      log.calendar.warn('default calendar unusable, creates without a calendar id are refused', { configuredId: this.defaultCalendarId, problem });
    }
    return state;
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

  /** Events within [from, to] (inclusive days), from cache while younger than READ_TTL; `force`
   *  skips it. Hidden calendars are filtered HERE (the cache keeps everything, so a toggle needs
   *  no refetch); `includeHidden` marks single hidden events instead of dropping them. */
  async getEvents(from: string, to: string, opts?: { force?: boolean; includeHidden?: boolean }): Promise<CalendarEvent[]> {
    if (!this.enabled || this.sources.usable().length === 0) return [];
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
    const member = this.sources.memberFor(id);
    if (member.source.getEvent) {
      await member.source.getEvent(id);
      return;
    }
    const day = occurrenceDay(id);
    if (!day) {
      throw new CalendarHelperError(
        `event ${id} is not in any date range Walnut has loaded; query the range that holds it first (calendar_query or GET /events), then hide it`,
        'usage',
      );
    }
    this.assertUsable(member);
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
      // A write during the list: list again (its write-through has run or will refresh what is cached).
      let events: CalendarEvent[] = [];
      let settled = false;
      for (let attempt = 0; attempt < 3 && !settled; attempt++) {
        const gen = this.writeGen;
        // Every usable source at once; throws only when every one failed.
        const read = await this.sources.readAll(this.sources.usable(), (m) => m.source.listEvents(window.from, window.to), { key: `${window.from}|${window.to}` });
        // As in refreshAll: a source that failed this time keeps the events it gave before (its status says why).
        const kept = read.failed.length ? (before?.events ?? []).filter((e) => read.failed.includes(e.source)) : [];
        events = kept.length ? [...read.items, ...kept] : read.items;
        settled = gen === this.writeGen;
      }
      if (!settled) return events; // writes keep coming: answer, but cache nothing that may be old
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

  /** Re-fetch every cached window (periodic / manual refresh), asking the sources to pull from
   *  their remote accounts first (async inside macOS: it freshens the next poll, not this one). */
  async refreshAll(): Promise<void> {
    if (!this.enabled || this.sources.usable().length === 0) return;
    let anyChanged = false;
    const keys = [...this.cache.keys()];
    const gen = this.writeGen;
    const read = await this.sources.readWindows(keys.map(lateKey), (m, k) => m.source.listEvents(...windowOf(k), { refresh: true }));
    // A write landed meanwhile: its own write-through holds the newer lists.
    if (gen !== this.writeGen) return;
    keys.forEach((key, i) => {
      const result = read[i];
      if ('error' in result) return log.calendar.warn('window refresh failed', { key, error: String(result.error).slice(0, 200) });
      // A source that failed this time keeps the events it gave before, rather than vanishing until the next refresh.
      const kept = result.failed.length ? (this.cache.get(key)?.events ?? []).filter((e) => result.failed.includes(e.source)) : [];
      const events = kept.length ? [...result.items, ...kept] : result.items;
      const hash = eventsHash(events);
      if (hash !== this.cache.get(key)?.hash) anyChanged = true;
      this.cache.set(key, { events, fetchedAt: Date.now(), hash });
    });
    this.lastRefresh = new Date().toISOString();
    if (anyChanged) this.emitUpdated();
  }

  /** The same rule for every source (event-rules.ts): an event Walnut did not make alone needs the person's yes. */
  private async guardWrite(member: SourceMember, id: string, opts?: CalendarWriteOptions): Promise<void> {
    const { source } = member;
    if (!source.getEvent) throw new CalendarHelperError('Calendar write safety is unavailable. Use Hide event instead.', 'human-approval-required');
    const event = await source.getEvent(assertEventId(id));
    // Before any yes: a mail account's event with other people on it is read-only, confirmed or not.
    if (event.readonly) throw new CalendarHelperError(event.readonlyReason ?? 'calendar is read-only', 'readonly');
    if (calendarEventNeedsApproval(event) && opts?.humanConfirm !== true) {
      throw new CalendarHelperError(`\"${event.title}\"${event.recurring ? ' belongs to a recurring series' : ' is not a private Walnut-created block'}. This change may affect the whole series and notify the organizer. Use Hide event instead, or ask the user to confirm in Calendar.`, 'human-approval-required');
    }
  }

  // Writes are NOT tracked: a write can go to another program than the reads (eventkit.ts
  // runSafeWrite), so its refusal says nothing about reads; latching it took the view down.

  /** Moves or renames in place: an event never changes calendar here, whatever the default is. */
  async updateEvent(id: string, patch: CalendarEventPatch, opts?: CalendarWriteOptions): Promise<CalendarEvent> {
    const member = this.sources.memberFor(id);
    this.assertUsable(member);
    if (accountDoorsGuarded()) assertOutwardDoor('calendar-write', `update:${id}`);
    await this.guardWrite(member, id, opts);
    this.writeGen++;
    // Only the fields an update may carry: nothing a caller adds can move it to another calendar.
    const event = await member.source.updateEvent(id, {
      start: patch.start,
      end: patch.end,
      ...(patch.title !== undefined ? { title: patch.title } : {}),
    }, opts);
    await this.writeThrough();
    return event;
  }

  /** No `calendarId` (absent or blank) creates on the configured default calendar. */
  async createEvent(input: CalendarEventCreateInput): Promise<CalendarEvent> {
    this.assertUsable(this.sources.primary, true);
    if (accountDoorsGuarded()) assertOutwardDoor('calendar-write', `create:${input.start}:${input.title}`);
    const calendarId = await this.createTarget(input.calendarId);
    const member = this.sources.memberFor(calendarId);
    this.assertUsable(member);
    this.writeGen++;
    const event = await member.source.createEvent({ ...input, calendarId });
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
    const member = this.sources.memberFor(id);
    this.assertUsable(member);
    if (accountDoorsGuarded()) assertOutwardDoor('calendar-write', `delete:${id}`);
    await this.guardWrite(member, id, opts);
    this.writeGen++;
    await member.source.deleteEvent(id, opts);
    await this.writeThrough();
  }

  /** After a write: refresh cached windows (all at once, recording no source failure, as before) so reads see it, then notify UIs. */
  private async writeThrough(): Promise<void> {
    this.sources.forgetLate(); // a late answer read before this write is older than it
    const gen = ++this.writeGen;
    const keys = [...this.cache.keys()];
    const read = await this.sources.readWindows(keys.map(lateKey), (m, k) => m.source.listEvents(...windowOf(k)), { record: false, keyed: false });
    keys.forEach((key, i) => {
      // A later write began (it may wait minutes for the Mac, or be refused): drop these lists
      // rather than keep them from before it. A miss reads fresh.
      if (gen !== this.writeGen) { this.cache.delete(key); return; }
      const result = read[i];
      // Stale after a write: better a miss than a lie (a source that failed is read again next time).
      if ('error' in result || result.failed.length) this.cache.delete(key);
      else this.cache.set(key, { events: result.items, fetchedAt: Date.now(), hash: eventsHash(result.items) });
    });
    this.emitUpdated();
  }

  private emitUpdated(): void {
    announce({ status: this.status(), ...(this.sources.hasExtras() ? { sources: this.statuses() } : {}) });
  }

  /**
   * Refuses a call to a source that cannot take it. `anySource`: the calendar as a whole
   * (a create whose target is not known yet) is usable when some source is.
   */
  private assertUsable(member: SourceMember, anySource = false): void {
    if (!this.enabled) throw new CalendarHelperError('calendar source is disabled', 'disabled');
    if (anySource && this.sources.usable().length > 0) return;
    const avail = member.source.available();
    if (!avail.ok) throw new CalendarHelperError(avail.message ?? 'calendar unavailable', avail.reason ?? 'not-configured');
  }
}

// The plugin's one instance lives in service-slot.ts; its importers keep this path.
export { adoptCalendarService, getCalendarService, releaseCalendarService, _setCalendarServiceForTest } from './service-slot.js';
