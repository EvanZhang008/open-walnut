/**
 * A session a service set move stopped on the shared daemon gets its next message on the set's
 * daemon, which never ran it: `send` answers not_found and `attach` "session not found". Drill D1
 * (2026-11-23): that line was held ("could not confirm the process identity") until a leader restart.
 * On a set's daemon it is the death verdict that lets the runner resume the session there
 * (--resume; the host's cli-owner record still refuses a second CLI). Anywhere else a missing
 * registry stays no proof of death, as before.
 */
import { describe, expect, it, vi } from 'vitest'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-moved-session-resume'))

import { RemoteSessionManager } from '../../src/providers/remote-session-manager.js'

const SID = '10000000-0000-4000-8000-00000000d001'

function manager(serviceSet: string) {
  const sent: string[] = []
  const conn = {
    connected: true, serviceSet, hostKey: 'devbox',
    hasCapability: () => false,
    send: async (cmd: string) => {
      sent.push(cmd)
      if (cmd === 'send') return { ok: false, reason: 'not_found' }
      if (cmd === 'attach') return { ok: false, error: `attach: session not found: ${SID}` }
      return { ok: true }
    },
  }
  const mgr = new RemoteSessionManager(SID, 'devbox', null)
  const m = mgr as unknown as { conn: unknown; _sid: string; _hasPipe: boolean; _onExit: (code: number) => void; writeMessageNow: (msg: string, o: unknown, seq: number) => Promise<boolean> }
  m.conn = conn
  m._sid = SID
  m._hasPipe = true
  const exits: number[] = []
  m._onExit = (code) => exits.push(code)
  return { m, sent, exits }
}

describe('a moved session\'s next message on its service set\'s daemon (drill D1)', () => {
  it('resumes there: the send returns false (the runner\'s --resume path) with a clean exit, nothing held', async () => {
    const { m, sent, exits } = manager('0123456789abcdef')
    expect(await m.writeMessageNow('next line', undefined, 1)).toBe(false)
    expect(sent).toEqual(['send', 'attach'])
    expect(exits).toEqual([0])
  })

  it('on the default set\'s daemon a missing registry is still no proof of death: held', async () => {
    const { m, exits } = manager('')
    await expect(m.writeMessageNow('next line', undefined, 1)).rejects.toThrow(/could not confirm the process identity/)
    expect(exits).toEqual([])
  })
})
