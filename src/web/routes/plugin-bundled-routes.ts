/**
 * Install and Remove for the bundled plugin store (`plugin-store/` in the repo,
 * `dist/plugin-store/` in a build; see src/core/plugins/bundled-store.ts).
 *
 *   POST /bundled/:pluginId/install → { plugin, alreadyInstalled? } (the lifecycle record, like /discover)
 *   POST /bundled/:pluginId/remove  → { removed, plugin? }   (the record as it was switched off)
 *
 * Install writes `plugins.<id>.enabled: true` and then runs the same additive discovery
 * `/discover` does, so the plugin loads live with no restart. A plugin that still cannot
 * be discovered (its build never ran) gets its config write rolled back, so the store
 * never shows a row as installed that nothing loaded.
 *
 * Remove turns the plugin off through the same `disable` the switch uses (which owns the
 * dependents gate: 409 `has-dependents` while other plugins run on it), forgets its
 * record, and deletes the whole `plugins.<id>` key. Without that key the folder is not
 * installed, so the next registry read, and every later boot, lists it as available.
 *
 * Cloud mode relays both to the primary over the plugin-manage bridge, like `/discover`.
 */

import type { Router } from 'express'
import { PluginDependentsError } from '../../core/plugins/dependency-gate.js'
import { validatePluginId } from '../../core/plugins/ids.js'
import { listInstalledBundledDirs, resolveBundledStoreDir, scanBundledStore } from '../../core/plugins/bundled-store.js'
import type { PluginLifecycleRecord } from '../../core/plugins/plugin-manager.js'
import {
  PluginRuntimeRelayError,
  type DiscoveredPluginRecord,
  type managePrimaryPlugin,
  type PluginManagementAction,
} from './plugin-runtime-bridge.js'

/** The two config writes, injectable so a route test never touches a real config.yaml. */
export interface BundledPluginConfigWriter {
  enable(pluginId: string): Promise<void>
  /** Delete `plugins.<id>`; resolves whether a key was there. */
  remove(pluginId: string): Promise<boolean>
}

export interface BundledPluginRouteDeps {
  cloudMode: boolean
  list(): PluginLifecycleRecord[]
  discover?(pluginId: string): Promise<DiscoveredPluginRecord>
  disable(pluginId: string, opts?: { cascade?: boolean }): Promise<PluginLifecycleRecord>
  /** Drop a disabled bundled plugin's record (integration-loader forgetBundledPlugin). */
  forget?(pluginId: string): Promise<boolean>
  managePrimary(
    pluginId: string,
    operation: PluginManagementAction,
    payload?: { cascade?: boolean },
  ): ReturnType<typeof managePrimaryPlugin>
  publishCloudChange(pluginId: string, action: string): void
  /** undefined: this build's store; null: none (tests). */
  bundledStoreDir?: string | null
  pluginConfig?: BundledPluginConfigWriter
}

const defaultConfigWriter: BundledPluginConfigWriter = {
  async enable(pluginId) {
    const { updatePluginConfig } = await import('../../core/config-manager.js')
    await updatePluginConfig(pluginId, { enabled: true })
  },
  async remove(pluginId) {
    const { removePluginConfig } = await import('../../core/config-manager.js')
    return removePluginConfig(pluginId)
  },
}

function paramId(value: string | string[]): string {
  return validatePluginId(Array.isArray(value) ? value[0] : value)
}

/** The 409 the store's cascade confirmation already knows how to read. */
function dependentsBody(error: unknown): { error: string; code: 'has-dependents'; dependents: string[] } | null {
  if (error instanceof PluginDependentsError) {
    return { error: error.message, code: error.code, dependents: error.dependents }
  }
  if (error instanceof PluginRuntimeRelayError && error.code === 'has-dependents') {
    return { error: error.message, code: 'has-dependents', dependents: error.dependents ?? [] }
  }
  return null
}

function failureStatus(error: unknown, message: string): number {
  if (error instanceof PluginRuntimeRelayError) return error.status
  if (message.startsWith('Invalid plugin id')) return 400
  return message.includes('not discovered') ? 404 : 400
}

export function mountBundledPluginRoutes(router: Router, deps: BundledPluginRouteDeps): void {
  const config = deps.pluginConfig ?? defaultConfigWriter
  const storeDir = async (): Promise<string | null> =>
    deps.bundledStoreDir === undefined ? resolveBundledStoreDir() : deps.bundledStoreDir
  const inStore = async (pluginId: string): Promise<boolean> =>
    (await scanBundledStore(await storeDir())).some((entry) => entry.id === pluginId)
  const notInStore = (pluginId: string) => ({ error: `"${pluginId}" is not in this build's bundled plugin store` })

  router.post('/bundled/:pluginId/install', async (req, res) => {
    try {
      const pluginId = paramId(req.params.pluginId)
      if (deps.cloudMode) {
        const plugin = (await deps.managePrimary(pluginId, 'bundled-install')).plugin
        if (!plugin) throw new PluginRuntimeRelayError('Primary did not return the installed Plugin', 502)
        deps.publishCloudChange(pluginId, 'installed')
        res.json({ plugin })
        return
      }
      if (!deps.discover) {
        res.status(501).json({ error: 'Plugin discovery is unavailable' })
        return
      }
      if (!(await inStore(pluginId))) {
        res.status(404).json(notInStore(pluginId))
        return
      }
      const existing = deps.list().find((record) => record.id === pluginId)
      // Same id already running from a link or a source: that copy wins discovery, so
      // writing `enabled: true` here would change nothing but the user's config.
      if (existing && !existing.bundled) {
        res.status(409).json({ error: `A plugin with the id "${pluginId}" is already installed from another place`, code: 'not-bundled' })
        return
      }
      // Already installed (maybe switched off): additive discovery would not touch it, so a
      // write here would only make config disagree with what runs. The switch turns it on.
      if (existing) {
        res.json({ plugin: existing, alreadyInstalled: true })
        return
      }
      await config.enable(pluginId)
      let plugin: DiscoveredPluginRecord
      try {
        plugin = await deps.discover(pluginId)
      } catch (error) {
        // Nothing loaded it, so nothing is installed: take the config write back and say why.
        // (A record that did appear keeps its config: rolling back under it would make the
        // next boot disagree with what runs now.)
        if (!deps.list().some((entry) => entry.id === pluginId)) await config.remove(pluginId).catch(() => false)
        const { skipped } = await listInstalledBundledDirs(await storeDir(), { [pluginId]: { enabled: true } })
        const why = skipped.find((entry) => entry.reason)?.reason
        const message = error instanceof Error ? error.message : String(error)
        res.status(why || message.includes('not discovered') ? 422 : 400)
          .json({ error: why ? `"${pluginId}" could not be loaded: ${why}` : message })
        return
      }
      res.json({ plugin })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      res.status(failureStatus(error, message)).json({ error: message })
    }
  })

  router.post('/bundled/:pluginId/remove', async (req, res) => {
    try {
      const pluginId = paramId(req.params.pluginId)
      if (deps.cloudMode) {
        const result = await deps.managePrimary(pluginId, 'bundled-remove')
        deps.publishCloudChange(pluginId, 'removed')
        res.json({ removed: result.removed === true, ...(result.plugin ? { plugin: result.plugin } : {}) })
        return
      }
      if (!deps.forget) {
        res.status(501).json({ error: 'Removing a bundled plugin is unavailable' })
        return
      }
      const record = deps.list().find((entry) => entry.id === pluginId)
      if (record && !record.bundled) {
        res.status(409).json({ error: `"${pluginId}" was not installed from the bundled store; remove it where it came from`, code: 'not-bundled' })
        return
      }
      if (!record) {
        // Never discovered (not built, or already gone): only the config key is left to clean.
        if (!(await inStore(pluginId))) {
          res.status(404).json(notInStore(pluginId))
          return
        }
        res.json({ removed: await config.remove(pluginId) })
        return
      }
      // The switch's own OFF: dependents gate, teardown, polling stop. It refuses (409)
      // before touching anything while another plugin runs on this one.
      const plugin = await deps.disable(pluginId)
      await deps.forget(pluginId)
      await config.remove(pluginId)
      res.json({ removed: true, plugin })
    } catch (error) {
      const refusal = dependentsBody(error)
      if (refusal) {
        res.status(409).json(refusal)
        return
      }
      const message = error instanceof Error ? error.message : String(error)
      res.status(failureStatus(error, message)).json({ error: message })
    }
  })
}
