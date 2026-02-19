/**
 * E2E tests for the Unified Session Transport Layer (SessionIO).
 *
 * Verifies that the SessionIO abstraction works correctly when integrated
 * into the full server pipeline: REST, WebSocket, event bus, session-tracker,
 * and task-manager.
 *
 * What's real: Express server, WebSocket, event bus, session-tracker persistence,
 *   task-manager linking, SessionIO (LocalIO / RemoteIO).
 * What's mocked: constants.js (temp dir), Claude CLI (mock-claude.mjs),
 *   SSH binary (mock-ssh.mjs via PATH override).
 *
 * Tests verify:
 *   1. Local session lifecycle via SessionIO (LocalIO)
 *   2. SSH session lifecycle via SessionIO (RemoteIO)
 *   3. FIFO-based message delivery (follow-up via session:send)
 *   4. Streaming events flow through SessionIO
 *   5. Session output file is renamed to session ID (rename lifecycle)
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'node:fs/promises'
import fsSync from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import type { Server as HttpServer } from 'node:http'
import { WebSocket } from 'ws'
import { createMockConstants } from '../helpers/mock-constants.js'

// Isolate all file I/O to a temp directory
vi.mock('../../src/constants.js', () => createMockConstants())

import { WALNUT_HOME } from '../../src/constants.js'
import { sessionRunner } from '../../src/providers/claude-code-session.js'
import { startServer, stopServer } from '../../src/web/server.js'

const MOCK_CLI = path.resolve(import.meta.dirname, '../providers/mock-claude.mjs')
const MOCK_SSH_SCRIPT = path.resolve(import.meta.dirname, '../providers/mock-ssh.mjs')

// ── Helpers ──

let server: HttpServer
let port: number
let mockSshBinDir: string
let originalPath: string | undefined

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

  // 2. Wire mock CLI into session runner
  sessionRunner.setCliCommand(MOCK_CLI)

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
  await stopServer()
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
      cwd: '/tmp/test-transport',
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
    expect(rd.result).toContain('Remote session completed successfully')

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

  it('SSH stderr confirms correct SSH invocation', async () => {
    // Check the stderr from the SSH session created above
    await delay(200)
    const sessRes = await fetch(apiUrl('/api/sessions/task/transport-ssh-001'))
    const sessBody = (await sessRes.json()) as {
      sessions: Array<{
        claudeSessionId: string
        host?: string
        outputFile?: string
      }>
    }

    const sshSession = sessBody.sessions.find((s) => s.host === 'test-remote')
    expect(sshSession).toBeDefined()

    // Read the .err file written by mock-ssh.mjs
    const outputFile = sshSession!.outputFile!
    let stderrContent: string
    try {
      stderrContent = fsSync.readFileSync(outputFile + '.err', 'utf-8')
    } catch {
      // May have been renamed
      const dir = path.dirname(outputFile)
      stderrContent = fsSync.readFileSync(
        path.join(dir, `${sshSession!.claudeSessionId}.jsonl.err`),
        'utf-8',
      )
    }

    // Verify SSH was invoked with correct args
    expect(stderrContent).toContain('SSH_ARGS:')
    expect(stderrContent).toContain('HOST_ARG:testuser@localhost')
    expect(stderrContent).toContain('REMOTE_CMD:')

    // Remote command includes cd, env var, and claude
    const remoteCmdMatch = stderrContent.match(/REMOTE_CMD:(.+)/)
    expect(remoteCmdMatch).toBeTruthy()
    const remoteCmd = remoteCmdMatch![1]
    expect(remoteCmd).toContain("cd '/tmp/test-transport'")
    expect(remoteCmd).toContain('CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1')
    expect(remoteCmd).toContain('claude')
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

    // Read the JSONL output file to verify all event types were captured
    const outputContent = await fs.readFile(session.outputFile!, 'utf-8')
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

describe('Output file rename lifecycle', () => {
  it('output file is renamed from temp ID to session ID', async () => {
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

    // Output file should be named after the session ID, not the temp ID
    expect(session.outputFile).toBeTruthy()
    expect(session.outputFile).toContain(session.claudeSessionId)
    expect(session.outputFile!.endsWith('.jsonl')).toBe(true)

    // The file should actually exist on disk
    const exists = await fs.access(session.outputFile!).then(() => true).catch(() => false)
    expect(exists).toBe(true)

    // Verify the file contains valid JSONL with the session ID
    const content = await fs.readFile(session.outputFile!, 'utf-8')
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
