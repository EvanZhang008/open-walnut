/**
 * The terminal orphan sweep honours the link's dial gate (src/core/hosts/link.ts dialRefusal; drill
 * round 4, R4-1). The sweep runs on every terminal reaper pass and reaches each configured host over
 * ssh. A host removed in Settings that ~/.ssh/config also names comes back as a found host waiting for
 * the yes, with its sessions' records still here, and the sweep kept a waiting host that had sessions:
 * every pass ssh-ed the host the person removed. A host turned off was swept too.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const state = vi.hoisted(() => ({ reached: [] as string[], hosts: {} as Record<string, unknown>, sessions: [] as Array<Record<string, unknown>> }))

vi.mock('../../../src/web/terminal/host-shell.js', () => ({
  hostLinkRunsScripts: async () => false,
  runOnTerminalHost: async (host: string | undefined) => {
    state.reached.push(host ?? '__local__')
    return { code: 0, stdout: 'OWNER:\n', stderr: '' }
  },
}))
vi.mock('../../../src/core/session-tracker.js', () => ({ listSessions: async () => state.sessions }))
vi.mock('../../../src/core/config-manager.js', () => ({ getConfig: async () => ({ hosts: state.hosts }) }))
vi.mock('../../../src/web/terminal/terminal-manager.js', () => ({ terminalManager: { isViewing: () => false, liveSlots: () => [] } }))

import { reapOrphanDtach } from '../../../src/web/terminal/dtach-lifecycle.js'

beforeEach(() => {
  state.reached = []
})

describe('terminal orphan sweep: no ssh to a host Walnut does not reach', () => {
  it('sweeps a host on; skips one turned off and a removed host back as a found host, even with sessions there', async () => {
    state.hosts = {
      'on-box': { hostname: 'on-box.invalid', enabled: true },
      'off-box': { hostname: 'off-box.invalid', enabled: false },
      'gone-box': { hostname: 'gone-box.invalid', discovered: true, connect: 'ask', enabled: false },
    }
    state.sessions = [
      { claudeSessionId: 's-gone', host: 'gone-box', process_status: 'stopped' },
      { claudeSessionId: 's-off', host: 'off-box', process_status: 'idle' },
    ]
    await reapOrphanDtach({ remoteHosts: true })
    expect(state.reached).toContain('on-box')
    expect(state.reached).not.toContain('off-box')
    expect(state.reached).not.toContain('gone-box')
  })
})
