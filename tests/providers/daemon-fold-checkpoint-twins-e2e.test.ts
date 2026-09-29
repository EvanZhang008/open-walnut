/**
 * Fold checkpoints, written and used by both daemon twins booted for real.
 *
 * The incident: a daemon restart folded every live session's whole stream file
 * before listening (a 1.76 GB stream took 99s, the boot 2.5 min). Now a session's
 * death and a graceful shutdown leave `<sid>.jsonl.fold`, and every rebuild (disk
 * getState here; adopt and resume share the same two functions) continues from
 * it. The proof that the checkpoint drives the answer: an early line is erased
 * in place after the checkpoint is written, and the answer still shows it, until
 * the checkpoint is removed or stops matching the file.
 *
 * MACHINE SAFETY: HOME, the daemon dir and the streams dir are temp paths, the
 * "CLI" is /bin/sh cat-ing a prepared file, and the daemon is SIGKILLed after
 * each test.
 */
import { describe, it, expect, beforeAll, afterEach } from 'vitest'
import { WebSocket } from 'ws'
import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { getDaemonSource } from '../../src/providers/daemon-source.js'

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
let proc: ChildProcess | null = null
let ws: WebSocket | null = null
let rpcId = 1

interface Dirs { home: string; streams: string; daemon: string }

function makeDirs(): Dirs {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-fold-ck-')))
  const home = path.join(root, 'home')
  fs.mkdirSync(home, { recursive: true })
  return { home, streams: path.join(root, 'streams'), daemon: path.join(root, 'daemon') }
}

async function boot(twin: Twin, dirs: Dirs): Promise<void> {
  const env: Record<string, string | undefined> = {
    ...process.env,
    SHELL: '/bin/sh',
    PATH: '/usr/bin:/bin',
    HOME: dirs.home,
    WALNUT_DAEMON_DIR: dirs.daemon,
    WALNUT_STREAMS_DIR: dirs.streams,
    WALNUT_LEGACY_STREAMS_DIR: path.join(root, 'no-legacy-streams'),
    WALNUT_SPAWN_JOURNAL: path.join(root, 'spawn-journal.jsonl'),
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

async function stop(signal: NodeJS.Signals): Promise<void> {
  try { ws?.close() } catch { /* already closed */ }
  ws = null
  if (proc && proc.exitCode === null && proc.signalCode === null) {
    const exited = new Promise<void>((resolve) => {
      const t = setTimeout(resolve, 10_000)
      proc!.once('exit', () => { clearTimeout(t); resolve() })
    })
    proc.kill(signal)
    await exited
  }
  proc = null
}

function rpc(cmd: Record<string, unknown>, timeoutMs = 30_000): Promise<Record<string, unknown>> {
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

async function waitFor(check: () => boolean, ms = 20_000): Promise<boolean> {
  const until = Date.now() + ms
  while (Date.now() < until) {
    if (check()) return true
    await new Promise((r) => setTimeout(r, 100))
  }
  return check()
}

const L = (o: unknown) => JSON.stringify(o) + '\n'
const EARLY_TASK = L({ type: 'system', subtype: 'task_started', task_id: 'early-task', description: 'early' })

/** ~9 MB of stream: an early background task, a confirmed CronCreate, deltas, a result. */
function streamContent(): string {
  const parts = [
    L({ type: 'system', subtype: 'init', session_id: 'real-id' }),
    L({ type: 'user', message: { role: 'user', content: 'go' } }),
    EARLY_TASK,
    L({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tu-cron', name: 'CronCreate', input: { cron: '7 9 * * *' } }] } }),
    L({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu-cron', content: 'ok' }] }, tool_use_result: { id: 'job-1' } }),
  ]
  const delta = L({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'x'.repeat(200) } } })
  for (let i = 0; i < 9 * 1024 * 1024 / delta.length; i++) parts.push(delta)
  parts.push(L({ type: 'result', subtype: 'success', is_error: false, num_turns: 1 }))
  return parts.join('')
}

/** Replace `needle` in the file with same-length filler, in place. */
function eraseInPlace(file: string, needle: string): void {
  const text = fs.readFileSync(file, 'utf8')
  const index = text.indexOf(needle)
  expect(index).toBeGreaterThanOrEqual(0)
  const at = Buffer.byteLength(text.slice(0, index))
  const empty = JSON.stringify({ type: 'x', pad: '' }) + '\n'
  const line = JSON.stringify({ type: 'x', pad: ' '.repeat(Buffer.byteLength(needle) - empty.length) }) + '\n'
  expect(Buffer.byteLength(line)).toBe(Buffer.byteLength(needle))
  const fd = fs.openSync(file, 'r+')
  fs.writeSync(fd, line, at)
  fs.closeSync(fd)
}

beforeAll(() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-fold-ck-src-'))
  scriptPath = path.join(dir, 'daemon.cjs')
  fs.writeFileSync(scriptPath, getDaemonSource(), { mode: 0o755 })
})

afterEach(async () => {
  await stop('SIGKILL')
  if (root) fs.rmSync(root, { recursive: true, force: true })
  root = ''
})

describe.each(TWINS)('fold checkpoints: $name', (twin) => {
  it('a dead session leaves a checkpoint, and every later rebuild continues from it', async () => {
    const dirs = makeDirs()
    const source = path.join(root, 'stream-source.jsonl')
    fs.writeFileSync(source, streamContent())
    const size = fs.statSync(source).size
    await boot(twin, dirs)

    // The "CLI" writes the whole stream and exits: the death drain folds it all.
    const started = await rpc({
      cmd: 'start', sid: 'ck-1', cwd: root, message: '', mode: 'default',
      args: ['/bin/sh', '-c', `cat ${JSON.stringify(source)}`, 'sh'],
    })
    expect(started.ok).toBe(true)
    const jsonl = path.join(dirs.streams, 'ck-1.jsonl')
    const ckPath = jsonl + '.fold'
    expect(await waitFor(() => fs.existsSync(ckPath))).toBe(true)
    const ck = JSON.parse(fs.readFileSync(ckPath, 'utf8'))
    expect(ck.boundary).toBe(fs.statSync(jsonl).size)
    expect(ck.boundary).toBeGreaterThanOrEqual(size)
    expect(ck.fold.cronIds).toEqual({ 'job-1': 1 })
    expect(Object.keys(ck.task.tasks)).toEqual(['early-task'])
    expect((fs.statSync(ckPath).mode & 0o777).toString(8)).toBe('600')

    // Something else deletes the checkpoint (the server's startup stream cleanup
    // once did, right before a deploy's daemon upgrade): the shutdown rewrites it
    // although the fold did not move.
    fs.unlinkSync(ckPath)
    await stop('SIGTERM')
    expect(JSON.parse(fs.readFileSync(ckPath, 'utf8'))).toEqual(ck)

    // A fresh daemon with nothing in memory: getState rebuilds from disk.
    await boot(twin, dirs)
    const baseline = await rpc({ cmd: 'getState', sid: 'ck-1' })
    expect((baseline.taskState as { tasks: Record<string, unknown> }).tasks['early-task']).toBeDefined()

    // Erase the early task line in place. The checkpoint still matches the file
    // (its tail is untouched), so the rebuild continues from it and keeps the task.
    eraseInPlace(jsonl, EARLY_TASK)
    const resumed = await rpc({ cmd: 'getState', sid: 'ck-1' })
    expect((resumed.taskState as { tasks: Record<string, unknown> }).tasks['early-task']).toBeDefined()
    expect(resumed.snapshot).toEqual(baseline.snapshot)

    // Lines appended after the checkpoint fold on top of it.
    fs.appendFileSync(jsonl, L({ type: 'system', subtype: 'task_notification', task_id: 'late-task', status: 'completed' }))
    const appended = await rpc({ cmd: 'getState', sid: 'ck-1' })
    expect(Object.keys((appended.taskState as { tasks: Record<string, unknown> }).tasks).sort()).toEqual(['early-task', 'late-task'])

    // Without the checkpoint the fold starts at byte 0 and sees the erased line.
    fs.renameSync(ckPath, ckPath + '.saved')
    const full = await rpc({ cmd: 'getState', sid: 'ck-1' })
    expect(Object.keys((full.taskState as { tasks: Record<string, unknown> }).tasks)).toEqual(['late-task'])

    // A checkpoint whose tail no longer matches the file is ignored the same way.
    fs.renameSync(ckPath + '.saved', ckPath)
    const fd = fs.openSync(jsonl, 'r+')
    fs.writeSync(fd, ' ', ck.boundary - 3)
    fs.closeSync(fd)
    const mismatched = await rpc({ cmd: 'getState', sid: 'ck-1' })
    expect(Object.keys((mismatched.taskState as { tasks: Record<string, unknown> }).tasks)).toEqual(['late-task'])
  }, 120_000)

  it('a graceful shutdown checkpoints a live session, and a fresh spawn of the sid drops it', async () => {
    const dirs = makeDirs()
    const source = path.join(root, 'stream-source.jsonl')
    fs.writeFileSync(source, streamContent())
    const size = fs.statSync(source).size
    await boot(twin, dirs)
    const started = await rpc({
      cmd: 'start', sid: 'ck-2', cwd: root, message: '', mode: 'default',
      args: ['/bin/sh', '-c', `cat ${JSON.stringify(source)}; sleep 30`, 'sh'],
    })
    expect(started.ok).toBe(true)
    const jsonl = path.join(dirs.streams, 'ck-2.jsonl')
    // Let the tailer fold everything the "CLI" wrote.
    expect(await waitFor(() => fs.existsSync(jsonl) && fs.statSync(jsonl).size >= size)).toBe(true)
    await waitFor(() => false, 1500)
    expect(fs.existsSync(jsonl + '.fold')).toBe(false)

    await stop('SIGTERM')
    const ck = JSON.parse(fs.readFileSync(jsonl + '.fold', 'utf8'))
    expect(ck.boundary).toBe(fs.statSync(jsonl).size)
    expect(ck.fold.cronIds).toEqual({ 'job-1': 1 })

    // A fresh (non-resume) spawn recreates the stream file and drops the old checkpoint.
    await boot(twin, dirs)
    const again = await rpc({
      cmd: 'start', sid: 'ck-2', cwd: root, message: '', mode: 'default',
      args: ['/bin/sh', '-c', 'sleep 30', 'sh'],
    })
    expect(again.ok).toBe(true)
    expect(fs.existsSync(jsonl + '.fold')).toBe(false)
    await rpc({ cmd: 'stop', sid: 'ck-2' })
  }, 120_000)
})
