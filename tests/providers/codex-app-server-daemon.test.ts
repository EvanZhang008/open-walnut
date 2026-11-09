/**
 * The session daemon with a direct Codex worker: a real createAcpDaemon, real
 * detached worker processes (the built worker bundle) and the scripted app-server
 * (tests/providers/mock-codex-app-server.mjs). Covers the stop that keeps the
 * worker, the teardown a restart or a deaf turn still gets, a daemon restart that
 * rejoins the thread, and an app-server that dies.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { createAcpDaemon } from '../../src/providers/acp-daemon.js'
import { CODEX_TRANSPORT_ENV } from '../../src/providers/codex-app-server/transport.js'
import { acpWorkerBundle } from '../helpers/acp-worker-bundle.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const MOCK_CODEX = path.join(__dirname, 'mock-codex-app-server.mjs')
const WORKER_BUNDLE = acpWorkerBundle()

interface FakeWs { open: boolean; frames: Array<Record<string, unknown>> }
const makeWs = (): FakeWs => ({ open: true, frames: [] })

let tmpDir: string
let streamsDir: string
let intervals: Array<ReturnType<typeof setInterval>>
let acp: ReturnType<typeof createAcpDaemon<FakeWs>>

function makeAcp() {
  return createAcpDaemon<FakeWs>({
    streamsDir,
    daemonDir: path.join(tmpDir, 'daemon'),
    sendEvent: (ws, ev, data) => { ws.frames.push({ ev, ...data }) },
    isWsOpen: (ws) => ws.open,
    log: () => {},
    cancelRpcTimeoutMs: 1_000,
    abortWaitMs: 150,
    killGraceMs: 150,
    setIntervalFn: ((fn: () => void, ms: number) => {
      const t = setInterval(fn, Math.min(ms, 200))
      intervals.push(t)
      return t
    }) as typeof setInterval,
  })
}

const logPath = () => path.join(tmpDir, 'codex.jsonl')
type Logged = { pid: number; kind: string; method?: string; params?: Record<string, unknown> }
const codexLog = (): Logged[] => {
  try { return fs.readFileSync(logPath(), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) } catch { return [] }
}
const spawnPids = () => codexLog().filter((e) => e.kind === 'spawn').map((e) => e.pid)
const alive = (pid: number) => { try { process.kill(pid, 0); return true } catch { return false } }

function startParams(sid: string, extra?: Record<string, unknown>) {
  return {
    sid,
    cwd: tmpDir,
    workerCmd: [process.execPath, WORKER_BUNDLE],
    // An older worker would run this; the direct path never does.
    adapterCmd: ['/nonexistent/codex-acp'],
    env: {
      CODEX_PATH: MOCK_CODEX,
      CODEX_HOME: path.join(tmpDir, 'codex-home'),
      MOCK_CODEX_LOG: logPath(),
      [CODEX_TRANSPORT_ENV]: 'app-server',
    },
    ...extra,
  }
}

const journal = (sid: string) => {
  try {
    return fs.readFileSync(path.join(streamsDir, `${sid}.acp.jsonl`), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
  } catch { return [] }
}
const metas = (sid: string) => journal(sid).filter((r) => r.kind === 'meta').map((r) => r.event as { type: string; [k: string]: unknown })

async function waitFor(pred: () => boolean, what: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!pred()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for ' + what)
    await new Promise((r) => setTimeout(r, 30))
  }
}

async function startTurn(sid: string, commandId: string, text: string) {
  const sent = await acp.acpOp(sid, 'prompt', { commandId, walnutMessageId: `m-${commandId}`, text })
  expect(sent.ok, JSON.stringify(sent)).toBe(true)
  await waitFor(() => metas(sid).some((e) => e.type === 'turn-started' && e.commandId === commandId), `turn ${commandId} start`)
}
const turnOver = (sid: string, commandId: string) =>
  metas(sid).some((e) => (e.type === 'turn-ended' || e.type === 'turn-interrupted') && e.commandId === commandId)

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-daemon-'))
  streamsDir = path.join(tmpDir, 'streams')
  fs.mkdirSync(streamsDir, { recursive: true })
  fs.mkdirSync(path.join(tmpDir, 'daemon'), { recursive: true })
  fs.mkdirSync(path.join(tmpDir, 'codex-home'), { recursive: true })
  intervals = []
  acp = makeAcp()
})

afterEach(async () => {
  for (const t of intervals) clearInterval(t)
  for (const sid of [...acp.workers.keys()]) await acp.acpStop(sid)
  for (const pid of spawnPids()) if (alive(pid)) process.kill(pid, 'SIGKILL')
  await new Promise((r) => setTimeout(r, 100))
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe('direct Codex under the daemon', () => {
  it('a stop keeps the worker and its app-server, and the next message runs on them', async () => {
    const ws = makeWs()
    expect((await acp.acpStart(ws, startParams('s1'))).ok).toBe(true)
    const workerPid = acp.workers.get('s1')!.proc.pid
    await startTurn('s1', 'c1', 'SLOW 30000')
    const stop = await acp.acpOp('s1', 'cancel', { commandId: 'x1' })
    expect(stop.result).toMatchObject({ aborted: true, providerClosedTurn: true, workerKept: true })
    await waitFor(() => turnOver('s1', 'c1'), 'turn end')
    expect(metas('s1').find((e) => e.commandId === 'c1' && e.type === 'turn-ended')?.stopReason).toBe('cancelled')
    expect(metas('s1').some((e) => e.type === 'turn-interrupted')).toBe(false)
    expect(acp.workers.get('s1')?.proc.pid).toBe(workerPid)

    await startTurn('s1', 'c2', 'right after the stop')
    await waitFor(() => turnOver('s1', 'c2'), 'second turn')
    expect(spawnPids()).toHaveLength(1)
    expect(metas('s1').filter((e) => e.type === 'error')).toHaveLength(0)
  })

  it('a hard stop (a restart) still tears the worker and its app-server down', async () => {
    const ws = makeWs()
    await acp.acpStart(ws, startParams('s2'))
    await startTurn('s2', 'c1', 'SLOW 30000')
    const [codexPid] = spawnPids()
    const stop = await acp.acpOp('s2', 'cancel', { commandId: 'x1', hard: true })
    expect(stop.ok).toBe(true)
    expect((stop.result as { workerKept?: boolean }).workerKept).toBeUndefined()
    await waitFor(() => !acp.hasWorker('s2'), 'worker reaped')
    await waitFor(() => !alive(codexPid), 'app-server gone')
  })

  it('a turn Codex does not end within the bound falls back to the teardown', async () => {
    const ws = makeWs()
    await acp.acpStart(ws, startParams('s3'))
    await startTurn('s3', 'c1', 'DEAF')
    const [codexPid] = spawnPids()
    const stop = await acp.acpOp('s3', 'cancel', { commandId: 'x1' })
    expect(stop.ok).toBe(true)
    await waitFor(() => !acp.hasWorker('s3'), 'worker reaped')
    await waitFor(() => !alive(codexPid), 'app-server gone')
    // The chat says the stop had to end the process, not only "interrupted by user".
    expect(metas('s3').find((e) => e.type === 'turn-interrupted' && e.commandId === 'c1')?.forced).toBe(true)
  }, 30_000)

  it('after a daemon restart the session rejoins its thread by id', async () => {
    const ws = makeWs()
    const first = await acp.acpStart(ws, startParams('s4'))
    const threadId = (first.result as { session: { sessionId: string } }).session.sessionId
    await startTurn('s4', 'c1', 'hello')
    await waitFor(() => turnOver('s4', 'c1'), 'turn')
    await acp.acpStop('s4')
    for (const t of intervals) clearInterval(t)
    acp = makeAcp()

    const again = await acp.acpStart(makeWs(), startParams('s4', { providerSessionId: threadId }))
    expect(again.ok, JSON.stringify(again)).toBe(true)
    expect((again.result as { state: { providerSessionId: string } }).state.providerSessionId).toBe(threadId)
    const resume = codexLog().filter((e) => e.kind === 'request' && e.method === 'thread/resume')
    expect(resume.at(-1)?.params?.threadId).toBe(threadId)
    expect(metas('s4').some((e) => e.type === 'session-loaded')).toBe(true)
  })

  it('a thread Codex lost is a load_failed with its reason in the journal, so the caller starts a new one visibly', async () => {
    const out = await acp.acpStart(makeWs(), startParams('s5', { providerSessionId: '019a0000-0000-7000-8000-00000000dead' }))
    expect(out.ok).toBe(false)
    expect((out as { errorKind?: string }).errorKind).toBe('load_failed')
    expect(acp.hasWorker('s5')).toBe(true)
    expect(metas('s5').find((e) => e.type === 'resume-failed')?.reason).toMatch(/no saved copy/)
  })

  it('an app-server killed mid-turn ends the turn with a runtime error, and the next start runs a fresh one', async () => {
    const ws = makeWs()
    const first = await acp.acpStart(ws, startParams('s6'))
    const threadId = (first.result as { session: { sessionId: string } }).session.sessionId
    await startTurn('s6', 'c1', 'SLOW 30000')
    const [codexPid] = spawnPids()
    process.kill(codexPid, 'SIGKILL')
    await waitFor(() => turnOver('s6', 'c1'), 'turn over')
    expect(metas('s6').find((e) => e.type === 'error' && e.commandId === 'c1')?.errorKind).toBe('app_server_exited')
    await waitFor(() => !acp.hasWorker('s6'), 'worker gone')

    const again = await acp.acpStart(makeWs(), startParams('s6', { providerSessionId: threadId }))
    expect(again.ok, JSON.stringify(again)).toBe(true)
    expect(spawnPids()).toHaveLength(2)
    await startTurn('s6', 'c2', 'back')
    await waitFor(() => turnOver('s6', 'c2'), 'turn after restart')
  })
})
