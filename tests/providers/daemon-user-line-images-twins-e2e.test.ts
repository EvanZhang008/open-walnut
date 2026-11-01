/**
 * The pictures of a user line reach the CLI as image blocks, on the real daemon
 * twins (the JS source twin under node, and the standalone twin under bun when bun
 * is installed), with a stand-in CLI that records every stdin line it receives
 * (user-line-images-core.ts). Pins, per twin: a listed png goes as an image block
 * in front of ONE text block holding the server's text and the images hint; the
 * delivery marker in the stream file keeps the text alone, never the bytes; a
 * picture over the cap stays a path to Read; a line with no pictures, or a file
 * attachment, is written as the text it was.
 *
 * Harness copied from daemon-send-dedupe-twins-e2e.test.ts.
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
import { testBun } from '../helpers/bun-runtime.js'
import { SOURCE_TWIN } from '../helpers/source-twin.js'
import { guardedPath } from '../setup/exec-guard.js'
import { withImagePaths } from '../../src/core/sessions/cloud-images.js'
import { withFilePaths } from '../../src/core/sessions/session-uploads.js'
import { onDaemonEarlyExit } from '../helpers/daemon-early-exit.js'

let scriptPath = ''
let cliPath = ''
let root = ''
const BUN: string | undefined = testBun()
const STANDALONE = path.resolve(__dirname, '../../src/providers/daemon-standalone.ts')
type Twin = { name: string; command: () => [string, string[]] }
const TWINS: Twin[] = [
  { name: `source twin (${SOURCE_TWIN.runtime})`, command: () => [SOURCE_TWIN.file, [scriptPath, '--start']] },
  ...(BUN ? [{ name: 'standalone twin (bun)', command: (): [string, string[]] => [BUN, [STANDALONE, '--start']] }] : []),
]
let proc: ChildProcess | null = null
let ws: WebSocket | null = null
let rpcId = 1
const cliPids = new Set<number>()

/**
 * A stand-in CLI: prints init, records each stdin line, optionally reports lifecycle.
 * Modes (send-lost-line-v1): --lose-first drops the first user line unseen, as if
 * another reader of the pipe had taken it; --dedupe-uuid skips a uuid it already
 * took, silently, as Claude Code does; a line that does not parse is recorded as
 * such (Claude Code exits on one), and a blank line is skipped (as Claude Code does).
 * --count-blank still skips a blank line but records that it read one, so a test
 * can say how many lines the CLI read, not only which ones it ran.
 * --read-after=<file> reads nothing from stdin until that file exists (a CLI still
 * booting, whose full stdin takes not one byte).
 */
const FAKE_CLI = `
const fs = require('fs')
const [received, ...modes] = process.argv.slice(2)
const mode = modes[0]
const seen = new Set()
let lose = modes.includes('--lose-first')
const readAfter = (modes.find((m) => m.startsWith('--read-after=')) || '').slice('--read-after='.length)
process.stdout.write(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'fake' }) + '\\n')
setTimeout(() => process.exit(0), 40000).unref()
let buf = ''
const listen = () => process.stdin.on('data', (chunk) => {
  buf += chunk.toString()
  let i
  while ((i = buf.indexOf('\\n')) !== -1) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1)
    if (!line.trim()) {
      if (modes.includes('--count-blank')) fs.appendFileSync(received, JSON.stringify({ pid: process.pid, blank: true }) + '\\n')
      continue
    }
    let msg; try { msg = JSON.parse(line) } catch {
      fs.appendFileSync(received, JSON.stringify({ pid: process.pid, parseError: line.slice(0, 200) }) + '\\n')
      continue
    }
    if (msg.type !== 'user') continue
    if (lose) { lose = false; continue }
    if (modes.includes('--dedupe-uuid') && msg.uuid) { if (seen.has(msg.uuid)) continue; seen.add(msg.uuid) }
    fs.appendFileSync(received, JSON.stringify({ pid: process.pid, uuid: msg.uuid || null, content: msg.message.content }) + '\\n')
    if (mode === '--lifecycle' && msg.uuid) {
      for (const state of ['queued', 'started', 'completed']) {
        process.stdout.write(JSON.stringify({ type: 'command_lifecycle', command_uuid: msg.uuid, state }) + '\\n')
      }
    }
  }
})
if (!readAfter) listen()
else { const t = setInterval(() => { if (fs.existsSync(readAfter)) { clearInterval(t); listen() } }, 50) }
setInterval(() => {}, 1000)
`

interface Dirs { home: string; streams: string; daemon: string; received: string }

function makeDirs(): Dirs {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-line-images-twins-')))
  const home = path.join(root, 'home')
  fs.mkdirSync(home, { recursive: true })
  return { home, streams: path.join(root, 'streams'), daemon: path.join(root, 'daemon'), received: path.join(root, 'received.jsonl') }
}

async function boot(twin: Twin, dirs: Dirs): Promise<void> {
  const env: Record<string, string | undefined> = {
    ...process.env,
    SHELL: '/bin/sh',
    PATH: guardedPath([], '/usr/bin:/bin'),
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
    onDaemonEarlyExit(proc!, { daemonDir: dirs.daemon }, (err) => { clearTimeout(timer); reject(err) })
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

const received = (dirs: Dirs): Array<{ pid: number; uuid?: string | null; content?: string; parseError?: string; blank?: true }> =>
  fs.existsSync(dirs.received) ? fs.readFileSync(dirs.received, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []

/** The daemon reply minus the envelope id. */
const body = (r: Record<string, unknown>) => { const { id: _id, ...rest } = r; return rest }

async function start(dirs: Dirs, sid: string, lifecycle: boolean | string[]): Promise<{ pid: number; outputFile: string }> {
  const modes = Array.isArray(lifecycle) ? lifecycle : lifecycle ? ['--lifecycle'] : []
  const sh = `exec ${JSON.stringify(process.execPath)} ${JSON.stringify(cliPath)} ${JSON.stringify(dirs.received)}${modes.map((m) => ' ' + m).join('')}`
  const r = await rpc({ cmd: 'start', sid, cwd: root, message: '', mode: 'default', args: ['/bin/sh', '-c', sh, 'sh'] })
  const pid = r.pid as number
  expect(typeof pid).toBe('number')
  cliPids.add(pid)
  expect(await waitFor(() => fs.existsSync(r.outputFile as string) && fs.readFileSync(r.outputFile as string, 'utf8').includes('"init"'))).toBe(true)
  return { pid, outputFile: r.outputFile as string }
}

const send = (sid: string, message: string, uuid: string, ids: string[], dedupe = false, lostPid?: number) => rpc({
  cmd: 'send', sid, message, uuid, markers: ids.map((messageId) => ({ message, messageId })), ...(dedupe ? { dedupe: true } : {}),
  ...(lostPid != null ? { lostPid } : {}),
})

beforeAll(() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-line-images-twins-src-'))
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


const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(200, 3)])
/** A picture in Walnut's picture folder on the host (<daemon dir>/images/), or elsewhere. */
const writePicture = (name: string, size = PNG.length, dir = path.join(root, 'daemon', 'images')): string => {
  fs.mkdirSync(dir, { recursive: true })
  const p = path.join(dir, name)
  const buf = Buffer.alloc(size, 3)
  PNG.copy(buf, 0, 0, Math.min(PNG.length, size))
  fs.writeFileSync(p, buf)
  return p
}
type Got = { content?: unknown }
const blocks = (r: Got): Array<{ type: string; text?: string; source?: { media_type: string; data: string } }> =>
  (Array.isArray(r.content) ? r.content : [])

describe.each(TWINS)('user line pictures: $name', (twin) => {
  it('a listed picture goes as an image block; the marker keeps the text only', async () => {
    const dirs = makeDirs()
    await boot(twin, dirs)
    const cli = await start(dirs, 'img-one', false)
    const pic = writePicture('shot.png')
    const message = withImagePaths('what is on this screen?', [pic])
    expect(body(await send('img-one', message, 'aaaaaaaa-0000-4000-8000-0000000000b1', ['qm-b1']))).toEqual({ ok: true })
    expect(await waitFor(() => received(dirs).length === 1)).toBe(true)
    const got = received(dirs)[0] as Got
    const b = blocks(got)
    expect(b.map((x) => x.type)).toEqual(['image', 'text'])
    expect(b[0].source).toEqual({ type: 'base64', media_type: 'image/png', data: fs.readFileSync(pic).toString('base64') })
    expect(b[1].text!.startsWith(message)).toBe(true)
    expect(b[1].text).toContain('Walnut (images):')
    const stream = fs.readFileSync(cli.outputFile, 'utf8')
    const marker = stream.split('\n').filter((l) => l.includes('walnut-injected')).map((l) => JSON.parse(l))
    expect(marker).toMatchObject([{ walnutMessageId: 'qm-b1', message: { content: message } }])
    expect(stream).not.toContain(fs.readFileSync(pic).toString('base64'))
  }, 60_000)

  it('a retry of a picture line the process already holds is not written again; one proved read past is written again whole', async () => {
    const dirs = makeDirs()
    await boot(twin, dirs)
    const cli = await start(dirs, 'img-retry', false)
    const message = withImagePaths('again?', [writePicture('retry.png')])
    const uuid = 'aaaaaaaa-0000-4000-8000-0000000000d1'
    expect(body(await send('img-retry', message, uuid, ['qm-d1']))).toEqual({ ok: true })
    expect(await waitFor(() => received(dirs).length === 1)).toBe(true)
    expect(body(await send('img-retry', message, uuid, ['qm-d1'], true))).toMatchObject({ ok: true, duplicate: true, fate: 'waiting' })
    // Proved read past by that process (send-lost-line-v1): written again, still as blocks.
    expect(body(await send('img-retry', message, uuid, ['qm-d1'], true, cli.pid))).toEqual({ ok: true })
    expect(await waitFor(() => received(dirs).length === 2)).toBe(true)
    const [first, again] = received(dirs) as Got[]
    expect(blocks(again)).toEqual(blocks(first))
    expect(blocks(again).map((x) => x.type)).toEqual(['image', 'text'])
  }, 60_000)

  it('a picture over the cap or outside Walnut\'s folders stays a path; plain text and file attachments are written as they were', async () => {
    const dirs = makeDirs()
    await boot(twin, dirs)
    await start(dirs, 'img-fallback', false)
    const big = writePicture('big.png', 5 * 1024 * 1024 + 1)
    const tooBig = withImagePaths('too big', [big])
    const file = withFilePaths('a file', [writePicture('as-file.png')])
    const elsewhere = withImagePaths('not ours', [writePicture('desktop.png', PNG.length, root)])
    expect(body(await send('img-fallback', tooBig, 'aaaaaaaa-0000-4000-8000-0000000000c1', ['qm-c1']))).toEqual({ ok: true })
    expect(body(await send('img-fallback', file, 'aaaaaaaa-0000-4000-8000-0000000000c2', ['qm-c2']))).toEqual({ ok: true })
    expect(body(await send('img-fallback', 'just words', 'aaaaaaaa-0000-4000-8000-0000000000c3', ['qm-c3']))).toEqual({ ok: true })
    expect(body(await send('img-fallback', elsewhere, 'aaaaaaaa-0000-4000-8000-0000000000c4', ['qm-c4']))).toEqual({ ok: true })
    expect(await waitFor(() => received(dirs).length === 4)).toBe(true)
    expect(received(dirs).map((r) => r.content)).toEqual([tooBig, file, 'just words', elsewhere])
    // The daemon says which path each line took.
    const logs = fs.readdirSync(dirs.daemon).filter((f) => f.startsWith('daemon-')).map((f) => fs.readFileSync(path.join(dirs.daemon, f), 'utf8')).join('')
    expect(logs).toContain('send: pictures went as paths to Read')
  }, 60_000)
})
