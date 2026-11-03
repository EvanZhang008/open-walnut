/**
 * Store plugins keep themselves current: the primary's own clock pulls a git plugin source
 * that is behind, without anyone opening the Apps page or pressing Update (2026-11-03, the
 * user: a coworker's store plugin sat 50 commits behind because nobody clicked).
 *
 * Each round, one source at a time:
 *
 *   - fetch, through the shared status cache (`refreshRow`), so the store's chip moves with it;
 *   - read the clone's own facts (`readSourceLocal`): a clone with edits or untracked files,
 *     or with commits the source does not have, is left alone and says why (`auto.skipped`);
 *   - a commit that already failed to load (`auto.rolledBack.sha`) is not pulled again;
 *   - otherwise run the very update the Update button runs (`runSourceUpdate`), which
 *     reloads what changed and rolls back a version that does not load.
 *
 * Only git sources: an npm tag moves only when the user asks. Off per source with
 * `auto_update: false` in config (the store's switch); off everywhere with
 * `WALNUT_PLUGIN_AUTO_UPDATE=0`. The server starts it only where plugins run (the leader).
 */

import { listSources, readSourceLocal, recordSourceAuto, type PluginSourceView, type SourceAutoState } from '../plugin-sources.js'
import { createSubsystemLogger } from '../../logging/index.js'
import { bus } from '../event-bus.js'
import type { UpdatableTarget, UpdateStatusCache } from './update-status-cache.js'
import { sourceRowKey } from './update-status.js'
import type { SourceUpdateOutcome } from './source-update-run.js'

const log = createSubsystemLogger('plugin-auto-update')

/** The first round waits for the boot's plugin load to settle. */
export const AUTO_UPDATE_FIRST_DELAY_MS = 2 * 60_000
export const AUTO_UPDATE_INTERVAL_MS = 30 * 60_000

/** What one source's round did, for the log and the tests. */
export type AutoRoundResult =
  | { slug: string; action: 'updated'; from?: string; to: string; reloaded: string[] }
  | { slug: string; action: 'rolled-back'; sha: string; to: string }
  | { slug: string; action: 'skipped'; reason: 'dirty' | 'diverged' }
  | { slug: string; action: 'held'; sha: string }
  | { slug: string; action: 'current' | 'unreachable' | 'off' | 'not-cloned' | 'failed'; detail?: string }

export interface SourceAutoUpdaterDeps {
  cache: UpdateStatusCache
  /** The Update button's run (`runSourceUpdate` with the server's reload closures). */
  update(slug: string): Promise<SourceUpdateOutcome>
  /** Where a git source is cloned. */
  sourceDir(slug: string): string
  listSources?: () => Promise<PluginSourceView[]>
  readLocal?: typeof readSourceLocal
  record?: typeof recordSourceAuto
  /** Tell open pages a source changed (the Apps page re-reads it). */
  notify?(slug: string): void
  now?(): number
}

export interface SourceAutoUpdater {
  start(opts?: { firstDelayMs?: number; intervalMs?: number }): void
  stop(): void
  /** One round over every source; a second call while one runs joins it. */
  runOnce(): Promise<AutoRoundResult[]>
}

const sameSkip = (prev: SourceAutoState['skipped'], reason: 'dirty' | 'diverged', behind: number, ahead: number): boolean =>
  !!prev && prev.reason === reason && prev.behind === behind && prev.ahead === ahead

export function createSourceAutoUpdater(deps: SourceAutoUpdaterDeps): SourceAutoUpdater {
  const list = deps.listSources ?? listSources
  const readLocal = deps.readLocal ?? readSourceLocal
  const record = deps.record ?? recordSourceAuto
  const notify = deps.notify ?? ((slug: string) => {
    bus.emit('plugin-sources:changed', { slug }, ['web-ui'], { source: 'plugin-auto-update' })
  })
  const now = deps.now ?? Date.now
  let timer: ReturnType<typeof setTimeout> | null = null
  let stopped = true
  let round: Promise<AutoRoundResult[]> | null = null

  const oneSource = async (source: PluginSourceView): Promise<AutoRoundResult> => {
    const slug = source.slug
    if (source.autoUpdate === false) return { slug, action: 'off' }
    if (!source.cloned) return { slug, action: 'not-cloned' }
    const rowKey = sourceRowKey(slug)
    const target: UpdatableTarget = {
      rowKey, kind: 'git', slug, cloned: true, dir: deps.sourceDir(slug),
      pluginIds: source.plugins.map((p) => p.id).filter((id): id is string => !!id),
    }
    const row = await deps.cache.refreshRow(rowKey, target)
    if (row.state.kind === 'unreachable' || row.state.kind === 'missing') {
      return { slug, action: 'unreachable', detail: row.state.kind === 'unreachable' ? row.state.reason : 'missing' }
    }
    const facts = await readLocal(slug)
    const at = new Date(now()).toISOString()
    const skip = async (reason: 'dirty' | 'diverged'): Promise<AutoRoundResult> => {
      if (!sameSkip(source.auto?.skipped, reason, facts.behind, facts.ahead)) {
        await record(slug, (auto) => { auto.skipped = { reason, at, behind: facts.behind, ahead: facts.ahead } })
        notify(slug)
      }
      return { slug, action: 'skipped', reason }
    }
    // Changes of its own matter only when there is something to pull: someone working in a
    // current clone has nothing to be told.
    if (facts.behind > 0 && (facts.dirty || facts.ahead > 0)) {
      return skip(facts.dirty ? 'dirty' : 'diverged')
    }
    if (source.auto?.skipped) {
      await record(slug, (auto) => { delete auto.skipped })
      notify(slug)
    }
    if (facts.behind === 0) return { slug, action: 'current' }
    const held = source.auto?.rolledBack?.sha
    if (held && held === facts.upstream) return { slug, action: 'held', sha: held }
    const outcome = await deps.update(slug)
    if (outcome.kind === 'refused') return skip(outcome.reason)
    notify(slug)
    if (outcome.kind === 'done' && outcome.rolledBack) {
      return { slug, action: 'rolled-back', sha: outcome.rolledBack.sha, to: outcome.rolledBack.to }
    }
    if (outcome.kind === 'done' && outcome.result.updated && outcome.result.toSha) {
      return { slug, action: 'updated', ...(outcome.result.fromSha ? { from: outcome.result.fromSha } : {}), to: outcome.result.toSha, reloaded: outcome.reloaded }
    }
    return { slug, action: 'failed', detail: outcome.kind === 'error' ? outcome.sentence : outcome.kind }
  }

  const runOnce = (): Promise<AutoRoundResult[]> => {
    if (round) return round
    const run = (async () => {
      const results: AutoRoundResult[] = []
      let sources: PluginSourceView[] = []
      try {
        sources = (await list()).filter((source) => source.kind === 'git' && source.enabled !== false)
      } catch (error) {
        log.warn('plugin auto-update: could not list sources', { error: String(error) })
        return results
      }
      // One at a time: each pull is git on one clone, and a reload holds the plugin lane.
      for (const source of sources) {
        try {
          results.push(await oneSource(source))
        } catch (error) {
          results.push({ slug: source.slug, action: 'failed', detail: error instanceof Error ? error.message : String(error) })
        }
      }
      for (const result of results) {
        if (result.action === 'current' || result.action === 'off') continue
        log.info('plugin auto-update', { ...result })
      }
      return results
    })()
    round = run
    void run.finally(() => { if (round === run) round = null })
    return run
  }

  const schedule = (ms: number, intervalMs: number) => {
    if (stopped) return
    timer = setTimeout(() => {
      timer = null
      void runOnce().catch(() => undefined).finally(() => schedule(intervalMs, intervalMs))
    }, ms)
    timer.unref?.()
  }

  return {
    start(opts = {}) {
      if (!stopped) return
      stopped = false
      const intervalMs = opts.intervalMs ?? AUTO_UPDATE_INTERVAL_MS
      schedule(opts.firstDelayMs ?? AUTO_UPDATE_FIRST_DELAY_MS, intervalMs)
    },
    stop() {
      stopped = true
      if (timer) clearTimeout(timer)
      timer = null
    },
    runOnce,
  }
}

/** Read the env knobs: off, and the two clocks (tests and demos shorten them). */
export function autoUpdateEnv(env: NodeJS.ProcessEnv = process.env): { enabled: boolean; firstDelayMs?: number; intervalMs?: number } {
  const num = (raw: string | undefined): number | undefined => {
    const n = raw ? Number(raw) : NaN
    return Number.isFinite(n) && n >= 1_000 ? n : undefined
  }
  const firstDelayMs = num(env.WALNUT_PLUGIN_AUTO_UPDATE_FIRST_MS)
  const intervalMs = num(env.WALNUT_PLUGIN_AUTO_UPDATE_INTERVAL_MS)
  return {
    enabled: env.WALNUT_PLUGIN_AUTO_UPDATE !== '0',
    ...(firstDelayMs ? { firstDelayMs } : {}),
    ...(intervalMs ? { intervalMs } : {}),
  }
}
