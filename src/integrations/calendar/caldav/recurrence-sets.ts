/**
 * The occurrence set of one period of an RRULE (a day, week, month or year), as dates or as a
 * count, for recurrence.ts. Counting needs no wall objects and no zone, which is what lets a
 * COUNT rule skip whole periods: a rule since 1600 is counted up to the range in a few
 * thousand cheap steps, then expanded only where it is read.
 *
 * Every BY list is read once per rule and de-duplicated (BYMONTHDAY=1,-31 in a 31-day month is
 * one day; 3000 copies of MO are one weekday).
 */
import { addDays, daysInMonth, weekday, type Wall } from './tz.js';

export const WEEKDAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];

interface ByDay { wd: number; n: number }

export interface RuleParts {
  freq: string;
  interval: number;
  days: ByDay[];
  byMonthDay: number[];
  byMonth: number[];
  setPos: number[];
  wkst: number;
  /** A BY list was given and none of its values can match (BYMONTH=13): the rule has no more occurrences. */
  never: boolean;
}

function ints(value: string | undefined, min: number, max: number): number[] {
  if (!value) return [];
  const all = value.split(',').map((v) => parseInt(v, 10)).filter((n) => Number.isFinite(n) && n !== 0 && n >= min && n <= max);
  return [...new Set(all)];
}

function byDays(value: string | undefined): ByDay[] {
  if (!value) return [];
  const seen = new Set<string>();
  const out: ByDay[] = [];
  for (const raw of value.split(',')) {
    const m = /^([+-]?\d{1,2})?(SU|MO|TU|WE|TH|FR|SA)$/i.exec(raw.trim());
    if (!m) continue;
    const day = { wd: WEEKDAYS.indexOf(m[2].toUpperCase()), n: m[1] ? parseInt(m[1], 10) : 0 };
    if (seen.has(`${day.wd}/${day.n}`)) continue;
    seen.add(`${day.wd}/${day.n}`);
    out.push(day);
  }
  return out;
}

/** The rule's parts, read once. */
export function ruleParts(rule: Record<string, string>): RuleParts {
  const parts = {
    freq: (rule.FREQ ?? '').toUpperCase(),
    interval: Math.max(1, parseInt(rule.INTERVAL ?? '1', 10) || 1),
    days: byDays(rule.BYDAY),
    byMonthDay: ints(rule.BYMONTHDAY, -31, 31),
    byMonth: ints(rule.BYMONTH, 1, 12),
    setPos: ints(rule.BYSETPOS, -366, 366),
    wkst: Math.max(0, WEEKDAYS.indexOf((rule.WKST ?? 'MO').toUpperCase())),
  };
  const given = (name: string) => !!rule[name]?.trim();
  const never = (given('BYDAY') && !parts.days.length) || (given('BYMONTHDAY') && !parts.byMonthDay.length) ||
    (given('BYMONTH') && !parts.byMonth.length);
  return { ...parts, never };
}

export function cmp(a: Wall, b: Wall): number {
  return a.y - b.y || a.m - b.m || a.d - b.d || a.h - b.h || a.mi - b.mi || a.s - b.s;
}

function at(start: Wall, y: number, m: number, d: number): Wall {
  return { y, m, d, h: start.h, mi: start.mi, s: start.s };
}

/** Days of month `m` matching BYDAY, with ordinals counted within the month (arithmetic per entry). */
function weekdaysInMonth(y: number, m: number, days: ByDay[]): number[] {
  const total = daysInMonth(y, m);
  const first = weekday({ y, m, d: 1 });
  const out = new Set<number>();
  for (const { wd, n } of days) {
    const day1 = 1 + ((wd - first + 7) % 7);
    const howMany = Math.floor((total - day1) / 7) + 1;
    if (n === 0) for (let k = 0; k < howMany; k++) out.add(day1 + 7 * k);
    else {
      const k = n > 0 ? n - 1 : howMany + n;
      if (k >= 0 && k < howMany) out.add(day1 + 7 * k);
    }
  }
  return [...out];
}

/**
 * The work one period costs beyond its candidates, four BY list entries to a step: a YEARLY
 * period looks at its day lists once per month it covers, and a plain weekday once per week.
 */
export function listCost(p: RuleParts): number {
  const yearly = p.freq === 'YEARLY';
  const months = yearly && (p.byMonth.length || p.byMonthDay.length) ? p.byMonth.length || 12 : 1;
  const plainDays = yearly && months === 1 ? p.days.filter((d) => d.n === 0).length * 52 : 0;
  const entries = months * (p.days.length + p.byMonthDay.length) + plainDays + p.byMonth.length + p.setPos.length;
  return Math.ceil(entries / 4);
}

function monthDays(y: number, m: number, byMonthDay: number[]): number[] {
  const total = daysInMonth(y, m);
  return [...new Set(byMonthDay.map((d) => (d > 0 ? d : total + d + 1)).filter((d) => d >= 1 && d <= total))];
}

/** Day numbers of one month's occurrences (MONTHLY, or a month of a YEARLY rule), sorted. */
function monthDayNumbers(start: Wall, y: number, m: number, p: RuleParts): number[] {
  let list: number[];
  if (p.byMonthDay.length && p.days.length) {
    const wds = new Set(weekdaysInMonth(y, m, p.days));
    list = monthDays(y, m, p.byMonthDay).filter((d) => wds.has(d));
  } else if (p.byMonthDay.length) list = monthDays(y, m, p.byMonthDay);
  else if (p.days.length) list = weekdaysInMonth(y, m, p.days);
  else list = start.d <= daysInMonth(y, m) ? [start.d] : []; // the 31st skips short months (RFC)
  return list.sort((a, b) => a - b);
}

/** Days of the year (0-based) matching a YEARLY rule's BYDAY, ordinals counted within the year. */
function yearDayNumbers(y: number, days: ByDay[]): number[] {
  const length = daysInMonth(y, 2) === 29 ? 366 : 365;
  const jan1 = weekday({ y, m: 1, d: 1 });
  const out = new Set<number>();
  for (const { wd, n } of days) {
    const first = (wd - jan1 + 7) % 7;
    const total = Math.floor((length - 1 - first) / 7) + 1;
    if (n === 0) for (let k = 0; k < total; k++) out.add(first + 7 * k);
    else {
      const k = n > 0 ? n - 1 : total + n;
      if (k >= 0 && k < total) out.add(first + 7 * k);
    }
  }
  return [...out].sort((a, b) => a - b);
}

function yearMonths(start: Wall, p: RuleParts): number[] {
  // BYMONTHDAY with no BYMONTH means that day of every month (RFC 5545 3.3.10).
  return p.byMonth.length ? [...p.byMonth].sort((a, b) => a - b) : p.byMonthDay.length ? [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12] : [start.m];
}

function monthOf(start: Wall, i: number, p: RuleParts): { y: number; m: number } {
  const index = start.m - 1 + i * p.interval;
  return { y: start.y + Math.floor(index / 12), m: (index % 12) + 1 };
}

/** How many of a period's `size` candidates BYSETPOS keeps. */
export function keptCount(size: number, setPos: number[]): number {
  if (!setPos.length) return size;
  return new Set(setPos.map((q) => (q > 0 ? q - 1 : size + q)).filter((k) => k >= 0 && k < size)).size;
}

export function applySetPos(list: Wall[], setPos: number[]): Wall[] {
  if (!setPos.length) return list;
  const keep = new Set(setPos.map((q) => (q > 0 ? q - 1 : list.length + q)).filter((k) => k >= 0 && k < list.length));
  return list.filter((_, k) => keep.has(k));
}

/** A period's candidates, sorted, before BYSETPOS; null for a frequency this reader does not expand. */
export function periodCandidates(i: number, start: Wall, p: RuleParts): Wall[] | null {
  if (p.never) return [];
  const inMonths = (w: Wall) => p.byMonth.length === 0 || p.byMonth.includes(w.m);
  switch (p.freq) {
    case 'DAILY': {
      const day = addDays(start, i * p.interval);
      if (!inMonths(day)) return [];
      if (p.byMonthDay.length && !monthDays(day.y, day.m, p.byMonthDay).includes(day.d)) return [];
      if (p.days.length && !p.days.some((b) => b.wd === weekday(day))) return [];
      return [day];
    }
    case 'WEEKLY': {
      const weekStart = periodStart(i, start, p);
      const wanted = p.days.length ? p.days.map((b) => b.wd) : [weekday(start)];
      const out: Wall[] = [];
      for (let k = 0; k < 7; k++) {
        const day = addDays(weekStart, k);
        if (wanted.includes(weekday(day)) && inMonths(day)) out.push(day);
      }
      return out;
    }
    case 'MONTHLY': {
      const { y, m } = monthOf(start, i, p);
      if (p.byMonth.length && !p.byMonth.includes(m)) return [];
      return monthDayNumbers(start, y, m, p).map((d) => at(start, y, m, d));
    }
    case 'YEARLY': {
      const y = start.y + i * p.interval;
      if (p.days.length && !p.byMonth.length && !p.byMonthDay.length) {
        return yearDayNumbers(y, p.days).map((doy) => {
          const d = new Date(Date.UTC(y, 0, 1 + doy));
          return at(start, y, d.getUTCMonth() + 1, d.getUTCDate());
        });
      }
      return yearMonths(start, p).flatMap((m) => monthDayNumbers(start, y, m, p).map((d) => at(start, y, m, d)));
    }
    default:
      return null;
  }
}

/** How many occurrences period `i` holds after BYSETPOS, without building them; null when unknown. */
export function periodCount(i: number, start: Wall, p: RuleParts): number | null {
  switch (p.freq) {
    case 'DAILY':
    case 'WEEKLY': {
      const list = periodCandidates(i, start, p);
      return list ? keptCount(list.length, p.setPos) : null;
    }
    case 'MONTHLY': {
      const { y, m } = monthOf(start, i, p);
      if (p.byMonth.length && !p.byMonth.includes(m)) return 0;
      return keptCount(monthDayNumbers(start, y, m, p).length, p.setPos);
    }
    case 'YEARLY': {
      const y = start.y + i * p.interval;
      const size = p.days.length && !p.byMonth.length && !p.byMonthDay.length
        ? yearDayNumbers(y, p.days).length
        : yearMonths(start, p).reduce((sum, m) => sum + monthDayNumbers(start, y, m, p).length, 0);
      return keptCount(size, p.setPos);
    }
    default:
      return null;
  }
}

/**
 * The occurrences of periods 1 .. n-1, counted with whole-cycle arithmetic where the count per
 * period repeats (a DAILY rule with only BYDAY repeats every 7 periods; a WEEKLY rule with no
 * BYMONTH has the same count every week), else period by period. `cost` is the steps taken.
 */
export function countPeriods(n: number, start: Wall, p: RuleParts, budget: number): { count: number; cost: number } | null {
  if (n <= 1) return { count: 0, cost: 0 };
  const plainDaily = p.freq === 'DAILY' && !p.byMonth.length && !p.byMonthDay.length;
  const plainWeekly = p.freq === 'WEEKLY' && !p.byMonth.length;
  if (plainDaily || plainWeekly) {
    const cycle = plainDaily ? 7 : 1;
    const each: number[] = [];
    for (let k = 1; k <= cycle; k++) each.push(periodCount(k, start, p) ?? 0);
    const periods = n - 1;
    const full = Math.floor(periods / cycle);
    let count = full * each.reduce((a, b) => a + b, 0);
    for (let k = 0; k < periods % cycle; k++) count += each[k];
    return { count, cost: cycle * (1 + listCost(p)) };
  }
  const step = 1 + listCost(p);
  let count = 0;
  let cost = 0;
  for (let i = 1; i < n; i++) {
    if (cost > budget) return { count, cost };
    const c = periodCount(i, start, p);
    if (c === null) return null;
    count += c;
    cost += step;
  }
  return { count, cost };
}

/** The first day a period covers, on the wall clock (where a walk can stop or start). */
export function periodStart(i: number, start: Wall, p: RuleParts): Wall {
  switch (p.freq) {
    case 'DAILY': return addDays(start, i * p.interval);
    case 'WEEKLY': return addDays(start, -((weekday(start) - p.wkst + 7) % 7) + 7 * i * p.interval);
    case 'MONTHLY': return { ...start, ...monthOf(start, i, p), d: 1 };
    default: return { ...start, y: start.y + i * p.interval, m: 1, d: 1 };
  }
}
