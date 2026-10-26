/**
 * The one-shot family (oneshot-v1, oneshot-core.ts) on BOTH daemon twins booted
 * for real (the JS source twin on node, the standalone twin on bun when bun is
 * installed): a text-mode run streams its lines and exit, a warm key hands the
 * pre-booted child (and its boot lines) to the run and boots a replacement, a
 * stream-json run ends at its result line, cancel signals the child, a closed
 * socket ends its runs, and a spawn that fails arrives as an exit with an error.
 *
 * MACHINE SAFETY: HOME, the daemon dir and the streams dir are temp paths; the
 * only program the daemon starts is the test's fake CLI (process.execPath plus
 * tests/helpers/oneshot-fake-claude.cjs), never `claude`; every daemon is
 * SIGKILLed after its twin, and every child it ran is checked gone.
 */
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { WebSocket } from 'ws'
import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { getDaemonSource } from '../../src/providers/daemon-source.js'
import { guardedPath } from '../setup/exec-guard.js'

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-oneshot-twins-')))
afterAll(() => { if (root.includes('walnut-oneshot-twins-')) fs.rmSync(root, { recursive: true, force: true }) })
const scriptPath = path.join(root, 'daemon.cjs')
fs.writeFileSync(scriptPath, getDaemonSource(), { mode: 0o755 })
const FAKE = path.resolve(__dirname, '../helpers/oneshot-fake-claude.cjs')
const BUN = [process.env.BUN_INSTALL && path.join(process.env.BUN_INSTALL, 'bin/bun'), path.join(os.homedir(), '.bun/bin/bun'), '/opt/homebrew/bin/bun', '/usr/local/bin/bun']
  .find((p): p is string => !!p && fs.existsSync(p))
const STANDALONE = path.resolve(__dirname, '../../src/providers/daemon-standalone.ts')
const TWINS: Array<{ name: string; command: () => [string, string[]] }> = [
  { name: 'source twin (node)', command: () => [process.execPath, [scriptPath, '--start']] },
  ...(BUN ? [{ name: 'standalone twin (bun)', command: (): [string, string[]] => [BUN, [STANDALONE, '--start']] }] : []),
]

let proc: ChildProcess | null = null
let port = 0
const sockets: WebSocket[] = []
const childPids: number[] = []
afterEach(async () => {
  for (const s of sockets.splice(0)) { try { s.close() } catch { /* closed */ } }
  if (proc && proc.exitCode === null && proc.signalCode === null) {
    const exited = new Promise<void>((r) => { const t = setTimeout(r, 10_000); proc!.once('exit', () => { clearTimeout(t); r() }) })
    proc.kill('SIGKILL')
    await exited
  }
  proc = null
  // Nothing the daemon ran may outlive the test (the source twin kills its runs and pool on exit;
  // a SIGKILLed daemon cannot, so the fake children end on their stdin closing).
  for (const pid of childPids.splice(0)) {
    await waitFor(() => !isAlive(pid), 10_000).catch(() => { try { process.kill(pid, 'SIGKILL') } catch { /* gone */ } })
  }
})

function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch { return false }
}

async function waitFor(check: () => boolean, ms: number): Promise<void> {
  const until = Date.now() + ms
  while (!check()) {
    if (Date.now() > until) throw new Error('condition not met in ' + ms + 'ms')
    await new Promise((r) => setTimeout(r, 50))
  }
}

async function boot(twin: (typeof TWINS)[number], dir: string): Promise<void> {
  const home = path.join(dir, 'home')
  fs.mkdirSync(home, { recursive: true })
  const env: Record<string, string | undefined> = {
    ...process.env, SHELL: '/bin/sh', PATH: guardedPath([], '/usr/bin:/bin'), HOME: home, WALNUT_HOME_OVERRIDE: home,
    WALNUT_DAEMON_DIR: path.join(dir, 'daemon'), WALNUT_STREAMS_DIR: path.join(dir, 'streams'),
    WALNUT_LEGACY_STREAMS_DIR: path.join(dir, 'no-legacy'), WALNUT_SPAWN_JOURNAL: path.join(dir, 'spawn-journal.jsonl'),
  }
  const [cmd, args] = twin.command()
  proc = spawn(cmd, args, { env, stdio: ['ignore', 'pipe', 'pipe'] })
  port = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('daemon spawn timeout')), 30_000)
    proc!.stdout?.on('data', (chunk) => {
      const m = chunk.toString().trim().match(/^\d+$/m)
      if (m) { clearTimeout(timer); resolve(parseInt(m[0], 10)) }
    })
    proc!.on('exit', (code) => { clearTimeout(timer); reject(new Error('daemon exited early: ' + code)) })
  })
}

interface Client {
  ws: WebSocket
  rpc(cmd: Record<string, unknown>): Promise<Record<string, unknown>>
  /** Every oneshot.* event for a run, in order. */
  events(runId: string): Array<Record<string, unknown>>
  exit(runId: string, ms?: number): Promise<Record<string, unknown>>
}

async function client(): Promise<Client> {
  const ws = await new Promise<WebSocket>((resolve, reject) => {
    const s = new WebSocket(`ws://127.0.0.1:${port}`)
    s.on('open', () => resolve(s))
    s.on('error', reject)
  })
  sockets.push(ws)
  let id = 1
  const byRun = new Map<string, Array<Record<string, unknown>>>()
  ws.on('message', (data: Buffer) => {
    let msg: Record<string, unknown>
    try { msg = JSON.parse(data.toString()) } catch { return }
    if (typeof msg.ev === 'string' && msg.ev.startsWith('oneshot.')) {
      const list = byRun.get(String(msg.runId)) ?? []
      list.push(msg)
      byRun.set(String(msg.runId), list)
    }
  })
  return {
    ws,
    rpc: (cmd) => {
      const myId = id++
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('rpc timeout: ' + String(cmd.cmd))), 30_000)
        const onMessage = (data: Buffer) => {
          let msg: Record<string, unknown>
          try { msg = JSON.parse(data.toString()) } catch { return }
          if (msg.id === myId) { clearTimeout(timer); ws.off('message', onMessage); resolve(msg) }
        }
        ws.on('message', onMessage)
        ws.send(JSON.stringify({ id: myId, ...cmd }))
      })
    },
    events: (runId) => byRun.get(runId) ?? [],
    exit: async (runId, ms = 20_000) => {
      await waitFor(() => (byRun.get(runId) ?? []).some((e) => e.ev === 'oneshot.exit'), ms)
      return byRun.get(runId)!.find((e) => e.ev === 'oneshot.exit')!
    },
  }
}

const linesOf = (events: Array<Record<string, unknown>>) =>
  events.filter((e) => e.ev === 'oneshot.out').flatMap((e) => e.lines as string[])
const resultOf = (events: Array<Record<string, unknown>>) => {
  const line = linesOf(events).find((l) => l.includes('"type":"result"'))
  return line ? JSON.parse(line) as { result: string; total_cost_usd: number } : null
}
const infoOf = (result: string) => JSON.parse(result.slice(result.indexOf('{'))) as { pid: number; ppid: number; cwd: string; probe: string }

describe.each(TWINS)('$name', (twin) => {
  it('runs text-mode and warm stream-json children, cancels, and ends runs with their socket', async () => {
    await boot(twin, path.join(root, twin.name.replace(/\W+/g, '-')))
    const c = await client()
    const daemonPid = proc!.pid!
    const cwd = fs.realpathSync(os.tmpdir())
    const env = { PATH: '/usr/bin:/bin', HOME: os.homedir(), ONESHOT_PROBE: 'probe-é中' }

    // Text mode: the prompt on stdin, closed after it; env and cwd are the caller's.
    const text = await c.rpc({ cmd: 'oneshot.run', runId: 't1', command: process.execPath, args: [FAKE, '-p'], cwd, env, input: 'hello 世界', endInput: true })
    expect(text).toMatchObject({ ok: true, runId: 't1', warm: false })
    const textExit = await c.exit('t1')
    expect(textExit).toMatchObject({ code: 0 })
    const textResult = resultOf(c.events('t1'))!
    expect(textResult.result.startsWith('reply:hello 世界')).toBe(true)
    expect(textResult.total_cost_usd).toBe(0.0123)
    const textInfo = infoOf(textResult.result)
    expect(textInfo).toMatchObject({ ppid: daemonPid, cwd, probe: 'probe-é中' })
    expect(c.events('t1').some((e) => e.ev === 'oneshot.err' && String(e.text).includes('fake-claude warn'))).toBe(true)
    childPids.push(textInfo.pid)

    // Warm: a pre-booted child is taken, its boot (init) line replayed first,
    // stdin ends at the result line, and a replacement boots for the next run.
    const spec = { command: process.execPath, args: [FAKE, '-p', '--input-format', 'stream-json'], cwd, env, warmKey: 'k1' }
    expect(await c.rpc({ cmd: 'oneshot.prewarm', ...spec })).toMatchObject({ ok: true, warm: 'spawned' })
    expect(await c.rpc({ cmd: 'oneshot.prewarm', ...spec })).toMatchObject({ ok: true, warm: 'kept' })
    await new Promise((r) => setTimeout(r, 500)) // let it print its init line
    const msg = (content: string) => JSON.stringify({ type: 'user', message: { role: 'user', content } }) + '\n'
    const w1 = await c.rpc({ cmd: 'oneshot.run', runId: 'w1', ...spec, input: msg('first'), endOnResult: true })
    expect(w1).toMatchObject({ ok: true, warm: true })
    expect(await c.exit('w1')).toMatchObject({ code: 0 })
    const w1Lines = linesOf(c.events('w1'))
    expect(JSON.parse(w1Lines[0])).toMatchObject({ type: 'system', subtype: 'init' })
    const w1Info = infoOf(resultOf(c.events('w1'))!.result)
    expect(w1Info.ppid).toBe(daemonPid)
    childPids.push(w1Info.pid)
    const w2 = await c.rpc({ cmd: 'oneshot.run', runId: 'w2', ...spec, input: msg('second'), endOnResult: true })
    expect(w2).toMatchObject({ ok: true, warm: true })
    expect(await c.exit('w2')).toMatchObject({ code: 0 })
    const w2Info = infoOf(resultOf(c.events('w2'))!.result)
    expect(w2Info.pid).not.toBe(w1Info.pid) // single-use: the replacement answered
    childPids.push(w2Info.pid)
    // Another key is a cold spawn.
    const cold = await c.rpc({ cmd: 'oneshot.run', runId: 'c1', ...spec, warmKey: 'k2', input: msg('cold'), endOnResult: true })
    expect(cold).toMatchObject({ ok: true, warm: false })
    expect(await c.exit('c1')).toMatchObject({ code: 0 })

    // Cancel signals the child; the exit names the signal.
    const hang = await c.rpc({ cmd: 'oneshot.run', runId: 'h1', command: process.execPath, args: [FAKE, '-p'], cwd, env, input: 'hang', endInput: true })
    expect(hang.ok).toBe(true)
    childPids.push(hang.pid as number)
    expect(await c.rpc({ cmd: 'oneshot.cancel', runId: 'h1', signal: 'SIGTERM' })).toMatchObject({ ok: true, found: true })
    expect(await c.exit('h1')).toMatchObject({ code: null, signal: 'SIGTERM' })
    expect(await c.rpc({ cmd: 'oneshot.cancel', runId: 'h1' })).toMatchObject({ ok: true, found: false })

    // A crash reports its code; a missing program reports an error.
    await c.rpc({ cmd: 'oneshot.run', runId: 'x1', command: process.execPath, args: [FAKE, '-p'], cwd, env, input: 'crash', endInput: true })
    expect(await c.exit('x1')).toMatchObject({ code: 3 })
    const missing = await c.rpc({ cmd: 'oneshot.run', runId: 'm1', command: path.join(root, 'no-such-claude'), args: [], cwd, env, endInput: true })
    if (missing.ok) expect(String((await c.exit('m1')).error)).toMatch(/ENOENT|no such file|not found/i)
    else expect(String(missing.error)).toMatch(/oneshot\.run failed/)

    // Refusals: no runId, a duplicate runId, no command.
    expect(await c.rpc({ cmd: 'oneshot.run', command: process.execPath })).toMatchObject({ ok: false, error: expect.stringMatching(/runId is required/) })
    expect(await c.rpc({ cmd: 'oneshot.run', runId: 'n1' })).toMatchObject({ ok: false, error: expect.stringMatching(/command is required/) })

    // A socket that closes takes its runs with it; another socket's run is untouched.
    const other = await client()
    const orphan = await other.rpc({ cmd: 'oneshot.run', runId: 'o1', command: process.execPath, args: [FAKE, '-p'], cwd, env, input: 'hang', endInput: true })
    const kept = await c.rpc({ cmd: 'oneshot.run', runId: 'k1', command: process.execPath, args: [FAKE, '-p'], cwd, env, input: 'hang', endInput: true })
    childPids.push(orphan.pid as number, kept.pid as number)
    await waitFor(() => isAlive(orphan.pid as number), 5_000)
    other.ws.close()
    await waitFor(() => !isAlive(orphan.pid as number), 10_000)
    expect(isAlive(kept.pid as number)).toBe(true)
    await c.rpc({ cmd: 'oneshot.cancel', runId: 'k1', signal: 'SIGKILL' })
    expect(await c.exit('k1')).toMatchObject({ signal: 'SIGKILL' })
  }, 120_000)
})
