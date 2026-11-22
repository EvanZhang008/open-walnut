/**
 * A Walnut's data dir moved: the server says so, a host never guesses (walnut-scope-core.ts).
 *
 * The data dir keeps `local/home.json` { machineId, home, movedFrom?, formerHomes? } (machine-local,
 * never synced or backed up). Read once per process, the first time a host link asks:
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
 * The record is kept whatever the one-service experiment (in_process_daemon) says, off the connect
 * path, so a move made while it was off is declared once it is on; only the declaration
 * (leader.configure's movedFrom and formerHomes) waits for the experiment.
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import { IS_EPHEMERAL, WALNUT_HOME } from '../constants.js'
import { log } from '../logging/index.js'
import { inProcessDaemonWantedNow } from '../providers/in-process-daemon.js'
import { isFollower } from './server-role.js'

export interface HomeRecord {
  machineId: string
  home: string
  /** The newest former home (what older readers of this record read). */
  movedFrom?: string
  /** Every former home on this machine, newest first (movedFrom first), at most FORMER_HOMES_MAX. */
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
 */
export function judgeHome(
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
export async function noteHome(home: string, machineId: string, walnutId: string | null, opts: { declares?: boolean } = {}): Promise<string[]> {
  try {
    const file = homeRecordFile(home)
    const prev = asRecord(await readJson(file))
    const moved = !!prev && prev.home !== home
    const [here, there] = moved ? await Promise.all([realpathOrNull(home), realpathOrNull(prev.home)]) : [null, null]
    const same = !!here && here === there
    const { instanceIdAt } = await import('./device-store.js')
    const oldHolds = moved && !same ? await instanceIdAt(prev.home) : null
    const { record, formerHomes } = judgeHome(prev, { machineId, home, walnutId }, () => oldHolds, () => same)
    if (JSON.stringify(record) !== JSON.stringify(prev)) {
      await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
      const tmp = `${file}.${process.pid}.tmp`
      await fs.writeFile(tmp, `${JSON.stringify(record)}\n`, { mode: 0o600 })
      await fs.rename(tmp, file)
    }
    if (formerHomes.length > 0 && formerHomes[0] !== prev?.movedFrom) {
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
 * The data dirs this Walnut declares it moved from, newest first, or null. Once per process; null
 * with the experiment off (the record is still kept, in the background), on a follower and on a
 * test server (its data is a copy).
 */
export function homeMoveToDeclare(): Promise<string[] | null> {
  declared ??= (async () => {
    if (IS_EPHEMERAL || isFollower()) return null
    const { inProcessDaemonWanted } = await import('../providers/in-process-daemon.js')
    const on = await inProcessDaemonWanted()
    const note = (async () => {
      const [{ readMachineId }, { getInstanceId, isVolatileInstanceId }] = await Promise.all([import('./machine-id.js'), import('./device-auth.js')])
      const id = await getInstanceId().catch(() => null)
      return noteHome(WALNUT_HOME, await readMachineId(), id && !isVolatileInstanceId(id) ? id : null, { declares: on })
    })()
    // Off: the record is kept so a later switch-on declares the move; nothing waits for it.
    if (!on) { void note.catch(() => {}); return null }
    const formers = await note
    return formers.length > 0 ? formers : null
  })().catch(() => null).then((moved) => { settled = moved; return moved })
  return declared
}

/**
 * The answer without waiting: null once it is known that nothing is declared (the experiment is
 * known off, a follower, a test server), undefined while not known yet. A connect gates its
 * commands only while it is not null (daemon-connection.ts): with the experiment off nothing waits.
 */
export function settledHomeMove(): string[] | null | undefined {
  if (settled !== undefined) return settled
  if (IS_EPHEMERAL || isFollower() || inProcessDaemonWantedNow() === false) return null
  return undefined
}

/** Tests only: judge again. */
export function resetHomeMoveForTests(): void { declared = null; settled = undefined }
