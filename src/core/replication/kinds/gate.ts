/**
 * Who keeps the WP4 copies, and what a kind turned off by the host's choice
 * leaves behind (docs/plan/walnut-replica-servers-impl.md, section 4 and WP4).
 *
 *   keepsCopies(kind)  the full replica program on a host (D13's per-host
 *                      opt-in, server-role.ts isHostReplicaProgram) keeps every
 *                      kind; the companion keeps COMPANION_COPY_KINDS
 *                      (docs/plan/walnut-companion-unified-replica.md, stage 2).
 *                      The plain host server (the default program and the
 *                      daemon's crash-loop fallback) and the leader answer every
 *                      step of these kinds `404 unknown_kind`, as before WP4.
 *   copyPath(live)     where a follower writes the file it keeps: the live path
 *                      on a host replica (a data dir that holds nothing else);
 *                      on the companion the same relative path under
 *                      `cache/replica/home/`, because the box's live files are its
 *                      own (its sessions, config, cron engine, git sync).
 *   off markers        the leader's `purge` step (a kind the host's Settings row
 *                      turned off) removes that kind's store and leaves
 *                      `cache/replica/<kind>.json` as `{v:1, off:true}`: no copy
 *                      state, and the kind answers `needs_leader {why:'kind_not_copied'}`
 *                      while the Mac is away (copyKindOff). The next manifest round
 *                      (the kind turned on again) overwrites the marker.
 */

import fsp from 'node:fs/promises'
import path from 'node:path'
import { WALNUT_HOME } from '../../../constants.js'
import { followerKind, isHostReplicaProgram } from '../../server-role.js'
import { writeCopyFile, type Refusal } from '../kind-follower.js'

/**
 * The kinds the companion keeps (stage 2a, 2b, 2c, 3c, 3e). Each has a box read that answers
 * from the copy while the Mac is away; a kind joins when its reader does.
 */
export const COMPANION_COPY_KINDS: ReadonlySet<string> = new Set([
  'requests', 'routines', 'prefs', 'personas', 'boards', 'config', 'inbox', 'inbox-bodies', 'sessions',
  'conversations', 'conversation-bodies',
])

/** This server keeps copies (no kind), or the copy of `kind`. */
export function keepsCopies(kind?: string): boolean {
  if (isHostReplicaProgram()) return true
  if (followerKind() !== 'companion') return false
  return kind === undefined || COMPANION_COPY_KINDS.has(kind)
}

/** The file a follower keeps for `live` (a path under WALNUT_HOME): see the header. */
export function copyPath(live: string): string {
  if (followerKind() !== 'companion') return live
  const rel = path.relative(WALNUT_HOME, live)
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) throw new Error(`copyPath: ${live} is not under the data dir`)
  return path.join(WALNUT_HOME, 'cache', 'replica', 'home', rel)
}

/**
 * Where a read of `live` looks on this server: on the companion, its copy of
 * `kind` once it holds one; anywhere else, and before the first round, `live`
 * (on a host replica the copy IS the live file).
 */
export async function copyReadPath(kind: string, live: string): Promise<string> {
  if (followerKind() !== 'companion' || !COMPANION_COPY_KINDS.has(kind)) return live
  return (await copyKindHeld(kind)) ? copyPath(live) : live
}

/** Every copy kind's refusal: where no copy is kept `404 unknown_kind`, else the leader's own refusal. */
export async function copyRefusal(): Promise<Refusal> {
  if (!keepsCopies()) return { status: 404, error: 'unknown_kind' }
  return (await import('../task-replica-store.js')).leaderRefusal()
}

/** A copy kind's state file (cache/replica/<kind>.json). */
export function copyStateFile(kind: string): string {
  return path.join(WALNUT_HOME, 'cache', 'replica', `${kind}.json`)
}

/** The kind's store is gone by the host's choice: no copy state, an off marker. */
export async function markCopyOff(kind: string, now = Date.now()): Promise<void> {
  await writeCopyFile(copyStateFile(kind), { v: 1, off: true, at: now })
}

/** True when the host's choice turned `kind` off here (its last purge, no round since). */
export async function copyKindOff(kind: string): Promise<boolean> {
  try {
    const raw = JSON.parse(await fsp.readFile(copyStateFile(kind), 'utf8')) as { off?: unknown } | null
    return raw?.off === true
  } catch { return false }
}

/**
 * True when this host holds a copy of `kind`: a round wrote its state (an empty
 * copy of an empty store counts), and the host's choice did not turn it off.
 * A read of a kind with no copy answers needs_leader {why:'kind_not_copied'},
 * never an empty list or the defaults as if they were the user's.
 */
export async function copyKindHeld(kind: string): Promise<boolean> {
  return (await copyKindAsOf(kind)) !== null
}

/** When the leader's rows of a held copy were read (ms; 0 when not recorded), or null when none is held. */
export async function copyKindAsOf(kind: string): Promise<number | null> {
  try {
    const raw = JSON.parse(await fsp.readFile(copyStateFile(kind), 'utf8')) as { v?: unknown; off?: unknown; hashes?: unknown; asOf?: unknown } | null
    if (!(raw?.v === 1 && raw.off !== true && !!raw.hashes && typeof raw.hashes === 'object')) return null
    return Number(raw.asOf) || 0
  } catch { return null }
}

/** The header a box read answered from a copy carries: when the copy's rows were the leader's. */
export const COPY_AS_OF_HEADER = 'x-walnut-copy-as-of'


/** The why of a read that finds no copy of its kind here. */
export const KIND_NOT_COPIED = 'kind_not_copied'
