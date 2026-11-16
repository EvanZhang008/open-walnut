/**
 * GET /api/v1/sessions/:id/history (readSessionRichHistory) when the history read
 * itself fails (HistoryReadFailedError): the frozen contract answers 200, with the
 * last good copy or an empty history marked historyUnavailable, never a 502
 * (docs/reference/api-v1.md). 2026-11-16: an over-ceiling tail read failed during a
 * deploy; that failure must not read as "no messages", nor break the v1 shape.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import fs from 'node:fs/promises'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-rich-history-read-failed'))

const state = vi.hoisted(() => ({ cached: undefined as unknown[] | undefined }))
vi.mock('../../../src/core/session-history.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/core/session-history.js')>()
  return {
    ...actual,
    readSessionHistory: vi.fn(async () => { throw new actual.HistoryReadFailedError('This conversation could not be read right now.') }),
    getCachedSessionHistory: vi.fn(() => state.cached),
  }
})

import { WALNUT_HOME } from '../../../src/constants.js'
import { createSessionRecord } from '../../../src/core/session-tracker.js'
import { readSessionRichHistory } from '../../../src/core/sessions/session-lifecycle.js'

describe('v1 rich history when the read fails', () => {
  beforeEach(async () => {
    state.cached = undefined
    await fs.rm(WALNUT_HOME, { recursive: true, force: true })
    await fs.mkdir(WALNUT_HOME, { recursive: true })
  })

  it('answers the last good copy instead of a 502', async () => {
    await createSessionRecord('rich-failed-cached', '', 'p')
    state.cached = [{ role: 'user', text: 'kept question', timestamp: '2026-01-01T00:00:00Z' }]
    const res = await readSessionRichHistory('rich-failed-cached', 400)
    expect(res.messages.map(m => m.text)).toEqual(['kept question'])
    expect(res.historyUnavailable).toBeUndefined()
  })

  it('with no copy anywhere answers empty with historyUnavailable, not a 502', async () => {
    await createSessionRecord('rich-failed-empty', '', 'p')
    const res = await readSessionRichHistory('rich-failed-empty', 400)
    expect(res).toMatchObject({ messages: [], total: 0, historyUnavailable: 'This conversation could not be read right now.' })
  })
})
