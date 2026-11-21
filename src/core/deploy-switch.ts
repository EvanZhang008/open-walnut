/**
 * A deploy's switch of this machine's server, as a server the Mac app starts on its own sees it.
 *
 *   WALNUT_HOME/local/deploy-switch.json   { pid, at }   (local/: never git-synced)
 *
 * scripts/dev-prod.sh writes it right before it stops the serving server and removes it when
 * it ends. Walnut.app restarts a server it started itself one second after that server exits,
 * from the checkout's dist (`bun <checkout>/dist/cli.js web`), and that restart used to take
 * the instance lock before the deploy's own server could (2026-11-21: from then on the app's
 * server, not the deploy's compiled file, served production, and every remote host got a daemon
 * without the compiled file's ACP files). A server the app started itself (WALNUT_LAUNCHER=
 * mac-app) that finds a live switch waits for the deploy's
 * server to take the lock; the lock then refuses it, and the app attaches to the deploy's
 * server (desktop/main.swift handleServerStartupFailure). Bounded: a switch whose deploy is
 * gone, an old one, or one that outlasts MAX_WAIT_MS lets it start as before.
 */

import fsp from 'node:fs/promises'
import path from 'node:path'

export const DEPLOY_SWITCH_TTL_MS = 10 * 60_000
export const DEPLOY_SWITCH_MAX_WAIT_MS = 120_000

export function deploySwitchFile(home: string): string {
  return path.join(home, 'local', 'deploy-switch.json')
}

/**
 * A server Walnut.app started itself, which the app restarts on its own: the only one that waits.
 * The app sets WALNUT_LAUNCHER=mac-app for its own server; both of a deploy's launch paths remove
 * it (scripts/dev-prod.sh). Other variables say nothing: the app passes its own environment on,
 * and an app opened from a deploy's server carries that server's WALNUT_LAUNCHD_LABEL (2026-11-21:
 * read as "a deploy's server", the app's restart did not wait).
 */
export function isAppStartedServer(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.WALNUT_LAUNCHER === 'mac-app'
}

export interface DeploySwitch { pid: number; at: number }

/** The switch when the marker names a deploy pid and a time within the TTL; else null. */
export function parseDeploySwitch(raw: string, now = Date.now()): DeploySwitch | null {
  try {
    const v = JSON.parse(raw) as { pid?: unknown; at?: unknown }
    const pid = typeof v.pid === 'number' && Number.isInteger(v.pid) && v.pid > 1 ? v.pid : null
    const at = typeof v.at === 'string' ? Date.parse(v.at) : NaN
    if (!pid || !Number.isFinite(at) || now - at > DEPLOY_SWITCH_TTL_MS || at - now > 60_000) return null
    return { pid, at }
  } catch {
    return null
  }
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch (err) { return (err as NodeJS.ErrnoException).code === 'EPERM' }
}

async function readText(file: string): Promise<string | null> {
  try { return await fsp.readFile(file, 'utf8') } catch { return null }
}

export interface DeploySwitchWait {
  home: string
  /** The instance lock file (instance-lock.ts LOCK_FILE). */
  lockFile: string
  env?: NodeJS.ProcessEnv
  maxWaitMs?: number
  pollMs?: number
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  onWait?: (deployPid: number) => void
}

/**
 * Waits, when this is a server the app started and a deploy is switching the server, until
 * another live process holds the instance lock ('lock-taken'), the switch is over ('ended'),
 * or the wait runs out ('timeout'). 'none' when there was nothing to wait for.
 */
export async function waitOutDeploySwitch(o: DeploySwitchWait): Promise<'none' | 'lock-taken' | 'ended' | 'timeout'> {
  if (!isAppStartedServer(o.env)) return 'none'
  const now = o.now ?? Date.now
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const file = deploySwitchFile(o.home)
  const first = await readText(file)
  const sw = first === null ? null : parseDeploySwitch(first, now())
  if (!sw || !alive(sw.pid)) return 'none'
  const pid = sw.pid
  o.onWait?.(pid)
  const until = now() + (o.maxWaitMs ?? DEPLOY_SWITCH_MAX_WAIT_MS)
  for (;;) {
    const lock = await readText(o.lockFile)
    if (lock !== null) {
      try {
        // The deploy's server: started after the switch began (the marker's time has whole
        // seconds). The outgoing server may still hold the lock while it shuts down.
        const l = JSON.parse(lock) as { pid?: unknown; startedAt?: unknown }
        const started = typeof l.startedAt === 'string' ? Date.parse(l.startedAt) : NaN
        if (typeof l.pid === 'number' && l.pid !== process.pid && Number.isFinite(started)
          && started >= sw.at - 1000 && alive(l.pid)) return 'lock-taken'
      } catch { /* corrupt: the lock code treats it as absent */ }
    }
    const raw = await readText(file)
    const still = raw === null ? null : parseDeploySwitch(raw, now())
    if (still?.pid !== pid || !alive(pid)) return 'ended'
    if (now() >= until) return 'timeout'
    await sleep(o.pollMs ?? 250)
  }
}
