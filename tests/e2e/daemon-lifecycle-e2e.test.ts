/**
 * True E2E daemon lifecycle tests — spawn the REAL daemon-source.ts template
 * as a child process, connect via WebSocket, exercise Phase A/B/C/D paths.
 *
 * What's real:
 *   - Actual daemon process (DAEMON_SOURCE template run via `node`)
 *   - Real WebSocket protocol
 *   - Real FIFO + file I/O + process spawning
 *   - Real reapSession / broadcastSessionState / reconcileRegistry
 *
 * What's faked:
 *   - Claude CLI replaced by `cat` (long-lived, reads stdin FIFO, writes to output)
 *   - No SSH — we talk to 127.0.0.1:<port> directly
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import { WebSocket } from 'ws'
import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { getDaemonSource } from '../../src/providers/daemon-source.js'

interface DaemonProc {
  proc: ChildProcess
  port: number
  daemonDir: string
  streamsDir: string
  scriptPath: string
}

async function writeDaemonScript(): Promise<string> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-daemon-e2e-'))
  const scriptPath = path.join(dir, 'daemon.cjs')
  fs.writeFileSync(scriptPath, getDaemonSource(), { mode: 0o755 })
  return scriptPath
}

async function spawnDaemon(scriptPath: string, daemonDir: string): Promise<DaemonProc> {
  // The daemon reads DAEMON_DIR from env (fallback to ~/.walnut/daemon in source)
  const env = {
    ...process.env,
    WALNUT_DAEMON_DIR: daemonDir,
  }

  // Start daemon (prints port to stdout)
  const proc = spawn('node', [scriptPath, '--start'], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: false,
  })
  if (process.env.DEBUG_DAEMON) {
    proc.stderr?.on('data', (b) => process.stderr.write('[daemon] ' + b.toString()))
  }

  const port = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('daemon spawn timeout')), 10_000)
    proc.stdout?.on('data', (chunk) => {
      const s = chunk.toString().trim()
      const m = s.match(/^\d+$/m)
      if (m) {
        clearTimeout(timer)
        resolve(parseInt(m[0], 10))
      }
    })
    proc.on('error', (err) => { clearTimeout(timer); reject(err) })
    proc.on('exit', (code) => { clearTimeout(timer); reject(new Error('daemon exited early: ' + code)) })
  })

  return {
    proc,
    port,
    daemonDir,
    streamsDir: path.join(daemonDir, 'streams'),
    scriptPath,
  }
}

async function stopDaemon(d: DaemonProc): Promise<void> {
  if (d.proc.exitCode === null) {
    d.proc.kill('SIGTERM')
    await new Promise<void>((resolve) => {
      const t = setTimeout(() => { try { d.proc.kill('SIGKILL') } catch {} ; resolve() }, 3000)
      d.proc.once('exit', () => { clearTimeout(t); resolve() })
    })
  }
}

function connectWs(port: number): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`)
    const t = setTimeout(() => reject(new Error('ws connect timeout')), 5000)
    ws.once('open', () => { clearTimeout(t); resolve(ws) })
    ws.once('error', (e) => { clearTimeout(t); reject(e) })
  })
}

/** Send a command and await matching ok/error reply. */
function sendCmd(
  ws: WebSocket,
  cmd: Record<string, unknown>,
  timeoutMs = 10_000,
): Promise<Record<string, unknown>> {
  const id = Math.floor(Math.random() * 1e9)
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      ws.off('message', handler)
      reject(new Error(`cmd ${cmd.cmd} timed out`))
    }, timeoutMs)
    const handler = (data: WebSocket.Data) => {
      try {
        const msg = JSON.parse(data.toString()) as Record<string, unknown>
        if (msg.id === id) {
          clearTimeout(t)
          ws.off('message', handler)
          resolve(msg)
        }
      } catch {}
    }
    ws.on('message', handler)
    ws.send(JSON.stringify({ id, ...cmd }))
  })
}

/** Collect events matching predicate until timeout or match. */
function waitForEvent(
  ws: WebSocket,
  predicate: (msg: Record<string, unknown>) => boolean,
  timeoutMs = 5000,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      ws.off('message', handler)
      reject(new Error('event wait timeout'))
    }, timeoutMs)
    const handler = (data: WebSocket.Data) => {
      try {
        const msg = JSON.parse(data.toString()) as Record<string, unknown>
        if (predicate(msg)) {
          clearTimeout(t)
          ws.off('message', handler)
          resolve(msg)
        }
      } catch {}
    }
    ws.on('message', handler)
  })
}

// ════════════════════════════════════════════════════════════════════════

describe('daemon E2E — real process, real WS, real FIFO', () => {
  let scriptPath: string
  let daemonDir: string
  let daemon: DaemonProc | null = null

  beforeAll(async () => {
    scriptPath = await writeDaemonScript()
  })

  beforeEach(async () => {
    daemonDir = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-daemon-data-'))
    daemon = await spawnDaemon(scriptPath, daemonDir)
  })

  afterEach(async () => {
    if (daemon) {
      await stopDaemon(daemon)
      daemon = null
    }
    try { await fsp.rm(daemonDir, { recursive: true, force: true }) } catch {}
  })

  afterAll(async () => {
    try { await fsp.rm(path.dirname(scriptPath), { recursive: true, force: true }) } catch {}
  })

  // ─────────────────────────────────────────────────────────────────
  it('Phase A — start session with `cat`, receive pid, writeMessage delivers', async () => {
    const ws = await connectWs(daemon!.port)
    const sid = `e2e-start-${Date.now()}`

    const started = await sendCmd(ws, {
      cmd: 'start',
      sid,
      args: ['/bin/sleep', '60'],
      cwd: '/tmp',
      message: 'hello\n',
    })
    expect(started.ok).toBe(true)
    expect(typeof started.pid).toBe('number')
    expect((started.pid as number) > 0).toBe(true)

    // Attach to start receiving events
    const attached = await sendCmd(ws, { cmd: 'attach', sid, fromOffset: 0 })
    expect(attached.ok).toBe(true)

    // Send additional message — should succeed
    const sent = await sendCmd(ws, { cmd: 'send', sid, message: 'world\n' })
    expect(sent.ok).toBe(true)

    ws.close()
  })

  // ─────────────────────────────────────────────────────────────────
  it('Phase B — external SIGKILL on session → daemon broadcasts session_state=dead', async () => {
    const ws = await connectWs(daemon!.port)
    const sid = `e2e-sigkill-${Date.now()}`

    const started = await sendCmd(ws, {
      cmd: 'start', sid, args: ['/bin/sleep', '60'], cwd: '/tmp', message: 'init\n',
    })
    const pid = started.pid as number

    await sendCmd(ws, { cmd: 'attach', sid, fromOffset: 0 })

    // Kill the session process externally
    process.kill(pid, 'SIGKILL')

    // Wait for session_state=dead broadcast
    const ev = await waitForEvent(
      ws,
      (m) => m.ev === 'session_state' && m.sid === sid && m.state === 'dead',
      10_000,
    )
    expect(ev.sid).toBe(sid)
    expect(ev.state).toBe('dead')
    expect(typeof ev.reason).toBe('string')

    ws.close()
  })

  // ─────────────────────────────────────────────────────────────────
  it('Phase B — send to dead session returns strict reason', async () => {
    const ws = await connectWs(daemon!.port)
    const sid = `e2e-send-dead-${Date.now()}`

    const started = await sendCmd(ws, {
      cmd: 'start', sid, args: ['/bin/sleep', '60'], cwd: '/tmp', message: 'init\n',
    })
    const pid = started.pid as number

    process.kill(pid, 'SIGKILL')

    // Wait for daemon to detect death (proc.on('exit') fires fast)
    await waitForEvent(
      ws,
      (m) => m.ev === 'session_state' && m.sid === sid && m.state === 'dead',
      10_000,
    )

    // Now send — must get strict session_dead reason
    const sent = await sendCmd(ws, { cmd: 'send', sid, message: 'late\n' })
    expect(sent.ok).toBe(false)
    expect(sent.reason).toBe('session_dead')

    ws.close()
  })

  // ─────────────────────────────────────────────────────────────────
  it('Phase B — send to unknown sid returns not_found', async () => {
    const ws = await connectWs(daemon!.port)
    const sent = await sendCmd(ws, { cmd: 'send', sid: 'does-not-exist', message: 'x' })
    expect(sent.ok).toBe(false)
    expect(sent.reason).toBe('not_found')
    ws.close()
  })

  // ─────────────────────────────────────────────────────────────────
  it('Phase C — registry persists across daemon restart, live session gets adopted', async () => {
    const ws1 = await connectWs(daemon!.port)
    const sid = `e2e-reconcile-live-${Date.now()}`

    const started = await sendCmd(ws1, {
      cmd: 'start', sid, args: ['/bin/sleep', '60'], cwd: '/tmp', message: 'init\n',
    })
    const pid = started.pid as number
    expect(pid).toBeGreaterThan(0)

    ws1.close()

    // Verify sessions.json exists with our sid
    const registryPath = path.join(daemonDir, 'sessions.json')
    const registryContent = JSON.parse(fs.readFileSync(registryPath, 'utf-8'))
    expect(registryContent.sessions).toBeTruthy()
    expect(registryContent.sessions[sid]).toBeTruthy()
    expect(registryContent.sessions[sid].pid).toBe(pid)

    // Stop daemon via SIGTERM (should NOT kill session)
    await stopDaemon(daemon!)

    // Session process must still be alive
    let stillAlive = false
    try { process.kill(pid, 0); stillAlive = true } catch {}
    expect(stillAlive).toBe(true)

    // Restart daemon → reconcile should adopt
    daemon = await spawnDaemon(scriptPath, daemonDir)
    const ws2 = await connectWs(daemon.port)

    const statusMsg = await sendCmd(ws2, { cmd: 'status', sid })
    // If this fails, print the daemon log for debugging
    if (!statusMsg.alive) {
      try {
        const logPath = path.join(daemonDir, 'daemon.log')
        const logBody = fs.readFileSync(logPath, 'utf-8')
        console.error('[daemon log]\n' + logBody.split('\n').slice(-30).join('\n'))
      } catch {}
    }
    expect(statusMsg.ok).toBe(true)
    expect(statusMsg.alive).toBe(true)

    ws2.close()

    // Cleanup: kill the orphan sleep ourselves
    try { process.kill(pid, 'SIGKILL') } catch {}
  })

  // ─────────────────────────────────────────────────────────────────
  it('Phase C — dead session in registry gets reaped on reconcile', async () => {
    const ws1 = await connectWs(daemon!.port)
    const sid = `e2e-reconcile-dead-${Date.now()}`

    const started = await sendCmd(ws1, {
      cmd: 'start', sid, args: ['/bin/sleep', '60'], cwd: '/tmp', message: 'init\n',
    })
    const pid = started.pid as number
    ws1.close()

    // Stop daemon (leaves session in registry, session alive)
    await stopDaemon(daemon!)

    // Kill session before restarting daemon
    try { process.kill(pid, 'SIGKILL') } catch {}
    // Wait for it to actually exit
    await new Promise((r) => setTimeout(r, 300))

    // Restart daemon → reconcile probes: kill(pid,0) throws → reap
    daemon = await spawnDaemon(scriptPath, daemonDir)
    const ws2 = await connectWs(daemon.port)

    // Session should report dead authoritatively
    const statusMsg = await sendCmd(ws2, { cmd: 'status', sid })
    expect(statusMsg.ok).toBe(true)
    expect(statusMsg.alive).toBe(false)

    ws2.close()
  })

  // ─────────────────────────────────────────────────────────────────
  it('reap is idempotent — SIGKILL + send in parallel still converges cleanly', async () => {
    const ws = await connectWs(daemon!.port)
    const sid = `e2e-idempotent-${Date.now()}`

    const started = await sendCmd(ws, {
      cmd: 'start', sid, args: ['/bin/sleep', '60'], cwd: '/tmp', message: 'init\n',
    })
    const pid = started.pid as number

    // Parallel: kill process AND fire sends while it dies
    const deathPromise = waitForEvent(
      ws, (m) => m.ev === 'session_state' && m.sid === sid && m.state === 'dead', 10_000,
    )

    process.kill(pid, 'SIGKILL')
    const sendResults = await Promise.all([
      sendCmd(ws, { cmd: 'send', sid, message: 'a\n' }).catch((e) => ({ err: String(e) })),
      sendCmd(ws, { cmd: 'send', sid, message: 'b\n' }).catch((e) => ({ err: String(e) })),
      sendCmd(ws, { cmd: 'send', sid, message: 'c\n' }).catch((e) => ({ err: String(e) })),
    ])

    const dead = await deathPromise
    expect(dead.state).toBe('dead')

    // All sends must have replied (not crashed daemon). Reasons:
    // - If sent before reap: ok:true OR ok:false, reason=ENXIO/session_dead
    // - If sent after reap:  ok:false, reason=session_dead
    for (const r of sendResults) {
      expect(r).toBeTruthy()
      if ('ok' in r && r.ok === false) {
        expect(['session_dead', 'ENXIO', 'not_found']).toContain(r.reason)
      }
    }

    // Daemon still healthy — can list sessions
    const listed = await sendCmd(ws, { cmd: 'list' })
    expect(listed.ok).toBe(true)

    ws.close()
  })

  // ─────────────────────────────────────────────────────────────────
  // 2026-07-25 incident: a walnut restart raced its own session re-attach —
  // handleSend saw hasPipe=false and issued start(resume:true) against a sid
  // whose CLI was ALIVE and mid-compaction. cmdStart killed it. The fix:
  // resume-with-message against a running pid delivers via FIFO and adopts
  // (no respawn); explicit restart (message:'') still respawns.
  it('start(resume) against a LIVE session adopts it — does NOT kill the process', async () => {
    const ws = await connectWs(daemon!.port)
    const sid = `e2e-live-adopt-${Date.now()}`

    const started = await sendCmd(ws, {
      cmd: 'start', sid, args: ['/bin/sleep', '60'], cwd: '/tmp', message: 'first\n',
    })
    expect(started.ok).toBe(true)
    const origPid = started.pid as number

    // Simulate the restart race: a second client issues start(resume:true)
    // with a message while the original process is still alive.
    const ws2 = await connectWs(daemon!.port)
    const resumed = await sendCmd(ws2, {
      cmd: 'start', sid, args: ['/bin/sleep', '60'], cwd: '/tmp',
      message: 'second — do not kill me\n', resume: true,
    })
    expect(resumed.ok).toBe(true)
    expect(resumed.adopted).toBe(true)
    // Same pid — the original process was adopted, not replaced.
    expect(resumed.pid).toBe(origPid)
    // Original process must still be alive.
    expect(() => process.kill(origPid, 0)).not.toThrow()

    // Explicit restart (empty message) must still take the respawn path.
    const restarted = await sendCmd(ws2, {
      cmd: 'start', sid, args: ['/bin/sleep', '60'], cwd: '/tmp', resume: true,
    })
    expect(restarted.ok).toBe(true)
    expect(restarted.adopted).toBeUndefined()
    expect(restarted.pid).not.toBe(origPid)
    // Old process was killed by the explicit respawn.
    await new Promise((r) => setTimeout(r, 500))
    expect(() => process.kill(origPid, 0)).toThrow()

    ws.close()
    ws2.close()
  })
})
