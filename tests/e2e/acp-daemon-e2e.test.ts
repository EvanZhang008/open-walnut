/**
 * ACP daemon E2E — spawns the REAL bun-compiled daemon binary and drives the
 * acp* command family over a real WebSocket, with the scripted mock ACP agent
 * as the adapter. Validates the dispatch wiring in daemon-standalone.ts that
 * the acp-daemon unit tests can't see.
 *
 * Covers: acpStart (new session) → acpSend → jsonl push frames → acpState →
 * acpRespond (permission) → daemon kill → restart → startup repair → lazy
 * resume via acpStart(providerSessionId), plus the unified `agent.*` family
 * (one namespace + an engine, routed onto those same handlers) for every ACP
 * engine in the registry.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { WebSocket } from 'ws'
import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { acpEngineIds } from '../../src/core/agents/engine-registry.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(__dirname, '../..')
const DAEMON_BIN = path.join(REPO_ROOT, 'dist/daemon-binaries/daemon-darwin-arm64')
const WORKER_BUNDLE = path.join(REPO_ROOT, 'dist/daemon-binaries/acp-worker.js')
const MOCK_AGENT = path.join(REPO_ROOT, 'tests/providers/mock-acp-agent.mjs')

const HAVE_BIN = fs.existsSync(DAEMON_BIN) && process.platform === 'darwin' && process.arch === 'arm64'

let daemonDir: string
let streamsDir: string
let proc: ChildProcess | null = null
let ws: WebSocket | null = null
let rpcId = 0
const pushed: Array<Record<string, unknown>> = []

async function spawnDaemon(): Promise<number> {
  const p = spawn(DAEMON_BIN, ['--start'], {
    env: { ...process.env, WALNUT_DAEMON_DIR: daemonDir },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  proc = p
  return new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('daemon spawn timeout')), 15_000)
    p.stdout!.on('data', (chunk: Buffer) => {
      const m = chunk.toString().match(/^\d+$/m)
      if (m) { clearTimeout(timer); resolve(parseInt(m[0], 10)) }
    })
    p.on('exit', (code) => { clearTimeout(timer); reject(new Error('daemon exited early: ' + code)) })
  })
}

async function connect(port: number): Promise<void> {
  ws = new WebSocket(`ws://127.0.0.1:${port}`)
  await new Promise<void>((resolve, reject) => {
    ws!.once('open', () => resolve())
    ws!.once('error', reject)
  })
  ws!.on('message', (raw) => {
    const msg = JSON.parse(raw.toString())
    if (msg.ev) pushed.push(msg)
  })
}

function rpc(cmd: string, params: Record<string, unknown> = {}, timeoutMs = 30_000): Promise<Record<string, unknown>> {
  const id = ++rpcId
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`rpc timeout: ${cmd}`)), timeoutMs)
    const onMsg = (raw: Buffer) => {
      const msg = JSON.parse(raw.toString())
      if (msg.id === id) {
        clearTimeout(timer)
        ws!.off('message', onMsg)
        resolve(msg)
      }
    }
    ws!.on('message', onMsg)
    ws!.send(JSON.stringify({ cmd, id, ...params }))
  })
}

async function stopDaemon(): Promise<void> {
  ws?.close(); ws = null
  if (proc && proc.exitCode === null) {
    proc.kill('SIGKILL')
    await new Promise((r) => setTimeout(r, 200))
  }
  proc = null
}

function journalRecords(): Array<{ kind: string; event?: { type?: string } }> {
  return pushed
    .filter((f) => f.ev === 'jsonl' && typeof f.line === 'string')
    .map((f) => JSON.parse(f.line as string))
}

async function waitFor(pred: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!pred()) {
    if (Date.now() > deadline) throw new Error('waitFor timeout')
    await new Promise((r) => setTimeout(r, 40))
  }
}

const startParams = (sid: string, extra: Record<string, unknown> = {}) => ({
  sid,
  cwd: os.tmpdir(),
  workerCmd: [process.execPath, WORKER_BUNDLE],
  adapterCmd: [process.execPath, MOCK_AGENT],
  ...extra,
})

describe.runIf(HAVE_BIN)('ACP daemon E2E (real binary)', () => {
  beforeAll(async () => {
    daemonDir = fs.mkdtempSync(path.join(os.tmpdir(), 'acp-e2e-daemon-'))
    streamsDir = daemonDir + '-streams'
    fs.mkdirSync(streamsDir, { recursive: true, mode: 0o777 })
    fs.chmodSync(daemonDir, 0o777)
    fs.chmodSync(streamsDir, 0o777)
    fs.writeFileSync(path.join(daemonDir, 'legacy-state'), 'state', { mode: 0o666 })
    fs.writeFileSync(path.join(streamsDir, 'legacy-stream'), 'stream', { mode: 0o666 })
    const port = await spawnDaemon()
    await connect(port)
  }, 30_000)

  afterAll(async () => {
    await stopDaemon()
    fs.rmSync(daemonDir, { recursive: true, force: true })
    fs.rmSync(streamsDir, { recursive: true, force: true })
  })

  let providerSessionId: string

  it('hello advertises the acp capability family', async () => {
    const resp = await rpc('hello')
    expect(resp.ok).toBe(true)
    const caps = resp.capabilities as string[]
    for (const c of ['acpStart', 'acpSend', 'acpCancel', 'acpRespond', 'acpState', 'acpStop', 'acpSubscribe']) {
      expect(caps).toContain(c)
    }
  })

  it('repairs daemon and stream storage to owner-only modes', () => {
    expect(fs.statSync(daemonDir).mode & 0o777).toBe(0o700)
    expect(fs.statSync(streamsDir).mode & 0o777).toBe(0o700)
    expect(fs.statSync(path.join(daemonDir, 'legacy-state')).mode & 0o777).toBe(0o600)
    expect(fs.statSync(path.join(streamsDir, 'legacy-stream')).mode & 0o777).toBe(0o600)
    for (const name of ['daemon.port', 'daemon.pid', 'daemon.instance', 'daemon.version']) {
      expect(fs.statSync(path.join(daemonDir, name)).mode & 0o777).toBe(0o600)
    }
  })

  it('acpStart creates a session; acpSend streams; acpState reports', async () => {
    const start = await rpc('acpStart', startParams('e2e-1'))
    expect(start.ok).toBe(true)
    const session = (start as { session?: { sessionId?: string } }).session
    expect(session?.sessionId).toMatch(/^mock-session-/)
    providerSessionId = session!.sessionId!

    const send = await rpc('acpSend', { sid: 'e2e-1', commandId: 'c1', walnutMessageId: 'qm-e2e-1', text: 'hello e2e' })
    expect(send.ok).toBe(true)

    await waitFor(() => journalRecords().some((r) => r.event?.type === 'turn-ended'))
    expect(journalRecords().some((r) => r.kind === 'acp')).toBe(true)

    const state = await rpc('acpState', { sid: 'e2e-1' })
    expect(state.ok).toBe(true)
    const snapshot = (state as { result?: { providerSessionId?: string; turnActive?: boolean } }).result
    expect(snapshot?.providerSessionId).toBe(providerSessionId)
    expect(snapshot?.turnActive).toBe(false)
  })

  it('permission round-trip over the wire', async () => {
    const send = await rpc('acpSend', { sid: 'e2e-1', commandId: 'c2', walnutMessageId: 'qm-e2e-2', text: 'permission-test' })
    expect(send.ok).toBe(true)
    await waitFor(() => journalRecords().some((r) => r.event?.type === 'permission-requested'))

    const state = await rpc('acpState', { sid: 'e2e-1' })
    const pending = (state as { result?: { pendingPermissions?: Array<{ providerRequestId: string }> } }).result?.pendingPermissions
    expect(pending?.length).toBe(1)

    const respond = await rpc('acpRespond', {
      sid: 'e2e-1', commandId: 'c3', providerRequestId: pending![0].providerRequestId, optionId: 'allow-once',
    })
    expect(respond.ok).toBe(true)
    await waitFor(() => journalRecords().filter((r) => r.event?.type === 'turn-ended').length >= 2)
  })

  it('self-report control prompt completes without a visible turn boundary', async () => {
    const before = journalRecords().length
    const sent = await rpc('acpSend', {
      sid: 'e2e-1',
      commandId: 'acp-self-report:e2e',
      control: 'self-report',
      text: 'self-report-test',
    })
    expect(sent.ok).toBe(true)
    await waitFor(() => journalRecords().slice(before)
      .some((record) => record.event?.type === 'control-ended'))

    const records = journalRecords().slice(before) as Array<{
      kind: string
      source?: string
      event?: { type?: string }
      frame?: unknown
    }>
    expect(records.some((record) => record.event?.type === 'prompt-accepted')).toBe(false)
    expect(records.some((record) => record.event?.type === 'turn-ended')).toBe(false)
    expect(records.filter((record) => record.kind === 'acp')
      .every((record) => record.source === 'control')).toBe(true)
  })

  it('acpCancel hard-aborts an ignored-cancel tool descendant and lazy-resumes the provider thread', async () => {
    const childPidFile = path.join(daemonDir, 'abort-child.pid')
    const childHeartbeat = path.join(daemonDir, 'abort-child.heartbeat')
    const start = await rpc('acpStart', startParams('e2e-abort', {
      env: {
        MOCK_ACP_CHILD_PID_FILE: childPidFile,
        MOCK_ACP_CHILD_HEARTBEAT: childHeartbeat,
      },
    }))
    expect(start.ok).toBe(true)
    const abortProviderId = (start as { session?: { sessionId?: string } }).session!.sessionId!

    const send = await rpc('acpSend', {
      sid: 'e2e-abort',
      commandId: 'acp-prompt:qm-e2e-abort',
      walnutMessageId: 'qm-e2e-abort',
      text: 'ignored-cancel-child',
    })
    expect(send.ok).toBe(true)
    await waitFor(() => fs.existsSync(childPidFile) && fs.existsSync(childHeartbeat))
    const childPid = Number(fs.readFileSync(childPidFile, 'utf-8'))

    const cancel = await rpc('acpCancel', { sid: 'e2e-abort', commandId: 'cancel-e2e-abort' })
    expect(cancel.ok).toBe(true)
    await waitFor(() => {
      try { process.kill(childPid, 0); return false } catch { return true }
    })

    const journalPath = path.join(streamsDir, 'e2e-abort.acp.jsonl')
    await waitFor(() => fs.readFileSync(journalPath, 'utf-8').includes('"user-cancelled"'))
    const records = fs.readFileSync(journalPath, 'utf-8').trim().split('\n').map((line) => JSON.parse(line))
    expect(records.filter((record) =>
      record.kind === 'meta'
      && (record.event?.type === 'turn-ended' || record.event?.type === 'turn-interrupted'))
    ).toHaveLength(1)

    const resumed = await rpc('acpStart', startParams('e2e-abort', {
      providerSessionId: abortProviderId,
      fromOffset: fs.statSync(journalPath).size,
    }))
    expect(resumed.ok).toBe(true)
    const state = await rpc('acpState', { sid: 'e2e-abort' })
    expect((state as { result?: { providerSessionId?: string } }).result?.providerSessionId)
      .toBe(abortProviderId)
  }, 30_000)

  it('daemon kill → restart → startup repair closed the interrupted turn → lazy resume works', async () => {
    // Start a slow turn, then SIGKILL the daemon mid-turn.
    await rpc('acpSend', { sid: 'e2e-1', commandId: 'c4', walnutMessageId: 'qm-e2e-4', text: 'slow' })
    await waitFor(() => journalRecords().filter((r) => r.event?.type === 'turn-started').length >= 3)
    await stopDaemon()
    await new Promise((r) => setTimeout(r, 300)) // worker+adapter die with daemon (stdio chain)

    pushed.length = 0
    const port = await spawnDaemon()
    await connect(port)

    // The interrupted turn must be closed in the on-disk journal. Two valid
    // closers: the worker's own stdin-close graceful path (reason:'shutdown' —
    // it wins when the OS gives it a beat after daemon SIGKILL) or the next
    // daemon's startupRepair (reason:'daemon-restart'). Either way, no
    // un-ended turn may survive.
    const journalPath = path.join(streamsDir, 'e2e-1.acp.jsonl')
    await waitFor(() => fs.readFileSync(journalPath, 'utf-8').includes('"turn-interrupted"'))

    // Lazy resume: acpStart with the persisted providerSessionId + replay from 0.
    const start = await rpc('acpStart', startParams('e2e-1', { providerSessionId, fromOffset: 0 }))
    expect(start.ok).toBe(true)
    // Replay delivered the repaired history, including the interruption fact.
    await waitFor(() => journalRecords().some((r) => r.event?.type === 'turn-interrupted'))
    await waitFor(() => journalRecords().some((r) => r.event?.type === 'session-loaded'))

    // And the resumed session takes a new prompt.
    const send = await rpc('acpSend', { sid: 'e2e-1', commandId: 'c5', walnutMessageId: 'qm-e2e-5', text: 'after resume' })
    expect(send.ok).toBe(true)
    await waitFor(() => {
      const ends = journalRecords().filter((r) => r.event?.type === 'turn-ended')
      return ends.length >= 1
    })
  }, 40_000)

  // ── Unified agent.* family (agent-commands-v1) ──
  // The wire test for the ONE namespace: `agent.<op>` + an `engine` field,
  // engine-routed INSIDE the daemon onto the legacy acp*/native handlers. The
  // pure-logic table test (tests/providers/agent-command-map.test.ts) proves the
  // mapping; this proves the daemon actually dispatches through it.
  //
  // Declared last on purpose: these tests create sessions of their own, and the
  // suites above count journal frames across every sid.
  describe('unified agent.* family over the wire', () => {
    /** Journal records for ONE sid (the shared helper spans every session). */
    function recordsForSid(sid: string): Array<{ kind: string; event?: { type?: string; text?: string } }> {
      return pushed
        .filter((f) => f.ev === 'jsonl' && f.sid === sid && typeof f.line === 'string')
        .map((f) => JSON.parse(f.line as string))
    }

    it.each(acpEngineIds())('agent.start routes engine=%s onto the ACP family', async (engine) => {
      const sid = `e2e-agent-${engine}`
      try {
        const start = await rpc('agent.start', { engine, ...startParams(sid) })
        expect(start.ok).toBe(true)
        // Same result shape acpStart answers with: the adapter's own session id.
        const providerSid = (start as { session?: { sessionId?: string } }).session?.sessionId
        expect(providerSid).toMatch(/^mock-session-/)

        const state = await rpc('agent.state', { engine, sid })
        expect(state.ok).toBe(true)
        expect((state as { result?: { providerSessionId?: string; turnActive?: boolean } }).result)
          .toMatchObject({ providerSessionId: providerSid, turnActive: false })
      } finally {
        await rpc('agent.stop', { engine, sid }).catch(() => { /* best effort */ })
      }
    }, 30_000)

    it('agent.send drives a full turn on the routed worker', async () => {
      const engine = acpEngineIds()[0]
      const sid = 'e2e-agent-send'
      try {
        expect((await rpc('agent.start', { engine, ...startParams(sid) })).ok).toBe(true)
        const send = await rpc('agent.send', {
          engine, sid, commandId: 'agent-c1', walnutMessageId: 'qm-agent-1', text: 'hello agent family',
        })
        expect(send.ok).toBe(true)
        await waitFor(() => recordsForSid(sid).some((r) => r.event?.type === 'turn-ended'))
        expect(recordsForSid(sid).some((r) => r.kind === 'acp')).toBe(true)
        expect(recordsForSid(sid).some((r) =>
          r.event?.type === 'prompt-accepted' && r.event?.text === 'hello agent family')).toBe(true)
      } finally {
        await rpc('agent.stop', { engine, sid }).catch(() => { /* best effort */ })
      }
    }, 30_000)

    it('refuses a native-engine op the transport has no command for', async () => {
      const resp = await rpc('agent.respond', {
        engine: 'claude', sid: 'e2e-1', providerRequestId: 'never-issued', optionId: 'allow-once',
      })
      expect(resp.ok).toBe(false)
      expect(resp.errorKind).toBe('agent_op_unsupported')
      expect(String(resp.error)).toContain('agent.respond')
    })
  })
})
