/**
 * What an Org node with no session shows (web/src/components/org/org-start-view.ts): it starts by
 * itself (src/core/org/org-autostart.ts), so only a failure, a Main not made yet, a project with
 * no VP, a node Walnut will not start by itself and the org switched off show anything else.
 */
import { describe, expect, it } from 'vitest'
import { orgStartView } from '../../web/src/components/org/org-start-view'

const vp = { kind: 'project' as const, contactId: 'lead-1' }

describe('an Org node with no session', () => {
  it('reads starting while it starts by itself, and while the server is asked', () => {
    expect(orgStartView({ enabled: true, row: vp, contact: {}, answer: null })).toEqual({ kind: 'starting' })
    expect(orgStartView({ enabled: true, row: vp, contact: { org_start: { state: 'starting', at: 'x' } }, answer: null })).toEqual({ kind: 'starting' })
    // It has a session the page has not seen yet: its chat replaces this in a moment.
    expect(orgStartView({ enabled: true, row: vp, contact: {}, answer: { skipped: 'has_session' } })).toEqual({ kind: 'starting' })
  })

  it('says why a start failed, from the task or from the answer', () => {
    expect(orgStartView({ enabled: true, row: vp, contact: { org_start: { state: 'failed', at: 'x', error: 'host "x" is not configured' } }, answer: null }))
      .toEqual({ kind: 'failed', error: 'host "x" is not configured' })
    expect(orgStartView({ enabled: true, row: vp, contact: { org_start: { state: 'failed', at: 'x' } }, answer: null }))
      .toEqual({ kind: 'failed', error: 'it did not start' })
    expect(orgStartView({ enabled: true, row: vp, contact: {}, answer: { error: 'network down' } })).toEqual({ kind: 'failed', error: 'network down' })
  })

  it('offers Start only where Walnut will not start it by itself', () => {
    for (const skipped of ['autostart_off', 'test_run', 'failed_before', 'complete', 'missing']) {
      expect(orgStartView({ enabled: true, row: vp, contact: {}, answer: { skipped } })).toEqual({ kind: 'idle' })
    }
    // A Main not made yet, and a project with no VP.
    expect(orgStartView({ enabled: true, row: { kind: 'main' }, contact: undefined, answer: null })).toEqual({ kind: 'idle' })
    expect(orgStartView({ enabled: true, row: { kind: 'project' }, contact: undefined, answer: null })).toEqual({ kind: 'no-vp' })
  })

  it('while the tasks load offers nothing, and a message to Main just sent reads starting', () => {
    expect(orgStartView({ enabled: true, row: { kind: 'main' }, contact: undefined, answer: null, loading: true })).toEqual({ kind: 'loading' })
    expect(orgStartView({ enabled: true, row: { kind: 'main' }, contact: undefined, answer: null, starting: true })).toEqual({ kind: 'starting' })
  })

  it('on a replica says the node starts on the primary', () => {
    expect(orgStartView({ enabled: true, row: vp, contact: {}, answer: { error: 'x', status: 501 } })).toEqual({ kind: 'elsewhere' })
  })

  it('with the org off says so, whatever else', () => {
    expect(orgStartView({ enabled: false, row: vp, contact: { org_start: { state: 'failed', at: 'x', error: 'e' } }, answer: null })).toEqual({ kind: 'off' })
    expect(orgStartView({ enabled: false, row: { kind: 'project' }, contact: undefined, answer: null })).toEqual({ kind: 'off' })
  })
})
