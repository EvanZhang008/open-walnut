/**
 * The one read of the write permission's number for the session channel
 * (src/core/session-channel/leader-permit.ts): 0 with no permit running, the record's number with
 * one, and no other file of the session channel reads a permit record's number itself.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import type { PermitRuntime } from '../../../src/core/leader/switch/runtime.js'

import { leaderPermitNumberForHosts, setLeaderPermitReader } from '../../../src/core/session-channel/leader-permit.js'

let permit: { runtime: PermitRuntime; machine: string; trial: boolean } | null = null
const setCurrentLeaderPermit = (p: typeof permit): void => { permit = p }

const DIR = path.resolve(__dirname, '../../../src/core/session-channel')

beforeEach(() => { setLeaderPermitReader(() => permit) })
afterEach(() => { setCurrentLeaderPermit(null); setLeaderPermitReader(null) })

describe('leaderPermitNumberForHosts', () => {
  it('is 0 with no permit running, and the record\'s number with one', () => {
    expect(leaderPermitNumberForHosts()).toBe(0)
    const runtime = { status: () => ({ record: { number: 7, holder: 'm1' } }) } as unknown as PermitRuntime
    setCurrentLeaderPermit({ runtime, machine: 'm1', trial: false })
    expect(leaderPermitNumberForHosts()).toBe(7)
    const none = { status: () => ({ record: null }) } as unknown as PermitRuntime
    setCurrentLeaderPermit({ runtime: none, machine: 'm1', trial: false })
    expect(leaderPermitNumberForHosts()).toBe(0)
    // No reader handed (the leader side not on): 0.
    setLeaderPermitReader(null)
    setCurrentLeaderPermit({ runtime, machine: 'm1', trial: false })
    expect(leaderPermitNumberForHosts()).toBe(0)
  })

  it('is the only read of a permit record\'s number in the session channel', () => {
    const readers = fs.readdirSync(DIR).filter((f) => f.endsWith('.ts') && f !== 'leader-permit.ts')
      .filter((f) => /\brecord\??\.number\b/.test(fs.readFileSync(path.join(DIR, f), 'utf8')))
    expect(readers).toEqual([])
  })
})
