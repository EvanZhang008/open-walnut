/**
 * The needs_upgrade ladder in v1-control-relay's classifyRelayReply().
 *
 * This is the seam Phase 4's DUAL fallback hangs on: a cloud box talking to an
 * OLD primary must recognize "this action will never be answered" and write the
 * legacy git outbox file too (core/task-queue.ts). Misclassify that as a plain
 * bridge outage and the op sits in cache/task-queue/ until the Mac upgrades.
 * The primary's own wording is asserted in tests/core/task-queue.test.ts —
 * together they close the loop across the two boxes.
 */
import { describe, it, expect } from 'vitest'
import { classifyRelayReply } from '../../../src/web/routes/v1-control-relay.js'

describe('classifyRelayReply', () => {
  it('maps an unknown action / command / bridge denial to needs_upgrade', () => {
    // Exactly what handleSessionControlRelay's default branch produces.
    expect(classifyRelayReply({ ok: false, error: 'Unknown control action: server.tasks.apply' }).kind)
      .toBe('needs_upgrade')
    // A daemon that predates session.control entirely.
    expect(classifyRelayReply({ ok: false, error: 'unknown command: session.control' }).kind)
      .toBe('needs_upgrade')
    expect(classifyRelayReply({ ok: false, error: 'command not permitted over bridge' }).kind)
      .toBe('needs_upgrade')
  })

  it('maps a dead primary server to bridge_offline (retryable, no legacy write)', () => {
    expect(classifyRelayReply({ ok: false, error: 'session.control: no primary server connected' }).kind)
      .toBe('bridge_offline')
  })

  it('passes a domain failure through with its status and code', () => {
    const failure = classifyRelayReply({
      ok: false, error: 'op too large (999999 > 262144 bytes)', errorKind: 'bad_request',
    })
    expect(failure).toEqual({
      kind: 'error', status: 400, code: 'bad_request',
      message: 'op too large (999999 > 262144 bytes)',
    })
    // A domain errorCode (e.g. terminate's cron_owner) wins over the kind.
    expect(classifyRelayReply({ ok: false, error: 'nope', errorKind: 'conflict', errorCode: 'cron_owner' }))
      .toEqual({ kind: 'error', status: 409, code: 'cron_owner', message: 'nope' })
  })
})
