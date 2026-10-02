/**
 * The ask half of a human launch (core/sessions/ask-launch-plan.ts), shared by
 * the web draft's quick-start and the phone's POST /api/v1/sessions. Each rule
 * here is one a phone-born ask and a Mac-born ask must agree on; the real-server
 * comparison of the two launches is tests/e2e/mobile-launch-ask.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const memory = vi.hoisted(() => ({ prefs: {} as { model?: string }, writes: [] as Array<{ model?: string }> }))
vi.mock('../../../src/core/sessions/ask-walnut-launch.js', () => ({
  getAskWalnutLaunchPrefs: async () => memory.prefs,
  rememberAskWalnutLaunch: async (pick: { model?: string }) => { memory.writes.push(pick) },
}))

const stamps = vi.hoisted(() => new Map<string, string | undefined>())
vi.mock('../../../src/core/sessions/ask-agent.js', async (orig) => {
  const real = await orig<typeof import('../../../src/core/sessions/ask-agent.js')>()
  const agents: Record<string, string> = { general: 'Walnut', mentor: 'Mentor' }
  return {
    ...real,
    stampedAgentId: async (taskId: string) => stamps.get(taskId),
    resolveAskAgent: async (id: string | undefined) => {
      const key = id?.trim() || 'general'
      return agents[key] ? { id: key, name: agents[key] } : undefined
    },
  }
})

import {
  ASK_DEFAULT_TIER,
  askLaunchProject,
  askLaunchTier,
  rememberAskModelPick,
  rememberedAskModel,
  resolveLaunchAskAgent,
} from '../../../src/core/sessions/ask-launch-plan.js'

beforeEach(() => {
  memory.prefs = {}
  memory.writes = []
  stamps.clear()
})

describe('askLaunchTier', () => {
  it('is born in Focus unless the caller named a tier; null keeps it off the board', () => {
    expect(ASK_DEFAULT_TIER).toBe('focus')
    expect(askLaunchTier(undefined)).toBe('focus')
    expect(askLaunchTier(null)).toBeNull()
    expect(askLaunchTier('wait')).toBe('wait')
  })
})

describe('askLaunchProject', () => {
  it("files under the agent's own project unless the caller picked one", () => {
    expect(askLaunchProject(undefined, { id: 'general', name: 'Walnut' })).toBe('Ask Walnut')
    expect(askLaunchProject('   ', { id: 'mentor', name: 'Mentor' })).toBe('Ask Mentor')
    expect(askLaunchProject('  Weekly review ', { id: 'mentor', name: 'Mentor' })).toBe('Weekly review')
  })
})

describe('resolveLaunchAskAgent', () => {
  it('a named agent wins; a retry that names none takes the task stamp; no stamp is Walnut', async () => {
    stamps.set('task-mentor', 'mentor')
    expect(await resolveLaunchAskAgent('general', 'task-mentor')).toEqual({ id: 'general', name: 'Walnut' })
    expect(await resolveLaunchAskAgent(undefined, 'task-mentor')).toEqual({ id: 'mentor', name: 'Mentor' })
    expect(await resolveLaunchAskAgent(undefined, 'task-plain')).toEqual({ id: 'general', name: 'Walnut' })
    expect(await resolveLaunchAskAgent(undefined, undefined)).toEqual({ id: 'general', name: 'Walnut' })
    expect(await resolveLaunchAskAgent('no-such-agent', undefined)).toBeUndefined()
  })
})

describe('rememberedAskModel', () => {
  it('applies the last ask pick in CLI form, on the native engine only', async () => {
    expect(await rememberedAskModel(true)).toBeUndefined()
    memory.prefs = { model: 'sonnet' }
    expect(await rememberedAskModel(true)).toBe('sonnet')
    // An ACP adapter would refuse an id picked in the claude picker.
    expect(await rememberedAskModel(false)).toBeUndefined()
  })
})

describe('rememberAskModelPick', () => {
  it("stores a named pick, clears on 'default', and leaves the memory alone otherwise", () => {
    rememberAskModelPick('haiku', undefined)
    rememberAskModelPick('default', undefined)
    rememberAskModelPick('', undefined)
    // Not a string: never stored as a model, same as naming Auto.
    rememberAskModelPick(42, undefined)
    expect(memory.writes).toEqual([{ model: 'haiku' }, { model: undefined }, { model: undefined }, { model: undefined }])

    memory.writes = []
    // Named nothing: whatever is remembered stays.
    rememberAskModelPick(undefined, undefined)
    // A retry re-picked nothing, even when it carries a model.
    rememberAskModelPick('sonnet', 'task-1')
    expect(memory.writes).toEqual([])
  })
})
