import { describe, expect, it } from 'vitest'
import { successorForRetiredModel } from '../../../src/core/sessions/retired-model.js'
import type { SessionModelCatalogEntry } from '../../../src/core/types.js'

// Rows exactly as the host CLI answered list_models after Fable 5, Opus 5 and
// Opus 4.8 left the menu (2026-09-28).
const CATALOG: SessionModelCatalogEntry[] = [
  { value: 'default', displayName: 'Default', resolvedModel: 'global.anthropic.claude-opus-5-5[1m]' },
  { value: 'global.anthropic.claude-fable-5-1[1m]', displayName: 'Fable' },
  { value: 'global.anthropic.claude-sonnet-5', displayName: 'Sonnet' },
  { value: 'global.anthropic.claude-opus-5-5[1m]', displayName: 'Opus' },
  { value: 'haiku', displayName: 'Haiku' },
  { value: 'gpt-6-astra', displayName: 'GPT-6 Astra' },
  { value: 'gpt-6-sol', displayName: 'GPT-6 Sol' },
]

describe('successorForRetiredModel', () => {
  it('moves a retired version to the one row of its family', () => {
    expect(successorForRetiredModel(CATALOG, 'global.anthropic.claude-fable-5[1m]'))
      .toBe('global.anthropic.claude-fable-5-1[1m]')
    expect(successorForRetiredModel(CATALOG, 'global.anthropic.claude-fable-5'))
      .toBe('global.anthropic.claude-fable-5-1[1m]')
    expect(successorForRetiredModel(CATALOG, 'global.anthropic.claude-opus-5[1m]'))
      .toBe('global.anthropic.claude-opus-5-5[1m]')
    expect(successorForRetiredModel(CATALOG, 'us.anthropic.claude-opus-4-8[1m]'))
      .toBe('global.anthropic.claude-opus-5-5[1m]')
  })

  it('leaves a model the host still offers alone', () => {
    for (const offered of ['global.anthropic.claude-fable-5-1[1m]', 'default', 'haiku', 'gpt-6-sol']) {
      expect(successorForRetiredModel(CATALOG, offered)).toBeNull()
    }
  })

  it('leaves another spelling of the same version alone', () => {
    // Allowed by availableModels even though it is not its own menu row.
    expect(successorForRetiredModel(CATALOG, 'claude-opus-5-5')).toBeNull()
    expect(successorForRetiredModel(CATALOG, 'claude-fable-5-1[1m]')).toBeNull()
  })

  it('does not guess for aliases, custom models, or unknown families', () => {
    expect(successorForRetiredModel(CATALOG, 'fable[1m]')).toBeNull()
    expect(successorForRetiredModel(CATALOG, 'gpt-5.6-sol')).toBeNull()
    expect(successorForRetiredModel(CATALOG, 'my-proxy-model')).toBeNull()
    expect(successorForRetiredModel(CATALOG, undefined)).toBeNull()
  })

  it('does not guess when the host catalog is missing or ambiguous', () => {
    expect(successorForRetiredModel([], 'global.anthropic.claude-fable-5[1m]')).toBeNull()
    const two: SessionModelCatalogEntry[] = [
      { value: 'global.anthropic.claude-fable-5-1[1m]', displayName: 'Fable 5.1' },
      { value: 'global.anthropic.claude-fable-5-2[1m]', displayName: 'Fable 5.2' },
    ]
    expect(successorForRetiredModel(two, 'global.anthropic.claude-fable-5[1m]')).toBeNull()
    // A family row with no version to compare (bare alias) is not a successor.
    expect(successorForRetiredModel(CATALOG, 'global.anthropic.claude-haiku-4-5-20251001-v1:0')).toBeNull()
  })

  it('skips disabled rows', () => {
    const disabled: SessionModelCatalogEntry[] = [
      { value: 'global.anthropic.claude-fable-5-1[1m]', displayName: 'Fable', disabled: true },
    ]
    expect(successorForRetiredModel(disabled, 'global.anthropic.claude-fable-5[1m]')).toBeNull()
  })
})
