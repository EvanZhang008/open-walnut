/**
 * A session of an engine with its own sign-in (Antigravity) whose CLI on the host is not signed
 * in: the chat gets the engine and the host with the error (session:error `signIn`), in words a
 * person reads, and a turn that cannot start for it waits for the user's Retry
 * (delivery-failure.ts sign_in_required). An engine without such a sign-in keeps its old error.
 */
import fs from 'node:fs/promises'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-acp-session-sign-in'))

import { WALNUT_HOME } from '../../src/constants.js'
import { _resetSessionTrackerForTesting, createSessionRecord } from '../../src/core/session-tracker.js'
import { AcpSession } from '../../src/providers/acp-session.js'
import { bus, EventNames } from '../../src/core/event-bus.js'
import { EngineSignInRequiredError, classifyDeliveryFailure } from '../../src/providers/delivery-failure.js'
import { notSignedInWords, signInHostName } from '../../src/core/agents/engine-sign-in.js'
import { usersErrorKind } from '../../src/core/sessions/session-error-owner.js'
import type { SessionEngine } from '../../src/core/types.js'

beforeEach(async () => {
  _resetSessionTrackerForTesting()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  await fs.mkdir(WALNUT_HOME, { recursive: true })
})
afterEach(() => { bus.unsubscribe('acp-sign-in-test') })

let seq = 0
async function run(engine: SessionEngine, errorKind: string, host?: string) {
  const sessionId = `acp-sign-in-${engine}-${++seq}`
  const runtimeId = `rt-sign-in-${seq}`
  const commandId = 'acp-prompt:qm-sign-in'
  await createSessionRecord(sessionId, '', 'Quick Start', '/tmp', {
    initialProcessStatus: 'running', messageCount: 0, engine, acpRuntimeId: runtimeId, ...(host ? { host } : {}),
  })
  const session = new AcpSession({
    taskId: '', project: 'Quick Start', cwd: '/tmp', mode: 'default', engine,
    providerSessionId: sessionId, runtimeId, consumedOffset: 0, ...(host ? { host } : {}),
  })
  const errors: Array<Record<string, unknown>> = []
  bus.subscribe('acp-sign-in-test', (e) => {
    if (e.name === EventNames.SESSION_ERROR) errors.push(e.data as Record<string, unknown>)
  }, { global: true, interest: ['session:error'] })
  const consume = (session as unknown as { consumeJournalLine(line: string, offset: number): void }).consumeJournalLine.bind(session)
  const line = (v: number, rec: unknown) => consume(JSON.stringify(rec), v)
  line(100, { kind: 'meta', ts: 1, event: { type: 'prompt-accepted', commandId, walnutMessageId: 'qm-sign-in', text: 'hi' } })
  line(200, { kind: 'meta', ts: 2, event: { type: 'turn-started', commandId } })
  line(300, { kind: 'meta', ts: 3, event: { type: 'error', errorKind, message: 'ACP provider authentication is required', commandId } })
  line(400, { kind: 'meta', ts: 4, event: { type: 'turn-ended', commandId, stopReason: 'end_turn' } })
  return errors
}

describe('a turn refused for a missing sign-in', () => {
  it('Antigravity on another host: the error names the engine and the host, and reads as the user\'s sign-in', async () => {
    const errors = await run('antigravity', 'auth_required', 'devbox')
    expect(errors).toHaveLength(1)
    expect(errors[0].signIn).toEqual({ engine: 'antigravity', host: 'devbox', hostName: 'devbox' })
    expect(errors[0].error).toBe('Antigravity is not signed in on devbox. Open Settings to sign in.')
    expect(usersErrorKind(String(errors[0].error))).toBe('sign-in')
  })

  it('Antigravity on this machine names it so', async () => {
    const errors = await run('antigravity', 'auth_required')
    expect(errors[0].signIn).toMatchObject({ engine: 'antigravity', host: '__local__', hostName: signInHostName('__local__') })
  })

  it('another error of the same engine, and the same error of an engine without its own sign-in, carry none', async () => {
    expect((await run('antigravity', 'protocol'))[0].signIn).toBeUndefined()
    const codex = await run('codex', 'auth_required')
    expect(codex[0].signIn).toBeUndefined()
    expect(String(codex[0].error)).toContain('auth_required')
  })
})

describe('a start refused for a missing sign-in', () => {
  it('waits for the user\'s Retry, said in the same words', () => {
    const words = notSignedInWords('antigravity', 'devbox')
    const err = new EngineSignInRequiredError(words, 'antigravity', 'devbox', 'devbox')
    expect(classifyDeliveryFailure(err)).toEqual({ kind: 'permanent', code: 'sign_in_required', reason: words })
    expect(err.signIn).toEqual({ engine: 'antigravity', host: 'devbox', hostName: 'devbox' })
  })

  it('a host\'s label is its name in the words', () => {
    expect(signInHostName('devbox', { hosts: { devbox: { label: 'Build box' } } })).toBe('Build box')
    expect(signInHostName('devbox', { hosts: {} })).toBe('devbox')
  })
})
