/**
 * `walnut daemon handback`: the stand-in an update's tail started outside launchd
 * (daemon-update-standin.ts) hands its sessions to the LaunchAgent's own job, the way any
 * service daemon hands over before an update. 2026-11-04 review: the stand-in was ended with
 * a SIGTERM, which cut the ACP turns, host_exec runs and relays the update path waits for.
 *
 *   1. it is a stand-in: `daemon.standin` names the daemon that serves the runtime dir;
 *   2. launchd has the service's job loaded and starts jobs now (the spawn probe; a probe with
 *      no answer counts once launchd has run the job: it then tries to start it beside the
 *      stand-in again and again, so waiting for an answer would leave it at that for good),
 *      else nothing is touched: loading the job here would start launchd's daemon beside the
 *      stand-in, and a job launchd would not load is no better after the stand-in stopped
 *      (a login loads it, and the stand-in hands back then);
 *   3. the stand-in is asked to prepare an update (`service.update`): refused while it has
 *      work, and then nothing changed and it keeps serving; else it exits;
 *   4. the job is kickstarted; its daemon adopts the sessions;
 *   5. a daemon of the job must answer within the service wait. When none does, the stand-in's
 *      loop starts it again: the host is never left without one for long.
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import type { LaunchdSpawn } from './daemon-service-launchd.js'
import { STANDIN_PID_NAME } from './daemon-update-standin.js'

export interface HandbackResult { ok: boolean; message?: string; failure?: { code: string; message: string } }

export interface HandbackDeps {
  platform: string
  runtimeDir: string
  /** The plist on disk is Walnut's own (daemon-service-files.ts). */
  ours(): Promise<boolean>
  spawns(): Promise<LaunchdSpawn>
  /** `service.update` to the running daemon, waiting until it exited (daemon-service-cli.ts requestDaemonServiceUpdate). */
  prepareUpdate(): Promise<void | 'prepared' | 'unprepared'>
  /** The service's job as `launchctl print` shows it: null when launchd has none loaded; `runs`, how often it started it. */
  job(): Promise<{ runs: number } | null>
  kickstart(): Promise<void>
  /** A daemon other than `previousInstance` answers as the service's. */
  ready(previousInstance: string | undefined): Promise<boolean>
  alive(pid: number): boolean
}

const fail = (code: string, message: string): HandbackResult => ({ ok: false, failure: { code, message } })
const readNumber = async (file: string): Promise<number> => Number((await fs.readFile(file, 'utf8').catch(() => '')).trim())

export async function handBackStandIn(d: HandbackDeps): Promise<HandbackResult> {
  if (d.platform !== 'darwin') return fail('unsupported', 'only a LaunchAgent has a stand-in to hand back')
  if (!(await d.ours())) return fail('notInstalled', 'no LaunchAgent of Walnut is installed')
  const standIn = await readNumber(path.join(d.runtimeDir, STANDIN_PID_NAME))
  const serving = await readNumber(path.join(d.runtimeDir, 'daemon.pid'))
  if (!Number.isSafeInteger(standIn) || standIn <= 1 || standIn !== serving || !d.alive(standIn)) {
    return fail('noStandIn', `no stand-in daemon serves ${d.runtimeDir}`)
  }
  const job = await d.job()
  if (!job) return fail('notLoaded', 'handback deferred: launchd has no job of the service loaded; the stand-in keeps serving until it has one')
  const spawns = await d.spawns()
  if (spawns === 'none' || (spawns === 'unknown' && job.runs < 1)) {
    return fail('launchdNotSpawning', `handback deferred: launchd ${spawns === 'none' ? 'is starting no jobs in this login session now' : 'gave no answer whether it starts jobs now'}; the stand-in keeps serving`)
  }
  const instance = (await fs.readFile(path.join(d.runtimeDir, 'daemon.instance'), 'utf8').catch(() => '')).trim() || undefined
  try {
    await d.prepareUpdate()
  } catch (error) {
    // Refused before anything changed (open work): the loop asks again later.
    return fail('updateRefused', `the stand-in keeps serving: ${error instanceof Error ? error.message : String(error)}`)
  }
  await d.kickstart()
  if (!(await d.ready(instance))) return fail('notReady', 'the stand-in handed over, and no daemon of the job answered in time')
  await fs.rm(path.join(d.runtimeDir, STANDIN_PID_NAME), { force: true }).catch(() => {})
  return { ok: true, message: "the stand-in handed over, and launchd's job serves" }
}
