/**
 * Messages an engine setting held go out by themselves (src/core/sessions/engine-config-resend.ts):
 *   - parked by a setting's refusal (engine_config): once after the next config change, here or
 *     as a new copy of the leader's config on a host;
 *   - left pending because this server had no copy of the leader's settings yet (a transient
 *     refusal, never parked): once the copy arrives.
 * The real queue; the session record and the bus are this test's.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fsp from 'node:fs/promises'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-engine-config-resend'))

const records: Record<string, { claudeSessionId: string; taskId?: string; archived?: boolean }> = {}
vi.mock('../../../src/core/session-tracker.js', async (orig) => ({
  ...(await orig<typeof import('../../../src/core/session-tracker.js')>()),
  getSessionByClaudeId: vi.fn(async (id: string) => records[id] ?? null),
}))

import { WALNUT_HOME } from '../../../src/constants.js'
import { bus, EventNames } from '../../../src/core/event-bus.js'
import { enqueueMessage, getQueue, markProcessing, parkMessages, resetCache, revertToPending } from '../../../src/core/session-message-queue.js'
import { classifyDeliveryFailure } from '../../../src/providers/delivery-failure.js'
import { CodexEngineConfigError } from '../../../src/providers/codex-engine-config.js'
import { withCopiedEngines } from '../../../src/providers/codex-engine-source.js'
import {
  engineConfigResendSettled, noteAwaitingConfigCopy, resendAfterConfigChange, resendAfterConfigCopy, resetEngineConfigResendForTests, wireEngineConfigResend,
} from '../../../src/core/sessions/engine-config-resend.js'

const SID = 'codex-session-on-devbox'
const refusal = classifyDeliveryFailure(new CodexEngineConfigError('provider "local-proxy" is at http://127.0.0.1:8402/v1 ... hosts.<name>.engines.codex.provider'))

let sends: string[] = []

beforeEach(async () => {
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true })
  await fsp.mkdir(WALNUT_HOME, { recursive: true })
  resetCache()
  resetEngineConfigResendForTests()
  for (const k of Object.keys(records)) delete records[k]
  records[SID] = { claudeSessionId: SID, taskId: 'task-1' }
  sends = []
  bus.subscribe('test-engine-config-sends', (e) => { sends.push((e.data as { sessionId: string }).sessionId) }, { global: true, interest: [EventNames.SESSION_SEND] })
})
afterEach(async () => {
  bus.unsubscribe('test-engine-config-sends')
  resetEngineConfigResendForTests()
  resetCache()
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
})

describe('a message a setting held (parked engine_config)', () => {
  it('goes back in line once after a config change, and a row parked for anything else stays', async () => {
    const held = await enqueueMessage(SID, 'are you there')
    await parkMessages(await markProcessing(SID), refusal)
    const other = await enqueueMessage(SID, 'too large', { heldReason: 'Not sent: too large.' })
    expect((await getQueue(SID)).find((m) => m.id === held.id)).toMatchObject({ status: 'parked', parkedCode: 'engine_config' })

    const off = await wireEngineConfigResend()
    try {
      bus.emit(EventNames.CONFIG_CHANGED, { key: 'hosts' }, ['web-ui'])
      await engineConfigResendSettled()
      expect(sends).toEqual([SID])
      const rows = await getQueue(SID)
      expect(rows.find((m) => m.id === held.id)).toMatchObject({ status: 'pending' })
      expect(rows.find((m) => m.id === other.id)).toMatchObject({ status: 'parked', parkedReason: 'Not sent: too large.' })
      // Once: a second change finds nothing a setting holds, and sends nothing.
      bus.emit(EventNames.CONFIG_CHANGED, { key: 'hosts' }, ['web-ui'])
      await engineConfigResendSettled()
      expect(sends).toEqual([SID])
      // Refused again: parked again, and the next change sends it once more.
      await parkMessages(await markProcessing(SID), refusal)
      bus.emit(EventNames.CONFIG_CHANGED, { key: 'engines' }, ['web-ui'])
      await engineConfigResendSettled()
      expect(sends).toEqual([SID, SID])
    } finally { off() }
  })

  it('a new copy of the leader\'s config sends it too; an archived session\'s stays', async () => {
    await enqueueMessage(SID, 'are you there')
    await parkMessages(await markProcessing(SID), refusal)
    records.archived = { claudeSessionId: 'archived', archived: true }
    await enqueueMessage('archived', 'old')
    await parkMessages(await markProcessing('archived'), refusal)
    expect(await resendAfterConfigCopy()).toEqual([SID])
    expect((await getQueue('archived'))[0]).toMatchObject({ status: 'parked' })
    expect(await resendAfterConfigChange()).toEqual([])
  })
})

describe('a message refused while this server had no copy of the leader\'s settings', () => {
  it('the refusal is transient: never parked, no setting\'s 422', () => {
    for (const copy of [null, { hosts: {} }]) {
      let caught: unknown
      try { withCopiedEngines({}, copy) } catch (err) { caught = err }
      expect(caught).toBeInstanceOf(CodexEngineConfigError)
      expect((caught as CodexEngineConfigError).transient).toBe(true)
      expect((caught as CodexEngineConfigError).status).toBeUndefined()
      expect(classifyDeliveryFailure(caught).kind).toBe('transient')
    }
  })

  it('stays pending, and goes once the copy arrives', async () => {
    const row = await enqueueMessage(SID, 'hello')
    // The delivery was refused: back to pending, its session noted (claude-code-session.ts).
    await revertToPending(await markProcessing(SID))
    noteAwaitingConfigCopy(SID)
    expect((await getQueue(SID))[0]).toMatchObject({ id: row.id, status: 'pending' })
    // A config change here is not the copy: nothing goes for it.
    expect(await resendAfterConfigChange()).toEqual([])
    expect(sends).toEqual([])
    expect(await resendAfterConfigCopy()).toEqual([SID])
    expect(sends).toEqual([SID])
    // Once.
    expect(await resendAfterConfigCopy()).toEqual([])
  })
})
