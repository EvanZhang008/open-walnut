/**
 * The cloud companion keeps its copy of the Mac's sessions in a file of its own and runs no host's
 * starts: it takes none of the rows a start carries (replication/kinds/sessions.ts applyLeaderSessionRows).
 * Its own file: the companion is decided by the constants (CLOUD_MODE), once per process.
 */
import { describe, expect, it, vi } from 'vitest'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-apply-leader-rows-companion', { CLOUD_MODE: true }))

import { applyLeaderSessionRows } from '../../../src/core/replication/kinds/sessions.js'
import type { SessionRecord } from '../../../src/core/types.js'

describe('applyLeaderSessionRows on the companion', () => {
  it('takes none, whatever host key it names', async () => {
    process.env.WALNUT_HOST_KEY = 'devbox'
    try {
      const r = { claudeSessionId: 'cccccccc-0001-4001-8001-000000000001', taskId: 'task-1', archived: true, archive_reason: 'engine_switched:codex' } as SessionRecord
      expect(await applyLeaderSessionRows([r], Date.now())).toBe(0)
    } finally { delete process.env.WALNUT_HOST_KEY }
  })
})
