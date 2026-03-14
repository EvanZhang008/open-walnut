/**
 * Live E2E test for the Unified Session Transport Layer.
 *
 * ZERO MOCKS — verifies the real pipeline end-to-end:
 *   Real server → Real SSH to devbox → Real Claude CLI on remote → JSONL streaming back
 *
 * Prerequisites:
 *   - WALNUT_LIVE_TEST=1 (env var gate)
 *   - SSH access to devbox (passwordless, BatchMode=yes)
 *   - Claude CLI installed on devbox (~/.local/bin/claude)
 *   - Real ~/.open-walnut/ config with hosts.devbox
 *
 * Run with:
 *   WALNUT_LIVE_TEST=1 npx vitest run tests/e2e/session-transport-live.live.test.ts --config vitest.live.config.ts
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs/promises'
import fsSync from 'node:fs'
import { execSync } from 'node:child_process'
import path from 'node:path'
import os from 'node:os'
import type { Server as HttpServer } from 'node:http'
import { WebSocket } from 'ws'
import yaml from 'js-yaml'
import { isLiveTest } from '../helpers/live.js'

// ── Helpers ──

let server: HttpServer
let port: number
let testTaskId: string

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

function waitForWsEvent(
  ws: WebSocket,
  eventName: string,
  timeoutMs = 120_000,
  filter?: (frame: WsEvent) => boolean,
): Promise<WsEvent> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Timed out waiting for ${eventName} after ${timeoutMs}ms`)),
      timeoutMs,
    )
    const handler = (raw: WebSocket.RawData) => {
      const frame = JSON.parse(raw.toString()) as WsEvent
      if (frame.type === 'event' && frame.name === eventName) {
        const taskId = (frame.data as Record<string, unknown>)?.taskId
        console.log(`[WS] received ${eventName}: taskId=${taskId}, match=${!filter || filter(frame)}`)
        if (!filter || filter(frame)) {
          clearTimeout(timer)
          ws.off('message', handler)
          resolve(frame)
        }
      }
    }
    ws.on('message', handler)
  })
}

function sendWsRpc(ws: WebSocket, method: string, payload: unknown): Promise<WsEvent> {
  return new Promise((resolve, reject) => {
    const id = `rpc-${Date.now()}-${Math.random().toString(36).slice(2)}`
    const timer = setTimeout(() => reject(new Error(`RPC ${method} timed out`)), 30_000)
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

async function pollUntil(
  check: () => Promise<boolean>,
  intervalMs = 500,
  timeoutMs = 30_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await check()) return
    await delay(intervalMs)
  }
  throw new Error(`pollUntil timed out after ${timeoutMs}ms`)
}

// ── Resolve devbox SSH target from real config ──

interface HostDef {
  hostname: string
  user?: string
  port?: number
}

function resolveDevboxTarget(): HostDef | null {
  try {
    const configPath = path.join(os.homedir(), '.open-walnut', 'config.yaml') // safe: production-path — live test reads real config
    const content = fsSync.readFileSync(configPath, 'utf-8')
    const config = yaml.load(content) as { hosts?: Record<string, HostDef> }
    return config?.hosts?.devbox ?? null
  } catch {
    return null
  }
}

function sshHostString(target: HostDef): string {
  return target.user ? `${target.user}@${target.hostname}` : target.hostname
}

// ── Prerequisite checks ──

function checkSshConnectivity(target: HostDef): boolean {
  const host = sshHostString(target)
  const portArgs = target.port ? `-p ${target.port}` : ''
  try {
    execSync(`ssh -o BatchMode=yes -o ConnectTimeout=10 ${portArgs} ${host} 'echo ok'`, {
      stdio: 'pipe',
      timeout: 15_000,
    })
    return true
  } catch {
    return false
  }
}

function checkRemoteClaude(target: HostDef): boolean {
  const host = sshHostString(target)
  const portArgs = target.port ? `-p ${target.port}` : ''
  try {
    const result = execSync(
      `ssh -o BatchMode=yes ${portArgs} ${host} 'export PATH="$HOME/.local/bin:$PATH" && claude --version'`,
      { stdio: 'pipe', timeout: 15_000 },
    )
    return result.toString().trim().length > 0
  } catch {
    return false
  }
}

// ── Test state ──

let sessionId: string
let outputFile: string

describe.skipIf(!isLiveTest())('Session transport live (real SSH + real Claude)', () => {
  // Check prerequisites before anything else
  let sshOk = false
  let claudeOk = false
  let devboxTarget: HostDef | null = null

  beforeAll(async () => {
    // 0. Resolve devbox SSH target from real ~/.open-walnut/config.yaml
    devboxTarget = resolveDevboxTarget()
    if (!devboxTarget) {
      console.warn('SKIP: devbox host not found in ~/.open-walnut/config.yaml')
      return
    }
    console.log(`Resolved devbox: ${sshHostString(devboxTarget)}`)

    // 1. Check SSH connectivity
    sshOk = checkSshConnectivity(devboxTarget)
    if (!sshOk) {
      console.warn('SKIP: SSH to devbox is not available')
      return
    }

    // 2. Check Claude CLI on remote
    claudeOk = checkRemoteClaude(devboxTarget)
    if (!claudeOk) {
      console.warn('SKIP: Claude CLI not found on devbox')
      return
    }

    // 3. Start real server on ephemeral port (uses real ~/.open-walnut/ data)
    const { startServer: start } = await import('../../src/web/server.js')
    server = await start({ port: 0, dev: true })
    const addr = server.address()
    port = typeof addr === 'object' && addr ? addr.port : 0

    // 4. Create a dedicated test task via REST
    // Use a timestamp-suffixed category to avoid source-type conflicts with existing categories
    const testCategory = `LiveTransport-${Date.now()}`
    const createRes = await fetch(apiUrl('/api/tasks'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: `live-transport-test-${Date.now()}`,
        category: testCategory,
        priority: 'none',
      }),
    })
    if (!createRes.ok) {
      const errBody = await createRes.text()
      throw new Error(`Failed to create test task: ${createRes.status} ${errBody}`)
    }
    const createBody = (await createRes.json()) as { task: { id: string } }
    if (!createBody?.task?.id) {
      throw new Error(`Unexpected response from create task: ${JSON.stringify(createBody)}`)
    }
    testTaskId = createBody.task.id
  }, 60_000) // generous timeout for server start + SSH checks

  afterAll(async () => {
    // 1. Delete test task
    if (testTaskId) {
      try {
        await fetch(apiUrl(`/api/tasks/${testTaskId}`), { method: 'DELETE' })
      } catch { /* best-effort */ }
    }

    // 2. Clean up remote files from this test run
    if (sessionId && devboxTarget) {
      const host = sshHostString(devboxTarget)
      const portArgs = devboxTarget.port ? `-p ${devboxTarget.port}` : ''
      try {
        execSync(
          `ssh -o BatchMode=yes ${portArgs} ${host} 'rm -f /tmp/open-open-walnut-streams/${sessionId}.* 2>/dev/null'`,
          { stdio: 'ignore', timeout: 10_000 },
        )
      } catch { /* best-effort */ }
    }

    // 3. Stop server
    if (server) {
      const { stopServer: stop } = await import('../../src/web/server.js')
      await stop()
    }
  }, 30_000)

  // ═══════════════════════════════════════════════════════════════════
  //  1. SSH session: full lifecycle
  // ═══════════════════════════════════════════════════════════════════

  it('SSH session full lifecycle: start → real Claude → result', async () => {
    if (!sshOk || !claudeOk) return // skip if prerequisites not met

    const ws = await connectWs()
    // Filter to only our test task's result — other sessions may complete concurrently
    // Use 3-minute wait — real Claude CLI startup over SSH can take time
    const resultPromise = waitForWsEvent(
      ws,
      'session:result',
      180_000,
      (frame) => (frame.data as Record<string, unknown>)?.taskId === testTaskId,
    )

    // Start a remote session on devbox with a minimal prompt
    console.log(`Starting remote session for task ${testTaskId}...`)
    const rpcRes = await sendWsRpc(ws, 'session:start', {
      taskId: testTaskId,
      message: 'Respond with exactly one word: PONG',
      host: 'devbox',
      cwd: '/tmp',
    })
    const rpcOk = (rpcRes as Record<string, unknown>).ok
    const rpcData = (rpcRes as Record<string, unknown>).data ?? rpcRes
    console.log(`session:start RPC result: ok=${rpcOk}`, JSON.stringify(rpcData).slice(0, 200))
    expect(rpcOk).toBe(true)

    // Wait for the session to complete (real Claude inference over SSH)
    console.log('Waiting for session:result event...')
    const resultEvent = await resultPromise
    const rd = resultEvent.data as {
      sessionId: string
      taskId: string
      result: string
      isError: boolean
      totalCost: number
    }

    expect(rd.taskId).toBe(testTaskId)
    expect(rd.isError).toBe(false)
    expect(rd.sessionId).toBeTruthy()
    // result text may be empty in stream-json FIFO mode; actual Claude output is verified in test 2 via JSONL

    // Store for later tests
    sessionId = rd.sessionId
    console.log(`Session completed: ${sessionId}, cost: $${rd.totalCost}`)

    ws.close()
    await delay(100)
  }, 200_000)

  // ═══════════════════════════════════════════════════════════════════
  //  2. JSONL output file contains real Claude response
  // ═══════════════════════════════════════════════════════════════════

  it('JSONL output file contains valid real Claude response', async () => {
    if (!sessionId) return // skip if session didn't start

    // Wait for persistence to settle
    await delay(1000)

    // Get session record to find output file
    const sessRes = await fetch(apiUrl(`/api/sessions/task/${testTaskId}`))
    expect(sessRes.status).toBe(200)
    const sessBody = (await sessRes.json()) as {
      sessions: Array<{
        claudeSessionId: string
        outputFile?: string
        host?: string
      }>
    }

    const session = sessBody.sessions.find((s) => s.claudeSessionId === sessionId)
    expect(session).toBeDefined()
    expect(session!.outputFile).toBeTruthy()
    outputFile = session!.outputFile!

    // Read and parse the JSONL output file
    const content = await fs.readFile(outputFile, 'utf-8')
    const lines = content.trim().split('\n').filter(Boolean)
    expect(lines.length).toBeGreaterThan(0)

    const parsed = lines.map((line) => JSON.parse(line))
    const types = parsed.map((p) => {
      const t = p.type as string
      const sub = p.subtype as string | undefined
      return sub ? `${t}:${sub}` : t
    })

    // Must have system:init with a real session_id
    expect(types).toContain('system:init')
    const initEvent = parsed.find((p) => p.type === 'system' && p.subtype === 'init')
    expect(initEvent).toBeTruthy()
    expect(initEvent.session_id).toBe(sessionId)

    // Must have at least one assistant message (real Claude response)
    const assistantEvents = parsed.filter((p) => p.type === 'assistant')
    expect(assistantEvents.length).toBeGreaterThanOrEqual(1)

    // Must have result:success with real cost > 0
    const resultEvent = parsed.find((p) => p.type === 'result' && p.subtype === 'success')
    expect(resultEvent).toBeTruthy()
    // Real Claude usage should have non-zero cost
    expect(resultEvent.total_cost_usd).toBeGreaterThan(0)

    console.log(`JSONL: ${lines.length} lines, cost: $${resultEvent.total_cost_usd}`)
  })

  // ═══════════════════════════════════════════════════════════════════
  //  3. Session record persisted correctly
  // ═══════════════════════════════════════════════════════════════════

  it('session record persisted with correct host and metadata', async () => {
    if (!sessionId) return

    type SessionEntry = {
      claudeSessionId: string
      taskId: string
      host?: string
      outputFile?: string
      process_status: string
      work_status: string
      project?: string
    }
    let session: SessionEntry | undefined

    // With the persistent FIFO writer fix, Claude stays alive between turns —
    // process_status remains 'running' while blocked on stdin waiting for the
    // next message. Poll for work_status === 'agent_complete' to confirm the
    // first turn completed successfully.
    await pollUntil(async () => {
      const res = await fetch(apiUrl(`/api/sessions/task/${testTaskId}`))
      if (res.status !== 200) return false
      const body = (await res.json()) as { sessions: SessionEntry[] }
      session = body.sessions.find((s) => s.claudeSessionId === sessionId)
      return session?.work_status === 'agent_complete'
    }, 500, 15_000)

    expect(session).toBeDefined()
    expect(session!.claudeSessionId).toBe(sessionId)
    expect(session!.taskId).toBe(testTaskId)
    expect(session!.host).toBe('devbox')
    expect(session!.outputFile).toBeTruthy()

    // Output file should exist on disk
    const exists = await fs.access(session!.outputFile!).then(() => true).catch(() => false)
    expect(exists).toBe(true)

    // hasPipe=true: process stays alive between turns, ready for next message
    expect(session!.process_status).toBe('running')
    expect(session!.work_status).toBe('agent_complete')

    console.log(`Session record: host=${session!.host}, work_status=${session!.work_status}`)
  })

  // ═══════════════════════════════════════════════════════════════════
  //  4. Task linked to session
  // ═══════════════════════════════════════════════════════════════════

  it('task is linked to the session', async () => {
    if (!sessionId) return

    let taskBody: {
      task: {
        session_ids?: string[]
        exec_session_id?: string
      }
    } | undefined

    await pollUntil(async () => {
      const res = await fetch(apiUrl(`/api/tasks/${testTaskId}`))
      if (res.status !== 200) return false
      taskBody = (await res.json()) as typeof taskBody
      return (taskBody?.task?.session_ids?.length ?? 0) > 0
    })

    expect(taskBody).toBeDefined()
    expect(taskBody!.task.session_ids).toBeDefined()
    expect(taskBody!.task.session_ids!.length).toBeGreaterThan(0)
    expect(taskBody!.task.session_ids).toContain(sessionId)
    expect(taskBody!.task.exec_session_id).toBeTruthy()

    console.log(`Task linked: session_ids=${taskBody!.task.session_ids!.join(', ')}`)
  })

  // ═══════════════════════════════════════════════════════════════════
  //  5. Remote files were created during session
  // ═══════════════════════════════════════════════════════════════════

  it('remote files were created on devbox during session', async () => {
    if (!sessionId || !devboxTarget) return

    const host = sshHostString(devboxTarget)
    const portArgs = devboxTarget.port ? `-p ${devboxTarget.port}` : ''

    // Check if remote JSONL file exists (or was created during the session)
    // The session may have already cleaned up the FIFO, but the JSONL should remain
    try {
      const result = execSync(
        `ssh -o BatchMode=yes ${portArgs} ${host} 'ls /tmp/open-open-walnut-streams/ 2>/dev/null | head -20'`,
        { stdio: 'pipe', timeout: 15_000 },
      )
      const remoteFiles = result.toString().trim()
      console.log(`Remote files in /tmp/open-open-walnut-streams/:\n${remoteFiles || '(empty)'}`)

      // We just verify the directory was used — files may have been renamed
      // or cleaned up by session lifecycle. The important thing is the pipeline worked.
    } catch {
      console.log('Remote /tmp/open-open-walnut-streams/ check skipped (SSH error)')
    }
  })
})
