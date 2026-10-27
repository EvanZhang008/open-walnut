/**
 * A resume or an attach of a big stream file, run by both daemon twins booted
 * for real.
 *
 * Why: on 2026-10-27 a resume of a session whose stream file was 2.5 GB, with
 * no checkpoint the daemon could use (a checkpoint format change had rejected
 * it), folded the whole file on the daemon's one thread before it answered
 * anything: every local session went quiet for 214 s. These tests pin that a
 * fold of any size leaves the daemon answering, that it leaves a checkpoint so
 * the next resume is cheap, that a stop during the fold ends it, and that a
 * resume of a file over the rotation cap then starts a fresh file (the
 * conversation lives in the Claude transcript, which must exist for that; a
 * file whose fold holds an armed cron or wakeup is kept, since the fresh file
 * would forget them).
 *
 * The file is 128 MB by default with a background task every turn (the
 * quadratic case); WALNUT_TEST_BIG_STREAM_MB and WALNUT_TEST_BIG_STREAM_TASK_EVERY
 * scale it (the 2026-10-27 proof ran 3000 MB, a task every 10 turns).
 *
 * MACHINE SAFETY: HOME, the daemon dir and the streams dir are temp paths, the
 * "CLI" is /bin/sh, and the daemon is SIGKILLed after each test.
 */
import { describe, it, expect, beforeAll, afterEach } from 'vitest'
import { WebSocket } from 'ws'
import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { getDaemonSource } from '../../src/providers/daemon-source.js'
import { guardedPath } from '../setup/exec-guard.js'

let scriptPath = ''
let root = ''
const BUN = [process.env.BUN_INSTALL && path.join(process.env.BUN_INSTALL, 'bin/bun'), path.join(os.homedir(), '.bun/bin/bun'), '/opt/homebrew/bin/bun', '/usr/local/bin/bun']
  .find((p): p is string => !!p && fs.existsSync(p))
const STANDALONE = path.resolve(__dirname, '../../src/providers/daemon-standalone.ts')
type Twin = { name: string; command: () => [string, string[]] }
const TWINS: Twin[] = [
  { name: 'source twin (node)', command: () => [process.execPath, [scriptPath, '--start']] },
  ...(BUN ? [{ name: 'standalone twin (bun)', command: (): [string, string[]] => [BUN, [STANDALONE, '--start']] }] : []),
]
const BIG_MB = parseInt(process.env.WALNUT_TEST_BIG_STREAM_MB || '', 10) || 128
// One background task every this many turns (1 is the quadratic stress case).
const TASK_EVERY = parseInt(process.env.WALNUT_TEST_BIG_STREAM_TASK_EVERY || '', 10) || 1
// The daemon may not hold its loop longer than this while it folds, and must
// answer a few pings during the fold (a blocked loop answers none).
const MAX_PING_MS = 1000
const MIN_PINGS = 3
let proc: ChildProcess | null = null
let ws: WebSocket | null = null
let rpcId = 1

interface Dirs { home: string; streams: string; daemon: string }

function makeDirs(): Dirs {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-bigstream-')))
  const home = path.join(root, 'home')
  fs.mkdirSync(home, { recursive: true })
  return { home, streams: path.join(root, 'streams'), daemon: path.join(root, 'daemon') }
}

async function boot(twin: Twin, dirs: Dirs, extra: Record<string, string> = {}): Promise<void> {
  const env: Record<string, string | undefined> = {
    ...process.env,
    SHELL: '/bin/sh',
    PATH: guardedPath([], '/usr/bin:/bin'),
    HOME: dirs.home,
    CLAUDE_CONFIG_DIR: undefined,
    WALNUT_DAEMON_DIR: dirs.daemon,
    WALNUT_STREAMS_DIR: dirs.streams,
    WALNUT_LEGACY_STREAMS_DIR: path.join(root, 'no-legacy-streams'),
    WALNUT_SPAWN_JOURNAL: path.join(root, 'spawn-journal.jsonl'),
    // No compaction sweep during a test: it would read the same file.
    WALNUT_STREAM_COMPACT_SWEEP_MS: '600000000',
    ...extra,
  }
  const [cmd, args] = twin.command()
  proc = spawn(cmd, args, { env, stdio: ['ignore', 'pipe', 'pipe'] })
  const port = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('daemon spawn timeout')), 30_000)
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

async function stop(): Promise<void> {
  try { ws?.close() } catch { /* already closed */ }
  ws = null
  if (proc && proc.exitCode === null && proc.signalCode === null) {
    const exited = new Promise<void>((resolve) => {
      const t = setTimeout(resolve, 10_000)
      proc!.once('exit', () => { clearTimeout(t); resolve() })
    })
    proc.kill('SIGKILL')
    await exited
  }
  proc = null
}

function rpc(cmd: Record<string, unknown>, timeoutMs = 600_000): Promise<Record<string, unknown>> {
  const id = rpcId++
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('rpc timeout: ' + String(cmd.cmd))), timeoutMs)
    const onMessage = (data: Buffer) => {
      let msg: Record<string, unknown>
      try { msg = JSON.parse(data.toString()) } catch { return }
      if (msg.id === id) { clearTimeout(timer); ws!.off('message', onMessage); resolve(msg) }
    }
    ws!.on('message', onMessage)
    ws!.send(JSON.stringify({ id, ...cmd }))
  })
}

/** Run `work` while pinging the daemon; the slowest ping answer, in ms. */
async function worstPingDuring<T>(work: Promise<T>): Promise<{ result: T; worstPingMs: number; pings: number }> {
  let done = false
  let worst = 0
  let pings = 0
  const pinger = (async () => {
    while (!done) {
      const t0 = Date.now()
      await rpc({ cmd: 'ping' })
      worst = Math.max(worst, Date.now() - t0)
      pings++
      await new Promise((r) => setTimeout(r, 20))
    }
  })()
  let result: T
  try {
    result = await work
  } finally {
    done = true
    // A ping still in flight counts: it waited behind the work.
    await pinger
  }
  return { result, worstPingMs: worst, pings }
}

async function waitFor(check: () => boolean, ms = 20_000, every = 50): Promise<boolean> {
  const until = Date.now() + ms
  while (Date.now() < until) {
    if (check()) return true
    await new Promise((r) => setTimeout(r, every))
  }
  return check()
}

function daemonLog(dirs: Dirs): string {
  try {
    return fs.readdirSync(dirs.daemon).filter((f) => f.startsWith('daemon-') && f.endsWith('.log'))
      .map((f) => fs.readFileSync(path.join(dirs.daemon, f), 'utf8')).join('')
  } catch { return '' }
}

const L = (o: unknown) => JSON.stringify(o) + '\n'
const WAKEUP_AT = Date.now() + 3_600_000
const epochOf = (file: string) => { const st = fs.statSync(file); return `${st.dev}:${st.ino}:${Math.floor(st.birthtimeMs)}` }

/**
 * Write a stream file of about `mb` MB shaped like a real one: turns of token
 * deltas, assistant text, tool calls with large results, and background task
 * lines. It ends with a finished turn and one background task still running.
 */
function writeBigStream(file: string, mb: number, opts: { cron?: boolean } = {}): number {
  const fd = fs.openSync(file, 'w')
  const target = mb * 1024 * 1024
  let size = 0
  const put = (s: string) => { fs.writeSync(fd, s); size += Buffer.byteLength(s) }
  put(L({ type: 'system', subtype: 'init', session_id: 'big-real-id' }))
  if (opts.cron) {
    // An armed cron and a ScheduleWakeup: both outlive the process.
    put(L({ type: 'user', message: { role: 'user', content: 'arm a loop' } }))
    put(L({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tu-cron', name: 'CronCreate', input: { cron: '7 9 * * *' } }] } }))
    put(L({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu-cron', content: 'ok' }] }, tool_use_result: { id: 'job-1' } }))
    put(L({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu-wake', content: 'Next wakeup scheduled' }] }, tool_use_result: { scheduledFor: WAKEUP_AT } }))
  }
  const delta = L({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'word '.repeat(30) } } })
  const result = 'r'.repeat(6000)
  let turn = 0
  while (size < target) {
    turn++
    const block: string[] = []
    block.push(L({ type: 'user', message: { role: 'user', content: 'turn ' + turn } }))
    for (let i = 0; i < 40; i++) block.push(delta)
    block.push(L({ type: 'system', subtype: 'thinking_tokens', tokens: 40 }))
    block.push(L({ type: 'assistant', message: { content: [{ type: 'text', text: 'answer '.repeat(200) }] } }))
    block.push(L({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tu-' + turn, name: 'Bash', input: { command: 'ls' } }] } }))
    block.push(L({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu-' + turn, content: result }] } }))
    // One background task per turn with progress ticks: a long session holds
    // thousands of tasks (the 2026-10-27 stream's task pass was quadratic in them).
    if (turn === 50 || turn % TASK_EVERY === 0) {
      block.push(L({ type: 'system', subtype: 'task_started', task_id: 'bg-' + turn, description: 'build', tool_use_id: 'tu-' + turn }))
      for (let i = 0; i < 8; i++) block.push(L({ type: 'system', subtype: 'task_progress', task_id: 'bg-' + turn, tool_use_id: 'tu-' + turn, description: 'step ' + i }))
      block.push(L({ type: 'system', subtype: 'task_notification', task_id: 'bg-' + turn, tool_use_id: 'tu-' + turn, status: 'completed' }))
    }
    block.push(L({ duration_api_ms: 10, stop_reason: 'end_turn', type: 'result', subtype: 'success', is_error: false, num_turns: turn }))
    block.push(L({ type: 'system', subtype: 'session_state_changed', state: 'idle' }))
    put(block.join(''))
  }
  put(L({ type: 'system', subtype: 'task_started', task_id: 'bg-last', description: 'still running' }))
  fs.closeSync(fd)
  return size
}

beforeAll(() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-bigstream-src-'))
  scriptPath = path.join(dir, 'daemon.cjs')
  fs.writeFileSync(scriptPath, getDaemonSource(), { mode: 0o755 })
})

afterEach(async () => {
  await stop()
  if (root) fs.rmSync(root, { recursive: true, force: true })
  root = ''
})

describe.each(TWINS)('big stream resume: $name', (twin) => {
  it('a resume with no checkpoint folds the whole file while the daemon keeps answering, and leaves a checkpoint', async () => {
    const dirs = makeDirs()
    await boot(twin, dirs)
    fs.mkdirSync(dirs.streams, { recursive: true })
    const jsonl = path.join(dirs.streams, 'big-1.jsonl')
    const size = writeBigStream(jsonl, BIG_MB)
    const ino = fs.statSync(jsonl).ino

    const t0 = Date.now()
    const { result: resumed, worstPingMs, pings } = await worstPingDuring(rpc({
      cmd: 'start', sid: 'big-1', cwd: root, message: '', mode: 'default', resume: true,
      args: ['/bin/sh', '-c', 'sleep 30', 'sh'],
    }))
    const resumeMs = Date.now() - t0
    console.log(`[big-stream] ${twin.name}: ${BIG_MB} MB resume ${resumeMs} ms, ${pings} pings, worst ${worstPingMs} ms`)
    expect(resumed.ok).toBe(true)
    // The fold read every complete line: the watcher starts at the end.
    expect(resumed.offset).toBe(size)
    expect(fs.statSync(jsonl).ino).toBe(ino)
    expect(worstPingMs).toBeLessThan(MAX_PING_MS)
    expect(pings).toBeGreaterThanOrEqual(MIN_PINGS)

    const state = await rpc({ cmd: 'getState', sid: 'big-1' })
    expect((state.snapshot as { v: number }).v).toBe(size)
    const tasks = (state.taskState as { tasks: Record<string, { status: string }> }).tasks
    expect(tasks['bg-last']?.status).toBe('running')
    expect(tasks['bg-50']?.status).toBe('completed')

    // The checkpoint the fold left describes the whole file.
    const ck = JSON.parse(fs.readFileSync(jsonl + '.fold', 'utf8'))
    expect(ck.epoch).toBe(epochOf(jsonl))
    expect(ck.boundary).toBe(size)

    // So the next resume (a restarted daemon, nothing in memory) reads almost nothing.
    await rpc({ cmd: 'stop', sid: 'big-1' })
    await stop()
    await boot(twin, dirs)
    const t1 = Date.now()
    const again = await rpc({
      cmd: 'start', sid: 'big-1', cwd: root, message: '', mode: 'default', resume: true,
      args: ['/bin/sh', '-c', 'sleep 30', 'sh'],
    })
    expect(again.ok).toBe(true)
    expect(again.offset as number).toBeGreaterThanOrEqual(size)
    expect(Date.now() - t1).toBeLessThan(Math.max(3000, resumeMs / 3))
    const later = await rpc({ cmd: 'getState', sid: 'big-1' })
    expect((later.taskState as { tasks: Record<string, { status: string }> }).tasks['bg-last']?.status).toBe('running')
    await rpc({ cmd: 'stop', sid: 'big-1' })
  }, 900_000)

  it('an attach that discovers a big unknown stream folds it while the daemon keeps answering', async () => {
    const dirs = makeDirs()
    await boot(twin, dirs)
    fs.mkdirSync(dirs.streams, { recursive: true })
    const jsonl = path.join(dirs.streams, 'big-2.jsonl')
    const size = writeBigStream(jsonl, BIG_MB)
    const { result: attached, worstPingMs, pings } = await worstPingDuring(rpc({ cmd: 'attach', sid: 'big-2', fromOffset: 0 }))
    console.log(`[big-stream] ${twin.name}: ${BIG_MB} MB attach, ${pings} pings, worst ${worstPingMs} ms`)
    expect(attached.ok).toBe(true)
    expect(attached.alive).toBe(false)
    expect(worstPingMs).toBeLessThan(MAX_PING_MS)
    expect(pings).toBeGreaterThanOrEqual(MIN_PINGS)
    const state = await rpc({ cmd: 'getState', sid: 'big-2' })
    expect((state.snapshot as { v: number }).v).toBe(size)
    expect((state.taskState as { tasks: Record<string, { status: string }> }).tasks['bg-last']?.status).toBe('running')
  }, 900_000)

  it('a resume of a file over the rotation cap starts a fresh file when the transcript exists', async () => {
    const dirs = makeDirs()
    await boot(twin, dirs, { WALNUT_STREAM_ROTATE_BYTES: String(4 * 1024 * 1024) })
    fs.mkdirSync(dirs.streams, { recursive: true })
    const projects = path.join(dirs.home, '.claude', 'projects', '-work-repo')
    fs.mkdirSync(projects, { recursive: true })
    fs.writeFileSync(path.join(projects, 'rot-1.jsonl'), L({ type: 'user', message: { content: 'hi' } }))
    const jsonl = path.join(dirs.streams, 'rot-1.jsonl')
    writeBigStream(jsonl, 8)
    fs.writeFileSync(jsonl + '.fold', '{}')
    const oldEpoch = epochOf(jsonl)
    const out = path.join(root, 'out.jsonl')
    fs.writeFileSync(out, L({ type: 'system', subtype: 'init', session_id: 'rot-1' }))

    const resumed = await rpc({
      cmd: 'start', sid: 'rot-1', cwd: root, message: '', mode: 'default', resume: true,
      args: ['/bin/sh', '-c', `cat ${JSON.stringify(out)}; sleep 30`, 'sh', '--resume', 'rot-1'],
    })
    expect(resumed.ok).toBe(true)
    expect(resumed.offset).toBe(0)
    expect(await waitFor(() => fs.readFileSync(jsonl, 'utf8').includes('"session_id":"rot-1"'))).toBe(true)
    expect(epochOf(jsonl)).not.toBe(oldEpoch)
    expect(fs.readFileSync(jsonl, 'utf8')).not.toContain('turn 1"')
    expect(fs.existsSync(jsonl + '.fold')).toBe(false)
    expect(daemonLog(dirs)).toContain('"stream rotated"')
    const state = await rpc({ cmd: 'getState', sid: 'rot-1' })
    expect((state.snapshot as { streamEpoch: string }).streamEpoch).toBe(epochOf(jsonl))
    // The old process's background tasks died with it.
    expect((state.taskState as { tasks: Record<string, unknown> }).tasks['bg-last']).toBeUndefined()
    await rpc({ cmd: 'stop', sid: 'rot-1' })
  }, 120_000)

  it('a stop during the fold ends it: the start spawns nothing and the progress is kept', async () => {
    const dirs = makeDirs()
    await boot(twin, dirs)
    fs.mkdirSync(dirs.streams, { recursive: true })
    const jsonl = path.join(dirs.streams, 'stop-1.jsonl')
    const size = writeBigStream(jsonl, BIG_MB)
    const started = rpc({
      cmd: 'start', sid: 'stop-1', cwd: root, message: '', mode: 'default', resume: true,
      args: ['/bin/sh', '-c', 'sleep 30', 'sh'],
    })
    await new Promise((r) => setTimeout(r, 100))
    const t0 = Date.now()
    const stopped = rpc({ cmd: 'stop', sid: 'stop-1', reason: 'user' })
    const [start, stop] = await Promise.all([started, stopped])
    const stopMs = Date.now() - t0
    expect(start.reason, JSON.stringify(start)).toBe('session_stopped')
    expect(stop.id).toBeDefined()
    // A partial fold's checkpoint is still a valid prefix; the next resume continues it.
    const ck = JSON.parse(fs.readFileSync(jsonl + '.fold', 'utf8'))
    expect(ck.boundary).toBeLessThan(size)
    expect(daemonLog(dirs)).toMatch(/"stream folded"[^\n]*"aborted":true/)
    console.log(`[big-stream] ${twin.name}: stop answered after ${stopMs} ms, fold stopped at ${ck.boundary} of ${size}`)
    expect(fs.existsSync(path.join(dirs.streams, 'stop-1.pgid'))).toBe(false)
  }, 900_000)

  it('a big file is kept while its fold holds an armed cron', async () => {
    const dirs = makeDirs()
    await boot(twin, dirs, { WALNUT_STREAM_ROTATE_BYTES: String(4 * 1024 * 1024) })
    fs.mkdirSync(dirs.streams, { recursive: true })
    const projects = path.join(dirs.home, '.claude', 'projects', '-work-repo')
    fs.mkdirSync(projects, { recursive: true })
    fs.writeFileSync(path.join(projects, 'cron-1.jsonl'), L({ type: 'user', message: { content: 'hi' } }))
    const jsonl = path.join(dirs.streams, 'cron-1.jsonl')
    const size = writeBigStream(jsonl, 8, { cron: true })
    const ino = fs.statSync(jsonl).ino
    const resumed = await rpc({
      cmd: 'start', sid: 'cron-1', cwd: root, message: '', mode: 'default', resume: true,
      args: ['/bin/sh', '-c', 'sleep 30', 'sh', '--resume', 'cron-1'],
    })
    expect(resumed.ok).toBe(true)
    expect(resumed.offset).toBe(size)
    expect(fs.statSync(jsonl).ino).toBe(ino)
    expect(daemonLog(dirs)).toMatch(/"stream rotation skipped"[^\n]*"reason":"cron-armed"/)
    const state = await rpc({ cmd: 'getState', sid: 'cron-1' })
    const snap = state.snapshot as { cronActive: boolean; wakeupAt?: number | null }
    expect(snap.cronActive).toBe(true)
    expect(snap.wakeupAt).toBe(WAKEUP_AT)
    await rpc({ cmd: 'stop', sid: 'cron-1' })
  }, 120_000)

  it('a big file is kept when its transcript is missing or the cap is not reached', async () => {
    const dirs = makeDirs()
    await boot(twin, dirs, { WALNUT_STREAM_ROTATE_BYTES: String(4 * 1024 * 1024) })
    fs.mkdirSync(dirs.streams, { recursive: true })
    // Over the cap, but no transcript: the stream file may be the only copy.
    const a = path.join(dirs.streams, 'keep-1.jsonl')
    const aSize = writeBigStream(a, 8)
    const aIno = fs.statSync(a).ino
    const ra = await rpc({
      cmd: 'start', sid: 'keep-1', cwd: root, message: '', mode: 'default', resume: true,
      args: ['/bin/sh', '-c', 'sleep 30', 'sh', '--resume', 'keep-1'],
    })
    expect(ra.ok).toBe(true)
    expect(ra.offset).toBe(aSize)
    expect(fs.statSync(a).ino).toBe(aIno)

    // Under the cap, with a transcript: kept.
    const projects = path.join(dirs.home, '.claude', 'projects', '-work-repo')
    fs.mkdirSync(projects, { recursive: true })
    fs.writeFileSync(path.join(projects, 'keep-2.jsonl'), L({ type: 'user', message: { content: 'hi' } }))
    const b = path.join(dirs.streams, 'keep-2.jsonl')
    const bSize = writeBigStream(b, 2)
    const rb = await rpc({
      cmd: 'start', sid: 'keep-2', cwd: root, message: '', mode: 'default', resume: true,
      args: ['/bin/sh', '-c', 'sleep 30', 'sh', '--resume', 'keep-2'],
    })
    expect(rb.ok).toBe(true)
    expect(rb.offset).toBe(bSize)
    expect(daemonLog(dirs)).not.toContain('"stream rotated"')
    await rpc({ cmd: 'stop', sid: 'keep-1' })
    await rpc({ cmd: 'stop', sid: 'keep-2' })
  }, 120_000)
})
