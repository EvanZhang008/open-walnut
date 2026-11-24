/**
 * 'start-shell-setup-v1': the leader's start carries the host's shell_setup (session-shell.ts).
 * '' when the host has none (a removed setup stops running there); nothing to a daemon without
 * the capability; and nothing from a replica, whose config copy has no shell_setup (it may carry
 * tokens) and whose '' would wipe the one the leader sent.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

const role = vi.hoisted(() => ({ follower: false }))
vi.mock('../../src/core/server-role.js', async (orig) => ({
  ...(await orig<typeof import('../../src/core/server-role.js')>()),
  isFollower: () => role.follower,
}))

afterEach(() => { role.follower = false })

async function startPayload(target: { hostname: string; shell_setup?: string }, caps: string[]): Promise<Record<string, unknown>> {
  const { RemoteSessionManager } = await import('../../src/providers/remote-session-manager.js')
  const sent: Array<Record<string, unknown>> = []
  const conn = {
    connected: true,
    hasCapability: (c: string) => caps.includes(c),
    onEvent: () => () => {},
    send: async (cmd: string, payload: Record<string, unknown>) => { if (cmd === 'start') sent.push(payload); return { ok: true, pid: 4242, outputFile: '/nonexistent/x.jsonl', offset: 0 } },
  }
  const mgr = new RemoteSessionManager('sid-shell-setup', 'devbox', target)
  Object.assign(mgr as unknown as Record<string, unknown>, { conn, ensureConnected: async () => conn })
  await mgr.start({ args: ['-p'], cwd: '/tmp', message: '', resume: false, onOutput: () => {}, onExit: () => {} })
  return sent[0]
}

describe('a start carries the host shell_setup', () => {
  const CAP = ['start-shell-setup-v1']

  it('from the leader, to a daemon that takes it', async () => {
    expect((await startPayload({ hostname: 'dev.example.test', shell_setup: 'export A=1' }, CAP)).shellSetup).toBe('export A=1')
    expect((await startPayload({ hostname: 'dev.example.test' }, CAP)).shellSetup).toBe('')
  })

  it('never to an older daemon, and never from a replica', async () => {
    expect(await startPayload({ hostname: 'dev.example.test', shell_setup: 'export A=1' }, [])).not.toHaveProperty('shellSetup')
    role.follower = true
    expect(await startPayload({ hostname: 'dev.example.test', shell_setup: 'export A=1' }, CAP)).not.toHaveProperty('shellSetup')
  })
})
