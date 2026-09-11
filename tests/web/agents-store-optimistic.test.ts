import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentDefinition } from '../../web/src/api/agents.js'

/**
 * Contract tests for the shared agent-definition store.
 *
 * /agents and the homepage chat switcher used to hold independent private copies
 * with no event between them, so an agent created or renamed on /agents left the
 * switcher stale until a full reload. The invariants worth pinning:
 *  1. Every write lands in the ONE list both surfaces read.
 *  2. A refused write rolls back — including a delete, which must go back to the
 *     position it came from.
 *  3. The list and the form metadata load separately (the homepage must not pay
 *     for catalogues it never renders), each shared across callers.
 */

const mocks = vi.hoisted(() => ({
  fetchAgents: vi.fn(),
  fetchAgent: vi.fn(),
  fetchAvailableModels: vi.fn(),
  fetchAvailableSkills: vi.fn(),
  createAgentDef: vi.fn(),
  updateAgentDef: vi.fn(),
  deleteAgentDef: vi.fn(),
  cloneAgentDef: vi.fn(),
  warn: vi.fn(),
}))

vi.mock('@/api/agents', () => ({
  fetchAgents: mocks.fetchAgents,
  fetchAgent: mocks.fetchAgent,
  fetchAvailableModels: mocks.fetchAvailableModels,
  fetchAvailableSkills: mocks.fetchAvailableSkills,
  createAgentDef: mocks.createAgentDef,
  updateAgentDef: mocks.updateAgentDef,
  deleteAgentDef: mocks.deleteAgentDef,
  cloneAgentDef: mocks.cloneAgentDef,
}))
vi.mock('@/utils/log', () => ({ log: { warn: mocks.warn, info: vi.fn() } }))

import {
  __resetAgentsStore,
  createAgentDefinition,
  deleteAgentDefinition,
  getAgentsSnapshot,
  loadAgentMeta,
  loadAgents,
  subscribeAgents,
  updateAgentDefinition,
} from '../../web/src/stores/agents-store.js'

function deferred<T>(): { promise: Promise<T>; resolve(v: T): void; reject(e: unknown): void } {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

function agent(over: Partial<AgentDefinition> = {}): AgentDefinition {
  return { id: 'researcher', name: 'Researcher', runner: 'embedded', source: 'config', ...over }
}

function ids(): string[] {
  return getAgentsSnapshot().agents.map((a) => a.id)
}

describe('agents store', () => {
  beforeEach(() => {
    __resetAgentsStore()
    for (const fn of Object.values(mocks)) fn.mockReset()
  })

  it('one list fetch serves every surface, and metadata is a separate ask', async () => {
    const held = deferred<AgentDefinition[]>()
    mocks.fetchAgents.mockReturnValue(held.promise)
    void loadAgents()
    void loadAgents()
    expect(mocks.fetchAgents).toHaveBeenCalledTimes(1)
    // Nothing pulled the form catalogues in with the list.
    expect(mocks.fetchAvailableModels).not.toHaveBeenCalled()
    expect(mocks.fetchAvailableSkills).not.toHaveBeenCalled()

    held.resolve([agent()])
    await loadAgents()
    expect(ids()).toEqual(['researcher'])
    expect(getAgentsSnapshot().agentsLoaded).toBe(true)
    expect(getAgentsSnapshot().metaLoaded).toBe(false)

    mocks.fetchAvailableModels.mockResolvedValue(['model-a'])
    mocks.fetchAvailableSkills.mockResolvedValue([{ dirName: 's', name: 'S', description: 'd' }])
    await loadAgentMeta()
    expect(getAgentsSnapshot().availableModels).toEqual(['model-a'])
    expect(getAgentsSnapshot().metaLoaded).toBe(true)
  })

  it('a create lands in the one list both surfaces read', async () => {
    mocks.fetchAgents.mockResolvedValue([agent()])
    await loadAgents()
    let notified = 0
    const unsub = subscribeAgents(() => notified++)
    mocks.createAgentDef.mockResolvedValue(agent({ id: 'writer', name: 'Writer', console: true }))

    await createAgentDefinition({ id: 'writer', name: 'Writer', runner: 'embedded' })
    expect(ids()).toEqual(['researcher', 'writer'])
    expect(notified).toBe(1)
    // No blanket refetch — the returned record is enough.
    expect(mocks.fetchAgents).toHaveBeenCalledTimes(1)
    unsub()
  })

  it('a rename shows before the PATCH answers, then takes the server record', async () => {
    mocks.fetchAgents.mockResolvedValue([agent()])
    await loadAgents()
    const held = deferred<AgentDefinition>()
    mocks.updateAgentDef.mockReturnValue(held.promise)

    const done = updateAgentDefinition('researcher', { name: 'Deep Researcher' })
    expect(getAgentsSnapshot().agents[0].name).toBe('Deep Researcher')

    held.resolve(agent({ name: 'Deep Researcher', description: 'from the server' }))
    await done
    expect(getAgentsSnapshot().agents[0].description).toBe('from the server')
  })

  it('a refused rename rolls back to the old name', async () => {
    mocks.fetchAgents.mockResolvedValue([agent()])
    await loadAgents()
    mocks.updateAgentDef.mockRejectedValue(new Error('model not allowed'))

    await expect(updateAgentDefinition('researcher', { name: 'Nope' })).rejects.toThrow('model not allowed')
    expect(getAgentsSnapshot().agents[0].name).toBe('Researcher')
    expect(mocks.warn).toHaveBeenCalled()
  })

  it('a refused delete puts the row back where it was', async () => {
    mocks.fetchAgents.mockResolvedValue([agent({ id: 'a' }), agent({ id: 'b' }), agent({ id: 'c' })])
    await loadAgents()
    mocks.deleteAgentDef.mockRejectedValue(new Error('builtin cannot be deleted'))

    const failing = deleteAgentDefinition('b')
    expect(ids()).toEqual(['a', 'c'])
    await expect(failing).rejects.toThrow('builtin cannot be deleted')
    expect(ids()).toEqual(['a', 'b', 'c'])
  })

  it('deleting an override of a builtin re-reads the list (the builtin comes back)', async () => {
    mocks.fetchAgents.mockResolvedValue([agent({ id: 'summarizer', overrides_builtin: true })])
    await loadAgents()
    mocks.deleteAgentDef.mockResolvedValue(undefined)
    mocks.fetchAgents.mockResolvedValue([agent({ id: 'summarizer', source: 'builtin' })])

    await deleteAgentDefinition('summarizer')
    expect(ids()).toEqual(['summarizer'])
    expect(getAgentsSnapshot().agents[0].source).toBe('builtin')
  })
})
