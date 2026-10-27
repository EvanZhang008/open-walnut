/**
 * remote-fold-prewarm.ts: the probe and the run are EXECUTED, not string-matched
 * (the daemon-start-cmd.test.ts lesson). "ssh" here is a local /bin/sh, the
 * upload is a file write, and the run is the real daemon source under this
 * node, folding a real stream into `<stream>.jsonl.fold.next`.
 *
 * MACHINE SAFETY: HOME, the daemon dir and the streams dir are temp paths; the
 * only processes are /bin/sh and the prewarm child, which never listens,
 * signals, or touches a session.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { getDaemonSource } from '../../src/providers/daemon-source.js'
import { FOLD_CHECKPOINT_FORMAT } from '../../src/providers/fold-checkpoint-core.js'
import {
  REMOTE_FOLD_PREWARM_MIN_BYTES, buildRemoteFoldPrewarmProbe, parseRemoteFoldPrewarmPoll, parseRemoteFoldPrewarmProbe,
  remoteFoldPrewarmDir, remoteFoldPrewarmPidFile, runRemoteFoldPrewarm, type RemoteFoldPrewarmIo,
} from '../../src/providers/remote-fold-prewarm.js'
import { guardedPath } from '../setup/exec-guard-core.js'

const execFileAsync = promisify(execFile)
let root = ''
let daemonDir = ''
let streams = ''
let source = ''

beforeAll(() => { source = getDaemonSource() })
beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-remote-prewarm-')))
  daemonDir = path.join(root, 'daemon')
  streams = path.join(root, 'streams')
  fs.mkdirSync(daemonDir, { recursive: true })
  fs.mkdirSync(streams, { recursive: true })
  fs.mkdirSync(path.join(root, 'home'))
})
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }) })

const shellEnv = () => ({ PATH: guardedPath([], ['/usr/bin', '/bin'].join(path.delimiter)), HOME: path.join(root, 'home') })

/** The host's `sh -s`, as sshExec sees it: rejects on a non-zero exit. */
async function sh(script: string, timeoutMs = 60_000): Promise<string> {
  const { stdout } = await execFileAsync('/bin/sh', ['-c', script], { env: shellEnv(), timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 })
  return stdout
}

const L = (o: unknown) => JSON.stringify(o) + '\n'

/** A stream of at least the checkpoint size: a task, a confirmed CronCreate, deltas, a result. */
function bigStream(file: string): number {
  const parts = [
    L({ type: 'system', subtype: 'init', session_id: 'real-id' }),
    L({ type: 'system', subtype: 'task_started', task_id: 'early-task', description: 'early' }),
    L({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tu-cron', name: 'CronCreate', input: { cron: '7 9 * * *' } }] } }),
    L({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu-cron', content: 'ok' }] }, tool_use_result: { id: 'job-1' } }),
  ]
  const delta = L({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'x'.repeat(200) } } })
  for (let i = 0; i < (REMOTE_FOLD_PREWARM_MIN_BYTES + 1024 * 1024) / delta.length; i++) parts.push(delta)
  parts.push(L({ type: 'result', subtype: 'success', is_error: false, num_turns: 1 }))
  fs.writeFileSync(file, parts.join(''))
  return fs.statSync(file).size
}

function registry(sessions: Record<string, string>): void {
  const entries = Object.fromEntries(Object.entries(sessions).map(([sid, jsonlPath]) => [sid, { jsonlPath }]))
  fs.writeFileSync(path.join(daemonDir, 'sessions.json'), JSON.stringify({ version: 1, sessions: entries }))
}

function io(overrides: Partial<RemoteFoldPrewarmIo> = {}): RemoteFoldPrewarmIo & { calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    daemonDir,
    format: FOLD_CHECKPOINT_FORMAT,
    exec: (script, timeoutMs) => { calls.push(script); return sh(script, timeoutMs) },
    upload: async (remotePath, content) => { calls.push(`upload ${remotePath}`); fs.writeFileSync(remotePath, content) },
    source: () => source,
    // Stands in for the host's bun: this node runs the same source.
    bunPath: async () => process.execPath,
    preamble: 'true',
    pollMs: 100,
    env: {
      WALNUT_DAEMON_DIR: daemonDir,
      WALNUT_STREAMS_DIR: streams,
      WALNUT_LEGACY_STREAMS_DIR: path.join(root, 'no-legacy-streams'),
      WALNUT_SPAWN_JOURNAL: path.join(root, 'spawn-journal.jsonl'),
      HOME: path.join(root, 'home'),
    },
    ...overrides,
  }
}

describe('the remote probe, run by a real shell', () => {
  it('names exactly the large registered streams with no checkpoint in the new format', async () => {
    const big = (name: string) => { const p = path.join(streams, name); bigStream(p); return p }
    const none = big('none.jsonl')
    const oldFormat = big('old.jsonl')
    fs.writeFileSync(oldFormat + '.fold', JSON.stringify({ v: FOLD_CHECKPOINT_FORMAT - 1, boundary: 1 }))
    const current = big('current.jsonl')
    fs.writeFileSync(current + '.fold', JSON.stringify({ v: FOLD_CHECKPOINT_FORMAT, boundary: 1 }))
    const prepared = big('prepared.jsonl')
    fs.writeFileSync(prepared + '.fold', JSON.stringify({ v: FOLD_CHECKPOINT_FORMAT - 1, boundary: 1 }))
    fs.writeFileSync(prepared + '.fold.next', JSON.stringify({ v: FOLD_CHECKPOINT_FORMAT, boundary: 1 }))
    // A format whose number only starts like the current one is another format.
    const lookalike = big('lookalike.jsonl')
    fs.writeFileSync(lookalike + '.fold', JSON.stringify({ v: FOLD_CHECKPOINT_FORMAT * 10 + 1, boundary: 1 }))
    const small = path.join(streams, 'small.jsonl')
    fs.writeFileSync(small, L({ type: 'system' }))
    registry({ a: none, b: oldFormat, c: current, d: prepared, e: lookalike, f: small, g: path.join(streams, 'gone.jsonl') })

    const answer = parseRemoteFoldPrewarmProbe(await sh(buildRemoteFoldPrewarmProbe(daemonDir, FOLD_CHECKPOINT_FORMAT)))
    expect(answer).toEqual({ streams: 3, bytes: fs.statSync(none).size * 3, running: false })
  })

  it('no registry needs nothing; an answer without its sentinel is no answer', async () => {
    expect(parseRemoteFoldPrewarmProbe(await sh(buildRemoteFoldPrewarmProbe(daemonDir, FOLD_CHECKPOINT_FORMAT)))).toEqual({ streams: 0, bytes: 0, running: false })
    expect(parseRemoteFoldPrewarmProbe('walnut-fold-prewarm-needed 9000000')).toBeNull()
    expect(parseRemoteFoldPrewarmProbe('')).toBeNull()
  })

  it('a daemon dir with a space or a quote stays one word', async () => {
    daemonDir = path.join(root, "dir with 'quote'")
    fs.mkdirSync(daemonDir)
    const p = path.join(streams, 'none.jsonl')
    bigStream(p)
    registry({ a: p })
    expect(parseRemoteFoldPrewarmProbe(await sh(buildRemoteFoldPrewarmProbe(daemonDir, FOLD_CHECKPOINT_FORMAT)))?.streams).toBe(1)
  })
})

describe('runRemoteFoldPrewarm against the real daemon source', () => {
  it('prepares the new-format checkpoint for a stream that has only an old one, then needs nothing', async () => {
    const jsonl = path.join(streams, 'live.jsonl')
    const size = bigStream(jsonl)
    fs.writeFileSync(jsonl + '.fold', JSON.stringify({ v: FOLD_CHECKPOINT_FORMAT + 100, boundary: 1 }))
    registry({ live: jsonl })

    const first = io()
    const result = await runRemoteFoldPrewarm(first)
    expect(result).toMatchObject({ outcome: 'ran', streams: 1, runtime: 'bun', summary: { sessions: 1, written: 1 } })
    const next = JSON.parse(fs.readFileSync(jsonl + '.fold.next', 'utf8'))
    expect(next.v).toBe(FOLD_CHECKPOINT_FORMAT)
    expect(next.boundary).toBe(size)
    expect(next.fold.cronIds).toEqual({ 'job-1': 1 })
    expect(Object.keys(next.task.tasks)).toEqual(['early-task'])
    // The old daemon's own checkpoint is left as it was, and the new source is gone.
    expect(JSON.parse(fs.readFileSync(jsonl + '.fold', 'utf8')).v).toBe(FOLD_CHECKPOINT_FORMAT + 100)
    expect(fs.existsSync(remoteFoldPrewarmDir(daemonDir))).toBe(false)

    const second = io()
    expect(await runRemoteFoldPrewarm(second)).toEqual({ outcome: 'not-needed' })
    // Nothing needed: the probe was the only round trip, nothing was uploaded.
    expect(second.calls).toHaveLength(1)
  }, 120_000)

  it('no stream worth preparing: one probe, no upload', async () => {
    const small = path.join(streams, 'small.jsonl')
    fs.writeFileSync(small, L({ type: 'system' }))
    registry({ s: small })
    const run = io()
    expect(await runRemoteFoldPrewarm(run)).toEqual({ outcome: 'not-needed' })
    expect(run.calls).toHaveLength(1)
  })

  it('a run that fails rejects and still removes the uploaded source', async () => {
    const jsonl = path.join(streams, 'live.jsonl')
    bigStream(jsonl)
    registry({ live: jsonl })
    const failing = path.join(root, 'failing-runtime')
    fs.writeFileSync(failing, '#!/bin/sh\nexit 7\n', { mode: 0o755 })
    await expect(runRemoteFoldPrewarm(io({ bunPath: async () => failing }))).rejects.toThrow('code 7')
    expect(fs.existsSync(remoteFoldPrewarmDir(daemonDir))).toBe(false)
    expect(fs.existsSync(jsonl + '.fold.next')).toBe(false)
  })

  it('a probe with no answer rejects before anything is uploaded', async () => {
    const run = io({ exec: async (script) => { run.calls.push(script); return '' } })
    await expect(runRemoteFoldPrewarm(run)).rejects.toThrow('did not finish')
    expect(run.calls.some((c) => c.startsWith('upload'))).toBe(false)
  })
})

describe('a prewarm outlives the ssh and the server that started it', () => {
  function fakeRuntime(body: string): string {
    const file = path.join(root, 'fake-runtime')
    fs.writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 })
    return file
  }

  it('a connection that closes mid-run keeps the run and its pid; the next caller waits for it instead of starting another', async () => {
    const jsonl = path.join(streams, 'live.jsonl')
    bigStream(jsonl)
    registry({ live: jsonl })
    const slow = fakeRuntime('echo run >> "$HOME/runs.txt"; sleep 2; echo \'{"sessions":1,"written":1}\'')
    let open = true
    const first = io({ bunPath: async () => slow, alive: () => open })
    const running = runRemoteFoldPrewarm(first)
    await expect.poll(() => fs.existsSync(remoteFoldPrewarmPidFile(daemonDir))).toBe(true)
    open = false
    await expect(running).rejects.toThrow('connection closed')
    expect(fs.existsSync(remoteFoldPrewarmPidFile(daemonDir))).toBe(true)

    // The next server: the probe finds the live run and waits for it.
    const probe = parseRemoteFoldPrewarmProbe(await sh(buildRemoteFoldPrewarmProbe(daemonDir, FOLD_CHECKPOINT_FORMAT)))
    expect(probe?.running).toBe(true)
    const second = io({ bunPath: async () => slow })
    expect(await runRemoteFoldPrewarm(second)).toMatchObject({ outcome: 'waited' })
    expect(second.calls.some((c) => c.startsWith('upload'))).toBe(false)
    expect(fs.readFileSync(path.join(root, 'home', 'runs.txt'), 'utf8').trim().split('\n')).toHaveLength(1)
    expect(fs.existsSync(remoteFoldPrewarmDir(daemonDir))).toBe(false)
    expect(fs.existsSync(remoteFoldPrewarmPidFile(daemonDir))).toBe(false)
  }, 60_000)

  it('a poll the link did not answer is asked again', async () => {
    const jsonl = path.join(streams, 'live.jsonl')
    bigStream(jsonl)
    registry({ live: jsonl })
    const quick = fakeRuntime('sleep 1; echo \'{"sessions":1,"written":1}\'')
    let dropped = 0
    const run = io({
      bunPath: async () => quick,
      exec: async (script, timeoutMs) => {
        if (script.includes('walnut-fold-prewarm-gone') && dropped++ === 0) throw new Error('ssh: connection reset')
        return sh(script, timeoutMs)
      },
    })
    expect(await runRemoteFoldPrewarm(run)).toMatchObject({ outcome: 'ran', summary: { sessions: 1, written: 1 } })
    expect(dropped).toBeGreaterThan(1)
  }, 60_000)

  it('a pid file naming a process that is not a prewarm (a reused pid) is no prewarm', async () => {
    fs.writeFileSync(remoteFoldPrewarmPidFile(daemonDir), String(process.pid))
    expect(parseRemoteFoldPrewarmProbe(await sh(buildRemoteFoldPrewarmProbe(daemonDir, FOLD_CHECKPOINT_FORMAT)))?.running).toBe(false)
  })
})

describe('parseRemoteFoldPrewarmPoll', () => {
  it('an exit line wins; else running, gone, or no answer', () => {
    expect(parseRemoteFoldPrewarmPoll('walnut-fold-prewarm-running 12\nwalnut-fold-prewarm-exit=0\nnoise\n{"sessions":2}\n'))
      .toEqual({ state: 'exited', code: 0, summary: { sessions: 2 } })
    expect(parseRemoteFoldPrewarmPoll('walnut-fold-prewarm-running 12')).toEqual({ state: 'running' })
    expect(parseRemoteFoldPrewarmPoll('walnut-fold-prewarm-gone')).toEqual({ state: 'gone' })
    expect(parseRemoteFoldPrewarmPoll('')).toBeNull()
  })
})
