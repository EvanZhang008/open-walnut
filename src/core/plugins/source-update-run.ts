/**
 * One update of a plugin source, the same steps whoever asks: the store's Update button
 * (`POST /api/plugin-sources/:slug/update`) and the primary's own clock
 * (`source-auto-update.ts`).
 *
 *   1. Pull (git `pull --ff-only`, npm re-resolve) under the source lock, bounded.
 *   2. Load what is new (the additive soft reload) and reload each plugin that ran from the
 *      source before, so its new code runs without a restart.
 *   3. A git update whose plugin did not come back up is put back on the commit that ran
 *      (`rollbackSource`), the plugin reloaded from it, and the source remembers the bad
 *      commit (`auto.rolledBack`), so the clock never pulls that one again. Without this
 *      the reload's own recovery kept the old code in memory while the files on disk were
 *      the broken version, and the next restart started that.
 *
 * Every outcome writes the store's update row (the shared status cache) and the source's
 * `auto` record, so the Apps page says what happened in place.
 */

import { registry } from '../integration-registry.js'
import {
  listSources, readSourceLocal, recordSourceAuto, rollbackSource, updateSource,
  type PluginSourceView, type UpdateResult,
} from '../plugin-sources.js'
import { createSubsystemLogger } from '../../logging/index.js'
import { clearRestartPending, isRestartPending, isRestartRequiredError, markRestartPending } from './restart-pending.js'
import type { UpdateStatusCache } from './update-status-cache.js'
import { describeGitFailure, maskCredentials, sourceRowKey, withDeadline, type UpdateStatusRow } from './update-status.js'

const log = createSubsystemLogger('plugin-sources')

/** An update that outlives this many ms answers 504; git or npm may still finish on its own. */
export const SOURCE_UPDATE_DEADLINE_MS = 60_000
export const SOURCE_UPDATE_TIMEOUT_MESSAGE = 'Update timed out after 60 s. The checkout was not changed unless git finished on its own; check again.'

export interface SourceUpdateDeps {
  /** Load plugins that are new on disk (additive). */
  softReload(): Promise<void>
  reloadPlugin?(pluginId: string): Promise<{ state?: string } | undefined>
  reloadPlugins?(pluginIds: string[]): Promise<{ reloaded: string[]; skipped: string[] }>
  cache?: UpdateStatusCache
  /** Override for the 60 s update deadline (tests only). */
  deadlineMs?: number
}

export interface SourceRollback {
  /** The commit whose code did not load. */
  sha: string
  /** The commit the source is back on. */
  to: string
  error: string
}

export type SourceUpdateOutcome =
  | { kind: 'not-found' }
  | { kind: 'timeout' }
  /** Automatic only: the clone has changes or commits of its own (checked under the pull's lock). */
  | { kind: 'refused'; reason: 'dirty' | 'diverged' }
  | { kind: 'error'; result: UpdateResult; sentence: string; cause: string; raw: string }
  | {
      kind: 'done'
      result: UpdateResult
      row?: UpdateStatusRow
      reloaded: string[]
      skipped: string[]
      failed: Array<{ id: string; error: string }>
      restartRequired: boolean
      rolledBack?: SourceRollback
      /** The rollback itself failed: the new files stay and the plugin waits for a restart. */
      rollbackError?: string
    }

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error))

/** The reload outlived its deadline and still runs: not a version that failed to load. */
const RELOAD_STILL_RUNNING = 'Plugin reload is still running; its status will update when it finishes'

/** Reload the plugins that ran from the source; never throws. */
async function reloadTargets(
  deps: SourceUpdateDeps,
  targets: string[],
): Promise<{ reloaded: string[]; skipped: string[]; failed: Array<{ id: string; error: string }> }> {
  const reloaded: string[] = []
  const skipped: string[] = []
  const failed: Array<{ id: string; error: string }> = []
  if (deps.reloadPlugins && targets.length) {
    markRestartPending(targets)
    try {
      const operation = deps.reloadPlugins(targets).then((outcome) => {
        for (const id of [...outcome.reloaded, ...outcome.skipped]) clearRestartPending(id)
        return outcome
      })
      const outcome = await withDeadline(operation, SOURCE_UPDATE_DEADLINE_MS, () => {
        throw new Error(RELOAD_STILL_RUNNING)
      })
      reloaded.push(...outcome.reloaded)
      skipped.push(...outcome.skipped)
    } catch (error) {
      // Code that only a restart can replace stays marked for the restart; it did not fail.
      if (!isRestartRequiredError(error)) failed.push(...targets.map((id) => ({ id, error: errorText(error) })))
    }
  } else if (deps.reloadPlugin) {
    for (const id of targets) {
      if (!registry.has(id)) { skipped.push(id); continue }
      markRestartPending([id])
      try {
        const record = await deps.reloadPlugin(id)
        if (record?.state !== 'active') throw new Error(`Plugin "${id}" is ${record?.state ?? 'unknown'}`)
        clearRestartPending(id)
        reloaded.push(id)
      } catch (error) {
        if (!isRestartRequiredError(error)) failed.push({ id, error: errorText(error) })
      }
    }
  } else markRestartPending(targets)
  return { reloaded, skipped, failed }
}

/**
 * Back to the commit that ran. The loader's own recovery usually kept the old code running
 * in memory; once the files match it again there is nothing left to restart. A plugin the
 * recovery could not bring back is reloaded from the restored files.
 */
async function rollBack(deps: SourceUpdateDeps, slug: string, result: UpdateResult, targets: string[], failed: Array<{ id: string; error: string }>): Promise<SourceRollback> {
  const rollback: SourceRollback = { sha: result.toSha!, to: result.fromSha!, error: failed.map((f) => f.error).join('; ') }
  await rollbackSource(slug, rollback.to, rollback.sha)
  for (const id of targets) {
    if (registry.has(id)) { clearRestartPending(id); continue }
    if (!deps.reloadPlugin) continue
    try {
      const record = await deps.reloadPlugin(id)
      if (record?.state === 'active') clearRestartPending(id)
    } catch (error) {
      log.warn('plugin did not come back after rollback', { slug, pluginId: id, error: errorText(error) })
    }
  }
  return rollback
}

export async function runSourceUpdate(slug: string, deps: SourceUpdateDeps, by: 'auto' | 'manual'): Promise<SourceUpdateOutcome> {
  const source: PluginSourceView | undefined = (await listSources()).find((s) => s.slug === slug)
  if (!source) return { kind: 'not-found' }
  // Ids loaded from this source BEFORE the pull: if the pull changed their code, the
  // in-memory version is now stale until a reload.
  const loadedBefore = source.plugins.map((p) => p.id).filter((id): id is string => !!id && registry.has(id))
  const rowKey = sourceRowKey(slug)
  const cache = deps.cache
  cache?.setBusy(rowKey, true)
  const TIMED_OUT = Symbol('timeout')
  let result: UpdateResult
  try {
    const outcome = await withDeadline<UpdateResult | typeof TIMED_OUT>(
      updateSource(slug, { requireClean: by === 'auto' }), deps.deadlineMs ?? SOURCE_UPDATE_DEADLINE_MS, () => TIMED_OUT)
    if (outcome === TIMED_OUT) return { kind: 'timeout' }
    if (outcome.refused) return { kind: 'refused', reason: outcome.refused }
    result = outcome
  } finally {
    cache?.setBusy(rowKey, false)
  }
  if (result.error) {
    // One scrubbed sentence for the row (no path, no host, no `fatal:`), the cause for the
    // client's copy, and the raw masked text for the Details disclosure.
    const raw = maskCredentials(result.error)
    const { cause, sentence } = describeGitFailure(raw)
    return { kind: 'error', result, sentence, cause, raw }
  }
  if (result.updated) {
    try {
      await deps.softReload()
    } catch (err) {
      log.warn('soft reload after update failed', { error: String(err) })
    }
  }
  const targets = loadedBefore.filter((id) => registry.has(id) && (result.updated || isRestartPending(id)))
  // Plugins the new commit added that the soft reload just started: a rollback removes their
  // files while they keep running until the next restart, so it is logged by name.
  const added = result.updated
    ? ((await listSources().catch(() => [])).find((s) => s.slug === slug)?.plugins ?? [])
      .map((p) => p.id).filter((id): id is string => !!id && registry.has(id) && !loadedBefore.includes(id))
    : []
  const { reloaded, skipped, failed } = await reloadTargets(deps, targets)

  let rolledBack: SourceRollback | undefined
  let rollbackError: string | undefined
  const gitUpdate = source.kind === 'git' && result.updated && !!result.fromSha && !!result.toSha
  // A reload still running past its deadline is left alone: resetting the files under it
  // would leave memory and disk on different commits.
  const didNotLoad = failed.length > 0 && failed.every((f) => f.error !== RELOAD_STILL_RUNNING)
  if (gitUpdate && didNotLoad) {
    try {
      rolledBack = await rollBack(deps, slug, result, targets, failed)
      log.warn('plugin source update did not load, rolled back', { slug, by, badSha: rolledBack.sha, toSha: rolledBack.to, error: rolledBack.error, ...(added.length ? { addedStillRunning: added } : {}) })
    } catch (error) {
      rollbackError = errorText(error)
      log.error('plugin source rollback failed', { slug, by, error: rollbackError })
    }
  }

  const at = new Date().toISOString()
  // The row is current at what landed: a git sha, an npm `name@version`, or (a pull that
  // found nothing new) whatever the source already recorded. After a rollback the row is
  // behind again, by the commits that did not load.
  const behind = rolledBack ? await readSourceLocal(slug).then((facts) => facts.behind, () => 1) : 0
  const row = rolledBack
    ? cache?.recordCheck(rowKey, { kind: 'git', result: { behind, updateAvailable: true, upstreamSha: rolledBack.sha, sha: rolledBack.to }, cloned: true })
    : cache?.recordUpdated(rowKey, result.toSha ?? result.resolved ?? source.lastSha ?? source.resolved ?? '')
  if (source.kind === 'git') {
    await recordSourceAuto(slug, (auto) => {
      if (rolledBack) {
        auto.rolledBack = { sha: rolledBack.sha, to: rolledBack.to, at, error: rolledBack.error, by }
        return
      }
      if (result.updated && result.toSha) {
        auto.lastUpdate = { ...(result.fromSha ? { from: result.fromSha } : {}), to: result.toSha, at, by }
        delete auto.rolledBack
      }
      delete auto.skipped
    }).catch((error) => log.warn('could not record plugin source update', { slug, error: errorText(error) }))
  }
  const restartRequired = !rolledBack && targets.some((id) => isRestartPending(id))
  return {
    kind: 'done', result, ...(row ? { row } : {}), reloaded, skipped, failed, restartRequired,
    ...(rolledBack ? { rolledBack } : {}), ...(rollbackError ? { rollbackError } : {}),
  }
}
