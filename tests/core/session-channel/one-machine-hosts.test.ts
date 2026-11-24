/**
 * One machine under two host keys (an ssh row and the row the same box joined the host network
 * as, one daemon, one service): what the leader records of a host-run session is the machine's,
 * not one name's (handed-sessions.ts, handover-marks.ts, session-tracker.ts applyHostChannelBatch
 * and handSeedToHost, leader-side.ts startKeyOf), when the leader proved the two names one daemon
 * with its own links (revoked-hosts.ts oneDaemonNow). Hands, rows and hand-over marks written under
 * one name are taken from a channel under the other name, both ways; a different machine is refused
 * as before, and so is one whose hello claims this machine's id (a liar, or a data home moved to
 * another box): a claimed id may ban, it never grants.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fsp from 'node:fs/promises'
import { createMockConstants } from '../../helpers/mock-constants.js'
import { vi } from 'vitest'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-one-machine-hosts'))

import { _resetSessionTrackerForTesting, applyHostChannelBatch, createSessionRecord, getSessionByClaudeId, handSeedToHost } from '../../../src/core/session-tracker.js'
import { closeDb, getDb } from '../../../src/core/session-db.js'
import { handIdOf, handStart, handsNow, settleAnswer } from '../../../src/core/session-channel/handed-sessions.js'
import { clearHandOverMarkIn, writeHandOverMark } from '../../../src/core/session-channel/handover-marks.js'
import { _resetRefusedSessionsForTesting } from '../../../src/core/session-channel/refused-sessions.js'
import { setRevokedHostResolver } from '../../../src/core/session-channel/revoked-hosts.js'
import { createLeaderSide, type LeaderSide } from '../../../src/core/session-channel/leader-side.js'
import type { ChannelSocket } from '../../../src/core/session-channel/leader-links.js'
import { WALNUT_HOME } from '../../../src/constants.js'
import type { SessionRecord } from '../../../src/core/types.js'

/**
 * The box's service goes by NET; SSH reaches the same daemon (the leader's own links to both answer
 * as one live process); FAR is another machine; LIAR is another machine whose hello claims NET's
 * machine id (or one whose data home was copied from NET's box: the same id, another daemon).
 */
const NET = 'devbox'
const SSH = 'devbox-ssh'
const FAR = 'farbox'
const LIAR = 'liarbox'
const MACHINE: Record<string, string> = { [NET]: 'machine-1', [SSH]: 'machine-1', [FAR]: 'machine-2', [LIAR]: 'machine-1' }
const ALIASES: Record<string, string[]> = { [NET]: [SSH], [SSH]: [NET] }
const SAME_DAEMON: Record<string, string[]> = { [NET]: [SSH], [SSH]: [NET] }

const whole = (sid: string, host: string, extra: Partial<SessionRecord> = {}): Record<string, unknown> => ({
  claudeSessionId: sid, taskId: '', project: 'p', process_status: 'running', mode: 'default', host, judge: 'host',
  startedAt: '2026-11-24T00:00:00.000Z', lastActiveAt: '2026-11-24T00:00:00.000Z', messageCount: 0, title: 'From host', ...extra,
})
let seq = 0
/** A born row from the channel under `via`; the host names itself `self` in its row (its WALNUT_HOST_KEY). */
const born = (sid: string, via: string, self = via, hand?: string) =>
  applyHostChannelBatch({ hostId: via, rows: [{ sid, born: true, patch: whole(sid, self), seq: ++seq, ...(hand ? { hand } : {}) }], renames: [], cursor: { logId: `L-${via}`, seq } })
const patch = (sid: string, p: Record<string, unknown>, via: string) =>
  applyHostChannelBatch({ hostId: via, rows: [{ sid, patch: p, seq: ++seq }], renames: [], cursor: { logId: `L-${via}`, seq } })

beforeEach(async () => {
  closeDb()
  _resetSessionTrackerForTesting()
  _resetRefusedSessionsForTesting()
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true })
  await fsp.mkdir(WALNUT_HOME, { recursive: true })
  seq = 0
  setRevokedHostResolver({ machineOf: (k) => MACHINE[k] ?? null, aliasesOf: (k) => ALIASES[k] ?? [], sameDaemonNow: (k) => SAME_DAEMON[k] ?? [] })
})
afterEach(() => {
  setRevokedHostResolver(null)
  closeDb()
  _resetSessionTrackerForTesting()
})

describe('a session handed under one name of a machine, reported under another', () => {
  it('a seeded hand under the ssh name: the born row from the host-network channel is its own (and the reverse)', async () => {
    await handStart(SSH, 'seed-ssh')
    expect((await born('seed-ssh', NET)).written).toEqual(['seed-ssh'])
    expect(await getSessionByClaudeId('seed-ssh')).toMatchObject({ host: NET, judge: 'host' })
    expect(handsNow()).toEqual([])
    await handStart(NET, 'seed-net')
    expect((await born('seed-net', SSH)).written).toEqual(['seed-net'])
    expect(handsNow()).toEqual([])
  })

  it('an open hand under one name takes the echoing born row from the other', async () => {
    const hand = await handStart(SSH, null)
    expect((await born('acp-1', NET, NET, hand)).written).toEqual(['acp-1'])
  })

  it('a different machine under any name is refused, and nothing is written', async () => {
    await handStart(SSH, 'meant-for-box')
    const r = await born('meant-for-box', FAR)
    expect(r.refused).toEqual(['meant-for-box'])
    expect(await getSessionByClaudeId('meant-for-box')).toBeNull()
    const hand = await handStart(NET, null)
    expect((await born('acp-far', FAR, FAR, hand)).refused).toEqual(['acp-far'])
    // The machine's own born row still applies after.
    expect((await born('meant-for-box', NET)).written).toEqual(['meant-for-box'])
  })

  it('a row the leader holds under one name takes the other name\'s patches and turn ends; another machine\'s are skipped', async () => {
    await handStart(SSH, 'row-1')
    expect((await born('row-1', SSH)).written).toEqual(['row-1'])
    expect((await patch('row-1', { process_status: 'idle' }, NET)).written).toEqual(['row-1'])
    expect((await getSessionByClaudeId('row-1'))?.process_status).toBe('idle')
    expect((await patch('row-1', { process_status: 'stopped' }, FAR)).skipped).toEqual(['row-1'])
    expect((await getSessionByClaudeId('row-1'))?.process_status).toBe('idle')
  })

  it('a start\'s answer under one name settles a hand under the other; another machine\'s answer is refused', async () => {
    const hand = await handStart(SSH, null)
    expect(await settleAnswer(NET, 'answered-1', hand)).toEqual({ ok: true, row: false })
    expect(handsNow()).toEqual([{ host: SSH, sid: 'answered-1' }])
    expect(handIdOf(NET, 'answered-1')).toBe(hand)
    expect(await settleAnswer(FAR, 'answered-1', '')).toEqual({ ok: false, row: false })
  })

  it('a hand-over mark under one name is cleared by the other name\'s row; another machine leaves it', () => {
    // The store opens with the first write.
    return (async () => {
      await createSessionRecord('opener', '', 'p', undefined, { title: 'x' })
      const handle = getDb()!
      writeHandOverMark({ sid: 'marked', host: SSH, kind: 'start', since: 1 })
      expect(clearHandOverMarkIn(handle, 'marked', FAR)).toBe(false)
      expect(clearHandOverMarkIn(handle, 'marked', NET)).toBe(true)
      expect(clearHandOverMarkIn(handle, 'marked', NET)).toBe(false)
    })()
  })
})

describe('a host whose hello claims this machine\'s id (B1 of the round 1 review)', () => {
  it('is judged another host: its born row of a hand to NET is refused, its patches skipped, its answer refused', async () => {
    await handStart(NET, 'v-seed')
    expect((await born('v-seed', LIAR)).refused).toEqual(['v-seed'])
    expect(await getSessionByClaudeId('v-seed')).toBeNull()
    expect((await born('v-seed', NET)).written).toEqual(['v-seed'])
    expect((await patch('v-seed', { process_status: 'stopped' }, LIAR)).skipped).toEqual(['v-seed'])
    expect((await getSessionByClaudeId('v-seed'))?.process_status).toBe('running')
    const hand = await handStart(NET, null)
    expect(await settleAnswer(LIAR, 'v-open', hand)).toEqual({ ok: true, row: false })
    // The answer named a new id under LIAR's own hand, never NET's open hand.
    expect(handsNow()).toContainEqual({ host: NET, sid: null })
  })

  it('a seed of the honest name is never moved to it', async () => {
    await createSessionRecord('v-seed-2', 't3', 'p', '/w', { host: NET, title: 'Honest', initialProcessStatus: 'idle' })
    expect(await handSeedToHost('v-seed-2', LIAR)).toBe(false)
    expect(await getSessionByClaudeId('v-seed-2')).toMatchObject({ host: NET })
  })
})

describe('handSeedToHost: the seed of a start on the ssh name goes to the name the machine\'s service knows itself by', () => {
  it('moves a seed under another name of the same machine; leaves another machine\'s seed alone', async () => {
    await createSessionRecord('seed-move', 't', 'p', '/w', { host: SSH, title: 'Seeded', initialProcessStatus: 'idle' })
    expect(await handSeedToHost('seed-move', NET)).toBe(true)
    expect(await getSessionByClaudeId('seed-move')).toMatchObject({ host: NET, judge: 'host', title: 'Seeded' })
    await createSessionRecord('seed-far', 't2', 'p', '/w', { host: FAR, title: 'Far', initialProcessStatus: 'idle' })
    expect(await handSeedToHost('seed-far', NET)).toBe(false)
    expect(await getSessionByClaudeId('seed-far')).toMatchObject({ host: FAR })
    expect((await getSessionByClaudeId('seed-far'))?.judge).toBeUndefined()
  })
})

describe('leader-side startKeyOf: where a start on a name goes', () => {
  let side: LeaderSide | null = null
  afterEach(() => { side?.stop(); side = null })

  function fakeSocket(): ChannelSocket {
    return { send: () => {}, close: () => {}, onMessage: () => {}, onClose: () => {} }
  }
  function makeSide(off: Set<string> = new Set()) {
    return createLeaderSide({
      walnutId: async () => 'w1',
      permit: () => ({ permitNumber: 0, epoch: 1 }),
      switchNow: async () => (h) => !off.has(h),
      openStream: async () => { throw new Error('not used') },
      dial: async () => fakeSocket(),
      applyBatch: async () => ({ written: [], skipped: [] }),
      loadCursor: async () => null,
      emit: () => {}, noteLive: () => {}, noteRename: () => {}, noteHostJudged: () => {},
      ownerOf: () => null,
      backoffMs: () => 20,
      log: () => {},
    })
  }

  it('its own service when it judges; the machine\'s linked service under another name; legacy for another machine', async () => {
    side = makeSide()
    await side.noteHost(NET, { connected: true, judges: true })
    await side.noteHost(SSH, { connected: true, judges: false })
    await side.noteHost(FAR, { connected: true, judges: false })
    expect(await side.whenLinked(NET, 2_000)).toBe(true)
    expect(side.startKeyOf(NET)).toBe(NET)
    expect(side.startKeyOf(SSH)).toBe(NET)
    expect(side.startKeyOf(FAR)).toBeNull()
    expect(side.startKeyOf('never-seen')).toBeNull()
  })

  it('either name switched off keeps the machine\'s starts on that name legacy', async () => {
    const off = new Set<string>([NET])
    side = makeSide(off)
    await side.noteHost(NET, { connected: true, judges: true })
    await side.noteHost(SSH, { connected: true, judges: false })
    expect(await side.whenLinked(NET, 2_000)).toBe(true)
    expect(side.startKeyOf(SSH)).toBeNull()
    off.clear(); off.add(SSH)
    await side.refreshFlag()
    expect(side.startKeyOf(SSH)).toBeNull()
    expect(side.startKeyOf(NET)).toBe(NET)
  })

  it('a host claiming this machine\'s id never takes its starts, even while the honest service is not judging', async () => {
    side = makeSide()
    await side.noteHost(NET, { connected: true, judges: false })
    await side.noteHost(LIAR, { connected: true, judges: true })
    expect(await side.whenLinked(LIAR, 2_000)).toBe(true)
    expect(side.startKeyOf(NET)).toBeNull()
    expect(side.startKeyOf(SSH)).toBeNull()
    expect(side.startKeyOf(LIAR)).toBe(LIAR)
  })

  it('whenLinked: false past its deadline for a host that never links', async () => {
    side = makeSide()
    await side.noteHost(FAR, { connected: true, judges: false })
    expect(await side.whenLinked(FAR, 50)).toBe(false)
  })
})
