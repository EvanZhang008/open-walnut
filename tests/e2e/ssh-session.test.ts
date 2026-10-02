/**
 * E2E tests for dialing a configured SSH host: real server + a recording `ssh`.
 *
 * Since 08182ce3 (2026-03-22) every session on a configured host runs through the
 * session daemon: Walnut opens an SSH ControlMaster to user@hostname, deploys and
 * starts the daemon there, and talks to it through a tunnel. The old transport
 * (`ssh host claude -p ...` read over stdout, built by buildRemoteCommand) was
 * removed in that commit, and with it the tests that asserted its remote command.
 *
 * These tests pin the SSH half: the host string and options Walnut dials with, and
 * that a host it cannot reach fails the start cleanly. The `ssh` on PATH records
 * every invocation and refuses like an unreachable host (exit 255), so nothing
 * leaves this machine. A session's result, record and task link over a working
 * daemon are covered by remote-session-e2e and session-manager-e2e.
 *
 * What's real: Express server, WebSocket connections, event bus, session runner,
 *   config hosts lookup, DaemonConnection's SSH dialing, REST endpoints.
 * What's mocked: constants.js (temp dir), the ssh binary (a recorder via PATH
 *   override). No Claude CLI runs: nothing can be spawned on a host that refuses SSH.
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

// Every start here names a host that refuses SSH, so no CLI is ever spawned (the
// last test checks that no session ran on this machine)
const MOCK_CLI = path.resolve(import.meta.dirname, '../providers/mock-claude.mjs')

// ── Helpers ──

let server: HttpServer
let port: number
/** Directory containing the recording 'ssh' */
let mockSshBinDir: string
/** One JSON line per ssh invocation: its argv */
let sshRecordFile: string
let originalPath: string | undefined

function sshCalls(): string[][] {
  let text = ''
  try { text = fsp.readFileSync(sshRecordFile, 'utf-8') } catch { return [] }
  return text.split('\n').filter(Boolean).map((l) => JSON.parse(l) as string[])
}

/** Connections opened to a host. Skips `ssh -G` (a local config query) and
 *  `ssh -O` (a command to the local ControlMaster socket): neither dials. */
function sshDialsTo(userAtHost: string): string[][] {
  return sshCalls().filter((argv) => argv.includes(userAtHost) && !argv.includes('-G') && !argv.includes('-O'))
}

/** The values of every `-o <option>` pair in an ssh argv. */
function sshOptions(argv: string[]): string[] {
  return argv.flatMap((a, i) => (a === '-o' && i + 1 < argv.length ? [argv[i + 1]] : []))
}

/** Resolves with the first `eventName` event for `taskId`; never rejects. */
function nextTaskEvent(ws: WebSocket, eventName: string, taskId: string): Promise<WsEvent> {
  return new Promise((resolve) => {
    const handler = (raw: WebSocket.RawData) => {
      const frame = JSON.parse(raw.toString()) as WsEvent
      if (frame.type === 'event' && frame.name === eventName && frame.data?.taskId === taskId) {
        ws.off('message', handler)
        resolve(frame)
      }
    }
    ws.on('message', handler)
  })
}

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

// ── Setup / Teardown ──

beforeAll(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })

  // 1. A recording 'ssh' first on PATH, so spawn('ssh', ...) finds it instead of
  //    the real binary. It answers every call like a host that refuses SSH.
  mockSshBinDir = path.join(os.tmpdir(), `mock-ssh-bin-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  await fs.mkdir(mockSshBinDir, { recursive: true })
  sshRecordFile = path.join(mockSshBinDir, 'calls.jsonl')
  const recorder = path.join(mockSshBinDir, 'ssh-recorder.mjs')
  await fs.writeFile(recorder, [
    "import fs from 'node:fs'",
    `fs.appendFileSync(${JSON.stringify(sshRecordFile)}, JSON.stringify(process.argv.slice(2)) + '\\n')`,
    "process.stderr.write('ssh: connect to host port 22: Connection refused\\n')",
    'process.exit(255)',
  ].join('\n') + '\n')
  await fs.writeFile(path.join(mockSshBinDir, 'ssh'),
    `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(recorder)} "$@"\n`, { mode: 0o755 })

  // Prepend mock bin dir to PATH
  originalPath = process.env.PATH
  process.env.PATH = `${mockSshBinDir}:${process.env.PATH}`

  // 2. Wire mock CLI into session runner
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

// ── Dialing a configured host ──

/** The outcome of the first test's start: settled by session:error or session:result. */
let refusedStart: Promise<WsEvent> | null = null
let refusedStartWs: WebSocket | null = null

describe('SSH session start via WS RPC', () => {
  it('session:start with host dials user@hostname over SSH in batch mode', async () => {
    const ws = await connectWs()
    refusedStartWs = ws
    refusedStart = Promise.race([
      nextTaskEvent(ws, 'session:error', 'ssh-task-001'),
      nextTaskEvent(ws, 'session:result', 'ssh-task-001'),
    ])

    const rpcRes = await sendWsRpc(ws, 'session:start', {
      taskId: 'ssh-task-001',
      message: 'hello from ssh e2e',
      project: 'RemoteProject',
      host: 'test-host',
      cwd: '/tmp/test-ssh',
    })
    expect((rpcRes as Record<string, unknown>).ok).toBe(true)

    await vi.waitFor(() => expect(sshDialsTo('testuser@localhost').length).toBeGreaterThan(0),
      { timeout: 20_000, interval: 100 })
    for (const argv of sshDialsTo('testuser@localhost')) {
      expect(sshOptions(argv)).toEqual(expect.arrayContaining(['BatchMode=yes', 'StrictHostKeyChecking=no']))
      // The removed stdout transport ran the CLI as the remote command
      expect(argv.some((a) => /\bclaude\b[^|;&]*\s'?(-p|--print)'?(\s|$)/.test(a))).toBe(false)
    }
  })

  it('a host that refuses SSH fails the start with session:error, and no session completes', async () => {
    expect(refusedStart).not.toBeNull()
    const outcome = await refusedStart!
    refusedStartWs?.close()
    expect(outcome.name).toBe('session:error')
    expect(outcome.data?.taskId).toBe('ssh-task-001')
    expect(typeof outcome.data?.error).toBe('string')
    expect((outcome.data!.error as string).length).toBeGreaterThan(0)

    const res = await fetch(apiUrl('/api/sessions/task/ssh-task-001'))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { sessions: Array<{ host?: string; process_status?: string }> }
    const onHost = body.sessions.filter((s) => s.host === 'test-host')
    for (const s of onHost) {
      expect(s.process_status).not.toBe('stopped')
      expect(s.process_status).not.toBe('running')
    }
  }, 90_000)
})

// ── SSH session with port ──

describe('SSH session with custom port', () => {
  it('session:start with port-host dials admin@remotebox.example.com with -p 2222', async () => {
    const ws = await connectWs()
    try {
      const rpcRes = await sendWsRpc(ws, 'session:start', {
        taskId: 'ssh-task-002',
        message: 'port test via ssh',
        project: 'RemoteProject',
        host: 'port-host',
        cwd: '/tmp/test-ssh-port',
      })
      expect((rpcRes as Record<string, unknown>).ok).toBe(true)

      await vi.waitFor(() => expect(sshDialsTo('admin@remotebox.example.com').length).toBeGreaterThan(0),
        { timeout: 20_000, interval: 100 })
      for (const argv of sshDialsTo('admin@remotebox.example.com')) {
        const portIdx = argv.indexOf('-p')
        expect(portIdx).toBeGreaterThan(-1)
        expect(argv[portIdx + 1]).toBe('2222')
        expect(sshOptions(argv)).toEqual(expect.arrayContaining(['BatchMode=yes', 'StrictHostKeyChecking=no']))
      }
    } finally {
      ws.close()
    }
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

    // Nothing in this file ran a session on this machine (a local session would
    // reach the local daemon and its real `claude`)
    const allRes = await fetch(apiUrl('/api/sessions'))
    expect(allRes.status).toBe(200)
    const all = (await allRes.json()) as { sessions: Array<{ host?: string | null }> }
    for (const s of all.sessions) expect(['test-host', 'port-host']).toContain(s.host)

    ws.close()
    await delay(50)
  })
})
