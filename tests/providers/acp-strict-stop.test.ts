/**
 * The ACP daemon's strict stop (acpStop(sid, {strict: true}), a leader switch's stop of a worker in the
 * data home, daemon-session-stop.ts) where no worker runs any more:
 *   - a worker that exited on its own and left its adapter running in its group: the group gets one
 *     SIGTERM once ps shows it still runs that adapter, and the stop answers when it is gone;
 *   - the same group when ps shows no adapter of the worker, or gives no answer: an error, no signal;
 *   - a straggler row of the last daemon life that ps could not settle at boot: asked once more at the
 *     stop; still no answer is an error, an answer lets the stop through.
 * Real processes: the worker and its adapter are this file's scripts (the adapter ends on SIGTERM or
 * on its release file). The straggler cases stub ps (`processInfo`) and use a pid above any real pid
 * limit, so nothing can answer to it.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createAcpDaemon, type AcpProcessInfo } from '../../src/providers/acp-daemon.js'

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

function daemon(extra: { groupCommands?: (pgid: number) => Promise<string[] | null>; processInfo?: (pid: number) => Promise<AcpProcessInfo>; bootMinute?: () => number } = {}) {
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
  it('ends the group a worker left (its adapter) with SIGTERM once ps shows that adapter', async () => {
    const acp = daemon()
    const adapterPid = await workerThatLeftItsAdapter(acp, 'rt-left-1')
    expect(acp.holds('rt-left-1')).toBe(true)
    await acp.acpStop('rt-left-1', { strict: true })
    expect(alive(adapterPid)).toBe(false)
    expect(acp.holds('rt-left-1')).toBe(false)
    // A plain stop of the same left group is what it was: it does not look at it.
    await acp.acpStop('rt-left-1')
  }, 30_000)

  it('refuses, and signals nothing, when ps shows no adapter of the worker in that group or gives no answer', async () => {
    let members: string[] | null = []
    const acp = daemon({ groupCommands: async () => members })
    const adapterPid = await workerThatLeftItsAdapter(acp, 'rt-left-2')
    await expect(acp.acpStop('rt-left-2', { strict: true })).rejects.toThrow(/no longer shows this worker's adapter, not signalled/)
    expect(alive(adapterPid)).toBe(true)
    members = null
    await expect(acp.acpStop('rt-left-2', { strict: true })).rejects.toThrow(/ps gave no answer about its process group .*not signalled/)
    expect(alive(adapterPid)).toBe(true)
    expect(acp.holds('rt-left-2')).toBe(true)
    // Once the group is gone by itself, the record goes and the stop answers.
    fs.writeFileSync(path.join(dir, 'release'), '')
    expect(await until(() => !alive(adapterPid), 10_000)).toBe(true)
    await until(() => !acp.holds('rt-left-2'), 5_000)
    await acp.acpStop('rt-left-2', { strict: true })
    expect(acp.holds('rt-left-2')).toBe(false)
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
    expect(acp.holds('rt-straggler')).toBe(true)
    await expect(acp.acpStop('rt-straggler', { strict: true })).rejects.toThrow(/could not be checked \(ps gave no answer\)/)
    expect(asked).toEqual([PID, PID])
    await acp.acpStop('rt-straggler', { strict: true })
    expect(asked).toEqual([PID, PID, PID])
    expect(acp.holds('rt-straggler')).toBe(false)
    answers = []
  })

  it('a straggler the sweep settled is no longer held', async () => {
    writeRow()
    const acp = daemon({ bootMinute: () => 1000, processInfo: async () => ({ state: 'gone' }) })
    await acp.startupRepair()
    await until(() => !acp.holds('rt-straggler'), 1_000)
    expect(acp.holds('rt-straggler')).toBe(false)
    await acp.acpStop('rt-straggler', { strict: true })
  })
})
