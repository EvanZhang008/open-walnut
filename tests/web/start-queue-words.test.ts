/**
 * The web's words for a start an older Walnut queued (web/src/utils/start-queue-words.ts) are the
 * server's (src/core/user-status.ts queuedWaitingOn), for a status the server has not derived yet.
 */
import { describe, it, expect } from 'vitest'
import { startQueueWords } from '../../web/src/utils/start-queue-words'
import { queuedWaitingOn } from '../../src/core/user-status'

describe('queued start words', () => {
  it.each([
    [{ host: 'clouddev', reason: 'all 24 slots taken' }],
    [{ host: '__local__', reason: 'load past 6 per CPU' }],
    [{ host: '__local__' }],
    [{}],
  ])('%j reads the same on the web and on the server', (q) => {
    expect(startQueueWords(q)).toBe(queuedWaitingOn(q))
  })

  it('says what it waits for and that Walnut starts it without another retry', () => {
    expect(queuedWaitingOn({ host: 'clouddev', reason: 'all 24 slots taken' }))
      .toBe('Waiting for a free slot on clouddev (all 24 slots taken): Walnut starts it automatically when there is room')
  })
})
