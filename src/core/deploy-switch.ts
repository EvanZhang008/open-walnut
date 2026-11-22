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
 *
 *   WALNUT_HOME/local/service-launcher.json   { state }   (the Mac's service launcher, installed by dev-prod.sh)
 *
 * The same holds while the service launcher keeps this Walnut's server (it restarts it within
 * seconds of any exit, and at login): an app-started server whose launcher is alive (its pid in
 * `<state>/daemon-boot.pid`) waits for any other live server to hold the lock, so the app attaches
 * to the launcher's server instead of racing it. One installed (the mark names its plist, which is
 * there) but not running yet, as at a login, is waited for up to LAUNCHER_START_WAIT_MS; one that never
 * comes, or no launcher, lets it start as before.
 */

import fsp from 'node:fs/promises'
import path from 'node:path'

export const DEPLOY_SWITCH_TTL_MS = 10 * 60_000
export const DEPLOY_SWITCH_MAX_WAIT_MS = 120_000

export function deploySwitchFile(home: string): string {
  return path.join(home, 'local', 'deploy-switch.json')
}

/** Where dev-prod.sh says which service launcher keeps this Walnut's server (absent: none). */
export function serviceLauncherFile(home: string): string {
  return path.join(home, 'local', 'service-launcher.json')
}

/** How long an app-started server waits for an installed launcher to start (at login launchd may start it after the app). */
export const LAUNCHER_START_WAIT_MS = 60_000

interface LauncherMark { state: string; plist: string | null }

async function launcherMark(home: string): Promise<LauncherMark | null> {
  const raw = await readText(serviceLauncherFile(home))
  if (raw === null) return null
  try {
    const v = JSON.parse(raw) as { state?: unknown; plist?: unknown }
    if (typeof v.state !== 'string' || !path.isAbsolute(v.state)) return null
    return { state: v.state, plist: typeof v.plist === 'string' && path.isAbsolute(v.plist) ? v.plist : null }
  } catch { return null }
}

/** The pid of the live launcher that keeps this Walnut's server, or null. */
export async function liveServiceLauncher(home: string): Promise<number | null> {
  const mark = await launcherMark(home)
  if (!mark) return null
  const pid = Number((await readText(path.join(mark.state, 'daemon-boot.pid')))?.trim())
  return Number.isInteger(pid) && pid > 1 && alive(pid) ? pid : null
}

/** A launcher is installed (its mark and its launchd plist are there), running or not. */
async function launcherInstalled(home: string): Promise<boolean> {
  const mark = await launcherMark(home)
  return !!mark?.plist && (await readText(mark.plist)) !== null
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
  /** The pid it waits for (a deploy's, the launcher's; 0 while it waits for an installed launcher to start). */
  onWait?: (deployPid: number) => void
  launcherStartWaitMs?: number
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
  // A deploy's switch is waited out first; with none, a live service launcher (its server may
  // have started long ago, so any live holder counts).
  let launcher = sw && alive(sw.pid) ? null : await liveServiceLauncher(o.home)
  // Installed but not running yet (a login: launchd may start it after the app): wait for it, bounded.
  if (!(sw && alive(sw.pid)) && !launcher && await launcherInstalled(o.home)) {
    const appear = now() + (o.launcherStartWaitMs ?? LAUNCHER_START_WAIT_MS)
    o.onWait?.(0)
    while (!launcher && now() < appear) {
      await sleep(o.pollMs ?? 250)
      launcher = await liveServiceLauncher(o.home)
    }
    if (!launcher) return 'timeout'
  }
  if (!(sw && alive(sw.pid)) && !launcher) return 'none'
  const pid = launcher ?? sw!.pid
  const since = launcher ? Number.NEGATIVE_INFINITY : sw!.at - 1000
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
          && started >= since && alive(l.pid)) return 'lock-taken'
      } catch { /* corrupt: the lock code treats it as absent */ }
    }
    if (launcher) {
      if (!alive(launcher)) return 'ended'
    } else {
      const raw = await readText(file)
      const still = raw === null ? null : parseDeploySwitch(raw, now())
      if (still?.pid !== pid || !alive(pid)) return 'ended'
    }
    if (now() >= until) return 'timeout'
    await sleep(o.pollMs ?? 250)
  }
}
