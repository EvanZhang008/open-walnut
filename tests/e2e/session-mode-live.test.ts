/**
 * Live E2E tests for session mode propagation — real Claude CLI + Haiku model.
 *
 * These tests verify that --permission-mode is correctly passed to the real
 * Claude Code CLI at spawn, and that mid-session mode switches via
 * PATCH → set_permission_mode control_request apply LIVE on the SAME process
 * (no respawn — the third member of the live-settings family after
 * model/effort). The CLI confirms by echoing the mode in the control_response
 * and emitting a system/status event with the new permissionMode.
 *
 * Three-layer verification:
 *   Layer A: Walnut streaming capture (outputFile) — system/init events with permissionMode
 *   Layer B: Claude Code canonical JSONL (~/.claude/projects/...) — user events with permissionMode
 *   Layer C: Walnut session record (REST API) — mode field
 *
 * Gated by WALNUT_LIVE_MODE_TEST=1 — skipped in CI, run manually:
 *   WALNUT_LIVE_MODE_TEST=1 npx vitest run tests/e2e/session-mode-live.test.ts --config vitest.e2e.config.ts
 *
 * Cost: ~$0.01 per full run (Haiku model, ~200 tokens per call).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fsp from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import type { Server as HttpServer } from 'node:http'
import { WebSocket } from 'ws'
import { createMockConstants } from '../helpers/mock-constants.js'

// Isolate file I/O to a temp directory
vi.mock('../../src/constants.js', () => createMockConstants('walnut-mode-live'))

import { WALNUT_HOME } from '../../src/constants.js'
import { startServer, stopServer } from '../../src/web/server.js'

const LIVE = process.env.WALNUT_LIVE_MODE_TEST === '1'
const describeIf = LIVE ? describe : describe.skip

// ── WS helpers (same pattern as daemon-live.test.ts) ──

interface WsEvent {
  type: string
  name?: string
  data?: Record<string, unknown>
  id?: string | number
  result?: unknown
  error?: string
  [key: string]: unknown
}

let server: HttpServer
let port: number

function apiUrl(p: string): string {
  return `http://localhost:${port}${p}`
}

function connectWs(): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${port}/ws`)
    ws.on('open', () => resolve(ws))
    ws.on('error', reject)
  })
}

function waitForWsEvent(
  ws: WebSocket,
  eventName: string,
  timeoutMs = 120_000,
  filter?: (msg: WsEvent) => boolean,
): Promise<WsEvent> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timeout waiting for ${eventName}`)), timeoutMs)
    const handler = (data: WebSocket.Data) => {
      try {
        const msg = JSON.parse(data.toString()) as WsEvent
        if (msg.type === 'event' && msg.name === eventName && (!filter || filter(msg))) {
          clearTimeout(timer)
          ws.removeListener('message', handler)
          resolve(msg)
        }
      } catch { /* skip non-JSON */ }
    }
    ws.on('message', handler)
  })
}

function sendWsRpc(ws: WebSocket, method: string, payload: unknown): Promise<WsEvent> {
  return new Promise((resolve, reject) => {
    const id = `rpc-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
    const timer = setTimeout(() => reject(new Error(`RPC timeout: ${method}`)), 30_000)
    const handler = (data: WebSocket.Data) => {
      try {
        const msg = JSON.parse(data.toString()) as WsEvent
        if (msg.id === id) {
          clearTimeout(timer)
          ws.removeListener('message', handler)
          resolve(msg)
        }
      } catch { /* skip */ }
    }
    ws.on('message', handler)
    ws.send(JSON.stringify({ type: 'req', id, method, payload }))
  })
}

function delay(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms))
}

/** Poll until condition is true or timeout. */
async function pollUntil(fn: () => Promise<boolean>, intervalMs: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await fn()) return true
    await new Promise(r => setTimeout(r, intervalMs))
  }
  return false
}

// ── JSONL helpers ──

interface JsonlEvent {
  type: string
  subtype?: string
  permissionMode?: string
  session_id?: string
  [key: string]: unknown
}

/**
 * Parse init events from Walnut's streaming capture (stream-json format).
 * Looks for { type: 'system', subtype: 'init', permissionMode: '...' }.
 */
function parseStreamInitEvents(content: string): JsonlEvent[] {
  const inits: JsonlEvent[] = []
  for (const line of content.split('\n').filter(Boolean)) {
    try {
      const evt = JSON.parse(line) as JsonlEvent
      if (evt.type === 'system' && evt.subtype === 'init') inits.push(evt)
    } catch { /* skip malformed lines */ }
  }
  return inits
}

/**
 * Parse ALL mode-bearing system events (init + status) in stream order.
 * A LIVE set_permission_mode switch emits a `status` event with the new
 * permissionMode on the SAME process — no new init. So "current mode" is the
 * last mode-bearing event of either subtype, not the last init.
 */
function parseStreamModeEvents(content: string): { subtype: string; permissionMode: string }[] {
  const events: { subtype: string; permissionMode: string }[] = []
  for (const line of content.split('\n').filter(Boolean)) {
    try {
      const evt = JSON.parse(line) as JsonlEvent
      if (evt.type === 'system' && (evt.subtype === 'init' || evt.subtype === 'status')
        && typeof evt.permissionMode === 'string') {
        events.push({ subtype: evt.subtype, permissionMode: evt.permissionMode })
      }
    } catch { /* skip malformed lines */ }
  }
  return events
}

/**
 * Parse permissionMode from Claude Code's canonical JSONL (session history format).
 * The canonical format uses { type: 'user', permissionMode: '...' } — no system/init events.
 * Each user turn carries the current permissionMode, so we collect all unique modes.
 */
function parseCanonicalModes(content: string): { permissionMode: string; timestamp?: string }[] {
  const modes: { permissionMode: string; timestamp?: string }[] = []
  for (const line of content.split('\n').filter(Boolean)) {
    try {
      const evt = JSON.parse(line) as Record<string, unknown>
      if (evt.type === 'user' && typeof evt.permissionMode === 'string') {
        modes.push({
          permissionMode: evt.permissionMode,
          timestamp: evt.timestamp as string | undefined,
        })
      }
    } catch { /* skip malformed lines */ }
  }
  return modes
}

/** Resolve the session's stream JSONL: record.outputFile when persisted (resume
 *  path writes it), else the daemon's stream file — local FIFO sessions never
 *  persist outputFile (they don't respawn), so the daemon path is the norm for
 *  live-switch tests. Remote sessions' stream lives on the remote host: read it
 *  over ssh via WALNUT_LIVE_SSH_HOST (the resolved hostname — the Walnut host
 *  alias in record.host is not ssh-resolvable). */
async function readStreamContent(sessionId: string): Promise<string | null> {
  const res = await fetch(apiUrl(`/api/sessions/${sessionId}`))
  if (res.status !== 200) return null
  const body = await res.json() as { session: { outputFile?: string; host?: string | null } }
  if (body.session.host) {
    const sshHost = process.env.WALNUT_LIVE_SSH_HOST
    if (!sshHost) return null
    try {
      const { execFile } = await import('node:child_process')
      const { promisify } = await import('node:util')
      const { stdout } = await promisify(execFile)(
        'ssh', [sshHost, 'cat', `/tmp/open-walnut-streams/${sessionId}.jsonl`],
        { maxBuffer: 64 * 1024 * 1024 },
      )
      return stdout
    } catch { return null }
  }
  const candidates = [
    body.session.outputFile,
    `/tmp/open-walnut-streams/${sessionId}.jsonl`,
  ].filter(Boolean) as string[]
  for (const p of candidates) {
    try { return await fsp.readFile(p, 'utf-8') } catch { /* next */ }
  }
  return null
}

/**
 * Layer A: Read init events from Walnut's streaming capture.
 */
async function readStreamInitEvents(sessionId: string): Promise<JsonlEvent[]> {
  const content = await readStreamContent(sessionId)
  return content ? parseStreamInitEvents(content) : []
}

/**
 * Layer B: Read permissionMode from Claude Code's canonical JSONL file.
 * Scans ~/.claude/projects/<encoded-cwd>/<session-id>.jsonl.
 * Independent of Walnut's streaming capture — verifies Claude Code itself recorded the mode.
 */
async function readCanonicalModes(sessionId: string): Promise<string[]> {
  const claudeHome = path.join(os.homedir(), '.claude')
  const projectsDir = path.join(claudeHome, 'projects')
  try {
    const dirs = await fsp.readdir(projectsDir)
    for (const dir of dirs) {
      const jsonlPath = path.join(projectsDir, dir, `${sessionId}.jsonl`)
      try {
        const content = await fsp.readFile(jsonlPath, 'utf-8')
        const modes = parseCanonicalModes(content)
        if (modes.length > 0) return modes.map(m => m.permissionMode)
      } catch { /* not in this dir */ }
    }
  } catch { /* projects dir missing */ }
  return []
}

/** Convenience: get the CURRENT stream mode — the last mode-bearing system
 *  event (init at spawn OR status from a live set_permission_mode switch). */
async function getLastStreamInitMode(sessionId: string): Promise<string | undefined> {
  const content = await readStreamContent(sessionId)
  if (!content) return undefined
  const events = parseStreamModeEvents(content)
  return events.length > 0 ? events[events.length - 1]!.permissionMode : undefined
}

/** Convenience: get last permissionMode from Claude Code's canonical file. */
async function getLastCanonicalMode(sessionId: string): Promise<string | undefined> {
  const modes = await readCanonicalModes(sessionId)
  return modes.length > 0 ? modes[modes.length - 1] : undefined
}

/**
 * Verify mode across all three layers:
 *   Layer A: Walnut streaming capture (outputFile)
 *   Layer B: Claude Code canonical JSONL (~/.claude/projects/...)
 *   Layer C: Walnut session record (REST API)
 *
 * All three must agree on the expected CLI permission mode.
 */
async function assertModeAllLayers(
  label: string,
  sessionId: string,
  expectedCliMode: string,
  expectedWalnutMode: string,
): Promise<void> {
  // Layer A: Walnut streaming capture
  const streamMode = await getLastStreamInitMode(sessionId)
  console.log(`  ${label} Layer A (stream):    ${streamMode}`)
  expect(streamMode).toBe(expectedCliMode)

  // Layer B: Claude Code canonical JSONL
  const canonicalMode = await getLastCanonicalMode(sessionId)
  console.log(`  ${label} Layer B (canonical): ${canonicalMode}`)
  expect(canonicalMode).toBe(expectedCliMode)

  // Layer C: Walnut session record
  const session = await getSession(sessionId)
  console.log(`  ${label} Layer C (record):    ${session.mode}`)
  expect(session.mode).toBe(expectedWalnutMode)
}

/** Get session record via REST API. */
async function getSession(sessionId: string): Promise<Record<string, unknown>> {
  const res = await fetch(apiUrl(`/api/sessions/${sessionId}`))
  expect(res.status).toBe(200)
  const body = await res.json() as { session: Record<string, unknown> }
  return body.session
}

/** Map Walnut mode names to CLI permissionMode values. */
const MODE_TO_CLI: Record<string, string> = {
  bypass: 'bypassPermissions',
  plan: 'plan',
  accept: 'acceptEdits',
  default: 'default',
}

// ── Shared prompt (simple, cheap — just need Claude to respond so the turn completes) ──
const SIMPLE_PROMPT = 'Reply with exactly one word: OK'

// ═══════════════════════════════════════════════════════════════════════════
//  Test suite
// ═══════════════════════════════════════════════════════════════════════════

describeIf('Live mode tests (real Claude CLI + Haiku)', () => {
  const taskIds: string[] = []

  beforeAll(async () => {
    // Create isolated data dirs
    await fsp.mkdir(WALNUT_HOME, { recursive: true })
    const tasksDir = path.join(WALNUT_HOME, 'tasks')
    await fsp.mkdir(tasksDir, { recursive: true })
    await fsp.writeFile(
      path.join(tasksDir, 'tasks.json'),
      JSON.stringify({
        version: 1,
        tasks: Array.from({ length: 10 }, (_, i) => ({
          id: `mode-live-task-${String(i + 1).padStart(3, '0')}`,
          title: `Mode live test ${i + 1}`,
          status: 'todo',
          priority: 'immediate',
          category: 'Test',
          project: 'Walnut',
          session_ids: [],
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          description: '',
          summary: '',
          note: '',
          subtasks: [],
          source: 'test',
        })),
      }),
    )

    // Copy real config.yaml for host definitions (needed if remote tests are added)
    const realConfig = path.join(os.homedir(), '.open-walnut', 'config.yaml')
    try {
      await fsp.copyFile(realConfig, path.join(WALNUT_HOME, 'config.yaml'))
    } catch { /* no config — local-only tests still work */ }

    // Start server on random port (NO mock CLI — real claude binary)
    server = await startServer({ port: 0, dev: true })
    const addr = server.address()
    port = typeof addr === 'object' && addr ? addr.port : 0
  }, 30_000)

  afterAll(async () => {
    await stopServer()
    await fsp.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
  })

  // ── Helper: start session and wait for result ──
  async function startSessionAndWait(opts: {
    taskId: string
    message: string
    mode?: string
    model?: string
  }): Promise<{ sessionId: string; resultText: string }> {
    const ws = await connectWs()
    try {
      const resultPromise = waitForWsEvent(ws, 'session:result', 120_000,
        (msg) => !!(msg.data?.sessionId))

      const rpcRes = await sendWsRpc(ws, 'session:start', {
        taskId: opts.taskId,
        message: opts.message,
        mode: opts.mode,
        model: opts.model ?? 'haiku',
      })
      expect((rpcRes as Record<string, unknown>).ok).toBe(true)

      const result = await resultPromise
      expect(result.data?.isError).toBe(false)

      return {
        sessionId: result.data!.sessionId as string,
        resultText: (result.data?.result as string) ?? '',
      }
    } finally {
      ws.close()
    }
  }

  // ── Helper: send follow-up to existing session and wait for result ──
  async function sendAndWait(opts: {
    sessionId: string
    message: string
    mode?: string
  }): Promise<{ resultText: string }> {
    const ws = await connectWs()
    try {
      const resultPromise = waitForWsEvent(ws, 'session:result', 120_000,
        (msg) => (msg.data?.sessionId as string) === opts.sessionId)

      const rpcRes = await sendWsRpc(ws, 'session:send', {
        sessionId: opts.sessionId,
        message: opts.message,
        mode: opts.mode,
      })
      expect((rpcRes as Record<string, unknown>).ok).toBe(true)

      const result = await resultPromise
      expect(result.data?.isError).toBe(false)

      return {
        resultText: (result.data?.result as string) ?? '',
      }
    } finally {
      ws.close()
    }
  }

  // ── Helper: PATCH session mode ──
  async function patchMode(sessionId: string, mode: string): Promise<void> {
    const res = await fetch(apiUrl(`/api/sessions/${sessionId}`), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode }),
    })
    expect(res.status).toBe(200)
    // Give the fire-and-forget set_permission_mode control_request a moment to land
    await delay(200)
  }

  // ═══════════════════════════════════════════════════════════════════
  //  Test 1: Start in bypass mode
  // ═══════════════════════════════════════════════════════════════════

  describe('Initial mode verification', () => {
    it('T1: bypass — all 3 layers agree on bypassPermissions', async () => {
      const { sessionId } = await startSessionAndWait({
        taskId: 'mode-live-task-001',
        message: SIMPLE_PROMPT,
        mode: 'bypass',
      })
      console.log(`T1: sessionId=${sessionId}`)
      await delay(2000)
      await assertModeAllLayers('T1', sessionId, 'bypassPermissions', 'bypass')
    }, 180_000)

    it('T2: plan — all 3 layers agree on plan', async () => {
      const { sessionId } = await startSessionAndWait({
        taskId: 'mode-live-task-002',
        message: SIMPLE_PROMPT,
        mode: 'plan',
      })
      console.log(`T2: sessionId=${sessionId}`)
      await delay(2000)
      await assertModeAllLayers('T2', sessionId, 'plan', 'plan')
    }, 180_000)

    it('T3: accept — all 3 layers agree on acceptEdits', async () => {
      const { sessionId } = await startSessionAndWait({
        taskId: 'mode-live-task-003',
        message: SIMPLE_PROMPT,
        mode: 'accept',
      })
      console.log(`T3: sessionId=${sessionId}`)
      await delay(2000)
      await assertModeAllLayers('T3', sessionId, 'acceptEdits', 'accept')
    }, 180_000)

    it('T4: no mode → defaults to bypassPermissions, all 3 layers agree', async () => {
      const { sessionId } = await startSessionAndWait({
        taskId: 'mode-live-task-004',
        message: SIMPLE_PROMPT,
        // No mode → Walnut defaults to 'bypass' → --permission-mode bypassPermissions.
        // Users shouldn't be prompted to approve every edit; plan mode must be explicit.
      })
      console.log(`T4: sessionId=${sessionId}`)
      await delay(2000)
      await assertModeAllLayers('T4', sessionId, 'bypassPermissions', 'bypass')
    }, 180_000)
  })

  // ═══════════════════════════════════════════════════════════════════
  //  Test 5-6: Mode switch via PATCH + resume
  // ═══════════════════════════════════════════════════════════════════

  describe('Mode switch via PATCH', () => {
    let switchSessionId: string

    it('T5: bypass→plan — PATCH applies LIVE (set_permission_mode, same process), all 3 layers update', async () => {
      // Start in bypass
      const { sessionId } = await startSessionAndWait({
        taskId: 'mode-live-task-005',
        message: SIMPLE_PROMPT,
        mode: 'bypass',
      })
      switchSessionId = sessionId
      console.log(`T5: started in bypass, sessionId=${sessionId}`)
      const pidBefore = (await getSession(sessionId)).pid
      expect(pidBefore).toBeTruthy()

      // PATCH mode to plan → LIVE set_permission_mode control_request (no respawn).
      // The CLI emits a system/status event with the new permissionMode.
      // NOTE: init events are NOT a respawn detector — the CLI emits an init per
      // TURN (query-loop semantics) even on the same long-running process. The
      // same-process proof is pid stability on the record.
      await patchMode(sessionId, 'plan')
      await delay(2000)

      // Follow-up rides the SAME FIFO (no --resume) and must run in plan mode —
      // its canonical user events carry permissionMode:'plan' (Layer B).
      await sendAndWait({ sessionId, message: SIMPLE_PROMPT })
      console.log(`T5: follow-up sent after live mode switch to plan`)
      await delay(2000)

      // LIVE switch = SAME process across the PATCH and the follow-up.
      const pidAfter = (await getSession(sessionId)).pid
      expect(pidAfter).toBe(pidBefore)

      // All 3 layers: stream (status event), canonical, record
      await assertModeAllLayers('T5', sessionId, 'plan', 'plan')

      // The old respawn path is gone — pendingMode must never be set.
      const session = await getSession(sessionId)
      expect(session.pendingMode).toBeUndefined()
    }, 180_000)

    it('T6: plan→bypass — PATCH + send, all 3 layers update', async () => {
      const sid = switchSessionId
      if (!sid) {
        console.log('T6: skipped — no session from T5')
        return
      }

      // PATCH mode to bypass
      await patchMode(sid, 'bypass')
      await sendAndWait({ sessionId: sid, message: SIMPLE_PROMPT })
      console.log(`T6: follow-up sent after mode switch to bypass`)

      await delay(2000)

      // All 3 layers must agree
      await assertModeAllLayers('T6', sid, 'bypassPermissions', 'bypass')
    }, 180_000)
  })

  // ═══════════════════════════════════════════════════════════════════
  //  Test 7: Full cycle on one session
  // ═══════════════════════════════════════════════════════════════════

  it('T7: full cycle bypass→plan→bypass — all 3 layers sync at each step', async () => {
    // Start in bypass
    const { sessionId } = await startSessionAndWait({
      taskId: 'mode-live-task-007',
      message: SIMPLE_PROMPT,
      mode: 'bypass',
    })
    console.log(`T7: started in bypass, sessionId=${sessionId}`)
    const pid0 = (await getSession(sessionId)).pid
    expect(pid0).toBeTruthy()

    await delay(2000)
    await assertModeAllLayers('T7-initial', sessionId, 'bypassPermissions', 'bypass')

    // Switch to plan — LIVE, same process (pid stable; init count is per-turn,
    // not a respawn detector).
    await patchMode(sessionId, 'plan')
    await sendAndWait({ sessionId, message: SIMPLE_PROMPT })
    console.log(`T7: switched to plan`)

    await delay(2000)
    expect((await getSession(sessionId)).pid).toBe(pid0)
    await assertModeAllLayers('T7-plan', sessionId, 'plan', 'plan')

    // Switch back to bypass — still the same live process.
    await patchMode(sessionId, 'bypass')
    await sendAndWait({ sessionId, message: SIMPLE_PROMPT })
    console.log(`T7: switched back to bypass`)

    await delay(2000)
    expect((await getSession(sessionId)).pid).toBe(pid0)
    await assertModeAllLayers('T7-bypass', sessionId, 'bypassPermissions', 'bypass')
  }, 300_000)

  // ═══════════════════════════════════════════════════════════════════
  //  Test 8: Mode persistence across stop + resume
  // ═══════════════════════════════════════════════════════════════════

  it('T8: mode persists across stop + resume — all 3 layers stay plan', async () => {
    // Start in plan mode
    const { sessionId } = await startSessionAndWait({
      taskId: 'mode-live-task-008',
      message: SIMPLE_PROMPT,
      mode: 'plan',
    })
    console.log(`T8: started in plan, sessionId=${sessionId}`)

    await delay(3000)
    await assertModeAllLayers('T8-initial', sessionId, 'plan', 'plan')

    // Wait for process to stop (or it may stay alive via FIFO)
    const stopped = await pollUntil(async () => {
      const s = await getSession(sessionId)
      return s.process_status === 'stopped'
    }, 2000, 60_000)

    if (!stopped) {
      console.log('T8: process still running (FIFO), sending follow-up without mode override')
    }

    // Resume WITHOUT explicit mode — processNext should use record.mode='plan'
    await sendAndWait({
      sessionId,
      message: SIMPLE_PROMPT,
      // NO mode override — tests that record.mode is preserved
    })
    console.log(`T8: follow-up sent, verifying mode persisted`)

    await delay(2000)
    await assertModeAllLayers('T8-resumed', sessionId, 'plan', 'plan')
  }, 180_000)

  // ═══════════════════════════════════════════════════════════════════
  //  Test 9: Remote session mode (optional, gated by WALNUT_LIVE_HOST)
  // ═══════════════════════════════════════════════════════════════════

  const LIVE_HOST = process.env.WALNUT_LIVE_HOST
  const describeRemote = LIVE_HOST ? describe : describe.skip

  describeRemote(`Remote mode tests (host: ${LIVE_HOST})`, () => {
    it('T9: remote bypass→plan — session record + stream agree after PATCH', async () => {
      // Start remote session in bypass
      const ws = await connectWs()
      try {
        const resultPromise = waitForWsEvent(ws, 'session:result', 180_000,
          (msg) => !!(msg.data?.sessionId))

        await sendWsRpc(ws, 'session:start', {
          taskId: 'mode-live-task-009',
          message: SIMPLE_PROMPT,
          host: LIVE_HOST,
          cwd: '/tmp',
          mode: 'bypass',
          model: 'haiku',
        })

        const result = await resultPromise
        const sessionId = result.data!.sessionId as string
        console.log(`T9: remote bypass session=${sessionId}`)

        // Verify initial mode
        const session = await getSession(sessionId)
        expect(session.mode).toBe('bypass')
        expect(session.host).toBe(LIVE_HOST)

        // Layer A: stream init should show bypass
        await delay(2000)
        const streamMode = await getLastStreamInitMode(sessionId)
        expect(streamMode).toBe('bypassPermissions')

        // PATCH to plan + send follow-up
        await patchMode(sessionId, 'plan')

        const followUpPromise = waitForWsEvent(ws, 'session:result', 180_000,
          (msg) => (msg.data?.sessionId as string) === sessionId)
        await sendWsRpc(ws, 'session:send', { sessionId, message: SIMPLE_PROMPT })
        await followUpPromise
        console.log(`T9: follow-up completed after plan switch`)

        await delay(2000)

        // Stream should now show plan as last init
        const updatedStreamMode = await getLastStreamInitMode(sessionId)
        expect(updatedStreamMode).toBe('plan')

        // Session record should show plan
        const updatedSession = await getSession(sessionId)
        expect(updatedSession.mode).toBe('plan')
        // Note: canonical JSONL is on the remote host — can't read locally
      } finally {
        ws.close()
      }
    }, 300_000)
  })
}, 600_000) // 10 min total suite timeout
