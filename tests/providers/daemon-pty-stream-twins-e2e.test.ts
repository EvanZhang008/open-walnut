/**
 * 'pty-stream-v1' on the real daemon twins, booted for real: a terminal on the
 * daemon's host carried as a stream on the server's link (pty-stream-core.ts),
 * read through the server's own endpoint (src/lib/link-stream.ts) and the Pty the
 * terminal manager drives (src/web/terminal/link-pty.ts). What every host without
 * an SSH route (the host network, the cloud box) gets where an SSH host has `ssh -tt`.
 *
 * Twins: the standalone twin under bun, the JS source twin under bun (both have a
 * pty), and the source twin under Node when the machine has one, which has no pty
 * and so must not advertise the capability and must refuse an open.
 *
 * MACHINE SAFETY: HOME, the daemon dir and the streams dir are temp paths. The only
 * process this test ends itself is the daemon it spawned, through its own handle
 * (SIGTERM, SIGKILL only after a deadline); the terminals' processes are ended by
 * the daemon (the behaviour under test), and the test only asks whether the pids it
 * was told are still there (signal 0).
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest'
import { WebSocket } from 'ws'
import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const sshSpawns = vi.hoisted(() => [] as string[][])
vi.mock('node:child_process', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:child_process')>()
  return {
    ...original,
    spawn: vi.fn((cmd: string, args: string[], opts?: unknown) => {
      if (cmd === 'ssh') { sshSpawns.push(args); throw new Error('ssh refused by the test: SSH certificate expired') }
      return original.spawn(cmd, args, opts as never)
    }),
  }
})

import { getDaemonSource } from '../../src/providers/daemon-source.js'
import { DaemonConnection } from '../../src/providers/daemon-connection.js'
import { createStreamEndpoint, type StreamEndpoint, type PtyStream } from '../../src/lib/link-stream.js'
import { ptyOverStream } from '../../src/web/terminal/link-pty.js'
import type { Pty, PtyExit } from '../../src/lib/pty.js'
import { testBun } from '../helpers/bun-runtime.js'
import { SOURCE_TWIN } from '../helpers/source-twin.js'
import { onDaemonEarlyExit } from '../helpers/daemon-early-exit.js'
import { guardedPath } from '../setup/exec-guard.js'

let scriptPath = ''
let scriptDir = ''
let root = ''
const BUN: string | undefined = testBun()
const STANDALONE = path.resolve(__dirname, '../../src/providers/daemon-standalone.ts')
type Twin = { name: string; pty: boolean; command: () => [string, string[]] }
const TWINS: Twin[] = [
  { name: `source twin (${SOURCE_TWIN.runtime})`, pty: SOURCE_TWIN.runtime === 'bun', command: () => [SOURCE_TWIN.file, [scriptPath, '--start']] },
  ...(BUN && SOURCE_TWIN.runtime === 'node' ? [{ name: 'source twin (bun)', pty: true, command: (): [string, string[]] => [BUN, [scriptPath, '--start']] }] : []),
  ...(BUN ? [{ name: 'standalone twin (bun)', pty: true, command: (): [string, string[]] => [BUN, [STANDALONE, '--start']] }] : []),
]
let proc: ChildProcess | null = null
const sockets: WebSocket[] = []
let rpcId = 1

async function boot(twin: Twin): Promise<number> {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.platform() === 'win32' ? os.tmpdir() : '/tmp', 'wpty-')))
  const home = path.join(root, 'home')
  fs.mkdirSync(home, { recursive: true })
  const daemonDir = path.join(root, 'daemon')
  const env: Record<string, string | undefined> = {
    ...process.env,
    SHELL: '/bin/sh',
    PATH: guardedPath([], '/usr/bin:/bin'),
    HOME: home,
    WALNUT_DAEMON_DIR: daemonDir,
    WALNUT_STREAMS_DIR: path.join(root, 'streams'),
    WALNUT_LEGACY_STREAMS_DIR: path.join(root, 'no-legacy-streams'),
    WALNUT_SPAWN_JOURNAL: path.join(root, 'spawn-journal.jsonl'),
  }
  const [cmd, args] = twin.command()
  proc = spawn(cmd, args, { env, stdio: ['ignore', 'pipe', 'pipe'] })
  return new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('daemon spawn timeout')), 30_000)
    proc!.stdout?.on('data', (chunk) => {
      const m = chunk.toString().trim().match(/^\d+$/m)
      if (m) { clearTimeout(timer); resolve(parseInt(m[0], 10)) }
    })
    proc!.on('error', (err) => { clearTimeout(timer); reject(err) })
    onDaemonEarlyExit(proc!, { daemonDir }, (err) => { clearTimeout(timer); reject(err) })
  })
}

function rpc(ws: WebSocket, cmd: Record<string, unknown>, timeoutMs = 10_000): Promise<Record<string, unknown>> {
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

async function rawLink(port: number): Promise<{ ws: WebSocket; caps: string[] }> {
  const ws = await new Promise<WebSocket>((resolve, reject) => {
    const w = new WebSocket(`ws://127.0.0.1:${port}`)
    w.on('open', () => resolve(w))
    w.on('error', reject)
  })
  sockets.push(ws)
  const hello = await rpc(ws, { cmd: 'hello' })
  expect(hello.ok).toBe(true)
  return { ws, caps: (hello.capabilities ?? (hello.result as { capabilities?: string[] } | undefined)?.capabilities ?? []) as string[] }
}

/** A server socket to the daemon, said hello, with the server's own stream endpoint on it. */
async function link(port: number): Promise<{ ws: WebSocket; ep: StreamEndpoint; caps: string[] }> {
  const { ws, caps } = await rawLink(port)
  const ep = createStreamEndpoint({
    send: (frame) => {
      if (ws.readyState !== WebSocket.OPEN) throw new Error('link down')
      ws.send(JSON.stringify(frame))
    },
  })
  ws.on('message', (data: Buffer) => {
    try { ep.handle(JSON.parse(data.toString()) as Record<string, unknown>) } catch { /* not a frame */ }
  })
  ws.on('close', () => ep.closeAll('the link closed'))
  return { ws, ep, caps }
}

/** A terminal as the manager sees it, with its output so far and its exit. */
function watch(pty: Pty): { text: () => string; exited: Promise<PtyExit> } {
  let text = ''
  pty.onData((d) => { text += d })
  return { text: () => text, exited: new Promise((resolve) => pty.onExit(resolve)) }
}

const alive = (pid: number) => { try { process.kill(pid, 0); return true } catch { return false } }

beforeAll(() => {
  scriptDir = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-pty-stream-twins-src-'))
  scriptPath = path.join(scriptDir, 'daemon.cjs')
  fs.writeFileSync(scriptPath, getDaemonSource(), { mode: 0o755 })
})

afterAll(() => {
  if (scriptDir) fs.rmSync(scriptDir, { recursive: true, force: true })
  scriptDir = ''
})

/** End the daemon this test spawned (its own handle only): TERM, then KILL after a deadline. */
async function stopOwnDaemon(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  const exited = new Promise<boolean>((resolve) => child.once('exit', () => resolve(true)))
  const within = (ms: number) => Promise.race([exited, new Promise<boolean>((r) => setTimeout(() => r(false), ms))])
  child.kill('SIGTERM')
  if (await within(5_000)) return
  child.kill('SIGKILL')
  await within(3_000)
}

const conns: DaemonConnection[] = []

afterEach(async () => {
  for (const c of conns.splice(0)) c.disconnect()
  sshSpawns.length = 0
  for (const s of sockets.splice(0)) { try { s.close() } catch { /* closed */ } }
  if (proc) await stopOwnDaemon(proc)
  proc = null
  if (root) fs.rmSync(root, { recursive: true, force: true })
  root = ''
})

const WAIT = { timeout: 15_000, interval: 25 }

for (const twin of TWINS.filter((t) => t.pty)) {
  describe(`terminal streams, ${twin.name}`, () => {
    it('advertises pty-stream-v1, runs the command under the login shell on a pty, keeps UTF-8 whole and reports the exit after the output', async () => {
      const { ep, caps } = await link(await boot(twin))
      expect(caps).toContain('pty-stream-v1')
      // Bytes split across pieces stay whole: 3000 of a 3-byte character, then a 2-byte one.
      const snow = '\u2603'
      const cmd = `[ -t 0 ] && echo tty; echo "term=$TERM home=$HOME"; printf '%s\\n' 'caf\u00e9 ${snow}'; i=0; while [ $i -lt 3000 ]; do printf '${snow}'; i=$((i+1)); done; echo; exit 7`
      const stream = await ep.openPty(cmd, { cols: 80, rows: 24 })
      expect(stream.remotePid).toBeGreaterThan(1)
      const t = watch(ptyOverStream(stream))
      const exit = await t.exited
      expect(exit).toEqual({ exitCode: 7, signal: 0 })
      const out = t.text().replace(/\r/g, '')
      expect(out).toContain('tty\n')
      expect(out).toContain(`term=xterm-256color home=${path.join(root, 'home')}`)
      expect(out).toContain('caf\u00e9 \u2603\n')
      expect(out).toContain(snow.repeat(3000))
      expect(out).not.toContain('\ufffd')
      expect(stream.exit).toEqual({ code: 7, signal: null })
      await vi.waitFor(() => expect(ep.size()).toBe(0), WAIT)
    }, 90_000)

    it('takes input, and a resize changes what the pty says its size is', async () => {
      const { ep } = await link(await boot(twin))
      const stream = await ep.openPty('stty size; read a; echo "got:$a"; stty size; read b; exit 0', { cols: 90, rows: 30 })
      const pty = ptyOverStream(stream)
      const t = watch(pty)
      await vi.waitFor(() => expect(t.text()).toContain('30 90'), WAIT)
      pty.resize(120, 40)
      pty.write('hi\r')
      await vi.waitFor(() => expect(t.text()).toContain('40 120'), WAIT)
      expect(t.text()).toContain('got:hi')
      pty.write('\r')
      expect(await t.exited).toEqual({ exitCode: 0, signal: 0 })
    }, 90_000)

    it('a plain shell\'s job printing far past the window is held, not hung up: every byte arrives', async () => {
      const { ep } = await link(await boot(twin))
      // 30 MB is past the 16 MB hard cap: only stopping the job printing (the pty's foreground
      // group, not the shell alone) keeps the stream inside its window until it is acked.
      const stream = await ep.openPty('yes | head -c 30000000; echo; echo done-$((40+2))', { cols: 80, rows: 24 })
      const pty = ptyOverStream(stream)
      let ys = 0
      let tail = ''
      pty.onData((d) => { for (let i = 0; i < d.length; i++) if (d.charCodeAt(i) === 121) ys++; tail = (tail + d).slice(-64) })
      const exit = await new Promise<PtyExit>((resolve) => pty.onExit(resolve))
      expect(exit).toEqual({ exitCode: 0, signal: 0 })
      expect(ys).toBe(15_000_000)
      expect(tail).toContain('done-42')
    }, 180_000)

    it('a close from the link hangs the terminal up with SIGHUP', async () => {
      const { ep } = await link(await boot(twin))
      const mark = path.join(root, 'hup')
      const stream = await ep.openPty(`trap 'echo hup > ${mark}; exit 0' HUP; echo ready; while :; do sleep 1; done`, { cols: 80, rows: 24 })
      const pty = ptyOverStream(stream)
      const t = watch(pty)
      await vi.waitFor(() => expect(t.text()).toContain('ready'), WAIT)
      pty.kill()
      await vi.waitFor(() => expect(fs.existsSync(mark)).toBe(true), WAIT)
      expect(fs.readFileSync(mark, 'utf8').trim()).toBe('hup')
      await vi.waitFor(() => expect(alive(stream.remotePid)).toBe(false), WAIT)
    }, 90_000)

    it('refuses a bad command or size, holds at most 32 per link, and the link dropping hangs every one up', async () => {
      const { ws, ep } = await link(await boot(twin))
      await expect(ep.openPty('', { cols: 80, rows: 24 })).rejects.toThrow(/needs a command/)
      await expect(ep.openPty('true', { cols: 0, rows: 24 })).rejects.toThrow(/cols and rows/)
      const open: PtyStream[] = []
      for (let i = 0; i < 32; i++) open.push(await ep.openPty('cat', { cols: 80, rows: 24 }))
      await expect(ep.openPty('cat', { cols: 80, rows: 24 })).rejects.toThrow(/too many terminal streams on this link/)
      const pids = open.map((s) => s.remotePid)
      for (const s of open) s.on('error', () => {})
      expect(pids.every(alive)).toBe(true)
      ws.close()
      await vi.waitFor(() => expect(pids.filter(alive)).toEqual([]), WAIT)
    }, 120_000)

    it('a socket that said it is a probe opens no terminal', async () => {
      const { ws, ep } = await link(await boot(twin))
      expect((await rpc(ws, { cmd: 'client.role', role: 'probe' })).ok).toBe(true)
      await expect(ep.openPty('echo no', { cols: 80, rows: 24 })).rejects.toThrow(/only the Walnut server linked here opens a terminal stream/)
    }, 90_000)
  })

  describe(`a host network machine's terminal end to end, ${twin.name}`, () => {
    it('opens through DaemonConnection with SSH refused', async () => {
      const port = await boot(twin)
      const conn = new DaemonConnection('joined-box', { hostname: 'joined-box.walnut-net.invalid', via: 'net', endpoint: 'ab'.repeat(32) /* an invented endpoint key */ })
      conns.push(conn)
      const inner = conn as unknown as { ws: unknown; streams: { closeAll(r: string): void } | null; streamEndpoint(): { handle(m: Record<string, unknown>): boolean } }
      const { ws, caps } = await rawLink(port)
      vi.spyOn(conn, 'hasCapability').mockImplementation((cap) => caps.includes(cap))
      ws.on('message', (data: Buffer) => {
        try { inner.streamEndpoint().handle(JSON.parse(data.toString()) as Record<string, unknown>) } catch { /* not a frame */ }
      })
      ws.on('close', () => inner.streams?.closeAll('the link to joined-box closed'))
      inner.ws = ws
      const t = watch(ptyOverStream(await conn.openPtyStream('echo "over the link"; exit 3', { cols: 80, rows: 24, env: { LANG: 'C.UTF-8' } })))
      expect(await t.exited).toEqual({ exitCode: 3, signal: 0 })
      expect(t.text()).toContain('over the link')
      expect(sshSpawns).toEqual([])
    }, 90_000)
  })
}

for (const twin of TWINS.filter((t) => !t.pty)) {
  describe(`terminal streams, ${twin.name}`, () => {
    it('has no pty, so it does not advertise pty-stream-v1 and refuses an open', async () => {
      const { ep, caps } = await link(await boot(twin))
      expect(caps).toContain('port-stream-v1')
      expect(caps).not.toContain('pty-stream-v1')
      await expect(ep.openPty('echo no', { cols: 80, rows: 24 })).rejects.toThrow(/no pty/)
    }, 90_000)
  })
}

describe('pty-stream-v1 wiring in both twins', () => {
  const read = (p: string) => fs.readFileSync(path.resolve(__dirname, '../..', p), 'utf8')
  const twins = { standalone: read('src/providers/daemon-standalone.ts'), source: read('src/providers/daemon-source.ts') }

  it('each twin opens a terminal only for its own server socket, routes stream.resize to the relay, and hands it the pty streams', () => {
    for (const src of Object.values(twins)) {
      const at = src.indexOf("if (cmd.to === 'pty')")
      expect(at).toBeGreaterThan(-1)
      const branch = src.slice(at, at + 400)
      expect(branch.indexOf('isServerClient(ws)')).toBeGreaterThan(-1)
      expect(branch.indexOf('isServerClient(ws)')).toBeLessThan(branch.indexOf('streamRelay.openPty('))
      expect(src.match(/streamRelay\.openPty\(/g)).toHaveLength(1)
      expect(src).toContain("case 'stream.resize':")
      expect(src).toMatch(/ptys: ptyStreams/)
    }
  })
})
