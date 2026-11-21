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

function remote(l: ReturnType<typeof fakeStandbyHost>, o: { linkWaitMs?: number } = {}) {
  return new RemoteStandbyTarget({ connect: async () => l.link, dir: sb.target, linkWaitMs: o.linkWaitMs ?? 5_000 })
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
    // One new chunk and the upload; the target's files were not read again (this side holds them).
    expect(chunkWrites(l, mark)).toBe(2)
    expect(l.log.slice(mark).filter((e) => e.cmd === 'fs.readRange').reduce((n, e) => n + e.bytes, 0)).toBeLessThan(200)
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

  it('an apply whose answer was lost is judged by what the target holds', async () => {
    sb = await sandbox('remote-lost-apply')
    dbs.push(...seedHome(sb.home).dbs)
    await settle()
    const l = fakeStandbyHost(sb.root)
    l.state.fault = (cmd, params) => (cmd === 'exec.script' && (params.args as string[])[3] === 'apply' ? 'lost-after' : undefined)
    const t = remote(l)
    const out = await batch(t)
    expect(out.ok, out.ok ? '' : out.reason).toBe(true)
    expect((await standbyStatus(sb.target)).batch).toBe(1)
    // Only one apply ran: a lost apply is never sent again.
    expect(l.log.filter((e) => e.cmd === 'receive apply')).toHaveLength(1)
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
  it('holds chunks to send so the batch reads on, up to its buffer, and flush waits for them', async () => {
    sb = await sandbox('remote-buffer')
    const l = fakeStandbyHost(sb.root)
    let open!: () => void
    const gate = new Promise<void>((r) => { open = r })
    l.state.fault = () => undefined
    const slow = { ...l.link, send: async (cmd: string, params?: Record<string, unknown>, ms?: number) => { if (cmd === 'fs.writePart') await gate; return l.link.send(cmd, params, ms) } }
    const chunk = (n: number) => { const d = Buffer.alloc(1024 * 1024, n); return { id: sha256Hex(d), d } }
    const t = new RemoteStandbyTarget({ connect: async () => slow, dir: sb.target, bufferBytes: 2 * 1024 * 1024 })
    await t.current()
    const [a, b, c] = [chunk(1), chunk(2), chunk(3)]
    // Two fit the buffer: they return before anything was sent.
    await t.putChunk(a.id, a.d)
    await t.putChunk(b.id, b.d)
    // The third waits for room.
    let third = false
    const p = t.putChunk(c.id, c.d).then(() => { third = true })
    await new Promise((r) => setTimeout(r, 50))
    expect(third).toBe(false)
    open()
    await p
    await t.flush()
    for (const x of [a, b, c]) expect(fs.existsSync(path.join(sb.target, 'chunks', x.id.slice(0, 2), x.id))).toBe(true)
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
  })

  it('takes an upload or export path only inside the target\'s .incoming/', async () => {
    sb = await sandbox('receive-paths')
    await expect(runReceiveOp('init', sb.target, { export: path.join(sb.root, 'elsewhere.gz'), chunks: true }, path.join(sb.root, 'host-home'))).rejects.toThrow(/is not a file of/)
    await expect(runReceiveOp('apply', sb.target, { upload: path.join(sb.target, '.incoming', '..', 'standby.json') }, path.join(sb.root, 'host-home'))).rejects.toThrow(/is not a file of/)
    await expect(runReceiveOp('nope', sb.target, {}, path.join(sb.root, 'host-home'))).rejects.toThrow(/unknown receive op/)
  })
})
