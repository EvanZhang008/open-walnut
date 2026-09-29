/**
 * orphan-stop-v1 with real processes: the ONE real-signal test for the rule
 * "the server never signals a CLI pid; orphans end through the owning daemon".
 *
 * The stub tests (tests/core/sessions/owner-stop.test.ts and
 * tests/providers/daemon-orphan-stop-twins.test.ts) pin every decision. This
 * file proves the signal SCOPE with the kernel in the loop: a source-twin
 * daemon ends a dummy CLI it spawned and journaled for the asking Walnut, and a
 * look-alike dummy it never spawned survives every request, the successful one
 * included.
 *
 * MACHINE SAFETY. Every signal this file can cause, listed:
 *  1. The daemon's own stop path (stopSessionProcess: SIGINT, SIGTERM at 5s)
 *     signals the process group of dummy A. The daemon spawned A itself,
 *     detached, so A's pid is its own group id; nothing else is in that group.
 *  2. afterAll sends SIGTERM to the test daemon through the ChildProcess handle
 *     this test holds (SIGKILL through the same handle if it has not exited
 *     after 15s). An isolated-dir daemon ends its own LIVE sessions on the way
 *     out, which is only dummy A, and only if a failed assertion left it running.
 *  3. afterAll sends SIGTERM to dummy B through the ChildProcess handle this
 *     test holds.
 * The test itself never signals a process group and never signals by a bare
 * pid: liveness is read with `ps -p` (read-only), and every pid passes
 * plainPid() (a safe integer above 1) before it is used at all.
 * HOME, the daemon dir, both streams dirs and the spawn journal are temp paths;
 * the daemon gets a minimal env (no inherited WALNUT_* variable) with PATH
 * /usr/bin:/bin. Each dummy prints three stream lines and then IS one
 * /bin/sleep process (exec), so it exits on its own after DUMMY_LIFETIME_S even
 * if every cleanup step fails. No server, no DaemonConnection, no real
 * ~/.open-walnut file, no port 3456.
 *
 * Gated behind WALNUT_REAL_SIGNAL_TEST=1, so no test tier runs it by default.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { WebSocket } from 'ws'
import { spawn, execFileSync, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { getDaemonSource } from '../../src/providers/daemon-source.js'
import { readSpawnJournal } from '../../src/providers/external-session-scan-core.js'

const ENABLED = process.env.WALNUT_REAL_SIGNAL_TEST === '1' && process.platform !== 'win32'
const SID_A = 'orphan-real-a-0000-4000-8000-000000000001'
const SID_B = 'orphan-real-b-0000-4000-8000-000000000002'
/** Upper bound on either dummy's life, whatever happens to the test. */
const DUMMY_LIFETIME_S = 120

let root = ''
let home = ''
let streams = ''
let journal = ''
let cliPath = ''
let daemon: ChildProcess | null = null
let dummyB: ChildProcess | null = null
let ws: WebSocket | null = null
let rpcId = 1

/** Refuse anything but a plain pid above 1: 0, 1 and negatives address groups or everything. */
function plainPid(pid: unknown): number {
  if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid <= 1) {
    throw new Error('refusing a pid that is not an integer above 1: ' + String(pid))
  }
  return pid
}

interface PsRow { ppid: number; pgid: number; stat: string; command: string }

/** The pid's `ps` row, or null when it is gone (a zombie counts as gone). Read-only. */
function psRow(pid: number): PsRow | null {
  plainPid(pid)
  let out = ''
  try {
    out = execFileSync('/bin/ps', ['-o', 'ppid=', '-o', 'pgid=', '-o', 'stat=', '-o', 'command=', '-p', String(pid)], { encoding: 'utf8' })
  } catch (err) {
    // ps exits 1 for "no such process"; anything else is a broken probe, never "dead".
    if ((err as { status?: number }).status === 1) return null
    throw err
  }
  const m = out.trim().match(/^(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/)
  if (!m) throw new Error('unreadable ps row: ' + JSON.stringify(out))
  if (m[3].startsWith('Z')) return null
  return { ppid: Number(m[1]), pgid: Number(m[2]), stat: m[3], command: m[4] }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

async function waitFor(check: () => boolean | Promise<boolean>, ms = 15_000): Promise<boolean> {
  const until = Date.now() + ms
  while (Date.now() < until) {
    if (await check()) return true
    await sleep(200)
  }
  return check()
}

/** Stand-in for `claude -p`: the stream lines of one finished turn, then one silent sleep. */
function writeDummyCli(dir: string): string {
  const file = path.join(dir, 'claude')
  fs.writeFileSync(file, [
    '#!/bin/sh',
    '# $2 is the session id (args: --session-id <id>).',
    `printf '%s\\n' '{"type":"system","subtype":"init","session_id":"'"$2"'"}' '{"type":"result","subtype":"success","is_error":false,"result":"ok","session_id":"'"$2"'"}' '{"type":"system","subtype":"session_state_changed","state":"idle"}'`,
    `exec /bin/sleep ${DUMMY_LIFETIME_S}`,
    '',
  ].join('\n'), { mode: 0o755 })
  return file
}

async function bootDaemon(scriptPath: string): Promise<void> {
  // A minimal env: nothing inherited can point this daemon at a real dir, a
  // watchdog pid, a bridge or a server.
  const env: Record<string, string> = {
    PATH: '/usr/bin:/bin',
    SHELL: '/bin/sh',
    LANG: 'C',
    HOME: home,
    TMPDIR: path.join(root, 'tmp'),
    WALNUT_DAEMON_DIR: path.join(root, 'daemon'),
    WALNUT_STREAMS_DIR: streams,
    WALNUT_LEGACY_STREAMS_DIR: path.join(root, 'no-legacy-streams'),
    WALNUT_SPAWN_JOURNAL: journal,
  }
  fs.mkdirSync(env.TMPDIR, { recursive: true })
  daemon = spawn(process.execPath, [scriptPath, '--start'], { env, stdio: ['ignore', 'pipe', 'pipe'] })
  daemon.stderr?.resume()
  const port = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('daemon spawn timeout')), 60_000)
    daemon!.stdout?.on('data', (chunk) => {
      const m = chunk.toString().trim().match(/^\d+$/m)
      if (m) { clearTimeout(timer); resolve(parseInt(m[0], 10)) }
    })
    daemon!.on('error', (err) => { clearTimeout(timer); reject(err) })
    daemon!.on('exit', (code) => { clearTimeout(timer); reject(new Error('daemon exited early: ' + code)) })
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

async function endChild(child: ChildProcess | null, graceMs: number, escalate: boolean): Promise<void> {
  if (!child || child.exitCode !== null || child.signalCode !== null) return
  const exited = new Promise<boolean>((r) => child.once('exit', () => r(true)))
  child.kill('SIGTERM')
  if (await Promise.race([exited, sleep(graceMs).then(() => false)])) return
  if (escalate && child.exitCode === null && child.signalCode === null) {
    child.kill('SIGKILL')
    await Promise.race([exited, sleep(5_000)])
  }
}

describe.runIf(ENABLED)('orphan stop with real processes (source twin daemon)', () => {
  beforeAll(async () => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-orphan-real-')))
    home = path.join(root, 'home')
    streams = path.join(root, 'streams')
    journal = path.join(root, 'spawn-journal.jsonl')
    fs.mkdirSync(home, { recursive: true })
    fs.mkdirSync(path.join(root, 'bin'), { recursive: true })
    cliPath = writeDummyCli(path.join(root, 'bin'))
    const scriptPath = path.join(root, 'daemon.cjs')
    fs.writeFileSync(scriptPath, getDaemonSource(), { mode: 0o700 })
    await bootDaemon(scriptPath)
  }, 120_000)

  afterAll(async () => {
    try { ws?.close() } catch { /* already closed */ }
    ws = null
    // Signal 2 (see header): the test daemon, through our own handle.
    await endChild(daemon, 15_000, true)
    daemon = null
    // Signal 3: dummy B, through our own handle.
    await endChild(dummyB, 5_000, false)
    dummyB = null
    if (root) fs.rmSync(root, { recursive: true, force: true })
    root = ''
  }, 60_000)

  it('ends only the dummy it spawned for this Walnut; a look-alike it never spawned survives', async () => {
    const walnutA = path.join(root, 'walnut-a')      // the asking Walnut's data dir: only a name to the daemon
    const walnutOther = path.join(root, 'walnut-other')

    // Dummy A: spawned BY the daemon, journaled for walnut A.
    const started = await rpc({
      cmd: 'start', sid: SID_A, cwd: root, message: '', mode: 'default',
      args: [cliPath, '--session-id', SID_A], origin: { home: walnutA, task: 'task-a' },
    }, 60_000)
    expect(started, JSON.stringify(started)).toMatchObject({ ok: true })
    const pidA = plainPid(started.pid)
    expect(psRow(pidA)).toMatchObject({ ppid: daemon!.pid, pgid: pidA })
    expect(fs.readFileSync(path.join(streams, SID_A + '.pgid'), 'utf8').trim()).toBe(String(pidA))
    expect(readSpawnJournal(journal).get(SID_A)).toMatchObject({ kind: 'new', home: walnutA })

    // Dummy B: the same script, started by the TEST and never shown to the daemon.
    // It stands for a live CLI another daemon owns (2026-09-26: the production
    // daemon's CLIs, killed by an ephemeral server holding their pids).
    dummyB = spawn(cliPath, ['--session-id', SID_B], {
      cwd: root, env: { PATH: '/usr/bin:/bin', HOME: home }, detached: true, stdio: 'ignore',
    })
    const pidB = plainPid(dummyB.pid)
    const bAlive = () => dummyB!.exitCode === null && dummyB!.signalCode === null && psRow(pidB) !== null
    expect(psRow(pidB)).toMatchObject({ ppid: process.pid, pgid: pidB })

    // A's turn has settled in the daemon's fold, so only the checks under test can refuse.
    expect(await waitFor(async () => {
      const st = await rpc({ cmd: 'getState', sid: SID_A })
      return st.alive === true && (st.snapshot as { turnActive?: boolean } | undefined)?.turnActive === false
    })).toBe(true)

    const orphanStop = (sid: string, expectPid: number, asking: string) =>
      rpc({ cmd: 'stop', sid, reason: 'orphan', expectPid, home: asking }, 30_000)
    const refusals: Array<[string, string, number, string, Record<string, unknown>]> = [
      ['B by its own sid: this daemon never spawned it', SID_B, pidB, walnutA, { reason: 'not_owned', detail: 'not_in_registry' }],
      ['A\'s sid naming B\'s pid: the pid is a precondition, never a target', SID_A, pidB, walnutA, { reason: 'not_owned', detail: 'pid_mismatch' }],
      ['A asked for by another Walnut', SID_A, pidA, walnutOther, { reason: 'not_owned', detail: 'other_walnut' }],
      ['A while its stream file is fresh', SID_A, pidA, walnutA, { reason: 'recent_output' }],
    ]
    for (const [label, sid, pid, asking, expected] of refusals) {
      const reply = await orphanStop(sid, pid, asking)
      expect(reply, label).toMatchObject({ ok: true, stopped: false, ...expected })
      expect(psRow(pidA), label + ': A is untouched').toMatchObject({ ppid: daemon!.pid })
      expect(bAlive(), label + ': B is untouched').toBe(true)
    }

    // Ten minutes of silence, as an idle CLI between turns has. Now every proof holds.
    const past = new Date(Date.now() - 10 * 60 * 1000)
    fs.utimesSync(path.join(streams, SID_A + '.jsonl'), past, past)
    const ended = await orphanStop(SID_A, pidA, walnutA)
    expect(ended, JSON.stringify(ended)).toMatchObject({ ok: true, stopped: true })

    expect(await waitFor(() => psRow(pidA) === null, 10_000), 'A ended').toBe(true)
    expect(bAlive(), 'B survived the successful stop').toBe(true)
    expect(psRow(pidB)).toMatchObject({ ppid: process.pid, pgid: pidB })
    const after = await rpc({ cmd: 'getState', sid: SID_A })
    expect(after.alive).toBe(false)
  }, 180_000)
})
