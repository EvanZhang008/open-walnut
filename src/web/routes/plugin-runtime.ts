import { Router, type RequestHandler } from 'express'
import { CLOUD_MODE, WALNUT_HOME } from '../../constants.js'
import { bus } from '../../core/event-bus.js'
import type { IntegrationRegistry } from '../../core/integration-registry.js'
import { validatePluginId } from '../../core/plugins/ids.js'
import {
  loadPluginCatalog,
  mergePluginRegistry,
  type InstalledPluginFacts,
  type PluginRegistryResult,
} from '../../core/plugins/plugin-catalog.js'
import type { PluginLifecycleRecord } from '../../core/plugins/plugin-manager.js'
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
  type PluginManagementAction,
  type PrimaryPluginRuntimeCatalogue,
} from './plugin-runtime-bridge.js'

export interface PluginRuntimeRouterDeps {
  registry: IntegrationRegistry
  list(): PluginLifecycleRecord[]
  discover?(pluginId: string): Promise<PluginLifecycleRecord>
  reload(pluginId: string): Promise<PluginLifecycleRecord>
  disable(pluginId: string): Promise<PluginLifecycleRecord>
  clearQuarantine(pluginId: string): Promise<void>
  cloudMode?: boolean
  listPrimaryModules?(): Promise<PrimaryPluginRuntimeCatalogue>
  readPrimaryModule?(pluginId: string, expectedHash?: string): Promise<PluginWebModule>
  listPrimaryOps?(pluginId: string): ReturnType<typeof listPrimaryPluginOps>
  callPrimaryOp?(pluginId: string, opName: string, args: Record<string, unknown>): ReturnType<typeof callPrimaryPluginOp>
  managePrimary?(pluginId: string, operation: PluginManagementAction): ReturnType<typeof managePrimaryPlugin>
  /** Which external source installed each plugin id — for the store's Update/Remove. */
  pluginSourceOwners?(): Promise<Map<string, { slug: string; kind: 'git' | 'npm' }>>
  /** Config schemas for plugins that did NOT load because config is missing. */
  unconfiguredSchemas?(): Promise<Map<string, Record<string, unknown> | undefined>>
  /** Overridable so a test can point the catalog overlay at a temp home. */
  walnutHome?: string
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
      for (const plugin of source.plugins) {
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
      let sourcesUnavailable = cloudMode
      if (!cloudMode) {
        try {
          pendingSchemas = await resolveUnconfiguredSchemas()
        } catch { /* no Configure button for a needs-config row; the reason still shows */ }
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
          state: record.state,
          builtin: record.builtin,
          ...(live?.version ?? tombstone?.version ? { version: live?.version ?? tombstone?.version } : {}),
          ...(live?.description ? { description: live.description } : {}),
          ...(live?.capabilities ?? tombstone?.capabilities
            ? { capabilities: live?.capabilities ?? tombstone?.capabilities }
            : {}),
          ...(record.missingConfig?.length ? { missingConfig: record.missingConfig } : {}),
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
        }
      })
      const merged: PluginRegistryResult = mergePluginRegistry(catalog, installed)
      res.json({ ...merged, sourcesUnavailable, cloud: cloudMode })
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
      res.json({ plugin })
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
      publishCloudChange(pluginId, 'reloaded')
      res.json({ plugin })
    } catch (error) {
      res.status(errorStatus(error)).json({ error: error instanceof Error ? error.message : String(error) })
    }
  })

  router.post('/:pluginId/disable', async (req, res) => {
    try {
      const pluginId = routePluginId(req.params.pluginId)
      const plugin = cloudMode
        ? (await managePrimary(pluginId, 'disable')).plugin
        : await deps.disable(pluginId)
      if (!plugin) throw new PluginRuntimeRelayError('Primary did not return the disabled Plugin', 502)
      publishCloudChange(pluginId, 'disabled')
      res.json({ plugin })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const status = error instanceof PluginRuntimeRelayError
        ? error.status
        : message.includes('not discovered') ? 404 : 400
      res.status(status).json({ error: message })
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
