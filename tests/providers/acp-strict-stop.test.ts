/**
 * The ACP daemon's strict stop (acpStop(sid, {strict: true}), a leader switch's stop of a worker in the
 * data home, daemon-session-stop.ts) where no worker runs any more:
 *   - a worker that exited on its own and left its adapter running in its group: the group gets one
 *     SIGTERM once ps shows it still runs that adapter, and the stop answers when it is gone;
 *   - the same group when ps shows no adapter of the worker, or gives no answer: an error, no signal;
 *   - a straggler row of the last daemon life that ps could not settle at boot: asked once more at the
 *     stop; still no answer is an error, an answer lets the stop through;
 *   - a straggler row with no start whose pid now runs another worker (its command says acp-worker, its
 *     journal is not this session's): an error, no signal; the session's own journal in argv proves it;
 *   - a surviving worker row with no start (adoption, which the strict stop and every start/op reach first)
 *     whose pid runs another session's worker: never signalled; the session's own journal in argv proves it;
 *   - a running worker while the strict stop waits on such a straggler: a plain stop's 6 s SIGKILL timer
 *     and a hard abort do nothing to it meanwhile, and the strict stop ends it with SIGTERM only.
 * Real processes: the worker and its adapter are this file's scripts (the adapter ends on SIGTERM or
 * on its release file). The straggler cases stub ps (`processInfo`) and use a pid above any real pid
 * limit, so nothing can answer to it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createAcpDaemon, psProcessInfo, type AcpGroupMember, type AcpProcessInfo } from '../../src/providers/acp-daemon.js'

// Starts the adapter it is given in its own group, answers every op, and exits by itself (no shutdown)
// once its exit file exists.
const WORKER = `
import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'
import { spawn } from 'node:child_process'
const [, , adapter, release, exitFile, adapterPidFile] = process.argv
const journal = process.argv[process.argv.indexOf('--journal') + 1]
fs.mkdirSync(path.dirname(journal), { recursive: true })
if (!fs.existsSync(journal)) fs.writeFileSync(journal, '')
const a = spawn(process.execPath, [adapter, release], { stdio: 'ignore' })
fs.writeFileSync(adapterPidFile, String(a.pid))
a.unref()
const reply = (id, result) => process.stdout.write(JSON.stringify({ id, ok: true, result }) + '\\n')
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const r = JSON.parse(line)
  if (r.op === 'newSession') return reply(r.id, { sessionId: 'strict-provider-session' })
  if (r.op === 'getState') return reply(r.id, { providerSessionId: 'strict-provider-session', turnActive: false, controlActive: false, pendingPermissions: [], capabilities: {} })
  reply(r.id, {})
})
setInterval(() => { if (fs.existsSync(exitFile)) process.exit(0) }, 20)
setTimeout(() => process.exit(0), 60000)
`
// Ends on SIGTERM (the default action), on its release file, or after 60 s.
const ADAPTER = `
const fs = require('fs')
const release = process.argv[2]
setInterval(() => { if (fs.existsSync(release)) process.exit(0) }, 20)
setTimeout(() => process.exit(0), 60000)
`

interface FakeWs { open: boolean; frames: Array<Record<string, unknown>> }
let dir = ''
const adapterPids: number[] = []
const alive = (pid: number) => { try { process.kill(pid, 0); return true } catch { return false } }
async function until(check: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms
  while (!check() && Date.now() < end) await new Promise((r) => setTimeout(r, 20))
  return check()
}
beforeEach(() => { dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'acp-strict-'))) })
afterEach(async () => {
  // Whatever a case left: the adapter ends on its release file; the dir goes once it has.
  fs.writeFileSync(path.join(dir, 'release'), '')
  for (const pid of adapterPids.splice(0)) expect(await until(() => !alive(pid), 10_000), 'the adapter exited').toBe(true)
  fs.rmSync(dir, { recursive: true, force: true })
})

function daemon(extra: { groupMembers?: (pgid: number) => Promise<AcpGroupMember[] | null>; processInfo?: (pid: number) => Promise<AcpProcessInfo>; bootMinute?: () => number } = {}) {
  return createAcpDaemon<FakeWs>({
    streamsDir: path.join(dir, 'streams'), daemonDir: path.join(dir, 'daemon'),
    sendEvent: (ws, ev, data) => { ws.frames.push({ ev, ...data }) }, isWsOpen: (ws) => ws.open, log: () => {},
    setIntervalFn: ((fn: () => void) => { const t = setInterval(fn, 60_000); t.unref(); return t }) as typeof setInterval,
    ...extra,
  })
}

/** A worker whose adapter is running, then the worker exits by itself: its group lives on with the adapter. */
async function workerThatLeftItsAdapter(acp: ReturnType<typeof daemon>, sid: string) {
  const worker = path.join(dir, 'worker.mjs')
  const adapter = path.join(dir, 'adapter.cjs')
  fs.writeFileSync(worker, WORKER)
  fs.writeFileSync(adapter, ADAPTER)
  const exitFile = path.join(dir, 'worker-exit')
  const adapterPidFile = path.join(dir, 'adapter.pid')
  const started = await acp.acpStart({ open: true, frames: [] }, {
    sid, cwd: dir,
    workerCmd: [process.execPath, worker, adapter, path.join(dir, 'release'), exitFile, adapterPidFile],
    // What the daemon records as the worker's adapter (its first two words): what ps must show.
    adapterCmd: [process.execPath, adapter],
  })
  expect(started.ok).toBe(true)
  expect(await until(() => fs.existsSync(adapterPidFile), 5_000)).toBe(true)
  const adapterPid = Number(fs.readFileSync(adapterPidFile, 'utf8'))
  adapterPids.push(adapterPid)
  fs.writeFileSync(exitFile, '')
  expect(await until(() => !acp.hasWorker(sid), 10_000), 'the worker exited by itself').toBe(true)
  expect(alive(adapterPid)).toBe(true)
  return adapterPid
}

describe('a strict ACP stop with no running worker', () => {
  it('ends the group a worker left (its adapter) with SIGTERM once ps proves the group (a member from before the exit)', async () => {
    const acp = daemon()
    const adapterPid = await workerThatLeftItsAdapter(acp, 'rt-left-1')
    expect(acp.heldBy('rt-left-1')).toEqual({ pid: expect.any(Number) })
    await acp.acpStop('rt-left-1', { strict: true })
    expect(alive(adapterPid)).toBe(false)
    expect(acp.heldBy('rt-left-1')).toBeNull()
    // A plain stop of the same left group is what it was: it does not look at it.
    await acp.acpStop('rt-left-1')
  }, 30_000)

  it('refuses, and signals nothing, when no member of that group started before the worker was seen gone, or ps gives no answer', async () => {
    let members: AcpGroupMember[] | null = []
    const acp = daemon({ groupMembers: async () => members })
    const adapterPid = await workerThatLeftItsAdapter(acp, 'rt-left-2')
    const notProved = /is not proved to be this worker's any more, not signalled/
    await expect(acp.acpStop('rt-left-2', { strict: true })).rejects.toThrow(notProved)
    expect(alive(adapterPid)).toBe(true)
    // The adapter's very command, but started after the worker was seen gone: a group of a reused id, not this one.
    const adapter = path.join(dir, 'adapter.cjs')
    members = [{ start: new Date(Date.now() + 60_000).toString().slice(0, 24), command: `${process.execPath} ${adapter}` }]
    await expect(acp.acpStop('rt-left-2', { strict: true })).rejects.toThrow(notProved)
    expect(alive(adapterPid)).toBe(true)
    members = null
    await expect(acp.acpStop('rt-left-2', { strict: true })).rejects.toThrow(/ps gave no answer about its process group .*not signalled/)
    expect(alive(adapterPid)).toBe(true)
    expect(acp.heldBy('rt-left-2')).not.toBeNull()
    // Once the group is gone by itself, the record goes and the stop answers.
    fs.writeFileSync(path.join(dir, 'release'), '')
    expect(await until(() => !alive(adapterPid), 10_000)).toBe(true)
    await until(() => acp.heldBy('rt-left-2') === null, 5_000)
    await acp.acpStop('rt-left-2', { strict: true })
    expect(acp.heldBy('rt-left-2')).toBeNull()
  }, 30_000)
})

describe('a strict ACP stop of a group read back from the pid file', () => {
  it('never signals it: its id is not proved to be the worker\'s group any more (no start, no exit seen in this life)', async () => {
    // A stopped worker's group the last daemon life kept as stop evidence; here a group that this file leads.
    const adapter = path.join(dir, 'adapter.cjs')
    fs.writeFileSync(adapter, ADAPTER)
    const { spawn } = await import('node:child_process')
    const child = spawn(process.execPath, [adapter, path.join(dir, 'release')], { detached: true, stdio: 'ignore' })
    child.unref()
    const pid = child.pid!
    adapterPids.push(pid)
    fs.mkdirSync(path.join(dir, 'daemon'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'daemon', 'acp-workers.json'), JSON.stringify({ 'rt-evidence': { pid, cmd: 'worker.mjs', adapter: `${process.execPath} ${adapter}`, boot: 1000, stopping: true } }))
    const acp = daemon({ bootMinute: () => 1000 })
    await acp.startupRepair()
    expect(acp.heldBy('rt-evidence')).toEqual({ pid })
    await expect(acp.acpStop('rt-evidence', { strict: true })).rejects.toThrow(/is not proved to be this worker's any more, not signalled/)
    expect(alive(pid)).toBe(true)
  }, 30_000)
})

describe('a strict ACP stop of a straggler the boot sweep could not settle', () => {
  // Above any real pid limit: nothing can answer to it, and the stubbed ps never says it is alive.
  const PID = 2 ** 22 + 23
  const writeRow = () => {
    fs.mkdirSync(path.join(dir, 'daemon'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'daemon', 'acp-workers.json'), JSON.stringify({ 'rt-straggler': { pid: PID, cmd: 'acp-worker', boot: 1000 } }))
  }

  it('asks ps once more at the stop: still no answer is an error, an answer lets it through', async () => {
    writeRow()
    let answers: AcpProcessInfo[] = [{ state: 'unknown' }, { state: 'unknown' }, { state: 'gone' }]
    const asked: number[] = []
    const acp = daemon({ bootMinute: () => 1000, processInfo: async (pid) => { asked.push(pid); return answers.shift() ?? { state: 'gone' } } })
    await acp.startupRepair()
    expect(asked).toEqual([PID])
    expect(acp.heldBy('rt-straggler')).not.toBeNull()
    await expect(acp.acpStop('rt-straggler', { strict: true })).rejects.toThrow(/could not be checked \(ps gave no answer\)/)
    expect(asked).toEqual([PID, PID])
    await acp.acpStop('rt-straggler', { strict: true })
    expect(asked).toEqual([PID, PID, PID])
    expect(acp.heldBy('rt-straggler')).toBeNull()
    answers = []
  })

  it('a straggler the sweep settled is no longer held', async () => {
    writeRow()
    const acp = daemon({ bootMinute: () => 1000, processInfo: async () => ({ state: 'gone' }) })
    await acp.startupRepair()
    await until(() => acp.heldBy('rt-straggler') === null, 1_000)
    expect(acp.heldBy('rt-straggler')).toBeNull()
    await acp.acpStop('rt-straggler', { strict: true })
  })
})

/** A detached process (it leads its own group) whose command is `acp-worker.cjs --journal <journal>`. */
async function workerLookalike(journal: string): Promise<number> {
  const script = path.join(dir, 'acp-worker.cjs')
  fs.writeFileSync(script, ADAPTER)
  const { spawn } = await import('node:child_process')
  const child = spawn(process.execPath, [script, path.join(dir, 'release'), '--journal', journal], { detached: true, stdio: 'ignore' })
  child.unref()
  adapterPids.push(child.pid!)
  expect(await until(() => alive(child.pid!), 2_000)).toBe(true)
  return child.pid!
}

describe('a strict ACP stop of a straggler row with no start time', () => {
  it('signals nothing and errors when the pid now runs another worker; the session\'s own journal in argv proves it', async () => {
    // Worker B of another session (or another Walnut) on the pid worker A had: a bare-number legacy row and a row
    // whose ps was slow at spawn (no start) both name it.
    const foreign = await workerLookalike(path.join(dir, 'other-walnut', 'streams', 'rt-other.acp.jsonl'))
    const own = await workerLookalike(path.join(dir, 'streams', 'rt-own.acp.jsonl'))
    fs.mkdirSync(path.join(dir, 'daemon'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'daemon', 'acp-workers.json'), JSON.stringify({
      'rt-legacy': foreign,
      'rt-nostart': { pid: foreign, cmd: 'acp-worker', boot: 1000 },
      'rt-own': { pid: own, cmd: 'acp-worker', boot: 1000 },
    }))
    // ps gives no answer at the boot sweep (the rows stay unsettled stragglers); the real ps at the stop.
    let boot = true
    const acp = daemon({ bootMinute: () => 1000, processInfo: async (pid) => boot ? { state: 'unknown' } : psProcessInfo(pid) })
    await acp.startupRepair()
    boot = false
    const kill = vi.spyOn(process, 'kill')
    try {
      for (const sid of ['rt-legacy', 'rt-nostart']) {
        expect(acp.heldBy(sid)).toEqual({ pid: foreign })
        await expect(acp.acpStop(sid, { strict: true })).rejects.toThrow(/is not proved to be process \d+ .*not signalled/)
        expect(alive(foreign)).toBe(true)
        expect(acp.heldBy(sid)).not.toBeNull()
      }
      expect(kill.mock.calls.filter(([, signal]) => signal !== 0 && signal !== undefined)).toEqual([])
      // The row's own session: its journal is in the process's command, so it is proved and gets one SIGTERM.
      await acp.acpStop('rt-own', { strict: true })
      expect(alive(own)).toBe(false)
      expect(acp.heldBy('rt-own')).toBeNull()
      expect(kill.mock.calls.filter(([, signal]) => signal !== 0 && signal !== undefined)).toEqual([[-own, 'SIGTERM']])
    } finally { kill.mockRestore() }
  }, 30_000)
})

describe('a surviving worker row with no start time (adoption, reached by a strict stop or any start/op)', () => {
  it('signals nothing when the reused pid runs another session\'s worker; the session\'s own journal in argv proves it', async () => {
    const foreign = await workerLookalike(path.join(dir, 'other-walnut', 'streams', 'rt-other.acp.jsonl'))
    const own = await workerLookalike(path.join(dir, 'streams', 'rt-own.acp.jsonl'))
    fs.mkdirSync(path.join(dir, 'daemon'), { recursive: true })
    // Rows the last daemon life wrote a few ms after the spawn (no start yet), on this boot, survive workers.
    fs.writeFileSync(path.join(dir, 'daemon', 'acp-workers.json'), JSON.stringify({
      'rt-nostart': { pid: foreign, cmd: 'acp-worker', boot: 1000, survive: true },
      'rt-own': { pid: own, cmd: 'acp-worker', boot: 1000, survive: true },
    }))
    // ps gives no answer at boot, so both adoptions stay open and the strict stop's own look adopts them.
    let boot = true
    const acp = daemon({ bootMinute: () => 1000, processInfo: async (pid) => boot ? { state: 'unknown' } : psProcessInfo(pid) })
    await acp.startupRepair()
    boot = false
    const kill = vi.spyOn(process, 'kill')
    try {
      await acp.acpStop('rt-nostart', { strict: true })
      expect(alive(foreign)).toBe(true)
      expect(kill.mock.calls.filter(([, signal]) => signal !== 0 && signal !== undefined)).toEqual([])
      await acp.acpStop('rt-own', { strict: true })
      expect(await until(() => !alive(own), 10_000)).toBe(true)
      expect(kill.mock.calls.some(([pid, signal]) => pid === -own && signal === 'SIGTERM')).toBe(true)
      expect(kill.mock.calls.some(([pid, signal]) => (pid === foreign || pid === -foreign) && signal !== 0 && signal !== undefined)).toBe(false)
    } finally { kill.mockRestore() }
  }, 30_000)
})

describe('a strict ACP stop that waits on a straggler while a worker of the same session runs', () => {
  it('lets no plain-stop SIGKILL timer or hard abort act on the worker during the wait, and ends it with SIGTERM only', async () => {
    const PID = 2 ** 22 + 29
    fs.mkdirSync(path.join(dir, 'daemon'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'daemon', 'acp-workers.json'), JSON.stringify({ 'rt-wait': { pid: PID, cmd: 'acp-worker', boot: 1000 } }))
    // The straggler's ps: no answer at boot, then 8 s for the strict stop's question (past the plain stop's 6 s timer).
    let calls = 0
    const acp = daemon({
      bootMinute: () => 1000,
      processInfo: async (pid) => {
        if (pid !== PID) return psProcessInfo(pid)
        calls += 1
        if (calls === 1) return { state: 'unknown' }
        await new Promise((r) => setTimeout(r, 8_000))
        return { state: 'gone' }
      },
    })
    await acp.startupRepair()
    // A worker of the same session that does not exit on shutdown (it answers every op and runs on).
    const worker = path.join(dir, 'worker.mjs')
    const adapter = path.join(dir, 'adapter.cjs')
    fs.writeFileSync(worker, WORKER)
    fs.writeFileSync(adapter, ADAPTER)
    const adapterPidFile = path.join(dir, 'adapter.pid')
    const started = await acp.acpStart({ open: true, frames: [] }, {
      sid: 'rt-wait', cwd: dir,
      workerCmd: [process.execPath, worker, adapter, path.join(dir, 'release'), path.join(dir, 'never'), adapterPidFile],
      adapterCmd: [process.execPath, adapter],
    })
    expect(started.ok).toBe(true)
    expect(await until(() => fs.existsSync(adapterPidFile), 5_000)).toBe(true)
    const adapterPid = Number(fs.readFileSync(adapterPidFile, 'utf8'))
    adapterPids.push(adapterPid)
    const kill = vi.spyOn(process, 'kill')
    try {
      // A plain stop first: it sends shutdown and arms its 6 s SIGKILL timer.
      await acp.acpStop('rt-wait')
      const strict = acp.acpStop('rt-wait', { strict: true })
      await new Promise((r) => setTimeout(r, 200))
      // A hard abort during the settle is refused, not a SIGKILL.
      const abort = await acp.acpAbortTurn('rt-wait', { hard: true })
      expect(abort).toMatchObject({ ok: false, error: { kind: 'worker_stopping' } })
      await strict
      expect(alive(adapterPid)).toBe(false)
      expect(acp.hasWorker('rt-wait')).toBe(false)
      const signals = kill.mock.calls.filter(([, signal]) => signal !== 0 && signal !== undefined).map(([, signal]) => signal)
      expect(signals).not.toContain('SIGKILL')
      expect(signals).toContain('SIGTERM')
      // Past the 6 s timer and the settle: still nothing was force killed.
      await new Promise((r) => setTimeout(r, 500))
      expect(kill.mock.calls.some(([, signal]) => signal === 'SIGKILL')).toBe(false)
    } finally { kill.mockRestore() }
  }, 40_000)
})
