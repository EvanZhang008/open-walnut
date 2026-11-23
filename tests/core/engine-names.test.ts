/**
 * The one list of engine names (src/core/agents/engine-names.ts) says what the registry
 * says: a native engine is "<name> Code" (as the web's engineLabel and iOS name it), every
 * other engine its display name. The fallback banner, the usage-limit words and the cost
 * report all read it.
 */
import { describe, expect, it } from 'vitest'
import { ENGINE_REGISTRY } from '../../src/core/agents/engine-registry.js'
import { ENGINE_FULL_NAMES, engineFullName } from '../../src/core/agents/engine-names.js'
import { fallbackEngineName } from '../../src/core/agents/fallback-engine-words.js'
import { limitEngineWords } from '../../src/core/sessions/usage-limit-model.js'
import { engineLabel } from '../../src/core/usage/cost-report.js'

describe('engine names', () => {
  it.each([...ENGINE_REGISTRY.values()].map((caps) => [caps.id, caps] as const))('%s is named as the registry names it', (id, caps) => {
    expect(ENGINE_FULL_NAMES[id]).toBe(caps.runtimeKind === 'native' ? `${caps.displayName} Code` : caps.displayName)
  })

  it('every reader names a known engine from the one list', () => {
    expect(fallbackEngineName('antigravity')).toBe('Antigravity')
    expect(fallbackEngineName('custom')).toBe('the custom engine')
    expect(limitEngineWords('antigravity')).toBe('Antigravity')
    expect(limitEngineWords('claude')).toBe('Claude')
    expect(engineLabel('antigravity')).toBe('Antigravity')
    expect(engineLabel('dsh')).toBe('DeepSeek Harness')
  })

  it('an engine this build does not know keeps its id', () => {
    expect(engineFullName('newcomer')).toBe('Newcomer')
    expect(engineLabel('newcomer')).toBe('newcomer')
  })
})
