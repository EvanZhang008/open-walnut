/**
 * A light subagent on an ACP engine end to end: the real daemon binary, the real ACP worker
 * bundle and a mock ACP agent (tests/providers/mock-acp-agent.mjs; only the agent is mocked).
 * run-acp.ts starts a worker under its own runtime id, sets the model, runs the prompt as one
 * turn, returns the answer and stops the worker; a model the engine does not list is refused
 * before any prompt runs; a stop mid-turn cancels the turn and ends the worker.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { spawn, type ChildProcess } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createMockConstants } from '../helpers/mock-constants.js'

const isolated = vi.hoisted(() => {
  const previous = process.env.WALNUT_DAEMON_DIR
  const daemonDir = `/tmp/lsa-e2e-daemon-${process.pid}-${Date.now()}`
  process.env.WALNUT_DAEMON_DIR = daemonDir
  return { daemonDir, previous }
})

vi.mock('../../src/constants.js', () => createMockConstants('walnut-light-subagent-acp'))

import { runAcpLight, _setLightAcpTestWiring } from '../../src/providers/light-subagent-acp.js'
import { LightSubagentError, type LightProgress } from '../../src/core/subagents/types.js'
import { onDaemonEarlyExit } from '../helpers/daemon-early-exit.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
// This machine's compiled daemon (a build makes the darwin and linux files).
const DAEMON_BIN = path.join(ROOT, `dist/daemon-binaries/daemon-${process.platform}-${process.arch}`)
const WORKER = path.join(ROOT, 'dist/daemon-binaries/acp-worker.js')
const MOCK_AGENT = path.join(ROOT, 'tests/providers/mock-acp-agent.mjs')
const HAVE_BIN = fs.existsSync(DAEMON_BIN) && fs.existsSync(WORKER)

let daemon: ChildProcess | null = null
const streams = isolated.daemonDir + '-streams'

function spec(prompt: string, extra: Partial<Parameters<typeof runAcpLight>[0]> = {}) {
  const progress: LightProgress[] = []
  const ctl = new AbortController()
  return {
    progress, ctl,
    spec: {
      runtimeId: `lsa-test-${Math.random().toString(36).slice(2, 10)}`,
      engine: 'opencode' as const, host: '__local__', cwd: os.tmpdir(), prompt, fullAccess: true,
      parentSid: '5ab0a6e1-1111-4bbb-8ccc-dddddddddd01', callerSid: '5ab0a6e1-1111-4bbb-8ccc-dddddddddd01',
      deadlineAt: Date.now() + 10 * 60_000, signal: ctl.signal,
      onProgress: (p: LightProgress) => { progress.push(p) },
      ...extra,
    },
  }
}

function journal(runtimeId: string): Array<{ kind: string; event?: { type?: string; configId?: string; value?: unknown } }> {
  return fs.readFileSync(path.join(streams, `${runtimeId}.acp.jsonl`), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
}

beforeAll(async () => {
  if (!HAVE_BIN) return
  fs.rmSync(isolated.daemonDir, { recursive: true, force: true })
  fs.mkdirSync(isolated.daemonDir, { recursive: true })
  const port = await new Promise<number>((resolve, reject) => {
    const p = spawn(DAEMON_BIN, ['--start'], { env: { ...process.env, WALNUT_DAEMON_DIR: isolated.daemonDir }, stdio: ['ignore', 'pipe', 'pipe'] })
    daemon = p
    const timer = setTimeout(() => reject(new Error('daemon spawn timeout')), 15_000)
    p.stdout!.on('data', (chunk: Buffer) => {
      const m = chunk.toString().match(/^\d+$/m)
      if (m) { clearTimeout(timer); resolve(parseInt(m[0], 10)) }
    })
    onDaemonEarlyExit(p, { daemonDir: isolated.daemonDir }, (err) => { clearTimeout(timer); reject(err) })
  })
  wsUrl = `ws://127.0.0.1:${port}`
  wire()
}, 40_000)

let wsUrl = ''
/** The daemon and mock agent to run on, with this adapter env on top of the runner's own. */
function wire(env?: Record<string, string>): void {
  _setLightAcpTestWiring({ wsUrl, artifacts: { workerCmd: [process.execPath, WORKER], adapterCmd: [process.execPath, MOCK_AGENT] }, ...(env ? { env } : {}) })
}

afterEach(() => { if (HAVE_BIN) wire() })

afterAll(() => {
  _setLightAcpTestWiring(null)
  if (daemon && daemon.exitCode === null) daemon.kill('SIGKILL')
  fs.rmSync(isolated.daemonDir, { recursive: true, force: true })
  fs.rmSync(streams, { recursive: true, force: true })
  if (isolated.previous === undefined) delete process.env.WALNUT_DAEMON_DIR
  else process.env.WALNUT_DAEMON_DIR = isolated.previous
})

describe.runIf(HAVE_BIN)('light subagent on an ACP engine (real daemon and worker, mock agent)', () => {
  it('runs one prompt on the model asked for, streams progress and returns the answer', async () => {
    const t = spec('light hello', { model: 'mock-gpt-fast' })
    const result = await runAcpLight(t.spec)
    expect(result.answer).toBe('hello from mock-acp (you said: light hello)')
    expect(t.progress.some((p) => p.kind === 'text' && p.text.includes('you said'))).toBe(true)
    const records = journal(t.spec.runtimeId)
    expect(records.some((r) => r.kind === 'meta' && r.event?.type === 'config-option-set' && r.event.configId === 'model' && r.event.value === 'mock-gpt-fast')).toBe(true)
    // The full-access preset of the parent.
    expect(records.some((r) => r.kind === 'meta' && r.event?.type === 'config-option-set' && r.event.configId === 'mode' && r.event.value === 'agent-full-access')).toBe(true)
  }, 60_000)

  it('refuses a model the engine does not list, naming what it offers, before any prompt', async () => {
    const t = spec('never sent', { model: 'no-such-model' })
    const err = await runAcpLight(t.spec).catch((e) => e)
    expect(err).toBeInstanceOf(LightSubagentError)
    expect(err.code).toBe('model_unavailable')
    expect(err.message).toContain('mock-gpt-best')
    expect(journal(t.spec.runtimeId).some((r) => r.kind === 'meta' && r.event?.type === 'prompt-accepted')).toBe(false)
  }, 60_000)

  it('a read-only parent gets the read-only preset and its permission asks are refused', async () => {
    const t = spec('permission-test', { fullAccess: false })
    const result = await runAcpLight(t.spec)
    expect(result.answer).toMatch(/permission granted: reject-once$/)
    const records = journal(t.spec.runtimeId)
    expect(records.some((r) => r.kind === 'meta' && r.event?.type === 'config-option-set' && r.event.configId === 'mode' && r.event.value === 'read-only')).toBe(true)
  }, 60_000)

  it('a full-access parent\'s subagent has its permission asks allowed once', async () => {
    const result = await runAcpLight(spec('permission-test').spec)
    expect(result.answer).toMatch(/permission granted: allow-once$/)
  }, 60_000)

  it.each([['a failed prompt', 'error please'], ['a usage limit', 'usage-limit-hit']])('an engine error (%s) fails the run at once, with the engine\'s words', async (_name, prompt) => {
    const started = Date.now()
    const err = await runAcpLight(spec(prompt).spec).catch((e) => e)
    expect(err).toBeInstanceOf(LightSubagentError)
    expect(err.code).toBe('engine_error')
    expect(err.message).toMatch(/^OpenCode: /)
    // Not the run's own limit: it failed when the engine said so.
    expect(Date.now() - started).toBeLessThan(20_000)
  }, 60_000)

  it('a parent without full access is refused when the engine stays in full access, before any prompt', async () => {
    wire({ MOCK_ACP_START_MODE: 'agent-full-access', MOCK_ACP_LOCK_MODE: '1' })
    const t = spec('never sent either', { fullAccess: false })
    const err = await runAcpLight(t.spec).catch((e) => e)
    expect(err).toBeInstanceOf(LightSubagentError)
    expect(err.code).toBe('engine_unavailable')
    expect(err.message).toContain('agent-full-access')
    expect(journal(t.spec.runtimeId).some((r) => r.kind === 'meta' && r.event?.type === 'prompt-accepted')).toBe(false)
  }, 60_000)

  it('an engine that starts in full access is moved to read-only for a parent without it', async () => {
    wire({ MOCK_ACP_START_MODE: 'agent-full-access' })
    const t = spec('light from full', { fullAccess: false })
    expect((await runAcpLight(t.spec)).answer).toContain('light from full')
    expect(journal(t.spec.runtimeId).some((r) => r.kind === 'meta' && r.event?.type === 'config-option-set' && r.event.configId === 'mode' && r.event.value === 'read-only')).toBe(true)
  }, 60_000)

  it('a link that drops mid-run is subscribed again, and the answer written meanwhile is read', async () => {
    const gate = path.join(isolated.daemonDir, `gate-drop-${Date.now()}`)
    const t = spec(`lifecycle-gate ${gate}`)
    const run = runAcpLight(t.spec)
    for (let i = 0; i < 200 && !t.progress.some((p) => p.kind === 'text'); i++) await new Promise((r) => setTimeout(r, 50))
    const { getDirectDaemonConnection } = await import('../../src/providers/daemon-connection.js')
    const conn = await getDirectDaemonConnection('__local__', wsUrl)
    const before = conn.connectionEpoch
    ;(conn as unknown as { ws: { terminate: () => void } }).ws.terminate()
    for (let i = 0; i < 100 && conn.connected; i++) await new Promise((r) => setTimeout(r, 20))
    // The turn ends while nothing watches it.
    fs.writeFileSync(gate, '')
    await new Promise((r) => setTimeout(r, 800))
    await getDirectDaemonConnection('__local__', wsUrl)
    expect(conn.connectionEpoch).not.toBe(before)
    const result = await run
    expect(result.answer).toContain('lifecycle-gate')
  }, 60_000)

  it('a stop while the start is still in flight ends it with no unhandled rejection', async () => {
    const stray: unknown[] = []
    const onStray = (e: unknown) => { stray.push(e) }
    process.on('unhandledRejection', onStray)
    try {
      const t = spec('never prompted')
      const run = runAcpLight(t.spec)
      // The worker is still starting (initialize, session/new).
      setTimeout(() => t.ctl.abort(), 20)
      const err = await run.catch((e) => e)
      expect(err).toBeInstanceOf(LightSubagentError)
      expect(err.message).toBe('The run was stopped')
      await new Promise((r) => setTimeout(r, 500))
      expect(stray).toEqual([])
    } finally {
      process.off('unhandledRejection', onStray)
    }
  }, 60_000)

  it('a daemon without the light bounds is refused before anything is sent to it', async () => {
    const sent: string[] = []
    const old = {
      hasCapability: (c: string) => c === 'acp-host-v1',
      readOnlyRemote: false, connected: true, connectionEpoch: 1,
      send: async (cmd: string) => { sent.push(cmd); return { ok: true } },
      onEvent: () => () => {},
    }
    _setLightAcpTestWiring({ wsUrl, artifacts: { workerCmd: [process.execPath, WORKER], adapterCmd: [process.execPath, MOCK_AGENT] }, conn: old as never })
    const err = await runAcpLight(spec('never sent to an old daemon').spec).catch((e) => e)
    expect(err).toBeInstanceOf(LightSubagentError)
    expect(err.code).toBe('engine_unavailable')
    expect(err.message).toContain('newer Walnut daemon')
    expect(sent).toEqual([])
  }, 30_000)

  it('a stop mid-turn cancels it and ends the worker', async () => {
    const gate = path.join(isolated.daemonDir, `gate-${Date.now()}`)
    const t = spec(`lifecycle-gate ${gate}`)
    const run = runAcpLight(t.spec)
    for (let i = 0; i < 200 && !t.progress.some((p) => p.kind === 'text'); i++) await new Promise((r) => setTimeout(r, 50))
    t.ctl.abort()
    const err = await run.catch((e) => e)
    expect(err).toBeInstanceOf(LightSubagentError)
    expect(err.message).toBe('The run was stopped')
    // The worker is gone: its journal ends with the turn's interruption or the cancel.
    await new Promise((r) => setTimeout(r, 1_000))
    const types = journal(t.spec.runtimeId).filter((r) => r.kind === 'meta').map((r) => r.event?.type)
    expect(types.some((x) => x === 'turn-interrupted' || x === 'turn-ended')).toBe(true)
  }, 60_000)
})
