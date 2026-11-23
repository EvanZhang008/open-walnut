/**
 * After a leader switch the new leader declares the previous holder's data dir to its hosts, and
 * only once the switch committed (src/core/leader/switch/moved-home.ts): the rule, pure, and the
 * wait of a commit start on real files.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { commitWaitMs, judgeSwitchedHere, switchedHereAfterCommit, type PermitView } from '../../../../src/core/leader/switch/moved-home.js'
import { isHomeMoveHeld } from '../../../../src/core/home-move.js'
import { DEFAULT_PERMIT_PARAMS } from '../../../../src/core/leader/permit/types.js'
import { writeMarker, writePromoted, type PromotedRecord } from '../../../../src/core/leader/switch/records.js'
import type { RuntimeState } from '../../../../src/core/leader/switch/runtime.js'

const permit = (machine: string, state: RuntimeState = 'leading', record: { number: number; holder?: string } | null = { number: 8, holder: machine }, trial = false): PermitView =>
  ({ machine, trial, status: () => ({ state, record }) })

const promoted = (extra: Partial<PromotedRecord> = {}): PromotedRecord => ({
  switchId: 's1', state: 'promoted', from: '/srv/a/walnut', to: 'machine-b', handover: 7, fromHomeOnHosts: '/srv/a/./walnut', fromFormerHomes: ['/srv/a/older'], at: '2026-11-22T00:00:00Z', ...extra,
})

describe('judgeSwitchedHere: what a start declares of a leader switch', () => {
  const switched = { switchId: 's1', home: '/srv/a/./walnut', formerHomes: ['/srv/a/older'] }

  it('a commit start whose own record stands above the handover on a majority: the old holder\'s path, as its server spelled it', () => {
    expect(judgeSwitchedHere({ promoted: promoted(), handedOver: false, permit: permit('machine-b') })).toEqual({ kind: 'declare', switched })
  })
  it('a led record (the switch saw the commit on a majority): declared at once, whatever the permit does now (a restart)', () => {
    expect(judgeSwitchedHere({ promoted: promoted({ state: 'led' }), handedOver: false, permit: permit('machine-b', 'waiting', null) })).toEqual({ kind: 'declare', switched })
  })
  it('a cross-machine copy with no switch record: nothing', () => {
    expect(judgeSwitchedHere({ promoted: null, handedOver: false, permit: permit('machine-b') }).kind).toBe('none')
  })
  it('a record not committed on a majority: it waits, never declares', () => {
    for (const p of [permit('machine-b', 'waiting', null), permit('machine-b', 'waiting', { number: 7, holder: 'machine-a' }), permit('machine-b', 'leading', { number: 7, holder: 'machine-b' }), permit('machine-b', 'lost', { number: 9, holder: 'machine-c' })]) {
      expect(judgeSwitchedHere({ promoted: promoted(), handedOver: false, permit: p }).kind).toBe('wait')
    }
  })
  it('a permit still booting (its first witness rounds may open host links): it waits, even on a led record', () => {
    for (const state of ['promoted', 'led'] as const) {
      expect(judgeSwitchedHere({ promoted: promoted({ state }), handedOver: false, permit: 'booting' }).kind).toBe('wait')
    }
    expect(judgeSwitchedHere({ promoted: null, handedOver: false, permit: 'booting' }).kind).toBe('none')
  })
  it('a record naming another machine: nothing, committed or not', () => {
    for (const state of ['promoted', 'led'] as const) {
      expect(judgeSwitchedHere({ promoted: promoted({ state, to: 'machine-c' }), handedOver: false, permit: permit('machine-b') })).toMatchObject({ kind: 'none' })
    }
  })
  it('no permit (experiment off), a trial start, a handed-over home, a torn or older record: nothing', () => {
    expect(judgeSwitchedHere({ promoted: promoted({ state: 'led' }), handedOver: false, permit: null }).kind).toBe('none')
    expect(judgeSwitchedHere({ promoted: promoted({ state: 'led' }), handedOver: false, permit: permit('machine-b', 'trial', null, true) }).kind).toBe('none')
    expect(judgeSwitchedHere({ promoted: promoted({ state: 'led' }), handedOver: true, permit: permit('machine-b') }).kind).toBe('none')
    expect(judgeSwitchedHere({ promoted: { torn: true } as PromotedRecord, handedOver: false, permit: permit('machine-b') }).kind).toBe('none')
    const older = promoted({ state: 'led' })
    delete older.fromHomeOnHosts
    expect(judgeSwitchedHere({ promoted: older, handedOver: false, permit: permit('machine-b') }).kind).toBe('none')
  })
})

describe('switchedHereAfterCommit: the commit start waits for its commit', () => {
  let home: string
  beforeEach(() => { home = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-moved-home-')) })
  afterEach(() => { fs.rmSync(home, { recursive: true, force: true }) })

  it('answers once its own record stands above the handover, not before', async () => {
    writePromoted(home, promoted())
    let view = permit('machine-b', 'waiting', { number: 7, holder: 'machine-a' })
    let answered: unknown = 'pending'
    let looks = 0
    const p = switchedHereAfterCommit(home, () => { looks++; return view }).then((v) => { answered = v })
    // It looked again three times and still waits.
    await vi.waitFor(() => expect(looks).toBeGreaterThanOrEqual(4), { timeout: 10_000 })
    expect(answered, 'no host hears this Walnut from here before the commit stood').toBe('pending')
    view = permit('machine-b', 'leading', { number: 8, holder: 'machine-b' })
    await p
    expect(answered).toEqual({ switchId: 's1', home: '/srv/a/./walnut', formerHomes: ['/srv/a/older'] })
  })
  it('a permit that stops before its commit stood settles the wait (null), never leaves it pending', async () => {
    writePromoted(home, promoted())
    let view = permit('machine-b', 'waiting', { number: 7, holder: 'machine-a' })
    let answered: unknown = 'pending'
    let looks = 0
    void switchedHereAfterCommit(home, () => { looks++; return view }, 60_000).then((v) => { answered = v })
    await vi.waitFor(() => expect(looks).toBeGreaterThanOrEqual(2), { timeout: 10_000 })
    view = permit('machine-b', 'stopped', null)
    await vi.waitFor(() => expect(answered).toBeNull(), { timeout: 10_000 })
  })
  it('past its deadline the wait rejects HomeMoveHeld (never null: a host would keep the new path as its own)', async () => {
    writePromoted(home, promoted())
    const started = Date.now()
    const err = await switchedHereAfterCommit(home, () => permit('machine-b', 'waiting', null), 600).catch((e: unknown) => e)
    expect(isHomeMoveHeld(err)).toBe(true)
    expect((err as { switchId: string }).switchId).toBe('s1')
    expect(Date.now() - started).toBeLessThan(5_000)
    // A permit still booting is held the same way.
    expect(isHomeMoveHeld(await switchedHereAfterCommit(home, () => 'booting', 300).catch((e: unknown) => e))).toBe(true)
  })
  it('the default deadline: twice the longest a commit takes when nothing is wrong (an earlier record running out)', () => {
    expect(commitWaitMs(DEFAULT_PERMIT_PARAMS)).toBe(2 * (DEFAULT_PERMIT_PARAMS.validMs + DEFAULT_PERMIT_PARAMS.witnessMarginMs))
    expect(commitWaitMs(DEFAULT_PERMIT_PARAMS)).toBe(124_000)
  })
  it('null at once without a switch record, or with the handed-over marker', async () => {
    expect(await switchedHereAfterCommit(home, () => permit('machine-b'))).toBeNull()
    writePromoted(home, promoted({ state: 'led' }))
    writeMarker(home, { switchId: 's2', to: 'machine-a', state: 'handed-over', at: '2026-11-22T00:00:00Z' })
    expect(await switchedHereAfterCommit(home, () => permit('machine-b'))).toBeNull()
  })
})
