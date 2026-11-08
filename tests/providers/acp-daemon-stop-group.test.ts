/**
 * A stopped ACP worker that exits while a child in its process group lives on keeps its
 * stop evidence: acpStop fails, a retried stop sends no second shutdown and still fails,
 * listWorkers and acpState still show it, a restarted daemon still refuses it from the pid
 * file, and only the group's own exit makes the stop succeed. Real processes; nothing here
 * signals them (the child exits on a release file).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createAcpDaemon } from '../../src/providers/acp-daemon.js'

// Answers the start; its first op starts a child in its own group; on shutdown it ACKs and exits.
const WORKER = `
import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'
import { spawn } from 'node:child_process'
const [, , child, release, opsFile, childPidFile] = process.argv
const journal = process.argv[process.argv.indexOf('--journal') + 1]
fs.mkdirSync(path.dirname(journal), { recursive: true })
if (!fs.existsSync(journal)) fs.writeFileSync(journal, '')
const c = spawn(process.execPath, [child, release], { stdio: 'ignore' })
fs.writeFileSync(childPidFile, String(c.pid))
c.unref()
const reply = (id, result) => process.stdout.write(JSON.stringify({ id, ok: true, result }) + '\\n')
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const r = JSON.parse(line)
  fs.appendFileSync(opsFile, r.op + '\\n')
  if (r.op === 'newSession') return reply(r.id, { sessionId: 'group-provider-session' })
  if (r.op === 'getState') return reply(r.id, { providerSessionId: 'group-provider-session', turnActive: false, controlActive: false, pendingPermissions: [], capabilities: {} })
  reply(r.id, {})
  if (r.op === 'shutdown') setTimeout(() => process.exit(0), 20)
})
`
// Lives until the release file exists (or 60 s), then exits on its own.
const CHILD = `
const fs = require('fs')
const release = process.argv[2]
setInterval(() => { if (fs.existsSync(release)) process.exit(0) }, 20)
setTimeout(() => process.exit(0), 60000)
`

interface FakeWs { open: boolean; frames: Array<Record<string, unknown>> }
let dir = ''
let childPid = 0
const alive = (pid: number) => { try { process.kill(pid, 0); return true } catch { return false } }
async function until(check: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms
  while (!check() && Date.now() < end) await new Promise((r) => setTimeout(r, 20))
  return check()
}
beforeEach(() => { dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'acp-group-'))); childPid = 0 })
afterEach(async () => {
  // A failed run still lets the child end by itself; the dir goes only once it has.
  fs.writeFileSync(path.join(dir, 'release'), '')
  if (childPid) expect(await until(() => !alive(childPid), 10_000), 'the child exited on its own').toBe(true)
  fs.rmSync(dir, { recursive: true, force: true })
})

function daemon() {
  return createAcpDaemon<FakeWs>({
    streamsDir: path.join(dir, 'streams'), daemonDir: path.join(dir, 'daemon'), strictStop: () => true,
    sendEvent: (ws, ev, data) => { ws.frames.push({ ev, ...data }) }, isWsOpen: (ws) => ws.open, log: () => {},
    setIntervalFn: ((fn: () => void) => { const t = setInterval(fn, 60_000); t.unref(); return t }) as typeof setInterval,
  })
}

describe('ACP stop keeps an exited worker\'s process group until it is gone', () => {
  it('fails while the group lives, retries without a second shutdown, and stops once the child exits', async () => {
    const worker = path.join(dir, 'worker.mjs')
    const child = path.join(dir, 'child.cjs')
    fs.writeFileSync(worker, WORKER)
    fs.writeFileSync(child, CHILD)
    const release = path.join(dir, 'release')
    const ops = path.join(dir, 'ops.txt')
    const childPidFile = path.join(dir, 'child.pid')
    const acp = daemon()
    const cmd = [process.execPath, worker, child, release, ops, childPidFile]
    const started = await acp.acpStart({ open: true, frames: [] }, { sid: 'rt-group', cwd: dir, workerCmd: cmd, adapterCmd: cmd })
    expect(started.ok).toBe(true)
    childPid = Number(fs.readFileSync(childPidFile, 'utf8'))
    expect(alive(childPid)).toBe(true)

    await expect(acp.acpStop('rt-group')).rejects.toThrow(/process group has not exited/)
    expect(acp.hasWorker('rt-group')).toBe(false)
    expect(acp.listWorkers()).toEqual([expect.objectContaining({ sid: 'rt-group', state: 'dead', stopping: true })])
    expect(await acp.acpOp('rt-group', 'getState')).toMatchObject({ ok: false, error: { kind: 'worker_stopping' } })

    await expect(acp.acpStop('rt-group')).rejects.toThrow(/process group has not exited/)
    expect(fs.readFileSync(ops, 'utf8').split('\n').filter((op) => op === 'shutdown')).toHaveLength(1)
    expect(acp.listWorkers()).toHaveLength(1)

    const pidFile = path.join(dir, 'daemon', 'acp-workers.json')
    expect(JSON.parse(fs.readFileSync(pidFile, 'utf8'))['rt-group']).toMatchObject({ stopping: true })

    // A new daemon life reads the stopped group from the pid file and keeps refusing; it signals nothing.
    const next = daemon()
    await next.startupRepair()
    expect(alive(childPid)).toBe(true)
    expect(next.listWorkers()).toEqual([expect.objectContaining({ sid: 'rt-group', state: 'dead', stopping: true })])
    expect(await next.acpOp('rt-group', 'getState')).toMatchObject({ ok: false, error: { kind: 'worker_stopping' } })
    await expect(next.acpStop('rt-group')).rejects.toThrow(/process group has not exited/)
    expect(alive(childPid)).toBe(true)

    fs.writeFileSync(release, '')
    await next.acpStop('rt-group')
    expect(alive(childPid)).toBe(false)
    expect(next.listWorkers()).toEqual([])
    expect(await next.acpOp('rt-group', 'getState')).toMatchObject({ ok: false, error: { kind: 'no_worker' } })
    expect(JSON.parse(fs.readFileSync(pidFile, 'utf8'))).toEqual({})
    // The first life's own retry agrees once the group is gone.
    await acp.acpStop('rt-group')
    expect(acp.listWorkers()).toEqual([])
  }, 60_000)
})
