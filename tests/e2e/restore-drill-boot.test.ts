/**
 * The restore drill's boot check with a real server (src/core/backup/restore-drill-boot.ts):
 * the restored copy boots once as a trial server on a port the OS picks, reads back the newest
 * task and a note, and stops; a copy that cannot boot fails the check and says why; a drill
 * killed while its trial server runs leaves no server behind; and `walnut web --_trial-start`
 * on a home with no drill's ticket refuses before it opens anything.
 *
 * Only made-up homes in temp folders: nothing here reads ~/.open-walnut or listens on 3456.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import fsp from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { LocalStore } from '../../src/core/backup/stores/local-store.js'
import { runEncryptedBackup } from '../../src/core/backup/encrypted-backup.js'
import { DRILL_DIR_PREFIX, runRestoreDrill, type DrillResult } from '../../src/core/backup/restore-drill.js'
import type { BackupConfig } from '../../src/core/backup/types.js'
import { chmodTree, listing, makeFullHome, write } from '../core/backup/restore-drill-helpers.js'

const cli = path.resolve(import.meta.dirname, '../../src/cli.ts')
const DEST = { type: 'r2' as const, bucket: 'b', account_id: '0'.repeat(32), access_key_id: 'AK', secret_access_key: 'S' }
const cfg: BackupConfig = { enabled: true, destination: DEST, encrypt: false }
const TITLE = 'Plan the garden 花园'
const NOTE = '# Garden\n\nTomatoes by the fence. 今天很好。\n'

let root: string
let home: string
let tmpRoot: string
let taskId: string

const alive = (pid: number) => { try { process.kill(pid, 0); return true } catch { return false } }
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const check = (r: DrillResult, id: string) => r.checks.find((c) => c.id === id)!
const drillFolders = async () => (await fsp.readdir(tmpRoot)).filter((n) => n.startsWith(DRILL_DIR_PREFIX))

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const port = (s.address() as net.AddressInfo).port
      s.close(() => resolve(port))
    }).on('error', reject)
  })
}

/** A home whose stores a real server made, with one task, a note, and a config naming the home. */
async function makeRealHome(dir: string): Promise<string> {
  await write(dir, 'config.yaml', `backup:\n  enabled: false\nnotes_import:\n  folders:\n    - ${dir}/Inbox\n`)
  const daemonDir = path.join(root, 'daemon')
  await fsp.mkdir(daemonDir, { recursive: true })
  const env: NodeJS.ProcessEnv = { ...process.env, OPEN_WALNUT_HOME: dir, WALNUT_DAEMON_DIR: daemonDir, WALNUT_DISABLE_SEARCH: '1' }
  const port = await freePort()
  const srv = spawn(process.execPath, [cli, 'web', '--port', String(port)], { env, stdio: ['ignore', 'pipe', 'pipe'] })
  let out = ''
  srv.stdout!.on('data', (d) => { out += d })
  srv.stderr!.on('data', (d) => { out += d })
  const exited = new Promise((r) => srv.once('exit', r))
  try {
    let up = false
    for (let i = 0; i < 240 && !up; i++) {
      await sleep(500)
      up = await fetch(`http://127.0.0.1:${port}/api/tasks`).then((r) => r.ok, () => false)
    }
    if (!up) throw new Error(`the server making the home did not come up:\n${out.slice(-3000)}`)
    const res = await fetch(`http://127.0.0.1:${port}/api/tasks`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: TITLE }) })
    const id = ((await res.json()) as { task?: { id?: string } }).task?.id
    if (!id) throw new Error(`no task made (${res.status})`)
    return id
  } finally {
    srv.kill('SIGTERM')
    await exited
    try {
      const pid = Number((await fsp.readFile(path.join(daemonDir, 'daemon.pid'), 'utf8')).trim())
      if (pid > 1) process.kill(pid, 'SIGTERM')
    } catch { /* no daemon of its own */ }
  }
}

beforeAll(async () => {
  root = await fsp.mkdtemp(path.join(os.tmpdir(), 'walnut-drill-boot-'))
  home = path.join(root, 'home')
  tmpRoot = path.join(root, 'drill-tmp')
  await fsp.mkdir(tmpRoot)
  taskId = await makeRealHome(home)
  await write(home, 'notes/garden.md', NOTE)
}, 180_000)

afterAll(async () => {
  await chmodTree(root, true).catch(() => {})
  await fsp.rm(root, { recursive: true, force: true })
})

describe('a backup whose copy boots', () => {
  it('boots it once as a trial server, reads the task and the note back through it, stops it, and touches nothing live', async () => {
    const store = new LocalStore(path.join(root, 'dest-good'))
    await runEncryptedBackup(cfg, { dataDir: home, store })
    const before = await listing(home)
    await chmodTree(home, false)
    let r: DrillResult
    try {
      r = await runRestoreDrill({ cfg, dataDir: home, store, tmpRoot, mustHaveSlackMs: 0, outsideRoots: {}, freeBytes: async () => 1024 ** 4 })
    } finally {
      await chmodTree(home, true)
    }
    const boot = check(r, 'boot')
    expect(boot.ok, JSON.stringify(boot, null, 2)).toBe(true)
    expect(r.ok, JSON.stringify(r.checks, null, 2)).toBe(true)
    expect(boot.detail).toContain(`read back task "${TITLE}" (${taskId}) and note notes/garden.md`)
    expect(boot.detail).toMatch(/every outward door closed/)
    expect(boot.detail).toMatch(/(\d+) of \1 databases pass integrity_check after its migrations/)
    // The config named the live home: pointed at the copy before the boot.
    expect(boot.detail).toMatch(/1 path\(s\) in its config\.yaml that named the live data home/)
    const port = Number(/127\.0\.0\.1:(\d+)/.exec(boot.detail)![1])
    expect(port).toBeGreaterThan(0)
    expect(port).not.toBe(3456)
    expect(boot.timings).toMatchObject({ startMs: expect.any(Number), serverBootMs: expect.any(Number), readBackMs: expect.any(Number), stopMs: expect.any(Number), totalMs: expect.any(Number) })
    // Stopped, its folder gone, the live home exactly as it was.
    const pid = Number(/pid (\d+)/.exec(boot.detail)![1])
    expect(alive(pid)).toBe(false)
    expect(await drillFolders()).toEqual([])
    expect(await listing(home)).toEqual(before)
  }, 240_000)
})

describe('a backup whose copy cannot boot', () => {
  it('fails the boot check (not "not run") and names why, with the server\'s own words', async () => {
    // Stores in a schema no server reads (made by hand, not by Walnut): they pass integrity_check, the boot dies.
    const bad = path.join(root, 'bad-home')
    await makeFullHome(bad)
    const store = new LocalStore(path.join(root, 'dest-bad'))
    await runEncryptedBackup(cfg, { dataDir: bad, store })
    const r = await runRestoreDrill({ cfg, dataDir: bad, store, tmpRoot, mustHaveSlackMs: 0, outsideRoots: {}, freeBytes: async () => 1024 ** 4 })
    expect(check(r, 'databases').ok).toBe(true)
    const boot = check(r, 'boot')
    expect(boot.ok, JSON.stringify(boot, null, 2)).toBe(false)
    expect(boot.detail).toMatch(/^The restored copy did not boot: the trial server exited during its start/)
    expect(boot.problems!.join('\n')).toMatch(/server log, last lines:/)
    expect(r.ok).toBe(false)
    expect(await drillFolders()).toEqual([])
  }, 240_000)
})

describe('a drill killed while its trial server runs', () => {
  it.each([
    ['answering', 'server'],
    ['still booting', 'spawn'],
  ] as const)('%s: leaves no server (it stops by itself), and the next drill removes the folder', async (_when, step) => {
    const dest = path.join(root, `dest-kill-${step}`)
    await runEncryptedBackup(cfg, { dataDir: home, store: new LocalStore(dest) })
    const ready = path.join(root, `server-ready-${step}`)
    const child = spawn(process.execPath, [path.join(import.meta.dirname, '../core/backup/fixtures/restore-drill-child.ts'), home, dest, tmpRoot, ready, step], {
      env: { ...process.env, OPEN_WALNUT_HOME: home }, stdio: ['ignore', 'ignore', 'pipe'],
    })
    let stderr = ''
    child.stderr!.on('data', (d) => { stderr += String(d) })
    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()))
    for (let i = 0; i < 1200 && !(await fsp.stat(ready).then(() => true, () => false)); i++) await sleep(100)
    const serverPid = Number(await fsp.readFile(ready, 'utf8').catch(() => '0'))
    expect(serverPid, stderr).toBeGreaterThan(1)
    expect(alive(serverPid)).toBe(true)
    child.kill('SIGKILL')
    await exited
    for (let i = 0; i < 300 && alive(serverPid); i++) await sleep(100)
    expect(alive(serverPid)).toBe(false)
    expect(await drillFolders()).toHaveLength(1)

    const r = await runRestoreDrill({ cfg, dataDir: home, store: new LocalStore(dest), tmpRoot, mustHaveSlackMs: 0, outsideRoots: {}, freeBytes: async () => 1024 ** 4, boot: false })
    expect(r.removedLeftovers).toBe(1)
    expect(await drillFolders()).toEqual([])
  }, 240_000)
})

describe('walnut web --_trial-start without a drill\'s ticket', () => {
  it('refuses before it opens anything in the home', async () => {
    const plain = path.join(root, 'plain-home')
    await fsp.mkdir(plain, { recursive: true })
    for (const args of [['--_trial-start'], ['--_trial-start', '--_ephemeral-child']]) {
      const r = await runCli(['web', ...args], { ...process.env, OPEN_WALNUT_HOME: plain, WALNUT_TRIAL_NONCE: 'not-a-ticket' })
      expect(r.code, r.out).toBe(2)
      expect(r.out).toMatch(args.length === 1 ? /runs only with --_ephemeral-child/ : /does not start this trial server: no ticket/)
    }
    expect(await fsp.readdir(plain)).toEqual([])
  }, 60_000)
})

async function runCli(args: string[], env: NodeJS.ProcessEnv): Promise<{ code: number | null; out: string }> {
  const child = spawn(process.execPath, [cli, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] })
  let out = ''
  child.stdout!.on('data', (d) => { out += d })
  child.stderr!.on('data', (d) => { out += d })
  const code = await new Promise<number | null>((resolve) => child.once('exit', (c) => resolve(c)))
  return { code, out }
}
