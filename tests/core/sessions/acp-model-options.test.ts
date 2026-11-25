/**
 * The model menu of a session whose engine lists its own models (src/core/sessions/acp-model-rows.ts).
 *
 * Pinned (2026-11-25: an Antigravity session's phone sheet listed Claude Code's models): the phone's
 * GET /api/v1/sessions/:id/model-options core answers with the live ACP catalog, the current row the
 * catalog's own; with no live session it shows the record's own model; Claude Code's host catalog
 * is never read for such a session. Every ACP engine of the registry is covered, so a new one is too.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionRecord } from '../../../src/core/types.js'

const state = vi.hoisted(() => ({
  record: null as Record<string, unknown> | null,
  acp: undefined as { modelCatalog: { currentModelId?: string; availableModels: Array<{ modelId: string; name: string; description?: string }> } } | undefined,
  hostCatalogReads: 0,
  attaches: 0,
  here: undefined as { modelCatalog: { currentModelId?: string; availableModels: Array<{ modelId: string; name: string }> } } | undefined,
}))

vi.mock('../../../src/core/session-tracker.js', () => ({
  getSessionByClaudeId: async () => state.record,
}))
vi.mock('../../../src/core/host-model-catalog.js', () => ({
  getHostModelCatalog: async () => { state.hostCatalogReads++; return { models: [{ value: 'opus', displayName: 'Opus' }], fetchedAt: '' } },
}))
vi.mock('../../../src/providers/claude-code-session.js', () => ({
  sessionRunner: {
    findOrAttachAcpSession: async () => { state.attaches++; return state.acp },
    findAcpSession: () => state.here,
    getOrAttachLiveSession: async () => undefined,
  },
}))

const { computeModelOptions } = await import('../../../src/core/sessions/session-controls.js')
const { ENGINE_REGISTRY } = await import('../../../src/core/agents/engine-registry.js')
const { listsOwnModels } = await import('../../../src/core/sessions/acp-model-rows.js')

const SID = 'aaaaaaaa-1111-4111-8111-111111111111'
const NEON = { modelId: 'gemini-4-neon[high]', name: 'Gemini 4 Neon (high)', description: 'Fast' }
const HYDROGEN = { modelId: 'gemini-4-hydrogen[high]', name: 'Gemini 4 Hydrogen (high)' }

function record(over: Partial<SessionRecord> = {}): Record<string, unknown> {
  return { claudeSessionId: SID, engine: 'antigravity', process_status: 'running', model: 'gemini-4-hydrogen[high]', ...over }
}

beforeEach(() => {
  state.record = record()
  state.acp = undefined
  state.hostCatalogReads = 0
  state.attaches = 0
  state.here = undefined
})

describe('model options of a session whose engine lists its own models', () => {
  it('the live ACP catalog, its current row, and never the Claude host catalog', async () => {
    state.acp = { modelCatalog: { currentModelId: HYDROGEN.modelId, availableModels: [HYDROGEN, NEON] } }
    const r = await computeModelOptions(SID)
    expect(r.models).toEqual([
      { id: HYDROGEN.modelId, label: HYDROGEN.name, supportsEffort: false },
      { id: NEON.modelId, label: NEON.name, supportsEffort: false },
    ])
    expect(r.current).toBe(HYDROGEN.modelId)
    expect(r.currentEffort).toBeNull()
    expect(state.hostCatalogReads).toBe(0)
  })

  it('a stopped session: the record\'s own model as the one row, and no worker is started for the menu', async () => {
    state.record = record({ process_status: 'stopped', acpModel: NEON.modelId, acpModelName: NEON.name } as Partial<SessionRecord>)
    state.acp = { modelCatalog: { availableModels: [HYDROGEN, NEON] } }
    const r = await computeModelOptions(SID)
    expect(r.models).toEqual([{ id: NEON.modelId, label: NEON.name, supportsEffort: false }])
    expect(r.current).toBe(NEON.modelId)
    expect(state.attaches).toBe(0)
    expect(state.hostCatalogReads).toBe(0)
  })

  it('a stopped session whose ACP object this server still holds lists its catalog, still without an attach', async () => {
    state.record = record({ process_status: 'stopped' })
    state.here = { modelCatalog: { currentModelId: NEON.modelId, availableModels: [HYDROGEN, NEON] } }
    const r = await computeModelOptions(SID)
    expect(r.models.map((m) => m.id)).toEqual([HYDROGEN.modelId, NEON.modelId])
    expect(r.current).toBe(NEON.modelId)
    expect(state.attaches).toBe(0)
  })

  it('a live read that hangs answers the record\'s model within the control cap', async () => {
    vi.useFakeTimers()
    try {
      state.record = record({ acpModel: HYDROGEN.modelId } as Partial<SessionRecord>)
      state.acp = new Promise(() => {}) as never
      const pending = computeModelOptions(SID)
      await vi.advanceTimersByTimeAsync(21_000)
      const r = await pending
      expect(r.models.map((m) => m.id)).toEqual([HYDROGEN.modelId])
      expect(state.hostCatalogReads).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('every ACP engine of the registry answers from its own catalog', async () => {
    const acpEngines = [...ENGINE_REGISTRY.values()].filter((caps) => caps.modelCatalog === 'provider-advertised').map((caps) => caps.id)
    expect(acpEngines).toContain('antigravity')
    state.acp = { modelCatalog: { availableModels: [NEON] } }
    for (const engine of acpEngines) {
      expect(listsOwnModels(engine)).toBe(true)
      state.record = record({ engine } as Partial<SessionRecord>)
      const r = await computeModelOptions(SID)
      expect(r.models.map((m) => m.id), engine).toEqual([NEON.modelId])
    }
    expect(state.hostCatalogReads).toBe(0)
  })

  it('a Claude Code session still reads the host catalog', async () => {
    state.record = record({ engine: undefined, model: 'opus' })
    const r = await computeModelOptions(SID)
    expect(r.models.map((m) => m.id)).toEqual(['opus'])
    expect(state.hostCatalogReads).toBe(1)
  })
})
