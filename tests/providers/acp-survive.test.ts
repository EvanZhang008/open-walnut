/**
 * An ACP worker started with `survive` outlives its daemon (src/providers/acp-survive.ts,
 * acp-daemon.ts adoptSurvivor): the daemon is a real process (tests/helpers/acp-daemon-proc.ts),
 * SIGKILLed while a turn runs a tool, and the next daemon on the same dirs adopts the worker.
 * The turn's end is in the journal once (no turn-interrupted), the prompt reached the agent once
 * (no tool ran twice), the same command asked again is the first one's answer, an answer to the
 * dead daemon's request is logged as such, and the next turn runs on the same worker. A worker on
 * stdio dies with its daemon and is repaired as before. A rollback (endForRollback, or the
 * launcher's stop script) ends a surviving worker and closes its turn as interrupted by the rollback.
 *
 * MACHINE SAFETY: temp dirs only; the agent is tests/providers/mock-acp-agent.mjs; every signal
 * goes to a process group this file started.
 */
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline'
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createAcpDaemon } from '../../src/providers/acp-daemon.js'
import { STOP_SCRIPT, registryFile } from '../../src/providers/detached-registry.js'
import { acpWorkerBundle } from '../helpers/acp-worker-bundle.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const MOCK_AGENT = path.join(here, 'mock-acp-agent.mjs')
const PROC = path.join(here, '..', 'helpers', 'acp-daemon-proc.ts')
const WORKER_BUNDLE = acpWorkerBundle()
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-acp-survive-')))
const procs: ChildProcess[] = []
const pids = new Set<number>()
const daemons: Array<ReturnType<typeof createAcpDaemon<FakeWs>>> = []

interface FakeWs { open: boolean; frames: Array<Record<string, unknown>> }
const makeWs = (): FakeWs => ({ open: true, frames: [] })

afterEach(async () => {
  for (const d of daemons.splice(0)) for (const sid of [...d.workers.keys()]) await d.acpStop(sid).catch(() => {})
})
afterAll(() => {
  for (const p of procs) { try { p.kill('SIGKILL') } catch { /* gone */ } }
  for (const pid of pids) if (pid > 1) { try { process.kill(-pid, 'SIGKILL') } catch { /* gone */ } }
  if (root.includes('walnut-acp-survive-')) fs.rmSync(root, { recursive: true, force: true })
})

function dirs(name: string) {
  const base = path.join(root, name)
  const d = { base, streams: path.join(base, 'streams'), daemon: path.join(base, 'daemon'), promptLog: path.join(base, 'prompts.jsonl') }
  fs.mkdirSync(d.streams, { recursive: true }); fs.mkdirSync(d.daemon, { recursive: true })
  return d
}

const params = (d: ReturnType<typeof dirs>, sid: string, survive: boolean) => ({
  sid, cwd: d.base, workerCmd: [process.execPath, WORKER_BUNDLE], adapterCmd: [process.execPath, MOCK_AGENT],
  env: { MOCK_ACP_PROMPT_LOG: d.promptLog, MOCK_ACP_STATUS_TOOL_MS: '2500' }, ...(survive ? { survive: true } : {}),
})

async function daemonProc(d: ReturnType<typeof dirs>) {
  const p = spawn(process.execPath, [PROC, d.streams, d.daemon], { stdio: ['pipe', 'pipe', 'inherit'] })
  procs.push(p)
  const waiting = new Map<number, (m: { value?: unknown; error?: string }) => void>()
  let ready: () => void = () => {}
  const up = new Promise<void>((r) => { ready = r })
  readline.createInterface({ input: p.stdout! }).on('line', (line) => {
    const m = JSON.parse(line) as { id?: number; ready?: boolean; value?: unknown; error?: string }
    if (m.ready) return ready()
    waiting.get(m.id!)?.(m)
  })
  await up
  let n = 0
  const ask = <T = Record<string, unknown>>(msg: Record<string, unknown>): Promise<T> => new Promise((resolve, reject) => {
    const id = ++n
    waiting.set(id, (m) => (m.error ? reject(new Error(m.error)) : resolve(m.value as T)))
    p.stdin!.write(JSON.stringify({ id, ...msg }) + '\n')
  })
  return { ask, kill: async () => { p.kill('SIGKILL'); await new Promise((r) => p.once('exit', r)) } }
}

function inProcess(d: ReturnType<typeof dirs>, logs: Array<{ msg: string; data?: Record<string, unknown> }> = []) {
  const acp = createAcpDaemon<FakeWs>({
    streamsDir: d.streams, daemonDir: d.daemon,
    sendEvent: (ws, ev, data) => { ws.frames.push({ ev, ...data }) }, isWsOpen: (ws) => ws.open,
    log: (_level, msg, data) => { logs.push({ msg, data }) }, strictStop: () => true, abortWaitMs: 150, killGraceMs: 300,
  })
  daemons.push(acp)
  return acp
}

const journal = (d: ReturnType<typeof dirs>, sid: string) => {
  try { return fs.readFileSync(path.join(d.streams, `${sid}.acp.jsonl`), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) } catch { return [] }
}
const metas = (d: ReturnType<typeof dirs>, sid: string, type: string) => journal(d, sid).filter((r) => r.kind === 'meta' && r.event?.type === type)
const prompts = (d: ReturnType<typeof dirs>) => { try { return fs.readFileSync(d.promptLog, 'utf8').trim().split('\n').filter(Boolean) } catch { return [] } }
async function until(f: () => boolean, ms = 15_000) {
  const t0 = Date.now()
  while (!f()) { if (Date.now() - t0 > ms) throw new Error('until: timed out'); await new Promise((r) => setTimeout(r, 30)) }
}
const groupAlive = (pid: number) => { try { process.kill(-pid, 0); return true } catch { return false } }

describe('a surviving ACP worker across a daemon kill', () => {
  it('keeps its turn: the result is in the journal once, the tool ran once, the next turn runs on the same worker', async () => {
    const d = dirs('a')
    const a = await daemonProc(d)
    const started = await a.ask<{ ok: boolean }>({ op: 'start', params: params(d, 'sid-s1', true) })
    expect(started.ok).toBe(true)
    expect(await a.ask({ op: 'holding' })).toEqual({ holding: 0, workers: 1 })
    const pid = (JSON.parse(fs.readFileSync(path.join(d.daemon, 'acp-workers.json'), 'utf8')) as Record<string, { pid: number; survive?: boolean }>)['sid-s1']!
    expect(pid.survive).toBe(true)
    pids.add(pid.pid)
    // The prompt: a tool that runs 2.5 s. The daemon dies while it runs.
    const sent = a.ask({ op: 'op', sid: 'sid-s1', workerOp: 'prompt', params: { commandId: 'acp-prompt:qm-1', walnutMessageId: 'qm-1', text: 'status-slow-tool' } }).catch(() => null)
    void sent
    await until(() => metas(d, 'sid-s1', 'turn-started').length > 0 || metas(d, 'sid-s1', 'prompt-accepted').length > 0)
    // The worker holds its end and made the pipe write-only, as every session's stdin pipe is.
    const fifo = path.join(d.streams, 'sid-s1.acp-in')
    await until(() => (fs.statSync(fifo).mode & 0o777) === 0o200)
    expect(fs.statSync(fifo).mode & 0o777).toBe(0o200)
    await a.kill()
    expect(groupAlive(pid.pid)).toBe(true)
    // The next daemon's startup makes every pipe there write-only (ensureOwnerOnlyStorage): it adopts anyway.
    fs.chmodSync(fifo, 0o200)
    // An update that waits on busy ACP turns never waits for this one.
    const busy = JSON.parse(fs.readFileSync(path.join(d.daemon, 'acp-busy.json'), 'utf8')) as { busySids: string[] }
    expect(busy.busySids).toEqual([])

    const logs: Array<{ msg: string; data?: Record<string, unknown> }> = []
    const b = inProcess(d, logs)
    await b.startupRepair()
    expect(b.workers.get('sid-s1')?.pid).toBe(pid.pid)
    expect(b.holdingWorkers()).toBe(0)
    await until(() => metas(d, 'sid-s1', 'turn-ended').length === 1, 15_000)
    expect(metas(d, 'sid-s1', 'turn-interrupted')).toEqual([])
    // A subscriber after the restart replays the whole turn, its end included.
    const ws = makeWs()
    const start = await b.acpStart(ws, { ...params(d, 'sid-s1', true), fromOffset: 0 })
    expect(start.ok).toBe(true)
    expect((start.result as { alive: boolean }).alive).toBe(true)
    expect(ws.frames.some((f) => f.ev === 'jsonl' && String(f.line).includes('"turn-ended"'))).toBe(true)
    // The same command asked again (a server's resend after the lost answer): never run again.
    const again = await b.acpOp('sid-s1', 'prompt', { commandId: 'acp-prompt:qm-1', walnutMessageId: 'qm-1', text: 'status-slow-tool' })
    expect(again.ok).toBe(true)
    expect(prompts(d)).toHaveLength(1)
    // The next turn runs on the adopted worker.
    const next = await b.acpOp('sid-s1', 'prompt', { commandId: 'acp-prompt:qm-2', walnutMessageId: 'qm-2', text: 'hello again' })
    expect(next.ok).toBe(true)
    await until(() => metas(d, 'sid-s1', 'turn-ended').length === 2)
    expect(prompts(d)).toHaveLength(2)
    expect(b.workers.get('sid-s1')?.pid).toBe(pid.pid)
    // The dead daemon's prompt request was answered into the file: told apart, not taken as this life's.
    expect(logs.some((l) => l.msg === 'acp: answer to a request of an earlier daemon life')).toBe(true)
  }, 60_000)

  it('a worker on stdio (no survive: an older server) dies with its daemon and its turn is repaired, as before', async () => {
    const d = dirs('b')
    const a = await daemonProc(d)
    expect((await a.ask<{ ok: boolean }>({ op: 'start', params: params(d, 'sid-p1', false) })).ok).toBe(true)
    expect(await a.ask({ op: 'holding' })).toEqual({ holding: 1, workers: 1 })
    void a.ask({ op: 'op', sid: 'sid-p1', workerOp: 'prompt', params: { commandId: 'acp-prompt:qm-p', walnutMessageId: 'qm-p', text: 'status-slow-tool' } }).catch(() => null)
    await until(() => metas(d, 'sid-p1', 'turn-started').length > 0 || metas(d, 'sid-p1', 'prompt-accepted').length > 0)
    const row = (JSON.parse(fs.readFileSync(path.join(d.daemon, 'acp-workers.json'), 'utf8')) as Record<string, { pid: number }>)['sid-p1']!
    pids.add(row.pid)
    await a.kill()
    await until(() => !groupAlive(row.pid), 10_000)
    const b = inProcess(d)
    await b.startupRepair()
    expect(b.workers.has('sid-p1')).toBe(false)
    expect(metas(d, "sid-p1", "turn-interrupted")).toHaveLength(1)
  }, 40_000)
})

describe('a rollback ends a surviving worker', () => {
  it('by the daemon (endForRollback): its open turn reads interrupted by the rollback', async () => {
    const d = dirs('c')
    const b = inProcess(d)
    const ws = makeWs()
    expect((await b.acpStart(ws, params(d, 'sid-r1', true))).ok).toBe(true)
    const pid = b.workers.get('sid-r1')!.pid!
    pids.add(pid)
    void b.acpOp('sid-r1', 'prompt', { commandId: 'acp-prompt:qm-r', walnutMessageId: 'qm-r', text: 'status-slow-tool' })
    await until(() => metas(d, 'sid-r1', 'turn-started').length > 0 || metas(d, 'sid-r1', 'prompt-accepted').length > 0)
    expect(await b.endForRollback()).toBe(1)
    expect(groupAlive(pid)).toBe(false)
    expect(b.workers.has('sid-r1')).toBe(false)
    expect(metas(d, 'sid-r1', 'turn-interrupted').map((r) => r.event.reason)).toEqual(['rollback'])
    expect(fs.existsSync(path.join(d.streams, 'sid-r1.acp-in'))).toBe(false)
  }, 40_000)

  it('by the launcher\'s stop script after the daemon crashed: the group ends and the journal says rollback', async () => {
    const d = dirs('e')
    const a = await daemonProc(d)
    expect((await a.ask<{ ok: boolean }>({ op: 'start', params: params(d, 'sid-r2', true) })).ok).toBe(true)
    void a.ask({ op: 'op', sid: 'sid-r2', workerOp: 'prompt', params: { commandId: 'acp-prompt:qm-r2', walnutMessageId: 'qm-r2', text: 'status-slow-tool-long' } }).catch(() => null)
    const regDir = path.join(d.daemon, 'detached')
    const file = registryFile(regDir, 'acp', 'sid-r2')
    // Listed with its open turn (rewritten as the turn starts).
    await until(() => fs.existsSync(file) && fs.readFileSync(file, 'utf8').includes('turn-interrupted'))
    const pid = Number(/^pid=(\d+)$/m.exec(fs.readFileSync(file, 'utf8'))![1])
    pids.add(pid)
    await a.kill()
    const script = path.join(d.base, 'stop-detached.sh')
    fs.writeFileSync(script, STOP_SCRIPT, { mode: 0o700 })
    const r = spawnSync('/bin/sh', [script, regDir], { encoding: 'utf8', timeout: 20_000 })
    expect(r.stdout).toContain(`stopped acp sid-r2 ${pid}`)
    await until(() => !groupAlive(pid), 8_000)
    expect(metas(d, 'sid-r2', 'turn-interrupted').map((x) => x.event.reason)).toEqual(['rollback'])
  }, 40_000)
})
