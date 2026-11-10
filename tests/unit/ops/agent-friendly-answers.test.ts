/**
 * What an agent reads back from a Walnut tool, from the 2026-11-10 evaluation of the
 * Walnut MCP tools by a fresh agent doing real jobs: an error says it is the caller's
 * to fix and how, a refused op says what to do instead, and a write never answers
 * with a status it already changed.
 */
import { describe, it, expect } from 'vitest'
import { executeOp, getOp } from '../../../src/ops/index.js'
import { hostOrigin } from '../../../src/lib/caller-origin.js'
import { selfCallRefusal } from '../../../src/ops/origin-policy.js'
import { handleGatewayCapability } from '../../../src/core/peers/capability-router.js'
import { PeerThrottle } from '../../../src/core/peers/peer-throttle.js'

const REMOTE = hostOrigin('remote-dev')

describe('an argument mistake is the caller\'s to fix, and says the fix', () => {
  it('a wrong argument name comes back as bad_request with the right name, never "internal"', async () => {
    const r = await handleGatewayCapability('tools.call', 'sid-x', { name: 'task_get', args: { task: 'abc' } }, '__local__', { throttle: new PeerThrottle(), cloudMode: false })
    expect(r).toMatchObject({ ok: false, error: { code: 'bad_request' } })
    expect(JSON.stringify(r)).toContain('did you mean')
  })

  it('an op that does not exist is bad_request too', async () => {
    const r = await handleGatewayCapability('tools.call', 'sid-x', { name: 'task_search', args: {} }, '__local__', { throttle: new PeerThrottle(), cloudMode: false })
    expect(r).toMatchObject({ ok: false, error: { code: 'bad_request' } })
  })
})

describe('a local-only op refused on another host says what to do instead', () => {
  it('task_delete, called by name or through the api route', async () => {
    const byName = await executeOp('task_delete', { id: 'abc' }, { origin: REMOTE } as never)
    expect(byName.ok).toBe(false)
    expect(!byName.ok && byName.message).toMatch(/task_complete/)
    expect(!byName.ok && byName.message).toMatch(/test run/)
    expect(selfCallRefusal('api', 'DELETE', '/api/tasks/abc', REMOTE)).toMatch(/task_complete/)
  })
})

describe('task_update never answers with the status it just changed', () => {
  const stale = { id: 't1', title: 'T', phase: 'NEED_ACTION', user_status: { state: 'waiting' } }
  const call = async () => ({ task: stale })
  it('a phase write leaves the stored user status out and says where to read it', async () => {
    const out = await getOp('task_update')!.handler!({ id: 't1', phase: 'NEED_ACTION' }, call as never) as Record<string, unknown>
    expect((out.task as Record<string, unknown>).user_status).toBeUndefined()
    expect(String(out.outcome)).toMatch(/task_get reads it/)
  })
  it('a write that moves no phase keeps it', async () => {
    const out = await getOp('task_update')!.handler!({ id: 't1', description: 'x' }, call as never) as Record<string, unknown>
    expect((out.task as Record<string, unknown>).user_status).toEqual({ state: 'waiting' })
  })
})
