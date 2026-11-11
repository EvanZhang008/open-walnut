/**
 * history.readyView answered by real daemons, all three ways a host runs one: the source twin
 * (daemon.cjs + its history-ready-core.cjs sidecar, the sidecar also being the worker), the
 * standalone twin run from source by bun, and the standalone twin compiled the way
 * scripts/build-daemon.sh compiles it (two entries: the daemon and history-ready-worker.ts, so
 * the worker sits at /$bunfs/root/history-ready-worker.ts). Each must answer `ready` from its
 * worker thread, never `none no-worker`, with this build's parser version, and a rewound
 * session without its abandoned branch.
 *
 * MACHINE SAFETY: HOME, the daemon dir, the streams dir and the spawn journal are temp paths
 * made for this run; no CLI is started; nothing is read from or written to the real ~/.claude.
 * The ONLY signals this suite sends go to the daemon child IT spawned, by that child's own
 * handle, in afterEach: SIGTERM, then SIGKILL only if it has not exited within 10 s (no
 * pattern, no pid read from anywhere).
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import { WebSocket } from 'ws'
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import zlib from 'node:zlib'
import { getDaemonSource } from '../../src/providers/daemon-source.js'
import { encodeProjectPathCore } from '../../src/providers/session-changes-core.js'
import { HISTORY_PARSER_VERSION } from '../../src/core/history-parser-version.js'
import { testBun } from '../helpers/bun-runtime.js'
import { SOURCE_TWIN } from '../helpers/source-twin.js'
import { onDaemonEarlyExit } from '../helpers/daemon-early-exit.js'
import { guardedPath } from '../setup/exec-guard.js'
import { transcript, cutHere } from '../helpers/transcript-fixtures.js'

const BUN: string | undefined = testBun()
const REPO = path.resolve(__dirname, '../..')
const STANDALONE = path.join(REPO, 'src/providers/daemon-standalone.ts')
const WORKER = path.join(REPO, 'src/providers/history-ready-worker.ts')
const CORE = path.join(REPO, 'src/providers/history-ready-core.ts')
let buildDir = ''

type Twin = { name: string; command: () => [string, string[]] }
const TWINS: Twin[] = BUN ? [
  { name: `source twin (${SOURCE_TWIN.runtime})`, command: () => [SOURCE_TWIN.file, [path.join(buildDir, 'daemon.cjs'), '--start']] },
  { name: 'standalone twin (bun, from source)', command: () => [BUN, [STANDALONE, '--start']] },
  { name: 'standalone twin (compiled, two entries)', command: () => [path.join(buildDir, 'daemon-compiled'), ['--start']] },
] : []

let root = ''
let proc: ChildProcess | null = null
let ws: WebSocket | null = null
let rpcId = 1

beforeAll(() => {
  if (!BUN) return
  buildDir = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-ready-twins-build-'))
  fs.writeFileSync(path.join(buildDir, 'daemon.cjs'), getDaemonSource())
  // The sidecar the source twin requires, and starts as its worker, as build-daemon.sh makes it.
  const sidecar = spawnSync(BUN, ['build', '--target=node', '--format=cjs', '--outfile', path.join(buildDir, 'history-ready-core.cjs'), CORE], { encoding: 'utf8' })
  if (sidecar.status !== 0) throw new Error('sidecar build failed: ' + sidecar.stderr)
  // The binary, compiled with its worker entry beside it (build-daemon.sh's compile line).
  const compiled = spawnSync(BUN, ['build', '--compile', '--outfile', path.join(buildDir, 'daemon-compiled'), STANDALONE, WORKER], { encoding: 'utf8', cwd: REPO })
  if (compiled.status !== 0) throw new Error('daemon compile failed: ' + compiled.stderr)
}, 180_000)

afterAll(() => { if (buildDir.includes('walnut-ready-twins-build-')) fs.rmSync(buildDir, { recursive: true, force: true }) })

afterEach(async () => {
  try { ws?.close() } catch { /* already closed */ }
  ws = null
  // The child this suite spawned, by its own handle: SIGTERM and wait for its exit; SIGKILL
  // only when it has not exited in 10 s. Never a pattern, never a pid from anywhere else.
  const child = proc
  if (child && child.exitCode === null && child.signalCode === null) {
    const exited = (ms: number) => new Promise<boolean>((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) { resolve(true); return }
      const t = setTimeout(() => resolve(false), ms)
      child.once('exit', () => { clearTimeout(t); resolve(true) })
    })
    child.kill('SIGTERM')
    if (!(await exited(10_000))) { child.kill('SIGKILL'); await exited(10_000) }
  }
  proc = null
  if (root.includes('walnut-ready-twins-')) fs.rmSync(root, { recursive: true, force: true })
})

async function boot(twin: Twin, home: string, daemonDir: string): Promise<void> {
  const env: Record<string, string | undefined> = {
    ...process.env,
    SHELL: '/bin/sh',
    PATH: guardedPath([], '/usr/bin:/bin'),
    HOME: home,
    CLAUDE_CONFIG_DIR: path.join(home, '.claude'),
    WALNUT_DAEMON_DIR: daemonDir,
    WALNUT_STREAMS_DIR: path.join(root, 'streams'),
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
    onDaemonEarlyExit(proc!, { daemonDir }, (err) => { clearTimeout(timer); reject(err) })
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

const rowsOf = (answer: Record<string, unknown>): string[] =>
  (JSON.parse(zlib.gunzipSync(Buffer.from(answer.rowsGz as string, 'base64')).toString('utf8')) as Array<{ text: string }>).map((r) => r.text)

describe.skipIf(TWINS.length === 0)('history.readyView from real daemons (all three builds)', () => {
  for (const twin of TWINS) {
    it(`${twin.name}: answers ready from its worker, rewound sessions filtered`, async () => {
      root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-ready-twins-')))
      const home = path.join(root, 'home')
      const daemonDir = path.join(root, 'daemon')
      const cwd = path.join(root, 'work')
      fs.mkdirSync(cwd, { recursive: true })
      const projectDir = path.join(home, '.claude', 'projects', encodeProjectPathCore(cwd))
      fs.mkdirSync(projectDir, { recursive: true })
      fs.writeFileSync(path.join(projectDir, 'ready-plain.jsonl'),
        transcript().user('u1', 'hello \u4e2d\u6587').assistant('a1', 'Hi there.').text())
      const t = transcript().user('u1', 'set it up').assistant('a1', 'done').user('u2', 'add a feature')
        .assistant('a2', 'ABANDONED reply').user('u3', 'ABANDONED ask')
      const cut = cutHere(t, 'u2')
      t.from('u2').user('u2b', 'a different feature').assistant('a2b', 'NEW reply')
      fs.writeFileSync(path.join(projectDir, 'ready-rewound.jsonl'), t.text())

      await boot(twin, home, daemonDir)
      const hello = await rpc({ cmd: 'hello' }).catch(() => ({} as Record<string, unknown>))
      if (Array.isArray(hello.capabilities)) expect(hello.capabilities).toContain('history-ready-v1')

      const plain = await rpc({ cmd: 'history.readyView', sid: 'ready-plain', cwd, budgetMs: 20_000 })
      expect(plain, JSON.stringify(plain)).toMatchObject({ ok: true, status: 'ready', parser: HISTORY_PARSER_VERSION, readable: true })
      expect(rowsOf(plain)).toEqual(['hello \u4e2d\u6587', 'Hi there.'])
      const same = await rpc({ cmd: 'history.readyView', sid: 'ready-plain', cwd, have: plain.key })
      expect(same).toMatchObject({ ok: true, status: 'unchanged', key: plain.key })

      const rewound = await rpc({ cmd: 'history.readyView', sid: 'ready-rewound', cwd, budgetMs: 20_000,
        cuts: [{ uuid: cut.uuid, lastUuidAtCommit: cut.lastUuidAtCommit }] })
      expect(rewound, JSON.stringify(rewound)).toMatchObject({ ok: true, status: 'ready' })
      const texts = rowsOf(rewound)
      expect(texts.some((x) => x.includes('ABANDONED'))).toBe(false)
      expect(texts).toContain('NEW reply')

      const keys = await rpc({ cmd: 'history.readyKeys', items: [{ sid: 'ready-plain', cwd }, { sid: 'ready-missing', cwd }] })
      expect(keys).toMatchObject({ ok: true, keys: { 'ready-plain': plain.key, 'ready-missing': null } })
    }, 90_000)
  }
})
