/**
 * A leader door (src/core/leader-doors.ts) is no capability's: openSocketDoor answers it only while
 * the code that serves it opened it in this process, whatever capabilities a server has, and a
 * path that is no leader door cannot be opened at all.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { CAPABILITIES, openSocketDoor, type Capability } from '../../src/core/capabilities.js'
import { LEADER_DOORS, openLeaderDoor, setLeaderDoorOpen } from '../../src/core/leader-doors.js'

afterEach(() => { for (const d of LEADER_DOORS) setLeaderDoorOpen(d.path, false) })

describe('leader doors', () => {
  it('/host-door is shut until it is opened, then found by the upgrade handler\'s lookup, and shut again', () => {
    const all = new Set(CAPABILITIES) as ReadonlySet<Capability>
    expect(openSocketDoor('/host-door', all)).toBeNull()
    expect(openSocketDoor('/host-door', new Set())).toBeNull()
    setLeaderDoorOpen('/host-door', true)
    expect(openSocketDoor('/host-door', new Set())?.path).toBe('/host-door')
    expect(openLeaderDoor('/host-door')?.verifiedIn).toBe('src/core/session-channel/host-door.ts')
    // Only the exact path.
    for (const p of ['/host-door/', '/HOST-DOOR', '/host-door?x', '/host']) expect(openSocketDoor(p, all), p).toBeNull()
    setLeaderDoorOpen('/host-door', false)
    expect(openSocketDoor('/host-door', new Set())).toBeNull()
  })

  it('a path that is no leader door cannot be opened', () => {
    expect(() => setLeaderDoorOpen('/bridge', true)).toThrow(/not a leader door/)
    expect(openSocketDoor('/bridge', new Set())).toBeNull()
  })
})
