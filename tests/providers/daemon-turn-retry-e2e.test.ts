/**
 * E2E: the daemon auto-retries a turn killed by a transient upstream error.
 *
 * Runs the REAL deployed daemon (getDaemonSource() template under node — the
 * exact artifact that ships to remote hosts, not a mock). The "CLI" is a shell
 * script whose stdout the daemon captures into the stream .jsonl, so this drives
 * the whole production path:
 *
 *   CLI stdout → stream file → watcher poll → checkTurnRetry → backoff timer
 *              → FIFO write → CLI reads its stdin
 *
 * Mock-green unit tests can't prove this: the retry only works if the tailer's
 * substring gate actually admits the result line, the policy is enabled from the
 * spawn env, the backoff timer survives, and the FIFO write lands in a stdin the
 * CLI is really reading. Each of those is a separate way to ship a silent no-op.
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

async function spawnDaemon(extraEnv: Record<string, string>): Promise<{
  proc: ChildProcess; port: number; daemonDir: string; streamsDir: string
}> {
  const daemonDir = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-retry-d-'))
  const streamsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-retry-s-'))
  const scriptPath = path.join(daemonDir, 'daemon.cjs')
  fs.writeFileSync(scriptPath, getDaemonSource(), { mode: 0o755 })

  // Scrub INHERITED retry vars before applying this test's own. The daemon reads
  // the feature from its env at boot, and a developer whose config enables
  // session.turn_retry runs their whole session under those vars (the local
  // daemon exports them when it spawns the CLI, so every child inherits them) —
  // which silently turns retries ON for the case that asserts a default install
  // stays inert. src/providers/local-daemon.ts scrubs the same five vars for the
  // same reason; a spawner's leftovers must never decide this behavior.
  const env: Record<string, string | undefined> = { ...process.env }
  for (const key of [
    'WALNUT_TURN_RETRY',
    'WALNUT_TURN_RETRY_BUDGET_MS',
    'WALNUT_TURN_RETRY_MAX_ATTEMPTS',
    'WALNUT_TURN_RETRY_BACKOFF_MS',
    'WALNUT_TURN_RETRY_BACKOFF_MAX_MS',
  ]) delete env[key]

  const proc = spawn('node', [scriptPath, '--start'], {
    env: {
      ...env,
      WALNUT_DAEMON_DIR: daemonDir,
      WALNUT_STREAMS_DIR: streamsDir,
      ...extraEnv,
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
  return { proc, port, daemonDir, streamsDir }
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

/**
 * Fake CLI: emit one `result` line with is_error, then echo whatever arrives on
 * stdin into a witness file. The retry is delivered as a FIFO stdin write, so the
 * witness file appearing IS proof of end-to-end delivery.
 */
function fakeCliScript(sid: string, resultText: string, witness: string): string {
  const resultLine = JSON.stringify({
    type: 'result', subtype: 'success', is_error: true,
    result: resultText, session_id: sid, num_turns: 1,
  })
  return [
    `echo '${JSON.stringify({ type: 'system', subtype: 'init', session_id: sid })}'`,
    // Single-quote-safe: the payload has no single quotes (JSON uses doubles).
    `echo '${resultLine}'`,
    // Read stdin (the FIFO) forever, appending each line to the witness file.
    `while IFS= read -r line; do printf '%s\\n' "$line" >> '${witness}'; done`,
    'sleep 60',
  ].join('; ')
}

/**
 * Wait until the witness file CONTAINS `needle`.
 *
 * Deliberately not "wait until the file is non-empty": the first line to land is
 * always the session's opening message, so a non-empty check returns before the
 * retry has been delivered and the assertion then fails on stale content.
 */
async function waitForContent(p: string, needle: string, timeoutMs: number): Promise<string> {
  const deadline = Date.now() + timeoutMs
  let last = ''
  while (Date.now() < deadline) {
    try {
      last = fs.readFileSync(p, 'utf-8')
      if (last.includes(needle)) return last
    } catch {}
    await new Promise((r) => setTimeout(r, 200))
  }
  throw new Error(`timed out waiting for ${JSON.stringify(needle)} in ${p}; last content: ${last}`)
}

async function readStream(streamsDir: string, sid: string): Promise<string> {
  try { return await fsp.readFile(path.join(streamsDir, sid + '.jsonl'), 'utf-8') } catch { return '' }
}

describe('daemon turn-error auto-retry (real daemon E2E)', () => {
  it('resumes a turn that died to a transient timeout, and tells the user', async () => {
    const sid = 'retry-transient-e2e'
    // 1s backoff so the test doesn't wait the 30s production default.
    const d = await spawnDaemon({
      WALNUT_TURN_RETRY: '1',
      WALNUT_TURN_RETRY_BACKOFF_MS: '1000',
      WALNUT_TURN_RETRY_BACKOFF_MAX_MS: '1000',
    })
    const ws = await connectWs(d.port)
    cleanups.push(() => ws.close())

    const witness = path.join(d.daemonDir, 'stdin-witness.txt')
    const start = await rpc(ws, {
      cmd: 'start', sid,
      args: ['/bin/sh', '-c', fakeCliScript(sid, 'API Error: The operation timed out.', witness)],
      cwd: os.tmpdir(), message: 'do the thing', mode: 'default',
    })
    expect(start.ok ?? start.pid).toBeTruthy()

    // THE assertion: the retry message really reached the CLI's stdin.
    const delivered = await waitForContent(witness, 'Walnut auto-retry', 20_000)
    expect(delivered).toContain('automated message, not from the user')
    // It must tell the model to continue, not to start over.
    expect(delivered.toLowerCase()).toContain('do not restart the task from the beginning')

    // And the human gets a timeline row explaining what happened.
    const stream = await readStream(d.streamsDir, sid)
    expect(stream).toContain('"subtype":"turn_retry"')
    expect(stream).toContain('auto-retrying')

    await rpc(ws, { cmd: 'stop', sid }, 15_000)
  }, 90_000)

  it('does NOT retry a model refusal (the infinite-loop case)', async () => {
    const sid = 'retry-refusal-e2e'
    const d = await spawnDaemon({
      WALNUT_TURN_RETRY: '1',
      WALNUT_TURN_RETRY_BACKOFF_MS: '1000',
      WALNUT_TURN_RETRY_BACKOFF_MAX_MS: '1000',
    })
    const ws = await connectWs(d.port)
    cleanups.push(() => ws.close())

    const witness = path.join(d.daemonDir, 'stdin-witness.txt')
    await rpc(ws, {
      cmd: 'start', sid,
      args: ['/bin/sh', '-c', fakeCliScript(
        sid, "API Error: Assistant can't help with this. Start a new session to continue.", witness,
      )],
      cwd: os.tmpdir(), message: 'do the thing', mode: 'default',
    })

    // Wait well past the backoff — nothing must be injected.
    await new Promise((r) => setTimeout(r, 6000))
    let body = ''
    try { body = fs.readFileSync(witness, 'utf-8') } catch { /* absent = also fine */ }
    expect(body).not.toContain('Walnut auto-retry')

    // No retry marker either (a refusal on a fresh session gets no extra row:
    // the CLI's own error is already in the timeline).
    const stream = await readStream(d.streamsDir, sid)
    expect(stream).not.toContain('"subtype":"turn_retry"')

    await rpc(ws, { cmd: 'stop', sid }, 15_000)
  }, 90_000)

  it('stays completely inert when the feature is disabled (default install)', async () => {
    const sid = 'retry-disabled-e2e'
    // No WALNUT_TURN_RETRY at all — exactly how a default install spawns.
    const d = await spawnDaemon({})
    const ws = await connectWs(d.port)
    cleanups.push(() => ws.close())

    const witness = path.join(d.daemonDir, 'stdin-witness.txt')
    await rpc(ws, {
      cmd: 'start', sid,
      args: ['/bin/sh', '-c', fakeCliScript(sid, 'API Error: The operation timed out.', witness)],
      cwd: os.tmpdir(), message: 'do the thing', mode: 'default',
    })

    await new Promise((r) => setTimeout(r, 5000))
    let body = ''
    try { body = fs.readFileSync(witness, 'utf-8') } catch {}
    expect(body).not.toContain('Walnut auto-retry')
    const stream = await readStream(d.streamsDir, sid)
    expect(stream).not.toContain('turn_retry')

    await rpc(ws, { cmd: 'stop', sid }, 15_000)
  }, 90_000)

  it('a user message during the backoff cancels the pending retry', async () => {
    const sid = 'retry-superseded-e2e'
    // Long backoff so the user send definitely lands first.
    const d = await spawnDaemon({
      WALNUT_TURN_RETRY: '1',
      WALNUT_TURN_RETRY_BACKOFF_MS: '8000',
      WALNUT_TURN_RETRY_BACKOFF_MAX_MS: '8000',
    })
    const ws = await connectWs(d.port)
    cleanups.push(() => ws.close())

    const witness = path.join(d.daemonDir, 'stdin-witness.txt')
    await rpc(ws, {
      cmd: 'start', sid,
      args: ['/bin/sh', '-c', fakeCliScript(sid, 'API Error: The operation timed out.', witness)],
      cwd: os.tmpdir(), message: 'do the thing', mode: 'default',
    })

    // Wait for the retry to be SCHEDULED (marker written), then take over.
    const deadline = Date.now() + 15_000
    while (Date.now() < deadline) {
      if ((await readStream(d.streamsDir, sid)).includes('"subtype":"turn_retry"')) break
      await new Promise((r) => setTimeout(r, 200))
    }
    await rpc(ws, { cmd: 'send', sid, message: 'actually, do this instead' })

    // The user's message must arrive...
    const body = await waitForContent(witness, 'actually, do this instead', 10_000)
    expect(body).not.toContain('Walnut auto-retry')
    // ...and past the original backoff deadline the retry still must not appear.
    await new Promise((r) => setTimeout(r, 11_000))
    expect(fs.readFileSync(witness, 'utf-8')).not.toContain('Walnut auto-retry')

    await rpc(ws, { cmd: 'stop', sid }, 15_000)
  }, 120_000)
})
