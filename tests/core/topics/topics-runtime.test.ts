/**
 * The topics services follow the experiment (src/core/topics/topics-runtime.ts, review L8): with the
 * flag off nothing subscribes or runs a timer (no reply capture on session:result, no mail tap, no
 * pass timer); turning it on in Settings starts them, and off stops them again.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-topics-runtime'))

import { WALNUT_HOME } from '../../../src/constants.js'
import { updateConfig } from '../../../src/core/config-manager.js'
import { bus, EventNames } from '../../../src/core/event-bus.js'
import { topicMailListening } from '../../../src/core/topics/topic-mail-port.js'
import { TOPIC_MAIL_PASS_MS } from '../../../src/core/topics/topic-mail.js'
import { startTopicsRuntime } from '../../../src/core/topics/topics-runtime.js'

const subscribed = (name: string): boolean => (bus as unknown as { subscribers: Map<string, unknown> }).subscribers.has(name)
/** The topics' own timers: the mail pass (a minute) and the reply expiry (ten minutes). */
const topicTimers = (spy: { mock: { calls: unknown[][] } }) => spy.mock.calls.filter((c) => c[1] === TOPIC_MAIL_PASS_MS || c[1] === 10 * 60_000)

async function setFlag(on: boolean): Promise<void> {
  await updateConfig({ experimental: { topics: on } } as never)
  bus.emit(EventNames.CONFIG_CHANGED, { key: 'experimental' }, ['web-ui'], { source: 'test' })
}

beforeAll(async () => {
  await fs.mkdir(WALNUT_HOME, { recursive: true })
})

afterAll(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
})

describe('the topics services follow the experiment', () => {
  it('off: no subscription, no tap, no timer; on: started; off again: stopped', async () => {
    await updateConfig({ experimental: { topics: false } } as never)
    const timers = vi.spyOn(globalThis, 'setInterval')
    const runtime = startTopicsRuntime()
    try {
      await runtime.reconcile()
      expect(runtime.running()).toBe(false)
      expect(subscribed('topic-replies')).toBe(false)
      expect(topicMailListening()).toBe(false)
      expect(topicTimers(timers)).toEqual([])

      await setFlag(true)
      await vi.waitFor(() => expect(runtime.running()).toBe(true))
      await runtime.reconcile()
      expect(topicMailListening()).toBe(true)
      await vi.waitFor(() => expect(subscribed('topic-replies')).toBe(true))
      expect(topicTimers(timers).length).toBe(2)

      await setFlag(false)
      await vi.waitFor(() => expect(runtime.running()).toBe(false))
      expect(topicMailListening()).toBe(false)
      await vi.waitFor(() => expect(subscribed('topic-replies')).toBe(false))
    } finally {
      runtime.stop()
      timers.mockRestore()
    }
  })
})
