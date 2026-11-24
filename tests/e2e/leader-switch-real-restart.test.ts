/**
 * Restarts of the leader with witnesses set up, real servers (docs/reference/leader-switch.md;
 * scripts/leader-switch/rehearsal.ts rehearseRestart): a planned restart closes the outward doors
 * for seconds, a crash until the dead process's record runs out, and a routine slot due while they
 * were closed fires once. The product's permit clocks: the crash closes the doors for the product's
 * lease (about a minute), so the 15 s routine's slot comes due while they are closed.
 *
 * The other scenarios are in the leader-switch-real-*.test.ts files (tests/helpers/leader-switch-real.ts).
 */
import { describe, expect, it } from 'vitest'
import path from 'node:path'
import { rehearseRestart } from '../../scripts/leader-switch/rehearsal.js'
import { failed, portsFrom, realSwitchRoot } from '../helpers/leader-switch-real.js'

const root = realSwitchRoot('restart')
const ports = portsFrom(4)

describe('the leader restarted, real servers', () => {
  it('a planned restart closes the doors for seconds, a crash until the record runs out; a routine slot due meanwhile fires once', async () => {
    const c = await rehearseRestart(path.join(root, 'restarts'), () => {}, ports())
    expect(failed(c.all)).toEqual([])
  }, 400_000)
})
