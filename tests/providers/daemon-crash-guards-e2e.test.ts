/**
 * Silent-death guards E2E — spawn the REAL daemon-source.ts template and
 * prove the three guards added for the 2026-08-13 phone-send data-loss
 * family actually behave:
 *
 *   1. a command whose handler throws gets an ERROR REPLY (daemon survives —
 *      the old behavior was process death mid phone-send);
 *   2. an uncaughtException writes the daemon-exit-<id>.log breadcrumb and
 *      exits 1 (the old behavior: silent vanish, zero evidence);
 *   3. a poison frame (valid JSON, not an object) is answered, not fatal.
 *
 * MACHINE SAFETY: isolated WALNUT_DAEMON_DIR/WALNUT_STREAMS_DIR temp dirs,
 * never /tmp/open-walnut; random port; the daemon is killed in afterEach.
 */
import { describe, it, expect, beforeAll, afterEach } from 'vitest'
import { WebSocket } from 'ws'
import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { getDaemonSource } from '../../src/providers/daemon-source.js'

let scriptPath = ''
let daemonDir = ''
let streamsDir = ''
let proc: ChildProcess | null = null
let port = 0
let ws: WebSocket | null = null

async function spawnDaemon(): Promise<void> {
  daemonDir = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-crash-guard-'))
  streamsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-crash-guard-streams-'))
  proc = spawn(process.execPath, [scriptPath, '--start'], {
    env: { ...process.env, WALNUT_DAEMON_DIR: daemonDir, WALNUT_STREAMS_DIR: streamsDir },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  port = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('daemon spawn timeout')), 20_000)
    proc!.stdout?.on('data', (chunk) => {
      const m = chunk.toString().trim().match(/^\d+$/m)
      if (m) { clearTimeout(timer); resolve(parseInt(m[0], 10)) }
    })
    proc!.on('error', (err) => { clearTimeout(timer); reject(err) })
    proc!.on('exit', (code) => { clearTimeout(timer); reject(new Error('daemon exited early: ' + code)) })
  })
  ws = await new Promise<WebSocket>((resolve, reject) => {
    const s = new WebSocket(`ws://127.0.0.1:${port}`)
    s.on('open', () => resolve(s))
    s.on('error', reject)
  })
}

function rpc(id: number, frame: string | Record<string, unknown>, timeoutMs = 15_000): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('rpc timeout')), timeoutMs)
    const onMessage = (data: Buffer) => {
      let msg: Record<string, unknown>
      try { msg = JSON.parse(data.toString()) } catch { return }
      // Poison-frame replies come back with id:null — accept those too when
      // the caller asked for them via id === -1.
      if (msg.id === id || (id === -1 && msg.id === null)) {
        clearTimeout(timer)
        ws!.off('message', onMessage)
        resolve(msg)
      }
    }
    ws!.on('message', onMessage)
    ws!.send(typeof frame === 'string' ? frame : JSON.stringify(frame))
  })
}

beforeAll(() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-crash-guard-src-'))
  scriptPath = path.join(dir, 'daemon.cjs')
  fs.writeFileSync(scriptPath, getDaemonSource(), { mode: 0o755 })
})

afterEach(async () => {
  try { ws?.close() } catch { /* already closed */ }
  ws = null
  if (proc && proc.exitCode === null) {
    proc.kill('SIGKILL')
    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, 2000)
      proc!.once('exit', () => { clearTimeout(t); resolve() })
    })
  }
  proc = null
  for (const d of [daemonDir, streamsDir]) {
    if (d) fs.rmSync(d, { recursive: true, force: true })
  }
})

describe('daemon crash guards (real source daemon)', () => {
  it('a throwing command handler produces an error reply, NOT process death', async () => {
    await spawnDaemon()
    // A genuine handler-level throw that needs no session: write-inbox with a
    // NUMERIC team passes the truthy-fields check, then path.join(..., 42, ...)
    // throws ERR_INVALID_ARG_TYPE — computed OUTSIDE the handler's own try.
    // Pre-guard, that throw escaped the ws message callback and killed the
    // daemon (the silent-death class this test pins down).
    const res = await rpc(11, { id: 11, cmd: 'write-inbox', team: 42, agent: 'x', text: 'hi' })
    expect(res.ok).not.toBe(true)
    expect(String(res.error ?? '')).toContain('internal daemon error handling write-inbox')
    // Daemon is still alive and serving.
    const pong = await rpc(12, { id: 12, cmd: 'ping' })
    expect(pong.ok).toBe(true)
    expect(proc!.exitCode).toBeNull()
  }, 60_000)

  it('a valid-JSON-but-not-object frame is answered, not fatal', async () => {
    await spawnDaemon()
    const res = await rpc(-1, 'null')
    expect(String(res.error ?? '')).toContain('invalid JSON')
    const pong = await rpc(13, { id: 13, cmd: 'ping' })
    expect(pong.ok).toBe(true)
  }, 60_000)

  it('an uncaughtException writes the exit breadcrumb and exits 1', async () => {
    await spawnDaemon()
    // Two halves of the forensic contract. First: a runtime-level death
    // (SIGKILL — the shape a Bun OOM kill takes) leaves NO breadcrumb; the
    // absence is itself the signal that distinguishes it from a JS crash.
    const breadcrumbsBefore = fs.readdirSync(daemonDir).filter((f) => f.startsWith('daemon-exit-'))
    expect(breadcrumbsBefore).toEqual([])
    proc!.kill('SIGKILL')
    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, 3000)
      proc!.once('exit', () => { clearTimeout(t); resolve() })
    })
    expect(fs.readdirSync(daemonDir).filter((f) => f.startsWith('daemon-exit-'))).toEqual([])
    // Second: a JS-level uncaughtException in a process running the SAME
    // guard code (extracted verbatim from the emitted template) writes a
    // breadcrumb with kind/error/stack/vitals and exits 1.
    const guardProbe = `
      const fs = require('node:fs');
      const path = require('node:path');
      global.__probeDir = ${JSON.stringify(daemonDir)};
      ${extractGuardSnippet()}
      setTimeout(() => { throw new Error('probe-boom') }, 10);
    `
    const probe = spawn(process.execPath, ['-e', guardProbe], { stdio: 'ignore' })
    const code = await new Promise<number | null>((resolve) => probe.on('exit', resolve))
    expect(code).toBe(1)
    const crumbs = fs.readdirSync(daemonDir).filter((f) => f.startsWith('daemon-exit-probe'))
    expect(crumbs.length).toBe(1)
    const line = JSON.parse(fs.readFileSync(path.join(daemonDir, crumbs[0]), 'utf-8').trim())
    expect(line.kind).toBe('uncaughtException')
    expect(line.error).toBe('probe-boom')
    expect(String(line.stack)).toContain('probe-boom')
    expect(typeof line.rssMb).toBe('number')
  }, 60_000)
})

/**
 * Extract the breadcrumb + crash funnel from the emitted template so the
 * probe process runs the PRODUCTION guard code (not a re-implementation).
 * The template names its file daemon-exit-<DAEMON_INSTANCE_ID>.log; the probe
 * pins the id to 'probe' via a tiny shim of the two referenced globals.
 */
function extractGuardSnippet(): string {
  const src = fs.readFileSync(scriptPath, 'utf-8')
  const start = src.indexOf('const EXIT_BREADCRUMB_FILE')
  const end = src.indexOf("process.on('unhandledRejection'", start)
  expect(start).toBeGreaterThan(-1)
  expect(end).toBeGreaterThan(start)
  const guard = src.slice(start, src.indexOf('\n', end))
  return `
    const DAEMON_DIR = global.__probeDir;
    const DAEMON_INSTANCE_ID = 'probe';
    const DAEMON_START_TS = Date.now();
    const sessions = new Map();
    const logMsg = () => {};
    ${guard}
  `
}
