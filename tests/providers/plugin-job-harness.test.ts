/**
 * One run of a plugin job (plugin-job-harness.ts) with a fake clock, a module given
 * in place of the bundle, and a real unix socket standing in for the daemon's agent
 * gateway. The real processes are tests/integration/plugin-jobs-twins.test.ts.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { createPluginJobHarness, type PluginJobHarnessDeps } from '../../src/providers/plugin-job-harness.js'

let dir = ''
let now = 0
let timers: Array<{ at: number; fn: () => void; id: number }> = []
let nextTimer = 1
let lines: Array<Record<string, any>> = []
let exits: number[] = []
let fatal: ((err: unknown, kind: string) => void) | null = null

function advance(ms: number): void {
  const end = now + ms
  for (;;) {
    timers.sort((a, b) => a.at - b.at)
    const next = timers[0]
    if (!next || next.at > end) break
    timers.shift()
    now = next.at
    next.fn()
  }
  now = end
}

const SID = 'plugin-job:' + 'a'.repeat(64)

function info(over: Record<string, unknown> = {}): string {
  return JSON.stringify({ plugin: 'acme-jobs', version: '1.0.0', job: 'worker', kind: 'long-running', host: '__local__', config: { q: 1 }, stateDir: path.join(dir, 'run'), sid: SID, secretsFile: path.join(dir, 'secrets.json'), ...over })
}

function deps(mod: Record<string, unknown>, over: Partial<PluginJobHarnessDeps> = {}): PluginJobHarnessDeps {
  return {
    fs, path, net,
    env: { WALNUT_PLUGIN_JOB: info(), WALNUT_AGENT_SOCKET: path.join(dir, 'gw.sock') },
    importModule: async () => mod,
    now: () => now,
    setTimer: (fn, ms) => { const id = nextTimer++; timers.push({ at: now + ms, fn, id }); return id },
    clearTimer: (t) => { timers = timers.filter((x) => x.id !== t) },
    onSignal: () => {},
    write: (text) => { lines.push(JSON.parse(text)) },
    exit: (code) => { exits.push(code) },
    onFatal: (fn) => { fatal = fn },
    home: dir,
    ...over,
  }
}

/** The daemon's gateway: records each request line and answers with `answer(request)`. */
function gateway(answer: (req: Record<string, any>) => Record<string, unknown>): Promise<{ server: net.Server; seen: Array<Record<string, any>> }> {
  const seen: Array<Record<string, any>> = []
  const server = net.createServer((sock) => {
    let buf = ''
    sock.on('data', (d) => {
      buf += d.toString()
      const nl = buf.indexOf('\n')
      if (nl === -1) return
      const req = JSON.parse(buf.slice(0, nl))
      seen.push(req)
      sock.end(JSON.stringify(answer(req)) + '\n')
    })
  })
  return new Promise((resolve) => server.listen(path.join(dir, 'gw.sock'), () => resolve({ server, seen })))
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pjh-'))
  fs.mkdirSync(path.join(dir, 'run'))
  now = 5_000_000
  timers = []
  nextTimer = 1
  lines = []
  exits = []
  fatal = null
})

afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }) })

describe('walnut.ops', () => {
  it('calls an op under the run\'s own caller id, and an error answer throws with its code', async () => {
    const gw = await gateway((req) => req.args.name === 'task_list'
      ? { ok: true, result: { tasks: [], asked: req.args.args } }
      : { ok: false, error: { code: 'not_found', message: 'no such op' } })
    let got: unknown
    let err: (Error & { code?: string }) | null = null
    const h = createPluginJobHarness(deps({
      jobs: {
        worker: async (walnut: any) => {
          got = await walnut.ops.call('task_list', { limit: 1 })
          try { await walnut.ops.call('nope', {}) } catch (e) { err = e as Error & { code?: string } }
        },
      },
    }))
    expect(await h.run(['/b.mjs', 'worker'])).toBe(0)
    gw.server.close()
    expect(got).toEqual({ tasks: [], asked: { limit: 1 } })
    expect(err!.code).toBe('not_found')
    expect(gw.seen.map((r) => r.sid)).toEqual([SID, SID])
    expect(gw.seen[0]).toMatchObject({ v: 1, op: 'tools.call', args: { name: 'task_list', args: { limit: 1 } } })
  })
})

describe('the run', () => {
  it('an uncaught error anywhere in the job ends the run as a failure, in its log', async () => {
    let release: () => void = () => {}
    const h = createPluginJobHarness(deps({ jobs: { worker: () => new Promise<void>((r) => { release = r }) } }))
    const run = h.run(['/b.mjs', 'worker'])
    await new Promise((r) => setImmediate(r))
    expect(fatal).not.toBeNull()
    fatal!(new Error('boom in a timer'), 'uncaughtException')
    expect(exits).toEqual([1])
    const line = lines.find((l) => l.msg === 'run failed (uncaughtException)')
    expect(line?.level).toBe('error')
    expect(String(line?.data?.error)).toContain('boom in a timer')
    release()
    await run
  })

  it('writes secrets under the lock the server takes on the same file', async () => {
    const file = path.join(dir, 'secrets.json')
    fs.writeFileSync(file, JSON.stringify({ old: 'x', keep: 'y' }))
    const locked: string[] = []
    let insideLock = false
    let wroteInside = 0
    const watchedFs = {
      ...fs,
      writeFileSync: ((...a: Parameters<typeof fs.writeFileSync>) => {
        if (String(a[0]).startsWith(file) && insideLock) wroteInside += 1
        return fs.writeFileSync(...a)
      }) as typeof fs.writeFileSync,
    } as typeof fs
    const h = createPluginJobHarness(deps(
      { jobs: { worker: async (walnut: any) => { await walnut.secrets.set('token', 'abc'); await walnut.secrets.delete('old') } } },
      {
        fs: watchedFs,
        lock: async <T,>(f: string, fn: () => Promise<T>): Promise<T> => {
          locked.push(f)
          insideLock = true
          try { return await fn() } finally { insideLock = false }
        },
      },
    ))
    expect(await h.run(['/b.mjs', 'worker'])).toBe(0)
    expect(locked).toEqual([file, file])
    expect(wroteInside).toBe(2)
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ keep: 'y', token: 'abc' })
  })

  it('a run no daemon looks after for 6 h, at two checks in a row, stops itself', async () => {
    const supervised = path.join(dir, 'run', 'supervised')
    fs.writeFileSync(supervised, String(now))
    let aborted = false
    const h = createPluginJobHarness(deps({
      jobs: { worker: async (_w: unknown, signal: AbortSignal) => { await new Promise((r) => signal.addEventListener('abort', r)); aborted = true } },
    }))
    const run = h.run(['/b.mjs', 'worker'])
    await new Promise((r) => setImmediate(r))
    // Fresh beats: nothing happens, however long.
    for (let i = 0; i < 20; i++) { fs.writeFileSync(supervised, String(now)); advance(30 * 60_000) }
    expect(aborted).toBe(false)
    // The daemon is gone: 6 h pass with no beat. One stale check is not enough...
    const last = now
    fs.writeFileSync(supervised, String(last))
    advance(6 * 60 * 60_000 + 30 * 60_000)
    await new Promise((r) => setImmediate(r))
    expect(lines.some((l) => String(l.msg).startsWith('stopping'))).toBe(false)
    // ...a beat in between starts the count again...
    fs.writeFileSync(supervised, String(now))
    advance(30 * 60_000)
    advance(6 * 60 * 60_000)
    await new Promise((r) => setImmediate(r))
    expect(aborted).toBe(false)
    // ...and two in a row stop it the way SIGTERM does.
    advance(30 * 60_000)
    await run
    expect(aborted).toBe(true)
    expect(lines.find((l) => String(l.msg).startsWith('stopping'))?.msg).toBe('stopping (no Walnut daemon has looked after it for 6 hours)')
    expect(exits).toEqual([])
  })

  it('refuses to run when the daemon did not describe the job', async () => {
    const h = createPluginJobHarness(deps({ jobs: { worker: async () => {} } }, { env: {} }))
    expect(await h.run(['/b.mjs', 'worker'])).toBe(2)
  })
})
