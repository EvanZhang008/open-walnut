/**
 * calendar-date — ALL date math for the calendar view, as pure functions.
 *
 * Timezone contract (same as task dates everywhere in Walnut): values are
 * SERVER-LOCAL WALL TIME serialized as tz-less ISO strings. Two formats:
 *   - day precision:  "2026-08-05"
 *   - time precision: "2026-08-05T09:00:00"  (no timezone suffix, ever)
 * distinguished by `.includes('T')`. Date-only strings must be parsed at
 * LOCAL midnight (see parseDateLocal in components/common/DatePicker.tsx) —
 * `new Date('YYYY-MM-DD')` is UTC midnight and shifts a day in UTC-negative
 * zones. This breaks if browser and server sit in different timezones
 * (remote access); accepted for a personal single-machine tool.
 *
 * DST note: day arithmetic goes through Date fields (never +86400000 ms), so
 * grids stay aligned across DST transitions. A drag can produce a wall time
 * that doesn't exist on a spring-forward day (02:30); it's stored as-is and
 * Date normalizes it on parse.
 */

/** 1 = Monday. Single knob if week start ever becomes configurable. */
export const WEEK_STARTS_ON = 1;

/** Visual grid rows are 30 minutes; drags snap to 15. */
export const SLOT_MINUTES = 30;
export const SNAP_MINUTES = 15;
export const SLOTS_PER_DAY = (24 * 60) / SLOT_MINUTES;

const pad = (n: number) => String(n).padStart(2, '0');

/** "YYYY-MM-DD" for a local Date. */
export function formatDateOnly(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Tz-less local ISO datetime: "YYYY-MM-DDTHH:MM:SS". */
export function formatLocalIso(d: Date): string {
  return `${formatDateOnly(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** Local-midnight copy of a Date. */
export function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

export function addDays(d: Date, days: number): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + days);
}

export function sameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

/**
 * Minutes since local midnight for a tz-less datetime string.
 * Parsed by string split, NOT new Date(), so a value like "T24:30" from bad
 * input can't silently roll into the next day unnoticed by the caller.
 */
export function minutesOfDay(iso: string): number {
  const t = iso.split('T')[1];
  if (!t) return 0;
  const [h, m] = t.split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
}

/** Day part ("YYYY-MM-DD") of either date format. */
export function dayOf(iso: string): string {
  return iso.split('T')[0];
}

/**
 * The tz-less ISO written when something lands on `day` at slot `slot`
 * (slot = index of SLOT_MINUTES-sized rows since midnight).
 */
export function slotToLocalIso(day: string, slot: number, slotMinutes: number = SLOT_MINUTES): string {
  const clamped = Math.max(0, Math.min(slot, (24 * 60) / slotMinutes - 1));
  const mins = Math.round(clamped * slotMinutes);
  return `${day}T${pad(Math.floor(mins / 60))}:${pad(mins % 60)}:00`;
}

/** Inverse of slotToLocalIso (floors into the containing slot). */
export function isoToSlot(iso: string, slotMinutes: number = SLOT_MINUTES): number {
  return Math.floor(minutesOfDay(iso) / slotMinutes);
}

/** Snap raw minutes-of-day to the drag quantum, clamped to the day. */
export function snapMinutes(mins: number, quantum: number = SNAP_MINUTES): number {
  return Math.max(0, Math.min(24 * 60 - quantum, Math.round(mins / quantum) * quantum));
}

/** Monday-start (WEEK_STARTS_ON) week containing `anchor`, as 7 local dates. */
export function weekRange(anchor: Date): Date[] {
  const day = startOfDay(anchor);
  const offset = (day.getDay() - WEEK_STARTS_ON + 7) % 7;
  const start = addDays(day, -offset);
  return Array.from({ length: 7 }, (_, i) => addDays(start, i));
}

/**
 * The month-view grid for the month containing `anchor`: full weeks covering
 * the 1st..last, each week an array of 7 local dates. 4-6 rows.
 */
export function monthGridRange(anchor: Date): Date[][] {
  const first = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
  const last = new Date(anchor.getFullYear(), anchor.getMonth() + 1, 0);
  const gridStart = weekRange(first)[0];
  const weeks: Date[][] = [];
  for (let d = gridStart; d <= last; d = addDays(d, 7)) {
    weeks.push(Array.from({ length: 7 }, (_, i) => addDays(d, i)));
  }
  return weeks;
}

/** Inclusive [from, to] day strings covered by a view, for range fetches. */
export function viewRange(view: 'day' | 'week' | 'month', anchor: Date): { from: string; to: string } {
  if (view === 'day') {
    const d = formatDateOnly(anchor);
    return { from: d, to: d };
  }
  if (view === 'week') {
    const days = weekRange(anchor);
    return { from: formatDateOnly(days[0]), to: formatDateOnly(days[6]) };
  }
  const weeks = monthGridRange(anchor);
  return { from: formatDateOnly(weeks[0][0]), to: formatDateOnly(weeks[weeks.length - 1][6]) };
}

// ---------------------------------------------------------------------------
// Overlap lane layout (the macOS-Calendar side-by-side algorithm)
// ---------------------------------------------------------------------------

export interface LaneInput {
  id: string;
  /** Minutes since midnight. end > start (callers enforce a visual minimum). */
  startMin: number;
  endMin: number;
}

export interface LanePlacement {
  /** 0-based column within the overlap cluster. */
  lane: number;
  /** Total columns in this item's cluster — width = 100% / laneCount. */
  laneCount: number;
}

/**
 * Assign side-by-side lanes to overlapping items in one day column.
 * Classic sweep: sort by start, greedily reuse the lowest lane that has
 * ended; a "cluster" is a maximal run of transitively-overlapping items and
 * every member shares the cluster's lane count so widths line up.
 */
export function layoutDayEvents(items: LaneInput[]): Map<string, LanePlacement> {
  const placements = new Map<string, LanePlacement>();
  const sorted = [...items].sort((a, b) => a.startMin - b.startMin || b.endMin - a.endMin);

  let cluster: LaneInput[] = [];
  let laneEnds: number[] = []; // per-lane last end within the cluster
  let clusterEnd = -1;

  const flush = () => {
    for (const it of cluster) {
      const p = placements.get(it.id)!;
      p.laneCount = laneEnds.length;
    }
    cluster = [];
    laneEnds = [];
    clusterEnd = -1;
  };

  for (const it of sorted) {
    if (cluster.length && it.startMin >= clusterEnd) flush();
    let lane = laneEnds.findIndex((end) => end <= it.startMin);
    if (lane === -1) {
      lane = laneEnds.length;
      laneEnds.push(it.endMin);
    } else {
      laneEnds[lane] = it.endMin;
    }
    cluster.push(it);
    clusterEnd = Math.max(clusterEnd, it.endMin);
    placements.set(it.id, { lane, laneCount: 0 }); // count fixed at flush
  }
  flush();
  return placements;
}
