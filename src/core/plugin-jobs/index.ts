/**
 * The one plugin-jobs manager of this (primary) server, wired to the real config,
 * plugin registry, bundler and daemon connections (manager.ts says what it does).
 * A replica (the companion, a host replica) runs none: only the Mac says what runs where. Nor does a test server (an
 * ephemeral one, a data home in a temp or task dir, a test runner): a job is a plugin's
 * real code with its real accounts, so a copied config would run it twice for real.
 * WALNUT_PLUGIN_JOBS_IN_TEST=1 turns them on there.
 */

import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { IS_EPHEMERAL, WALNUT_HOME } from '../../constants.js'
import { log } from '../../logging/index.js'
import { bootPolicy } from '../boot-policy.js'
import { isSecretKey } from '../config-secret-shape.js'
import { semanticLaneDecision } from '../search/semantic-default.js'
import { createJobBundler } from './bundle.js'
import { createPluginJobsManager, jobsVerdict, LOCAL_HOST, type JobPlugin, type JobsHost, type PluginJobsManager } from './manager.js'

let manager: PluginJobsManager | null = null
let unsubscribe: (() => void) | null = null

/** How long a burst of config and plugin changes waits before every daemon is told again. */
const RECONCILE_DEBOUNCE_MS = 750
/** A dial that found the plugin catalogue still loading tries again after this. */
const DIAL_RETRY_MS = 15_000
let dialing = false

async function jobPlugins(waitMs: number): Promise<JobPlugin[] | null> {
  const { registry } = await import('../integration-registry.js')
  await registry.waitForPlugins(waitMs)
  const loader = await import('../integration-loader.js')
  if (loader.isPluginCatalogueLoading(registry)) return null
  const { getConfig } = await import('../config-manager.js')
  const config = await getConfig()
  const records = new Map(loader.getPluginLifecycleRecords(registry).map((r) => [r.id, r]))
  return loader.getPluginJobSources(registry).map((s) => ({
    id: s.id,
    name: records.get(s.id)?.name ?? s.id,
    version: s.version,
    state: s.state,
    jobs: s.jobs,
    config: { ...((config.plugins?.[s.id] ?? {}) as Record<string, unknown>) },
    runOn: config.plugin_jobs?.[s.id]?.run_on?.trim() || LOCAL_HOST,
  }))
}

let offCache: string | null | undefined

/** Why this server runs no plugin jobs, or null when it does. */
export function pluginJobsOffReason(env: NodeJS.ProcessEnv = process.env): string | null {
  if (!bootPolicy('plugin-jobs')) return 'plugin jobs are shown and placed on the Mac'
  if (env.WALNUT_PLUGIN_JOBS_IN_TEST === '1') return null
  if (offCache !== undefined) return offCache
  // The semantic lane's "is this a real install" test, without its own opt-in flag.
  const d = semanticLaneDecision({ env: { ...env, WALNUT_SEARCH_V2_SEMANTIC: undefined }, isEphemeral: IS_EPHEMERAL, walnutHome: WALNUT_HOME })
  offCache = d.reason === 'default' ? null : 'plugin jobs do not run on a test server (WALNUT_PLUGIN_JOBS_IN_TEST=1 turns them on)'
  return offCache
}

/** The settings a plugin job depends on: a config change elsewhere sends no daemon anything. */
async function jobsConfigFingerprint(): Promise<string> {
  const { getConfig } = await import('../config-manager.js')
  const c = await getConfig()
  return JSON.stringify([c.plugins ?? {}, c.plugin_jobs ?? {}, c.hosts ?? {}])
}

export function getPluginJobsManager(): PluginJobsManager | null {
  if (pluginJobsOffReason()) return null
  if (manager) return manager
  const bundler = createJobBundler({
    cacheDir: path.join(WALNUT_HOME, 'cache', 'plugin-jobs'),
    bundle: async (dir, entry, outfile) => (await import('../integration-loader.js')).bundlePluginForJobs(dir, entry, outfile),
    now: () => Date.now(),
  })
  manager = createPluginJobsManager({
    home: WALNUT_HOME,
    walnutId: async () => (await import('../device-auth.js')).getInstanceId(),
    plugins: (waitMs = 60_000) => jobPlugins(waitMs),
    bundle: async (pluginId) => {
      const { registry } = await import('../integration-registry.js')
      const { getPluginJobSources } = await import('../integration-loader.js')
      const src = getPluginJobSources(registry).find((s) => s.id === pluginId)
      if (!src) return { error: 'the plugin is not on this computer' }
      return bundler.bundle(src)
    },
    writeLocal: async (file, data, sha256) => {
      const have = await fs.readFile(file).catch(() => null)
      if (have && crypto.createHash('sha256').update(have).digest('hex') === sha256) return
      await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
      const tmp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`
      await fs.writeFile(tmp, data, { mode: 0o600 })
      await fs.rename(tmp, file)
    },
    localSecretsFile: (pluginId) => path.join(WALNUT_HOME, 'secrets', 'plugins', `${pluginId}.json`),
    isSecretKey,
    hosts: async () => {
      const { getConfig } = await import('../config-manager.js')
      const { CLOUD_BOX_HOST_ALIAS } = await import('../hosts/cloud-box-host.js')
      const all = (await getConfig()).hosts ?? {}
      // The cloud box is reached through the companion, which takes no uploads: not a place for jobs.
      return Object.entries(all)
        .filter(([key]) => key !== CLOUD_BOX_HOST_ALIAS)
        .map(([key, h]) => ({ key, label: (h as { label?: string }).label?.trim() || key }))
    },
    log: (level, msg, data) => log.session[level](msg, data),
    now: () => Date.now(),
    setTimer: (fn, ms) => { const t = setTimeout(fn, ms); t.unref?.(); return t },
  })
  let timer: ReturnType<typeof setTimeout> | null = null
  let pluginMoved = false
  let seen: string | null = null
  void jobsConfigFingerprint().then((fp) => { seen ??= fp }, () => {})
  const settle = async () => {
    const moved = pluginMoved
    pluginMoved = false
    const fp = await jobsConfigFingerprint().catch(() => null)
    if (!moved && fp !== null && fp === seen) return
    if (fp !== null) seen = fp
    void dialJobHosts()
    await manager?.reconcileAll()
  }
  let configEvent = ''
  const later = (event: { name: string }) => {
    if (event.name !== configEvent) pluginMoved = true
    if (timer) return
    timer = setTimeout(() => {
      timer = null
      void settle().catch((err) => log.session.warn('plugin jobs: reconcile failed', { error: err instanceof Error ? err.message : String(err) }))
    }, RECONCILE_DEBOUNCE_MS)
    timer.unref?.()
  }
  const name = 'plugin-jobs'
  let stopped = false
  let offBus: (() => void) | null = null
  void import('../event-bus.js').then(({ bus, EventNames }) => {
    if (stopped) return
    configEvent = EventNames.CONFIG_CHANGED
    // A plugin turned on or off, moved, re-configured or reloaded: every daemon hears its set again.
    bus.subscribe(name, later, { global: true, interest: [EventNames.CONFIG_CHANGED, 'plugin:runtime-changed'] })
    offBus = () => bus.unsubscribe(name)
  }).catch((err) => log.session.warn('plugin jobs: could not watch the config', { error: err instanceof Error ? err.message : String(err) }))
  unsubscribe = () => { stopped = true; offBus?.(); if (timer) clearTimeout(timer); timer = null }
  return manager
}

/**
 * Every machine a plugin's jobs belong on (and any that still reports jobs that moved
 * away) gets a daemon link, this computer's included, so the jobs start at boot without
 * waiting for a session to open one. A link that drops redials itself (daemon-connection.ts);
 * each connect then sends that machine its set.
 */
async function dialJobHosts(): Promise<void> {
  const m = manager
  if (!m || dialing) return
  dialing = true
  try {
    const plugins = await jobPlugins(60_000)
    if (!plugins) {
      const t = setTimeout(() => { void dialJobHosts() }, DIAL_RETRY_MS)
      t.unref?.()
      return
    }
    const want = new Set<string>()
    for (const p of plugins) if (jobsVerdict(p.state) !== 'stop') want.add(p.runOn)
    for (const v of m.views()) if (v.jobs.length > 0) want.add(v.key)
    if (want.size === 0) return
    const dc = await import('../../providers/daemon-connection.js')
    for (const key of want) {
      try {
        if (key === LOCAL_HOST) {
          const { localDaemon } = await import('../../providers/local-daemon.js')
          if (!localDaemon.wsUrl) await localDaemon.ensureRunning()
          if (localDaemon.wsUrl) await dc.getDirectDaemonConnection(LOCAL_HOST, localDaemon.wsUrl)
          continue
        }
        if (dc.isDaemonConnected(key)) continue
        const { remoteHostsOff } = await import('../hosts/host-connect-action.js')
        if (remoteHostsOff()) continue
        const { getConfig } = await import('../config-manager.js')
        const def = (await getConfig()).hosts?.[key]
        if (!def || def.enabled === false) continue
        await (await import('../hosts/link.js')).link(key)
      } catch (err) {
        log.session.warn('plugin jobs: could not reach the machine they run on', { host: key, error: err instanceof Error ? err.message : String(err) })
      }
    }
  } finally {
    dialing = false
  }
}

/** At boot (primary only): the manager starts listening, and the machines with jobs are dialled. */
export function startPluginJobs(): void {
  if (!getPluginJobsManager()) return
  void dialJobHosts()
}

/** A daemon connected (after its leader.configure): it hears which plugin jobs run there. */
export function pluginJobsConnected(host: JobsHost): Promise<void> {
  return getPluginJobsManager()?.connected(host) ?? Promise.resolve()
}

export function pluginJobsDisconnected(hostKey: string): void {
  manager?.disconnected(hostKey)
}

export function _resetPluginJobsManagerForTesting(): void {
  unsubscribe?.()
  unsubscribe = null
  manager = null
  offCache = undefined
}
