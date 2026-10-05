/**
 * send-dedupe-v1 on the real daemon twins, booted for real (the JS source twin
 * under node, and the standalone twin under bun when bun is installed), with a
 * stand-in CLI that records every stdin line it receives.
 *
 * Pins what the regex parity checks never could (gate mutants M7 and M10 of
 * round 1 survived them): a resend with `dedupe` into the process that already
 * has the whole line is not written again; a marker with no write record (a
 * write cut short) or from an older daemon is no proof, so the line IS written;
 * the CLI's own lifecycle word settles it; and the write record survives a
 * daemon restart, so the new daemon still answers for the CLI it adopted.
 *
 * MACHINE SAFETY: HOME, the daemon dir and the streams dir are temp paths, the
 * "CLI" is a node script that exits on its own within 40 s, every session is
 * stopped and the daemon SIGKILLed after each test.
 */
import { describe, it, expect, beforeAll, afterEach } from 'vitest'
import { WebSocket } from 'ws'
import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { getDaemonSource } from '../../src/providers/daemon-source.js'

let scriptPath = ''
let cliPath = ''
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
const cliPids = new Set<number>()

/** A stand-in CLI: prints init, records each stdin line, optionally reports lifecycle. */
const FAKE_CLI = `
const fs = require('fs')
const [received, mode] = process.argv.slice(2)
process.stdout.write(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'fake' }) + '\\n')
setTimeout(() => process.exit(0), 40000).unref()
let buf = ''
process.stdin.on('data', (chunk) => {
  buf += chunk.toString()
  let i
  while ((i = buf.indexOf('\\n')) !== -1) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1)
    let msg; try { msg = JSON.parse(line) } catch { continue }
    if (msg.type !== 'user') continue
    fs.appendFileSync(received, JSON.stringify({ pid: process.pid, uuid: msg.uuid || null, content: msg.message.content }) + '\\n')
    if (mode === '--lifecycle' && msg.uuid) {
      for (const state of ['queued', 'started', 'completed']) {
        process.stdout.write(JSON.stringify({ type: 'command_lifecycle', command_uuid: msg.uuid, state }) + '\\n')
      }
    }
  }
})
setInterval(() => {}, 1000)
`

interface Dirs { home: string; streams: string; daemon: string; received: string }

function makeDirs(): Dirs {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-dedupe-twins-')))
  const home = path.join(root, 'home')
  fs.mkdirSync(home, { recursive: true })
  return { home, streams: path.join(root, 'streams'), daemon: path.join(root, 'daemon'), received: path.join(root, 'received.jsonl') }
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

async function killDaemon(): Promise<void> {
  try { ws?.close() } catch { /* already closed */ }
  ws = null
  if (proc && proc.exitCode === null) {
    proc.kill('SIGKILL')
    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, 3000)
      proc!.once('exit', () => { clearTimeout(t); resolve() })
    })
  }
  proc = null
}

function rpc(cmd: Record<string, unknown>, timeoutMs = 20_000): Promise<Record<string, unknown>> {
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

async function waitFor(check: () => boolean, ms = 10_000): Promise<boolean> {
  const until = Date.now() + ms
  while (Date.now() < until) {
    if (check()) return true
    await new Promise((r) => setTimeout(r, 50))
  }
  return check()
}

const received = (dirs: Dirs): Array<{ pid: number; uuid: string | null; content: string }> =>
  fs.existsSync(dirs.received) ? fs.readFileSync(dirs.received, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []

/** The daemon reply minus the envelope id. */
const body = (r: Record<string, unknown>) => { const { id: _id, ...rest } = r; return rest }

async function start(dirs: Dirs, sid: string, lifecycle: boolean): Promise<{ pid: number; outputFile: string }> {
  const sh = `exec ${JSON.stringify(process.execPath)} ${JSON.stringify(cliPath)} ${JSON.stringify(dirs.received)}${lifecycle ? ' --lifecycle' : ''}`
  const r = await rpc({ cmd: 'start', sid, cwd: root, message: '', mode: 'default', args: ['/bin/sh', '-c', sh, 'sh'] })
  const pid = r.pid as number
  expect(typeof pid).toBe('number')
  cliPids.add(pid)
  expect(await waitFor(() => fs.existsSync(r.outputFile as string) && fs.readFileSync(r.outputFile as string, 'utf8').includes('"init"'))).toBe(true)
  return { pid, outputFile: r.outputFile as string }
}

const send = (sid: string, message: string, uuid: string, ids: string[], dedupe = false) => rpc({
  cmd: 'send', sid, message, uuid, markers: ids.map((messageId) => ({ message, messageId })), ...(dedupe ? { dedupe: true } : {}),
})

beforeAll(() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-dedupe-twins-src-'))
  scriptPath = path.join(dir, 'daemon.cjs')
  fs.writeFileSync(scriptPath, getDaemonSource(), { mode: 0o755 })
  cliPath = path.join(dir, 'fake-cli.cjs')
  fs.writeFileSync(cliPath, FAKE_CLI)
})

afterEach(async () => {
  await killDaemon()
  // The stand-in CLIs run detached in their own groups: end them here, not on their timer.
  for (const pid of cliPids) { try { process.kill(-pid, 'SIGKILL') } catch { try { process.kill(pid, 'SIGKILL') } catch { /* gone */ } } }
  cliPids.clear()
  if (root) fs.rmSync(root, { recursive: true, force: true })
  root = ''
})

describe.each(TWINS)('send-dedupe-v1: $name', (twin) => {
  it('a resend into the process that has the whole line is not written again (M10)', async () => {
    const dirs = makeDirs()
    await boot(twin, dirs)
    const cli = await start(dirs, 'dd-same', false)
    expect(body(await send('dd-same', 'hello', 'aaaaaaaa-0000-4000-8000-000000000001', ['qm-1']))).toMatchObject({ ok: true })
    expect(await waitFor(() => received(dirs).length === 1)).toBe(true)
    // The marker carries the pid of the CLI it went to (M7's half).
    const markers = fs.readFileSync(cli.outputFile, 'utf8').split('\n').filter((l) => l.includes('walnut-injected')).map((l) => JSON.parse(l))
    expect(markers).toMatchObject([{ walnutMessageId: 'qm-1', walnutPid: cli.pid }])
    const again = body(await send('dd-same', 'hello', 'aaaaaaaa-0000-4000-8000-000000000001', ['qm-1'], true))
    expect(again).toEqual({ ok: true, duplicate: true, fate: 'waiting' })
    await new Promise((r) => setTimeout(r, 300))
    expect(received(dirs)).toHaveLength(1)
  }, 60_000)

  it('a marker with no write record (cut short) or with no pid (older daemon) is no proof: written (M7)', async () => {
    const dirs = makeDirs()
    await boot(twin, dirs)
    const cli = await start(dirs, 'dd-torn', false)
    // A write the previous daemon cut short: its marker landed, the newline never did.
    const torn = { type: 'user', subtype: 'walnut-injected', message: { role: 'user', content: 'torn' }, walnutMessageId: 'qm-torn', walnutDelivery: 'ordered', walnutPid: cli.pid }
    const old = { type: 'user', subtype: 'walnut-injected', message: { role: 'user', content: 'old' }, walnutMessageId: 'qm-old', walnutDelivery: 'ordered' }
    fs.appendFileSync(cli.outputFile, JSON.stringify(torn) + '\n' + JSON.stringify(old) + '\n')
    expect(body(await send('dd-torn', 'torn', 'aaaaaaaa-0000-4000-8000-000000000002', ['qm-torn'], true))).toEqual({ ok: true })
    expect(body(await send('dd-torn', 'old', 'aaaaaaaa-0000-4000-8000-000000000003', ['qm-old'], true))).toEqual({ ok: true })
    expect(await waitFor(() => received(dirs).length === 2)).toBe(true)
    expect(received(dirs).map((r) => r.content)).toEqual(['torn', 'old'])
  }, 60_000)

  it('the CLI\'s lifecycle word and the write record settle a resend, also after a daemon restart', async () => {
    const dirs = makeDirs()
    await boot(twin, dirs)
    const word = await start(dirs, 'dd-word', true)
    await start(dirs, 'dd-rec', false)
    const wordUuid = 'aaaaaaaa-0000-4000-8000-000000000004'
    const recUuid = 'aaaaaaaa-0000-4000-8000-000000000005'
    expect(body(await send('dd-word', 'run me', wordUuid, ['qm-4']))).toMatchObject({ ok: true })
    expect(body(await send('dd-rec', 'hold me', recUuid, ['qm-5']))).toMatchObject({ ok: true })
    expect(await waitFor(() => fs.readFileSync(word.outputFile, 'utf8').includes('"completed"'))).toBe(true)
    expect(body(await send('dd-word', 'run me', wordUuid, ['qm-4'], true))).toEqual({ ok: true, duplicate: true, fate: 'ran', state: 'completed' })

    // A deploy restarts the daemon; the CLIs live on and the new daemon adopts them.
    await killDaemon()
    await boot(twin, dirs)
    const resend = async (sid: string, message: string, uuid: string, id: string) => {
      let reply: Record<string, unknown> = {}
      const until = Date.now() + 15_000
      do {
        reply = body(await send(sid, message, uuid, [id], true))
        if (reply.reason !== 'not_found') break
        await new Promise((r) => setTimeout(r, 200))
      } while (Date.now() < until)
      return reply
    }
    expect(await resend('dd-word', 'run me', wordUuid, 'qm-4')).toEqual({ ok: true, duplicate: true, fate: 'ran', state: 'completed' })
    expect(await resend('dd-rec', 'hold me', recUuid, 'qm-5')).toEqual({ ok: true, duplicate: true, fate: 'waiting' })
    await new Promise((r) => setTimeout(r, 300))
    expect(received(dirs).map((r) => r.content).sort()).toEqual(['hold me', 'run me'])
  }, 90_000)
})
