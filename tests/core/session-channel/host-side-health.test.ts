/**
 * Review round 1, S2: a host that stood down, or waits on a channel its leader says it has, shows
 * in the leader's Walnut Health (host-side-health.ts): one item per host, raised once per change
 * into either state, recovered when the host's report says it judges again. Never a pop-up.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

const raised: Array<{ key: string; title: string; host?: string }> = []
const recovered: string[] = []
vi.mock('../../../src/core/notifications/health-items.js', () => ({
  hostLabel: async (k: string) => k,
  healthConditions: () => ({
    raise: async (key: string, item: () => Promise<{ title: string; host?: string; needsYou?: unknown }>) => { const i = await item(); expect(i.needsYou).toBeUndefined(); raised.push({ key, title: i.title, host: i.host }) },
    recover: async (key: string) => { recovered.push(key) },
    reset: () => {},
  }),
}))

import { _resetHostSideHealthForTesting, noteHostSessionSide } from '../../../src/core/session-channel/host-side-health.js'

afterEach(() => { raised.length = 0; recovered.length = 0; _resetHostSideHealthForTesting() })
const flush = () => new Promise((r) => setTimeout(r, 0))

describe('the leader\'s Walnut Health item for a host\'s session side', () => {
  it('raised once when the host stands down, again when it changes to waiting, recovered when it judges again', async () => {
    noteHostSessionSide('devbox-a', 'judging')
    noteHostSessionSide('devbox-a', 'stood-down')
    noteHostSessionSide('devbox-a', 'stood-down')
    await flush()
    expect(raised).toEqual([{ key: 'host-sessions:devbox-a', title: 'Sessions on devbox-a are judged by no one', host: 'devbox-a' }])
    noteHostSessionSide('devbox-a', 'waiting')
    await flush()
    expect(raised.map((r) => r.title)).toEqual(['Sessions on devbox-a are judged by no one', 'The session channel to devbox-a did not open'])
    noteHostSessionSide('devbox-a', null)
    await flush()
    expect(recovered).toEqual(['host-sessions:devbox-a'])
  })

  it('a host that never reported a problem recovers nothing', async () => {
    noteHostSessionSide('devbox-b', 'judging')
    noteHostSessionSide('devbox-b', undefined)
    await flush()
    expect(raised).toEqual([])
    expect(recovered).toEqual([])
  })
})
