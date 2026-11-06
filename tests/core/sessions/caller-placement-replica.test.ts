import { describe, it, expect, vi } from 'vitest'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-caller-placement-replica', { CLOUD_MODE: true }))
const copies = vi.hoisted(() => ({
  task: {} as Record<string, unknown>,
  session: { id: 'replica-caller', task_id: 'parent', project: 'Ask Walnut', host: 'devbox', cwd: '/repo/app' },
}))
vi.mock('../../../src/core/task-projection.js', () => ({ readTaskProjection: async () => ({ tasks: [copies.task] }) }))
vi.mock('../../../src/core/session-projection.js', () => ({ readSessionProjection: async () => ({ sessions: [copies.session] }) }))

import { resolveCallerPlacement, inheritedTier, decidePlacement } from '../../../src/core/sessions/caller-placement.js'

describe('replica caller placement', () => {
  it.each(['focus', 'wait', 'ct_release', undefined])('an old ask in a work project inherits its live tier %s', async (focus_tier) => {
    copies.task = { id: 'parent', title: 'Practice lead', project: 'Personal', walnut_agent: true, pinned: true, focus_tier }
    const caller = await resolveCallerPlacement('replica-caller')
    expect(caller).toMatchObject({ kind: 'worker', task: { project: 'Personal', pinned: true }, session: { host: 'devbox' } })
    expect(decidePlacement({}, caller)).toMatchObject({ project: 'Personal', parentTaskId: 'parent' })
    expect(inheritedTier({}, caller)).toEqual({ pinned: true, ...(focus_tier ? { focus_tier } : {}) })
  })

  it.each([
    { project: 'Ask Walnut', walnut_agent: true },
    { project: '', walnut_agent: true },
    { project: 'Walnut', walnut_agent: true, org_role: 'main' },
  ])('a true ask still keeps its placement defaults: %j', async (task) => {
    copies.task = { id: 'parent', title: 'Ask', pinned: true, focus_tier: 'wait', ...task }
    const caller = await resolveCallerPlacement('replica-caller')
    expect(caller.kind).toBe('ask')
    expect(inheritedTier({}, caller)).toEqual({ pinned: true, focus_tier: 'wait' })
    expect(decidePlacement({}, caller).project).toBeUndefined()
  })
})
