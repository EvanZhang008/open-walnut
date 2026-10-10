/**
 * Calls: when a call app (Zoom, Teams, Webex, FaceTime, or one the user adds)
 * was holding a call open on this Mac. PURE: parsers for macOS power assertions
 * and interval math. The collector (calls-collector.ts) feeds it `pmset` output;
 * the store (calls-store.ts) keeps the intervals Mac-local.
 *
 * Why power assertions: a call app keeps the display awake for exactly as long as
 * a call runs (Zoom creates a display-sleep assertion when a meeting starts and
 * releases it when it ends), and macOS logs every create and release with the
 * second. So the call is measured, not guessed from the calendar, and it is seen
 * even while the user listens with the Mac idle, which the foreground sampler
 * leaves out.
 *
 * What it cannot know: that the user was listening. A call app holding a call is
 * a call in progress on this Mac, not attention to it.
 */

/** Process names (as macOS reports them) that count as call apps out of the box. */
export const DEFAULT_CALL_APPS: readonly string[] = [
  'zoom.us', 'Microsoft Teams', 'MSTeams', 'Teams', 'Webex', 'Cisco Webex Meetings', 'webexmta', 'FaceTime',
]

/** Assertion types a call app takes to keep the screen on during a call. */
const DISPLAY_TYPES = new Set(['NoDisplaySleepAssertion', 'PreventUserIdleDisplaySleep'])
/** Any process may hold a WebRTC call (a browser call, a chat app's huddle): matched by name. */
const RTC_TYPES = new Set([...DISPLAY_TYPES, 'PreventUserIdleSystemSleep', 'NoIdleSleepAssertion'])
const RTC_NAME = /webrtc|peerconnection/i
/** Housekeeping a call app also does while awake: never a call. */
const NOT_A_CALL = /update|download|install|backup|sync|video wake lock|playing (audio|video)/i

/** Two pieces of one app's call this close are one call (Zoom re-takes its assertion within seconds). */
export const CALL_JOIN_MS = 60_000
/** Coverage pieces this close are one stretch of watching. */
export const COVERAGE_JOIN_MS = 120_000
/** A call longer than this is a stuck assertion, not a call. */
export const MAX_CALL_MS = 12 * 3_600_000

export interface CallInterval {
  app: string
  startMs: number
  endMs: number
}

export type Span = readonly [number, number]

/** Normalise the user's extra call app names (config time.calls.apps). */
export function callAppSet(extra?: readonly unknown[]): Set<string> {
  const out = new Set(DEFAULT_CALL_APPS.map((a) => a.toLowerCase()))
  for (const a of extra ?? []) if (typeof a === 'string' && a.trim() && a.length <= 80) out.add(a.trim().toLowerCase())
  return out
}

/** Is this assertion a call? `apps` is callAppSet(). */
export function isCallAssertion(app: string, type: string, name: string, apps: ReadonlySet<string>): boolean {
  if (NOT_A_CALL.test(name)) return false
  if (apps.has(app.toLowerCase())) return DISPLAY_TYPES.has(type)
  return RTC_TYPES.has(type) && RTC_NAME.test(name)
}

/** `HH:MM:SS` (hours may run past 24) → ms, or null. */
function ageMs(h: string, m: string, s: string): number | null {
  const ms = ((Number(h) * 60 + Number(m)) * 60 + Number(s)) * 1000
  return Number.isFinite(ms) ? ms : null
}

// `   pid 46202(zoom.us): [0x00012a5500018cfb] 00:12:09 PreventUserIdleDisplaySleep named: "..."`
const NOW_LINE = /^\s*pid (\d+)\((.+?)\): \[(0x[0-9a-fA-F]+)\] (\d+):(\d\d):(\d\d) (\S+) named: "(.*)"/

export interface OpenCall { app: string; key: string; startMs: number }

/**
 * Parse `pmset -g assertions` into the calls open right now. `nowMs` is when the
 * command ran; each assertion's age gives its start. The key (pid + assertion id)
 * identifies one call across samples.
 */
export function parseAssertionsNow(text: string, nowMs: number, apps: ReadonlySet<string>): OpenCall[] {
  const out: OpenCall[] = []
  for (const line of text.split('\n')) {
    const m = NOW_LINE.exec(line)
    if (!m) continue
    const [, pid, app, id, h, mi, s, type, name] = m
    if (!isCallAssertion(app!, type!, name!, apps)) continue
    const age = ageMs(h!, mi!, s!)
    if (age === null || age > MAX_CALL_MS) continue
    out.push({ app: app!, key: `${pid}:${id}`, startMs: nowMs - age })
  }
  return out
}

// `2026-10-05 11:00:08 -0700 Assertions   \tPID 56527(zoom.us) Created NoDisplaySleepAssertion "Describe Activity Type" 00:00:00  id:0x0x500009897 [System: ...]`
const LOG_LINE = /^(\d{4}-\d\d-\d\d) (\d\d:\d\d:\d\d) ([+-]\d\d)(\d\d) Assertions\s+PID (\d+)\((.+?)\) (Created|Released|Summary|ClientDied|TimedOut|TurnedOn|TurnedOff) (\S+) "(.*?)" (\d+):(\d\d):(\d\d)\s+id:(0x\S+)/
const STAMP = /^(\d{4}-\d\d-\d\d) (\d\d:\d\d:\d\d) ([+-]\d\d)(\d\d) /

function stampMs(date: string, time: string, tzh: string, tzm: string): number {
  return Date.parse(`${date}T${time}${tzh}:${tzm}`)
}

/** The time a log line was written, or null for a header or a wrapped line. */
export function logLineMs(line: string): number | null {
  const m = STAMP.exec(line)
  if (!m) return null
  const ms = stampMs(m[1]!, m[2]!, m[3]!, m[4]!)
  return Number.isFinite(ms) ? ms : null
}

/**
 * Fold `pmset -g log` lines into call intervals. Stateful across lines so it can
 * run over a stream: feed every line to `push`, then `finish(endMs)` closes calls
 * still open at the end of the log (the call is running now).
 *
 * Created opens a call; Released, ClientDied (the app quit) and TimedOut close
 * it; Summary (macOS repeats long-held assertions every 15 min) opens one whose
 * Created line rotated out of the log, dated by its age.
 */
export function createLogFolder(apps: ReadonlySet<string>) {
  const open = new Map<string, OpenCall>()
  const calls: CallInterval[] = []
  let firstMs: number | null = null
  let lastMs: number | null = null
  const close = (key: string, endMs: number): void => {
    const c = open.get(key)
    if (!c) return
    open.delete(key)
    if (endMs > c.startMs && endMs - c.startMs <= MAX_CALL_MS) calls.push({ app: c.app, startMs: c.startMs, endMs })
  }
  return {
    push(line: string): void {
      const at = logLineMs(line)
      if (at !== null) {
        if (firstMs === null) firstMs = at
        lastMs = at
      }
      if (!line.includes(' Assertions ')) return
      const m = LOG_LINE.exec(line)
      if (!m) return
      const [, date, time, tzh, tzm, pid, app, verb, type, name, h, mi, s, id] = m
      if (!isCallAssertion(app!, type!, name!, apps)) return
      const ms = stampMs(date!, time!, tzh!, tzm!)
      if (!Number.isFinite(ms)) return
      const key = `${pid}:${id}`
      if (verb === 'Created') {
        open.set(key, { app: app!, key, startMs: ms })
      } else if (verb === 'Summary') {
        const age = ageMs(h!, mi!, s!)
        if (!open.has(key) && age !== null) open.set(key, { app: app!, key, startMs: ms - age })
      } else if (verb === 'Released' || verb === 'ClientDied' || verb === 'TimedOut') {
        close(key, ms)
      }
    },
    /** Close what is still open at `endMs` and answer the intervals plus the log's own span. */
    finish(endMs: number): { calls: CallInterval[]; span: Span | null } {
      for (const key of [...open.keys()]) close(key, endMs)
      return { calls: [...calls], span: firstMs !== null && lastMs !== null ? [firstMs, Math.max(lastMs, endMs)] : null }
    },
  }
}

/** Union per app: pieces of one app closer than `joinMs` become one call. */
export function mergeCalls(calls: readonly CallInterval[], joinMs = CALL_JOIN_MS): CallInterval[] {
  const byApp = new Map<string, CallInterval[]>()
  for (const c of calls) {
    if (!(c.endMs > c.startMs)) continue
    const list = byApp.get(c.app) ?? []
    list.push({ ...c })
    byApp.set(c.app, list)
  }
  const out: CallInterval[] = []
  for (const list of byApp.values()) {
    list.sort((a, b) => a.startMs - b.startMs)
    let cur: CallInterval | null = null
    for (const c of list) {
      if (cur && c.startMs - cur.endMs <= joinMs) cur.endMs = Math.max(cur.endMs, c.endMs)
      else { if (cur) out.push(cur); cur = { ...c } }
    }
    if (cur) out.push(cur)
  }
  return out.sort((a, b) => a.startMs - b.startMs)
}

/** Union of spans, joining pieces closer than `joinMs`. */
export function mergeSpans(spans: readonly Span[], joinMs = 0): Array<[number, number]> {
  const sorted = spans.filter(([a, b]) => b > a).map(([a, b]) => [a, b] as [number, number]).sort((x, y) => x[0] - y[0])
  const out: Array<[number, number]> = []
  for (const s of sorted) {
    const last = out[out.length - 1]
    if (last && s[0] - last[1] <= joinMs) last[1] = Math.max(last[1], s[1])
    else out.push([s[0], s[1]])
  }
  return out
}

/** Index of the first span in `merged` (sorted, disjoint) that ends after `t`. */
function firstEndingAfter(merged: readonly Span[], t: number): number {
  let lo = 0
  let hi = merged.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (merged[mid]![1] <= t) lo = mid + 1
    else hi = mid
  }
  return lo
}

/** Milliseconds of [a, b) covered by `merged` (sorted, disjoint). */
export function coveredMs(a: number, b: number, merged: readonly Span[]): number {
  let ms = 0
  for (let i = firstEndingAfter(merged, a); i < merged.length; i++) {
    const [s, e] = merged[i]!
    if (s >= b) break
    ms += Math.min(b, e) - Math.max(a, s)
  }
  return ms
}

/** The parts of [a, b) NOT covered by `merged` (sorted, disjoint). */
export function uncovered(a: number, b: number, merged: readonly Span[]): Array<[number, number]> {
  const out: Array<[number, number]> = []
  let cursor = a
  for (let i = firstEndingAfter(merged, a); i < merged.length; i++) {
    const [s, e] = merged[i]!
    if (s >= b) break
    if (s > cursor) out.push([cursor, Math.min(s, b)])
    cursor = Math.max(cursor, e)
    if (cursor >= b) break
  }
  if (cursor < b) out.push([cursor, b])
  return out
}
