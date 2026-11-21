/**
 * The service's side of the launcher (src/providers/service-launcher-beat.ts):
 *  - ready only after the core flow answers over the daemon's own port (hello as itself, status of a
 *    session it adopted): a version that is up but answers every request wrong never writes ready, so
 *    the launcher's trial puts the version before it back (service-launcher-run.test.ts, never ready);
 *  - once a version is the good one, the staged versions it no longer needs go: kept are the current,
 *    the good, the one a pending switch asks for, any a process runs, and any staged in the last hour.
 */
import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, type ChildProcess } from 'node:child_process'
import { WebSocket, WebSocketServer } from 'ws'
import { askOwnPort, daemonServesCheck, launcherKeeps, startLauncherBeat } from '../../src/providers/service-launcher-beat.js'

const dirs: string[] = []
const servers: WebSocketServer[] = []
const children: ChildProcess[] = []
afterEach(async () => {
  for (const c of children.splice(0)) { try { c.kill('SIGKILL') } catch { /* gone */ } }
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(() => r(null)))))
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
})
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-beat-')); dirs.push(d); return d }

/** A daemon double on a real port: `answer` decides what each command gets back. */
async function daemonDouble(answer: (cmd: Record<string, unknown>) => Record<string, unknown>): Promise<number> {
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' })
  servers.push(wss)
  wss.on('connection', (ws) => ws.on('message', (raw) => {
    const cmd = JSON.parse(String(raw)) as Record<string, unknown>
    ws.send(JSON.stringify({ id: cmd.id, ...answer(cmd) }))
  }))
  await new Promise((r) => wss.once('listening', r))
  return (wss.address() as { port: number }).port
}
const right = (cmd: Record<string, unknown>) => cmd.cmd === 'hello'
  ? { ok: true, instanceId: 'inst-1', version: 'walnut-daemon-abc' }
  : { ok: true, exists: cmd.sid === 'adopted-1' }

describe('ready only after the core flow answers', () => {
  it('passes a daemon that answers as itself, and names what is wrong with one that does not', async () => {
    const ask = askOwnPort(await daemonDouble(right), WebSocket as never)
    expect(await daemonServesCheck(ask, { instanceId: 'inst-1', version: 'walnut-daemon-abc', sid: 'adopted-1' })).toBeNull()
    expect(await daemonServesCheck(ask, { instanceId: 'inst-1' })).toBeNull()
    expect(await daemonServesCheck(ask, { instanceId: 'inst-2' })).toMatch(/answered as instance inst-1, not inst-2/)
    expect(await daemonServesCheck(ask, { instanceId: 'inst-1', sid: 'lost-session' })).toMatch(/adopted session lost-session answered exists=false/)
    const wrong = askOwnPort(await daemonDouble(() => ({ ok: false, error: 'internal error' })), WebSocket as never)
    expect(await daemonServesCheck(wrong, { instanceId: 'inst-1' })).toMatch(/hello did not answer ok: internal error/)
    const silent = askOwnPort(await daemonDouble(() => ({})), WebSocket as never, 300)
    expect(await daemonServesCheck(silent, { instanceId: 'inst-1' })).toMatch(/hello did not answer ok/)
  })

  it('a version that is up but answers every request wrong never writes ready, and drops its busy claim', async () => {
    const dir = tmp()
    const ask = askOwnPort(await daemonDouble(() => ({ ok: false, error: 'broken' })), WebSocket as never)
    const warnings: string[] = []
    const beat = startLauncherBeat({ dir, everyMs: 50, warn: (m) => warnings.push(m) })!
    beat.busy(600)
    void beat.ready({ exe: '/x/daemon' }, () => daemonServesCheck(ask, { instanceId: 'inst-1' }))
    await new Promise((r) => setTimeout(r, 400))
    expect(fs.existsSync(path.join(dir, 'ready'))).toBe(false)
    expect(warnings.join('\n')).toMatch(/not ready for the launcher yet: hello did not answer ok: broken/)
    // Busy no more: the launcher's plain trial time applies to it.
    expect(fs.readFileSync(path.join(dir, 'heartbeat'), 'utf8').split(' ')[1]).toBe('0')
    beat.stop()
  })

  it('a version that answers right writes ready with its pid', async () => {
    const dir = tmp()
    const ask = askOwnPort(await daemonDouble(right), WebSocket as never)
    const beat = startLauncherBeat({ dir, everyMs: 50 })!
    await beat.ready({ exe: '/x/daemon', instance: 'inst-1' }, () => daemonServesCheck(ask, { instanceId: 'inst-1', sid: 'adopted-1' }))
    expect(fs.readFileSync(path.join(dir, 'ready'), 'utf8')).toMatch(new RegExp(`^pid=${process.pid}\\nexe=/x/daemon\\ninstance=inst-1\\n`))
    beat.stop()
  })
})

describe.skipIf(process.platform !== 'linux')('the staged versions once a version is the good one', () => {
  it('keeps the current, the good, the asked-for, a running one and a fresh one, and removes the rest', async () => {
    const root = tmp()
    const L = path.join(root, 'launcher')
    fs.mkdirSync(L)
    const v = (c: string) => path.join(root, 'versions', c.repeat(64), 'daemon')
    const old = Date.now() / 1000 - 2 * 3600
    for (const c of ['a', 'b', 'c', 'd', 'e', 'f']) {
      fs.mkdirSync(path.dirname(v(c)), { recursive: true, mode: 0o700 })
      fs.copyFileSync('/bin/sleep', v(c)); fs.chmodSync(v(c), 0o700)
      fs.writeFileSync(path.join(path.dirname(v(c)), 'pad'), Buffer.alloc(1024 * 1024))
      if (c !== 'e') fs.utimesSync(path.dirname(v(c)), old, old)
    }
    // f: a process runs it (a job the daemon started from it).
    const running = spawn(v('f'), ['30'], { stdio: 'ignore' }); children.push(running)
    const execs = () => { try { return fs.readlinkSync(`/proc/${running.pid}/exe`) === v('f') } catch { return false } }
    for (let i = 0; i < 50 && !execs(); i++) await new Promise((r) => setTimeout(r, 20))
    fs.writeFileSync(path.join(L, 'state'), `current=${v('a')}\ngood=${v('a')}\nphase=committed\nsince=1\n`)
    fs.writeFileSync(path.join(L, 'request'), `id=u1\nop=switch\nexe=${v('c')}\nprepared=0\n`)
    expect((await launcherKeeps(root)).sort()).toEqual([v('a'), v('a'), v('c')].sort())
    const du = () => fs.readdirSync(path.join(root, 'versions')).length
    expect(du()).toBe(6)
    const pruned: string[][] = []
    const beat = startLauncherBeat({ dir: L, everyMs: 1000, onPruned: (removed) => pruned.push(removed) })!
    for (let i = 0; i < 50 && pruned.length === 0; i++) await new Promise((r) => setTimeout(r, 100))
    beat.stop()
    expect(pruned).toHaveLength(1)
    expect(pruned[0]!.map((d) => path.basename(d)[0]).sort()).toEqual(['b', 'd'])
    expect(fs.readdirSync(path.join(root, 'versions')).map((d) => d[0]).sort()).toEqual(['a', 'c', 'e', 'f'])
  })

  it('removes nothing while a version is still on trial or in its probation', async () => {
    const root = tmp()
    const L = path.join(root, 'launcher')
    fs.mkdirSync(L)
    const v = (c: string) => path.join(root, 'versions', c.repeat(64), 'daemon')
    for (const c of ['a', 'b', 'x']) {
      fs.mkdirSync(path.dirname(v(c)), { recursive: true, mode: 0o700 }); fs.writeFileSync(v(c), '', { mode: 0o700 })
      fs.utimesSync(path.dirname(v(c)), 1, 1)
    }
    fs.writeFileSync(path.join(L, 'state'), `current=${v('b')}\ngood=${v('a')}\nphase=probation\nsince=1\n`)
    const pruned: string[][] = []
    const beat = startLauncherBeat({ dir: L, everyMs: 1000, onPruned: (removed) => pruned.push(removed) })!
    await new Promise((r) => setTimeout(r, 500))
    beat.stop()
    expect(pruned).toEqual([])
    expect(fs.readdirSync(path.join(root, 'versions'))).toHaveLength(3)
  })
})
