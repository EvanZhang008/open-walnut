/**
 * Invites with no companion (src/core/net/net-local.ts), against a fake of this Mac's
 * daemon that keeps the invites the way walnut-net does (in memory, gone on a restart):
 *
 *  - a join is only read until the Mac kept the machine; then walnut-net forgets it;
 *  - an invite walnut-net lost (it restarted) ends, and is never handed over again: it
 *    may have been used just before, and a code works once;
 *  - joins a stopped run never read are handed back, then walnut-net forgets every invite
 *    this run did not make; a walnut-net that does not answer decides nothing;
 *  - at most 16 links are open (all walnut-net takes);
 *  - a link called back is taken out of walnut-net, unless a machine already used it.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { cancelLocalInvite, clearLeftovers, forgetLocalInvite, leftoverJoins, localInviteState, makeLocalInvite, resetLocalInvitesForTest, type Daemon, type LocalJoin } from '../../../src/core/net/net-local.js'
import { decodeTicket } from '../../../src/core/net/join-ticket.js'
import { netKey } from '../../helpers/net-keys.js'

const MAC = netKey('local-mac')
const BOX = netKey('local-box')

function fakeDaemon(opts: { caps?: string[] } = {}) {
  let invites: Array<{ id: string }> = []
  const used = new Map<string, LocalJoin>()
  const pushes: string[][] = []
  const d: Daemon & { restart(): void; use(id: string, j: LocalJoin): void; pushes: string[][]; held(): string[] } = {
    hasCapability: (c) => (opts.caps ?? ['net-v1', 'net-join-v1']).includes(c),
    async send(cmd, params) {
      if (cmd === 'net.invites') {
        invites = (params.invites as Array<{ id: string }>).map((i) => ({ id: i.id }))
        pushes.push(invites.map((i) => i.id))
        for (const id of [...used.keys()]) if (!invites.some((i) => i.id === id)) used.delete(id)
        return { ok: true }
      }
      if (cmd === 'net.status') return { ok: true, node: { addrs: ['192.168.1.20:41641'], homeRelay: null, invites: invites.map((i) => ({ id: i.id, used: used.get(i.id) ?? null })) } }
      throw new Error(`unexpected ${cmd}`)
    },
    restart() { invites = []; used.clear() },
    use(id, j) { used.set(id, j) },
    pushes,
    held: () => invites.map((i) => i.id),
  }
  return d
}

const join: LocalJoin = { memberId: BOX, name: 'box', hostname: 'box.example.test', platform: 'linux-x64', at: 1, addrs: ['192.168.1.7:41000'] }

beforeEach(() => resetLocalInvitesForTest())

describe('invites with no companion', () => {
  it('makes a ticket walnut-net checks, and reads a join until the Mac kept the machine', async () => {
    const d = fakeDaemon()
    const inv = await makeLocalInvite(d, { macId: MAC, relayMode: 'none' })
    expect(decodeTicket(inv.link)).toMatchObject({ mac: MAC, relayMode: 'none', addrs: ['192.168.1.20:41641'], relay: null })
    expect(d.held()).toEqual([inv.id])
    expect((await localInviteState(d, inv.id)).state).toBe('waiting')
    d.use(inv.id, join)
    // Read twice: still there (a failed write of the machine can try again).
    expect(await localInviteState(d, inv.id)).toEqual({ state: 'joined', join })
    expect(await localInviteState(d, inv.id)).toEqual({ state: 'joined', join })
    expect(d.held()).toEqual([inv.id])
    await forgetLocalInvite(d, inv.id)
    expect(d.held()).toEqual([])
  })

  it('a link called back leaves walnut-net; one a machine already used is kept as joined', async () => {
    const d = fakeDaemon()
    const a = await makeLocalInvite(d, { macId: MAC, relayMode: 'none' })
    const b = await makeLocalInvite(d, { macId: MAC, relayMode: 'none' })
    expect(await cancelLocalInvite(d, a.id)).toBe('cancelled')
    expect(d.held()).toEqual([b.id])
    expect((await localInviteState(d, a.id)).state).toBe('expired')
    d.use(b.id, join)
    expect(await cancelLocalInvite(d, b.id)).toBe('joined')
    expect(d.held()).toEqual([b.id])
    expect(await localInviteState(d, b.id)).toEqual({ state: 'joined', join })
  })

  it('a call back walnut-net did not take keeps the link working, and says why', async () => {
    const d = fakeDaemon()
    const inv = await makeLocalInvite(d, { macId: MAC, relayMode: 'none' })
    const send = d.send.bind(d)
    d.send = async (cmd, params) => (cmd === 'net.invites' ? { ok: false, error: 'busy' } : send(cmd, params))
    await expect(cancelLocalInvite(d, inv.id)).rejects.toThrow(/did not take the invite: busy/)
    d.send = send
    expect(d.held()).toEqual([inv.id])
    expect((await localInviteState(d, inv.id)).state).toBe('waiting')
  })

  it('a call back walnut-net does not answer to is refused, and the link keeps working (it may have been used)', async () => {
    const d = fakeDaemon()
    const inv = await makeLocalInvite(d, { macId: MAC, relayMode: 'none' })
    const send = d.send.bind(d)
    d.send = async (cmd, params) => (cmd === 'net.status' ? { ok: true, node: null } : send(cmd, params))
    await expect(cancelLocalInvite(d, inv.id)).rejects.toMatchObject({ code: 'net_no_answer', message: expect.stringMatching(/did not answer, so the link was not called back/) })
    d.send = async (cmd, params) => { if (cmd === 'net.status') throw new Error('timed out'); return send(cmd, params) }
    await expect(cancelLocalInvite(d, inv.id)).rejects.toMatchObject({ code: 'net_no_answer' })
    d.send = send
    expect(d.held()).toEqual([inv.id])
    expect((await localInviteState(d, inv.id)).state).toBe('waiting')
  })

  it('decides nothing while walnut-net does not answer, and pushes lists in order', async () => {
    const d = fakeDaemon()
    const inv = await makeLocalInvite(d, { macId: MAC, relayMode: 'none' })
    const send = d.send.bind(d)
    d.send = async (cmd, params) => (cmd === 'net.status' ? { ok: true, node: null } : send(cmd, params))
    expect((await localInviteState(d, inv.id)).state).toBe('waiting')
    d.send = send
    expect((await localInviteState(d, inv.id)).state).toBe('waiting')
    // A forget and a new invite at once: the last list walnut-net gets is the newest.
    const [, next] = await Promise.all([forgetLocalInvite(d, inv.id), makeLocalInvite(d, { macId: MAC, relayMode: 'none' })])
    expect(d.held()).toEqual([next.id])
  })

  it('ends an invite walnut-net lost, and never hands it over again', async () => {
    const d = fakeDaemon()
    const inv = await makeLocalInvite(d, { macId: MAC, relayMode: 'none' })
    d.restart()
    expect((await localInviteState(d, inv.id)).state).toBe('expired')
    expect(d.held()).toEqual([])
    expect((await localInviteState(d, inv.id)).state).toBe('expired')
    expect(d.pushes.every((p) => p.length <= 1)).toBe(true)
    expect(d.pushes.at(-1)).toEqual([])
  })

  it('hands back joins a stopped run never read, and clears its invites, once', async () => {
    const d = fakeDaemon()
    // A run before this one made two invites; one was used before it stopped.
    await makeLocalInvite(d, { macId: MAC, relayMode: 'none' })
    const old = await makeLocalInvite(d, { macId: MAC, relayMode: 'none' })
    d.use(old.id, join)
    // This run (net-mac.ts takes them in its first sync, before any invite of its own): read,
    // kept by the Mac, then cleared.
    resetLocalInvitesForTest()
    expect(await leftoverJoins(d)).toEqual([join])
    expect(d.held()).toHaveLength(2)
    await clearLeftovers(d)
    expect(d.held()).toEqual([])
    const mine = await makeLocalInvite(d, { macId: MAC, relayMode: 'none' })
    expect(await leftoverJoins(d)).toEqual([])
    expect(d.held()).toEqual([mine.id])
    // An older daemon has none; a walnut-net that does not answer decides nothing.
    expect(await leftoverJoins(fakeDaemon({ caps: ['net-v1'] }))).toEqual([])
    const silent = fakeDaemon()
    silent.send = async (cmd) => (cmd === 'net.status' ? { ok: true, node: null } : { ok: true })
    expect(await leftoverJoins(silent)).toBeNull()
  })

  it('keeps at most 16 links open, and needs a daemon that takes machines in', async () => {
    const d = fakeDaemon()
    for (let i = 0; i < 16; i++) await makeLocalInvite(d, { macId: MAC, relayMode: 'none' })
    await expect(makeLocalInvite(d, { macId: MAC, relayMode: 'none' })).rejects.toMatchObject({ status: 429, code: 'too_many_invites' })
    await expect(makeLocalInvite(fakeDaemon({ caps: ['net-v1'] }), { macId: MAC, relayMode: 'none' })).rejects.toMatchObject({ status: 409, code: 'daemon_too_old' })
  })
})
