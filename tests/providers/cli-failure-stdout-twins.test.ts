/**
 * The session daemon's own `walnut` CLI puts a failed call's JSON on stdout when stderr is thrown away.
 *
 * 2026-11-23: a lead ran `walnut tools call task_history ... 2>/dev/null | python3 -c 'json.load'`;
 * the call failed, its one JSON object went to the discarded stderr, and python read nothing and
 * reported a JSON error, so the real cause was lost. The TS CLI was fixed in tool-call-output.ts
 * (stderrDiscarded); this checks the daemon's own CLI too (daemon-standalone.ts, which runs
 * wn-cli.ts). A pipe still gets it on stderr, as before.
 *
 * MACHINE SAFETY: HOME, the daemon dir and the socket are temp paths; the only processes are the
 * CLIs this file starts, each ended when its test ends.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import net from 'node:net'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { testBun } from '../helpers/bun-runtime.js'
import { guardedPath } from '../setup/exec-guard.js'

let root = ''
const BUN: string | undefined = testBun()
const STANDALONE = path.resolve(__dirname, '../../src/providers/daemon-standalone.ts')
const REFUSED = { ok: false, error: { code: 'bad_request', message: 'Invalid arguments for task_history: id: Required' } }
const procs: ChildProcess[] = []
const servers: net.Server[] = []
const daemonDir = () => path.join(root, 'daemon')
const sockPath = () => path.join(daemonDir(), 'agent-gateway.sock')

async function gateway(answer: Record<string, unknown>): Promise<void> {
  const server = net.createServer((sock) => {
    let buf = ''
    sock.on('data', (c) => {
      buf += c.toString('utf-8')
      if (buf.includes('\n')) sock.end(JSON.stringify(answer) + '\n')
    })
    sock.on('error', () => { /* the CLI went */ })
  })
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(sockPath(), resolve))
  fs.chmodSync(sockPath(), 0o600)
}

function cli(stderr: 'pipe' | 'devnull'): Promise<{ out: string; err: string; code: number | null }> {
  const argv = [STANDALONE, 'walnut', 'tools', 'call', 'task_history', '{}']
  const env: Record<string, string | undefined> = {
    ...process.env,
    SHELL: '/bin/sh',
    PATH: guardedPath([], '/usr/bin:/bin'),
    HOME: path.join(root, 'home'),
    WALNUT_DAEMON_DIR: daemonDir(),
    WALNUT_AGENT_SOCKET: sockPath(),
    WALNUT_SESSION_ID: 'external',
    WALNUT_CLI_WAIT_MS: '5000',
  }
  const nullFd = stderr === 'devnull' ? fs.openSync('/dev/null', 'w') : undefined
  const child = spawn(BUN!, argv, { env, stdio: ['ignore', 'pipe', nullFd ?? 'pipe'] })
  if (nullFd !== undefined) fs.closeSync(nullFd)
  procs.push(child)
  let out = ''
  let err = ''
  child.stdout?.on('data', (c) => { out += c })
  child.stderr?.on('data', (c) => { err += c })
  return new Promise((resolve) => child.on('close', (code) => resolve({ out, err, code })))
}

afterEach(async () => {
  for (const p of procs.splice(0)) { if (p.exitCode === null && p.signalCode === null) p.kill('SIGKILL') }
  for (const s of servers.splice(0)) await new Promise<void>((resolve) => s.close(() => resolve()))
  if (root) fs.rmSync(root, { recursive: true, force: true })
  root = ''
})

function newRoot(): void {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.platform() === 'win32' ? os.tmpdir() : '/tmp', 'wcs-')))
  for (const d of [path.join(root, 'home'), daemonDir()]) fs.mkdirSync(d, { recursive: true, mode: 0o700 })
}

describe.skipIf(!BUN)("a failed call's JSON reaches a reader, standalone daemon (bun)", () => {
  it('stderr thrown away: the one JSON object is on stdout, with its code', async () => {
    newRoot()
    await gateway(REFUSED)
    const r = await cli('devnull')
    expect(r.code).not.toBe(0)
    const parsed = JSON.parse(r.out) as { ok: boolean; error: { code: string; message: string } }
    expect(parsed.ok).toBe(false)
    expect(parsed.error.message).toContain('Invalid arguments for task_history')
  }, 60_000)

  it('stderr a pipe: stdout stays empty and the JSON is on stderr, as before', async () => {
    newRoot()
    await gateway(REFUSED)
    const r = await cli('pipe')
    expect(r.code).not.toBe(0)
    expect(r.out).toBe('')
    expect((JSON.parse(r.err.trim().split('\n').pop()!) as { ok: boolean }).ok).toBe(false)
  }, 60_000)
})
