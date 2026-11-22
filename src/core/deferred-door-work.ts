/**
 * Outward work a closed door held back, kept on disk until the doors open (docs/reference/
 * leader-switch.md, "Outward doors"): a list rename, the old copy of a cross-source move marked
 * moved, a remote delete, and an answered unsubscribe letter. Before, each waited in memory
 * (onceOutwardDoorsOpened) and a restart while the doors were closed lost it.
 *
 *   cache/leader-deferred-work.json   { version: 1, entries: [{ kind, key, payload, at, claim?, notBefore? }] }
 *
 * Leader data (home-manifest `cache.leader-deferred-work`): it moves with the home, so work the
 * old leader held during a switch's handover is done by the new leader once its doors open.
 *
 * At least once. One entry per key (a second hold of the same key replaces the first, and an
 * entry replaced while it runs stays for the next replay). At each opening of the doors every
 * entry whose kind has a replayer is claimed: stamped, under the file's lock, with this process
 * (host, pid and a token of this incarnation), run, and only then removed. A stamp of a process
 * that is gone (another host's, a dead pid's, an older incarnation of this one) is taken back by
 * the next replay, so a stop or a crash between the claim and the end of the run loses nothing;
 * it may run that entry a second time (the replays are close to idempotent: a rename or a moved
 * mark set twice, a delete answered 404, an unsubscribe the ledger's claim refuses). A replay
 * refused again holds it again. A replayer that answers 'keep' (its plugin is not loaded) gives
 * its claim back; kept entries, and entries with a `notBefore` (a failed delete's retry), are
 * tried again every KEEP_RETRY_MS and at each opening.
 *
 * The file is read under its lock with every read error but a missing file thrown, so an I/O
 * error never writes the held work away; a file that does not parse is moved aside to
 * `.corrupt-<time>` (logged) and the work goes on from empty.
 *
 * Only a refusal at a door holds anything, and a door refuses only while a permit guards this
 * process (leaderPermitActive()): with the experiment off, or on with no witnesses, nothing here
 * reads or writes a file. Nothing holds or replays outside a normal boot (bootMode(): a
 * trial start does no outward work). The permit runtime arms it at boot when the file is there
 * (armDeferredDoorWork), so what the process before held is replayed at the first opening; a hold
 * made later subscribes itself.
 */
import { randomBytes } from 'node:crypto'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { WALNUT_HOME } from '../constants.js'
import { log } from '../logging/index.js'
import { withFileLock } from '../utils/file-lock.js'
import { writeJsonFile } from '../utils/fs.js'
import { bootMode } from './boot-policy.js'
import { DEFERRED_DOOR_WORK_FILE, isPermitRefusal, leaderPermitActive, onceOutwardDoorsOpened, outwardDoorsOpen } from './leader/switch/doors.js'

export type DeferredDoorWorkKind = 'task-sync:rename' | 'task-sync:mark-moved' | 'task-sync:delete' | 'mail-unsubscribe'

/** 'keep': it cannot run yet (its plugin is not loaded); its claim is given back for later. */
export type DeferredReplayResult = 'done' | 'keep'

export type DeferredReplayer = (payload: unknown) => Promise<DeferredReplayResult | void>

/** Which process claimed an entry and runs it. */
export interface DeferredClaim {
  host: string
  pid: number
  /** This incarnation's token: a later process with the same pid is another one. */
  token: string
  at: string
}

export interface DeferredEntry {
  kind: DeferredDoorWorkKind
  key: string
  payload: unknown
  at: string
  claim?: DeferredClaim
  /** Not run before this time (ms): a failed delete's next try. */
  notBefore?: number
}

interface DeferredFile {
  version: 1
  entries: DeferredEntry[]
}

const REPLAY_KEY = 'deferred-door-work'
/** How often kept and later entries are tried again while the doors stay open. */
export const KEEP_RETRY_MS = 5 * 60_000

const replayers = new Map<string, DeferredReplayer>()
/** Keys this process claimed and runs now. */
const running = new Set<string>()
/** Keys held in memory only (the file could not be written), with their time: the file's older entry of one is not run. */
const memoryHeld = new Map<string, string>()
let armedHome: string | null = null
let retryTimer: ReturnType<typeof setTimeout> | null = null
let me: DeferredClaim = newIncarnation()

function newIncarnation(): DeferredClaim {
  return { host: os.hostname(), pid: process.pid, token: randomBytes(8).toString('hex'), at: '' }
}

export function deferredDoorWorkFile(home: string = armedHome ?? WALNUT_HOME): string {
  return path.join(home, ...DEFERRED_DOOR_WORK_FILE.split('/'))
}

/** Holds and replays run only while a permit guards this process, and only on a normal boot. */
function active(): boolean {
  return leaderPermitActive() && bootMode() === 'normal'
}

function entriesOf(d: unknown): DeferredEntry[] {
  const list = (d as DeferredFile | null)?.entries
  return Array.isArray(list) ? list.filter((e) => e && typeof e.kind === 'string' && typeof e.key === 'string') : []
}

class CorruptFile extends Error {}

/** The entries on disk: [] when there is no file; every other read error throws; CorruptFile when it does not parse. */
async function readEntries(file: string): Promise<DeferredEntry[]> {
  let text: string
  try {
    text = await fsp.readFile(file, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw err
  }
  if (!text.trim()) return []
  try {
    return entriesOf(JSON.parse(text))
  } catch (err) {
    throw new CorruptFile((err as Error).message)
  }
}

/** What is held now (tests, a status read). */
export async function readDeferredDoorWork(home?: string): Promise<DeferredEntry[]> {
  return readEntries(deferredDoorWorkFile(home))
}

/**
 * One read-modify-write of the file under its lock; `fn` answers the entries to write. A file that
 * does not parse is moved aside first and `fn` starts from empty; any other read error throws and
 * nothing is written.
 */
async function change(fn: (entries: DeferredEntry[]) => DeferredEntry[]): Promise<void> {
  const file = deferredDoorWorkFile()
  await withFileLock(file, async () => {
    let entries: DeferredEntry[]
    try {
      entries = await readEntries(file)
    } catch (err) {
      if (!(err instanceof CorruptFile)) throw err
      const aside = `${file}.corrupt-${Date.now()}`
      await fsp.rename(file, aside)
      log.task.warn('deferred door work: the file did not parse, moved aside; held work goes on from empty', { file: aside, error: err.message })
      entries = []
    }
    const next: DeferredFile = { version: 1, entries: fn(entries) }
    await writeJsonFile(file, next, { durable: true, mode: 0o600 })
  })
}

function subscribe(): void {
  onceOutwardDoorsOpened(REPLAY_KEY, () => { void replayDeferredDoorWork() })
}

/** The doors opened before this subscribed (a hold or a keep racing an opening): replay now. */
function replayIfOpen(): void {
  if (active() && outwardDoorsOpen()) void replayDeferredDoorWork()
}

function scheduleRetry(): void {
  if (retryTimer) return
  retryTimer = setTimeout(() => { retryTimer = null; void replayDeferredDoorWork() }, KEEP_RETRY_MS)
  retryTimer.unref?.()
}

/**
 * Hold `payload` until the doors open, on disk: the replayer of `kind` runs it then. `key` names
 * one logical piece of work (a second hold of it replaces the first). `retryAfterMs`: not before
 * then (a failed delete's next try). A no-op while no permit guards this process, or on a boot
 * that is not normal.
 */
export async function holdDurablyUntilDoorsOpen(kind: DeferredDoorWorkKind, key: string, payload: unknown, opts: { retryAfterMs?: number } = {}): Promise<void> {
  if (!active()) return
  const entry: DeferredEntry = { kind, key, payload, at: new Date().toISOString(), ...(opts.retryAfterMs ? { notBefore: Date.now() + opts.retryAfterMs } : {}) }
  subscribe()
  try {
    await change((all) => [...all.filter((e) => e.key !== key), entry])
  } catch (err) {
    // The file cannot be read or written: still done once the doors open in this process.
    log.task.warn('deferred door work: could not be saved, held in memory only', { kind, key, error: err instanceof Error ? err.message : String(err) })
    holdInMemory(entry)
    return
  }
  if (entry.notBefore) scheduleRetry()
  else replayIfOpen()
}

/**
 * The fallback when the file cannot be written: once the doors open the newer of this entry and
 * the file's one of its key runs (the file's is claimed for it, or dropped when older), unless
 * its key runs already, which tries again at the next opening.
 */
function holdInMemory(entry: DeferredEntry): void {
  if (!((memoryHeld.get(entry.key) ?? '') > entry.at)) memoryHeld.set(entry.key, entry.at)
  onceOutwardDoorsOpened(`${REPLAY_KEY}:${entry.key}`, () => {
    void (async () => {
      if (running.has(entry.key)) { holdInMemory(entry); return }
      running.add(entry.key)
      if (memoryHeld.get(entry.key) === entry.at) memoryHeld.delete(entry.key)
      let todo = entry
      let claimed = false
      await change((all) => {
        const there = all.find((e) => e.key === entry.key)
        if (there && there.at > entry.at) {
          todo = { ...there, claim: claimNow() }
          claimed = true
          return all.map((e) => (e === there ? todo : e))
        }
        return all.filter((e) => e !== there)
      }).catch(() => undefined)
      await runClaimed([todo], claimed)
    })()
  })
}

function claimNow(): DeferredClaim {
  return { ...me, at: new Date().toISOString() }
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch (err) { return (err as NodeJS.ErrnoException).code === 'EPERM' }
}

/** A claim older than this is taken back whoever made it (a pid reused by another program reads alive). */
const CLAIM_STALE_MS = 60 * 60_000

/**
 * A claim of a process that does not run it any more: this one's when the key is not running
 * here (a removal that failed after the run), an older incarnation's (same pid, other token),
 * another host's (the old leader of a switch), a dead pid's, or one older than CLAIM_STALE_MS.
 * Callers have checked `running` first.
 */
function staleClaim(c: DeferredClaim): boolean {
  if (c.token === me.token) return true
  if (c.host !== me.host || c.pid === me.pid) return true
  if (!(Date.now() - Date.parse(c.at) < CLAIM_STALE_MS)) return true
  return !(c.pid > 1 && alive(c.pid))
}

/**
 * The replayer of one kind (module load of its owner; a plugin's activation). When the doors are
 * open already (a plugin that loads after the first opening), what is held for it runs now.
 * Returns an unregister.
 */
export function registerDeferredReplay(kind: DeferredDoorWorkKind, run: DeferredReplayer): () => void {
  replayers.set(kind, run)
  replayIfOpen()
  return () => { if (replayers.get(kind) === run) replayers.delete(kind) }
}

/** The permit runtime, once its checker is registered: replay at the first opening what an earlier process held. */
export function armDeferredDoorWork(home: string): void {
  armedHome = path.resolve(home)
  subscribe()
  // Armed after the doors opened already: nothing rises again, so replay now (claimed under the
  // file's lock, so a replay the opening started too runs nothing twice).
  replayIfOpen()
}

async function runHeld(entry: DeferredEntry): Promise<'done' | 'keep' | 'failed'> {
  const run = replayers.get(entry.kind)
  if (!run) return 'keep'
  try {
    return (await run(entry.payload)) === 'keep' ? 'keep' : 'done'
  } catch (err) {
    if (isPermitRefusal(err)) return 'keep'
    log.task.warn('deferred door work failed', { kind: entry.kind, key: entry.key, error: err instanceof Error ? err.message : String(err) })
    return 'failed'
  }
}

/**
 * Run entries this process claimed (keys in `running`). After each run its entry goes, unless a
 * newer hold replaced it meanwhile; a kept one gets its claim back. `onDisk`: the entries carry
 * this process's claim in the file (false: the in-memory fallback). Answers how many ran.
 */
async function runClaimed(taken: DeferredEntry[], onDisk = true): Promise<number> {
  for (const e of taken) running.add(e.key)
  const ours = (e: DeferredEntry, t: DeferredEntry) => e.key === t.key && e.claim?.token === me.token && e.at === t.at
  let ran = 0
  let kept = false
  for (const entry of taken) {
    try {
      const outcome = await runHeld(entry)
      if (outcome === 'keep') {
        kept = true
        subscribe()
        if (onDisk) {
          await change((all) => all.map((e) => (ours(e, entry) ? { ...e, claim: undefined } : e)))
            .catch(() => holdInMemory({ ...entry, claim: undefined }))
        } else {
          holdInMemory({ ...entry, claim: undefined })
        }
        continue
      }
      ran++
      if (onDisk) {
        await change((all) => all.filter((e) => !ours(e, entry)))
          .catch((err) => log.task.warn('deferred door work: ran, but could not be removed (it runs again)', { key: entry.key, error: err instanceof Error ? err.message : String(err) }))
      }
    } finally {
      running.delete(entry.key)
    }
  }
  if (kept) scheduleRetry()
  return ran
}

/**
 * Run every held entry that has a replayer and is due, each by one process: claimed (stamped)
 * before it runs, removed after. Nothing while no permit guards this process, on a boot that is
 * not normal, or while its doors are closed. Resolves with how many ran.
 */
export async function replayDeferredDoorWork(): Promise<number> {
  if (!active()) return 0
  // Asked while the doors are closed (an opening that closed again at once): the next one replays.
  if (!outwardDoorsOpen()) { subscribe(); return 0 }
  const now = Date.now()
  const claimable = (e: DeferredEntry) => replayers.has(e.kind) && !running.has(e.key)
    && (!e.claim || staleClaim(e.claim)) && !(e.notBefore && e.notBefore > now)
    // A newer hold of its key waits in memory (the file could not be written then): that one runs.
    && !((memoryHeld.get(e.key) ?? '') >= e.at)
  let taken: DeferredEntry[] = []
  let later = false
  try {
    // Most openings hold nothing: read first, so they write nothing (no lock, no file).
    let pre: DeferredEntry[] | null = null
    try { pre = await readDeferredDoorWork() } catch (err) { if (!(err instanceof CorruptFile)) throw err }
    if (pre && !pre.some(claimable)) {
      if (pre.some((e) => e.notBefore && e.notBefore > now)) scheduleRetry()
      return 0
    }
    await change((all) => {
      const claim = claimNow()
      taken = []
      const next = all.map((e) => {
        if (!claimable(e)) { if (e.notBefore && e.notBefore > now) later = true; return e }
        const stamped = { ...e, claim }
        taken.push(stamped)
        // Marked running at the claim itself, under the file's lock: nothing else claims them now.
        running.add(e.key)
        return stamped
      })
      return next
    })
  } catch (err) {
    for (const e of taken) running.delete(e.key)
    log.task.warn('deferred door work: could not be read', { error: err instanceof Error ? err.message : String(err) })
    return 0
  }
  if (later) scheduleRetry()
  const ran = await runClaimed(taken)
  if (ran) log.task.info('deferred door work done once the doors opened', { ran, kept: taken.length - ran })
  return ran
}

/**
 * Tests only: the process ended. Forgets the armed home, the retry timer and what runs, and takes
 * a new incarnation (its claims read as an earlier process's). Replayers stay: their modules
 * register them at load.
 */
export function _resetDeferredDoorWorkForTesting(): void {
  armedHome = null
  running.clear()
  memoryHeld.clear()
  if (retryTimer) clearTimeout(retryTimer)
  retryTimer = null
  me = newIncarnation()
}
