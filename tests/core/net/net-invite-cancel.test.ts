/**
 * Calling a join link back from Settings > Remote Hosts (src/core/net/net-invites.ts
 * `cancelInvite`): a link on the cloud companion is called back there, one on this Mac in its
 * walnut-net (net-local.ts, tested on its own); a link a machine already used comes back joined;
 * a companion older than the call says so in words about the link, and the link keeps working.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type Answer = { status: number; body: Record<string, unknown> }
const companion = vi.hoisted(() => ({ calls: [] as Array<{ path: string; method: string }>, answer: (_p: string, _m: string): Answer | Promise<Answer> => ({ status: 200, body: {} }) }))

vi.mock('../../../src/core/net/net-mac.js', async () => {
  const { NetError } = await import('../../../src/core/net/net-error.js')
  return {
    syncNet: vi.fn(async () => ({ companion: true, macId: 'mac', relay: 'own', error: null })),
    localDaemon: vi.fn(async () => ({})),
    errorOf: (body: Record<string, unknown>) => {
      const e = body.error as { code?: string; message?: string } | undefined
      return { code: e?.code ?? 'refused', message: e?.message ?? 'The cloud companion refused' }
    },
    companionCall: vi.fn(async (p: string, init: { method: string }) => {
      companion.calls.push({ path: p, method: init.method })
      const a = await companion.answer(p, init.method)
      if (a.status === 404 && !(a.body.error as { code?: string } | undefined)?.code) {
        throw new NetError(409, 'companion_too_old', 'Your cloud companion is too old for the host network; update it first.')
      }
      return a
    }),
  }
})
vi.mock('../../../src/core/net/join-ps1-published.js', () => ({ windowsAppPublished: async () => false }))

const { cancelInvite, inviteStatus, makeInvite, resetInvitesForTest } = await import('../../../src/core/net/net-invites.js')

const made = { id: 'ni-1', link: 'https://c.example/join/X', command: 'curl -fsSL https://c.example/join/X | sh', expiresAt: Date.now() + 600_000 }

beforeEach(() => {
  companion.calls = []
  companion.answer = (_p, m) => (m === 'POST' ? { status: 201, body: made } : { status: 200, body: { state: 'cancelled' } })
})
afterEach(() => resetInvitesForTest())

describe('calling a link back', () => {
  it('calls it back on the companion, and the link reads cancelled', async () => {
    const inv = await makeInvite({})
    expect(inv.state).toBe('waiting')
    expect(await cancelInvite(inv.id)).toMatchObject({ id: 'ni-1', state: 'cancelled' })
    expect(companion.calls.at(-1)).toEqual({ path: '/net/invites/ni-1', method: 'DELETE' })
    expect(inviteStatus(inv.id)?.state).toBe('cancelled')
    // Called back once: a second press asks nothing more.
    const n = companion.calls.length
    expect((await cancelInvite(inv.id)).state).toBe('cancelled')
    expect(companion.calls.length).toBe(n)
  })

  it('a link a machine already used comes back joined', async () => {
    const inv = await makeInvite({})
    companion.answer = (_p, m) => (m === 'DELETE' ? { status: 200, body: { state: 'joined' } } : { status: 200, body: { state: 'joined', member: { id: 'm', name: 'gpu-box' } } })
    expect(await cancelInvite(inv.id)).toMatchObject({ state: 'joined', member: { name: 'gpu-box' } })
  })

  it('a machine that joins while the call-back is on its way: the link reads joined, never cancelled', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    try {
      const inv = await makeInvite({})
      let answerDelete!: (a: Answer) => void
      companion.answer = (_p, m) => (m === 'DELETE'
        ? new Promise<Answer>((r) => { answerDelete = r })
        : { status: 200, body: { state: 'joined', member: { id: 'm', name: 'gpu-box' } } })
      const cancelled = cancelInvite(inv.id)
      await vi.waitFor(() => expect(companion.calls.at(-1)?.method).toBe('DELETE'))
      // The poll reads the join first.
      vi.advanceTimersByTime(3_000)
      await vi.waitFor(() => expect(inviteStatus(inv.id)?.state).toBe('joined'))
      answerDelete({ status: 200, body: { state: 'cancelled' } })
      expect(await cancelled).toMatchObject({ state: 'joined', member: { name: 'gpu-box' } })
      expect(inviteStatus(inv.id)?.state).toBe('joined')
    } finally {
      vi.useRealTimers()
    }
  })

  it('an older companion: the refusal is about the link, which keeps working', async () => {
    const inv = await makeInvite({})
    companion.answer = () => ({ status: 404, body: {} })
    await expect(cancelInvite(inv.id)).rejects.toMatchObject({ code: 'companion_too_old', message: expect.stringMatching(/too old to call a link back; the link works until it ends/) })
    expect(inviteStatus(inv.id)?.state).toBe('waiting')
  })

  it('a link the companion no longer knows reads expired; an unknown id is refused', async () => {
    const inv = await makeInvite({})
    companion.answer = () => ({ status: 404, body: { error: { code: 'unknown_invite', message: 'No such invite' } } })
    expect((await cancelInvite(inv.id)).state).toBe('expired')
    await expect(cancelInvite('ni-none')).rejects.toMatchObject({ status: 404, code: 'unknown_invite' })
  })
})
