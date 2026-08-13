/**
 * E2E (incident a172ce49): the daemon's tailer intercept must clear pendingCtrl
 * when the CLI withdraws a pending can_use_tool via control_cancel_request.
 *
 * Runs the REAL daemon (getDaemonSource() template via node — the deployed
 * artifact, not a mock). The "CLI" is a shell script whose stdout the daemon
 * captures into the stream .jsonl; the tailer intercepts control lines from
 * exactly that file, so this exercises the production code path end to end:
 *
 *   stdout → stream file → watcher poll → permission intercept → pendingCtrl
 *
 * Before the fix, the intercept pre-filter only matched '"control_request"' /
 * '"control_response"' — a control_cancel_request line sailed past it and
 * pendingCtrl stayed set forever (snapshot waiting=true, permanent amber
 * "Waiting" badge, unanswerable card).
 */

import { describe, it, expect, afterEach } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import WebSocket from 'ws'
import { getDaemonSource } from '../../src/providers/daemon-source.js'

let rpcId = 1
const cleanups: Array<() => Promise<void> | void> = []

afterEach(async () => {
  while (cleanups.length > 0) {
    const fn = cleanups.pop()!
    try { await fn() } catch {}
  }
})

async function spawnDaemon(): Promise<{ proc: ChildProcess; port: number; daemonDir: string }> {
  const daemonDir = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-ctrlcancel-d-'))
  const streamsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-ctrlcancel-s-'))
  const scriptPath = path.join(daemonDir, 'daemon.cjs')
  fs.writeFileSync(scriptPath, getDaemonSource(), { mode: 0o755 })

  const proc = spawn('node', [scriptPath, '--start'], {
    env: {
      ...process.env,
      WALNUT_DAEMON_DIR: daemonDir,
      WALNUT_STREAMS_DIR: streamsDir,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: false,
  })
  const port = await new Promise<number>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('daemon spawn timeout')), 20_000)
    proc.stdout!.on('data', (chunk: Buffer) => {
      const m = chunk.toString().match(/^\d+$/m)
      if (m) { clearTimeout(t); resolve(parseInt(m[0], 10)) }
    })
    proc.on('error', (err) => { clearTimeout(t); reject(err) })
    proc.on('exit', (code) => { clearTimeout(t); reject(new Error('daemon exited early: ' + code)) })
  })

  cleanups.push(async () => {
    try { proc.kill('SIGTERM') } catch {}
    await new Promise((r) => setTimeout(r, 300))
    try { proc.kill('SIGKILL') } catch {}
    for (const d of [daemonDir, streamsDir]) {
      await fsp.rm(d, { recursive: true, force: true })
    }
  })
  return { proc, port, daemonDir }
}

function connectWs(port: number): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`)
    const t = setTimeout(() => reject(new Error('ws connect timeout')), 5000)
    ws.once('open', () => { clearTimeout(t); resolve(ws) })
    ws.once('error', (e) => { clearTimeout(t); reject(e) })
  })
}

function rpc(ws: WebSocket, cmd: Record<string, unknown>, timeoutMs = 10_000): Promise<Record<string, unknown>> {
  const id = rpcId++
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => { ws.off('message', onMsg); reject(new Error(`rpc timeout: ${cmd.cmd}`)) }, timeoutMs)
    const onMsg = (data: Buffer | string) => {
      try {
        const msg = JSON.parse(data.toString()) as Record<string, unknown>
        if (msg.id === id) { clearTimeout(t); ws.off('message', onMsg); resolve(msg) }
      } catch {}
    }
    ws.on('message', onMsg)
    ws.send(JSON.stringify({ id, ...cmd }))
  })
}

/** Poll getState until pred(pending permission) is true, or time out.
 *  NB the SNAPSHOT field is `pendingPermission` (assembleSnapshot renames the
 *  registry's `pendingCtrl` — see daemon-fold.ts). */
async function waitForPendingCtrl(
  ws: WebSocket,
  sid: string,
  pred: (ctrl: unknown) => boolean,
  timeoutMs = 10_000,
): Promise<unknown> {
  const deadline = Date.now() + timeoutMs
  let last: unknown = 'never-polled'
  while (Date.now() < deadline) {
    const res = await rpc(ws, { cmd: 'getState', sid })
    last = (res.snapshot as Record<string, unknown> | undefined)?.pendingPermission ?? null
    if (pred(last)) return last
    await new Promise((r) => setTimeout(r, 200))
  }
  throw new Error(`waitForPendingCtrl timeout; last=${JSON.stringify(last)}`)
}

describe('daemon tailer: control_cancel_request clears pendingCtrl (real daemon E2E)', () => {
  it('control_request sets pendingCtrl; control_cancel_request clears it', async () => {
    const d = await spawnDaemon()
    const ws = await connectWs(d.port)
    cleanups.push(() => ws.close())
    const sid = 'ctrl-cancel-e2e'

    // Fake CLI: emit a pending permission request, then WAIT for a trigger file
    // before withdrawing it — a fixed sleep raced (the request+cancel both
    // landed before the first getState poll), which made phase 1 unobservable.
    // Stays alive after the cancel so the daemon doesn't reap mid-assert.
    const triggerFile = path.join(d.daemonDir, 'emit-cancel-now')
    const fakeCli = [
      `echo '{"type":"system","subtype":"init","session_id":"${sid}"}'`,
      `echo '{"type":"control_request","request_id":"cc-1","request":{"subtype":"can_use_tool","tool_name":"Bash","input":{"command":"ls"}}}'`,
      `while [ ! -f '${triggerFile}' ]; do sleep 0.2; done`,
      `echo '{"type":"control_cancel_request","request_id":"cc-1"}'`,
      'sleep 60',
    ].join('; ')

    const start = await rpc(ws, {
      cmd: 'start', sid, args: ['/bin/sh', '-c', fakeCli], cwd: os.tmpdir(), message: 'hi', mode: 'default',
    })
    expect(start.ok ?? start.pid).toBeTruthy()

    // Phase 1: the request lands → pendingCtrl set with our request_id.
    // Snapshot shape uses `requestId`; the raw registry form uses `reqId`.
    const reqIdOf = (c: unknown) => (c as { requestId?: string; reqId?: string } | null)?.requestId
      ?? (c as { reqId?: string } | null)?.reqId
    const pending = await waitForPendingCtrl(ws, sid, (c) => reqIdOf(c) === 'cc-1')
    expect((pending as { toolName?: string }).toolName).toBe('Bash')

    // Phase 2: release the cancel → pendingCtrl cleared (was: stuck forever).
    fs.writeFileSync(triggerFile, '1')
    await waitForPendingCtrl(ws, sid, (c) => c == null)

    await rpc(ws, { cmd: 'stop', sid }, 15_000)
  }, 60_000)
})
