/**
 * ACP session server E2E — the full Phase 3 stack through a REAL web server:
 *
 *   HTTP quick-start (engine=codex) → SessionRunner.handleAcpStart → AcpSession
 *   → real daemon binary (acp* RPC family) → real acp-worker bundle → mock ACP
 *   agent → journal push frames → acp-stream-normalizer → Walnut bus events.
 *
 * Only the ACP agent binary is mocked (tests/AGENTS.md rule). Covers:
 * quick-start stream, warm follow-up, permission approve/deny over the HTTP
 * permission route, interrupt-and-replace, re-attach after the runner loses
 * its in-memory session (web-server-restart equivalent), and worker-kill +
 * lazy resume on next message.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { spawn, type ChildProcess } from 'node:child_process'
import type { Server as HttpServer } from 'node:http'
import { fileURLToPath } from 'node:url'
import { createMockConstants } from '../helpers/mock-constants.js'

const isolatedDaemonEnv = vi.hoisted(() => {
  const previous = process.env.WALNUT_DAEMON_DIR
  const daemonDir = `/tmp/acp-srv-e2e-daemon-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`
  process.env.WALNUT_DAEMON_DIR = daemonDir
  return { daemonDir, previous }
})

vi.mock('../../src/constants.js', () => createMockConstants('walnut-e2e-acp-session'))

// Offline model for async task-title refinement.
vi.mock('../../src/agent/model.js', () => ({
  sendMessage: vi.fn(async () => ({
    content: [{ type: 'text', text: 'Codex Task' }],
    stopReason: 'end_turn',
  })),
}))

import { WALNUT_HOME, TASKS_FILE } from '../../src/constants.js'
import { startServer, stopServer } from '../../src/web/server.js'
import { sessionRunner } from '../../src/providers/claude-code-session.js'
import { getDirectDaemonConnection } from '../../src/providers/daemon-connection.js'
import { bus, EventNames } from '../../src/core/event-bus.js'
import { getSessionsForTask } from '../../src/core/session-tracker.js'
import { getTask, listTasks } from '../../src/core/task-manager.js'
import { getQueue, sendMessageToSession } from '../../src/core/session-message-queue.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(__dirname, '../..')
const DAEMON_BIN = path.join(REPO_ROOT, 'dist/daemon-binaries/daemon-darwin-arm64')
const WORKER_BUNDLE = path.join(REPO_ROOT, 'dist/daemon-binaries/acp-worker.js')
const MOCK_AGENT = path.join(REPO_ROOT, 'tests/providers/mock-acp-agent.mjs')

const HAVE_BIN = fs.existsSync(DAEMON_BIN) && fs.existsSync(WORKER_BUNDLE)
  && process.platform === 'darwin' && process.arch === 'arm64'

let server: HttpServer
let port: number
let daemonProc: ChildProcess | null = null
let daemonWsUrl: string
let daemonDir: string
let streamsDir: string

// ── Bus capture ──

interface Captured {
  name: string
  data: Record<string, unknown>
  destinations: string[]
}
const captured: Captured[] = []

function eventsFor(sessionId: string, name?: string): Captured[] {
  return captured.filter((e) =>
    (e.data as { sessionId?: string }).sessionId === sessionId && (!name || e.name === name))
}

function textFor(sessionId: string): string {
  return eventsFor(sessionId, EventNames.SESSION_TEXT_DELTA)
    .map((e) => (e.data as { delta?: string }).delta ?? '').join('')
}

async function waitFor<T>(fn: () => T | undefined | false, timeoutMs = 15_000, what = 'condition'): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const v = fn()
    if (v) return v as T
    if (Date.now() > deadline) throw new Error(`timeout waiting for ${what}`)
    await new Promise((r) => setTimeout(r, 50))
  }
}

async function waitForAsync<T>(
  fn: () => Promise<T | undefined | false>,
  timeoutMs = 15_000,
  what = 'condition',
): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await fn()
    if (value) return value as T
    if (Date.now() > deadline) throw new Error(`timeout waiting for ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

function apiUrl(p: string): string { return `http://localhost:${port}${p}` }

async function quickStartCodex(message: string): Promise<{ taskId: string }> {
  const res = await fetch(apiUrl('/api/sessions/quick-start'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cwd: os.tmpdir(), message, engine: 'codex' }),
  })
  expect(res.status).toBe(200)
  return await res.json() as { taskId: string }
}

interface PromptAcceptedFact {
  kind: 'meta'
  event: {
    type: 'prompt-accepted'
    commandId: string
    walnutMessageId: string
    text: string
  }
}

function journalRecords(runtimeId: string): Array<Record<string, unknown>> {
  const content = fs.readFileSync(path.join(streamsDir, runtimeId + '.acp.jsonl'), 'utf-8')
  return content.split('\n').filter(Boolean).map((line) =>
    JSON.parse(line) as Record<string, unknown>)
}

function promptFacts(runtimeId: string): PromptAcceptedFact[] {
  return journalRecords(runtimeId).filter((record): record is PromptAcceptedFact =>
    record.kind === 'meta'
      && (record.event as { type?: string } | undefined)?.type === 'prompt-accepted')
}

/** Poll the session record the AcpSession creates once session/new answers. */
async function sessionIdForTask(taskId: string): Promise<string> {
  const deadline = Date.now() + 20_000
  for (;;) {
    const records = await getSessionsForTask(taskId)
    const rec = records.find((r) => r.engine === 'codex')
    if (rec) return rec.claudeSessionId
    if (Date.now() > deadline) throw new Error(`timeout waiting for codex session record for task ${taskId}`)
    await new Promise((r) => setTimeout(r, 50))
  }
}

beforeAll(async () => {
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true })
  await fsp.mkdir(path.dirname(TASKS_FILE), { recursive: true })
  await fsp.writeFile(TASKS_FILE, JSON.stringify({ version: 1, tasks: [] }))

  // Real daemon binary in an isolated dir (never the prod daemon).
  daemonDir = isolatedDaemonEnv.daemonDir
  fs.rmSync(daemonDir, { recursive: true, force: true })
  fs.mkdirSync(daemonDir, { recursive: true })
  streamsDir = daemonDir + '-streams'
  const daemonPort = await new Promise<number>((resolve, reject) => {
    const p = spawn(DAEMON_BIN, ['--start'], {
      env: {
        ...process.env,
        WALNUT_DAEMON_DIR: daemonDir,
        MOCK_ACP_STATUS_TOOL_MS: '1500',
        MOCK_ACP_CHILD_PID_FILE: path.join(daemonDir, 'ignored-cancel-child.pid'),
        MOCK_ACP_FAIL_LOAD_FILE: path.join(daemonDir, 'fail-next-load'),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    daemonProc = p
    const timer = setTimeout(() => reject(new Error('daemon spawn timeout')), 15_000)
    p.stdout!.on('data', (chunk: Buffer) => {
      const m = chunk.toString().match(/^\d+$/m)
      if (m) { clearTimeout(timer); resolve(parseInt(m[0], 10)) }
    })
    p.on('exit', (code) => { clearTimeout(timer); reject(new Error('daemon exited early: ' + code)) })
  })

  daemonWsUrl = `ws://127.0.0.1:${daemonPort}`
  sessionRunner.setTestDaemonUrl(daemonWsUrl)
  sessionRunner.setTestAcpArtifacts({
    workerCmd: [process.execPath, WORKER_BUNDLE],
    adapterCmd: [process.execPath, MOCK_AGENT],
  })

  bus.subscribe('test-capture-acp', (event) => {
    captured.push({
      name: event.name,
      data: (event.data ?? {}) as Record<string, unknown>,
      destinations: event.destinations,
    })
  }, {
    global: true,
    interest: [
      EventNames.SESSION_TEXT_DELTA, EventNames.SESSION_THINKING_DELTA,
      EventNames.SESSION_TOOL_USE, EventNames.SESSION_TOOL_RESULT,
      EventNames.SESSION_RESULT, EventNames.SESSION_ERROR,
      EventNames.SESSION_PERMISSION_REQUEST, EventNames.SESSION_PERMISSION_RESOLVED,
      EventNames.SESSION_SYSTEM_EVENT, EventNames.SESSION_START,
      EventNames.SESSION_STATUS_CHANGED,
    ],
  })

  server = await startServer({ port: 0, dev: true })
  const addr = server.address()
  port = typeof addr === 'object' && addr ? addr.port : 0
  await new Promise((r) => setTimeout(r, 1500)) // let subscribers settle
}, 40_000)

afterAll(async () => {
  try { bus.unsubscribe('test-capture-acp') } catch { /* ignore */ }
  sessionRunner.setTestDaemonUrl(undefined)
  sessionRunner.setTestAcpArtifacts(undefined)
  await stopServer()
  if (daemonProc && daemonProc.exitCode === null) daemonProc.kill('SIGKILL')
  daemonProc = null
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
  fs.rmSync(daemonDir, { recursive: true, force: true })
  fs.rmSync(streamsDir, { recursive: true, force: true })
  if (isolatedDaemonEnv.previous === undefined) {
    delete process.env.WALNUT_DAEMON_DIR
  } else {
    process.env.WALNUT_DAEMON_DIR = isolatedDaemonEnv.previous
  }
})

describe.runIf(HAVE_BIN)('ACP codex session through the real server', () => {
  let taskId: string
  let sessionId: string

  it('quick-start engine=codex creates a codex session record and streams the reply', async () => {
    const resp = await quickStartCodex('hello codex e2e')
    taskId = resp.taskId
    expect(taskId).toBeTruthy()

    sessionId = await sessionIdForTask(taskId)
    expect(sessionId).toMatch(/^mock-session-/)

    await waitFor(() => eventsFor(sessionId, EventNames.SESSION_RESULT).length > 0, 15_000, 'first turn result')
    expect(textFor(sessionId)).toContain('you said: hello codex e2e')

    const records = await getSessionsForTask(taskId)
    const rec = records.find((r) => r.claudeSessionId === sessionId)!
    expect(rec.engine).toBe('codex')
    expect(rec.acpRuntimeId).toMatch(/^acp-/)
    expect(rec.host ?? '__local__').toBe('__local__')
    expect(rec.messageCount).toBe(1)
    expect(rec.process_status).toBe('idle')
    expect(rec.status_reason).toBe('turn_completed')

    const task = await getTask(taskId)
    expect(task.exec_session_id).toBe(sessionId)
    expect(task.session_id).toBe(sessionId)
    expect(task.session_ids.filter((id) => id === sessionId)).toHaveLength(1)

    const facts = promptFacts(rec.acpRuntimeId!)
    expect(facts).toHaveLength(1)
    expect(facts[0].event).toEqual(expect.objectContaining({
      commandId: `acp-prompt:${facts[0].event.walnutMessageId}`,
      text: 'hello codex e2e',
    }))
    expect(facts[0].event.walnutMessageId).toMatch(/^qm-/)

    const search = await fetch(apiUrl(`/api/search?q=${sessionId}&types=task,memory`))
    expect(search.status).toBe(200)
    expect((await search.json() as { results: unknown[] }).results).toEqual([
      expect.objectContaining({ type: 'task', taskId, sessionId }),
    ])
  }, 30_000)

  it('discovers ACP models, switches live, and persists acpModel', async () => {
    const catalogResponse = await fetch(apiUrl(`/api/sessions/${sessionId}/model-catalog`))
    expect(catalogResponse.status).toBe(200)
    expect(await catalogResponse.json()).toEqual({
      source: 'acp',
      currentModelId: 'mock-gpt-best',
      models: [
        {
          modelId: 'mock-gpt-best',
          name: 'Mock GPT Best',
          description: 'Best mock model',
        },
        {
          modelId: 'mock-gpt-fast',
          name: 'Mock GPT Fast',
          description: 'Fast mock model',
        },
      ],
    })

    const switchResponse = await fetch(apiUrl(`/api/sessions/${sessionId}/model`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'mock-gpt-fast' }),
    })
    expect(switchResponse.status).toBe(200)
    expect(await switchResponse.json()).toEqual({
      applied: true,
      model: 'mock-gpt-fast',
    })

    const sessionResponse = await fetch(apiUrl(`/api/sessions/${sessionId}`))
    expect(sessionResponse.status).toBe(200)
    expect((await sessionResponse.json() as {
      session: { acpModel?: string }
    }).session.acpModel).toBe('mock-gpt-fast')
  }, 30_000)

  it('discovers and changes generic ACP controls through compatibility routes', async () => {
    const initialResponse = await fetch(apiUrl(`/api/sessions/${sessionId}/controls`))
    expect(initialResponse.status).toBe(200)
    expect((await initialResponse.json() as {
      controls: Array<{ id: string; currentValue: string }>
    }).controls.map(({ id, currentValue }) => ({ id, currentValue }))).toEqual([
      { id: 'mode', currentValue: 'agent' },
      { id: 'collaboration_mode', currentValue: 'default' },
    ])

    const modeResponse = await fetch(apiUrl(`/api/sessions/${sessionId}/controls`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'mode', value: 'read-only' }),
    })
    expect(modeResponse.status).toBe(200)

    const afterMode = await fetch(apiUrl(`/api/sessions/${sessionId}/controls`))
    expect((await afterMode.json() as {
      controls: Array<{ id: string; currentValue: string }>
    }).controls.find((control) => control.id === 'mode')?.currentValue).toBe('read-only')

    const patchResponse = await fetch(apiUrl(`/api/sessions/${sessionId}`), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'plan' }),
    })
    expect(patchResponse.status).toBe(200)

    await waitForAsync(async () => {
      const response = await fetch(apiUrl(`/api/sessions/${sessionId}/controls`))
      const body = await response.json() as {
        controls: Array<{ id: string; currentValue: string }>
      }
      return body.controls.find((control) => control.id === 'collaboration_mode')?.currentValue === 'plan'
    }, 5_000, 'live collaboration mode plan')

    const restoreResponse = await fetch(apiUrl(`/api/sessions/${sessionId}`), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'default' }),
    })
    expect(restoreResponse.status).toBe(200)
    await waitForAsync(async () => {
      const response = await fetch(apiUrl(`/api/sessions/${sessionId}/controls`))
      const body = await response.json() as {
        controls: Array<{ id: string; currentValue: string }>
      }
      return body.controls.find((control) => control.id === 'collaboration_mode')?.currentValue === 'default'
    }, 5_000, 'live collaboration mode restore')
  }, 30_000)

  it('warm follow-up reuses the live worker (no session-loaded replay)', async () => {
    const beforeRecord = (await getSessionsForTask(taskId))
      .find((record) => record.claudeSessionId === sessionId)!
    const runtimeId = beforeRecord.acpRuntimeId!
    const before = eventsFor(sessionId, EventNames.SESSION_RESULT).length
    await sendMessageToSession(sessionId, 'follow-up message', { source: 'ui', taskId })
    await waitFor(() => eventsFor(sessionId, EventNames.SESSION_RESULT).length > before, 15_000, 'follow-up result')
    expect(textFor(sessionId)).toContain('you said: follow-up message')
    const afterRecord = (await getSessionsForTask(taskId))
      .find((record) => record.claudeSessionId === sessionId)!
    expect(afterRecord.acpRuntimeId).toBe(runtimeId)
    expect(afterRecord.messageCount).toBe(2)
    expect(afterRecord.process_status).toBe('idle')
    expect(promptFacts(runtimeId).map((fact) => fact.event.text))
      .toEqual(['hello codex e2e', 'follow-up message'])
    // Warm path: the journal must NOT contain a session-loaded meta (no cold resume).
    const journal = fs.readFileSync(path.join(streamsDir, runtimeId + '.acp.jsonl'), 'utf-8')
    expect(journal).not.toContain('"session-loaded"')
  }, 30_000)

  it('keeps ACP status and journal streaming alive across a daemon WS flap', async () => {
    const statusesBefore = eventsFor(sessionId, EventNames.SESSION_STATUS_CHANGED).length
    const resultsBefore = eventsFor(sessionId, EventNames.SESSION_RESULT).length
    await sendMessageToSession(sessionId, 'lifecycle-slow reconnect stream', {
      source: 'ui',
      taskId,
    })
    await waitFor(
      () => textFor(sessionId).includes('thinking...'),
      15_000,
      'first pre-flap stream chunk',
    )
    await waitForAsync(async () => {
      const record = (await getSessionsForTask(taskId))
        .find((candidate) => candidate.claudeSessionId === sessionId)
      return record?.process_status === 'running'
    }, 15_000, 'running ACP record before flap')

    const conn = await getDirectDaemonConnection('__local__', daemonWsUrl)
    const socket = (conn as unknown as {
      ws: { terminate(): void } | null
    }).ws
    expect(socket).not.toBeNull()
    socket!.terminate()

    await waitFor(() => !conn.connected, 5_000, 'daemon connection drop')
    await waitFor(() => conn.connected, 10_000, 'daemon connection reconnect')
    const afterReconnect = await waitForAsync(async () => {
      const record = (await getSessionsForTask(taskId))
        .find((candidate) => candidate.claudeSessionId === sessionId)
      return record?.status_reason === 'daemon_reconnected' ? record : false
    }, 10_000, 'ACP reconnect status')
    expect(afterReconnect.process_status).not.toBe('stopped')
    await waitFor(
      () => textFor(sessionId).includes('still working...'),
      10_000,
      'post-reconnect stream chunk',
    )
    await waitFor(
      () => eventsFor(sessionId, EventNames.SESSION_RESULT).length > resultsBefore,
      15_000,
      'post-reconnect result event',
    )
    expect(textFor(sessionId)).toContain('done: slow reply')
    expect(eventsFor(sessionId, EventNames.SESSION_STATUS_CHANGED)
      .slice(statusesBefore)
      .map((event) => event.data.process_status))
      .not.toContain('stopped')
  }, 35_000)

  it('keeps status authoritative while steering follow-ups into a slow tool turn', async () => {
    const runtimeId = findRuntimeId()
    const before = eventsFor(sessionId, EventNames.SESSION_RESULT).length
    const statusesBefore = eventsFor(sessionId, EventNames.SESSION_STATUS_CHANGED).length
    await sendMessageToSession(sessionId, 'status-slow-tool queue gate', { source: 'ui', taskId })
    await waitFor(
      () => eventsFor(sessionId, EventNames.SESSION_TOOL_USE)
        .some((event) => event.data.toolName === 'Status slow subprocess'),
      15_000,
      'slow tool start',
    )
    await waitForAsync(async () => {
      const record = (await getSessionsForTask(taskId))
        .find((candidate) => candidate.claudeSessionId === sessionId)
      return record?.process_status === 'running'
    }, 15_000, 'running session record')
    expect(eventsFor(sessionId, EventNames.SESSION_STATUS_CHANGED).at(-1)).toMatchObject({
      data: { process_status: 'running' },
      destinations: ['*'],
    })

    await sendMessageToSession(sessionId, 'rapid follow-up one', { source: 'ui', taskId })
    await sendMessageToSession(sessionId, 'rapid follow-up two', { source: 'ui', taskId })
    await waitForAsync(async () => (await getQueue(sessionId)).length === 0,
      5_000, 'steered queue drain')
    expect((await getSessionsForTask(taskId))
      .find((candidate) => candidate.claudeSessionId === sessionId)?.process_status)
      .toBe('running')

    await waitFor(
      () => eventsFor(sessionId, EventNames.SESSION_RESULT).length >= before + 1,
      20_000,
      'one steered terminal turn',
    )
    const records = journalRecords(runtimeId)
    const prompts = records.filter((record) =>
      record.kind === 'meta'
        && (record.event as { type?: string } | undefined)?.type === 'prompt-accepted')
    const steers = records.filter((record) =>
      record.kind === 'meta'
        && (record.event as { type?: string } | undefined)?.type === 'steer-accepted')
      .map((record) => (record.event as { text?: string }).text)
    expect((prompts.at(-1)?.event as { text?: string }).text).toBe('status-slow-tool queue gate')
    expect(steers.slice(-2)).toEqual(['rapid follow-up one', 'rapid follow-up two'])
    const statusEvents = eventsFor(sessionId, EventNames.SESSION_STATUS_CHANGED)
      .slice(statusesBefore)
    expect(statusEvents.map((event) => event.data.process_status)).toEqual([
      'running', 'idle',
    ])
    expect(statusEvents.every((event) => {
      const data = event.data as Record<string, unknown>
      const status = data.status as Record<string, unknown> | undefined
      const snapshotFields = [
        'sessionId', 'taskId', 'process_status', 'activity', 'mode',
        'planCompleted', 'archived', 'errorMessage', 'pendingPermissionTool',
        'provider', 'engine', 'statusRevision', 'statusUpdatedAt',
      ]
      return typeof data.statusRevision === 'number'
        && typeof data.statusUpdatedAt === 'string'
        && data.activity !== undefined
        && data.mode !== undefined
        && data.planCompleted !== undefined
        && data.archived !== undefined
        && data.errorMessage !== undefined
        && data.provider !== undefined
        && data.engine !== undefined
        && data.taskId !== undefined
        && status !== undefined
        && Object.keys(status).length === snapshotFields.length
        && snapshotFields.every((field) => status[field] === data[field])
    })).toBe(true)
    const revisions = statusEvents.map((event) =>
      Number((event.data as { statusRevision: number }).statusRevision))
    expect(revisions.slice(1).every((revision, index) =>
      revision === revisions[index] + 1)).toBe(true)
    expect(statusEvents.every((event) =>
      event.destinations.length === 1 && event.destinations[0] === '*')).toBe(true)
  }, 30_000)

  it('restores a pending permission through GET after the runner loses its ACP session', async () => {
    const permissionEventsBefore = eventsFor(
      sessionId,
      EventNames.SESSION_PERMISSION_REQUEST,
    ).length
    const resultsBefore = eventsFor(sessionId, EventNames.SESSION_RESULT).length
    await sendMessageToSession(sessionId, 'permission-test reload recovery', {
      source: 'ui',
      taskId,
    })
    const initialPermission = await waitFor(
      () => eventsFor(sessionId, EventNames.SESSION_PERMISSION_REQUEST)[permissionEventsBefore],
      15_000,
      'permission request before reload',
    )
    const requestId = initialPermission.data.requestId as string
    await waitForAsync(async () => {
      const record = (await getSessionsForTask(taskId))
        .find((candidate) => candidate.claudeSessionId === sessionId)
      return record?.pendingPermission?.requestId === requestId ? record : false
    }, 5_000, 'durable ACP permission')

    const state = sessionRunner as unknown as {
      acpSessions: Map<string, { detach(): void }>
    }
    for (const session of new Set(state.acpSessions.values())) session.detach()
    state.acpSessions.clear()

    const response = await fetch(apiUrl(`/api/sessions/${sessionId}`))
    expect(response.status).toBe(200)
    const body = await response.json() as {
      pendingPermissions: Array<{
        requestId: string
        toolName?: string
        input?: Record<string, unknown>
      }>
    }
    expect(body.pendingPermissions).toEqual([expect.objectContaining({
      requestId,
      toolName: 'Write file /tmp/mock.txt',
    })])

    await waitFor(
      () => eventsFor(sessionId, EventNames.SESSION_PERMISSION_REQUEST).length
        === permissionEventsBefore + 2,
      15_000,
      'restored permission event',
    )
    const secondResponse = await fetch(apiUrl(`/api/sessions/${sessionId}`))
    expect(secondResponse.status).toBe(200)
    expect(eventsFor(sessionId, EventNames.SESSION_PERMISSION_REQUEST))
      .toHaveLength(permissionEventsBefore + 2)

    const permissionResponse = await fetch(apiUrl(`/api/sessions/${sessionId}/permission`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requestId, allow: true }),
    })
    expect(permissionResponse.status).toBe(200)
    await waitFor(
      () => eventsFor(sessionId, EventNames.SESSION_RESULT).length > resultsBefore,
      15_000,
      'permission turn result after reload',
    )
    await waitForAsync(async () => {
      const record = (await getSessionsForTask(taskId))
        .find((candidate) => candidate.claudeSessionId === sessionId)
      return record?.pendingPermission === undefined
    }, 5_000, 'durable ACP permission clear')
  }, 30_000)

  it('permission approve round-trips through the HTTP permission route', async () => {
    const before = eventsFor(sessionId, EventNames.SESSION_PERMISSION_REQUEST).length
    await sendMessageToSession(sessionId, 'permission-test', { source: 'ui', taskId })
    const permEvent = await waitFor(() => eventsFor(sessionId, EventNames.SESSION_PERMISSION_REQUEST)[before],
      15_000, 'permission request event')
    const requestId = (permEvent.data as { requestId?: string }).requestId!
    expect(requestId).toBeTruthy()
    const options = (permEvent.data as { acpOptions?: Array<{ optionId: string }> }).acpOptions ?? []
    expect(options.map((o) => o.optionId)).toContain('allow-once')

    const res = await fetch(apiUrl(`/api/sessions/${sessionId}/permission`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requestId, allow: true }),
    })
    expect(res.status).toBe(200)

    await waitFor(() => eventsFor(sessionId, EventNames.SESSION_PERMISSION_RESOLVED)
      .some((e) => (e.data as { requestId?: string }).requestId === requestId), 15_000, 'permission resolved')
    await waitFor(() => textFor(sessionId).includes('permission granted: allow-once'), 15_000, 'granted text')
  }, 30_000)

  it('permission deny picks the reject option', async () => {
    const before = eventsFor(sessionId, EventNames.SESSION_PERMISSION_REQUEST).length
    await sendMessageToSession(sessionId, 'permission-test again', { source: 'ui', taskId })
    const permEvent = await waitFor(() => eventsFor(sessionId, EventNames.SESSION_PERMISSION_REQUEST)[before],
      15_000, 'second permission request')
    const requestId = (permEvent.data as { requestId?: string }).requestId!

    const res = await fetch(apiUrl(`/api/sessions/${sessionId}/permission`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requestId, allow: false }),
    })
    expect(res.status).toBe(200)
    await waitFor(() => textFor(sessionId).includes('permission granted: reject-once'), 15_000, 'reject option text')
  }, 30_000)

  it('interrupt kills the tool descendant before accepting the queued replacement', async () => {
    const runtimeId = findRuntimeId()
    const childPidFile = path.join(daemonDir, 'ignored-cancel-child.pid')
    await fsp.rm(childPidFile, { force: true })
    await sendMessageToSession(sessionId, 'ignored-cancel-child', { source: 'ui', taskId })
    await waitFor(() => fs.existsSync(childPidFile), 15_000, 'mock tool child pid')
    const childPid = Number(fs.readFileSync(childPidFile, 'utf-8'))
    expect(childPid).toBeGreaterThan(0)

    await sendMessageToSession(sessionId, 'after interrupt', { source: 'ui', taskId, interrupt: true })
    await waitFor(() => textFor(sessionId).includes('you said: after interrupt'), 20_000, 'replacement turn reply')

    expect(() => process.kill(childPid, 0)).toThrow()
    const records = journalRecords(runtimeId)
    const interruptedAt = records.findIndex((record) =>
      record.kind === 'meta'
        && (record.event as { type?: string } | undefined)?.type === 'turn-interrupted')
    const replacementAt = records.findIndex((record) =>
      record.kind === 'meta'
        && (record.event as { type?: string; text?: string } | undefined)?.type === 'prompt-accepted'
        && (record.event as { text?: string }).text === 'after interrupt')
    expect(interruptedAt).toBeGreaterThanOrEqual(0)
    expect(replacementAt).toBeGreaterThan(interruptedAt)
  }, 30_000)

  it('re-attaches from the record after the runner loses its in-memory session (server-restart equivalent)', async () => {
    // Simulate a web-server restart: the runner's in-memory ACP map is empty,
    // but the record (engine + acpRuntimeId + providerSessionId) survives.
    const recordBefore = await waitForAsync(async () => {
      const record = (await getSessionsForTask(taskId))
        .find((candidate) => candidate.claudeSessionId === sessionId)
      return record?.process_status === 'idle' ? record : false
    }, 15_000, 'interrupt replacement committed idle')
    const statusCountBefore = eventsFor(sessionId, EventNames.SESSION_STATUS_CHANGED).length
    const journalPath = path.join(streamsDir, findRuntimeId() + '.acp.jsonl')
    const loadedBefore = fs.readFileSync(journalPath, 'utf-8').match(/"session-loaded"/g)?.length ?? 0
    const state = sessionRunner as unknown as {
      acpSessions: Map<string, { detach(): void }>
    }
    for (const session of new Set(state.acpSessions.values())) session.detach()
    state.acpSessions.clear()

    await sendMessageToSession(sessionId, 'post-restart message', { source: 'ui', taskId })
    await waitFor(() => textFor(sessionId).includes('you said: post-restart message'), 20_000, 'post-restart reply')
    const recordAfter = await waitForAsync(async () => {
      const record = (await getSessionsForTask(taskId))
        .find((candidate) => candidate.claudeSessionId === sessionId)
      return record?.process_status === 'idle'
        && record.statusRevision === recordBefore.statusRevision! + 2
        ? record
        : false
    }, 20_000, 'post-restart committed idle revision')
    const statusEvents = eventsFor(sessionId, EventNames.SESSION_STATUS_CHANGED)
      .slice(statusCountBefore)
    expect(statusEvents.map((event) => event.data.process_status)).toEqual([
      'running',
      'idle',
    ])
    expect(statusEvents.map((event) => event.data.statusRevision)).toEqual([
      recordBefore.statusRevision! + 1,
      recordBefore.statusRevision! + 2,
    ])
    expect(recordAfter.statusRevision).toBe(statusEvents[1].data.statusRevision)
    expect(recordAfter.statusUpdatedAt).toBe(statusEvents[1].data.statusUpdatedAt)
    // Worker was still alive → attach (alive:true), not a cold session/load.
    const loadedAfter = fs.readFileSync(journalPath, 'utf-8').match(/"session-loaded"/g)?.length ?? 0
    expect(loadedAfter).toBe(loadedBefore)
  }, 30_000)

  it('worker kill → next message lazy-resumes via session/load', async () => {
    // Kill the worker out from under the daemon (idle-reap / crash stand-in).
    const pids = JSON.parse(fs.readFileSync(path.join(daemonDir, 'acp-workers.json'), 'utf-8')) as Record<string, number>
    const runtimeId = findRuntimeId()
    expect(pids[runtimeId]).toBeTruthy()
    process.kill(pids[runtimeId], 'SIGKILL')
    await new Promise((r) => setTimeout(r, 500)) // daemon reaps the exit

    await sendMessageToSession(sessionId, 'after worker death', { source: 'ui', taskId })
    await waitFor(() => textFor(sessionId).includes('you said: after worker death'), 20_000, 'post-resume reply')

    // This time it WAS a cold resume: session/load journaled, but provider-load
    // history remains diagnostic and is not emitted as current live output.
    const journal = fs.readFileSync(path.join(streamsDir, runtimeId + '.acp.jsonl'), 'utf-8')
    expect(journal).toContain('"session-loaded"')
    expect(textFor(sessionId)).not.toContain('replayed: earlier reply')
  }, 30_000)

  it('load failure preserves history, migrates identity once, and leaves no phantom queue', async () => {
    const previousSessionId = sessionId
    const beforeRecord = (await getSessionsForTask(taskId))
      .find((record) => record.claudeSessionId === previousSessionId)!
    const runtimeId = beforeRecord.acpRuntimeId!
    const errorsBefore = eventsFor(previousSessionId, EventNames.SESSION_ERROR).length
    const failOnceFile = path.join(daemonDir, 'fail-next-load')
    fs.writeFileSync(failOnceFile, 'fail next session/load')

    const pids = JSON.parse(
      fs.readFileSync(path.join(daemonDir, 'acp-workers.json'), 'utf-8'),
    ) as Record<string, number>
    expect(pids[runtimeId]).toBeTruthy()
    process.kill(pids[runtimeId], 'SIGKILL')
    await new Promise((resolve) => setTimeout(resolve, 500))

    await sendMessageToSession(previousSessionId, 'after load fallback', {
      source: 'ui',
      taskId,
    })

    const replacement = await waitForAsync(async () => {
      const records = await getSessionsForTask(taskId)
      return records.find((record) =>
        record.engine === 'codex'
          && record.claudeSessionId !== previousSessionId
          && record.acpRuntimeId === runtimeId)
    }, 20_000, 'fallback replacement session record')
    const newSessionId = replacement.claudeSessionId

    await waitFor(
      () => eventsFor(newSessionId, EventNames.SESSION_RESULT).length > 0,
      20_000,
      'fallback turn result',
    )
    const history = await waitForAsync(async () => {
      const response = await fetch(apiUrl(`/api/sessions/${newSessionId}/history`))
      if (response.status !== 200) return false
      const body = await response.json() as {
        messages: Array<{ role: string; text: string }>
      }
      return body.messages.some((message) => message.text.includes('after load fallback'))
        ? body.messages
        : false
    }, 20_000, 'fallback history')
    const historyText = history.map((message) => `${message.role}:${message.text}`).join('\n')
    expect(historyText).toContain('user:hello codex e2e')
    expect(historyText).toContain('assistant:hello from mock-acp (you said: hello codex e2e)')
    expect(historyText).toContain('user:after load fallback')
    expect(historyText).toContain('assistant:hello from mock-acp (you said: after load fallback)')

    const identityWarnings = captured.filter((event) =>
      event.name === EventNames.SESSION_SYSTEM_EVENT
        && event.data.previousSessionId === previousSessionId
        && event.data.newSessionId === newSessionId)
    expect(identityWarnings).toHaveLength(1)
    expect(identityWarnings[0].data).toEqual(expect.objectContaining({
      sessionId: previousSessionId,
      previousSessionId,
      newSessionId,
    }))
    expect(String(identityWarnings[0].data.message))
      .toMatch(/earlier history remains visible/i)
    expect(eventsFor(previousSessionId, EventNames.SESSION_ERROR)).toHaveLength(errorsBefore)

    expect(await getQueue(previousSessionId)).toEqual([])
    expect(await getQueue(newSessionId)).toEqual([])
    expect((await getSessionsForTask(taskId))
      .find((record) => record.claudeSessionId === previousSessionId)).toBeUndefined()
    const settled = (await getSessionsForTask(taskId))
      .find((record) => record.claudeSessionId === newSessionId)!
    expect(settled.messageCount).toBe(beforeRecord.messageCount + 1)
    expect(settled.process_status).toBe('idle')
    expect(settled.status_reason).toBe('turn_completed')
    const migrationStatus = eventsFor(newSessionId, EventNames.SESSION_STATUS_CHANGED)
      .find((event) => event.data.previousSessionId === previousSessionId)
    expect(migrationStatus).toMatchObject({
      data: {
        sessionId: newSessionId,
        previousSessionId,
        statusRevision: beforeRecord.statusRevision! + 2,
      },
      destinations: ['*'],
    })

    const task = await getTask(taskId)
    expect(task.session_id).toBe(newSessionId)
    expect(task.exec_session_id).toBe(newSessionId)
    expect(task.session_ids).toContain(newSessionId)
    expect(task.session_ids).not.toContain(previousSessionId)
    sessionId = newSessionId
  }, 40_000)

  it('rejects Codex fork before task creation or native session start', async () => {
    const taskIdsBefore = new Set((await listTasks()).map((task) => task.id))
    const nativeStartsBefore = captured.filter((event) =>
      event.name === EventNames.SESSION_START
        && (event.data as { forkedFromSessionId?: string }).forkedFromSessionId === sessionId).length

    const response = await fetch(apiUrl(`/api/sessions/${sessionId}/fork`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        create_child_task: true,
        message: 'unsupported Codex fork probe',
      }),
    })

    expect([409, 501]).toContain(response.status)
    expect(await response.json()).toEqual(expect.objectContaining({
      code: 'ACP_FORK_UNSUPPORTED',
    }))
    expect(new Set((await listTasks()).map((task) => task.id))).toEqual(taskIdsBefore)
    expect(captured.filter((event) =>
      event.name === EventNames.SESSION_START
        && (event.data as { forkedFromSessionId?: string }).forkedFromSessionId === sessionId))
      .toHaveLength(nativeStartsBefore)
  })

  function findRuntimeId(): string {
    const files = fs.readdirSync(streamsDir).filter((f) => f.endsWith('.acp.jsonl'))
    expect(files.length).toBe(1)
    return files[0].replace('.acp.jsonl', '')
  }
})
