/**
 * The launchd half of the service manager (daemon-service-manager.ts): reading what
 * `launchctl print` says, and unloading and loading the LaunchAgent so that no install,
 * update, rollback or restart ends with no job loaded when one was loaded before.
 *
 * `launchctl bootout` answers before launchd has let the job go (a 47 ms answer for a
 * job that took 3 s to exit; scripts/dev-prod.sh guards the server's own reload the same
 * way), and a bootstrap of a label still on its way out fails (5: Input/output error,
 * 36 or 37: operation in progress). 2026-11-04: a host network Mac's daemon update booted
 * the old job out and bootstrapped at once; the bootstrap failed, the rollback met the
 * same race, and nothing was loaded until its owner logged in again. So a bootout waits
 * until print stops showing the job, a bootstrap asks again for a while, and a job launchd
 * shows loaded from our plist counts as loaded (an earlier try may have gone through).
 */
import { randomBytes } from 'node:crypto'
import type { DaemonServiceCommandResult } from './daemon-service-manager.js'

export type LaunchdOverride = 'allowed' | 'disabled' | 'unknown'

/** `launchctl print` of a label launchd does not have. */
export const LAUNCHD_NOT_LOADED = 113
/** How long a bootout waits for launchd to let the job go. */
export const BOOTOUT_SETTLE_MS = 25_000
/** How long a bootstrap asks again after a failure. */
export const BOOTSTRAP_RETRY_MS = 30_000
/**
 * By when a booted-out job is gone for sure: launchd kills it at the plist's ExitTimeOut
 * (60 s, daemon-service-config.ts renderDaemonLaunchAgent), plus a little.
 */
export const JOB_GONE_BY_MS = 65_000
const SETTLE_POLL_MS = 250
const RETRY_PAUSE_MS = 1_000
/** How long a job just loaded may go without a process before launchd counts as not starting it (kickstarted halfway). */
export const SPAWN_WAIT_MS = 8_000
/** The update waits for launchd to start jobs again; the words every surface shows. */
export const LAUNCHD_NOT_SPAWNING = 'launchd is starting no jobs in this login session now (a dark wake with the lid closed, or a login not finished)'

// launchctl print puts the plist it loaded on its own line; the spacing varies.
const LAUNCHD_PATH = /^[ \t]*path[ \t]*=[ \t]*(\S[^\n]*?)[ \t]*$/m
const LAUNCHD_PID = /^[ \t]*pid[ \t]*=[ \t]*\d+/m
/** A job launchd has started at least once ("runs = 2"): a missing pid is then its exit, not a spawn that never came. */
const LAUNCHD_RAN = /^[ \t]*runs[ \t]*=[ \t]*[1-9]/m
const DISABLED_BLOCK = /disabled\s+services\s*=\s*\{([^}]*)\}/

/** The plist path launchd says it loaded the job from, or null. */
export function launchdLoadedFrom(stdout: string): string | null {
  return LAUNCHD_PATH.exec(stdout)?.[1] ?? null
}

export function parseLaunchdOverride(stdout: string, label: string): LaunchdOverride {
  const block = DISABLED_BLOCK.exec(stdout)
  if (!block) return 'unknown'
  let verdict: LaunchdOverride = 'allowed'
  for (const line of block[1].split('\n').map((line) => line.trim()).filter(Boolean)) {
    const entry = line.match(/^"([^"]+)"\s*=>\s*(true|false|disabled|enabled)\s*,?$/)
    if (!entry) return 'unknown'
    if (entry[1] === label) verdict = ['true', 'disabled'].includes(entry[2]) ? 'disabled' : 'allowed'
  }
  return verdict
}

/**
 * Whether launchd starts jobs in this login session now. In a dark wake with the lid closed,
 * or before a login finished, it loads jobs and starts none ("pending spawn, domain in
 * on-demand-only mode"). 2026-11-04: a Mac's update stopped its only daemon there, and neither
 * the new job nor the restored one ran until a reboot and login 1 h 45 min later. `t_spawns`
 * loads a throwaway job that only touches a file, and sets ts_sp: ok, none, or unknown.
 *
 * Each probe has a label and a dir of its own (`$1`, else a random id), so two probes never
 * boot out each other's job and read a false "none" (2026-11-04 review: one fixed label did).
 * It always cleans up (t_spawns_clean), and first boots out any probe job whose dir is gone
 * (one killed before it could clean up, or the fixed label of an older build).
 */
export function launchdSpawnProbeLines(serviceLabel: string): string[] {
  const base = `${serviceLabel}.spawn-probe`
  const plist = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<plist version="1.0"><dict><key>Label</key><string>@LABEL@</string>',
    '<key>ProgramArguments</key><array><string>/usr/bin/touch</string><string>@RAN@</string></array>',
    '<key>RunAtLoad</key><true/></dict></plist>',
  ].map((line) => `'${line.replace('@LABEL@', `'"$ts_l"'`).replace('@RAN@', `'"$tp/ran"'`)}'`).join(' ')
  return [
    `t_spawns_clean() { [ -n "\${ts_l:-}" ] && launchctl bootout "gui/$tu/$ts_l" >/dev/null 2>&1; [ -n "\${tp:-}" ] && rm -rf "$tp"; ts_l=; tp=; }`,
    't_spawns() {',
    '  ts_sp=unknown; tp=; ts_l=',
    '  ts_id=${1:-$(od -An -N6 -tx1 /dev/urandom 2>/dev/null | tr -d " \\n")}',
    '  case "$ts_id" in ""|*[!0-9a-f]*) return 0;; esac',
    `  for ts_o in $(launchctl list 2>/dev/null | awk '{print $3}' | grep '^${base.replace(/\./g, '\\.')}'); do`,
    '    [ -d "/tmp/walnut-spawn-probe.${ts_o##*.}" ] || launchctl bootout "gui/$tu/$ts_o" >/dev/null 2>&1',
    '  done',
    `  (umask 077; mkdir "/tmp/walnut-spawn-probe.$ts_id") 2>/dev/null || return 0`,
    `  tp="/tmp/walnut-spawn-probe.$ts_id"; ts_l="${base}.$ts_id"`,
    `  printf '%s\\n' ${plist} > "$tp/spawn-probe.plist"`,
    '  chmod 644 "$tp/spawn-probe.plist"',
    '  if launchctl bootstrap "gui/$tu" "$tp/spawn-probe.plist" >/dev/null 2>&1; then',
    // Its own counter (ts_n): every name here starts ts_ or tp, since the tail and the stand-in
    // call this from their own shell, where tq holds the tail's words (2026-11-04 review).
    // ts_w: how many tenths of a second it waits (the tail asks for longer, two probes in a row).
    '    ts_n=0; while [ ! -e "$tp/ran" ] && [ "$ts_n" -lt "${ts_w:-50}" ]; do sleep 0.1; ts_n=$((ts_n + 1)); done',
    '    if [ -e "$tp/ran" ]; then ts_sp=ok; else ts_sp=none; fi',
    '  fi',
    '  t_spawns_clean',
    '}',
  ]
}

export interface LaunchAgentIo {
  run(program: string, args: string[]): Promise<DaemonServiceCommandResult>
  sleep(ms: number): Promise<void>
  /** Monotonic (performance.now): every wait here is in this process, and a sleep must not end one. */
  now(): number
}

/** A step that did not end where it should: what to tell, and the command it was about. */
export interface LaunchdShortfall {
  message: string
  command: string
  stderr?: string
}

export interface LaunchAgentControl {
  /** Bootout, then wait while print still shows the job. null: it is gone (or launchd stopped saying). */
  bootout(): Promise<LaunchdShortfall | null>
  /** Bootstrap the plist, asking again for up to BOOTSTRAP_RETRY_MS. null: our job is loaded. */
  bootstrap(): Promise<LaunchdShortfall | null>
  /**
   * Load the plist when it is on disk and launchd has no job for the label: the last step
   * of every exit that found the job loaded. `did` = it had to load it.
   */
  ensureLoaded(onDisk: boolean): Promise<{ loaded: boolean; did: boolean; why?: string }>
  /**
   * After a bootstrap: launchd started a process for the job (a pid) within SPAWN_WAIT_MS,
   * kickstarted once halfway. A job loaded that never ran is a start that failed, found in
   * seconds, not a slow one (2026-11-04: "pending spawn, domain in on-demand-only mode").
   */
  spawned(): Promise<LaunchdShortfall | null>
}

/** What the spawn probe saw: launchd ran its job (ok), loaded it and ran nothing (none), or no answer (unknown). */
export type LaunchdSpawn = 'ok' | 'none' | 'unknown'
/** The probe's own wait is 5 s; launchctl under load takes far longer than that to answer (2026-11-04 review: 15 s timed out). */
export const SPAWN_PROBE_TIMEOUT_MS = 60_000

/**
 * Before anything is stopped: does launchd start a job now? A probe that timed out or could
 * not run says nothing (unknown), never "it starts jobs"; its job and dir go either way.
 */
export async function launchdSpawnsJobs(
  run: (program: string, args: string[], timeoutMs?: number) => Promise<DaemonServiceCommandResult>, uid: number, label: string,
  id: string = randomBytes(6).toString('hex'),
): Promise<LaunchdSpawn> {
  if (!/^[0-9a-f]{6,32}$/.test(id)) throw new Error('the spawn probe id must be a short hex word')
  const script = [`tu=${uid}`, ...launchdSpawnProbeLines(label), "trap 't_spawns_clean; exit 1' TERM INT HUP", `t_spawns ${id}`, 'echo "walnut-spawn=$ts_sp"'].join('\n')
  const said = await run('/bin/sh', ['-c', script], SPAWN_PROBE_TIMEOUT_MS)
  const seen = /walnut-spawn=(ok|none|unknown)/.exec(said.stdout)?.[1] as LaunchdSpawn | undefined
  // Killed before it answered: its trap may not have run, so its job and dir go from here.
  if (!seen) {
    await run('launchctl', ['bootout', `gui/${uid}/${label}.spawn-probe.${id}`]).catch(() => null)
    await run('/bin/rm', ['-rf', `/tmp/walnut-spawn-probe.${id}`]).catch(() => null)
  }
  return seen ?? 'unknown'
}

export function createLaunchAgentControl(io: LaunchAgentIo, o: { uid: number; label: string; plist: string }): LaunchAgentControl {
  const target = `gui/${o.uid}/${o.label}`
  const domain = `gui/${o.uid}`
  const line = (args: string[]) => ['launchctl', ...args].join(' ')
  const print = () => io.run('launchctl', ['print', target])
  // The first bootout no bootstrap followed yet: until JOB_GONE_BY_MS after it, a job print
  // shows may be that one on its way out, not a loaded one.
  let bootedOutAt: number | null = null

  async function bootout(): Promise<LaunchdShortfall | null> {
    const args = ['bootout', target]
    bootedOutAt ??= io.now()
    const out = await io.run('launchctl', args)
    const deadline = io.now() + BOOTOUT_SETTLE_MS
    for (;;) {
      // Only a print that still shows the job keeps the wait going; a print that cannot
      // tell is left to the caller's own probe, which refuses on it.
      if ((await print()).code !== 0) return null
      if (io.now() >= deadline) break
      await io.sleep(SETTLE_POLL_MS)
    }
    return out.code !== 0
      ? { message: `${line(args)} exited with ${out.code} and ${o.label} stayed loaded`, command: line(args), stderr: out.stderr }
      : { message: `${o.label} was still loaded ${Math.round(BOOTOUT_SETTLE_MS / 1000)} s after ${line(args)}`, command: line(args) }
  }

  async function bootstrap(): Promise<LaunchdShortfall | null> {
    const args = ['bootstrap', domain, o.plist]
    const deadline = io.now() + BOOTSTRAP_RETRY_MS
    let last: DaemonServiceCommandResult
    for (;;) {
      last = await io.run('launchctl', args)
      if (last.code === 0) { bootedOutAt = null; return null }
      const shown = await print()
      if (shown.code === 0) {
        const from = launchdLoadedFrom(shown.stdout)
        if (from === o.plist) { bootedOutAt = null; return null }
        if (from) return { message: `${line(args)} exited with ${last.code}, and ${o.label} is loaded from ${from}`, command: line(args), stderr: last.stderr }
      }
      if (io.now() >= deadline) break
      await io.sleep(RETRY_PAUSE_MS)
    }
    return {
      message: `${line(args)} kept failing for ${Math.round(BOOTSTRAP_RETRY_MS / 1000)} s (last exit ${last.code})`,
      command: line(args), stderr: last.stderr,
    }
  }

  async function ensureLoaded(onDisk: boolean): Promise<{ loaded: boolean; did: boolean; why?: string }> {
    // A job our own bootout ended may still show for a while: wait until it is gone for sure.
    if (bootedOutAt !== null) {
      const until = bootedOutAt + JOB_GONE_BY_MS
      while ((await print()).code === 0 && io.now() < until) await io.sleep(SETTLE_POLL_MS)
    }
    const shown = await print()
    if (shown.code === 0) return { loaded: true, did: false }
    if (!onDisk) return { loaded: false, did: false, why: 'its plist is not on disk' }
    if (shown.code !== LAUNCHD_NOT_LOADED) return { loaded: false, did: false, why: `${line(['print', target])} exited with ${shown.code}` }
    const short = await bootstrap()
    return short ? { loaded: false, did: false, why: short.message } : { loaded: true, did: true }
  }

  async function spawned(): Promise<LaunchdShortfall | null> {
    const deadline = io.now() + SPAWN_WAIT_MS
    let kicked = false
    for (;;) {
      const shown = await print()
      // Not ours to judge: a print that cannot answer, and a job that ran and exited (the readiness check decides).
      if (shown.code !== 0 || LAUNCHD_PID.test(shown.stdout) || LAUNCHD_RAN.test(shown.stdout)) return null
      if (!kicked && io.now() >= deadline - SPAWN_WAIT_MS / 2) {
        kicked = true
        await io.run('launchctl', ['kickstart', target])
      }
      if (io.now() >= deadline) break
      await io.sleep(SETTLE_POLL_MS)
    }
    return { message: `launchd loaded ${o.label} and started no process for it within ${SPAWN_WAIT_MS / 1000} s, kickstarted too: ${LAUNCHD_NOT_SPAWNING}`, command: line(['print', target]) }
  }

  return { bootout, bootstrap, ensureLoaded, spawned }
}
