/**
 * triggers.state.seed rules (trigger-state-seed-core.ts): a snapshot's state is
 * written only as the asking Walnut's own file of a trigger nothing holds, only where
 * no file is (never over one, never through a symlink), only when it parses with the
 * snapshot's strict parser and matches its digest; every refusal is a reason, never
 * a throw, and a resend of the same state answers seeded.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { canonicalTriggerStateJson, parseSnapshotState, triggerStateDigest, TRIGGER_STATE_SNAPSHOT_MAX_BYTES } from '../../src/providers/trigger-state-snapshot-core.js'
import { checkSeedLive, seedTriggerState, validateSeedState, type SeedLiveFacts, type TriggerStateSeedDeps } from '../../src/providers/trigger-state-seed-core.js'

const HOME = '/data/walnut-a'
const TID = 'mail-watch-1'
const quiet: SeedLiveFacts = { configured: false, armed: false, draining: false, checkRunning: false, hostDeliveryInFlight: false }

const goodState = () => ({
  version: 1, epoch: 'epoch-old', seen: { 'uid-1': 1_000, 'uid-2': 2_000 }, state: { z: 1, a: [2, 3] },
  budget: { used: 1, atMs: 900 }, pendingFires: [], consecutiveErrors: 0, seq: 7, lastRunAtMs: 2_100, sharedCopy: true,
})
const digestOf = (s: unknown) => createHash('sha256').update(canonicalTriggerStateJson(s)).digest('hex')

let dir = ''
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trig-seed-')) })
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }) })

const scopeDir = () => path.join(dir, 'walnuts', 'a')
const fileOf = (tid: string) => path.join(scopeDir(), `${tid}.json`)
const deps = (over: Partial<TriggerStateSeedDeps> = {}): TriggerStateSeedDeps => {
  const state = goodState()
  return {
    fs, askedHome: HOME, triggerId: TID, state, digest: digestOf(state),
    liveFacts: () => quiet, stateDir: () => scopeDir(), statePath: (_h, tid) => fileOf(tid), tempTag: 't1',
    ...over,
  }
}

describe('validateSeedState', () => {
  it('accepts a snapshot state and keeps every field, the cursor\'s key order included', () => {
    const s = goodState()
    const v = validateSeedState(s, digestOf(s))
    expect(v).toMatchObject({ ok: true, seq: 7, seenCount: 2, digest: digestOf(s) })
    if (!('ok' in v)) throw new Error('refused')
    expect(JSON.parse(v.text)).toEqual(s)
    expect(v.text).toContain('{"z":1,"a":[2,3]}')
    // The written bytes read back with the snapshot's parser to the same digest.
    const back = parseSnapshotState(Buffer.from(v.text))
    expect('ok' in back && triggerStateDigest(back.state)).toBe(digestOf(s))
  })

  it('refuses a wrong or missing digest, a pending fire, an unknown field, a bad shape and a huge state', () => {
    const s = goodState()
    expect(validateSeedState(s, 'f'.repeat(64))).toMatchObject({ seeded: false, reason: 'digest_mismatch' })
    expect(validateSeedState(s, undefined)).toMatchObject({ seeded: false, reason: 'digest_mismatch' })
    const pending = { ...s, pendingFires: [{ seq: 8, atMs: 1, items: [{ id: 'x' }] }] }
    expect(validateSeedState(pending, digestOf(pending))).toMatchObject({ reason: 'pending_fires' })
    const extra = { ...s, surprise: 1 }
    expect(validateSeedState(extra, digestOf(extra))).toMatchObject({ reason: 'state_unknown_field' })
    for (const bad of [null, 'x', [], { ...s, version: 2 }, { ...s, seen: { a: 'x' } }, { ...s, seq: -1 }]) {
      expect(validateSeedState(bad, 'd'), JSON.stringify(bad)).toMatchObject({ reason: 'state_corrupt' })
    }
    const huge = { ...s, state: 'x'.repeat(TRIGGER_STATE_SNAPSHOT_MAX_BYTES) }
    expect(validateSeedState(huge, digestOf(huge))).toMatchObject({ reason: 'state_too_large' })
  })
})

describe('checkSeedLive', () => {
  it('refuses anything that holds the trigger', () => {
    expect(checkSeedLive(quiet)).toEqual({ ok: true })
    for (const [k, reason] of [['configured', 'still_configured'], ['armed', 'armed'], ['draining', 'draining'],
      ['checkRunning', 'check_running'], ['hostDeliveryInFlight', 'host_delivery_in_flight']] as const) {
      expect(checkSeedLive({ ...quiet, [k]: true }), k).toMatchObject({ seeded: false, reason })
    }
  })
})

describe('seedTriggerState', () => {
  it('writes the exact state, mode 0600, by a temp file renamed into place', () => {
    const d = deps()
    const reply = seedTriggerState(d)
    expect(reply).toEqual({ seeded: true, triggerId: TID, digest: d.digest, seq: 7, seenCount: 2 })
    expect(JSON.parse(fs.readFileSync(fileOf(TID), 'utf-8'))).toEqual(d.state)
    expect(fs.statSync(fileOf(TID)).mode & 0o777).toBe(0o600)
    expect(fs.readdirSync(scopeDir())).toEqual([`${TID}.json`])
  })

  it('answers a resend of the same state as seeded, and never overwrites another', () => {
    expect(seedTriggerState(deps())).toMatchObject({ seeded: true })
    const before = fs.readFileSync(fileOf(TID), 'utf-8')
    expect(seedTriggerState(deps())).toMatchObject({ seeded: true, already: true })
    const other = { ...goodState(), seq: 99 }
    expect(seedTriggerState(deps({ state: other, digest: digestOf(other) }))).toMatchObject({ seeded: false, reason: 'state_exists' })
    expect(fs.readFileSync(fileOf(TID), 'utf-8')).toBe(before)
  })

  it('never writes through a symlink, even one to nothing', () => {
    fs.mkdirSync(scopeDir(), { recursive: true })
    const target = path.join(dir, 'elsewhere.json')
    fs.symlinkSync(target, fileOf(TID))
    expect(seedTriggerState(deps())).toMatchObject({ seeded: false, reason: 'state_exists' })
    expect(fs.existsSync(target)).toBe(false)
  })

  it('refuses without a home or a valid id, and while anything holds the trigger, writing nothing', () => {
    expect(seedTriggerState(deps({ askedHome: '' }))).toMatchObject({ reason: 'home_required' })
    for (const bad of ['', ' x', 'a\nb', 'x'.repeat(201), 7]) {
      expect(seedTriggerState(deps({ triggerId: bad })), String(bad)).toMatchObject({ reason: 'trigger_id_invalid' })
    }
    expect(seedTriggerState(deps({ liveFacts: () => ({ ...quiet, armed: true }) }))).toMatchObject({ reason: 'armed' })
    expect(seedTriggerState(deps({ digest: 'nope' }))).toMatchObject({ reason: 'digest_mismatch' })
    expect(fs.existsSync(scopeDir())).toBe(false)
  })

  it('asks the live facts for exactly (home, id)', () => {
    const asked: string[] = []
    seedTriggerState(deps({ liveFacts: (h, t) => { asked.push(`${h}|${t}`); return quiet } }))
    expect(asked).toEqual([`${HOME}|${TID}`])
  })

  it('a failed write is a refusal that leaves no temp file', () => {
    const failing = { ...fs, renameSync: () => { throw new Error('disk full') } } as unknown as TriggerStateSeedDeps['fs']
    expect(seedTriggerState(deps({ fs: failing }))).toMatchObject({ seeded: false, reason: 'write_failed', detail: 'disk full' })
    expect(fs.readdirSync(scopeDir())).toEqual([])
  })
})
