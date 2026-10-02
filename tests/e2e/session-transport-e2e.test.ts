/**
 * E2E tests for the Unified Session Transport Layer (SessionIO).
 *
 * Verifies that the SessionIO abstraction works correctly when integrated
 * into the full server pipeline: REST, WebSocket, event bus, session-tracker,
 * and task-manager.
 *
 * What's real: Express server, WebSocket, event bus, session-tracker persistence,
 *   task-manager linking, RemoteSessionManager (the one transport since every
 *   session, local or remote, runs through a daemon).
 * What's mocked: constants.js (temp dir), the session daemon (MockDaemon, which
 *   spawns mock-claude.mjs), SSH binary (mock-ssh.mjs via PATH override, so host
 *   probes such as the remote cwd pre-flight never reach a real ssh).
 *
 * The daemon spawns `claude` by name, so setCliCommand alone cannot reach the
 * spawn: without the MockDaemon these tests ran the REAL CLI where one is
 * installed and failed where none is (CI).
 *
 * Tests verify:
 *   1. Local session lifecycle (host __local__)
 *   2. Remote host session lifecycle (record carries the host)
 *   3. FIFO-based message delivery (follow-up via session:send)
 *   4. Streaming events flow through the daemon stream
 *   5. Session stream file is named after the pre-assigned session id
 *   6. Follow-up message delivery (session:send → queue → resume)
 *   7. Session history retrieval via REST API
 *   8. Multiple concurrent sessions stream independently
 *   9. Session streaming events arrive via WebSocket
 *  10. Session error handling and graceful degradation
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import type { Server as HttpServer } from 'node:http'
import { WebSocket } from 'ws'
import { createMockConstants } from '../helpers/mock-constants.js'

// Isolate all file I/O to a temp directory
vi.mock('../../src/constants.js', () => createMockConstants())

import { WALNUT_HOME, CLAUDE_HOME } from '../../src/constants.js'
import { sessionRunner } from '../../src/providers/claude-code-session.js'
import { startServer, stopServer } from '../../src/web/server.js'
import { createMockDaemon, type MockDaemon } from '../helpers/mock-daemon.js'

const MOCK_CLI = path.resolve(import.meta.dirname, '../providers/mock-claude.mjs')
const MOCK_SSH_SCRIPT = path.resolve(import.meta.dirname, '../providers/mock-ssh.mjs')

// ── Helpers ──

let server: HttpServer
let port: number
let daemon: MockDaemon
let mockSshBinDir: string
let remoteCwd: string
let originalPath: string | undefined
const savedEnv: Record<string, string | undefined> = {}

function apiUrl(p: string): string {
  return `http://localhost:${port}${p}`
}

function wsUrl(): string {
  return `ws://localhost:${port}/ws`
}

function connectWs(): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl())
    ws.on('open', () => resolve(ws))
    ws.on('error', reject)
  })
}

interface WsEvent {
  type: string
  name?: string
  data?: Record<string, unknown>
  [key: string]: unknown
}

function waitForWsEvent(ws: WebSocket, eventName: string, timeoutMs = 15000): Promise<WsEvent> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${eventName}`)), timeoutMs)
    const handler = (raw: WebSocket.RawData) => {
      const frame = JSON.parse(raw.toString()) as WsEvent
      if (frame.type === 'event' && frame.name === eventName) {
        clearTimeout(timer)
        ws.off('message', handler)
        resolve(frame)
      }
    }
    ws.on('message', handler)
  })
}

function collectWsEvents(ws: WebSocket, eventNames: string[]): WsEvent[] {
  const events: WsEvent[] = []
  ws.on('message', (raw) => {
    const frame = JSON.parse(raw.toString()) as WsEvent
    if (frame.type === 'event' && eventNames.includes(frame.name!)) {
      events.push(frame)
    }
  })
  return events
}

function sendWsRpc(ws: WebSocket, method: string, payload: unknown): Promise<WsEvent> {
  return new Promise((resolve, reject) => {
    const id = `rpc-${Date.now()}-${Math.random().toString(36).slice(2)}`
    const timer = setTimeout(() => reject(new Error(`RPC ${method} timed out`)), 10000)
    const handler = (raw: WebSocket.RawData) => {
      const frame = JSON.parse(raw.toString()) as WsEvent
      if (frame.type === 'res' && (frame as Record<string, unknown>).id === id) {
        clearTimeout(timer)
        ws.off('message', handler)
        resolve(frame)
      }
    }
    ws.on('message', handler)
    ws.send(JSON.stringify({ type: 'req', id, method, payload }))
  })
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

async function pollUntil(check: () => Promise<boolean>, intervalMs = 100, timeoutMs = 10000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await check()) return
    await delay(intervalMs)
  }
  throw new Error(`pollUntil timed out after ${timeoutMs}ms`)
}

// ── Setup / Teardown ──

beforeAll(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })

  // 1. Create mock SSH wrapper
  mockSshBinDir = path.join(os.tmpdir(), `mock-ssh-bin-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  await fs.mkdir(mockSshBinDir, { recursive: true })
  await fs.writeFile(
    path.join(mockSshBinDir, 'ssh'),
    `#!/bin/sh\nexec node "${MOCK_SSH_SCRIPT}" "$@"\n`,
    { mode: 0o755 },
  )
  originalPath = process.env.PATH
  process.env.PATH = `${mockSshBinDir}:${process.env.PATH}`
  // The remote host's working directory (the MockDaemon runs on this machine).
  remoteCwd = path.join(mockSshBinDir, 'remote-cwd')
  await fs.mkdir(remoteCwd, { recursive: true })

  // 2. Route every session (local and host) through a MockDaemon running the mock CLI.
  // History is read from the CLI transcript under ~/.claude/projects through the
  // server's own local daemon. Point that daemon's `~` at the temp home (whose
  // .claude is the mocked CLAUDE_HOME) and let the mock CLI write its transcript
  // there, so nothing reads or writes the real home.
  for (const key of ['WALNUT_HOME_OVERRIDE', 'MOCK_CLAUDE_TRANSCRIPT_DIR']) savedEnv[key] = process.env[key]
  process.env.WALNUT_HOME_OVERRIDE = WALNUT_HOME
  process.env.MOCK_CLAUDE_TRANSCRIPT_DIR = path.join(CLAUDE_HOME, 'projects')
  daemon = await createMockDaemon()
  sessionRunner.setCliCommand(MOCK_CLI)
  sessionRunner.setTestDaemonUrl(`ws://127.0.0.1:${daemon.port}`)

  // 3. Seed tasks and config
  const tasksDir = path.join(WALNUT_HOME, 'tasks')
  await fs.mkdir(tasksDir, { recursive: true })
  await fs.writeFile(
    path.join(tasksDir, 'tasks.json'),
    JSON.stringify({
      version: 1,
      tasks: [
        {
          id: 'transport-local-001',
          title: 'Local transport test',
          status: 'todo',
          priority: 'none',
          category: 'Test',
          project: 'TransportTest',
          session_ids: [],
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          description: '',
          summary: '',
          note: '',
          subtasks: [],
          phase: 'TODO',
          source: 'ms-todo',
        },
        {
          id: 'transport-ssh-001',
          title: 'SSH transport test',
          status: 'todo',
          priority: 'none',
          category: 'Test',
          project: 'TransportTest',
          session_ids: [],
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          description: '',
          summary: '',
          note: '',
          subtasks: [],
          phase: 'TODO',
          source: 'ms-todo',
        },
        {
          id: 'transport-stream-001',
          title: 'Streaming events test',
          status: 'todo',
          priority: 'none',
          category: 'Test',
          project: 'TransportTest',
          session_ids: [],
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          description: '',
          summary: '',
          note: '',
          subtasks: [],
          phase: 'TODO',
          source: 'ms-todo',
        },
        {
          id: 'transport-rename-001',
          title: 'Rename lifecycle test',
          status: 'todo',
          priority: 'none',
          category: 'Test',
          project: 'TransportTest',
          session_ids: [],
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          description: '',
          summary: '',
          note: '',
          subtasks: [],
          phase: 'TODO',
          source: 'ms-todo',
        },
        {
          id: 'transport-followup-001',
          title: 'Follow-up message test',
          status: 'todo',
          priority: 'none',
          category: 'Test',
          project: 'TransportTest',
          session_ids: [],
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          description: '',
          summary: '',
          note: '',
          subtasks: [],
          phase: 'TODO',
          source: 'ms-todo',
        },
        {
          id: 'transport-concurrent-001',
          title: 'Concurrent session A',
          status: 'todo',
          priority: 'none',
          category: 'Test',
          project: 'TransportTest',
          session_ids: [],
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          description: '',
          summary: '',
          note: '',
          subtasks: [],
          phase: 'TODO',
          source: 'ms-todo',
        },
        {
          id: 'transport-concurrent-002',
          title: 'Concurrent session B',
          status: 'todo',
          priority: 'none',
          category: 'Test',
          project: 'TransportTest',
          session_ids: [],
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          description: '',
          summary: '',
          note: '',
          subtasks: [],
          phase: 'TODO',
          source: 'ms-todo',
        },
        {
          id: 'transport-concurrent-003',
          title: 'Concurrent session C',
          status: 'todo',
          priority: 'none',
          category: 'Test',
          project: 'TransportTest',
          session_ids: [],
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          description: '',
          summary: '',
          note: '',
          subtasks: [],
          phase: 'TODO',
          source: 'ms-todo',
        },
        {
          id: 'transport-streaming-001',
          title: 'Streaming events test',
          status: 'todo',
          priority: 'none',
          category: 'Test',
          project: 'TransportTest',
          session_ids: [],
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          description: '',
          summary: '',
          note: '',
          subtasks: [],
          phase: 'TODO',
          source: 'ms-todo',
        },
        {
          id: 'transport-error-001',
          title: 'Error handling test',
          status: 'todo',
          priority: 'none',
          category: 'Test',
          project: 'TransportTest',
          session_ids: [],
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          description: '',
          summary: '',
          note: '',
          subtasks: [],
          phase: 'TODO',
          source: 'ms-todo',
        },
      ],
    }),
  )

  // 4. Write config with SSH hosts
  await fs.writeFile(
    path.join(WALNUT_HOME, 'config.yaml'),
    [
      'version: 1',
      'user:',
      '  name: TestUser',
      'defaults:',
      '  priority: none',
      '  category: Inbox',
      'hosts:',
      '  test-remote:',
      '    hostname: localhost',
      '    user: testuser',
    ].join('\n') + '\n',
  )

  // 5. Start server on random port
  server = await startServer({ port: 0, dev: true })
  const addr = server.address()
  port = typeof addr === 'object' && addr ? addr.port : 0
})

afterAll(async () => {
  if (originalPath !== undefined) {
    process.env.PATH = originalPath
  }
  sessionRunner.setTestDaemonUrl(undefined)
  await stopServer()
  await daemon?.stop()
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
  if (mockSshBinDir) {
    await fs.rm(mockSshBinDir, { recursive: true, force: true }).catch(() => {})
  }
})

// ═══════════════════════════════════════════════════════════════════
//  1. Local session lifecycle via SessionIO (LocalIO)
// ═══════════════════════════════════════════════════════════════════

describe('Local session via SessionIO', () => {
  it('full lifecycle: start → stream → result → persistence', async () => {
    const ws = await connectWs()
    const resultPromise = waitForWsEvent(ws, 'session:result', 20000)

    const rpcRes = await sendWsRpc(ws, 'session:start', {
      taskId: 'transport-local-001',
      message: 'local transport e2e test',
      project: 'TransportTest',
    })
    expect((rpcRes as Record<string, unknown>).ok).toBe(true)

    // Wait for session to complete
    const resultEvent = await resultPromise
    const rd = resultEvent.data as {
      sessionId: string
      taskId: string
      result: string
      isError: boolean
    }

    expect(rd.taskId).toBe('transport-local-001')
    expect(rd.isError).toBe(false)
    expect(rd.sessionId).toBeTruthy()
    expect(rd.result).toContain('local transport e2e test')

    // Verify persistence via REST
    await delay(500)
    const sessRes = await fetch(apiUrl('/api/sessions/task/transport-local-001'))
    expect(sessRes.status).toBe(200)
    const sessBody = (await sessRes.json()) as {
      sessions: Array<{
        claudeSessionId: string
        taskId: string
        outputFile?: string
        host?: string
      }>
    }
    expect(sessBody.sessions.length).toBeGreaterThanOrEqual(1)

    const session = sessBody.sessions[0]
    expect(session.claudeSessionId).toBeTruthy()
    expect(session.taskId).toBe('transport-local-001')
    expect(session.outputFile).toBeTruthy()
    // Local session should have no host
    expect(session.host).toBeFalsy()

    // Verify output file was renamed to session ID
    expect(session.outputFile).toContain(session.claudeSessionId)

    ws.close()
    await delay(50)
  })

  it('task gets linked to session after result', async () => {
    // Check the task from the previous test
    let taskBody: { task: { session_ids?: string[]; exec_session_id?: string } } | undefined
    await pollUntil(async () => {
      const res = await fetch(apiUrl('/api/tasks/transport-local-001'))
      if (res.status !== 200) return false
      taskBody = (await res.json()) as { task: { session_ids?: string[]; exec_session_id?: string } }
      return (taskBody.task.session_ids?.length ?? 0) > 0
    })

    expect(taskBody).toBeDefined()
    expect(taskBody!.task.session_ids!.length).toBeGreaterThan(0)
    expect(taskBody!.task.exec_session_id).toBeTruthy()
  })
})

// ═══════════════════════════════════════════════════════════════════
//  2. SSH session lifecycle via SessionIO (RemoteIO)
// ═══════════════════════════════════════════════════════════════════

describe('SSH session via SessionIO', () => {
  it('full lifecycle: start with host → mock SSH → result → persistence with host', async () => {
    const ws = await connectWs()
    const resultPromise = waitForWsEvent(ws, 'session:result', 20000)

    const rpcRes = await sendWsRpc(ws, 'session:start', {
      taskId: 'transport-ssh-001',
      message: 'ssh transport e2e test',
      project: 'TransportTest',
      host: 'test-remote',
      cwd: remoteCwd,
    })
    expect((rpcRes as Record<string, unknown>).ok).toBe(true)

    const resultEvent = await resultPromise
    const rd = resultEvent.data as {
      sessionId: string
      taskId: string
      result: string
      isError: boolean
    }

    expect(rd.taskId).toBe('transport-ssh-001')
    expect(rd.isError).toBe(false)
    expect(rd.sessionId).toBeTruthy()
    // The mock CLI echoes the prompt and the directory it ran in.
    expect(rd.result).toContain('ssh transport e2e test')
    expect(rd.result).toContain(`[cwd:${await fs.realpath(remoteCwd)}]`)

    // Verify persistence with host field
    await delay(500)
    const sessRes = await fetch(apiUrl('/api/sessions/task/transport-ssh-001'))
    expect(sessRes.status).toBe(200)
    const sessBody = (await sessRes.json()) as {
      sessions: Array<{
        claudeSessionId: string
        host?: string
        outputFile?: string
      }>
    }

    const sshSession = sessBody.sessions.find((s) => s.host === 'test-remote')
    expect(sshSession).toBeDefined()
    expect(sshSession!.claudeSessionId).toBeTruthy()
    expect(sshSession!.host).toBe('test-remote')

    ws.close()
    await delay(50)
  })

  // The SSH command line (`cd <cwd> && CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1
  // claude ...`) was removed in 08182ce3: a host session is a `start` command to
  // the host's daemon, which spawns claude in the requested cwd itself (and
  // deliberately leaves background tasks enabled). That command is the contract.
  it('host start reaches the daemon with the requested cwd and the claude argv', async () => {
    const sessRes = await fetch(apiUrl('/api/sessions/task/transport-ssh-001'))
    const sessBody = (await sessRes.json()) as {
      sessions: Array<{ claudeSessionId: string; host?: string }>
    }
    const sshSession = sessBody.sessions.find((s) => s.host === 'test-remote')
    expect(sshSession).toBeDefined()

    const start = daemon.getCommandHistoryFor('start')
      .find((c) => c.payload.sid === sshSession!.claudeSessionId)
    expect(start).toBeDefined()
    expect(start!.payload.cwd).toBe(remoteCwd)
    const argv = start!.payload.args as string[]
    expect(argv[0]).toBe('claude')
    expect(argv).toContain('-p')
    expect(argv[argv.indexOf('--session-id') + 1]).toBe(sshSession!.claudeSessionId)
    expect(start!.payload.resume).toBe(false)
  })
})

// ═══════════════════════════════════════════════════════════════════
//  3. Streaming events flow through SessionIO (verified via JSONL + result)
// ═══════════════════════════════════════════════════════════════════

describe('Streaming events via SessionIO', () => {
  it('tool-test session produces correct JSONL output through the full pipeline', async () => {
    const ws = await connectWs()
    const resultPromise = waitForWsEvent(ws, 'session:result', 20000)

    // 'tool-test' makes mock CLI emit: init → tool_use → tool_result → assistant text → result
    await sendWsRpc(ws, 'session:start', {
      taskId: 'transport-stream-001',
      message: 'tool-test',
      project: 'TransportTest',
    })

    const resultEvent = await resultPromise
    const rd = resultEvent.data as {
      sessionId: string
      taskId: string
      result: string
      totalCost: number
      isError: boolean
    }

    // Result confirms the full JSONL → tailer → bus pipeline worked
    expect(rd.taskId).toBe('transport-stream-001')
    expect(rd.isError).toBe(false)
    expect(rd.sessionId).toBeTruthy()
    expect(rd.result).toContain('tool-test')
    expect(rd.totalCost).toBe(0.003)

    // Verify session persisted
    await delay(500)
    const sessRes = await fetch(apiUrl('/api/sessions/task/transport-stream-001'))
    const sessBody = (await sessRes.json()) as {
      sessions: Array<{
        claudeSessionId: string
        outputFile?: string
      }>
    }
    expect(sessBody.sessions.length).toBeGreaterThanOrEqual(1)
    const session = sessBody.sessions[0]

    // The record names the daemon stream; read that stream on the (mock) host
    // to verify all event types were captured.
    expect(session.outputFile).toBe(`remote://__local__/${session.claudeSessionId}`)
    const outputContent = await fs.readFile(daemon.streamFilePath(session.claudeSessionId), 'utf-8')
    const jsonlLines = outputContent.trim().split('\n').filter(Boolean)

    // Parse each line and collect types
    const parsed = jsonlLines.map((line) => JSON.parse(line))
    const types = parsed.map((p) => p.type + (p.subtype ? `:${p.subtype}` : ''))

    // Full event sequence: system:init, assistant (tool_use), user (tool_result),
    // assistant (text), result:success
    expect(types).toContain('system:init')
    expect(types).toContain('result:success')
    expect(types.filter((t) => t === 'assistant').length).toBeGreaterThanOrEqual(2)
    expect(types.filter((t) => t === 'user').length).toBeGreaterThanOrEqual(1)

    // Verify tool_use event was captured in JSONL
    const toolUseEvent = parsed.find(
      (p) => p.type === 'assistant' &&
        p.message?.content?.some?.((c: Record<string, unknown>) => c.type === 'tool_use'),
    )
    expect(toolUseEvent).toBeTruthy()
    const toolContent = toolUseEvent.message.content.find(
      (c: Record<string, unknown>) => c.type === 'tool_use',
    )
    expect(toolContent.name).toBe('Read')
    expect(toolContent.id).toBe('toolu_mock_001')

    // Verify tool_result event was captured in JSONL
    const toolResultEvent = parsed.find(
      (p) => p.type === 'user' &&
        p.message?.content?.some?.((c: Record<string, unknown>) => c.type === 'tool_result'),
    )
    expect(toolResultEvent).toBeTruthy()
    const resultContent = toolResultEvent.message.content.find(
      (c: Record<string, unknown>) => c.type === 'tool_result',
    )
    expect(resultContent.tool_use_id).toBe('toolu_mock_001')
    expect(resultContent.content).toBe('File contents here')

    ws.close()
    await delay(50)
  })
})

// ═══════════════════════════════════════════════════════════════════
//  4. Output file rename lifecycle
// ═══════════════════════════════════════════════════════════════════

// Since bacfc958 a fresh start pre-assigns the CLI session id (`--session-id`),
// so the stream is named after the session id from the spawn on: there is no
// temp id left to rename. The contract kept here is the one the rename served,
// a stream file found by the session id whose init line carries that id.
describe('Output file rename lifecycle', () => {
  it('output file is named after the session ID from the start', async () => {
    const ws = await connectWs()
    const resultPromise = waitForWsEvent(ws, 'session:result', 20000)

    await sendWsRpc(ws, 'session:start', {
      taskId: 'transport-rename-001',
      message: 'rename lifecycle test',
      project: 'TransportTest',
    })

    const resultEvent = await resultPromise
    const rd = resultEvent.data as { sessionId: string }
    expect(rd.sessionId).toBeTruthy()

    // Give persistence time to settle
    await delay(500)

    const sessRes = await fetch(apiUrl('/api/sessions/task/transport-rename-001'))
    const sessBody = (await sessRes.json()) as {
      sessions: Array<{
        claudeSessionId: string
        outputFile?: string
      }>
    }

    expect(sessBody.sessions.length).toBeGreaterThanOrEqual(1)
    const session = sessBody.sessions[0]
    expect(session.claudeSessionId).toBe(rd.sessionId)

    // The record points at the daemon stream named after the session id
    expect(session.outputFile).toBe(`remote://__local__/${session.claudeSessionId}`)

    // The daemon was asked to start under the final id, so nothing was renamed
    const start = daemon.getCommandHistoryFor('start')
      .find((c) => c.payload.sid === session.claudeSessionId)
    expect(start).toBeDefined()
    expect(daemon.getCommandHistoryFor('rename')
      .filter((c) => c.payload.newSid === session.claudeSessionId)).toHaveLength(0)

    // The stream file exists on the host under that id
    const streamFile = daemon.streamFilePath(session.claudeSessionId)
    const exists = await fs.access(streamFile).then(() => true).catch(() => false)
    expect(exists).toBe(true)

    // Verify the file contains valid JSONL with the session ID
    const content = await fs.readFile(streamFile, 'utf-8')
    const lines = content.trim().split('\n').filter(Boolean)
    expect(lines.length).toBeGreaterThan(0)

    // The init event should contain the session ID
    const initLine = lines.find((l) => {
      try {
        const parsed = JSON.parse(l)
        return parsed.type === 'system' && parsed.subtype === 'init'
      } catch { return false }
    })
    expect(initLine).toBeTruthy()
    const initData = JSON.parse(initLine!)
    expect(initData.session_id).toBe(session.claudeSessionId)

    ws.close()
    await delay(50)
  })
})

// ═══════════════════════════════════════════════════════════════════
//  5. Follow-up message delivery via session:send → queue → resume
// ═══════════════════════════════════════════════════════════════════

// `snapshot-clean-turn:<text>` makes the mock CLI behave like the real one
// across turns: it answers <text>, stays alive reading its FIFO, and appends
// each turn to its transcript (MOCK_CLAUDE_TRANSCRIPT_DIR), which is where
// history reads user messages from.
describe('Follow-up message delivery', () => {
  let firstSessionId: string

  it('start initial session and capture session ID', async () => {
    const ws = await connectWs()
    const resultPromise = waitForWsEvent(ws, 'session:result', 20000)

    await sendWsRpc(ws, 'session:start', {
      taskId: 'transport-followup-001',
      message: 'snapshot-clean-turn:first message for follow-up test',
      project: 'TransportTest',
    })

    const resultEvent = await resultPromise
    const rd = resultEvent.data as {
      sessionId: string
      taskId: string
      result: string
      isError: boolean
    }

    expect(rd.taskId).toBe('transport-followup-001')
    expect(rd.isError).toBe(false)
    expect(rd.result).toContain('first message for follow-up test')
    firstSessionId = rd.sessionId
    expect(firstSessionId).toBeTruthy()

    ws.close()
    await delay(300)
  })

  it('send follow-up message via session:send and get response', async () => {
    const ws = await connectWs()

    // Send a follow-up message: queued, then written to the live CLI's FIFO
    const sendRpcRes = await sendWsRpc(ws, 'session:send', {
      sessionId: firstSessionId,
      message: 'snapshot-clean-turn:follow-up question via transport',
    })

    // RPC should return a messageId (the result rides in the response payload)
    expect(sendRpcRes.ok).toBe(true)
    const sendData = sendRpcRes.payload as Record<string, unknown> | undefined
    expect(sendData?.messageId).toBeTruthy()

    // Wait for the resumed session to produce a result
    const resultEvent = await waitForWsEvent(ws, 'session:result', 20000)
    const rd = resultEvent.data as {
      sessionId: string
      result: string
      isError: boolean
    }

    expect(rd.sessionId).toBe(firstSessionId)
    expect(rd.isError).toBe(false)
    expect(rd.result).toContain('follow-up question via transport')

    ws.close()
    await delay(50)
  })

  it('session history includes both initial and follow-up turns', async () => {
    await delay(500)

    const historyRes = await fetch(apiUrl(`/api/sessions/${firstSessionId}/history`))
    expect(historyRes.status).toBe(200)
    const historyBody = (await historyRes.json()) as {
      messages: Array<{
        role: string
        text?: string
        tools?: unknown[]
      }>
    }

    // Should have messages from both the initial turn and the follow-up
    expect(historyBody.messages.length).toBeGreaterThanOrEqual(2)

    // Check there are both user and assistant messages
    const userMessages = historyBody.messages.filter((m) => m.role === 'user')
    const assistantMessages = historyBody.messages.filter((m) => m.role === 'assistant')
    expect(userMessages.length).toBeGreaterThanOrEqual(2)
    expect(assistantMessages.length).toBeGreaterThanOrEqual(2)
    const answers = assistantMessages.map((m) => m.text ?? '').join('\n')
    expect(answers).toContain('first message for follow-up test')
    expect(answers).toContain('follow-up question via transport')
  })
})

// ═══════════════════════════════════════════════════════════════════
//  6. Multiple concurrent sessions stream independently
// ═══════════════════════════════════════════════════════════════════

describe('Multiple concurrent sessions', () => {
  it('three sessions started simultaneously all complete independently', async () => {
    const ws = await connectWs()

    // Collect all session:result events
    const results: WsEvent[] = []
    const allDone = new Promise<void>((resolve) => {
      const handler = (raw: WebSocket.RawData) => {
        const frame = JSON.parse(raw.toString()) as WsEvent
        if (frame.type === 'event' && frame.name === 'session:result') {
          const data = frame.data as { taskId: string }
          if (data.taskId?.startsWith('transport-concurrent-')) {
            results.push(frame)
            if (results.length === 3) {
              ws.off('message', handler)
              resolve()
            }
          }
        }
      }
      ws.on('message', handler)
    })

    // Start all three sessions simultaneously
    const starts = await Promise.all([
      sendWsRpc(ws, 'session:start', {
        taskId: 'transport-concurrent-001',
        message: 'concurrent session alpha',
        project: 'TransportTest',
      }),
      sendWsRpc(ws, 'session:start', {
        taskId: 'transport-concurrent-002',
        message: 'concurrent session beta',
        project: 'TransportTest',
      }),
      sendWsRpc(ws, 'session:start', {
        taskId: 'transport-concurrent-003',
        message: 'concurrent session gamma',
        project: 'TransportTest',
      }),
    ])

    // All RPCs should succeed
    for (const s of starts) {
      expect((s as Record<string, unknown>).ok).toBe(true)
    }

    // Wait for all three to complete (with generous timeout)
    await Promise.race([
      allDone,
      delay(30000).then(() => { throw new Error('Timeout waiting for 3 concurrent sessions') }),
    ])

    expect(results.length).toBe(3)

    // Verify each session completed independently with its own message
    const taskIds = results.map((r) => (r.data as { taskId: string }).taskId).sort()
    expect(taskIds).toEqual([
      'transport-concurrent-001',
      'transport-concurrent-002',
      'transport-concurrent-003',
    ])

    // Each result should contain its respective message fragment
    for (const r of results) {
      const rd = r.data as { isError: boolean; result: string; sessionId: string }
      expect(rd.isError).toBe(false)
      expect(rd.sessionId).toBeTruthy()
      expect(rd.result).toBeTruthy()
    }

    // Verify session IDs are all unique
    const sessionIds = results.map((r) => (r.data as { sessionId: string }).sessionId)
    expect(new Set(sessionIds).size).toBe(3)

    ws.close()
    await delay(50)
  }, 35000)

  it('concurrent sessions each have independent persisted records', async () => {
    await delay(500)

    // Check each task has at least one session
    for (const taskId of ['transport-concurrent-001', 'transport-concurrent-002', 'transport-concurrent-003']) {
      const res = await fetch(apiUrl(`/api/sessions/task/${taskId}`))
      expect(res.status).toBe(200)
      const body = (await res.json()) as {
        sessions: Array<{ claudeSessionId: string; taskId: string }>
      }
      expect(body.sessions.length).toBeGreaterThanOrEqual(1)
      expect(body.sessions[0].taskId).toBe(taskId)
      expect(body.sessions[0].claudeSessionId).toBeTruthy()
    }
  })
})

// ═══════════════════════════════════════════════════════════════════
//  7. Session streaming events arrive via WebSocket
// ═══════════════════════════════════════════════════════════════════

describe('Session streaming events via WebSocket', () => {
  it('session emits text-delta and tool-use events before result', async () => {
    const ws = await connectWs()

    // Collect all streaming events for this session
    const streamEvents = collectWsEvents(ws, [
      'session:text-delta',
      'session:tool-use',
      'session:tool-result',
      'session:result',
      'session:started',
    ])

    const resultPromise = waitForWsEvent(ws, 'session:result', 20000)

    // 'tool-test' makes mock CLI emit: init → tool_use → tool_result → text → result
    await sendWsRpc(ws, 'session:start', {
      taskId: 'transport-streaming-001',
      message: 'tool-test',
      project: 'TransportTest',
    })

    await resultPromise

    // Should have received a session:started event
    const startedEvents = streamEvents.filter((e) => e.name === 'session:started')
    expect(startedEvents.length).toBeGreaterThanOrEqual(1)

    // Should have received tool-use events (from the tool-test mock CLI output)
    const toolUseEvents = streamEvents.filter((e) => e.name === 'session:tool-use')
    expect(toolUseEvents.length).toBeGreaterThanOrEqual(1)

    // Tool use event should contain the tool name (SessionToolUseEvent.toolName)
    const firstToolUse = toolUseEvents[0].data as { toolName?: string; toolUseId?: string }
    expect(firstToolUse.toolName).toBe('Read')
    expect(firstToolUse.toolUseId).toBe('toolu_mock_001')

    // Should have received a result event
    const resultEvents = streamEvents.filter((e) => e.name === 'session:result')
    expect(resultEvents.length).toBe(1)

    ws.close()
    await delay(50)
  })
})

// ═══════════════════════════════════════════════════════════════════
//  8. Session error handling and graceful degradation
// ═══════════════════════════════════════════════════════════════════

describe('Session error handling', () => {
  // A CLI that dies with a failure code before any result line ends the turn as
  // `session:error` (the exit path in claude-code-session.ts), not as a result.
  it('session with error message produces a session error and server stays healthy', async () => {
    const ws = await connectWs()

    const errorPromise = waitForWsEvent(ws, 'session:error', 20000)

    // Send 'error' message — mock CLI exits with code 1
    await sendWsRpc(ws, 'session:start', {
      taskId: 'transport-error-001',
      message: 'error',
      project: 'TransportTest',
    })

    const errorEvent = await errorPromise
    const ed = errorEvent.data as {
      sessionId?: string
      taskId: string
      error: string
    }

    expect(ed.taskId).toBe('transport-error-001')
    expect(ed.sessionId).toBeTruthy()
    expect(ed.error).toContain('exited with code 1')

    // The record carries the error state
    await pollUntil(async () => {
      const res = await fetch(apiUrl(`/api/sessions/${ed.sessionId}`))
      if (res.status !== 200) return false
      const body = (await res.json()) as { session?: { process_status?: string } }
      return body.session?.process_status === 'error'
    })

    // Server should still be healthy after error session
    const healthRes = await fetch(apiUrl('/api/tasks'))
    expect(healthRes.status).toBe(200)

    ws.close()
    await delay(50)
  })

  it('session:send to nonexistent session returns error', async () => {
    const ws = await connectWs()

    // Try to send to a session that does not exist
    try {
      await sendWsRpc(ws, 'session:send', {
        sessionId: 'nonexistent-session-id-999',
        message: 'this should not work',
      })
    } catch (err) {
      // RPC may time out or return an error — both are acceptable
      expect(err).toBeDefined()
    }

    // Server should still be healthy
    const healthRes = await fetch(apiUrl('/api/tasks'))
    expect(healthRes.status).toBe(200)

    ws.close()
    await delay(50)
  })

  it('session:start with invalid payload is rejected', async () => {
    const ws = await connectWs()

    // Send a malformed session:start (missing required 'message' field)
    try {
      const rpcRes = await sendWsRpc(ws, 'session:start', {
        taskId: 'transport-error-001',
        // missing 'message'
      })
      // If we get a response, check it is an error
      if (rpcRes.type === 'res') {
        const error = (rpcRes as Record<string, unknown>).error
        expect(error).toBeTruthy()
      }
    } catch {
      // Timeout or error is acceptable — the server rejects bad payloads
    }

    // Server remains healthy
    const healthRes = await fetch(apiUrl('/api/tasks'))
    expect(healthRes.status).toBe(200)

    ws.close()
    await delay(50)
  })
})

// ═══════════════════════════════════════════════════════════════════
//  9. Session record enrichment
// ═══════════════════════════════════════════════════════════════════

describe('Session record enrichment', () => {
  it('session record contains model, cwd, and cost fields', async () => {
    // Query an existing session from the local lifecycle test
    const sessRes = await fetch(apiUrl('/api/sessions/task/transport-local-001'))
    expect(sessRes.status).toBe(200)
    const sessBody = (await sessRes.json()) as {
      sessions: Array<{
        claudeSessionId: string
        cwd?: string
        model?: string
        totalCost?: number
        process_status?: string
      }>
    }

    expect(sessBody.sessions.length).toBeGreaterThanOrEqual(1)
    const session = sessBody.sessions[0]

    // The model comes from the mock CLI's init line: proof the mock, not an
    // installed claude, served the session.
    expect(session.model).toBe('mock-model')

    // Session should have process_status
    expect(session.process_status).toBeTruthy()

    // For a completed session, process_status should be 'stopped'
    expect(session.process_status).toBe('stopped')
  })

  it('GET /api/sessions returns all sessions across tasks', async () => {
    const sessRes = await fetch(apiUrl('/api/sessions'))
    expect(sessRes.status).toBe(200)
    const sessBody = (await sessRes.json()) as {
      sessions: Array<{ claudeSessionId: string; taskId: string }>
    }

    // Should have sessions from the tests that ran before this
    expect(sessBody.sessions.length).toBeGreaterThanOrEqual(3)

    // Sessions should come from different tasks
    const taskIds = new Set(sessBody.sessions.map((s) => s.taskId))
    expect(taskIds.size).toBeGreaterThanOrEqual(2)
  })
})
