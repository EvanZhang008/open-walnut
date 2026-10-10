/**
 * The one host-server manager of this (primary) server, wired to the real
 * config, daemon connections, tunnel port and copy targets (manager.ts says
 * what it does). A replica runs none.
 */

import path from 'node:path'
import { CLOUD_MODE, WALNUT_HOME } from '../../constants.js'
import { log } from '../../logging/index.js'
import type { CloudReplicaReply } from '../cloud-ingest.js'
import { createHostServerManager, type HostServerHost, type HostServerManager, type HostServerSettings } from './manager.js'
import { buildHostAppPackage, type HostAppPackage } from './package.js'

let manager: HostServerManager | null = null
let unsubscribe: (() => void) | null = null
let packageCache: { at: number; pkg: HostAppPackage } | null = null

/** The settings of one host's server, defaults filled in. */
export function hostServerSettingsFrom(raw: unknown): HostServerSettings {
  const s = (raw && typeof raw === 'object' ? raw : {}) as {
    enabled?: unknown; node?: unknown; build_env?: unknown
    expose?: { enabled?: unknown; provider?: unknown; options?: unknown }
  }
  const buildEnv: Record<string, string> = {}
  for (const [k, v] of Object.entries(s.build_env && typeof s.build_env === 'object' ? s.build_env : {})) {
    if (typeof v === 'string') buildEnv[k] = v
  }
  const options: Record<string, string> = {}
  for (const [k, v] of Object.entries(s.expose?.options && typeof s.expose.options === 'object' ? s.expose.options : {})) {
    if (typeof v === 'string') options[k] = v
  }
  return {
    enabled: s.enabled === true,
    ...(typeof s.node === 'string' && s.node.trim() ? { node: s.node.trim() } : {}),
    buildEnv,
    expose: {
      enabled: s.expose?.enabled === true,
      provider: typeof s.expose?.provider === 'string' && s.expose.provider ? s.expose.provider : null,
      options,
    },
  }
}

export function getHostServerManager(): HostServerManager | null {
  if (CLOUD_MODE) return null
  if (manager) return manager
  manager = createHostServerManager({
    settingsOf: async (hostKey) => {
      const { getConfig } = await import('../config-manager.js')
      const host = (await getConfig()).hosts?.[hostKey]
      return host ? hostServerSettingsFrom(host.server) : null
    },
    label: async (hostKey) => {
      const { getConfig } = await import('../config-manager.js')
      return (await getConfig()).hosts?.[hostKey]?.label?.trim() || hostKey
    },
    walnutId: async () => (await import('../device-auth.js')).getInstanceId(),
    home: WALNUT_HOME,
    holdTunnelPort: async (holder) => {
      const { getExposeRuntime } = await import('../../web/expose-runtime.js')
      const runtime = getExposeRuntime()
      if (!runtime) throw new Error('this server has no tunnel port (it is still starting)')
      return runtime.holdTunnelPort(holder)
    },
    releaseTunnelPort: async (holder) => {
      const { getExposeRuntime } = await import('../../web/expose-runtime.js')
      await getExposeRuntime()?.releaseTunnelPort(holder)
    },
    buildPackage: async () => {
      // A deploy replaces the dist this process runs from only by restarting it.
      if (packageCache) return packageCache.pkg
      const pkg = await buildHostAppPackage()
      packageCache = { at: Date.now(), pkg }
      return pkg
    },
    stateFile: path.join(WALNUT_HOME, 'host-servers.json'),
    now: Date.now,
    registerTarget: (hostKey, post) => {
      let unregister: () => void = () => {}
      void import('../replication/replica-targets.js').then(({ registerReplicaTarget }) => {
        unregister = registerReplicaTarget({
          id: `host:${hostKey}`,
          kind: 'host',
          label: hostKey,
          available: async () => manager?.view(hostKey).phase === 'running',
          post: async (payload, opts): Promise<CloudReplicaReply> => {
            try {
              const res = await post(payload, opts)
              const json = await res.json().catch(() => null) as Record<string, unknown> | null
              if (res.ok && json) return { ok: true, reply: json }
              if (res.status === 404 || res.status === 405) return { ok: false, outcome: 'unsupported', status: res.status }
              return { ok: false, outcome: 'failed', status: res.status, error: typeof json?.error === 'string' ? json.error : undefined }
            } catch (err) {
              return { ok: false, outcome: 'failed', error: err instanceof Error ? err.message : String(err) }
            }
          },
        })
      })
      return () => unregister()
    },
  })
  void import('../event-bus.js').then(({ bus, EventNames }) => {
    const name = 'host-server-settings'
    bus.subscribe(name, () => { void reconcileAllHostServers() }, { global: true, interest: [EventNames.CONFIG_CHANGED] })
    unsubscribe = () => bus.unsubscribe(name)
  })
  return manager
}

/**
 * Every host config.yaml names, and every one the manager has seen: a host
 * turned off, or removed from config.yaml, is torn down if it ran.
 */
export async function reconcileAllHostServers(): Promise<void> {
  const m = getHostServerManager()
  if (!m) return
  const { getConfig } = await import('../config-manager.js')
  const hosts = new Set([...Object.keys((await getConfig()).hosts ?? {}), ...m.views().map((v) => v.hostKey)])
  await Promise.all([...hosts].map((key) => m.reconcile(key).catch((err) => {
    log.session.warn('host server: reconcile failed', { host: key, error: err instanceof Error ? err.message : String(err) })
  })))
}

export function hostServerConnected(host: HostServerHost): Promise<void> {
  return getHostServerManager()?.connected(host) ?? Promise.resolve()
}

export function hostServerDisconnected(hostKey: string): void {
  manager?.disconnected(hostKey)
}

export function _resetHostServerManagerForTesting(): void {
  manager?.stop()
  unsubscribe?.()
  manager = null
  unsubscribe = null
  packageCache = null
}
