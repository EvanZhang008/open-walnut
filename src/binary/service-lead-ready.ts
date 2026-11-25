/**
 * A host's one Walnut service that does not get ready in time (service-entry.ts runLeaderService and
 * runHostService): it leaves a fallback marker (`<install root>/service-role.fallback`,
 * service-mode.ts) and ends the planned way; the launcher starts the same file again,
 * decideServiceEntry reads the marker and runs the session daemon, so this machine's sessions go on
 * (as the follower role, the daemon then starts the follower as its child again: two programs). The
 * mode file is never changed here: the next mode write or version is the next try.
 *
 * "Ready" is the launcher's ready mark (`<WALNUT_LAUNCHER_DIR>/ready`) naming this process: the
 * server writes it once it serves, leading, waiting for the permit or as a standby (serve-launcher-
 * beat.ts). The server takes WALNUT_LAUNCHER_DIR out of its env at its start, so the dir is read
 * from the decision, before the server loads.
 *
 * The follower role, only where the one service is new (service-entry.ts serveWatchOn: a Mac, which
 * runs it only with the experiment macos_one_service), also:
 *   - counts its starts (`service-role.starts`): a service that exits before it is ready (a crash at
 *     boot) is started again by the launcher forever once its version is committed, and the watch
 *     dies with it. After MAX_UNREADY_STARTS starts in a row that never got ready (each within
 *     STARTS_WINDOW_MS of the one before), the next start leaves the marker and ends at once, so a
 *     host where the service cannot come up falls back to the two programs by itself;
 *   - honours the server's own busy word: once the port listens the server beats "busy until" for
 *     its session adoption (web/serve-launcher-beat.ts), and the watch waits that out plus
 *     BUSY_MARGIN_SECONDS, as the launcher does, so a slow but healthy adoption is never cut.
 * The leader keeps its own: the leader switch decides what a leading machine that does not come up does.
 */
import fs from 'node:fs'
import path from 'node:path'
import { writeServiceRoleFallback, type ServiceRole } from './service-mode.js'

/** Seconds a leading service has to get ready: a value, read once per start. */
export const LEAD_READY_SECONDS_ENV = 'WALNUT_SERVICE_LEAD_READY_SECONDS'
const DEFAULT_LEAD_READY_SECONDS = 180
const POLL_MS = 2_000

export function leadReadySeconds(env: Record<string, string | undefined>): number {
  const n = Number(env[LEAD_READY_SECONDS_ENV])
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_LEAD_READY_SECONDS
}

/** Seconds a follower service has to get ready (a value, read once per start): longer than the launcher's trial, which judges a new version first. */
export const SERVE_READY_SECONDS_ENV = 'WALNUT_SERVICE_SERVE_READY_SECONDS'
const DEFAULT_SERVE_READY_SECONDS = 600

export function serveReadySeconds(env: Record<string, string | undefined>): number {
  const n = Number(env[SERVE_READY_SECONDS_ENV])
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_SERVE_READY_SECONDS
}

/** Starts in a row that never got ready: the start after them falls back to the daemon. */
export const MAX_UNREADY_STARTS = 3
export const SERVICE_ROLE_STARTS_FILE = 'service-role.starts'
/** A start this long after the one counted before begins a new count (planned stops weeks apart are no crash loop). */
export const STARTS_WINDOW_MS = 3600_000
/** How long past the server's own "busy until" the follower watch still waits. */
export const BUSY_MARGIN_SECONDS = 120

interface RoleStarts { v: 1; role: ServiceRole; home: string; exe: string; n: number; at: number }

interface StartsFs {
  readFileSync(file: string, encoding: 'utf8'): string
  writeFileSync(file: string, text: string, opts: { mode: number }): void
  renameSync(from: string, to: string): void
  rmSync(file: string, opts: { force: true }): void
}

/**
 * Counts this start of `role` on `home` with `exe` (the count of another role, home or version
 * starts over) and answers how many starts in a row have not got ready, this one included.
 */
export function noteRoleStart(stateDir: string, d: { role: ServiceRole; home: string; exe: string }, now: number, f: StartsFs = fs): number {
  const file = path.join(stateDir, SERVICE_ROLE_STARTS_FILE)
  let n = 0
  try {
    const raw = JSON.parse(f.readFileSync(file, 'utf8')) as Partial<RoleStarts>
    const recent = typeof raw?.at === 'number' && now - raw.at >= 0 && now - raw.at < STARTS_WINDOW_MS
    if (raw?.v === 1 && recent && raw.role === d.role && raw.home === d.home && raw.exe === d.exe && Number.isInteger(raw.n) && raw.n! > 0) n = raw.n!
  } catch { /* none yet */ }
  n += 1
  const tmp = `${file}.${process.pid}.tmp`
  f.writeFileSync(tmp, JSON.stringify({ v: 1, ...d, n, at: now } satisfies RoleStarts) + '\n', { mode: 0o600 })
  f.renameSync(tmp, file)
  return n
}

/** The role got ready: its count starts over. */
export function clearRoleStarts(stateDir: string, f: Pick<StartsFs, 'rmSync'> = fs): void {
  f.rmSync(path.join(stateDir, SERVICE_ROLE_STARTS_FILE), { force: true })
}

/** Whether a ready mark's text names `pid` (its `pid=` line). */
export function readyNames(text: string, pid: number): boolean {
  return text.split('\n').some((line) => line === `pid=${pid}`)
}

export interface LeadReadyWatch { stop(): void }

/**
 * The heartbeat's "busy until" (`<epoch> <busy until> <pid>`, service-launcher-beat.ts) as a time in
 * ms, when the beat is `pid`'s; null otherwise.
 */
export function busyUntilMs(text: string, pid: number): number | null {
  const [, until, who] = text.trim().split(/\s+/)
  const t = Number(until)
  return Number(who) === pid && Number.isFinite(t) && t > 0 ? t * 1000 : null
}

/**
 * Polls the ready mark until it names `pid`, or calls `onLate` once `seconds` passed without. With
 * `waitUntil`, a late check that gets a later time from it waits until then instead (the server
 * said it is busy), and asks again then.
 */
export function watchLeadReady(o: {
  launcherDir: string
  pid: number
  seconds: number
  onLate: () => void
  onReady?: () => void
  readReady?: (file: string) => Promise<string>
  waitUntil?: () => Promise<number | null>
  now?: () => number
  pollMs?: number
}): LeadReadyWatch {
  const file = path.join(o.launcherDir, 'ready')
  const read = o.readReady ?? ((f: string) => fs.promises.readFile(f, 'utf8'))
  const now = o.now ?? Date.now
  let done = false
  let late: ReturnType<typeof setTimeout> | undefined
  const stop = () => { done = true; clearInterval(poll); clearTimeout(late) }
  const check = async (): Promise<boolean> => {
    const text = await read(file).catch(() => '')
    if (!done && readyNames(text, o.pid)) { stop(); o.onReady?.() }
    return done
  }
  const poll = setInterval(() => { void check() }, o.pollMs ?? POLL_MS)
  const arm = (ms: number) => {
    late = setTimeout(() => {
      // One last look: a mark written in the last poll interval counts.
      void check().then(async (ready) => {
        if (ready || done) return
        const until = o.waitUntil ? await o.waitUntil().catch(() => null) : null
        if (done) return
        if (until !== null && until > now()) { arm(until - now()); return }
        stop()
        o.onLate()
      })
    }, ms)
    late.unref?.()
  }
  arm(o.seconds * 1000)
  poll.unref?.()
  return { stop }
}

/**
 * Arms the watch for a leading service: late, it writes the marker for this mode and calls `leave`
 * (the planned stop, service-entry.ts endServicePlanned). Null when no launcher dir is known.
 */
export function armLeadReady(
  d: { home: string; exe: string; stateDir: string; serverEnv: Record<string, string> },
  deps: RoleReadyDeps,
): LeadReadyWatch | null {
  return armRoleReady({ ...d, role: 'leader' }, deps)
}

export interface RoleReadyDeps {
  leave: () => void; pid?: number; now?: () => number; log?: (line: string) => void
  readReady?: (file: string) => Promise<string>
  /** The heartbeat's text (tests); the launcher dir's `heartbeat` by default. */
  readBeat?: (file: string) => Promise<string>
}

/**
 * Arms the watch for either role: late, the marker for this mode, then `leave`. The follower role
 * counts this start first (noteRoleStart): after MAX_UNREADY_STARTS unready starts it leaves the
 * marker and `leave`s at once (null is returned), its ready mark ends the count, and it waits out
 * the server's busy word (the header). Null also when no launcher dir is known.
 */
export function armRoleReady(
  d: { role: ServiceRole; home: string; exe: string; stateDir: string; serverEnv: Record<string, string> },
  deps: RoleReadyDeps,
): LeadReadyWatch | null {
  const launcherDir = d.serverEnv.WALNUT_LAUNCHER_DIR
  if (!launcherDir || !path.isAbsolute(launcherDir)) return null
  const now = deps.now ?? Date.now
  const log = deps.log ?? ((line: string) => { process.stderr.write(`walnut --service: ${line}\n`) })
  const what = d.role === 'leader' ? `the leader on ${d.home}` : `the Walnut service following ${d.home}`
  const fallBack = (why: string) => {
    try {
      writeServiceRoleFallback(d.stateDir, { role: d.role, home: d.home, exe: d.exe, at: now(), why })
      log(`${why}; the next start runs the session daemon until the next mode write or version`)
    } catch (err) {
      log(`${why}; the fallback marker was not written: ${err instanceof Error ? err.message : String(err)}`)
    }
    deps.leave()
  }
  const follower = d.role === 'replica'
  if (follower) {
    let n = 0
    try { n = noteRoleStart(d.stateDir, d, now()) } catch (err) { log(`its start was not counted: ${err instanceof Error ? err.message : String(err)}`) }
    if (n > MAX_UNREADY_STARTS) {
      try { clearRoleStarts(d.stateDir) } catch { /* the marker decides now */ }
      fallBack(`${what} did not get ready in its last ${MAX_UNREADY_STARTS} starts`)
      return null
    }
  }
  const seconds = follower ? serveReadySeconds(d.serverEnv) : leadReadySeconds(d.serverEnv)
  const pid = deps.pid ?? (Number(d.serverEnv.WALNUT_LAUNCHER_SERVICE_PID) || process.pid)
  const readBeat = deps.readBeat ?? ((f: string) => fs.promises.readFile(f, 'utf8'))
  const beatFile = path.join(launcherDir, 'heartbeat')
  return watchLeadReady({
    launcherDir, pid, seconds, now, ...(deps.readReady ? { readReady: deps.readReady } : {}),
    ...(follower ? {
      onReady: () => { try { clearRoleStarts(d.stateDir) } catch { /* counted again next start */ } },
      waitUntil: async () => {
        const until = busyUntilMs(await readBeat(beatFile).catch(() => ''), pid)
        return until === null ? null : until + BUSY_MARGIN_SECONDS * 1000
      },
    } : {}),
    onLate: () => {
      if (follower) { try { clearRoleStarts(d.stateDir) } catch { /* the marker decides now */ } }
      fallBack(`${what} was not ready within ${seconds} s`)
    },
  })
}
