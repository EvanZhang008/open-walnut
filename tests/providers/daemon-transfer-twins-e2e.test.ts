/**
 * fs.writePart, transfer.pack, transfer.reach and host.facts on BOTH daemon
 * twins booted for real (the JS source twin on node, the standalone twin on bun
 * when bun is installed): the command reaches its core and the reply, including
 * a refusal's code and extra fields, comes back in the wire shape the server
 * client reads.
 *
 * MACHINE SAFETY: HOME, the daemon dir and the streams dir are temp paths, no
 * command makes a network call (host.facts runs with network:false, reach is
 * refused before ssh runs), and the daemon is SIGKILLed after each twin.
 */
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { WebSocket } from 'ws'
import { spawn, spawnSync, execFileSync, type ChildProcess } from 'node:child_process'
import * as crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { getDaemonSource } from '../../src/providers/daemon-source.js'
import { gitChildEnv } from '../../src/lib/git-env.js'
import { guardedPath } from '../setup/exec-guard.js'

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-transfer-twins-')))
afterAll(() => { if (root.includes('walnut-transfer-twins-')) fs.rmSync(root, { recursive: true, force: true }) })
const scriptPath = path.join(root, 'daemon.cjs')
fs.writeFileSync(scriptPath, getDaemonSource(), { mode: 0o755 })
const BUN = [process.env.BUN_INSTALL && path.join(process.env.BUN_INSTALL, 'bin/bun'), path.join(os.homedir(), '.bun/bin/bun'), '/opt/homebrew/bin/bun', '/usr/local/bin/bun']
  .find((p): p is string => !!p && fs.existsSync(p))
const STANDALONE = path.resolve(__dirname, '../../src/providers/daemon-standalone.ts')
// The source twin finds task directories through its sidecar, as deployed next to it.
if (BUN) {
  const built = spawnSync(BUN, ['build', '--target=node', '--format=cjs', '--outfile', path.join(root, 'task-dir-core.cjs'),
    path.resolve(__dirname, '../../src/providers/task-dir-core.ts')], { encoding: 'utf8' })
  if (built.status !== 0) throw new Error('sidecar build failed: ' + built.stderr)
}
const TWINS: Array<{ name: string; command: () => [string, string[]] }> = [
  { name: 'source twin (node)', command: () => [process.execPath, [scriptPath, '--start']] },
  ...(BUN ? [{ name: 'standalone twin (bun)', command: (): [string, string[]] => [BUN, [STANDALONE, '--start']] }] : []),
]

let proc: ChildProcess | null = null
let ws: WebSocket | null = null
let rpcId = 1
afterEach(async () => {
  try { ws?.close() } catch { /* closed */ }
  ws = null
  if (proc && proc.exitCode === null && proc.signalCode === null) {
    const exited = new Promise<void>((r) => { const t = setTimeout(r, 10_000); proc!.once('exit', () => { clearTimeout(t); r() }) })
    proc.kill('SIGKILL')
    await exited
  }
  proc = null
})

async function boot(twin: (typeof TWINS)[number], dir: string): Promise<string> {
  const home = path.join(dir, 'home')
  fs.mkdirSync(home, { recursive: true })
  const env: Record<string, string | undefined> = {
    // The exec guard's dir leads, so a stray ssh/scp is caught, never the real one.
    ...process.env, SHELL: '/bin/sh', PATH: guardedPath([], '/usr/bin:/bin'), HOME: home, WALNUT_HOME_OVERRIDE: home,
    WALNUT_DAEMON_DIR: path.join(dir, 'daemon'), WALNUT_STREAMS_DIR: path.join(dir, 'streams'),
    WALNUT_LEGACY_STREAMS_DIR: path.join(dir, 'no-legacy'), WALNUT_SPAWN_JOURNAL: path.join(dir, 'spawn-journal.jsonl'),
    WALNUT_TASK_DIR_ROOT: path.join(dir, 'state', 'tasks'),
  }
  for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE']) delete env[k]
  const [cmd, args] = twin.command()
  proc = spawn(cmd, args, { env, stdio: ['ignore', 'pipe', 'pipe'] })
  const port = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('daemon spawn timeout')), 30_000)
    proc!.stdout?.on('data', (chunk) => {
      const m = chunk.toString().trim().match(/^\d+$/m)
      if (m) { clearTimeout(timer); resolve(parseInt(m[0], 10)) }
    })
    proc!.on('exit', (code) => { clearTimeout(timer); reject(new Error('daemon exited early: ' + code)) })
  })
  ws = await new Promise<WebSocket>((resolve, reject) => {
    const s = new WebSocket(`ws://127.0.0.1:${port}`)
    s.on('open', () => resolve(s))
    s.on('error', reject)
  })
  return home
}

function rpc(cmd: Record<string, unknown>, timeoutMs = 60_000): Promise<Record<string, unknown>> {
  const id = rpcId++
  const sock = ws!
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('rpc timeout: ' + String(cmd.cmd))), timeoutMs)
    const onMessage = (data: Buffer) => {
      let msg: Record<string, unknown>
      try { msg = JSON.parse(data.toString()) } catch { return }
      if (msg.id === id) { clearTimeout(timer); sock.off('message', onMessage); resolve(msg) }
    }
    sock.on('message', onMessage)
    sock.send(JSON.stringify({ id, ...cmd }))
  })
}

describe.each(TWINS)('$name', (twin) => {
  it('answers the transfer family and host.facts', async () => {
    const dir = path.join(root, twin.name.replace(/\W+/g, '-'))
    const home = await boot(twin, dir)

    const facts = await rpc({ cmd: 'host.facts', network: false })
    expect(facts.ok).toBe(true)
    expect(facts).toMatchObject({ os: { platform: process.platform }, home, cloud: null, internet: null })
    expect(Object.keys(facts.tools as object)).toContain('git')

    const body = crypto.randomBytes(3000)
    const sha = crypto.createHash('sha256').update(body).digest('hex')
    expect(await rpc({ cmd: 'fs.writePart', path: '~/in/f.bin', offset: 0, data: body.subarray(0, 1000).toString('base64') }))
      .toMatchObject({ ok: true, staged: 1000 })
    expect(await rpc({ cmd: 'fs.writePart', path: '~/in/f.bin', offset: 2000, data: body.subarray(2000).toString('base64') }))
      .toMatchObject({ ok: false, code: 'gap', have: 1000, error: expect.stringMatching(/^fs\.writePart failed: /) })
    expect(await rpc({ cmd: 'fs.writePart', path: '~/in/f.bin', offset: 1000, data: body.subarray(1000).toString('base64'), final: true, size: 3000, sha256: sha }))
      .toMatchObject({ ok: true, staged: 3000, done: true, sha256: sha })
    expect(fs.readFileSync(path.join(home, 'in', 'f.bin')).equals(body)).toBe(true)

    const repo = path.join(dir, 'repo')
    fs.mkdirSync(repo)
    const genv = gitChildEnv({ HOME: home, GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@example.com' })
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo, env: genv })
    fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n')
    execFileSync('git', ['add', '-A'], { cwd: repo, env: genv })
    execFileSync('git', ['commit', '-q', '-m', 'one'], { cwd: repo, env: genv })
    fs.writeFileSync(path.join(repo, 'a.txt'), 'b\n')
    const packed = await rpc({ cmd: 'transfer.pack', cwd: repo, outDir: path.join(dir, 'out') })
    expect(packed.ok, String(packed.error)).toBe(true)
    expect((packed.files as Array<{ name: string }>).map((f) => f.name)).toEqual(['meta.json', 'changes.patch', 'repo.bundle'])
    expect(packed.meta).toMatchObject({ kind: 'git', branch: 'main', dirty: true, bundle: {} })
    expect(await rpc({ cmd: 'transfer.pack', cwd: repo, outDir: path.join(repo, 'out') })).toMatchObject({ ok: false, code: 'bad_request' })

    expect(await rpc({ cmd: 'transfer.reach', host: '-oProxyCommand=evil' })).toMatchObject({ ok: false, code: 'bad_request' })
    expect(await rpc({ cmd: 'transfer.fetch', host: 'a', files: [{ remotePath: '/x y', localPath: '/tmp/x' }] })).toMatchObject({ ok: false, code: 'bad_request' })
  }, 120_000)

  it('upload.part files a session upload under its task directory, made by the first chunk only', async () => {
    const dir = path.join(root, twin.name.replace(/\W+/g, '-') + '-upload')
    await boot(twin, dir)
    const body = crypto.randomBytes(3000)
    const sha = crypto.createHash('sha256').update(body).digest('hex')
    const up = 'up-11111111-2222-3333-4444-555555555555'
    const part = (offset: number, end: number, extra: Record<string, unknown> = {}) => rpc({
      cmd: 'upload.part', uploadId: up, name: 'clip.mov', size: body.length, offset,
      data: body.subarray(offset, end).toString('base64'), sessionId: 'not-a-session-here', taskId: 'task-upl-1', ...extra,
    })
    expect(await part(0, 1000)).toMatchObject({ ok: true, staged: 1000 })
    // Without bun there is no sidecar, and the source twin has no task directories.
    const taskDirs = !!BUN
    const fallback = taskDirs ? path.join(dir, 'state', 'uploads') : path.join(dir, 'daemon', 'uploads')
    const taskDir = taskDirs ? path.join(dir, 'state', 'tasks', 'task-upl-1') : path.dirname(fallback)
    const target = taskDirs ? path.join(taskDir, 'uploads', up, 'clip.mov') : path.join(fallback, up, 'clip.mov')
    expect(await part(1000, 3000, { sha256: sha })).toMatchObject({ ok: true, staged: 3000, done: true, path: target })
    expect(fs.readFileSync(target).equals(body)).toBe(true)
    // A refusal keeps its code; a later chunk for a task with no directory never makes one.
    expect(await rpc({ cmd: 'upload.part', uploadId: up, name: '../x', size: 1, offset: 0, data: 'eA==' })).toMatchObject({ ok: false, code: 'bad_request' })
    expect(await rpc({ cmd: 'upload.part', uploadId: up, name: 'late.bin', size: 9, offset: 3, data: 'eA==', taskId: 'task-upl-2' }))
      .toMatchObject({ ok: false, code: 'gap' })
    expect(fs.existsSync(path.join(dir, 'state', 'tasks', 'task-upl-2'))).toBe(false)
    // No task at all: a durable folder beside the task directories, never the daemon's temp dir.
    expect(await rpc({ cmd: 'upload.part', uploadId: up, name: 'loose.txt', size: 5, offset: 0, data: Buffer.from('hello').toString('base64') }))
      .toMatchObject({ ok: true, done: true, path: path.join(fallback, up, 'loose.txt') })
  }, 120_000)
})
