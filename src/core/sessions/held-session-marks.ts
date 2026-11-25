/**
 * Marks an engine switch writes on its new session's row (`engineSwitch`, the carried
 * `switchContext`: engine-switch.ts handOver, engine-switch-io.ts stashSwitchContext) that this
 * server holds no row of yet: kept, and written the moment the row arrives.
 *
 * A session a host runs and judges answers its start before its row reaches the leader (the born
 * row comes on the host's channel: host-judged-runner.ts startOnJudgingHost), and a dropped link
 * can hold it back past any wait. A mark written then failed as "Session not found": the
 * `engineSwitch` mark was lost (a later switch back started a new session instead of resuming:
 * engine-switch-resume.ts planResume), and the context stash threw, so a switch whose new session
 * ran was recorded failed (2026-11-25).
 *
 *   writeMarksWhenHere  the write now, or the marks held (persisted under local/, never synced)
 *   armHeldMarks        the boot: the held marks read back, written for rows already here, and
 *                       the store watched for the rest (engine-switch-watch.ts resumeEngineSwitches)
 *
 * Held marks wait at most HELD_TTL_MS: a row that never comes (a start that never ran) leaves none.
 */
import fsp from 'node:fs/promises'
import path from 'node:path'
import { WALNUT_HOME } from '../../constants.js'
import { log } from '../../logging/index.js'

export const HELD_TTL_MS = 24 * 60 * 60_000

type Patch = Record<string, unknown>
interface Held { patch: Patch; at: number }

const fileOf = (): string => path.join(WALNUT_HOME, 'local', 'held-session-marks.json')

let held: Map<string, Held> | null = null
let unwatch: (() => void) | null = null
let chain: Promise<unknown> = Promise.resolve()
let again = false
let running = false

/** One file operation at a time, in order. */
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.then(fn, fn)
  chain = run.catch(() => {})
  return run
}

async function load(): Promise<Map<string, Held>> {
  if (held) return held
  const out = new Map<string, Held>()
  try {
    const raw = JSON.parse(await fsp.readFile(fileOf(), 'utf8')) as Record<string, Held>
    const now = Date.now()
    for (const [sid, h] of Object.entries(raw ?? {})) {
      if (h && typeof h === 'object' && h.patch && typeof h.at === 'number' && now - h.at < HELD_TTL_MS) out.set(sid, h)
    }
  } catch { /* none held */ }
  held = out
  return out
}

async function save(m: Map<string, Held>): Promise<void> {
  const file = fileOf()
  if (m.size === 0) { await fsp.rm(file, { force: true }); return }
  await fsp.mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
  const tmp = `${file}.${process.pid}.tmp`
  await fsp.writeFile(tmp, JSON.stringify(Object.fromEntries(m)), { mode: 0o600 })
  await fsp.rename(tmp, file)
}

const isMissingRow = (err: unknown): boolean => err instanceof Error && /^Session not found\b/.test(err.message)

/** Watch the store while marks wait: each write may be the row they wait for. */
function watch(): void {
  if (unwatch || !held || held.size === 0) return
  void import('../session-tracker.js').then(({ onSessionStoreWrite }) => {
    if (unwatch || !held || held.size === 0) return
    unwatch = onSessionStoreWrite(() => { void applyHeldMarks() })
  }).catch(() => {})
}

/**
 * `patch` on `sessionId`'s row now, or held until the row arrives: 'written' or 'held'. Throws only
 * what the write throws for a row that is here.
 */
export async function writeMarksWhenHere(sessionId: string, patch: Patch): Promise<'written' | 'held'> {
  const { updateSessionRecord } = await import('../session-tracker.js')
  try {
    await updateSessionRecord(sessionId, patch as never)
    return 'written'
  } catch (err) {
    if (!isMissingRow(err)) throw err
  }
  await serial(async () => {
    const m = await load()
    const was = m.get(sessionId)
    m.set(sessionId, { patch: { ...(was?.patch ?? {}), ...patch }, at: Date.now() })
    await save(m)
  })
  log.session.info('engine switch: the new session\'s row is not here yet; its marks are held until it arrives', { sessionId, fields: Object.keys(patch) })
  watch()
  // The row may have come between the write and the hold.
  await applyHeldMarks()
  return held?.has(sessionId) ? 'held' : 'written'
}

/** The held marks of every row here now, written; the ones whose row is still away stay. */
export async function applyHeldMarks(): Promise<string[]> {
  if (running) { again = true; return [] }
  running = true
  const done: string[] = []
  try {
    do {
      again = false
      const m = await serial(load)
      if (m.size === 0) break
      const { getSessionByClaudeId, updateSessionRecord } = await import('../session-tracker.js')
      for (const [sid, h] of [...m]) {
        if (Date.now() - h.at >= HELD_TTL_MS) { await serial(async () => { m.delete(sid); await save(m) }); continue }
        if (!await getSessionByClaudeId(sid).catch(() => null)) continue
        try {
          await updateSessionRecord(sid, h.patch as never)
          done.push(sid)
          log.session.info('engine switch: held marks written now that the session\'s row is here', { sessionId: sid, fields: Object.keys(h.patch) })
        } catch (err) {
          if (isMissingRow(err)) continue
          log.session.warn('engine switch: held marks could not be written; they are dropped', { sessionId: sid, error: err instanceof Error ? err.message : String(err) })
        }
        await serial(async () => { if (m.get(sid) === h) { m.delete(sid); await save(m) } })
      }
    } while (again)
  } finally {
    running = false
  }
  if (held && held.size === 0 && unwatch) { unwatch(); unwatch = null }
  return done
}

/** The boot: held marks read back, written for the rows already here, the rest watched for. */
export async function armHeldMarks(): Promise<number> {
  const m = await serial(load)
  if (m.size === 0) return 0
  watch()
  await applyHeldMarks()
  return held?.size ?? 0
}

/** The marks held for `sessionId`, if any (tests, the switch's own log). */
export async function heldMarksOf(sessionId: string): Promise<Patch | undefined> {
  return (await serial(load)).get(sessionId)?.patch
}

/** Tests only. */
export function _resetHeldMarksForTesting(): void {
  held = null
  unwatch?.()
  unwatch = null
  chain = Promise.resolve()
  again = false
  running = false
}
