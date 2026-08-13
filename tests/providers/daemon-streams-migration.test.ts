/**
 * Streams-under-HOME lifecycle — migration + retention + fresh-spawn epoch
 * (incident 019a7fe5: /tmp wiped on reboot → recreated stream file → stale
 * watermark vetoed every snapshot; streams moved to ~/.open-walnut/tmp/streams).
 *
 * Runs the REAL daemon (getDaemonSource() template via node — the artifact
 * deployed to remote hosts) in fully isolated temp dirs and exercises:
 *   1. migrateLegacyStreams at startup: dead-session families move, live-pgid
 *      families stay whole, existing dst never overwritten, dead FIFOs dropped.
 *   2. sweepDeadStreams: old dead families reaped, live/registered kept.
 *   3. fresh spawn recreates the jsonl with a NEW inode (unlink, not truncate)
 *      → streamEpoch changes across same-sid relaunches; getState carries it.
 *
 * MACHINE SAFETY: isolated WALNUT_DAEMON_DIR/STREAMS_DIR/LEGACY dirs + the
 * TEST-ONLY WALNUT_FORCE_STREAMS_MIGRATION/WALNUT_LEGACY_STREAMS_DIR overrides;
 * never /tmp/open-walnut, never the real /tmp/open-walnut-streams. Sleep
 * processes stand in for the CLI; everything is killed in afterEach/afterAll.
 */
import { describe, it, expect, afterEach } from 'vitest'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { spawn, type ChildProcess } from 'node:child_process'
import { WebSocket } from 'ws'
import { getDaemonSource } from '../../src/providers/daemon-source.js'

const PROD_DAEMON_DIR = '/tmp/open-walnut'
const PROD_LEGACY_DIR = '/tmp/open-walnut-streams'

let rpcId = 1
const cleanups: Array<() => Promise<void> | void> = []

afterEach(async () => {
  while (cleanups.length > 0) {
    const fn = cleanups.pop()!
    try { await fn() } catch {}
  }
})

interface DaemonHandle {
  proc: ChildProcess
  port: number
  daemonDir: string
  streamsDir: string
  legacyDir: string
}

async function spawnDaemon(opts: {
  daemonDir?: string
  streamsDir?: string
  legacyDir?: string
  extraEnv?: Record<string, string>
} = {}): Promise<DaemonHandle> {
  const daemonDir = opts.daemonDir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-strmig-d-'))
  const streamsDir = opts.streamsDir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-strmig-s-'))
  const legacyDir = opts.legacyDir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-strmig-l-'))
  if (path.resolve(daemonDir) === path.resolve(PROD_DAEMON_DIR)) throw new Error('refusing prod daemon dir')
  if (path.resolve(legacyDir) === path.resolve(PROD_LEGACY_DIR)) throw new Error('refusing prod legacy dir')

  const scriptPath = path.join(daemonDir, 'daemon.cjs')
  fs.writeFileSync(scriptPath, getDaemonSource(), { mode: 0o755 })

  const proc = spawn('node', [scriptPath, '--start'], {
    env: {
      ...process.env,
      WALNUT_DAEMON_DIR: daemonDir,
      WALNUT_STREAMS_DIR: streamsDir,
      WALNUT_LEGACY_STREAMS_DIR: legacyDir,
      WALNUT_FORCE_STREAMS_MIGRATION: '1',
      ...opts.extraEnv,
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

  const handle: DaemonHandle = { proc, port, daemonDir, streamsDir, legacyDir }
  cleanups.push(async () => {
    try { proc.kill('SIGTERM') } catch {}
    await new Promise((r) => setTimeout(r, 300))
    try { proc.kill('SIGKILL') } catch {}
    for (const d of [daemonDir, streamsDir, legacyDir]) {
      await fsp.rm(d, { recursive: true, force: true })
    }
  })
  return handle
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

/** Write a dead-session file family into a dir. */
function writeFamily(dir: string, sid: string, opts: { pgid?: number; mtimeMs?: number } = {}): void {
  fs.writeFileSync(path.join(dir, `${sid}.jsonl`), `{"type":"system","subtype":"init","session_id":"${sid}"}\n`)
  fs.writeFileSync(path.join(dir, `${sid}.jsonl.err`), '')
  fs.writeFileSync(path.join(dir, `${sid}.pgid`), String(opts.pgid ?? 999_999_9))
  if (opts.mtimeMs) {
    const t = new Date(opts.mtimeMs)
    for (const ext of ['.jsonl', '.jsonl.err', '.pgid']) {
      fs.utimesSync(path.join(dir, sid + ext), t, t)
    }
  }
}

describe('migrateLegacyStreams (real daemon startup)', () => {
  it('moves dead families, drops FIFOs, keeps live-pgid families in place, never overwrites', async () => {
    const legacyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-strmig-l-'))
    const streamsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-strmig-s-'))

    // (a) dead family — should migrate whole.
    writeFamily(legacyDir, 'dead-sid')
    // (b) live family — a real live process group holds it in place.
    const liveProc = spawn('/bin/sleep', ['120'], { detached: true, stdio: 'ignore' })
    cleanups.push(() => { try { process.kill(-liveProc.pid!, 'SIGKILL') } catch { try { liveProc.kill('SIGKILL') } catch {} } })
    writeFamily(legacyDir, 'live-sid', { pgid: liveProc.pid! })
    // (c) collision — same name exists at dst already; dst content must win.
    writeFamily(legacyDir, 'coll-sid')
    fs.writeFileSync(path.join(streamsDir, 'coll-sid.jsonl'), 'NEWER-CONTENT\n')
    // (d) dead FIFO — dropped, not migrated.
    const { execSync } = await import('node:child_process')
    execSync(`mkfifo ${JSON.stringify(path.join(legacyDir, 'fifo-sid.pipe'))}`)

    await spawnDaemon({ legacyDir, streamsDir })
    // Migration runs synchronously before the port prints — no wait needed.

    // (a) migrated: family at dst, gone from src. (The .pgid is NOT asserted at
    // dst: startup cleanup legitimately unlinks stale pgids of dead processes
    // right after migration — but it must be gone from the legacy dir.)
    expect(fs.existsSync(path.join(streamsDir, 'dead-sid.jsonl'))).toBe(true)
    expect(fs.existsSync(path.join(streamsDir, 'dead-sid.jsonl.err'))).toBe(true)
    expect(fs.existsSync(path.join(legacyDir, 'dead-sid.jsonl'))).toBe(false)
    expect(fs.existsSync(path.join(legacyDir, 'dead-sid.pgid'))).toBe(false)
    // ZERO data loss: content identical after the move.
    expect(fs.readFileSync(path.join(streamsDir, 'dead-sid.jsonl'), 'utf-8')).toContain('dead-sid')

    // (b) live family untouched at the legacy path.
    expect(fs.existsSync(path.join(legacyDir, 'live-sid.jsonl'))).toBe(true)
    expect(fs.existsSync(path.join(streamsDir, 'live-sid.jsonl'))).toBe(false)

    // (c) collision: dst content preserved, src left in place (loss-averse).
    expect(fs.readFileSync(path.join(streamsDir, 'coll-sid.jsonl'), 'utf-8')).toBe('NEWER-CONTENT\n')
    expect(fs.existsSync(path.join(legacyDir, 'coll-sid.jsonl'))).toBe(true)

    // (d) FIFO dropped.
    expect(fs.existsSync(path.join(legacyDir, 'fifo-sid.pipe'))).toBe(false)
    expect(fs.existsSync(path.join(streamsDir, 'fifo-sid.pipe'))).toBe(false)
  }, 60_000)

  it('is idempotent — a second daemon over the same dirs changes nothing', async () => {
    const legacyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-strmig-l-'))
    const streamsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-strmig-s-'))
    writeFamily(legacyDir, 'idem-sid')

    await spawnDaemon({ legacyDir, streamsDir })
    const contentAfterFirst = fs.readFileSync(path.join(streamsDir, 'idem-sid.jsonl'), 'utf-8')

    await spawnDaemon({ legacyDir, streamsDir })
    expect(fs.readFileSync(path.join(streamsDir, 'idem-sid.jsonl'), 'utf-8')).toBe(contentAfterFirst)
    expect(fs.readdirSync(legacyDir).filter((f) => f.startsWith('idem-sid'))).toEqual([])
  }, 90_000)
})

describe('sweepDeadStreams (real daemon, fast test clock)', () => {
  it('reaps only old dead families; fresh and live-pgid families survive', async () => {
    const streamsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-strmig-s-'))
    const old = Date.now() - 60 * 60 * 1000 // 1h old vs the 10min test retention → eligible
    writeFamily(streamsDir, 'reap-me', { mtimeMs: old })
    writeFamily(streamsDir, 'fresh-sid') // now-mtime → inside the window
    const liveProc = spawn('/bin/sleep', ['120'], { detached: true, stdio: 'ignore' })
    cleanups.push(() => { try { process.kill(-liveProc.pid!, 'SIGKILL') } catch { try { liveProc.kill('SIGKILL') } catch {} } })
    writeFamily(streamsDir, 'live-old', { pgid: liveProc.pid!, mtimeMs: old })

    await spawnDaemon({
      streamsDir,
      extraEnv: {
        // Retention must be far LARGER than the test's own runtime: with a 1s
        // retention the "fresh" file also crossed the threshold while the poll
        // loop waited, and the next sweep pass reaped it (a test-clock bug,
        // not a sweep bug). 10min retention vs 1h-old files keeps the classes
        // cleanly separated for the whole test.
        WALNUT_STREAM_RETENTION_MS: String(10 * 60 * 1000),
        WALNUT_STREAM_SWEEP_MS: '500',
      },
    })
    // The 60s first-pass setTimeout is irrelevant here: the 500ms interval
    // starts at listen time, so a sweep pass lands within ~1s.
    const deadline = Date.now() + 10_000
    while (Date.now() < deadline && fs.existsSync(path.join(streamsDir, 'reap-me.jsonl'))) {
      await new Promise((r) => setTimeout(r, 200))
    }

    expect(fs.existsSync(path.join(streamsDir, 'reap-me.jsonl'))).toBe(false)
    expect(fs.existsSync(path.join(streamsDir, 'reap-me.pgid'))).toBe(false)
    expect(fs.existsSync(path.join(streamsDir, 'fresh-sid.jsonl'))).toBe(true)
    expect(fs.existsSync(path.join(streamsDir, 'live-old.jsonl'))).toBe(true)
  }, 60_000)
})

describe('fresh-spawn streamEpoch (real daemon)', () => {
  it('same-sid relaunch gets a NEW inode and a DIFFERENT snapshot streamEpoch', async () => {
    const d = await spawnDaemon()
    const ws = await connectWs(d.port)
    cleanups.push(() => ws.close())
    const sid = 'epoch-relaunch'

    const start1 = await rpc(ws, { cmd: 'start', sid, args: ['/bin/sleep', '60'], cwd: os.tmpdir(), message: 'hi' })
    expect(start1.ok).toBe(true)
    const ino1 = fs.statSync(path.join(d.streamsDir, sid + '.jsonl')).ino
    const state1 = await rpc(ws, { cmd: 'getState', sid })
    const epoch1 = (state1.snapshot as { streamEpoch?: string | null } | undefined)?.streamEpoch
    expect(typeof epoch1).toBe('string')
    expect(epoch1).toContain(`:${ino1}:`)

    // Kill the CLI stand-in and relaunch the same sid fresh (no resume).
    await rpc(ws, { cmd: 'stop', sid }, 15_000)
    await new Promise((r) => setTimeout(r, 500))
    const start2 = await rpc(ws, { cmd: 'start', sid, args: ['/bin/sleep', '60'], cwd: os.tmpdir(), message: 'hi again' })
    expect(start2.ok).toBe(true)

    const ino2 = fs.statSync(path.join(d.streamsDir, sid + '.jsonl')).ino
    expect(ino2, 'fresh spawn must recreate the file (new inode), not truncate in place').not.toBe(ino1)
    const state2 = await rpc(ws, { cmd: 'getState', sid })
    const epoch2 = (state2.snapshot as { streamEpoch?: string | null } | undefined)?.streamEpoch
    expect(typeof epoch2).toBe('string')
    expect(epoch2, 'streamEpoch must change when the file is recreated').not.toBe(epoch1)
  }, 60_000)
})
