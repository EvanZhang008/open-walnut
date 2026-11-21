/**
 * A real session daemon (the standalone twin, run by bun from its source, as the binary daemon a
 * host runs is built from it) on this machine, and a link to it in the shape the server's
 * DaemonConnection has: for the remote standby e2e and its bench (scripts/standby-bench.ts).
 *
 * Hermetic: HOME, the daemon's dir, its streams and its Walnut home are temp paths under `dir`.
 * The link fails like the server's: a closed socket is `lost`, no socket is `no-link`, a command
 * past its deadline is `no-answer` (src/providers/link-failure.ts).
 */
import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { WebSocket } from 'ws'
import { markLinkFailure } from '../../../src/providers/link-failure.js'
import type { DaemonLink } from '../../../src/core/standby/remote-transport.js'

const STANDALONE = path.resolve(__dirname, '../../../src/providers/daemon-standalone.ts')

export interface StandbyTwin {
  /** The daemon's HOME and the Walnut home its children see (both must stay as they were). */
  home: string
  walnutHome: string
  connect(): Promise<DaemonLink>
  /** Close the socket under the link (the link drops; the daemon keeps running). */
  drop(): void
  /** SIGKILL the daemon; `start` boots it again on the same dirs. */
  kill(): Promise<void>
  start(): Promise<void>
  stop(): Promise<void>
}

export async function bootStandbyTwin(dir: string, bun: string): Promise<StandbyTwin> {
  const home = path.join(dir, 'home')
  const walnutHome = path.join(dir, 'walnut-home')
  fs.mkdirSync(home, { recursive: true })
  fs.mkdirSync(walnutHome, { recursive: true })
  const env: Record<string, string | undefined> = {
    ...process.env, SHELL: '/bin/sh', PATH: '/usr/bin:/bin', HOME: home, WALNUT_HOME_OVERRIDE: walnutHome,
    WALNUT_DAEMON_DIR: path.join(dir, 'daemon'), WALNUT_STREAMS_DIR: path.join(dir, 'streams'),
    WALNUT_LEGACY_STREAMS_DIR: path.join(dir, 'no-legacy'), WALNUT_SPAWN_JOURNAL: path.join(dir, 'spawn-journal.jsonl'),
    WALNUT_TASK_DIR_ROOT: path.join(dir, 'state', 'tasks'),
  }
  for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'WALNUT_SESSION_ID']) delete env[k]
  let proc: ChildProcess | null = null
  let port = 0
  let ws: WebSocket | null = null
  let rpcId = 1

  const start = async () => {
    proc = spawn(bun, [STANDALONE, '--start'], { env, stdio: ['ignore', 'pipe', 'pipe'] })
    port = await new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('daemon twin did not print its port within 60 s')), 60_000)
      proc!.stdout!.on('data', (chunk: Buffer) => {
        const m = chunk.toString().trim().match(/^\d+$/m)
        if (m) { clearTimeout(timer); resolve(parseInt(m[0], 10)) }
      })
      proc!.once('exit', (code) => { clearTimeout(timer); reject(new Error(`daemon twin exited early (code ${code})`)) })
    })
  }
  const kill = async () => {
    const p = proc
    proc = null
    ws?.terminate()
    ws = null
    if (!p || p.exitCode !== null || p.signalCode !== null) return
    const exited = new Promise<void>((r) => { const t = setTimeout(r, 10_000); p.once('exit', () => { clearTimeout(t); r() }) })
    p.kill('SIGKILL')
    await exited
  }
  await start()

  const open = () => new Promise<WebSocket>((resolve, reject) => {
    const s = new WebSocket(`ws://127.0.0.1:${port}`, { maxPayload: 64 * 1024 * 1024 })
    s.once('open', () => resolve(s))
    s.once('error', (err) => reject(markLinkFailure(err, 'no-link')))
  })
  const link = (sock: WebSocket): DaemonLink => ({
    send(cmd, params = {}, timeoutMs = 30_000) {
      if (sock.readyState !== WebSocket.OPEN) return Promise.reject(markLinkFailure(new Error('no link to the daemon'), 'no-link'))
      const id = rpcId++
      return new Promise((resolve, reject) => {
        const done = () => { clearTimeout(timer); sock.off('message', onMessage); sock.off('close', onClose) }
        const timer = setTimeout(() => { done(); reject(markLinkFailure(new Error(`${cmd}: no answer`), 'no-answer')) }, timeoutMs)
        const onMessage = (data: Buffer) => {
          let msg: Record<string, unknown>
          try { msg = JSON.parse(data.toString()) as Record<string, unknown> } catch { return }
          if (msg.id === id) { done(); resolve(msg) }
        }
        const onClose = () => { done(); reject(markLinkFailure(new Error(`${cmd}: the link went`), 'lost')) }
        sock.on('message', onMessage)
        sock.once('close', onClose)
        sock.send(JSON.stringify({ id, cmd, ...params }))
      })
    },
  })

  return {
    home,
    walnutHome,
    async connect() {
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        if (!proc) throw markLinkFailure(new Error('the daemon is not running'), 'no-link')
        ws = await open()
      }
      return link(ws)
    },
    drop() { ws?.terminate() },
    kill,
    start,
    stop: kill,
  }
}
