/**
 * The console's wait on a change this Mac makes on its cloud companion outlasts
 * the Mac's own waits there, so the console shows the Mac's sentence (the
 * companion's refusal, or "could not reach the cloud companion") instead of its
 * own deadline, and never reports a change that went through as failed. A gate
 * mutant raised the Mac's wait to 50s, past the console's 45s, and nothing
 * noticed (2026-10-03).
 */
import { describe, it, expect, vi } from 'vitest'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-cloud-change-timeout-order'))

import { CLOUD_CHANGE_TIMEOUT_MS, CLOUD_LIST_TIMEOUT_MS, CLOUD_RELAY_WORST_MS } from '../../src/web/routes/devices.js'
import { CLOUD_CHANGE_CLIENT_TIMEOUT_MS } from '../../web/src/components/settings/sections/cloud/cloud-change-timeout'

/** What the answer itself needs after the Mac's last wait: the response, a slow event loop. */
const ANSWER_SLACK_MS = 5_000

describe('the Mac gives up on its companion before the console gives up on the Mac', () => {
  it('a re-pair (a removal, then a mint) and a removal (a call, then a list) both fit the console\'s wait', () => {
    expect(CLOUD_RELAY_WORST_MS).toBe(Math.max(2 * CLOUD_CHANGE_TIMEOUT_MS, CLOUD_CHANGE_TIMEOUT_MS + CLOUD_LIST_TIMEOUT_MS))
    expect(CLOUD_RELAY_WORST_MS + ANSWER_SLACK_MS).toBeLessThanOrEqual(CLOUD_CHANGE_CLIENT_TIMEOUT_MS)
  })

  it('one call to the companion alone is well inside it', () => {
    expect(CLOUD_CHANGE_TIMEOUT_MS + ANSWER_SLACK_MS).toBeLessThan(CLOUD_CHANGE_CLIENT_TIMEOUT_MS)
  })
})
