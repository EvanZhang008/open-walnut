/**
 * The relay intent names its message in the session's relay index before the
 * relay leaves (send-outcomes.ts markRelayIntent, gate r4 mutant mR3). A direct
 * delivery asks that index whether a message relayed earlier may still wait in
 * the Mac's queue; one the index does not name would be overtaken. When the
 * index cannot be written the intent throws, so the relay does not go out.
 */
import { describe, it, expect, afterAll, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-relay-intent-index', { CLOUD_MODE: true }))

import { SEND_QUEUE_DIR, WALNUT_HOME } from '../../src/constants.js'
import { markRelayIntent, readSendOutcome } from '../../src/core/send-outcomes.js'
import { unconfirmedSessionRelays } from '../../src/core/send-relay-index.js'

describe('markRelayIntent: the relay index names the message before the relay leaves', () => {
  afterAll(async () => { await fs.rm(WALNUT_HOME, { recursive: true, force: true }) })

  it('the intent is on disk and the session\'s relay index names the message', async () => {
    await markRelayIntent('sess-ri-1', 'qm-mobile-ri000000001')
    expect(await readSendOutcome('sess-ri-1', 'qm-mobile-ri000000001')).toMatchObject({ state: 'maybe-relayed', relayIntent: true })
    expect(await unconfirmedSessionRelays('sess-ri-1')).toEqual(['qm-mobile-ri000000001'])
  })

  it('an index that cannot be written stops the relay: the intent throws', async () => {
    // A file where the index directory belongs: every write of the index fails.
    const relays = path.join(SEND_QUEUE_DIR, 'relays')
    await fs.mkdir(SEND_QUEUE_DIR, { recursive: true })
    await fs.rm(relays, { recursive: true, force: true })
    await fs.writeFile(relays, 'not a directory')
    try {
      await expect(markRelayIntent('sess-ri-2', 'qm-mobile-ri000000002')).rejects.toThrow()
    } finally {
      await fs.rm(relays, { force: true })
    }
  })
})
