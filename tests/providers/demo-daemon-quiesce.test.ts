// demo.quiesce: only a Demo's own daemon fences, the fence never reopens, and the reply comes after accepted work settled.
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { createDemoDaemonQuiesce, type DemoQuiesceDeps } from '../../src/providers/demo-daemon-quiesce-core.js'
import { createDaemonCommandDrain } from '../../src/providers/daemon-command-drain.js'
import { EventEmitter } from 'node:events'
import { createOneShotCore, type OneShotChild } from '../../src/providers/oneshot-core.js'
import os from 'node:os'
import { spawn } from 'node:child_process'
import ts from 'typescript'
import { getDaemonSource } from '../../src/providers/daemon-source.js'

const ROOT = '/fixture/share/open-walnut-demo'
const GEN = 'gen-1'
const DATA = path.join(ROOT, 'data', GEN)
const demoEnv = { WALNUT_DEMO_ROOT: ROOT, WALNUT_DEMO_GENERATION: GEN, HOME: path.join(ROOT, 'homes', GEN) }

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((yes) => { resolve = yes })
  return { promise, resolve }
}

function make(over: Partial<DemoQuiesceDeps> = {}, factory = createDemoDaemonQuiesce) {
  const drain = createDaemonCommandDrain()
  const workers: Array<{ sid: string; state: string; pid: number | null; stopping: boolean }> = []
  let ended = 0
  const q = factory({
    env: demoEnv, daemonDir: path.join(ROOT, 'd', GEN), isProdDaemonDir: false, serviceMode: false, keepSessions: false,
    resolve: (...parts) => path.resolve(...parts), basename: (p) => path.basename(p),
    settle: () => drain.settle(),
    endWarmPool: () => { ended++ },
    oneShot: () => ({ runs: 0, pool: 0, children: 0 }),
    acpRuntimes: () => workers.slice(),
    deadlineMs: 200, pollMs: 5,
    ...over,
  })
  return { q, drain, workers, ended: () => ended }
}

describe('demo.quiesce', () => {
  it('answers only after a delayed native and ACP start accepted before it, and lists the ACP runtime', async () => {
    const { q, drain, workers } = make()
    const nativeStart = deferred()
    const acpStart = deferred()
    drain.admit(() => nativeStart.promise)
    drain.admit(() => acpStart.promise.then(() => { workers.push({ sid: 'rt-1', state: 'running', pid: 77, stopping: false }) }))
    let reply: unknown
    const pending = q.quiesce(undefined, { home: DATA }).then((r) => { reply = r })
    await new Promise((r) => setTimeout(r, 20))
    expect(q.fenced).toBe(true)
    expect(reply).toBeUndefined()
    nativeStart.resolve()
    acpStart.resolve()
    await pending
    expect(reply).toEqual({ ok: true, quiet: true, acpRuntimes: [{ sid: 'rt-1', state: 'running', pid: 77, stopping: false }] })
  })

  it('once fenced refuses every start, input, write and unknown command, and still takes reads and stops', async () => {
    const { q } = make()
    expect(q.allows('start')).toBe(true)
    await q.quiesce(undefined, { home: DATA })
    for (const cmd of ['start', 'acpStart', 'acpNewSession', 'send', 'sendRaw', 'oneshot.run', 'oneshot.prewarm', 'exec.run',
      'agent.start', 'agent.send', 'agent.newSession', 'attach', 'bridgeResume', 'fs.write', 'workspace.create', 'net.configure',
      'triggers.test', 'triggers.configure', 'hooks.configure', 'mcp.call', 'some.future.command', '__proto__', 'constructor', undefined]) {
      expect(q.allows(cmd), String(cmd)).toBe(false)
    }
    for (const cmd of ['stop', 'acpStop', 'agent.stop', 'list', 'acpState', 'agent.state', 'exec.list', 'exec.read', 'exec.kill',
      'oneshot.cancel', 'ping', 'hello', 'gateway-result', 'demo.quiesce']) {
      expect(q.allows(cmd), cmd).toBe(true)
    }
  })

  it('a production, service, kept or foreign daemon, a wrong home or any socket role is refused and nothing closes', async () => {
    const cases: Array<[Partial<DemoQuiesceDeps>, unknown, Record<string, unknown>]> = [
      [{ isProdDaemonDir: true }, undefined, { home: DATA }],
      [{ serviceMode: true }, undefined, { home: DATA }],
      [{ keepSessions: true }, undefined, { home: DATA }],
      [{ daemonDir: '/tmp/open-walnut' }, undefined, { home: DATA }],
      // The daemon dir is this generation's own: the shared root/d and another generation's are refused.
      [{ daemonDir: path.join(ROOT, 'd') }, undefined, { home: DATA }],
      [{ daemonDir: path.join(ROOT, 'd', 'gen-2') }, undefined, { home: DATA }],
      [{ env: {} }, undefined, { home: DATA }],
      [{ env: { ...demoEnv, WALNUT_DEMO_ROOT: '/fixture/share/other' } }, undefined, { home: DATA }],
      [{ env: { ...demoEnv, WALNUT_DEMO_ROOT: ROOT + '/' } }, undefined, { home: DATA }],
      [{ env: { ...demoEnv, WALNUT_DEMO_GENERATION: '../x' } }, undefined, { home: DATA }],
      [{ env: { ...demoEnv, HOME: '/Users/someone' } }, undefined, { home: DATA }],
      [{}, undefined, { home: path.join(ROOT, 'data', 'other') }],
      [{}, undefined, {}],
      [{}, 'bridge', { home: DATA }],
      [{}, 'follower', { home: DATA }],
      [{}, 'lane', { home: DATA }],
      [{}, 'probe', { home: DATA }],
    ]
    for (const [over, origin, params] of cases) {
      const { q, ended } = make(over)
      const reply = await q.quiesce(origin, params)
      expect(reply).toMatchObject({ ok: false, errorKind: 'demo_quiesce_refused' })
      expect(q.fenced).toBe(false)
      expect(q.allows('start')).toBe(true)
      expect(ended()).toBe(0)
    }
  })

  it('a deadline failure keeps the fence, and a retry answers once the work settled', async () => {
    const { q, drain } = make()
    const stuck = deferred()
    drain.admit(() => stuck.promise)
    expect(await q.quiesce(undefined, { home: DATA })).toMatchObject({ ok: false, errorKind: 'demo_not_quiet' })
    expect(q.fenced).toBe(true)
    expect(q.allows('start')).toBe(false)
    expect(await q.quiesce(undefined, { home: DATA })).toMatchObject({ ok: false, errorKind: 'demo_not_quiet' })
    stuck.resolve()
    expect(await q.quiesce(undefined, { home: DATA })).toMatchObject({ ok: true, quiet: true })
    expect(q.fenced).toBe(true)
  })

  it('ends the warm pool and refuses while a one-shot child has not exited, then answers once it has', async () => {
    let live = { runs: 1, pool: 0, children: 1 }
    const { q, ended } = make({ oneShot: () => live })
    const first = await q.quiesce(undefined, { home: DATA })
    expect(ended()).toBe(1)
    expect(first).toMatchObject({ ok: false, errorKind: 'demo_not_quiet', oneShot: { runs: 1, children: 1 } })
    live = { runs: 0, pool: 0, children: 0 }
    expect(await q.quiesce(undefined, { home: DATA })).toMatchObject({ ok: true })
  })

  it('with the real one-shot core: a run child that errored but lives keeps it refused until it exits', async () => {
    class Child extends EventEmitter {
      pid = 99; exitCode: number | null = null; killed = false; signals: string[] = []
      stdin = { write: () => true, end: () => { setTimeout(() => this.exit(), 5) }, on: () => {} }
      stdout = new EventEmitter(); stderr = new EventEmitter()
      kill(sig?: string) { this.signals.push(sig ?? 'SIGTERM'); return true }
      exit() { this.exitCode = 0; this.emit('exit', 0, null); this.emit('close', 0, null) }
    }
    const spawned: Child[] = []
    const oneShot = createOneShotCore<null>({ spawn: () => { const c = new Child(); spawned.push(c); return c as unknown as OneShotChild }, send: () => {} })
    oneShot.prewarm({ command: 'claude', args: [], warmKey: 'k' })
    oneShot.run(null, { command: 'claude', args: [], runId: 'r1' })
    const runChild = spawned[1]!
    runChild.emit('error', new Error('write EPIPE'))
    const { q } = make({ endWarmPool: () => { oneShot.endWarmPool() }, oneShot: () => oneShot.liveChildren() })
    const first = await q.quiesce(undefined, { home: DATA })
    expect(first).toMatchObject({ ok: false, errorKind: 'demo_not_quiet', oneShot: { runs: 0, pool: 0, children: 1 } })
    expect(spawned[0]!.exitCode).toBe(0) // the warm child ended by its stdin
    expect(spawned.flatMap((c) => c.signals)).toEqual([])
    runChild.exit()
    expect(await q.quiesce(undefined, { home: DATA })).toMatchObject({ ok: true, quiet: true })
  })

  it('builds from its own text, as the source twin inlines it', async () => {
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    const inlined = new Function(`"use strict"; return (${createDemoDaemonQuiesce.toString()})`)() as typeof createDemoDaemonQuiesce
    const { q } = make({}, inlined)
    expect(await q.quiesce(undefined, { home: DATA })).toMatchObject({ ok: true, quiet: true })
    expect(q.allows('start')).toBe(false)
    const refused = make({ isProdDaemonDir: true }, inlined).q
    expect(await refused.quiesce(undefined, { home: DATA })).toMatchObject({ ok: false })
    expect(refused.fenced).toBe(false)
  })
})

describe('demo.quiesce twin wiring', () => {
  const read = (rel: string) => fs.readFileSync(path.resolve(__dirname, '../..', rel), 'utf8')
  const standalone = read('src/providers/daemon-standalone.ts')
  const source = read('src/providers/daemon-source.ts')

  it('both twins answer it before the drain, refuse what the fence refuses, and fence every start', () => {
    for (const src of [standalone, source]) {
      const at = src.indexOf("if (cmd.cmd === 'demo.quiesce') {")
      expect(at).toBeGreaterThan(0)
      const gate = src.indexOf('if (!demoQuiesce.allows(cmd.cmd)) {', at)
      expect(gate).toBeGreaterThan(at)
      const admit = src.indexOf('daemonCommands.admit(work)', gate)
      expect(admit).toBeGreaterThan(gate)
      expect(src.slice(at, admit)).not.toContain('daemonCommands.admit')
      expect(src).toContain("if (demoQuiesce.fenced) throw new Error('start: Demo is stopping; no new session starts')")
      expect(src).toContain("if (demoQuiesce.fenced) throw new Error('acpStart: Demo is stopping; no new worker starts')")
      expect(src).toMatch(/settle: [^\n]*daemonCommands\.settle\(\)/)
      expect(src).toMatch(/endWarmPool: [^\n]*oneShot\.endWarmPool\(\)/)
    }
    expect(standalone).toContain('demoQuiesce.quiesce(ws.data?.origin, cmd)')
    expect(source).toContain('demoQuiesce.quiesce(ws.origin, cmd)')
    expect(source).toContain("['__CREATE_DEMO_QUIESCE__', createDemoDaemonQuiesce.toString()]")
  })

  /** The text of `name`'s body: from its declaration to the first line that closes it at column 0 (or 2 inside a factory). */
  const body = (src: string, decl: string, close = '\n}\n') => {
    const at = src.indexOf(decl)
    expect(at, decl).toBeGreaterThan(0)
    return src.slice(at, src.indexOf(close, at))
  }

  it('every process spawn a fenced Demo could still reach reads the fence synchronously before it', () => {
    const sites: Array<[string, string, RegExp, string]> = [
      ['standalone startSessionProcess', body(standalone, 'async function startSessionProcess('), /\bspawn\(/g, 'demoQuiesce.fenced'],
      ['source startSessionProcess', body(source, 'async function startSessionProcess('), /\bspawn\(/g, 'demoQuiesce.fenced'],
      ['ACP worker spawn', body(read('src/providers/acp-daemon.ts'), 'async function acpStart(', '\n  }\n'), /\bspawn\(/g, 'deps.maySpawn'],
      ['one-shot prewarm', body(read('src/providers/oneshot-core.ts'), 'function prewarm(', '\n  }\n'), /\bspawnChild\(/g, 'poolClosed'],
      ['one-shot run', body(read('src/providers/oneshot-core.ts'), 'function run(', '\n  }\n'), /\bspawnChild\(/g, 'poolClosed'],
    ]
    for (const [name, text, spawnCall, guard] of sites) {
      const calls = [...text.matchAll(spawnCall)].map((m) => m.index!)
      expect(calls.length, name).toBeGreaterThan(0)
      for (const at of calls) {
        const checked = text.lastIndexOf(guard, at)
        expect(checked, name + ': a guard before the spawn').toBeGreaterThan(0)
        expect(text.slice(checked, at), name + ': no await between the guard and the spawn').not.toMatch(/\bawait\b/)
      }
    }
    // The ACP fence is wired into both twins' ACP daemon.
    expect(standalone).toContain('maySpawn: () => !demoQuiesce.fenced')
    expect(source).toContain('maySpawn: function () { return !demoQuiesce.fenced; }')
  })

  it('adds no signal of its own', () => {
    const core = read('src/providers/demo-daemon-quiesce-core.ts')
    expect(core).not.toMatch(/SIGKILL|SIGTERM|\.kill\(|process\./)
  })
})

// A CLI whose leader exited while a child of its group lives on: the window before the
// existing reap ends that group. Driven through each twin's own cmdList and stopSessionProcess,
// with a real exited leader and a real child in its group; nothing here signals either.
describe('fenced list counts a live group whose CLI leader exited', () => {
  const LEADER = `
const { spawn } = require('child_process')
const fs = require('fs')
const c = spawn(process.execPath, [process.argv[2], process.argv[3]], { stdio: 'ignore' })
fs.writeFileSync(process.argv[4], String(c.pid))
c.unref()
setTimeout(() => process.exit(0), 100)
`
  const CHILD = `
const fs = require('fs')
setInterval(() => { if (fs.existsSync(process.argv[2])) process.exit(0) }, 20)
setTimeout(() => process.exit(0), 60000)
`
  function extract(source: string, name: string): string {
    const parsed = ts.createSourceFile('twin.ts', source, ts.ScriptTarget.ES2022, true)
    let found: ts.Node | undefined
    const visit = (node: ts.Node) => {
      if (ts.isFunctionDeclaration(node) && node.name?.text === name) found = node
      if (!found) ts.forEachChild(node, visit)
    }
    visit(parsed)
    if (!found) throw new Error('Missing ' + name)
    return found.getText(parsed)
  }
  const alive = (pid: number) => { try { process.kill(pid, 0); return true } catch { return false } }
  async function until(check: () => boolean, ms: number): Promise<boolean> {
    const end = Date.now() + ms
    while (!check() && Date.now() < end) await new Promise((r) => setTimeout(r, 20))
    return check()
  }
  const twins: Array<[string, string]> = [
    ['standalone', fs.readFileSync(path.resolve(__dirname, '../../src/providers/daemon-standalone.ts'), 'utf8')],
    ['source', getDaemonSource()],
  ]

  it.each(twins)('%s twin: alive while fenced, unchanged unfenced, stop refused, quiet once the child exits', async (_name, source) => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wq-group-')))
    const release = path.join(dir, 'release')
    let childPid = 0
    try {
      fs.writeFileSync(path.join(dir, 'leader.cjs'), LEADER)
      fs.writeFileSync(path.join(dir, 'child.cjs'), CHILD)
      const childPidFile = path.join(dir, 'child.pid')
      const leader = spawn(process.execPath, [path.join(dir, 'leader.cjs'), path.join(dir, 'child.cjs'), release, childPidFile], { detached: true, stdio: 'ignore' })
      await new Promise<void>((r) => leader.once('exit', () => r()))
      const leaderPid = leader.pid!
      childPid = Number(fs.readFileSync(childPidFile, 'utf8'))
      expect(alive(leaderPid)).toBe(false)
      expect(alive(childPid)).toBe(true)

      const streams = path.join(dir, 'streams')
      fs.mkdirSync(streams)
      fs.writeFileSync(path.join(streams, 'pgid-row.pgid'), String(leaderPid))
      const fenced = { fenced: false }
      const sessions = new Map<string, Record<string, unknown>>([['memory-row', { state: 'dead', pid: leaderPid, exitCode: 0 }]])
      const replies: Array<{ id: number; ok: boolean; data: Record<string, unknown> }> = []
      const env: Record<string, unknown> = {
        fs, path, STREAMS_DIR: streams, sessions, demoQuiesce: fenced,
        followerReads: { ownRows: (_h: unknown, rows: unknown) => rows }, followerHomeOf: () => '',
        sendOk: (_ws: unknown, id: number, data: Record<string, unknown>) => replies.push({ id, ok: true, data }),
        sendError: (_ws: unknown, id: number, error: string) => replies.push({ id, ok: false, data: { error } }),
        cronRuntime: null, daemonBootId: undefined, SERVICE_MODE: false, logMsg: () => {},
        reapSession: () => {}, persistRegistry: () => {}, recordMissingStartTime: () => {},
      }
      const text = ['isProcessGroupAlive', 'cmdList', 'stopSessionProcess'].map((n) => extract(source, n)).join('\n')
      const js = ts.transpileModule(text + '\nreturn { cmdList, stopSessionProcess };', { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText
      const twin = new Function(...Object.keys(env), js)(...Object.values(env)) as {
        cmdList: (ws: unknown, id: number) => void
        stopSessionProcess: (ws: unknown, id: number, sid: string) => void
      }
      const list = (id: number) => {
        twin.cmdList({}, id)
        const rows = replies.find((r) => r.id === id)!.data.sessions as Array<{ sid: string; alive: boolean }>
        return Object.fromEntries(rows.map((r) => [r.sid, r.alive]))
      }

      // Production list is unchanged: the leader is gone, so neither row reads alive.
      expect(list(1)).toEqual({ 'pgid-row': false, 'memory-row': false })
      fenced.fenced = true
      expect(list(2)).toEqual({ 'pgid-row': true, 'memory-row': true })
      twin.stopSessionProcess({}, 3, 'memory-row')
      expect(replies.find((r) => r.id === 3)).toMatchObject({ ok: false, data: { error: expect.stringMatching(/process group still exists/) } })
      expect(alive(childPid)).toBe(true)

      fs.writeFileSync(release, '')
      expect(await until(() => !alive(childPid), 10_000)).toBe(true)
      expect(list(4)).toEqual({ 'pgid-row': false, 'memory-row': false })
    } finally {
      fs.writeFileSync(release, '')
      if (childPid) await until(() => !alive(childPid), 10_000)
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }, 30_000)
})

// The daemon's own automatic work must stop in the fence's tick and count to 0 before quiet. Stubs only.
describe('demo.quiesce stops the daemon\'s own background work', () => {
  it('stops it synchronously with the fence, before the first await, and again once the drain settled', async () => {
    const calls: Array<{ home: string; fenced: boolean; settled: boolean }> = []
    let settled = false
    const gate = deferred()
    const box: { q?: ReturnType<typeof createDemoDaemonQuiesce> } = {}
    const { q } = make({
      settle: () => gate.promise.then(() => { settled = true }),
      stopInternalWork: (home) => { calls.push({ home, fenced: box.q!.fenced, settled }) },
    })
    box.q = q
    const pending = q.quiesce(undefined, { home: DATA })
    // Same tick as the call: no microtask has run yet.
    expect(calls).toEqual([{ home: DATA, fenced: true, settled: false }])
    gate.resolve()
    expect(await pending).toMatchObject({ ok: true, quiet: true })
    expect(calls).toEqual([{ home: DATA, fenced: true, settled: false }, { home: DATA, fenced: true, settled: true }])
  })

  it('answers not quiet with the counts and keeps the fence while any count is above 0, then quiet once all are 0', async () => {
    let counts: Record<string, number> = { triggerChecks: 1, triggerRuns: 0, pluginJobsDraining: 1 }
    const { q } = make({ background: () => counts })
    const first = await q.quiesce(undefined, { home: DATA })
    expect(first).toMatchObject({ ok: false, errorKind: 'demo_not_quiet', background: { triggerChecks: 1, pluginJobsDraining: 1 } })
    expect(first).not.toHaveProperty('oneShot')
    expect(q.fenced).toBe(true)
    counts = { triggerChecks: 0, triggerRuns: 0, pluginJobsDraining: 1 }
    expect(await q.quiesce(undefined, { home: DATA })).toMatchObject({ ok: false, background: { pluginJobsDraining: 1 } })
    counts = { triggerChecks: 0, triggerRuns: 0, pluginJobsDraining: 0 }
    expect(await q.quiesce(undefined, { home: DATA })).toMatchObject({ ok: true, quiet: true })
  })

  it('names both one-shot and background counts when both are left', async () => {
    const { q } = make({ oneShot: () => ({ runs: 1, pool: 0, children: 1 }), background: () => ({ pluginJobRuns: 2 }) })
    expect(await q.quiesce(undefined, { home: DATA })).toMatchObject({
      ok: false, errorKind: 'demo_not_quiet', oneShot: { runs: 1 }, background: { pluginJobRuns: 2 },
    })
  })

  it('a stop that throws keeps the fence and the Demo data (not quiet)', async () => {
    const { q } = make({ stopInternalWork: () => { throw new Error('boom') } })
    expect(await q.quiesce(undefined, { home: DATA })).toMatchObject({ ok: false, errorKind: 'demo_not_quiet', error: expect.stringContaining('boom') })
    expect(q.fenced).toBe(true)
  })

  it('a daemon that is not this Demo\'s own never stops or counts anything', async () => {
    let stops = 0
    let reads = 0
    for (const over of [{ isProdDaemonDir: true }, { serviceMode: true }, { env: {} }] as Array<Partial<DemoQuiesceDeps>>) {
      const { q } = make({ ...over, stopInternalWork: () => { stops++ }, background: () => { reads++; return {} } })
      expect(await q.quiesce(undefined, { home: DATA })).toMatchObject({ errorKind: 'demo_quiesce_refused' })
      expect(q.isDemo).toBe(false)
      expect(q.allows('triggers.run')).toBe(true)
    }
    expect(stops).toBe(0)
    expect(reads).toBe(0)
  })

  it('isDemo reads the Demo checks without fencing anything', () => {
    const { q } = make()
    expect(q.isDemo).toBe(true)
    expect(q.fenced).toBe(false)
    expect(q.allows('start')).toBe(true)
  })

  it('once fenced, only the listed names pass: no prototype name and no unlisted read op', async () => {
    const { q } = make()
    await q.quiesce(undefined, { home: DATA })
    for (const cmd of ['constructor', '__proto__', 'toString', 'valueOf', 'hasOwnProperty', 'isPrototypeOf', '__defineGetter__',
      'jobs.status', 'jobs.logs', 'triggers.list', 'triggers.run', 'triggers.claim', 'jobs.configure', 'fs.read', 'git.diff']) {
      expect(q.allows(cmd), cmd).toBe(false)
    }
  })

  it('the inlined text builds with the new deps too', async () => {
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    const inlined = new Function(`"use strict"; return (${createDemoDaemonQuiesce.toString()})`)() as typeof createDemoDaemonQuiesce
    let stops = 0
    let counts: Record<string, number> = { triggerChecks: 1 }
    const { q } = make({ stopInternalWork: () => { stops++ }, background: () => counts }, inlined)
    expect(q.isDemo).toBe(true)
    expect(await q.quiesce(undefined, { home: DATA })).toMatchObject({ ok: false, background: { triggerChecks: 1 } })
    counts = { triggerChecks: 0 }
    expect(await q.quiesce(undefined, { home: DATA })).toMatchObject({ ok: true })
    expect(stops).toBe(4)
    expect(q.allows('constructor')).toBe(false)
  })
})

describe('demo.quiesce background wiring in both twins', () => {
  const read = (rel: string) => fs.readFileSync(path.resolve(__dirname, '../..', rel), 'utf8')
  const standalone = read('src/providers/daemon-standalone.ts')
  const source = read('src/providers/daemon-source.ts')
  const twins: Array<[string, string]> = [['standalone', standalone], ['source', source]]

  /** One top-level function's text, from its declaration to its closing brace at column 0. */
  function fn(src: string, name: string): string {
    const m = new RegExp(`\\n(?:async )?function ${name}\\(`).exec(src)
    expect(m, name).not.toBeNull()
    const at = m!.index + 1
    return src.slice(at, src.indexOf('\n}\n', at) + 2)
  }

  it.each(twins)('%s: the quiesce deps stop the trigger checks and the plugin jobs of the Demo\'s home, and count what is left', (_n, src) => {
    const at = src.indexOf('createDemoDaemonQuiesce({') >= 0 ? src.indexOf('createDemoDaemonQuiesce({') : src.indexOf('(__CREATE_DEMO_QUIESCE__)({')
    expect(at).toBeGreaterThan(0)
    const deps = src.slice(at, src.indexOf('\n})', at))
    expect(deps).toMatch(/stopInternalWork:[\s\S]*demoTriggerChecks\.abort\(\)[\s\S]*pluginJobs\.quiesce\(home\)/)
    for (const count of ['demoTriggerCheckPids.size', 'triggerChecksRunning.size', 'triggerTestsRunning', 'hostDeliveriesInFlight.size', 'jobs.runs', 'jobs.draining', 'jobs.timers']) {
      expect(deps, count).toContain(count)
    }
    expect(deps).toMatch(/pluginJobs\.pending\(home\)/)
  })

  it.each(twins)('%s: the plugin supervisor and the ACP daemon read the fence; strict stops only on a Demo', (_n, src) => {
    const jobs = src.slice(src.indexOf('pluginJobs = '), src.indexOf('\n})', src.indexOf('pluginJobs = ')))
    expect(jobs).toMatch(/maySpawn: (\(\) => !demoQuiesce\.fenced|function \(\) \{ return !demoQuiesce\.fenced; \})/)
    const acpAt = /createAcpDaemon(?:<[^(]*>)?\(\{/.exec(src)!.index
    const acp = src.slice(acpAt, acpAt + 400)
    expect(acp).toMatch(/strictStop: (\(\) => demoQuiesce\.isDemo|function \(\) \{ return demoQuiesce\.isDemo; \})/)
  })

  it.each(twins)('%s: tick, run, host delivery, routine start and test each read the fence before they start anything', (_n, src) => {
    expect(fn(src, 'tickTriggers')).toMatch(/^function tickTriggers\(\)[^{]*\{\n(?:\s*\/\/[^\n]*\n)*\s*if \(demoQuiesce\.fenced\) return;?\n/)
    expect(fn(src, 'runTrigger')).toMatch(/^async function runTrigger\([^\n]*\{\n\s*if \(demoQuiesce\.fenced\) return \{ outcome: 'quiet', reason: 'demo_stopping' \};?\n/)
    expect(fn(src, 'deliverUnclaimedFires')).toMatch(/^function deliverUnclaimedFires\([^\n]*\{\n\s*if \(demoQuiesce\.fenced\) return;?\n/)
    expect(fn(src, 'startUnclaimedRun')).toContain('demoQuiesce.fenced) return')
    expect(fn(src, 'runTriggerTest')).toContain("if (demoQuiesce.fenced) throw new Error('triggers.test: Demo is stopping; no check starts')")
    // A run the stop ended writes no state and sends no event.
    const run = fn(src, 'runTrigger')
    const call = run.indexOf('runCheckProcess(')
    const discard = run.indexOf('if (demoQuiesce.fenced) {', call)
    expect(discard).toBeGreaterThan(call)
    expect(run.indexOf('persistTriggerState', call)).toBeGreaterThan(discard)
    expect(run.indexOf('sendTriggerEvent', call)).toBeGreaterThan(discard)
    // The run is counted (triggerChecksRunning) after the gate and let go in the finally.
    expect(run).toMatch(/triggerChecksRunning\.add\(entry\)/)
    expect(run.slice(run.lastIndexOf('finally'))).toMatch(/triggerChecksRunning\.delete\(entry\)/)
  })

  // Class guard: a new site that starts host work on its own (check, delivery, routine start, journal sweep) fails until it reads the fence first.
  const PRIMITIVES = [/\b(?:triggerCheckCore\.)?runCheckProcess\(/g, /\bofflineHost\.deliverTrigger\(/g, /\bclockHostStart\.start\(/g, /\bofflineHost\.sweep\(/g]
  it.each(twins)('%s: every automatic start site reads the fence first', (_n, src) => {
    let sites = 0
    for (const re of PRIMITIVES) {
      for (const m of src.matchAll(re)) {
        const at = m.index!
        const head = src.lastIndexOf('\nfunction ', at)
        const headAsync = src.lastIndexOf('\nasync function ', at)
        const start = Math.max(head, headAsync)
        expect(start, `${m[0]} at ${at}: inside a top-level function`).toBeGreaterThan(0)
        const before = src.slice(start, at).replace(/\bawait\s+$/, '')
        const name = /function (\w+)/.exec(src.slice(start, start + 80))![1]
        const gate = before.lastIndexOf('demoQuiesce.fenced')
        expect(gate, `${name}: reads the fence before ${m[0]}`).toBeGreaterThan(0)
        expect(before.slice(gate), `${name}: no await between the fence and ${m[0]}`).not.toMatch(/\bawait\b/)
        if (m[0].includes('runCheckProcess')) {
          expect(src.slice(at, at + 500), `${name}: passes the fence options`).toContain('checkRunFence()')
        }
        sites++
      }
    }
    // runTrigger, runTriggerTest (checks), deliverUnclaimedFires (delivery), startUnclaimedRun (routine), offlineSweepTick.
    expect(sites).toBe(5)
  })

  it.each(twins)('%s: a check never starts but through runTrigger or runTriggerTest, and tick is the only clock that runs them', (_n, src) => {
    const callers = [...src.matchAll(/(?<!function )\brunTrigger\(entry\)/g)].map((m) => {
      const start = Math.max(src.lastIndexOf('\nfunction ', m.index!), src.lastIndexOf('\nasync function ', m.index!))
      return /function (\w+)/.exec(src.slice(start, start + 80))![1]
    })
    expect(callers.sort()).toEqual(['cmdTriggersRun', 'tickTriggers'])
    // cmdTriggersRun is a command: the fence refuses it before dispatch (triggers.run is not listed).
    expect([...src.matchAll(/setInterval\(tickTriggers/g)]).toHaveLength(1)
  })

  it('the check fence is the same in both twins: an abort controller only demo.quiesce aborts, a pid set, the final gate', () => {
    for (const src of [standalone, source]) {
      expect([...src.matchAll(/demoTriggerChecks\.abort\(\)/g)]).toHaveLength(1)
      const fence = fn(src, 'checkRunFence')
      expect(fence).toContain('!demoQuiesce.fenced')
      expect(fence).toContain('demoTriggerChecks.signal')
      expect(fence).toContain('demoTriggerCheckPids')
    }
  })
})

// Each twin's own trigger functions run against stubs (no process, signal or file); the check stub holds its pid until closed.
describe('a fenced Demo: a tick mid-run, a late spawn and the counts, in each twin', () => {
  function extract(source: string, names: string[]): string {
    const parsed = ts.createSourceFile('twin.ts', source, ts.ScriptTarget.ES2022, true)
    const found = new Map<string, string>()
    const visit = (node: ts.Node) => {
      if (ts.isFunctionDeclaration(node) && node.name && names.includes(node.name.text) && !found.has(node.name.text)) found.set(node.name.text, node.getText(parsed))
      ts.forEachChild(node, visit)
    }
    visit(parsed)
    for (const n of names) if (!found.has(n)) throw new Error('Missing ' + n)
    return names.map((n) => found.get(n)!).join('\n')
  }
  const twinTexts: Array<[string, string]> = [
    ['standalone', fs.readFileSync(path.resolve(__dirname, '../../src/providers/daemon-standalone.ts'), 'utf8')],
    ['source', getDaemonSource()],
  ]

  it.each(twinTexts)('%s', async (twinName, text) => {
    const core = await import('../../src/providers/trigger-check-core.js')
    type Opts = { maySpawn: () => boolean; signal?: AbortSignal; children: Set<number> }
    const checks: Array<{ opts: Opts; finish: () => void; aborted: boolean }> = []
    const runCheckProcess = (_spec: unknown, _stdin: string, opts: Opts) => new Promise((resolve) => {
      // The real one's gate, as a stub: nothing starts when it says no.
      if (!opts.maySpawn() || opts.signal?.aborted) { resolve({ exitCode: null, signal: null, stdout: '', stderrTail: '', timedOut: false, stdoutOverflow: false, durationMs: 0, spawnError: 'not started' }); return }
      const pid = 4000 + checks.length
      opts.children.add(pid)
      const rec = { opts, aborted: false, finish: () => resolve({ exitCode: 0, signal: null, stdout: '{"fire":false}', stderrTail: '', timedOut: false, stdoutOverflow: false, durationMs: 1 }) }
      opts.signal?.addEventListener('abort', () => { rec.aborted = true })
      checks.push(rec)
    })
    const persisted: string[] = []
    const events: string[] = []
    const delivered: string[] = []
    const fence = { fenced: false }
    let holders: unknown[] = []
    const entry = { home: '/h', def: { id: 't1', name: 'T', everyMs: 60_000, check: { run: 'stub' } }, state: core.emptyHostState(1), nextRunAtMs: 0, running: false, fireSentAt: new Map(), armedAtMs: 0 }
    const armedTriggers = new Map([['/h\nt1', entry]])
    const env: Record<string, unknown> = {
      demoQuiesce: fence, armedTriggers, triggerKey: (h: string, id: string) => `${h}\n${id}`,
      demoTriggerChecks: new AbortController(), demoTriggerCheckPids: new Set<number>(), triggerChecksRunning: new Set<unknown>(),
      runCheckProcess, buildCheckStdin: core.buildCheckStdin, parseCheckStdout: core.parseCheckStdout, checkErrorOf: core.checkErrorOf,
      applyCheckError: core.applyCheckError, decideCheck: core.decideCheck, applyCheckOutcome: core.applyCheckOutcome,
      triggerCheckCore: { ...core, runCheckProcess },
      triggerCadenceMs: () => 60_000, runClock: () => 'held', GATEWAY_SHIM_DIR: '/stub-shim',
      persistTriggerState: (_h: string, id: string) => { persisted.push(id) },
      sendTriggerEvent: (_h: string, kind: string) => { events.push(kind); return true },
      sendTriggerFire: () => true, logMsg: () => {},
      replayPendingFires: () => { events.push('replay') },
      fireHolders: () => holders,
      hostDeliveryGraceMs: () => 0, hostDeliveriesInFlight: new Map(),
      fireDueOnHost: () => true, HOST_DELIVERY_RETRY_MS: 0,
      offlineHost: { deliverTrigger: () => { delivered.push('deliver'); return new Promise(() => {}) } },
      clockHostStart: { start: () => { delivered.push('routine'); return new Promise(() => {}) } },
    }
    const names = ['checkRunFence', 'runTrigger', 'tickTriggers', 'deliverUnclaimedFires', 'startUnclaimedRun']
    const js = ts.transpileModule(extract(text, names) + '\nreturn { checkRunFence, runTrigger, tickTriggers, deliverUnclaimedFires, startUnclaimedRun, inFlight: () => triggerChecksRunning.size };', {
      compilerOptions: { target: ts.ScriptTarget.ES2022 },
    }).outputText
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    const twin = new Function(...Object.keys(env), js)(...Object.values(env)) as {
      tickTriggers: () => void
      startUnclaimedRun: (e: unknown, f: unknown, now: number) => void
      deliverUnclaimedFires: (now: number) => void
      inFlight: () => number
    }
    const pids = env.demoTriggerCheckPids as Set<number>
    const abort = env.demoTriggerChecks as AbortController
    const background = () => ({ triggerChecks: pids.size, triggerRuns: twin.inFlight() })

    // Unfenced (production): the tick runs the check with the fence options and replays.
    twin.tickTriggers()
    expect(checks, twinName).toHaveLength(1)
    expect(checks[0]!.opts.maySpawn()).toBe(true)
    expect(checks[0]!.opts.children).toBe(pids)
    expect(events).toContain('replay')
    expect(background()).toEqual({ triggerChecks: 1, triggerRuns: 1 })

    // The fence closes while that check runs; the quiesce stop aborts the Demo's checks.
    fence.fenced = true
    abort.abort()
    expect(checks[0]!.aborted).toBe(true)
    // A late check spawn reads the final gate as closed.
    expect(checks[0]!.opts.maySpawn()).toBe(false)
    // The next tick starts nothing, replays nothing, delivers nothing, a due host delivery included.
    holders = [{ ...entry, def: { ...entry.def, deliver: { home: '/h', taskId: 'x', prompt: 'p' } }, state: { ...entry.state, pendingFires: [{ seq: 1, atMs: 0 }] } }]
    // A second trigger, due and not running, so only the fence keeps the tick from it.
    armedTriggers.set('/h\nt2', { ...entry, def: { ...entry.def, id: 't2' }, running: false, nextRunAtMs: 0, fireSentAt: new Map() })
    events.length = 0
    twin.tickTriggers()
    twin.deliverUnclaimedFires(Date.now())
    twin.startUnclaimedRun({ ...entry, def: { ...entry.def, start: { kind: 'stub' } } }, { seq: 1 }, Date.now())
    expect(checks).toHaveLength(1)
    expect(events).toEqual([])
    expect(delivered).toEqual([])

    // The check's promise settles (as the settle timer would) with its process not closed:
    // the run writes nothing, its counter drops, the pid is still counted.
    checks[0]!.finish()
    await new Promise((r) => setTimeout(r, 0))
    expect(persisted).toEqual([])
    expect(events).toEqual([])
    expect(background()).toEqual({ triggerChecks: 1, triggerRuns: 0 })
    // Its real close: all counts 0.
    pids.delete(4000)
    expect(background()).toEqual({ triggerChecks: 0, triggerRuns: 0 })
  })
})

// The offline host's minute sweep and its delivery into a session bypass the command drain; each twin's own text, all stubs.
describe('offline host sweep and delivery in a fenced Demo, in each twin', () => {
  const read = (rel: string) => fs.readFileSync(path.resolve(__dirname, '../..', rel), 'utf8')
  function extract(source: string, names: string[]): string {
    const parsed = ts.createSourceFile('twin.ts', source, ts.ScriptTarget.ES2022, true)
    const found = new Map<string, string>()
    const visit = (node: ts.Node) => {
      if (ts.isFunctionDeclaration(node) && node.name && names.includes(node.name.text) && !found.has(node.name.text)) found.set(node.name.text, node.getText(parsed))
      ts.forEachChild(node, visit)
    }
    visit(parsed)
    for (const n of names) if (!found.has(n)) throw new Error('Missing ' + n)
    return names.map((n) => found.get(n)!).join('\n')
  }
  const twinTexts: Array<[string, string]> = [
    ['standalone', read('src/providers/daemon-standalone.ts')],
    ['source', getDaemonSource()],
  ]

  function build(text: string, isDemo: boolean) {
    // The twin reads its fence through this view, so a test can point it at a real quiesce.
    let fenceSource: { fenced: boolean } = { fenced: false }
    const fence = { get fenced() { return fenceSource.fenced }, set fenced(v: boolean) { fenceSource = { fenced: v } }, isDemo }
    const drain = createDaemonCommandDrain()
    const sends: string[] = []
    const sweeps: number[] = []
    const gateOpen = deferred()
    const sendDone = deferred()
    const send = async (sid: string, msg: string) => { sends.push(`${sid}:${msg}`); await sendDone.promise; return { ok: true } }
    const env: Record<string, unknown> = {
      demoQuiesce: fence, daemonCommands: drain,
      // The real gate queues per session; this one holds every run until the test opens it.
      sessionStartGate: { run: async (_sid: string, work: () => Promise<unknown>) => { await gateOpen.promise; return work() } },
      cancelTurnRetry: () => {},
      core: { handleSendCommand: send }, handleSendCommand: send,
      offlineHost: { sweep: () => { sweeps.push(1); return Promise.resolve(0) } },
    }
    const js = ts.transpileModule(extract(text, ['offlineSweepTick', 'deliverFromOfflineHost']) + '\nreturn { offlineSweepTick, deliverFromOfflineHost };', {
      compilerOptions: { target: ts.ScriptTarget.ES2022 },
    }).outputText
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    const twin = new Function(...Object.keys(env), js)(...Object.values(env)) as {
      offlineSweepTick: () => void
      deliverFromOfflineHost: (sid: string, text: string, messageId: string) => Promise<{ ok: boolean; reason?: string }>
    }
    return {
      twin, fence, drain, sends, sweeps,
      openGate: () => gateOpen.resolve(), finishSend: () => sendDone.resolve(),
      readFenceFrom: (q: { fenced: boolean }) => { fenceSource = q },
    }
  }
  const tick = () => new Promise((r) => setTimeout(r, 0))

  it.each(twinTexts)('%s: the sweep runs unfenced and not once fenced', (_n, text) => {
    const t = build(text, true)
    t.twin.offlineSweepTick()
    expect(t.sweeps).toHaveLength(1)
    t.fence.fenced = true
    t.twin.offlineSweepTick()
    expect(t.sweeps).toHaveLength(1)
  })

  it.each(twinTexts)('%s: a delivery admitted before the fence is waited for by quiesce settle', async (_n, text) => {
    const t = build(text, true)
    t.openGate()
    const delivered = t.twin.deliverFromOfflineHost('s1', 'hi', 'qm-1')
    await tick()
    expect(t.sends).toEqual(['s1:hi'])
    const { q } = make({ settle: () => t.drain.settle(), deadlineMs: 5000 })
    t.readFenceFrom(q)
    let reply: unknown
    const pending = q.quiesce(undefined, { home: DATA }).then((r) => { reply = r })
    expect(t.fence.fenced).toBe(true)
    // A delivery after the fence is refused, and the one in flight keeps quiesce waiting.
    expect(await t.twin.deliverFromOfflineHost('s1', 'late', 'qm-2')).toEqual({ ok: false, reason: 'demo_stopping' })
    await new Promise((r) => setTimeout(r, 30))
    expect(reply).toBeUndefined()
    t.finishSend()
    expect(await delivered).toEqual({ ok: true })
    await pending
    expect(reply).toMatchObject({ ok: true, quiet: true })
  })

  it.each(twinTexts)('%s: a delivery queued at the gate when the fence closes sends nothing', async (_n, text) => {
    const t = build(text, true)
    const delivered = t.twin.deliverFromOfflineHost('s1', 'hi', 'qm-1')
    let settled = false
    void t.drain.settle().then(() => { settled = true })
    await tick()
    expect(settled).toBe(false)
    t.fence.fenced = true
    t.openGate()
    expect(await delivered).toEqual({ ok: false, reason: 'demo_stopping' })
    expect(t.sends).toEqual([])
    await tick()
    expect(settled).toBe(true)
  })

  it.each(twinTexts)('%s: once fenced a delivery is refused before the gate', async (_n, text) => {
    const t = build(text, true)
    t.fence.fenced = true
    expect(await t.twin.deliverFromOfflineHost('s1', 'hi', 'qm-1')).toEqual({ ok: false, reason: 'demo_stopping' })
    expect(t.sends).toEqual([])
  })

  it.each(twinTexts)('%s: an ordinary daemon delivers as before and admits nothing into the drain', async (_n, text) => {
    const t = build(text, false)
    t.openGate()
    const delivered = t.twin.deliverFromOfflineHost('s1', 'hi', 'qm-1')
    // The drain does not see it: settle answers at once and a pause is not refused.
    let settled = false
    void t.drain.settle().then(() => { settled = true })
    await tick()
    expect(settled).toBe(true)
    expect(() => t.drain.pause().resume()).not.toThrow()
    t.finishSend()
    expect(await delivered).toEqual({ ok: true })
    expect(t.sends).toEqual(['s1:hi'])
  })

  it.each(twinTexts)('%s: the offline host is wired to these two and the gate rechecks the fence before the send', (_n, text) => {
    const src = text
    expect(src).toMatch(/offlineSweepTimer = setInterval\(offlineSweepTick, 60_?000\)/)
    expect(src).toMatch(/deliver: (\(sid, text, messageId\) => |function \(sid, text, messageId\) \{ return )deliverFromOfflineHost\(sid, text, messageId\)/)
    const body = extract(src, ['deliverFromOfflineHost'])
    const gate = body.indexOf('sessionStartGate.run(')
    const recheck = body.indexOf('if (demoQuiesce.fenced)', gate)
    expect(recheck).toBeGreaterThan(gate)
    expect(body.indexOf('handleSendCommand(', gate)).toBeGreaterThan(recheck)
    expect(body).toMatch(/demoQuiesce\.isDemo && !daemonCommands\.closed \? daemonCommands\.admit\(work\) : work\(\)/)
  })
})
