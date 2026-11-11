/**
 * The session history archive's clock (2026-11-10, the user: keep 60 days of
 * session history plain, compress what is older, decompress on open). Every
 * SWEEP_EVERY_MS the primary asks each connected host's daemon to compress the
 * Claude Code sessions there that nobody touched for `session.history_compress_days`
 * (default 60, 0 = off); the daemon does the work next to the files and
 * restores a session the moment anything opens it (src/providers/transcript-archive.ts).
 *
 * A host is asked only once Walnut has read its whole Claude Code history for
 * usage and costs (the usage collector's first full read), so an archive never
 * hides a session from that read. No isolated server (an ephemeral one, the
 * test runner, a data home in a temp or task dir) runs it: its daemon still
 * reads the account's real Claude Code history. `WALNUT_HISTORY_ARCHIVE=1`
 * turns it on there (an E2E with a throwaway HOME), `=0` off everywhere.
 */
import { log } from '../logging/index.js'
import type { Config } from './types.js'

export const DEFAULT_HISTORY_COMPRESS_DAYS = 60
const FIRST_SWEEP_MS = 20 * 60_000
const SWEEP_EVERY_MS = 6 * 3_600_000
/** A pass that stopped at its budget goes on this soon (the first pass on a host with years of history). */
const RESUME_AFTER_MS = 30 * 60_000
/** Originals set aside are removed by a pass an hour later (transcript-archive.ts ASIDE_KEEP_MS): this one. */
const FINALIZE_AFTER_MS = 70 * 60_000
/** A pass is cut short here; the next one goes on where it stopped. */
const PASS_BUDGET_MS = 10 * 60_000
const PASS_TIMEOUT_MS = PASS_BUDGET_MS + 5 * 60_000

/** Days a session stays plain; 0 = the archive is off. A value below 1 that is not 0 reads as the default. */
export function historyCompressDays(config: Pick<Config, 'session'> | null | undefined): number {
  const v = config?.session?.history_compress_days
  if (v === 0) return 0
  return typeof v === 'number' && Number.isFinite(v) && v >= 1 ? Math.floor(v) : DEFAULT_HISTORY_COMPRESS_DAYS
}

export interface ArchiveConn {
  host: string
  hasCapability?: (cap: string) => boolean
  send: (cmd: string, args: Record<string, unknown>, timeoutMs?: number) => Promise<unknown>
}

export interface ArchivePassRow {
  host: string
  sessions?: number
  files?: number
  bytesBefore?: number
  bytesAfter?: number
  failed?: number
  /** Originals removed this pass (the second step), the bytes that freed, and those still aside. */
  finalized?: number
  freedBytes?: number
  aside?: number
  conflicts?: number
  partial?: boolean
  skipped?: 'usage-not-read' | 'busy' | 'no-capability'
  error?: string
}

/** May this server archive history at all? */
export async function historyArchiveAllowed(env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  if (env.WALNUT_HISTORY_ARCHIVE === '1') return true
  if (env.WALNUT_HISTORY_ARCHIVE === '0') return false
  const [{ IS_EPHEMERAL, WALNUT_HOME }, { semanticLaneDecision }] = await Promise.all([import('../constants.js'), import('./search/semantic-default.js')])
  return semanticLaneDecision({ env: { ...env, WALNUT_SEARCH_V2_SEMANTIC: undefined }, isEphemeral: IS_EPHEMERAL, walnutHome: WALNUT_HOME }).on
}

/** One pass over every connected host. Deps are for tests. */
export async function archiveHistoryOnce(deps?: {
  conns?: ArchiveConn[]
  config?: Pick<Config, 'session'>
  usageRead?: (conn: ArchiveConn) => boolean
  dryRun?: boolean
}): Promise<ArchivePassRow[]> {
  const config = deps?.config ?? await (await import('./config-manager.js')).getConfig()
  const days = historyCompressDays(config)
  if (days === 0) return []
  const { IS_EPHEMERAL } = await import('../constants.js')
  let conns = deps?.conns
  if (!conns) {
    const { listConnectedDaemonsByHost } = await import('../providers/daemon-connection.js')
    conns = [...listConnectedDaemonsByHost().values()].map((list) => list[0]).filter(Boolean) as unknown as ArchiveConn[]
  }
  const usageRead = deps?.usageRead ?? (await defaultUsageRead())
  const rows: ArchivePassRow[] = []
  for (const conn of conns) {
    if (IS_EPHEMERAL && conn.host !== '__local__') continue
    if (!conn.hasCapability?.('transcript-archive-v1')) { rows.push({ host: conn.host, skipped: 'no-capability' }); continue }
    if (!usageRead(conn)) { rows.push({ host: conn.host, skipped: 'usage-not-read' }); continue }
    try {
      const res = await conn.send('transcript.archive', { olderThanDays: days, budgetMs: PASS_BUDGET_MS, ...(deps?.dryRun ? { dryRun: true } : {}) }, PASS_TIMEOUT_MS) as
        { ok?: boolean; error?: string; busy?: boolean; sessions?: number; files?: number; bytesBefore?: number; bytesAfter?: number; failed?: number; partial?: boolean; errors?: string[]
          finalized?: number; freedBytes?: number; aside?: number; conflicts?: number }
      if (res?.ok === false) throw new Error(res.error || 'transcript.archive refused')
      if (res?.busy) { rows.push({ host: conn.host, skipped: 'busy' }); continue }
      const row: ArchivePassRow = {
        host: conn.host, sessions: res?.sessions ?? 0, files: res?.files ?? 0,
        bytesBefore: res?.bytesBefore ?? 0, bytesAfter: res?.bytesAfter ?? 0, failed: res?.failed ?? 0, partial: !!res?.partial,
        finalized: res?.finalized ?? 0, freedBytes: res?.freedBytes ?? 0, aside: res?.aside ?? 0, conflicts: res?.conflicts ?? 0,
      }
      rows.push(row)
      if ((row.sessions ?? 0) > 0 || (row.finalized ?? 0) > 0 || (row.conflicts ?? 0) > 0 || (row.failed ?? 0) > 0) {
        log.session.info('session history archived', { ...row, days, errors: res?.errors ?? [] })
      }
    } catch (err) {
      rows.push({ host: conn.host, error: (err as Error).message })
      log.session.warn('session history archive failed', { host: conn.host, error: (err as Error).message })
    }
  }
  return rows
}

/**
 * Has the usage collector read this host's whole Claude Code history once? A
 * daemon that cannot read sessions Walnut did not start (no claude-outside-v1)
 * never gets that read, so there is nothing to wait for.
 */
async function defaultUsageRead(): Promise<(conn: ArchiveConn) => boolean> {
  try {
    const { responseUsageStore } = await import('./usage/collection.js')
    const rollup = responseUsageStore().rollup
    return (conn) => !conn.hasCapability?.('claude-outside-v1') || rollup.claudeOutsideBuilt(conn.host)
  } catch {
    return () => false
  }
}

let inFlight: Promise<ArchivePassRow[]> | null = null

/** One pass now, joined by every caller while it runs. */
export function archiveHistoryNow(): Promise<ArchivePassRow[]> {
  inFlight ??= archiveHistoryOnce().then(withRemotePass).finally(() => { inFlight = null })
  return inFlight
}

/**
 * The remote tier (history-remote/service.ts) for this machine, after its archive pass and only
 * once that pass is through its backlog: compressing comes first, and the two never compete for
 * the disk at once. Its row reads as the archive's (waiting uploads as `aside`), so the clock
 * comes back for its second step.
 */
async function withRemotePass(rows: ArchivePassRow[]): Promise<ArchivePassRow[]> {
  const local = rows.find((r) => r.host === '__local__')
  if (!local || local.partial || local.error || local.skipped) return rows
  try {
    const { remotePassOnce } = await import('./history-remote/service.js')
    const rr = await remotePassOnce()
    if (rr) rows.push({ host: '__local__:remote', sessions: rr.uploaded, finalized: rr.offloaded, freedBytes: rr.freedBytes, aside: rr.waiting, failed: rr.failed, partial: rr.partial })
  } catch (err) {
    rows.push({ host: '__local__:remote', error: (err as Error).message })
    log.session.warn('session history remote pass failed', { error: (err as Error).message })
  }
  return rows
}

/** A host still busy with a pass (one a restart cut this server off from) is asked again this soon. */
const RETRY_AFTER_MS = 5 * 60_000
/** The soonest a pass runs after a start, even when one was due while the server was down. */
const BOOT_MIN_MS = 3 * 60_000

/** How long after these rows the next pass is due. */
export function nextPassMs(rows: ArchivePassRow[] | null): number {
  if (rows?.some((r) => r.skipped === 'busy')) return RETRY_AFTER_MS
  if (rows?.some((r) => r.partial || r.error)) return RESUME_AFTER_MS
  if (rows?.some((r) => (r.aside ?? 0) > 0)) return FINALIZE_AFTER_MS
  return SWEEP_EVERY_MS
}

/**
 * The first pass after a start: when the due time a previous server kept says, no sooner than
 * BOOT_MIN_MS, never later than a whole sweep. With none kept, FIRST_SWEEP_MS. 2026-11-10: production
 * restarted about every 20 minutes for a day of deploys, the clock began again at each start, and the
 * pass due 20 minutes in was cut off by the next restart every time, so no originals were removed.
 */
export function firstPassMs(dueAt: number | null, now: number): number {
  if (dueAt === null || !Number.isFinite(dueAt)) return FIRST_SWEEP_MS
  return Math.min(SWEEP_EVERY_MS, Math.max(BOOT_MIN_MS, dueAt - now))
}

async function dueFile(): Promise<string | null> {
  try {
    const [{ WALNUT_HOME }, path] = await Promise.all([import('../constants.js'), import('node:path')])
    return path.join(WALNUT_HOME, 'cache', 'history-archive-due.json')
  } catch { return null }
}

async function readDueAt(file: string | null): Promise<number | null> {
  if (!file) return null
  try {
    const fs = await import('node:fs/promises')
    const at = Number((JSON.parse(await fs.readFile(file, 'utf8')) as { dueAt?: unknown }).dueAt)
    return Number.isFinite(at) ? at : null
  } catch { return null }
}

async function writeDueAt(file: string | null, dueAt: number): Promise<void> {
  if (!file) return
  try {
    const [fs, path] = await Promise.all([import('node:fs/promises'), import('node:path')])
    await fs.mkdir(path.dirname(file), { recursive: true })
    const tmp = `${file}.${process.pid}.tmp`
    await fs.writeFile(tmp, JSON.stringify({ dueAt }))
    await fs.rename(tmp, file)
  } catch { /* the clock only: a start without it waits FIRST_SWEEP_MS */ }
}

export function startTranscriptArchiveSweep(deps?: { dueFile?: string | null; now?: () => number }): { stop: () => void } {
  let stopped = false
  let again: ReturnType<typeof setTimeout> | null = null
  let first: ReturnType<typeof setTimeout> | null = null
  const now = deps?.now ?? Date.now
  const file = deps && 'dueFile' in deps ? Promise.resolve(deps.dueFile ?? null) : dueFile()
  const run = (): void => {
    if (stopped) return
    void historyArchiveAllowed().then((ok) => (ok ? archiveHistoryNow() : null)).then(async (rows) => {
      if (stopped || again) return
      // An archive that is off or not allowed yet keeps no due time: the next start waits as before.
      if (!rows) return
      const ms = nextPassMs(rows)
      await writeDueAt(await file, now() + ms)
      if (stopped || again || ms >= SWEEP_EVERY_MS) return
      again = setTimeout(() => { again = null; run() }, ms)
      again.unref?.()
    }).catch(() => { /* next round */ })
  }
  const firstMs = Number(process.env.WALNUT_HISTORY_ARCHIVE_FIRST_MS)
  if (Number.isFinite(firstMs) && firstMs >= 0 && process.env.WALNUT_HISTORY_ARCHIVE_FIRST_MS !== '') {
    first = setTimeout(run, firstMs)
    first.unref?.()
  } else {
    void file.then(async (f) => {
      const dueAt = await readDueAt(f)
      const ms = firstPassMs(dueAt, now())
      // Kept at once: a server restarted before its first pass hands the due time on.
      if (dueAt === null) await writeDueAt(f, now() + ms)
      if (stopped) return
      first = setTimeout(run, ms)
      first.unref?.()
    })
  }
  const every = setInterval(run, SWEEP_EVERY_MS)
  every.unref?.()
  return { stop: () => { stopped = true; if (first) clearTimeout(first); clearInterval(every); if (again) clearTimeout(again) } }
}
