/**
 * A Walnut's data dir moved: the server says so, a host never guesses (walnut-scope-core.ts).
 *
 * The data dir keeps `local/home.json` { machineId, home, movedFrom?, formerHomes?, switchId? }
 * (machine-local, never synced or backed up). Read once per process, the first time a host link asks:
 *
 *   - no record, or one another machine wrote: this is where the Walnut is; nothing moved.
 *     (A copy on another machine or a restore declares nothing: it is a Walnut of its own by path.)
 *   - same machine, same path: whatever it declared before still holds (the former homes are sent
 *     at every connect, all of them, so a host that was away for one move or several hears them).
 *   - same machine, another path that is the same folder (a symlink, HOME spelled two ways): a
 *     move from the other spelling, so a host that knows that one follows. Never a copy.
 *   - same machine, another path, and the old path no longer holds a data dir with this
 *     Walnut's id: a move. `movedFrom` is the old path, `formerHomes` it and the ones before it.
 *   - same machine, another path, and the old path still holds this id: a copy (a test run, a
 *     second checkout). It never declares a move, so it can never take the real one's place.
 *
 * One more, above them all: a leader switch to this data dir that committed (the write permission's
 * record of this machine stands on a witness majority on top of the switch's handover, read by
 * src/core/leader/switch/moved-home.ts). The previous holder's data dir, as its server spelled it
 * to its hosts, is `movedFrom`, its former homes after it, whatever machine it was on, and the
 * record keeps the switch's id so later starts go on by the rules above. A copy, a restore or a
 * test copy on another machine has no such switch and declares nothing, as before.
 *
 * The record is kept whatever the one-service experiment (in_process_daemon) says, off the connect
 * path, so a move made while it was off is declared once it is on; only the declaration
 * (leader.configure's movedFrom and formerHomes) waits for the experiment. A committed switch
 * declares with the experiment off too: without it the old holder's triggers, plugin jobs and
 * detached records would stay on each host under the old path, a second set nobody owns.
 */

import { existsSync } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import { IS_EPHEMERAL, WALNUT_HOME } from '../constants.js'
import { log } from '../logging/index.js'
import { inProcessDaemonWantedNow } from '../providers/in-process-daemon.js'
import { leaderPermitActive } from './leader/switch/doors.js'
import { isFollower } from './server-role.js'

export interface HomeRecord {
  machineId: string
  home: string
  /** The newest former home (what older readers of this record read). */
  movedFrom?: string
  /** Every former home on this machine, newest first (movedFrom first), at most FORMER_HOMES_MAX. */
  formerHomes?: string[]
  /** The leader switch to this data dir this record took in (its previous holder's home is a former home). */
  switchId?: string
}

/** A leader switch to this data dir that committed: what its hosts must hear (src/core/leader/switch/moved-home.ts). */
export interface SwitchedFrom {
  switchId: string
  /** The data dir the previous holder spoke from on its hosts, as its server spelled it (never normalised). */
  home: string
  /** The former homes the previous holder's record kept, newest first. */
  formerHomes?: string[]
}

/** The most former homes a record keeps and a declaration names. */
export const FORMER_HOMES_MAX = 8

export function homeRecordFile(home: string): string {
  return path.join(home, 'local', 'home.json')
}

function formerHomesOf(r: HomeRecord): string[] {
  return r.formerHomes && r.formerHomes.length > 0 ? r.formerHomes : r.movedFrom ? [r.movedFrom] : []
}

/**
 * What this start says, as a pure rule: the record to keep and the former homes to declare,
 * newest first (empty: none). `heldBy(home)` is the Walnut id a data dir at `home` holds now
 * (null: none there); `sameFolder(home)` is whether `home` names the folder this start runs in.
 * `switched`: a leader switch to this data dir that committed (null: none, and the rules are
 * exactly those of a Walnut that never switched).
 */
export function judgeHome(
  prev: HomeRecord | null,
  now: { machineId: string; home: string; walnutId: string | null },
  heldBy: (home: string) => string | null,
  sameFolder: (home: string) => boolean = () => false,
  switched: SwitchedFrom | null = null,
): { record: HomeRecord; formerHomes: string[] } {
  const own = judgeOwnMove(prev, now, heldBy, sameFolder)
  // Without an id no host lets this Walnut continue anyway (walnut-scope-core.ts declareMove).
  if (!switched || !now.walnutId) return own
  // Taken in already (a restart, a move on this machine since): the rules above go on, the switch's id with them.
  if (prev && prev.machineId === now.machineId && prev.switchId === switched.switchId) {
    return own.record.switchId === switched.switchId ? own : { ...own, record: { ...own.record, switchId: switched.switchId } }
  }
  // What this machine kept at this very path before the switch was taken in (a start that wrote a record first) comes after.
  const here = !!prev && prev.machineId === now.machineId && prev.home === now.home ? formerHomesOf(prev) : []
  const formers = [switched.home, ...(switched.formerHomes ?? []), ...here]
    .filter((h, i, all) => typeof h === 'string' && !!h && h !== now.home && all.indexOf(h) === i)
    .slice(0, FORMER_HOMES_MAX)
  // The same path on both machines: the hosts know the Walnut by it already, nothing to declare.
  const moved = formers.length > 0 ? { movedFrom: formers[0], formerHomes: formers } : {}
  return { record: { machineId: now.machineId, home: now.home, ...moved, switchId: switched.switchId }, formerHomes: formers }
}

/** The rules of a start on this machine with no leader switch to take in (the file's header, bar the last). */
function judgeOwnMove(
  prev: HomeRecord | null,
  now: { machineId: string; home: string; walnutId: string | null },
  heldBy: (home: string) => string | null,
  sameFolder: (home: string) => boolean = () => false,
): { record: HomeRecord; formerHomes: string[] } {
  const fresh: HomeRecord = { machineId: now.machineId, home: now.home }
  if (!prev || prev.machineId !== now.machineId) return { record: fresh, formerHomes: [] }
  if (prev.home === now.home) return { record: prev, formerHomes: formerHomesOf(prev) }
  const same = sameFolder(prev.home)
  // Without an id of its own this Walnut cannot be the one that lived there (its own folder keeps its record).
  if (!now.walnutId) return { record: same ? prev : fresh, formerHomes: [] }
  if (!same && heldBy(prev.home) === now.walnutId) return { record: fresh, formerHomes: [] }
  const formers = [prev.home, ...formerHomesOf(prev)]
    .filter((h, i, all) => h !== now.home && all.indexOf(h) === i)
    .slice(0, FORMER_HOMES_MAX)
  return { record: { ...fresh, movedFrom: formers[0], formerHomes: formers }, formerHomes: formers }
}

function asRecord(raw: unknown): HomeRecord | null {
  const r = raw as Partial<HomeRecord> | null
  if (!r || typeof r.machineId !== 'string' || !r.machineId || typeof r.home !== 'string' || !r.home) return null
  const formers = Array.isArray(r.formerHomes) ? r.formerHomes.filter((h): h is string => typeof h === 'string' && !!h).slice(0, FORMER_HOMES_MAX) : []
  return {
    machineId: r.machineId, home: r.home,
    ...(typeof r.movedFrom === 'string' && r.movedFrom ? { movedFrom: r.movedFrom } : {}),
    ...(formers.length > 0 ? { formerHomes: formers } : {}),
    ...(typeof r.switchId === 'string' && r.switchId ? { switchId: r.switchId } : {}),
  }
}

async function readJson(file: string): Promise<unknown> {
  try { return JSON.parse(await fs.readFile(file, 'utf8')) } catch { return null }
}

async function realpathOrNull(p: string): Promise<string | null> {
  try { return await fs.realpath(p) } catch { return null }
}

/**
 * Read the record, judge this start, keep the result; answers the former homes to declare
 * (empty: none). Never throws: a doubt declares nothing.
 */
export async function noteHome(home: string, machineId: string, walnutId: string | null, opts: { declares?: boolean; switched?: SwitchedFrom | null } = {}): Promise<string[]> {
  try {
    const file = homeRecordFile(home)
    const prev = asRecord(await readJson(file))
    const moved = !!prev && prev.home !== home
    const [here, there] = moved ? await Promise.all([realpathOrNull(home), realpathOrNull(prev.home)]) : [null, null]
    const same = !!here && here === there
    const { instanceIdAt } = await import('./device-store.js')
    const oldHolds = moved && !same ? await instanceIdAt(prev.home) : null
    const { record, formerHomes } = judgeHome(prev, { machineId, home, walnutId }, () => oldHolds, () => same, opts.switched ?? null)
    if (JSON.stringify(record) !== JSON.stringify(prev)) {
      await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
      // One temp file per write: two judgements in one process (a test's reset while the last one still writes) never rename each other's.
      const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2, 10)}.tmp`
      await fs.writeFile(tmp, `${JSON.stringify(record)}\n`, { mode: 0o600 })
      await fs.rename(tmp, file)
    }
    if (opts.switched && record.switchId === opts.switched.switchId && prev?.switchId !== opts.switched.switchId) {
      log.leader.info('home move: a leader switch made this data dir the Walnut\'s; hosts are told it moved from the previous holder\'s', { switchId: opts.switched.switchId, movedFrom: formerHomes[0] ?? null, formerHomes: formerHomes.length, home })
    } else if (formerHomes.length > 0 && formerHomes[0] !== prev?.movedFrom) {
      log.leader.info(opts.declares === false ? 'home move: this Walnut\'s data dir moved; hosts hear it once the one-service experiment is on' : 'home move: this Walnut\'s data dir moved; hosts are told', { movedFrom: formerHomes[0], formerHomes: formerHomes.length, home })
    }
    return formerHomes
  } catch (err) {
    log.leader.warn('home move: the home record could not be read or kept; no move is declared', { error: err instanceof Error ? err.message : String(err) })
    return []
  }
}

let declared: Promise<string[] | null> | null = null
/** What `homeMoveToDeclare` answered, once it has (undefined until then). */
let settled: string[] | null | undefined

/**
 * A leader switch may have made this data dir the Walnut's (the permit guards this process and
 * the switch's promotion record is here): known without waiting, so a connect holds its commands
 * for the declaration (settledHomeMove). The path is spelled out (records.ts promotedFile):
 * importing the switch here would load it on every start.
 */
function switchMayBeDue(): boolean {
  return leaderPermitActive() && existsSync(path.join(WALNUT_HOME, 'local', 'leader-switch', 'promoted.json'))
}

/**
 * A leader switch to this data dir has not been confirmed committed within its deadline
 * (moved-home.ts): the host connection that asked fails, sends nothing and retries on its backoff.
 * Never answered as "nothing to declare": a host that heard this Walnut from here first would keep
 * the new path as a Walnut of its own, and the move could never be taken there.
 */
export class HomeMoveHeld extends Error {
  constructor(readonly switchId: string, readonly waitedMs: number) {
    super(`leader switch ${switchId}: its commit is not confirmed after ${Math.round(waitedMs / 1000)} s (no witness majority answers?); this host is held until it is`)
    this.name = 'HomeMoveHeld'
  }
}

export function isHomeMoveHeld(err: unknown): err is HomeMoveHeld {
  return !!err && typeof err === 'object' && (err as { name?: unknown }).name === 'HomeMoveHeld'
}

/**
 * The data dirs this Walnut declares it moved from, newest first, or null. Once per process; null
 * with the experiment off (the record is still kept, in the background), on a follower and on a
 * test server (its data is a copy, and it may reach its own local daemon: never a declaration,
 * switch or not). A leader switch to this data dir declares once its commit stood, with the
 * experiment off too; until then this waits (moved-home.ts), so no host hears this Walnut from here
 * before it knows where it was. A wait past its deadline rejects with HomeMoveHeld and is
 * forgotten, so the next connection attempt waits afresh.
 */
export function homeMoveToDeclare(): Promise<string[] | null> {
  if (declared) return declared
  const asked: Promise<string[] | null> = (async () => {
    if (IS_EPHEMERAL || isFollower()) return null
    const switched = switchMayBeDue() ? await (await import('./leader/switch/moved-home.js')).switchedHereAfterCommit(WALNUT_HOME) : null
    if (switched) void import('./leader/home-busy-health.js').then((m) => m.noteSwitchConfirmed()).catch(() => {})
    const { inProcessDaemonWanted } = await import('../providers/in-process-daemon.js')
    const on = !!switched || await inProcessDaemonWanted()
    const note = (async () => {
      const [{ readMachineId }, { getInstanceId, isVolatileInstanceId }] = await Promise.all([import('./machine-id.js'), import('./device-auth.js')])
      const id = await getInstanceId().catch(() => null)
      return noteHome(WALNUT_HOME, await readMachineId(), id && !isVolatileInstanceId(id) ? id : null, { declares: on, switched })
    })()
    // Off: the record is kept so a later switch-on declares the move; nothing waits for it.
    if (!on) { void note.catch(() => {}); return null }
    const formers = await note
    return formers.length > 0 ? formers : null
  })().then((moved) => { settled = moved; return moved }, (err: unknown) => {
    if (!isHomeMoveHeld(err)) { settled = null; return null }
    if (declared === asked) declared = null
    void import('./leader/home-busy-health.js').then((m) => m.noteSwitchHeld(err.switchId)).catch(() => {})
    throw err
  })
  declared = asked
  return asked
}

/**
 * The answer without waiting: null once it is known that nothing is declared (the experiment is
 * known off, a follower, a test server), undefined while not known yet. A connect gates its
 * commands only while it is not null (daemon-connection.ts): with the experiment off nothing waits,
 * unless a leader switch may have made this data dir the Walnut's.
 */
export function settledHomeMove(): string[] | null | undefined {
  if (settled !== undefined) return settled
  if (IS_EPHEMERAL || isFollower()) return null
  if (switchMayBeDue()) return undefined
  if (inProcessDaemonWantedNow() === false) return null
  return undefined
}

/**
 * Where this Walnut speaks from on its hosts and the former homes its record keeps on this
 * machine: what a leader switch carries to the next holder (GET /api/leader/status), which
 * declares them as where it moved from. The path as this server spells it, never normalised:
 * a host keys a Walnut by that string.
 */
export async function homeOnHosts(): Promise<{ home: string; formerHomes: string[] }> {
  const prev = asRecord(await readJson(homeRecordFile(WALNUT_HOME)))
  if (!prev || prev.home !== WALNUT_HOME) return { home: WALNUT_HOME, formerHomes: [] }
  const { readMachineId } = await import('./machine-id.js')
  const machineId = await readMachineId().catch(() => null)
  return { home: WALNUT_HOME, formerHomes: prev.machineId === machineId ? formerHomesOf(prev) : [] }
}

/** Tests only: judge again. */
export function resetHomeMoveForTests(): void { declared = null; settled = undefined }
