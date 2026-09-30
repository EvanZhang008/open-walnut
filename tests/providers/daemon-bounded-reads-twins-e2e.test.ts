/**
 * Bounded reads, on both daemon twins booted for real.
 *
 * Found on a live daemon (2026-09-29): a 1.79 GB stream and several over 100 MB,
 * cold sids pulled every 5 minutes for a day, and four commands that read as
 * much as they were asked for on the daemon's one thread:
 *   - the attach catch-up replay read the whole gap (an offset of 0 against a
 *     whale is gigabytes); it now replays the newest 8 MB after a
 *     replay_truncated line;
 *   - a cold getState folded the whole stream twice, synchronously, on every
 *     pull; it is now one pass, in 8 ms slices, over at most the newest 32 MB,
 *     remembered until the file changes;
 *   - read-history without tailBytes read the whole file and every subagent
 *     file; it now serves at most 32 MB and says `truncated`;
 *   - fs.read had no size cap; it now answers EFBIG over 32 MB.
 *
 * MACHINE SAFETY: HOME, the daemon dir and the streams dir are temp paths, the
 * "CLI" is /bin/sh cat-ing a prepared file, big files are sparse, and the
 * daemon is SIGKILLed after each test.
 */
import { describe, it, expect, beforeAll, afterEach } from 'vitest'
import { WebSocket } from 'ws'
import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { getDaemonSource } from '../../src/providers/daemon-source.js'

const MB = 1024 * 1024
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
let port = 0
const sockets: WebSocket[] = []
let rpcId = 1

interface Dirs { home: string; streams: string; daemon: string }

function makeDirs(): Dirs {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-bounded-')))
  const home = path.join(root, 'home')
  fs.mkdirSync(home, { recursive: true })
  const streams = path.join(root, 'streams')
  fs.mkdirSync(streams, { recursive: true })
  return { home, streams, daemon: path.join(root, 'daemon') }
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
  port = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('daemon spawn timeout')), 30_000)
    proc!.stdout?.on('data', (chunk) => {
      const m = chunk.toString().trim().match(/^\d+$/m)
      if (m) { clearTimeout(timer); resolve(parseInt(m[0], 10)) }
    })
    proc!.on('error', (err) => { clearTimeout(timer); reject(err) })
    proc!.on('exit', (code) => { clearTimeout(timer); reject(new Error('daemon exited early: ' + code)) })
  })
}

/** A client socket that keeps every frame it receives, in order. */
async function connect(): Promise<{ ws: WebSocket; frames: Record<string, unknown>[] }> {
  const frames: Record<string, unknown>[] = []
  const ws = await new Promise<WebSocket>((resolve, reject) => {
    const s = new WebSocket(`ws://127.0.0.1:${port}`)
    s.on('open', () => resolve(s))
    s.on('error', reject)
  })
  ws.on('message', (data: Buffer) => {
    try { frames.push(JSON.parse(data.toString())) } catch { /* not JSON */ }
  })
  sockets.push(ws)
  return { ws, frames }
}

function rpc(ws: WebSocket, cmd: Record<string, unknown>, timeoutMs = 60_000): Promise<Record<string, unknown>> {
  const id = rpcId++
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('rpc timeout: ' + String(cmd.cmd))), timeoutMs)
    const onMessage = (data: Buffer) => {
      let msg: Record<string, unknown>
      try { msg = JSON.parse(data.toString()) } catch { return }
      if (msg.id === id) { clearTimeout(timer); ws.off('message', onMessage); resolve(msg) }
    }
    ws.on('message', onMessage)
    ws.send(JSON.stringify({ id, ...cmd }))
  })
}

async function stop(): Promise<void> {
  for (const s of sockets.splice(0)) { try { s.close() } catch { /* already closed */ } }
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

async function waitFor(check: () => boolean | Promise<boolean>, ms = 30_000): Promise<boolean> {
  const until = Date.now() + ms
  while (Date.now() < until) {
    if (await check()) return true
    await new Promise((r) => setTimeout(r, 100))
  }
  return check()
}

/** Every structured line the daemon logged with this message. */
function daemonLog(dirs: Dirs, msg: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = []
  for (const name of fs.readdirSync(dirs.daemon)) {
    if (!/^daemon-.*\.log$/.test(name) || name.startsWith('daemon-exit-')) continue
    for (const line of fs.readFileSync(path.join(dirs.daemon, name), 'utf8').split('\n')) {
      if (!line.includes(msg)) continue
      try {
        const entry = JSON.parse(line) as Record<string, unknown>
        if (entry.msg === msg) out.push(entry)
      } catch { /* torn line */ }
    }
  }
  return out
}

/** Task state without the serve-time stamps (`t`, `updatedAt`). */
function withoutStamps(taskState: unknown): unknown {
  return JSON.parse(JSON.stringify(taskState, (key, value) => (key === 't' || key === 'updatedAt' ? undefined : value)))
}

const L = (o: unknown) => JSON.stringify(o) + '\n'
const delta = (i: number) => L({ type: 'stream_event', n: i, event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'x'.repeat(200) } } })

/** `bytes` of distinct delta lines, between a head and a tail. */
function streamOf(bytes: number, head: string[] = [], tail: string[] = []): string {
  const parts = [...head]
  let size = 0
  for (let i = 0; size < bytes; i++) {
    const line = delta(i)
    parts.push(line)
    size += line.length
  }
  return parts.concat(tail).join('')
}

/** A sparse file of `zeros` NUL bytes followed by real lines (no disk cost). */
function sparseWithLines(file: string, zeros: number, lines: string[]): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, '')
  fs.truncateSync(file, zeros)
  fs.appendFileSync(file, lines.join(''))
}

beforeAll(() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-bounded-src-'))
  scriptPath = path.join(dir, 'daemon.cjs')
  fs.writeFileSync(scriptPath, getDaemonSource(), { mode: 0o755 })
})

afterEach(async () => {
  await stop()
  if (root) fs.rmSync(root, { recursive: true, force: true })
  root = ''
})

describe.each(TWINS)('bounded reads: $name', (twin) => {
  it('a catch-up replay over 8 MB sends replay_truncated, then only the newest lines', async () => {
    const dirs = makeDirs()
    const source = path.join(root, 'stream-source.jsonl')
    fs.writeFileSync(source, streamOf(10 * MB))
    const size = fs.statSync(source).size
    await boot(twin, dirs)
    const starter = await connect()
    const started = await rpc(starter.ws, {
      cmd: 'start', sid: 'br-replay', cwd: root, message: '', mode: 'default',
      args: ['/bin/sh', '-c', `cat ${JSON.stringify(source)}; sleep 45`, 'sh'],
    })
    expect(started.ok).toBe(true)
    const jsonl = path.join(dirs.streams, 'br-replay.jsonl')

    // Wait until the session watcher has consumed the whole file.
    const probe = await connect()
    let currentOffset = 0
    expect(await waitFor(async () => {
      const r = await rpc(probe.ws, { cmd: 'attach', sid: 'br-replay', fromOffset: Number.MAX_SAFE_INTEGER })
      currentOffset = r.currentOffset as number
      return currentOffset >= size
    })).toBe(true)
    const file = fs.readFileSync(jsonl)
    expect(currentOffset).toBe(file.length)

    // A client with no cursor (offset 0) asks for the whole 10 MB.
    const late = await connect()
    const reply = await rpc(late.ws, { cmd: 'attach', sid: 'br-replay', fromOffset: 0 })
    expect(reply.ok).toBe(true)
    const events = late.frames.filter((f) => f.ev === 'jsonl' && f.sid === 'br-replay') as Array<{ line: string; v: number }>
    const marker = JSON.parse(events[0].line) as Record<string, unknown>
    expect(marker).toMatchObject({ type: 'system', subtype: 'replay_truncated', from_offset: 0, session_id: 'br-replay' })
    const resumeAt = events[0].v
    expect(marker.resume_offset).toBe(resumeAt)
    expect(marker.skipped_bytes).toBe(resumeAt)
    expect(String(marker.content)).toContain(String(resumeAt))
    // The window starts on a line and holds at most 8 MB.
    expect(file[resumeAt - 1]).toBe(10)
    expect(currentOffset - resumeAt).toBeLessThanOrEqual(8 * MB)
    expect(currentOffset - resumeAt).toBeGreaterThan(8 * MB - 400)
    // Then every line of the window, in order, with its real v, and nothing else.
    const lines = events.slice(1)
    const expected = file.subarray(resumeAt, currentOffset).toString('utf8').split('\n').filter(Boolean)
    expect(lines.map((e) => e.line)).toEqual(expected)
    expect(lines[0].v).toBe(resumeAt + Buffer.byteLength(expected[0]) + 1)
    expect(lines[lines.length - 1].v).toBe(currentOffset)
    expect(daemonLog(dirs, 'addSubscriber: catch-up capped')).toHaveLength(1)

    // A gap under the cap replays exactly, with no marker.
    const tailStart = currentOffset - Buffer.byteLength(expected.slice(-3).join('\n') + '\n')
    const near = await connect()
    await rpc(near.ws, { cmd: 'attach', sid: 'br-replay', fromOffset: tailStart })
    const nearEvents = near.frames.filter((f) => f.ev === 'jsonl' && f.sid === 'br-replay') as Array<{ line: string; v: number }>
    expect(nearEvents.map((e) => e.line)).toEqual(expected.slice(-3))
    expect(daemonLog(dirs, 'addSubscriber: catch-up capped')).toHaveLength(1)

    await rpc(starter.ws, { cmd: 'stop', sid: 'br-replay' })
  }, 120_000)

  it('a cold getState scans in slices, at most the newest 32 MB, once per file version', async () => {
    const dirs = makeDirs()
    const jsonl = path.join(dirs.streams, 'br-cold.jsonl')
    fs.writeFileSync(jsonl, streamOf(
      34 * MB,
      [
        L({ type: 'system', subtype: 'init', session_id: 'br-cold' }),
        L({ type: 'system', subtype: 'task_started', task_id: 'early-task', description: 'early' }),
      ],
      [
        L({ type: 'system', subtype: 'task_notification', task_id: 'late-task', status: 'completed' }),
        L({ type: 'result', subtype: 'success', is_error: false, num_turns: 1 }),
      ],
    ))
    await boot(twin, dirs)
    const client = await connect()

    // A ping sent right behind the getState is answered while the scan runs:
    // the scan hands the event loop back.
    const order: string[] = []
    const cold = rpc(client.ws, { cmd: 'getState', sid: 'br-cold' }).then((r) => { order.push('getState'); return r })
    const pong = rpc(client.ws, { cmd: 'ping' }).then((r) => { order.push('ping'); return r })
    const [first] = await Promise.all([cold, pong])
    expect(order).toEqual(['ping', 'getState'])

    expect(first).toMatchObject({ ok: true, exists: true, alive: false, state: 'dead' })
    const tasks = (first.taskState as { tasks: Record<string, { status: string }> }).tasks
    // The head task sits before the newest 32 MB, so the capped scan never sees it.
    expect(Object.keys(tasks)).toEqual(['late-task'])
    expect(tasks['late-task'].status).toBe('completed')
    const scans = daemonLog(dirs, 'getState: cold rebuild')
    expect(scans).toHaveLength(1)
    expect(scans[0]).toMatchObject({ level: 'warn', capped: true, size: fs.statSync(jsonl).size })

    // The same file again: answered from memory, no second scan.
    const second = await rpc(client.ws, { cmd: 'getState', sid: 'br-cold' })
    expect(second.snapshot).toEqual(first.snapshot)
    expect(Object.keys((second.taskState as { tasks: object }).tasks)).toEqual(['late-task'])
    expect(daemonLog(dirs, 'getState: cold rebuild')).toHaveLength(1)

    // An append is a new file version: scanned again, and the new line shows.
    fs.appendFileSync(jsonl, L({ type: 'system', subtype: 'task_notification', task_id: 'later-task', status: 'failed' }))
    const third = await rpc(client.ws, { cmd: 'getState', sid: 'br-cold' })
    expect(Object.keys((third.taskState as { tasks: object }).tasks).sort()).toEqual(['late-task', 'later-task'])
    expect(daemonLog(dirs, 'getState: cold rebuild')).toHaveLength(2)

    // A small stream is scanned whole, and still only once.
    const small = path.join(dirs.streams, 'br-small.jsonl')
    fs.writeFileSync(small, L({ type: 'system', subtype: 'task_started', task_id: 'only-task', description: 'x' }))
    const a = await rpc(client.ws, { cmd: 'getState', sid: 'br-small' })
    const b = await rpc(client.ws, { cmd: 'getState', sid: 'br-small' })
    expect(Object.keys((a.taskState as { tasks: object }).tasks)).toEqual(['only-task'])
    // A remembered answer is stamped with the time it is served, like a rebuild.
    expect(withoutStamps(b.taskState)).toEqual(withoutStamps(a.taskState))
    expect(b.snapshot).toEqual(a.snapshot)
    const smallScans = daemonLog(dirs, 'getState: cold rebuild').filter((e) => e.jsonlPath === small)
    expect(smallScans).toHaveLength(1)
    expect(smallScans[0]).toMatchObject({ level: 'info', capped: false, from: 0 })

    // No stream file: still a plain "does not exist".
    expect(await rpc(client.ws, { cmd: 'getState', sid: 'br-none' })).toMatchObject({ ok: true, exists: false })
  }, 120_000)

  it('read-history without tailBytes serves at most the newest 32 MB and flags it', async () => {
    const dirs = makeDirs()
    const lines = Array.from({ length: 50 }, (_, i) => L({ type: 'user', n: i, message: { content: 'line ' + i } }))
    // 40 MB of NUL then the lines: the window starts inside the NULs, so the
    // first line is the cut's partial line and is dropped with them.
    const big = path.join(dirs.streams, 'br-hist.jsonl')
    sparseWithLines(big, 40 * MB, lines)
    const small = path.join(dirs.streams, 'br-hist-small.jsonl')
    fs.writeFileSync(small, lines.join(''))
    // A small main file with a whale subagent file shares the same budget.
    const withSub = path.join(dirs.streams, 'br-hist-sub.jsonl')
    fs.writeFileSync(withSub, lines.slice(0, 2).join(''))
    sparseWithLines(path.join(dirs.streams, 'br-hist-sub', 'subagents', 'agent-a.jsonl'), 40 * MB, lines)
    await boot(twin, dirs)
    const client = await connect()

    const capped = await rpc(client.ws, { cmd: 'read-history', sid: 'br-hist' })
    expect(capped).toMatchObject({ ok: true, truncated: true, size: fs.statSync(big).size })
    expect(capped.main).toBe(lines.slice(1).join(''))
    expect(daemonLog(dirs, 'read-history: reply capped')).toHaveLength(1)

    const whole = await rpc(client.ws, { cmd: 'read-history', sid: 'br-hist-small' })
    expect(whole.main).toBe(lines.join(''))
    expect(whole.truncated).toBeUndefined()
    expect(whole.size).toBeUndefined()

    // An explicit tail within the cap is a request, not a truncation.
    const tail = await rpc(client.ws, { cmd: 'read-history', sid: 'br-hist', tailBytes: 1000 })
    expect(tail.truncated).toBeUndefined()
    expect(String(tail.main).length).toBeLessThanOrEqual(1000)

    const sub = await rpc(client.ws, { cmd: 'read-history', sid: 'br-hist-sub' })
    expect(sub.main).toBe(lines.slice(0, 2).join(''))
    const subText = (sub.subagents as Record<string, string>)['agent-a.jsonl']
    expect(subText).toBe(lines.slice(1).join(''))
    expect(sub).toMatchObject({ truncated: true, size: fs.statSync(withSub).size })
  }, 120_000)

  it('fs.read refuses a file over 32 MB with EFBIG, before reading it', async () => {
    const dirs = makeDirs()
    const big = path.join(root, 'big.bin')
    fs.writeFileSync(big, '')
    fs.truncateSync(big, 33 * MB)
    const small = path.join(root, 'small.txt')
    fs.writeFileSync(small, 'hello\n')
    await boot(twin, dirs)
    const client = await connect()

    const refused = await rpc(client.ws, { cmd: 'fs.read', path: big, encoding: 'base64' })
    expect(refused.ok).not.toBe(true)
    // The server's readers key on these: '(EFBIG)' (file-content bridge, engine
    // settings) and 'byte ceiling' (DaemonFileReader).
    expect(String(refused.error)).toContain('(EFBIG)')
    expect(String(refused.error)).toContain('byte ceiling')
    expect(String(refused.error)).toContain(String(33 * MB))

    const ok = await rpc(client.ws, { cmd: 'fs.read', path: small, encoding: 'utf-8' })
    expect(ok).toMatchObject({ ok: true, data: 'hello\n', encoding: 'utf-8' })
  }, 60_000)
})
