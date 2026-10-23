/**
 * The schedule math of a routine's clock, ONE copy for the server
 * (src/core/cron/schedule.ts) and both daemon twins, which run the clock of a
 * routine whose work runs on their host (docs/plan/walnut-trigger.md, "Clock
 * routines").
 *
 * The cron half follows croner 10, which the server ran alone before, step for
 * step: the same wall-clock search field by field, the same day-of-month OR
 * day-of-week rule (OR only when neither field is a bare `*`), the same answer
 * at a daylight saving change (a time that does not exist moves forward by the
 * gap, a time that happens twice is the earlier one), and the same "first slot
 * at or after now". tests/providers/clock-schedule-core.test.ts holds the core to
 * croner over thousands of random patterns, zones and times.
 *
 * What this core does not take, croner alone still runs on the server: a year
 * field, `W`, `#`, `L` in the day of week, `LW`, the `+` prefix. Such a routine
 * keeps its clock on the server (`supports` is false), so a daemon never meets a
 * pattern it would read differently.
 *
 * How the daemon twins get it: daemon-standalone.ts imports createClockSchedule;
 * daemon-source.ts inlines `createClockSchedule.toString()` through
 * `__CREATE_CLOCK_SCHEDULE__`. So the factory body references NOTHING at module
 * scope.
 */

export type ClockScheduleSpec =
  | { kind: 'at'; at: string }
  | { kind: 'every'; everyMs: number; anchorMs?: number }
  | { kind: 'cron'; expr: string; tz?: string };

/** A parsed cron pattern: one flag per allowed value, by index. */
export interface ParsedCron {
  second: number[];
  minute: number[];
  hour: number[];
  /** Index 0 is the 1st. */
  day: number[];
  /** Index 0 is January. */
  month: number[];
  /** Index 0 is Sunday. */
  weekday: number[];
  lastDay: boolean;
  starDom: boolean;
  starDow: boolean;
}

export interface ClockSchedule {
  /**
   * The first slot at or after `nowMs`, as src/core/cron/schedule.ts answers it.
   * undefined: no slot (an `at` in the past, a pattern that never matches);
   * null: this core does not take the schedule (croner may).
   */
  nextRunAtMs(schedule: ClockScheduleSpec, nowMs: number, defaultTz?: string): number | undefined | null;
  /**
   * The slot after a run at `runAtMs`, strictly later than it. undefined: none
   * (an `at` ran, a pattern with no later slot). A slot inside the hour a
   * daylight saving change repeats is looked for past that hour, so a clock never
   * stops there (the server simply asks again a minute later).
   */
  afterRun(schedule: ClockScheduleSpec, runAtMs: number, defaultTz?: string): number | undefined;
  /** Whether nextRunAtMs and afterRun answer for this schedule. */
  supports(schedule: unknown, defaultTz?: string): boolean;
  parseCron(expr: string): ParsedCron | null;
  validTimeZone(tz: string): boolean;
  /** The zone a cron schedule runs in: its own, else `defaultTz`, else this process's. */
  zoneOf(schedule: { tz?: string }, defaultTz?: string): string;
}

export function createClockSchedule(): ClockSchedule {
  const MONTH_DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  // [field, its parent, index offset], croner's order.
  const LEVELS: Array<[string, string, number]> = [
    ['month', 'year', 0], ['day', 'month', -1], ['hour', 'day', 0], ['minute', 'hour', 0], ['second', 'minute', 0],
  ];
  const SIZES: Record<string, number> = { second: 60, minute: 60, hour: 24, day: 31, month: 12, weekday: 7 };
  const formats = new Map<string, Intl.DateTimeFormat>();

  interface Wall { y: number; m: number; d: number; h: number; i: number; s: number }
  interface Cursor { year: number; month: number; day: number; hour: number; minute: number; second: number; ms: number; [k: string]: number }

  function formatOf(tz: string): Intl.DateTimeFormat {
    let f = formats.get(tz);
    if (!f) {
      f = new Intl.DateTimeFormat('en-US', {
        timeZone: tz, year: 'numeric', month: 'numeric', day: 'numeric',
        hour: 'numeric', minute: 'numeric', second: 'numeric', hour12: false,
      });
      formats.set(tz, f);
    }
    return f;
  }

  function validTimeZone(tz: string): boolean {
    if (typeof tz !== 'string' || !tz) return false;
    try { formatOf(tz); return true } catch { return false }
  }

  function zoneOf(schedule: { tz?: string }, defaultTz?: string): string {
    const own = typeof schedule.tz === 'string' ? schedule.tz.trim() : '';
    if (own) return own;
    if (typeof defaultTz === 'string' && defaultTz.trim()) return defaultTz.trim();
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  }

  /** The wall clock of an instant in a zone (croner's toTZ). */
  function toWall(at: Date, tz: string): Wall {
    const out: Record<string, number> = { year: 0, month: 0, day: 0, hour: 0, minute: 0, second: 0 };
    for (const p of formatOf(tz).formatToParts(at)) {
      if (p.type in out) out[p.type] = parseInt(p.value, 10);
    }
    return { y: out.year, m: out.month, d: out.day, h: out.hour === 24 ? 0 : out.hour, i: out.minute, s: out.second };
  }

  function wallMs(w: Wall): number {
    return Date.UTC(w.y, w.m - 1, w.d, w.h, w.i, w.s);
  }

  function sameWall(a: Wall, b: Wall): boolean {
    return a.y === b.y && a.m === b.m && a.d === b.d && a.h === b.h && a.i === b.i && a.s === b.s;
  }

  /** The instant of a wall clock in a zone (croner's fromTZ, not strict). */
  function fromWall(w: Wall, tz: string): number {
    const guess = new Date(wallMs(w));
    const offset = wallMs(w) - wallMs(toWall(guess, tz));
    const o = new Date(guess.getTime() + offset);
    const seen = toWall(o, tz);
    if (sameWall(seen, w)) {
      // Twice that day (the clock went back): the earlier one.
      const earlier = new Date(o.getTime() - 3_600_000);
      return sameWall(toWall(earlier, tz), w) ? earlier.getTime() : o.getTime();
    }
    const l = new Date(o.getTime() + wallMs(w) - wallMs(seen));
    if (sameWall(toWall(l, tz), w)) return l.getTime();
    // Not that day at all (the clock went forward): the later of the two.
    return Math.max(o.getTime(), l.getTime());
  }

  // ── parsing (croner's rules; anything it would read in a way this core does not is null) ──

  function setValue(arr: number[], field: string, v: number): boolean {
    if (field === 'weekday') {
      if (v === 7) v = 0;
      if (v < 0 || v > 6) return false;
    } else if (v < 0 || v >= SIZES[field]) return false;
    arr[v] = 1;
    return true;
  }

  function range(arr: number[], field: string, lo: number, hi: number, step: number): boolean {
    if (!Number.isFinite(lo) || !Number.isFinite(hi) || !Number.isFinite(step)) return false;
    if (lo > hi || step === 0 || step > arr.length) return false;
    for (let v = lo; v <= hi; v += step) if (!setValue(arr, field, v)) return false;
    return true;
  }

  function part(arr: number[], field: string, text: string, offset: number, emptyOk: boolean): boolean {
    if (text === '') return emptyOk;
    if (text === '*') { arr.fill(1); return true }
    const list = text.split(',');
    if (list.length > 1) return list.every((t) => part(arr, field, t, offset, emptyOk));
    if (text.indexOf('-') !== -1 && text.indexOf('/') !== -1) {
      const m = /^(\d+)-(\d+)\/(\d+)$/.exec(text);
      if (!m) return false;
      return range(arr, field, parseInt(m[1], 10) + offset, parseInt(m[2], 10) + offset, parseInt(m[3], 10));
    }
    if (text.indexOf('-') !== -1) {
      const ends = text.split('-');
      if (ends.length !== 2) return false;
      return range(arr, field, parseInt(ends[0], 10) + offset, parseInt(ends[1], 10) + offset, 1);
    }
    if (text.indexOf('/') !== -1) {
      const halves = text.split('/');
      // croner takes only `*/n`: a bare or numeric prefix is an error there.
      if (halves.length !== 2 || halves[0] !== '*') return false;
      const step = parseInt(halves[1], 10);
      if (!Number.isFinite(step) || step === 0 || step > arr.length) return false;
      for (let v = 0; v < arr.length; v += step) if (!setValue(arr, field, v)) return false;
      return true;
    }
    const v = parseInt(text, 10) + offset;
    return Number.isFinite(v) && setValue(arr, field, v);
  }

  function nickname(text: string): string | null {
    const t = text.trim().toLowerCase();
    if (t === '@yearly' || t === '@annually') return '0 0 1 1 *';
    if (t === '@monthly') return '0 0 1 * *';
    if (t === '@weekly') return '0 0 * * 0';
    if (t === '@daily' || t === '@midnight') return '0 0 * * *';
    if (t === '@hourly') return '0 * * * *';
    return null;
  }

  function parseCron(expr: string): ParsedCron | null {
    if (typeof expr !== 'string') return null;
    let pattern = expr.trim();
    if (pattern.indexOf('@') >= 0) {
      const named = nickname(pattern);
      if (!named) return null;
      pattern = named;
    }
    const parts = pattern.match(/\S+/g) || [''];
    // Seven parts (a year) is croner's alone.
    if (parts.length !== 5 && parts.length !== 6) return null;
    if (parts.length === 5) parts.unshift('0');
    let dom = parts[3];
    if (dom.toUpperCase() === 'LW') return null;
    let lastDay = false;
    if (dom.toUpperCase().indexOf('L') >= 0) { dom = dom.replace(/L/gi, ''); lastDay = true }
    // The star flags are read BEFORE `?` becomes `*`, as croner reads them.
    const starDom = dom === '*';
    let mon = parts[4];
    let dow = parts[5];
    if (mon.length >= 3) {
      mon = mon.replace(/jan/gi, '1').replace(/feb/gi, '2').replace(/mar/gi, '3').replace(/apr/gi, '4').replace(/may/gi, '5')
        .replace(/jun/gi, '6').replace(/jul/gi, '7').replace(/aug/gi, '8').replace(/sep/gi, '9').replace(/oct/gi, '10')
        .replace(/nov/gi, '11').replace(/dec/gi, '12');
    }
    if (dow.length >= 3) {
      dow = dow.replace(/-sun/gi, '-7').replace(/sun/gi, '0').replace(/mon/gi, '1').replace(/tue/gi, '2')
        .replace(/wed/gi, '3').replace(/thu/gi, '4').replace(/fri/gi, '5').replace(/sat/gi, '6');
    }
    if (dow.startsWith('+')) return null;
    const starDow = dow === '*';
    const fields = [parts[0], parts[1], parts[2], dom, mon, dow].map((f) => f.replace(/\?/g, '*'));
    // W, # and an L left in the day of week: croner's features, not this core's.
    if (fields.some((f) => /[^/*0-9,-]/.test(f))) return null;
    const out: ParsedCron = {
      second: new Array(60).fill(0), minute: new Array(60).fill(0), hour: new Array(24).fill(0),
      day: new Array(31).fill(0), month: new Array(12).fill(0), weekday: new Array(7).fill(0),
      lastDay, starDom, starDow,
    };
    const ok = part(out.second, 'second', fields[0], 0, false)
      && part(out.minute, 'minute', fields[1], 0, false)
      && part(out.hour, 'hour', fields[2], 0, false)
      && part(out.day, 'day', fields[3], -1, lastDay)
      && part(out.month, 'month', fields[4], -1, false)
      && part(out.weekday, 'weekday', fields[5], 0, false);
    return ok ? out : null;
  }

  // ── the search (croner's CronDate.increment, a loop instead of its recursion) ──

  function lastDayOf(year: number, month: number): number {
    return month !== 1 ? MONTH_DAYS[month] : new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  }

  /** croner's apply(): fold an overflowed field into the next one. Its quirks are kept (hour against 59). */
  function apply(c: Cursor): boolean {
    if (c.month > 11 || c.month < 0 || c.day > MONTH_DAYS[c.month] || c.day < 1 || c.hour > 59 || c.minute > 59
      || c.second > 59 || c.hour < 0 || c.minute < 0 || c.second < 0) {
      const t = new Date(Date.UTC(c.year, c.month, c.day, c.hour, c.minute, c.second, c.ms));
      c.ms = t.getUTCMilliseconds(); c.second = t.getUTCSeconds(); c.minute = t.getUTCMinutes(); c.hour = t.getUTCHours();
      c.day = t.getUTCDate(); c.month = t.getUTCMonth(); c.year = t.getUTCFullYear();
      return true;
    }
    return false;
  }

  /** 1: the field already matches, 2: moved to a later match, 3: no match left in this parent. */
  function findNext(p: ParsedCron, c: Cursor, level: number): number {
    const [name, , offset] = LEVELS[level];
    const values = (p as unknown as Record<string, number[]>)[name];
    const before = c[name];
    const lastDom = p.lastDay && name === 'day' ? lastDayOf(c.year, c.month) : -1;
    const firstWeekday = !p.starDow && name === 'day' ? new Date(Date.UTC(c.year, c.month, 1)).getUTCDay() : 0;
    for (let u = c[name] + offset; u < values.length; u++) {
      let hit = values[u];
      if (name === 'day') {
        if (p.lastDay && u - offset === lastDom) hit = 1;
        if (!p.starDow) {
          const onWeekday = p.weekday[(firstWeekday + (u - offset - 1)) % 7];
          hit = !p.starDom ? (hit || onWeekday) : (hit && onWeekday);
        }
      }
      if (hit) {
        c[name] = u - offset;
        return before !== c[name] ? 2 : 1;
      }
    }
    return 3;
  }

  function search(p: ParsedCron, c: Cursor): Cursor | null {
    let level = 0;
    for (let guard = 0; guard < 200_000; guard++) {
      const found = findNext(p, c, level);
      if (found > 1) {
        for (let i = level + 1; i < LEVELS.length; i++) c[LEVELS[i][0]] = -LEVELS[i][2];
        if (found === 3) {
          c[LEVELS[level][1]] += 1;
          c[LEVELS[level][0]] = -LEVELS[level][2];
          apply(c);
          level = 0;
          continue;
        }
        if (apply(c)) { level = Math.max(0, level - 1); continue }
      }
      level += 1;
      if (level >= LEVELS.length) return c;
      if (c.year >= 3000) return null;
    }
    return null;
  }

  /** croner's next run after `afterMs`, which may lie before it at a clock change. */
  function cronCandidate(p: ParsedCron, tz: string, afterMs: number): number | undefined {
    const w = toWall(new Date(afterMs), tz);
    const c: Cursor = { year: w.y, month: w.m - 1, day: w.d, hour: w.h, minute: w.i, second: w.s + 1, ms: 0 };
    apply(c);
    const hit = search(p, c);
    if (!hit) return undefined;
    const at = fromWall({ y: hit.year, m: hit.month + 1, d: hit.day, h: hit.hour, i: hit.minute, s: hit.second }, tz);
    return Number.isFinite(at) ? at : undefined;
  }

  function cronOf(schedule: ClockScheduleSpec, defaultTz?: string): { p: ParsedCron; tz: string } | null {
    if (schedule.kind !== 'cron') return null;
    const p = parseCron(schedule.expr);
    const tz = zoneOf(schedule, defaultTz);
    return p && validTimeZone(tz) ? { p, tz } : null;
  }

  function nextRunAtMs(schedule: ClockScheduleSpec, nowMs: number, defaultTz?: string): number | undefined | null {
    if (!schedule || typeof schedule !== 'object') return null;
    if (schedule.kind === 'at') {
      const atMs = new Date(schedule.at).getTime();
      if (!Number.isFinite(atMs)) return undefined;
      return atMs > nowMs ? atMs : undefined;
    }
    if (schedule.kind === 'every') {
      const everyMs = Math.max(1, Math.floor(schedule.everyMs));
      const anchor = Math.max(0, Math.floor(schedule.anchorMs ?? nowMs));
      if (nowMs < anchor) return anchor;
      const elapsed = nowMs - anchor;
      const steps = Math.max(1, Math.floor((elapsed + everyMs - 1) / everyMs));
      return anchor + steps * everyMs;
    }
    if (schedule.kind !== 'cron') return null;
    if (!schedule.expr || !schedule.expr.trim()) return undefined;
    const parsed = cronOf(schedule, defaultTz);
    if (!parsed) return null;
    const next = cronCandidate(parsed.p, parsed.tz, nowMs - 1);
    return next !== undefined && next >= nowMs ? next : undefined;
  }

  function afterRun(schedule: ClockScheduleSpec, runAtMs: number, defaultTz?: string): number | undefined {
    if (schedule.kind === 'at') return undefined;
    if (schedule.kind === 'every') return nextRunAtMs(schedule, runAtMs + 1) ?? undefined;
    const parsed = cronOf(schedule, defaultTz);
    if (!parsed) return undefined;
    let from = runAtMs;
    for (let tries = 0; tries < 4; tries++) {
      const next = cronCandidate(parsed.p, parsed.tz, from);
      if (next === undefined) return undefined;
      if (next > runAtMs) return next;
      // The earlier of a repeated hour came back: look past that hour.
      from += 3_600_000;
    }
    return undefined;
  }

  function supports(schedule: unknown, defaultTz?: string): boolean {
    if (!schedule || typeof schedule !== 'object') return false;
    const s = schedule as Record<string, unknown>;
    if (s.kind === 'at') return typeof s.at === 'string' && Number.isFinite(new Date(s.at).getTime());
    if (s.kind === 'every') {
      return typeof s.everyMs === 'number' && Number.isFinite(s.everyMs) && s.everyMs >= 1
        && (s.anchorMs === undefined || (typeof s.anchorMs === 'number' && Number.isFinite(s.anchorMs)));
    }
    if (s.kind === 'cron') {
      return typeof s.expr === 'string' && (s.tz === undefined || typeof s.tz === 'string')
        && cronOf({ kind: 'cron', expr: s.expr, ...(typeof s.tz === 'string' ? { tz: s.tz } : {}) }, defaultTz) !== null;
    }
    return false;
  }

  return { nextRunAtMs, afterRun, supports, parseCron, validTimeZone, zoneOf };
}
