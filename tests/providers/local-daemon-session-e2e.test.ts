/**
 * End-to-end integration test for unified daemon architecture.
 *
 * Proves that local sessions now go through the local daemon with:
 *   - Session spawn via daemon (cmdStart)
 *   - JSONL streaming from daemon via WebSocket (no local JsonlTailer)
 *   - Permission policy enforced by daemon (bypass auto-allow, plan ExitPlanMode forward)
 *   - Session survives Walnut restart (attach recovers)
 *   - setMode propagates to daemon mid-session
 *
 * Uses a mock claude CLI that emits deterministic JSONL sequences so we can
 * exercise control_request flows without a real Anthropic API key.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { execSync } from 'node:child_process'
import { WebSocket } from 'ws'
import { LocalDaemon } from '../../src/providers/local-daemon.js'

// ISOLATION: this suite spawns a REAL daemon binary. It must never touch the
// production daemon dir (/tmp/open-walnut) — doing so kills the production
// daemon's pid/port files and, worse, the old `pkill -9 -f daemon-darwin-arm64`
// cleanup SIGKILLed the production daemon itself on every beforeEach. Each new
// daemon generation then re-adopted all sessions and replayed history to the
// UI. Everything here lives in a per-run temp dir; cleanup kills ONLY the pid
// recorded in our own pid file.
const DAEMON_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-daemon-e2e-'))
const PORT_FILE = path.join(DAEMON_DIR, 'daemon.port')
const PID_FILE = path.join(DAEMON_DIR, 'daemon.pid')
// daemon-standalone.ts derives streams dir as `${WALNUT_DAEMON_DIR}-streams`
const STREAMS_DIR = `${DAEMON_DIR}-streams`

const PROD_DAEMON_DIR = '/tmp/open-walnut'
if (path.resolve(DAEMON_DIR) === path.resolve(PROD_DAEMON_DIR)) {
  throw new Error(`Refusing to run real-binary E2E against production daemon dir ${PROD_DAEMON_DIR}`)
}

function binaryExists(): boolean {
  const projectRoot = path.resolve(__dirname, '../..')
  const binaryName = `daemon-${process.platform}-${process.arch}`
  const binaryPath = path.join(projectRoot, 'dist', 'daemon-binaries', binaryName)
  return fs.existsSync(binaryPath)
}

function killExistingDaemon(): void {
  // Kill only the daemon whose pid is recorded in OUR isolated pid file.
  // Never pkill by binary name — that murders the production daemon too.
  try {
    const pid = parseInt(fs.readFileSync(PID_FILE, 'utf-8').trim(), 10)
    if (pid > 0) {
      try { process.kill(pid, 'SIGTERM') } catch {}
      for (let i = 0; i < 20; i++) {
        try { process.kill(pid, 0) } catch { break }
        execSync('sleep 0.1')
      }
      try { process.kill(pid, 'SIGKILL') } catch {}
    }
  } catch {}
  try { fs.unlinkSync(PORT_FILE) } catch {}
  try { fs.unlinkSync(PID_FILE) } catch {}
}

async function sendCmd(ws: WebSocket, cmd: Record<string, unknown>, timeoutMs = 5000): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const id = Math.floor(Math.random() * 1e9)
    const timeout = setTimeout(() => reject(new Error(`${cmd.cmd} timeout`)), timeoutMs)
    const handler = (data: WebSocket.RawData) => {
      const msg = JSON.parse(data.toString())
      if (msg.id === id) {
        clearTimeout(timeout)
        ws.off('message', handler)
        resolve(msg)
      }
    }
    ws.on('message', handler)
    ws.send(JSON.stringify({ id, ...cmd }))
  })
}

function collectEvents(ws: WebSocket, predicate: (ev: Record<string, unknown>) => boolean, timeoutMs: number): Promise<Record<string, unknown>[]> {
  return new Promise((resolve) => {
    const events: Record<string, unknown>[] = []
    const timeout = setTimeout(() => resolve(events), timeoutMs)
    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString())
      if (msg.ev && predicate(msg)) {
        events.push(msg)
      }
    })
    setTimeout(() => { clearTimeout(timeout); resolve(events) }, timeoutMs)
  })
}

/** Create a mock "claude" shell script that emits a canned JSONL sequence. */
function makeMockClaude(tmpDir: string, jsonlLines: string[]): string {
  const scriptPath = path.join(tmpDir, 'mock-claude.sh')
  // Read stdin (so FIFO read doesn't block on empty), emit JSONL, then exit.
  const body = `#!/bin/bash
# Drain stdin in background so FIFO has reader
cat > /dev/null &
READER=$!
# Emit canned JSONL
${jsonlLines.map(l => `echo '${l.replace(/'/g, "'\\''")}'`).join('\n')}
# Wait briefly for more input, then exit
sleep 0.3
kill $READER 2>/dev/null
exit 0
`
  fs.writeFileSync(scriptPath, body, { mode: 0o755 })
  return scriptPath
}

/**
 * Poll until `pred()` holds. Use this ONLY for positive conditions ("the data
 * arrived"). Tests that assert an ABSENCE (e.g. control_request lines must be 0)
 * deliberately keep their fixed sleep: a poll would return instantly and prove
 * nothing, since the condition is already true before the daemon has done anything.
 */
async function waitUntil(pred: () => boolean, timeoutMs = 5000, label = 'condition'): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (pred()) return
    await new Promise((r) => setTimeout(r, 25))
  }
  throw new Error(`waitUntil timed out after ${timeoutMs}ms waiting for ${label}`)
}

describe.skipIf(!binaryExists())('Local daemon session E2E', () => {
  let tmpDir: string

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-local-daemon-test-'))
  })

  afterAll(() => {
    killExistingDaemon()
    try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch {}
  })

  beforeEach(() => {
    killExistingDaemon()
    // Clean up any stale session files from previous tests
    try {
      for (const f of fs.readdirSync(STREAMS_DIR)) {
        if (f.startsWith('test-local-')) {
          fs.unlinkSync(path.join(STREAMS_DIR, f))
        }
      }
    } catch {}
  })

  it('starts session through local daemon and streams JSONL', async () => {
    const daemon = new LocalDaemon({ daemonDir: DAEMON_DIR })
    const port = await daemon.ensureRunning()

    const ws = new WebSocket(`ws://localhost:${port}`)
    await new Promise((r) => ws.on('open', r))

    // Collect jsonl events in background
    const lines: string[] = []
    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString())
      if (msg.ev === 'jsonl' && typeof msg.line === 'string') lines.push(msg.line)
    })

    const mockClaude = makeMockClaude(tmpDir, [
      '{"type":"system","subtype":"init","session_id":"test-sid","model":"claude-test"}',
      '{"type":"assistant","message":{"content":[{"type":"text","text":"hello"}]}}',
      '{"type":"result","stop_reason":"end_turn","subtype":"success"}',
    ])

    const sid = 'test-local-spawn-' + Date.now()
    const startRes = await sendCmd(ws, {
      cmd: 'start',
      sid,
      args: [mockClaude],
      cwd: tmpDir,
      message: 'hi',
      mode: 'default',
    })
    expect(startRes.ok).toBe(true)
    expect(startRes.pid).toBeGreaterThan(0)

    // Poll for the fan-out instead of sleeping out a 1500ms worst case.
    await waitUntil(() => lines.length >= 3, 5000, '3 fanned-out JSONL lines')

    // Should have received all 3 mock lines
    expect(lines.length).toBeGreaterThanOrEqual(3)
    expect(lines.some((l) => l.includes('"system"'))).toBe(true)
    expect(lines.some((l) => l.includes('hello'))).toBe(true)
    expect(lines.some((l) => l.includes('"result"'))).toBe(true)

    ws.close()
  }, 20000)

  // Restart-to-reinitialize path: cmdStart now accepts an ABSENT message. The CLI
  // must still spawn and emit its init event (SessionStart hook + fresh settings
  // load happen here) WITHOUT any user turn being written to the FIFO. This is the
  // protocol change that makes the Restart button actually re-initialize.
  it('spawns and emits init with NO message (idle re-init)', async () => {
    const daemon = new LocalDaemon({ daemonDir: DAEMON_DIR })
    const port = await daemon.ensureRunning()

    const ws = new WebSocket(`ws://localhost:${port}`)
    await new Promise((r) => ws.on('open', r))

    const lines: string[] = []
    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString())
      if (msg.ev === 'jsonl' && typeof msg.line === 'string') lines.push(msg.line)
    })

    // Mock CLI emits ONLY an init line (like a real `claude -p --resume` that has
    // received no user turn), then idles on stdin until killed.
    const mockClaude = makeMockClaude(tmpDir, [
      '{"type":"system","subtype":"init","session_id":"reinit-sid","model":"claude-test"}',
    ])

    const sid = 'test-local-reinit-' + Date.now()
    const startRes = await sendCmd(ws, {
      cmd: 'start',
      sid,
      args: [mockClaude],
      cwd: tmpDir,
      // NO message field — the key assertion. cmdStart must not reject this.
      mode: 'default',
    })
    expect(startRes.ok).toBe(true)
    expect(startRes.pid).toBeGreaterThan(0)

    await waitUntil(() => lines.some((l) => l.includes('"init"')), 5000, 'the init line')

    // init streamed through even though we sent no message, and NO user turn was
    // injected into the JSONL (the FIFO got no `{"type":"user",...}` write).
    expect(lines.some((l) => l.includes('"init"'))).toBe(true)
    expect(lines.some((l) => l.includes('"type":"user"'))).toBe(false)

    ws.close()
  }, 20000)

  it('bypass mode auto-allows control_request — walnut never sees it', async () => {
    const daemon = new LocalDaemon({ daemonDir: DAEMON_DIR })
    const port = await daemon.ensureRunning()

    const ws = new WebSocket(`ws://localhost:${port}`)
    await new Promise((r) => ws.on('open', r))

    const jsonlLines: string[] = []
    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString())
      if (msg.ev === 'jsonl' && typeof msg.line === 'string') jsonlLines.push(msg.line)
    })

    // Mock emits a control_request for Bash. Daemon should auto-allow and
    // swallow the line so walnut never sees it.
    const mockClaude = makeMockClaude(tmpDir, [
      '{"type":"system","subtype":"init","session_id":"test-bypass"}',
      '{"type":"control_request","request_id":"ctrl-1","request":{"subtype":"can_use_tool","tool_name":"Bash","input":{"cmd":"ls"}}}',
      '{"type":"result","stop_reason":"end_turn","subtype":"success"}',
    ])

    const sid = 'test-local-bypass-' + Date.now()
    const startRes = await sendCmd(ws, {
      cmd: 'start',
      sid,
      args: [mockClaude],
      cwd: tmpDir,
      message: 'hi',
      mode: 'bypass',
    })
    expect(startRes.ok).toBe(true)

    await new Promise((r) => setTimeout(r, 2000))

    // control_request line should NOT have been forwarded to subscribers
    const ctrlReqLines = jsonlLines.filter((l) => l.includes('"control_request"'))
    expect(ctrlReqLines.length).toBe(0)

    // But we should see init + result
    expect(jsonlLines.some((l) => l.includes('"system"'))).toBe(true)
    expect(jsonlLines.some((l) => l.includes('"result"'))).toBe(true)

    ws.close()
  }, 20000)

  it('default mode forwards control_request to walnut (pendingCtrl set)', async () => {
    const daemon = new LocalDaemon({ daemonDir: DAEMON_DIR })
    const port = await daemon.ensureRunning()

    const ws = new WebSocket(`ws://localhost:${port}`)
    await new Promise((r) => ws.on('open', r))

    const jsonlLines: string[] = []
    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString())
      if (msg.ev === 'jsonl' && typeof msg.line === 'string') jsonlLines.push(msg.line)
    })

    // Mock emits a control_request and then sleeps, keeping FIFO open
    const scriptPath = path.join(tmpDir, 'mock-wait.sh')
    fs.writeFileSync(scriptPath, `#!/bin/bash
cat > /dev/null &
READER=$!
echo '{"type":"system","subtype":"init","session_id":"test-default"}'
echo '{"type":"control_request","request_id":"ctrl-default-1","request":{"subtype":"can_use_tool","tool_name":"Bash","input":{"cmd":"ls"}}}'
sleep 2
kill $READER 2>/dev/null
exit 0
`, { mode: 0o755 })

    const sid = 'test-local-default-' + Date.now()
    await sendCmd(ws, {
      cmd: 'start',
      sid,
      args: [scriptPath],
      cwd: tmpDir,
      message: 'hi',
      mode: 'default',
    })

    await new Promise((r) => setTimeout(r, 1200))

    // control_request SHOULD be forwarded to subscribers in default mode
    const ctrlReqLines = jsonlLines.filter((l) => l.includes('"control_request"'))
    expect(ctrlReqLines.length).toBeGreaterThanOrEqual(1)

    // Now attach should return pendingCtrl
    const attachRes = await sendCmd(ws, { cmd: 'attach', sid, fromOffset: 0 })
    expect(attachRes.ok).toBe(true)
    expect(attachRes.pendingCtrl).toBeTruthy()
    const pc = attachRes.pendingCtrl as { reqId: string; toolName: string }
    expect(pc.reqId).toBe('ctrl-default-1')
    expect(pc.toolName).toBe('Bash')

    ws.close()
  }, 20000)

  it('plan mode auto-allows tool but forwards ExitPlanMode', async () => {
    const daemon = new LocalDaemon({ daemonDir: DAEMON_DIR })
    const port = await daemon.ensureRunning()

    const ws = new WebSocket(`ws://localhost:${port}`)
    await new Promise((r) => ws.on('open', r))

    const jsonlLines: string[] = []
    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString())
      if (msg.ev === 'jsonl' && typeof msg.line === 'string') jsonlLines.push(msg.line)
    })

    const scriptPath = path.join(tmpDir, 'mock-plan.sh')
    fs.writeFileSync(scriptPath, `#!/bin/bash
cat > /dev/null &
READER=$!
echo '{"type":"system","subtype":"init","session_id":"test-plan"}'
echo '{"type":"control_request","request_id":"ctrl-read","request":{"subtype":"can_use_tool","tool_name":"Read","input":{"path":"foo"}}}'
echo '{"type":"control_request","request_id":"ctrl-exitplan","request":{"subtype":"can_use_tool","tool_name":"ExitPlanMode","input":{"plan":"my plan"}}}'
sleep 2
kill $READER 2>/dev/null
exit 0
`, { mode: 0o755 })

    const sid = 'test-local-plan-' + Date.now()
    await sendCmd(ws, {
      cmd: 'start',
      sid,
      args: [scriptPath],
      cwd: tmpDir,
      message: 'hi',
      mode: 'plan',
    })

    await new Promise((r) => setTimeout(r, 1500))

    // Read should be auto-allowed (swallowed)
    const readLines = jsonlLines.filter((l) => l.includes('ctrl-read'))
    expect(readLines.length).toBe(0)

    // ExitPlanMode should be forwarded
    const exitPlanLines = jsonlLines.filter((l) => l.includes('ctrl-exitplan'))
    expect(exitPlanLines.length).toBeGreaterThanOrEqual(1)

    // Attach should show pendingCtrl = ExitPlanMode
    const attachRes = await sendCmd(ws, { cmd: 'attach', sid, fromOffset: 0 })
    const pc = attachRes.pendingCtrl as { reqId: string; toolName: string } | null
    expect(pc?.toolName).toBe('ExitPlanMode')

    ws.close()
  }, 20000)

  it('setMode clears pending ExitPlanMode when switching plan → bypass', async () => {
    const daemon = new LocalDaemon({ daemonDir: DAEMON_DIR })
    const port = await daemon.ensureRunning()

    const ws = new WebSocket(`ws://localhost:${port}`)
    await new Promise((r) => ws.on('open', r))

    const scriptPath = path.join(tmpDir, 'mock-setmode.sh')
    fs.writeFileSync(scriptPath, `#!/bin/bash
cat > /dev/null &
READER=$!
echo '{"type":"system","subtype":"init","session_id":"test-setmode"}'
echo '{"type":"control_request","request_id":"ctrl-exitplan-sm","request":{"subtype":"can_use_tool","tool_name":"ExitPlanMode","input":{"plan":"x"}}}'
sleep 3
kill $READER 2>/dev/null
exit 0
`, { mode: 0o755 })

    const sid = 'test-local-setmode-' + Date.now()
    await sendCmd(ws, {
      cmd: 'start',
      sid,
      args: [scriptPath],
      cwd: tmpDir,
      message: 'hi',
      mode: 'plan',
    })

    // Bounded sleep retained: the next step polls via attach, and the condition
    // (pendingCtrl set) is only observable through that RPC, not a local array.
    await new Promise((r) => setTimeout(r, 1000))

    // Confirm pendingCtrl exists
    let attachRes = await sendCmd(ws, { cmd: 'attach', sid, fromOffset: 0 })
    expect(attachRes.pendingCtrl).toBeTruthy()

    // Switch to bypass — daemon should auto-allow the pending ExitPlanMode
    const setModeRes = await sendCmd(ws, { cmd: 'setMode', sid, mode: 'bypass' })
    expect(setModeRes.ok).toBe(true)
    expect(setModeRes.oldMode).toBe('plan')
    expect(setModeRes.newMode).toBe('bypass')

    // After setMode, pendingCtrl should be cleared (bypass auto-allows all tools)
    attachRes = await sendCmd(ws, { cmd: 'attach', sid, fromOffset: 0 })
    expect(attachRes.pendingCtrl).toBeNull()

    ws.close()
  }, 20000)

  it('session survives daemon client disconnect (no kill)', async () => {
    const daemon = new LocalDaemon({ daemonDir: DAEMON_DIR })
    const port = await daemon.ensureRunning()

    let ws1 = new WebSocket(`ws://localhost:${port}`)
    await new Promise((r) => ws1.on('open', r))

    const scriptPath = path.join(tmpDir, 'mock-survive.sh')
    fs.writeFileSync(scriptPath, `#!/bin/bash
cat > /dev/null &
READER=$!
echo '{"type":"system","subtype":"init","session_id":"test-survive"}'
sleep 3
kill $READER 2>/dev/null
exit 0
`, { mode: 0o755 })

    const sid = 'test-local-survive-' + Date.now()
    const startRes = await sendCmd(ws1, {
      cmd: 'start',
      sid,
      args: [scriptPath],
      cwd: tmpDir,
      message: 'hi',
      mode: 'default',
    })
    const pid = startRes.pid as number
    expect(pid).toBeGreaterThan(0)

    // Disconnect — session/CLI must keep running
    ws1.close()
    await new Promise((r) => setTimeout(r, 500))

    expect(() => process.kill(pid, 0)).not.toThrow()  // Still alive

    // Reconnect and attach — should work
    const ws2 = new WebSocket(`ws://localhost:${port}`)
    await new Promise((r) => ws2.on('open', r))
    const attachRes = await sendCmd(ws2, { cmd: 'attach', sid, fromOffset: 0 })
    expect(attachRes.ok).toBe(true)
    expect(attachRes.alive).toBe(true)

    ws2.close()
  }, 20000)
})
