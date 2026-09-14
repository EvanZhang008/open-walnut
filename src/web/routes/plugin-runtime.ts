import fsp from 'node:fs/promises'
import os from 'node:os'
import { Router, type RequestHandler } from 'express'
import { CLOUD_MODE, WALNUT_HOME } from '../../constants.js'
import { bus } from '../../core/event-bus.js'
import type { IntegrationRegistry } from '../../core/integration-registry.js'
import { PluginDependentsError } from '../../core/plugins/dependency-gate.js'
import { validatePluginId } from '../../core/plugins/ids.js'
import type {
  LinkedCheckoutInfo,
  LinkedCheckoutListing,
  LinkedCheckoutStatus,
  LinkedUpdateResult,
} from '../../core/plugins/linked-checkout.js'
import type { UpdateStatusCache } from '../../core/plugins/update-status-cache.js'
import {
  ROW_CHECK_DEADLINE_MS,
  ROW_TIMEOUT_REASON,
  describeGitFailure,
  fetchEnv,
  maskCredentials,
  withDeadline,
} from '../../core/plugins/update-status.js'
import {
  CLOUD_LINKED_NOTE,
  LINKED_UPDATE_DEADLINE_MS,
  UPDATE_TIMEOUT_MESSAGE,
  defaultLinkedCheckoutOps,
  linkedRowKeyOf,
  type LinkedCheckoutOps,
} from './plugin-linked-ops.js'
import { markHandledFailure } from '../middleware/handled-failure.js'
import {
  loadPluginCatalog,
  mergePluginRegistry,
  type InstalledPluginFacts,
  type PluginRegistryResult,
} from '../../core/plugins/plugin-catalog.js'
import type { PluginLifecycleRecord } from '../../core/plugins/plugin-manager.js'
import { RESTART_PENDING_STATE, clearRestartPending, isRestartPending } from '../../core/plugins/restart-pending.js'
import {
  listPluginWebModules,
  readPluginWebModule,
  type PluginWebModule,
} from '../../core/plugins/plugin-web-module.js'
import { callPluginOp, listPluginOps } from '../../core/plugins/server-api.js'
import {
  callPrimaryPluginOp,
  listPrimaryPluginOps,
  listPrimaryPluginWebModules,
  managePrimaryPlugin,
  PluginRuntimeRelayError,
  readPrimaryPluginWebModule,
  type DiscoveredPluginRecord,
  type PluginManagementAction,
  type PrimaryPluginRuntimeCatalogue,
} from './plugin-runtime-bridge.js'

/**
 * Discovery is additive, so being told `active` does not mean the caller's just-changed
 * files are the ones running. Said in plain words because the usual caller is a person
 * or a CLI that has this second to rsync a directory.
 */
const ALREADY_LOADED_NOTE = 'already loaded; use POST /api/plugin-runtime/<id>/reload to pick up changed files'

// Re-exported so existing importers (server.ts, tests) keep one import path.
export {
  CLOUD_LINKED_NOTE,
  LINKED_UPDATE_DEADLINE_MS,
  UPDATE_TIMEOUT_MESSAGE,
  defaultLinkedCheckoutOps,
  linkedRowKeyOf,
  type LinkedCheckoutOps,
} from './plugin-linked-ops.js'

export interface PluginRuntimeRouterDeps {
  registry: IntegrationRegistry
  list(): PluginLifecycleRecord[]
  discover?(pluginId: string): Promise<DiscoveredPluginRecord>
  reload(pluginId: string): Promise<PluginLifecycleRecord>
  /** `cascade` blocks the plugins that depend on this one instead of refusing. */
  disable(pluginId: string, opts?: { cascade?: boolean }): Promise<PluginLifecycleRecord>
  clearQuarantine(pluginId: string): Promise<void>
  cloudMode?: boolean
  listPrimaryModules?(): Promise<PrimaryPluginRuntimeCatalogue>
  readPrimaryModule?(pluginId: string, expectedHash?: string): Promise<PluginWebModule>
  listPrimaryOps?(pluginId: string): ReturnType<typeof listPrimaryPluginOps>
  callPrimaryOp?(pluginId: string, opName: string, args: Record<string, unknown>): ReturnType<typeof callPrimaryPluginOp>
  managePrimary?(
    pluginId: string,
    operation: PluginManagementAction,
    payload?: { cascade?: boolean },
  ): ReturnType<typeof managePrimaryPlugin>
  /** Which external source installed each plugin id — for the store's Update/Remove. */
  pluginSourceOwners?(): Promise<Map<string, { slug: string; kind: 'git' | 'npm' }>>
  /** Config schemas for plugins that did NOT load because config is missing. */
  unconfiguredSchemas?(): Promise<Map<string, Record<string, unknown> | undefined>>
  /** Overridable so a test can point the catalog overlay at a temp home. */
  walnutHome?: string
  /** Linked-checkout detection and its two git actions. */
  linked?: LinkedCheckoutOps
  /** The update-status cache the check/update actions write into (shared with /api/plugin-updates). */
  cache?: UpdateStatusCache
  /** Override for the 60 s update deadline (tests only). */
  updateDeadlineMs?: number
}

function routePluginId(value: string | string[]): string {
  return validatePluginId(Array.isArray(value) ? value[0] : value)
}

function errorStatus(error: unknown, fallback = 400): number {
  return error instanceof PluginRuntimeRelayError ? error.status : fallback
}

export function createPluginRuntimeRouter(deps: PluginRuntimeRouterDeps): Router {
  const router = Router()
  const cloudMode = deps.cloudMode ?? CLOUD_MODE
  const listPrimaryModules = deps.listPrimaryModules ?? listPrimaryPluginWebModules
  const readPrimaryModule = deps.readPrimaryModule ?? readPrimaryPluginWebModule
  const getPrimaryOps = deps.listPrimaryOps ?? listPrimaryPluginOps
  const invokePrimaryOp = deps.callPrimaryOp ?? callPrimaryPluginOp
  const managePrimary = deps.managePrimary ?? managePrimaryPlugin
  /**
   * id → the external source that installed it. Imported lazily so the plugin-sources
   * module (and the config read behind it) stays off this router's import path.
   */
  const resolveSourceOwners = deps.pluginSourceOwners ?? (async () => {
    const { listSources } = await import('../../core/plugin-sources.js')
    const owners = new Map<string, { slug: string; kind: 'git' | 'npm' }>()
    for (const source of await listSources()) {
      // A source whose clone is gone still OWNS the plugins it carried (one may still be
      // loaded from memory): the row keeps its slug, its chip and its Remove (N2-3).
      const carried = source.plugins.length > 0 ? source.plugins : (source.lastKnownPlugins ?? [])
      for (const plugin of carried) {
        if (plugin.id) owners.set(plugin.id, { slug: source.slug, kind: source.kind ?? 'git' })
      }
    }
    return owners
  })
  /**
   * A needs-config plugin is NOT in the registry (that is what "did not load" means),
   * so its schema cannot be read from there — and those are exactly the plugins whose
   * Configure button matters most. The loader keeps their manifests aside; read them.
   */
  const resolveUnconfiguredSchemas = deps.unconfiguredSchemas ?? (async () => {
    const { getUnconfiguredPlugins } = await import('../../core/integration-loader.js')
    return new Map(getUnconfiguredPlugins().map((plugin) => [plugin.id, plugin.configSchema]))
  })
  /** Lazily imported for the same reason as the source owners above: git stays off this
   *  module's import path until a caller actually asks about a linked checkout. */
  const linked: LinkedCheckoutOps = deps.linked ?? defaultLinkedCheckoutOps()
  const cache = deps.cache
  const updateDeadlineMs = deps.updateDeadlineMs ?? LINKED_UPDATE_DEADLINE_MS
  // The home directory the client folds checkout paths to `~` against. Realpath'd because the
  // linked scan realpaths its checkouts (macOS: /var -> /private/var) and a symlinked home
  // would never prefix-match otherwise. Resolved once; a failure keeps the plain form.
  const homeDirPromise = fsp.realpath(os.homedir()).catch(() => os.homedir())
  /** `listDetailed` when the unit has it (a test's fake may not); a plain list skipped nothing it can name. */
  const listLinkedDetailed = async (): Promise<LinkedCheckoutListing> =>
    linked.listDetailed ? linked.listDetailed() : { found: await linked.list(), skipped: [] }
  /**
   * The linked checkout for ONE plugin, using the dir the registry recorded as a fallback
   * matcher for a link whose name is not the plugin id.
   */
  const detectLinked = (pluginId: string) =>
    linked.detect(pluginId, deps.registry.get(pluginId)?.pluginDir)
  const activePlugin = (pluginId: string) => {
    const active = deps.list().some((plugin) => plugin.id === pluginId && plugin.state === 'active')
    return active ? deps.registry.get(pluginId) : undefined
  }
  const publishCloudChange = (pluginId: string, action: string) => {
    if (!cloudMode) return
    bus.emit('plugin:runtime-changed', { pluginId, action }, ['web-ui'], { source: 'plugin-runtime-relay' })
  }

  router.get('/', async (_req, res, next) => {
    try {
      const localPlugins = deps.list()
      const catalogue = cloudMode
        ? await listPrimaryModules()
        : {
            plugins: localPlugins,
            tombstones: deps.registry.getTombstones(),
            ...await listPluginWebModules(deps.registry, localPlugins),
          }
      const modules = catalogue.modules.map((module) => ({
        ...module,
        url: `/api/plugin-runtime/${encodeURIComponent(module.id)}/web-module?v=${module.hash}`,
      }))
      res.json({
        plugins: catalogue.plugins,
        tombstones: catalogue.tombstones,
        modules,
        moduleErrors: catalogue.errors,
      })
    } catch (error) {
      if (error instanceof PluginRuntimeRelayError) {
        res.status(error.status).json({ error: error.message })
        return
      }
      next(error)
    }
  })

  /**
   * GET /registry — the store's whole list in one call: the curated catalog merged
   * with what is actually installed and what state it is in.
   *
   * Mounted under /api/plugin-runtime because that is the plugin management surface
   * and it needs no new server mount point.
   *
   * Local file + in-memory state only, never the network. In cloud mode the install
   * state comes from the primary over the same relay `GET /` already uses; the
   * plugin-SOURCE list is Mac-local and is not relayed, so external rows come back
   * without their Update/Remove slug and the response says so rather than pretending
   * (`sourcesUnavailable`).
   */
  router.get('/registry', async (_req, res, next) => {
    try {
      const catalog = await loadPluginCatalog(deps.walnutHome ?? WALNUT_HOME)
      const lifecycle = cloudMode ? (await listPrimaryModules()).plugins : deps.list()
      let owners = new Map<string, { slug: string; kind: 'git' | 'npm' }>()
      let pendingSchemas = new Map<string, Record<string, unknown> | undefined>()
      let linkedCheckouts = new Map<string, LinkedCheckoutInfo>()
      // The scan ran out of budget before it reached every link. A row it never looked at
      // must not read as "not linked", so the rows that COULD be one are flagged.
      let linkedScanSkipped = false
      let sourcesUnavailable = cloudMode
      if (!cloudMode) {
        try {
          pendingSchemas = await resolveUnconfiguredSchemas()
        } catch { /* no Configure button for a needs-config row; the reason still shows */ }
        try {
          // Host-local and self-budgeting: a slow git leaves rows without the linked line,
          // which is exactly how they read before this existed.
          const listing = await listLinkedDetailed()
          linkedCheckouts = listing.found
          linkedScanSkipped = listing.skipped.length > 0
        } catch { /* no Check/Update buttons; the row still lists */ }
        try {
          owners = await resolveSourceOwners()
        } catch {
          // A store list that renders is worth more than one that 500s because the
          // sources file could not be read; the rows just lose their slug.
          sourcesUnavailable = true
        }
      }
      const installed: InstalledPluginFacts[] = lifecycle.map((record) => {
        const live = deps.registry.get(record.id)
        const tombstone = deps.registry.getTombstone(record.id)
        const owner = owners.get(record.id)
        return {
          id: record.id,
          name: record.name,
          // A source update replaced this plugin's files while it was loaded: the process
          // still runs the old code, so the row reads RESTART TO ACTIVATE, not ON.
          state: isRestartPending(record.id) ? RESTART_PENDING_STATE : record.state,
          builtin: record.builtin,
          ...(live?.version ?? tombstone?.version ? { version: live?.version ?? tombstone?.version } : {}),
          ...(live?.description ? { description: live.description } : {}),
          ...(live?.capabilities ?? tombstone?.capabilities
            ? { capabilities: live?.capabilities ?? tombstone?.capabilities }
            : {}),
          ...(record.missingConfig?.length ? { missingConfig: record.missingConfig } : {}),
          ...(record.missingDependencies?.length ? { missingDependencies: record.missingDependencies } : {}),
          ...(record.reason ? { reason: record.reason } : {}),
          ...(record.error ? { error: record.error } : {}),
          // "Configure" must open something. A manifest can declare a configSchema
          // whose `properties` is empty (calendar does), and offering Configure for it
          // opens a form that is nothing but a Save button.
          configurable: Object.keys(
            ((
              (live?.configSchema ?? pendingSchemas.get(record.id)) as
                { properties?: Record<string, unknown> } | undefined
            )?.properties) ?? {},
          ).length > 0,
          ...(owner ? { sourceSlug: owner.slug, sourceKind: owner.kind } : {}),
          ...(linkedCheckouts.has(record.id) ? { linked: linkedCheckouts.get(record.id) } : {}),
          ...(linkedScanSkipped && !record.builtin && !owner && !linkedCheckouts.has(record.id)
            ? { linkedScanSkipped: true }
            : {}),
        }
      })
      const merged: PluginRegistryResult = mergePluginRegistry(catalog, installed)
      // A replica's home is not where the checkouts live, so it says nothing about it.
      const homeDir = cloudMode ? undefined : await homeDirPromise
      res.json({ ...merged, sourcesUnavailable, cloud: cloudMode, ...(homeDir ? { homeDir } : {}) })
    } catch (error) {
      if (error instanceof PluginRuntimeRelayError) {
        res.status(error.status).json({ error: error.message })
        return
      }
      next(error)
    }
  })

  router.post('/discover', async (req, res) => {
    try {
      const rawPluginId = req.body?.pluginId
      if (typeof rawPluginId !== 'string') throw new Error('Plugin discovery requires pluginId')
      const pluginId = routePluginId(rawPluginId)
      if (!cloudMode && !deps.discover) {
        res.status(501).json({ error: 'Plugin discovery is unavailable' })
        return
      }
      const plugin = cloudMode
        ? (await managePrimary(pluginId, 'discover')).plugin
        : await deps.discover!(pluginId)
      if (!plugin) throw new PluginRuntimeRelayError('Primary did not return the discovered Plugin', 502)
      publishCloudChange(pluginId, 'discovered')
      res.json({ plugin, ...(plugin.alreadyLoaded ? { note: ALREADY_LOADED_NOTE } : {}) })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      res.status(message.includes('not discovered') ? 404 : errorStatus(error)).json({ error: message })
    }
  })

  const sendWebModule: RequestHandler = async (req, res) => {
    try {
      const pluginId = routePluginId(req.params.pluginId)
      const rawExpectedHash = req.query.v
      if (rawExpectedHash !== undefined && (
        typeof rawExpectedHash !== 'string' || !/^[a-f0-9]{64}$/.test(rawExpectedHash)
      )) {
        res.status(400).json({ error: 'Invalid Plugin module hash' })
        return
      }
      const expectedHash = rawExpectedHash as string | undefined
      let module: PluginWebModule
      if (cloudMode) {
        module = await readPrimaryModule(pluginId, expectedHash)
      } else {
        const plugin = activePlugin(pluginId)
        if (!plugin || plugin.apiVersion !== 1 || !plugin.webEntry) {
          res.status(404).json({ error: `Active native Web Plugin "${pluginId}" was not found` })
          return
        }
        module = await readPluginWebModule(plugin)
        if (expectedHash && module.hash !== expectedHash) {
          res.status(409).json({ error: 'Plugin module changed; refresh the Plugin catalogue' })
          return
        }
      }
      const etag = `"${module.hash}"`
      res.setHeader('ETag', etag)
      res.setHeader('Cache-Control', 'no-cache')
      res.setHeader('Content-Type', 'text/javascript; charset=utf-8')
      res.setHeader('X-Content-Type-Options', 'nosniff')
      const requestEtags = String(req.headers['if-none-match'] ?? '')
        .split(',')
        .map((value) => value.trim())
      if (requestEtags.includes(etag)) {
        res.status(304).end()
        return
      }
      res.send(module.content)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const status = error instanceof PluginRuntimeRelayError
        ? error.status
        : message.includes('exceeds')
          ? 413
          : message.includes('not a file') || message.includes('ENOENT')
            ? 404
            : 400
      res.status(status).json({ error: message })
    }
  }

  router.get('/:pluginId/web-module', sendWebModule)
  router.head('/:pluginId/web-module', sendWebModule)
  router.all('/:pluginId/web-module', (_req, res) => {
    res.status(405).setHeader('Allow', 'GET, HEAD').end()
  })

  router.get('/:pluginId/ops', async (req, res) => {
    try {
      const pluginId = routePluginId(req.params.pluginId)
      if (cloudMode) {
        res.json({ ops: await getPrimaryOps(pluginId) })
        return
      }
      if (!activePlugin(pluginId)) {
        res.status(404).json({ error: `Active Plugin "${pluginId}" was not found` })
        return
      }
      res.json({ ops: await listPluginOps() })
    } catch (error) {
      res.status(errorStatus(error)).json({ error: error instanceof Error ? error.message : String(error) })
    }
  })

  router.post('/:pluginId/ops/:opName', async (req, res) => {
    try {
      const pluginId = routePluginId(req.params.pluginId)
      const rawOpName = req.params.opName
      const opName = Array.isArray(rawOpName) ? rawOpName[0] : rawOpName
      if (!/^[a-z0-9_]{1,128}$/.test(opName)) throw new Error('Invalid operation name')
      const args = req.body && typeof req.body === 'object' && !Array.isArray(req.body)
        ? req.body as Record<string, unknown>
        : {}
      if (cloudMode) {
        res.json(await invokePrimaryOp(pluginId, opName, args))
        return
      }
      if (!activePlugin(pluginId)) {
        res.status(404).json({ error: `Active Plugin "${pluginId}" was not found` })
        return
      }
      res.json(await callPluginOp(pluginId, opName, args))
    } catch (error) {
      res.status(errorStatus(error)).json({ error: error instanceof Error ? error.message : String(error) })
    }
  })

  router.post('/:pluginId/reload', async (req, res) => {
    try {
      const pluginId = routePluginId(req.params.pluginId)
      const plugin = cloudMode
        ? (await managePrimary(pluginId, 'reload')).plugin
        : await deps.reload(pluginId)
      if (!plugin) throw new PluginRuntimeRelayError('Primary did not return the reloaded Plugin', 502)
      // The reload imported the files on disk, so the update that marked this row is live now.
      if (!cloudMode) clearRestartPending(pluginId)
      publishCloudChange(pluginId, 'reloaded')
      res.json({ plugin })
    } catch (error) {
      res.status(errorStatus(error)).json({ error: error instanceof Error ? error.message : String(error) })
    }
  })

  /**
   * POST /:pluginId/disable — turn a plugin off.
   *
   * Refused with 409 `has-dependents` while other plugins run on this one; the caller
   * re-sends `{ cascade: true }` once the user has seen the list. The 409 body shape
   * (`code` + `dependents`) is a contract the store's confirmation reads, so a caller
   * never has to parse the message.
   *
   * Both halves also work through the cloud bridge: `cascade` rides the plugin-manage
   * relay, and a refusal comes back with its dependents decoded, so a replica opens the
   * same confirmation the Mac does.
   */
  router.post('/:pluginId/disable', async (req, res) => {
    try {
      const pluginId = routePluginId(req.params.pluginId)
      const cascade = (req.body as { cascade?: unknown } | undefined)?.cascade === true
      const plugin = cloudMode
        ? (await managePrimary(pluginId, 'disable', cascade ? { cascade: true } : undefined)).plugin
        : await deps.disable(pluginId, { cascade })
      if (!plugin) throw new PluginRuntimeRelayError('Primary did not return the disabled Plugin', 502)
      // Off is off: a disabled plugin is not "running stale code".
      if (!cloudMode) clearRestartPending(pluginId)
      publishCloudChange(pluginId, 'disabled')
      res.json({ plugin })
    } catch (error) {
      if (error instanceof PluginDependentsError) {
        res.status(409).json({ error: error.message, code: error.code, dependents: error.dependents })
        return
      }
      // The relayed twin of the same refusal, so a replica's store gets the same body.
      if (error instanceof PluginRuntimeRelayError && error.code === 'has-dependents') {
        res.status(409).json({ error: error.message, code: error.code, dependents: error.dependents ?? [] })
        return
      }
      const message = error instanceof Error ? error.message : String(error)
      const status = error instanceof PluginRuntimeRelayError
        ? error.status
        : message.includes('not discovered') ? 404 : 400
      res.status(status).json({ error: message })
    }
  })

  /**
   * The two linked-checkout actions.
   *
   *   POST /:pluginId/linked/check  → { behind, ahead, dirty, sha, branch, fetched, reason? }
   *   POST /:pluginId/linked/update → { sha, fromSha, updated, reloaded[], skipped[] }
   *
   * 404 when the plugin is not a linked checkout, so a caller can never be told "up to
   * date" about a directory nobody links to. 409 `dirty` / `diverged` are refusals the
   * store renders as a sentence, never as a crash: neither one touches the work tree.
   *
   * Cloud mode answers 501 with CLOUD_LINKED_NOTE (see its comment).
   *
   * Both write the update-status cache when one is injected, so the chip the store
   * renders from `/api/plugin-updates` flips with the action instead of ten minutes later,
   * and both are bounded: a check past 8 s answers 200 with `fetched: false`, an update
   * past 60 s answers 504. Old response fields are all kept; `state` and `checkedAt` ride
   * alongside them.
   */

  /** A refusal from linked-checkout, recognised without importing it (git stays lazy). */
  const linkedRefusal = (error: unknown): { code: 'dirty' | 'diverged'; message: string } | null => {
    if (!(error instanceof Error) || error.name !== 'LinkedCheckoutError') return null
    const code = (error as { code?: unknown }).code
    return code === 'dirty' || code === 'diverged' ? { code, message: error.message } : null
  }

  router.post('/:pluginId/linked/check', async (req, res) => {
    try {
      const pluginId = routePluginId(req.params.pluginId)
      if (cloudMode) {
        res.status(501).json({ error: CLOUD_LINKED_NOTE })
        return
      }
      const info = await detectLinked(pluginId)
      if (!info) {
        res.status(404).json({ error: `Plugin "${pluginId}" is not a linked checkout` })
        return
      }
      // A fetch nobody is watching: no prompt, no askpass window, ssh in batch mode. On
      // timeout the counts are unknown, and `fetched: false` says so rather than hanging.
      const status: LinkedCheckoutStatus = await withDeadline(
        linked.check(info, { env: fetchEnv() }),
        ROW_CHECK_DEADLINE_MS,
        () => ({ behind: null, ahead: null, dirty: info.dirty, sha: info.sha, branch: info.branch, fetched: false, reason: ROW_TIMEOUT_REASON }),
      )
      if (!cache) {
        res.json(status)
        return
      }
      const row = cache.recordCheck(await linkedRowKeyOf(info), { kind: 'linked', status })
      res.json({ ...status, state: row.state, checkedAt: row.checkedAt })
    } catch (error) {
      res.status(errorStatus(error)).json({ error: error instanceof Error ? error.message : String(error) })
    }
  })

  router.post('/:pluginId/linked/update', async (req, res) => {
    try {
      const pluginId = routePluginId(req.params.pluginId)
      if (cloudMode) {
        res.status(501).json({ error: CLOUD_LINKED_NOTE })
        return
      }
      const info = await detectLinked(pluginId)
      if (!info) {
        res.status(404).json({ error: `Plugin "${pluginId}" is not a linked checkout` })
        return
      }
      const rowKey = await linkedRowKeyOf(info)
      cache?.setBusy(rowKey, true)
      let result: LinkedUpdateResult
      try {
        const TIMED_OUT = Symbol('timeout')
        const outcome = await withDeadline<LinkedUpdateResult | typeof TIMED_OUT>(linked.update(info), updateDeadlineMs, () => TIMED_OUT)
        if (outcome === TIMED_OUT) {
          // The row reports this itself; no incident card for a slow remote (N3-1).
          markHandledFailure(res).status(504).json({ error: UPDATE_TIMEOUT_MESSAGE })
          return
        }
        result = outcome
      } catch (error) {
        const refusal = linkedRefusal(error)
        if (refusal) {
          // The server just saw the tree: the row says dirty / diverged until the next snapshot.
          cache?.recordRefusal(rowKey, refusal.code)
          res.status(409).json({ error: refusal.message, code: refusal.code })
          return
        }
        throw error
      } finally {
        cache?.setBusy(rowKey, false)
      }
      // The whole checkout moved, so every plugin sharing the rowKey is current at `sha`.
      const row = cache?.recordUpdated(rowKey, result.sha)

      // One checkout can hold several plugins, and after a pull they all run stale code.
      // Only plugins that are ON get reloaded: `reload` writes `enabled: true`, so
      // reloading an off plugin would turn it on behind the user's back. The rest are
      // named in `skipped` rather than silently left out.
      const live = new Map(deps.list().map((plugin) => [plugin.id, plugin.state]))
      const siblings = [...(await linked.list().catch(() => new Map<string, LinkedCheckoutInfo>()))]
        .filter(([id, sibling]) => id !== pluginId && sibling.checkout === info.checkout && live.has(id))
        .map(([id]) => id)
        .sort()
      const reloaded: string[] = []
      const skipped: string[] = []
      const failed: Array<{ id: string; error: string }> = []
      for (const id of [pluginId, ...siblings]) {
        const state = live.get(id)
        if (state !== 'active' && state !== 'activating') {
          skipped.push(id)
          continue
        }
        try {
          await deps.reload(id)
          reloaded.push(id)
        } catch (error) {
          failed.push({ id, error: error instanceof Error ? error.message : String(error) })
        }
      }
      if (reloaded.length > 0) publishCloudChange(pluginId, 'reloaded')
      res.json({
        ...result,
        reloaded,
        ...(skipped.length ? { skipped } : {}),
        ...(failed.length ? { failed } : {}),
        ...(row ? { state: row.state, checkedAt: row.checkedAt } : {}),
      })
    } catch (error) {
      if (error instanceof PluginRuntimeRelayError) {
        res.status(error.status).json({ error: error.message })
        return
      }
      // A git failure: one scrubbed sentence for the row (no path, no host, no `fatal:`),
      // the cause for the client's own copy, and the raw masked text for Details.
      const raw = maskCredentials(error instanceof Error ? error.message : String(error))
      const { cause, sentence } = describeGitFailure(raw)
      // Expected and already reported on the row: honest 502, but no red card (N3-1).
      markHandledFailure(res).status(502).json({ error: sentence, cause, detail: raw })
    }
  })

  router.post('/:pluginId/clear-quarantine', async (req, res) => {
    try {
      const pluginId = routePluginId(req.params.pluginId)
      if (cloudMode) await managePrimary(pluginId, 'clear-quarantine')
      else await deps.clearQuarantine(pluginId)
      publishCloudChange(pluginId, 'quarantine-cleared')
      res.json({ ok: true })
    } catch (error) {
      res.status(errorStatus(error)).json({ error: error instanceof Error ? error.message : String(error) })
    }
  })

  return router
}
