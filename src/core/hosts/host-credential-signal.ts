/**
 * "I just ran my login command": notice a local SSH credential change while a
 * host waits on one, and redial that host now. An expired certificate or a
 * missing agent is fixed OUTSIDE Walnut, and the credential clock (1, 2, 5, 10
 * minutes, then hourly) used to be the only thing that noticed: on 2026-09-29 a
 * certificate renewed at 08:00 left the host dark until its next hourly re-dial.
 *
 * Two cheap observations, and only while some host waits on a credential:
 *  - files: every regular file in ~/.ssh (keys, certificates, config), never
 *    known_hosts or a ControlMaster socket. One modified AFTER the host's last
 *    failed dial means the login happened since. Comparing with the failure
 *    time needs no baseline, so a login made between the failure and the first
 *    poll still counts; a redial that fails again moves the failure time past
 *    the file, so one change is one redial, never a loop.
 *  - agent: `ssh-add -L` when SSH_AUTH_SOCK is set (an agent has no mtime), so
 *    its listing is compared with the previous poll's.
 * A host redials at most once per HOST_REDIAL_MIN_INTERVAL_MS. Everything is
 * async: one readdir with its stats, and one short child process per poll.
 */

import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { log } from '../../logging/index.js'
import { HOST_REDIAL_MIN_INTERVAL_MS } from './host-wake-signal.js'

export const CREDENTIAL_POLL_MS = 15_000
/** A file dated further ahead than this is a skewed clock, not a login. */
const FUTURE_SLACK_MS = 60_000
/** Bound on the files looked at, so a crowded ~/.ssh cannot slow a poll. */
const MAX_FILES = 200
const AGENT_TIMEOUT_MS = 3_000
/** Files in ~/.ssh that never hold the user's own credential. */
const NOT_A_CREDENTIAL = /^(known_hosts|authorized_keys)/

export interface CredentialWaiter {
  host: string
  /** When the host's last real dial failed (ms epoch). */
  failedAt: number
}

export interface HostCredentialSignalDeps {
  /** Hosts waiting on a credential fix right now. */
  waiting: () => CredentialWaiter[]
  redial: (host: string) => void
  /** Newest credential-file mtime (ms), null when none can be read. Default: ~/.ssh. */
  newestFileMtime?: () => Promise<number | null>
  /** The agent's key listing, null when there is no agent to ask. Default: `ssh-add -L`. */
  agentListing?: () => Promise<string | null>
  now?: () => number
  setInterval?: (fn: () => void, ms: number) => { unref?: () => void }
  clearInterval?: (t: unknown) => void
}

export interface HostCredentialSignal {
  /** One poll (exposed so tests drive it without real timers); resolves with the hosts redialled. */
  poll: () => Promise<string[]>
  stop: () => void
}

/** Newest mtime among the regular files of `dir` (ms), ignoring non-credentials and future dates. */
export async function newestSshFileMtime(
  dir: string = path.join(process.env.HOME || os.homedir(), '.ssh'),
  nowMs: number = Date.now(),
): Promise<number | null> {
  let names: string[]
  try { names = await fs.readdir(dir) } catch { return null }
  const stats = await Promise.all(names.filter((n) => !NOT_A_CREDENTIAL.test(n)).slice(0, MAX_FILES)
    .map((n) => fs.stat(path.join(dir, n)).catch(() => null)))
  let newest: number | null = null
  for (const st of stats) {
    // isFile(): a ControlMaster socket changes with every ssh the user runs.
    if (!st?.isFile() || st.mtimeMs > nowMs + FUTURE_SLACK_MS) continue
    if (newest === null || st.mtimeMs > newest) newest = st.mtimeMs
  }
  return newest
}

/**
 * `ssh-add -L` with its exit code (1 = no identities, 2 = no agent). Null when
 * there is nothing to compare: no SSH_AUTH_SOCK, or the call itself timed out
 * (a slow machine must not read as a new login every other poll).
 */
export function sshAgentListing(env: Record<string, string | undefined> = process.env): Promise<string | null> {
  if (!env.SSH_AUTH_SOCK) return Promise.resolve(null)
  return new Promise((resolve) => {
    execFile('ssh-add', ['-L'], { encoding: 'utf-8', timeout: AGENT_TIMEOUT_MS, maxBuffer: 256 * 1024 }, (err, stdout) => {
      const code = err ? (err as { code?: unknown }).code : 0
      resolve(typeof code === 'number' ? `${code}\n${String(stdout ?? '')}` : null)
    })
  })
}

export function startHostCredentialSignal(deps: HostCredentialSignalDeps): HostCredentialSignal {
  const now = deps.now ?? Date.now
  const newestFileMtime = deps.newestFileMtime ?? (() => newestSshFileMtime(undefined, now()))
  const agentListing = deps.agentListing ?? (() => sshAgentListing())
  const lastRedialAt = new Map<string, number>()
  /** The last agent listing read in this wait; undefined = none yet. */
  let lastAgent: string | undefined
  let polling = false

  const poll = async (): Promise<string[]> => {
    if (polling) return []
    // One entry per host: the latest failure is the one a new login must postdate.
    const waiters = new Map<string, number>()
    for (const w of deps.waiting()) waiters.set(w.host, Math.max(w.failedAt, waiters.get(w.host) ?? -Infinity))
    if (waiters.size === 0) {
      // Nobody waits: no stat, no child process, and the next wait starts fresh.
      lastAgent = undefined
      return []
    }
    polling = true
    try {
      const [newest, agent] = await Promise.all([
        newestFileMtime().catch(() => null),
        agentListing().catch(() => null),
      ])
      // An unreadable listing (null) says nothing, so it neither counts nor resets the comparison.
      const agentChanged = agent !== null && lastAgent !== undefined && agent !== lastAgent
      if (agent !== null) lastAgent = agent
      const at = now()
      const due = [...waiters].filter(([host, failedAt]) =>
        (agentChanged || (newest !== null && newest > failedAt))
        && at - (lastRedialAt.get(host) ?? -Infinity) >= HOST_REDIAL_MIN_INTERVAL_MS,
      ).map(([host]) => host)
      if (due.length === 0) return []
      log.session.info('host credential change: redialling', { hosts: due, via: agentChanged ? 'agent' : 'files' })
      for (const host of due) {
        lastRedialAt.set(host, at)
        try { deps.redial(host) } catch (err) {
          log.session.warn('host redial after a credential change failed to start', { host, error: err instanceof Error ? err.message : String(err) })
        }
      }
      return due
    } finally {
      polling = false
    }
  }

  const si = deps.setInterval ?? ((fn: () => void, ms: number) => setInterval(fn, ms))
  const ci = deps.clearInterval ?? ((t: unknown) => clearInterval(t as ReturnType<typeof setInterval>))
  const timer = si(() => { void poll() }, CREDENTIAL_POLL_MS)
  timer.unref?.()
  return { poll, stop: () => ci(timer) }
}
