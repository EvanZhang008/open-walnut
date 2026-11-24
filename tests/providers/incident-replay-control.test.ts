/**
 * The incident replay (tests/e2e/incident-replay.test.ts) runs the daemon's real control reducers, which
 * tests/helpers/incident-replay-control.ts lifts out of the runtime's source. Only the e2e tier ran it, so a
 * move of the inbound branch out of daemon-standalone.ts (the session tailer split, 2026-11-24) broke main
 * and no land saw it. This quick test loads the helper, so a reducer that moves to a file the helper does
 * not read fails here, at the land, instead of in the deep test.
 */
import { describe, it, expect } from 'vitest'
import { replayControlTracker } from '../helpers/incident-replay-control.js'

describe('incident replay control reducers (lifted from the runtime source)', () => {
  it('a permission request is pending until its own response, and a cancel clears it', () => {
    const control = replayControlTracker()
    control.inbound({ type: 'control_request', request_id: 'r1', request: { subtype: 'can_use_tool', tool_name: 'Bash', input: {} } })
    expect(control.pending()).toEqual({ requestId: 'r1', toolName: 'Bash' })
    control.delivered(JSON.stringify({ type: 'control_response', response: { request_id: 'other' } }))
    expect(control.pending()?.requestId).toBe('r1')
    control.delivered(JSON.stringify({ type: 'control_response', response: { request_id: 'r1' } }))
    expect(control.pending()).toBeNull()

    control.inbound({ type: 'control_request', request_id: 'r2', request: { subtype: 'can_use_tool', tool_name: 'Edit', input: {} } })
    control.inbound({ type: 'control_cancel_request', request_id: 'r2' })
    expect(control.pending()).toBeNull()
  })
})
