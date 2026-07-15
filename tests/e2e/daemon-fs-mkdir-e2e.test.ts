/**
 * E2E: daemon fs.mkdir round-trip against the REAL daemon-source.ts template
 * (same spawn pattern as daemon-lifecycle-e2e). Also pins the `hello`
 * capability contract — a daemon missing 'fs.mkdir' would force redeploy.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { WebSocket } from 'ws'
import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { getDaemonSource } from '../../src/providers/daemon-source.js'

let proc: ChildProcess
let port: number
let tmpDir: string

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-mkdir-e2e-'))
  const scriptPath = path.join(tmpDir, 'daemon.cjs')
  fs.writeFileSync(scriptPath, getDaemonSource(), { mode: 0o755 })

  proc = spawn('node', [scriptPath, '--start'], {
    env: { ...process.env, WALNUT_DAEMON_DIR: path.join(tmpDir, 'daemon') },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  port = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('daemon spawn timeout')), 10_000)
    proc.stdout?.on('data', (chunk) => {
      const m = chunk.toString().trim().match(/^\d+$/m)
      if (m) { clearTimeout(timer); resolve(parseInt(m[0], 10)) }
    })
    proc.on('error', (err) => { clearTimeout(timer); reject(err) })
    proc.on('exit', (code) => { clearTimeout(timer); reject(new Error('daemon exited early: ' + code)) })
  })
}, 20_000)

afterAll(async () => {
  if (proc && proc.exitCode === null) {
    proc.kill('SIGTERM')
    await new Promise<void>((resolve) => {
      const t = setTimeout(() => { try { proc.kill('SIGKILL') } catch {} ; resolve() }, 3000)
      proc.once('exit', () => { clearTimeout(t); resolve() })
    })
  }
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

function connectWs(): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`)
    const t = setTimeout(() => reject(new Error('ws connect timeout')), 5000)
    ws.once('open', () => { clearTimeout(t); resolve(ws) })
    ws.once('error', (e) => { clearTimeout(t); reject(e) })
  })
}

function sendCmd(ws: WebSocket, cmd: Record<string, unknown>, timeoutMs = 10_000): Promise<Record<string, unknown>> {
  const id = Math.floor(Math.random() * 1e9)
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => { ws.off('message', handler); reject(new Error(`cmd ${cmd.cmd} timed out`)) }, timeoutMs)
    const handler = (data: WebSocket.Data) => {
      try {
        const msg = JSON.parse(data.toString())
        if (msg.id === id) {
          clearTimeout(t)
          ws.off('message', handler)
          resolve(msg)
        }
      } catch { /* non-JSON frame — ignore */ }
    }
    ws.on('message', handler)
    ws.send(JSON.stringify({ ...cmd, id }))
  })
}

describe('daemon fs.mkdir round-trip', () => {
  it('hello advertises the fs.mkdir capability', async () => {
    const ws = await connectWs()
    const res = await sendCmd(ws, { cmd: 'hello' })
    expect(res.ok).toBe(true)
    expect(res.capabilities).toContain('fs.mkdir')
    ws.close()
  })

  it('creates a nested directory recursively and is idempotent', async () => {
    const ws = await connectWs()
    const target = path.join(tmpDir, 'a/b/c')

    const res1 = await sendCmd(ws, { cmd: 'fs.mkdir', path: target })
    expect(res1.ok).toBe(true)
    expect(res1.created).toBe(true)
    expect(res1.resolvedPath).toBe(target)
    expect(fs.statSync(target).isDirectory()).toBe(true)

    // Second call on an existing dir — still ok (recursive mkdir tolerates it)
    const res2 = await sendCmd(ws, { cmd: 'fs.mkdir', path: target })
    expect(res2.ok).toBe(true)
    ws.close()
  })

  it('expands ~ to the daemon home directory', async () => {
    const ws = await connectWs()
    const rel = `.walnut-mkdir-e2e-${Date.now()}`
    const res = await sendCmd(ws, { cmd: 'fs.mkdir', path: `~/${rel}` })
    expect(res.ok).toBe(true)
    const expanded = path.join(os.homedir(), rel)
    expect(res.resolvedPath).toBe(expanded)
    expect(fs.statSync(expanded).isDirectory()).toBe(true)
    fs.rmSync(expanded, { recursive: true, force: true })
    ws.close()
  })

  it('missing path param → error', async () => {
    const ws = await connectWs()
    const res = await sendCmd(ws, { cmd: 'fs.mkdir' })
    expect(res.ok).toBe(false)
    expect(String(res.error)).toContain('missing path')
    ws.close()
  })
})
