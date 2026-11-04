/**
 * Small keyed JSON files in WALNUT_HOME for daemon update facts that must outlive the
 * server process (a deploy restarts it, a crash too): which build did not stay serving
 * where (daemon-build-backoff.ts), and which host's old daemon was just stopped for an
 * update with a copy kept to go back to (below).
 *
 * Wall clock (Date.now), never a monotonic one: every entry here must run out in real
 * time, across a Mac's sleep and across restarts, and a monotonic clock stops in sleep
 * and starts again at every process start.
 *
 * Machine-local: in WALNUT_HOME/local/, which git-sync never syncs (`/local/`, a critical
 * ignore), and keyed by this machine's id too. 2026-11-04 review: at the data home's root
 * they went to the cloud companion with every sync, where the same key (both daemon dirs are
 * /tmp/open-walnut) made one machine's day off hold a good build on the other, and two
 * writers made conflicts that lost holds.
 *
 * The id is random, made once and kept in WALNUT_HOME/local/machine-id (also when a test names a
 * store file elsewhere), never the host name: a Mac with no HostName set takes its name from the
 * network (DHCP, a VPN), so a laptop that moved lost every hold and every stop record (2026-11-04
 * review 4). An entry an older build kept under the host name is still read, once, and moved
 * under the id; of the two, the newer one counts (a build that ran in between, a downgrade).
 *
 * Read and written async, writes in order, each through a temp file and a rename. A test
 * run keeps none unless it names the file (its env name): tests share one data home, and
 * one test's entry would steer the next test's update.
 */
import { randomBytes } from 'node:crypto'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { WALNUT_HOME } from '../constants.js'

/** Where a store file lives when no test names one: the machine-local part of the data home. */
export function updateStoreFile(fileName: string): string {
  return path.join(WALNUT_HOME, 'local', fileName)
}

export const MACHINE_ID_FILE = 'machine-id'
const MACHINE_ID = /^[0-9a-f]{32}$/
const machineIds = new Map<string, Promise<string | null>>()

/** Where this machine's id is kept: the machine-local part of the data home, which git-sync never syncs. */
function machineIdDir(): string {
  return path.join(WALNUT_HOME, 'local')
}

/**
 * This machine's id (`machine-id` in `dir`, WALNUT_HOME/local): read, or made once, whole or not at
 * all (a written file linked into place, so two processes that start together agree and neither
 * reads a half-made one). null when none can be read or made (the entries are then keyed by the
 * host name, as an older build did).
 */
export function updateStoreMachineId(dir: string = machineIdDir()): Promise<string | null> {
  let id = machineIds.get(dir)
  if (!id) {
    id = readOrMakeMachineId(dir)
    machineIds.set(dir, id)
    // One that could not be made is asked again later (a data home made meanwhile).
    void id.then((made) => { if (!made && machineIds.get(dir) === id) machineIds.delete(dir) })
  }
  return id
}

/** Tests: the ids read so far are forgotten, as in a process that just started. */
export function resetUpdateStoreMachineIdsForTest(): void {
  machineIds.clear()
}

async function readOrMakeMachineId(dir: string): Promise<string | null> {
  const file = path.join(dir, MACHINE_ID_FILE)
  const read = async () => {
    const text = (await fsp.readFile(file, 'utf8').catch(() => '')).trim()
    return MACHINE_ID.test(text) ? text : null
  }
  const kept = await read()
  if (kept) return kept
  try {
    await fsp.mkdir(dir, { recursive: true, mode: 0o700 })
    const fresh = randomBytes(16).toString('hex')
    const tmp = `${file}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`
    await fsp.writeFile(tmp, `${fresh}\n`, { mode: 0o600 })
    try {
      // 2026-11-04 review 5: an O_EXCL create is written in a second step, and a process that met
      // the file in between took it for a broken one and put its own id over it.
      await fsp.link(tmp, file)
      return fresh
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        // No hard links there: an O_EXCL create.
        return await fsp.writeFile(file, `${fresh}\n`, { flag: 'wx', mode: 0o600 }).then(() => fresh, () => read())
      }
      // Made by another process meanwhile (its id), or a file that holds no id: replaced whole.
      const other = await read()
      if (other) return other
      await fsp.rename(tmp, file)
      return (await read()) ?? fresh
    } finally {
      await fsp.rm(tmp, { force: true }).catch(() => {})
    }
  } catch { return null }
}

/** The key an older build kept an entry under: this machine's host name. */
function hostKey(key: string): string {
  return `${os.hostname() || 'unknown'}|${key}`
}

/** This machine's part of every key: a data home copied to another machine holds nothing for it there. */
async function machineKey(key: string): Promise<string> {
  const id = await updateStoreMachineId()
  return id ? `${id}|${key}` : hostKey(key)
}

let writes: Promise<void> = Promise.resolve()

/** The writes asked for so far, in every store, are on disk (tests, and a caller that must read its own write). */
export function updateStoresSettled(): Promise<void> {
  return writes
}

/** Entries keyed by where the daemon runs (`local:<dir>`, `ssh:<host>`, `net:<host>`), each gone after maxAgeMs (Infinity: only when settled). */
export class KeyedUpdateStore<T extends { at: number }> {
  constructor(
    private readonly fileName: string,
    private readonly envName: string,
    private readonly maxAgeMs: number,
    private readonly valid: (e: unknown) => e is T,
  ) {}

  private file(): string | null {
    const named = process.env[this.envName]
    if (named) return named
    if (process.env.VITEST) return null
    return updateStoreFile(this.fileName)
  }

  private async readAll(file: string): Promise<Record<string, unknown>> {
    try {
      const parsed = JSON.parse(await fsp.readFile(file, 'utf8')) as unknown
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}
    } catch { return {} }
  }

  /** Still within its time: a clock set back counts the same distance, so an entry never lasts much longer. */
  fresh(entry: { at: number } | null | undefined, now = Date.now()): boolean {
    return !!entry && Math.abs(now - entry.at) < this.maxAgeMs
  }

  /**
   * The entry kept for `key` (past its time or not), or null: none, unreadable, or no file in a
   * test run. One an older build kept under this machine's host name is read too, and moved.
   */
  async read(key: string): Promise<T | null> {
    const file = this.file()
    if (!file) return null
    const all = await this.readAll(file)
    const mine = await machineKey(key)
    const entry = this.valid(all[mine]) ? all[mine] as T : null
    const legacy = mine !== hostKey(key) && this.valid(all[hostKey(key)]) ? all[hostKey(key)] as T : null
    // The host-name key's entry moves under the id; of the two, the newer counts (an older build
    // that ran in between wrote the host-name one).
    if (!legacy || (entry && entry.at >= legacy.at)) return entry
    void this.write(key, this.fresh(legacy) ? legacy : null)
    return legacy
  }

  /** Keep (or with null, forget) the entry for `key`. Best effort: one that cannot be kept is in memory only. */
  write(key: string, entry: T | null): Promise<void> {
    const file = this.file()
    if (!file) return Promise.resolve()
    writes = writes.then(async () => {
      const all = await this.readAll(file)
      const now = Date.now()
      const mine = await machineKey(key)
      // Entries past their time are dropped on the way.
      for (const [k, e] of Object.entries(all)) if (!this.valid(e) || !this.fresh(e, now)) delete all[k]
      // The host-name key an older build used for this place goes: the entry lives under the id now.
      delete all[hostKey(key)]
      if (entry) all[mine] = entry
      else delete all[mine]
      const tmp = `${file}.tmp-${process.pid}`
      await fsp.mkdir(path.dirname(file), { recursive: true })
      await fsp.writeFile(tmp, `${JSON.stringify(all, null, 2)}\n`, { mode: 0o600 })
      await fsp.rename(tmp, file)
    }).catch(() => {})
    return writes
  }
}

/**
 * The old daemon in `dir` was stopped for `expected` at `at`, and (previous) how it ran,
 * when a copy of it was kept to start again. 2026-11-04 review: this lived in memory, so
 * a server restarted between the stop and the new daemon's start (a deploy, a crash) knew
 * neither the copy nor the build, and a new build that then failed left the host with none.
 *
 * Settled by what runs: the new daemon stayed serving past its window (`started`, then proven),
 * or the old one was started again. No short clock ends it (the next review: it ran out 10 min
 * after the stop, while a host that came back later still needed the way back), only
 * PENDING_REPLACE_MAX_MS, so one left by a host that never came back goes in the end (review 4:
 * none ever went, and ones under an old host name stayed for good).
 */
export interface PendingReplace {
  at: number
  dir: string
  expected: string
  previous: { runtime: string; bunPath: string | null } | null
  /**
   * The new daemon answered on the real dir (its pid when read, wall clock), not yet proven to
   * stay; `boot`: the host's boot time then (epoch s), so a reboot inside the window is told apart.
   */
  started?: { pid: number | null; at: number; boot?: number }
  /**
   * The new build failed after the stop and the old one is to start again: what is left to do is
   * that, never the new build again (a restore or a start that failed is tried on the next connect).
   */
  back?: boolean
  /**
   * How many connects tried that way back and failed (its restore or its start). At
   * BACK_TRIES_MAX the mark goes and the build on disk is started, watched: 2026-11-04 review 5,
   * a way back that kept failing left the host with no daemon for the build's whole day off.
   */
  backTries?: number
}

const validPending = (e: unknown): e is PendingReplace => {
  const p = e as PendingReplace
  return !!p && typeof p === 'object' && Number.isFinite(p.at) && typeof p.dir === 'string' && typeof p.expected === 'string'
    && (p.previous === null || (!!p.previous && typeof p.previous.runtime === 'string'
      && (p.previous.bunPath === null || typeof p.previous.bunPath === 'string')))
    && (p.started === undefined || (!!p.started && Number.isFinite(p.started.at) && (p.started.pid === null || Number.isInteger(p.started.pid))
      && (p.started.boot === undefined || Number.isFinite(p.started.boot))))
    && (p.back === undefined || typeof p.back === 'boolean')
    && (p.backTries === undefined || Number.isInteger(p.backTries))
}

/** Failed tries of the way back after which the build on disk is started instead (PendingReplace.backTries). */
export const BACK_TRIES_MAX = 2

/** How long a stop's record is kept at most: a host away longer than this is started as a new one. */
export const PENDING_REPLACE_MAX_MS = 7 * 24 * 3600_000

export const pendingReplaces = new KeyedUpdateStore<PendingReplace>(
  'daemon-update-pending.json', 'WALNUT_UPDATE_PENDING_FILE', PENDING_REPLACE_MAX_MS, validPending)

/**
 * A new daemon of this machine on its probation (local-daemon-replace.ts StayWatch): the build,
 * its pid (null: not known yet), when it started and in which boot (both wall clock). Kept on
 * disk, so a server restarted inside the window (a deploy) still watches it, and still keeps the
 * file of the build before it as the one to go back to (2026-11-04 review 5: the watch lived in
 * memory, and a restart ended it unjudged).
 */
export interface StayRecord {
  at: number
  expected: string
  pid: number | null
  bootAt: number
}

const validStay = (e: unknown): e is StayRecord => {
  const s = e as StayRecord
  return !!s && typeof s === 'object' && Number.isFinite(s.at) && typeof s.expected === 'string' && Number.isFinite(s.bootAt)
    && (s.pid === null || Number.isInteger(s.pid))
}

/** A probation is a quarter of an hour; one kept past a day is no watch any more. */
export const stayWatches = new KeyedUpdateStore<StayRecord>('daemon-update-stay.json', 'WALNUT_UPDATE_STAY_FILE', 24 * 3600_000, validStay)

/**
 * The build that last stayed through its probation on this machine's daemon dir, or that a server
 * found serving there with no probation running. A start with no daemon running of any other build
 * is a replacement: watched, with the kept build before it as the way back (local-daemon.ts). Kept
 * across reboots, so a build that served for days is not put on probation again at every boot.
 * 2026-11-05 review 6: a build that never ran here was started as if it had, unwatched, and on a
 * Mac kept over the way back.
 */
export interface ProvenRecord {
  at: number
  expected: string
}

const validProven = (e: unknown): e is ProvenRecord => {
  const p = e as ProvenRecord
  return !!p && typeof p === 'object' && Number.isFinite(p.at) && typeof p.expected === 'string' && p.expected.length > 0
}

/** One entry per daemon dir; a year without a pass or an adopt is a build nobody runs any more. */
export const provenBuilds = new KeyedUpdateStore<ProvenRecord>('daemon-update-proven.json', 'WALNUT_UPDATE_PROVEN_FILE', 365 * 24 * 3600_000, validProven)
