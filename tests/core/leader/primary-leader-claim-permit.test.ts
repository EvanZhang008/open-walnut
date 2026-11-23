/**
 * Under the leader switch's write permission a host is taken back from the cloud companion's backup
 * lead only once this server may act (src/core/leader/primary-leader.ts configureHostLeader): a
 * restart that boots waiting (its earlier handover still runs out at the witnesses) describes the
 * Walnut to the host but sends no `leader.claim`, so the host never follows a leader whose permit
 * record does not stand; the claim goes the moment the doors open. With no permit it claims at once,
 * as before.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../../src/constants.js', async () => {
  const { createMockConstants } = await import('../../helpers/mock-constants.js')
  return createMockConstants('walnut-leader-claim-permit')
})
vi.mock('../../../src/core/leader/home-busy-health.js', () => ({
  noteHomeBusy: () => {}, noteHomeServed: () => {}, noteMoveNotTaken: () => {}, noteMoveTaken: () => {}, noteSwitchHeld: () => {}, noteSwitchConfirmed: () => {},
}))
vi.mock('../../../src/core/leader/switch/boot.js', () => ({ currentLeaderPermit: () => null }))

import { configureHostLeader } from '../../../src/core/leader/primary-leader.js'
import { notifyOutwardDoorsOpened, setOutwardDoorChecker, _forgetDoorsOpenedListenersForTesting } from '../../../src/core/leader/switch/doors.js'
import { resetHomeMoveForTests } from '../../../src/core/home-move.js'

afterEach(() => { setOutwardDoorChecker(null); _forgetDoorsOpenedListenersForTesting(); resetHomeMoveForTests() })

/** A host whose leader book says the companion's backup leads it (epoch 2), until a claim. */
function backupHost() {
  const sent: string[] = []
  let holder: 'backup' | 'primary' = 'backup'
  let epoch = 2
  return {
    sent,
    conn: {
      hostKey: 'devbox',
      send: async (cmd: string) => {
        sent.push(cmd)
        if (cmd === 'leader.claim') { holder = 'primary'; epoch++; return { ok: true, epoch } }
        return { ok: true, epoch, holder, since: Date.now() - 1_000 }
      },
    },
  }
}

describe('taking a host back from the companion\'s backup lead', () => {
  it('with no permit: claims at once, as before', async () => {
    const h = backupHost()
    expect(await configureHostLeader(h.conn)).toMatchObject({ holder: 'primary', epoch: 3 })
    expect(h.sent).toEqual(['leader.configure', 'leader.claim'])
  })

  it('while this server may not act: no claim; the host stays with the backup until the doors open, then it is taken back once', async () => {
    let open = false
    setOutwardDoorChecker((kind) => { if (!open) throw Object.assign(new Error('write permission not held'), { name: 'PermitNotHeld' }); void kind }, () => open)
    const h = backupHost()
    expect(await configureHostLeader(h.conn)).toMatchObject({ holder: 'backup', epoch: 2 })
    expect(h.sent).toEqual(['leader.configure'])
    // A second connect while still waiting subscribes once (one key per host).
    await configureHostLeader(h.conn)
    expect(h.sent).toEqual(['leader.configure', 'leader.configure'])
    // The permission stands: the doors open, and the lead is taken back.
    open = true
    notifyOutwardDoorsOpened()
    await vi.waitFor(() => expect(h.sent).toEqual(['leader.configure', 'leader.configure', 'leader.configure', 'leader.claim']))
    notifyOutwardDoorsOpened()
    expect(h.sent.filter((c) => c === 'leader.claim')).toHaveLength(1)
  })
})
