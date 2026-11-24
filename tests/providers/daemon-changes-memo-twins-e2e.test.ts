/**
 * A changes recompute continues from where the last one stopped even after the
 * session's output fell out of the daemon's output LRU, in the session daemon
 * (daemon-standalone.ts) booted for real.
 *
 * The incident (2026-09-29): the server's prewarm sweep warms ~20 sessions and
 * the daemon kept 12 outputs, with the parse memos inside each output entry. A
 * whale's entry was evicted between its warms, so every warm re-read the whole
 * 907 MB transcript (5 to 20 s) even with the incremental parse in place. The
 * memos now live in their own, larger LRU; the daemon logs how each compute read
 * the transcript, which is what this test reads back.
 *
 * MACHINE SAFETY: HOME, the daemon dir and the streams dir are temp paths; no
 * CLI is started; the daemon is SIGKILLed after each test.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { WebSocket } from 'ws'
import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { encodeProjectPathCore } from '../../src/providers/session-changes-core.js'
import { testBun } from '../helpers/bun-runtime.js'
import { onDaemonEarlyExit } from '../helpers/daemon-early-exit.js'

const BUN: string | undefined = testBun()
const STANDALONE = path.resolve(__dirname, '../../src/providers/daemon-standalone.ts')

let root = ''
let proc: ChildProcess | null = null
let ws: WebSocket | null = null
let rpcId = 1

afterEach(async () => {
  try { ws?.close() } catch { /* already closed */ }
  ws = null
  if (proc && proc.exitCode === null && proc.signalCode === null) {
    const exited = new Promise<void>((resolve) => { const t = setTimeout(resolve, 10_000); proc!.once('exit', () => { clearTimeout(t); resolve() }) })
    proc.kill('SIGKILL')
    await exited
  }
  proc = null
  if (root) fs.rmSync(root, { recursive: true, force: true })
})

async function boot(home: string, daemonDir: string): Promise<void> {
  const env: Record<string, string | undefined> = {
    ...process.env,
    SHELL: '/bin/sh',
    PATH: '/usr/bin:/bin',
    HOME: home,
    WALNUT_DAEMON_DIR: daemonDir,
    WALNUT_STREAMS_DIR: path.join(root, 'streams'),
    WALNUT_LEGACY_STREAMS_DIR: path.join(root, 'no-legacy-streams'),
    WALNUT_SPAWN_JOURNAL: path.join(root, 'spawn-journal.jsonl'),
    // Logs each command's cmd_recv line: logSettled() waits for one.
    WALNUT_DAEMON_DEBUG: '1',
  }
  proc = spawn(BUN!, [STANDALONE, '--start'], { env, stdio: ['ignore', 'pipe', 'pipe'] })
  const port = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('daemon spawn timeout')), 30_000)
    proc!.stdout?.on('data', (chunk) => {
      const m = chunk.toString().trim().match(/^\d+$/m)
      if (m) { clearTimeout(timer); resolve(parseInt(m[0], 10)) }
    })
    proc!.on('error', (err) => { clearTimeout(timer); reject(err) })
    onDaemonEarlyExit(proc!, { daemonDir: daemonDir }, (err) => { clearTimeout(timer); reject(err) })
  })
  ws = await new Promise<WebSocket>((resolve, reject) => {
    const s = new WebSocket(`ws://127.0.0.1:${port}`)
    s.on('open', () => resolve(s))
    s.on('error', reject)
  })
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

/** The daemon's log lines in its files (each line a JSON record). */
function logRecords(daemonDir: string): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = []
  for (const f of fs.readdirSync(daemonDir).filter((n) => /^daemon-.*\.log$/.test(n))) {
    for (const line of fs.readFileSync(path.join(daemonDir, f), 'utf8').split('\n')) {
      if (!line.trim()) continue
      try { out.push(JSON.parse(line) as Record<string, unknown>) } catch { /* a line still being written */ }
    }
  }
  return out
}

/**
 * Waits until every line the daemon logged so far is on disk. The log is written by an async
 * appender, in order (log-appender-core.ts, since 8ad44f196a), so a compute's line can land after
 * its answer, and a SIGKILL drops what is still queued. A `list` sent now is logged (cmd_recv)
 * after every line before it: once that line is in the file, so is everything before it.
 */
async function logSettled(daemonDir: string): Promise<void> {
  const marker = await rpc({ cmd: 'list' })
  await expect.poll(
    () => logRecords(daemonDir).some((r) => r.msg === 'cmd_recv' && r.cmd === 'list' && r.id === marker.id),
    { timeout: 15_000, message: 'the daemon log caught up with its answers' },
  ).toBe(true)
}

/** Every `changes.compute done` line the daemon logged for this sid, in order, once the log caught up. */
async function settledComputeLog(daemonDir: string, sid: string): Promise<Array<{ resumed: boolean; readBytes: number; files: number }>> {
  await logSettled(daemonDir)
  return computeLog(daemonDir, sid)
}

/** Every `changes.compute done` line the daemon logged for this sid, in order. */
function computeLog(daemonDir: string, sid: string): Array<{ resumed: boolean; readBytes: number; files: number }> {
  const out: Array<{ resumed: boolean; readBytes: number; files: number }> = []
  for (const f of fs.readdirSync(daemonDir).filter((n) => /^daemon-.*\.log$/.test(n))) {
    for (const line of fs.readFileSync(path.join(daemonDir, f), 'utf8').split('\n')) {
      if (!line.includes('changes.compute done')) continue
      const rec = JSON.parse(line) as { msg: string; sid: string; resumed: boolean; readBytes: number; files: number }
      if (rec.msg === 'changes.compute done' && rec.sid === sid) out.push(rec)
    }
  }
  return out.sort((a, b) => String((a as unknown as { ts: string }).ts).localeCompare(String((b as unknown as { ts: string }).ts)))
}

const L = (o: unknown) => JSON.stringify(o) + '\n'
const writeLine = (repo: string, rel: string, content: string) => L({
  type: 'assistant', cwd: repo,
  message: { content: [{ type: 'tool_use', name: 'Write', input: { file_path: path.join(repo, rel), content } }] },
})

describe.skipIf(!BUN)('changes parse memos outlive the output LRU, standalone daemon (bun)', () => {
  it("a whale's recompute after 14 other sessions reads only the appended bytes", async () => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-changes-memo-')))
    const home = path.join(root, 'home')
    const daemonDir = path.join(root, 'daemon')
    const repo = path.join(root, 'repo')
    fs.mkdirSync(repo, { recursive: true })
    const projectDir = path.join(home, '.claude', 'projects', encodeProjectPathCore(repo))
    fs.mkdirSync(projectDir, { recursive: true })
    const transcript = (sid: string) => path.join(projectDir, `${sid}.jsonl`)

    const whale = 'whale-sid'
    const chat = L({ type: 'assistant', cwd: repo, message: { content: [{ type: 'text', text: 'x'.repeat(1500) }] } })
    fs.writeFileSync(transcript(whale), L({ type: 'user', cwd: repo, message: { role: 'user', content: 'go' } })
      + writeLine(repo, 'a.ts', 'a1\n') + chat.repeat(2000))
    fs.writeFileSync(path.join(repo, 'a.ts'), 'a1\n')
    const others = Array.from({ length: 14 }, (_, i) => `other-${i}`)
    for (const sid of others) fs.writeFileSync(transcript(sid), writeLine(repo, `${sid}.ts`, 'o\n'))

    await boot(home, daemonDir)
    const first = await rpc({ cmd: 'changes.compute', sid: whale, cwd: repo })
    expect(first.ok, JSON.stringify(first)).toBe(true)
    for (const sid of others) expect((await rpc({ cmd: 'changes.compute', sid, cwd: repo })).ok).toBe(true)

    const appended = writeLine(repo, 'b.ts', 'b1\n')
    fs.appendFileSync(transcript(whale), appended)
    fs.writeFileSync(path.join(repo, 'b.ts'), 'b1\n')
    const second = await rpc({ cmd: 'changes.compute', sid: whale, cwd: repo })
    const files = ((second.result as { groups: Array<{ files: Array<{ relPath: string }> }> }).groups)
      .flatMap((g) => g.files.map((f) => f.relPath)).sort()
    expect(files).toEqual(['a.ts', 'b.ts'])

    const log = await settledComputeLog(daemonDir, whale)
    expect(log).toHaveLength(2)
    expect(log[0]).toMatchObject({ resumed: false, readBytes: fs.statSync(transcript(whale)).size - Buffer.byteLength(appended) })
    expect(log[1]).toMatchObject({ resumed: true, readBytes: Buffer.byteLength(appended), files: 2 })
  }, 90_000)

  it('a restart reads only appended bytes from a dense transcript', async () => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-changes-restart-')))
    const home = path.join(root, 'home')
    const daemonDir = path.join(root, 'daemon')
    const repo = path.join(root, 'repo')
    fs.mkdirSync(repo, { recursive: true })
    const projectDir = path.join(home, '.claude', 'projects', encodeProjectPathCore(repo))
    fs.mkdirSync(projectDir, { recursive: true })
    const sid = 'restart-whale'
    const transcript = path.join(projectDir, `${sid}.jsonl`)
    const chat = L({ type: 'assistant', cwd: repo, message: { content: [{ type: 'text', text: 'x'.repeat(1500) }] } })
    fs.writeFileSync(transcript, writeLine(repo, 'a.ts', 'first\n') + chat.repeat(20000))
    fs.writeFileSync(path.join(repo, 'a.ts'), 'first\n')
    await boot(home, daemonDir)
    const start = Date.now()
    expect((await rpc({ cmd: 'changes.compute', sid, cwd: repo })).ok).toBe(true)
    const coldMs = Date.now() - start
    // The SIGKILL below drops log lines still queued: the first compute's line is on disk first.
    await logSettled(daemonDir)
    ws!.close(); ws = null
    const child = proc!
    const exited = new Promise<void>(resolve => child.once('exit', () => resolve()))
    child.kill('SIGKILL')
    await exited
    proc = null
    const append = writeLine(repo, 'b.ts', 'second\n')
    fs.appendFileSync(transcript, append)
    fs.writeFileSync(path.join(repo, 'b.ts'), 'second\n')
    await boot(home, daemonDir)
    const secondStart = Date.now()
    const result = await rpc({ cmd: 'changes.compute', sid, cwd: repo })
    expect(result.ok).toBe(true)
    const records = await settledComputeLog(daemonDir, sid)
    console.log(`[changes-restart-cost] ${JSON.stringify({ coldMs, restartMs: Date.now() - secondStart, appendBytes: Buffer.byteLength(append), records })}`)
    expect((result.result as { fileCount: number }).fileCount).toBe(2)
    expect(records).toHaveLength(2)
    expect(records[1]).toMatchObject({ resumed: true, readBytes: Buffer.byteLength(append), files: 2 })
  }, 90_000)

  // The same sweep, seen from a session that did not change: its full output
  // was evicted too, and every sweep rebuilt its before/after (1 to 18 s per
  // session in production) only to send the same light list again.
  it('an unchanged session outside the output LRU answers from its light copy', async () => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-changes-light-')))
    const home = path.join(root, 'home')
    const daemonDir = path.join(root, 'daemon')
    const repo = path.join(root, 'repo')
    fs.mkdirSync(repo, { recursive: true })
    const projectDir = path.join(home, '.claude', 'projects', encodeProjectPathCore(repo))
    fs.mkdirSync(projectDir, { recursive: true })
    const sids = Array.from({ length: 15 }, (_, i) => `s-${i}`)
    for (const sid of sids) {
      fs.writeFileSync(path.join(projectDir, `${sid}.jsonl`), writeLine(repo, `${sid}.ts`, 'new\n'))
      fs.writeFileSync(path.join(repo, `${sid}.ts`), 'new\n')
    }

    await boot(home, daemonDir)
    const firsts = new Map<string, Record<string, unknown>>()
    for (const sid of sids) firsts.set(sid, await rpc({ cmd: 'changes.compute', sid, cwd: repo }))
    // s-0 is the least recent of 15 outputs in a 12-entry LRU: evicted.
    const again = await rpc({ cmd: 'changes.compute', sid: 's-0', cwd: repo })
    expect(again).toEqual({ ...firsts.get('s-0'), id: again.id })
    expect(await settledComputeLog(daemonDir, 's-0')).toHaveLength(1)

    // A file click still needs the full content, so it computes once more.
    const file = await rpc({ cmd: 'changes.file', sid: 's-0', cwd: repo, path: path.join(repo, 's-0.ts') })
    expect(file).toMatchObject({ found: true, file: { relPath: 's-0.ts', after: 'new\n' } })
    expect(await settledComputeLog(daemonDir, 's-0')).toHaveLength(2)

    // A transcript that moved is never answered from the old copy.
    fs.appendFileSync(path.join(projectDir, 's-0.jsonl'), writeLine(repo, 's-0b.ts', 'b\n'))
    fs.writeFileSync(path.join(repo, 's-0b.ts'), 'b\n')
    const moved = await rpc({ cmd: 'changes.compute', sid: 's-0', cwd: repo })
    expect((moved.result as { fileCount: number }).fileCount).toBe(2)
    // And refresh always recomputes.
    await rpc({ cmd: 'changes.compute', sid: 's-1', cwd: repo, refresh: true })
    expect(await settledComputeLog(daemonDir, 's-1')).toHaveLength(2)
  }, 90_000)

  // A stopped session's transcript cannot grow until a resume, so once it has
  // been stopped and unused for a while its heavy parse state (every edit's
  // text) goes: 20 recent sessions held 150 MB of it, about half the daemon's
  // heap (2026-10-26). Not at exit: a file click right after must stay cheap.
  it('a stopped, unused session keeps only its light answer', async () => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-changes-ended-')))
    const home = path.join(root, 'home')
    const daemonDir = path.join(root, 'daemon')
    const repo = path.join(root, 'repo')
    fs.mkdirSync(repo, { recursive: true })
    const projectDir = path.join(home, '.claude', 'projects', encodeProjectPathCore(repo))
    fs.mkdirSync(projectDir, { recursive: true })
    const sid = 'ended-sid'
    const transcript = path.join(projectDir, `${sid}.jsonl`)
    fs.writeFileSync(transcript, writeLine(repo, 'a.ts', 'a1\n'))
    fs.writeFileSync(path.join(repo, 'a.ts'), 'a1\n')

    // A 3 s window (swept every 1.5 s) and a CLI that runs 4 s: by its exit the
    // first compute is already older than the window.
    process.env.WALNUT_CHANGES_RELEASE_AFTER_MS = '3000'
    try { await boot(home, daemonDir) } finally { delete process.env.WALNUT_CHANGES_RELEASE_AFTER_MS }
    const started = await rpc({ cmd: 'start', sid, cwd: repo, message: '', mode: 'default', args: ['/bin/sh', '-c', 'sleep 4', 'sh'] })
    expect(started.ok, JSON.stringify(started)).toBe(true)
    const first = await rpc({ cmd: 'changes.compute', sid, cwd: repo })
    expect(first.ok, JSON.stringify(first)).toBe(true)
    const until = Date.now() + 30_000
    while ((await rpc({ cmd: 'status', sid })).alive !== false && Date.now() < until) await new Promise((r) => setTimeout(r, 200))
    expect((await rpc({ cmd: 'status', sid })).alive).toBe(false)

    // After the exit, past one sweep: the window counts from the exit, not from
    // the last use, so the list and a file click still answer without a compute.
    await new Promise((r) => setTimeout(r, 1600))
    expect((await rpc({ cmd: 'changes.compute', sid, cwd: repo })).result).toEqual(first.result)
    expect(await rpc({ cmd: 'changes.file', sid, cwd: repo, path: path.join(repo, 'a.ts') })).toMatchObject({ found: true })
    expect(await settledComputeLog(daemonDir, sid)).toHaveLength(1)

    // Unused past the window plus a sweep (the checks above were a use): the
    // list still answers from the light copy...
    await new Promise((r) => setTimeout(r, 5000))
    expect((await rpc({ cmd: 'changes.compute', sid, cwd: repo })).result).toEqual(first.result)
    expect(await settledComputeLog(daemonDir, sid)).toHaveLength(1)
    // ...and after a resume appends, the disk checkpoint restores the released parse.
    const appended = writeLine(repo, 'b.ts', 'b1\n')
    fs.appendFileSync(transcript, appended)
    fs.writeFileSync(path.join(repo, 'b.ts'), 'b1\n')
    const moved = await rpc({ cmd: 'changes.compute', sid, cwd: repo })
    expect((moved.result as { fileCount: number }).fileCount).toBe(2)
    const log = await settledComputeLog(daemonDir, sid)
    expect(log).toHaveLength(2)
    expect(log[1]).toMatchObject({ resumed: true, readBytes: Buffer.byteLength(appended) })
  }, 90_000)
})
