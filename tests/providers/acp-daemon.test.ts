/**
 * ACP daemon supervision tests — real createAcpDaemon with REAL worker child
 * processes (the tsx-run worker-main) and the scripted mock ACP agent.
 * Covers: start/new-session, journal push to subscribers, load-resume,
 * load-failure fallback, stop, crash repair (repairJournalTail semantics),
 * straggler sweep, idle kill.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { createAcpDaemon } from '../../src/providers/acp-daemon.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const MOCK_AGENT = path.join(__dirname, 'mock-acp-agent.mjs')
const HUNG_WORKER = path.join(__dirname, 'mock-hung-acp-worker.mjs')
const REPO_ROOT = path.resolve(__dirname, '../..')
const WORKER_BUNDLE = path.join(REPO_ROOT, 'dist/daemon-binaries/acp-worker.js')

// The bundled worker artifact is required (built by scripts/build-daemon.sh).
// Fail loudly rather than silently skipping — the bundle IS the deploy unit.
if (!fs.existsSync(WORKER_BUNDLE)) {
  throw new Error(`acp-worker bundle missing: ${WORKER_BUNDLE} — run: bash scripts/build-daemon.sh`)
}

/** Fake ws endpoint capturing pushed frames. */
interface FakeWs { open: boolean; frames: Array<Record<string, unknown>> }
const makeWs = (): FakeWs => ({ open: true, frames: [] })

let tmpDir: string
let streamsDir: string
let daemonDir: string
let acp: ReturnType<typeof createAcpDaemon<FakeWs>>
let intervals: Array<ReturnType<typeof setInterval>>

function makeAcp(
  idleKillMs?: number,
  cancelRpcTimeoutMs = 1_000,
  onLog: (level: string, msg: string, data?: Record<string, unknown>) => void = () => {},
) {
  return createAcpDaemon<FakeWs>({
    streamsDir,
    daemonDir,
    sendEvent: (ws, ev, data) => { ws.frames.push({ ev, ...data }) },
    isWsOpen: (ws) => ws.open,
    log: onLog,
    idleKillMs,
    cancelRpcTimeoutMs,
    abortWaitMs: 150,
    killGraceMs: 150,
    setIntervalFn: ((fn: () => void, ms: number) => {
      const t = setInterval(fn, Math.min(ms, 200)) // fast sweep in tests
      intervals.push(t)
      return t
    }) as typeof setInterval,
  })
}

function startParams(sid: string, extra?: Record<string, unknown>) {
  return {
    sid,
    cwd: tmpDir,
    workerCmd: [process.execPath, WORKER_BUNDLE],
    adapterCmd: [process.execPath, MOCK_AGENT],
    ...extra,
  }
}

function journalLines(ws: FakeWs): Array<{
  kind: string
  source?: string
  event?: { type?: string }
  frame?: unknown
}> {
  return ws.frames
    .filter((f) => f.ev === 'jsonl' && typeof f.line === 'string')
    .map((f) => JSON.parse(f.line as string))
}

async function waitFor(pred: () => boolean, timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!pred()) {
    if (Date.now() > deadline) throw new Error('waitFor timeout')
    await new Promise((r) => setTimeout(r, 30))
  }
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'acp-daemon-test-'))
  streamsDir = path.join(tmpDir, 'streams')
  daemonDir = path.join(tmpDir, 'daemon')
  fs.mkdirSync(streamsDir, { recursive: true })
  fs.mkdirSync(daemonDir, { recursive: true })
  intervals = []
  acp = makeAcp()
})

afterEach(async () => {
  for (const t of intervals) clearInterval(t)
  for (const sid of [...acp.workers.keys()]) await acp.acpStop(sid)
  await new Promise((r) => setTimeout(r, 100))
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe('acpStart + streaming', () => {
  it('starts worker, creates session, pushes journal lines to the subscriber', async () => {
    const ws = makeWs()
    const resp = await acp.acpStart(ws, startParams('sid-1'))
    expect(resp.ok).toBe(true)
    const session = (resp.result as { session: { sessionId: string } }).session
    expect(session.sessionId).toMatch(/^mock-session-/)

    const send = await acp.acpOp('sid-1', 'prompt', { commandId: 'c1', walnutMessageId: 'qm-1', text: 'hello' })
    expect(send.ok).toBe(true)

    await waitFor(() => journalLines(ws).some((r) => r.kind === 'meta' && r.event?.type === 'turn-ended'))
    const recs = journalLines(ws)
    expect(recs.some((r) => r.kind === 'acp')).toBe(true)
    // Push frames carry monotonically increasing v (byte offsets).
    const vs = ws.frames.filter((f) => f.ev === 'jsonl').map((f) => f.v as number)
    expect([...vs].sort((a, b) => a - b)).toEqual(vs)
  })

  it('second acpStart on a live worker attaches instead of respawning', async () => {
    const ws1 = makeWs()
    await acp.acpStart(ws1, startParams('sid-2'))
    const pid1 = acp.workers.get('sid-2')!.proc.pid
    const ws2 = makeWs()
    const resp2 = await acp.acpStart(ws2, startParams('sid-2'))
    expect(resp2.ok).toBe(true)
    expect((resp2.result as { alive: boolean }).alive).toBe(true)
    expect(acp.workers.get('sid-2')!.proc.pid).toBe(pid1)
  })

  it('acpSetConfigOption forwards to the worker and updates its model state', async () => {
    const ws = makeWs()
    await acp.acpStart(ws, startParams('sid-config'))
    const switched = await acp.acpOp('sid-config', 'setConfigOption', {
      commandId: 'config-command-1',
      configId: 'model',
      value: 'mock-gpt-fast',
    })
    expect(switched).toMatchObject({
      ok: true,
      result: {
        applied: true,
        configId: 'model',
        value: 'mock-gpt-fast',
      },
    })
    const state = await acp.acpOp('sid-config', 'getState')
    expect(state.result).toMatchObject({
      models: { currentModelId: 'mock-gpt-fast' },
    })
  })

  it('late subscriber with fromOffset=0 replays the full journal', async () => {
    const ws1 = makeWs()
    await acp.acpStart(ws1, startParams('sid-3'))
    await acp.acpOp('sid-3', 'prompt', { commandId: 'c1', walnutMessageId: 'qm-3', text: 'hello' })
    await waitFor(() => journalLines(ws1).some((r) => r.event?.type === 'turn-ended'))

    const ws2 = makeWs()
    expect(acp.subscribe(ws2, 'sid-3', 0)).toBe(true)
    // Replay is synchronous on subscribe.
    const replayed = journalLines(ws2)
    expect(replayed.length).toBeGreaterThan(0)
    expect(replayed.some((r) => r.event?.type === 'turn-ended')).toBe(true)
  })
})

describe('resume paths', () => {
  it('acpStart with providerSessionId loads the session (lazy resume)', async () => {
    const ws = makeWs()
    const resp = await acp.acpStart(ws, startParams('sid-4', { providerSessionId: 'mock-session-77' }))
    expect(resp.ok).toBe(true)
    const recs = journalLines(ws)
    expect(recs.some((r) => r.event?.type === 'session-loaded')).toBe(true)
  })

  it('load failure returns errorKind=load_failed with worker kept alive for fallback newSession', async () => {
    const ws = makeWs()
    const resp = await acp.acpStart(ws, startParams('sid-5', {
      providerSessionId: 'mock-session-1',
      env: { MOCK_ACP_FAIL_LOAD: '1' },
    }))
    expect(resp.ok).toBe(false)
    expect(resp.errorKind).toBe('load_failed')
    expect(acp.hasWorker('sid-5')).toBe(true)
    // Caller decides fallback: newSession on the same live worker.
    const fresh = await acp.acpOp('sid-5', 'newSession', { cwd: tmpDir })
    expect(fresh.ok).toBe(true)
  })
})

describe('MCP mount forwarding', () => {
  const WALNUT_MOUNT = {
    name: 'walnut',
    command: 'open-walnut',
    args: ['mcp'],
    env: [],
  }

  function sessionRequests(logPath: string): Array<{
    method: string
    mcpServers?: unknown
  }> {
    if (!fs.existsSync(logPath)) return []
    return fs.readFileSync(logPath, 'utf-8').trim().split('\n')
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line))
  }

  it('acpStart with no mcpServers keeps the provider mount list empty', async () => {
    const sessionLog = path.join(tmpDir, 'daemon-sessions-default.jsonl')
    const resp = await acp.acpStart(makeWs(), startParams('sid-mcp-off', {
      env: { MOCK_ACP_SESSION_LOG: sessionLog },
    }))
    expect(resp.ok).toBe(true)
    expect(sessionRequests(sessionLog)).toEqual([
      expect.objectContaining({ method: 'session/new', mcpServers: [] }),
    ])
  })

  it('acpStart forwards mcpServers on the newSession path', async () => {
    const sessionLog = path.join(tmpDir, 'daemon-sessions-new.jsonl')
    const resp = await acp.acpStart(makeWs(), startParams('sid-mcp-new', {
      env: { MOCK_ACP_SESSION_LOG: sessionLog },
      mcpServers: [WALNUT_MOUNT],
    }))
    expect(resp.ok).toBe(true)
    expect(sessionRequests(sessionLog)).toEqual([
      expect.objectContaining({ method: 'session/new', mcpServers: [WALNUT_MOUNT] }),
    ])
  })

  it('acpStart forwards mcpServers on the loadSession (cold resume) path too', async () => {
    const sessionLog = path.join(tmpDir, 'daemon-sessions-load.jsonl')
    const resp = await acp.acpStart(makeWs(), startParams('sid-mcp-load', {
      providerSessionId: 'mock-session-mcp-resume',
      env: { MOCK_ACP_SESSION_LOG: sessionLog },
      mcpServers: [WALNUT_MOUNT],
    }))
    expect(resp.ok).toBe(true)
    expect(sessionRequests(sessionLog)).toEqual([
      expect.objectContaining({ method: 'session/load', mcpServers: [WALNUT_MOUNT] }),
    ])
  })
})

describe('lifecycle + repair', () => {
  it('acpStop tears down worker and notifies subscribers with acp_state dead', async () => {
    const ws = makeWs()
    await acp.acpStart(ws, startParams('sid-6'))
    await acp.acpStop('sid-6')
    await waitFor(() => !acp.hasWorker('sid-6'))
    expect(ws.frames.some((f) => f.ev === 'acp_state' && f.state === 'dead')).toBe(true)
  })

  it('worker SIGKILL mid-turn → journal repaired (turn-interrupted) + subscribers notified', async () => {
    const ws = makeWs()
    await acp.acpStart(ws, startParams('sid-7'))
    await acp.acpOp('sid-7', 'prompt', { commandId: 'c1', walnutMessageId: 'qm-7', text: 'permission-test' })
    await waitFor(() => journalLines(ws).some((r) => r.event?.type === 'permission-requested'))

    process.kill(acp.workers.get('sid-7')!.proc.pid!, 'SIGKILL')
    await waitFor(() => !acp.hasWorker('sid-7'))

    const journalPath = path.join(streamsDir, 'sid-7.acp.jsonl')
    const text = fs.readFileSync(journalPath, 'utf-8')
    expect(text).toContain('"turn-interrupted"')
    expect(text).toContain('"permission-auto-cancelled"')
    expect(ws.frames.some((f) => f.ev === 'acp_state' && f.state === 'dead')).toBe(true)
  })

  it('repairs a turn whose opening fact is more than 64 KiB before the journal tail', () => {
    const journalPath = path.join(streamsDir, 'sid-large-repair.acp.jsonl')
    const records = [
      JSON.stringify({
        kind: 'meta',
        ts: 1,
        event: { type: 'turn-started', commandId: 'large-open-turn' },
      }),
      ...Array.from({ length: 90 }, (_, index) => JSON.stringify({
        kind: 'acp',
        ts: index + 2,
        source: 'live',
        frame: { payload: 'x'.repeat(1_024) },
      })),
    ]
    fs.writeFileSync(journalPath, records.join('\n') + '\n')
    expect(fs.statSync(journalPath).size).toBeGreaterThan(64 * 1_024)

    acp.startupRepair()

    const repaired = fs.readFileSync(journalPath, 'utf8').trim().split('\n')
      .map((line) => JSON.parse(line))
    expect(repaired.at(-1)).toMatchObject({
      event: {
        type: 'turn-interrupted',
        reason: 'daemon-restart',
        commandId: 'large-open-turn',
      },
    })
  })

  it('bounds a hung cancel RPC independently from the generic provider timeout', async () => {
    acp = makeAcp(undefined, 80)
    const ws = makeWs()
    const started = await acp.acpStart(ws, {
      ...startParams('sid-hung-cancel'),
      workerCmd: [process.execPath, HUNG_WORKER],
    })
    expect(started.ok).toBe(true)
    const sent = await acp.acpOp('sid-hung-cancel', 'prompt', {
      commandId: 'acp-prompt:qm-hung',
      walnutMessageId: 'qm-hung',
      text: 'hang cancel',
    })
    expect(sent.ok).toBe(true)

    const before = Date.now()
    const aborted = await acp.acpOp('sid-hung-cancel', 'cancel', {
      commandId: 'cancel-hung',
    })
    const elapsed = Date.now() - before

    expect(aborted.ok).toBe(true)
    expect(elapsed).toBeLessThan(1_500)
    expect(acp.hasWorker('sid-hung-cancel')).toBe(false)
  })

  it('does not append a synthetic terminal when the provider closes during process-group termination', async () => {
    acp = makeAcp(undefined, 50)
    const ws = makeWs()
    const started = await acp.acpStart(ws, {
      ...startParams('sid-terminal-kill-race'),
      workerCmd: [process.execPath, HUNG_WORKER],
      env: { MOCK_TERMINAL_ON_SIGTERM: '1' },
    })
    expect(started.ok).toBe(true)
    expect((await acp.acpOp('sid-terminal-kill-race', 'prompt', {
      commandId: 'acp-prompt:qm-terminal-kill-race',
      walnutMessageId: 'qm-terminal-kill-race',
      text: 'terminal during kill',
    })).ok).toBe(true)

    const aborted = await acp.acpOp('sid-terminal-kill-race', 'cancel', {
      commandId: 'cancel-terminal-kill-race',
    })

    expect(aborted.ok).toBe(true)
    expect(aborted.result).toMatchObject({ providerClosedTurn: true })
    const records = fs.readFileSync(
      path.join(streamsDir, 'sid-terminal-kill-race.acp.jsonl'),
      'utf-8',
    ).trim().split('\n').map((line) => JSON.parse(line))
    expect(records.filter((record) =>
      record.kind === 'meta'
      && (record.event?.type === 'turn-ended'
        || record.event?.type === 'turn-interrupted')))
      .toEqual([
        expect.objectContaining({
          event: expect.objectContaining({
            type: 'turn-ended',
            commandId: 'acp-prompt:qm-terminal-kill-race',
          }),
        }),
      ])
  })

  it('hard abort kills the detached worker process group and lazy-resumes the same provider session', async () => {
    const ws = makeWs()
    const childPidFile = path.join(tmpDir, 'tool-child.pid')
    const childHeartbeat = path.join(tmpDir, 'tool-child.heartbeat')
    const promptLog = path.join(tmpDir, 'prompt-log.jsonl')
    const started = await acp.acpStart(ws, startParams('sid-abort', {
      env: {
        MOCK_ACP_CHILD_PID_FILE: childPidFile,
        MOCK_ACP_CHILD_HEARTBEAT: childHeartbeat,
        MOCK_ACP_PROMPT_LOG: promptLog,
      },
    }))
    expect(started.ok).toBe(true)
    const providerSessionId = (
      (started.result as { session: { sessionId: string } }).session
    ).sessionId
    const workerPid = acp.workers.get('sid-abort')!.proc.pid!

    // Detached worker is its process-group leader; adapter + tool inherit it.
    expect(() => process.kill(-workerPid, 0)).not.toThrow()

    const send = await acp.acpOp('sid-abort', 'prompt', {
      commandId: 'acp-prompt:qm-abort',
      walnutMessageId: 'qm-abort',
      text: 'ignored-cancel-child',
    })
    expect(send.ok).toBe(true)
    await waitFor(() => fs.existsSync(childPidFile) && fs.existsSync(childHeartbeat))
    const childPid = Number(fs.readFileSync(childPidFile, 'utf-8'))

    const abort = await acp.acpOp('sid-abort', 'cancel', { commandId: 'cancel-abort' })
    expect(abort.ok).toBe(true)
    await waitFor(() => !acp.hasWorker('sid-abort'))
    await waitFor(() => {
      try { process.kill(childPid, 0); return false } catch { return true }
    })

    const journalPath = path.join(streamsDir, 'sid-abort.acp.jsonl')
    const records = fs.readFileSync(journalPath, 'utf-8').trim().split('\n').map((line) => JSON.parse(line))
    const boundaries = records.filter((record) =>
      record.kind === 'meta'
      && (record.event?.type === 'turn-ended' || record.event?.type === 'turn-interrupted'))
    expect(boundaries).toHaveLength(1)
    expect(boundaries[0]).toMatchObject({
      event: { type: 'turn-interrupted', reason: 'user-cancelled' },
    })

    const resumed = await acp.acpStart(ws, startParams('sid-abort', {
      providerSessionId,
      fromOffset: fs.statSync(journalPath).size,
      env: { MOCK_ACP_PROMPT_LOG: promptLog },
    }))
    expect(resumed.ok).toBe(true)
    const state = (resumed.result as { state: { providerSessionId: string } }).state
    expect(state.providerSessionId).toBe(providerSessionId)
    expect(journalLines(ws).some((record) =>
      record.kind === 'meta' && record.event?.type === 'session-loaded')).toBe(true)

    const replacement = await acp.acpOp('sid-abort', 'prompt', {
      commandId: 'acp-prompt:qm-replacement',
      walnutMessageId: 'qm-replacement',
      text: 'replacement',
    })
    expect(replacement.ok).toBe(true)
    await waitFor(() => {
      const text = fs.readFileSync(journalPath, 'utf-8')
      return text.includes('"commandId":"acp-prompt:qm-replacement"')
        && text.includes('"turn-ended"')
    })
    expect(fs.readFileSync(promptLog, 'utf-8').trim().split('\n')).toHaveLength(2)
  })

  it('self-report control prompt stays out of user-turn facts and completes over the journal', async () => {
    const ws = makeWs()
    await acp.acpStart(ws, startParams('sid-control'))
    const sent = await acp.acpOp('sid-control', 'prompt', {
      commandId: 'acp-self-report:daemon',
      control: 'self-report',
      text: 'self-report-test',
    })
    expect(sent.ok).toBe(true)
    await waitFor(() => journalLines(ws).some((record) =>
      record.event?.type === 'control-ended'))

    const records = journalLines(ws)
    expect(records.some((record) => record.event?.type === 'prompt-accepted')).toBe(false)
    expect(records.some((record) => record.event?.type === 'turn-started')).toBe(false)
    const frames = records.filter((record) => record.kind === 'acp')
    expect(frames.length).toBeGreaterThan(0)
    expect(frames.every((record) => record.source === 'control')).toBe(true)
    const report = frames.map((record) => {
      const frame = record.frame as {
        params?: { update?: { content?: { text?: string } } }
      }
      return frame.params?.update?.content?.text ?? ''
    }).join('')
    expect(report).toContain('deterministic self report')
  })

  it('startupRepair closes un-ended turns and pending permissions in orphaned journals', async () => {
    // Simulate a journal left by a previous daemon life: turn open, permission pending.
    const journalPath = path.join(streamsDir, 'sid-old.acp.jsonl')
    const lines = [
      { kind: 'meta', ts: 1, event: { type: 'turn-started', commandId: 'c9' } },
      { kind: 'meta', ts: 2, event: { type: 'permission-requested', providerRequestId: 'perm-1' } },
    ].map((r) => JSON.stringify(r)).join('\n') + '\n'
    fs.writeFileSync(journalPath, lines)
    // Straggler pid entry pointing at a dead pid.
    fs.writeFileSync(path.join(daemonDir, 'acp-workers.json'), JSON.stringify({ 'sid-old': 999999 }))

    acp.startupRepair()

    const text = fs.readFileSync(journalPath, 'utf-8')
    expect(text).toContain('"turn-interrupted"')
    expect(text).toContain('"daemon-restart"')
    expect(text).toContain('"permission-auto-cancelled"')
    // pid file reset.
    expect(fs.readFileSync(path.join(daemonDir, 'acp-workers.json'), 'utf-8')).toBe('{}')
  })

  it('worker recovery after daemon repair records acceptance without reopening or duplicating the terminal', async () => {
    const sid = 'sid-composed-repair'
    const commandId = 'acp-prompt:qm-composed-repair'
    const promptLog = path.join(tmpDir, 'composed-repair-prompts.jsonl')
    const journalPath = path.join(streamsDir, sid + '.acp.jsonl')
    fs.writeFileSync(journalPath, [
      {
        kind: 'meta',
        ts: 1,
        event: {
          type: 'prompt-intent',
          commandId,
          walnutMessageId: 'qm-composed-repair',
          text: 'already dispatched before crash',
        },
      },
      {
        kind: 'meta',
        ts: 2,
        event: { type: 'prompt-dispatched', commandId },
      },
    ].map((record) => JSON.stringify(record)).join('\n') + '\n')

    acp.startupRepair()
    const resumed = await acp.acpStart(makeWs(), startParams(sid, {
      providerSessionId: 'provider-composed-repair',
      env: { MOCK_ACP_PROMPT_LOG: promptLog },
    }))
    expect(resumed.ok).toBe(true)
    const retry = await acp.acpOp(sid, 'prompt', {
      commandId,
      walnutMessageId: 'qm-composed-repair',
      text: 'already dispatched before crash',
    })
    expect(retry.ok).toBe(true)
    expect(fs.existsSync(promptLog)).toBe(false)

    const lifecycle = fs.readFileSync(journalPath, 'utf-8').trim().split('\n')
      .map((line) => JSON.parse(line))
      .filter((record) => record.kind === 'meta'
        && record.event?.commandId === commandId)
      .map((record) => record.event.type)
    expect(lifecycle).toEqual([
      'prompt-intent',
      'prompt-dispatched',
      'turn-interrupted',
      'prompt-accepted',
    ])
  })

  it('startupRepair is a no-op for cleanly closed journals', async () => {
    const journalPath = path.join(streamsDir, 'sid-clean.acp.jsonl')
    const lines = [
      { kind: 'meta', ts: 1, event: { type: 'turn-started', commandId: 'c1' } },
      { kind: 'meta', ts: 2, event: { type: 'turn-ended', commandId: 'c1', stopReason: 'end_turn' } },
    ].map((r) => JSON.stringify(r)).join('\n') + '\n'
    fs.writeFileSync(journalPath, lines)
    acp.startupRepair()
    expect(fs.readFileSync(journalPath, 'utf-8')).toBe(lines)
  })

  it('repairs ACP storage modes and never logs raw adapter stderr', async () => {
    for (const timer of intervals) clearInterval(timer)
    intervals = []
    fs.chmodSync(streamsDir, 0o777)
    fs.chmodSync(daemonDir, 0o777)
    const pidFile = path.join(daemonDir, 'acp-workers.json')
    fs.writeFileSync(pidFile, '{}', { mode: 0o666 })
    const logs: Array<{ msg: string; data?: Record<string, unknown> }> = []
    acp = makeAcp(undefined, 1_000, (_level, msg, data) => {
      logs.push({ msg, data })
    })

    expect(fs.statSync(streamsDir).mode & 0o777).toBe(0o700)
    expect(fs.statSync(daemonDir).mode & 0o777).toBe(0o700)
    expect(fs.statSync(pidFile).mode & 0o777).toBe(0o600)

    const secret = 'secret-token-must-not-persist'
    const sid = 'sid-private-stderr'
    const journalPath = path.join(streamsDir, sid + '.acp.jsonl')
    fs.writeFileSync(journalPath, '', { mode: 0o666 })
    expect((await acp.acpStart(makeWs(), startParams(sid, {
      env: { MOCK_ACP_STDERR_SECRET: secret },
    }))).ok).toBe(true)
    await waitFor(() => logs.some((entry) => entry.msg === 'acp worker stderr'))

    const serializedLogs = JSON.stringify(logs)
    expect(serializedLogs).not.toContain(secret)
    expect(serializedLogs).not.toContain('adapter auth diagnostic')
    expect(logs.find((entry) => entry.msg === 'acp worker stderr')?.data)
      .toEqual(expect.objectContaining({ sid, bytes: expect.any(Number) }))
    expect(fs.statSync(journalPath).mode & 0o777).toBe(0o600)
    expect(fs.readFileSync(journalPath, 'utf-8')).not.toContain(secret)
  })

  it('idle worker is reaped by the sweep', async () => {
    for (const t of intervals) clearInterval(t)
    intervals = []
    acp = makeAcp(300) // idle kill after 300ms
    const ws = makeWs()
    await acp.acpStart(ws, startParams('sid-8'))
    expect(acp.hasWorker('sid-8')).toBe(true)
    await waitFor(() => !acp.hasWorker('sid-8'), 10_000)
  })

  it('a turn parked on a permission request is NOT idle-killed', async () => {
    for (const t of intervals) clearInterval(t)
    intervals = []
    acp = makeAcp(300) // same 300ms idle budget as the reap test above
    const ws = makeWs()
    await acp.acpStart(ws, startParams('sid-perm-idle'))
    // Open a turn that parks on session/request_permission and never answers —
    // zero journal/RPC traffic from here on, exactly like a user away from
    // the keyboard with an approval card up.
    const sendResp = await acp.acpOp('sid-perm-idle', 'prompt', {
      commandId: 'cmd-perm-idle',
      walnutMessageId: 'qm-perm-idle',
      text: 'permission-test',
    })
    expect(sendResp.ok).toBe(true)
    await waitFor(() => journalLines(ws).some(
      (l) => l.kind === 'meta' && l.event?.type === 'permission-requested',
    ), 10_000)
    // Idle budget elapses many times over; the open turn must hold the worker.
    await new Promise((r) => setTimeout(r, 1_200))
    expect(acp.hasWorker('sid-perm-idle')).toBe(true)
    // The open turn is advertised for the upgrade-defer guard (local-daemon /
    // daemon-connection read this before a version-mismatch restart).
    const busy = JSON.parse(fs.readFileSync(path.join(daemonDir, 'acp-busy.json'), 'utf-8')) as {
      busySids: string[]
      updatedAt: number
    }
    expect(busy.busySids).toContain('sid-perm-idle')
    // Answer the permission → turn ends → worker becomes reapable again.
    const journal = () => journalLines(ws)
    const permLine = journal().find(
      (l) => l.kind === 'meta' && l.event?.type === 'permission-requested',
    ) as { event?: { providerRequestId?: string } } | undefined
    const permId = permLine?.event?.providerRequestId
    expect(permId).toBeTruthy()
    const respond = await acp.acpOp('sid-perm-idle', 'permissionResponse', {
      commandId: 'cmd-perm-answer',
      providerRequestId: permId,
      optionId: 'allow-once',
    })
    expect(respond.ok).toBe(true)
    await waitFor(() => journal().some(
      (l) => l.kind === 'meta' && l.event?.type === 'turn-ended',
    ), 10_000)
    await waitFor(() => !acp.hasWorker('sid-perm-idle'), 10_000)
  })

  it('acpOp on unknown sid → no_worker errorKind', async () => {
    const resp = await acp.acpOp('sid-none', 'prompt', { commandId: 'c1', walnutMessageId: 'qm-none', text: 'x' })
    expect(resp.ok).toBe(false)
    expect(resp.error?.kind).toBe('no_worker')
  })
})
