/**
 * The Mac's side of plugin jobs (src/core/plugin-jobs/manager.ts), driven with fake
 * deps and fake daemons. Every assertion is on what a daemon received (or did not):
 * which bundle went where, which set each `jobs.configure` carried, and what the
 * status and log reads asked.
 */
import { describe, expect, it, vi } from 'vitest'
import {
  createPluginJobsManager,
  jobsVerdict,
  withoutSecrets,
  LOCAL_HOST,
  PLUGIN_JOBS_CAPABILITY,
  type JobPlugin,
  type JobsHost,
  type ManagerDeps,
} from '../../src/core/plugin-jobs/manager.js'
import type { PluginJobSpec, PluginJobsSpec, PluginJobStatus } from '../../src/providers/plugin-jobs-core.js'
import { isSecretKey } from '../../src/core/config-secret-shape.js'

const HOME = '/home/tester/.open-walnut'
const WALNUT_ID = 'walnut-test-1'
const BUNDLES = '/d/plugin-jobs/bundles'
const SHA_NEW = 'a1'.repeat(32)
const SHA_OLD = 'b2'.repeat(32)
const SHA_MIRROR = 'c3'.repeat(32)
const BUNDLE_DATA = Buffer.from('export const jobs = { poll() {}, worker() {} }\n')
const MIRROR_DATA = Buffer.from('export const jobs = { sync() {} }\n')
const SECRETS_FILE = `${HOME}/secrets/plugins/acme-jobs.json`
const bundleFile = (sha: string) => `${BUNDLES}/${sha}.mjs`

/** The settings a job here takes: all of them but Walnut's own `enabled`. */
const LOCAL_CONFIG = {
  endpoint: 'https://queue.example.test',
  batchSize: 25,
  apiToken: 'tok-1',
  clientSecret: 'cs-1',
  password: 'pw-1',
  signingKey: 'sk-1',
}
/** The settings a job on a host takes: no secret-shaped key. */
const HOST_CONFIG = { endpoint: 'https://queue.example.test', batchSize: 25 }

function acmePlugin(over: Partial<JobPlugin> = {}): JobPlugin {
  return {
    id: 'acme-jobs',
    name: 'Acme Jobs',
    version: '1.2.0',
    state: 'active',
    jobs: { poll: { kind: 'every', everyMs: 300_000, every: '5m' }, worker: { kind: 'long-running' } },
    config: { enabled: true, ...LOCAL_CONFIG },
    runOn: LOCAL_HOST,
    ...over,
  }
}

/** The two specs of acme-jobs that `host` should be told to run, at `sha`. */
function acmeSpecs(host: string, sha: string, version = '1.2.0'): PluginJobSpec[] {
  const local = host === LOCAL_HOST
  const common = {
    plugin: 'acme-jobs',
    version,
    bundle: { sha256: sha, file: bundleFile(sha) },
    config: local ? LOCAL_CONFIG : HOST_CONFIG,
    host,
    ...(local ? { secretsFile: SECRETS_FILE } : {}),
  }
  return [
    { ...common, job: 'poll', kind: 'every', everyMs: 300_000 },
    { ...common, job: 'worker', kind: 'long-running' },
  ]
}

/** What a daemon reports for acme-jobs when it already runs it at `sha`. */
function acmeRows(sha: string, version: string): PluginJobStatus[] {
  const base = { plugin: 'acme-jobs', version, state: 'running' as const, since: 0, failures: 0, bundleSha256: sha }
  return [
    { ...base, job: 'poll', kind: 'every', everyMs: 300_000, restarts: 0, runs: 4 },
    { ...base, job: 'worker', kind: 'long-running', restarts: 1, runs: 0 },
  ]
}

function rowOf(j: PluginJobSpec): PluginJobStatus {
  return {
    plugin: j.plugin, job: j.job, kind: j.kind, ...(j.everyMs ? { everyMs: j.everyMs } : {}),
    version: j.version, state: 'running', since: 0, restarts: 0, runs: 0, failures: 0, bundleSha256: j.bundle.sha256,
  }
}

const tick = () => new Promise<void>((resolve) => setImmediate(resolve))
async function ticks(n: number): Promise<void> {
  for (let i = 0; i < n; i++) await tick()
}

interface Sent { cmd: string; params: Record<string, unknown>; timeoutMs?: number }

/**
 * One machine's daemon: a jobs set per Walnut (keyed by `home`), as the real one
 * keeps. `link` is a connection to it; `handle()` makes another, the way
 * DaemonConnection.hostServerHandle() hands out a new object on every connect.
 */
function fakeDaemon(hostKey: string, opts: {
  caps?: string[]
  /** Event-loop turns every command takes before it answers (makes an overlap visible). */
  latencyTicks?: number
  uploadError?: Error
  /** Commands the daemon answers with `{ok:false, error}`. */
  refuse?: Record<string, string>
} = {}) {
  let up = true
  const caps = new Set(opts.caps ?? [PLUGIN_JOBS_CAPABILITY])
  const jobsByHome = new Map<string, PluginJobStatus[]>()
  const sent: Sent[] = []
  const uploads: Array<{ path: string; data: Buffer; opts?: { sha256?: string } }> = []
  let inFlight = 0
  let maxInFlight = 0

  function answer(cmd: string, params: Record<string, unknown>): Record<string, unknown> {
    const refusal = opts.refuse?.[cmd]
    if (refusal) return { ok: false, error: refusal }
    const home = String(params.home)
    switch (cmd) {
      case 'jobs.status':
        return { ok: true, dir: '/d/plugin-jobs', bundles: BUNDLES, jobs: (jobsByHome.get(home) ?? []).map((r) => ({ ...r })) }
      case 'jobs.configure': {
        const rows = (params.spec as PluginJobsSpec).jobs.map(rowOf)
        jobsByHome.set(home, rows)
        return { ok: true, jobs: rows.map((r) => ({ ...r })) }
      }
      case 'jobs.logs':
        if (params.job === 'missing') return { ok: false, error: 'jobs.logs: no such job here' }
        return { ok: true, lines: [`${hostKey} ${String(params.plugin)}/${String(params.job)} started`, 'ran in 120 ms'], bytes: 4096 }
      default:
        return { ok: false, error: `unknown command ${cmd}` }
    }
  }

  function handle(): JobsHost {
    return {
      hostKey,
      get connected() { return up },
      hasCapability: (cap) => caps.has(cap),
      send: async (cmd, params = {}, timeoutMs) => {
        if (!up) throw new Error(`not connected to ${hostKey}`)
        sent.push({ cmd, params, timeoutMs })
        inFlight++
        maxInFlight = Math.max(maxInFlight, inFlight)
        try {
          await ticks(opts.latencyTicks ?? 0)
          return answer(cmd, params)
        } finally {
          inFlight--
        }
      },
      uploadFile: async (remotePath, data, o) => {
        uploads.push({ path: remotePath, data, opts: o })
        if (opts.uploadError) throw opts.uploadError
        return { ok: true }
      },
    }
  }

  return {
    link: handle(),
    handle,
    sent,
    uploads,
    setLink(v: boolean) { up = v },
    seed(rows: PluginJobStatus[], home = HOME) { jobsByHome.set(home, rows) },
    running(home = HOME): PluginJobStatus[] { return jobsByHome.get(home) ?? [] },
    cmds(): string[] { return sent.map((s) => s.cmd) },
    configures(): PluginJobsSpec[] { return sent.filter((s) => s.cmd === 'jobs.configure').map((s) => s.params.spec as PluginJobsSpec) },
    lastSpec(): PluginJobsSpec {
      const all = sent.filter((s) => s.cmd === 'jobs.configure')
      if (all.length === 0) throw new Error(`${hostKey} was never configured`)
      return all[all.length - 1]!.params.spec as PluginJobsSpec
    },
    get maxInFlight() { return maxInFlight },
    resetCounters() { sent.length = 0; maxInFlight = 0 },
  }
}

/** Fake deps: the plugin list, the bundles and the host list are the test's to change. */
function harness(opts: { plugins?: JobPlugin[] | null; hosts?: Array<{ key: string; label: string }> } = {}) {
  const state = {
    plugins: opts.plugins === undefined ? [acmePlugin()] : opts.plugins,
    hosts: opts.hosts ?? [{ key: 'devbox', label: 'Dev box' }],
    clock: 1_000,
  }
  const timers: Array<{ fn: () => void; ms: number }> = []
  const bundles = new Map<string, { sha256: string; data: Buffer } | { error: string }>([
    ['acme-jobs', { sha256: SHA_NEW, data: BUNDLE_DATA }],
    ['acme-mirror', { sha256: SHA_MIRROR, data: MIRROR_DATA }],
  ])
  const deps = {
    home: HOME,
    walnutId: vi.fn(async () => WALNUT_ID),
    // A fresh copy each call, as the real one builds from the registry and config.
    plugins: vi.fn(async (_waitMs?: number) => (state.plugins ? structuredClone(state.plugins) : null)),
    bundle: vi.fn(async (pluginId: string): Promise<{ sha256: string; data: Buffer } | { error: string }> =>
      bundles.get(pluginId) ?? { error: 'the plugin is not on this computer' }),
    writeLocal: vi.fn(async (_file: string, _data: Buffer, _sha256: string) => {}),
    localSecretsFile: (pluginId: string) => `${HOME}/secrets/plugins/${pluginId}.json`,
    isSecretKey: (key: string) => /token|secret|password|key$/i.test(key),
    hosts: vi.fn(async () => state.hosts),
    log: vi.fn(),
    now: () => state.clock,
    setTimer: vi.fn((fn: () => void, ms: number) => { timers.push({ fn, ms }); return timers.length }),
  } satisfies ManagerDeps
  return {
    deps,
    state,
    timers,
    bundles,
    /** Change acme-jobs the way a settings edit or a plugin reload would. */
    update(change: Partial<JobPlugin>) {
      const list = state.plugins!
      const i = list.findIndex((p) => p.id === 'acme-jobs')
      list[i] = { ...list[i]!, ...change }
    },
    manager: () => createPluginJobsManager(deps),
  }
}

describe('jobsVerdict', () => {
  it.each([
    ['active', 'run'],
    ['discovered', 'keep'],
    ['activating', 'keep'],
    ['failed', 'keep'],
    ['disposing', 'keep'],
    ['disabled', 'stop'],
    ['needs-config', 'stop'],
    ['needs-dependency', 'stop'],
    ['unsupported', 'stop'],
    ['quarantined', 'stop'],
  ])('a plugin %s: %s', (state, verdict) => {
    expect(jobsVerdict(state)).toBe(verdict)
  })
})

describe('plugin jobs manager: what each daemon is told', () => {
  it('this computer: the bundle is written locally, never uploaded, and the jobs get every setting and the local secrets file', async () => {
    const h = harness()
    const local = fakeDaemon(LOCAL_HOST)
    const mgr = h.manager()
    await mgr.connected(local.link)

    expect(local.cmds()).toEqual(['jobs.status', 'jobs.configure'])
    expect(local.sent.every((s) => s.params.home === HOME)).toBe(true)
    expect(h.deps.writeLocal).toHaveBeenCalledTimes(1)
    expect(h.deps.writeLocal).toHaveBeenCalledWith(bundleFile(SHA_NEW), BUNDLE_DATA, SHA_NEW)
    expect(local.uploads).toEqual([])

    const spec = local.lastSpec()
    expect(spec).toMatchObject({ v: 1, home: HOME, walnutId: WALNUT_ID })
    expect(spec.jobs).toStrictEqual(acmeSpecs(LOCAL_HOST, SHA_NEW))
    expect(local.running().map((r) => r.job)).toEqual(['poll', 'worker'])
    expect(mgr.views()).toEqual([{ key: LOCAL_HOST, phase: 'ready', message: undefined, jobs: local.running(), bundleErrors: {} }])
  })

  it('a host: the bundle is uploaded by its sha, and the settings leave out secrets and Walnut\'s own keys', async () => {
    const h = harness({ plugins: [acmePlugin({ runOn: 'devbox' })] })
    const devbox = fakeDaemon('devbox')
    const mgr = h.manager()
    await mgr.connected(devbox.link)

    expect(devbox.uploads).toEqual([{ path: bundleFile(SHA_NEW), data: BUNDLE_DATA, opts: { sha256: SHA_NEW } }])
    expect(h.deps.writeLocal).not.toHaveBeenCalled()
    const jobs = devbox.lastSpec().jobs
    expect(jobs).toStrictEqual(acmeSpecs('devbox', SHA_NEW))
    for (const j of jobs) {
      expect(j).not.toHaveProperty('secretsFile')
      expect(Object.keys(j.config).sort()).toEqual(['batchSize', 'endpoint'])
    }
    expect(JSON.stringify(devbox.sent)).not.toMatch(/tok-1|cs-1|pw-1|sk-1/)
  })

  it('each daemon hears only the jobs of the plugins that run on it', async () => {
    const mirror: JobPlugin = {
      id: 'acme-mirror', name: 'Acme Mirror', version: '0.3.0', state: 'active',
      jobs: { sync: { kind: 'every', everyMs: 3_600_000, every: '1h' } }, config: { enabled: true, target: 'west' }, runOn: 'devbox',
    }
    const h = harness({ plugins: [acmePlugin(), mirror] })
    const local = fakeDaemon(LOCAL_HOST)
    const devbox = fakeDaemon('devbox')
    const mgr = h.manager()
    await mgr.connected(local.link)
    await mgr.connected(devbox.link)

    expect(local.lastSpec().jobs.map((j) => `${j.plugin}/${j.job}`)).toEqual(['acme-jobs/poll', 'acme-jobs/worker'])
    expect(devbox.lastSpec().jobs).toStrictEqual([{
      plugin: 'acme-mirror', version: '0.3.0', job: 'sync', kind: 'every', everyMs: 3_600_000,
      bundle: { sha256: SHA_MIRROR, file: bundleFile(SHA_MIRROR) }, config: { target: 'west' }, host: 'devbox',
    }])
    expect(devbox.uploads.map((u) => u.path)).toEqual([bundleFile(SHA_MIRROR)])
    expect(h.deps.writeLocal).toHaveBeenCalledTimes(1)
    expect(h.deps.writeLocal).toHaveBeenCalledWith(bundleFile(SHA_NEW), BUNDLE_DATA, SHA_NEW)
  })

  it('a move: the machine the jobs left is sent a set without them, and the new one starts them', async () => {
    const h = harness()
    const local = fakeDaemon(LOCAL_HOST)
    const devbox = fakeDaemon('devbox')
    const mgr = h.manager()
    await mgr.connected(local.link)
    await mgr.connected(devbox.link)
    expect(local.running()).toHaveLength(2)
    expect(devbox.lastSpec().jobs).toEqual([])

    h.update({ runOn: 'devbox' })
    await mgr.reconcileAll()

    expect(local.configures()).toHaveLength(2)
    expect(local.lastSpec().jobs).toEqual([])
    expect(local.running()).toEqual([])
    expect(devbox.lastSpec().jobs).toStrictEqual(acmeSpecs('devbox', SHA_NEW))
    expect(devbox.running().map((r) => r.job)).toEqual(['poll', 'worker'])
  })

  it('a daemon older than plugin jobs is sent nothing, and both views say why', async () => {
    const h = harness({ plugins: [acmePlugin({ runOn: 'devbox' })] })
    const devbox = fakeDaemon('devbox', { caps: ['snapshot-v1'] })
    const mgr = h.manager()
    await mgr.connected(devbox.link)

    expect(devbox.sent).toEqual([])
    expect(devbox.uploads).toEqual([])
    expect(h.deps.bundle).not.toHaveBeenCalled()
    expect(mgr.views()).toMatchObject([{ key: 'devbox', phase: 'unsupported', jobs: [] }])
    expect(mgr.views()[0]!.message).toContain('older than plugin jobs')

    const view = await mgr.status('acme-jobs')
    expect(devbox.sent).toEqual([])
    expect(view!.placement.state).toBe('host-unsupported')
    expect(view!.placement.message).toBe('the daemon on Dev box is older than plugin jobs; it is upgraded on its next connect')
    expect(view!.live).toBe(false)
    expect(view!.hosts).toEqual([
      { key: LOCAL_HOST, label: 'This computer', connected: false, supported: true },
      { key: 'devbox', label: 'Dev box', connected: true, supported: false },
    ])
  })

  it('while the plugin catalogue is loading nothing is sent (the jobs running go on), and a retry is scheduled', async () => {
    const h = harness({ plugins: null })
    const local = fakeDaemon(LOCAL_HOST)
    local.seed(acmeRows(SHA_OLD, '1.1.0'))
    const mgr = h.manager()
    await mgr.connected(local.link)

    expect(local.sent).toEqual([])
    expect(local.running()).toEqual(acmeRows(SHA_OLD, '1.1.0'))
    expect(h.timers.map((t) => t.ms)).toEqual([15_000])
    expect(mgr.views()[0]!.phase).toBe('checking')

    // Still loading at the retry: still nothing, and one more retry.
    h.timers[0]!.fn()
    await ticks(5)
    expect(local.sent).toEqual([])
    expect(h.timers).toHaveLength(2)

    // Loaded at the next one: the whole set goes, and no further retry is scheduled.
    h.state.plugins = [acmePlugin()]
    h.timers[1]!.fn()
    await ticks(5)
    expect(local.configures()).toHaveLength(1)
    expect(local.lastSpec().jobs).toStrictEqual(acmeSpecs(LOCAL_HOST, SHA_NEW))
    expect(mgr.views()[0]!.phase).toBe('ready')
    expect(h.timers).toHaveLength(2)
  })
})

describe('plugin jobs manager: a plugin in flux, turned off, or whose code fails', () => {
  it.each(['failed', 'activating', 'discovered', 'disposing'])('%s: the jobs its daemon runs are kept at their old code', async (state) => {
    const h = harness({ plugins: [acmePlugin({ state })] })
    const local = fakeDaemon(LOCAL_HOST)
    local.seed(acmeRows(SHA_OLD, '1.1.0'))
    const mgr = h.manager()
    await mgr.connected(local.link)

    expect(h.deps.bundle).not.toHaveBeenCalled()
    expect(h.deps.writeLocal).not.toHaveBeenCalled()
    expect(local.lastSpec().jobs).toStrictEqual(acmeSpecs(LOCAL_HOST, SHA_OLD, '1.1.0'))
    expect(local.running().map((r) => r.bundleSha256)).toEqual([SHA_OLD, SHA_OLD])
  })

  it('failed with nothing running: nothing is started', async () => {
    const h = harness({ plugins: [acmePlugin({ state: 'failed' })] })
    const local = fakeDaemon(LOCAL_HOST)
    const mgr = h.manager()
    await mgr.connected(local.link)
    expect(local.lastSpec().jobs).toEqual([])
    expect(h.deps.bundle).not.toHaveBeenCalled()
  })

  it.each(['disabled', 'quarantined', 'needs-config'])('%s: the jobs are stopped', async (state) => {
    const h = harness({ plugins: [acmePlugin({ state })] })
    const local = fakeDaemon(LOCAL_HOST)
    local.seed(acmeRows(SHA_OLD, '1.1.0'))
    const mgr = h.manager()
    await mgr.connected(local.link)

    expect(local.lastSpec().jobs).toEqual([])
    expect(local.running()).toEqual([])
    expect(h.deps.bundle).not.toHaveBeenCalled()
    const view = await mgr.status('acme-jobs')
    expect(view!.placement.state).toBe('plugin-off')
  })

  it('a bundle that fails keeps the running jobs at the old code, and status says the version before keeps running', async () => {
    const h = harness()
    h.bundles.set('acme-jobs', { error: 'Could not resolve "./missing.js"' })
    const local = fakeDaemon(LOCAL_HOST)
    local.seed(acmeRows(SHA_OLD, '1.1.0'))
    const mgr = h.manager()
    await mgr.connected(local.link)

    expect(h.deps.writeLocal).not.toHaveBeenCalled()
    expect(local.lastSpec().jobs).toStrictEqual(acmeSpecs(LOCAL_HOST, SHA_OLD, '1.1.0'))
    expect(mgr.views()[0]!.bundleErrors).toEqual({ 'acme-jobs': 'Could not resolve "./missing.js"' })

    const view = await mgr.status('acme-jobs')
    expect(view!.live).toBe(true)
    expect(view!.placement).toEqual({
      state: 'code-error',
      message: 'its newest code could not be prepared (Could not resolve "./missing.js"); the version before keeps running',
    })
    expect(view!.jobs.map((j) => [j.job, j.bundleSha256, j.host])).toEqual([['poll', SHA_OLD, LOCAL_HOST], ['worker', SHA_OLD, LOCAL_HOST]])
  })

  it('a bundle that fails with nothing running: a code error, and no old version is promised', async () => {
    const h = harness()
    h.bundles.set('acme-jobs', { error: 'Could not resolve "./missing.js"' })
    const local = fakeDaemon(LOCAL_HOST)
    const mgr = h.manager()
    await mgr.connected(local.link)

    expect(local.lastSpec().jobs).toEqual([])
    const view = await mgr.status('acme-jobs')
    expect(view!.placement.state).toBe('code-error')
    expect(view!.placement.message).not.toContain('the version before')
  })

  it('an upload to a host that fails keeps the old code running there', async () => {
    const h = harness({ plugins: [acmePlugin({ runOn: 'devbox' })] })
    const devbox = fakeDaemon('devbox', { uploadError: new Error('link dropped') })
    devbox.seed(acmeRows(SHA_OLD, '1.1.0'))
    const mgr = h.manager()
    await mgr.connected(devbox.link)

    expect(devbox.uploads).toHaveLength(1)
    expect(devbox.lastSpec().jobs).toStrictEqual(acmeSpecs('devbox', SHA_OLD, '1.1.0'))
    expect(mgr.views()[0]!.bundleErrors).toEqual({ 'acme-jobs': 'its code could not be sent: link dropped' })
  })

  it('a configure the daemon refuses leaves the host in error, and status says the last setup failed', async () => {
    const h = harness()
    const local = fakeDaemon(LOCAL_HOST, { refuse: { 'jobs.configure': 'jobs.configure: the spec names another Walnut' } })
    const mgr = h.manager()
    await mgr.connected(local.link)

    expect(mgr.views()[0]).toMatchObject({ phase: 'error', message: 'jobs.configure refused: jobs.configure: the spec names another Walnut' })
    expect(h.deps.log).toHaveBeenCalledWith('warn', 'plugin jobs: could not configure', expect.objectContaining({ host: LOCAL_HOST }))
    const view = await mgr.status('acme-jobs')
    expect(view!.placement).toEqual({
      state: 'pending',
      message: 'the last setup on this computer failed: jobs.configure refused: jobs.configure: the spec names another Walnut',
    })
  })
})

describe('plugin jobs manager: one reconcile per host at a time', () => {
  it('two reconciles started together run one after the other, the second with what changed meanwhile', async () => {
    const h = harness()
    const local = fakeDaemon(LOCAL_HOST, { latencyTicks: 3 })
    const mgr = h.manager()
    await mgr.connected(local.link)
    local.resetCounters()

    const first = mgr.reconcileAll()
    h.update({ state: 'disabled' })
    const second = mgr.reconcileAll()
    await Promise.all([first, second])

    expect(local.maxInFlight).toBe(1)
    const sets = local.configures()
    expect(sets.length).toBeLessThanOrEqual(2)
    expect(sets.map((s) => s.jobs.length)).toEqual([2, 0])
    expect(local.running()).toEqual([])
  })

  it('any number of calls made while one runs fold into one more run', async () => {
    const h = harness()
    const local = fakeDaemon(LOCAL_HOST, { latencyTicks: 3 })
    const mgr = h.manager()
    await mgr.connected(local.link)
    local.resetCounters()

    await Promise.all(Array.from({ length: 5 }, () => mgr.reconcileAll()))

    expect(local.maxInFlight).toBe(1)
    expect(local.cmds()).toEqual(['jobs.status', 'jobs.configure', 'jobs.status', 'jobs.configure'])
  })

  it('a reconcile asked for during the connect waits for it instead of running beside it', async () => {
    const h = harness()
    const local = fakeDaemon(LOCAL_HOST, { latencyTicks: 3 })
    const mgr = h.manager()
    const connecting = mgr.connected(local.link)
    const again = mgr.reconcile(LOCAL_HOST)
    await Promise.all([connecting, again])

    expect(local.maxInFlight).toBe(1)
    expect(local.configures()).toHaveLength(2)
  })
})

describe('plugin jobs manager: status', () => {
  it('a live answer from the machine the jobs run on', async () => {
    const h = harness()
    const local = fakeDaemon(LOCAL_HOST)
    const mgr = h.manager()
    await mgr.connected(local.link)
    h.state.clock = 7_000
    local.resetCounters()

    const view = await mgr.status('acme-jobs')
    expect(local.sent).toEqual([{ cmd: 'jobs.status', params: { home: HOME }, timeoutMs: 5_000 }])
    expect(h.deps.plugins).toHaveBeenLastCalledWith(3_000)
    expect(view).toMatchObject({
      pluginId: 'acme-jobs',
      runOn: LOCAL_HOST,
      runOnLabel: 'This computer',
      placement: { state: 'running', message: 'running on this computer' },
      live: true,
      checkedAt: 7_000,
      elsewhere: [],
    })
    expect(view!.declared).toEqual([{ name: 'poll', kind: 'every', every: '5m' }, { name: 'worker', kind: 'long-running' }])
    expect(view!.jobs.map((j) => [j.job, j.host])).toEqual([['poll', LOCAL_HOST], ['worker', LOCAL_HOST]])
    expect(view!.hosts).toEqual([
      { key: LOCAL_HOST, label: 'This computer', connected: true, supported: true },
      { key: 'devbox', label: 'Dev box', connected: false, supported: true },
    ])
  })

  it('a host gone from the config: host-unknown', async () => {
    const h = harness({ plugins: [acmePlugin({ runOn: 'old-box' })] })
    const mgr = h.manager()
    const view = await mgr.status('acme-jobs')
    expect(view).toMatchObject({ runOn: 'old-box', runOnLabel: 'old-box', live: false, jobs: [], elsewhere: [] })
    expect(view!.placement.state).toBe('host-unknown')
    expect(view!.placement.message).toContain('old-box is not in Settings, Hosts')
  })

  it('a host offline: its last report, not live, with when it was taken', async () => {
    const h = harness({ plugins: [acmePlugin({ runOn: 'devbox' })] })
    const devbox = fakeDaemon('devbox')
    const mgr = h.manager()
    h.state.clock = 5_000
    await mgr.connected(devbox.link)
    devbox.setLink(false)
    mgr.disconnected('devbox')
    h.state.clock = 9_000
    devbox.resetCounters()

    const view = await mgr.status('acme-jobs')
    expect(devbox.sent).toEqual([])
    expect(view!.live).toBe(false)
    expect(view!.checkedAt).toBe(5_000)
    expect(view!.placement).toEqual({
      state: 'host-offline',
      message: 'Dev box is not connected now; it keeps the jobs running and this is its last report',
    })
    expect(view!.jobs.map((j) => [j.job, j.host])).toEqual([['poll', 'devbox'], ['worker', 'devbox']])
    expect(mgr.views()[0]).toMatchObject({ key: 'devbox', phase: 'checking', message: 'not connected' })
  })

  it('a host that never connected: host-offline, the jobs start when it connects', async () => {
    const h = harness({ plugins: [acmePlugin({ runOn: 'devbox' })] })
    const mgr = h.manager()
    const view = await mgr.status('acme-jobs')
    expect(view!.placement).toEqual({ state: 'host-offline', message: 'Dev box is not connected; the jobs start when it connects' })
    expect(view!.jobs).toEqual([])
    expect(view).not.toHaveProperty('checkedAt')
  })

  it('jobs moved while their old machine was away: elsewhere names it until it is back and stops them', async () => {
    const h = harness()
    const local = fakeDaemon(LOCAL_HOST)
    const devbox = fakeDaemon('devbox')
    const mgr = h.manager()
    await mgr.connected(local.link)
    local.setLink(false)
    mgr.disconnected(LOCAL_HOST)

    h.update({ runOn: 'devbox' })
    await mgr.connected(devbox.link)
    await mgr.reconcileAll()
    expect(local.configures()).toHaveLength(1)
    expect(devbox.running()).toHaveLength(2)

    let view = await mgr.status('acme-jobs')
    expect(view!.placement).toEqual({ state: 'running', message: 'running on Dev box' })
    expect(view!.elsewhere).toEqual([{ host: LOCAL_HOST, jobs: 2 }])

    local.setLink(true)
    await mgr.connected(local.link)
    expect(local.lastSpec().jobs).toEqual([])
    view = await mgr.status('acme-jobs')
    expect(view!.elsewhere).toEqual([])
  })

  it('refuses with 503 while the plugins are still loading', async () => {
    const h = harness({ plugins: null })
    const mgr = h.manager()
    const err = await mgr.status('acme-jobs').then(() => null, (e: unknown) => e)
    expect(err).toBeInstanceOf(Error)
    expect((err as { status?: number }).status).toBe(503)
  })

  it('a plugin with no jobs here: null', async () => {
    const h = harness()
    expect(await h.manager().status('acme-other')).toBeNull()
  })
})

describe('plugin jobs manager: logs', () => {
  it('reads from the machine the plugin runs on, or the machine named', async () => {
    const h = harness({ plugins: [acmePlugin({ runOn: 'devbox' })] })
    const local = fakeDaemon(LOCAL_HOST)
    const devbox = fakeDaemon('devbox')
    const mgr = h.manager()
    await mgr.connected(local.link)
    await mgr.connected(devbox.link)
    const logCalls = (d: ReturnType<typeof fakeDaemon>) => d.sent.filter((s) => s.cmd === 'jobs.logs')

    const out = await mgr.logs('acme-jobs', 'poll', 50)
    expect(out).toEqual({ host: 'devbox', lines: ['devbox acme-jobs/poll started', 'ran in 120 ms'], bytes: 4096 })
    expect(logCalls(devbox)).toEqual([{ cmd: 'jobs.logs', params: { home: HOME, plugin: 'acme-jobs', job: 'poll', lines: 50 }, timeoutMs: 10_000 }])
    expect(logCalls(local)).toEqual([])

    const named = await mgr.logs('acme-jobs', 'worker', 20, LOCAL_HOST)
    expect(named.host).toBe(LOCAL_HOST)
    expect(logCalls(local)).toEqual([{ cmd: 'jobs.logs', params: { home: HOME, plugin: 'acme-jobs', job: 'worker', lines: 20 }, timeoutMs: 10_000 }])
    expect(logCalls(devbox)).toHaveLength(1)
  })

  it('a disconnected machine: 503, and nothing is sent', async () => {
    const h = harness({ plugins: [acmePlugin({ runOn: 'devbox' })] })
    const devbox = fakeDaemon('devbox')
    const mgr = h.manager()
    await mgr.connected(devbox.link)
    devbox.setLink(false)
    mgr.disconnected('devbox')
    devbox.resetCounters()

    const err = await mgr.logs('acme-jobs', 'poll', 50).then(() => null, (e: unknown) => e)
    expect(err).toBeInstanceOf(Error)
    expect((err as { status?: number }).status).toBe(503)
    expect(devbox.sent).toEqual([])

    // A machine the manager never saw is not connected either.
    const never = await mgr.logs('acme-jobs', 'poll', 50, 'other-box').then(() => null, (e: unknown) => e)
    expect((never as { status?: number }).status).toBe(503)
  })

  it('an older daemon: 409; a job the daemon does not know: 404', async () => {
    const h = harness({ plugins: [acmePlugin({ runOn: 'devbox' })] })
    const old = fakeDaemon('devbox', { caps: [] })
    const local = fakeDaemon(LOCAL_HOST)
    const mgr = h.manager()
    await mgr.connected(old.link)
    await mgr.connected(local.link)

    const refused = await mgr.logs('acme-jobs', 'poll', 50).then(() => null, (e: unknown) => e)
    expect((refused as { status?: number }).status).toBe(409)
    expect(old.sent).toEqual([])

    const missing = await mgr.logs('acme-jobs', 'missing', 50, LOCAL_HOST).then(() => null, (e: unknown) => e)
    expect((missing as { status?: number }).status).toBe(404)
    expect((missing as Error).message).toBe('jobs.logs: no such job here')
  })
})

describe('plugin jobs manager: no secret reaches a host', () => {
  it('leaves out secrets at any depth, a secret named pair, and masks the password of a URL', () => {
    const config = {
      endpoint: 'https://queue.example.test',
      connection: { token: 't1', user: 'jobs' },
      accounts: [{ name: 'a', password: 'p1' }],
      env: [{ name: 'GITHUB_TOKEN', value: 'v1' }, { name: 'REGION', value: 'west' }],
      dsn: 'postgres://jobs:hunter2@db.example.test/q',
      batchSize: 25,
    }
    const out = withoutSecrets(config, isSecretKey)
    expect(out).toEqual({
      endpoint: 'https://queue.example.test',
      connection: { user: 'jobs' },
      accounts: [{ name: 'a' }],
      env: [{ name: 'GITHUB_TOKEN' }, { name: 'REGION', value: 'west' }],
      dsn: 'postgres://jobs:\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022@db.example.test/q',
      batchSize: 25,
    })
    for (const secret of ['t1', 'p1', 'v1', 'hunter2']) expect(JSON.stringify(out)).not.toContain(secret)
  })

  it('the spec a host is sent carries the same', async () => {
    const h = harness({ plugins: [acmePlugin({ runOn: 'devbox', config: { enabled: true, endpoint: 'https://q.example.test', connection: { token: 't1', user: 'jobs' } } })] })
    const devbox = fakeDaemon('devbox')
    await h.manager().connected(devbox.link)
    for (const j of devbox.lastSpec().jobs) expect(j.config).toEqual({ endpoint: 'https://q.example.test', connection: { user: 'jobs' } })
  })
})

describe('plugin jobs manager: a reconnect while a pass runs', () => {
  it('the pass on the old connection sends nothing, and the one after it sends the newest set', async () => {
    const h = harness({ plugins: [acmePlugin({ runOn: 'devbox' })] })
    const devbox = fakeDaemon('devbox')
    const mgr = h.manager()
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    h.deps.bundle.mockImplementationOnce(async () => { await gate; return { sha256: SHA_NEW, data: BUNDLE_DATA } })
    const first = mgr.connected(devbox.link)
    await ticks(5)
    // The jobs move away, then the link drops and comes back as a new handle.
    h.update({ runOn: LOCAL_HOST })
    const second = mgr.connected(devbox.handle())
    release()
    await Promise.all([first, second])
    expect(devbox.configures().map((spec) => spec.jobs.map((j) => j.job))).toEqual([[]])
    expect(devbox.running()).toEqual([])
    expect(devbox.maxInFlight).toBe(1)
  })
})

describe('plugin jobs manager: logs while the plugins load', () => {
  it('503 without a machine named, and asks no daemon', async () => {
    const h = harness({ plugins: null })
    const local = fakeDaemon(LOCAL_HOST)
    const mgr = h.manager()
    await mgr.connected(local.link)
    local.resetCounters()
    await expect(mgr.logs('acme-jobs', 'worker', 50)).rejects.toMatchObject({ status: 503 })
    expect(local.sent).toEqual([])
    // With the machine named, the read goes there.
    await expect(mgr.logs('acme-jobs', 'worker', 50, LOCAL_HOST)).resolves.toMatchObject({ host: LOCAL_HOST })
  })
})

describe('plugin jobs manager: limits, retries, and a host taken out', () => {
  it('a host taken out of Settings, Hosts is sent the empty set when it is reached', async () => {
    const h = harness({ plugins: [acmePlugin({ runOn: 'devbox' })] })
    const dev = fakeDaemon('devbox')
    const mgr = h.manager()
    await mgr.connected(dev.link)
    expect(dev.lastSpec().jobs).toHaveLength(2)
    h.state.hosts = []
    await mgr.reconcile('devbox')
    expect(dev.lastSpec().jobs).toEqual([])
    expect((await mgr.status('acme-jobs'))!.placement.message).not.toMatch(/may still run/)
    // Taken out while it was away: the page says the jobs may still run there.
    h.state.hosts = [{ key: 'devbox', label: 'Dev box' }]
    await mgr.reconcile('devbox')
    dev.setLink(false)
    mgr.disconnected('devbox')
    h.state.hosts = []
    const view = await mgr.status('acme-jobs')
    expect(view!.placement.state).toBe('host-unknown')
    expect(view!.placement.message).toMatch(/may still run there/)
  })

  it('settings over 64 KB keep that plugin\'s jobs off the machine; the other plugins\' go', async () => {
    const big = acmePlugin({ config: { enabled: true, blob: 'x'.repeat(70 * 1024) } })
    const mirror = acmePlugin({ id: 'acme-mirror', name: 'Acme Mirror', jobs: { sync: { kind: 'long-running' } }, config: {} })
    const h = harness({ plugins: [big, mirror] })
    const local = fakeDaemon(LOCAL_HOST)
    const mgr = h.manager()
    await mgr.connected(local.link)
    expect(local.lastSpec().jobs.map((j) => `${j.plugin}/${j.job}`)).toEqual(['acme-mirror/sync'])
    const view = await mgr.status('acme-jobs')
    expect(view!.placement.state).toBe('code-error')
    expect(view!.placement.message).toMatch(/larger than 64 KB/)
  })

  it('at most 64 jobs go to one machine; a plugin that does not fit says so', async () => {
    const ids = Array.from({ length: 7 }, (_, i) => `acme-${i}`)
    const plugins = ids.map((id) => acmePlugin({ id, jobs: Object.fromEntries(Array.from({ length: 10 }, (_, k) => [`j${k}`, { kind: 'long-running' as const }])) }))
    const h = harness({ plugins })
    for (const id of ids) h.bundles.set(id, { sha256: SHA_NEW, data: BUNDLE_DATA })
    const local = fakeDaemon(LOCAL_HOST)
    const mgr = h.manager()
    await mgr.connected(local.link)
    expect(local.lastSpec().jobs).toHaveLength(60)
    expect(new Set(local.lastSpec().jobs.map((j) => j.plugin))).toEqual(new Set(ids.slice(0, 6)))
    const view = await mgr.status('acme-6')
    expect(view!.placement.state).toBe('code-error')
    expect(view!.placement.message).toMatch(/at most 64/)
  })

  it('a failed pass is tried again after 30 s, doubling, and a clean pass starts the count again', async () => {
    const h = harness()
    const refuse: Record<string, string> = { 'jobs.configure': 'disk full' }
    const local = fakeDaemon(LOCAL_HOST, { refuse })
    const mgr = h.manager()
    await mgr.connected(local.link)
    expect(h.timers.at(-1)!.ms).toBe(30_000)
    const fire = async () => { const t = h.timers.at(-1)!; h.timers.length = 0; t.fn(); await ticks(30) }
    await fire()
    expect(h.timers.at(-1)!.ms).toBe(60_000)
    delete refuse['jobs.configure']
    await fire()
    expect(local.running().map((r) => r.job)).toEqual(['poll', 'worker'])
    expect(h.timers).toEqual([])
    // The count starts again: the next failure waits 30 s.
    refuse['jobs.configure'] = 'disk full'
    await mgr.reconcile(LOCAL_HOST)
    expect(h.timers.at(-1)!.ms).toBe(30_000)
  })

  it('a job the daemon refused for its code makes a later pass send the code again', async () => {
    const h = harness()
    const local = fakeDaemon(LOCAL_HOST)
    const link = local.handle()
    let refusing = true
    const send = link.send
    link.send = async (cmd, params, timeoutMs) => {
      const r = await send(cmd, params, timeoutMs)
      if (cmd === 'jobs.configure' && refusing) r.jobs = (r.jobs as PluginJobStatus[]).map((j) => ({ ...j, state: 'refused' as const }))
      return r
    }
    const mgr = h.manager()
    await mgr.connected(link)
    expect(h.deps.writeLocal).toHaveBeenCalledTimes(1)
    expect(h.timers.at(-1)!.ms).toBe(30_000)
    refusing = false
    const t = h.timers.at(-1)!
    h.timers.length = 0
    t.fn()
    await ticks(30)
    expect(h.deps.writeLocal).toHaveBeenCalledTimes(2)
    expect(h.timers).toEqual([])
  })
})

describe('plugin jobs: a test server', () => {
  it('runs none unless WALNUT_PLUGIN_JOBS_IN_TEST=1', async () => {
    const { pluginJobsOffReason, _resetPluginJobsManagerForTesting } = await import('../../src/core/plugin-jobs/index.js')
    _resetPluginJobsManagerForTesting()
    expect(pluginJobsOffReason({ ...process.env, WALNUT_PLUGIN_JOBS_IN_TEST: undefined })).toMatch(/test server/)
    expect(pluginJobsOffReason({ ...process.env, WALNUT_PLUGIN_JOBS_IN_TEST: '1' })).toBeNull()
    _resetPluginJobsManagerForTesting()
  })
})
