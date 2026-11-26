/**
 * A batch under way at a standby target, read from the target's disk (under-way.ts): what lets the
 * candidate's check tell "its standby runs but the batch is slow" from "no batch comes" (the 2026-11-25
 * rehearsal: a 20 Mbit/s batch ran past 300 s, and the check asked "is the standby running?").
 *
 * The batch here is a real remote batch over the in-process daemon link, held before its apply job starts
 * (every chunk sent, nothing current yet): the state a slow link keeps a target in for minutes.
 */
import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { RemoteStandbyTarget } from '../../../src/core/standby/remote-transport.js'
import { batchUnderWay, standbyStatus, takeBatch } from '../../../src/core/standby/index.js'
import { statusFileName } from '../../../src/core/standby/apply-status.js'
import { INCOMING } from '../../../src/core/standby/receive.js'
import { staleCopyProblem } from '../../../src/core/leader/switch/target-job.js'
import { fakeStandbyHost } from './fake-standby-host.js'
import { sandbox, seedHome, write, type Sandbox } from './helpers.js'

let sb: Sandbox
const dbs: Array<{ close: () => unknown }> = []
afterEach(async () => {
  for (const db of dbs.splice(0)) db.close()
  await sb?.cleanup()
})

const remote = (l: ReturnType<typeof fakeStandbyHost>) =>
  new RemoteStandbyTarget({ connect: async () => l.link, dir: sb.target, spoolDir: path.join(sb.root, 'spool'), applyPollMs: 20, applyLateMs: 300, applyJobBytes: 0, linkWaitMs: 5_000 })
const batch = (t: RemoteStandbyTarget) => takeBatch({ home: sb.home, transport: t, stagingDir: path.join(sb.root, 'staging') })
const landed = async () => (await standbyStatus(sb.target)).committedAt

describe('a batch under way at a standby target', () => {
  it('none right after a batch landed: the apply job\'s "done" status, written after it, does not count', async () => {
    sb = await sandbox('under-way-none')
    dbs.push(...seedHome(sb.home).dbs)
    const l = fakeStandbyHost(sb.root)
    const out = await batch(remote(l))
    expect(out.ok, out.ok ? '' : out.reason).toBe(true)
    const incoming = fs.readdirSync(path.join(sb.target, INCOMING))
    expect(incoming.some((n) => /^apply-.*\.status\.json$/.test(n)), incoming.join(', ')).toBe(true)
    expect(await batchUnderWay(sb.target, await landed())).toBeNull()
  })

  it('a batch whose chunks arrived and whose apply has not started: under way since its first chunk, with what it brought', async () => {
    sb = await sandbox('under-way-held')
    dbs.push(...seedHome(sb.home).dbs)
    const l = fakeStandbyHost(sb.root)
    const t = remote(l)
    const first = await batch(t)
    expect(first.ok, first.ok ? '' : first.reason).toBe(true)
    const at = await landed()
    // New content, every byte different: the next batch sends it as new chunks, then its apply waits here.
    write(sb.home, 'notes/big.bin', Buffer.alloc(3 * 1_048_576, 7))
    let release!: () => void
    const held = new Promise<void>((r) => { release = r })
    let reached!: () => void
    const atApply = new Promise<void>((r) => { reached = r })
    l.state.before = async (cmd) => { if (cmd === 'exec.run') { reached(); await held } }
    const second = batch(t)
    await atApply
    const before = Date.now()
    const u = await batchUnderWay(sb.target, at)
    expect(u, 'a batch under way').not.toBeNull()
    expect(u!.chunks).toBeGreaterThanOrEqual(1)
    expect(u!.bytes).toBeGreaterThan(0)
    expect(Date.parse(u!.since)).toBeGreaterThan(Date.parse(at!))
    expect(u!.progressAt, 'its chunks are progress').not.toBeNull()
    expect(Date.parse(u!.progressAt!)).toBeGreaterThanOrEqual(Date.parse(u!.since))
    expect(Date.parse(u!.lastAt)).toBeGreaterThanOrEqual(Date.parse(u!.progressAt!))
    expect(Date.parse(u!.lastAt)).toBeLessThanOrEqual(before)
    expect(u!.applyingSince).toBeNull()
    // Nothing of the copy moved: the batch is not current until its apply ran.
    expect(await landed()).toBe(at)
    release()
    const done = await second
    expect(done.ok, done.ok ? '' : done.reason).toBe(true)
    expect(await batchUnderWay(sb.target, await landed())).toBeNull()
  })

  // Review round 1, M1: a remote batch's init writes its export into .incoming/ first, a batch that sends nothing
  // or voids too. That is a start, never progress: the check must not say "its standby runs, wait".
  it('only an init and its export after the landing: a batch began, nothing arrived, so not "its standby runs"', async () => {
    sb = await sandbox('under-way-init-only')
    dbs.push(...seedHome(sb.home).dbs)
    const l = fakeStandbyHost(sb.root)
    expect((await batch(remote(l))).ok).toBe(true)
    const at = await landed()
    await new Promise((r) => setTimeout(r, 20))
    // A fresh sender's first step of a batch: init with an export, and nothing after it.
    await remote(l).current()
    const incoming = fs.readdirSync(path.join(sb.target, INCOMING))
    expect(incoming.some((n) => n.startsWith('export-')), incoming.join(', ')).toBe(true)
    const u = await batchUnderWay(sb.target, at)
    expect(u).toMatchObject({ chunks: 0, bytes: 0, applyingSince: null, progressAt: null })
    const now = Date.now()
    const p = staleCopyProblem({ ageSeconds: 900, committedAt: new Date(now - 900_000).toISOString() }, u, now)
    expect(p).toMatch(/batches still begin here .* but bring nothing/)
    expect(p).not.toMatch(/its standby runs|wait for it to land/)
  })

  it('an apply job that runs (its status says running, its process lives, its heartbeat is fresh) is progress; a dead or silent one is not', async () => {
    sb = await sandbox('under-way-applying')
    dbs.push(...seedHome(sb.home).dbs)
    const l = fakeStandbyHost(sb.root)
    expect((await batch(remote(l))).ok).toBe(true)
    const at = await landed()
    await new Promise((r) => setTimeout(r, 20))
    const file = path.join(sb.target, INCOMING, statusFileName('job-1'))
    const iso = (ms: number) => new Date(ms).toISOString()
    const started = iso(Date.now())
    fs.writeFileSync(file, JSON.stringify({ state: 'running', pid: process.pid, startedAt: started, at: iso(Date.now()), batch: 2 }))
    const u = await batchUnderWay(sb.target, at)
    expect(u?.applyingSince).toBe(started)
    expect(u?.progressAt).not.toBeNull()
    expect(u?.chunks).toBe(0)
    // Its process gone (apply-status.ts runningApply: the pid must live).
    fs.writeFileSync(file, JSON.stringify({ state: 'running', pid: 2_147_483_646, startedAt: iso(Date.now()), at: iso(Date.now()), batch: 2 }))
    expect(await batchUnderWay(sb.target, at)).toBeNull()
    // Its heartbeat older than HEARTBEAT_STALE_MS (45 s).
    fs.writeFileSync(file, JSON.stringify({ state: 'running', pid: process.pid, startedAt: iso(Date.now() - 120_000), at: iso(Date.now() - 60_000), batch: 2 }))
    expect(await batchUnderWay(sb.target, at)).toBeNull()
    fs.writeFileSync(file, JSON.stringify({ state: 'failed', at: iso(Date.now()), error: 'x' }))
    expect(await batchUnderWay(sb.target, at)).toBeNull()
  })
})
