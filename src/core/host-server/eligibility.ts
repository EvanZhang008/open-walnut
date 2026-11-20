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
  /** The machine's memory, or the container's limit (its control group) when that is smaller. */
  memTotalMb: number | null
  memAvailableMb: number | null
  /** The memory numbers are the container's (a control group limit below the machine's). */
  container?: true
  /** Free on the disk that holds the host root (or its nearest parent that exists). */
  diskFreeMb: number | null
}

export interface FollowerFloors { memTotalMb: number; memAvailableMb: number; diskFreeMb: number }

export const FOLLOWER_FLOORS: Readonly<FollowerFloors> = Object.freeze({ memTotalMb: 2048, memAvailableMb: 1024, diskFreeMb: 2560 })

/** Why a host has no follower by default now (`this-computer`: the host row is the leader's own machine). */
export type FollowerGateReason = 'no-build' | 'memory' | 'disk' | 'this-computer' | 'another-name'

export interface FollowerGate {
  reason: FollowerGateReason
  /** One sentence for the person (the view's message). */
  message: string
  /** What the host said, for the view and the log. */
  room?: HostRoom
  /** Looked at again later by itself: false for what waiting does not change (no build, too little memory in all). */
  again: boolean
}

/**
 * Prints the platform lines of targetProbeScript, then `mem_total_kb=`, `mem_avail_kb=`,
 * `cg_limit_b=`, `cg_used_b=` and `disk_free_kb=` (empty when the host does not say). Linux reads
 * /proc/meminfo (MemAvailable), which in a container shows the whole machine, so also the control
 * group's limit and use (v2 memory.max and memory.current, v1 memory.limit_in_bytes and
 * memory.usage_in_bytes); macOS reads hw.memsize and the free, inactive and speculative pages of
 * vm_stat. Changes nothing.
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
    'cl=; cu=; G=${WALNUT_PROBE_CGROUP:-/sys/fs/cgroup}',
    'if [ -r "$G/memory.max" ]; then cl=$(cat "$G/memory.max" 2>/dev/null); cu=$(cat "$G/memory.current" 2>/dev/null)',
    'elif [ -r "$G/memory/memory.limit_in_bytes" ]; then cl=$(cat "$G/memory/memory.limit_in_bytes" 2>/dev/null); cu=$(cat "$G/memory/memory.usage_in_bytes" 2>/dev/null); fi',
    'case "$cl" in \'\'|*[!0-9]*) cl= ;; esac',
    'case "$cu" in \'\'|*[!0-9]*) cu= ;; esac',
    `d="${root}"`,
    'while [ ! -d "$d" ]; do d=$(dirname "$d"); done',
    'df_kb=$(df -Pk "$d" 2>/dev/null | awk \'NR==2{print $4}\')',
    'printf "mem_total_kb=%s\\nmem_avail_kb=%s\\ncg_limit_b=%s\\ncg_used_b=%s\\ndisk_free_kb=%s\\n" "$mt" "$ma" "$cl" "$cu" "$df_kb"',
  ].join('\n')
}

function mb(kb: string | undefined): number | null {
  if (!kb || !/^\d+$/.test(kb.trim())) return null
  return Math.floor(Number(kb.trim()) / 1024)
}

/** A control group with no limit reads `max` (v2) or a number near 2^63 (v1): no limit below this counts. */
const NO_LIMIT_BYTES = 2 ** 50

/** The memory and disk lines of the probe's answer; a container's limit counts where it is the smaller. */
export function parseHostRoom(out: string): HostRoom {
  const kv: Record<string, string> = {}
  for (const line of out.split('\n')) {
    const m = /^(mem_total_kb|mem_avail_kb|cg_limit_b|cg_used_b|disk_free_kb)=(.*)$/.exec(line.trim())
    if (m) kv[m[1]!] = m[2]!
  }
  const room: HostRoom = { memTotalMb: mb(kv.mem_total_kb), memAvailableMb: mb(kv.mem_avail_kb), diskFreeMb: mb(kv.disk_free_kb) }
  const limit = /^\d+$/.test(kv.cg_limit_b ?? '') ? Number(kv.cg_limit_b) : null
  if (limit !== null && limit < NO_LIMIT_BYTES) {
    const limitMb = Math.floor(limit / 2 ** 20)
    const used = /^\d+$/.test(kv.cg_used_b ?? '') ? Number(kv.cg_used_b) : null
    const freeMb = used !== null ? Math.max(0, Math.floor((limit - used) / 2 ** 20)) : null
    if (room.memTotalMb === null || limitMb < room.memTotalMb) { room.memTotalMb = limitMb; room.container = true }
    if (freeMb !== null && (room.memAvailableMb === null || freeMb < room.memAvailableMb)) { room.memAvailableMb = freeMb; room.container = true }
  }
  return room
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
    return { gate: { reason: 'no-build', again: false, message: `No Walnut server runs on this host: ${why}. Its sessions run as before.` } }
  }
  const room = parseHostRoom(out)
  const it = room.container ? 'its container allows' : 'it has'
  if (room.memTotalMb !== null && room.memTotalMb < floors.memTotalMb) {
    // Waiting does not add memory: looked at again on a connect or Retry only.
    return { gate: { reason: 'memory', room, again: false, message: `No Walnut server runs on this host by default: ${it} ${size(room.memTotalMb)} of memory, and one needs a host with at least ${size(floors.memTotalMb)}.` } }
  }
  if (room.memAvailableMb !== null && room.memAvailableMb < floors.memAvailableMb) {
    return { gate: { reason: 'memory', room, again: true, message: `No Walnut server runs on this host yet: ${room.container ? 'its container has' : 'it has'} ${size(room.memAvailableMb)} of memory free, and one needs ${size(floors.memAvailableMb)} free.` } }
  }
  if (room.diskFreeMb !== null && room.diskFreeMb < floors.diskFreeMb) {
    return { gate: { reason: 'disk', room, again: true, message: `No Walnut server runs on this host yet: its disk has ${size(room.diskFreeMb)} free, and one needs ${size(floors.diskFreeMb)} (two versions of the program and its copy of your data).` } }
  }
  return { target, room }
}
