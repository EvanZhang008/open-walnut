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
        { ok?: boolean; error?: string; busy?: boolean; sessions?: number; files?: number; bytesBefore?: number; bytesAfter?: number; failed?: number; partial?: boolean; errors?: string[] }
      if (res?.ok === false) throw new Error(res.error || 'transcript.archive refused')
      if (res?.busy) { rows.push({ host: conn.host, skipped: 'busy' }); continue }
      const row: ArchivePassRow = {
        host: conn.host, sessions: res?.sessions ?? 0, files: res?.files ?? 0,
        bytesBefore: res?.bytesBefore ?? 0, bytesAfter: res?.bytesAfter ?? 0, failed: res?.failed ?? 0, partial: !!res?.partial,
      }
      rows.push(row)
      if ((row.sessions ?? 0) > 0 || (row.failed ?? 0) > 0) {
        log.session.info('session history archived', { ...row, days, freedBytes: (row.bytesBefore ?? 0) - (row.bytesAfter ?? 0), errors: res?.errors ?? [] })
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
  inFlight ??= archiveHistoryOnce().finally(() => { inFlight = null })
  return inFlight
}

export function startTranscriptArchiveSweep(): { stop: () => void } {
  let stopped = false
  let again: ReturnType<typeof setTimeout> | null = null
  const run = (): void => {
    if (stopped) return
    void historyArchiveAllowed().then((ok) => (ok ? archiveHistoryNow() : null)).then((rows) => {
      if (stopped || again || !rows?.some((r) => r.partial)) return
      again = setTimeout(() => { again = null; run() }, RESUME_AFTER_MS)
      again.unref?.()
    }).catch(() => { /* next round */ })
  }
  const firstMs = Number(process.env.WALNUT_HISTORY_ARCHIVE_FIRST_MS)
  const first = setTimeout(run, Number.isFinite(firstMs) && firstMs >= 0 ? firstMs : FIRST_SWEEP_MS)
  first.unref?.()
  const every = setInterval(run, SWEEP_EVERY_MS)
  every.unref?.()
  return { stop: () => { stopped = true; clearTimeout(first); clearInterval(every); if (again) clearTimeout(again) } }
}
