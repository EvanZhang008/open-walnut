/**
 * Whether a host Walnut turned a follower on for by default (follower-default.ts) can run one
 * well now: a build of the walnut file that runs there, enough memory, room on its disk. A host
 * the person turned on runs as before: these gates are for the default only.
 *
 * One probe over the host's link, read here (pure): the platform probe of host-target.ts, then
 * the memory and the disk free where the follower would live. A value the host does not give
 * (an unusual system) refuses nothing.
 *
 * The floors (measured 2026-11-18 on a 48 core dev host with 19 agents): the follower used about
 * 311 MB of resident memory right after a start and 194 MB after 16 minutes; the daemon beside it
 * about 246 MB. One version of the program takes about 160 MB unpacked (a 122 MB file plus its
 * runtime tree), and that follower's data copy was 1.9 GB, most of it its search copy. So:
 *
 *   memory in all   2 GiB    follower and daemon together stay under a third of it
 *   memory free     1 GiB    three times the follower's peak at start
 *   disk free       2.5 GiB  two versions and the upload (about 0.4 GB) and the data copy (2 GB)
 */

import { parseHostTarget, targetProbeScript, type HostTarget } from './host-target.js'
import { checkHostRoot } from './install.js'

export interface HostRoom {
  memTotalMb: number | null
  memAvailableMb: number | null
  /** Free on the disk that holds the host root (or its nearest parent that exists). */
  diskFreeMb: number | null
}

export interface FollowerFloors { memTotalMb: number; memAvailableMb: number; diskFreeMb: number }

export const FOLLOWER_FLOORS: Readonly<FollowerFloors> = Object.freeze({ memTotalMb: 2048, memAvailableMb: 1024, diskFreeMb: 2560 })

/** Why a host has no follower by default now (`this-computer`: the host row is the leader's own machine). */
export type FollowerGateReason = 'no-build' | 'memory' | 'disk' | 'this-computer'

export interface FollowerGate {
  reason: FollowerGateReason
  /** One sentence for the person (the view's message). */
  message: string
  /** What the host said, for the view and the log. */
  room?: HostRoom
}

/**
 * Prints the platform lines of targetProbeScript, then `mem_total_kb=`, `mem_avail_kb=` and
 * `disk_free_kb=` (empty when the host does not say). Linux reads /proc/meminfo (MemAvailable);
 * macOS reads hw.memsize and the free, inactive and speculative pages of vm_stat. Changes nothing.
 */
export function roomProbeScript(rootSpec: string): string {
  const root = checkHostRoot(rootSpec)
  return [
    targetProbeScript(),
    'mt=; ma=; df_kb=',
    'if [ -r /proc/meminfo ]; then',
    '  mt=$(awk \'/^MemTotal:/{print $2}\' /proc/meminfo); ma=$(awk \'/^MemAvailable:/{print $2}\' /proc/meminfo)',
    'elif command -v sysctl >/dev/null 2>&1; then',
    '  b=$(sysctl -n hw.memsize 2>/dev/null); if [ -n "$b" ]; then mt=$((b / 1024)); fi',
    '  ma=$(vm_stat 2>/dev/null | awk \'/page size of/{ps=$8} /^Pages (free|inactive|speculative):/{v=$NF; gsub(/\\./, "", v); n+=v} END{if (ps && n) print int(n * ps / 1024)}\')',
    'fi',
    `d="${root}"`,
    'while [ ! -d "$d" ]; do d=$(dirname "$d"); done',
    'df_kb=$(df -Pk "$d" 2>/dev/null | awk \'NR==2{print $4}\')',
    'printf "mem_total_kb=%s\\nmem_avail_kb=%s\\ndisk_free_kb=%s\\n" "$mt" "$ma" "$df_kb"',
  ].join('\n')
}

function mb(kb: string | undefined): number | null {
  if (!kb || !/^\d+$/.test(kb.trim())) return null
  return Math.floor(Number(kb.trim()) / 1024)
}

/** The memory and disk lines of the probe's answer. */
export function parseHostRoom(out: string): HostRoom {
  const kv: Record<string, string> = {}
  for (const line of out.split('\n')) {
    const m = /^(mem_total_kb|mem_avail_kb|disk_free_kb)=(.*)$/.exec(line.trim())
    if (m) kv[m[1]!] = m[2]!
  }
  return { memTotalMb: mb(kv.mem_total_kb), memAvailableMb: mb(kv.mem_avail_kb), diskFreeMb: mb(kv.disk_free_kb) }
}

const size = (n: number): string => (n >= 1024 ? `${(n / 1024).toFixed(1).replace(/\.0$/, '')} GB` : `${n} MB`)

/**
 * The probe's answer judged: the host's target and room when a follower can run there, else the
 * gate that keeps it off and why.
 */
export function judgeFollowerRoom(out: string, floors: FollowerFloors = FOLLOWER_FLOORS): { target: HostTarget; room: HostRoom } | { gate: FollowerGate } {
  let target: HostTarget
  try {
    target = parseHostTarget(out)
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err)
    return { gate: { reason: 'no-build', message: `No Walnut server runs on this host: ${why}. Its sessions run as before.` } }
  }
  const room = parseHostRoom(out)
  if (room.memTotalMb !== null && room.memTotalMb < floors.memTotalMb) {
    return { gate: { reason: 'memory', room, message: `No Walnut server runs on this host by default: it has ${size(room.memTotalMb)} of memory, and one needs a host with at least ${size(floors.memTotalMb)}.` } }
  }
  if (room.memAvailableMb !== null && room.memAvailableMb < floors.memAvailableMb) {
    return { gate: { reason: 'memory', room, message: `No Walnut server runs on this host yet: it has ${size(room.memAvailableMb)} of memory free, and one needs ${size(floors.memAvailableMb)} free.` } }
  }
  if (room.diskFreeMb !== null && room.diskFreeMb < floors.diskFreeMb) {
    return { gate: { reason: 'disk', room, message: `No Walnut server runs on this host yet: its disk has ${size(room.diskFreeMb)} free, and one needs ${size(floors.diskFreeMb)} (two versions of the program and its copy of your data).` } }
  }
  return { target, room }
}
