/**
 * The calendar's sources: the Mac's (EventKit, always first) and one per mail account that
 * brings its calendar (CalDAV). CalendarService reads and writes through this set.
 *
 * Rules it keeps:
 * - Each source fails alone. A read asks every usable source at once and merges what came
 *   back; a source that failed records why (its status says so) and the others still show.
 *   Only when EVERY source asked failed does the read throw, which with the Mac's calendars
 *   alone is exactly the old single-source behaviour.
 * - A write goes to the source its id names (event-rules.ts `calendarSourceOf`), never to
 *   another one; an EventKit id is the Mac's, and a `caldav:` id of an account no longer read
 *   is not found (never handed to the Mac's source).
 * - A mail account's read that misses its deadline keeps running; its answer is kept for the
 *   next read of the same window and `onLateResult` says it arrived, so the views ask again.
 * - Per-event failures (not found, read-only, needs the person's yes) say nothing about a
 *   source's health and are never latched into its status.
 */
import { CalendarHelperError } from '../../core/calendar/helper-error.js';
import { calendarErrorCode } from './api.js';
import { calendarSourceOf } from './event-rules.js';
import type { CalendarSource, CalendarSourceId, CalendarSourceReason, CalendarSourceStatus } from './types.js';

export interface SourceMember {
  source: CalendarSource;
  lastError: { reason: CalendarSourceReason; message: string } | null;
  /** When this source last answered a read (extra sources; the Mac's uses the service's clock). */
  lastRefresh?: string;
}

/**
 * How long a read waits for a mail account's calendar before answering without it. Its own
 * requests have longer deadlines (dav.ts) and finish in the background, so the next read has
 * them; meanwhile a slow mail server never holds the Mac's events back for long.
 */
export const EXTRA_READ_DEADLINE_MS = 3_000;
/** A late answer older than this is read again instead of served. */
const LATE_RESULT_TTL_MS = 5 * 60_000;

export interface SourceSetOptions {
  extraReadDeadlineMs?: number;
  /** A mail account's answer that missed its read's deadline has arrived. */
  onLateResult?: () => void;
}

interface LateRead { work: Promise<unknown[]>; value?: unknown[]; at?: number }

/** Failures about one event, never about the source (the Mac's set is the one it always had). */
const PER_EVENT_CODES = new Set(['not-found', 'readonly', 'human-approval-required', 'approval-canceled']);
const EXTRA_PER_EVENT_CODES = new Set([...PER_EVENT_CODES, 'conflict', 'usage']);
const LATCHED_REASONS: ReadonlySet<string> = new Set(['permission-denied', 'not-configured', 'needs-sign-in', 'auth-failed', 'no-calendar']);

export class CalendarSourceSet {
  readonly primary: SourceMember;
  private extras = new Map<string, SourceMember>();
  /** Per member and read key: a read past its deadline, still running or answered since. */
  private late = new Map<SourceMember, Map<string, LateRead>>();
  private readonly deadlineMs: number;

  constructor(primary: CalendarSource, private readonly options: SourceSetOptions = {}) {
    this.primary = { source: primary, lastError: null };
    this.deadlineMs = options.extraReadDeadlineMs ?? EXTRA_READ_DEADLINE_MS;
  }

  /** The Mac's source first, then the mail accounts' in the order config lists them. */
  members(): SourceMember[] {
    return [this.primary, ...this.extras.values()];
  }

  hasExtras(): boolean {
    return this.extras.size > 0;
  }

  /**
   * Replace the extra sources with `sources`, keeping the member (and its recorded state) of
   * any source id already here. Returns whether the set changed.
   */
  setExtras(sources: CalendarSource[]): boolean {
    const next = new Map<string, SourceMember>();
    for (const source of sources) next.set(source.id, this.extras.get(source.id) ?? { source, lastError: null });
    const changed = next.size !== this.extras.size || [...next.keys()].some((id) => !this.extras.has(id));
    this.extras = next;
    for (const member of [...this.late.keys()]) if (member !== this.primary && ![...next.values()].includes(member)) this.late.delete(member);
    return changed;
  }

  /** The sources a read may ask right now (each one's own static check). */
  usable(): SourceMember[] {
    return this.members().filter((m) => m.source.available().ok);
  }

  /** The source that holds an event or calendar id; a mail account's id no source reads is not found. */
  memberFor(id: string): SourceMember {
    const owner = calendarSourceOf(id);
    if (owner === 'eventkit') return this.primary;
    const member = this.extras.get(owner);
    if (!member) throw new CalendarHelperError(`not found: ${id} (its mail account's calendar is not read)`, 'not-found');
    return member;
  }

  /** Run one source call, recording a source-level failure so its status explains it. */
  async track<T>(member: SourceMember, fn: () => Promise<T>): Promise<T> {
    try {
      const result = await fn();
      member.lastError = null;
      if (member !== this.primary) member.lastRefresh = new Date().toISOString();
      return result;
    } catch (err) {
      const code = calendarErrorCode(err);
      if (code && (member === this.primary ? PER_EVENT_CODES : EXTRA_PER_EVENT_CODES).has(code)) throw err;
      // The Mac's source latches only its helper's own codes, as it always did; a mail
      // account's source latches anything, because its failures are network and server ones.
      if (code || member !== this.primary) {
        member.lastError = {
          reason: code && LATCHED_REASONS.has(code) ? (code as CalendarSourceReason) : 'fetch-error',
          message: err instanceof Error ? err.message : String(err),
        };
      }
      throw err;
    }
  }

  /**
   * Ask every member at once and merge. Throws the first failure only when every member
   * failed; `complete` says whether every one answered. `key` names the read (a window), so a
   * mail account's late answer serves the next read with that key. `record: false` reads
   * without touching any status (a refresh after a write, which never latched before).
   */
  async readAll<T>(
    members: SourceMember[],
    fn: (member: SourceMember) => Promise<T[]>,
    opts: { key?: string; record?: boolean } = {},
  ): Promise<{ items: T[]; complete: boolean; failed: CalendarSourceId[] }> {
    const ask = (m: SourceMember) => (m === this.primary ? fn(m) : this.extraRead(m, opts.key, () => fn(m)));
    // `record: false` only clears a recorded failure on success, as the write refresh always did.
    const untracked = (m: SourceMember) => ask(m).then((items) => { m.lastError = null; return items; });
    const results = await Promise.allSettled(members.map((m) => (opts.record === false ? untracked(m) : this.track(m, () => ask(m)))));
    const items: T[] = [];
    let failure: unknown = undefined;
    const failed: CalendarSourceId[] = [];
    results.forEach((result, i) => {
      if (result.status === 'fulfilled') items.push(...result.value);
      else {
        failed.push(members[i].source.id);
        if (failure === undefined) failure = result.reason;
      }
    });
    if (failed.length > 0 && failed.length === results.length) throw failure;
    return { items, complete: failed.length === 0, failed };
  }

  /**
   * Several windows from every usable source. The Mac's source reads them one after another
   * (one helper run at a time, as it always did); mail accounts' read all at once alongside.
   * Each window answers its items and the sources that failed for it (whose events the caller
   * still holds from before), or the error when every source failed. `key` names a window for
   * late answers (none when `keyed` is false: a read that must not take one).
   */
  async readWindows<T>(
    keys: string[],
    fn: (member: SourceMember, key: string) => Promise<T[]>,
    opts: { record?: boolean; keyed?: boolean } = {},
  ): Promise<Array<{ items: T[]; failed: CalendarSourceId[] } | { error: unknown }>> {
    const members = this.usable();
    const own = members.filter((m) => m === this.primary);
    const extras = members.filter((m) => m !== this.primary);
    const read = (group: SourceMember[], key: string) => (group.length === 0
      ? Promise.resolve(null)
      : this.readAll(group, (m) => fn(m, key), { key: opts.keyed === false ? undefined : key, record: opts.record })
        .then((r) => ({ items: r.items, failed: r.failed }), (error: unknown) => ({ error, failed: group.map((m) => m.source.id) })));
    const extraReads = keys.map((key) => read(extras, key));
    const out: Array<{ items: T[]; failed: CalendarSourceId[] } | { error: unknown }> = [];
    for (const [i, key] of keys.entries()) {
      const parts = [await read(own, key), await extraReads[i]].filter((p) => p !== null);
      const ok = parts.filter((p): p is { items: T[]; failed: CalendarSourceId[] } => 'items' in p);
      out.push(ok.length > 0 || parts.length === 0
        ? { items: ok.flatMap((p) => p.items), failed: parts.flatMap((p) => p.failed) }
        : { error: (parts[0] as { error: unknown }).error });
    }
    return out;
  }

  /** Drop every kept late answer (a write made them older than the server's copy). */
  forgetLate(): void {
    this.late.clear();
  }

  /** A mail account's read within the deadline: a late answer kept for its key, or one still running, is used first. */
  private async extraRead<T>(member: SourceMember, key: string | undefined, run: () => Promise<T[]>): Promise<T[]> {
    const reads = key ? (this.late.get(member) ?? new Map<string, LateRead>()) : null;
    const kept = key ? reads!.get(key) : undefined;
    if (kept?.value && Date.now() - (kept.at ?? 0) < LATE_RESULT_TTL_MS) {
      reads!.delete(key!);
      return kept.value as T[];
    }
    const work = kept && !kept.value ? (kept.work as Promise<T[]>) : run();
    try {
      return await withDeadline(work, this.deadlineMs);
    } catch (err) {
      if (!key || !(err instanceof LateError)) throw err;
      // Keep the read; when it answers, the next read of this key takes its answer at once.
      const entry: LateRead = kept && !kept.value ? kept : { work };
      reads!.set(key, entry);
      this.late.set(member, reads!);
      if (entry === kept) throw err;
      work.then((value) => {
        if (reads!.get(key) !== entry) return;
        entry.value = value;
        entry.at = Date.now();
        member.lastError = null;
        member.lastRefresh = new Date().toISOString();
        this.options.onLateResult?.();
      }, () => {
        if (reads!.get(key) === entry) reads!.delete(key);
      });
      throw err;
    }
  }

  /** One source's status. `lastRefresh` is the service's clock for the Mac's source. */
  statusOf(member: SourceMember, enabled: boolean, eventCount: number, lastRefresh: string | undefined): CalendarSourceStatus {
    const { source } = member;
    const own = source.describe?.() ?? {};
    const refreshed = member === this.primary ? lastRefresh : member.lastRefresh;
    const avail = source.available();
    if (!enabled) return { id: source.id, ...own, available: avail.ok, enabled: false, reason: 'disabled' };
    if (!avail.ok) return { id: source.id, ...own, available: false, enabled: true, reason: avail.reason, message: avail.message };
    if (member.lastError) {
      return {
        id: source.id,
        ...own,
        available: false,
        enabled: true,
        reason: member.lastError.reason,
        message: member.lastError.message,
        lastRefresh: refreshed,
      };
    }
    // Available but degraded is its own state: reads work, yet something the user has to fix
    // is silently propping them up. Reporting only available:true would hide it forever.
    const degraded = source.degraded?.();
    return {
      id: source.id,
      ...own,
      available: true,
      enabled: true,
      ...(degraded ? { degraded } : {}),
      lastRefresh: refreshed,
      eventCount,
    };
  }
}

class LateError extends CalendarHelperError {}

function withDeadline<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new LateError(`Its server did not answer within ${Math.round(ms / 1000)} seconds; its events show once it does.`, 'fetch-error')), ms);
    timer.unref?.();
  });
  return Promise.race([work, late]).finally(() => clearTimeout(timer));
}
