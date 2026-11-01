/**
 * secrets.* (secrets-v1, src/providers/secrets-core.ts) on BOTH daemon twins
 * booted for real: a value lands as a 0600 file in a 0700 dir, a list carries
 * names and versions and never a value, an older version is refused, sync
 * removes what the Mac no longer shares here, and a session started on the
 * host gets WALNUT_SECRETS_DIR plus the env var of each secret the user let
 * sessions have, and nothing of one they did not.
 *
 * MACHINE SAFETY: HOME, the daemon dir and the secrets root are temp paths; the
 * "CLI" is /bin/sh writing its env to a file; every process is killed after.
 */
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { WebSocket } from 'ws'
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { getDaemonSource } from '../../src/providers/daemon-source.js'
import { guardedPath } from '../setup/exec-guard.js'
import { testBun } from '../helpers/bun-runtime.js'
import { SOURCE_TWIN } from '../helpers/source-twin.js'
import { onDaemonEarlyExit } from '../helpers/daemon-early-exit.js'

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-secrets-twins-')))
afterAll(() => { if (root.includes('walnut-secrets-twins-')) fs.rmSync(root, { recursive: true, force: true }) })
const scriptPath = path.join(root, 'daemon.cjs')
fs.writeFileSync(scriptPath, getDaemonSource(), { mode: 0o755 })
const BUN: string | undefined = testBun()
const STANDALONE = path.resolve(__dirname, '../../src/providers/daemon-standalone.ts')
// The source twin finds both sidecars next to it, as deployed.
if (BUN) {
  for (const name of ['task-dir-core', 'secrets-core']) {
    const built = spawnSync(BUN, ['build', '--target=node', '--format=cjs', '--outfile', path.join(root, `${name}.cjs`),
      path.resolve(__dirname, `../../src/providers/${name}.ts`)], { encoding: 'utf8' })
    if (built.status !== 0) throw new Error('sidecar build failed: ' + built.stderr)
  }
}
const TWINS: Array<{ name: string; command: () => [string, string[]] }> = [
  { name: `source twin (${SOURCE_TWIN.runtime})`, command: () => [SOURCE_TWIN.file, [scriptPath, '--start']] },
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
    WALNUT_SECRETS_DIR_ROOT: path.join(dir, 'state', 'open-walnut', 'secrets'),
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
    onDaemonEarlyExit(proc!, { daemonDir: env.WALNUT_DAEMON_DIR }, (err) => { clearTimeout(timer); reject(err) })
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

const started: number[] = []
afterEach(() => {
  for (const pid of started.splice(0)) { try { process.kill(-pid, 'SIGKILL') } catch { /* gone */ } }
})

async function waitFile(file: string, ms = 15_000): Promise<string> {
  const until = Date.now() + ms
  while (Date.now() < until) {
    if (fs.existsSync(file)) { const t = fs.readFileSync(file, 'utf8'); if (t.includes('END')) return t }
    await new Promise((r) => setTimeout(r, 50))
  }
  throw new Error('no file ' + file)
}

describe.each(TWINS)('$name', (twin) => {
  it('keeps the shared secrets 0600, lists no value, syncs revokes, and hands sessions their env', async () => {
    const dir = path.join(root, twin.name.replace(/\W+/g, '-'))
    await boot(twin, dir)
    const secrets = path.join(dir, 'state', 'open-walnut', 'secrets')
    const hello = await rpc({ cmd: 'hello' })
    expect(hello.capabilities as string[]).toContain('secrets-v1')

    const value = 'example-value-' + 'x'.repeat(20)
    expect(await rpc({ cmd: 'secrets.put', name: 'github-read', version: 1, value, env: 'GH_TOKEN', sessions: true }))
      .toMatchObject({ ok: true, name: 'github-read', version: 1, env: 'GH_TOKEN', sessions: true })
    expect(await rpc({ cmd: 'secrets.put', name: 'deploy-key', version: 3, value: 'second-value' })).toMatchObject({ ok: true, version: 3 })
    expect(fs.readFileSync(path.join(secrets, 'github-read'), 'utf8')).toBe(value)
    expect(fs.statSync(secrets).mode & 0o777).toBe(0o700)
    expect(fs.statSync(path.join(secrets, 'github-read')).mode & 0o777).toBe(0o600)
    expect(fs.statSync(path.join(secrets, '.index.json')).mode & 0o777).toBe(0o600)
    expect(fs.readFileSync(path.join(secrets, '.index.json'), 'utf8')).not.toContain(value)

    const listed = await rpc({ cmd: 'secrets.list' })
    expect(listed).toMatchObject({ ok: true, root: secrets })
    expect((listed.secrets as Array<{ name: string }>).map((s) => s.name)).toEqual(['deploy-key', 'github-read'])
    expect(JSON.stringify(listed)).not.toContain(value)

    // A stale write never replaces a newer copy; bad names and env names are refused by name.
    expect(await rpc({ cmd: 'secrets.put', name: 'deploy-key', version: 2, value: 'older' })).toMatchObject({ ok: false, code: 'stale_version' })
    // The file viewer (and so a paired phone or the cloud bridge) never reads a copy, nor moves one.
    const peek = await rpc({ cmd: 'fs.readBounded', path: path.join(secrets, 'github-read') })
    expect(peek).toMatchObject({ ok: false })
    expect(JSON.stringify(peek)).not.toContain(value)
    expect(await rpc({ cmd: 'secrets.put', name: '../escape', version: 1, value: 'x' })).toMatchObject({ ok: false, code: 'bad_name' })
    const reserved = await rpc({ cmd: 'secrets.put', name: 'pathy', version: 1, value: 'x', env: 'PATH', sessions: true })
    expect(reserved).toMatchObject({ ok: false, code: 'bad_env' })
    expect(String(reserved.error)).not.toContain('x\n')

    // A session started here: WALNUT_SECRETS_DIR, GH_TOKEN, and nothing of the secret without sessions.
    const seen = path.join(dir, 'seen.txt')
    const script = `printf '%s|%s|%s|END' "\${WALNUT_SECRETS_DIR-unset}" "\${GH_TOKEN-unset}" "$(env | grep -c second-value)" > '${seen}'; exec /bin/sleep 60`
    const reply = await rpc({ cmd: 'start', sid: 'secrets-session-1', args: ['/bin/sh', '-c', script], cwd: dir, message: 'init\n' })
    expect(reply.ok, JSON.stringify(reply)).toBe(true)
    const pid = Number((reply as { pid?: unknown }).pid ?? (reply as { result?: { pid?: unknown } }).result?.pid)
    if (pid > 1) started.push(pid)
    expect(await waitFile(seen)).toBe(`${secrets}|${value}|0|END`)

    // The Mac stopped sharing deploy-key with this host while it was away: sync removes it.
    expect(await rpc({ cmd: 'secrets.sync', keep: ['github-read'] })).toMatchObject({ ok: true, removed: ['deploy-key'] })
    expect(fs.existsSync(path.join(secrets, 'deploy-key'))).toBe(false)
    expect(await rpc({ cmd: 'secrets.remove', name: 'github-read' })).toMatchObject({ ok: true, removed: true })
    expect(((await rpc({ cmd: 'secrets.list' })).secrets as unknown[])).toEqual([])
  }, 90_000)
})
