/**
 * The old leader's final batch in the new leader's standby folder (standby-cleanup.ts): kept
 * through the switch-back window, removed after it (and after a batch of the new leader's own),
 * never while a standby sends there, and never anything outside that folder. Fake homes and
 * standby folders in a temp dir only.
 */
import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import YAML from 'yaml'
import { cleanSwitchedStandby } from '../../../../src/core/leader/switch/standby-cleanup.js'
import { appendHistory, removeMarker, writeMarker, writePromoted, switchDir } from '../../../../src/core/leader/switch/records.js'
import { snapshotTo, standbyStatus } from '../../../../src/core/standby/index.js'
import { afterSwitchCleanup, startStandbyRunner, type StandbyRunner } from '../../../../src/core/standby/runner.js'
import { removeTree } from '../../../../src/core/standby/target-files.js'
import { walk, write } from '../../standby/helpers.js'

const H = 3_600_000

interface World {
  root: string
  /** The old leader's home (handed over), whose final batch sits in `orphan`. */
  homeA: string
  /** The new leader's home. */
  homeB: string
  /** B's standby_dir: where A's batches landed. */
  orphan: string
  /** A's standby_dir: where B's batches go now (B's own standby target). */
  own: string
  /** A file beside the orphan folder that nothing may touch. */
  outside: string
  committedAt: number
}

let world: World | null = null
let runner: StandbyRunner | null = null
afterEach(async () => {
  runner?.stop()
  runner = null
  if (world) await removeTree(world.root)
  world = null
})

/** `committedAgoMs`: how long before now (after the old leader's final batch) the switch committed; default 1 s after it. */
async function makeWorld(o: { backWindowHours?: number; committedAgoMs?: number } = {}): Promise<World> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'switch-standby-cleanup-'))
  const homeA = path.join(root, 'a', 'home')
  const homeB = path.join(root, 'b', 'home')
  const orphan = path.join(root, 'b', 'standby')
  const own = path.join(root, 'a', 'standby')
  const outside = path.join(root, 'b', 'keep-me.txt')
  for (const d of [homeA, homeB]) fs.mkdirSync(d, { recursive: true })
  fs.writeFileSync(outside, 'not the standby folder\n')
  write(homeA, 'memory/MEMORY.md', '# Memory\n')
  write(homeA, 'notes/a.md', 'x'.repeat(200_000))
  // A's batches landed at B: the final one is what stays behind.
  const batch = await snapshotTo(homeA, orphan)
  if (!batch.ok) throw new Error(batch.reason)
  // The promotion renamed its copy/ into the new home: only the chunks and manifests stay.
  await removeTree(path.join(orphan, 'copy'))
  const committedAt = Date.now() - (o.committedAgoMs ?? -1_000)
  const cfg = {
    experimental: { switchable_leader: true },
    standby: { dir: own },
    leader_switch: {
      witnesses: [1, 2, 3].map((i) => ({ id: `w${i}`, dir: path.join(root, `w${i}`) })),
      machines: [
        { id: 'machine-a', home: homeA, standby_dir: own, port: 3461 },
        { id: 'machine-b', home: homeB, standby_dir: orphan, port: 3462 },
      ],
      back_window_hours: o.backWindowHours ?? 1,
    },
  }
  fs.writeFileSync(path.join(homeB, 'config.yaml'), YAML.stringify(cfg))
  write(homeB, 'memory/MEMORY.md', '# Memory\n')
  appendHistory(homeB, { switchId: 's1', from: 'machine-a', to: 'machine-b', committedAt: new Date(committedAt).toISOString(), record: 7 })
  writePromoted(homeB, { switchId: 's1', state: 'led', from: homeA, at: new Date(committedAt).toISOString() })
  return { root, homeA, homeB, orphan, own, outside, committedAt }
}

const after = (w: World, ms: number) => new Date(w.committedAt + ms).toISOString()
const chunksLeft = (dir: string) => walk(path.join(dir, 'chunks')).length

describe('the orphan standby folder after a switch', () => {
  it('is removed past the window, after a batch of its own: the folder stays empty, nothing outside it moves', async () => {
    const w = world = await makeWorld()
    expect(chunksLeft(w.orphan)).toBeGreaterThan(0)
    const beforeA = walk(w.homeA)
    const beforeB = walk(w.homeB)
    const r = await cleanSwitchedStandby({ home: w.homeB, ownBatchTakenAt: after(w, H + 60_000), now: w.committedAt + H + 120_000 })
    expect(r).toMatchObject({ removed: true, dir: w.orphan, switchId: 's1', refused: [] })
    expect(r.removed && r.bytes).toBeGreaterThan(200_000)
    expect(fs.existsSync(w.orphan)).toBe(true)
    expect(fs.readdirSync(w.orphan).filter((n) => !n.endsWith('.lock') && n !== 'drift')).toEqual([])
    expect(walk(w.homeA)).toEqual(beforeA)
    expect(walk(w.homeB)).toEqual(beforeB)
    expect(fs.readFileSync(w.outside, 'utf8')).toBe('not the standby folder\n')
    // A valid empty target: a later sender finds no batch.
    await expect(standbyStatus(w.orphan)).rejects.toThrow(/holds no standby copy/)
    // Run again: nothing to do.
    expect(await cleanSwitchedStandby({ home: w.homeB, ownBatchTakenAt: after(w, H + 60_000), now: w.committedAt + 2 * H })).toMatchObject({ removed: false, why: 'the folder holds no standby copy' })
  })

  it('is kept inside the window, and without a batch of the new leader since the switch', async () => {
    const w = world = await makeWorld()
    const before = walk(w.orphan)
    expect(await cleanSwitchedStandby({ home: w.homeB, ownBatchTakenAt: after(w, 60_000), now: w.committedAt + H - 1 })).toMatchObject({ removed: false, why: 'the switch-back window has not passed', notBefore: w.committedAt + H })
    expect(await cleanSwitchedStandby({ home: w.homeB, ownBatchTakenAt: null, now: w.committedAt + 2 * H })).toMatchObject({ removed: false, why: expect.stringMatching(/own standby has no complete batch/) })
    expect(await cleanSwitchedStandby({ home: w.homeB, ownBatchTakenAt: after(w, -1), now: w.committedAt + 2 * H })).toMatchObject({ removed: false })
    expect(walk(w.orphan)).toEqual(before)
  })

  it('is kept while the switch has not finished here, or a switch from this home is under way', async () => {
    const w = world = await makeWorld()
    const before = walk(w.orphan)
    const late = { home: w.homeB, ownBatchTakenAt: after(w, H + 60_000), now: w.committedAt + 2 * H }
    writePromoted(w.homeB, { switchId: 's1', state: 'promoted', at: new Date().toISOString() })
    expect(await cleanSwitchedStandby(late)).toMatchObject({ removed: false, why: 'switch s1 has not finished here' })
    writePromoted(w.homeB, { switchId: 's1', state: 'led', at: new Date().toISOString() })
    fs.writeFileSync(path.join(switchDir(w.homeB), 'switch-state.json'), JSON.stringify({ id: 's2', step: 'final-batch' }))
    expect(await cleanSwitchedStandby(late)).toMatchObject({ removed: false, why: 'a switch from this home is under way' })
    fs.writeFileSync(path.join(switchDir(w.homeB), 'switch-state.json'), JSON.stringify({ id: 's2', step: 'done' }))
    writeMarker(w.homeB, { switchId: 's2', to: 'machine-a', state: 'handed-over', at: new Date().toISOString() })
    expect(await cleanSwitchedStandby(late)).toMatchObject({ removed: false, why: 'this home was handed over: it does not lead' })
    removeMarker(w.homeB)
    fs.rmSync(path.join(switchDir(w.homeB), 'history.json'))
    expect(await cleanSwitchedStandby(late)).toMatchObject({ removed: false, why: 'no switch made this home the leader' })
    expect(walk(w.orphan)).toEqual(before)
  })

  it('is never touched while a standby sends to it (a batch committed there after the switch)', async () => {
    const w = world = await makeWorld({ committedAgoMs: 2 * H })
    // The old machine leads again and sends here: its batch is newer than the switch.
    write(w.homeA, 'notes/b.md', 'new since\n')
    const live = await snapshotTo(w.homeA, w.orphan)
    expect(live.ok).toBe(true)
    const before = walk(w.orphan)
    const r = await cleanSwitchedStandby({ home: w.homeB, ownBatchTakenAt: new Date().toISOString() })
    expect(r).toMatchObject({ removed: false, why: expect.stringMatching(/after the switch: a standby sends to it/) })
    expect(walk(w.orphan)).toEqual(before)
  })

  it('refuses a folder that holds or sits in this home or its own standby target, links resolved', async () => {
    const w = world = await makeWorld()
    const late = { home: w.homeB, ownBatchTakenAt: after(w, H + 60_000), now: w.committedAt + 2 * H }
    // B's own standby target is the orphan folder, through a link.
    const link = path.join(w.root, 'own-link')
    fs.symlinkSync(w.orphan, link)
    const cfgFile = path.join(w.homeB, 'config.yaml')
    const cfg = YAML.parse(fs.readFileSync(cfgFile, 'utf8'))
    cfg.standby.dir = link
    fs.writeFileSync(cfgFile, YAML.stringify(cfg))
    expect(await cleanSwitchedStandby(late)).toMatchObject({ removed: false, why: expect.stringMatching(/contain each other/) })
    // The machine's standby_dir is a link to the home's parent.
    cfg.standby.dir = w.own
    cfg.leader_switch.machines[1].standby_dir = path.join(w.root, 'home-parent-link')
    fs.symlinkSync(path.dirname(w.homeB), path.join(w.root, 'home-parent-link'))
    fs.writeFileSync(cfgFile, YAML.stringify(cfg))
    expect(await cleanSwitchedStandby(late)).toMatchObject({ removed: false, why: expect.stringMatching(/contain each other/) })
    expect(chunksLeft(w.orphan)).toBeGreaterThan(0)
    expect(fs.existsSync(path.join(w.homeB, 'memory', 'MEMORY.md'))).toBe(true)
  })

  it('leaves an entry that is a link, and never enters one: what it points at outside stays', async () => {
    const w = world = await makeWorld()
    const away = path.join(w.root, 'elsewhere')
    fs.mkdirSync(away)
    fs.writeFileSync(path.join(away, 'precious.txt'), 'outside\n')
    // copy/ (gone after the promotion) is a link out of the folder; a chunk subfolder holds a link out too.
    fs.symlinkSync(away, path.join(w.orphan, 'copy'))
    const sub = fs.readdirSync(path.join(w.orphan, 'chunks'))[0]!
    fs.chmodSync(path.join(w.orphan, 'chunks', sub), 0o700)
    fs.symlinkSync(path.join(away, 'precious.txt'), path.join(w.orphan, 'chunks', sub, 'link-out'))
    const r = await cleanSwitchedStandby({ home: w.homeB, ownBatchTakenAt: after(w, H + 60_000), now: w.committedAt + 2 * H })
    expect(r).toMatchObject({ removed: true, refused: ['copy'] })
    expect(fs.lstatSync(path.join(w.orphan, 'copy')).isSymbolicLink()).toBe(true)
    expect(fs.readFileSync(path.join(away, 'precious.txt'), 'utf8')).toBe('outside\n')
    expect(fs.existsSync(path.join(w.orphan, 'chunks'))).toBe(false)
  })

  it('finishes what a removal that failed partway left: the rest of the batch joins its .discard-* folder, then goes', async () => {
    const w = world = await makeWorld()
    // Failed after standby.json was moved aside, before the manifests and chunks.
    const bin = path.join(w.orphan, '.discard-1700000000000')
    fs.mkdirSync(bin)
    fs.renameSync(path.join(w.orphan, 'standby.json'), path.join(bin, 'standby.json'))
    fs.mkdirSync(path.join(w.orphan, '.discard-notmine'))
    expect(chunksLeft(w.orphan)).toBeGreaterThan(0)
    const r = await cleanSwitchedStandby({ home: w.homeB, ownBatchTakenAt: after(w, H + 60_000), now: w.committedAt + 2 * H })
    expect(r).toMatchObject({ removed: false, why: 'the folder holds no standby copy' })
    expect(fs.existsSync(bin)).toBe(false)
    expect(fs.existsSync(path.join(w.orphan, 'chunks'))).toBe(false)
    expect(fs.existsSync(path.join(w.orphan, 'batches'))).toBe(false)
    expect(fs.existsSync(path.join(w.orphan, '.discard-notmine'))).toBe(true)
    expect(fs.readFileSync(w.outside, 'utf8')).toBe('not the standby folder\n')
  })

  it('a folder with chunks and no standby.json but no .discard-* folder is not touched (a first batch may be arriving)', async () => {
    const w = world = await makeWorld()
    fs.rmSync(path.join(w.orphan, 'standby.json'))
    const before = walk(w.orphan)
    const r = await cleanSwitchedStandby({ home: w.homeB, ownBatchTakenAt: after(w, H + 60_000), now: w.committedAt + 2 * H })
    expect(r).toMatchObject({ removed: false, why: 'the folder holds no standby copy' })
    expect(walk(w.orphan)).toEqual(before)
  })

  it('the standby runner of the new leader removes it after its own batch once the window passed', async () => {
    const w = world = await makeWorld({ backWindowHours: 0.0002, committedAgoMs: -20 })
    await new Promise((r) => setTimeout(r, 900))
    const cleanup = afterSwitchCleanup()
    runner = startStandbyRunner({
      settings: async () => ({ on: true, home: w.homeB, dir: w.own, intervalSeconds: 3600 }),
      notify: async () => true,
      afterBatch: cleanup,
    })
    await runner.reconcile()
    const out = await runner.runOnce()
    expect(out?.ok, out && !out.ok ? out.reason : '').toBe(true)
    // Started detached: the batch did not wait for it.
    await cleanup.whenIdle()
    expect(fs.existsSync(path.join(w.orphan, 'chunks'))).toBe(false)
    expect((await standbyStatus(w.own)).batch).toBe(1)
    expect(fs.readFileSync(w.outside, 'utf8')).toBe('not the standby folder\n')
  }, 60_000)

  it('the runner\'s cleanup loads nothing of the switch for a home no switch made the leader', async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'switch-standby-cleanup-plain-'))
    try {
      const before = walk(root)
      await afterSwitchCleanup()(root, new Date().toISOString())
      expect(walk(root)).toEqual(before)
    } finally {
      await removeTree(root)
    }
  })
})
