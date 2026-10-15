/**
 * A v1 journal is claimed by rename before it is read (offline-journal-core.ts claimV1;
 * docs/plan/walnut-replica-servers-impl.md section 5, Migration).
 *
 * WP8 review round 4: a 1fe1fd194 daemon still running in a legacy dir writes its journal by
 * tmp + rename. A record it wrote between the migration's read and the `.migrated` rename was
 * renamed aside unread, and `.migrated` files are never read again, so it was lost. Now the
 * file is renamed to `<file>.migrating-<ms>-<hex>` first: a later v1 write makes a NEW
 * `journal-<key>.json`, which the next boot takes (its old records dedupe by v1 op id).
 *
 * The v1 writer is the real 1fe1fd194 offline host (tests/helpers/v1-daemon-sources.ts); the
 * race is injected through deps.fs, never by timing.
 */
import { describe, it, expect, afterAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { JHOME, SID_A, journalStore, jslice, keyOf, type Clock } from '../helpers/offline-journal-harness.js'
import { createJournalMigration } from '../../src/providers/offline-journal-core.js'
import { createEnvelopeKit } from '../../src/core/peers/envelope-kit.js'
import { oldOfflineHost, cleanupOldSources } from '../helpers/v1-daemon-sources.js'

const scratch: string[] = []
afterAll(() => {
  for (const d of scratch) fs.rmSync(d, { recursive: true, force: true })
  cleanupOldSources()
})

/** A fake HOME with the fallback daemon's legacy dir (owner-only, as the old daemon made it) and the v2 root. */
function layout(): { legacy: string; v2dir: string; clock: Clock } {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-claim-'))
  scratch.push(home)
  const fallback = path.join(home, '.cache', 'open-walnut')
  const legacy = path.join(fallback, 'offline-host')
  fs.mkdirSync(legacy, { recursive: true, mode: 0o700 })
  for (const d of [home, path.join(home, '.cache'), fallback, legacy]) fs.chmodSync(d, 0o700)
  const v2dir = path.join(home, '.open-walnut', 'tmp', 'offline-host')
  fs.mkdirSync(v2dir, { recursive: true, mode: 0o700 })
  return { legacy, v2dir, clock: { now: Date.parse('2026-10-14T10:00:00Z') } as Clock }
}

async function v1Host(legacy: string, clock: Clock) {
  const create = await oldOfflineHost()
  const old = create({
    fs, path, dir: legacy, now: () => clock.now, randomHex: (n: number) => randomBytes(n).toString('hex'), keyOf, kit: createEnvelopeKit(),
    log: () => {}, isLive: () => true, turnActive: () => false, streamOffset: () => undefined, deliver: async () => ({ ok: true }),
  })
  old.configure(jslice())
  return old
}

const efforts = (j: ReturnType<typeof journalStore>) => j.records(JHOME).map((r: Record<string, unknown>) => r.effort)

function boot(v2dir: string, legacy: string, clock: Clock, fsImpl: typeof fs = fs) {
  const journal = journalStore(v2dir, clock, { fs: fsImpl })
  createJournalMigration({ path, journal, dir: v2dir, legacyDirs: [legacy], log: () => {} }).boot()
  return journal
}

describe('a v1 journal is claimed before it is read', () => {
  it('a record the live v1 daemon writes during the migration lands in a new file and the next boot takes it, once', async () => {
    const { legacy, v2dir, clock } = layout()
    const old = await v1Host(legacy, clock)
    old.noteSettings(JHOME, SID_A, { effort: 'low' })
    clock.now += 1000
    old.noteSettings(JHOME, SID_A, { effort: 'high' })
    const v1File = path.join(legacy, `journal-${keyOf(JHOME)}.json`)
    let injected = false
    // The old daemon's next write lands right before the claim is set aside as `.migrated`.
    const racingFs = new Proxy(fs, {
      get(t, k) {
        if (k !== 'renameSync') return (t as unknown as Record<string | symbol, unknown>)[k]
        return (from: string, to: string) => {
          if (!injected && String(to).endsWith('.migrated')) {
            injected = true
            clock.now += 1000
            old.noteSettings(JHOME, SID_A, { effort: 'max' })
          }
          return t.renameSync(from, to)
        }
      },
    })
    const first = boot(v2dir, legacy, clock, racingFs as typeof fs)
    expect(injected).toBe(true)
    expect(efforts(first)).toEqual(['low', 'high'])
    // The old daemon's rewrite is a new file at the v1 name, every record of it.
    const rewritten = JSON.parse(fs.readFileSync(v1File, 'utf8')) as { records: Array<{ effort: string }> }
    expect(rewritten.records.map((r) => r.effort)).toEqual(['low', 'high', 'max'])
    const migrated = fs.readdirSync(legacy).filter((n) => n.endsWith('.migrated'))
    expect(migrated).toEqual([`journal-${keyOf(JHOME)}.json.migrated`])
    // The next boot takes the new file: 'max' arrives, 'low' and 'high' are not doubled.
    first.close()
    const next = boot(v2dir, legacy, clock)
    expect(efforts(next)).toEqual(['low', 'high', 'max'])
    expect(fs.existsSync(v1File)).toBe(false)
    next.close()
  })

  it('a claim put back never replaces a file the v1 daemon wrote since: both are kept and the next boot takes both, once', async () => {
    const { legacy, v2dir, clock } = layout()
    const old = await v1Host(legacy, clock)
    old.noteSettings(JHOME, SID_A, { effort: 'low' })
    const v1File = path.join(legacy, `journal-${keyOf(JHOME)}.json`)
    let wrote = false
    // The claim's read fails, and the old daemon writes again right then (a new file at the v1 name).
    const failingFs = new Proxy(fs, {
      get(t, k) {
        if (k !== 'readFileSync') return (t as unknown as Record<string | symbol, unknown>)[k]
        return (file: fs.PathOrFileDescriptor, ...rest: unknown[]) => {
          if (/\.migrating-\d+-[0-9a-f]+$/.test(String(file))) {
            if (!wrote) { wrote = true; clock.now += 1000; old.noteSettings(JHOME, SID_A, { effort: 'high' }) }
            throw Object.assign(new Error('EMFILE: too many open files'), { code: 'EMFILE' })
          }
          return (t.readFileSync as (...a: unknown[]) => unknown)(file, ...rest)
        }
      },
    })
    const first = boot(v2dir, legacy, clock, failingFs as typeof fs)
    expect(efforts(first)).toEqual([])
    expect(fs.readdirSync(legacy).filter((n) => /\.migrating-/.test(n))).toHaveLength(1)
    const v1Now = JSON.parse(fs.readFileSync(v1File, 'utf8')) as { records: Array<{ effort: string }> }
    expect(v1Now.records.map((r) => r.effort)).toEqual(['low', 'high'])
    first.close()
    const next = boot(v2dir, legacy, clock)
    expect(efforts(next)).toEqual(['low', 'high'])
    expect(fs.readdirSync(legacy).filter((n) => /\.migrating-|^journal-[^.]+\.json$/.test(n))).toEqual([])
    next.close()
  })

  it('a claim a crash left is migrated at the next boot and set aside under the v1 name', async () => {
    const { legacy, v2dir, clock } = layout()
    const old = await v1Host(legacy, clock)
    old.noteSettings(JHOME, SID_A, { effort: 'low' })
    const v1File = path.join(legacy, `journal-${keyOf(JHOME)}.json`)
    const claim = `${v1File}.migrating-1792000000000-a1b2c3d4`
    fs.renameSync(v1File, claim)
    const j = boot(v2dir, legacy, clock)
    expect(efforts(j)).toEqual(['low'])
    expect(fs.existsSync(claim)).toBe(false)
    expect(fs.readdirSync(legacy)).toContain(`journal-${keyOf(JHOME)}.json.migrated`)
    j.close()
  })

  it('a claim that cannot be read (EMFILE) goes back under the v1 name, and the next clean boot migrates it once', async () => {
    const { legacy, v2dir, clock } = layout()
    const old = await v1Host(legacy, clock)
    old.noteSettings(JHOME, SID_A, { effort: 'low' })
    const failingFs = new Proxy(fs, {
      get(t, k) {
        if (k !== 'readFileSync') return (t as unknown as Record<string | symbol, unknown>)[k]
        return (file: fs.PathOrFileDescriptor, ...rest: unknown[]) => {
          if (/\.migrating-\d+-[0-9a-f]+$/.test(String(file))) throw Object.assign(new Error('EMFILE: too many open files'), { code: 'EMFILE' })
          return (t.readFileSync as (...a: unknown[]) => unknown)(file, ...rest)
        }
      },
    })
    const first = boot(v2dir, legacy, clock, failingFs as typeof fs)
    expect(efforts(first)).toEqual([])
    expect(fs.readdirSync(legacy).filter((n) => /\.migrating-/.test(n))).toEqual([])
    expect(fs.existsSync(path.join(legacy, `journal-${keyOf(JHOME)}.json`))).toBe(true)
    first.close()
    const next = boot(v2dir, legacy, clock)
    expect(efforts(next)).toEqual(['low'])
    expect(fs.readdirSync(legacy).filter((n) => /\.migrating-/.test(n))).toEqual([])
    next.close()
    const again = boot(v2dir, legacy, clock)
    expect(efforts(again)).toEqual(['low'])
    again.close()
  })
})
