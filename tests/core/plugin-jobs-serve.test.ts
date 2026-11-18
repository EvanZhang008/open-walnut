/**
 * The leader's half of a job that serves its plugin's routes: the manager sends a serving
 * job only to a daemon that can forward to it and keeps the flag on a job it sends on
 * unchanged (manager.ts), names the daemon to ask (serveTarget), and forwardJobRoute
 * (serve.ts) turns one HTTP request into `jobs.http` and the daemon's answer, or a
 * refusal, into an HTTP answer. Fake daemons: what each one received is the assertion.
 */
import { describe, expect, it, vi } from 'vitest'
import {
  createPluginJobsManager,
  LOCAL_HOST,
  PLUGIN_JOBS_CAPABILITY,
  PLUGIN_JOBS_SERVE_CAPABILITY,
  type JobPlugin,
  type JobsHost,
  type ManagerDeps,
} from '../../src/core/plugin-jobs/manager.js'
import { forwardJobRoute, JobRouteError, servesFromJob, type JobRouteRequest } from '../../src/core/plugin-jobs/serve.js'
import type { PluginJobsSpec, PluginJobStatus } from '../../src/providers/plugin-jobs-core.js'
import { markLinkFailure } from '../../src/providers/link-failure.js'

const HOME = '/home/tester/.open-walnut'
const BUNDLES = '/d/plugin-jobs/bundles'
const SHA = 'a1'.repeat(32)

function plugin(over: Partial<JobPlugin> = {}): JobPlugin {
  return {
    id: 'acme-door', name: 'Acme Door', version: '2.0.0', state: 'active',
    jobs: { worker: { kind: 'long-running', serves: true }, sweep: { kind: 'every', everyMs: 300_000, every: '5m' } },
    config: { enabled: true, endpoint: 'https://queue.example.test' }, runOn: 'devbox', ...over,
  }
}

function daemon(hostKey: string, caps: string[], rows: PluginJobStatus[] = []) {
  let up = true
  const sent: Array<{ cmd: string; params: Record<string, unknown> }> = []
  let running = rows
  const handle: JobsHost = {
    hostKey,
    get connected() { return up },
    hasCapability: (c) => caps.includes(c),
    send: async (cmd, params = {}) => {
      if (!up) throw new Error('not connected')
      sent.push({ cmd, params })
      if (cmd === 'jobs.status') return { ok: true, bundles: BUNDLES, jobs: running }
      if (cmd === 'jobs.configure') {
        running = (params.spec as PluginJobsSpec).jobs.map((j) => ({
          plugin: j.plugin, job: j.job, kind: j.kind, version: j.version, state: 'running' as const, since: 0,
          restarts: 0, runs: 0, failures: 0, bundleSha256: j.bundle.sha256, ...(j.serves ? { serves: true as const } : {}),
        }))
        return { ok: true, jobs: running }
      }
      return { ok: false, error: `unknown ${cmd}` }
    },
    uploadFile: async () => ({ ok: true }),
  }
  return { handle, sent, down: () => { up = false }, specs: () => sent.filter((s) => s.cmd === 'jobs.configure').map((s) => s.params.spec as PluginJobsSpec) }
}

function manager(plugins: JobPlugin[] | null) {
  const state = { plugins }
  const deps: ManagerDeps = {
    home: HOME,
    walnutId: async () => 'walnut-1',
    plugins: vi.fn(async () => (state.plugins ? structuredClone(state.plugins) : null)),
    bundle: async () => ({ sha256: SHA, data: Buffer.from('export const jobs = {}') }),
    writeLocal: async () => {},
    localSecretsFile: (id) => `${HOME}/secrets/plugins/${id}.json`,
    isSecretKey: () => false,
    hosts: async () => [{ key: 'devbox', label: 'Dev box' }],
    log: () => {},
    now: () => 1_000,
    setTimer: () => 0,
  }
  return { mgr: createPluginJobsManager(deps), state }
}

const BOTH = [PLUGIN_JOBS_CAPABILITY, PLUGIN_JOBS_SERVE_CAPABILITY]

describe('the manager and serving jobs', () => {
  it('sends `serves` with the serving job only, and the plugin page lists it', async () => {
    const { mgr } = manager([plugin()])
    const d = daemon('devbox', BOTH)
    await mgr.connected(d.handle)
    const jobs = d.specs().at(-1)!.jobs
    expect(jobs.find((j) => j.job === 'worker')?.serves).toBe(true)
    expect('serves' in jobs.find((j) => j.job === 'sweep')!).toBe(false)
    const view = await mgr.status('acme-door')
    expect(view?.declared).toEqual([
      { name: 'worker', kind: 'long-running', serves: true },
      { name: 'sweep', kind: 'every', every: '5m' },
    ])
  })

  it('holds a serving plugin off a daemon older than jobs that serve routes, keeping what it runs, and says so', async () => {
    const old = { plugin: 'acme-door', job: 'sweep', kind: 'every' as const, everyMs: 300_000, version: '1.0.0', state: 'running' as const, since: 0, restarts: 0, runs: 3, failures: 0, bundleSha256: 'b2'.repeat(32) }
    const { mgr } = manager([plugin(), plugin({ id: 'acme-plain', jobs: { poll: { kind: 'every', everyMs: 300_000, every: '5m' } } })])
    const d = daemon('devbox', [PLUGIN_JOBS_CAPABILITY], [old])
    await mgr.connected(d.handle)
    const jobs = d.specs().at(-1)!.jobs
    // The version it runs keeps running; the new one with the serving job waits.
    expect(jobs.filter((j) => j.plugin === 'acme-door').map((j) => `${j.job}@${j.version}`)).toEqual(['sweep@1.0.0'])
    expect(jobs.filter((j) => j.plugin === 'acme-plain').map((j) => j.job)).toEqual(['poll'])
    const view = await mgr.status('acme-door')
    expect(view?.placement).toMatchObject({ state: 'code-error', message: expect.stringMatching(/older than jobs that serve routes/) })
  })

  it('a plugin in flux keeps its serving job serving when it is sent on unchanged', async () => {
    const { mgr, state } = manager([plugin()])
    const d = daemon('devbox', BOTH)
    await mgr.connected(d.handle)
    state.plugins = [plugin({ state: 'failed' })]
    await mgr.reconcile('devbox')
    expect(d.specs().at(-1)!.jobs.find((j) => j.job === 'worker')?.serves).toBe(true)
  })

  it('serveTarget names the daemon to ask, or why there is none', async () => {
    const { mgr, state } = manager(null)
    expect(await mgr.serveTarget('acme-door')).toEqual({ error: 'the plugins are still loading', retryAfterS: 2 })
    state.plugins = [plugin(), plugin({ id: 'acme-plain', jobs: { poll: { kind: 'every', everyMs: 300_000, every: '5m' } } })]
    expect(await mgr.serveTarget('acme-plain')).toEqual({ error: 'no job of acme-plain serves routes' })
    expect(await mgr.serveTarget('acme-door')).toEqual({ error: 'Dev box is not connected, so the job\'s routes cannot be reached', retryAfterS: 5 })
    const old = daemon('devbox', [PLUGIN_JOBS_CAPABILITY])
    await mgr.connected(old.handle)
    expect(await mgr.serveTarget('acme-door')).toEqual({ error: 'the daemon on Dev box is older than jobs that serve routes; it is upgraded on its next connect' })
    const d = daemon('devbox', BOTH)
    await mgr.connected(d.handle)
    expect(await mgr.serveTarget('acme-door')).toEqual({ handle: d.handle, where: 'Dev box' })
    d.down()
    expect(await mgr.serveTarget('acme-door')).toMatchObject({ error: expect.stringMatching(/Dev box is not connected/) })
    state.plugins = [plugin({ state: 'disabled' })]
    expect(await mgr.serveTarget('acme-door')).toEqual({ error: 'the plugin is turned off, so its job serves no routes' })
    state.plugins = [plugin({ runOn: LOCAL_HOST })]
    expect(await mgr.serveTarget('acme-door')).toEqual({ error: 'the daemon of this computer is not connected, so the job\'s routes cannot be reached', retryAfterS: 5 })
  })

  it('servesFromJob: a plugin with a serving job that is not off', () => {
    const sources = [
      { id: 'a', state: 'active', jobs: { w: { kind: 'long-running' as const, serves: true as const } } },
      { id: 'b', state: 'failed', jobs: { w: { kind: 'long-running' as const, serves: true as const } } },
      { id: 'c', state: 'disabled', jobs: { w: { kind: 'long-running' as const, serves: true as const } } },
      { id: 'd', state: 'active', jobs: { w: { kind: 'long-running' as const } } },
    ]
    expect(['a', 'b', 'c', 'd', 'e'].map((id) => servesFromJob(sources, id))).toEqual([true, true, false, false, false])
  })
})

describe('forwardJobRoute', () => {
  function target(reply: (params: Record<string, unknown>) => Promise<Record<string, unknown>> | Record<string, unknown>) {
    const asked: Array<Record<string, unknown>> = []
    const handle: JobsHost = {
      hostKey: 'devbox', connected: true, hasCapability: () => true,
      send: async (cmd, params = {}, timeoutMs) => { asked.push({ cmd, ...params, timeoutMs }); return reply(params) },
      uploadFile: async () => ({}),
    }
    return { asked, deps: { home: HOME, serveTarget: async () => ({ handle, where: 'Dev box' }) } }
  }
  const ok = (body: string, headers: Record<string, string> = {}) => ({ ok: true, status: 200, headers, size: Buffer.byteLength(body), data: Buffer.from(body).toString('base64') })
  function request(over: Partial<JobRouteRequest> = {}): JobRouteRequest {
    return { pluginId: 'acme-door', method: 'post', path: '/queue?x=1', headers: {}, body: Buffer.from('{"item":"a"}'), ...over }
  }

  it('sends the request without the caller\'s credentials, and brings the answer back without hop-by-hop headers', async () => {
    const t = target(() => ok('{"length":1}', { 'content-type': 'application/json', connection: 'close', 'transfer-encoding': 'chunked', 'x-acme': 'yes' }))
    const r = await forwardJobRoute(t.deps, request({
      headers: { Authorization: 'Bearer secret', cookie: 'sid=1', host: 'mac.local', 'x-walnut-origin': 'remote-http', 'content-type': 'application/json' },
    }))
    expect(t.asked).toEqual([{
      cmd: 'jobs.http', home: HOME, plugin: 'acme-door', method: 'POST', path: '/queue?x=1',
      headers: { 'x-walnut-origin': 'remote-http', 'content-type': 'application/json' },
      size: 12, data: Buffer.from('{"item":"a"}').toString('base64'), timeoutMs: 10_000,
    }])
    expect(r).toEqual({ status: 200, headers: { 'content-type': 'application/json', 'x-acme': 'yes' }, body: Buffer.from('{"length":1}') })
  })

  it('never lets a job set a cookie on Walnut\'s origin', async () => {
    const t = target(() => ok('{}', { 'Set-Cookie': 'walnut_session=stolen; Path=/', 'set-cookie2': 'x=1', 'content-type': 'application/json' }))
    expect((await forwardJobRoute(t.deps, request())).headers).toEqual({ 'content-type': 'application/json' })
  })

  it.each([
    ['not_running', 503, 5],
    ['not_ready', 503, 5],
    ['busy', 503, 5],
    ['not_serving', 503, undefined],
    ['timeout', 504, undefined],
    ['too_large', 502, undefined],
    ['bad_request', 400, undefined],
    ['request_too_large', 413, undefined],
    ['something_new', 502, undefined],
  ])('a daemon refusal %s answers %d', async (code, status, retry) => {
    const t = target(() => ({ ok: false, error: `the job said ${code}`, errorKind: code }))
    const err = await forwardJobRoute(t.deps, request()).catch((e) => e)
    expect(err).toBeInstanceOf(JobRouteError)
    expect(err).toMatchObject({ status, message: `the job said ${code}`, retryAfterS: retry })
  })

  it('the Retry-After is the daemon\'s own word when it gives one, within 1 to 60 s', async () => {
    for (const [said, want] of [[12, 12], [600, 60], [0, 1], [undefined, 5]] as const) {
      const t = target(() => ({ ok: false, error: 'backing off', errorKind: 'not_running', ...(said !== undefined ? { retryAfterS: said } : {}) }))
      expect(await forwardJobRoute(t.deps, request()).catch((e) => e)).toMatchObject({ status: 503, retryAfterS: want })
    }
    // A refusal that is not about time never says when.
    const t = target(() => ({ ok: false, error: 'no', errorKind: 'not_serving', retryAfterS: 9 }))
    expect((await forwardJobRoute(t.deps, request()).catch((e) => e)).retryAfterS).toBeUndefined()
  })

  it('no machine to ask answers 503 with its reason, without asking anyone', async () => {
    const err = await forwardJobRoute({ home: HOME, serveTarget: async () => ({ error: 'Dev box is not connected', retryAfterS: 5 }) }, request()).catch((e) => e)
    expect(err).toMatchObject({ status: 503, message: 'Dev box is not connected', retryAfterS: 5 })
  })

  it('a link failure answers by its kind: no link 503 (ask again), lost 502 (may have run), no answer 504; one that never answers is cut', async () => {
    const failing = (kind: 'no-link' | 'lost' | 'no-answer' | null) => target(() => {
      const err = new Error(`link trouble ${kind}`)
      throw kind ? markLinkFailure(err, kind) : err
    })
    expect(await forwardJobRoute(failing('no-link').deps, request()).catch((e) => e)).toMatchObject({ status: 503, retryAfterS: 5, message: 'Dev box could not be reached: link trouble no-link' })
    const lost = await forwardJobRoute(failing('lost').deps, request()).catch((e) => e)
    expect(lost).toMatchObject({ status: 502, message: 'the link to Dev box closed before it answered; the request may have run there' })
    expect(lost.retryAfterS).toBeUndefined()
    expect(await forwardJobRoute(failing('no-answer').deps, request()).catch((e) => e)).toMatchObject({ status: 504, message: 'Dev box did not answer within 10 s' })
    expect(await forwardJobRoute(failing(null).deps, request()).catch((e) => e)).toMatchObject({ status: 502, message: 'Dev box could not be asked: link trouble null' })
    const silent = target(() => new Promise(() => {}))
    const started = Date.now()
    const err = await forwardJobRoute({ ...silent.deps, timeoutMs: 100 }, request()).catch((e) => e)
    expect(err).toMatchObject({ status: 504, message: 'Dev box did not answer within 0 s' })
    expect(Date.now() - started).toBeLessThan(2_000)
  })

  it('an answer that is not one is a 502', async () => {
    for (const bad of [{ ok: true, status: 700, headers: {}, size: 0, data: '' }, { ok: true, status: 200, headers: {}, size: 4, data: '' }, { ok: true, status: 200, size: 0, data: '' }]) {
      expect(await forwardJobRoute(target(() => bad).deps, request()).catch((e) => e)).toMatchObject({ status: 502 })
    }
  })

  it('a request body goes up to 256 KB (the upload to the job\'s machine); an answer up to 2 MB comes back', async () => {
    const big = Buffer.alloc(2 * 1024 * 1024, 97)
    const t = target(() => ({ ok: true, status: 200, headers: {}, size: big.byteLength, data: big.toString('base64') }))
    const r = await forwardJobRoute(t.deps, request({ body: Buffer.alloc(256 * 1024) }))
    expect(r.body.byteLength).toBe(2 * 1024 * 1024)
    expect(t.asked[0]).toMatchObject({ size: 256 * 1024 })
    const err = await forwardJobRoute(t.deps, request({ body: Buffer.alloc(256 * 1024 + 1) })).catch((e) => e)
    expect(err).toMatchObject({ status: 413, message: 'the request body is 257 KB, more than the 256 KB a plugin job\'s route takes (its answer may be up to 2 MB)' })
    expect(t.asked).toHaveLength(1)
  })

  it('refuses what no job takes before asking: a method, a path, a body past 256 KB, headers past 64 KB', async () => {
    const t = target(() => ok(''))
    await expect(forwardJobRoute(t.deps, request({ method: 'TRACE' }))).rejects.toMatchObject({ status: 405 })
    await expect(forwardJobRoute(t.deps, request({ path: '/a/%2e%2e/b' }))).rejects.toMatchObject({ status: 400 })
    await expect(forwardJobRoute(t.deps, request({ body: Buffer.alloc(256 * 1024 + 1) }))).rejects.toMatchObject({ status: 413 })
    await expect(forwardJobRoute(t.deps, request({ method: 'GET' }))).rejects.toMatchObject({ status: 400 })
    await expect(forwardJobRoute(t.deps, request({ headers: { 'x-big': 'v'.repeat(64 * 1024 + 1) } }))).rejects.toMatchObject({ status: 431 })
    expect(t.asked).toEqual([])
  })
})
