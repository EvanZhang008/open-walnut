/**
 * `walnut web --_trial-start`: the restore drill's trial server (src/core/backup/restore-drill-boot.ts
 * starts it; src/core/trial-start/ticket.ts says how it is entered). It takes the ticket the drill
 * left in the restored home, or refuses to start; then boots the full server program in the boot
 * policy's trial column (HTTP, the databases and their migrations, every outward door closed) on a
 * port the OS picks, on loopback only, and writes where it listens into the home
 * (TRIAL_SERVER_FILE) for the drill. It stops on SIGTERM, and by itself once the drill is gone.
 *
 * Unlike a normal `walnut web` it never installs an update, never applies a pending switch to
 * restored data, and never registers a live restart: it only boots once and answers.
 */
import fs from 'node:fs'
import path from 'node:path'
import { watchForOrphan } from '../lib/exit-on-orphan.js'

/** Where the trial server says how it listens, relative to its home. */
export const TRIAL_SERVER_FILE = path.join('local', 'trial-server.json')

export interface TrialServerInfo {
  pid: number
  port: number
  bootMode: string
  purpose: string | null
  doorsClosed: boolean
  /** From the start of the boot to listening. */
  bootMs: number
}

export async function runTrialChild(opts: { bailMs: number }): Promise<void> {
  const { WALNUT_HOME } = await import('../constants.js')
  const { takeTrialTicket } = await import('../core/trial-start/ticket.js')
  let purpose: ReturnType<typeof takeTrialTicket>
  try {
    purpose = takeTrialTicket({ home: WALNUT_HOME })
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`)
    process.exit(2)
  }
  if (!purpose) {
    process.stderr.write('walnut web --_trial-start: not a trial start\n')
    process.exit(2)
  }
  const parent = process.ppid
  const { startServer, stopServer, armGracefulSignalExit } = await import('../web/server.js')
  let stopping = false
  const shutdown = async (why: string) => {
    if (stopping) return
    stopping = true
    const bail = setTimeout(() => process.exit(1), opts.bailMs)
    try {
      await stopServer({ reason: why, bailMs: opts.bailMs })
    } catch {
      // A failed teardown still ends the process.
    } finally {
      clearTimeout(bail)
    }
    process.exit(0)
  }
  process.on('SIGINT', () => void shutdown('SIGINT'))
  process.on('SIGTERM', () => void shutdown('SIGTERM'))
  process.on('SIGHUP', () => void shutdown('SIGHUP'))
  armGracefulSignalExit()
  // The drill was killed: nobody will stop this server, and its folder goes with the next drill.
  watchForOrphan(parent, () => void shutdown('parent_gone'))

  const started = Date.now()
  const http = await startServer({ port: 0, bindAddress: '127.0.0.1', trialStart: purpose })
  const addr = http.address()
  const port = typeof addr === 'object' && addr ? addr.port : 0
  const { bootMode, trialPurpose } = await import('../core/boot-policy.js')
  const { doorsClosed } = await import('../core/leader/switch/doors.js')
  const info: TrialServerInfo = { pid: process.pid, port, bootMode: bootMode(), purpose: trialPurpose(), doorsClosed: doorsClosed(), bootMs: Date.now() - started }
  const file = path.join(WALNUT_HOME, TRIAL_SERVER_FILE)
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(info), { mode: 0o600 })
  fs.renameSync(`${file}.tmp`, file)
}
