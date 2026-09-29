/**
 * The NDJSON store (local-day files, retention) and the incremental tailer
 * (cursor per file, partial lines, truncation, rotation).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Store, dayRange, dayStartMs, localDay, nextDay, prevDay, pruneStore, readDays } from '../../../scripts/bridge-monitor/lib/store.mjs'
import { Tailer } from '../../../scripts/bridge-monitor/lib/tail.mjs'
import { loadConfig, mergeConfig, DEFAULTS } from '../../../scripts/bridge-monitor/lib/config.mjs'

let dir = ''
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bm-store-')) })
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }) })

describe('local days', () => {
  it('a UTC instant lands on the local calendar day of the given zone', () => {
    expect(localDay('2026-03-10T06:30:00Z', 'America/Los_Angeles')).toBe('2026-03-09')
    expect(localDay('2026-03-10T06:30:00Z', 'Asia/Tokyo')).toBe('2026-03-10')
    expect(localDay('2026-03-10T23:30:00Z', 'UTC')).toBe('2026-03-10')
  })

  it('local midnight, across a DST change (2026-03-08 in the US is 23 hours long)', () => {
    const tz = 'America/Los_Angeles'
    expect(new Date(dayStartMs('2026-03-08', tz)).toISOString()).toBe('2026-03-08T08:00:00.000Z')
    expect(new Date(dayStartMs('2026-03-09', tz)).toISOString()).toBe('2026-03-09T07:00:00.000Z')
    expect((dayStartMs('2026-03-09', tz) - dayStartMs('2026-03-08', tz)) / 3_600_000).toBe(23)
  })

  it('day arithmetic', () => {
    expect(nextDay('2026-02-28')).toBe('2026-03-01')
    expect(prevDay('2026-03-01')).toBe('2026-02-28')
    expect(dayRange('2026-03-02', 3)).toEqual(['2026-02-28', '2026-03-01', '2026-03-02'])
  })
})

describe('Store', () => {
  it('appends to the local-day file and reads it back; probe records get their own prefix', async () => {
    const s = new Store(dir, { tz: 'UTC' })
    await s.append([{ t: '2026-03-10T10:00:00Z', kind: 'net' }, { t: '2026-03-11T00:00:01Z', kind: 'load' }])
    await new Store(dir, { tz: 'UTC', prefix: 'probe' }).append({ t: '2026-03-10T11:00:00Z', kind: 'probe', ev: 'connected' })
    expect(fs.readdirSync(dir).sort()).toEqual(['2026-03-10.ndjson', '2026-03-11.ndjson', 'probe-2026-03-10.ndjson'])
    expect((await readDays(dir, ['2026-03-10', '2026-03-11'])).map((r: any) => r.kind)).toEqual(['net', 'load'])
    expect(await readDays(dir, ['2026-03-10'], { prefix: 'probe' })).toHaveLength(1)
  })

  it('a torn last line (crash mid-write) is skipped, the rest is read', async () => {
    fs.writeFileSync(path.join(dir, '2026-03-10.ndjson'), '{"t":"2026-03-10T01:00:00Z","kind":"a"}\n{"t":"2026-03-1')
    expect(await readDays(dir, ['2026-03-10', '2026-03-12'])).toHaveLength(1)
  })

  it('retention removes only dated store files older than N days', async () => {
    for (const n of ['2026-02-20.ndjson', 'probe-2026-02-24.ndjson', '2026-02-25.ndjson', '2026-03-10.ndjson', 'collector.out.log', 'notes.ndjson']) {
      fs.writeFileSync(path.join(dir, n), 'x\n')
    }
    const removed = await pruneStore(dir, 14, '2026-03-10')
    // 14 days ending 2026-03-10 keeps 02-25 .. 03-10.
    expect(removed.sort()).toEqual(['2026-02-20.ndjson', 'probe-2026-02-24.ndjson'])
    expect(fs.readdirSync(dir).sort()).toEqual(['2026-02-25.ndjson', '2026-03-10.ndjson', 'collector.out.log', 'notes.ndjson'])
  })
})

describe('Tailer', () => {
  it('first sight at "end" skips history; "start" reads it; then only new complete lines', async () => {
    const f = path.join(dir, 'a.log')
    fs.writeFileSync(f, 'old1\nold2\n')
    const t = new Tailer({})
    expect(await t.read(f, { firstSeen: 'end' })).toEqual([])
    fs.appendFileSync(f, 'new1\nnew2\npart')
    expect(await t.read(f)).toEqual(['new1', 'new2'])
    fs.appendFileSync(f, 'ial\n')
    expect(await t.read(f)).toEqual(['partial'])
    const t2 = new Tailer({})
    expect(await t2.read(f, { firstSeen: 'start' })).toEqual(['old1', 'old2', 'new1', 'new2', 'partial'])
  })

  it('the cursor survives a restart through the persisted object (no duplicates)', async () => {
    const f = path.join(dir, 'b.log')
    fs.writeFileSync(f, 'l1\n')
    const cursors = {}
    await new Tailer(cursors).read(f, { firstSeen: 'start' })
    fs.appendFileSync(f, 'l2\n')
    const restored = new Tailer(JSON.parse(JSON.stringify(cursors)))
    expect(await restored.read(f)).toEqual(['l2'])
  })

  it('truncation and rotation (new inode) restart from the top', async () => {
    const f = path.join(dir, 'c.log')
    fs.writeFileSync(f, 'aaaaaaaaaaaa\nbbbbbbbbbbbb\n')
    const t = new Tailer({})
    await t.read(f, { firstSeen: 'start' })
    fs.writeFileSync(f, 'x\n')
    expect(await t.read(f, { firstSeen: 'start' })).toEqual(['x'])
    fs.rmSync(f)
    fs.writeFileSync(f, 'rotated\n')
    expect(await t.read(f, { firstSeen: 'start' })).toEqual(['rotated'])
  })

  it('a filter keeps only matching lines; a missing file is empty and forgets its cursor', async () => {
    const f = path.join(dir, 'd.log')
    fs.writeFileSync(f, '{"msg":"bridge: connected"}\n{"msg":"other"}\n')
    const cursors: Record<string, unknown> = {}
    const t = new Tailer(cursors)
    expect(await t.read(f, { firstSeen: 'start', filter: (l: string) => l.includes('"msg":"bridge') })).toHaveLength(1)
    fs.rmSync(f)
    expect(await t.read(f)).toEqual([])
    expect(cursors[f]).toBeUndefined()
  })
})

describe('config', () => {
  it('a missing file gives the defaults; the probe ships disabled', () => {
    const { cfg, error } = loadConfig(path.join(dir, 'absent.json'))
    expect(error).toBeNull()
    expect(cfg.probe.enabled).toBe(false)
    expect(cfg.retentionDays).toBe(14)
    expect(cfg.logDir).toMatch(/Library\/Logs\/Walnut\/bridge-monitor$/)
    expect(cfg.logDir.startsWith('/tmp')).toBe(false)
  })

  it('a broken file falls back to defaults and reports the error (never a crash loop)', () => {
    const f = path.join(dir, 'bad.json')
    fs.writeFileSync(f, '{ not json')
    const { cfg, error } = loadConfig(f)
    expect(error).toBeTruthy()
    expect(cfg.alert.maxDropsPer10Min).toBe(3)
  })

  it('merges nested sections key by key and expands ~', () => {
    const f = path.join(dir, 'ok.json')
    fs.writeFileSync(f, JSON.stringify({ alert: { outageSec: 90 }, probe: { tokenFile: '~/probe.token' }, replicaLogDir: '~/exports' }))
    const { cfg } = loadConfig(f)
    expect(cfg.alert).toMatchObject({ outageSec: 90, maxDropsPer10Min: 3 })
    expect(cfg.probe.tokenFile).toBe(path.join(os.homedir(), 'probe.token'))
    expect(cfg.replicaLogDir).toBe(path.join(os.homedir(), 'exports'))
    expect(mergeConfig(DEFAULTS, null)).toBe(DEFAULTS)
  })
})

describe('heavy-job guard', () => {
  it('counts a slot busy only while its holder lives (or it is freshly made and unstamped)', async () => {
    const { busySlots } = await import('../../../scripts/bridge-monitor/lib/pressure.mjs')
    const base = path.join(dir, 'heavy.slot')
    expect(await busySlots({ base, count: 2 })).toBe(0)
    fs.mkdirSync(`${base}.1`)
    fs.writeFileSync(`${base}.1/pid`, String(process.pid))
    fs.mkdirSync(`${base}.2`)
    expect(await busySlots({ base, count: 2 })).toBe(2) // slot 2: unstamped but young
    expect(await busySlots({ base, count: 2 }, Date.now() + 120_000)).toBe(1) // ...and stale after a minute
    fs.writeFileSync(`${base}.2/pid`, '999999')
    expect(await busySlots({ base, count: 2 })).toBe(1) // dead holder frees the slot
    fs.writeFileSync(`${base}.2/pid`, '1')
    expect(await busySlots({ base, count: 2 })).toBe(1) // pid 1 is never treated as a holder
  })

  it('skips when every slot is held or memory pressure is at the limit, and says why', async () => {
    const { heavyGuard } = await import('../../../scripts/bridge-monitor/lib/pressure.mjs')
    const deps = (busy: number, pressure: number | null) => ({ busySlots: async () => busy, pressureLevel: async () => pressure })
    const slots = { base: '/nonexistent', count: 2 }
    expect(await heavyGuard({ busySlots: slots, maxPressureLevel: 4 }, deps(2, 1))).toMatchObject({ busy: true, reason: 'heavy-job slots busy (2/2)' })
    expect(await heavyGuard({ busySlots: slots, maxPressureLevel: 4 }, deps(1, 1))).toMatchObject({ busy: false, slotsBusy: 1 })
    expect(await heavyGuard({ busySlots: slots, maxPressureLevel: 4 }, deps(0, 4))).toMatchObject({ busy: true, reason: 'memory pressure level 4' })
    expect(await heavyGuard({ busySlots: null, maxPressureLevel: 4 }, deps(9, 2))).toMatchObject({ busy: false, slotsBusy: null })
    expect(await heavyGuard({}, deps(0, null))).toMatchObject({ busy: false })
  })
})
