/**
 * What `walnut daemon install|update` does with the launcher (service-launcher-script.ts) when the
 * experiment service_launcher asks for it: renders the launcher script, asks it for a switch
 * (`launcher/request`, never its state: only the launcher writes which version runs), and waits
 * for its answer (`launcher/result`). The managers (daemon-service-manager.ts, daemon-service-cron.ts)
 * call these through `DaemonServiceDeps.launcher`, so their tests pass a double.
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { execFile } from 'node:child_process'
import type { DaemonServiceConfig } from './daemon-service-config.js'
import { DAEMON_BOOT_SCRIPT_NAME } from './daemon-service-config.js'
import {
  BAD_SECONDS, LAUNCHER_DIR_NAME, LAUNCHER_SCRIPT_NAME, STOP_WAIT_SECONDS, TRIAL_SECONDS, isLauncherScript, renderLauncherScript,
} from './service-launcher-script.js'
import { readLauncherFacts, type LauncherFacts } from './service-launcher-beat.js'

export type LauncherOutcome = 'committed' | 'rolledback' | 'interrupted' | 'refused' | 'failed' | 'current'
export interface LauncherResult { id: string; outcome: LauncherOutcome; exe: string; reason: string }

/** How long a switch may take the launcher: the old service's stop, the new one's trial, a put-back's stop. */
export const SWITCH_WAIT_MS = (STOP_WAIT_SECONDS * 2 + TRIAL_SECONDS + 30) * 1000

export interface LauncherControl {
  /** The launcher script's file. */
  readonly script: string
  /** The script for `config`, with `seed` as its EXEC (the version it runs with no state). */
  render(config: DaemonServiceConfig, seed: string): string
  /** The EXEC of the launcher script on disk, when that file is a launcher. */
  seed(): Promise<string | null>
  /** The launcher's state, null with none. */
  facts(): Promise<LauncherFacts | null>
  /** Ask for a switch to `exe`; `prepared` false holds it until prepared() (the old service still runs). */
  request(exe: string, prepared: boolean): Promise<string>
  prepared(id: string): Promise<void>
  /** Take back a request not acted on (the old service refused to prepare). */
  withdraw(id: string): Promise<void>
  /** The launcher's answer to `id`, or null at the timeout. */
  wait(id: string, timeoutMs?: number): Promise<LauncherResult | null>
  /** The script must be executable for systemd and launchd, which run it directly. */
  chmod(): Promise<void>
  /** Why the launcher would refuse `exe` now (it failed here within a day), or null. */
  refuses(exe: string): Promise<string | null>
  /** Ask the launcher to put the good version back in place of `exe` (it answered, then did not stay). */
  rollback(exe: string, reason: string): Promise<LauncherResult | null>
  /**
   * Forget a launcher state no launcher keeps now (a plain config ran since: an older Walnut took the
   * service back): its versions are not what runs, so the launcher must start from its seed. The day-long
   * refusals and the last put-back stay.
   */
  reset(): Promise<void>
}

function keyValues(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of text.split('\n')) { const at = line.indexOf('='); if (at > 0 && !(line.slice(0, at) in out)) out[line.slice(0, at)] = line.slice(at + 1) }
  return out
}

/** The EXEC of a launcher script's text (sh single quotes), or null. */
export function launcherSeed(text: string): string | null {
  if (!isLauncherScript(text)) return null
  const lines = text.split('\n').filter((line) => line.startsWith('EXEC='))
  if (lines.length !== 1) return null
  const word = lines[0]!.slice(5)
  if (!/^(?:'[^']*'|\\')+$/.test(word)) return null
  const value = word.replace(/'([^']*)'|\\'/g, (_m, inner: string | undefined) => inner ?? "'")
  return value.startsWith('/') ? value : null
}

/** The launcher script's file for a backend: cron keeps the boot script's place (an older Walnut reads it there). */
export function launcherScriptPath(stateDir: string, backend: 'systemd' | 'launchd' | 'cron'): string {
  return path.join(stateDir, backend === 'cron' ? DAEMON_BOOT_SCRIPT_NAME : LAUNCHER_SCRIPT_NAME)
}

/** The daemon build an executable carries (`<exe> __daemon --version`), for the launcher's day-long hold of a failed one. */
export function daemonBuildOf(exe: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile(exe, ['__daemon', '--version'], { timeout: 30_000 }, (error, stdout) => {
      const last = String(stdout ?? '').trim().split('\n').pop()?.trim() ?? ''
      resolve(!error && /^walnut-daemon-[A-Za-z0-9]+$/.test(last) ? last : undefined)
    })
  })
}

async function writeWhole(file: string, text: string): Promise<void> {
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}`
  await fs.writeFile(tmp, text, { mode: 0o600 })
  await fs.rename(tmp, file)
}

export function createLauncherControl(o: {
  stateDir: string
  backend: 'systemd' | 'launchd' | 'cron'
  buildOf?: (exe: string) => Promise<string | undefined>
  sleep?: (ms: number) => Promise<void>
}): LauncherControl {
  const dir = path.join(o.stateDir, LAUNCHER_DIR_NAME)
  const script = launcherScriptPath(o.stateDir, o.backend)
  const requestFile = path.join(dir, 'request')
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const readRequest = async () => keyValues(await fs.readFile(requestFile, 'utf8').catch(() => ''))
  const body = (fields: Record<string, string>) => Object.entries(fields).map(([k, v]) => `${k}=${v.replace(/[\r\n]+/g, ' ')}\n`).join('')
  return {
    script,
    render: (config, seed) => renderLauncherScript({ ...config, executable: seed }, { backend: o.backend, self: script }),
    seed: async () => launcherSeed(await fs.readFile(script, 'utf8').catch(() => '')),
    facts: () => readLauncherFacts(dir),
    async request(exe, prepared) {
      await fs.mkdir(dir, { recursive: true, mode: 0o700 })
      const id = `u${Date.now().toString(36)}${randomBytes(4).toString('hex')}`
      const build = await (o.buildOf ?? daemonBuildOf)(exe)
      await writeWhole(requestFile, body({ id, op: 'switch', exe, ...(build ? { build } : {}), prepared: prepared ? '1' : '0', at: String(Math.floor(Date.now() / 1000)) }))
      return id
    },
    async prepared(id) {
      const req = await readRequest()
      if (req.id !== id) return
      await writeWhole(requestFile, body({ ...req, prepared: '1' }))
    },
    async withdraw(id) {
      if ((await readRequest()).id === id) await fs.rm(requestFile, { force: true })
    },
    async wait(id, timeoutMs = SWITCH_WAIT_MS) {
      const end = Date.now() + timeoutMs
      for (;;) {
        const r = keyValues(await fs.readFile(path.join(dir, 'result'), 'utf8').catch(() => ''))
        if (r.id === id && r.outcome) return { id, outcome: r.outcome as LauncherOutcome, exe: r.exe ?? '', reason: r.reason ?? '' }
        if (Date.now() >= end) return null
        await sleep(250)
      }
    },
    chmod: () => fs.chmod(script, 0o700),
    async refuses(exe) {
      const now = Math.floor(Date.now() / 1000)
      const lines = (await fs.readFile(path.join(dir, 'bad'), 'utf8').catch(() => '')).split('\n')
      const hit = lines.map((line) => /^(\d+) (.+)$/.exec(line)).find((m) => m && m[2] === exe && now - Number(m[1]) < BAD_SECONDS)
      return hit ? `this version failed here ${Math.round((now - Number(hit[1])) / 60)} minutes ago, so the launcher refuses it for a day` : null
    },
    async rollback(exe, reason) {
      await fs.mkdir(dir, { recursive: true, mode: 0o700 })
      const id = `b${Date.now().toString(36)}${randomBytes(4).toString('hex')}`
      await writeWhole(requestFile, body({ id, op: 'rollback', exe, reason, prepared: '1', at: String(Math.floor(Date.now() / 1000)) }))
      return this.wait(id)
    },
    async reset() {
      await Promise.all(['state', 'request', 'result', 'ready'].map((name) => fs.rm(path.join(dir, name), { force: true })))
    },
  }
}

/** The versions a prune must keep for the launcher: what it runs, what it goes back to, what it was asked for, its seed. */
export async function launcherKeeps(stateDir: string, backend: 'systemd' | 'launchd' | 'cron'): Promise<string[]> {
  const control = createLauncherControl({ stateDir, backend })
  const facts = await control.facts()
  const req = keyValues(await fs.readFile(path.join(stateDir, LAUNCHER_DIR_NAME, 'request'), 'utf8').catch(() => ''))
  return [facts?.current, facts?.good, req.exe, await control.seed()].filter((exe): exe is string => !!exe && exe.startsWith('/'))
}
