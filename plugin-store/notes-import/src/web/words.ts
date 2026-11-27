/** Small wording helpers shared by the panels. */

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n.toLocaleString()} ${n === 1 ? one : many}`
}

/** A notes folder as the person reads it: `Notes / Archive / Notion 2024`. */
export function inNotes(folder: string): string {
  return ['Notes', ...folder.split('/').filter(Boolean)].join(' / ')
}

/** Days from today to the day of `d` (0 today, -1 yesterday), by the viewer's calendar. */
function daysFromToday(d: Date): number {
  const start = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime()
  return Math.round((start(d) - start(new Date())) / 86_400_000)
}

/** A day the way Walnut writes one: "today", "yesterday", "Nov 20", "Nov 20, 2025" (year only when not this year). */
export function dayWords(iso: string | undefined): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const near = daysFromToday(d)
  if (near === 0) return 'today'
  if (near === -1) return 'yesterday'
  const year = d.getFullYear() === new Date().getFullYear() ? undefined : 'numeric'
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year })
}

/**
 * A point in time the way Walnut writes one ("today 9:40 PM", "Nov 20, 9:40 PM": 12-hour clock, no
 * seconds). A plugin cannot import the host's web/src/utils/time.ts (pointInTime), so it spells the
 * same shape with an explicit locale (tests/web/time-words-guard.test.ts checks it).
 */
export function pointWords(iso: string | undefined): string {
  const day = dayWords(iso)
  if (!day) return ''
  const clock = new Date(iso!).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }).replace(/[\u202f\u00a0]/g, ' ')
  return /^[a-z]/.test(day) ? `${day} ${clock}` : `${day}, ${clock}`
}
