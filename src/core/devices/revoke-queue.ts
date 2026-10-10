/**
 * The parts of a revoke, written before the pairing goes and kept until they
 * finish, where the revoke ran or later in the running server.
 *
 * A revoke (device-auth.ts `revokePairing`) has two parts that live on the
 * OTHER box: the device's push rows, which live on the primary, and the other
 * box's copy of the pairing (device-twins.ts), which keeps the revoked token
 * working there, so the phone could register for pushes again through it.
 * Either can fail: the bridge is down, the companion is unreachable, or the
 * revoke ran in `walnut device revoke`, a process with no bridge at all (typed
 * on the companion, it can never reach the primary from there). Until both
 * land, a lost phone can keep getting letter subjects on its lock screen.
 *
 * So every part is written here BEFORE the pairing leaves auth.json (write
 * ahead, device-auth.ts), cleared when it finishes, and the server finishes
 * what is left: at start, every 60 s, and when the primary bridge (re)connects
 * (replica). A process killed between the two writes leaves an entry for a
 * pairing that is still here; the drain drops such an entry without running it.
 * It judges that under the auth lock (device-auth.ts `revokesLanded`), which a
 * revoke holds from its write-ahead to its auth.json write: judged without it, a
 * drain in that window took a revoke about to land for one that never would,
 * and dropped its parts. A busy lock leaves the entry for the next drain.
 * Files: cache/revoke-queue/<opId>.json (NON-git: each box finishes its own).
 *
 * Steps:
 *  - push { name, revokedAt, pairingHash? }: core/push/device-revoke.ts, which
 *    relays on a replica. Only rows registered before `revokedAt` go: the name
 *    may have been paired again by the time the step runs, and the rows the
 *    new pairing registered since are its own. (Dropping the step on a re-pair
 *    instead left the old phone's rows on the primary, still pushing.)
 *    `revokedAt` is stamped right after the auth.json write (`stampRevokedAt`),
 *    so a registration the old token authenticated just before it is older.
 *  - twin { tokenHash }: device-twins.ts `removeTwinOnce`. Keyed by the old
 *    token's hash, so a new pairing of the name is never touched. A running
 *    server leaves the entry for its drain even when its first try works: its
 *    own retries are in memory and a restart ends them. While the step is here the
 *    box refuses to adopt that hash back (`twinRemovalPending`,
 *    device-adoption.ts): the other box still takes the revoked token, and the
 *    phone's routes call there would copy the pairing straight back. After it,
 *    auth.json's `revokedHashes` keeps refusing it, for good.
 *  - takeback { name, tokenSha }: core/push/device-revoke.ts
 *    `takeBackPushRegistration`, a registration the companion relayed for a
 *    pairing that went while it was on its way (web/routes/push.ts). The row
 *    stays only for a pairing of the name that still holds when the step runs
 *    (core/push/claims.ts); the token itself is not stored here.
 * A step still unfinished after 7 days is dropped, loudly.
 */

import crypto from 'node:crypto'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { CLOUD_MODE, WALNUT_HOME } from '../../constants.js'
import { log } from '../../logging/index.js'
import { writeJsonFile } from '../../utils/fs.js'

/** `pairingHash`: the revoked pairing's token hash, so a drain can tell whether the revoke landed. */
export type RevokeStep =
  | { step: 'push'; name: string; revokedAt: string; pairingHash?: string }
  | { step: 'twin'; tokenHash: string }
  | { step: 'takeback'; name: string; tokenSha: string }
type QueuedStep = RevokeStep & { opId: string; at: string }

const DRAIN_INTERVAL_MS = 60_000
const DRAIN_BATCH_MAX = 100
const MAX_AGE_MS = 7 * 24 * 60 * 60_000

/** Read at call time, so a test that mocks WALNUT_HOME gets its own queue. */
function queueDir(): string {
  return path.join(WALNUT_HOME, 'cache', 'revoke-queue')
}

function sameStep(a: RevokeStep, b: RevokeStep): boolean {
  if (a.step === 'push' && b.step === 'push') return a.name === b.name && a.revokedAt === b.revokedAt
  if (a.step === 'twin' && b.step === 'twin') return a.tokenHash === b.tokenHash
  if (a.step === 'takeback' && b.step === 'takeback') return a.name === b.name && a.tokenSha === b.tokenSha
  return false
}

function wellFormed(raw: unknown): raw is QueuedStep {
  if (!raw || typeof raw !== 'object') return false
  const s = raw as Record<string, unknown>
  if (typeof s.opId !== 'string' || typeof s.at !== 'string') return false
  return (s.step === 'push' && typeof s.name === 'string' && s.name.length > 0
      && (s.revokedAt === undefined || typeof s.revokedAt === 'string')
      && (s.pairingHash === undefined || (typeof s.pairingHash === 'string' && /^[0-9a-f]{64}$/.test(s.pairingHash))))
    || (s.step === 'twin' && typeof s.tokenHash === 'string' && /^[0-9a-f]{64}$/.test(s.tokenHash))
    || (s.step === 'takeback' && typeof s.name === 'string' && s.name.length > 0
      && typeof s.tokenSha === 'string' && /^[0-9a-f]{64}$/.test(s.tokenSha))
}

async function readQueue(): Promise<Array<{ file: string; entry: QueuedStep | null }>> {
  let names: string[]
  try {
    names = (await fsp.readdir(queueDir())).filter((n) => n.endsWith('.json')).sort()
  } catch {
    return []
  }
  return Promise.all(names.map(async (n) => {
    const file = path.join(queueDir(), n)
    try {
      const parsed = JSON.parse(await fsp.readFile(file, 'utf-8')) as unknown
      return { file, entry: wellFormed(parsed) ? parsed : null }
    } catch {
      return { file, entry: null }
    }
  }))
}

let opSeq = 0

/** Sorts in queue order: time, then this process's sequence, then a random tail (two processes). */
function mintOpId(): string {
  return `${Date.now().toString().padStart(15, '0')}-${(opSeq++).toString().padStart(6, '0')}-${crypto.randomBytes(4).toString('hex')}`
}

/**
 * Queue one step. Returns its opId (the existing entry's, when the same step is
 * already queued), or null when it could not be stored. Never throws.
 */
export async function enqueueRevokeStep(step: RevokeStep): Promise<string | null> {
  try {
    const existing = (await readQueue()).find((q) => q.entry && sameStep(q.entry, step))
    if (existing?.entry) return existing.entry.opId
    const entry: QueuedStep = { ...step, opId: mintOpId(), at: new Date().toISOString() }
    await writeJsonFile(path.join(queueDir(), `${entry.opId}.json`), entry, { mode: 0o600 })
    log.web.info('revoke-queue: revoke step queued', { step: step.step, ...describe(step) })
    return entry.opId
  } catch (err) {
    log.web.error('revoke-queue: could not queue a revoke step', {
      step: step.step, ...describe(step), error: err instanceof Error ? err.message : String(err),
    })
    return null
  }
}

/** Remove a step that finished where it ran. Never throws. */
export async function clearRevokeStep(opId: string): Promise<void> {
  if (!/^[0-9a-f-]+$/.test(opId)) return
  await fsp.rm(path.join(queueDir(), `${opId}.json`), { force: true }).catch(() => {})
}

/**
 * Set a queued push step's revoke time (device-auth.ts stamps it right after
 * its auth.json write). An entry already gone is left gone. Never throws;
 * false = not stamped.
 */
export async function stampRevokedAt(opId: string, revokedAt: string): Promise<boolean> {
  if (!/^[0-9a-f-]+$/.test(opId)) return false
  const file = path.join(queueDir(), `${opId}.json`)
  try {
    const parsed = JSON.parse(await fsp.readFile(file, 'utf-8')) as unknown
    if (!wellFormed(parsed) || parsed.step !== 'push') return false
    await writeJsonFile(file, { ...parsed, revokedAt }, { mode: 0o600 })
    return true
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      log.web.warn('revoke-queue: could not stamp a queued push step\'s revoke time', { error: err instanceof Error ? err.message : String(err) })
    }
    return false
  }
}

/** True while the removal of the other box's copy of `tokenHash` is still queued here. Never throws. */
export async function twinRemovalPending(tokenHash: string): Promise<boolean> {
  return (await readQueue()).some((q) => q.entry?.step === 'twin' && q.entry.tokenHash === tokenHash)
}

/** Pending steps (diagnostics and tests). */
export async function queuedRevokeSteps(): Promise<RevokeStep[]> {
  return (await readQueue()).flatMap((q) => q.entry ? [stripMeta(q.entry)] : [])
}

/** A push entry written without `revokedAt` takes its queue time, which is just after the revoke. */
function stripMeta(entry: QueuedStep): RevokeStep {
  if (entry.step === 'push') {
    return { step: 'push', name: entry.name, revokedAt: entry.revokedAt ?? entry.at, ...(entry.pairingHash ? { pairingHash: entry.pairingHash } : {}) }
  }
  return entry.step === 'twin'
    ? { step: 'twin', tokenHash: entry.tokenHash }
    : { step: 'takeback', name: entry.name, tokenSha: entry.tokenSha }
}

/** Log fields: the name, or a short hash prefix (never the whole pairing hash). */
function describe(step: RevokeStep): Record<string, string> {
  return step.step === 'twin' ? { tokenHash: `${step.tokenHash.slice(0, 8)}...` } : { name: step.name }
}

/**
 * The pairing whose revoke a step belongs to, when the step names it. A
 * take-back is queued only after its pairing was found gone, so it is never judged.
 */
function pairingOf(step: RevokeStep): string | undefined {
  if (step.step === 'takeback') return undefined
  return step.step === 'twin' ? step.tokenHash : step.pairingHash
}

/** True = done, false = keep for the next drain. */
async function runStep(step: RevokeStep): Promise<boolean> {
  if (step.step === 'twin') {
    const { removeTwinOnce } = await import('../../web/routes/device-twins.js')
    return removeTwinOnce(step.tokenHash)
  }
  if (step.step === 'takeback') {
    const { takeBackPushRegistration } = await import('../push/device-revoke.js')
    const outcome = await takeBackPushRegistration(step, { queue: false })
    return !outcome.pending || !outcome.retry
  }
  const { revokePushTokensForDevice } = await import('../push/device-revoke.js')
  const outcome = await revokePushTokensForDevice(step.name, { queue: false, revokedAt: step.revokedAt })
  return !outcome.pending || !outcome.retry
}

/** How long a drain waits for the auth lock before leaving the judgment to the next drain. */
const JUDGE_LOCK_WAIT_MS = 250

/**
 * Under the auth lock: which of `entries` belong to a revoke that landed (the
 * hash is revoked here, or no pairing holds it), and which to one that never
 * will (the pairing is still here: its process died before its auth.json
 * write). Those are removed here, still under the lock, so a new revoke of the
 * same pairing cannot slip in between the judgment and the removal. Entries
 * read before the lock was taken were written by a revoke that has left it
 * since, so none of them is judged mid-revoke. When auth.json cannot be read,
 * every revoke counts as landed: the parts err towards stopping the pushes.
 * Returns the landed entries' files (empty when the lock is busy).
 */
async function judgeLanded(entries: Array<{ file: string; entry: QueuedStep | null }>): Promise<{ files: Set<string>; dropped: number }> {
  const files = new Set<string>()
  const judged = entries.flatMap((q) => {
    const hash = q.entry ? pairingOf(stripMeta(q.entry)) : undefined
    return q.entry && hash ? [{ file: q.file, step: stripMeta(q.entry), hash }] : []
  })
  if (judged.length === 0) return { files, dropped: 0 }
  let dropped = 0
  try {
    const { withPairingsLocked } = await import('../device-auth.js')
    await withPairingsLocked(async (paired) => {
      for (const { file, step, hash } of judged) {
        if (!paired || paired.from !== 'auth' || paired.revoked.has(hash) || !paired.hashes.has(hash)) {
          files.add(file)
          continue
        }
        log.web.warn('revoke-queue: the revoke behind this step never landed (its pairing is still here), dropped', { step: step.step, ...describe(step) })
        await fsp.rm(file, { force: true }).catch(() => {})
        dropped++
      }
    }, JUDGE_LOCK_WAIT_MS)
  } catch (err) {
    log.web.warn('revoke-queue: could not judge which revokes landed, kept for the next try', { error: err instanceof Error ? err.message : String(err) })
  }
  return { files, dropped }
}

let draining: Promise<{ done: number; left: number }> | null = null

/** Run every queued step once, oldest first. Single flight; never throws. */
export function drainRevokeQueue(): Promise<{ done: number; left: number }> {
  if (!draining) {
    draining = drainOnce().finally(() => { draining = null })
  }
  return draining
}

async function drainOnce(): Promise<{ done: number; left: number }> {
  let done = 0
  let left = 0
  const landed = await judgeLanded((await readQueue()).slice(0, DRAIN_BATCH_MAX))
  done += landed.dropped
  // Read again: a revoke stamps its push parts' time just before it leaves the lock.
  const queue = await readQueue()
  for (const { file, entry } of queue.slice(0, DRAIN_BATCH_MAX)) {
    if (!entry) {
      log.web.warn('revoke-queue: unreadable queued step removed', { file })
      await fsp.rm(file, { force: true }).catch(() => {})
      continue
    }
    const step = stripMeta(entry)
    if (pairingOf(step) !== undefined && !landed.files.has(file)) {
      // Not judged: the auth lock was busy (a revoke may be between its two
      // writes), or the entry is newer than the judgment. Next time.
      left++
      continue
    }
    let finished = false
    try {
      finished = await runStep(step)
    } catch (err) {
      log.web.warn('revoke-queue: queued revoke step failed, kept for the next try', {
        step: entry.step, ...describe(entry), error: err instanceof Error ? err.message : String(err),
      })
    }
    if (finished) {
      log.web.info('revoke-queue: queued revoke step finished', { step: entry.step, ...describe(entry), queuedAt: entry.at })
      await fsp.rm(file, { force: true }).catch(() => {})
      done++
      continue
    }
    const age = Date.now() - Date.parse(entry.at)
    if (Number.isFinite(age) && age > MAX_AGE_MS) {
      log.web.error('revoke-queue: revoke step still unfinished after 7 days, dropped: the device may still get pushes', {
        step: entry.step, ...describe(entry), queuedAt: entry.at,
      })
      await fsp.rm(file, { force: true }).catch(() => {})
      continue
    }
    left++
  }
  return { done, left: left + Math.max(0, queue.length - DRAIN_BATCH_MAX) }
}

/**
 * Server only (both boxes): drain at start, every 60 s, and on the primary
 * bridge (re)connecting on a replica.
 */
export function startRevokeQueue(): { stop: () => void } {
  void drainRevokeQueue()
  const timer = setInterval(() => { void drainRevokeQueue() }, DRAIN_INTERVAL_MS)
  timer.unref?.()
  let unhook: (() => void) | null = null
  let stopped = false
  if (CLOUD_MODE) {
    void (async () => {
      try {
        const { addPrimaryBridgeConnectedHandler } = await import('../../web/ws/bridge-registry.js')
        if (stopped) return
        unhook = addPrimaryBridgeConnectedHandler(() => { void drainRevokeQueue() })
      } catch (err) {
        log.web.warn('revoke-queue: could not hook the bridge-connected trigger', { error: String(err) })
      }
    })()
  }
  return {
    stop: () => {
      stopped = true
      clearInterval(timer)
      unhook?.()
    },
  }
}
