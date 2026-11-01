/**
 * tests/helpers/daemon-early-exit.ts: a daemon that dies while booting fails
 * the test with its own stderr and its daemon log in the message, and the first
 * line stays `daemon exited early: <code>`.
 */
import { describe, it, expect, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { daemonEarlyExitError, onDaemonEarlyExit } from '../helpers/daemon-early-exit.js'

const dirs: string[] = []
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-early-exit-')); dirs.push(d); return d }
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }) })

function runChild(code: string, dir: string | null, stdio: 'pipe' | 'ignore' = 'pipe'): Promise<Error> {
  const proc = spawn(process.execPath, ['-e', code], { stdio: ['ignore', stdio, stdio] })
  return new Promise((resolve) => onDaemonEarlyExit(proc, { daemonDir: dir }, resolve))
}

describe('daemonEarlyExitError', () => {
  it('keeps the first line and adds the stderr, the stdout without the port line, the breadcrumb and the log tail', () => {
    const dir = tmp()
    // A log bigger than the tail: only its end shows, starting at a whole line.
    const filler = Array.from({ length: 400 }, (_, i) => `{"level":"info","msg":"filler ${i}"}`).join('\n')
    fs.writeFileSync(path.join(dir, 'daemon-d-4242-0a1b2c3d.log'), filler + '\n{"level":"error","msg":"FATAL: uncaughtException — daemon exiting"}\n')
    fs.writeFileSync(path.join(dir, 'daemon-exit-d-4242-0a1b2c3d.log'), '{"kind":"uncaughtException","error":"boom at boot"}\n')
    const err = daemonEarlyExitError({ code: 1, pid: 4242, stderr: 'TypeError: x is not a function\n', stdout: '38211\nwarming up\n', daemonDir: dir })
    const lines = err.message.split('\n')
    expect(lines[0]).toBe('daemon exited early: 1')
    expect(err.message).toContain('TypeError: x is not a function')
    expect(err.message).toContain('warming up')
    expect(err.message).not.toMatch(/^38211$/m)
    expect(err.message).toContain('boom at boot')
    expect(err.message).toContain('FATAL: uncaughtException')
    expect(err.message).not.toContain('filler 0"')
    expect(err.message.length).toBeLessThan(10_000)
  })

  it("prefers the log naming the daemon's pid over a newer one of another daemon", () => {
    const dir = tmp()
    const own = path.join(dir, 'daemon-d-111-aaaaaaaa.log')
    fs.writeFileSync(own, 'own daemon line\n')
    fs.utimesSync(own, new Date(Date.now() - 60_000), new Date(Date.now() - 60_000))
    fs.writeFileSync(path.join(dir, 'daemon-d-222-bbbbbbbb.log'), 'other daemon line\n')
    expect(daemonEarlyExitError({ code: 1, pid: 111, daemonDir: dir }).message).toContain('own daemon line')
    // A pid that names no file (a wrapper process): the newest log.
    expect(daemonEarlyExitError({ code: 1, pid: 999, daemonDir: dir }).message).toContain('other daemon line')
  })

  it('never throws: a missing dir, no dir, and a signal death', () => {
    const missing = path.join(tmp(), 'gone')
    expect(daemonEarlyExitError({ code: 7, daemonDir: missing }).message.split('\n')[0]).toBe('daemon exited early: 7')
    expect(daemonEarlyExitError({ code: 7 }).message).toBe('daemon exited early: 7')
    const sig = daemonEarlyExitError({ code: null, signal: 'SIGKILL' })
    expect(sig.message).toBe('daemon exited early: null\nsignal: SIGKILL')
  })
})

describe('onDaemonEarlyExit on a real process', () => {
  it("reports the child's exit code, its last stderr, and the log it wrote under its own pid", async () => {
    const dir = tmp()
    const code = `
      const fs = require('fs'), path = require('path')
      fs.writeFileSync(path.join(${JSON.stringify(dir)}, 'daemon-d-' + process.pid + '-0a1b2c3d.log'), '{"msg":"FATAL: reconcile failed"}\\n')
      process.stdout.write('starting\\n')
      process.stderr.write('x'.repeat(10000) + '\\nlast stderr words\\n')
      process.exitCode = 3
    `
    const err = await runChild(code, dir)
    expect(err.message.split('\n')[0]).toBe('daemon exited early: 3')
    expect(err.message).toContain('last stderr words')
    expect(err.message).toContain('starting')
    expect(err.message).toContain('FATAL: reconcile failed')
    // The stderr tail is bounded.
    expect(err.message.length).toBeLessThan(10_000)
  })

  it('works when the process has no stdio pipes', async () => {
    const err = await runChild('process.exit(5)', null, 'ignore')
    expect(err.message).toBe('daemon exited early: 5')
  })

  it('reports a signal death', async () => {
    const proc = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: ['ignore', 'pipe', 'pipe'] })
    const got = new Promise<Error>((resolve) => onDaemonEarlyExit(proc, {}, resolve))
    proc.kill('SIGKILL')
    const err = await got
    expect(err.message.split('\n')[0]).toBe('daemon exited early: null')
    expect(err.message).toContain('signal: SIGKILL')
  })
})
