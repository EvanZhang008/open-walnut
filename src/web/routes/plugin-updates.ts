/**
 * GET /api/plugin-updates: every updatable plugin row's state in ONE call.
 *
 * The page asks once when Settings, Plugins opens, so this route must answer in the time
 * it takes to read the cache: the fetches that discover "3 commits behind" run in the
 * background (`UpdateStatusCache.refreshAll`), and the response says `refreshing: true`
 * while they do. `?refresh=1` (Check now) forces a batch past the minimum interval and
 * answers 202 with the same body; a second `?refresh=1` while one is in flight joins it,
 * so one click never means two `git fetch` on the same `.git`.
 *
 * Rows are keyed by CHECKOUT for linked plugins (several plugins linked out of one repo
 * share one fetch and one state) and by slug for git and npm sources. Builtin and example
 * plugins never appear: nothing can update them.
 *
 * Every failure here degrades to whatever the cache holds. A status page that 500s
 * because a sources file could not be read is worse than one that says "not checked".
 */

import { Router } from 'express'
import { CLOUD_MODE } from '../../constants.js'
import type { PluginSourceView } from '../../core/plugin-sources.js'
import type { LinkedCheckoutInfo } from '../../core/plugins/linked-checkout.js'
import type { UpdatableTarget, UpdateStatusCache } from '../../core/plugins/update-status-cache.js'
import {
  PLUGIN_UPDATE_MIN_INTERVAL_MS,
  linkedRowKey,
  sourceRowKey,
  withDeadline,
  type PluginUpdatesResponse,
  type UpdateStatusRow,
} from '../../core/plugins/update-status.js'
import { createSubsystemLogger } from '../../logging/index.js'
import { CLOUD_LINKED_NOTE, linkedRowKeyOf, type LinkedCheckoutOps } from './plugin-linked-ops.js'

const log = createSubsystemLogger('plugin-updates')

/** The sources file is local and fast; past this it is left out of the batch rather than holding the page. */
const LIST_SOURCES_DEADLINE_MS = 3_000

export interface PluginUpdatesRouterDeps {
  cache: UpdateStatusCache
  /** Linked-checkout listing (its real implementation carries its own 5 s budget). */
  linked: LinkedCheckoutOps
  listSources(): Promise<PluginSourceView[]>
  /** Ids of the plugins the store lists, builtin ones excluded. */
  installedIds(): string[]
  /** Where a git source is cloned, so the cache can re-read local facts there between fetches. */
  sourceDir?(slug: string): string
  cloudMode?: boolean
  walnutHome?: string
}

interface CollectedTargets {
  /** What the cache checks. */
  targets: UpdatableTarget[]
  /** Linked rows a replica cannot check: answered `unsupported` without touching git. */
  cloudLinked: Array<{ rowKey: string; pluginIds: string[] }>
}

function emptyResponse(minIntervalMs: number): PluginUpdatesResponse {
  return { checkedAt: null, minIntervalMs, refreshing: false, rows: {}, rowKeyOf: {} }
}

const CLOUD_LINKED_ROW: UpdateStatusRow = {
  state: { kind: 'unsupported', reason: CLOUD_LINKED_NOTE, hint: '' },
  checkedAt: null,
  target: { kind: 'linked' },
}

export function createPluginUpdatesRouter(deps: PluginUpdatesRouterDeps): Router {
  const router = Router()
  const cloudMode = deps.cloudMode ?? CLOUD_MODE

  /**
   * Everything the cache should know about. Linked checkouts are grouped by realpath;
   * sources ride as one row per slug (a `cloned: false` source has no plugins yet and
   * still gets a row, so the store can offer Restore). Each half fails on its own.
   */
  const collectTargets = async (): Promise<CollectedTargets> => {
    const installed = new Set(deps.installedIds())
    const targets: UpdatableTarget[] = []
    const cloudLinked: CollectedTargets['cloudLinked'] = []

    let checkouts = new Map<string, LinkedCheckoutInfo>()
    try {
      checkouts = await deps.linked.list()
    } catch (error) {
      log.warn('plugin updates: linked scan failed', { error: String(error) })
    }
    const byKey = new Map<string, UpdatableTarget & { kind: 'linked' }>()
    for (const [pluginId, info] of checkouts) {
      if (!installed.has(pluginId)) continue
      if (cloudMode) {
        // No realpath on a replica: the checkout is not here, and the key only has to
        // group the siblings of this listing.
        const rowKey = linkedRowKey(info.checkout)
        const group = cloudLinked.find((row) => row.rowKey === rowKey)
        if (group) group.pluginIds.push(pluginId)
        else cloudLinked.push({ rowKey, pluginIds: [pluginId] })
        continue
      }
      const rowKey = await linkedRowKeyOf(info)
      const existing = byKey.get(rowKey)
      if (existing) existing.pluginIds.push(pluginId)
      else byKey.set(rowKey, { rowKey, kind: 'linked', info, pluginIds: [pluginId] })
    }
    targets.push(...byKey.values())

    let sources: PluginSourceView[] = []
    try {
      sources = await withDeadline(deps.listSources(), LIST_SOURCES_DEADLINE_MS, () => {
        log.warn('plugin updates: sources listing timed out, skipped')
        return []
      })
    } catch (error) {
      log.warn('plugin updates: sources listing failed', { error: String(error) })
    }
    for (const source of sources) {
      const kind = source.kind === 'npm' ? 'npm' : 'git'
      // A missing clone has no plugins to scan; the ids it carried last time keep the
      // still-loaded Installed row on the same update row as the Sources card (N2-3).
      const carried = source.plugins.length > 0 ? source.plugins : (source.lastKnownPlugins ?? [])
      targets.push({
        rowKey: sourceRowKey(source.slug),
        kind,
        slug: source.slug,
        cloned: source.cloned,
        pluginIds: carried.map((plugin) => plugin.id).filter((id): id is string => !!id),
        ...(kind === 'git' && deps.sourceDir ? { dir: deps.sourceDir(source.slug) } : {}),
        ...(kind === 'npm' && source.resolved ? { resolved: source.resolved } : {}),
      })
    }
    return { targets, cloudLinked }
  }

  router.get('/', async (req, res) => {
    const refresh = req.query.refresh === '1'
    let collected: CollectedTargets = { targets: [], cloudLinked: [] }
    try {
      collected = await collectTargets()
    } catch (error) {
      log.warn('plugin updates: could not collect targets', { error: String(error) })
    }
    let body: PluginUpdatesResponse
    try {
      // Force first, so the snapshot below already reports the batch as in flight and its
      // own stale check joins that batch instead of starting a second one.
      if (refresh) void deps.cache.refreshAll(collected.targets, { force: true }).catch(() => undefined)
      body = await deps.cache.snapshot(collected.targets)
    } catch (error) {
      log.warn('plugin updates: snapshot failed', { error: String(error) })
      body = emptyResponse(PLUGIN_UPDATE_MIN_INTERVAL_MS)
    }
    for (const row of collected.cloudLinked) {
      body.rows[row.rowKey] = CLOUD_LINKED_ROW
      for (const id of row.pluginIds) body.rowKeyOf[id] = row.rowKey
    }
    if (refresh) body.refreshing = true
    res.status(refresh ? 202 : 200).json(body)
  })

  return router
}
