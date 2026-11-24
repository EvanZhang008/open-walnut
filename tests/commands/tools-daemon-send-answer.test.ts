/**
 * A session's task_send / session_send goes through its host daemon first (src/commands/tools.ts);
 * only a daemon that could not route it leaves the call to the HTTP path. A plugin job's call the
 * Walnut server could not yet tell from its job (right after it started, 2026-11-24) is refused as
 * one to ask again, and that refusal stands: over HTTP it would go as an outside caller's.
 */
import { describe, expect, it } from 'vitest'
import { daemonSendAnswerStands } from '../../src/commands/tools.js'

describe('daemonSendAnswerStands', () => {
  it('an answer or a refusal stands; a call the daemon could not route goes over HTTP', () => {
    expect(daemonSendAnswerStands({ ok: true })).toBe(true)
    expect(daemonSendAnswerStands({ ok: false, error: { code: 'bad_request' } })).toBe(true)
    expect(daemonSendAnswerStands({ ok: false, error: { code: 'hub_unreachable' } })).toBe(false)
    expect(daemonSendAnswerStands({ ok: false, error: { code: 'unknown_caller' } })).toBe(false)
  })

  it('a job\'s call refused while the server sets up its jobs stands, never sent anonymous over HTTP', () => {
    expect(daemonSendAnswerStands({ ok: false, error: { code: 'hub_unreachable', detail: { retryAfterMs: 5000, jobsNotKnownYet: true } } })).toBe(true)
  })
})
