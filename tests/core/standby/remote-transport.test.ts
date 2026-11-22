/**
 * A standby target on another host, over a daemon link (remote-transport.ts, receive.ts). The
 * link here is in process: fs.writePart is the daemons' own transfer core, exec.script runs the
 * receive op as the CLI would. What it proves: the copy is the home, a batch sends only what
 * the target lacks, a dropped link is waited out, a link gone too long fails the batch and the
 * next sends only the missing chunks, a lost apply answer is judged by the target, and a full
 * disk or a target that moved leaves the batch before whole. Kills of the receiving process and
 * a real daemon are in remote-twin-e2e.test.ts.
 */
import { afterEach, describe, expect, it } from 'vitest'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { RemoteStandbyTarget } from '../../../src/core/standby/remote-transport.js'
import { composeManifest, runReceiveOp } from '../../../src/core/standby/receive.js'
import { runningApply } from '../../../src/core/standby/apply-status.js'
import { fakeStandbyHost } from './fake-standby-host.js'

const sha256Hex = (d: Buffer) => crypto.createHash('sha256').update(d).digest('hex')
import { standbyStatus, takeBatch, verifyStandby } from '../../../src/core/standby/index.js'
import { ORPHAN_CHUNK_KEEP_MS } from '../../../src/core/standby/verify.js'
import { targetPaths } from '../../../src/core/standby/target-files.js'
import { leaderPlainFiles, sandbox, seedHome, sha, write, type Sandbox } from './helpers.js'

let sb: Sandbox
const dbs: Array<{ close: () => unknown }> = []
afterEach(async () => {
  for (const db of dbs.splice(0)) db.close()
  await sb?.cleanup()
})
const settle = () => new Promise((r) => setTimeout(r, 30))

/** Where every target here keeps its spool, and a quick poll of its apply. */
const place = () => ({ dir: sb.target, spoolDir: path.join(sb.root, 'spool'), applyPollMs: 20 })
const spoolFiles = () => walkFiles(path.join(sb.root, 'spool'))
function walkFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return []
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walkFiles(path.join(dir, e.name)) : [path.join(dir, e.name)]))
}

function remote(l: ReturnType<typeof fakeStandbyHost>, o: { linkWaitMs?: number } = {}) {
  return new RemoteStandbyTarget({ connect: async () => l.link, ...place(), linkWaitMs: o.linkWaitMs ?? 5_000 })
}

const batch = (t: RemoteStandbyTarget) => takeBatch({ home: sb.home, transport: t, stagingDir: path.join(sb.root, 'staging') })

/** Every leader plain file of the home is in the copy, byte for byte, and the copy verifies deep. */
async function expectCopyIsHome(): Promise<void> {
  for (const rel of leaderPlainFiles(sb.home)) expect(sha(path.join(sb.target, 'copy', rel)), rel).toBe(sha(path.join(sb.home, rel)))
  expect((await verifyStandby(sb.target, { deep: true })).drift).toEqual([])
}

const chunkWrites = (l: ReturnType<typeof fakeStandbyHost>, from = 0) =>
  l.log.slice(from).filter((e) => e.cmd === 'fs.writePart').length

describe('a standby target on another host', () => {
  it('takes batches: the copy is the home, and a later batch sends only what changed', async () => {
    sb = await sandbox('remote-basic')
    dbs.push(...seedHome(sb.home).dbs)
    await settle()
    const l = fakeStandbyHost(sb.root)
    const t = remote(l)
    const first = await batch(t)
    expect(first.ok, first.ok ? '' : first.reason).toBe(true)
    await expectCopyIsHome()
    expect(fs.statSync(sb.target).mode & 0o777).toBe(0o700)

    write(sb.home, 'memory/MEMORY.md', '# second version\n')
    fs.rmSync(path.join(sb.home, 'user-own-folder/plan.md'))
    await settle()
    const mark = l.log.length
    const second = await batch(t)
    expect(second.ok, second.ok ? '' : second.reason).toBe(true)
    if (!second.ok) return
    expect(second.commit).toMatchObject({ batch: 2, written: 1, deleted: 1, unchanged: false })
    // One new chunk and the upload; the target's files were not read again (this side holds them):
    // what was read is the init's small export and the apply's status.
    expect(chunkWrites(l, mark)).toBe(2)
    expect(l.log.slice(mark).filter((e) => e.cmd === 'fs.readRange' && !e.path?.endsWith('.status.json')).reduce((n, e) => n + e.bytes, 0)).toBeLessThan(200)
    await expectCopyIsHome()
    expect(fs.existsSync(path.join(sb.target, 'copy/user-own-folder/plan.md'))).toBe(false)

    const third = await batch(t)
    expect(third.ok && third.commit.unchanged).toBe(true)
    expect(t.lastApply?.verify?.drift).toEqual([])
    // Nothing is left in .incoming/ (the upload and the exports are removed or swept).
    expect(fs.readdirSync(path.join(sb.target, '.incoming')).filter((n) => n.startsWith('upload-'))).toEqual([])
  })

  it('waits out a dropped link and sends again only what the host did not take', async () => {
    sb = await sandbox('remote-drop')
    dbs.push(...seedHome(sb.home).dbs)
    await settle()
    const l = fakeStandbyHost(sb.root)
    let n = 0
    l.state.fault = (cmd) => (cmd === 'fs.writePart' && ++n % 3 === 0 ? (n % 2 ? 'lost-before' : 'lost-after') : undefined)
    const t = remote(l)
    const out = await batch(t)
    expect(out.ok, out.ok ? '' : out.reason).toBe(true)
    expect(t.stats.resent).toBeGreaterThan(0)
    await expectCopyIsHome()
  })

  it('a link gone too long fails the batch, keeps the target, and the next batch sends only the missing chunks', async () => {
    sb = await sandbox('remote-gone')
    dbs.push(...seedHome(sb.home).dbs)
    write(sb.home, 'big/more.bin', crypto.randomBytes(4 * 1024 * 1024))
    await settle()
    const l = fakeStandbyHost(sb.root)
    const t = remote(l, { linkWaitMs: 300 })
    expect((await batch(t)).ok).toBe(true)
    write(sb.home, 'big/more.bin', crypto.randomBytes(4 * 1024 * 1024))
    write(sb.home, 'memory/MEMORY.md', '# second version\n')
    await settle()
    // The link goes for good after two chunks of batch 2 arrived.
    const arrived: string[] = []
    l.state.fault = (cmd, params) => {
      if (cmd !== 'fs.writePart' || !String(params.path).includes('/chunks/')) return undefined
      if (arrived.length < 2) { arrived.push(String(params.path)); return undefined }
      l.state.down = true
      return 'lost-before'
    }
    const cut = await batch(t)
    expect(cut.ok).toBe(false)
    expect((await standbyStatus(sb.target)).batch).toBe(1)
    // A deep verify between keeps the chunks the cut batch sent (they are recent).
    expect((await verifyStandby(sb.target, { deep: true })).drift).toEqual([])
    for (const p of arrived) expect(fs.existsSync(p), p).toBe(true)
    // Back: the two chunks it holds are not sent again.
    l.state.down = false
    l.state.fault = null
    const sentAgain: string[] = []
    l.state.fault = (cmd, params) => { if (cmd === 'fs.writePart' && String(params.path).includes('/chunks/')) sentAgain.push(String(params.path)); return undefined }
    const again = await batch(t)
    expect(again.ok, again.ok ? '' : again.reason).toBe(true)
    expect(arrived).toHaveLength(2)
    expect(sentAgain.length).toBeGreaterThan(0)
    expect(sentAgain.filter((p) => arrived.includes(p))).toEqual([])
    expect(again.ok && again.stats.sentChunks).toBe(sentAgain.length)
    await expectCopyIsHome()
    // An orphan chunk older than the keep time is collected by a deep verify.
    const orphan = path.join(sb.target, 'chunks', 'ab', 'ab'.repeat(32))
    fs.mkdirSync(path.dirname(orphan), { recursive: true })
    fs.writeFileSync(orphan, 'left by a batch that never came')
    const old = new Date(Date.now() - ORPHAN_CHUNK_KEEP_MS - 60_000)
    fs.utimesSync(orphan, old, old)
    expect((await verifyStandby(sb.target, { deep: true })).drift).toEqual([])
    expect(fs.existsSync(orphan)).toBe(false)
  })

  it('an apply started as a job whose start answer was lost runs once: the start sent again finds its job', async () => {
    sb = await sandbox('remote-lost-apply')
    dbs.push(...seedHome(sb.home).dbs)
    await settle()
    const l = fakeStandbyHost(sb.root)
    let starts = 0
    l.state.fault = (cmd, params) => (cmd === 'exec.run' && (params.argv as string[])[3] === 'apply' && ++starts === 1 ? 'lost-after' : undefined)
    const t = remote(l)
    const out = await batch(t)
    expect(out.ok, out.ok ? '' : out.reason).toBe(true)
    expect((await standbyStatus(sb.target)).batch).toBe(1)
    // The start went twice; the apply ran once.
    expect(l.log.filter((e) => e.cmd === 'receive apply')).toHaveLength(2)
    expect(l.state.applyRuns).toBe(1)
    await expectCopyIsHome()
  })

  it('an apply whose status could not be read is judged by what the target holds', async () => {
    sb = await sandbox('remote-lost-status')
    dbs.push(...seedHome(sb.home).dbs)
    await settle()
    const l = fakeStandbyHost(sb.root)
    l.state.fault = (cmd, params) => (cmd === 'fs.readRange' && String(params.path).endsWith('.status.json') ? 'lost-before' : undefined)
    const out = await batch(remote(l, { linkWaitMs: 300 }))
    expect(out.ok, out.ok ? '' : out.reason).toBe(true)
    expect(l.state.applyRuns).toBe(1)
    expect((await standbyStatus(sb.target)).batch).toBe(1)
  })

  it('an apply job that ended without an answer fails the batch, and the target keeps the batch before', async () => {
    sb = await sandbox('remote-apply-gone')
    dbs.push(...seedHome(sb.home).dbs)
    await settle()
    const l = fakeStandbyHost(sb.root)
    const t = remote(l)
    expect((await batch(t)).ok).toBe(true)
    write(sb.home, 'memory/MEMORY.md', '# second version\n')
    await settle()
    // The job starts, then ends at once as a kill there would end it: no status, no answer.
    l.state.fault = (cmd, params) => {
      if (cmd !== 'exec.run' || (params.argv as string[])[3] !== 'apply') return undefined
      l.jobs.set(String(params.jobId), { running: false, exitCode: 137, output: 'Killed' })
      return { ok: true, jobId: params.jobId, running: true }
    }
    const out = await batch(t)
    expect(out.ok).toBe(false)
    expect(!out.ok && out.reason).toMatch(/ended without an answer \(exit 137: Killed\)/)
    expect((await standbyStatus(sb.target)).batch).toBe(1)
    l.state.fault = null
    expect((await batch(t)).ok).toBe(true)
    await expectCopyIsHome()
  })

  it('while an apply runs there the other ops say the target is busy, and a second leader goes on from the batch it made', async () => {
    sb = await sandbox('remote-busy')
    dbs.push(...seedHome(sb.home).dbs)
    await settle()
    const l = fakeStandbyHost(sb.root)
    expect((await batch(remote(l))).ok).toBe(true)
    write(sb.home, 'memory/MEMORY.md', '# second version\n')
    await settle()
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    l.state.applyPoint = async (name) => { if (name === 'files-built') await gate }
    const first = batch(remote(l))
    const incoming = path.join(sb.target, '.incoming')
    for (let i = 0; i < 500 && (await runningApply(incoming))?.batch !== 2; i++) await new Promise((r) => setTimeout(r, 20))
    expect((await runningApply(incoming))?.batch).toBe(2)
    // A leader started meanwhile (a restart): its read is refused at once, not after the target's lock.
    const started = Date.now()
    const second = remote(l)
    const busy = await batch(second)
    expect(busy.ok).toBe(false)
    expect(!busy.ok && busy.reason).toMatch(/the target is busy: an apply of batch 2 runs there/)
    expect(Date.now() - started).toBeLessThan(5_000)
    release()
    expect((await first).ok).toBe(true)
    l.state.applyPoint = null
    write(sb.home, 'memory/MEMORY.md', '# third version\n')
    await settle()
    const next = await batch(second)
    expect(next.ok && next.commit.batch).toBe(3)
    expect(l.state.applyRuns).toBe(3)
    await expectCopyIsHome()
  })

  it('a full disk there fails the batch and keeps the batch before whole', async () => {
    sb = await sandbox('remote-full')
    dbs.push(...seedHome(sb.home).dbs)
    await settle()
    const l = fakeStandbyHost(sb.root)
    const t = remote(l)
    expect((await batch(t)).ok).toBe(true)
    write(sb.home, 'memory/MEMORY.md', '# second version\n')
    write(sb.home, 'big/blob.bin', crypto.randomBytes(3 * 1024 * 1024))
    await settle()
    let n = 0
    l.state.fault = (cmd, params) => (cmd === 'fs.writePart' && String(params.path).includes('/chunks/') && ++n > 1
      ? { ok: false, error: 'fs.writePart failed: ENOSPC: no space left on device, write', code: 'io' } : undefined)
    const mark = l.log.length
    const out = await batch(t)
    expect(out.ok).toBe(false)
    expect(!out.ok && out.reason).toMatch(/ENOSPC/)
    // A chunk that did not arrive stops the batch before anything is applied there.
    expect(l.log.slice(mark).filter((e) => e.cmd === 'receive apply')).toEqual([])
    expect((await standbyStatus(sb.target)).batch).toBe(1)
    expect(fs.readFileSync(path.join(sb.target, 'copy/memory/MEMORY.md'), 'utf8')).toBe('# Memory\n')
    l.state.fault = null
    expect((await batch(t)).ok).toBe(true)
    await expectCopyIsHome()
  })

  it('a chunk this side believed the target held, gone there, fails one batch; the next sends it', async () => {
    sb = await sandbox('remote-lost-chunk')
    dbs.push(...seedHome(sb.home).dbs)
    await settle()
    const l = fakeStandbyHost(sb.root)
    const t = remote(l)
    expect((await batch(t)).ok).toBe(true)
    // A new file with the same content as one held: its chunk is not sent, and it is gone there.
    const id = sha(path.join(sb.home, 'memory/MEMORY.md'))
    fs.rmSync(path.join(sb.target, 'chunks', id.slice(0, 2), id))
    write(sb.home, 'memory/copy-of-memory.md', fs.readFileSync(path.join(sb.home, 'memory/MEMORY.md')))
    await settle()
    const failed = await batch(t)
    expect(failed.ok).toBe(false)
    expect((await standbyStatus(sb.target)).batch).toBe(1)
    const next = await batch(t)
    expect(next.ok, next.ok ? '' : next.reason).toBe(true)
    await expectCopyIsHome()
  })

  it('a target another leader moved meanwhile refuses the upload; the next batch reads it again', async () => {
    sb = await sandbox('remote-moved')
    dbs.push(...seedHome(sb.home).dbs)
    await settle()
    const l = fakeStandbyHost(sb.root)
    const t = remote(l)
    expect((await batch(t)).ok).toBe(true)
    write(sb.home, 'memory/MEMORY.md', '# second version\n')
    await settle()
    // Another leader's batch 2 lands between this side's read and its apply.
    const other = remote(l)
    const view = await t.current()
    expect((await batch(other)).ok).toBe(true)
    // `t` sends a batch 2 against batch 1: refused, and the target keeps the other leader's.
    const out = await takeBatch({ home: sb.home, transport: { current: async () => view, missing: (ids) => t.missing(ids), putChunk: (id, d) => t.putChunk(id, d), commit: (m) => t.commit(m) }, stagingDir: path.join(sb.root, 'staging') })
    expect(out.ok).toBe(false)
    expect((await standbyStatus(sb.target)).batch).toBe(2)
    expect((await batch(t)).ok).toBe(true)
    await expectCopyIsHome()
  })
})

describe('a file put back to an old version', () => {
  it('sends the old version\'s chunks again (the target removed them when it was replaced)', async () => {
    sb = await sandbox('remote-aba')
    dbs.push(...seedHome(sb.home).dbs)
    await settle()
    const l = fakeStandbyHost(sb.root)
    const t = remote(l)
    const versions = ['{"v":"A"}\n', '{"v":"B"}\n', '{"v":"A"}\n', '{"v":"B"}\n']
    for (const [i, v] of versions.entries()) {
      write(sb.home, 'cache/status-riding.json', v)
      await settle()
      const out = await batch(t)
      expect(out.ok, `batch ${i + 1}: ${out.ok ? '' : out.reason}`).toBe(true)
      expect(fs.readFileSync(path.join(sb.target, 'copy/cache/status-riding.json'), 'utf8')).toBe(v)
    }
    await expectCopyIsHome()
  })
})

describe('sending chunks', () => {
  const chunk = (n: number) => { const d = Buffer.alloc(1024 * 1024, n); return { id: sha256Hex(d), d } }
  const onTarget = (id: string) => fs.existsSync(path.join(sb.target, 'chunks', id.slice(0, 2), id))
  /** A link whose chunk writes wait for `open()` and are counted as they start. */
  function gatedChunks(l: ReturnType<typeof fakeStandbyHost>, answer?: (n: number) => Record<string, unknown> | undefined) {
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    const g = {
      started: 0,
      open: () => release(),
      link: { ...l.link, async send(cmd: string, params?: Record<string, unknown>, ms?: number) {
        if (cmd === 'fs.writePart' && String(params?.path).includes('/chunks/')) {
          const n = ++g.started
          await gate
          const refused = answer?.(n)
          if (refused) return refused
        }
        return l.link.send(cmd, params, ms)
      } },
    }
    return g
  }

  it('stages chunks on this machine\'s disk so a put never waits for the link, and flush waits for them', async () => {
    sb = await sandbox('remote-spool')
    const l = fakeStandbyHost(sb.root)
    const g = gatedChunks(l)
    const t = new RemoteStandbyTarget({ connect: async () => g.link, ...place() })
    await t.current()
    const ids = Array.from({ length: 12 }, (_, i) => chunk(i))
    for (const x of ids) await t.putChunk(x.id, x.d)
    // Every put returned with the link held: eight on the wire, every one on disk here until it went.
    expect(g.started).toBe(8)
    expect(spoolFiles()).toHaveLength(12)
    let flushed = false
    const done = t.flush().then(() => { flushed = true })
    await new Promise((r) => setTimeout(r, 50))
    expect(flushed).toBe(false)
    g.open()
    await done
    expect(ids.every((x) => onTarget(x.id))).toBe(true)
    // Each chunk's file went once the host had it.
    expect(spoolFiles()).toEqual([])
    expect(t.stats.spoolPeakBytes).toBe(12 * 1024 * 1024)
  })

  it('a chunk that would leave the disk with less than its reserve is refused, and nothing more is staged', async () => {
    sb = await sandbox('remote-spool-full')
    const l = fakeStandbyHost(sb.root)
    const g = gatedChunks(l)
    let used = 0
    const t = new RemoteStandbyTarget({
      connect: async () => g.link, ...place(), spoolReserveBytes: 100 * 1024 * 1024,
      // 103 MiB free at first: room for three chunks above the reserve.
      statfs: async () => ({ free: 103 * 1024 * 1024 - used, total: 1024 ** 4 }),
    })
    await t.current()
    const ids = Array.from({ length: 5 }, (_, i) => chunk(40 + i))
    for (const x of ids.slice(0, 3)) { await t.putChunk(x.id, x.d); used += x.d.length }
    await expect(t.putChunk(ids[3].id, ids[3].d)).rejects.toThrow(/keeps free: the batch is void/)
    expect(spoolFiles()).toHaveLength(3)
    // What was staged still goes.
    g.open()
    await t.flush()
    expect(ids.slice(0, 3).every((x) => onTarget(x.id))).toBe(true)
    expect(onTarget(ids[3].id)).toBe(false)
  })

  it('a chunk refused there drops the rest of the queue and its files, and the next read starts clean', async () => {
    sb = await sandbox('remote-queue-fail')
    const l = fakeStandbyHost(sb.root)
    const g = gatedChunks(l, (n) => n === 1 ? { ok: false, error: 'fs.writePart failed: ENOSPC', code: 'io' } : undefined)
    const t = new RemoteStandbyTarget({ connect: async () => g.link, ...place(), window: 1 })
    await t.current()
    const ids = Array.from({ length: 6 }, (_, i) => chunk(i))
    for (const x of ids.slice(0, 4)) await t.putChunk(x.id, x.d)
    g.open()
    // The refusal fails the flush, and every later put says the same until the next read.
    await expect(t.flush()).rejects.toThrow(/ENOSPC/)
    await new Promise((r) => setTimeout(r, 50))
    // The three queued behind it were dropped, never sent, and their files are gone.
    expect(g.started).toBe(1)
    expect(ids.some((x) => onTarget(x.id))).toBe(false)
    expect(spoolFiles()).toEqual([])
    await t.current()
    expect((await t.missing(ids.map((x) => x.id))).size).toBe(6)
    await t.putChunk(ids[5].id, ids[5].d)
    await t.flush()
    expect(onTarget(ids[5].id)).toBe(true)
  })

  it('a put after a chunk failed throws that failure', async () => {
    sb = await sandbox('remote-queue-fail-put')
    const l = fakeStandbyHost(sb.root)
    const g = gatedChunks(l, (n) => n === 1 ? { ok: false, error: 'fs.writePart failed: ENOSPC', code: 'io' } : undefined)
    const t = new RemoteStandbyTarget({ connect: async () => g.link, ...place(), window: 1 })
    await t.current()
    await t.putChunk(chunk(60).id, chunk(60).d)
    g.open()
    await new Promise((r) => setTimeout(r, 50))
    await expect(t.putChunk(chunk(61).id, chunk(61).d)).rejects.toThrow(/ENOSPC/)
  })

  it('what a void batch left to send goes before the next read, and is not sent again', async () => {
    sb = await sandbox('remote-queue-leftover')
    const l = fakeStandbyHost(sb.root)
    const g = gatedChunks(l)
    const t = new RemoteStandbyTarget({ connect: async () => g.link, ...place(), window: 2 })
    await t.current()
    const ids = Array.from({ length: 4 }, (_, i) => chunk(10 + i))
    for (const x of ids) await t.putChunk(x.id, x.d)
    let read = false
    const next = t.current().then(() => { read = true })
    await new Promise((r) => setTimeout(r, 50))
    expect(read).toBe(false)
    g.open()
    await next
    expect((await t.missing(ids.map((x) => x.id))).size).toBe(0)
    expect(ids.every((x) => onTarget(x.id))).toBe(true)
    expect(g.started).toBe(4)
  })

  it('closed, it drops what waits to go, removes its files and sends nothing more', async () => {
    sb = await sandbox('remote-queue-close')
    const l = fakeStandbyHost(sb.root)
    const g = gatedChunks(l)
    const t = new RemoteStandbyTarget({ connect: async () => g.link, ...place(), window: 2 })
    await t.current()
    const ids = Array.from({ length: 6 }, (_, i) => chunk(20 + i))
    for (const x of ids) await t.putChunk(x.id, x.d)
    expect(g.started).toBe(2)
    t.close()
    g.open()
    await new Promise((r) => setTimeout(r, 100))
    // Only the two already on the wire finished there.
    expect(g.started).toBe(2)
    expect(ids.filter((x) => onTarget(x.id)).length).toBe(2)
    expect(spoolFiles()).toEqual([])
    expect(fs.readdirSync(path.join(sb.root, 'spool'))).toEqual([])
    await expect(t.putChunk(ids[0].id, ids[0].d)).rejects.toThrow(/closed/)
    await expect(t.current()).rejects.toThrow(/closed/)
    await expect(t.verify()).rejects.toThrow(/closed/)
  })

  it('a spool or a staging folder a killed leader left is removed by the next batch; a live one stays', async () => {
    sb = await sandbox('remote-spool-leftover')
    dbs.push(...seedHome(sb.home).dbs)
    await settle()
    const l = fakeStandbyHost(sb.root)
    // 2147483646 is past any pid_max: no process has it.
    const deadSpool = path.join(sb.root, 'spool', '2147483646-0a1b2c3d')
    const liveSpool = path.join(sb.root, 'spool', `${process.pid}-feedf00d`)
    const deadStaging = path.join(sb.root, 'staging', 'batch-2147483646-1')
    for (const d of [deadSpool, liveSpool, deadStaging]) { fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, 'x'), 'left') }
    expect((await batch(remote(l))).ok).toBe(true)
    expect(fs.existsSync(deadSpool)).toBe(false)
    expect(fs.existsSync(deadStaging)).toBe(false)
    expect(fs.existsSync(liveSpool)).toBe(true)
  })
})

describe('a batch over a slow link', () => {
  it('reads every file and ends its database pins while the link still holds every chunk', async () => {
    sb = await sandbox('remote-pin-early')
    dbs.push(...seedHome(sb.home).dbs)
    write(sb.home, 'big/more.bin', crypto.randomBytes(12 * 1024 * 1024))
    await settle()
    const l = fakeStandbyHost(sb.root)
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    const slow = { ...l.link, async send(cmd: string, params?: Record<string, unknown>, ms?: number) {
      if (cmd === 'fs.writePart' && String(params?.path).includes('/chunks/')) await gate
      return l.link.send(cmd, params, ms)
    } }
    const t = new RemoteStandbyTarget({ connect: async () => slow, ...place() })
    let committing = 0
    const out = takeBatch({
      home: sb.home, stagingDir: path.join(sb.root, 'staging'),
      transport: { current: () => t.current(), missing: (ids) => t.missing(ids), putChunk: (id, d) => t.putChunk(id, d), commit: (m) => { committing = performance.now(); return t.commit(m) } },
    })
    const heldFrom = performance.now()
    for (let i = 0; i < 500 && !committing; i++) await new Promise((r) => setTimeout(r, 10))
    // The batch reached its commit, its pins ended, with not one chunk through the link.
    expect(committing).toBeGreaterThan(0)
    expect(fs.existsSync(path.join(sb.target, 'chunks'))).toBe(true)
    expect(fs.readdirSync(path.join(sb.target, 'chunks')).length).toBe(0)
    expect(spoolFiles().length).toBeGreaterThan(12)
    await new Promise((r) => setTimeout(r, 300))
    const heldMs = performance.now() - heldFrom
    release()
    const done = await out
    expect(done.ok, done.ok ? '' : done.reason).toBe(true)
    expect(done.stats.pinMs).toBeLessThan(heldMs - 300)
    await expectCopyIsHome()
    expect(spoolFiles()).toEqual([])
  })
})

describe('the receiving side', () => {
  it('rebuilds the manifest only when it matches the leader\'s hash, against the batch it holds', async () => {
    sb = await sandbox('receive-compose')
    dbs.push(...seedHome(sb.home).dbs)
    await settle()
    const l = fakeStandbyHost(sb.root)
    expect((await batch(remote(l))).ok).toBe(true)
    const t = targetPaths(sb.target)
    const head = { format: 'walnut-standby' as const, version: 1, batch: 2, takenAt: new Date().toISOString() }
    const upload = { format: 'walnut-standby-upload' as const, version: 1 as const, base: 1, head, puts: [], dels: ['config.yaml'], hash: 'x'.repeat(64) }
    await expect(composeManifest(t, upload)).rejects.toThrow(/does not match/)
    await expect(composeManifest(t, { ...upload, base: 7 })).rejects.toThrow(/against batch 7/)
    await expect(composeManifest(t, { ...upload, base: null })).rejects.toThrow(/against batch none/)
  })

  it('refuses a target that lies in that machine\'s own Walnut home or holds it', async () => {
    sb = await sandbox('receive-home')
    const home = path.join(sb.root, 'host-home')
    await expect(runReceiveOp('init', path.join(home, 'standby'), {}, home)).rejects.toThrow(/must not contain each other/)
    await expect(runReceiveOp('init', sb.root, {}, home)).rejects.toThrow(/must not contain each other/)
    expect(fs.existsSync(home)).toBe(false)
    // A link that leads into the home is the home.
    fs.mkdirSync(home)
    fs.symlinkSync(home, path.join(sb.root, 'looks-elsewhere'))
    await expect(runReceiveOp('init', path.join(sb.root, 'looks-elsewhere', 'standby'), {}, home)).rejects.toThrow(/must not contain each other/)
    expect(fs.readdirSync(home)).toEqual([])
  })

  it('takes an upload or export path only inside the target\'s .incoming/', async () => {
    sb = await sandbox('receive-paths')
    await expect(runReceiveOp('init', sb.target, { export: path.join(sb.root, 'elsewhere.gz'), chunks: true }, path.join(sb.root, 'host-home'))).rejects.toThrow(/is not a file of/)
    await expect(runReceiveOp('apply', sb.target, { upload: path.join(sb.target, '.incoming', '..', 'standby.json') }, path.join(sb.root, 'host-home'))).rejects.toThrow(/is not a file of/)
    await expect(runReceiveOp('nope', sb.target, {}, path.join(sb.root, 'host-home'))).rejects.toThrow(/unknown receive op/)
  })
})
