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
import { IS_DEMO, IS_EPHEMERAL, WALNUT_HOME } from '../../constants.js'
import { EXTERNAL_CALLER_SID } from '../../providers/gateway-core.js'
import { createRefusalLog } from '../../providers/gateway-refusal-log.js'
import { log } from '../../logging/index.js'
import { bootPolicy } from '../boot-policy.js'
import { isSecretKey } from '../config-secret-shape.js'
import { semanticLaneDecision } from '../search/semantic-default.js'
import { createJobBundler } from './bundle.js'
import { createPluginJobsManager, jobsVerdict, LOCAL_HOST, type JobPlugin, type JobsHost, type PluginJobsManager } from './manager.js'
import { forwardJobRoute, JobRouteError, type JobRouteRequest, type JobRouteResponse } from './serve.js'

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
  offCache = d.reason === 'default' ? null : IS_DEMO ? 'plugin jobs do not run in the Demo'
    : 'plugin jobs do not run on a test server (WALNUT_PLUGIN_JOBS_IN_TEST=1 turns them on)'
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
    // Every host, whatever its link: the cloud box takes a job's code over its tunnel as a
    // host network machine does over its link (DaemonConnection.uploadFile).
    hosts: async () => {
      const { getConfig } = await import('../config-manager.js')
      const config = await getConfig()
      // Each machine once (a host joined twice is one choice): hosts/joined-twins.ts.
      const { pickableHosts } = await import('../hosts/joined-twins.js')
      return pickableHosts(config.hosts ?? {}, config.net)
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
          await (await import('../../providers/local-daemon-dial.js')).getLocalDaemonConnection()
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
  // The Demo runs no plugin job on a remote host: what runs there is only its own daemon (providers/demo-remote-host.ts).
  if (IS_DEMO && host.hostKey !== LOCAL_HOST) return Promise.resolve()
  return getPluginJobsManager()?.connected(host) ?? Promise.resolve()
}

/** A request to a plugin's routes that its job serves (serve.ts), from the dispatcher. */
export async function forwardPluginJobRoute(request: JobRouteRequest): Promise<JobRouteResponse> {
  const m = getPluginJobsManager()
  if (!m) {
    const off = pluginJobsOffReason()
    // No reason: a real install whose jobs are still starting (the boot), soon asked again.
    throw new JobRouteError(`this plugin's routes come from its job, and ${off ?? 'plugin jobs are still starting'}`, 503, off ? undefined : 2)
  }
  return forwardJobRoute({ home: WALNUT_HOME, serveTarget: (id) => m.serveTarget(id) }, request)
}

/**
 * The longest plugin or job id a relayed call names that this server keeps: gateway-answer.ts
 * relayedCallOf cuts a frame's ids at this length, and a host's daemon names no longer one
 * (plugin-jobs-core.ts CALLER_ID_MAX), so a cut id is never taken for another job.
 */
export const RELAYED_JOB_ID_MAX = 120

/** One warn line per host, job and reason every few minutes (a draining job calls on and on). */
const droppedJobs = createRefusalLog()

function noteDroppedJob(hostKey: string, job: { plugin: string; job: string }, why: string, data: Record<string, unknown> = {}): void {
  for (const s of droppedJobs.sweep()) {
    log.session.info('plugin jobs: relayed job names dropped, left out of the log', { host: s.host, job: s.callerSid, why: s.code, suppressed: s.suppressed })
  }
  const seen = droppedJobs.admit(hostKey, `${job.plugin}/${job.job}`.slice(0, 260), why)
  if (!seen.write) return
  log.session.warn('plugin jobs: a host named a job this computer does not give it; the call stays anonymous', {
    host: hostKey, plugin: job.plugin.slice(0, 130), job: job.job.slice(0, 130), why, ...data, ...(seen.suppressed > 0 ? { suppressed: seen.suppressed } : {}),
  })
}

let assignmentsForTest: ((plugin: string, job: string) => string[]) | null = null
/** Tests: which hosts this computer gives a job, in place of the manager's record (null: the manager's). */
export function _setJobAssignmentsForTesting(fn: ((plugin: string, job: string) => string[]) | null): void {
  assignmentsForTest = fn
}

/**
 * The plugin job a host's daemon names on a call it relays to this server (the `gateway-request`
 * frame's own `caller`, follower-gateway-core.ts GatewayCaller), kept only when it can be that
 * host's job: an anonymous call (`external`: a job's calls carry no session) naming a job this
 * server's manager gives that very host now (the set the host's daemon last took from it,
 * manager.ts assignedHosts, under any name of that daemon), else undefined and the call stays plain
 * `external`. A replica or a test server gives no host any job, so it keeps none. `vouched` is kept
 * exactly as the host sent it (true or absent): the daemon saw the call's process inside the run.
 * The daemon names the job from its own record of the run it started (plugin-jobs-core.ts
 * callerOfRun), never from the caller's words, which ride in the payload and are never read as it.
 * `hostKey` is the host whose link carried the frame (daemon-connection.ts), never one the frame names.
 */
export async function relayedJobOf(
  call: { callerSid: string; pluginJob?: { plugin: string; job: string; vouched?: boolean } }, hostKey: string,
): Promise<{ plugin: string; job: string; vouched?: true } | undefined> {
  const job = call.pluginJob
  if (!job || call.callerSid !== EXTERNAL_CALLER_SID || !hostKey) return undefined
  if (job.plugin.length > RELAYED_JOB_ID_MAX || job.job.length > RELAYED_JOB_ID_MAX) {
    noteDroppedJob(hostKey, job, 'id-too-long')
    return undefined
  }
  const kept = { plugin: job.plugin, job: job.job, ...(job.vouched === true ? { vouched: true as const } : {}) }
  const given = assignmentsForTest ? assignmentsForTest(job.plugin, job.job) : manager?.assignedHosts(job.plugin, job.job) ?? []
  if (given.includes(hostKey)) return kept
  const { oneHost } = await import('../hosts/session-host-origin.js')
  let late = false
  for (const h of given) if (await oneHost(hostKey, h, () => { late = true })) return kept
  noteDroppedJob(hostKey, job, late ? 'host-names-check-timed-out' : 'not-given-to-host', { givenTo: given.slice(0, 8) })
  return undefined
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
