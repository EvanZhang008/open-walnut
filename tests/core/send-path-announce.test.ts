/**
 * The Mac tells the companion when a delivery path for held phone sends comes
 * up where the companion cannot see it: the Mac reaching a host's daemon again,
 * or its own restarted daemon. Before, both waited for the companion's 60 s
 * sweep (connection matrix D1, H5, H6).
 */
import { describe, it, expect, vi } from 'vitest'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-send-path-announce'))

const forward = vi.fn()
vi.mock('../../src/web/routes/events-v1.js', () => ({ forwardMobileEventToBridge: forward }))

import { startSendPathAnnouncements, SEND_PATH_READY_KIND } from '../../src/core/send-path-announce.js'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe('send-path announcements (Mac side)', () => {
  it('a host connecting is announced to the companion, retried while the Mac\'s own link is not up yet', async () => {
    let onConnected: ((hostKey: string) => void) | undefined
    const off = startSendPathAnnouncements((cb) => { onConnected = cb; return () => { onConnected = undefined } })
    forward.mockResolvedValueOnce(false).mockResolvedValueOnce(true)
    onConnected!('devbox')
    for (let i = 0; i < 50 && forward.mock.calls.length < 2; i++) await sleep(20)
    expect(forward.mock.calls).toEqual([
      [SEND_PATH_READY_KIND, { host: 'devbox' }],
      [SEND_PATH_READY_KIND, { host: 'devbox' }],
    ])
    expect(SEND_PATH_READY_KIND).toBe('send-path-ready')
    off()
    expect(onConnected).toBeUndefined()
  })
})
