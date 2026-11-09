import { describe, expect, it } from 'vitest'
import { errorOwnerOf, usersErrorKind } from '../../../src/core/sessions/session-error-owner.js'
import { deriveUserStatus } from '../../../src/core/user-status.js'

const NOW = Date.parse('2026-11-09T12:00:00Z')
const ago = (ms: number) => new Date(NOW - ms).toISOString()

// 2026-11-09: two review sessions on another Mac ended on this text, Walnut's own retries failed the
// same way, and both read Needs you with "Retry it or open it".
const ECONNRESET = 'API Error: Connection dropped (ECONNRESET)'

describe('whose a session error is', () => {
  it('a passing error is the team\'s, never the user\'s', () => {
    for (const text of [
      ECONNRESET,
      'API Error: Connection refused — a firewall or proxy may be blocking it (ECONNREFUSED)',
      'API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}',
      'API Error: 500 Internal server error',
      'API Error: 503 Service Unavailable',
      'Request timed out',
      'socket hang up',
      'API Error: Server error mid-response.',
      'CLI exited with code 1',
      null,
      '',
    ]) expect(usersErrorKind(text), String(text)).toBeNull()
  })

  it('names the kind of an error only the user can fix', () => {
    expect(usersErrorKind('API Error: 401 {"error":{"message":"invalid x-api-key"}}')).toBe('credentials')
    expect(usersErrorKind('Invalid API key · Please run /login')).toBe('sign-in')
    expect(usersErrorKind('OAuth token has expired. Please obtain a new token or refresh your existing token.')).toBe('credentials')
    expect(usersErrorKind('user@host: Permission denied (publickey) [walnut-ssh-evidence: cert-expired]')).toBe('sign-in')
    expect(usersErrorKind('Your credit balance is too low to access the API')).toBe('spending')
    expect(usersErrorKind('API Error: 403 User is not authorized to perform: bedrock:InvokeModel')).toBe('permissions')
    expect(usersErrorKind('auth expired')).toBe('credentials')
    // The session budget's own refusal (providers/delivery-failure.ts budget_paused).
    expect(usersErrorKind('Not sent: the session budget is paused. Raise or remove the limit, then retry.')).toBe('spending')
  })

  it('the node above takes it: its lead, else its VP, else Main; Main has only the user', () => {
    expect(errorOwnerOf({ hasLeader: true, projectLead: true, hasMain: true })).toBe('lead')
    expect(errorOwnerOf({ projectLead: true, hasMain: true })).toBe('vp')
    expect(errorOwnerOf({ hasMain: true })).toBe('main')
    expect(errorOwnerOf({})).toBeNull()
    // A VP's own failure goes to Main; Main's to the user.
    expect(errorOwnerOf({ isLead: true, projectLead: true, hasMain: true })).toBe('main')
    expect(errorOwnerOf({ isMain: true, hasMain: true })).toBeNull()
    // A leader that completed hears nothing more from its subtasks: the next node takes it.
    expect(errorOwnerOf({ hasLeader: true, leaderOpen: false, projectLead: true, hasMain: true })).toBe('vp')
    expect(errorOwnerOf({ hasLeader: true, leaderOpen: false })).toBeNull()
  })
})

describe('a failed session in the status the user reads', () => {
  const failed = { phase: 'NEED_ACTION', hasSession: true, processStatus: 'error', errorMessage: ECONNRESET, phaseChangedAt: ago(60_000) }

  it('waits on Walnut while its own retry is pending', () => {
    const s = deriveUserStatus({ ...failed, hasLeader: true, autoRetryAt: new Date(NOW + 180_000).toISOString() }, NOW)
    expect(s).toMatchObject({ state: 'waiting', kind: 'machine' })
    expect(s.waitingOn).toContain('Walnut, retrying its failed turn by itself at 12:03 UTC (API Error: Connection dropped (ECONNRESET))')
  })

  it('then waits on the node above, naming the error, never Needs you', () => {
    const lead = deriveUserStatus({ ...failed, hasLeader: true, projectLead: true, hasMain: true }, NOW)
    expect(lead).toMatchObject({ state: 'waiting', kind: 'lead' })
    expect(lead.waitingOn).toBe(`Its lead, to retry it: its session failed again after Walnut's own retry (${ECONNRESET})`)
    expect(deriveUserStatus({ ...failed, projectLead: true, hasMain: true }, NOW).waitingOn).toMatch(/^Its VP, to retry it/)
    expect(deriveUserStatus({ ...failed, hasMain: true }, NOW).waitingOn).toMatch(/^Main, to retry it/)
  })

  it('reaches the user only with no one above it, or with an error of his kind', () => {
    expect(deriveUserStatus(failed, NOW)).toMatchObject({ state: 'needs', source: 'error' })
    const signIn = deriveUserStatus({ ...failed, hasLeader: true, errorMessage: 'Invalid API key · Please run /login' }, NOW)
    expect(signIn).toMatchObject({ state: 'needs', source: 'error' })
    expect(signIn.ask).toContain('It needs a sign-in only you can do.')
  })

  it('every machine failure Walnut gave up on goes the same way', () => {
    const gaveUp = {
      phase: 'NEED_ACTION', hasSession: true, processStatus: 'stopped',
      endpointWait: { state: 'gave_up', url: 'http://127.0.0.1:8402', where: 'this Mac', since: ago(7 * 3600_000), resumes: 0, gaveUpWhy: 'time' },
    }
    expect(deriveUserStatus({ ...gaveUp, hasMain: true }, NOW)).toMatchObject({ state: 'waiting', kind: 'lead', waitingOn: expect.stringMatching(/^Main, to retry it/) })
    expect(deriveUserStatus(gaveUp, NOW)).toMatchObject({ state: 'needs', source: 'error' })
    const lost = { phase: 'IN_PROGRESS', hasSession: true, processStatus: 'stopped', restartLoss: { state: 'gave_up', cause: 'machine_reboot' } }
    expect(deriveUserStatus({ ...lost, hasMain: true }, NOW)).toMatchObject({ state: 'waiting', kind: 'lead', waitingOn: expect.stringMatching(/^Main, to retry it: Walnut could not resume it/) })
    const undelivered = { phase: 'NEED_ACTION', hasSession: true, processStatus: 'stopped', undeliveredMessage: 'Not delivered: its working directory is gone' }
    expect(deriveUserStatus({ ...undelivered, hasLeader: true }, NOW)).toMatchObject({ state: 'waiting', kind: 'lead' })
    // A paused budget is his to raise.
    const budget = { ...undelivered, undeliveredMessage: 'Not sent: the session budget is paused. Raise or remove the limit, then retry.' }
    expect(deriveUserStatus({ ...budget, hasLeader: true }, NOW)).toMatchObject({ state: 'needs', source: 'error', ask: expect.stringContaining('spending only you can approve') })
    // The user's own terminal holding the session is his.
    const terminal = { ...undelivered, undeliveredMessage: 'Not delivered: the user (or someone) has this session open in a terminal right now (claude -r)' }
    expect(deriveUserStatus({ ...terminal, hasLeader: true }, NOW)).toMatchObject({ state: 'needs', source: 'error' })
  })
})
