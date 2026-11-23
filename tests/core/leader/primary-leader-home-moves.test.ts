/**
 * A leader declares its home move (leader.configure's movedFrom, home-move.ts) only under the
 * one-service experiment, and only when its data dir really moved; the connect's first frame
 * carries it (declareHomeMove). A host that refuses this data dir (`walnut_home_busy`) becomes
 * one Walnut Health item for that host, which an accepted leader.configure clears. A leader switch
 * to this data dir that committed declares the previous holder's path with the experiment off too
 * (src/core/leader/switch/moved-home.ts), and a connect waits for its commit.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

vi.mock('../../../src/constants.js', async () => {
  const { createMockConstants } = await import('../../helpers/mock-constants.js')
  return createMockConstants('walnut-leader-home-moves')
})

const health = vi.hoisted(() => ({ busy: [] as Array<[string, string, string]>, served: [] as string[], notTaken: [] as Array<[string, string]>, taken: [] as string[], held: [] as string[], confirmed: 0 }))
vi.mock('../../../src/core/leader/home-busy-health.js', () => ({
  noteHomeBusy: (host: string, movedTo: string, kind = 'busy') => { health.busy.push([host, movedTo, kind]) },
  noteHomeServed: (host: string) => { health.served.push(host) },
  noteMoveNotTaken: (host: string, why: string) => { health.notTaken.push([host, why]) },
  noteMoveTaken: (host: string) => { health.taken.push(host) },
  noteSwitchHeld: (switchId: string) => { health.held.push(switchId) },
  noteSwitchConfirmed: () => { health.confirmed++ },
}))

// The permit of this process (boot.ts): none, unless a test plays a switch's new leader.
const permit = vi.hoisted(() => ({ current: null as null | { machine: string; trial: boolean; runtime: { status(): { state: string; record: { number: number; holder: string } | null } } } }))
vi.mock('../../../src/core/leader/switch/boot.js', () => ({ currentLeaderPermit: () => permit.current }))

import { WALNUT_HOME } from '../../../src/constants.js'
import { setOutwardDoorChecker } from '../../../src/core/leader/switch/doors.js'
import { writePromoted } from '../../../src/core/leader/switch/records.js'
import { configureHostLeader, declareHomeMove } from '../../../src/core/leader/primary-leader.js'
import { inProcessDaemonWanted, resetInProcessDaemonWantedForTests } from '../../../src/providers/in-process-daemon.js'
import { homeRecordFile, isHomeMoveHeld, resetHomeMoveForTests, settledHomeMove } from '../../../src/core/home-move.js'
import { readMachineId, setMachineIdHomeForTest } from '../../../src/core/machine-id.js'

const saved = process.env.WALNUT_IN_PROCESS_DAEMON
let account: string
beforeEach(() => {
  account = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-leader-home-moves-account-'))
  setMachineIdHomeForTest(account)
  health.busy.length = 0
  health.served.length = 0
  health.notTaken.length = 0
  health.taken.length = 0
  fs.rmSync(homeRecordFile(WALNUT_HOME), { force: true })
})
afterEach(async () => {
  // First: a judgement still keeping its record reads this test's permit, machine id and data dir.
  await resetHomeMoveForTests()
  permit.current = null
  setOutwardDoorChecker(null)
  fs.rmSync(path.join(WALNUT_HOME, 'local', 'leader-switch'), { recursive: true, force: true })
  if (saved === undefined) delete process.env.WALNUT_IN_PROCESS_DAEMON
  else process.env.WALNUT_IN_PROCESS_DAEMON = saved
  resetInProcessDaemonWantedForTests()
  setMachineIdHomeForTest(null)
  fs.rmSync(account, { recursive: true, force: true })
})

async function switchTo(flag: '0' | '1'): Promise<void> {
  await resetHomeMoveForTests()
  process.env.WALNUT_IN_PROCESS_DAEMON = flag
  resetInProcessDaemonWantedForTests()
}

/** The data dir was at `old` on this machine before (its record says so). */
async function movedFrom(old: string): Promise<void> {
  fs.mkdirSync(path.dirname(homeRecordFile(WALNUT_HOME)), { recursive: true })
  fs.writeFileSync(homeRecordFile(WALNUT_HOME), JSON.stringify({ machineId: await readMachineId(), home: old }))
}

function host(reply: Record<string, unknown> = { ok: false, error: 'test stops here' }) {
  const sent: Array<Record<string, unknown>> = []
  return {
    sent,
    conn: { hostKey: 'h1', send: async (cmd: string, params?: Record<string, unknown>) => { sent.push({ cmd, ...params }); return reply } },
  }
}

describe('leader.configure and declared home moves', () => {
  it('the experiment off: no movedFrom, but the move is kept in the record off the connect path (L2)', async () => {
    await switchTo('0')
    const old = path.join(os.tmpdir(), 'walnut-gone-home-0')
    await movedFrom(old)
    const h = host()
    await configureHostLeader(h.conn)
    expect(h.sent.find((s) => s.cmd === 'leader.configure')).not.toHaveProperty('movedFrom')
    expect(h.sent.find((s) => s.cmd === 'leader.configure')).not.toHaveProperty('formerHomes')
    // The record names the move, so turning the experiment on later declares it.
    await vi.waitFor(() => expect(JSON.parse(fs.readFileSync(homeRecordFile(WALNUT_HOME), 'utf8'))).toMatchObject({ home: WALNUT_HOME, movedFrom: old, formerHomes: [old] }))
    // The connect's first frame sends nothing either.
    const first = host()
    await declareHomeMove(first.conn)
    expect(first.sent).toEqual([])
    await switchTo('1')
    const later = host({ ok: true, epoch: 1, holder: 'primary' })
    await configureHostLeader(later.conn)
    expect(later.sent.find((s) => s.cmd === 'leader.configure')).toMatchObject({ movedFrom: old, formerHomes: [old] })
  })

  it('the experiment known off: a connect has nothing to wait for (L5)', async () => {
    await switchTo('0')
    expect(settledHomeMove(), 'not asked yet').toBeUndefined()
    expect(await inProcessDaemonWanted()).toBe(false)
    // The server's boot asked the switch: the home move is known to declare nothing, before any ask of it.
    expect(settledHomeMove()).toBeNull()
  })

  it('the experiment on, a data dir that never moved: no movedFrom, and the record is kept', async () => {
    await switchTo('1')
    const h = host()
    await configureHostLeader(h.conn)
    expect(h.sent.find((s) => s.cmd === 'leader.configure')).not.toHaveProperty('movedFrom')
    expect(JSON.parse(fs.readFileSync(homeRecordFile(WALNUT_HOME), 'utf8'))).toEqual({ machineId: await readMachineId(), home: WALNUT_HOME })
    const first = host()
    await declareHomeMove(first.conn)
    expect(first.sent).toEqual([])
  })

  it('the experiment on, a data dir that moved: the first frame and every leader.configure carry movedFrom', async () => {
    await switchTo('1')
    const old = path.join(os.tmpdir(), 'walnut-gone-home-1')
    await movedFrom(old)
    const first = host({ ok: true, epoch: 7, holder: 'primary' })
    await declareHomeMove(first.conn)
    expect(first.sent).toHaveLength(1)
    expect(first.sent[0]).toMatchObject({ cmd: 'leader.configure', home: WALNUT_HOME, movedFrom: old, formerHomes: [old] })
    const later = host()
    await configureHostLeader(later.conn)
    expect(later.sent.find((s) => s.cmd === 'leader.configure')).toMatchObject({ movedFrom: old })
    expect(health.served).toEqual(['h1'])
    // The host took the move: its "could not follow" item, if any, recovers.
    expect(health.taken).toEqual(['h1'])
  })

  it('the home a host keeps this Walnut under after a move (homeHere) reaches the connection; any other answer says none (A3b S34-L3)', async () => {
    await switchTo('1')
    const old = path.join(os.tmpdir(), 'walnut-gone-home-here')
    await movedFrom(old)
    const heard: Array<string | null> = []
    const moved = host({ ok: true, epoch: 2, holder: 'primary', homeHere: old })
    await declareHomeMove({ ...moved.conn, noteHomeHere: (h) => { heard.push(h) } })
    const again = host({ ok: true, epoch: 2, holder: 'primary', homeHere: old })
    await configureHostLeader({ ...again.conn, noteHomeHere: (h) => { heard.push(h) } })
    // A host that keeps it under this very home, or names nothing usable, says none.
    for (const reply of [{ ok: true, epoch: 2, holder: 'primary' }, { ok: true, epoch: 2, holder: 'primary', homeHere: WALNUT_HOME }, { ok: true, epoch: 2, holder: 'primary', homeHere: 'relative/dir' }]) {
      await configureHostLeader({ ...host(reply).conn, noteHomeHere: (h) => { heard.push(h) } })
    }
    expect(heard).toEqual([old, old, null, null, null])
  })

  it('a host that takes the description but not the declared move: a Walnut Health item says so (M2)', async () => {
    await switchTo('1')
    await movedFrom(path.join(os.tmpdir(), 'walnut-gone-home-2'))
    const h = host({ ok: true, epoch: 1, holder: 'primary', moveNotTaken: 'lost_trail' })
    expect(await configureHostLeader(h.conn)).toMatchObject({ epoch: 1 })
    expect(health.notTaken).toEqual([['h1', 'lost_trail']])
    expect(health.taken).toEqual([])
  })

  it('another Walnut left this path on the host: the item says so, not "another copy" (M3)', async () => {
    await switchTo('0')
    const h = host({ ok: false, error: 'another Walnut used this data dir here and moved to another one: abc', errorKind: 'walnut_home_taken', movedTo: '/their/home' })
    expect(await configureHostLeader(h.conn)).toBeNull()
    expect(health.busy).toEqual([['h1', '/their/home', 'taken']])
  })

  it('N1: a host that follows another copy that is gone from this machine: described again naming it, and this copy is served', async () => {
    await switchTo('1')
    await movedFrom(path.join(os.tmpdir(), 'walnut-gone-home-n1'))
    const gone = path.join(account, 'backup-copy-deleted')
    const sent: Array<Record<string, unknown>> = []
    const conn = {
      hostKey: 'h1',
      send: async (cmd: string, params?: Record<string, unknown>) => {
        sent.push({ cmd, ...params })
        return params?.copyGone === gone ? { ok: true, epoch: 3, holder: 'primary' } : { ok: false, error: 'this Walnut moved to another data dir: abc', errorKind: 'walnut_home_busy', movedTo: gone }
      },
    }
    expect(await configureHostLeader(conn)).toMatchObject({ epoch: 3 })
    expect(sent.map((s) => s.copyGone ?? null)).toEqual([null, gone])
    expect(health.busy).toEqual([])
    expect(health.served).toEqual(['h1'])
  })

  it('N1: the other copy still holds this Walnut: no claim, and the item tells the person what to do (contested)', async () => {
    await switchTo('1')
    await movedFrom(path.join(os.tmpdir(), 'walnut-gone-home-n1b'))
    const { getInstanceId } = await import('../../../src/core/device-auth.js')
    const live = path.join(account, 'backup-copy-live')
    fs.mkdirSync(live, { recursive: true })
    fs.writeFileSync(path.join(live, 'auth.json'), JSON.stringify({ instanceId: await getInstanceId(), devices: [] }))
    const h = host({ ok: false, error: 'this Walnut moved to another data dir: abc', errorKind: 'walnut_home_busy', movedTo: live })
    expect(await configureHostLeader(h.conn)).toBeNull()
    expect(h.sent.filter((s) => s.cmd === 'leader.configure')).toHaveLength(1)
    expect(health.busy).toEqual([['h1', live, 'contested']])
    // A copy that does not read is a doubt: no claim either.
    fs.writeFileSync(path.join(live, 'auth.json'), '{ half')
    fs.chmodSync(path.join(live, 'auth.json'), 0o000)
    const unread = host({ ok: false, error: 'x', errorKind: 'walnut_home_busy', movedTo: live })
    await configureHostLeader(unread.conn)
    fs.chmodSync(path.join(live, 'auth.json'), 0o600)
    expect(unread.sent.filter((s) => s.cmd === 'leader.configure')).toHaveLength(1)
  })

  it('a host that refuses this data dir: one Walnut Health item names where the Walnut moved', async () => {
    await switchTo('0')
    const h = host({ ok: false, error: 'this Walnut moved to another data dir: abc', errorKind: 'walnut_home_busy', movedTo: '/new/home' })
    expect(await configureHostLeader(h.conn)).toBeNull()
    expect(health.busy).toEqual([['h1', '/new/home', 'busy']])
    expect(health.served).toEqual([])
  })
})

describe('leader.configure after a leader switch to this data dir', () => {
  const OLD = '/srv/machine-a/./walnut'
  /** This process is the new leader of switch s1: the permit guards it, and its promotion record says where the old leader was. */
  let looks = 0
  function newLeader(state: 'leading' | 'waiting', recordState: 'promoted' | 'led' = 'promoted', to = 'machine-b') {
    let st = state
    looks = 0
    permit.current = { machine: 'machine-b', trial: false, runtime: { status: () => (looks++, { state: st, record: st === 'leading' ? { number: 8, holder: 'machine-b' } : { number: 7, holder: 'machine-a' } }) } }
    setOutwardDoorChecker(() => {}, () => st === 'leading')
    writePromoted(WALNUT_HOME, { switchId: 's1', state: recordState, from: '/srv/machine-a/walnut', to, handover: 7, fromHomeOnHosts: OLD, fromFormerHomes: [], at: new Date().toISOString() })
    return { commit: () => { st = 'leading' } }
  }

  it('the experiment off and the switch committed: every leader.configure carries the old holder\'s path, raw', async () => {
    await switchTo('0')
    newLeader('leading')
    expect(settledHomeMove(), 'a connect holds its commands for the declaration').toBeUndefined()
    const first = host({ ok: true, epoch: 3, holder: 'primary' })
    await declareHomeMove(first.conn)
    expect(first.sent).toEqual([expect.objectContaining({ cmd: 'leader.configure', home: WALNUT_HOME, movedFrom: OLD, formerHomes: [OLD] })])
    const later = host({ ok: true, epoch: 3, holder: 'primary' })
    await configureHostLeader(later.conn)
    expect(later.sent.find((s) => s.cmd === 'leader.configure')).toMatchObject({ movedFrom: OLD, formerHomes: [OLD] })
    expect(JSON.parse(fs.readFileSync(homeRecordFile(WALNUT_HOME), 'utf8'))).toMatchObject({ home: WALNUT_HOME, movedFrom: OLD, switchId: 's1' })
  })

  it('before the commit stands nothing reaches the host; at the commit the first frame declares', async () => {
    await switchTo('0')
    const leader = newLeader('waiting')
    const h = host({ ok: true, epoch: 3, holder: 'primary' })
    const done = configureHostLeader(h.conn)
    // It looked at its permit three times and still waits.
    await vi.waitFor(() => expect(looks).toBeGreaterThanOrEqual(3), { timeout: 10_000 })
    expect(h.sent, 'no frame before the commit').toEqual([])
    leader.commit()
    await done
    expect(h.sent[0]).toMatchObject({ cmd: 'leader.configure', movedFrom: OLD })
  })

  it('the witness majority out of reach: each attempt fails at its deadline with no frame and a Health item; back, it declares once', async () => {
    await switchTo('0')
    health.held.length = 0
    health.confirmed = 0
    process.env.WALNUT_TEST_COMMIT_WAIT_MS = '500'
    try {
      const leader = newLeader('waiting')
      for (let attempt = 0; attempt < 2; attempt++) {
        const h = host({ ok: true, epoch: 3, holder: 'primary' })
        const started = Date.now()
        const err = await declareHomeMove(h.conn).catch((e: unknown) => e)
        expect(isHomeMoveHeld(err), 'the attempt fails, never "nothing to declare"').toBe(true)
        expect(Date.now() - started).toBeLessThan(5_000)
        expect(h.sent, 'no frame: the host keeps no record for the new path').toEqual([])
        expect(settledHomeMove(), 'the next connect waits afresh').toBeUndefined()
        const configured = host({ ok: true, epoch: 3, holder: 'primary' })
        expect(isHomeMoveHeld(await configureHostLeader(configured.conn).catch((e: unknown) => e))).toBe(true)
        expect(configured.sent).toEqual([])
      }
      await vi.waitFor(() => expect(health.held).toContain('s1'))
      expect(fs.existsSync(homeRecordFile(WALNUT_HOME)), 'nothing judged or kept while held').toBe(false)
      // The majority answers again: the commit stands, and the next attempt declares, once.
      leader.commit()
      const back = host({ ok: true, epoch: 3, holder: 'primary' })
      await declareHomeMove(back.conn)
      expect(back.sent).toEqual([expect.objectContaining({ cmd: 'leader.configure', movedFrom: OLD, formerHomes: [OLD] })])
      await vi.waitFor(() => expect(health.confirmed).toBe(1))
    } finally {
      delete process.env.WALNUT_TEST_COMMIT_WAIT_MS
    }
  })

  it('a record naming another machine, or no permit (the experiment off), declares nothing: as before', async () => {
    await switchTo('0')
    newLeader('leading', 'led', 'machine-c')
    const h = host({ ok: true, epoch: 3, holder: 'primary' })
    await configureHostLeader(h.conn)
    expect(h.sent.find((s) => s.cmd === 'leader.configure')).not.toHaveProperty('movedFrom')
    await resetHomeMoveForTests()
    fs.rmSync(homeRecordFile(WALNUT_HOME), { force: true })
    newLeader('leading', 'led')
    permit.current = null
    setOutwardDoorChecker(null)
    expect(settledHomeMove(), 'no permit and the experiment known off: nothing waits').toBeNull()
    const off = host({ ok: true, epoch: 3, holder: 'primary' })
    await configureHostLeader(off.conn)
    expect(off.sent.find((s) => s.cmd === 'leader.configure')).not.toHaveProperty('movedFrom')
  })
})
