/**
 * Stream compaction (stream-compact-core.ts), run by both daemon twins booted
 * for real.
 *
 * Why: the CLI's stdout IS the stream file, and token deltas made up about half
 * of 12.5 GB of stream files on 2026-10-26 (one session 3.3 GB). Once a
 * session's CLI is gone, the daemon rewrites its file without the deltas of
 * finished turns. These tests pin what must hold around that swap: the file a
 * live CLI writes is never touched, the fold and checkpoint describe the new
 * file, a resume continues from it, and a resume that arrives during the copy
 * wins (the copy is dropped, the original stays).
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
let proc: ChildProcess | null = null
let ws: WebSocket | null = null
let rpcId = 1

interface Dirs { home: string; streams: string; daemon: string }

function makeDirs(): Dirs {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-compact-')))
  const home = path.join(root, 'home')
  fs.mkdirSync(home, { recursive: true })
  return { home, streams: path.join(root, 'streams'), daemon: path.join(root, 'daemon') }
}

async function boot(twin: Twin, dirs: Dirs, extra: Record<string, string>): Promise<void> {
  const env: Record<string, string | undefined> = {
    ...process.env,
    SHELL: '/bin/sh',
    PATH: guardedPath([], '/usr/bin:/bin'),
    HOME: dirs.home,
    WALNUT_DAEMON_DIR: dirs.daemon,
    WALNUT_STREAMS_DIR: dirs.streams,
    WALNUT_LEGACY_STREAMS_DIR: path.join(root, 'no-legacy-streams'),
    WALNUT_SPAWN_JOURNAL: path.join(root, 'spawn-journal.jsonl'),
    WALNUT_STREAM_COMPACT_IDLE_MS: '1',
    WALNUT_STREAM_COMPACT_SWEEP_MS: '200',
    WALNUT_STREAM_COMPACT_MIN_BYTES: '4096',
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
const isDrop = (l: string) => l.startsWith('{"type":"stream_event",') || l.startsWith('{"type":"system","subtype":"thinking_tokens",')
const epochOf = (file: string) => { const st = fs.statSync(file); return `${st.dev}:${st.ino}:${Math.floor(st.birthtimeMs)}` }

/**
 * A finished turn with a background task, a confirmed cron, `deltaBytes` of
 * deltas, and a kept tool result of `keptBytes` (a fold checkpoint is written
 * only for files of 8 MB and up).
 */
function streamContent(deltaBytes: number, keptBytes = 0): string {
  const parts = [
    L({ type: 'system', subtype: 'init', session_id: 'real-id' }),
    L({ type: 'user', message: { role: 'user', content: 'go' } }),
    L({ type: 'system', subtype: 'task_started', task_id: 'early-task', description: 'early' }),
    L({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tu-cron', name: 'CronCreate', input: { cron: '7 9 * * *' } }] } }),
    L({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu-cron', content: 'ok' }] }, tool_use_result: { id: 'job-1' } }),
  ]
  const delta = L({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'x'.repeat(200) } } })
  const thinking = L({ type: 'system', subtype: 'thinking_tokens', tokens: 12 })
  for (let i = 0; i < deltaBytes / delta.length; i++) parts.push(delta, ...(i % 10 === 0 ? [thinking] : []))
  if (keptBytes) parts.push(L({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu-big', content: 'y'.repeat(keptBytes) }] } }))
  parts.push(L({ type: 'assistant', message: { content: [{ type: 'text', text: 'done' }] } }))
  parts.push(L({ duration_api_ms: 10, stop_reason: 'end_turn', type: 'result', subtype: 'success', is_error: false, num_turns: 1 }))
  // The CLI ends a turn with its idle state line (the fold's turn end).
  parts.push(L({ type: 'system', subtype: 'session_state_changed', state: 'idle' }))
  return parts.join('')
}

beforeAll(() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-compact-src-'))
  scriptPath = path.join(dir, 'daemon.cjs')
  fs.writeFileSync(scriptPath, getDaemonSource(), { mode: 0o755 })
})

afterEach(async () => {
  await stop()
  if (root) fs.rmSync(root, { recursive: true, force: true })
  root = ''
})

describe.each(TWINS)('stream compaction: $name', (twin) => {
  it('a live CLI\'s file is never touched; once it is gone the file loses its deltas, and a resume continues from the new file', async () => {
    const dirs = makeDirs()
    const source = path.join(root, 'stream-source.jsonl')
    const content = streamContent(512 * 1024, 9 * 1024 * 1024)
    fs.writeFileSync(source, content)
    // Idle 2 s: the test reads the dead file's mtime before the copy starts.
    await boot(twin, dirs, { WALNUT_STREAM_COMPACT_IDLE_MS: '2000' })
    const jsonl = path.join(dirs.streams, 'cmp-1.jsonl')

    // Live: the "CLI" wrote everything and sleeps. Several sweeps pass; nothing changes.
    const started = await rpc({
      cmd: 'start', sid: 'cmp-1', cwd: root, message: '', mode: 'default',
      args: ['/bin/sh', '-c', `cat ${JSON.stringify(source)}; sleep 3`, 'sh'],
    })
    expect(started.ok).toBe(true)
    expect(await waitFor(() => fs.existsSync(jsonl) && fs.statSync(jsonl).size >= content.length)).toBe(true)
    const liveIno = fs.statSync(jsonl).ino
    const liveEpoch = epochOf(jsonl)
    await new Promise((r) => setTimeout(r, 1500))
    expect(fs.statSync(jsonl).ino).toBe(liveIno)
    expect(fs.readFileSync(jsonl, 'utf8').startsWith(content)).toBe(true)
    expect(daemonLog(dirs)).not.toContain('stream compacted')

    // Gone: the next sweep compacts it.
    let dead = false
    for (let i = 0; i < 200 && !dead; i++) {
      dead = (await rpc({ cmd: 'getState', sid: 'cmp-1' })).alive === false
      if (!dead) await new Promise((r) => setTimeout(r, 50))
    }
    expect(dead).toBe(true)
    const liveMtime = fs.statSync(jsonl).mtimeMs
    expect(await waitFor(() => daemonLog(dirs).includes('"stream compacted"'), 30_000)).toBe(true)
    const after = fs.readFileSync(jsonl, 'utf8')
    const expected = content.split('\n').slice(0, -1).filter((l) => !isDrop(l)).map((l) => l + '\n').join('')
    // The daemon may append its own lines after the CLI's (exit markers): those stay.
    expect(after.startsWith(expected)).toBe(true)
    expect(after.split('\n').filter(isDrop)).toEqual([])
    expect(fs.statSync(jsonl).ino).not.toBe(liveIno)
    // Retention reads the mtime: the copy keeps the original's.
    expect(Math.floor(fs.statSync(jsonl).mtimeMs / 1000)).toBe(Math.floor(liveMtime / 1000))
    expect(fs.readdirSync(dirs.streams).filter((f) => f.includes('.compact-tmp'))).toEqual([])

    // The checkpoint describes the new file, cron and background task included.
    const ck = JSON.parse(fs.readFileSync(jsonl + '.fold', 'utf8'))
    expect(ck.epoch).toBe(epochOf(jsonl))
    expect(ck.boundary).toBe(Buffer.byteLength(after.slice(0, after.lastIndexOf('\n') + 1)))
    expect(ck.fold.cronIds).toEqual({ 'job-1': 1 })
    expect(Object.keys(ck.task.tasks)).toEqual(['early-task'])

    // The daemon's own answer is the new file's.
    const state = await rpc({ cmd: 'getState', sid: 'cmp-1' })
    const snap = state.snapshot as { streamEpoch: string; rewrittenFrom?: string; v: number; cronActive: boolean; turnActive: boolean }
    expect(snap.streamEpoch).toBe(epochOf(jsonl))
    // It names the file it replaced, so the server does not read a new turn into it.
    expect(snap.rewrittenFrom).toBe(liveEpoch)
    expect(snap.v).toBe(ck.boundary)
    expect(snap.cronActive).toBe(true)
    expect((state.taskState as { tasks: Record<string, unknown> }).tasks['early-task']).toBeDefined()

    // Not copied again while it has not grown.
    const compactedIno = fs.statSync(jsonl).ino
    await new Promise((r) => setTimeout(r, 1000))
    expect(fs.statSync(jsonl).ino).toBe(compactedIno)

    // A restarted daemon (nothing in memory) answers the same from disk.
    await stop()
    await boot(twin, dirs, { WALNUT_STREAM_COMPACT_SWEEP_MS: '600000' })
    const cold = await rpc({ cmd: 'getState', sid: 'cmp-1' })
    expect(cold.snapshot).toMatchObject({ streamEpoch: epochOf(jsonl), rewrittenFrom: liveEpoch, v: ck.boundary, cronActive: true })

    // A resume appends to the compacted file from its end.
    const more = L({ type: 'system', subtype: 'task_started', task_id: 'late-task', description: 'late' }) + L({ duration_api_ms: 10, stop_reason: 'end_turn', type: 'result', subtype: 'success', is_error: false, num_turns: 2 })
    const moreFile = path.join(root, 'more.jsonl')
    fs.writeFileSync(moreFile, more)
    const resumed = await rpc({
      cmd: 'start', sid: 'cmp-1', cwd: root, message: '', mode: 'default', resume: true,
      args: ['/bin/sh', '-c', `cat ${JSON.stringify(moreFile)}`, 'sh'],
    })
    expect(resumed.ok).toBe(true)
    expect(resumed.offset).toBe(ck.boundary)
    expect(await waitFor(() => fs.readFileSync(jsonl, 'utf8').includes('late-task'))).toBe(true)
    expect(fs.readFileSync(jsonl, 'utf8').startsWith(after.slice(0, ck.boundary))).toBe(true)
    expect(await waitFor(() => false, 1000)).toBe(false)
    const later = await rpc({ cmd: 'getState', sid: 'cmp-1' })
    expect(Object.keys((later.taskState as { tasks: Record<string, unknown> }).tasks).sort()).toEqual(['early-task', 'late-task'])
  }, 120_000)

  it('a resume that arrives while the copy runs wins: the copy is dropped and the original stays', async () => {
    const dirs = makeDirs()
    const source = path.join(root, 'stream-source.jsonl')
    const content = streamContent(6 * 1024 * 1024)
    fs.writeFileSync(source, content)
    // Small reads keep the copy running long enough to race it.
    await boot(twin, dirs, { WALNUT_STREAM_COMPACT_CHUNK: '2048', WALNUT_STREAM_COMPACT_SWEEP_MS: '100' })
    const jsonl = path.join(dirs.streams, 'cmp-2.jsonl')
    const started = await rpc({
      cmd: 'start', sid: 'cmp-2', cwd: root, message: '', mode: 'default',
      args: ['/bin/sh', '-c', `cat ${JSON.stringify(source)}`, 'sh'],
    })
    expect(started.ok).toBe(true)
    const tmpExists = () => fs.readdirSync(dirs.streams).some((f) => f.startsWith('cmp-2.jsonl.compact-tmp-'))
    expect(await waitFor(tmpExists, 30_000, 5)).toBe(true)
    const ino = fs.statSync(jsonl).ino

    const resumed = await rpc({
      cmd: 'start', sid: 'cmp-2', cwd: root, message: '', mode: 'default', resume: true,
      args: ['/bin/sh', '-c', 'sleep 4', 'sh'],
    })
    expect(resumed.ok).toBe(true)
    expect(await waitFor(() => !tmpExists(), 30_000)).toBe(true)
    // The daemon's log write may land a moment after the temp file goes.
    const compactLines = () => daemonLog(dirs).split('\n').filter((l) => l.includes('"msg":"stream compact')).join('\n')
    await waitFor(() => /stream compaction skipped/.test(compactLines()), 10_000)
    expect(compactLines()).toMatch(/stream compaction skipped[^\n]*"reason":"(aborted|changed)"/)
    expect(compactLines()).not.toContain('"stream compacted"')
    expect(fs.statSync(jsonl).ino).toBe(ino)
    expect(fs.readFileSync(jsonl, 'utf8').startsWith(content)).toBe(true)
    await rpc({ cmd: 'stop', sid: 'cmp-2' })
  }, 120_000)
})
