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
 * The follower role also counts its starts (`service-role.starts`): a service that exits before it
 * is ready (a crash at boot) is started again by the launcher forever once its version is committed,
 * and the watch dies with it. Its MAX_UNREADY_STARTS-th start in a row that never got ready leaves
 * the marker and ends at once, so a host where the service cannot come up (a Mac it was never run on)
 * falls back to the two programs by itself. The leader keeps its own: the leader switch decides what
 * a leading machine that does not come up does.
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

/** Starts in a row that never got ready before the follower role falls back to the daemon. */
export const MAX_UNREADY_STARTS = 3
export const SERVICE_ROLE_STARTS_FILE = 'service-role.starts'

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
    if (raw?.v === 1 && raw.role === d.role && raw.home === d.home && raw.exe === d.exe && Number.isInteger(raw.n) && raw.n! > 0) n = raw.n!
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

/** Polls the ready mark until it names `pid`, or calls `onLate` once `seconds` passed without. */
export function watchLeadReady(o: {
  launcherDir: string
  pid: number
  seconds: number
  onLate: () => void
  onReady?: () => void
  readReady?: (file: string) => Promise<string>
  pollMs?: number
}): LeadReadyWatch {
  const file = path.join(o.launcherDir, 'ready')
  const read = o.readReady ?? ((f: string) => fs.promises.readFile(f, 'utf8'))
  let done = false
  const stop = () => { done = true; clearInterval(poll); clearTimeout(late) }
  const check = async (): Promise<boolean> => {
    const text = await read(file).catch(() => '')
    if (!done && readyNames(text, o.pid)) { stop(); o.onReady?.() }
    return done
  }
  const poll = setInterval(() => { void check() }, o.pollMs ?? POLL_MS)
  const late = setTimeout(() => {
    // One last look: a mark written in the last poll interval counts.
    void check().then((ready) => {
      if (ready) return
      stop()
      o.onLate()
    })
  }, o.seconds * 1000)
  poll.unref?.(); late.unref?.()
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

export interface RoleReadyDeps { leave: () => void; pid?: number; now?: () => number; log?: (line: string) => void; readReady?: (file: string) => Promise<string> }

/**
 * Arms the watch for either role: late, the marker for this mode, then `leave`. The follower role
 * counts this start first (noteRoleStart): past MAX_UNREADY_STARTS it leaves the marker and `leave`s
 * at once, and its ready mark ends the count. Null when no launcher dir is known.
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
  return watchLeadReady({
    launcherDir, pid, seconds, ...(deps.readReady ? { readReady: deps.readReady } : {}),
    ...(follower ? { onReady: () => { try { clearRoleStarts(d.stateDir) } catch { /* counted again next start */ } } } : {}),
    onLate: () => {
      if (follower) { try { clearRoleStarts(d.stateDir) } catch { /* the marker decides now */ } }
      fallBack(`${what} was not ready within ${seconds} s`)
    },
  })
}
