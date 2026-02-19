/**
 * E2E tests for SSH remote session invocation — real server + mock SSH.
 *
 * What's real: Express server, WebSocket connections, event bus, session-tracker
 * persistence, task-manager linking, config resolution, REST endpoints.
 * What's mocked: constants.js (temp dir), ssh binary (mock-ssh.mjs via PATH override).
 *
 * Tests verify the full pipeline:
 *   WS RPC session:start { host } → SessionRunner.handleStart → config.hosts lookup →
 *   ClaudeCodeSession.send(sshTarget) → spawn('ssh', ...) → mock SSH → JSONL stream →
 *   bus events → WS broadcast → REST API confirms persistence with host field.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'node:fs/promises'
import fsp from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import type { Server as HttpServer } from 'node:http'
import { WebSocket } from 'ws'
import { createMockConstants } from '../helpers/mock-constants.js'

// Mock constants to isolate from real data
vi.mock('../../src/constants.js', () => createMockConstants())

import { WALNUT_HOME } from '../../src/constants.js'
import { startServer, stopServer } from '../../src/web/server.js'

// Path to the real mock SSH script
const MOCK_SSH_SCRIPT = path.resolve(import.meta.dirname, '../providers/mock-ssh.mjs')
// Path to the mock claude script (used as cliCommand for the SessionRunner for non-SSH paths)
const MOCK_CLI = path.resolve(import.meta.dirname, '../providers/mock-claude.mjs')

// ── Helpers ──

let server: HttpServer
let port: number
/** Directory containing the mock 'ssh' wrapper script */
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

/** Poll a check function until it returns true (or throw after timeoutMs). */
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

  // 1. Create a mock 'ssh' wrapper script that delegates to mock-ssh.mjs.
  //    We place it in a temp bin directory and prepend that directory to PATH
  //    so spawn('ssh', ...) finds our mock instead of the real ssh binary.
  mockSshBinDir = path.join(os.tmpdir(), `mock-ssh-bin-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  await fs.mkdir(mockSshBinDir, { recursive: true })
  const mockSshWrapper = path.join(mockSshBinDir, 'ssh')
  await fs.writeFile(mockSshWrapper, `#!/bin/sh\nexec node "${MOCK_SSH_SCRIPT}" "$@"\n`, { mode: 0o755 })

  // Prepend mock bin dir to PATH
  originalPath = process.env.PATH
  process.env.PATH = `${mockSshBinDir}:${process.env.PATH}`

  // 2. Wire mock CLI into session runner for non-SSH sessions
  const { sessionRunner } = await import('../../src/providers/claude-code-session.js')
  sessionRunner.setCliCommand(MOCK_CLI)

  // 3. Seed tasks and config
  const tasksDir = path.join(WALNUT_HOME, 'tasks')
  await fs.mkdir(tasksDir, { recursive: true })

  // Seed tasks: a regular task + a .metadata task with default_host/default_cwd
  await fs.writeFile(
    path.join(tasksDir, 'tasks.json'),
    JSON.stringify({
      version: 1,
      tasks: [
        {
          id: 'ssh-task-001',
          title: 'Remote session test task',
          status: 'todo',
          priority: 'immediate',
          category: 'Work',
          project: 'RemoteProject',
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
          id: 'ssh-task-002',
          title: 'Another remote task',
          status: 'todo',
          priority: 'none',
          category: 'Work',
          project: 'RemoteProject',
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
          id: 'ssh-meta-001',
          title: '.metadata',
          status: 'todo',
          priority: 'none',
          category: 'Work',
          project: 'MetaProject',
          session_ids: [],
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          description: 'default_host: test-host\ndefault_cwd: /tmp/test-ssh-meta',
          summary: '',
          note: '',
          subtasks: [],
          phase: 'TODO',
          source: 'ms-todo',
        },
        {
          id: 'ssh-task-003',
          title: 'Meta project task',
          status: 'todo',
          priority: 'none',
          category: 'Work',
          project: 'MetaProject',
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

  // 4. Write config.yaml with hosts section
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
      '  test-host:',
      '    hostname: localhost',
      '    user: testuser',
      '  port-host:',
      '    hostname: remotebox.example.com',
      '    user: admin',
      '    port: 2222',
    ].join('\n') + '\n',
  )

  // 5. Start the server
  server = await startServer({ port: 0, dev: true })
  const addr = server.address()
  port = typeof addr === 'object' && addr ? addr.port : 0
})

afterAll(async () => {
  // Restore PATH
  if (originalPath !== undefined) {
    process.env.PATH = originalPath
  }

  await stopServer()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
  if (mockSshBinDir) {
    await fs.rm(mockSshBinDir, { recursive: true, force: true }).catch(() => {})
  }
})

// ── SSH session via WS RPC ──

describe('SSH session start via WS RPC', () => {
  it('session:start with host spawns SSH and produces session:result', async () => {
    const ws = await connectWs()
    const resultPromise = waitForWsEvent(ws, 'session:result', 20000)

    // Start a session with explicit host
    const rpcRes = await sendWsRpc(ws, 'session:start', {
      taskId: 'ssh-task-001',
      message: 'hello from ssh e2e',
      project: 'RemoteProject',
      host: 'test-host',
      cwd: '/tmp/test-ssh',
    })
    expect((rpcRes as Record<string, unknown>).ok).toBe(true)

    // Wait for the session to complete
    const resultEvent = await resultPromise
    const rd = resultEvent.data as {
      sessionId: string
      taskId: string
      result: string
      isError: boolean
    }

    expect(rd.taskId).toBe('ssh-task-001')
    expect(rd.isError).toBe(false)
    expect(rd.sessionId).toBeTruthy()
    expect(rd.result).toContain('Remote session completed successfully')

    ws.close()
    await delay(50)
  })

  it('session record persists with host field', async () => {
    // The previous test started a session for ssh-task-001. Check the session record.
    await delay(1000)

    const res = await fetch(apiUrl('/api/sessions/task/ssh-task-001'))
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      sessions: Array<{
        taskId: string
        claudeSessionId: string
        host?: string
      }>
    }
    expect(body.sessions.length).toBeGreaterThanOrEqual(1)

    // Find the session that has a host field
    const sshSession = body.sessions.find((s) => s.host === 'test-host')
    expect(sshSession).toBeDefined()
    expect(sshSession!.claudeSessionId).toBeTruthy()
    expect(sshSession!.host).toBe('test-host')
  })

  it('SSH was spawned with correct arguments (verified via stderr file)', async () => {
    // The session from the first test should have a stderr file (.err) containing
    // the SSH arguments written by mock-ssh.mjs.
    const res = await fetch(apiUrl('/api/sessions/task/ssh-task-001'))
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      sessions: Array<{
        claudeSessionId: string
        host?: string
        outputFile?: string
      }>
    }

    const sshSession = body.sessions.find((s) => s.host === 'test-host')
    expect(sshSession).toBeDefined()

    // Read the stderr file written by mock-ssh.mjs
    // The output file is the JSONL path; stderr is at .err
    const outputFile = sshSession!.outputFile
    expect(outputFile).toBeTruthy()
    const stderrFile = outputFile + '.err'

    let stderrContent: string
    try {
      stderrContent = fsp.readFileSync(stderrFile, 'utf-8')
    } catch {
      // The stderr file might have been renamed along with the JSONL file.
      // Try the session ID-based path.
      const sessionDir = path.dirname(outputFile!)
      const stderrBySessionId = path.join(sessionDir, `${sshSession!.claudeSessionId}.jsonl.err`)
      stderrContent = fsp.readFileSync(stderrBySessionId, 'utf-8')
    }

    // Verify SSH was called (not claude directly)
    expect(stderrContent).toContain('SSH_ARGS:')
    expect(stderrContent).toContain('REMOTE_CMD:')
    expect(stderrContent).toContain('HOST_ARG:')

    // Parse the remote command from stderr
    const remoteCmdMatch = stderrContent.match(/REMOTE_CMD:(.+)/)
    expect(remoteCmdMatch).toBeTruthy()
    const remoteCmd = remoteCmdMatch![1]

    // Verify remote command includes cd and CLAUDE_CODE_DISABLE_BACKGROUND_TASKS
    expect(remoteCmd).toContain("cd '/tmp/test-ssh'")
    expect(remoteCmd).toContain('CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1')
    expect(remoteCmd).toContain('claude')

    // Verify host argument includes user@hostname
    const hostArgMatch = stderrContent.match(/HOST_ARG:(.+)/)
    expect(hostArgMatch).toBeTruthy()
    expect(hostArgMatch![1]).toBe('testuser@localhost')

    // Verify SSH options were passed
    const sshArgsMatch = stderrContent.match(/SSH_ARGS:(.+)/)
    expect(sshArgsMatch).toBeTruthy()
    const sshArgs = JSON.parse(sshArgsMatch![1]) as string[]
    expect(sshArgs).toContain('-o')
    expect(sshArgs).toContain('BatchMode=yes')
    expect(sshArgs).toContain('StrictHostKeyChecking=no')
  })
})

// ── SSH session with port ──

describe('SSH session with custom port', () => {
  it('session:start with port-host includes -p flag in SSH args', async () => {
    const ws = await connectWs()
    const resultPromise = waitForWsEvent(ws, 'session:result', 20000)

    const rpcRes = await sendWsRpc(ws, 'session:start', {
      taskId: 'ssh-task-002',
      message: 'port test via ssh',
      project: 'RemoteProject',
      host: 'port-host',
      cwd: '/tmp/test-ssh-port',
    })
    expect((rpcRes as Record<string, unknown>).ok).toBe(true)

    const resultEvent = await resultPromise
    const rd = resultEvent.data as { isError: boolean; sessionId: string }
    expect(rd.isError).toBe(false)

    // Verify the session record has the correct host
    await delay(500)
    const res = await fetch(apiUrl('/api/sessions/task/ssh-task-002'))
    const body = (await res.json()) as {
      sessions: Array<{
        claudeSessionId: string
        host?: string
        outputFile?: string
      }>
    }
    const portSession = body.sessions.find((s) => s.host === 'port-host')
    expect(portSession).toBeDefined()

    // Read stderr to verify -p 2222 was passed
    const outputFile = portSession!.outputFile
    expect(outputFile).toBeTruthy()

    let stderrContent: string
    try {
      const stderrFile = outputFile + '.err'
      stderrContent = fsp.readFileSync(stderrFile, 'utf-8')
    } catch {
      const sessionDir = path.dirname(outputFile!)
      const stderrBySessionId = path.join(sessionDir, `${portSession!.claudeSessionId}.jsonl.err`)
      stderrContent = fsp.readFileSync(stderrBySessionId, 'utf-8')
    }

    const sshArgsMatch = stderrContent.match(/SSH_ARGS:(.+)/)
    expect(sshArgsMatch).toBeTruthy()
    const sshArgs = JSON.parse(sshArgsMatch![1]) as string[]

    // Verify port flag: -p 2222
    const portIdx = sshArgs.indexOf('-p')
    expect(portIdx).toBeGreaterThan(-1)
    expect(sshArgs[portIdx + 1]).toBe('2222')

    // Verify user@hostname
    const hostArgMatch = stderrContent.match(/HOST_ARG:(.+)/)
    expect(hostArgMatch).toBeTruthy()
    expect(hostArgMatch![1]).toBe('admin@remotebox.example.com')

    ws.close()
    await delay(50)
  })
})

// ── Unknown host — graceful handling ──

describe('SSH session error handling', () => {
  it('session:start with unknown host does not crash the server', async () => {
    const ws = await connectWs()

    // Start a session with a host that doesn't exist in config.
    // handleStart() throws inside the bus subscriber. The bus swallows the error
    // (each handler runs in its own try/catch — error isolation). No session:error
    // is emitted to WS clients, but the server must remain healthy.
    const rpcRes = await sendWsRpc(ws, 'session:start', {
      taskId: 'ssh-task-002',
      message: 'unknown host test',
      project: 'RemoteProject',
      host: 'nonexistent-host',
      cwd: '/tmp/test',
    })

    // The RPC returns ok because it just emits the event to the bus.
    expect((rpcRes as Record<string, unknown>).ok).toBe(true)

    // Give the bus a moment to process the event (and swallow the error).
    await delay(500)

    // Verify the server is still healthy — REST API responds.
    const healthRes = await fetch(apiUrl('/api/tasks/ssh-task-002'))
    expect(healthRes.status).toBe(200)

    // Verify no session was created for this failed attempt (host resolution failed
    // before spawn). The task should have no new sessions from this call.
    const sessRes = await fetch(apiUrl('/api/sessions/task/ssh-task-002'))
    expect(sessRes.status).toBe(200)
    const sessBody = (await sessRes.json()) as {
      sessions: Array<{ host?: string }>
    }
    const nonexistentHostSessions = sessBody.sessions.filter(
      (s) => s.host === 'nonexistent-host',
    )
    expect(nonexistentHostSessions).toHaveLength(0)

    ws.close()
    await delay(50)
  })
})

// ── Task links to SSH session ──

describe('SSH session task linking', () => {
  it('task has session_ids populated after SSH session completes', async () => {
    const ws = await connectWs()
    const resultPromise = waitForWsEvent(ws, 'session:result', 20000)

    await sendWsRpc(ws, 'session:start', {
      taskId: 'ssh-task-001',
      message: 'task linking test',
      project: 'RemoteProject',
      host: 'test-host',
      cwd: '/tmp/test-ssh',
    })

    await resultPromise

    // Poll until session_ids is populated on the task
    let taskBody: { task: { session_ids?: string[]; exec_session_id?: string } } | undefined
    await pollUntil(async () => {
      const taskRes = await fetch(apiUrl('/api/tasks/ssh-task-001'))
      if (taskRes.status !== 200) return false
      taskBody = (await taskRes.json()) as { task: { session_ids?: string[]; exec_session_id?: string } }
      return (taskBody.task.session_ids?.length ?? 0) > 0
    })

    expect(taskBody).toBeDefined()
    expect(taskBody!.task.session_ids!.length).toBeGreaterThan(0)

    ws.close()
    await delay(50)
  })
})

// ── Verify remote command structure (buildRemoteCommand) ──

describe('Remote command structure', () => {
  it('buildRemoteCommand produces correct cd + env + claude command', async () => {
    // Import the exported helper directly for a unit-level check
    const { buildRemoteCommand, shellQuote } = await import('../../src/providers/claude-code-session.js')

    const args = ['-p', '--output-format', 'stream-json', '--verbose', 'hello world']
    const cmd = buildRemoteCommand(args, '/home/user/project')

    expect(cmd).toContain("cd '/home/user/project'")
    expect(cmd).toContain('CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1')
    expect(cmd).toContain('claude')
    expect(cmd).toContain("'-p'")
    expect(cmd).toContain("'hello world'")

    // Without cwd
    const cmdNoCwd = buildRemoteCommand(args)
    expect(cmdNoCwd).not.toContain('cd ')
    expect(cmdNoCwd).toContain('CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1 claude')

    // shellQuote handles single quotes
    expect(shellQuote("it's")).toBe("'it'\\''s'")
    expect(shellQuote('simple')).toBe("'simple'")
  })
})
