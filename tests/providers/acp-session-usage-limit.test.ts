/**
 * An ACP engine's turn the subscription's usage limit refused (Codex through codex-acp): the session
 * hands the usage-limit wait (src/core/sessions/usage-limit-wait.ts) its facts on session:error, and
 * the record keeps the provider's words. The worker names it (errorKind 'usage_limit', its reset read
 * on the host); an older worker's protocol error is read from the turn's own last text.
 */
import fs from 'node:fs/promises'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-acp-session-usage-limit'))

import { WALNUT_HOME } from '../../src/constants.js'
import { _resetSessionTrackerForTesting, createSessionRecord, getSessionByClaudeId } from '../../src/core/session-tracker.js'
import { AcpSession } from '../../src/providers/acp-session.js'
import { bus, EventNames } from '../../src/core/event-bus.js'

const WORDS = "You've hit your usage limit. Upgrade to Pro (https://example.invalid/pro) or try again in 2 hours 13 minutes."

beforeEach(async () => {
  _resetSessionTrackerForTesting()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  await fs.mkdir(WALNUT_HOME, { recursive: true })
})
afterEach(() => { bus.unsubscribe('acp-usage-limit-test') })

let seq = 0
async function run(errorKind: string, opts: { resetsAt?: number; text?: string } = {}) {
  const sessionId = `acp-limit-${errorKind}-${++seq}`
  const runtimeId = `rt-${errorKind}-${seq}`
  const commandId = 'acp-prompt:qm-limit'
  await createSessionRecord(sessionId, '', 'Quick Start', '/tmp', {
    initialProcessStatus: 'running', messageCount: 0, engine: 'codex', acpRuntimeId: runtimeId,
  })
  const session = new AcpSession({
    taskId: '', project: 'Quick Start', cwd: '/tmp', mode: 'default',
    providerSessionId: sessionId, runtimeId, consumedOffset: 0,
  })
  const errors: Array<Record<string, unknown>> = []
  bus.subscribe('acp-usage-limit-test', (e) => {
    if (e.name === EventNames.SESSION_ERROR) errors.push(e.data as Record<string, unknown>)
  }, { global: true, interest: ['session:error'] })
  const consume = (session as unknown as { consumeJournalLine(line: string, offset: number): void }).consumeJournalLine.bind(session)
  const line = (v: number, rec: unknown) => consume(JSON.stringify(rec), v)
  line(100, { kind: 'meta', ts: 1, event: { type: 'prompt-accepted', commandId, walnutMessageId: 'qm-limit', text: 'go on' } })
  line(200, { kind: 'meta', ts: 2, event: { type: 'turn-started', commandId } })
  line(300, {
    kind: 'acp', ts: 3, source: 'live',
    frame: { method: 'session/update', params: { sessionId, update: { sessionUpdate: 'agent_message_chunk', messageId: 'm1', content: { type: 'text', text: opts.text ?? WORDS } } } },
  })
  line(400, { kind: 'meta', ts: 4, event: { type: 'error', errorKind, message: 'x', commandId, ...(opts.resetsAt ? { resetsAt: opts.resetsAt } : {}) } })
  line(500, { kind: 'meta', ts: 5, event: { type: 'turn-interrupted', reason: 'worker-crash', commandId } })
  return { sessionId, errors }
}

describe('an ACP turn the usage limit refused', () => {
  it('the worker names it: session:error carries the facts with the host-read reset', async () => {
    const reset = Date.now() + 2 * 3_600_000
    const { sessionId, errors } = await run('usage_limit', { resetsAt: reset })
    expect(errors).toHaveLength(1)
    expect(errors[0].usageLimit).toMatchObject({ engine: 'codex', resetsAt: reset, resetsFrom: 'text' })
    await vi.waitFor(async () => {
      const rec = await getSessionByClaudeId(sessionId)
      expect(rec?.process_status).toBe('error')
      expect(rec?.errorMessage).toContain("You've hit your usage limit")
    })
  })

  it('an older worker: a protocol error after the limit words is the limit too', async () => {
    const before = Date.now()
    const { errors } = await run('protocol')
    const facts = errors[0].usageLimit as { resetsAt: number } | undefined
    expect(facts).toMatchObject({ engine: 'codex' })
    expect(facts!.resetsAt).toBeGreaterThanOrEqual(before + 133 * 60_000)
  })

  it('a protocol error after any other text is no limit', async () => {
    const { sessionId, errors } = await run('protocol', { text: 'Working on it.' })
    expect(errors[0].usageLimit).toBeUndefined()
    await vi.waitFor(async () => expect((await getSessionByClaudeId(sessionId))?.process_status).toBe('error'))
    expect((await getSessionByClaudeId(sessionId))?.errorMessage ?? '').not.toContain('usage limit')
  })
})
