/**
 * RRULE expansion (RFC 5545 3.3.10) for the rules calendars actually carry.
 *
 * Expansion runs on the WALL CLOCK of the event's own zone and turns each occurrence into an
 * instant only at the end, so a weekly 09:00 meeting stays at 09:00 local on both sides of a
 * daylight-saving change (which is what every calendar program shows).
 *
 * Covered: FREQ DAILY / WEEKLY / MONTHLY / YEARLY, INTERVAL, COUNT, UNTIL, BYDAY (with
 * ordinals for MONTHLY and YEARLY), BYMONTHDAY (negative too), BYMONTH, BYSETPOS, WKST.
 * Not covered (rare in calendars): BYYEARDAY, BYWEEKNO, BYHOUR/BYMINUTE/BYSECOND and the
 * sub-daily frequencies; such a rule yields its first occurrence only.
 *
 * Cost is bounded by the range asked, not by the series' age: the walk starts at the period that
 * holds the range's start (arithmetic per frequency), stops at the first period past its end, and
 * occurrences before the range are only counted, never turned into instants. A COUNT rule counts
 * the skipped periods without building them (recurrence-sets.ts `countPeriods`: whole cycles by
 * arithmetic where the count per period repeats). Every series has a budget of
 * `CANDIDATE_BUDGET` candidate dates per read; one that runs out stops there and says so
 * (`onTruncated`), so no event can hold the server's event loop.
 */
import { parseTimeValue } from './ics.js';
import { applySetPos, cmp, countPeriods, listCost, periodCandidates, periodStart, ruleParts } from './recurrence-sets.js';
import type { Wall } from './tz.js';

/** The most work (candidate dates and BY list entries looked at) one series may cost one read. */
export const CANDIDATE_BUDGET = 50_000;

/** A read's budget, shared by every series it expands (source.ts: one per listEvents). */
export interface SharedBudget { left: number }
const DAY_MS = 86_400_000;

export interface ExpandInput {
  /** DTSTART on its own wall clock (a date for an all-day event: time 00:00:00). */
  start: Wall;
  /** RRULE parts (ics.ts `parseRuleParts`). */
  rule: Record<string, string>;
  /** The instant a wall clock of the event's zone shows. */
  toEpoch: (wall: Wall) => number;
  /** Stop once occurrences start after this instant. */
  rangeEndEpoch: number;
  /** Occurrences starting before this instant are not needed (DTSTART is still returned). */
  rangeStartEpoch?: number;
  /** An all-day series: a date-time UNTIL is read as its UTC date, inclusive. */
  dateOnly?: boolean;
  /** The budget ran out before the range was covered: some occurrences are missing. */
  onTruncated?: () => void;
  /** The read's shared budget: this series takes from it what it spends. */
  shared?: SharedBudget;
}

/** The first period that can hold an occurrence starting at or after `fromEpoch`, by arithmetic. */
function firstPeriod(freq: string, interval: number, startEpoch: number, fromEpoch: number | undefined): number {
  if (fromEpoch === undefined) return 0;
  // Two days of slack for the zone (walls and instants differ by under a day).
  const days = Math.floor((fromEpoch - startEpoch) / DAY_MS) - 2;
  if (days <= 0) return 0;
  const per = freq === 'DAILY' ? 1 : freq === 'WEEKLY' ? 7 : freq === 'MONTHLY' ? 31 : 366;
  // A month or a year is at most 31 or 366 days, so this never skips past the range.
  return Math.max(0, Math.floor(days / per / interval) - (per > 1 ? 1 : 0));
}

const wallUtc = (w: Wall) => Date.UTC(w.y, w.m - 1, w.d, w.h, w.mi, w.s);

/** The UNTIL bound as an instant: a date means the end of that day on the event's clock. */
function untilEpoch(value: string | undefined, toEpoch: (w: Wall) => number, dateOnly: boolean): number {
  if (!value) return Infinity;
  const t = parseTimeValue(value);
  if (!t) return Infinity;
  if (t.kind === 'utc' && dateOnly) {
    const d = new Date(t.epoch);
    return toEpoch({ y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate(), h: 23, mi: 59, s: 59 });
  }
  if (t.kind === 'utc') return t.epoch;
  if (t.kind === 'date') return toEpoch({ ...t.wall, h: 23, mi: 59, s: 59 });
  return toEpoch(t.wall);
}

/**
 * Occurrence start times on the event's wall clock, DTSTART first, then those from the range's
 * start (roughly: callers filter by overlap) up to its end, COUNT or UNTIL, whichever is first.
 */
export function expandRule(input: ExpandInput): Wall[] {
  const allowed = Math.max(0, Math.min(CANDIDATE_BUDGET, input.shared?.left ?? CANDIDATE_BUDGET));
  const spent = { cost: 0 };
  try {
    return walk(input, allowed, spent);
  } finally {
    if (input.shared) input.shared.left -= spent.cost;
  }
}

function walk(input: ExpandInput, allowed: number, spent: { cost: number }): Wall[] {
  const { start, rule, toEpoch, rangeEndEpoch } = input;
  const p = ruleParts(rule);
  const count = rule.COUNT ? Math.max(1, parseInt(rule.COUNT, 10) || 1) : Infinity;
  const until = untilEpoch(rule.UNTIL, toEpoch, input.dateOnly === true);
  const out: Wall[] = [start];
  const startEpoch = toEpoch(start);
  if (count <= 1 || startEpoch > rangeEndEpoch || p.never) return out;
  const truncated = () => { input.onTruncated?.(); return out; };
  let budget = allowed;
  const charge = (n: number) => { budget -= n; spent.cost += n; };
  const perPeriod = listCost(p);
  let emitted = 1; // DTSTART is the first occurrence
  let from = firstPeriod(p.freq, p.interval, startEpoch, input.rangeStartEpoch);
  if (count !== Infinity && from > 0) {
    // Period 0 holds DTSTART and may hold more after it; periods 1 .. from-1 are only counted.
    const first = periodCandidates(0, start, p);
    if (first === null) return out;
    emitted += applySetPos(first, p.setPos).filter((w) => cmp(w, start) > 0).length;
    const skipped = countPeriods(from, start, p, budget);
    if (skipped === null) from = 0;
    else {
      charge(skipped.cost + first.length);
      emitted += skipped.count;
      if (budget <= 0) return truncated();
      if (emitted >= count) return out;
    }
  }
  const before = input.rangeStartEpoch === undefined ? -Infinity : input.rangeStartEpoch - 2 * DAY_MS;
  const stopAfter = Math.min(rangeEndEpoch, until) + 2 * DAY_MS;
  for (let i = from; ; i++) {
    if (budget <= 0) return truncated();
    if (wallUtc(periodStart(i, start, p)) > stopAfter) return out;
    const raw = periodCandidates(i, start, p);
    if (raw === null) return out; // a frequency this reader does not expand
    charge(Math.max(1, raw.length) + perPeriod);
    for (const w of applySetPos(raw, p.setPos)) {
      if (cmp(w, start) <= 0) continue;
      const rough = wallUtc(w);
      if (rough > stopAfter) return out;
      if (rough < before) {
        // Before the range: it counts toward COUNT, and nothing more is done with it.
        if (++emitted >= count) return out;
        continue;
      }
      const epoch = toEpoch(w);
      if (epoch > until || epoch > rangeEndEpoch) return out;
      out.push(w);
      if (++emitted >= count) return out;
    }
  }
}
