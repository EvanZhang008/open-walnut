/**
 * The time half of a snooze picker (2026-11-11, the user: "可以加一个customized date和hours 啥的吗
 * 就是也可以他们自己选 现在只有date 没有hours", a custom date AND hour, not only a date).
 * A snooze is the task's start date: "YYYY-MM-DD" (that day's local midnight) or an ISO instant;
 * a time picked here always writes an ISO instant, so older date-only values read as before.
 * Every hour is local wall-clock time, built with the Date constructor, so a DST change between
 * now and the picked day still lands on the hour picked.
 */

const pad = (n: number) => String(n).padStart(2, '0');

/** A local day as YYYY-MM-DD. */
export function ymdOf(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * A typed time as "HH:MM" (24 h), or null: "15:30", "3:30 pm", "3:30PM", "3pm", "330p", "1530",
 * "9", "12am" (00:00), "12 pm" (12:00). The field is Walnut's own text box, never the browser's
 * time field (each engine draws its own; MonthGrid keeps the same rule for the date).
 */
export function parseClock(text: string): string | null {
  const t = /^(\d{1,4})(?::(\d{2}))?\s*(a|am|p|pm)?$/.exec(text.trim().toLowerCase().replace(/\./g, ''));
  if (!t) return null;
  let h: number; let m: number;
  if (t[2] !== undefined) { if (t[1].length > 2) return null; h = Number(t[1]); m = Number(t[2]); }
  else if (t[1].length <= 2) { h = Number(t[1]); m = 0; }
  else { h = Number(t[1].slice(0, -2)); m = Number(t[1].slice(-2)); }
  if (m > 59) return null;
  if (t[3]) {
    if (h < 1 || h > 12) return null;
    h = (h % 12) + (t[3].startsWith('p') ? 12 : 0);
  } else if (h > 23) return null;
  return `${pad(h)}:${pad(m)}`;
}

/** "HH:MM" (24 h) parsed, or null. */
function parseHhmm(hhmm: string): { h: number; m: number } | null {
  const t = /^(\d{1,2}):(\d{2})/.exec(hhmm);
  if (!t) return null;
  const h = Number(t[1]); const m = Number(t[2]);
  return h < 24 && m < 60 ? { h, m } : null;
}

/** The instant of a local day at a local time, as ISO; null for a malformed day or time. */
export function localDateTimeIso(ymd: string, hhmm: string): string | null {
  const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd);
  const t = parseHhmm(hhmm);
  if (!day || !t) return null;
  return new Date(Number(day[1]), Number(day[2]) - 1, Number(day[3]), t.h, t.m).toISOString();
}

/** "3:30 PM": the same 12-hour words as the Tomorrow 8 AM / 12 PM / 6 PM chips. */
export function clockWords(d: Date): string {
  const h = d.getHours() % 12 || 12;
  return `${h}:${pad(d.getMinutes())} ${d.getHours() < 12 ? 'AM' : 'PM'}`;
}

const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTH = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "Today 3:30 PM", "Tomorrow 9:00 AM", "Thu Nov 13, 3:30 PM" ("…, 2027" in another year). */
export function dateTimeWords(iso: string, nowMs = Date.now()): string {
  const d = new Date(iso);
  const now = new Date(nowMs);
  const dayMs = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((dayMs(d) - dayMs(now)) / 86_400_000);
  if (days === 0) return `Today ${clockWords(d)}`;
  if (days === 1) return `Tomorrow ${clockWords(d)}`;
  const year = d.getFullYear() !== now.getFullYear() ? ` ${d.getFullYear()}` : '';
  return `${DOW[d.getDay()]} ${MONTH[d.getMonth()]} ${d.getDate()}${year}, ${clockWords(d)}`;
}

/**
 * When a timed snooze runs out, short enough for a closed row or a pill (2026-11-11, the Walnut
 * VP: "Snoozed until Sun 3:30 PM", not "4d"): "Today 3:30 PM", "Tomorrow 9:00 AM", a weekday
 * within the week ("Sun 3:30 PM"), else "Nov 20, 3:30 PM" ("…, 2027" in another year). A
 * date-only value (YYYY-MM-DD, its day's midnight) has no hour to show: null, and the caller
 * keeps its day words.
 */
export function snoozeWhenWords(value: string, nowMs = Date.now()): string | null {
  if (!value.includes('T')) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  const now = new Date(nowMs);
  const dayMs = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((dayMs(d) - dayMs(now)) / 86_400_000);
  if (days === 0) return `Today ${clockWords(d)}`;
  if (days === 1) return `Tomorrow ${clockWords(d)}`;
  if (days > 1 && days < 7) return `${DOW[d.getDay()]} ${clockWords(d)}`;
  const year = d.getFullYear() !== now.getFullYear() ? `, ${d.getFullYear()}` : '';
  return `${MONTH[d.getMonth()]} ${d.getDate()}${year}, ${clockWords(d)}`;
}

/**
 * The first day a picker offers once an hour is typed. A day alone means its midnight, so a
 * date-only snooze picker may start tomorrow (the Org snoozes' minDate); with an hour, today
 * still counts while that hour is ahead (the past check refuses the rest).
 */
export function hourPickerMin(minYmd: string | undefined, nowMs = Date.now()): string | undefined {
  const today = ymdOf(new Date(nowMs));
  return minYmd && minYmd > today ? today : minYmd;
}

/**
 * Where the time field's Set button snoozes to: the day the picker has selected, else today (or
 * the picker's first day), moved to the next day when that time today has already gone by.
 * `past` is a picked day whose time has gone by, which the button refuses.
 */
export function timeTarget(selectedYmd: string, hhmm: string, minYmd: string | undefined, nowMs = Date.now()):
  { iso: string; past: boolean } | null {
  const now = new Date(nowMs);
  let day = selectedYmd || ymdOf(now);
  if (minYmd && day < minYmd) day = minYmd;
  let iso = localDateTimeIso(day, hhmm);
  if (!iso) return null;
  if (!selectedYmd && Date.parse(iso) <= nowMs) {
    const [y, m, d] = day.split('-').map(Number);
    iso = localDateTimeIso(ymdOf(new Date(y, m - 1, d + 1)), hhmm);
    if (!iso) return null;
  }
  return { iso, past: Date.parse(iso) <= nowMs };
}

/** Tomorrow's quick times (2026-11-11, the user: "snooze until should have more options, like
 *  tomorrow 8am, 12pm, 6pm"). */
const TOMORROW_HOURS: { label: string; hour: number }[] = [
  { label: '8 AM', hour: 8 },
  { label: '12 PM', hour: 12 },
  { label: '6 PM', hour: 18 },
];

/** Tomorrow at 8:00, 12:00 and 18:00 local time, as ISO instants. */
export function tomorrowTimePills(nowMs = Date.now()): { label: string; date: string }[] {
  const now = new Date(nowMs);
  return TOMORROW_HOURS.map(({ label, hour }) => ({
    label,
    date: new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, hour).toISOString(),
  }));
}
