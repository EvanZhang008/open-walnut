/**
 * A leading service that does not get ready in time (service-entry.ts runLeaderService): it leaves a
 * fallback marker (`<install root>/service-role.fallback`, service-mode.ts) and ends the planned
 * way; the launcher starts the same file again, decideServiceEntry reads the marker and runs the
 * session daemon, so this machine's sessions go on. The mode file is never changed here: the next
 * mode write or version is the next try.
 *
 * "Ready" is the launcher's ready mark (`<WALNUT_LAUNCHER_DIR>/ready`) naming this process: the
 * server writes it once it serves, leading, waiting for the permit or as a standby (serve-launcher-
 * beat.ts). The server takes WALNUT_LAUNCHER_DIR out of its env at its start, so the dir is read
 * from the decision, before the server loads.
 */
import fs from 'node:fs'
import path from 'node:path'
import { writeServiceRoleFallback } from './service-mode.js'

/** Seconds a leading service has to get ready: a value, read once per start. */
export const LEAD_READY_SECONDS_ENV = 'WALNUT_SERVICE_LEAD_READY_SECONDS'
const DEFAULT_LEAD_READY_SECONDS = 180
const POLL_MS = 2_000

export function leadReadySeconds(env: Record<string, string | undefined>): number {
  const n = Number(env[LEAD_READY_SECONDS_ENV])
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_LEAD_READY_SECONDS
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
  readReady?: (file: string) => Promise<string>
  pollMs?: number
}): LeadReadyWatch {
  const file = path.join(o.launcherDir, 'ready')
  const read = o.readReady ?? ((f: string) => fs.promises.readFile(f, 'utf8'))
  let done = false
  const stop = () => { done = true; clearInterval(poll); clearTimeout(late) }
  const check = async (): Promise<boolean> => {
    const text = await read(file).catch(() => '')
    if (!done && readyNames(text, o.pid)) stop()
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
  deps: { leave: () => void; pid?: number; now?: () => number; log?: (line: string) => void; readReady?: (file: string) => Promise<string> },
): LeadReadyWatch | null {
  const launcherDir = d.serverEnv.WALNUT_LAUNCHER_DIR
  if (!launcherDir || !path.isAbsolute(launcherDir)) return null
  const seconds = leadReadySeconds(d.serverEnv)
  const pid = deps.pid ?? (Number(d.serverEnv.WALNUT_LAUNCHER_SERVICE_PID) || process.pid)
  const log = deps.log ?? ((line: string) => { process.stderr.write(`walnut --service: ${line}\n`) })
  return watchLeadReady({
    launcherDir, pid, seconds, ...(deps.readReady ? { readReady: deps.readReady } : {}),
    onLate: () => {
      const why = `the leader on ${d.home} was not ready within ${seconds} s`
      try {
        writeServiceRoleFallback(d.stateDir, { role: 'leader', home: d.home, exe: d.exe, at: (deps.now ?? Date.now)(), why })
        log(`${why}; the next start runs the session daemon until the next mode write or version`)
      } catch (err) {
        log(`${why}; the fallback marker was not written: ${err instanceof Error ? err.message : String(err)}`)
      }
      deps.leave()
    },
  })
}
