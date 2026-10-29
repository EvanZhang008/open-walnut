/**
 * The companion's direct send to a host daemon, when the daemon's FIFO write
 * failed after part or all of the line went in.
 *
 * Before: ENXIO / session_dead was always read as "the line never reached the
 * CLI": the direct intent was cleared and the phone was told 409 session_dead,
 * so a client retry could deliver a message the CLI already held. Now a daemon
 * that says `written: prefix | body | line` makes the outcome ambiguous: the
 * intent stays, and nobody sends it again without proof. A daemon that says
 * `none`, or an older daemon that says nothing, keeps today's answer.
 *
 * What's mocked: the bridge (its requests are the daemon's answers), the intent
 * store and the stop fence. What's real: deliverDirectToHost.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const bridge = vi.hoisted(() => ({ send: {} as Record<string, unknown> }))
vi.mock('../../../src/web/ws/bridge-registry.js', () => ({
  BridgeOfflineError: class BridgeOfflineError extends Error {},
  bridgeRequest: vi.fn(async (_host: string, cmd: string) => {
    if (cmd === 'status') return { exists: true, alive: true, sendMarkers: true }
    if (cmd === 'send') return bridge.send
    return {}
  }),
}))
const intents = vi.hoisted(() => ({ mark: vi.fn(async () => {}), clear: vi.fn(async () => {}) }))
vi.mock('../../../src/core/send-outcomes.js', () => ({ markDirectIntent: intents.mark, clearDirectIntent: intents.clear }))
vi.mock('../../../src/core/sessions/cloud-stop-fence.js', () => ({ stopSupersedes: vi.fn(async () => null) }))

import { deliverDirectToHost } from '../../../src/core/sessions/direct-host-send.js'

const input = { host: 'devbox', sessionId: 'sid-direct', text: 'run the deploy', messageId: 'pm-1', stopFence: null }

beforeEach(() => {
  intents.mark.mockClear()
  intents.clear.mockClear()
})

describe('a direct send whose FIFO write failed part way', () => {
  for (const written of ['prefix', 'body'] as const) {
    it(`session_dead with written ${written}: ambiguous, the intent stays`, async () => {
      bridge.send = { ok: false, reason: 'session_dead', exitCode: -1, written }
      const out = await deliverDirectToHost(input)
      expect(out).toMatchObject({ ok: false, kind: 'transport', offline: false, ambiguous: true })
      expect(intents.mark).toHaveBeenCalledOnce()
      expect(intents.clear).not.toHaveBeenCalled()
    })
  }

  it('ENXIO (EPIPE mid-write) with written prefix: ambiguous, the intent stays', async () => {
    bridge.send = { ok: false, reason: 'ENXIO', exitCode: -1, written: 'prefix' }
    expect(await deliverDirectToHost(input)).toMatchObject({ kind: 'transport', ambiguous: true })
    expect(intents.clear).not.toHaveBeenCalled()
  })

  it('an unclassified write error with written body: ambiguous, the intent stays', async () => {
    bridge.send = { ok: false, error: 'send failed: EIO', written: 'body' }
    expect(await deliverDirectToHost(input)).toMatchObject({ kind: 'transport', ambiguous: true })
    expect(intents.clear).not.toHaveBeenCalled()
  })

  it('written none: nothing reached the CLI, refused 409 session_dead as before', async () => {
    bridge.send = { ok: false, reason: 'ENXIO', exitCode: -1, written: 'none' }
    expect(await deliverDirectToHost(input)).toMatchObject({ ok: false, kind: 'refused', status: 409, code: 'session_dead' })
    expect(intents.clear).toHaveBeenCalledOnce()
  })

  it('an older daemon that sends no written field keeps today\'s answer', async () => {
    bridge.send = { ok: false, reason: 'session_dead', exitCode: -1 }
    expect(await deliverDirectToHost(input)).toMatchObject({ ok: false, kind: 'refused', status: 409, code: 'session_dead' })
    expect(intents.clear).toHaveBeenCalledOnce()
    bridge.send = { ok: false, error: 'send failed: EIO' }
    expect(await deliverDirectToHost(input)).toMatchObject({ kind: 'transport', ambiguous: false })
  })
})
