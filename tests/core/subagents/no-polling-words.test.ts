/**
 * A Walnut subagent's answer comes back by itself (registry.ts tellParent), as a native background
 * Agent's does, so nothing Walnut tells a caller may send it to poll: no `subagent_read`, no
 * `wait_ms` loop, in the answer of a running call or in an op's description (2026-11-16, Evan: "u
 * don't need to do anything, the agent will return automatically"; the old answer said
 * `subagent_read '{"wait_ms":600000}' waits for it`). The behaviour itself (the end reaching an
 * idle caller with no read) is pinned in subagent-on-host.test.ts "NO POLLING".
 */
import { describe, it, expect } from 'vitest'
import { runOutcome } from '../../../src/ops/subagents.js'
import { getOp } from '../../../src/ops/registry.js'
import '../../../src/ops/index.js'

const POLL = /subagent_read|wait_ms|poll it again|call again/i

describe('nothing tells a subagent\'s caller to poll', () => {
  it('a running call says the answer comes by itself', () => {
    for (const body of [{ id: 'sa-1', state: 'running', tool_uses: 3 }, { id: 'sa-1', state: 'running', from_host: '__local__', host: 'cloud' }]) {
      const text = JSON.stringify(runOutcome(body))
      expect(text).not.toMatch(POLL)
      expect(text).toMatch(/by itself/)
    }
  })

  it('no op that starts or talks to a subagent tells it to wait with a read', () => {
    for (const name of ['subagent_run', 'subagent_send']) {
      const op = getOp(name)!
      expect(op, name).toBeTruthy()
      expect(op.description).not.toMatch(/subagent_read/)
      expect(op.description).toMatch(/never (wait on it or )?poll/i)
    }
    expect(getOp('subagent_read')!.description).toMatch(/never call this to wait/i)
    expect(getOp('subagent_read')!.input).not.toHaveProperty('wait_ms')
  })

  it('subagent_run tells the caller to use its own Agent tool for most work', () => {
    expect(getOp('subagent_run')!.description).toMatch(/^USE YOUR OWN Agent TOOL FOR MOST SUBAGENTS/)
  })
})
