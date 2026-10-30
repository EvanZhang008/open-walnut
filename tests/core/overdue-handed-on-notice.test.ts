/**
 * The overdue notice of a request its target handed on quotes the task it went to, not the
 * target (2026-10-29: four overdue notices to Main each quoted a lead's own latest message, about
 * other work, instead of the worker that had the request). Pure: the envelope wording
 * (peers/envelope-kit.ts buildRequestNotification) the server and the daemon share.
 */
import { describe, it, expect } from 'vitest'
import { buildRequestNotification } from '../../src/core/session-requests.js'
import type { SessionRequest } from '../../src/core/session-requests.js'

const request = { id: 'rq-osprey01', preview: 'Fix the highlight bug', fromSessionId: 's-main', createdAt: '2026-10-29T10:00:00Z', status: 'pending' } as SessionRequest
const target = {
  title: 'Osprey lead', sessionId: 's-lead', taskId: 't-lead', phase: 'IN_PROGRESS',
  lastMessage: { text: 'Second-user fix for the login page is live.' },
}

describe('overdue notice of a request handed on', () => {
  it('quotes the task it went to, with each task\'s state, never the target\'s own message', () => {
    const text = buildRequestNotification(request, 'timeout', {
      ...target,
      handedOn: [
        { taskId: 't-old', title: 'First try', state: 'stopped', phase: 'COMPLETE' },
        { taskId: 't-worker', title: 'Highlight worker', state: 'working', phase: 'IN_PROGRESS', lastMessage: { text: 'Reproduced it in WebKit; fixing the observer now.' } },
      ],
    })
    expect(text).toContain('outcome="timeout"')
    expect(text).toContain('handed your request on')
    expect(text).toContain('"Highlight worker" (t-worker): still has it, no answer yet; its task is IN_PROGRESS now')
    expect(text).toContain('"First try" (t-old): finished without an explicit answer; its task is COMPLETE now')
    expect(text).toContain('Reproduced it in WebKit; fixing the observer now.')
    expect(text).not.toContain('Second-user fix')
    expect(text).toContain(`task_get '{"id":"t-worker"}'`)
    expect(text).toContain('OVERDUE')
  })

  it('says so when the task it went to has no words yet, and still names its state', () => {
    const text = buildRequestNotification(request, 'timeout', {
      ...target, handedOn: [{ taskId: 't-worker', title: 'Highlight worker', state: 'working', phase: 'TODO' }],
    })
    expect(text).toContain('could not be read')
    expect(text).toContain('its task is TODO now')
    expect(text).not.toContain('Second-user fix')
  })

  it('a request not handed on still quotes the target, and a turn end still reads as before', () => {
    const overdue = buildRequestNotification(request, 'timeout', target)
    expect(overdue).toContain('Second-user fix')
    const ended = buildRequestNotification(request, 'completed', { ...target, handedOn: [{ taskId: 't-worker', state: 'working' }] })
    expect(ended).toContain('Its turn ended WITHOUT an explicit reply')
  })
})
