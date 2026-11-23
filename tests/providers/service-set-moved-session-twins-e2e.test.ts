/**
 * A session moved between two Walnuts' daemons on one machine resumes, takes
 * messages and answers on the real daemon twins (the JS source twin under node,
 * the standalone twin under bun when bun is installed).
 *
 * Two daemons share one HOME (so the CLI's ~/.claude transcripts are shared, as
 * on one machine and OS account) but each has its own daemon dir, streams dir,
 * registry and spawn journal, as two service sets do (src/providers/service-set.ts).
 * The leader moves a session the way a Walnut does: stop it on daemon A and wait
 * for the exit, start it on daemon B with `resume`, send to it there.
 *
 * Pinned: the stop is confirmed and the CLI is gone; B's CLI is a NEW process
 * that got `--resume <sid>` and sees only what B sent (never "before move" again),
 * with the shared transcript already in place; each answer lands in the output
 * of the daemon that ran the turn; after the move A neither lists the session
 * live nor adopts it when restarted, and B keeps sending to it.
 *
 * MACHINE SAFETY: HOME, both daemon dirs and both streams dirs are temp paths,
 * the "CLI" is a node script that exits on its own within 40 s, every session
 * is stopped and both daemons are SIGKILLed after each test.
 */
import { describe, it, expect, beforeAll, afterEach } from 'vitest'
import { WebSocket } from 'ws'
import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { getDaemonSource } from '../../src/providers/daemon-source.js'
import { testBun } from '../helpers/bun-runtime.js'
import { SOURCE_TWIN } from '../helpers/source-twin.js'
import { onDaemonEarlyExit } from '../helpers/daemon-early-exit.js'
import { guardedPath } from '../setup/exec-guard.js'

const BUN = testBun()
const STANDALONE = path.resolve(__dirname, '../../src/providers/daemon-standalone.ts')
type Twin = { name: string; command: () => [string, string[]] }
let scriptPath = ''
let cliPath = ''
const TWINS: Twin[] = [
  { name: `source twin (${SOURCE_TWIN.runtime})`, command: () => [SOURCE_TWIN.file, [scriptPath, '--start']] },
  ...(BUN ? [{ name: 'standalone twin (bun)', command: (): [string, string[]] => [BUN, [STANDALONE, '--start']] }] : []),
]

/**
 * A stand-in CLI: records each user line with its pid, argv and the transcript it
 * found at boot, appends the line to the shared transcript like the real CLI does,
 * and answers with an assistant text and a result.
 */
const FAKE_CLI = `
const fs = require('fs'), path = require('path')
const [received, ...argv] = process.argv.slice(2)
const sid = argv[argv.length - 1]
const transcript = path.join(process.env.HOME, '.claude', 'projects', 'p', sid + '.jsonl')
const transcriptAtBoot = fs.existsSync(transcript) ? fs.readFileSync(transcript, 'utf8').split('\\n').filter(Boolean).length : 0
fs.mkdirSync(path.dirname(transcript), { recursive: true })
process.stdout.write(JSON.stringify({ type: 'system', subtype: 'init', session_id: sid }) + '\\n')
setTimeout(() => process.exit(0), 40000).unref()
let buf = ''
process.stdin.on('data', (chunk) => {
  buf += chunk.toString()
  let i
  while ((i = buf.indexOf('\\n')) !== -1) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1)
    let msg; try { msg = JSON.parse(line) } catch { continue }
    if (msg.type !== 'user') continue
    const content = msg.message.content
    fs.appendFileSync(received, JSON.stringify({ pid: process.pid, argv, content, transcriptAtBoot }) + '\\n')
    fs.appendFileSync(transcript, JSON.stringify({ type: 'user', message: { content } }) + '\\n')
    process.stdout.write(JSON.stringify({ type: 'assistant', parent_tool_use_id: null, message: { role: 'assistant', content: [{ type: 'text', text: 'answer to ' + content }] } }) + '\\n')
    process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'answer to ' + content }) + '\\n')
  }
})
setInterval(() => {}, 1000)
`

interface Daemon { name: 'A' | 'B'; daemonDir: string; streams: string; proc: ChildProcess; ws: WebSocket }
interface Got { pid: number; argv: string[]; content: string; transcriptAtBoot: number }
const SID = 'dddddddd-0000-4000-8000-0000000000a1'
let root = ''
let rpcId = 1
const daemons: Daemon[] = []
const cliPids = new Set<number>()

async function boot(twin: Twin, name: 'A' | 'B'): Promise<Daemon> {
  const daemonDir = path.join(root, name, 'daemon')
  const streams = path.join(root, name, 'streams')
  const env: Record<string, string | undefined> = {
    ...process.env,
    SHELL: '/bin/sh',
    // The system dirs, behind the exec guard (a stray ssh or sudo from a child is caught, never run).
    PATH: guardedPath([], '/usr/bin:/bin'),
    HOME: path.join(root, 'home'), // one machine, one OS account: shared by both daemons
    CLAUDE_CONFIG_DIR: undefined,
    WALNUT_DAEMON_DIR: daemonDir,
    WALNUT_STREAMS_DIR: streams,
    WALNUT_LEGACY_STREAMS_DIR: path.join(root, 'no-legacy-streams'),
    // The spawn journal and the cli-owners records beside it are the machine's, under the shared HOME
    // (one CLI per session on a host, whichever service asks): never one per set.
    WALNUT_SPAWN_JOURNAL: path.join(root, 'home', '.open-walnut', 'local', 'spawn-journal.jsonl'),
  }
  const [cmd, args] = twin.command()
  const proc = spawn(cmd, args, { env, stdio: ['ignore', 'pipe', 'pipe'] })
  const port = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`daemon ${name} spawn timeout`)), 30_000)
    proc.stdout?.on('data', (chunk) => {
      const m = chunk.toString().trim().match(/^\d+$/m)
      if (m) { clearTimeout(timer); resolve(parseInt(m[0], 10)) }
    })
    proc.on('error', (err) => { clearTimeout(timer); reject(err) })
    onDaemonEarlyExit(proc, { daemonDir }, (err) => { clearTimeout(timer); reject(err) })
  })
  const ws = await new Promise<WebSocket>((resolve, reject) => {
    const s = new WebSocket(`ws://127.0.0.1:${port}`)
    s.on('open', () => resolve(s))
    s.on('error', reject)
  })
  const d = { name, daemonDir, streams, proc, ws }
  daemons.push(d)
  return d
}

async function killDaemon(d: Daemon): Promise<void> {
  try { d.ws.close() } catch { /* already closed */ }
  if (d.proc.exitCode === null) {
    d.proc.kill('SIGKILL')
    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, 3000)
      d.proc.once('exit', () => { clearTimeout(t); resolve() })
    })
  }
  daemons.splice(daemons.indexOf(d), 1)
}

function rpc(d: Daemon, cmd: Record<string, unknown>, timeoutMs = 20_000): Promise<Record<string, unknown>> {
  const id = rpcId++
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`rpc timeout on ${d.name}: ${String(cmd.cmd)}`)), timeoutMs)
    const onMessage = (data: Buffer) => {
      let msg: Record<string, unknown>
      try { msg = JSON.parse(data.toString()) } catch { return }
      if (msg.id === id) { clearTimeout(timer); d.ws.off('message', onMessage); resolve(msg) }
    }
    d.ws.on('message', onMessage)
    d.ws.send(JSON.stringify({ id, ...cmd }))
  })
}

async function waitFor(check: () => boolean, ms = 10_000): Promise<boolean> {
  const until = Date.now() + ms
  while (Date.now() < until) {
    if (check()) return true
    await new Promise((r) => setTimeout(r, 50))
  }
  return check()
}

const receivedFile = () => path.join(root, 'received.jsonl')
const received = (): Got[] => fs.existsSync(receivedFile()) ? fs.readFileSync(receivedFile(), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []
const isAlive = (pid: number) => { try { process.kill(pid, 0); return true } catch { return false } }

/** Start `sid` on `d` the way a Walnut does: a new session names `--session-id`, a move names `--resume` and says `resume`. */
function startCmd(sid: string, resume: boolean): Record<string, unknown> {
  const sh = `exec ${JSON.stringify(process.execPath)} ${JSON.stringify(cliPath)} ${JSON.stringify(receivedFile())} "$@"`
  return { cmd: 'start', sid, cwd: root, message: '', mode: 'default', resume, args: ['/bin/sh', '-c', sh, 'sh', resume ? '--resume' : '--session-id', sid] }
}

async function start(d: Daemon, sid: string, resume: boolean): Promise<{ pid: number; outputFile: string }> {
  const r = await rpc(d, startCmd(sid, resume))
  expect(r).toMatchObject({ ok: true })
  cliPids.add(r.pid as number)
  expect(await waitFor(() => fs.existsSync(r.outputFile as string) && fs.readFileSync(r.outputFile as string, 'utf8').includes('"init"'))).toBe(true)
  return { pid: r.pid as number, outputFile: r.outputFile as string }
}

/** Send one line and wait until the CLI took it and its answer is in `outputFile`. */
async function sendAndAnswer(d: Daemon, sid: string, message: string, outputFile: string): Promise<Got> {
  expect(await rpc(d, { cmd: 'send', sid, message })).toMatchObject({ ok: true })
  expect(await waitFor(() => received().some((g) => g.content === message))).toBe(true)
  const answer = JSON.stringify(`answer to ${message}`).slice(1, -1)
  expect(await waitFor(() => fs.readFileSync(outputFile, 'utf8').includes(`"text":"${answer}"`))).toBe(true)
  return received().find((g) => g.content === message)!
}

/** What a daemon says about `sid`: live or not, from `status` and from `list`. */
async function liveOn(d: Daemon, sid: string): Promise<{ status: boolean; listed: boolean; pid: number | null }> {
  const status = await rpc(d, { cmd: 'status', sid })
  const list = await rpc(d, { cmd: 'list' })
  const row = ((list.sessions ?? []) as Array<{ sid: string; alive: boolean }>).find((s) => s.sid === sid)
  return { status: status.alive === true, listed: row?.alive === true, pid: (status.pid as number | null | undefined) ?? null }
}

beforeAll(() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-moved-session-src-'))
  scriptPath = path.join(dir, 'daemon.cjs')
  fs.writeFileSync(scriptPath, getDaemonSource(), { mode: 0o755 })
  cliPath = path.join(dir, 'fake-cli.cjs')
  fs.writeFileSync(cliPath, FAKE_CLI)
})

afterEach(async () => {
  for (const d of [...daemons]) {
    await rpc(d, { cmd: 'stop', sid: SID }, 5_000).catch(() => undefined)
    await killDaemon(d)
  }
  // The stand-in CLIs run in their own groups: end them here, not on their timer.
  for (const pid of cliPids) { try { process.kill(-pid, 'SIGKILL') } catch { try { process.kill(pid, 'SIGKILL') } catch { /* gone */ } } }
  cliPids.clear()
  if (root) fs.rmSync(root, { recursive: true, force: true })
  root = ''
})

describe.each(TWINS)('a moved session between two daemons on one HOME: $name', (twin) => {
  it('stops on A, resumes on B with its own CLI, answers there, and A never takes it back', async () => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-moved-session-')))
    fs.mkdirSync(path.join(root, 'home'), { recursive: true })
    let a = await boot(twin, 'A')
    const b = await boot(twin, 'B')
    expect(a.daemonDir).not.toBe(b.daemonDir)
    expect(a.streams).not.toBe(b.streams)

    // 1. The session runs on A and its answer is in A's output.
    const onA = await start(a, SID, false)
    const first = await sendAndAnswer(a, SID, 'before move', onA.outputFile)
    expect(first.pid).toBe(onA.pid)
    expect(onA.outputFile.startsWith(a.streams)).toBe(true)
    expect(await liveOn(a, SID)).toMatchObject({ status: true, listed: true, pid: onA.pid })
    expect(await liveOn(b, SID)).toMatchObject({ status: false, listed: false })

    // 2. While A's CLI lives, B cannot start a second one of the same session (the shared
    //    cli-owner record): the move must stop it on A first.
    const early = await rpc(b, startCmd(SID, true))
    expect(early.ok, JSON.stringify(early)).not.toBe(true)
    if (typeof early.pid === 'number') cliPids.add(early.pid)
    expect(isAlive(onA.pid)).toBe(true)
    expect(received().map((g) => g.pid)).toEqual([onA.pid])

    // 3. The move stops it on A, confirmed and gone.
    expect(await rpc(a, { cmd: 'stop', sid: SID, reason: 'user' })).toMatchObject({ ok: true, stopped: true })
    expect(await waitFor(() => !isAlive(onA.pid))).toBe(true)

    // 4. B resumes it: a new CLI, told to resume, with the shared transcript there already.
    const onB = await start(b, SID, true)
    expect(onB.pid).not.toBe(onA.pid)
    expect(onB.outputFile.startsWith(b.streams)).toBe(true)
    expect(received()).toHaveLength(1) // the resume wrote nothing into the new CLI
    const second = await sendAndAnswer(b, SID, 'after move', onB.outputFile)
    expect(second).toMatchObject({ pid: onB.pid, argv: ['--resume', SID], transcriptAtBoot: 1 })
    expect(second.pid).not.toBe(first.pid)
    expect(received().filter((g) => g.pid === onB.pid).map((g) => g.content)).toEqual(['after move'])
    expect(fs.readFileSync(onB.outputFile, 'utf8')).not.toContain('answer to before move')

    // 5. Only B has it live.
    expect(await liveOn(a, SID)).toMatchObject({ status: false, listed: false })
    expect(await liveOn(b, SID)).toMatchObject({ status: true, listed: true, pid: onB.pid })

    // 6. A restarted on its own dirs does not adopt it; B still sends to the same CLI.
    await killDaemon(a)
    a = await boot(twin, 'A')
    expect(await liveOn(a, SID)).toMatchObject({ status: false, listed: false })
    const third = await sendAndAnswer(b, SID, 'third', onB.outputFile)
    expect(third.pid).toBe(onB.pid)
    expect(received().map((g) => g.content)).toEqual(['before move', 'after move', 'third'])
    expect(isAlive(onB.pid)).toBe(true)
  }, 90_000)
})
