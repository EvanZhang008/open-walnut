/**
 * The Mac's side of plugin jobs (primary only). A plugin's jobs run under the
 * daemon of ONE machine: this computer (`__local__`) unless `plugin_jobs.<id>.run_on`
 * names a host. The daemon there keeps them running (providers/plugin-jobs-core.ts)
 * while this computer sleeps, restarts or deploys; this side only says what runs where.
 *
 * On every connect of a daemon (after `leader.configure`), every config change and
 * every plugin load or reload, for each connected daemon with `plugin-jobs-v1`:
 *   1. which plugins' jobs belong there, bundled into one self-contained file each
 *      (bundle.ts) and put in the daemon's `bundles/` dir (written here for this
 *      computer, uploaded for a host, never twice: the sha names the file);
 *   2. `jobs.configure` with the WHOLE set for this Walnut, so a daemon that held a
 *      job that moved away (or whose plugin was turned off) stops it, even one that
 *      was unreachable when the move happened.
 * A plugin whose server half is in flux (activating, failed, still discovered) keeps
 * the jobs it has now, at their old code: its compute may well be fine, and a deploy
 * must never stop a 24/7 job. One whose bundle fails keeps its old one the same way.
 * While the plugin catalogue is still loading, nothing is sent at all. A host that is no
 * longer in Settings, Hosts gets the empty set (its jobs stop) whenever it is reachable.
 * At most 64 jobs go to one machine, and settings past 64 KB keep a plugin's jobs off it.
 * A pass that failed, a bundle that could not be sent and a job the daemon refused for
 * its code are tried again after 30 s, doubling to 5 min.
 *
 * A plugin with a job that serves its routes (`"serves": true`, serve.ts) goes only to a
 * daemon with `plugin-jobs-serve-v1`; an older one keeps what it runs until its upgrade.
 *
 * Secrets: the settings sent to a host leave out every secret-shaped field at any depth
 * (and the value of a `{ name, value }` pair named like a secret), and the password of
 * every URL is masked; a job reads its secrets on the machine it runs on (walnut.secrets).
 */

import path from 'node:path'
import { maskByKey } from '../config-secret-shape.js'
import { servingJobOf, type PluginJobDeclaration } from './manifest.js'
import { assertOutwardDoor, holdUntilDoorsOpen, isPermitRefusal, leaderPermitActive } from '../leader/switch/doors.js'
import type { PluginJobSpec, PluginJobStatus } from '../../providers/plugin-jobs-core.js'

export const PLUGIN_JOBS_CAPABILITY = 'plugin-jobs-v1'
/** `jobs.http`: a daemon that forwards a plugin's routes to its serving job (plugin-jobs-core.ts). */
export const PLUGIN_JOBS_SERVE_CAPABILITY = 'plugin-jobs-serve-v1'
export const LOCAL_HOST = '__local__'

/** What the manager needs of a daemon connection (DaemonConnection.hostServerHandle has it). */
export interface JobsHost {
  hostKey: string
  readonly connected: boolean
  hasCapability(cap: string): boolean
  send(cmd: string, params?: Record<string, unknown>, timeoutMs?: number): Promise<Record<string, unknown>>
  uploadFile(remotePath: string, data: Buffer, opts?: { sha256?: string }): Promise<unknown>
  /** Every alias that reaches this link's daemon and the one it goes by (DaemonConnection.daemonNames). */
  daemonNames?(): Promise<{ keeper: string; aliases: string[] }>
}

/** A plugin with jobs, as the manager sees it. */
export interface JobPlugin {
  id: string
  name: string
  version: string
  /** Its lifecycle state on this computer (plugin-manager.ts). */
  state: string
  jobs: Record<string, PluginJobDeclaration>
  /** Its settings, Walnut's own keys (enabled) left out. */
  config: Record<string, unknown>
  /** `__local__` or a host key. */
  runOn: string
}

export interface ManagerDeps {
  home: string
  walnutId(): Promise<string>
  /** Every plugin with jobs; null while the plugin catalogue is still loading (nothing is sent then). */
  plugins(waitMs?: number): Promise<JobPlugin[] | null>
  /** The plugin's job code as one file. */
  bundle(pluginId: string): Promise<{ sha256: string; data: Buffer } | { error: string }>
  /** Put a bundle at `file` on this computer (the local daemon's bundle dir), if it is not there yet. */
  writeLocal(file: string, data: Buffer, sha256: string): Promise<void>
  /** Where a plugin's secrets live on this computer (walnut.secrets of a job here). */
  localSecretsFile(pluginId: string): string
  /** Whether a settings key holds a secret (config-secret-shape.ts). */
  isSecretKey(key: string): boolean
  /** Host keys config.yaml names, with their labels. */
  hosts(): Promise<Array<{ key: string; label: string }>>
  log(level: 'info' | 'warn', msg: string, data?: Record<string, unknown>): void
  now(): number
  setTimer(fn: () => void, ms: number): unknown
}

/** Which state of a plugin runs its jobs, keeps the ones running, or stops them. */
/** Marks a secret for removal; no setting holds it (a lone surrogate never comes from YAML or JSON). */
const DROPPED = '\uD800walnut-secret'

function prune(value: unknown): unknown {
  if (Array.isArray(value)) return value.filter((v) => v !== DROPPED).map(prune)
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value)) {
      if (v === DROPPED) continue
      Object.defineProperty(out, k, { value: prune(v), enumerable: true, writable: true, configurable: true })
    }
    return out
  }
  return value
}

/** Settings without any secret: the shape rule of the Settings page (config-secret-shape.ts), at any depth. */
export function withoutSecrets(config: Record<string, unknown>, isSecretKey: (key: string) => boolean): Record<string, unknown> {
  return prune(maskByKey(config, () => DROPPED, (key) => (isSecretKey(key) ? 'secret' : null))) as Record<string, unknown>
}

export function jobsVerdict(state: string): 'run' | 'keep' | 'stop' {
  if (state === 'active') return 'run'
  if (state === 'discovered' || state === 'activating' || state === 'failed' || state === 'disposing') return 'keep'
  return 'stop'
}

interface HostRecord {
  handle: JobsHost
  phase: 'checking' | 'ready' | 'unsupported' | 'error'
  message?: string
  /** The daemon's last answer: its jobs for this Walnut, and when. */
  jobs: PluginJobStatus[]
  checkedAt?: number
  /** Per plugin: why its code could not be sent (its old code runs on, if any). */
  bundleErrors: Record<string, string>
  /** Per plugin: why its jobs are kept off this machine (a limit), as one sentence. */
  limitErrors: Record<string, string>
  running: boolean
  again: boolean
  waiters: Array<() => void>
  /** `plugin/job` of every spec the daemon last took from this computer: the jobs it gives that host. */
  assigned?: ReadonlySet<string>
  /** Another name of this host's daemon: the name its jobs are set up under (daemonKeeperAlias). */
  keeper?: string
  /** When this record was made (its host's first connect since this server started). */
  since: number
  /** Something this pass could not finish (a failure, an upload, a refused job): tried again after `retryMs`. */
  retryWanted: boolean
  retryMs: number
  retryArmed: boolean
}

export interface PluginJobsHostView { key: string; label: string; connected: boolean; supported: boolean }

export interface PluginJobsView {
  pluginId: string
  declared: Array<{ name: string; kind: 'every' | 'long-running'; every?: string; serves?: true }>
  runOn: string
  runOnLabel: string
  /** One sentence for the person: where the jobs run now, or why they do not. */
  placement: { state: 'running' | 'pending' | 'host-offline' | 'host-unsupported' | 'host-unknown' | 'plugin-off' | 'code-error'; message: string }
  jobs: Array<PluginJobStatus & { host: string }>
  /** Answered from the daemon just now (false: its last answer, `checkedAt`). */
  live: boolean
  checkedAt?: number
  /** Other machines still reporting this plugin's jobs (a move while that machine was away). */
  elsewhere: Array<{ host: string; jobs: number }>
  hosts: PluginJobsHostView[]
}

/** How long a host's job set may stay unknown before calls stop waiting for it (jobSetState). */
export const JOB_SET_PENDING_MS = 60_000

export function createPluginJobsManager(deps: ManagerDeps) {
  const hosts = new Map<string, HostRecord>()
  const createdAt = deps.now()
  const RETRY_LOADING_MS = 15_000
  const RETRY_FIRST_MS = 30_000
  const RETRY_MAX_MS = 5 * 60_000
  /** What one daemon takes (plugin-jobs-core.ts refuses a set past either). */
  const MAX_JOBS_PER_HOST = 64
  const MAX_CONFIG_CHARS = 64 * 1024
  /** A read for a person waits this long for plugins still loading, never the reconcile's minute. */
  const STATUS_WAIT_MS = 3_000

  function labelOf(list: Array<{ key: string; label: string }>, key: string): string {
    if (key === LOCAL_HOST) return 'This computer'
    return list.find((h) => h.key === key)?.label || key
  }

  /** The settings a job takes along: Walnut's keys out, and for a host no secret at any depth. */
  function configFor(p: JobPlugin, hostKey: string): Record<string, unknown> {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(p.config)) {
      if (k === 'enabled') continue
      out[k] = v
    }
    return hostKey === LOCAL_HOST ? out : withoutSecrets(out, deps.isSecretKey)
  }

  /** The specs this computer wants on `hostKey`, given what that daemon runs now. */
  async function desiredFor(hostKey: string, handle: JobsHost, plugins: JobPlugin[], current: PluginJobStatus[], bundles: string, rec: HostRecord, runsHere: ReadonlySet<string> = new Set([hostKey])): Promise<PluginJobSpec[]> {
    const out: PluginJobSpec[] = []
    const bundleErrors: Record<string, string> = {}
    const limitErrors: Record<string, string> = {}
    /** A plugin's jobs go as a whole or not at all, and never past what the daemon takes. */
    const fits = (p: JobPlugin, n: number): boolean => {
      if (JSON.stringify(configFor(p, hostKey)).length > MAX_CONFIG_CHARS) {
        limitErrors[p.id] = `its settings are larger than ${MAX_CONFIG_CHARS / 1024} KB, more than a job takes, so its jobs do not run until they are smaller`
        return false
      }
      if (out.length + n > MAX_JOBS_PER_HOST) {
        limitErrors[p.id] = `${hostKey === LOCAL_HOST ? 'this computer' : 'that machine'} already runs ${out.length} plugin jobs and takes at most ${MAX_JOBS_PER_HOST}, so these do not run there`
        return false
      }
      return true
    }
    const keepCurrent = (p: JobPlugin) => {
      const mine = current.filter((c) => c.plugin === p.id)
      if (mine.length === 0 || !fits(p, mine.length)) return
      for (const j of mine) {
        out.push({
          plugin: p.id, version: j.version, job: j.job, kind: j.kind, ...(j.everyMs ? { everyMs: j.everyMs } : {}),
          ...(j.serves ? { serves: true as const } : {}),
          bundle: { sha256: j.bundleSha256, file: path.posix.join(bundles, `${j.bundleSha256}.mjs`) },
          config: configFor(p, hostKey), host: hostKey,
          ...(hostKey === LOCAL_HOST ? { secretsFile: deps.localSecretsFile(p.id) } : {}),
        })
      }
    }
    for (const p of [...plugins].sort((a, b) => a.id.localeCompare(b.id))) {
      if (!p.runOn || !runsHere.has(p.runOn)) continue
      const verdict = jobsVerdict(p.state)
      if (verdict === 'stop') continue
      if (verdict === 'keep') { keepCurrent(p); continue }
      if (servingJobOf(p.jobs) && !handle.hasCapability(PLUGIN_JOBS_SERVE_CAPABILITY)) {
        keepCurrent(p)
        limitErrors[p.id] = `the daemon on ${hostKey === LOCAL_HOST ? 'this computer' : 'that machine'} is older than jobs that serve routes, so this version's jobs start once it is upgraded (on its next connect)`
        continue
      }
      if (!fits(p, Object.keys(p.jobs).length)) continue
      const b = await deps.bundle(p.id)
      if ('error' in b) {
        bundleErrors[p.id] = b.error
        keepCurrent(p)
        continue
      }
      const file = path.posix.join(bundles, `${b.sha256}.mjs`)
      try {
        if (hostKey === LOCAL_HOST) await deps.writeLocal(file, b.data, b.sha256)
        else await handle.uploadFile(file, b.data, { sha256: b.sha256 })
      } catch (err) {
        bundleErrors[p.id] = `its code could not be sent: ${err instanceof Error ? err.message : String(err)}`
        rec.retryWanted = true
        keepCurrent(p)
        continue
      }
      for (const [name, decl] of Object.entries(p.jobs)) {
        out.push({
          plugin: p.id, version: p.version, job: name, kind: decl.kind,
          ...(decl.kind === 'every' ? { everyMs: decl.everyMs } : {}),
          ...(decl.kind === 'long-running' && decl.serves ? { serves: true as const } : {}),
          bundle: { sha256: b.sha256, file }, config: configFor(p, hostKey), host: hostKey,
          ...(hostKey === LOCAL_HOST ? { secretsFile: deps.localSecretsFile(p.id) } : {}),
        })
      }
    }
    rec.bundleErrors = bundleErrors
    rec.limitErrors = limitErrors
    return out
  }

  async function reconcileOnce(hostKey: string): Promise<void> {
    const rec = hosts.get(hostKey)
    if (!rec || !rec.handle.connected) return
    // The outward door, before any upload: a refusal throws, and reconcile waits for the
    // permission (no error phase, no back-off).
    if (leaderPermitActive()) assertOutwardDoor('plugin-jobs', hostKey)
    // A reconnect while this pass runs swaps the handle and asks for one more pass, whose
    // snapshot is newer: this one sends nothing then (it would land after and win).
    const handle = rec.handle
    // The daemon holds ONE job set per Walnut: only the name it goes by sends it, or another name's
    // empty set stops the jobs of a plugin that runs there (daemonKeeperAlias).
    const names = handle.daemonNames ? await handle.daemonNames().catch(() => null) : null
    if (names && names.keeper !== hostKey) {
      rec.assigned = undefined
      rec.keeper = names.keeper
      rec.phase = 'unsupported'
      rec.message = 'another name of a host whose jobs are set up under its own name'
      return
    }
    rec.keeper = undefined
    if (!handle.hasCapability(PLUGIN_JOBS_CAPABILITY)) {
      rec.assigned = undefined
      rec.phase = 'unsupported'
      rec.message = 'its daemon is older than plugin jobs; it is upgraded on its next connect'
      return
    }
    const plugins = await deps.plugins()
    if (!plugins) {
      // A deploy's boot: the catalogue is not complete yet, and a partial set would stop jobs.
      deps.setTimer(() => { void reconcile(hostKey) }, RETRY_LOADING_MS)
      return
    }
    const st = await handle.send('jobs.status', { home: deps.home }, 15_000)
    if (st.ok !== true) throw new Error(`jobs.status refused: ${String(st.error ?? 'no answer')}`)
    const bundles = typeof st.bundles === 'string' ? st.bundles : ''
    if (!bundles.startsWith('/')) throw new Error('jobs.status named no bundle dir')
    const current = Array.isArray(st.jobs) ? st.jobs as PluginJobStatus[] : []
    // A host taken out of Settings, Hosts runs nothing for this Walnut any more.
    // Nor a revoked host: its jobs are taken off it, and no plugin's settings go there (session-channel/revoked-reach.ts `cmd:jobs.configure`).
    const revoked = (await import('../session-channel/revoked-hosts.js')).hostRevokedNow(hostKey)
    const known = !revoked && (hostKey === LOCAL_HOST || (await deps.hosts()).some((h) => h.key === hostKey))
    // A plugin set to run on another alias of this daemon runs here too: it is the same machine.
    const runsHere = new Set(names?.aliases ?? [hostKey])
    const jobs = await desiredFor(hostKey, handle, known ? plugins : [], current, bundles, rec, runsHere)
    const walnutId = await deps.walnutId()
    if (rec.handle !== handle) return
    const r = await handle.send('jobs.configure', { home: deps.home, spec: { v: 1, home: deps.home, walnutId, jobs } }, 30_000)
    if (r.ok !== true) throw new Error(`jobs.configure refused: ${String(r.error ?? 'no answer')}`)
    rec.jobs = Array.isArray(r.jobs) ? r.jobs as PluginJobStatus[] : []
    rec.assigned = new Set(jobs.map((j) => `${j.plugin}/${j.job}`))
    rec.checkedAt = deps.now()
    rec.phase = 'ready'
    rec.message = undefined
    // A job refused for its code (gone from that machine, or not the version sent): the next
    // pass uploads it again.
    if (rec.jobs.some((j) => j.state === 'refused')) rec.retryWanted = true
    if (jobs.length > 0 || current.length > 0) {
      deps.log('info', 'plugin jobs: configured', { host: hostKey, jobs: jobs.map((j) => `${j.plugin}/${j.job}`) })
    }
  }

  /** One reconcile per host at a time; a request while one runs makes it run once more. */
  function reconcile(hostKey: string): Promise<void> {
    const rec = hosts.get(hostKey)
    if (!rec) return Promise.resolve()
    const done = new Promise<void>((resolve) => rec.waiters.push(resolve))
    if (rec.running) { rec.again = true; return done }
    rec.running = true
    void (async () => {
      do {
        rec.again = false
        rec.retryWanted = false
        const waiters = rec.waiters.splice(0)
        try {
          await reconcileOnce(hostKey)
        } catch (err) {
          if (isPermitRefusal(err)) {
            // Not a failure: the pass runs again the moment this server gets the permission.
            rec.phase = 'checking'
            rec.message = 'waits for the write permission: this server is not the leader now'
            holdUntilDoorsOpen(
              `plugin-jobs:${hostKey}`,
              () => { if (hosts.get(hostKey) === rec && rec.handle.connected) void reconcile(hostKey) },
              () => deps.log('info', 'plugin jobs: wait for the write permission', { host: hostKey }),
            )
          } else {
            rec.phase = 'error'
            rec.message = err instanceof Error ? err.message : String(err)
            rec.retryWanted = true
            deps.log('warn', 'plugin jobs: could not configure', { host: hostKey, error: rec.message })
          }
        }
        for (const w of waiters) w()
      } while (rec.again && hosts.get(hostKey) === rec)
      rec.running = false
      for (const w of rec.waiters.splice(0)) w()
      retryLater(hostKey, rec)
    })()
    return done
  }

  /** A pass left something undone: once more after 30 s, doubling to 5 min; a clean pass starts the count again. */
  function retryLater(hostKey: string, rec: HostRecord): void {
    if (!rec.retryWanted) { rec.retryMs = 0; return }
    if (rec.retryArmed || !rec.handle.connected) return
    rec.retryMs = rec.retryMs ? Math.min(RETRY_MAX_MS, rec.retryMs * 2) : RETRY_FIRST_MS
    rec.retryArmed = true
    deps.setTimer(() => {
      rec.retryArmed = false
      if (hosts.get(hostKey) === rec && rec.handle.connected) void reconcile(hostKey)
    }, rec.retryMs)
  }

  function connected(handle: JobsHost): Promise<void> {
    const prev = hosts.get(handle.hostKey)
    if (prev) {
      // The same record, so a pass still running on the old connection is followed by one
      // on this one, never run beside it.
      prev.handle = handle
      prev.phase = 'checking'
      prev.message = undefined
    } else {
      hosts.set(handle.hostKey, { handle, since: deps.now(), phase: 'checking', jobs: [], bundleErrors: {}, limitErrors: {}, running: false, again: false, waiters: [], retryWanted: false, retryMs: 0, retryArmed: false })
    }
    return reconcile(handle.hostKey)
  }

  function disconnected(hostKey: string): void {
    const rec = hosts.get(hostKey)
    if (rec) { rec.phase = 'checking'; rec.message = 'not connected' }
  }

  async function reconcileAll(): Promise<void> {
    await Promise.all([...hosts.keys()].map((k) => reconcile(k)))
  }

  function hostViews(list: Array<{ key: string; label: string }>): PluginJobsHostView[] {
    const local = hosts.get(LOCAL_HOST)
    const out: PluginJobsHostView[] = [{
      key: LOCAL_HOST, label: 'This computer',
      connected: local?.handle.connected === true, supported: local ? local.handle.hasCapability(PLUGIN_JOBS_CAPABILITY) : true,
    }]
    for (const h of list) {
      if (h.key === LOCAL_HOST) continue
      const rec = hosts.get(h.key)
      out.push({ key: h.key, label: h.label || h.key, connected: rec?.handle.connected === true, supported: rec ? rec.handle.hasCapability(PLUGIN_JOBS_CAPABILITY) : true })
    }
    return out
  }

  /** Where one plugin's jobs run and how each is, from the daemon there (5 s deadline, else its last answer). */
  async function status(pluginId: string): Promise<PluginJobsView | null> {
    const plugins = await deps.plugins(STATUS_WAIT_MS)
    if (!plugins) throw Object.assign(new Error('the plugins are still loading'), { status: 503 })
    const list = await deps.hosts()
    const p = plugins.find((x) => x.id === pluginId)
    if (!p) return null
    const declared = Object.entries(p.jobs).map(([name, d]) => ({
      name, kind: d.kind, ...(d.kind === 'every' ? { every: d.every } : {}), ...(d.kind === 'long-running' && d.serves ? { serves: true as const } : {}),
    }))
    const target = p.runOn
    const rec = hosts.get(target)
    let live = false
    if (rec?.handle.connected && rec.handle.hasCapability(PLUGIN_JOBS_CAPABILITY)) {
      try {
        const st = await rec.handle.send('jobs.status', { home: deps.home }, 5_000)
        if (st.ok === true && Array.isArray(st.jobs)) {
          rec.jobs = st.jobs as PluginJobStatus[]
          rec.checkedAt = deps.now()
          live = true
        }
      } catch { /* its last answer below */ }
    }
    const jobs = (rec?.jobs ?? []).filter((j) => j.plugin === pluginId).map((j) => ({ ...j, host: target }))
    const elsewhere: PluginJobsView['elsewhere'] = []
    // Another name of the daemon the jobs run on is that same machine, not elsewhere.
    const sameMachine = new Set(rec?.handle.daemonNames ? (await rec.handle.daemonNames().catch(() => null))?.aliases ?? [] : [])
    for (const [key, other] of hosts) {
      if (key === target || sameMachine.has(key)) continue
      const n = other.jobs.filter((j) => j.plugin === pluginId).length
      if (n > 0) elsewhere.push({ host: key, jobs: n })
    }
    const runOnLabel = labelOf(list, target)
    // In a sentence this computer is not a name: "running on this computer".
    const where = target === LOCAL_HOST ? 'this computer' : runOnLabel
    const known = target === LOCAL_HOST || list.some((h) => h.key === target)
    let placement: PluginJobsView['placement']
    if (!known) {
      const still = rec && rec.jobs.length > 0 && !rec.handle.connected
      placement = { state: 'host-unknown', message: `${target} is not in Settings, Hosts any more: the jobs run nowhere else until you pick a machine${still ? ', and Walnut has not reached it since, so they may still run there' : ''}` }
    }
    else if (jobsVerdict(p.state) === 'stop') placement = { state: 'plugin-off', message: `the plugin is ${p.state === 'disabled' ? 'turned off' : p.state.replace(/-/g, ' ')}, so its jobs do not run` }
    else if (!rec || !rec.handle.connected) {
      const who = target === LOCAL_HOST ? 'the daemon of this computer' : runOnLabel
      placement = { state: 'host-offline', message: jobs.length > 0 ? `${who} is not connected now; it keeps the jobs running and this is its last report` : `${who} is not connected; the jobs start when it connects` }
    } else if (!rec.handle.hasCapability(PLUGIN_JOBS_CAPABILITY)) placement = { state: 'host-unsupported', message: `the daemon on ${where} is older than plugin jobs; it is upgraded on its next connect` }
    else if (rec.limitErrors[pluginId]) placement = { state: 'code-error', message: rec.limitErrors[pluginId] }
    else if (rec.bundleErrors[pluginId]) placement = { state: 'code-error', message: `its newest code could not be prepared (${rec.bundleErrors[pluginId]})${jobs.length > 0 ? '; the version before keeps running' : ''}` }
    else if (rec.phase === 'error') placement = { state: 'pending', message: `the last setup on ${where} failed: ${rec.message ?? 'unknown error'}` }
    else if (jobs.length === 0) placement = { state: 'pending', message: `starting on ${where}` }
    else placement = { state: 'running', message: `running on ${where}` }
    return { pluginId, declared, runOn: target, runOnLabel, placement, jobs, live, ...(rec?.checkedAt ? { checkedAt: rec.checkedAt } : {}), elsewhere, hosts: hostViews(list) }
  }

  /** The newest lines of one job's log, from the machine it runs on (or `host`). */
  async function logs(pluginId: string, job: string, lines: number, host?: string): Promise<{ host: string; lines: string[]; bytes: number }> {
    const plugins = await deps.plugins(STATUS_WAIT_MS)
    // Without the catalogue the machine is unknown: never ask the wrong one.
    if (!plugins && !host) throw Object.assign(new Error('the plugins are still loading'), { status: 503 })
    const p = plugins?.find((x) => x.id === pluginId)
    const target = host || p?.runOn || LOCAL_HOST
    const rec = hosts.get(target)
    if (!rec?.handle.connected) throw Object.assign(new Error(`${target === LOCAL_HOST ? 'this computer\'s daemon' : target} is not connected`), { status: 503 })
    if (!rec.handle.hasCapability(PLUGIN_JOBS_CAPABILITY)) throw Object.assign(new Error('that daemon is older than plugin jobs'), { status: 409 })
    const r = await rec.handle.send('jobs.logs', { home: deps.home, plugin: pluginId, job, lines }, 10_000)
    if (r.ok !== true) throw Object.assign(new Error(String(r.error ?? 'no answer')), { status: 404 })
    return { host: target, lines: Array.isArray(r.lines) ? r.lines.map(String) : [], bytes: Number(r.bytes) || 0 }
  }

  /** The daemon to ask for a plugin's routes its job serves (serve.ts), or why there is none now (and when to ask again). */
  async function serveTarget(pluginId: string): Promise<{ handle: JobsHost; where: string } | { error: string; retryAfterS?: number }> {
    const plugins = await deps.plugins(0)
    if (!plugins) return { error: 'the plugins are still loading', retryAfterS: 2 }
    const p = plugins.find((x) => x.id === pluginId)
    if (!p || !servingJobOf(p.jobs)) return { error: `no job of ${pluginId} serves routes` }
    if (jobsVerdict(p.state) === 'stop') return { error: `the plugin is ${p.state === 'disabled' ? 'turned off' : p.state.replace(/-/g, ' ')}, so its job serves no routes` }
    const where = p.runOn === LOCAL_HOST ? 'this computer' : labelOf(await deps.hosts(), p.runOn)
    const rec = hosts.get(p.runOn)
    if (!rec?.handle.connected) return { error: `${p.runOn === LOCAL_HOST ? 'the daemon of this computer' : where} is not connected, so the job's routes cannot be reached`, retryAfterS: 5 }
    if (!rec.handle.hasCapability(PLUGIN_JOBS_SERVE_CAPABILITY)) return { error: `the daemon on ${where} is older than jobs that serve routes; it is upgraded on its next connect` }
    return { handle: rec.handle, where }
  }

  return {
    connected,
    disconnected,
    reconcile,
    reconcileAll,
    status,
    logs,
    serveTarget,
    /** The hosts this computer gives job `job` of `plugin` now (the set each daemon last took; a turned-off plugin's is none). */
    assignedHosts: (plugin: string, job: string): string[] =>
      [...hosts.entries()].filter(([, r]) => r.assigned?.has(`${plugin}/${job}`)).map(([key]) => key),
    /**
     * Whether this computer knows the jobs it gives `hostKey` now. `known`: a pass there finished
     * (its set taken), or that host runs none for a known reason (an older daemon, a failed pass).
     * `pending`: not yet, and soon: its first pass runs or waits for the plugin catalogue (right
     * after this server starts: about 14 s on 2026-11-24, in which a host's job calls read as
     * anonymous), or the host has not connected yet in this server's first minute. Past
     * JOB_SET_PENDING_MS of either it reads `known` again (with the set it has: none), so a host
     * whose pass never ends is not waited for on every call. For another name of a daemon, the name
     * its jobs are set up under decides.
     */
    jobSetState: (hostKey: string): 'known' | 'pending' => {
      const now = deps.now()
      const stateOf = (key: string): 'known' | 'pending' => {
        const r = hosts.get(key)
        if (!r) return now - createdAt < JOB_SET_PENDING_MS ? 'pending' : 'known'
        if (r.assigned !== undefined || r.phase !== 'checking') return 'known'
        return now - r.since < JOB_SET_PENDING_MS ? 'pending' : 'known'
      }
      const own = stateOf(hostKey)
      const keeper = hosts.get(hostKey)?.keeper
      return own === 'known' && keeper ? stateOf(keeper) : own
    },
    /** Per host: its phase and its jobs (tests, diagnostics). */
    views: () => [...hosts.entries()].map(([key, r]) => ({ key, phase: r.phase, message: r.message, jobs: r.jobs, bundleErrors: r.bundleErrors })),
  }
}

export type PluginJobsManager = ReturnType<typeof createPluginJobsManager>
