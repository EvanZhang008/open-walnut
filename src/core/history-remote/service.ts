/**
 * The remote history tier on the primary (src/providers/transcript-offload.ts holds the file
 * work and its rules). Only this server holds the bucket's credentials, so it runs the tier
 * for its OWN machine's Claude Code history, next to the files: a remote host's history
 * never leaves it (a work machine's transcripts are not the user's to send to his own
 * bucket). It also fetches back: in this process directly (setRemoteFetcher), and for its
 * local daemon through the `history.fetch` capability (capability-router.ts).
 */
import os from 'node:os'
import path from 'node:path'
import { log } from '../../logging/index.js'
import type { Config } from '../types.js'
import { hostKeyPrefix, remoteStore, resolveRemote, type ResolvedRemote } from './store.js'

/** This machine's Claude Code projects dirs: CLAUDE_CONFIG_DIR's and ~/.claude's, as the daemon reads them. */
export function localProjectsDirs(env: NodeJS.ProcessEnv = process.env, home = os.homedir()): string[] {
  const configHome = env.CLAUDE_CONFIG_DIR || path.join(home, '.claude')
  return [...new Set([path.join(configHome, 'projects'), path.join(home, '.claude', 'projects')])]
}

/** A project dir of this machine's history: directly under one of the projects dirs. */
export function isLocalProjectDir(dir: unknown, roots = localProjectsDirs()): dir is string {
  if (typeof dir !== 'string' || !path.isAbsolute(dir)) return false
  const abs = path.resolve(dir)
  return roots.some((r) => path.dirname(abs) === path.resolve(r) && path.basename(abs) !== '..')
}

async function currentRemote(config?: Pick<Config, 'session'> | null): Promise<ResolvedRemote> {
  const cfg = config ?? await (await import('../config-manager.js')).getConfig()
  return resolveRemote(cfg.session?.history_remote)
}

/**
 * Fetch the remote-only archive files of `sid` in project dir `dir` of this machine. The bucket
 * is the one the session's manifest names (read with the credentials set now).
 */
export async function fetchLocalArchive(dir: unknown, sid: unknown, deps?: { config?: Pick<Config, 'session'> | null; roots?: string[] }): Promise<number> {
  const { RemoteHistoryError } = await import('../../providers/transcript-archive.js')
  if (!isLocalProjectDir(dir, deps?.roots) || typeof sid !== 'string') {
    log.session.warn('session history fetch refused: not a project dir of this machine', { dir: typeof dir === 'string' ? dir : undefined })
    throw new RemoteHistoryError('not a session of this machine')
  }
  const r = await currentRemote(deps?.config)
  const { fetchRemoteArchive } = await import('../../providers/transcript-offload.js')
  const started = Date.now()
  try {
    const got = await fetchRemoteArchive(dir, sid, await remoteStore(r))
    if (got) log.session.info('session history fetched from remote storage', { sessionId: sid, files: got, ms: Date.now() - started })
    return got
  } catch (e) {
    log.session.warn('session history could not be fetched from remote storage', { sessionId: sid, error: (e as Error).message, ms: Date.now() - started })
    throw e
  }
}

/** This process restores from remote storage itself (session-file-reader and the other server readers). */
export async function installServerFetcher(): Promise<void> {
  const { setRemoteFetcher } = await import('../../providers/transcript-archive.js')
  setRemoteFetcher(async (dir, sid) => { await fetchLocalArchive(dir, sid) })
}

export interface RemotePassRow {
  host: string
  uploaded: number
  uploadedBytes: number
  offloaded: number
  freedBytes: number
  waiting: number
  failed: number
  partial: boolean
  errors: string[]
}

/** One pass of the tier over this machine's history; null when it is off. */
export async function remotePassOnce(deps?: { config?: Pick<Config, 'session'> | null; roots?: string[]; host?: string; budgetMs?: number }): Promise<RemotePassRow | null> {
  const r = await currentRemote(deps?.config)
  if (!r.enabled) return null
  const { offloadArchived } = await import('../../providers/transcript-offload.js')
  const res = await offloadArchived(deps?.roots ?? localProjectsDirs(), {
    store: await remoteStore(r),
    olderThanMs: r.days * 86_400_000,
    keyPrefix: hostKeyPrefix(r, deps?.host),
    budgetMs: deps?.budgetMs ?? 10 * 60_000,
  })
  const row: RemotePassRow = { host: '__local__', ...res }
  if (res.uploaded || res.offloaded || res.failed) log.session.info('session history sent to remote storage', { ...row, days: r.days, bucket: r.bucket })
  return row
}

type TierCounts = { uploaded: number; remoteOnly: number; remoteBytes: number }

/** How long the status route waits for a count before it answers with the last one. */
export const STATUS_WAIT_MS = 2_500
/** A count this young is answered as it is, with no new scan. */
const STATUS_FRESH_MS = 60_000
const tierCount: { last?: TierCounts & { at: number }; running?: Promise<TierCounts> } = {}

/**
 * The tier's counts read every manifest of this machine's history (tens of thousands), which
 * takes longer than a route may hang. One scan runs at a time; the route waits STATUS_WAIT_MS
 * for it, else answers the last count (or none yet) with `counting`, and the scan goes on.
 */
async function tierCounts(roots: string[], waitMs: number): Promise<{ counts?: TierCounts; countedAt?: number; counting: boolean }> {
  const last = tierCount.last
  if (last && Date.now() - last.at < STATUS_FRESH_MS) return { counts: last, countedAt: last.at, counting: false }
  if (!tierCount.running) {
    const { remoteTierStatus } = await import('../../providers/transcript-offload.js')
    tierCount.running = remoteTierStatus(roots)
      .then((c) => { tierCount.last = { ...c, at: Date.now() }; return c })
      .finally(() => { tierCount.running = undefined })
    tierCount.running.catch((e) => log.session.warn('remote history status could not be counted', { error: (e as Error).message }))
  }
  let timer: NodeJS.Timeout | undefined
  const done = waitMs <= 0 ? false : await Promise.race([
    tierCount.running.then(() => true, () => false),
    new Promise<false>((r) => { timer = setTimeout(() => r(false), waitMs) }),
  ]).finally(() => clearTimeout(timer))
  const now = tierCount.last
  if (done && now) return { counts: now, countedAt: now.at, counting: false }
  return { ...(now ? { counts: now, countedAt: now.at } : {}), counting: true }
}

/** Test seam: forget the cached count. */
export function resetTierCount(): void { tierCount.last = undefined }

export async function remoteStatus(config?: Pick<Config, 'session'> | null, deps?: { roots?: string[]; waitMs?: number }): Promise<{
  enabled: boolean; days: number; bucket: string; region: string; endpoint?: string; prefix: string; auth: ResolvedRemote['auth']
  uploaded: number; remoteOnly: number; remoteBytes: number; counting: boolean; countedAt?: number
}> {
  const r = await currentRemote(config)
  const s = await tierCounts(deps?.roots ?? localProjectsDirs(), deps?.waitMs ?? STATUS_WAIT_MS)
  const c = s.counts ?? { uploaded: 0, remoteOnly: 0, remoteBytes: 0 }
  return {
    enabled: r.enabled, days: r.days, bucket: r.bucket, region: r.region, ...(r.endpoint ? { endpoint: r.endpoint } : {}), prefix: r.prefix, auth: r.auth,
    uploaded: c.uploaded, remoteOnly: c.remoteOnly, remoteBytes: c.remoteBytes, counting: s.counting, ...(s.countedAt ? { countedAt: s.countedAt } : {}),
  }
}
