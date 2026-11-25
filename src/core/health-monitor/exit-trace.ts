/**
 * Cut-off shutdowns from the server's exit trace, and whether a boot was a restart. The file names each with its
 * pid; only pids this monitor saw boot are this server's (the file also holds
 * test servers'), and a line already recorded is not counted twice.
 */

import fsp from 'node:fs/promises'
import { sameBuildRestartReasons } from '../planned-restart.js'
import type { ServerEvent } from './store.js'

const TAIL_BYTES = 256 * 1024

export async function shutdownBailsSince(file: string, events: readonly ServerEvent[]): Promise<ServerEvent[]> {
  let text: string
  try {
    const h = await fsp.open(file, 'r')
    try {
      const { size } = await h.stat()
      const len = Math.min(size, TAIL_BYTES)
      const buf = Buffer.alloc(len)
      await h.read(buf, 0, len, size - len)
      text = buf.toString('utf-8')
    } finally { await h.close() }
  } catch { return [] }
  const pids = new Set(events.filter((e) => e.kind === 'boot').map((e) => e.pid))
  const seen = new Set(events.filter((e) => e.kind === 'shutdown-bail').map((e) => `${e.pid}:${e.at}`))
  const out: ServerEvent[] = []
  for (const m of text.matchAll(/^\[([^\]]+)\] SERVER EXIT: shutdown bail after \d+ms pid=(\d+)/gm)) {
    const at = Date.parse(m[1])
    const pid = Number(m[2])
    if (!Number.isFinite(at) || !pids.has(pid) || seen.has(`${pid}:${at}`)) continue
    out.push({ kind: 'shutdown-bail', at, pid })
  }
  return out
}

/**
 * A boot on the same build as the boot before it is a start nobody deployed: a
 * crash and its respawn, a launchd relaunch, a reboot. A deploy, an update and a
 * rollback all start a different build. (2026-11-10: every one of 16 boots in a
 * day was a queued deploy, and the alarm counting all boots asked for a fix.)
 * A boot an older Walnut recorded has no build, so it never matches.
 */
export function bootOnSameBuild(events: readonly ServerEvent[], build: string | null): boolean {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]
    if (e.kind !== 'boot') continue
    return 'build' in e && e.build === build
  }
  return false
}

/**
 * Why the server before this boot stopped, when its planned restart said so: the last planned
 * stop counts only when the server that recorded it is the one the last boot started (or no
 * server took it: pid 0, a marker left after that server stopped), and it is from after that
 * boot. A record from an older server (a crash since then) says nothing.
 */
export function plannedStopBefore(
  events: readonly ServerEvent[], stop: { reason: string; pid: number; takenAt: number } | null | undefined, now: number,
): string | undefined {
  if (!stop) return undefined
  let last: ServerEvent | undefined
  for (let i = events.length - 1; i >= 0 && !last; i--) if (events[i].kind === 'boot') last = events[i]
  if (!last || (stop.pid !== 0 && last.pid !== stop.pid) || stop.takenAt < last.at || stop.takenAt > now) return undefined
  return stop.reason
}

/** How long after a deploy's stop its own build may boot for that deploy to have taken. */
export const DEPLOY_TAKES_MS = 15 * 60_000

/** One commit, however short each side spells it (a boot's build is `<commit>@<built at>`). */
function sameCommit(build: string | null | undefined, commit: string): boolean {
  const a = (build ?? '').split('@')[0] ?? ''
  const n = Math.min(a.length, commit.length)
  return n >= 7 && a.slice(0, n) === commit.slice(0, n)
}

/**
 * A boot on the build that already ran that nothing planned to come back on it: a crash and
 * its respawn, a relaunch, a reboot. A Mac app update ends the server so it starts again under
 * the new app, on the same build (2026-11-20: two app installs counted as restarts on their own).
 *
 * A deploy's stop that came back on the old build is a deploy that did not take, and counts,
 * unless that deploy's own build booted within DEPLOY_TAKES_MS after it: then another stop (a Mac
 * app restart) ended the server inside the deploy's window and took its marker, and the deploy
 * went on (2026-11-24: the app restarted 13 s before the deploy's switch, and the boot between
 * read as a restart on its own). Until that window is over the boot is not judged yet.
 * `events` and `now`: the monitor's boots and clock (without them, the boot is judged alone).
 */
export function unplannedRestart(e: ServerEvent, events: readonly ServerEvent[] = [], now = Number.POSITIVE_INFINITY): boolean {
  if (e.kind !== 'boot' || e.sameBuild !== true) return false
  if ((sameBuildRestartReasons as readonly string[]).includes(e.after ?? '')) return false
  if (e.after === 'deploy' && e.afterBuild) {
    const until = e.at + DEPLOY_TAKES_MS
    const afterBuild = e.afterBuild
    if (events.some((b) => b.kind === 'boot' && b.at > e.at && b.at <= until && sameCommit(b.build, afterBuild))) return false
    if (now < until) return false
  }
  return true
}
