/**
 * The words a coding CLI ends a turn with when the subscription's usage limit stopped it, and the
 * reset time those words carry. Pure (no IO, the clock and time zone are arguments), so the ACP
 * worker on a host, the daemon's turn-error list and the server all read one list.
 *
 * What the CLIs write (read from their bundles, 2026-11-04):
 *   Claude Code  "You've hit your session limit · resets 3pm (America/Los_Angeles)"
 *                (session | weekly | Opus | Sonnet | usage limit; "resets Nov 6, 3pm (...)" past a
 *                day), "You're out of extra usage · resets ...", older CLIs
 *                "Claude AI usage limit reached|1762282800" (epoch seconds after the bar)
 *   Codex        "You've hit your usage limit. Upgrade to Pro (...) or try again at 3:05 PM."
 *                ("Try again at Nov 5th, 2026 3:05 PM." on another day, "Try again later.", older
 *                CLIs "try again in 2 hours 13 minutes"), in the Codex process's local time
 *
 * A plain API rate limit (HTTP 429, "Too many requests", a gateway's throttle) is NOT one of these:
 * it clears in seconds and the turn-retry layers own it (daemon-core.ts classifyTurnError).
 */

/** The text is a subscription usage-limit stop. */
export function matchesUsageLimitText(text: string | null | undefined): boolean {
  if (!text) return false
  return USAGE_LIMIT_PATTERNS.some((re) => re.test(text))
}

/** The provider's limit words out of a longer text (an ACP turn streams them after its answer so far):
 *  from the first match on, at most 300 characters, or null when the text holds none. */
export function usageLimitSentence(text: string | null | undefined): string | null {
  if (!text) return null
  let at = -1
  for (const re of USAGE_LIMIT_PATTERNS) {
    const m = re.exec(text)
    if (m && (at < 0 || m.index < at)) at = m.index
  }
  return at < 0 ? null : text.slice(at, at + 300).trim()
}

/** Exported for the daemon's terminal list and its twin (daemon-source.ts keeps a copy). */
export const USAGE_LIMIT_PATTERNS: readonly RegExp[] = [
  /you(?:'|\u2019)?ve hit your\b(?![^.\u00b7\n]{0,40}\brate[ _-]?limit)[^.\u00b7\n]{0,40}\blimit\b/i,
  /\busage limit reached\b/i,
  /you(?:'|\u2019)?re out of extra usage/i,
  /\busage_?limit_?exceeded\b/i,
]

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']

function monthIndex(word: string | undefined): number {
  return word ? MONTHS.indexOf(word.slice(0, 3).toLowerCase()) : -1
}

/** The zone's offset from UTC at `utcMs` (ms, east positive), or null for an unknown zone. */
function zoneOffsetMs(utcMs: number, timeZone: string): number | null {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric',
      hour: 'numeric', minute: 'numeric', second: 'numeric',
    }).formatToParts(new Date(utcMs))
    const n = (t: string) => Number(parts.find((p) => p.type === t)?.value)
    const asUtc = Date.UTC(n('year'), n('month') - 1, n('day'), n('hour') % 24, n('minute'), n('second'))
    return Number.isFinite(asUtc) ? asUtc - Math.floor(utcMs / 1000) * 1000 : null
  } catch {
    return null
  }
}

/** A wall-clock time in `timeZone` (undefined = this process's zone) as epoch ms. */
export function wallClockToEpoch(y: number, mon: number, d: number, h: number, min: number, timeZone?: string): number | null {
  if (!timeZone) {
    const t = new Date(y, mon, d, h, min, 0, 0).getTime()
    return Number.isFinite(t) ? t : null
  }
  const guess = Date.UTC(y, mon, d, h, min)
  const off1 = zoneOffsetMs(guess, timeZone)
  if (off1 === null) return null
  const first = guess - off1
  const off2 = zoneOffsetMs(first, timeZone)
  return off2 === null ? first : guess - off2
}

/** Today's date in `timeZone` (undefined = this process's zone). */
function todayIn(nowMs: number, timeZone?: string): { y: number; m: number; d: number } {
  if (!timeZone) { const n = new Date(nowMs); return { y: n.getFullYear(), m: n.getMonth(), d: n.getDate() } }
  const off = zoneOffsetMs(nowMs, timeZone) ?? 0
  const n = new Date(nowMs + off)
  return { y: n.getUTCFullYear(), m: n.getUTCMonth(), d: n.getUTCDate() }
}

function hour24(h: number, ampm: string | undefined): number {
  if (!ampm) return h
  const pm = ampm.toLowerCase() === 'pm'
  return (h % 12) + (pm ? 12 : 0)
}

const DAY_MS = 24 * 60 * 60_000

/** A time of day with no date is its next occurrence (a reset is never in the past by more than a few minutes). */
function nextOccurrence(nowMs: number, h: number, min: number, timeZone?: string): number | null {
  const t = todayIn(nowMs, timeZone)
  const at = wallClockToEpoch(t.y, t.m, t.d, h, min, timeZone)
  if (at === null) return null
  return at < nowMs - 10 * 60_000 ? (wallClockToEpoch(t.y, t.m, t.d + 1, h, min, timeZone) ?? at + DAY_MS) : at
}

/** Is this a real IANA zone name (the CLI prints the zone it formatted in)? */
function validZone(z: string | undefined): string | undefined {
  if (!z) return undefined
  try { new Intl.DateTimeFormat('en-US', { timeZone: z }); return z } catch { return undefined }
}

/**
 * The reset time a usage-limit text names, as epoch ms, or undefined when it names none.
 * `localZone`: the zone of the process that wrote the text when the text does not say (Codex
 * writes its host's local time; undefined = this process's zone).
 */
export function parseUsageLimitReset(text: string | null | undefined, nowMs: number, localZone?: string): number | undefined {
  if (!text) return undefined
  // Older Claude Code: "Claude AI usage limit reached|<epoch seconds>".
  const bar = /usage limit reached\|(\d{10,13})/i.exec(text)
  if (bar) { const v = Number(bar[1]); return v < 1e11 ? v * 1000 : v }

  // Claude Code: "resets 3pm (America/Los_Angeles)", "resets 3:30pm (UTC)", "resets Nov 6, 3pm (...)",
  // "resets Nov 6, 2027, 3pm (...)".
  const claude = /\bresets\s+(?:([A-Za-z]{3,9})\s+(\d{1,2}),?\s+(?:(\d{4}),?\s+)?(?:at\s+)?)?(\d{1,2})(?::(\d{2}))?\s*([ap]m)?\b(?:\s*\(([^)\s]+)\))?/i.exec(text)
  if (claude) {
    const zone = validZone(claude[7]) ?? localZone
    const h = hour24(Number(claude[4]), claude[6])
    const min = claude[5] ? Number(claude[5]) : 0
    if (h > 23 || min > 59) return undefined
    const mon = monthIndex(claude[1])
    if (mon >= 0) {
      const now = todayIn(nowMs, zone)
      const year = claude[3] ? Number(claude[3]) : now.y
      let at = wallClockToEpoch(year, mon, Number(claude[2]), h, min, zone)
      // "Jan 3" read in late December is next year's.
      if (at !== null && !claude[3] && at < nowMs - 30 * DAY_MS) at = wallClockToEpoch(year + 1, mon, Number(claude[2]), h, min, zone)
      return at ?? undefined
    }
    return nextOccurrence(nowMs, h, min, zone) ?? undefined
  }

  // Codex: "try again at 3:05 PM", "Try again at Nov 5th, 2026 3:05 PM".
  const codexAt = /\btry again at\s+(?:([A-Za-z]{3,9})\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})\s+)?(\d{1,2}):(\d{2})\s*([AP]M)?/i.exec(text)
  if (codexAt) {
    const h = hour24(Number(codexAt[4]), codexAt[6])
    const min = Number(codexAt[5])
    if (h > 23 || min > 59) return undefined
    const mon = monthIndex(codexAt[1])
    if (mon >= 0) return wallClockToEpoch(Number(codexAt[3]), mon, Number(codexAt[2]), h, min, localZone) ?? undefined
    return nextOccurrence(nowMs, h, min, localZone) ?? undefined
  }

  // Older Codex: "try again in 2 hours 13 minutes", "try again in 3 days 1 hour".
  const codexIn = /\btry again in\s+((?:\d+\s*(?:days?|d|hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)\b[\s,]*(?:and\s+)?)+)/i.exec(text)
  if (codexIn) {
    let ms = 0
    for (const m of codexIn[1].matchAll(/(\d+)\s*(days?|d|hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)\b/gi)) {
      const n = Number(m[1])
      const u = m[2].toLowerCase()
      ms += u.startsWith('d') ? n * DAY_MS : u.startsWith('h') ? n * 3_600_000 : u.startsWith('m') ? n * 60_000 : n * 1000
    }
    return ms > 0 ? nowMs + ms : undefined
  }
  return undefined
}
