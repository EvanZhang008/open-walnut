/**
 * A leader offers a host its home moves (walnutHomeMoves on leader.configure) only under the
 * one-service experiment: a host keys a Walnut that comes from a new data dir by its id only
 * then (walnut-scope-core.ts adopt), never on a production Walnut before that switch is on.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'

vi.mock('../../../src/constants.js', async () => {
  const { createMockConstants } = await import('../../helpers/mock-constants.js')
  return createMockConstants('walnut-leader-home-moves')
})

import { configureHostLeader } from '../../../src/core/leader/primary-leader.js'
import { resetInProcessDaemonWantedForTests } from '../../../src/providers/in-process-daemon.js'

const saved = process.env.WALNUT_IN_PROCESS_DAEMON
afterEach(() => {
  if (saved === undefined) delete process.env.WALNUT_IN_PROCESS_DAEMON
  else process.env.WALNUT_IN_PROCESS_DAEMON = saved
  resetInProcessDaemonWantedForTests()
})

async function sentWith(flag: '0' | '1'): Promise<Record<string, unknown>> {
  process.env.WALNUT_IN_PROCESS_DAEMON = flag
  resetInProcessDaemonWantedForTests()
  const sent: Array<Record<string, unknown>> = []
  await configureHostLeader({
    hostKey: 'h1',
    send: async (cmd, params) => { sent.push({ cmd, ...params }); return { ok: false, error: 'test stops here' } },
  })
  const configure = sent.find((s) => s.cmd === 'leader.configure')
  if (!configure) throw new Error('no leader.configure sent')
  return configure
}

describe('leader.configure and home moves', () => {
  it('the experiment off: no walnutHomeMoves, so no host aliases this home', async () => {
    expect(await sentWith('0')).not.toHaveProperty('walnutHomeMoves')
  })
  it('the experiment on: walnutHomeMoves true', async () => {
    expect(await sentWith('1')).toMatchObject({ walnutHomeMoves: true })
  })
})
